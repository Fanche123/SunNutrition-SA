const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const background = require("../tools/arca-extension/background.js");
const content = require("../tools/arca-extension/content-script.js");
const frontend = require("../assets/js/modules/arca-invoicing.js");

function safeMessage() {
  return {
    type: "PREPARE_SESSION",
    sessionId: "12345678-1234-1234-1234-123456789012",
    payload: {
      contractVersion: 1,
      mode: "review_only",
      finalSubmissionAllowed: false,
      revision: "a".repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      order: { id: "10" },
      customer: { cuit: "30123456789" },
      invoice: { pointOfSale: "00001" },
      lines: [{ description: "Producto" }]
    }
  };
}

test("manifest limita hosts y usa sólo almacenamiento efímero de sesión", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "tools/arca-extension/manifest.json"), "utf8"));

  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(manifest.host_permissions.sort(), [
    "https://auth.afip.gob.ar/*",
    "https://serviciosjava2.afip.gob.ar/*"
  ]);
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
});

test("mensajes externos sólo aceptan loopback explícito", () => {
  assert.equal(background.trustedExternalSender({ url: "http://127.0.0.1:3000/" }), true);
  assert.equal(background.trustedExternalSender({ url: "http://127.0.0.1:3300/" }), false);
  assert.equal(background.trustedExternalSender({ url: "http://localhost:3000/" }), false);
  assert.equal(background.trustedExternalSender({ url: "https://example.com/" }), false);
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
    assert.equal(wrongTab.ok, false);
    assert.equal(wrongFrame.ok, false);

    const representative = await background.internalMessage(
      { type: "UPDATE_SESSION", status: "waiting_representative", stage: "representative", reason: "" },
      { tab: { id: 73 }, frameId: 0, url: "https://serviciosjava2.afip.gob.ar/rcel/" }
    );
    assert.equal(representative.status, "waiting_representative");
    assert.equal(representative.stage, "representative");

    const visibleStatus = await background.externalMessage(
      { type: "GET_SESSION_STATUS", sessionId: safeMessage().sessionId },
      { url: "http://127.0.0.1:3000/" }
    );
    assert.equal(visibleStatus.status, "waiting_representative");
    assert.equal(visibleStatus.orderId, "10");

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

test("invariante de no submit: no existe invocación de click, submit o requestSubmit", () => {
  const source = fs.readFileSync(path.join(root, "tools/arca-extension/content-script.js"), "utf8");

  assert.doesNotMatch(source, /\.click\s*\(/);
  assert.doesNotMatch(source, /\.submit\s*\(/);
  assert.doesNotMatch(source, /requestSubmit\s*\(/);
  assert.match(content.FINAL_ACTION_PATTERN.source, /confirmar/i);
  assert.equal(content.FINAL_ACTION_PATTERN.test("Obtener CAE"), true);
  assert.equal(content.FINAL_ACTION_PATTERN.test("Presentar"), true);
});

test("frontend valida ID y sugiere comprobante sólo desde condiciones explícitas", () => {
  assert.equal(frontend.validExtensionId("a".repeat(32)), true);
  assert.equal(frontend.validExtensionId("z".repeat(32)), false);
  assert.equal(frontend.suggestReceiptType("responsable_inscripto", "monotributista"), "Factura_A");
  assert.equal(frontend.suggestReceiptType("responsable_inscripto", "consumidor_final"), "Factura_B");
  assert.equal(frontend.suggestReceiptType("monotributista", "responsable_inscripto"), "Factura_C");
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
    { label: "Punto de Venta", value: "00001" },
    { label: "Tipo de Comprobante", value: "Factura_A", optionText: "Factura A" }
  ]);
  assert.deepEqual(content.buildFieldPlan("recipient", payload).map((field) => field.label), [
    "CUIT",
    "Condición frente al IVA",
    "Domicilio Comercial"
  ]);
  assert.equal(content.classifyPage("La sesión ha expirado", false, "serviciosjava2.afip.gob.ar"), "session_expired");
  assert.equal(content.classifyPage("No se puede acceder al sitio. ERR_CONNECTION_RESET", false, "serviciosjava2.afip.gob.ar"), "network_error");
  assert.equal(content.classifyPage("Revisión de datos del comprobante", true, "serviciosjava2.afip.gob.ar"), "review");
  assert.equal(content.classifyPage("Seleccione la empresa representada", false, "serviciosjava2.afip.gob.ar"), "representative_selection");
  assert.equal(content.classifyPage("Comprobantes en línea - Generar comprobantes", false, "serviciosjava2.afip.gob.ar"), "service_menu");
  assert.equal(content.classifyPage("Mis Comprobantes - consultar comprobantes", false, "serviciosjava2.afip.gob.ar"), "unrecognized");
  assert.equal(content.classifyPage("Punto de Venta y Tipo de Comprobante", false, "serviciosjava2.afip.gob.ar"), "initial");
  assert.equal(content.classifyPage("Pantalla nueva", false, "serviciosjava2.afip.gob.ar"), "unrecognized");
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
    const address = field();
    address.id = "address";
    Object.assign(controls, { cuit, condition, address });
    labels.splice(0, labels.length,
      { textContent: "CUIT", getAttribute: () => "cuit", querySelector: () => null },
      { textContent: "Condición frente al IVA", getAttribute: () => "condition", querySelector: () => null },
      { textContent: "Domicilio Comercial", getAttribute: () => "address", querySelector: () => null }
    );
    payload.customer.fiscalCondition = "responsable_inscripto";
    payload.customer.address = "Domicilio de prueba";
    assert.equal(content.completeExactFields(content.buildFieldPlan("recipient", payload)), true);
    assert.deepEqual(
      [cuit.value, condition.value, address.value],
      ["30123456789", "RI", "Domicilio de prueba"]
    );

    const description = field();
    description.id = "descripcion";
    const quantity = field();
    quantity.id = "cantidad";
    const price = field();
    price.id = "precio";
    const discount = field();
    discount.id = "bonificacion";
    const vat = field("SELECT", [{ value: "21", textContent: "21,00 %" }]);
    vat.id = "alicuota_iva";
    const rowControls = [description, quantity, price, discount, vat];
    const row = { querySelectorAll: () => rowControls };
    global.document.querySelectorAll = (selector) => selector === "tr" ? [row] : [];
    const result = content.completeLineRows([{
      description: "Producto",
      individualUnits: 20,
      unitPrice: 100,
      discountPercent: 10,
      vatRate: 21
    }]);
    assert.equal(result.ok, true);
    assert.deepEqual(
      [description.value, quantity.value, price.value, discount.value, vat.value],
      ["Producto", "20", "100", "10", "21"]
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
  assert.equal(frontend.localDateIso(new Date(2026, 6, 30, 23, 30)), "2026-07-30");
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
  assert.match(view, /Confirmar, Emitir, Generar, Obtener CAE, Firmar o Presentar/);
});
