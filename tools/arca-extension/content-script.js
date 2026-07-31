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
  const MAX_EMISSION_OPTION_ATTEMPTS = 12;
  const EMISSION_OPTION_RETRY_MS = 250;
  const RECIPIENT_LOOKUP_TIMEOUT_MS = 5000;
  const RECIPIENT_LOOKUP_RETRY_MS = 250;
  const AUTHORIZED_LOGIN_CUIT = "20398041063";
  const LOGIN_URL = "https://auth.afip.gob.ar/contribuyente_/login.xhtml";
  const LOGIN_PASSWORD_ACTION = "https://auth.afip.gob.ar/contribuyente_/loginClave.xhtml";
  const ARCA_SERVICE_HOSTS = new Set(["fe.afip.gob.ar", "serviciosjava2.afip.gob.ar"]);
  const REPRESENTATIVE_HOST = "fe.afip.gob.ar";
  const REPRESENTATIVE_PATH = "/rcel/jsp/index_bis.jsp";
  const REPRESENTATIVE_ACTION_PATH = "/rcel/jsp/setearContribuyente.do";
  const REPRESENTATIVE_TITLE = "RCEL";
  const REPRESENTATIVE_PROMPT = "Seleccione la Empresa a representar:";
  const REPRESENTATIVE_DOM_CONTRACT = "representative-selection-v1";
  const COMPANY_REPRESENTATIVE_NAME = "SUNNUTRITION S.A.";
  const PERSONAL_REPRESENTATIVE_NAME = "DE MAYO BENJAMIN";
  const EMISSION_HOST = "fe.afip.gob.ar";
  const EMISSION_PATH = "/rcel/jsp/genComDatosEmisor.do";
  const EMISSION_ACTION_PATH = "/rcel/jsp/genComDatosReceptor.do";
  const RECIPIENT_PATH = "/rcel/jsp/genComDatosReceptor.do";
  const RECIPIENT_ACTION_PATH = "/rcel/jsp/genComDatosOperacion.do";
  const OPERATION_PATH = "/rcel/jsp/genComDatosOperacion.do";
  const OPERATION_ACTION_PATH = "/rcel/jsp/genComResumenDatos.do";
  const OTHER_PAYMENT_IDS = Object.freeze([
    "formadepago1",
    "formadepago2",
    "formadepago3",
    "formadepago4",
    "formadepago6",
    "formadepago7",
    "formadepago8"
  ]);
  const PAYMENT_FIELD_NAMES = Object.freeze({
    formadepago1: "formaDePago",
    formadepago2: "formaDePagoTarjeta",
    formadepago3: "formaDePagoTarjeta",
    formadepago4: "formaDePago",
    formadepago5: "formaDePago",
    formadepago6: "formaDePago",
    formadepago7: "formaDePago",
    formadepago8: "formaDePago"
  });
  const ASSOCIATED_FIELD_NAMES = Object.freeze([
    "cmpAsociadoPtoVta",
    "cmpAsociadoNro",
    "cmpAsociadoCuitEmisor",
    "cmpAsociadoFechaEmision"
  ]);
  let activeSession = null;
  let lastPageSignature = "";
  let observerTimer = null;
  let expiryTimer = null;
  let terminalStatus = "";
  let currentStage = "";
  let emissionOptionAttempts = 0;
  let recipientLookupStartedAt = null;
  let recipientLookupTimer = null;
  let pendingLoginAction = "";
  let pendingInterimAuthorization = null;
  let stageGuard = createStageGuard();
  let startupState = "idle";
  let pendingBanner = null;
  let bannerMountScheduled = false;
  let pageObserver = null;
  let documentLifecycleInstalled = false;

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

  function isForbiddenOperationAction(control) {
    const text = normalizeActionText(control);
    const name = normalize(control?.name);
    return name === "agregarimp"
      || name === "eliminar"
      || text === "agregar linea descripcion"
      || text === "agregar otro tributo"
      || text === "volver"
      || text === "menu principal";
  }

  function blockSyntheticFinalActions() {
    document.addEventListener("click", (event) => {
      const control = event.target?.closest?.("button, input[type='submit'], input[type='button'], a");
      if (
        !event.isTrusted
        && (
          currentStage === "review"
          || isForbiddenOperationAction(control)
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

  function uniqueFormControl(form, selector, reason) {
    const matches = [...form.querySelectorAll(selector)];
    return matches.length === 1
      ? { ok: true, field: matches[0] }
      : { ok: false, reason };
  }

  function exactEmissionUrl(url, pathname) {
    return url.protocol === "https:"
      && url.hostname === EMISSION_HOST
      && url.port === ""
      && url.pathname === pathname
      && url.search === ""
      && url.hash === "";
  }

  function exactLoginUrl(url, expected) {
    let expectedUrl;
    try {
      expectedUrl = new URL(expected);
    } catch {
      return false;
    }
    const pathnameMatches = url.pathname === expectedUrl.pathname
      || url.pathname === `${expectedUrl.pathname}/`;
    return url.protocol === "https:"
      && url.protocol === expectedUrl.protocol
      && url.hostname === expectedUrl.hostname
      && url.port === ""
      && url.username === ""
      && url.password === ""
      && pathnameMatches;
  }

  function exactLoginAction(url, expected) {
    let expectedUrl;
    try {
      expectedUrl = new URL(expected);
    } catch {
      return false;
    }
    return url.protocol === expectedUrl.protocol
      && url.hostname === expectedUrl.hostname
      && url.port === ""
      && url.username === ""
      && url.password === ""
      && url.pathname === expectedUrl.pathname
      && url.search === ""
      && url.hash === "";
  }

  function uniqueElementReferences(elements) {
    return [...new Set(elements || [])];
  }

  function loginScreenContract() {
    let pageUrl;
    try {
      pageUrl = new URL(root.location?.href || "");
    } catch {
      return { ok: false, reason: "login_url_mismatch" };
    }
    if (!exactLoginUrl(pageUrl, LOGIN_URL)) return { ok: false, reason: "login_url_mismatch" };
    if (document.title !== "Acceso con Clave Fiscal - ARCA") {
      return { ok: false, reason: "login_title_mismatch" };
    }
    const pageText = normalize(document.body?.innerText || document.body?.textContent || "");
    if (/(clave|contrasena).*(incorrect|invalida)|error.*autentic|acceso denegado/.test(pageText)) {
      return { ok: false, reason: "login_authentication_error" };
    }
    const forms = uniqueElementReferences(document.querySelectorAll('form#F1[name="F1"]'));
    if (forms.length !== 1) return { ok: false, reason: "login_form_not_unique" };
    const form = forms[0];
    if (String(form.id || form.getAttribute?.("id") || "") !== "F1"
      || String(form.name || form.getAttribute?.("name") || "") !== "F1") {
      return { ok: false, reason: "login_form_identity_mismatch" };
    }
    if (normalize(form.method || form.getAttribute?.("method")) !== "post") {
      return { ok: false, reason: "login_form_method_mismatch" };
    }
    let actionUrl;
    try {
      actionUrl = new URL(form.getAttribute?.("action") || form.action || "", pageUrl.href);
    } catch {
      return { ok: false, reason: "login_form_action_mismatch" };
    }
    const usernameNumber = [...form.querySelectorAll('input#F1\\:username[name="F1:username"][type="number"]')];
    const usernameText = [...form.querySelectorAll('input#F1\\:username[name="F1:username"][type="text"]')];
    const password = [...form.querySelectorAll('input#F1\\:password[name="F1:password"][type="password"]')];
    const next = [...form.querySelectorAll('input#F1\\:btnSiguiente[name="F1:btnSiguiente"][type="submit"][title="Siguiente"]')];
    const enter = [...form.querySelectorAll('input#F1\\:btnIngresar[name="F1:btnIngresar"][type="submit"][title="Ingresar"]')];
    const hiddenCaptcha = [...form.querySelectorAll('input#F1\\:captcha[name="F1:captcha"][type="hidden"]')];
    const visibleSecurityControls = [...document.querySelectorAll(
      "input, select, textarea, iframe, [class], [aria-label], [src]"
    )]
      .filter((control) => {
        const identity = [
          control.id,
          control.name,
          control.title,
          control.className,
          control.getAttribute?.("aria-label"),
          control.getAttribute?.("src"),
          control.textContent
        ].join(" ");
        return /(captcha|mfa|otp)/i.test(identity)
          && !(control === hiddenCaptcha[0] && control.type === "hidden");
      });
    if (visibleSecurityControls.length) {
      return { ok: false, reason: "login_manual_security_required" };
    }
    if (exactLoginAction(actionUrl, LOGIN_URL)) {
      if (usernameNumber.length !== 1 || next.length !== 1
        || usernameText.length || password.length || enter.length) {
        return { ok: false, reason: "login_cuit_controls_mismatch" };
      }
      if (usernameNumber[0].form !== form || next[0].form !== form) {
        return { ok: false, reason: "login_cuit_controls_form_mismatch" };
      }
      return { ok: true, stage: "login_cuit", form, username: usernameNumber[0], submit: next[0] };
    }
    if (exactLoginAction(actionUrl, LOGIN_PASSWORD_ACTION)) {
      if (usernameText.length !== 1 || password.length !== 1 || enter.length !== 1
        || hiddenCaptcha.length !== 1 || usernameNumber.length || next.length) {
        return { ok: false, reason: "login_password_controls_mismatch" };
      }
      if ([usernameText[0], password[0], hiddenCaptcha[0], enter[0]].some((control) => control.form !== form)) {
        return { ok: false, reason: "login_password_controls_form_mismatch" };
      }
      if (String(usernameText[0].value || "").trim() !== AUTHORIZED_LOGIN_CUIT) {
        return { ok: false, reason: "login_cuit_mismatch" };
      }
      return {
        ok: true,
        stage: "login_password",
        form,
        username: usernameText[0],
        password: password[0],
        hiddenCaptcha: hiddenCaptcha[0],
        submit: enter[0]
      };
    }
    return { ok: false, reason: "login_form_action_mismatch" };
  }

  function authorizeLoginAction(stage, perform, cleanup = () => {}) {
    if (pendingLoginAction) return;
    pendingLoginAction = stage;
    const authorizedSessionId = activeSession?.sessionId;
    root.chrome.runtime.sendMessage(sessionMessage("AUTHORIZE_LOGIN_ACTION", { stage }), (response) => {
      absorbSessionVersion(response);
      if (terminalStatus || !activeSession || activeSession.sessionId !== authorizedSessionId) {
        cleanup();
        return;
      }
      if (root.chrome.runtime.lastError || !response?.ok || response.stage !== stage) {
        cleanup();
        return interrupt(
          "manual_action_required",
          "Esta transición de acceso ya fue utilizada o no está autorizada para la sesión."
        );
      }
      perform();
    });
  }

  function clearTransientCredential() {
    root.chrome.runtime.sendMessage({ type: "CLEAR_TRANSIENT_CREDENTIAL" }, () => {
      void root.chrome.runtime.lastError;
    });
  }

  function sessionMessage(type, fields = {}) {
    return {
      type,
      sessionId: activeSession?.sessionId || "",
      revision: activeSession?.revision || activeSession?.payload?.revision || "",
      generation: activeSession?.generation,
      ...fields
    };
  }

  function absorbSessionVersion(response) {
    if (!activeSession || !response) return;
    if (
      Number.isSafeInteger(response.generation)
      && Number.isSafeInteger(activeSession.generation)
      && response.generation !== activeSession.generation
    ) return;
    if (Number.isSafeInteger(response.generation)) activeSession.generation = response.generation;
    if (
      Number.isSafeInteger(response.sequence)
      && (!Number.isSafeInteger(activeSession.sequence) || response.sequence >= activeSession.sequence)
    ) activeSession.sequence = response.sequence;
  }

  function applyCredentialToPassword(field, secret) {
    const descriptor = root.HTMLInputElement
      ? Object.getOwnPropertyDescriptor(root.HTMLInputElement.prototype, "value")
      : Object.getOwnPropertyDescriptor(field || {}, "value");
    if (!descriptor?.set || field?.type !== "password") return false;
    descriptor.set.call(field, secret);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function runLoginAutomation() {
    if (terminalStatus || !activeSession) return;
    const contract = loginScreenContract();
    if (!contract.ok) {
      clearTransientCredential();
      return interrupt(
        "selector_changed",
        `La pantalla inicial de ARCA no coincide con el contrato seguro: ${contract.reason}.`
      );
    }
    currentStage = contract.stage;
    if (contract.stage === "login_cuit") {
      return authorizeLoginAction("login_cuit", () => {
        const current = loginScreenContract();
        if (!current.ok || current.stage !== "login_cuit") {
          return interrupt("selector_changed", "La pantalla de CUIT cambió antes de la transición.");
        }
        if (!applyFieldValue(current.username, AUTHORIZED_LOGIN_CUIT)
          || String(current.username.value) !== AUTHORIZED_LOGIN_CUIT) {
          return interrupt("selector_changed", "ARCA revirtió el CUIT autorizado.");
        }
        const verified = loginScreenContract();
        if (
          !verified.ok
          || verified.stage !== "login_cuit"
          || verified.form !== current.form
          || verified.username !== current.username
          || verified.submit !== current.submit
        ) {
          return interrupt("selector_changed", "El formulario F1 o el botón Siguiente cambió después de completar el CUIT.");
        }
        showBanner("CUIT autorizado verificado. Avanzando a la clave.", "complete");
        if (!activateInterimAction(verified.submit, "login_cuit")) {
          return interrupt("unexpected_response", "ARCA no aceptó Siguiente.");
        }
        terminalStatus = "login_submitted";
      });
    }
    if (pendingLoginAction) return;
    const requestedSessionId = activeSession.sessionId;
    authorizeLoginAction("login_password", () => {
      root.chrome.runtime.sendMessage(sessionMessage("CONSUME_ENCRYPTED_CREDENTIAL"), (response) => {
        absorbSessionVersion(response);
        let secret = response?.ok ? response.secret : null;
        try {
          if (
            root.chrome.runtime.lastError
            || !secret
            || terminalStatus
            || !activeSession
            || activeSession.sessionId !== requestedSessionId
          ) {
            return interrupt("manual_action_required", "No hay una clave cifrada vigente para esta sesión.");
          }
          try {
            const verified = loginScreenContract();
            if (!verified.ok || verified.stage !== "login_password") {
              return interrupt("selector_changed", "La pantalla de clave cambió antes de completar el campo.");
            }
            verified.password.focus();
            verified.password.click();
            if (document.activeElement !== verified.password) {
              return interrupt("manual_action_required", "ARCA rechazó el foco del campo de clave.");
            }
            if (!applyCredentialToPassword(verified.password, secret)) {
              return interrupt("selector_changed", "ARCA no aceptó el setter seguro del campo de clave.");
            }
            showBanner("Clave cifrada aplicada de forma transitoria. Ingresando exactamente una vez.", "complete");
            if (!activateInterimAction(verified.submit, "login_password")) {
              return interrupt("unexpected_response", "ARCA no aceptó Ingresar.");
            }
            root.chrome.runtime.sendMessage(sessionMessage("COMPLETE_LOGIN_ACTION"), (completeResponse) => {
              absorbSessionVersion(completeResponse);
              void root.chrome.runtime.lastError;
            });
            terminalStatus = "login_submitted";
          } finally {
            secret = null;
          }
        } finally {
          secret = null;
        }
      });
    });
  }

  function emissionScreenContract() {
    let pageUrl;
    try {
      pageUrl = new URL(root.location?.href || "");
    } catch {
      return { ok: false, reason: "emission_path_mismatch" };
    }
    if (!exactEmissionUrl(pageUrl, EMISSION_PATH)) {
      return { ok: false, reason: "emission_path_mismatch" };
    }

    const forms = [...document.querySelectorAll('form[name="datosEmisorForm"]')];
    if (forms.length !== 1) return { ok: false, reason: "datosEmisorForm_not_unique" };
    const form = forms[0];
    if (normalize(form.method || form.getAttribute?.("method")) !== "post") {
      return { ok: false, reason: "datosEmisorForm_method_mismatch" };
    }
    let actionUrl;
    try {
      actionUrl = new URL(form.getAttribute?.("action") || form.action || "", pageUrl.href);
    } catch {
      return { ok: false, reason: "datosEmisorForm_action_mismatch" };
    }
    if (!exactEmissionUrl(actionUrl, EMISSION_ACTION_PATH)) {
      return { ok: false, reason: "datosEmisorForm_action_mismatch" };
    }

    const definitions = [
      ["dateField", 'input#fc[name="fechaEmisionComprobante"]', "fc_not_unique"],
      ["conceptField", 'select#idconcepto[name="idConcepto"]', "idconcepto_not_unique"],
      [
        "foreignCurrencyField",
        'input#monedaextranjera[name="monedaExtranjera"][type="checkbox"]',
        "monedaextranjera_not_unique"
      ],
      ["activityField", 'select#actiAsociadaId[name="actiAsociadaId"]', "actiAsociadaId_not_unique"],
      ["referenceField", 'input#refComEmisor[name="refComEmisor"]', "refComEmisor_not_unique"]
    ];
    const result = { ok: true, form };
    for (const [key, selector, reason] of definitions) {
      const control = uniqueFormControl(form, selector, reason);
      if (!control.ok) return control;
      result[key] = control.field;
    }
    if (
      result.dateField.type !== "text"
      || result.dateField.disabled
      || result.dateField.readOnly
    ) return { ok: false, reason: "fc_not_editable" };
    if (
      result.referenceField.type !== "text"
      || result.referenceField.disabled
      || result.referenceField.readOnly
    ) return { ok: false, reason: "refComEmisor_not_editable" };
    if (result.conceptField.disabled) return { ok: false, reason: "idconcepto_disabled" };
    if (result.activityField.disabled) return { ok: false, reason: "actiAsociadaId_disabled" };
    return result;
  }

  function emissionScreenFields() {
    const contract = emissionScreenContract();
    if (!contract.ok) return null;
    const {
      dateField,
      conceptField,
      foreignCurrencyField,
      activityField,
      referenceField
    } = contract;
    return { dateField, conceptField, foreignCurrencyField, activityField, referenceField };
  }

  function recipientScreenContract() {
    let pageUrl;
    try {
      pageUrl = new URL(root.location?.href || "");
    } catch {
      return { ok: false, reason: "recipient_path_mismatch" };
    }
    if (!exactEmissionUrl(pageUrl, RECIPIENT_PATH)) {
      return { ok: false, reason: "recipient_path_mismatch" };
    }
    if (String(document.title || "") !== "RCEL") {
      return { ok: false, reason: "recipient_title_mismatch" };
    }

    const forms = [...document.querySelectorAll('form#formulario[name="datosReceptorForm"]')];
    if (forms.length !== 1) return { ok: false, reason: "datosReceptorForm_not_unique" };
    const form = forms[0];
    if (normalize(form.method || form.getAttribute?.("method")) !== "post") {
      return { ok: false, reason: "datosReceptorForm_method_mismatch" };
    }
    let actionUrl;
    try {
      actionUrl = new URL(form.getAttribute?.("action") || form.action || "", pageUrl.href);
    } catch {
      return { ok: false, reason: "datosReceptorForm_action_mismatch" };
    }
    if (!exactEmissionUrl(actionUrl, RECIPIENT_ACTION_PATH)) {
      return { ok: false, reason: "datosReceptorForm_action_mismatch" };
    }

    const definitions = [
      ["conditionField", 'select#idivareceptor[name="idIVAReceptor"]', "idivareceptor_not_unique"],
      [
        "documentTypeField",
        'input#idtipodocreceptor[name="idTipoDocReceptor"][type="hidden"]',
        "idtipodocreceptor_not_unique"
      ],
      ["cuitField", 'input#nrodocreceptor[name="nroDocReceptor"]', "nrodocreceptor_not_unique"],
      [
        "legalNameField",
        'input#razonsocialreceptor[name="razonSocialReceptor"]',
        "razonsocialreceptor_not_unique"
      ],
      [
        "addressField",
        'select#domicilioreceptor[name="domicilioReceptor"]',
        "domicilioreceptor_not_unique"
      ],
      ["emailField", 'input#email[name="emailReceptor"]', "emailReceptor_not_unique"],
      [
        "multipleBuyersField",
        'select#selectCompradoresMultiples[name="selectCompradoresMultiples"]',
        "selectCompradoresMultiples_not_unique"
      ],
      ["associatedTypeField", 'select#cmp_asoc_tipo[name="cmpAsociadoTipo"]', "cmp_asoc_tipo_not_unique"],
      [
        "additionalTypeField",
        'select#datoadicionaltipo[name="datoAdicionalTipo"]',
        "datoadicionaltipo_not_unique"
      ]
    ];
    const result = { ok: true, form, otherPaymentFields: [], associatedFields: [] };
    for (const [key, selector, reason] of definitions) {
      const control = uniqueFormControl(form, selector, reason);
      if (!control.ok) return control;
      result[key] = control.field;
    }
    const cheque = uniqueFormControl(
      form,
      'input#formadepago5[name="formaDePago"][type="checkbox"]',
      "formadepago5_not_unique"
    );
    if (!cheque.ok) return cheque;
    result.chequeField = cheque.field;
    for (const id of OTHER_PAYMENT_IDS) {
      const control = uniqueFormControl(
        form,
        `input#${id}[type="checkbox"]`,
        `${id}_not_unique`
      );
      if (!control.ok) return control;
      result.otherPaymentFields.push(control.field);
    }
    const paymentFields = [...form.querySelectorAll('input[id^="formadepago"][type="checkbox"]')];
    if (
      paymentFields.length !== Object.keys(PAYMENT_FIELD_NAMES).length
      || paymentFields.some((field) => (
        !Object.prototype.hasOwnProperty.call(PAYMENT_FIELD_NAMES, field.id)
        || field.name !== PAYMENT_FIELD_NAMES[field.id]
      ))
    ) return { ok: false, reason: "recipient_payment_controls_unexpected" };
    for (const name of ASSOCIATED_FIELD_NAMES) {
      const control = uniqueFormControl(
        form,
        `input[name="${name}"]`,
        `${name}_not_unique`
      );
      if (!control.ok) return control;
      result.associatedFields.push(control.field);
    }
    if (
      result.cuitField.type !== "text"
      || result.cuitField.disabled
      || result.cuitField.readOnly
    ) return { ok: false, reason: "nrodocreceptor_not_editable" };
    if (!result.legalNameField.readOnly || result.legalNameField.disabled) {
      return { ok: false, reason: "razonsocialreceptor_not_readonly" };
    }
    if (result.conditionField.disabled) return { ok: false, reason: "idivareceptor_disabled" };
    if (result.addressField.disabled) return { ok: false, reason: "domicilioreceptor_disabled" };
    if (result.multipleBuyersField.disabled) {
      return { ok: false, reason: "selectCompradoresMultiples_disabled" };
    }
    return result;
  }

  function recipientConditionOption(field, payload) {
    const condition = payload?.customer?.fiscalCondition;
    const expectedLabel = recipientLabel(condition);
    if (!expectedLabel || field?.tagName !== "SELECT") return null;
    const options = [...field.options];
    if (condition === "responsable_inscripto") {
      const candidates = options.filter((option) => (
        String(option.value) === "1"
        || normalize(option.textContent) === normalize(expectedLabel)
      ));
      const matches = candidates.filter((option) => (
        String(option.value) === "1"
        && normalize(option.textContent) === normalize(expectedLabel)
      ));
      return candidates.length === 1 && matches.length === 1 ? matches[0] : null;
    }
    if (condition !== "exento") return null;
    const matches = options.filter((option) => (
      normalize(option.textContent) === normalize(expectedLabel)
      && String(option.value || "").trim() !== ""
    ));
    if (matches.length !== 1) return null;
    const value = String(matches[0].value);
    return options.filter((option) => String(option.value) === value).length === 1
      ? matches[0]
      : null;
  }

  function normalizedRecipientCuit(value) {
    const source = String(value || "").trim();
    if (!/^[0-9.\-\s]+$/.test(source)) return "";
    const digits = source.replace(/\D/g, "");
    return digits.length === 11 ? digits : "";
  }

  function applyRecipientCuit(field, value) {
    if (String(field.value) === value) return true;
    field.value = value;
    if (String(field.value) !== value) return false;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.dispatchEvent(new Event("blur", { bubbles: false }));
    return String(field.value) === value;
  }

  function usableAddressOptions(field) {
    return [...(field?.options || [])].filter((option) => (
      !option.disabled
      && String(option.value || "").trim() !== ""
      && normalize(option.textContent)
      && !normalize(option.textContent).includes("seleccionar")
    ));
  }

  function setCheckboxState(field, checked, rejectedReason) {
    if (field.indeterminate) return rejectedReason;
    if (Boolean(field.checked) === checked) return "";
    if (field.disabled) return rejectedReason;
    field.checked = checked;
    if (Boolean(field.checked) !== checked) return rejectedReason;
    field.dispatchEvent(new Event("change", { bubbles: true }));
    return Boolean(field.checked) === checked ? "" : rejectedReason;
  }

  function recipientValuesMatch(contract, payload) {
    const conditionOption = recipientConditionOption(contract.conditionField, payload);
    if (!conditionOption) return "recipient_condition_not_unique";
    if (conditionOption.disabled) return "recipient_condition_disabled";
    if (String(contract.conditionField.value) !== String(conditionOption.value)) {
      return "recipient_condition_value_rejected";
    }
    const cuit = normalizedRecipientCuit(payload?.customer?.cuit);
    if (!cuit) return "recipient_cuit_invalid";
    if (String(contract.cuitField.value) !== cuit) return "recipient_cuit_value_rejected";
    if (!String(contract.legalNameField.value || "").trim()) return "recipient_legal_name_empty";
    const addresses = usableAddressOptions(contract.addressField);
    if (addresses.length === 0) return "recipient_address_empty";
    if (addresses.length !== 1) return "recipient_address_ambiguous";
    if (String(contract.addressField.value) !== String(addresses[0].value)) {
      return "recipient_address_not_selected";
    }
    if (
      contract.chequeField.disabled
      || contract.chequeField.indeterminate
      || !contract.chequeField.checked
    ) return "recipient_cheque_not_checked";
    if (contract.otherPaymentFields.some((field) => field.checked || field.indeterminate)) {
      return "recipient_other_payment_checked";
    }
    if (String(contract.multipleBuyersField.value) !== "N") {
      return "recipient_multiple_buyers_not_no";
    }
    if (contract.associatedFields.some((field) => String(field.value || "").trim() !== "")) {
      return "recipient_associated_fields_not_empty";
    }
    if (String(contract.additionalTypeField.value) !== "0") {
      return "recipient_additional_type_active";
    }
    return "";
  }

  function completeRecipientFields(payload) {
    let contract = recipientScreenContract();
    if (!contract.ok) return { ok: false, pending: false, reason: contract.reason };

    const conditionOption = recipientConditionOption(contract.conditionField, payload);
    if (!conditionOption) {
      return { ok: false, pending: false, reason: "recipient_condition_not_unique" };
    }
    if (conditionOption.disabled) {
      return { ok: false, pending: false, reason: "recipient_condition_disabled" };
    }
    if (String(contract.conditionField.value) !== String(conditionOption.value)) {
      contract.conditionField.value = conditionOption.value;
      if (String(contract.conditionField.value) !== String(conditionOption.value)) {
        return { ok: false, pending: false, reason: "recipient_condition_value_rejected" };
      }
      contract.conditionField.dispatchEvent(new Event("change", { bubbles: true }));
    }

    const cuit = normalizedRecipientCuit(payload?.customer?.cuit);
    if (!cuit) return { ok: false, pending: false, reason: "recipient_cuit_invalid" };
    if (!applyRecipientCuit(contract.cuitField, cuit)) {
      return { ok: false, pending: false, reason: "recipient_cuit_value_rejected" };
    }

    contract = recipientScreenContract();
    if (!contract.ok) return { ok: false, pending: false, reason: contract.reason };
    if (!String(contract.legalNameField.value || "").trim()) {
      return { ok: false, pending: true, reason: "recipient_legal_name_empty" };
    }
    const addresses = usableAddressOptions(contract.addressField);
    if (addresses.length === 0) {
      return { ok: false, pending: true, reason: "recipient_address_empty" };
    }
    if (addresses.length !== 1) {
      return { ok: false, pending: false, reason: "recipient_address_ambiguous" };
    }
    if (String(contract.addressField.value) !== String(addresses[0].value)) {
      return { ok: false, pending: true, reason: "recipient_address_not_selected" };
    }

    let reason = setCheckboxState(contract.chequeField, true, "recipient_cheque_not_checked");
    if (reason) return { ok: false, pending: false, reason };
    for (const field of contract.otherPaymentFields) {
      reason = setCheckboxState(field, false, "recipient_other_payment_checked");
      if (reason) return { ok: false, pending: false, reason };
    }

    const noOption = exactEmissionOption(contract.multipleBuyersField, "N", "No");
    if (!noOption) {
      return { ok: false, pending: false, reason: "recipient_multiple_buyers_no_not_unique" };
    }
    if (String(contract.multipleBuyersField.value) !== "N") {
      if (contract.multipleBuyersField.disabled) {
        return { ok: false, pending: false, reason: "recipient_multiple_buyers_not_no" };
      }
      contract.multipleBuyersField.value = "N";
      if (String(contract.multipleBuyersField.value) !== "N") {
        return { ok: false, pending: false, reason: "recipient_multiple_buyers_not_no" };
      }
      contract.multipleBuyersField.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (contract.associatedFields.some((field) => String(field.value || "").trim() !== "")) {
      return { ok: false, pending: false, reason: "recipient_associated_fields_not_empty" };
    }
    if (String(contract.additionalTypeField.value) !== "0") {
      return { ok: false, pending: false, reason: "recipient_additional_type_active" };
    }

    contract = recipientScreenContract();
    if (!contract.ok) return { ok: false, pending: false, reason: contract.reason };
    reason = recipientValuesMatch(contract, payload);
    return reason
      ? { ok: false, pending: false, reason }
      : { ok: true, pending: false };
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
      if (matchBy === "value_and_text") {
        return String(option.value || "").trim() === String(value || "").trim()
          && normalize(option.textContent) === expected;
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

  function exactEmissionOption(field, expectedValue, expectedText = "") {
    const value = String(expectedValue);
    const text = normalize(expectedText);
    const candidates = [...(field?.options || [])].filter((option) => (
      String(option.value) === value
      || (text && normalize(option.textContent) === text)
    ));
    const matches = candidates.filter((option) => (
      String(option.value) === value
      && (!text || normalize(option.textContent) === text)
    ));
    return candidates.length === 1 && matches.length === 1 ? matches[0] : null;
  }

  function exactActivityOption(field, activityCode) {
    return exactEmissionOption(field, String(activityCode || "").trim());
  }

  function setEmissionTextValue(field, value, reason) {
    field.value = value;
    return String(field.value) === String(value) ? "" : reason;
  }

  function setEmissionSelectValue(field, value, reason) {
    if (String(field.value) === String(value)) return "";
    field.value = value;
    if (String(field.value) !== String(value)) return reason;
    field.dispatchEvent(new Event("change", { bubbles: true }));
    return String(field.value) === String(value) ? "" : reason;
  }

  function emissionValuesMatch(contract, dateValue, activityCode) {
    const conceptOption = exactEmissionOption(contract.conceptField, "1", "Productos");
    if (!conceptOption) return "idconcepto_productos_not_unique";
    if (conceptOption.disabled) return "idconcepto_productos_disabled";
    const activityOption = exactActivityOption(contract.activityField, activityCode);
    if (!activityOption) return "actiAsociadaId_106131_not_unique";
    if (activityOption.disabled) return "actiAsociadaId_106131_disabled";
    if (String(contract.dateField.value) !== String(dateValue)) return "fc_value_rejected";
    if (String(contract.conceptField.value) !== "1") return "idconcepto_value_rejected";
    if (contract.foreignCurrencyField.checked || contract.foreignCurrencyField.indeterminate) {
      return "monedaextranjera_not_unchecked";
    }
    if (String(contract.activityField.value) !== "106131") return "actiAsociadaId_value_rejected";
    if (String(contract.referenceField.value) !== "") return "refComEmisor_value_rejected";
    return "";
  }

  function completeEmissionFields(payload) {
    let contract = emissionScreenContract();
    if (!contract.ok) return { ok: false, pending: false, reason: contract.reason };
    if (contract.foreignCurrencyField.checked || contract.foreignCurrencyField.indeterminate) {
      return { ok: false, pending: false, reason: "monedaextranjera_not_unchecked" };
    }
    const dateValue = resolvedFieldValue(
      contract.dateField,
      payload?.invoice?.invoiceDate,
      "",
      "exact",
      "date"
    );
    if (dateValue === null) return { ok: false, pending: false, reason: "fc_payload_date_invalid" };
    const conceptOption = exactEmissionOption(contract.conceptField, "1", "Productos");
    if (!conceptOption) {
      const pending = [...(contract.conceptField.options || [])].length === 0;
      return {
        ok: false,
        pending,
        reason: pending
          ? "emission_options_pending"
          : "idconcepto_productos_not_unique"
      };
    }
    if (conceptOption.disabled) {
      return { ok: false, pending: false, reason: "idconcepto_productos_disabled" };
    }

    let reason = setEmissionTextValue(contract.dateField, dateValue, "fc_value_rejected");
    if (!reason) {
      reason = setEmissionSelectValue(contract.conceptField, conceptOption.value, "idconcepto_value_rejected");
    }
    if (reason) return { ok: false, pending: false, reason };

    contract = emissionScreenContract();
    if (!contract.ok) return { ok: false, pending: false, reason: contract.reason };
    if (contract.foreignCurrencyField.checked || contract.foreignCurrencyField.indeterminate) {
      return { ok: false, pending: false, reason: "monedaextranjera_not_unchecked" };
    }
    const activityOption = exactActivityOption(contract.activityField, payload?.automation?.activityCode);
    if (!activityOption) {
      const pending = [...(contract.activityField.options || [])].length === 0;
      return {
        ok: false,
        pending,
        reason: pending
          ? "emission_options_pending"
          : "actiAsociadaId_106131_not_unique"
      };
    }
    if (activityOption.disabled) {
      return { ok: false, pending: false, reason: "actiAsociadaId_106131_disabled" };
    }
    reason = setEmissionSelectValue(
      contract.activityField,
      activityOption.value,
      "actiAsociadaId_value_rejected"
    );
    if (!reason) {
      reason = setEmissionTextValue(contract.referenceField, "", "refComEmisor_value_rejected");
    }
    if (reason) return { ok: false, pending: false, reason };

    contract = emissionScreenContract();
    if (!contract.ok) return { ok: false, pending: false, reason: contract.reason };
    reason = emissionValuesMatch(contract, dateValue, payload?.automation?.activityCode);
    return reason
      ? { ok: false, pending: false, reason }
      : { ok: true, pending: false };
  }

  function resetRecipientLookupWait() {
    clearTimeout(recipientLookupTimer);
    recipientLookupTimer = null;
    recipientLookupStartedAt = null;
  }

  function scheduleRecipientLookupRetry(callback) {
    const now = Date.now();
    if (recipientLookupStartedAt === null) recipientLookupStartedAt = now;
    const remaining = RECIPIENT_LOOKUP_TIMEOUT_MS - (now - recipientLookupStartedAt);
    clearTimeout(recipientLookupTimer);
    recipientLookupTimer = null;
    if (remaining <= 0) return false;
    recipientLookupTimer = setTimeout(() => {
      recipientLookupTimer = null;
      callback();
    }, Math.min(RECIPIENT_LOOKUP_RETRY_MS, remaining));
    return true;
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
      return reachReview();
    }

    const payload = activeSession.payload;
    if (!payloadCoherenceIsValid(payload)) {
      return interrupt("unexpected_response", "Los datos preparados no respetan la configuración fiscal esperada.");
    }
    if (stage === "initial") {
      reportStageProgress("started", "initial");
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
      reportStageProgress("started", "emission");
      const result = completeEmissionFields(payload);
      if (result.ok) {
        emissionOptionAttempts = 0;
        return continueFromEmissionStage(payload, "Datos de emisión completos.");
      }
      if (result.pending && emissionOptionAttempts < MAX_EMISSION_OPTION_ATTEMPTS) {
        emissionOptionAttempts += 1;
        lastPageSignature = "";
        setTimeout(runRecognizedStage, EMISSION_OPTION_RETRY_MS);
        return showBanner("Esperando opciones de datos de emisión provistas por ARCA.", "waiting");
      }
      emissionOptionAttempts = 0;
      const messages = {
        emission_path_mismatch: `El path actual no es ${EMISSION_PATH}.`,
        datosEmisorForm_not_unique: "No existe un único form[name=\"datosEmisorForm\"].",
        datosEmisorForm_method_mismatch: "datosEmisorForm no usa el método POST esperado.",
        datosEmisorForm_action_mismatch: `datosEmisorForm no apunta a ${EMISSION_ACTION_PATH}.`,
        emission_options_pending: "Las opciones de #idconcepto o #actiAsociadaId no terminaron de cargar.",
        fc_not_unique: "No existe un único input#fc[name=\"fechaEmisionComprobante\"].",
        fc_not_editable: "input#fc[name=\"fechaEmisionComprobante\"] no es editable.",
        fc_payload_date_invalid: "La fecha preparada por el ERP no tiene formato ISO válido.",
        fc_value_rejected: "input#fc[name=\"fechaEmisionComprobante\"] revirtió la fecha preparada.",
        idconcepto_not_unique: "No existe un único select#idconcepto[name=\"idConcepto\"].",
        idconcepto_disabled: "select#idconcepto está deshabilitado y no sería enviado por el formulario.",
        idconcepto_productos_not_unique: "Productos value 1 no existe de forma única en #idconcepto.",
        idconcepto_productos_disabled: "Productos value 1 está deshabilitado en #idconcepto.",
        idconcepto_value_rejected: "select#idconcepto revirtió Productos value 1.",
        monedaextranjera_not_unique: "No existe un único checkbox #monedaextranjera.",
        monedaextranjera_not_unchecked: "input#monedaextranjera no permanece desmarcado.",
        actiAsociadaId_not_unique: "No existe un único select#actiAsociadaId[name=\"actiAsociadaId\"].",
        actiAsociadaId_disabled: "select#actiAsociadaId está deshabilitado y no sería enviado por el formulario.",
        actiAsociadaId_106131_not_unique: "Actividad value 106131 no existe de forma única en #actiAsociadaId.",
        actiAsociadaId_106131_disabled: "Actividad value 106131 está deshabilitada en #actiAsociadaId.",
        actiAsociadaId_value_rejected: "select#actiAsociadaId revirtió la actividad value 106131.",
        refComEmisor_not_unique: "No existe un único input#refComEmisor[name=\"refComEmisor\"].",
        refComEmisor_not_editable: "input#refComEmisor[name=\"refComEmisor\"] no es editable.",
        refComEmisor_value_rejected: "input#refComEmisor no pudo quedar vacío."
      };
      return interrupt(
        "selector_changed",
        messages[result.reason] || `Falló el contrato DOM de Datos de emisión: ${result.reason}.`
      );
    }
    if (stage === "recipient") {
      reportStageProgress("started", "recipient");
      const result = completeRecipientFields(payload);
      if (result.ok) {
        resetRecipientLookupWait();
        return continueFromRecipientStage(payload, "Datos del receptor completos.");
      }
      if (result.pending && scheduleRecipientLookupRetry(runRecognizedStage)) {
        lastPageSignature = "";
        return showBanner("Esperando razón social y domicilio provistos por ARCA.", "waiting");
      }
      resetRecipientLookupWait();
      const messages = {
        recipient_path_mismatch: `El path actual no es ${RECIPIENT_PATH}.`,
        recipient_title_mismatch: "La pantalla Datos del receptor no conserva el título RCEL.",
        datosReceptorForm_not_unique: "No existe un único form#formulario[name=\"datosReceptorForm\"].",
        datosReceptorForm_method_mismatch: "datosReceptorForm no usa el método POST esperado.",
        datosReceptorForm_action_mismatch: `datosReceptorForm no apunta a ${RECIPIENT_ACTION_PATH}.`,
        idivareceptor_not_unique: "No existe un único select#idivareceptor[name=\"idIVAReceptor\"].",
        idivareceptor_disabled: "La condición frente al IVA está deshabilitada y no sería enviada.",
        idtipodocreceptor_not_unique: "ARCA cambió el campo oculto de tipo de documento.",
        nrodocreceptor_not_unique: "No existe un único input#nrodocreceptor[name=\"nroDocReceptor\"].",
        nrodocreceptor_not_editable: "El CUIT del receptor no es editable.",
        razonsocialreceptor_not_unique: "No existe un único campo de razón social del receptor.",
        razonsocialreceptor_not_readonly: "La razón social dejó de ser un dato autocompletado read-only.",
        domicilioreceptor_not_unique: "No existe un único select#domicilioreceptor[name=\"domicilioReceptor\"].",
        domicilioreceptor_disabled: "El domicilio comercial está deshabilitado y no sería enviado.",
        emailReceptor_not_unique: "ARCA cambió el campo de email del receptor.",
        formadepago5_not_unique: "No existe un único checkbox Cheque #formadepago5.",
        recipient_payment_controls_unexpected: "ARCA cambió el conjunto o el nombre de los medios de pago esperados.",
        recipient_condition_not_unique: payload?.customer?.fiscalCondition === "exento"
          ? "ARCA no expone de forma exacta y única IVA Sujeto Exento para esta Factura B; se requiere exportar ese DOM real."
          : "ARCA no expone de forma exacta y única IVA Responsable Inscripto value 1.",
        recipient_condition_disabled: "La condición fiscal exacta del receptor está deshabilitada.",
        recipient_condition_value_rejected: "ARCA revirtió la condición fiscal preparada por el ERP.",
        recipient_cuit_invalid: "El CUIT preparado por el ERP no tiene un formato de 11 dígitos válido.",
        recipient_cuit_value_rejected: "ARCA revirtió el CUIT normalizado preparado por el ERP.",
        recipient_legal_name_empty: "ARCA no completó la razón social dentro del tiempo esperado.",
        recipient_address_empty: "ARCA no completó el domicilio comercial dentro del tiempo esperado.",
        recipient_address_ambiguous: "ARCA devolvió más de un domicilio comercial y requiere una decisión manual.",
        recipient_address_not_selected: "ARCA no seleccionó de forma inequívoca el domicilio comercial autocompletado.",
        recipient_cheque_not_checked: "Cheque está ausente, deshabilitado o no permanece marcado.",
        recipient_other_payment_checked: "Otro medio de pago no pudo permanecer desmarcado.",
        recipient_multiple_buyers_no_not_unique: "La opción exacta No value N no existe de forma única.",
        recipient_multiple_buyers_not_no: "Compradores múltiples no pudo permanecer en No.",
        recipient_associated_fields_not_empty: "Hay datos en Comprobantes asociados; no se modificaron ni agregaron.",
        recipient_additional_type_active: "Datos adicionales tiene una selección activa; no se modificó.",
        selectCompradoresMultiples_not_unique: "ARCA cambió el selector de compradores múltiples.",
        selectCompradoresMultiples_disabled: "Compradores múltiples está deshabilitado y no sería enviado.",
        cmp_asoc_tipo_not_unique: "ARCA cambió el selector de comprobantes asociados.",
        datoadicionaltipo_not_unique: "ARCA cambió el selector de datos adicionales."
      };
      return interrupt(
        "selector_changed",
        messages[result.reason] || `Falló el contrato DOM de Datos del receptor: ${result.reason}.`
      );
    }
    if (stage === "lines") {
      reportStageProgress("started", "lines");
      const result = completeOperationFields(payload);
      if (result.ok) {
        return continueFromOperationStage(payload, "Datos de la operación completos.");
      }
      return interrupt(
        result.reason === "unexpected_response" ? "unexpected_response" : "selector_changed",
        result.message || `Falló el contrato DOM de Datos de la operación: ${result.reason}.`
      );
    }
    if (stage === "representative_selection") {
      const contract = representativeScreenContract(payload.automation);
      if (!contract.ok) {
        return interrupt("selector_changed", representativeFailureMessage(contract.reason));
      }
      let revalidationReason = "representative_control_replaced";
      return authorizeInterimAction(
        contract.companyControl,
        "representative",
        "SunNutrition identificada por el nombre legal visible. Abriendo la empresa representada.",
        (authorizedControl) => {
          const current = representativeScreenContract(payload.automation);
          if (!current.ok) {
            revalidationReason = current.reason;
            return null;
          }
          return current.companyControl === authorizedControl ? current.companyControl : null;
        },
        () => representativeFailureMessage(revalidationReason, true)
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
    const contract = representativeScreenContract(automation);
    return contract.ok ? contract.companyControl : null;
  }

  function representativeScreenContract(automation) {
    let url;
    try {
      url = new URL(root.location?.href || "");
    } catch {
      return { ok: false, reason: "representative_url_mismatch" };
    }
    if (
      url.protocol !== "https:"
      || url.hostname !== REPRESENTATIVE_HOST
      || url.port !== ""
      || url.pathname !== REPRESENTATIVE_PATH
      || url.search !== ""
      || url.hash !== ""
    ) return { ok: false, reason: "representative_url_mismatch" };
    if (document.title !== REPRESENTATIVE_TITLE) {
      return { ok: false, reason: "representative_title_mismatch" };
    }
    const normalizedPrompt = normalize(REPRESENTATIVE_PROMPT);
    const promptMatches = [...document.querySelectorAll("body *")]
      .filter((element) => (
        normalize(element?.textContent) === normalizedPrompt
        && ![...(element?.children || [])].some(
          (child) => normalize(child?.textContent) === normalizedPrompt
        )
      ));
    if (promptMatches.length !== 1) {
      return { ok: false, reason: "representative_prompt_mismatch" };
    }
    const forms = [...document.querySelectorAll('form[name="seleccionaEmpresaForm"]')];
    if (forms.length !== 1) return { ok: false, reason: "representative_form_not_unique" };
    const form = forms[0];
    if (String(form.id || form.getAttribute?.("id") || "") !== "") {
      return { ok: false, reason: "representative_form_id_mismatch" };
    }
    if (normalize(form.method || form.getAttribute?.("method")) !== "get") {
      return { ok: false, reason: "representative_form_method_mismatch" };
    }
    let actionUrl;
    try {
      actionUrl = new URL(form.getAttribute?.("action") || form.action || "", url.href);
    } catch {
      return { ok: false, reason: "representative_form_action_mismatch" };
    }
    if (
      actionUrl.protocol !== "https:"
      || actionUrl.hostname !== REPRESENTATIVE_HOST
      || actionUrl.port !== ""
      || actionUrl.pathname !== REPRESENTATIVE_ACTION_PATH
      || actionUrl.search !== ""
      || actionUrl.hash !== ""
    ) return { ok: false, reason: "representative_form_action_mismatch" };
    const hiddenControls = [...form.querySelectorAll(
      'input#idcontribuyente[name="idContribuyente"][type="hidden"]'
    )];
    if (hiddenControls.length !== 1) {
      return { ok: false, reason: "representative_hidden_control_mismatch" };
    }
    const controls = [...form.querySelectorAll('input[type="button"].btn_empresa')];
    if (controls.length !== 2) {
      return { ok: false, reason: "representative_button_count_mismatch" };
    }
    const expectedCompany = String(automation?.representativeName || "").trim();
    if (expectedCompany !== COMPANY_REPRESENTATIVE_NAME) {
      return { ok: false, reason: "representative_payload_mismatch" };
    }
    const companyMatches = controls.filter(
      (control) => normalize(control?.value) === normalize(COMPANY_REPRESENTATIVE_NAME)
    );
    const personalMatches = controls.filter(
      (control) => normalize(control?.value) === normalize(PERSONAL_REPRESENTATIVE_NAME)
    );
    if (companyMatches.length === 0) return { ok: false, reason: "representative_company_missing" };
    if (companyMatches.length > 1) return { ok: false, reason: "representative_company_ambiguous" };
    if (personalMatches.length === 0) return { ok: false, reason: "representative_personal_missing" };
    if (personalMatches.length > 1) return { ok: false, reason: "representative_personal_ambiguous" };
    if (
      companyMatches[0].disabled
      || companyMatches[0].getAttribute?.("aria-disabled") === "true"
    ) return { ok: false, reason: "representative_company_disabled" };
    if (
      personalMatches[0].disabled
      || personalMatches[0].getAttribute?.("aria-disabled") === "true"
    ) return { ok: false, reason: "representative_personal_disabled" };
    return {
      ok: true,
      form,
      companyControl: companyMatches[0],
      personalControl: personalMatches[0]
    };
  }

  function representativeFailureMessage(reason, revalidation = false) {
    const messages = {
      representative_url_mismatch: "La URL no es la selección exacta de empresa de ARCA.",
      representative_title_mismatch: "El título de la selección de empresa no es RCEL.",
      representative_prompt_mismatch: "El prompt normalizado de selección de empresa no es único.",
      representative_form_not_unique: "No existe un único formulario seleccionaEmpresaForm.",
      representative_form_id_mismatch: "seleccionaEmpresaForm tiene un id inesperado.",
      representative_form_method_mismatch: "seleccionaEmpresaForm no usa el método GET esperado.",
      representative_form_action_mismatch: "seleccionaEmpresaForm no apunta a setearContribuyente.do.",
      representative_hidden_control_mismatch: "El control oculto idContribuyente no es único.",
      representative_button_count_mismatch: "seleccionaEmpresaForm no contiene exactamente dos botones .btn_empresa.",
      representative_payload_mismatch: "El pedido preparado no autoriza SUNNUTRITION S.A.",
      representative_company_missing: "Falta el botón exacto SUNNUTRITION S.A.",
      representative_company_ambiguous: "Hay más de un botón exacto SUNNUTRITION S.A.",
      representative_personal_missing: "Falta el botón exacto DE MAYO BENJAMIN.",
      representative_personal_ambiguous: "Hay más de un botón exacto DE MAYO BENJAMIN.",
      representative_company_disabled: "El botón SUNNUTRITION S.A. está deshabilitado.",
      representative_personal_disabled: "El botón DE MAYO BENJAMIN está deshabilitado.",
      representative_control_replaced: "El botón autorizado de SUNNUTRITION S.A. fue reemplazado."
    };
    const prefix = revalidation
      ? "La selección de empresa cambió durante la autorización: "
      : "La selección de empresa no coincide con el contrato seguro: ";
    return `${prefix}${messages[reason] || reason}`;
  }

  function interimActionAllowed(control, stage) {
    const text = normalizeActionText(control);
    if (stage === "login_cuit") return text === "siguiente";
    if (stage === "login_password") return text === "ingresar";
    if (stage === "service") return text === "generar comprobantes";
    if (stage === "representative") return text === normalize("SUNNUTRITION S.A.");
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

  function authorizeInterimAction(
    control,
    stage,
    successMessage = "Abriendo Generar comprobantes.",
    revalidateControl = (authorizedControl) => authorizedControl,
    revalidationFailureMessage = () => "La acción autorizada cambió antes del clic."
  ) {
    if (terminalStatus) return;
    if (!interimActionAllowed(control, stage)) {
      return interrupt("unexpected_response", "La acción intermedia no coincide con la etapa autorizada.");
    }
    const authorizedSessionId = activeSession?.sessionId;
    const authorizedRevision = activeSession?.revision || activeSession?.payload?.revision;
    if (
      pendingInterimAuthorization
      && pendingInterimAuthorization.stage === stage
      && pendingInterimAuthorization.sessionId === authorizedSessionId
      && pendingInterimAuthorization.revision === authorizedRevision
    ) return;
    const authorization = {
      stage,
      sessionId: authorizedSessionId,
      revision: authorizedRevision
    };
    pendingInterimAuthorization = authorization;
    const authorizationFields = stage === "representative"
      ? { stage, domContract: REPRESENTATIVE_DOM_CONTRACT }
      : { stage };
    root.chrome.runtime.sendMessage(sessionMessage("AUTHORIZE_INTERIM_ACTION", authorizationFields), (response) => {
      absorbSessionVersion(response);
      if (pendingInterimAuthorization !== authorization) return;
      pendingInterimAuthorization = null;
      if (
        terminalStatus
        || !activeSession
        || activeSession.sessionId !== authorizedSessionId
        || (activeSession.revision || activeSession.payload?.revision) !== authorizedRevision
      ) return;
      if (root.chrome.runtime.lastError || !response?.ok || response.stage !== stage) {
        interrupt("authorization_rejected", "La transición intermedia no fue autorizada de forma segura.");
        return;
      }
      const currentControl = revalidateControl(control);
      if (!currentControl) {
        interrupt("selector_changed", revalidationFailureMessage());
      } else if (activateInterimAction(currentControl, stage)) {
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

  function continueFromEmissionStage(payload, message) {
    const contract = emissionScreenContract();
    if (!contract.ok) {
      return interrupt(
        "selector_changed",
        `${message} Falló la verificación previa al clic: ${contract.reason}.`
      );
    }
    const dateValue = resolvedFieldValue(
      contract.dateField,
      payload?.invoice?.invoiceDate,
      "",
      "exact",
      "date"
    );
    const stateReason = dateValue === null
      ? "fc_payload_date_invalid"
      : emissionValuesMatch(contract, dateValue, payload?.automation?.activityCode);
    if (stateReason) {
      return interrupt(
        "selector_changed",
        `${message} Falló la reverificación previa al clic: ${stateReason}.`
      );
    }
    const controls = [...contract.form.querySelectorAll("input[type='button']")]
      .filter((control) => normalize(elementText(control)) === "continuar >");
    if (controls.length !== 1) {
      return interrupt(
        "selector_changed",
        `${message} datosEmisorForm no contiene un único input[type="button"] Continuar >.`
      );
    }
    fieldsCompleted(`${message} Avanzando a la siguiente etapa segura.`, "emission");
    if (!activateInterimAction(controls[0], "emission")) {
      return interrupt("unexpected_response", `${message} ARCA no aceptó la navegación intermedia.`);
    }
  }

  function continueFromRecipientStage(payload, message) {
    const contract = recipientScreenContract();
    if (!contract.ok) {
      return interrupt(
        "selector_changed",
        `${message} Falló la verificación previa al clic: ${contract.reason}.`
      );
    }
    const stateReason = recipientValuesMatch(contract, payload);
    if (stateReason) {
      return interrupt(
        "selector_changed",
        `${message} Falló la reverificación previa al clic: ${stateReason}.`
      );
    }
    const controls = [...contract.form.querySelectorAll("input[type='button']")]
      .filter((control) => String(control.value || "").trim() === "Continuar >");
    if (controls.length !== 1) {
      return interrupt(
        "selector_changed",
        `${message} datosReceptorForm no contiene un único input[type="button"] Continuar >.`
      );
    }
    fieldsCompleted(`${message} Avanzando a la siguiente etapa segura.`, "recipient");
    if (!activateInterimAction(controls[0], "recipient")) {
      return interrupt("unexpected_response", `${message} ARCA no aceptó la navegación intermedia.`);
    }
  }

  function operationScreenContract() {
    let pageUrl;
    try {
      pageUrl = new URL(root.location?.href || "");
    } catch {
      return { ok: false, reason: "operation_path_mismatch" };
    }
    if (!exactEmissionUrl(pageUrl, OPERATION_PATH)) {
      return { ok: false, reason: "operation_path_mismatch" };
    }
    if (String(document.title || "").trim() !== "RCEL") {
      return { ok: false, reason: "operation_title_mismatch" };
    }
    const forms = [...document.querySelectorAll('form[name="datosOperacionForm"]')];
    if (forms.length !== 1) return { ok: false, reason: "datosOperacionForm_not_unique" };
    const form = forms[0];
    if (normalize(form.method || form.getAttribute?.("method")) !== "post") {
      return { ok: false, reason: "datosOperacionForm_method_mismatch" };
    }
    let actionUrl;
    try {
      actionUrl = new URL(form.getAttribute?.("action") || form.action || "", pageUrl.href);
    } catch {
      return { ok: false, reason: "datosOperacionForm_action_mismatch" };
    }
    if (!exactEmissionUrl(actionUrl, OPERATION_ACTION_PATH)) {
      return { ok: false, reason: "datosOperacionForm_action_mismatch" };
    }

    const quantityPrecision = uniqueFormControl(
      form,
      'select#numdecimalescantidad[name="numDecimalesCantidad"]',
      "numdecimalescantidad_not_unique"
    );
    if (!quantityPrecision.ok) return quantityPrecision;
    const pricePrecision = uniqueFormControl(
      form,
      'select#numdecimalespreciounit[name="numDecimalesPrecioUnit"]',
      "numdecimalespreciounit_not_unique"
    );
    if (!pricePrecision.ok) return pricePrecision;
    const addButtons = [...form.querySelectorAll('input[type="button"]')]
      .filter((control) => String(control.value || "").trim() === "Agregar l\u00ednea descripci\u00f3n");
    if (addButtons.length !== 1) return { ok: false, reason: "operation_add_line_not_unique" };
    const addTributeButtons = [...form.querySelectorAll('input[type="button"]')]
      .filter((control) => (
        String(control.value || "").trim() === "Agregar otro Tributo"
        && normalize(control.name) === "agregarimp"
      ));
    if (addTributeButtons.length !== 1) {
      return { ok: false, reason: "operation_add_tribute_not_unique" };
    }
    const continueButtons = [...form.querySelectorAll('input[type="button"]')]
      .filter((control) => String(control.value || "").trim() === "Continuar >");
    if (continueButtons.length !== 1) return { ok: false, reason: "operation_continue_not_unique" };

    const rowResult = operationLineControls(form);
    if (!rowResult.ok) return rowResult;
    return {
      ok: true,
      form,
      rows: rowResult.rows,
      quantityPrecision: quantityPrecision.field,
      pricePrecision: pricePrecision.field,
      addButton: addButtons[0],
      addTributeButton: addTributeButtons[0],
      continueButton: continueButtons[0]
    };
  }

  function operationLineControls(form) {
    const definitions = [
      ["code", 'input[name="detalleCodigoArticulo"]'],
      ["lineNumber", 'input[name="detalleNroLinea"][type="hidden"]'],
      ["description", 'textarea[name="detalleDescripcion"]'],
      ["quantity", 'input[name="detalleCantidad"]'],
      ["unit", 'select[name="detalleMedida"]'],
      ["price", 'input[name="detallePrecio"]'],
      ["discountPercent", 'input[name="detallePorcentajeBonificacion"]'],
      ["discountAmount", 'input[name="detalleImporteBonificacion"]'],
      ["netSubtotal", 'input[name="detalleSubtotal1"]'],
      ["vatType", 'select[name="detalleTipoIVA"]'],
      ["vatAmount", 'input[name="detalleImporteIVA"]'],
      ["total", 'input[name="detalleSubtotal2"]']
    ];
    const controls = Object.fromEntries(definitions.map(([key, selector]) => [
      key,
      [...form.querySelectorAll(selector)]
    ]));
    const count = controls.code.length;
    if (!count || Object.values(controls).some((items) => items.length !== count)) {
      return { ok: false, reason: "operation_line_controls_mismatch" };
    }
    const rows = [];
    const seenLineNumbers = new Set();
    let usesLegacyBlankLineNumbers = null;
    for (let index = 0; index < count; index += 1) {
      const row = Object.fromEntries(definitions.map(([key]) => [key, controls[key][index]]));
      const suffix = String(index + 1);
      if (
        row.description.id !== `detalle_descripcion${suffix}`
        || row.quantity.id !== `detalle_cantidad${suffix}`
        || row.unit.id !== `detalle_medida${suffix}`
        || row.price.id !== `detalle_precio${suffix}`
        || row.discountPercent.id !== `detalle_porcentaje${suffix}`
        || row.discountAmount.id !== `detalle_importe_bonificacion${suffix}`
        || row.netSubtotal.id !== `detalle_subtotal1${suffix}`
        || row.vatType.id !== `detalle_tipo_iva${suffix}`
        || row.vatAmount.id !== `detalle_importe_iva${suffix}`
        || row.total.id !== `detalle_subtotal2${suffix}`
      ) return { ok: false, reason: "operation_line_ids_mismatch" };
      const lineNumber = String(row.lineNumber.value ?? "").trim();
      const isLegacyBlankLineNumber = lineNumber === "";
      if (usesLegacyBlankLineNumbers === null) {
        usesLegacyBlankLineNumbers = isLegacyBlankLineNumber;
      }
      if (
        usesLegacyBlankLineNumbers !== isLegacyBlankLineNumber
        || (!isLegacyBlankLineNumber && (
          !/^[1-9]\d*$/.test(lineNumber)
          || Number(lineNumber) !== index + 1
          || seenLineNumbers.has(lineNumber)
        ))
      ) {
        return { ok: false, reason: "operation_line_number_invalid" };
      }
      if (!isLegacyBlankLineNumber) seenLineNumbers.add(lineNumber);
      if (
        [row.code, row.description, row.quantity, row.unit, row.price, row.discountPercent, row.vatType]
          .some((field) => field.disabled || field.readOnly)
        || [row.netSubtotal, row.vatAmount, row.total].some((field) => !field.readOnly)
      ) return { ok: false, reason: "operation_line_editability_mismatch" };
      rows.push(row);
    }
    return { ok: true, rows };
  }

  function operationTributesAreEmpty(form) {
    const detailFields = [...form.querySelectorAll('[name="impuestoDetalle"]')];
    if (detailFields.some((field) => String(field.value || "").trim() !== "")) return false;
    const numericFields = [
      "impuestoBaseImponible",
      "impuestoAlicuota",
      "impuestoMonto"
    ].flatMap((name) => [...form.querySelectorAll(`[name="${name}"]`)]);
    if (numericFields.some((field) => {
      const value = String(field.value || "").trim();
      return value !== "" && parseArcaNumber(value) !== 0;
    })) return false;
    const selectors = [...form.querySelectorAll("select")]
      .filter((field) => /^impuesto_/i.test(String(field.id || "")));
    return selectors.every((field) => {
      const option = exactOption(field, "999", "Seleccionar...", "value_and_text");
      return option && selectedOption(field) === option;
    });
  }

  function selectedOption(field) {
    if (field?.tagName !== "SELECT") return null;
    if (Number.isInteger(field.selectedIndex) && field.selectedIndex >= 0) {
      return field.options[field.selectedIndex] || null;
    }
    return [...field.options].find((option) => option.selected) || null;
  }

  function applyExactSelectOption(field, option) {
    if (!field || !option || field.disabled || option.disabled) return false;
    const index = [...field.options].indexOf(option);
    if (index < 0) return false;
    [...field.options].forEach((candidate, optionIndex) => {
      candidate.selected = optionIndex === index;
    });
    field.selectedIndex = index;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    return selectedOption(field) === option;
  }

  function applyOperationPrecision(contract, automation) {
    const quantityOption = exactOption(
      contract.quantityPrecision,
      automation.quantityPrecision,
      "2 decimales",
      "value_and_text"
    );
    const priceOption = exactOption(
      contract.pricePrecision,
      automation.unitPricePrecision,
      "2 decimales",
      "value_and_text"
    );
    return applyExactSelectOption(contract.quantityPrecision, quantityOption)
      && applyExactSelectOption(contract.pricePrecision, priceOption);
  }

  function completeOperationFields(payload) {
    const contract = operationScreenContract();
    if (!contract.ok) {
      return { ok: false, pending: false, reason: contract.reason, message: "" };
    }
    const expectedCount = payload?.lines?.length || 0;
    if (!expectedCount) {
      return {
        ok: false,
        pending: false,
        reason: "unexpected_response",
        message: "El pedido preparado no contiene líneas."
      };
    }
    if (contract.rows.length > expectedCount) {
      return {
        ok: false,
        pending: false,
        reason: "operation_extra_lines",
        message: "ARCA ya contiene líneas adicionales; no se eliminó ninguna."
      };
    }
    if (contract.rows.length < expectedCount) {
      return {
        ok: false,
        pending: false,
        reason: "operation_product_lines_missing",
        message: "El pedido tiene más productos que las filas superiores disponibles; no se crearon líneas."
      };
    }
    if (!operationTributesAreEmpty(contract.form)) {
      return {
        ok: false,
        pending: false,
        reason: "operation_tribute_active",
        message: "Hay un tributo seleccionado o completado; no se modificó."
      };
    }
    if (!applyOperationPrecision(contract, payload.automation)) {
      return {
        ok: false,
        pending: false,
        reason: "operation_precision_rejected",
        message: "ARCA no conservó ambas precisiones en 2 decimales."
      };
    }
    for (let index = 0; index < expectedCount; index += 1) {
      const result = applyOperationLine(contract.rows[index], payload.lines[index], payload.automation);
      if (!result.ok) {
        return {
          ok: false,
          pending: false,
          reason: result.reason,
          message: `Falló la línea ${index + 1}: ${result.message}`
        };
      }
    }
    const reason = operationValuesMatch(contract, payload);
    return reason
      ? { ok: false, pending: false, reason, message: "ARCA revirtió o calculó un valor incoherente." }
      : { ok: true, pending: false, reason: "", message: "" };
  }

  function applyOperationLine(row, line, automation) {
    const unitOption = exactOption(row.unit, line.unitValue, line.unitText, "value_and_text");
    if (!unitOption) {
      return { ok: false, reason: "operation_unit_not_unique", message: "la unidad exacta no es única." };
    }
    const vatOption = exactOption(row.vatType, automation.vatValue, automation.vatText, "value_and_text");
    if (!vatOption) {
      return { ok: false, reason: "operation_vat_not_unique", message: "IVA 21% value 5 no es único." };
    }
    const textValues = [
      [row.code, automation.productCode],
      [row.description, line.description],
      [row.quantity, line.quantity],
      [row.price, line.unitPrice],
      [row.discountPercent, line.discountPercent]
    ];
    if (!textValues.every(([field, value]) => applyFieldValue(field, String(value)))) {
      return { ok: false, reason: "operation_value_rejected", message: "un campo editable revirtió su valor." };
    }
    if (!applyExactSelectOption(row.unit, unitOption)) {
      return { ok: false, reason: "operation_unit_rejected", message: "la unidad fue revertida." };
    }
    if (!applyExactSelectOption(row.vatType, vatOption)) {
      return { ok: false, reason: "operation_vat_rejected", message: "IVA 21% fue revertido." };
    }
    return { ok: true, reason: "", message: "" };
  }

  function operationValuesMatch(contract, payload) {
    if (contract.rows.length !== payload.lines.length) return "operation_line_count_mismatch";
    if (!operationTributesAreEmpty(contract.form)) return "operation_tribute_active";
    const quantityPrecision = exactOption(
      contract.quantityPrecision,
      payload.automation.quantityPrecision,
      "2 decimales",
      "value_and_text"
    );
    const pricePrecision = exactOption(
      contract.pricePrecision,
      payload.automation.unitPricePrecision,
      "2 decimales",
      "value_and_text"
    );
    if (
      selectedOption(contract.quantityPrecision) !== quantityPrecision
      || selectedOption(contract.pricePrecision) !== pricePrecision
    ) return "operation_precision_rejected";
    for (let index = 0; index < payload.lines.length; index += 1) {
      const row = contract.rows[index];
      const line = payload.lines[index];
      const unitOption = exactOption(row.unit, line.unitValue, line.unitText, "value_and_text");
      const vatOption = exactOption(
        row.vatType,
        payload.automation.vatValue,
        payload.automation.vatText,
        "value_and_text"
      );
      if (
        String(row.code.value || "") !== payload.automation.productCode
        || String(row.description.value || "") !== line.description
        || !numericFieldEquals(row.quantity, line.quantity)
        || selectedOption(row.unit) !== unitOption
        || !numericFieldEquals(row.price, line.unitPrice)
        || !numericFieldEquals(row.discountPercent, line.discountPercent)
        || selectedOption(row.vatType) !== vatOption
      ) return "operation_value_rejected";
      if (
        !moneyFieldEquals(row.discountAmount, line.discountAmount)
        || !moneyFieldEquals(row.netSubtotal, line.netSubtotal)
        || !moneyFieldEquals(row.vatAmount, line.vat)
        || !moneyFieldEquals(row.total, line.total)
      ) return "operation_subtotal_mismatch";
    }
    return "";
  }

  function parseArcaNumber(value) {
    let text = String(value ?? "").trim().replace(/[$%\s]/g, "");
    if (!text) return Number.NaN;
    const comma = text.lastIndexOf(",");
    const dot = text.lastIndexOf(".");
    if (comma >= 0 && dot >= 0) {
      text = comma > dot ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
    } else if (comma >= 0) {
      text = text.replace(",", ".");
    }
    const number = Number(text);
    return Number.isFinite(number) ? number : Number.NaN;
  }

  function numericFieldEquals(field, expected) {
    const actual = parseArcaNumber(field?.value);
    return Number.isFinite(actual) && Math.abs(actual - Number(expected)) < 1e-9;
  }

  function moneyFieldEquals(field, expected) {
    const actual = parseArcaNumber(field?.value);
    return Number.isFinite(actual) && Math.round(actual * 100) === Math.round(Number(expected) * 100);
  }

  function continueFromOperationStage(payload, message) {
    const contract = operationScreenContract();
    if (!contract.ok) {
      return interrupt("selector_changed", `${message} Falló la verificación previa: ${contract.reason}.`);
    }
    const reason = operationValuesMatch(contract, payload);
    if (reason) {
      return interrupt("selector_changed", `${message} Falló la reverificación previa: ${reason}.`);
    }
    fieldsCompleted(`${message} Avanzando al resumen seguro.`, "lines");
    if (!activateInterimAction(contract.continueButton, "lines")) {
      return interrupt("unexpected_response", `${message} ARCA no aceptó Continuar >.`);
    }
  }

  function fieldsCompleted(message, stage) {
    showBanner(message, "complete");
    reportStageProgress("completed", stage);
  }

  function interrupt(reason, message) {
    pendingInterimAuthorization = null;
    resetRecipientLookupWait();
    showBanner(`${message} Diagnóstico: ${reason}. La automatización se detuvo de forma segura.`, "error");
    reportPageDiagnostic(reason, currentStage);
  }

  function expireActiveSession(message) {
    terminalStatus = "interrupted";
    pendingInterimAuthorization = null;
    activeSession = null;
    clearTimeout(observerTimer);
    clearTimeout(expiryTimer);
    resetRecipientLookupWait();
    showBanner(`${message} La automatización se detuvo de forma segura.`, "error");
  }

  function sendSessionEvent(type, fields = {}) {
    if (!activeSession) return;
    root.chrome.runtime.sendMessage(sessionMessage(type, fields), (response) => {
      absorbSessionVersion(response);
      void root.chrome.runtime.lastError;
    });
  }

  function reportStageProgress(phase, stage) {
    sendSessionEvent("REPORT_STAGE_PROGRESS", { phase, stage });
  }

  function reportPageDiagnostic(reason, stage = "") {
    sendSessionEvent("REPORT_PAGE_DIAGNOSTIC", { reason, stage });
  }

  function reachReview() {
    sendSessionEvent("REACH_REVIEW", { stage: "review", finalSubmissionAllowed: false });
  }

  function reportDocumentTransition(reason) {
    if (!["pagehide", "unload"].includes(reason)) return;
    sendSessionEvent("REPORT_DOCUMENT_TRANSITION", { reason, stage: currentStage });
  }

  function installDocumentLifecycleDiagnostics() {
    if (documentLifecycleInstalled || typeof root.addEventListener !== "function") return;
    documentLifecycleInstalled = true;
    root.addEventListener("pagehide", () => reportDocumentTransition("pagehide"));
    root.addEventListener("unload", () => reportDocumentTransition("unload"));
  }

  function showBanner(message, state) {
    let banner = document.getElementById("sunnutrition-arca-assistant");
    if (!banner) {
      const mount = document.documentElement || document.head || document.body;
      if (!mount) {
        pendingBanner = { message, state };
        if (!bannerMountScheduled) {
          bannerMountScheduled = true;
          document.addEventListener("DOMContentLoaded", () => {
            bannerMountScheduled = false;
            const queued = pendingBanner;
            pendingBanner = null;
            if (queued) showBanner(queued.message, queued.state);
          }, { once: true });
        }
        return null;
      }
      banner = document.createElement("aside");
      banner.id = "sunnutrition-arca-assistant";
      banner.setAttribute("role", "status");
      banner.style.cssText = "position:fixed;z-index:2147483647;top:12px;right:12px;max-width:420px;padding:14px 16px;border:2px solid #0f766e;border-radius:8px;background:#fff;color:#17212b;font:600 14px/1.4 system-ui;box-shadow:0 8px 24px #0003";
      mount.appendChild(banner);
    }
    banner.dataset.state = state;
    banner.textContent = `SunNutrition · ${message}`;
    return banner;
  }

  function scheduleInspection(mutations = []) {
    if (
      Array.isArray(mutations)
      && mutations.length
      && mutations.every((mutation) => mutation.target?.closest?.("#sunnutrition-arca-assistant"))
    ) return;
    if (Array.isArray(mutations) && mutations.length) lastPageSignature = "";
    clearTimeout(observerTimer);
    observerTimer = setTimeout(() => {
      try {
        runRecognizedStage();
      } catch {
        showStartupFailure("init_exception");
      }
    }, 250);
  }

  function activateSession(response) {
    pendingInterimAuthorization = null;
    activeSession = response;
    const remaining = Date.parse(activeSession.payload?.expiresAt) - Date.now();
    if (!(remaining > 0)) {
      expireActiveSession("La preparación ya venció.");
      return;
    }
    expiryTimer = setTimeout(() => expireActiveSession("La preparación venció."), remaining);
    if (location.hostname === "auth.afip.gob.ar") {
      showBanner("Usando la clave efímera preparada. MFA o CAPTCHA requieren intervención manual.", "waiting");
      const runLoginWhenReady = () => {
        if (terminalStatus || startupState === "failed") return;
        if (document.readyState === "loading" || !document.body || !document.documentElement) {
          document.addEventListener("DOMContentLoaded", runLoginWhenReady, { once: true });
          return;
        }
        runLoginAutomation();
      };
      runLoginWhenReady();
      return;
    }
    const inspectDocument = () => {
      if (terminalStatus || startupState === "failed") return;
      if (document.readyState === "loading" || !document.body || !document.documentElement) {
        document.addEventListener("DOMContentLoaded", inspectDocument, { once: true });
        return;
      }
      pageObserver = new MutationObserver(scheduleInspection);
      pageObserver.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
      scheduleInspection();
    };
    inspectDocument();
  }

  function startupFailureMessage(code) {
    const messages = {
      init_runtime_error: "No se pudo consultar al service worker de la extensión.",
      init_response_missing: "El service worker no devolvió una respuesta de sesión.",
      session_absent: "No hay una preparación vigente asociada a esta pestaña.",
      session_terminal: "La preparación asociada ya está en estado terminal.",
      session_replaced: "El ERP canceló o reemplazó esta preparación.",
      session_expired: "La preparación asociada venció.",
      session_rejected: "La recuperación de la preparación fue rechazada de forma segura.",
      init_exception: "La inicialización de la extensión produjo una excepción controlada."
    };
    return `${messages[code] || messages.session_rejected} Diagnóstico: ${code}. Cero acciones ejecutadas.`;
  }

  function showStartupFailure(code) {
    startupState = "failed";
    terminalStatus = "interrupted";
    pendingInterimAuthorization = null;
    activeSession = null;
    clearTimeout(observerTimer);
    clearTimeout(expiryTimer);
    resetRecipientLookupWait();
    pageObserver?.disconnect?.();
    pageObserver = null;
    showBanner(startupFailureMessage(code), "error");
  }

  function responseFailureCode(response, runtimeFailed, responseMissing) {
    if (runtimeFailed) return "init_runtime_error";
    if (responseMissing) return "init_response_missing";
    if (response?.reason === "session_replaced") return "session_replaced";
    if (response?.reason === "session_expired" || response?.reason === "timeout") return "session_expired";
    if (["review_reached", "interrupted"].includes(response?.status)) return "session_terminal";
    if (response?.reason === "session_absent" || response?.status === "not_found") return "session_absent";
    return "session_rejected";
  }

  function requestActiveSession(attempt = 1, lastFailureCode = "session_absent") {
    try {
      if (!root.chrome?.runtime?.sendMessage) {
        showStartupFailure("init_runtime_error");
        return;
      }
      root.chrome.runtime.sendMessage({ type: "GET_ACTIVE_SESSION" }, (response) => {
        const runtimeFailed = Boolean(root.chrome.runtime.lastError);
        if (!runtimeFailed && response?.ok) {
          startupState = "active";
          try {
            activateSession(response);
          } catch {
            showStartupFailure("init_exception");
          }
          return;
        }
        const failureCode = responseFailureCode(response, runtimeFailed, response === undefined);
        if (attempt < MAX_SESSION_LOOKUP_ATTEMPTS && !["session_terminal", "session_replaced", "session_expired"].includes(failureCode)) {
          setTimeout(() => requestActiveSession(attempt + 1, failureCode), SESSION_LOOKUP_RETRY_MS);
          return;
        }
        showStartupFailure(failureCode || lastFailureCode);
      });
    } catch {
      showStartupFailure("init_exception");
    }
  }

  function start() {
    if (startupState !== "idle") return;
    startupState = "recovering";
    installDocumentLifecycleDiagnostics();
    showBanner("Extensión cargada. Recuperando la preparación segura. Diagnóstico: init_recovering.", "waiting");
    try {
      blockSyntheticFinalActions();
      requestActiveSession();
    } catch {
      showStartupFailure("init_exception");
    }
  }

  function handleCancellationMessage(message) {
    if (
      message?.type !== "CANCEL_ACTIVE_SESSION"
      || !activeSession
      || message.sessionId !== activeSession.sessionId
      || message.revision !== (activeSession.revision || activeSession.payload?.revision)
    ) return false;
    expireActiveSession("El ERP canceló o reemplazó esta preparación. Diagnóstico: session_replaced.");
    return true;
  }

  if (root.chrome?.runtime?.onMessage) {
    root.chrome.runtime.onMessage.addListener((message) => {
      handleCancellationMessage(message);
    });
  }

  if (typeof document !== "undefined") start();

  if (typeof module === "object" && module.exports) {
    module.exports = {
      FINAL_ACTION_PATTERN,
      AUTHORIZED_LOGIN_CUIT,
      REPRESENTATIVE_DOM_CONTRACT,
      MAX_EMISSION_OPTION_ATTEMPTS,
      RECIPIENT_LOOKUP_TIMEOUT_MS,
      MAX_SESSION_LOOKUP_ATTEMPTS,
      NETWORK_ERROR_PATTERN,
      SECRET_FIELD_PATTERN,
      blockSyntheticFinalActions,
      buildFieldPlan,
      classifyPage,
      completeExactFields,
      completeEmissionFields,
      completeInitialFields,
      completeOperationFields,
      completeRecipientFields,
      createStageGuard,
      authorizeInterimAction,
      continueFromEmissionStage,
      continueFromOperationStage,
      continueFromRecipientStage,
      continueFromStage,
      exactOption,
      exactActivityOption,
      exactEmissionOption,
      emissionScreenContract,
      emissionScreenFields,
      initialScreenFields,
      loginScreenContract,
      normalizedRecipientCuit,
      operationScreenContract,
      operationValuesMatch,
      representativeFailureMessage,
      representativeScreenContract,
      recipientScreenContract,
      recipientValuesMatch,
      resetRecipientLookupWait,
      findFieldByExactLabel,
      findRepresentativeControl,
      handleCancellationMessage,
      requestActiveSessionForTesting: requestActiveSession,
      reportDocumentTransitionForTesting: reportDocumentTransition,
      responseFailureCode,
      showBannerForTesting: showBanner,
      startForTesting: start,
      findUniqueAction,
      interimActionAllowed,
      isForbiddenOperationAction,
      isFinalAction,
      normalize,
      normalizeActionText,
      normalizeLabel,
      uniqueElementReferences,
      payloadCoherenceIsValid,
      recipientLabel,
      receiptLabel,
      resolvedFieldValue,
      setFieldValue,
      scheduleRecipientLookupRetry,
      usableAddressOptions,
      setCurrentStageForTesting(stage) {
        currentStage = stage;
      },
      resetOperationStateForTesting() {
      },
      resetLoginStateForTesting() {
        clearTimeout(observerTimer);
        clearTimeout(expiryTimer);
        pendingLoginAction = "";
        pendingInterimAuthorization = null;
        stageGuard = createStageGuard();
        terminalStatus = "";
        currentStage = "";
        activeSession = null;
        lastPageSignature = "";
        startupState = "idle";
        pendingBanner = null;
        bannerMountScheduled = false;
        pageObserver?.disconnect?.();
        pageObserver = null;
      },
      runLoginAutomationForTesting: runLoginAutomation,
      expireActiveSessionForTesting: expireActiveSession,
      runRecognizedStageForTesting: runRecognizedStage,
      setActiveSessionForTesting(session) {
        pendingLoginAction = "";
        pendingInterimAuthorization = null;
        activeSession = {
          ...session,
          payload: {
            ...session.payload,
            expiresAt: session.payload?.expiresAt || new Date(Date.now() + 60_000).toISOString()
          }
        };
        terminalStatus = "";
      }
    };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
