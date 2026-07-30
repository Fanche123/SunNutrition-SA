(function initializeArcaContentScript(root) {
  "use strict";

  const FINAL_ACTION_PATTERN = /\b(confirmar|emitir|generar|obtener\s+cae|firmar|presentar)\b/i;
  const SECRET_FIELD_PATTERN = /(clave|password|passwd|token|captcha|mfa|otp|certificado|firma)/i;
  const REVIEW_PATTERN = /(resumen|vista previa|revisi[oó]n).*(comprobante|datos)/i;
  const SESSION_EXPIRED_PATTERN = /(sesi[oó]n).*(expir|venci|finaliz)/i;
  const NETWORK_ERROR_PATTERN = /(sin conexi[oó]n|no se puede acceder|error de red|err_(connection|network|internet))/i;
  const MAX_SESSION_LOOKUP_ATTEMPTS = 12;
  const SESSION_LOOKUP_RETRY_MS = 250;
  let activeSession = null;
  let lastPageSignature = "";
  let observerTimer = null;
  let expiryTimer = null;
  let terminalStatus = "";
  let currentStage = "";

  function normalize(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/\s+/g, " ").trim();
  }

  function elementText(element) {
    return String(element?.value || element?.textContent || element?.getAttribute?.("aria-label") || "").trim();
  }

  function isFinalAction(element) {
    const control = element?.closest?.("button, input[type='submit'], input[type='button'], a");
    return Boolean(control && FINAL_ACTION_PATTERN.test(elementText(control)));
  }

  function blockSyntheticFinalActions() {
    document.addEventListener("click", (event) => {
      if (!event.isTrusted && isFinalAction(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    document.addEventListener("submit", (event) => {
      const submitter = event.submitter;
      if (!event.isTrusted && (!submitter || isFinalAction(submitter))) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }

  function findFieldByExactLabel(labelText) {
    const expected = normalize(labelText);
    const labels = [...document.querySelectorAll("label")].filter((label) => normalize(label.textContent) === expected);
    if (labels.length !== 1) return null;
    const label = labels[0];
    const targetId = label.getAttribute("for");
    const field = targetId ? document.getElementById(targetId) : label.querySelector("input, select, textarea");
    if (!field || SECRET_FIELD_PATTERN.test(`${field.id} ${field.name} ${label.textContent}`)) return null;
    return field;
  }

  function setFieldValue(field, value, optionText = "") {
    if (!field || SECRET_FIELD_PATTERN.test(`${field.id} ${field.name}`)) return false;
    if (field.tagName === "SELECT") {
      const expected = normalize(optionText || value);
      const matches = [...field.options].filter((option) => (
        normalize(option.textContent) === expected || normalize(option.value) === expected
      ));
      if (matches.length !== 1) return false;
      field.value = matches[0].value;
    } else {
      field.value = String(value ?? "");
    }
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function completeExactFields(definitions) {
    const resolved = definitions.map((definition) => ({
      ...definition,
      field: findFieldByExactLabel(definition.label)
    }));
    if (resolved.some((definition) => !definition.field)) return false;
    return resolved.every((definition) => setFieldValue(
      definition.field,
      definition.value,
      definition.optionText
    ));
  }

  function receiptLabel(receiptType) {
    return receiptType.replace("_", " ");
  }

  function recipientLabel(condition) {
    const labels = {
      responsable_inscripto: "IVA Responsable Inscripto",
      monotributista: "Responsable Monotributo",
      exento: "IVA Sujeto Exento",
      consumidor_final: "Consumidor Final",
      no_alcanzado: "No Alcanzado",
      no_categorizado: "Sujeto No Categorizado"
    };
    return labels[condition] || "";
  }

  function buildFieldPlan(stage, payload) {
    if (stage === "initial") {
      return [
        { label: "Punto de Venta", value: payload.invoice.pointOfSale },
        {
          label: "Tipo de Comprobante",
          value: payload.invoice.receiptType,
          optionText: receiptLabel(payload.invoice.receiptType)
        }
      ];
    }
    if (stage === "recipient") {
      return [
        { label: "CUIT", value: payload.customer.cuit },
        {
          label: "Condición frente al IVA",
          value: payload.customer.fiscalCondition,
          optionText: recipientLabel(payload.customer.fiscalCondition)
        },
        { label: "Domicilio Comercial", value: payload.customer.address }
      ];
    }
    return [];
  }

  function classifyPage(text, hasFinalControls, hostname) {
    const normalizedText = normalize(text);
    if (NETWORK_ERROR_PATTERN.test(normalizedText)) return "network_error";
    if (SESSION_EXPIRED_PATTERN.test(normalizedText)) return "session_expired";
    if (REVIEW_PATTERN.test(normalizedText) && hasFinalControls) return "review";
    if (/punto de venta.*tipo de comprobante/.test(normalizedText)) return "initial";
    if (/datos del receptor/.test(normalizedText)) return "recipient";
    if (/datos de la operacion|detalle de la operacion/.test(normalizedText)) return "lines";
    if (/seleccione la empresa|seleccione.*representad|elegi.*representad/.test(normalizedText)) {
      return "representative_selection";
    }
    if (/comprobantes en linea|generar comprobantes/.test(normalizedText)) return "service_menu";
    return hostname === "serviciosjava2.afip.gob.ar" ? "unrecognized" : "outside_service";
  }

  function runRecognizedStage() {
    if (terminalStatus) return;
    if (!activeSession?.payload?.invoice) return;
    if (Date.parse(activeSession.payload.expiresAt) <= Date.now()) {
      return expireActiveSession("La preparación venció. Volvé al ERP y revisá los datos nuevamente.");
    }
    const text = normalize(document.body?.innerText);
    const signature = `${location.href}|${text.slice(0, 500)}`;
    if (signature === lastPageSignature) return;
    lastPageSignature = signature;

    const finalControls = [...document.querySelectorAll("button, input[type='submit'], input[type='button'], a")]
      .filter(isFinalAction);
    const stage = classifyPage(text, finalControls.length > 0, location.hostname);
    currentStage = {
      representative_selection: "representative",
      service_menu: "service"
    }[stage] || (["initial", "recipient", "lines", "review"].includes(stage) ? stage : "");
    if (stage === "session_expired") {
      return interrupt("session_expired", "La sesión de ARCA venció. Volvé al ERP y prepará una sesión nueva.");
    }
    if (stage === "network_error") {
      return interrupt("network_error", "ARCA informó un problema de red.");
    }
    if (stage === "review") {
      terminalStatus = "review_reached";
      showBanner("Revisión final alcanzada. La automatización terminó. Revisá todo y emití únicamente si decidís hacerlo.", "review");
      return updateSession("review_reached", "", "review");
    }

    const payload = activeSession.payload;
    if (stage === "initial") {
      updateSession("completing_stage", "", "initial");
      const completed = completeExactFields(buildFieldPlan(stage, payload));
      return completed
        ? fieldsCompleted("Datos iniciales completos. Revisalos y presioná Continuar manualmente.", "initial")
        : interrupt("selector_changed", "ARCA cambió los campos de datos iniciales.");
    }
    if (stage === "recipient") {
      updateSession("completing_stage", "", "recipient");
      const completed = completeExactFields(buildFieldPlan(stage, payload));
      return completed
        ? fieldsCompleted("Datos del receptor completos. Revisalos y presioná Continuar manualmente.", "recipient")
        : interrupt("selector_changed", "ARCA cambió los campos del receptor.");
    }
    if (stage === "lines") {
      updateSession("completing_stage", "", "lines");
      const result = completeLineRows(payload.lines);
      return result.ok
        ? fieldsCompleted("Detalle completo. Revisá cantidades, precios, IVA y bonificaciones antes de continuar.", "lines")
        : interrupt(result.reason, result.message);
    }
    if (stage === "representative_selection") {
      showBanner("Elegí SunNutrition manualmente. El asistente conserva el pedido preparado sin acceder a tus credenciales.", "waiting");
      return updateSession("waiting_representative", "", "representative");
    }
    if (stage === "service_menu") {
      showBanner("Comprobantes en línea reconocido. Elegí Generar comprobantes manualmente; el asistente retomará en el formulario.", "waiting");
      return updateSession("service_recognized", "", "service");
    }
    if (stage === "unrecognized") {
      return interrupt("screen_unrecognized", "La pantalla de ARCA no coincide con una etapa verificada.");
    }
  }

  function completeLineRows(lines) {
    const rows = [...document.querySelectorAll("tr")].filter((row) => {
      const controls = [...row.querySelectorAll("input, select, textarea")];
      return controls.some((control) => /(descripcion|detalle)/i.test(`${control.name} ${control.id}`))
        && controls.some((control) => /cantidad/i.test(`${control.name} ${control.id}`))
        && controls.some((control) => /precio/i.test(`${control.name} ${control.id}`));
    });
    if (rows.length < lines.length) {
      return {
        ok: false,
        reason: "selector_changed",
        message: "No se reconocieron todas las filas de productos. No se completó ninguna acción final."
      };
    }
    for (let index = 0; index < lines.length; index += 1) {
      const row = rows[index];
      const line = lines[index];
      const description = uniqueControl(row, /(descripcion|detalle)/i);
      const quantity = uniqueControl(row, /cantidad/i);
      const price = uniqueControl(row, /precio/i);
      const discount = uniqueControl(row, /(bonif|descuento)/i);
      const vat = uniqueControl(row, /(alicuota|iva)/i);
      if (!description || !quantity || !price || !vat) {
        return {
          ok: false,
          reason: "selector_changed",
          message: `No se reconocieron todos los campos del producto ${index + 1}.`
        };
      }
      const valuesOk = setFieldValue(description, line.description)
        && setFieldValue(quantity, line.individualUnits)
        && setFieldValue(price, line.unitPrice)
        && (!discount || setFieldValue(discount, line.discountPercent))
        && setFieldValue(vat, line.vatRate, `${line.vatRate.toFixed(2).replace(".", ",")} %`);
      if (!valuesOk) {
        return {
          ok: false,
          reason: "unexpected_response",
          message: `ARCA rechazó un valor del producto ${index + 1}.`
        };
      }
    }
    return { ok: true };
  }

  function uniqueControl(container, pattern) {
    const matches = [...container.querySelectorAll("input, select, textarea")].filter((control) => (
      !SECRET_FIELD_PATTERN.test(`${control.name} ${control.id}`)
      && pattern.test(`${control.name} ${control.id}`)
    ));
    return matches.length === 1 ? matches[0] : null;
  }

  function fieldsCompleted(message, stage) {
    showBanner(message, "complete");
    updateSession("fields_completed", "", stage);
  }

  function interrupt(reason, message) {
    terminalStatus = "interrupted";
    showBanner(`${message} La automatización se detuvo de forma segura.`, "error");
    updateSession("interrupted", reason, currentStage);
  }

  function expireActiveSession(message) {
    terminalStatus = "interrupted";
    activeSession = null;
    clearTimeout(observerTimer);
    clearTimeout(expiryTimer);
    showBanner(`${message} La automatización se detuvo de forma segura.`, "error");
  }

  function updateSession(status, reason, stage = "") {
    if (!activeSession) return;
    root.chrome.runtime.sendMessage({ type: "UPDATE_SESSION", status, reason, stage }, () => {
      void root.chrome.runtime.lastError;
    });
  }

  function showBanner(message, state) {
    let banner = document.getElementById("sunnutrition-arca-assistant");
    if (!banner) {
      banner = document.createElement("aside");
      banner.id = "sunnutrition-arca-assistant";
      banner.setAttribute("role", "status");
      banner.style.cssText = "position:fixed;z-index:2147483647;top:12px;right:12px;max-width:420px;padding:14px 16px;border:2px solid #0f766e;border-radius:8px;background:#fff;color:#17212b;font:600 14px/1.4 system-ui;box-shadow:0 8px 24px #0003";
      document.documentElement.appendChild(banner);
    }
    banner.dataset.state = state;
    banner.textContent = `SunNutrition · ${message}`;
  }

  function scheduleInspection() {
    clearTimeout(observerTimer);
    observerTimer = setTimeout(runRecognizedStage, 250);
  }

  function activateSession(response) {
    activeSession = response;
    const remaining = Date.parse(activeSession.payload?.expiresAt) - Date.now();
    if (!(remaining > 0)) {
      expireActiveSession("La preparación ya venció.");
      return;
    }
    expiryTimer = setTimeout(() => expireActiveSession("La preparación venció."), remaining);
    if (location.hostname === "auth.afip.gob.ar") {
      showBanner("Ingresá tus credenciales, MFA o CAPTCHA manualmente. El asistente no accede a esos datos.", "waiting");
      updateSession("waiting_login", "", "login");
      return;
    }
    scheduleInspection();
    new MutationObserver(scheduleInspection).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function requestActiveSession(attempt = 1) {
    root.chrome.runtime.sendMessage({ type: "GET_ACTIVE_SESSION" }, (response) => {
      if (!root.chrome.runtime.lastError && response?.ok) {
        activateSession(response);
        return;
      }
      if (attempt < MAX_SESSION_LOOKUP_ATTEMPTS) {
        setTimeout(() => requestActiveSession(attempt + 1), SESSION_LOOKUP_RETRY_MS);
      }
    });
  }

  function start() {
    blockSyntheticFinalActions();
    requestActiveSession();
  }

  if (root.chrome?.runtime?.onMessage) {
    root.chrome.runtime.onMessage.addListener((message) => {
      if (
        message?.type === "CANCEL_ACTIVE_SESSION"
        && (!activeSession || message.sessionId === activeSession.sessionId)
      ) {
        expireActiveSession("El ERP canceló o reemplazó esta preparación.");
      }
    });
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
  }

  if (typeof module === "object" && module.exports) {
    module.exports = {
      FINAL_ACTION_PATTERN,
      MAX_SESSION_LOOKUP_ATTEMPTS,
      NETWORK_ERROR_PATTERN,
      SECRET_FIELD_PATTERN,
      buildFieldPlan,
      classifyPage,
      completeExactFields,
      completeLineRows,
      findFieldByExactLabel,
      isFinalAction,
      normalize,
      recipientLabel,
      receiptLabel,
      setFieldValue
    };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
