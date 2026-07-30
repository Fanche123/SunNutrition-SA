const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const background = require("../tools/arca-extension/background.js");
const content = require("../tools/arca-extension/content-script.js");
const frontend = require("../assets/js/modules/arca-invoicing.js");
const fiscal = require("../tools/arca-extension/arca-fiscal-contract.js");

function safeMessage() {
  return {
    type: "PREPARE_SESSION",
    sessionId: "12345678-1234-1234-1234-123456789012",
    payload: {
      contractVersion: fiscal.CONTRACT.version,
      mode: "review_only",
      finalSubmissionAllowed: false,
      revision: "a".repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      automation: { ...fiscal.AUTOMATION },
      order: { id: "10" },
      customer: {
        cuit: "30123456789",
        fiscalCondition: "responsable_inscripto",
        fiscalConditionLabel: "IVA Responsable Inscripto"
      },
      invoice: {
        pointOfSale: "00001",
        receiptType: "Factura_A",
        invoiceDate: "2026-07-30",
        issuerCondition: "responsable_inscripto",
        recipientCondition: "responsable_inscripto",
        totals: {
          netSubtotal: 1800,
          vat: 378,
          total: 2178
        }
      },
      lines: [{
        description: "Producto",
        individualUnits: 20,
        unitPrice: 100,
        discountPercent: 10,
        vatRate: 21,
        gross: 2000,
        discountAmount: 200,
        netSubtotal: 1800,
        vat: 378,
        total: 2178
      }]
    }
  };
}

test("manifest limita hosts y usa sólo almacenamiento efímero de sesión", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "tools/arca-extension/manifest.json"), "utf8"));

  assert.deepEqual(manifest.permissions.sort(), ["alarms", "storage"]);
  assert.deepEqual(manifest.host_permissions.sort(), [
    "https://auth.afip.gob.ar/*",
    "https://fe.afip.gob.ar/*",
    "https://serviciosjava2.afip.gob.ar/*"
  ]);
  assert.deepEqual(
    [...manifest.content_scripts[0].matches].sort(),
    [...manifest.host_permissions].sort()
  );
  assert.deepEqual(manifest.externally_connectable.matches, ["http://127.0.0.1/*"]);
  assert.equal(manifest.content_scripts[0].all_frames, undefined);
  assert.equal(manifest.minimum_chrome_version, "102");
  assert.equal(JSON.stringify(manifest).includes("<all_urls>"), false);
});

test("contrato exige revisión exclusiva y rechaza cualquier clave sensible", () => {
  assert.equal(background.validatePreparedMessage(safeMessage()), true);
  const withPassword = safeMessage();
  withPassword.payload.password = "nunca";
  assert.equal(background.validatePreparedMessage(withPassword), false);
  const withCookie = safeMessage();
  withCookie.payload.customer.cookie = "nunca";
  assert.equal(background.validatePreparedMessage(withCookie), false);
  const emissionEnabled = safeMessage();
  emissionEnabled.payload.finalSubmissionAllowed = true;
  assert.equal(background.validatePreparedMessage(emissionEnabled), false);
  const staleContract = safeMessage();
  staleContract.payload.contractVersion -= 1;
  assert.equal(background.validatePreparedMessage(staleContract), false);
  const wrongRepresentative = safeMessage();
  wrongRepresentative.payload.automation.representativeCuit = "30123456789";
  assert.equal(background.validatePreparedMessage(wrongRepresentative), false);
  const wrongVat = safeMessage();
  wrongVat.payload.lines[0].vatRate = 10.5;
  assert.equal(background.validatePreparedMessage(wrongVat), false);
  const wrongRecipient = safeMessage();
  wrongRecipient.payload.invoice.recipientCondition = "exento";
  assert.equal(background.validatePreparedMessage(wrongRecipient), false);
  const invalidDate = safeMessage();
  invalidDate.payload.invoice.invoiceDate = "2026-02-30";
  assert.equal(background.validatePreparedMessage(invalidDate), false);
  const invalidUnits = safeMessage();
  invalidUnits.payload.lines[0].individualUnits = -20;
  assert.equal(background.validatePreparedMessage(invalidUnits), false);
  const invalidDiscount = safeMessage();
  invalidDiscount.payload.lines[0].discountPercent = 101;
  assert.equal(background.validatePreparedMessage(invalidDiscount), false);
  const incoherentTotals = safeMessage();
  incoherentTotals.payload.invoice.totals.total = 2177;
  assert.equal(background.validatePreparedMessage(incoherentTotals), false);
  const nonFiniteAmount = safeMessage();
  nonFiniteAmount.payload.lines[0].unitPrice = Number.NaN;
  assert.equal(background.validatePreparedMessage(nonFiniteAmount), false);
});

test("mensajes externos sólo aceptan loopback explícito", () => {
  assert.equal(background.trustedExternalSender({ url: "http://127.0.0.1:3000/" }), true);
  assert.equal(background.trustedExternalSender({ url: "http://127.0.0.1:3300/" }), false);
  assert.equal(background.trustedExternalSender({ url: "http://localhost:3000/" }), false);
  assert.equal(background.trustedExternalSender({ url: "https://example.com/" }), false);
});

test("PING negocia la versión vigente antes de preparar una sesión", async () => {
  const response = await background.externalMessage(
    { type: "PING" },
    { url: "http://127.0.0.1:3000/" }
  );
  assert.deepEqual(response, {
    ok: true,
    contractVersion: fiscal.CONTRACT.version,
    mode: "review_only"
  });
  assert.equal(frontend.extensionContractCompatibilityError(response), "");
  assert.match(frontend.extensionContractCompatibilityError({
    ...response,
    contractVersion: response.contractVersion - 1
  }), /Recargala desde chrome:\/\/extensions/);
  assert.equal(
    frontend.extensionContractCompatibilityError({ ok: true, mode: "review_only" }),
    "Contrato incompatible."
  );
});

test("openArca conserva la preparación y no llama al backend con una extensión obsoleta", async () => {
  const originalChrome = global.chrome;
  const originalDocument = global.document;
  const originalFetch = global.fetch;
  const status = { textContent: "", dataset: {} };
  const extensionId = { value: "a".repeat(32) };
  const openButton = { disabled: false };
  const sentMessages = [];
  let fetchCalls = 0;
  const prepared = {
    sessionId: safeMessage().sessionId,
    payload: safeMessage().payload,
    orderId: "10",
    prepareRequest: {
      orderId: "10",
      receiptType: "Factura_A",
      invoiceDate: "2026-07-30"
    }
  };
  global.document = {
    getElementById(id) {
      return {
        "arca-status": status,
        "arca-extension-id": extensionId,
        "arca-open": openButton
      }[id] || null;
    }
  };
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(_extensionId, message, callback) {
        sentMessages.push(message.type);
        callback({
          ok: true,
          contractVersion: fiscal.CONTRACT.version - 1,
          mode: "review_only"
        });
      }
    }
  };
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("El preflight no debe llamar al backend.");
  };
  frontend.__testing.state.prepared = prepared;
  frontend.__testing.state.sessionActive = false;
  try {
    await frontend.__testing.openArca();
    assert.deepEqual(sentMessages, ["PING"]);
    assert.equal(fetchCalls, 0);
    assert.equal(frontend.__testing.state.prepared, prepared);
    assert.equal(openButton.disabled, false);
    assert.match(status.textContent, /Recargala desde chrome:\/\/extensions/);
    assert.equal(status.dataset.status, "error");
  } finally {
    frontend.__testing.state.prepared = null;
    frontend.__testing.state.sessionActive = false;
    global.chrome = originalChrome;
    global.document = originalDocument;
    global.fetch = originalFetch;
  }
});

test("sesión preparada sobrevive al reinicio del service worker y queda ligada a una sola pestaña", async () => {
  const originalChrome = global.chrome;
  const stored = {};
  global.chrome = {
    runtime: { lastError: null },
    storage: {
      session: {
        get(key, callback) {
          const result = { [key]: stored[key] ? structuredClone(stored[key]) : undefined };
          callback(result);
        },
        set(values, callback) {
          Object.assign(stored, structuredClone(values));
          callback();
        }
      }
    },
    tabs: {
      create(_options, callback) {
        callback({ id: 73 });
      },
      sendMessage(_tabId, _message, callback) {
        callback();
      },
      remove(_tabId, callback) {
        callback();
      }
    }
  };
  try {
    const prepared = await background.externalMessage(
      safeMessage(),
      { url: "http://127.0.0.1:3000/" }
    );
    assert.equal(prepared.status, "waiting_login");
    assert.equal(prepared.stage, "login");

    const storageSnapshot = structuredClone(stored[background.SESSION_STORAGE_KEY]);
    assert.equal(storageSnapshot[safeMessage().sessionId].payload.order.id, "10");
    assert.equal(JSON.stringify(storageSnapshot).includes("password"), false);

    // La fuente de verdad es storage.session, no una variable global del worker.
    const restored = await background.internalMessage(
      { type: "GET_ACTIVE_SESSION" },
      {
        tab: { id: 73 },
        frameId: 0,
        url: "https://auth.afip.gob.ar/contribuyente_/login.xhtml?action=SYSTEM&system=rcel"
      }
    );
    assert.equal(restored.ok, true);
    assert.equal(restored.payload.order.id, "10");

    const wrongTab = await background.internalMessage(
      { type: "GET_ACTIVE_SESSION" },
      { tab: { id: 74 }, frameId: 0, url: "https://serviciosjava2.afip.gob.ar/rcel/" }
    );
    const wrongFrame = await background.internalMessage(
      { type: "GET_ACTIVE_SESSION" },
      { tab: { id: 73 }, frameId: 2, url: "https://serviciosjava2.afip.gob.ar/rcel/" }
    );
    const wrongHost = await background.internalMessage(
      { type: "GET_ACTIVE_SESSION" },
      { tab: { id: 73 }, frameId: 0, url: "https://example.com/rcel/" }
    );
    assert.equal(wrongTab.ok, false);
    assert.equal(wrongFrame.ok, false);
    assert.equal(wrongHost.ok, false);

    const representative = await background.internalMessage(
      { type: "AUTHORIZE_INTERIM_ACTION", stage: "representative" },
      { tab: { id: 73 }, frameId: 0, url: "https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp" }
    );
    assert.equal(representative.ok, true);
    assert.equal(representative.status, "waiting_representative");
    assert.equal(representative.stage, "representative");
    const repeatedRepresentative = await background.internalMessage(
      { type: "AUTHORIZE_INTERIM_ACTION", stage: "representative" },
      { tab: { id: 73 }, frameId: 0, url: "https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp" }
    );
    assert.equal(repeatedRepresentative.ok, false);
    assert.equal(repeatedRepresentative.stage, "representative");

    const visibleStatus = await background.externalMessage(
      { type: "GET_SESSION_STATUS", sessionId: safeMessage().sessionId },
      { url: "http://127.0.0.1:3000/" }
    );
    assert.equal(visibleStatus.status, "waiting_representative");
    assert.equal(visibleStatus.orderId, "10");

    const authorizedService = await background.internalMessage(
      { type: "AUTHORIZE_INTERIM_ACTION", stage: "service" },
      { tab: { id: 73 }, frameId: 0, url: "https://serviciosjava2.afip.gob.ar/rcel/" }
    );
    assert.equal(authorizedService.ok, true);
    assert.equal(authorizedService.stage, "service");
    const repeatedService = await background.internalMessage(
      { type: "AUTHORIZE_INTERIM_ACTION", stage: "service" },
      { tab: { id: 73 }, frameId: 0, url: "https://serviciosjava2.afip.gob.ar/rcel/" }
    );
    assert.equal(repeatedService.ok, false);
    assert.equal(repeatedService.stage, "service");

    const replacement = safeMessage();
    replacement.sessionId = "22345678-1234-1234-1234-123456789012";
    replacement.payload.order.id = "11";
    const replacementStatus = await background.externalMessage(
      replacement,
      { url: "http://127.0.0.1:3000/" }
    );
    assert.equal(replacementStatus.orderId, "11");
    const oldStatus = await background.externalMessage(
      { type: "GET_SESSION_STATUS", sessionId: safeMessage().sessionId },
      { url: "http://127.0.0.1:3000/" }
    );
    assert.equal(oldStatus.ok, false);
    const replacementSession = await background.internalMessage(
      { type: "GET_ACTIVE_SESSION" },
      { tab: { id: 73 }, frameId: 0, url: "https://serviciosjava2.afip.gob.ar/rcel/" }
    );
    assert.equal(replacementSession.payload.order.id, "11");

    const terminal = await background.internalMessage(
      { type: "UPDATE_SESSION", status: "review_reached", stage: "review", reason: "" },
      { tab: { id: 73 }, frameId: 0, url: "https://serviciosjava2.afip.gob.ar/rcel/" }
    );
    assert.equal(terminal.status, "review_reached");
    const lateUpdate = await background.internalMessage(
      { type: "UPDATE_SESSION", status: "fields_completed", stage: "lines", reason: "" },
      { tab: { id: 73 }, frameId: 0, url: "https://serviciosjava2.afip.gob.ar/rcel/" }
    );
    assert.equal(lateUpdate.status, "review_reached");
    assert.equal(stored[background.SESSION_STORAGE_KEY][replacement.sessionId].payload, null);
  } finally {
    global.chrome = originalChrome;
  }
});

test("TTL elimina el payload de storage.session y devuelve una interrupción cerrada", async () => {
  const originalChrome = global.chrome;
  const stored = {};
  global.chrome = {
    runtime: { lastError: null },
    storage: {
      session: {
        get(key, callback) {
          callback({ [key]: stored[key] ? structuredClone(stored[key]) : undefined });
        },
        set(values, callback) {
          Object.assign(stored, structuredClone(values));
          callback();
        }
      }
    },
    tabs: {
      sendMessage(_tabId, _message, callback) {
        callback();
      }
    }
  };
  try {
    const sessionId = safeMessage().sessionId;
    await background.writeSessionRecords({
      [sessionId]: {
        id: sessionId,
        orderId: "10",
        payload: safeMessage().payload,
        status: "waiting_login",
        stage: "login",
        reason: "",
        tabId: 73,
        updatedAt: new Date().toISOString(),
        expiresAt: Date.now() - 1
      }
    });
    const response = await background.externalMessage(
      { type: "GET_SESSION_STATUS", sessionId },
      { url: "http://127.0.0.1:3000/" }
    );
    assert.equal(response.status, "interrupted");
    assert.equal(response.reason, "timeout");
    assert.equal(stored[background.SESSION_STORAGE_KEY][sessionId].payload, null);
  } finally {
    global.chrome = originalChrome;
  }
});

test("alarma MV3 elimina el payload aun sin polling ni navegación", async () => {
  const originalChrome = global.chrome;
  const modulePath = require.resolve("../tools/arca-extension/background.js");
  const stored = {};
  let alarmListener = null;
  let createdAlarm = null;
  global.chrome = {
    runtime: { lastError: null },
    storage: {
      session: {
        get(key, callback) {
          callback({ [key]: stored[key] ? structuredClone(stored[key]) : undefined });
        },
        set(values, callback) {
          Object.assign(stored, structuredClone(values));
          callback();
        }
      }
    },
    alarms: {
      create(name, options) {
        createdAlarm = { name, options };
      },
      clear(_name, callback) {
        callback();
      },
      onAlarm: {
        addListener(listener) {
          alarmListener = listener;
        }
      }
    },
    tabs: {
      sendMessage(_tabId, _message, callback) {
        callback();
      }
    }
  };
  delete require.cache[modulePath];
  try {
    const alarmBackground = require(modulePath);
    const session = {
      id: safeMessage().sessionId,
      orderId: "10",
      payload: safeMessage().payload,
      status: "waiting_login",
      stage: "login",
      reason: "",
      tabId: 73,
      updatedAt: new Date().toISOString(),
      expiresAt: Date.now() + 60_000
    };
    await alarmBackground.writeSessionRecords({ [session.id]: session });
    alarmBackground.createExpiryAlarm(session);
    assert.equal(createdAlarm.name, alarmBackground.expiryAlarmName(session.id));
    alarmListener({ name: createdAlarm.name });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stored[alarmBackground.SESSION_STORAGE_KEY][session.id].payload, null);
    assert.equal(stored[alarmBackground.SESSION_STORAGE_KEY][session.id].status, "interrupted");
  } finally {
    delete require.cache[modulePath];
    global.chrome = originalChrome;
  }
});

test("invariante de no submit: no existe invocación de click, submit o requestSubmit", () => {
  const source = fs.readFileSync(path.join(root, "tools/arca-extension/content-script.js"), "utf8");

  assert.doesNotMatch(source, /\.click\s*\(/);
  assert.doesNotMatch(source, /\.submit\s*\(/);
  assert.doesNotMatch(source, /requestSubmit\s*\(/);
  assert.match(source, /dispatchEvent\(new MouseEvent\("click"/);
  assert.match(content.FINAL_ACTION_PATTERN.source, /confirmar/i);
  assert.equal(content.FINAL_ACTION_PATTERN.test("Obtener CAE"), true);
  assert.equal(content.FINAL_ACTION_PATTERN.test("Presentar"), true);
  assert.equal(content.interimActionAllowed({ value: "Continuar" }, "emission"), true);
  assert.equal(content.interimActionAllowed({ value: "Confirmar" }, "review"), false);
  assert.equal(content.interimActionAllowed({ value: "Generar comprobantes" }, "service"), true);
  assert.equal(content.interimActionAllowed({ value: "Generar" }, "service"), false);
});

test("eventos sintéticos finales se bloquean en captura", () => {
  const originalDocument = global.document;
  const listeners = {};
  global.document = {
    addEventListener(type, listener) {
      listeners[type] = listener;
    }
  };
  try {
    content.blockSyntheticFinalActions();
    let prevented = false;
    let stopped = false;
    const control = { value: "Confirmar" };
    listeners.click({
      isTrusted: false,
      target: { closest: () => control },
      preventDefault: () => { prevented = true; },
      stopImmediatePropagation: () => { stopped = true; }
    });
    assert.equal(prevented, true);
    assert.equal(stopped, true);
  } finally {
    global.document = originalDocument;
  }
});

test("frontend valida ID y sugiere comprobante sólo desde condiciones explícitas", () => {
  assert.equal(frontend.validExtensionId("a".repeat(32)), true);
  assert.equal(frontend.validExtensionId("z".repeat(32)), false);
  assert.equal(frontend.suggestReceiptType("responsable_inscripto", "responsable_inscripto"), "Factura_A");
  assert.equal(frontend.suggestReceiptType("responsable_inscripto", "exento"), "Factura_B");
  assert.equal(frontend.suggestReceiptType("responsable_inscripto", "monotributista"), "");
  assert.equal(frontend.suggestReceiptType("monotributista", "responsable_inscripto"), "");
  assert.equal(frontend.suggestReceiptType("", "consumidor_final"), "");
});

test("la lista presenta entrega prevista y marca hoy o mañana según calendario argentino", () => {
  const nearMidnightUtc = new Date("2026-07-31T02:30:00.000Z");
  const previousEscapeHtml = global.escapeHtml;
  const previousFormatDate = global.formatDate;
  global.escapeHtml = (value) => String(value);
  global.formatDate = (value) => {
    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
  };

  try {
    assert.equal(frontend.argentinaCalendarIso(nearMidnightUtc), "2026-07-30");
    assert.equal(frontend.expectedDeliveryTiming("2026-07-30", nearMidnightUtc), "today");
    assert.equal(frontend.expectedDeliveryTiming("2026-07-31", nearMidnightUtc), "tomorrow");
    assert.equal(frontend.expectedDeliveryTiming("2026-08-01", nearMidnightUtc), "");
    assert.equal(frontend.expectedDeliveryTiming("2026-07-29", nearMidnightUtc), "");
    assert.match(frontend.expectedDeliveryMarkup("2026-07-30", "today"), /30\/07\/2026[\s\S]*Entrega hoy/);
    assert.match(frontend.expectedDeliveryMarkup("2026-07-31", "tomorrow"), /31\/07\/2026[\s\S]*Entrega mañana/);
    assert.equal(frontend.expectedDeliveryMarkup(""), "Sin fecha prevista");
    assert.equal(frontend.expectedDeliveryMarkup("2026-02-30"), "Sin fecha prevista");
  } finally {
    global.escapeHtml = previousEscapeHtml;
    global.formatDate = previousFormatDate;
  }
});

test("fixture de extensión mapea campos permitidos y aborta pantallas inesperadas", () => {
  const payload = safeMessage().payload;
  payload.invoice.receiptType = "Factura_A";
  payload.customer.fiscalCondition = "responsable_inscripto";
  payload.customer.address = "Domicilio de prueba";

  assert.deepEqual(content.buildFieldPlan("initial", payload), [
    {
      labels: ["Punto de Ventas a utilizar", "Punto de Venta", "Punto de venta"],
      value: "00001",
      matchBy: "numeric_identifier"
    },
    {
      label: "Tipo de Comprobante",
      value: "Factura_A",
      optionText: "Factura A",
      matchBy: "visible_text"
    }
  ]);
  assert.deepEqual(content.buildFieldPlan("recipient", payload).map((field) => field.label), [
    "CUIT",
    "Condición frente al IVA",
    undefined
  ]);
  assert.deepEqual(content.buildFieldPlan("emission", payload).map((field) => field.value), [
    "2026-07-30",
    "Productos",
    "Elaboración de alimentos o bases de cereales"
  ]);
  assert.equal(content.classifyPage("La sesión ha expirado", false, "serviciosjava2.afip.gob.ar"), "session_expired");
  assert.equal(content.classifyPage("No se puede acceder al sitio. ERR_CONNECTION_RESET", false, "serviciosjava2.afip.gob.ar"), "network_error");
  assert.equal(content.classifyPage("Revisión de datos del comprobante", true, "serviciosjava2.afip.gob.ar"), "review");
  assert.equal(content.classifyPage("Seleccione la empresa representada", false, "fe.afip.gob.ar"), "representative_selection");
  assert.equal(content.classifyPage("Comprobantes en línea - Generar comprobantes", false, "serviciosjava2.afip.gob.ar"), "service_menu");
  assert.equal(content.classifyPage("Pantalla final. Generar comprobantes", true, "serviciosjava2.afip.gob.ar"), "unrecognized");
  assert.equal(content.classifyPage("Mis Comprobantes - consultar comprobantes", false, "serviciosjava2.afip.gob.ar"), "unrecognized");
  assert.equal(content.classifyPage("Punto de Venta y Tipo de Comprobante", false, "serviciosjava2.afip.gob.ar"), "initial");
  assert.equal(content.classifyPage("Paso 1 - Datos de emisión", false, "serviciosjava2.afip.gob.ar"), "emission");
  assert.equal(content.classifyPage("Pantalla nueva", false, "serviciosjava2.afip.gob.ar"), "unrecognized");
  assert.equal(content.classifyPage("Seleccione la empresa representada", false, "example.com"), "outside_service");
  assert.equal(content.payloadCoherenceIsValid(payload), true);
  payload.customer.fiscalCondition = "exento";
  assert.equal(content.payloadCoherenceIsValid(payload), false);
});

test("punto de venta se resuelve sólo por identificador único de cinco dígitos", () => {
  const select = {
    tagName: "SELECT",
    options: [
      { value: "1", textContent: "00001 — Arenales 2955, piso 7" },
      { value: "2", textContent: "000002 — Otro domicilio" }
    ]
  };
  assert.equal(content.exactOption(select, "00001", "", "numeric_identifier")?.value, "1");
  select.options[0] = { value: "1", textContent: "000002 — Otro domicilio" };
  assert.equal(content.exactOption(select, "00001", "", "numeric_identifier"), null);
  select.options[0] = { value: "1", textContent: "00001 — Arenales 2955, piso 7" };
  select.options.push({ value: "00001", textContent: "Punto alternativo" });
  assert.equal(content.exactOption(select, "00001", "", "numeric_identifier"), null);
});

test("pantalla inicial real selecciona punto 00001 y únicamente Factura A o B", () => {
  const originalDocument = global.document;
  const dispatched = [];
  const point = {
    tagName: "SELECT",
    id: "puntodeventa",
    name: "puntodeventa",
    value: "",
    options: [
      { value: "", textContent: "seleccionar..." },
      {
        value: "1",
        textContent: "00001-Arenales 2955 Piso:7 Dpto:D - Ciudad de Buenos Aires"
      }
    ],
    dispatchEvent: (event) => dispatched.push(`point:${event.type}`)
  };
  const receiptOptions = [
    { value: "1", textContent: "Factura A" },
    { value: "2", textContent: "Nota de Débito A" },
    { value: "3", textContent: "Nota de Crédito A" },
    { value: "6", textContent: "Factura B" },
    { value: "7", textContent: "Nota de Débito B" },
    { value: "201", textContent: "Factura de Crédito Electrónica MiPyMEs (FCE) A" }
  ];
  const receipt = {
    tagName: "SELECT",
    id: "tipocomprobante",
    name: "tipocomprobante",
    value: "",
    options: [{ value: "", textContent: "seleccionar..." }],
    dispatchEvent: (event) => dispatched.push(`receipt:${event.type}`)
  };
  const fields = { puntodeventa: point, tipocomprobante: receipt };
  const labels = [
    {
      textContent: "Punto de Ventas a utilizar",
      getAttribute: () => "puntodeventa",
      querySelector: () => null
    },
    {
      textContent: "Tipo de Comprobante",
      getAttribute: () => "tipocomprobante",
      querySelector: () => null
    }
  ];
  global.document = {
    querySelectorAll: (selector) => selector === "label" ? labels : [],
    getElementById: (id) => fields[id] || null
  };
  try {
    const payload = safeMessage().payload;
    payload.invoice.receiptType = "Factura_A";
    assert.deepEqual(content.completeInitialFields(payload), { ok: false, pending: true });
    assert.deepEqual([point.value, receipt.value], ["1", ""]);
    receipt.options = [{ value: "", textContent: "seleccionar..." }, ...receiptOptions];
    assert.deepEqual(content.completeInitialFields(payload), { ok: true, pending: false });
    assert.deepEqual([point.value, receipt.value], ["1", "1"]);
    payload.invoice.receiptType = "Factura_B";
    assert.deepEqual(content.completeInitialFields(payload), { ok: true, pending: false });
    assert.deepEqual([point.value, receipt.value], ["1", "6"]);
    assert.deepEqual(dispatched, [
      "point:input", "point:change",
      "receipt:input", "receipt:change",
      "receipt:input", "receipt:change"
    ]);

    receipt.value = "";
    receipt.options = [
      { value: "", textContent: "seleccionar..." },
      { value: "Factura A", textContent: "Nota de Débito A" }
    ];
    payload.invoice.receiptType = "Factura_A";
    assert.deepEqual(content.completeInitialFields(payload), { ok: false, pending: false });
    assert.equal(receipt.value, "");
  } finally {
    global.document = originalDocument;
  }
});

test("código de producto exige conjuntamente código 4 y etiqueta esperada", () => {
  const select = {
    tagName: "SELECT",
    options: [{ value: "4", textContent: "Producto o servicio" }]
  };
  assert.equal(content.exactOption(select, "4", "Producto o servicio", "code_and_label")?.value, "4");
  select.options[0] = { value: "9", textContent: "Producto o servicio" };
  assert.equal(content.exactOption(select, "4", "Producto o servicio", "code_and_label"), null);
  select.options[0] = { value: "4", textContent: "Otro concepto" };
  assert.equal(content.exactOption(select, "4", "Producto o servicio", "code_and_label"), null);
});

test("empresa representada exige nombre legal visible exacto y único", () => {
  const originalDocument = global.document;
  const personalControl = { value: "DE MAYO BENJAMIN" };
  const companyControl = { value: "SUNNUTRITION S.A." };
  const controls = [personalControl, companyControl];
  global.document = {
    querySelectorAll: () => controls
  };
  try {
    const automation = safeMessage().payload.automation;
    assert.equal(content.findRepresentativeControl(automation), companyControl);
    companyControl.value = "SUNNUTRITION";
    assert.equal(content.findRepresentativeControl(automation), null);
    companyControl.value = "SUNNUTRITION S.A.S.";
    assert.equal(content.findRepresentativeControl(automation), null);
    companyControl.value = "SUNNUTRITION S.A.";
    controls.push({ value: "sunnutrition s.a." });
    assert.equal(content.findRepresentativeControl(automation), null);
  } finally {
    global.document = originalDocument;
  }
});

test("cada etapa intermedia se reclama una sola vez", () => {
  const guard = content.createStageGuard();
  assert.equal(guard.claim("initial"), true);
  assert.equal(guard.claim("initial"), false);
  assert.equal(guard.claim("emission"), true);
});

test("fixture DOM completa campos exactos, eventos y líneas sin clicks ni submits", () => {
  const originalDocument = global.document;
  const dispatched = [];
  const field = (tagName = "INPUT", options = []) => ({
    tagName,
    id: "",
    name: "",
    value: "",
    options,
    dispatchEvent: (event) => dispatched.push(event.type)
  });
  const point = field();
  point.id = "point";
  const receipt = field("SELECT", [{ value: "A", textContent: "Factura A" }]);
  receipt.id = "receipt";
  const labels = [
    { textContent: "Punto de Venta", getAttribute: () => "point", querySelector: () => null },
    { textContent: "Tipo de Comprobante", getAttribute: () => "receipt", querySelector: () => null }
  ];
  const controls = { point, receipt };
  global.document = {
    querySelectorAll: (selector) => selector === "label" ? labels : [],
    getElementById: (id) => controls[id] || null
  };
  try {
    const payload = safeMessage().payload;
    payload.invoice.receiptType = "Factura_A";
    assert.equal(content.completeExactFields(content.buildFieldPlan("initial", payload)), true);
    assert.equal(point.value, "00001");
    assert.equal(receipt.value, "A");
    assert.deepEqual(dispatched, ["input", "change", "input", "change"]);

    const cuit = field();
    cuit.id = "cuit";
    const condition = field("SELECT", [{
      value: "RI",
      textContent: "IVA Responsable Inscripto"
    }]);
    condition.id = "condition";
    const saleCondition = field("SELECT", [{ value: "CH", textContent: "Cheque" }]);
    saleCondition.id = "sale-condition";
    Object.assign(controls, { cuit, condition, "sale-condition": saleCondition });
    labels.splice(0, labels.length,
      { textContent: "CUIT", getAttribute: () => "cuit", querySelector: () => null },
      { textContent: "Condición frente al IVA", getAttribute: () => "condition", querySelector: () => null },
      { textContent: "Condición de venta", getAttribute: () => "sale-condition", querySelector: () => null }
    );
    payload.customer.fiscalCondition = "responsable_inscripto";
    assert.equal(content.completeExactFields(content.buildFieldPlan("recipient", payload)), true);
    assert.deepEqual(
      [cuit.value, condition.value, saleCondition.value],
      ["30123456789", "RI", "CH"]
    );

    const productCode = field("SELECT", [{ value: "4", textContent: "Producto o servicio" }]);
    productCode.id = "codigo";
    const description = field();
    description.id = "descripcion";
    const quantity = field();
    quantity.id = "cantidad";
    const unit = field("SELECT", [{ value: "7", textContent: "Unidades" }]);
    unit.id = "unidad_medida";
    const price = field();
    price.id = "precio";
    const discount = field();
    discount.id = "bonificacion";
    const vat = field("SELECT", [{ value: "21", textContent: "21,00 %" }]);
    vat.id = "alicuota_iva";
    const rowControls = [productCode, description, quantity, unit, price, discount, vat];
    const row = { querySelectorAll: () => rowControls };
    global.document.querySelectorAll = (selector) => selector === "tr" ? [row] : [];
    const result = content.completeLineRows([{
      description: "Producto",
      individualUnits: 20,
      unitPrice: 100,
      discountPercent: 10,
      vatRate: 21
    }], payload.automation);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(
      [productCode.value, description.value, quantity.value, unit.value, price.value, discount.value, vat.value],
      ["4", "Barra Pop", "20", "7", "100", "10", "21"]
    );

    global.document.querySelectorAll = () => [];
    assert.equal(content.completeExactFields(content.buildFieldPlan("initial", payload)), false);
  } finally {
    global.document = originalDocument;
  }
});

test("la nueva solapa carga el módulo y los datos sólo al abrirla", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "assets/js/app.js"), "utf8");

  assert.match(html, /data-view="arca-invoicing"/);
  assert.doesNotMatch(html, /<script[^>]+src="assets\/js\/modules\/arca-invoicing\.js/);
  assert.match(app, /loadDeferredScript\(\s*"assets\/js\/modules\/arca-invoicing\.js/);
  assert.match(app, /runViewLoad\(view/);
});

test("la preparación se invalida y el ciclo de vida cancela contexto, revalida y usa fecha local", () => {
  const source = fs.readFileSync(path.join(root, "assets/js/modules/arca-invoicing.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "assets/js/app.js"), "utf8");

  assert.match(source, /arca-products-body"\)\?\.addEventListener\("change", clearPreparedState\)/);
  assert.match(source, /MAX_POLL_FAILURES = 3/);
  assert.match(source, /POLL_TIMEOUT_MS = 5 \* 60 \* 1000/);
  assert.match(source, /discardPreparedContext\("timeout"/);
  assert.match(source, /preparedBeforeRevalidation\.prepareRequest/);
  assert.match(source, /type: "CANCEL_SESSION"/);
  assert.match(source, /state\.launchSequence !== launchSequence/);
  assert.match(source, /cancelExtensionSession\(extensionId, preparedForExtension\.sessionId, \{ closeTab: true \}\)/);
  assert.match(source, /orderId, status, reason/);
  assert.match(source, /pagehide/);
  assert.match(app, /window\.cancelArcaInvoicing\?\.\("manual_abort"\)/);
  assert.equal(frontend.invoiceDateFromOrder({ fecha_entrega_prevista: "2026-07-30" }), "2026-07-30");
  assert.equal(frontend.invoiceDateFromOrder({ fecha_entrega_prevista: "2026-02-30" }), "");
  const dateInput = { value: "2026-07-01" };
  frontend.setInvoiceDateFromOrder({ fecha_entrega_prevista: "2026-07-31" }, dateInput);
  assert.equal(dateInput.value, "2026-07-31");
  frontend.setInvoiceDateFromOrder({ fecha_entrega_prevista: "" }, dateInput);
  assert.equal(dateInput.value, "");
  assert.deepEqual(frontend.buildPrepareRequest("1023", "Factura_B", "2026-07-30"), {
    orderId: "1023",
    receiptType: "Factura_B",
    invoiceDate: "2026-07-30"
  });
  assert.match(frontend.fiscalSummaryForReceipt("Factura_B"), /IVA Sujeto Exento/);
  assert.deepEqual(fiscal.validateProductInvoiceDate("2026-07-25", "2026-07-30"), { ok: true, reason: "" });
  assert.deepEqual(fiscal.validateProductInvoiceDate("2026-08-03", "2026-07-30"), {
    ok: false,
    reason: "future_month"
  });
  assert.match(frontend.extensionStatusLabel("waiting_login"), /login manual/);
  assert.match(frontend.extensionStatusLabel("waiting_representative"), /SunNutrition/);
  assert.match(frontend.extensionStatusLabel("service_recognized"), /Comprobantes en línea/);
  assert.match(frontend.extensionStatusLabel("completing_stage", "recipient"), /datos del receptor/);
});

test("una preparación tardía se cancela y cierra sólo la pestaña creada por esa carrera", () => {
  const removed = [];
  const originalChrome = global.chrome;
  global.chrome = {
    runtime: { lastError: null },
    tabs: {
      sendMessage: (_tabId, _message, callback) => callback(),
      remove: (tabId, callback) => {
        removed.push(tabId);
        callback();
      }
    }
  };
  try {
    const session = {
      id: "late-session",
      status: "waiting_user",
      reason: "",
      payload: safeMessage().payload,
      tabId: 73,
      updatedAt: new Date().toISOString()
    };
    background.cancelSession(session, "manual_abort", { closeTab: true });
    assert.deepEqual(removed, [73]);
    assert.equal(session.status, "interrupted");
    assert.equal(session.payload, null);
  } finally {
    global.chrome = originalChrome;
  }
});

test("la extensión elimina el payload al cancelar y aplica TTL autónomo", () => {
  const session = {
    id: "session",
    orderId: "10",
    payload: safeMessage().payload,
    status: "waiting_user",
    reason: "",
    tabId: null,
    updatedAt: new Date().toISOString()
  };
  background.cancelSession(session, "timeout");
  assert.equal(session.payload, null);
  assert.equal(session.status, "interrupted");
  assert.equal(session.reason, "timeout");
  assert.equal(background.SESSION_TTL_MS, 5 * 60 * 1000);
});

test("el código no persiste en disco, no expone secretos y reintenta sólo la asociación inicial", () => {
  const backgroundSource = fs.readFileSync(path.join(root, "tools/arca-extension/background.js"), "utf8");
  const contentSource = fs.readFileSync(path.join(root, "tools/arca-extension/content-script.js"), "utf8");

  assert.match(backgroundSource, /chrome\?\.storage\?\.session/);
  assert.doesNotMatch(backgroundSource, /storage\.(local|sync)/);
  assert.doesNotMatch(backgroundSource, /console\.(log|info|warn|error)/);
  assert.equal(content.MAX_SESSION_LOOKUP_ATTEMPTS, 12);
  assert.doesNotMatch(contentSource, /\.click\s*\(|\.submit\s*\(|requestSubmit\s*\(/);
});

test("la UI contiene estados, bloqueos y textos de control manual", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const view = html.match(/id="view-arca-invoicing"([\s\S]*?)id="view-sales-invoice-entry"/)?.[1] || "";

  assert.match(view, /<th scope="col">Entrega prevista<\/th>/);
  assert.match(view, /<th scope="col">Entrega<\/th>/);
  assert.doesNotMatch(view, /Entregado sin factura/);
  assert.match(view, /Datos incompletos/);
  assert.doesNotMatch(view, /Ya facturados/);
  assert.match(view, /Login, clave, MFA y CAPTCHA siempre son manuales/);
  assert.match(view, /Confirmar, Emitir, Generar,\s+Obtener CAE, Firmar o Presentar/);
  assert.doesNotMatch(view, /id="arca-(issuer-condition|recipient-condition|point-of-sale)"/);
  assert.doesNotMatch(view, /data-arca-vat|id="arca-summary-condition"/);
  assert.doesNotMatch(view, /Factura C/);
  assert.match(view, /id="arca-receipt-type"/);
  assert.match(view, /id="arca-invoice-date" type="date"/);
});
