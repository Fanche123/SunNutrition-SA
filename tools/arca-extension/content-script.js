(function initializeArcaContentScript(root) {
  "use strict";

  const ARCA_FISCAL = root.ArcaFiscalContract
    || (typeof module === "object" && module.exports ? require("./arca-fiscal-contract") : null);
  const FINAL_ACTION_PATTERN = /\b(confirmar|emitir|generar|obtener\s+cae|firmar|presentar)\b/i;
  const SECRET_FIELD_PATTERN = /(clave|password|passwd|token|captcha|mfa|otp|certificado|firma)/i;
  const REVIEW_PATTERN = /(resumen|vista previa|revisi[oó]n|confirmaci[oó]n).*(comprobante|datos)/i;
  const SESSION_EXPIRED_PATTERN = /(sesi[oó]n).*(expir|venci|finaliz)/i;
  const NETWORK_ERROR_PATTERN = /(sin conexi[oó]n|no se puede acceder|error de red|err_(connection|network|internet))/i;
  const MAX_SESSION_LOOKUP_ATTEMPTS = 12;
  const SESSION_LOOKUP_RETRY_MS = 250;
  const ARCA_SERVICE_HOSTS = new Set(["fe.afip.gob.ar", "serviciosjava2.afip.gob.ar"]);
  let activeSession = null;
  let lastPageSignature = "";
  let observerTimer = null;
  let expiryTimer = null;
  let terminalStatus = "";
  let currentStage = "";
  const stageGuard = createStageGuard();

  function normalize(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/\s+/g, " ").trim();
  }

  function normalizeLabel(value) {
    return normalize(value).replace(/\s*[:*]+\s*$/, "");
  }

  function elementText(element) {
    return String(element?.value || element?.textContent || element?.getAttribute?.("aria-label") || "").trim();
  }

  function normalizeActionText(element) {
    return normalize(elementText(element)).replace(/^<\s*|\s*>$/g, "").trim();
  }

  function isFinalAction(element) {
    const control = element?.closest?.("button, input[type='submit'], input[type='button'], a");
    return Boolean(control && FINAL_ACTION_PATTERN.test(elementText(control)));
  }

  function blockSyntheticFinalActions() {
    document.addEventListener("click", (event) => {
      const control = event.target?.closest?.("button, input[type='submit'], input[type='button'], a");
      if (
        !event.isTrusted
        && (
          currentStage === "review"
          || (isFinalAction(event.target) && !interimActionAllowed(control, currentStage))
        )
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    document.addEventListener("submit", (event) => {
      const submitter = event.submitter;
      if (
        !event.isTrusted
        && (
          currentStage === "review"
          || !submitter
          || (isFinalAction(submitter) && !interimActionAllowed(submitter, currentStage))
        )
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }

  function findFieldByExactLabel(labelText) {
    const expectedLabels = (Array.isArray(labelText) ? labelText : [labelText]).map(normalizeLabel);
    const labels = [...document.querySelectorAll("label")]
      .filter((label) => expectedLabels.includes(normalizeLabel(label.textContent)));
    if (labels.length !== 1) return null;
    const label = labels[0];
    const targetId = label.getAttribute("for");
    const field = targetId ? document.getElementById(targetId) : label.querySelector("input, select, textarea");
    if (!field || SECRET_FIELD_PATTERN.test(`${field.id} ${field.name} ${label.textContent}`)) return null;
    return field;
  }

  function findUniqueInitialField(labelText) {
    const expected = normalizeLabel(labelText);
    const candidates = new Set();
    const labels = [...document.querySelectorAll("label")]
      .filter((label) => normalizeLabel(label.textContent) === expected);
    for (const label of labels) {
      const targetId = label.getAttribute("for");
      const field = targetId ? document.getElementById(targetId) : label.querySelector("select");
      if (!field || field.tagName !== "SELECT") return null;
      candidates.add(field);
    }
    const rows = [...document.querySelectorAll("tr")].filter((row) => (
      [...row.querySelectorAll("th, td")]
        .some((cell) => normalizeLabel(cell.textContent) === expected)
    ));
    for (const row of rows) {
      const selects = [...row.querySelectorAll("select")];
      if (selects.length !== 1) return null;
      candidates.add(selects[0]);
    }
    return candidates.size === 1 ? [...candidates][0] : null;
  }

  function initialScreenFields() {
    const screenText = normalize(document.body?.innerText || document.body?.textContent);
    if (!screenText.includes("puntos de ventas y tipos de comprobantes habilitados para impresion")) {
      return null;
    }
    const pointField = findUniqueInitialField("Punto de Ventas a utilizar");
    const receiptField = findUniqueInitialField("Tipo de Comprobante");
    if (!pointField || !receiptField || pointField === receiptField) return null;
    return { pointField, receiptField };
  }

  function exactOption(field, value, optionText = "", matchBy = "exact") {
    if (field?.tagName !== "SELECT") return null;
    const expected = normalize(optionText || value);
    const expectedDigits = String(value || "").replace(/\D/g, "");
    const matches = [...field.options].filter((option) => {
      if (matchBy === "numeric_identifier") {
        const valueDigits = /^\d+$/.test(String(option.value || "").trim())
          ? String(option.value).trim().padStart(expectedDigits.length, "0")
          : "";
        const textDigits = String(option.textContent || "").trim().match(/^0*(\d+)\b/)?.[1] || "";
        const identifiers = [
          valueDigits,
          textDigits ? textDigits.padStart(expectedDigits.length, "0") : ""
        ].filter(Boolean);
        return identifiers.length > 0 && identifiers.every((identifier) => identifier === expectedDigits);
      }
      if (matchBy === "code_and_label") {
        const valueCode = /^\d+$/.test(String(option.value || "").trim()) ? String(option.value).trim() : "";
        const text = String(option.textContent || "").trim();
        const textCode = text.match(/^0*(\d+)\b/)?.[1] || "";
        const identifiers = [valueCode, textCode].filter(Boolean).map((identifier) => String(Number(identifier)));
        const label = normalize(text.replace(/^\s*\d+\s*[-–—:]\s*/, ""));
        return identifiers.length > 0
          && identifiers.every((identifier) => identifier === String(Number(expectedDigits)))
          && label === expected;
      }
      if (matchBy === "visible_text") {
        return normalize(option.textContent) === expected;
      }
      return normalize(option.textContent) === expected || normalize(option.value) === expected;
    });
    return matches.length === 1 ? matches[0] : null;
  }

  function resolvedFieldValue(field, value, optionText = "", matchBy = "exact", format = "") {
    if (!field || SECRET_FIELD_PATTERN.test(`${field.id} ${field.name}`)) return null;
    if (field.tagName === "SELECT") {
      const option = exactOption(field, value, optionText, matchBy);
      return option ? option.value : null;
    }
    if (format === "date" && field.type !== "date") {
      const [year, month, day] = String(value || "").split("-");
      return year && month && day ? `${day}/${month}/${year}` : null;
    }
    return String(value ?? "");
  }

  function applyFieldValue(field, value) {
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    return String(field.value) === String(value);
  }

  function setFieldValue(field, value, optionText = "", matchBy = "exact", format = "") {
    if (!field || SECRET_FIELD_PATTERN.test(`${field.id} ${field.name}`)) return false;
    const resolved = resolvedFieldValue(field, value, optionText, matchBy, format);
    return resolved !== null && applyFieldValue(field, resolved);
  }

  function completeExactFields(definitions) {
    const resolved = definitions.map((definition) => ({
      ...definition,
      field: findFieldByExactLabel(definition.labels || definition.label)
    }));
    if (resolved.some((definition) => !definition.field)) return false;
    const values = resolved.map((definition) => resolvedFieldValue(
      definition.field,
      definition.value,
      definition.optionText,
      definition.matchBy,
      definition.format
    ));
    if (values.some((value) => value === null)) return false;
    return resolved.every((definition, index) => applyFieldValue(definition.field, values[index]));
  }

  function completeInitialFields(payload) {
    const [pointDefinition, receiptDefinition] = buildFieldPlan("initial", payload);
    const fields = initialScreenFields();
    if (!fields) return { ok: false, pending: false, reason: "initial_structure_unknown" };
    const { pointField, receiptField } = fields;
    const pointValue = resolvedFieldValue(
      pointField,
      pointDefinition.value,
      pointDefinition.optionText,
      pointDefinition.matchBy
    );
    if (pointValue === null) return { ok: false, pending: false, reason: "point_of_sale_not_unique" };
    if (String(pointField.value) !== String(pointValue) && !applyFieldValue(pointField, pointValue)) {
      return { ok: false, pending: false, reason: "point_of_sale_rejected" };
    }

    const receiptValue = resolvedFieldValue(
      receiptField,
      receiptDefinition.value,
      receiptDefinition.optionText,
      receiptDefinition.matchBy
    );
    if (receiptValue === null) {
      const availableOptions = [...(receiptField.options || [])].filter((option) => {
        const text = normalize(option.textContent);
        return text && !text.includes("seleccionar");
      });
      return {
        ok: false,
        pending: availableOptions.length === 0,
        reason: availableOptions.length === 0 ? "receipt_options_pending" : "receipt_type_not_unique"
      };
    }
    if (String(receiptField.value) !== String(receiptValue) && !applyFieldValue(receiptField, receiptValue)) {
      return { ok: false, pending: false, reason: "receipt_type_rejected" };
    }
    return { ok: true, pending: false };
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
        {
          labels: ["Punto de Ventas a utilizar", "Punto de Venta", "Punto de venta"],
          value: payload.invoice.pointOfSale,
          matchBy: "numeric_identifier"
        },
        {
          label: "Tipo de Comprobante",
          value: payload.invoice.receiptType,
          optionText: receiptLabel(payload.invoice.receiptType),
          matchBy: "visible_text"
        }
      ];
    }
    if (stage === "emission") {
      return [
        {
          labels: ["Fecha de Comprobante", "Fecha del Comprobante", "Fecha de emisión"],
          value: payload.invoice.invoiceDate,
          format: "date"
        },
        {
          labels: ["Conceptos a incluir", "Concepto"],
          value: payload.automation.concept,
          optionText: payload.automation.concept
        },
        {
          labels: ["Actividad", "Actividad asociada"],
          value: payload.automation.activity,
          optionText: payload.automation.activity
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
        {
          labels: ["Condiciones de Venta", "Condición de venta"],
          value: payload.automation.saleCondition,
          optionText: payload.automation.saleCondition
        }
      ];
    }
    return [];
  }

  function classifyPage(text, hasFinalControls, hostname) {
    if (!ARCA_SERVICE_HOSTS.has(hostname)) return "outside_service";
    const normalizedText = normalize(text);
    if (NETWORK_ERROR_PATTERN.test(normalizedText)) return "network_error";
    if (SESSION_EXPIRED_PATTERN.test(normalizedText)) return "session_expired";
    if (REVIEW_PATTERN.test(normalizedText) && hasFinalControls) return "review";
    if (/punto de venta.*tipo de comprobante/.test(normalizedText)) return "initial";
    if (/datos de emision/.test(normalizedText)) return "emission";
    if (/datos del receptor/.test(normalizedText)) return "recipient";
    if (/datos de la operacion|detalle de la operacion/.test(normalizedText)) return "lines";
    if (/seleccione la empresa|seleccione.*representad|elegi.*representad/.test(normalizedText)) {
      return "representative_selection";
    }
    if (/comprobantes en linea/.test(normalizedText) && /generar comprobantes/.test(normalizedText)) {
      return "service_menu";
    }
    return "unrecognized";
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
    }[stage] || (["initial", "emission", "recipient", "lines", "review"].includes(stage) ? stage : "");
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
    if (!payloadCoherenceIsValid(payload)) {
      return interrupt("unexpected_response", "Los datos preparados no respetan la configuración fiscal esperada.");
    }
    if (stage === "initial") {
      updateSession("completing_stage", "", "initial");
      const result = completeInitialFields(payload);
      if (result.ok) return continueFromStage("Datos iniciales completos.", "initial");
      if (result.pending) {
        lastPageSignature = "";
        return showBanner(
          "Punto de venta 00001 seleccionado. Esperando los comprobantes habilitados por ARCA.",
          "waiting"
        );
      }
      const message = result.reason === "point_of_sale_not_unique"
        ? "No existe una única opción para el punto de venta 00001."
        : result.reason === "receipt_type_not_unique"
          ? `No existe una única opción exacta ${receiptLabel(payload.invoice.receiptType)}.`
          : "ARCA cambió la estructura verificada de los datos iniciales.";
      return interrupt("selector_changed", message);
    }
    if (stage === "emission") {
      updateSession("completing_stage", "", "emission");
      const completed = completeExactFields(buildFieldPlan(stage, payload));
      return completed
        ? continueFromStage("Datos de emisión completos.", "emission")
        : interrupt("selector_changed", "ARCA cambió los campos de datos de emisión.");
    }
    if (stage === "recipient") {
      updateSession("completing_stage", "", "recipient");
      const completed = completeExactFields(buildFieldPlan(stage, payload));
      return completed
        ? continueFromStage("Datos del receptor completos.", "recipient")
        : interrupt("selector_changed", "ARCA cambió los campos del receptor.");
    }
    if (stage === "lines") {
      updateSession("completing_stage", "", "lines");
      const result = completeLineRows(payload.lines, payload.automation);
      return result.ok
        ? continueFromStage("Detalle completo.", "lines")
        : interrupt(result.reason, result.message);
    }
    if (stage === "representative_selection") {
      const control = findRepresentativeControl(payload.automation);
      if (!control) {
        return interrupt(
          "selector_changed",
          "No se encontró una única empresa representada con el nombre legal configurado."
        );
      }
      return authorizeInterimAction(
        control,
        "representative",
        "SunNutrition identificada por el nombre legal visible. Abriendo la empresa representada."
      );
    }
    if (stage === "service_menu") {
      const control = findUniqueAction("Generar comprobantes");
      if (!control) {
        return interrupt("selector_changed", "No se encontró una única acción Generar comprobantes.");
      }
      return authorizeInterimAction(control, "service");
    }
    if (stage === "unrecognized") {
      return interrupt("screen_unrecognized", "La pantalla de ARCA no coincide con una etapa verificada.");
    }
  }

  function createStageGuard() {
    const consumed = new Set();
    return {
      claim(stage) {
        if (!stage || consumed.has(stage)) return false;
        consumed.add(stage);
        return true;
      }
    };
  }

  function payloadCoherenceIsValid(payload) {
    return ARCA_FISCAL.preparedPayloadIsValid(payload);
  }

  function findUniqueAction(expectedText) {
    const expected = normalize(expectedText);
    const matches = [...document.querySelectorAll("button, input[type='submit'], input[type='button'], a")]
      .filter((control) => normalizeActionText(control) === expected);
    return matches.length === 1 ? matches[0] : null;
  }

  function findRepresentativeControl(automation) {
    const expectedName = normalize(automation?.representativeName);
    if (!expectedName) return null;
    const matches = [...document.querySelectorAll(
      "button, input[type='submit'], input[type='button'], a"
    )].filter((control) => (
      normalize(elementText(control)) === expectedName
      && !FINAL_ACTION_PATTERN.test(elementText(control))
    ));
    return matches.length === 1 ? matches[0] : null;
  }

  function interimActionAllowed(control, stage) {
    const text = normalizeActionText(control);
    if (stage === "service") return text === "generar comprobantes";
    if (stage === "representative") return !FINAL_ACTION_PATTERN.test(text);
    return ["initial", "emission", "recipient", "lines"].includes(stage) && text === "continuar";
  }

  function activateInterimAction(control, stage) {
    if (
      currentStage !== stage
      || !control
      || control.disabled
      || control.getAttribute?.("aria-disabled") === "true"
      || !interimActionAllowed(control, stage)
      || !stageGuard.claim(stage)
    ) return false;
    return control.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: root
    }));
  }

  function authorizeInterimAction(control, stage, successMessage = "Abriendo Generar comprobantes.") {
    if (!interimActionAllowed(control, stage)) {
      return interrupt("unexpected_response", "La acción intermedia no coincide con la etapa autorizada.");
    }
    root.chrome.runtime.sendMessage({ type: "AUTHORIZE_INTERIM_ACTION", stage }, (response) => {
      if (root.chrome.runtime.lastError || !response?.ok || response.stage !== stage) {
        interrupt("unexpected_response", "La transición intermedia no fue autorizada de forma segura.");
        return;
      }
      activeSession.stage = stage;
      if (activateInterimAction(control, stage)) {
        showBanner(successMessage, "complete");
      } else {
        interrupt("unexpected_response", "ARCA no aceptó la transición intermedia autorizada.");
      }
    });
  }

  function continueFromStage(message, stage) {
    const control = findUniqueAction("Continuar");
    if (!control) {
      return interrupt("selector_changed", `${message} No se encontró una única acción Continuar.`);
    }
    fieldsCompleted(`${message} Avanzando a la siguiente etapa segura.`, stage);
    if (!activateInterimAction(control, stage)) {
      return interrupt("unexpected_response", `${message} ARCA no aceptó la navegación intermedia.`);
    }
  }

  function completeLineRows(lines, automation = activeSession?.payload?.automation) {
    if (!automation) {
      return {
        ok: false,
        reason: "unexpected_response",
        message: "Falta la configuración segura del detalle."
      };
    }
    const rows = [...document.querySelectorAll("tr")].filter((row) => {
      const controls = [...row.querySelectorAll("input, select, textarea")];
      return controls.some((control) => /(descripcion|detalle)/i.test(`${control.name} ${control.id}`))
        && controls.some((control) => /cantidad/i.test(`${control.name} ${control.id}`))
        && controls.some((control) => /precio/i.test(`${control.name} ${control.id}`));
    });
    if (rows.length !== lines.length) {
      return {
        ok: false,
        reason: "selector_changed",
        message: "La cantidad de filas de productos no coincide exactamente con el pedido."
      };
    }
    const preparedRows = [];
    for (let index = 0; index < lines.length; index += 1) {
      const row = rows[index];
      const line = lines[index];
      const productCode = uniqueControl(row, /codigo/i);
      const description = uniqueControl(row, /(descripcion|detalle)/i);
      const quantity = uniqueControl(row, /cantidad/i);
      const unit = uniqueControl(row, /(unidad|medida)/i);
      const price = uniqueControl(row, /precio/i);
      const discount = uniqueControl(row, /(bonif|descuento)/i);
      const vat = uniqueControl(row, /(alicuota|iva)/i);
      if (!productCode || !description || !quantity || !unit || !price || !vat) {
        return {
          ok: false,
          reason: "selector_changed",
          message: `No se reconocieron todos los campos del producto ${index + 1}.`
        };
      }
      const definitions = [
        [productCode, automation.productCode, automation.productCodeLabel, "code_and_label"],
        [description, automation.lineDescription],
        [quantity, line.individualUnits],
        [unit, automation.unit, automation.unit],
        [price, line.unitPrice],
        ...(discount ? [[discount, line.discountPercent]] : []),
        [vat, line.vatRate, `${line.vatRate.toFixed(2).replace(".", ",")} %`]
      ];
      const values = definitions.map(([field, value, optionText, matchBy]) => (
        resolvedFieldValue(field, value, optionText, matchBy)
      ));
      if (values.some((value) => value === null)) {
        return {
          ok: false,
          reason: "unexpected_response",
          message: `ARCA rechazó un valor del producto ${index + 1}.`
        };
      }
      preparedRows.push({ definitions, values });
    }
    const valuesOk = preparedRows.every(({ definitions, values }) => (
      definitions.every(([field], index) => applyFieldValue(field, values[index]))
    ));
    if (!valuesOk) {
      return {
        ok: false,
        reason: "unexpected_response",
        message: "ARCA no conservó exactamente los valores preparados del detalle."
      };
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

  function scheduleInspection(mutations = []) {
    if (
      Array.isArray(mutations)
      && mutations.length
      && mutations.every((mutation) => mutation.target?.closest?.("#sunnutrition-arca-assistant"))
    ) return;
    if (Array.isArray(mutations) && mutations.length) lastPageSignature = "";
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
      blockSyntheticFinalActions,
      buildFieldPlan,
      classifyPage,
      completeExactFields,
      completeInitialFields,
      completeLineRows,
      createStageGuard,
      authorizeInterimAction,
      continueFromStage,
      exactOption,
      initialScreenFields,
      findFieldByExactLabel,
      findRepresentativeControl,
      findUniqueAction,
      interimActionAllowed,
      isFinalAction,
      normalize,
      normalizeActionText,
      normalizeLabel,
      payloadCoherenceIsValid,
      recipientLabel,
      receiptLabel,
      resolvedFieldValue,
      setFieldValue,
      setCurrentStageForTesting(stage) {
        currentStage = stage;
      }
    };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
