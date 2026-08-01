const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const {
  createBackupManifest,
  migrateSalesWorkflow,
  rollbackSalesWorkflow,
  verifyBackup
} = require("../backend/migrations/20260731-sales-workflow");
const {
  createSalesWorkflowService,
  workflowRows
} = require("../backend/services/sales-workflow.service");
const { createBackendTableService } = require("../backend/services/backend-table.service");

const backendId = (value) => value === null || value === undefined || value === "" ? "" : String(value);
const nextId = (rows, key) => rows.reduce((max, row) => Math.max(max, Number(row[key]) || 0), 0) + 1;

function cacheFixture() {
  return {
    generatedAt: "",
    tables: {
      clientes: { rows: [{ id_cliente: 1, nombre_cliente: "Cliente Uno" }] },
      productos: { rows: [{ id_producto: 10, nombre_producto: "Barra", cantidad_individual: 12 }] },
      pedidos: { rows: [
        { id_pedido: 1, id_cliente: 1, fecha_pedido: "2026-07-01", fecha_entrega: "2026-07-10" },
        { id_pedido: 2, id_cliente: 1, fecha_pedido: "2026-07-02", fecha_entrega: "2026-07-08" },
        { id_pedido: 3, id_cliente: 1, fecha_pedido: "2026-07-03", fecha_entrega: "2026-07-09" }
      ] },
      detalle_pedidos: { rows: [
        { id_detalle_pedido: 1, id_pedido: 1, id_producto: 10, cantidad_cajas: 2, precio_ud: 10, bonificacion: 0 },
        { id_detalle_pedido: 2, id_pedido: 2, id_producto: 10, cantidad_cajas: 1, precio_ud: 10, bonificacion: 0 },
        { id_detalle_pedido: 3, id_pedido: 3, id_producto: 10, cantidad_cajas: 3, precio_ud: 10, bonificacion: 0 }
      ] },
      entregas: { rows: [{ id_entrega: 20, fecha: "2026-07-08" }, { id_entrega: 30, fecha: "2026-07-09" }] },
      entregas_detalle: { rows: [
        { id_entregas_detalle: 1, id_entrega: 20, id_pedido: 2 },
        { id_entregas_detalle: 2, id_entrega: 30, id_pedido: 3 }
      ] },
      ventas: { rows: [
        { id_venta: 20, id_pedido: 2, id_cliente: 1, total: 121 },
        { id_venta: 30, id_pedido: 3, id_cliente: 1, total: 121 }
      ] },
      gestion_ventas: { rows: [{
        id_gestion_venta: 1,
        id_pedido: 3,
        origen: "gestion_ventas",
        factura_arca_confirmada_en: "2026-07-09T12:00:00.000Z",
        factura_arca_confirmada_por: "local",
        archivo_factura: "backend/attachments/ventas/3-factura.pdf",
        archivo_factura_nombre: "factura.pdf",
        archivo_factura_hash: "abc",
        cerrado_en: "",
        cerrado_por: ""
      }] }
    }
  };
}

function addRealAttachment(source) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-workflow-attachment-"));
  const buffer = Buffer.from("%PDF-1.4\nfixture\n");
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  const relativePath = `backend/attachments/ventas/3-${hash.slice(0, 16)}.pdf`;
  const absolutePath = path.join(rootDir, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, buffer);
  Object.assign(source.tables.gestion_ventas.rows[0], {
    archivo_factura: relativePath,
    archivo_factura_hash: hash
  });
  return {
    crypto,
    fs,
    path,
    rootDir,
    absolutePath,
    cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true })
  };
}

test("migración aditiva crea sólo gestion_ventas y su backup es verificable", () => {
  const source = cacheFixture();
  delete source.tables.gestion_ventas;
  const serialized = JSON.stringify(source, null, 2);
  const manifest = createBackupManifest(serialized);
  assert.equal(verifyBackup(serialized, manifest), true);
  const result = migrateSalesWorkflow(source);
  assert.equal(result.report.tableCreated, true);
  assert.deepEqual(result.cache.tables.pedidos.rows, source.tables.pedidos.rows);
  assert.deepEqual(result.cache.tables.ventas.rows, source.tables.ventas.rows);
  assert.deepEqual(result.cache.tables.entregas.rows, source.tables.entregas.rows);
  assert.equal(rollbackSalesWorkflow(result.cache).cache.tables.gestion_ventas, undefined);
});

test("backfill lógico mantiene incompletos abiertos y no inunda con históricos resueltos", () => {
  const source = cacheFixture();
  const storage = addRealAttachment(source);
  try {
    const rows = workflowRows(source, backendId, storage);
    const incomplete = rows.find((row) => row.id_pedido === "1");
    const historical = rows.find((row) => row.id_pedido === "2");
    const ready = rows.find((row) => row.id_pedido === "3");
    assert.equal(incomplete.managed, false);
    assert.deepEqual(incomplete.completion, { arca: false, delivery: false, sale: false });
    assert.equal(historical.managed, true);
    assert.equal(historical.historicalResolved, true);
    assert.deepEqual(historical.completion, { arca: true, delivery: true, sale: true });
    assert.equal(ready.canClose, true);
  } finally {
    storage.cleanup();
  }
});

test("la bandeja abierta excluye entregas previstas vencidas y conserva fechas de hoy, futuras e inválidas", () => {
  const source = cacheFixture();
  source.tables.pedidos.rows[0].fecha_entrega = "2026-07-30";
  source.tables.pedidos.rows[1].fecha_entrega = "2026-07-30";
  source.tables.pedidos.rows[2].fecha_entrega = "2026-07-31";
  source.tables.pedidos.rows.push(
    { id_pedido: 4, id_cliente: 1, fecha_pedido: "2026-07-04", fecha_entrega: "2026-08-02" },
    { id_pedido: 5, id_cliente: 1, fecha_pedido: "2026-07-05", fecha_entrega: "fecha-invalida" }
  );
  const responses = [];
  const service = createSalesWorkflowService({
    backendId,
    backendNextNumericId: nextId,
    ensureBackendTable: () => {},
    loadCache: () => source,
    sendJson: (_response, status, payload) => { responses.push({ status, payload }); return payload; },
    currentDate: () => "2026-07-31"
  });

  service.handleList({ url: "/api/sales/workflow?managed=0", headers: { host: "127.0.0.1" } }, {});
  assert.equal(responses.at(-1).status, 200);
  assert.deepEqual(responses.at(-1).payload.rows.map((row) => row.id_pedido), ["3", "4", "5"]);
  assert.equal(responses.at(-1).payload.total, 3);

  service.handleList({ url: "/api/sales/workflow?managed=1", headers: { host: "127.0.0.1" } }, {});
  assert.deepEqual(responses.at(-1).payload.rows.map((row) => row.id_pedido), ["2"]);
});

test("Tick revalida las tres condiciones y el cierre es idempotente", async () => {
  let source = cacheFixture();
  const storage = addRealAttachment(source);
  const responses = [];
  const service = createSalesWorkflowService({
    backendId,
    backendNextNumericId: nextId,
    ensureBackendTable: (tables, name) => { tables[name] ||= { headers: [], rows: [], rowCount: 0 }; },
    loadCache: () => source,
    readJsonBody: async (request) => request.body,
    saveBackendCache: (cache) => { source = cache; },
    sendJson: (_response, status, payload) => { responses.push({ status, payload }); return payload; },
    ...storage
  });
  try {
    await service.handleClose({ body: { orderId: 1 }, accessIdentity: { mode: "local" } }, {});
    assert.equal(responses.at(-1).status, 409);
    assert.match(responses.at(-1).payload.error, /Factura ARCA, Entrega, Venta con adjunto/);

    await service.handleClose({ body: { orderId: 3 }, accessIdentity: { mode: "local" } }, {});
    assert.equal(responses.at(-1).status, 200);
    const closedAt = source.tables.gestion_ventas.rows[0].cerrado_en;
    assert.ok(closedAt);
    assert.equal(source.tables.gestion_ventas.rows[0].cerrado_por, "local");

    await service.handleClose({ body: { orderId: 3 }, accessIdentity: { mode: "local" } }, {});
    assert.equal(responses.at(-1).payload.idempotent, true);
    assert.equal(source.tables.gestion_ventas.rows[0].cerrado_en, closedAt);
  } finally {
    storage.cleanup();
  }
});

test("Tick rechaza adjunto ausente o alterado aunque existan sus metadatos", async () => {
  let source = cacheFixture();
  const storage = addRealAttachment(source);
  const responses = [];
  const service = createSalesWorkflowService({
    backendId,
    backendNextNumericId: nextId,
    ensureBackendTable: (tables, name) => { tables[name] ||= { headers: [], rows: [], rowCount: 0 }; },
    loadCache: () => source,
    readJsonBody: async (request) => request.body,
    saveBackendCache: (cache) => { source = cache; },
    sendJson: (_response, status, payload) => { responses.push({ status, payload }); return payload; },
    ...storage
  });
  try {
    fs.unlinkSync(storage.absolutePath);
    await service.handleClose({ body: { orderId: 3 }, accessIdentity: { mode: "local" } }, {});
    assert.equal(responses.at(-1).status, 409);
    assert.equal(source.tables.gestion_ventas.rows[0].cerrado_en, "");

    fs.writeFileSync(storage.absolutePath, "%PDF-1.4\nalterado\n");
    await service.handleClose({ body: { orderId: 3 }, accessIdentity: { mode: "local" } }, {});
    assert.equal(responses.at(-1).status, 409);
    assert.equal(source.tables.gestion_ventas.rows[0].cerrado_en, "");
  } finally {
    storage.cleanup();
  }
});

test("la tabla técnica gestion_ventas rechaza el escritor genérico", async () => {
  const responses = [];
  let saves = 0;
  const service = createBackendTableService({
    backendEditableColumns: () => ["id_gestion_venta", "id_pedido"],
    backendEditablePrimaryKey: () => "id_gestion_venta",
    backendId,
    backendNextNumericId: nextId,
    backendTable: () => null,
    ensureBackendTable: () => {},
    expectedBackendColumns: { gestion_ventas: ["id_gestion_venta", "id_pedido"] },
    loadCache: () => ({ tables: { gestion_ventas: { rows: [], rowCount: 0 } } }),
    readJsonBody: async (request) => request.body,
    saveBackendCache: () => { saves += 1; },
    sendJson: (_response, status, payload) => { responses.push({ status, payload }); return payload; }
  });
  await service.handleBackendTableSave({
    url: "/api/backend/tables/gestion_ventas",
    headers: { host: "127.0.0.1" },
    body: { rows: [{ id_pedido: 1 }] }
  }, {});
  assert.equal(responses.at(-1).status, 403);
  assert.match(responses.at(-1).payload.error, /tabla técnica/);
  assert.equal(saves, 0);
});

test("alternar abiertos y gestionados descarta respuestas obsoletas en ambos sentidos", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../assets/js/modules/sales-workflow.js"), "utf8");
  const pending = [];
  const elements = new Map();
  const makeElement = () => ({
    listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
    setAttribute() {},
    querySelector() { return null; },
    hidden: false,
    innerHTML: "",
    textContent: "",
    className: ""
  });
  ["sales-workflow-new-order", "sales-workflow-managed-toggle", "sales-workflow-body", "sales-workflow-dialog", "sales-workflow-status"]
    .forEach((id) => elements.set(id, makeElement()));
  const context = {
    document: {
      getElementById: (id) => elements.get(id) || null,
      querySelector: () => makeElement()
    },
    addEventListener() {},
    confirm: () => true,
    requestBackendApi: (url) => new Promise((resolve) => pending.push({ url, resolve })),
    formatDate: (value) => value,
    displayNameLabel: (value) => value,
    formatMoney: (value) => String(value),
    escapeHtml: (value) => String(value ?? ""),
    crypto: { randomUUID: () => "fixture" },
    console
  };
  context.window = context;
  vm.runInNewContext(source, context, { filename: "sales-workflow.js" });
  const row = (id, managed) => ({ id_pedido: id, managed, completion: {}, fecha_entrega_prevista: "", productos: [] });
  const toggle = elements.get("sales-workflow-managed-toggle");

  const openLoad = context.loadSalesWorkflow();
  const managedLoad = toggle.listeners.click();
  assert.equal(pending.length, 2);
  pending[0].resolve({ rows: [row("obsoleto-abierto", false)] });
  await openLoad;
  pending[1].resolve({ rows: [row("vigente-gestionado", true)] });
  await managedLoad;
  assert.match(elements.get("sales-workflow-body").innerHTML, /vigente-gestionado/);
  assert.doesNotMatch(elements.get("sales-workflow-body").innerHTML, /obsoleto-abierto/);

  const managedLoad2 = context.loadSalesWorkflow();
  const openLoad2 = toggle.listeners.click();
  assert.equal(pending.length, 4);
  pending[2].resolve({ rows: [row("obsoleto-gestionado", true)] });
  await managedLoad2;
  pending[3].resolve({ rows: [row("vigente-abierto", false)] });
  await openLoad2;
  assert.match(elements.get("sales-workflow-body").innerHTML, /vigente-abierto/);
  assert.doesNotMatch(elements.get("sales-workflow-body").innerHTML, /obsoleto-gestionado/);
});

test("confirmación ARCA persiste una sola vez sin crear ventas", async () => {
  let source = cacheFixture();
  source.tables.gestion_ventas.rows = [];
  const salesBefore = JSON.stringify(source.tables.ventas.rows);
  const responses = [];
  const service = createSalesWorkflowService({
    backendId,
    backendNextNumericId: nextId,
    ensureBackendTable: (tables, name) => { tables[name] ||= { headers: [], rows: [], rowCount: 0 }; },
    loadCache: () => source,
    readJsonBody: async (request) => request.body,
    saveBackendCache: (cache) => { source = cache; },
    sendJson: (_response, status, payload) => { responses.push({ status, payload }); return payload; }
  });
  await service.handleArcaConfirmation({ body: { orderId: 1 }, accessIdentity: { mode: "local" } }, {});
  const timestamp = source.tables.gestion_ventas.rows[0].factura_arca_confirmada_en;
  await service.handleArcaConfirmation({ body: { orderId: 1 }, accessIdentity: { mode: "local" } }, {});
  assert.equal(responses.at(-1).payload.idempotent, true);
  assert.equal(source.tables.gestion_ventas.rows[0].factura_arca_confirmada_en, timestamp);
  assert.equal(JSON.stringify(source.tables.ventas.rows), salesBefore);
});

test("Crear factura reutiliza sólo la revisión del pedido elegido", () => {
  const source = fs.readFileSync(path.join(__dirname, "../assets/js/modules/sales-workflow.js"), "utf8");
  assert.match(source, /selectArcaInvoicingOrder\(row\.id_pedido\)/);
  assert.match(source, /arca-invoicing-layout > \.arca-review-panel/);
  assert.doesNotMatch(source, /openMovedDialog\("Crear factura", document\.querySelector\("#view-arca-invoicing > \.arca-invoicing-layout"\)/);
  assert.match(source, /body: JSON\.stringify\(\{ orderId: row\.id_pedido \}\)/);
});
