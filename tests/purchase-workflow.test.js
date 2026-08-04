const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createRequestHandler } = require("../backend/routes/router");
const { createPurchaseWorkflowService } = require("../backend/services/purchase-workflow.service");

function harness() {
  let cache = { tables: {
    compras: { rows: [{ id_compra: 199, id_proveedor: 1, fecha_pedido: "2026-07-01", fecha_entrega_prevista: "2026-08-01" }] },
    detalle_compras: { rows: [{ id_detalle_compra: 1, id_compra: 199, id_insumos_proveedores: 1, cantidad: 10 }] },
    insumos_proveedores: { rows: [{ id_insumos_proveedores: 1, id_insumo: 1, id_proveedor: 1, cantidad_proveedor: 1, ud_proveedor: "kg" }] },
    insumos: { rows: [{ id_insumo: 1, nombre: "Avena", cantidad_receta: 1, ud_receta: "kg" }] }, items: { rows: [] },
    proveedores: { rows: [{ id_proveedor: 1, nombre: "Proveedor" }] }, empleados: { rows: [{ id_empleado: 1 }] }, etiquetas: { rows: [{ id_etiqueta: 1, etiqueta: "Mercaderia" }] },
    acreedores: { rows: [{ id_acreedor: 1, origen_tipo_acreedor: "Proveedor", origen_id_acreedor: 1 }] }, acreedores_etiquetas: { rows: [{ id_acreedor_etiqueta: 1, id_acreedor: 1, id_etiqueta: 1 }] },
    recepciones: { rows: [] }, detalle_recepciones: { rows: [] }, egresos: { rows: [] }
  } };
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "purchase-workflow-"));
  let body = {};
  const service = createPurchaseWorkflowService({
    backendId: (value) => String(value ?? "").trim(), backendNextNumericId: (rows, key) => Math.max(0, ...rows.map((row) => Number(row[key]) || 0)) + 1,
    ensureBackendTable: (tables, name) => { if (!tables[name]) tables[name] = { rows: [] }; }, fs, path, rootDir,
    isIsoDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)),
    loadCache: () => JSON.parse(JSON.stringify(cache)), saveBackendCache: (value) => { cache = value; }, readJsonBody: async () => body,
    sendJson: (_response, status, payload) => { _response.status = status; _response.payload = payload; }
  });
  async function call(handler, input = {}) { body = input; const response = {}; await handler({}, response); return response; }
  return { service, call, cache: () => cache, cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }) };
}

test("workflow supports partial reception, rejects excess and is idempotent", async () => {
  const h = harness();
  try {
    let result = await h.call(h.service.handleReception, { purchaseId: 199, receptionDate: "2026-08-01", employeeId: 1, entries: [{ supplyId: 1, quantity: 4 }], requestKey: "partial-1" });
    assert.equal(result.status, 200);
    result = await h.call(h.service.handleReception, { purchaseId: 199, receptionDate: "2026-08-02", employeeId: 1, entries: [{ supplyId: 1, quantity: 7 }], requestKey: "excess" });
    assert.equal(result.status, 400); assert.match(result.payload.error, /supera lo pendiente/);
    result = await h.call(h.service.handleReception, { purchaseId: 199, receptionDate: "2026-08-01", employeeId: 1, entries: [{ supplyId: 1, quantity: 4 }], requestKey: "partial-1" });
    assert.equal(result.payload.duplicate, true); assert.equal(h.cache().tables.recepciones.rows.length, 1);
    result = await h.call(h.service.handleReception, { purchaseId: 199, receptionDate: "2026-08-02", employeeId: 1, entries: [{ supplyId: 1, quantity: 3 }, { supplyId: 1, quantity: 3 }], requestKey: "duplicated-item" });
    assert.equal(result.status, 400); assert.match(result.payload.error, /una sola vez/);
    result = await h.call(h.service.handleReception, { purchaseId: 199, receptionDate: "2026-08-02", employeeId: 1, entries: [{ supplyId: 1, quantity: 6 }], requestKey: "partial-2" });
    assert.equal(result.status, 200);
    const list = await h.call(h.service.handleList); assert.equal(list.payload.pending[0].receptionState, "complete");
  } finally { h.cleanup(); }
});

test("pending workflow starts at purchase 199 regardless of delivery date and keeps closed purchases managed", async () => {
  const h = harness();
  try {
    h.cache().tables.compras.rows = [
      { id_compra: 198, id_proveedor: 1, fecha_entrega_prevista: "2026-07-31" },
      { id_compra: 199, id_proveedor: 1, fecha_entrega_prevista: "2026-07-31" },
      { id_compra: 200, id_proveedor: 1, fecha_entrega_prevista: "2026-08-01" },
      { id_compra: 201, id_proveedor: 1, fecha_entrega_prevista: "2026-08-02" },
      { id_compra: 202, id_proveedor: 1, fecha_entrega_prevista: "" },
      { id_compra: 203, id_proveedor: 1, fecha_entrega_prevista: "fecha-invalida" }
    ];
    h.cache().tables.gestion_compras = { rows: [
      { id_gestion_compra: 1, id_compra: 198, cerrado_en: "2026-08-01T12:00:00.000Z" },
      { id_gestion_compra: 2, id_compra: 200, cerrado_en: "2026-08-01T12:00:00.000Z" }
    ] };
    const result = await h.call(h.service.handleList);
    assert.deepEqual(result.payload.pending.map((row) => row.purchaseId), ["199", "201", "202", "203"]);
    assert.deepEqual(result.payload.managed.map((row) => row.purchaseId), ["200"]);
  } finally { h.cleanup(); }
});

test("GET /api/purchases/workflow exposes purchase 199 through the routed API contract", async () => {
  const h = harness();
  try {
    h.cache().tables.compras.rows = [
      { id_compra: 198, id_proveedor: 1, fecha_entrega_prevista: "2026-07-14" },
      { id_compra: 199, id_proveedor: 1, fecha_entrega_prevista: "2026-07-14" }
    ];
    const router = createRequestHandler({
      applyRequestAccess: async () => true,
      backendColumnsMap: () => ({}), backendOverview: () => ({}), backendSchema: () => ({}),
      handlers: { handlePurchaseWorkflowList: h.service.handleList },
      sendJson: (_response, status, payload) => { _response.status = status; _response.payload = payload; },
      serveStaticFile: () => {}
    });
    const response = {};
    await router({ method: "GET", url: "/api/purchases/workflow", headers: { host: "127.0.0.1:3000" } }, response);
    assert.equal(response.status, 200);
    assert.deepEqual(response.payload.pending.map((row) => row.purchaseId), ["199"]);
  } finally { h.cleanup(); }
});

test("workflow keeps each pending quantity and its canonical unit after a partial reception", async () => {
  const h = harness();
  try {
    h.cache().tables.detalle_compras.rows = [
      { id_detalle_compra: 1, id_compra: 199, id_insumos_proveedores: 1, cantidad: 10 },
      { id_detalle_compra: 2, id_compra: 199, id_insumos_proveedores: 2, cantidad: 5 }
    ];
    h.cache().tables.insumos_proveedores.rows.push({ id_insumos_proveedores: 2, id_insumo: 2, id_proveedor: 1, cantidad_proveedor: 1, ud_proveedor: "Ud" });
    h.cache().tables.insumos.rows = [
      { id_insumo: 1, nombre: "Aceite", cantidad_receta: 1, ud_receta: "Lt" },
      { id_insumo: 2, nombre: "Bolsa", cantidad_receta: 1, ud_receta: "Ud" }
    ];
    h.cache().tables.recepciones.rows.push({ id_recepcion: 1, id_compra: 199 });
    h.cache().tables.detalle_recepciones.rows.push({ id_detalle_recepcion: 1, id_recepcion: 1, id_insumo: 1, cantidad_recibida: 4 });
    const result = await h.call(h.service.handleList);
    assert.deepEqual(result.payload.pending[0].items.map((item) => ({ supplyId: item.supplyId, pending: item.pending, supplierUnit: item.supplierUnit })), [
      { supplyId: "1", pending: 6, supplierUnit: "kg" },
      { supplyId: "2", pending: 5, supplierUnit: "Ud" }
    ]);
  } finally { h.cleanup(); }
});

test("workflow preserves the supplier presentation snapshotted on a historical purchase", async () => {
  const h = harness();
  try {
    h.cache().tables.compras.rows = [{ id_compra: 204, id_proveedor: 1, fecha_entrega_prevista: "2026-07-30" }];
    h.cache().tables.detalle_compras.rows = [{ id_detalle_compra: 1, id_compra: 204, id_insumos_proveedores: 1, id_insumo: 1, cantidad: 100, cantidad_proveedor: 25, ud_proveedor: "Pack_25Ud" }];
    h.cache().tables.insumos_proveedores.rows = [{ id_insumos_proveedores: 1, id_insumo: 1, id_proveedor: 1, cantidad_proveedor: 20, ud_proveedor: "Pack_20Ud" }];
    h.cache().tables.insumos.rows = [{ id_insumo: 1, nombre: "Caja_140", cantidad_receta: 20, ud_receta: "Ud" }];
    h.cache().tables.recepciones.rows = [{ id_recepcion: 1, id_compra: 204 }];
    h.cache().tables.detalle_recepciones.rows = [{ id_detalle_recepcion: 1, id_recepcion: 1, id_insumo: 1, cantidad_recibida: 40 }];
    const result = await h.call(h.service.handleList);
    assert.deepEqual(result.payload.pending[0].items.map((item) => ({ ordered: item.ordered, received: item.received, pending: item.pending, supplierUnit: item.supplierUnit })), [
      { ordered: 100, received: 40, pending: 60, supplierUnit: "Pack_25Ud" }
    ]);
    const rejected = await h.call(h.service.handleReception, { purchaseId: 204, receptionDate: "2026-08-01", employeeId: 1, entries: [{ supplyId: 1, quantity: 61 }], requestKey: "over-historical-pending" });
    assert.equal(rejected.status, 400);
  } finally { h.cleanup(); }
});

test("workflow rejects a selected employee who is no longer active", async () => {
  const h = harness();
  try {
    h.cache().tables.empleados.rows = [{ id_empleado: 1, nombre_empleado: "Activo", fecha_baja: "" }, { id_empleado: 2, nombre_empleado: "Baja", fecha_baja: "2026-01-01" }];
    const result = await h.call(h.service.handleReception, { purchaseId: 199, receptionDate: "2026-08-01", employeeId: 2, entries: [{ supplyId: 1, quantity: 1 }], requestKey: "inactive-employee" });
    assert.equal(result.status, 400);
    assert.match(result.payload.error, /no existe o no está activo/);
  } finally { h.cleanup(); }
});

test("reception popup contract loads active employees, defaults Alcarez, shows pending units and preserves valid civil dates", () => {
  const frontend = fs.readFileSync(path.join(__dirname, "..", "assets", "js", "modules", "purchase-workflow.js"), "utf8");
  const markup = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(markup, /<select name="employeeId" required>/);
  assert.match(frontend, /backendTableRowsForEntry\("empleados"\)/);
  assert.match(frontend, /DEFAULT_RECEPTION_EMPLOYEE = "Alcarez_Pablo_Nicolas"/);
  assert.match(frontend, /input\.value = item\.pending/);
  assert.match(frontend, /purchase-workflow-unit/);
  assert.match(frontend, /function plannedReceptionDate\(purchase\)/);
  assert.match(frontend, /Date\.UTC\(year, month - 1, day\)/);
  assert.match(frontend, /value = plannedReceptionDate\(purchase\)/);
  assert.doesNotMatch(frontend, /receptionDate\]\"\)\.value = new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
  const context = { document: { addEventListener: () => {}, querySelector: () => null } };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(frontend.replace(/\}\)\(\);\s*$/, "globalThis.plannedReceptionDateForTest = plannedReceptionDate; })();"), context);
  assert.equal(context.plannedReceptionDateForTest({ expectedDeliveryDate: "2026-07-14" }), "2026-07-14");
  assert.equal(context.plannedReceptionDateForTest({ expectedDeliveryDate: "2026-02-30" }), "");
  assert.equal(context.plannedReceptionDateForTest({ expectedDeliveryDate: "" }), "");
});

test("close is backend-gated by a real expense and attachment", async () => {
  const h = harness();
  try {
    await h.call(h.service.handleReception, { purchaseId: 199, receptionDate: "2026-08-01", employeeId: 1, entries: [{ supplyId: 1, quantity: 10 }], requestKey: "receive" });
    let result = await h.call(h.service.handleClose, { purchaseId: 199, user: "tester" }); assert.equal(result.status, 400);
    result = await h.call(h.service.handleInvoice, { purchaseId: 199, requestKey: "invoice", expense: { invoiceType: "Factura_A", invoiceNumber: "1", invoiceDate: "2026-08-01", subtotal: 100, iva: 21, total: 121 }, attachment: { fileName: "factura.pdf", dataBase64: Buffer.from("pdf").toString("base64") } });
    assert.equal(result.status, 200); assert.equal(h.cache().tables.egresos.rows.length, 1);
    result = await h.call(h.service.handleClose, { purchaseId: 199, user: "tester" }); assert.equal(result.status, 200);
    result = await h.call(h.service.handleClose, { purchaseId: 199, user: "tester" }); assert.equal(result.payload.duplicate, true);
    const list = await h.call(h.service.handleList); assert.equal(list.payload.pending.length, 0); assert.equal(list.payload.managed.length, 1);
  } finally { h.cleanup(); }
});
