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
  const ARCA_SERVICE_HOSTS = new Set(["fe.afip.gob.ar", "serviciosjava2.afip.gob.ar"]);
  const EMISSION_HOST = "fe.afip.gob.ar";
  const EMISSION_PATH = "/rcel/jsp/genComDatosEmisor.do";
  const EMISSION_ACTION_PATH = "/rcel/jsp/genComDatosReceptor.do";
  const RECIPIENT_PATH = "/rcel/jsp/genComDatosReceptor.do";
  const RECIPIENT_ACTION_PATH = "/rcel/jsp/genComDatosOperacion.do";
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
      updateSession("completing_stage", "", "recipient");
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
    resetRecipientLookupWait();
    showBanner(`${message} La automatización se detuvo de forma segura.`, "error");
    updateSession("interrupted", reason, currentStage);
  }

  function expireActiveSession(message) {
    terminalStatus = "interrupted";
    activeSession = null;
    clearTimeout(observerTimer);
    clearTimeout(expiryTimer);
    resetRecipientLookupWait();
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
      completeLineRows,
      completeRecipientFields,
      createStageGuard,
      authorizeInterimAction,
      continueFromEmissionStage,
      continueFromRecipientStage,
      continueFromStage,
      exactOption,
      exactActivityOption,
      exactEmissionOption,
      emissionScreenContract,
      emissionScreenFields,
      initialScreenFields,
      normalizedRecipientCuit,
      recipientScreenContract,
      recipientValuesMatch,
      resetRecipientLookupWait,
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
      scheduleRecipientLookupRetry,
      usableAddressOptions,
      setCurrentStageForTesting(stage) {
        currentStage = stage;
      }
    };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
