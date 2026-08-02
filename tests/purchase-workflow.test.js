const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createPurchaseWorkflowService } = require("../backend/services/purchase-workflow.service");

function harness() {
  let cache = { tables: {
    compras: { rows: [{ id_compra: 1, id_proveedor: 1, fecha_pedido: "2026-07-01", fecha_entrega_prevista: "2026-08-01" }] },
    detalle_compras: { rows: [{ id_detalle_compra: 1, id_compra: 1, id_insumos_proveedores: 1, cantidad: 10 }] },
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
    now: () => new Date("2026-08-01T12:00:00Z"),
    sendJson: (_response, status, payload) => { _response.status = status; _response.payload = payload; }
  });
  async function call(handler, input = {}) { body = input; const response = {}; await handler({}, response); return response; }
  return { service, call, cache: () => cache, cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }) };
}

test("workflow supports partial reception, rejects excess and is idempotent", async () => {
  const h = harness();
  try {
    let result = await h.call(h.service.handleReception, { purchaseId: 1, receptionDate: "2026-08-01", employeeId: 1, entries: [{ supplyId: 1, quantity: 4 }], requestKey: "partial-1" });
    assert.equal(result.status, 200);
    result = await h.call(h.service.handleReception, { purchaseId: 1, receptionDate: "2026-08-02", employeeId: 1, entries: [{ supplyId: 1, quantity: 7 }], requestKey: "excess" });
    assert.equal(result.status, 400); assert.match(result.payload.error, /supera lo pendiente/);
    result = await h.call(h.service.handleReception, { purchaseId: 1, receptionDate: "2026-08-01", employeeId: 1, entries: [{ supplyId: 1, quantity: 4 }], requestKey: "partial-1" });
    assert.equal(result.payload.duplicate, true); assert.equal(h.cache().tables.recepciones.rows.length, 1);
    result = await h.call(h.service.handleReception, { purchaseId: 1, receptionDate: "2026-08-02", employeeId: 1, entries: [{ supplyId: 1, quantity: 3 }, { supplyId: 1, quantity: 3 }], requestKey: "duplicated-item" });
    assert.equal(result.status, 400); assert.match(result.payload.error, /una sola vez/);
    result = await h.call(h.service.handleReception, { purchaseId: 1, receptionDate: "2026-08-02", employeeId: 1, entries: [{ supplyId: 1, quantity: 6 }], requestKey: "partial-2" });
    assert.equal(result.status, 200);
    const list = await h.call(h.service.handleList); assert.equal(list.payload.pending[0].receptionState, "complete");
  } finally { h.cleanup(); }
});

test("pending workflow excludes past deliveries in Buenos Aires and keeps reviewable dates", async () => {
  const h = harness();
  try {
    h.cache().tables.compras.rows = [
      { id_compra: 1, id_proveedor: 1, fecha_entrega_prevista: "2026-07-31" },
      { id_compra: 2, id_proveedor: 1, fecha_entrega_prevista: "2026-08-01" },
      { id_compra: 3, id_proveedor: 1, fecha_entrega_prevista: "2026-08-02" },
      { id_compra: 4, id_proveedor: 1, fecha_entrega_prevista: "" },
      { id_compra: 5, id_proveedor: 1, fecha_entrega_prevista: "fecha-invalida" }
    ];
    const result = await h.call(h.service.handleList);
    assert.deepEqual(result.payload.pending.map((row) => row.purchaseId), ["2", "3", "4", "5"]);
    assert.equal(result.payload.managed.length, 0);
  } finally { h.cleanup(); }
});

test("close is backend-gated by a real expense and attachment", async () => {
  const h = harness();
  try {
    await h.call(h.service.handleReception, { purchaseId: 1, receptionDate: "2026-08-01", employeeId: 1, entries: [{ supplyId: 1, quantity: 10 }], requestKey: "receive" });
    let result = await h.call(h.service.handleClose, { purchaseId: 1, user: "tester" }); assert.equal(result.status, 400);
    result = await h.call(h.service.handleInvoice, { purchaseId: 1, requestKey: "invoice", expense: { invoiceType: "Factura_A", invoiceNumber: "1", invoiceDate: "2026-08-01", subtotal: 100, iva: 21, total: 121 }, attachment: { fileName: "factura.pdf", dataBase64: Buffer.from("pdf").toString("base64") } });
    assert.equal(result.status, 200); assert.equal(h.cache().tables.egresos.rows.length, 1);
    result = await h.call(h.service.handleClose, { purchaseId: 1, user: "tester" }); assert.equal(result.status, 200);
    result = await h.call(h.service.handleClose, { purchaseId: 1, user: "tester" }); assert.equal(result.payload.duplicate, true);
    const list = await h.call(h.service.handleList); assert.equal(list.payload.pending.length, 0); assert.equal(list.payload.managed.length, 1);
  } finally { h.cleanup(); }
});
