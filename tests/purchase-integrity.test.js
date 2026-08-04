const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { EXPECTED_BACKEND_COLUMNS } = require("../backend/config/backend-columns");
const { backendId } = require("../backend/utils/ids");
const {
  createAttachmentsService,
  remitoXNumberFromText
} = require("../backend/services/attachments.service");
const { createCreditorEntryService } = require("../backend/services/creditor-entry.service");
const { createOtherExpenseEntryService } = require("../backend/services/other-expense-entry.service");
const { createPurchaseEntryService } = require("../backend/services/purchase-entry.service");
const { createReceptionEntryService } = require("../backend/services/reception-entry.service");

function createInvoiceReadHarness(fetchImpl, options = {}) {
  let result;
  const service = createAttachmentsService({
    childProcess: {},
    fetchImpl,
    fs,
    invoiceReadTimeoutMs: options.invoiceReadTimeoutMs,
    path,
    pythonExecutable: "python",
    readJsonBody: async (request) => request.body,
    rootDir: "C:\\isolated",
    sendJson: (_response, status, payload) => {
      result = { status, payload };
    }
  });
  return {
    invoke: async (body) => {
      const handler = options.sales
        ? service.handleSalesInvoiceRead
        : service.handleReceptionInvoiceRead;
      await handler({ body }, {});
      return result;
    }
  };
}

function createInvoiceProviderHealthHarness(fetchImpl, timeoutMs = 5) {
  let result;
  const service = createAttachmentsService({
    childProcess: {},
    fetchImpl,
    fs,
    invoiceProviderHealthTimeoutMs: timeoutMs,
    path,
    pythonExecutable: "python",
    readJsonBody: async () => ({}),
    rootDir: "C:\\isolated",
    sendJson: (_response, status, payload) => {
      result = { status, payload };
    }
  });
  return {
    invoke: async () => {
      await service.handleInvoiceProviderHealth({}, {});
      return result;
    }
  };
}

function facturaBReadHarness(providerInvoice) {
  return createInvoiceReadHarness(async () => ({
    ok: true,
    json: async () => ({ output_text: JSON.stringify(providerInvoice) })
  }), { sales: true });
}

function syntheticPdfDataUrl() {
  return `data:application/pdf;base64,${Buffer.from("%PDF-1.4\n%%EOF").toString("base64")}`;
}

test("lector de facturas normaliza exito y marca campos no reconocidos", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  try {
    const harness = createInvoiceReadHarness(async () => ({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          tipo_factura: "Factura_A",
          nro_factura: "0001-00000001",
          fecha_factura: "2026-07-17",
          subtotal: "240000,00",
          iva: 50400,
          total: 290400,
          per_ret_iva: "no reconocido"
        })
      })
    }));
    const result = await harness.invoke({
      fileDataUrl: syntheticPdfDataUrl(),
      fileName: "factura.pdf",
      mimeType: "application/pdf"
    });
    assert.equal(result.status, 200);
    assert.equal(result.payload.invoice.total, 290400);
    assert.equal(result.payload.invoice.per_ret_iva, null);
    assert(result.payload.missingFields.includes("per_ret_iva"));
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("Ventas normaliza el IVA incluido de Factura B y concilia al centavo", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  try {
    const exact = await facturaBReadHarness({
      tipo_factura: "Factura_B",
      subtotal: 2744280,
      iva: 476280,
      total: 2744280
    }).invoke({ fileDataUrl: syntheticPdfDataUrl(), fileName: "factura-b.pdf" });
    assert.deepEqual(
      [exact.payload.invoice.subtotal, exact.payload.invoice.iva, exact.payload.invoice.total],
      [2268000, 476280, 2744280]
    );

    const cents = await facturaBReadHarness({
      tipo_factura: "Factura_B",
      subtotal: null,
      iva: null,
      total: 100
    }).invoke({ fileDataUrl: syntheticPdfDataUrl(), fileName: "factura-b-centavos.pdf" });
    assert.deepEqual(
      [cents.payload.invoice.subtotal, cents.payload.invoice.iva, cents.payload.invoice.total],
      [82.64, 17.36, 100]
    );

    for (const total of [0, null, "importe invalido"]) {
      const partial = await facturaBReadHarness({
        tipo_factura: "Factura_B",
        subtotal: null,
        iva: null,
        total
      }).invoke({ fileDataUrl: syntheticPdfDataUrl(), fileName: "factura-b-parcial.pdf" });
      assert.equal(partial.payload.invoice.subtotal, null);
      assert.equal(partial.payload.invoice.iva, null);
      assert.equal(partial.payload.invoice.total, total === 0 ? 0 : null);
    }
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("Ventas conserva casos fiscales explícitos y no altera Factura A/B", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  try {
    for (const invoice of [
      { tipo_factura: "Factura_B", subtotal: 100, iva: 21, total: 121 },
      { tipo_factura: "Factura_A", subtotal: 200, iva: 42, total: 242 }
    ]) {
      const result = await facturaBReadHarness(invoice)
        .invoke({ fileDataUrl: syntheticPdfDataUrl(), fileName: "documento.pdf" });
      assert.equal(result.payload.invoice.subtotal, invoice.subtotal);
      assert.equal(result.payload.invoice.iva, invoice.iva);
    }

    const additionalTaxes = await facturaBReadHarness({
      tipo_factura: "Factura_B",
      subtotal: 100,
      iva: 21,
      per_ret_iibb: 3,
      total: 124
    }).invoke({ fileDataUrl: syntheticPdfDataUrl(), fileName: "factura-b-percepcion.pdf" });
    assert.equal(additionalTaxes.payload.invoice.subtotal, 100);
    assert.equal(additionalTaxes.payload.invoice.iva, 21);
    assert.equal(additionalTaxes.payload.reviewWarnings.length, 1);

    const differentRate = await facturaBReadHarness({
      tipo_factura: "Factura_B",
      iva_alicuota: 10.5,
      subtotal: 100,
      iva: 10.5,
      total: 110.5
    }).invoke({ fileDataUrl: syntheticPdfDataUrl(), fileName: "factura-b-105.pdf" });
    assert.equal(differentRate.payload.invoice.subtotal, 100);
    assert.equal(differentRate.payload.invoice.iva, 10.5);
    assert.equal(differentRate.payload.reviewWarnings.length, 1);

    const benignMetadata = await facturaBReadHarness({
      tipo_factura: "Factura_B",
      iva_alicuota: "21",
      tratamiento_iva: "IVA incluido",
      exento: "0,00",
      no_gravado: "0",
      subtotal: 2744280,
      iva: 476280,
      total: 2744280
    }).invoke({ fileDataUrl: syntheticPdfDataUrl(), fileName: "factura-b-incluido.pdf" });
    assert.equal(benignMetadata.payload.invoice.subtotal, 2268000);
    assert.equal(benignMetadata.payload.invoice.iva, 476280);
    assert.equal(benignMetadata.payload.reviewWarnings.length, 0);

    const zeroRate = await facturaBReadHarness({
      tipo_factura: "Factura_B",
      iva_alicuota: 0,
      subtotal: 100,
      iva: 0,
      total: 100
    }).invoke({ fileDataUrl: syntheticPdfDataUrl(), fileName: "factura-b-tasa-cero.pdf" });
    assert.equal(zeroRate.payload.invoice.subtotal, 100);
    assert.equal(zeroRate.payload.invoice.iva, 0);
    assert.equal(zeroRate.payload.reviewWarnings.length, 1);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("Ventas toma el correlativo adyacente y pone en cero los tributos de Remito X", async () => {
  assert.equal(remitoXNumberFromText("N° 00001 - 01018"), "01018");
  assert.equal(remitoXNumberFromText("0001-98765432"), "98765432");
  assert.notEqual(remitoXNumberFromText("N° 00001 - 01018"), "00001");

  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  try {
    const result = await facturaBReadHarness({
      tipo_factura: "Remito_X",
      nro_factura: "00001 - 01018",
      fecha_factura: "2026-08-30",
      subtotal: 500,
      iva: null,
      per_ret_iva: null,
      per_ret_iibb: null,
      imp_internos: null,
      total: 500
    }).invoke({ fileDataUrl: syntheticPdfDataUrl(), fileName: "remito-x.pdf" });

    assert.equal(result.payload.invoice.nro_factura, "01018");
    assert.equal(result.payload.invoice.subtotal, 500);
    assert.equal(result.payload.invoice.total, 500);
    assert.deepEqual([
      result.payload.invoice.iva,
      result.payload.invoice.per_ret_iva,
      result.payload.invoice.per_ret_iibb,
      result.payload.invoice.imp_internos
    ], [0, 0, 0, 0]);
    assert.equal(result.payload.missingFields.includes("iva"), false);
    assert.equal(result.payload.missingFields.includes("per_ret_iva"), false);
    assert.equal(result.payload.missingFields.includes("per_ret_iibb"), false);
    assert.equal(result.payload.missingFields.includes("imp_internos"), false);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("lector distingue configuracion, archivo invalido, red y respuesta ilegible", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  try {
    delete process.env.OPENAI_API_KEY;
    const unconfigured = await createInvoiceReadHarness(async () => {
      throw new Error("no debe llamarse");
    }).invoke({ fileDataUrl: syntheticPdfDataUrl(), fileName: "factura.pdf" });
    assert.equal(unconfigured.status, 503);
    assert.equal(unconfigured.payload.code, "SERVICE_NOT_CONFIGURED");

    const invalid = await createInvoiceReadHarness(async () => ({})).invoke({
      fileDataUrl: `data:application/pdf;base64,${Buffer.from("not-a-pdf").toString("base64")}`,
      fileName: "factura.pdf"
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.payload.code, "INVALID_FILE");

    process.env.OPENAI_API_KEY = "test-key";
    const unavailable = await createInvoiceReadHarness(async () => {
      throw new TypeError("fetch failed", { cause: { code: "EACCES" } });
    }).invoke({ fileDataUrl: syntheticPdfDataUrl(), fileName: "factura.pdf" });
    assert.equal(unavailable.status, 502);
    assert.equal(unavailable.payload.code, "SERVICE_UNAVAILABLE");
    assert.equal(unavailable.payload.details.transportCode, "eacces");
    assert(!unavailable.payload.error.includes("fetch failed"));

    const timeout = await createInvoiceReadHarness((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }), { invoiceReadTimeoutMs: 5 }).invoke({ fileDataUrl: syntheticPdfDataUrl(), fileName: "factura.pdf" });
    assert.equal(timeout.status, 504);
    assert.equal(timeout.payload.code, "SERVICE_TIMEOUT");

    const unreadable = await createInvoiceReadHarness(async () => ({
      ok: true,
      json: async () => ({ output_text: "respuesta no JSON" })
    })).invoke({ fileDataUrl: syntheticPdfDataUrl(), fileName: "factura.pdf" });
    assert.equal(unreadable.status, 502);
    assert.equal(unreadable.payload.code, "UNREADABLE_RESPONSE");
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("diagnóstico OCR corta un fetch suspendido con su timeout corto", async () => {
  const startedAt = Date.now();
  const harness = createInvoiceProviderHealthHarness((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
  }), 5);

  const result = await harness.invoke();
  assert.equal(result.status, 503);
  assert.equal(result.payload.connectivity, "unreachable");
  assert(Date.now() - startedAt < 500);
});

test("lector no propone una fecha historica anomala impresa en un remito", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  try {
    const harness = createInvoiceReadHarness(async () => ({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          tipo_factura: "Remito_X",
          nro_factura: "00001",
          fecha_factura: "1899-12-30",
          subtotal: 914760,
          total: 914760
        })
      })
    }));
    const result = await harness.invoke({
      fileDataUrl: syntheticPdfDataUrl(),
      fileName: "remito.pdf",
      mimeType: "application/pdf"
    });
    assert.equal(result.status, 200);
    assert.equal(result.payload.invoice.tipo_factura, "Remito_X");
    assert.equal(result.payload.invoice.fecha_factura, "");
    assert(result.payload.missingFields.includes("fecha_factura"));
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("lector clasifica rechazos del proveedor sin atribuirlos al PDF", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  try {
    const cases = [
      [401, { type: "authentication_error", code: "invalid_api_key" }, "PROVIDER_AUTHENTICATION"],
      [429, { type: "rate_limit_error", code: "insufficient_quota" }, "PROVIDER_QUOTA"],
      [400, { type: "invalid_request_error", code: "model_not_found", param: "model" }, "PROVIDER_MODEL"],
      [400, { type: "invalid_request_error", code: "invalid_value", param: "input" }, "PROVIDER_REQUEST"]
    ];
    for (const [status, providerError, expectedCode] of cases) {
      const result = await createInvoiceReadHarness(async () => ({
        ok: false,
        status,
        json: async () => ({ error: providerError })
      })).invoke({ fileDataUrl: syntheticPdfDataUrl(), fileName: "factura.pdf" });
      assert.equal(result.status, 502);
      assert.equal(result.payload.code, expectedCode);
      assert.notEqual(result.payload.code, "INVALID_FILE");
      assert.equal(result.payload.details.stage, "provider_response");
      assert.equal(result.payload.details.providerStatus, status);
    }
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("lector logistico evita doble envio, restaura el boton y conserva carga manual ante error", async () => {
  const button = { disabled: false, textContent: "Leer factura", dataset: {} };
  const manualNumber = { value: "MANUAL-1" };
  let fetchCalls = 0;
  let releaseFetch;
  const pendingFetch = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const context = {
    API_BASE_URL: "",
    document: {
      querySelectorAll: () => [{ dataset: { logisticsExpenseDelivery: "1" } }],
      activeElement: null
    },
    els: {
      "logistics-invoice-read": button,
      "logistics-file": { files: [{ name: "factura.pdf", type: "application/pdf" }] },
      "logistics-without-file": { checked: false },
      "logistics-expense-invoice-number": manualNumber,
      "logistics-expense-status": { textContent: "", dataset: {} }
    },
    backendId: (value) => String(value ?? "").trim(),
    isReceptionReadableAttachment: () => true,
    receptionAttachmentToDataUrl: async () => syntheticPdfDataUrl(),
    setCommercialStatus: (id, message, status) => {
      context.els[id].textContent = message;
      context.els[id].dataset.status = status;
    },
    setCommercialButtonLoading: (target, loading, text) => {
      if (loading) {
        target.dataset.originalText = target.textContent;
        target.textContent = text;
        target.disabled = true;
      } else {
        target.textContent = target.dataset.originalText;
        target.disabled = false;
      }
    },
    fetch: async () => {
      fetchCalls += 1;
      return pendingFetch;
    },
    logisticsInvoiceReadRequestId: 0,
    console
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../assets/js/modules/logistics-entry.js"), "utf8"), context);
  const first = vm.runInContext("autofillLogisticsExpenseFromAttachment()", context);
  await new Promise((resolve) => setImmediate(resolve));
  await vm.runInContext("autofillLogisticsExpenseFromAttachment()", context);
  assert.equal(fetchCalls, 1);
  assert.equal(button.disabled, true);
  releaseFetch({ ok: false, status: 503, json: async () => ({ ok: false, code: "SERVICE_UNAVAILABLE" }) });
  await first;
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Leer factura");
  assert.equal(manualNumber.value, "MANUAL-1");
  assert.equal(context.els["logistics-expense-status"].dataset.status, "error");
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nextId(rows, column) {
  return rows.reduce((maximum, row) => Math.max(maximum, Number(row[column]) || 0), 0) + 1;
}

function ensureTable(tables, name) {
  if (!tables[name]) tables[name] = { rows: [], headers: EXPECTED_BACKEND_COLUMNS[name] || [], rowCount: 0 };
}

function clean(value) {
  return String(value ?? "").trim();
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function normalize(value) {
  return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function createHarness(initialCache, options = {}) {
  let persisted = clone(initialCache);
  let saveCount = 0;
  const responses = [];
  return {
    dependencies: {
      EXPECTED_BACKEND_COLUMNS,
      backendId,
      backendNextNumericId: options.backendNextNumericId || nextId,
      backendNormalizeText: normalize,
      backendRowsById: (rows, key) => new Map(rows.map((row) => [backendId(row[key]), row])),
      cleanBackendInput: clean,
      cleanBackendText: clean,
      ensureBackendTable: ensureTable,
      isIsoDate,
      loadCache: () => clone(persisted),
      normalizeLookupText: normalize,
      readJsonBody: async (request) => request.body,
      saveBackendCache: options.saveBackendCache || ((cache) => {
        saveCount += 1;
        persisted = clone(cache);
      }),
      sendJson: (_response, status, payload) => responses.push({ status, payload })
    },
    cache: () => clone(persisted),
    responses,
    saveCount: () => saveCount
  };
}

function baseCache() {
  const tables = {};
  Object.keys(EXPECTED_BACKEND_COLUMNS).forEach((name) => ensureTable(tables, name));
  tables.proveedores.rows.push({ id_proveedor: 1, nombre: "Proveedor Uno" });
  tables.insumos.rows.push({ id_insumo: 10, nombre: "Azucar" });
  tables.insumos_proveedores.rows.push({
    id_insumos_proveedores: 20,
    id_insumo: 10,
    id_proveedor: 1,
    ud_proveedor: "Bolsa",
    cantidad_proveedor: 25
  });
  tables.empleados.rows.push({ id_empleado: 30, nombre_empleado: "Empleado Uno" });
  tables.etiquetas.rows.push({ id_etiqueta: 40, etiqueta: "Mercaderia" });
  tables.acreedores.rows.push({
    id_acreedor: 50,
    origen_tipo_acreedor: "proveedor",
    origen_id_acreedor: 1
  });
  tables.acreedores_etiquetas.rows.push({
    id_acreedor_etiqueta: 60,
    id_acreedor: 50,
    id_etiqueta: 40
  });
  return { generatedAt: "", tables };
}

async function invoke(handler, body) {
  await handler({ body }, {});
}

function purchasePayload() {
  return {
    supplier: "1",
    orderDate: "2026-07-20",
    expectedDeliveryDate: "2026-07-25",
    itemId: "20",
    itemName: "Azucar",
    quantity: 2
  };
}

function otherExpensePayload() {
  return {
    expenseDate: "2026-07-20",
    creditorId: "50",
    creditorTagId: "60",
    detail: "Servicio",
    invoiceType: "Factura_A",
    invoiceNumber: "0001-1",
    invoiceDate: "2026-07-20",
    paymentDate: "2026-07-30",
    iva: 21,
    vatRetention: 0,
    iibbRetention: 0,
    internalTaxes: 0,
    subtotal: 100,
    total: 121
  };
}

function receptionPayload(attachment = null) {
  return {
    receptionDate: "2026-07-22",
    employeeId: "30",
    entries: [{ purchaseId: "1", supplyId: "10", quantity: 50 }],
    expense: {
      invoiceType: "Factura_A",
      invoiceNumber: "0001-2",
      invoiceDate: "2026-07-22",
      paymentDate: "2026-07-30",
      iva: 21,
      vatRetention: 0,
      iibbRetention: 0,
      internalTaxes: 0,
      subtotal: 100,
      total: 121
    },
    attachment
  };
}

test("compra completa persiste encabezado y detalle una sola vez", async () => {
  const harness = createHarness(baseCache());
  const service = createPurchaseEntryService(harness.dependencies);
  await invoke(service.handlePurchaseFullEntry, purchasePayload());
  assert.equal(harness.responses[0].status, 200);
  assert.equal(harness.saveCount(), 1);
  assert.equal(harness.cache().tables.compras.rows.length, 1);
  assert.equal(harness.cache().tables.detalle_compras.rows.length, 1);
  assert.equal(harness.cache().tables.detalle_compras.rows[0].ud_proveedor, "Bolsa");
  assert.equal(harness.cache().tables.detalle_compras.rows[0].cantidad_proveedor, "25");
});

test("compra invalida o fallo de guardado no deja encabezado parcial", async () => {
  const invalid = createHarness(baseCache());
  await invoke(createPurchaseEntryService(invalid.dependencies).handlePurchaseFullEntry, { ...purchasePayload(), quantity: 0 });
  assert.equal(invalid.responses[0].status, 400);
  assert.equal(invalid.saveCount(), 0);

  const failing = createHarness(baseCache(), { saveBackendCache: () => { throw new Error("fallo de guardado"); } });
  await invoke(createPurchaseEntryService(failing.dependencies).handlePurchaseFullEntry, purchasePayload());
  assert.equal(failing.responses[0].status, 400);
  assert.equal(failing.cache().tables.compras.rows.length, 0);
  assert.equal(failing.cache().tables.detalle_compras.rows.length, 0);
});

test("compra completa conserva cantidades decimales con punto o coma sin truncarlas", async () => {
  for (const quantity of ["1092.03", "1092,03"]) {
    const harness = createHarness(baseCache());
    await invoke(createPurchaseEntryService(harness.dependencies).handlePurchaseFullEntry, { ...purchasePayload(), quantity });
    assert.equal(harness.responses[0].status, 200);
    assert.equal(harness.cache().tables.detalle_compras.rows[0].cantidad, 1092.03);
  }
});

test("compra completa rechaza cantidades no positivas o con más de dos decimales", async () => {
  for (const quantity of ["1092.034", "0", "-1", "texto"]) {
    const harness = createHarness(baseCache());
    await invoke(createPurchaseEntryService(harness.dependencies).handlePurchaseFullEntry, { ...purchasePayload(), quantity });
    assert.equal(harness.responses[0].status, 400);
    assert.match(harness.responses[0].payload.error, /cantidad debe ser positiva y tener como máximo dos decimales/);
    assert.equal(harness.saveCount(), 0);
  }
});

test("formulario de compra usa entrada decimal y no vuelve a redondear cantidades a enteros", () => {
  const markup = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const frontend = fs.readFileSync(path.join(__dirname, "..", "assets", "js", "modules", "purchase-entry.js"), "utf8");
  assert.match(markup, /id="purchase-supplier-quantity" type="text" inputmode="decimal" required/);
  assert.match(frontend, /function parsePurchaseQuantity\(value\)/);
  assert.match(frontend, /function decimalPurchaseDisplay\(value\)/);
  assert.match(frontend, /La cantidad debe ser positiva y tener como máximo dos decimales/);
  assert.doesNotMatch(frontend, /Math\.ceil\(desiredRecipeQuantity \/ recipePerSupplierUnit\)/);
});

test("otros gastos persiste ambas entidades una sola vez", async () => {
  const harness = createHarness(baseCache());
  const service = createOtherExpenseEntryService({
    ...harness.dependencies,
    synchronizeEconomicExpenses: (cache) => {
      cache.tables.gastos_economicos.rows.push({ id_gasto_economico: 1, origen_tipo: "otro_gasto" });
      return cache;
    }
  });
  await invoke(service.handleOtherExpenseFullEntry, otherExpensePayload());
  assert.equal(harness.responses[0].status, 200);
  assert.equal(harness.saveCount(), 1);
  assert.equal(harness.cache().tables.egresos.rows.length, 1);
  assert.equal(harness.cache().tables.otros_gastos.rows.length, 1);
  assert.equal(harness.cache().tables.gastos_economicos.rows.length, 1);
});

test("fallo entre las entidades de otros gastos no persiste el egreso y permite reintento", async () => {
  const failingNextId = (rows, column) => {
    if (column === "id_otros_gastos") throw new Error("fallo al crear detalle");
    return nextId(rows, column);
  };
  const failing = createHarness(baseCache(), { backendNextNumericId: failingNextId });
  await invoke(createOtherExpenseEntryService(failing.dependencies).handleOtherExpenseFullEntry, otherExpensePayload());
  assert.equal(failing.responses[0].status, 400);
  assert.equal(failing.cache().tables.egresos.rows.length, 0);

  const retry = createHarness(failing.cache());
  await invoke(createOtherExpenseEntryService(retry.dependencies).handleOtherExpenseFullEntry, otherExpensePayload());
  assert.equal(retry.responses[0].status, 200);
  assert.equal(retry.cache().tables.egresos.rows.length, 1);
});

test("recepcion completa sin adjunto persiste recepcion, detalle y egreso una sola vez", async () => {
  const cache = baseCache();
  cache.tables.compras.rows.push({ id_compra: 1, id_proveedor: 1 });
  const harness = createHarness(cache);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-reception-"));
  try {
    const service = createReceptionEntryService({ ...harness.dependencies, fs, path, rootDir });
    await invoke(service.handleReceptionFullEntry, receptionPayload());
    assert.equal(harness.responses[0].status, 200);
    assert.equal(harness.saveCount(), 1);
    assert.equal(harness.cache().tables.recepciones.rows.length, 1);
    assert.equal(harness.cache().tables.detalle_recepciones.rows.length, 1);
    assert.equal(harness.cache().tables.egresos.rows.length, 1);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("recepcion con adjunto confirma solo el archivo final", async () => {
  const cache = baseCache();
  cache.tables.compras.rows.push({ id_compra: 1, id_proveedor: 1 });
  const harness = createHarness(cache);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-reception-"));
  try {
    const service = createReceptionEntryService({ ...harness.dependencies, fs, path, rootDir });
    await invoke(service.handleReceptionFullEntry, receptionPayload({
      fileName: "factura.txt",
      mimeType: "text/plain",
      dataBase64: Buffer.from("fixture").toString("base64")
    }));
    assert.equal(harness.responses[0].status, 200);
    const relativePath = harness.cache().tables.recepciones.rows[0].archivo_recepcion;
    assert.equal(fs.existsSync(path.join(rootDir, relativePath)), true);
    const pendingDir = path.join(rootDir, "tmp", "reception-attachments-pending");
    assert.deepEqual(fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir) : [], []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("fallos de detalle o egreso ocurren antes de persistir la recepcion", async () => {
  for (const failedColumn of ["id_detalle_recepcion", "id_egreso"]) {
    const cache = baseCache();
    cache.tables.compras.rows.push({ id_compra: 1, id_proveedor: 1 });
    const harness = createHarness(cache, {
      backendNextNumericId: (rows, column) => {
        if (column === failedColumn) throw new Error(`fallo ${column}`);
        return nextId(rows, column);
      }
    });
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-reception-"));
    try {
      await invoke(createReceptionEntryService({ ...harness.dependencies, fs, path, rootDir }).handleReceptionFullEntry, receptionPayload());
      assert.equal(harness.responses[0].status, 400);
      assert.equal(harness.saveCount(), 0);
      assert.equal(harness.cache().tables.recepciones.rows.length, 0);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test("fallo despues del adjunto temporal limpia el archivo sin persistir filas", async () => {
  const cache = baseCache();
  cache.tables.compras.rows.push({ id_compra: 1, id_proveedor: 1 });
  const harness = createHarness(cache, { saveBackendCache: () => { throw new Error("fallo cache"); } });
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-reception-"));
  try {
    await invoke(createReceptionEntryService({ ...harness.dependencies, fs, path, rootDir }).handleReceptionFullEntry, receptionPayload({
      fileName: "factura.txt",
      dataBase64: Buffer.from("fixture").toString("base64")
    }));
    assert.equal(harness.responses[0].status, 400);
    const pendingDir = path.join(rootDir, "tmp", "reception-attachments-pending");
    assert.deepEqual(fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir) : [], []);
    assert.equal(harness.cache().tables.recepciones.rows.length, 0);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("fallo al confirmar adjunto restaura snapshot y limpia temporales", async () => {
  const cache = baseCache();
  cache.tables.compras.rows.push({ id_compra: 1, id_proveedor: 1 });
  const harness = createHarness(cache);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-reception-"));
  const failingFs = { ...fs, renameSync: () => { throw new Error("fallo confirmacion"); } };
  try {
    await invoke(createReceptionEntryService({ ...harness.dependencies, fs: failingFs, path, rootDir }).handleReceptionFullEntry, receptionPayload({
      fileName: "factura.txt",
      dataBase64: Buffer.from("fixture").toString("base64")
    }));
    assert.equal(harness.responses[0].status, 400);
    assert.equal(harness.saveCount(), 2);
    assert.equal(harness.cache().tables.recepciones.rows.length, 0);
    const pendingDir = path.join(rootDir, "tmp", "reception-attachments-pending");
    assert.deepEqual(fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir) : [], []);

    const retryHarness = createHarness(harness.cache());
    await invoke(createReceptionEntryService({ ...retryHarness.dependencies, fs, path, rootDir }).handleReceptionFullEntry, receptionPayload());
    assert.equal(retryHarness.responses[0].status, 200);
    assert.equal(retryHarness.cache().tables.recepciones.rows.length, 1);
    assert.equal(retryHarness.cache().tables.detalle_recepciones.rows.length, 1);
    assert.equal(retryHarness.cache().tables.egresos.rows.length, 1);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("endpoints especializados responden 400 ante payload invalido sin guardar", async () => {
  const cache = baseCache();
  cache.tables.compras.rows.push({ id_compra: 1, id_proveedor: 1 });
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-reception-"));
  try {
    const otherExpense = createHarness(cache);
    await invoke(createOtherExpenseEntryService(otherExpense.dependencies).handleOtherExpenseFullEntry, {});
    assert.equal(otherExpense.responses[0].status, 400);
    assert.equal(otherExpense.saveCount(), 0);

    const reception = createHarness(cache);
    await invoke(createReceptionEntryService({ ...reception.dependencies, fs, path, rootDir }).handleReceptionFullEntry, {});
    assert.equal(reception.responses[0].status, 400);
    assert.equal(reception.saveCount(), 0);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("alta integral falla sin persistir y el reintento reutiliza registros sin duplicar", async () => {
  const cache = baseCache();
  cache.tables.proveedores.rows = [];
  cache.tables.acreedores.rows = [];
  cache.tables.acreedores_etiquetas.rows = [];
  const conflictCache = clone(cache);
  conflictCache.tables.datos_bancarios.rows.push({ id_dato_bancario: 1, detalle: "CBU-X", id_acreedor: 999 });
  const conflict = createHarness(conflictCache);
  const payload = {
    originType: "proveedor",
    name: "Proveedor Nuevo",
    idEtiqueta: 40,
    bankDetail: "CBU-X",
    extra: { pedido_minimo: "$ 999.645,25" },
    supplierItems: [{ idInsumo: 10, udProveedor: "Bolsa", cantidadProveedor: 25 }]
  };
  await invoke(createCreditorEntryService(conflict.dependencies).handleCreditorCreate, payload);
  assert.equal(conflict.responses[0].status, 409);
  assert.equal(conflict.saveCount(), 0);
  assert.equal(conflict.cache().tables.proveedores.rows.length, 0);

  const retry = createHarness(cache);
  const service = createCreditorEntryService(retry.dependencies);
  await invoke(service.handleCreditorCreate, { ...payload, bankDetail: "" });
  await invoke(service.handleCreditorCreate, { ...payload, bankDetail: "" });
  assert.equal(retry.responses[0].status, 200);
  assert.equal(retry.responses[1].status, 200);
  assert.equal(retry.cache().tables.proveedores.rows.length, 1);
  assert.equal(retry.cache().tables.proveedores.rows[0].pedido_minimo, 999645.25);
  assert.equal(retry.cache().tables.acreedores.rows.length, 1);
  assert.equal(retry.cache().tables.insumos_proveedores.rows.length, 1);

  const invalidMoney = createHarness(cache);
  await invoke(createCreditorEntryService(invalidMoney.dependencies).handleCreditorCreate, {
    ...payload,
    name: "Proveedor con subcentavos",
    bankDetail: "",
    extra: { pedido_minimo: "10,123" }
  });
  assert.equal(invalidMoney.responses[0].status, 400);
  assert.equal(invalidMoney.saveCount(), 0);
});
