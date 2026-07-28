const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { createAccessConfig } = require("../backend/config/access");
const { ADMIN_TABLE_POLICY } = require("../backend/config/admin-table-policy");
const { createAccessControl } = require("../backend/services/access-control.service");
const { createRequestHandler } = require("../backend/routes/router");
const {
  columnFiltersFromSearchParams,
  createAdminTableService,
  isGeneratedPrimaryKey,
  publicRelations
} = require("../backend/services/admin-table.service");
const { createBackendTableService } = require("../backend/services/backend-table.service");
const { createSqlService } = require("../backend/services/sql.service");
const { createTableReadMetrics } = require("../backend/services/table-read-metrics.service");
const { setCorsHeaders } = require("../backend/utils/http");
const {
  backendEditableColumns,
  backendEditablePrimaryKey,
  backendNextNumericId,
  ensureBackendTable
} = require("../backend/utils/runtime");
const { backendId } = require("../backend/utils/ids");
const { EXPECTED_BACKEND_COLUMNS } = require("../backend/config/backend-columns");
const {
  filterRows,
  matchesColumnFilter,
  normalizeColumnFilters,
  resolveAdminTableOrder,
  resolveTableOrder,
  sortTableRows
} = require("../backend/data-store");

const clone = (value) => JSON.parse(JSON.stringify(value));
const readJsonBody = async (request) => request.body || {};

function responseCapture() {
  return {
    status: 0,
    headers: {},
    payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); },
    end(raw = "") { this.payload = raw ? JSON.parse(raw) : null; }
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function fixtureStore() {
  let state = {
    generatedAt: "",
    tables: {
      etiquetas: {
        headers: EXPECTED_BACKEND_COLUMNS.etiquetas,
        rows: [{ id_etiqueta: 1, etiqueta: "Mercaderia", categoria_pnl: "Costo" }],
        rowCount: 1
      },
      otros_acreedores: {
        headers: EXPECTED_BACKEND_COLUMNS.otros_acreedores,
        rows: [{ id_otro_acreedor: 1, nombre_otro_acreedor: true }],
        rowCount: 1
      },
      canales: {
        headers: EXPECTED_BACKEND_COLUMNS.canales,
        rows: [{ id_canal: 1, nombre: "Directo", comision: 0 }],
        rowCount: 1
      },
      clientes: {
        headers: EXPECTED_BACKEND_COLUMNS.clientes,
        rows: [{ id_cliente: 1, nombre_cliente: "Cliente fixture", id_canal: 1 }],
        rowCount: 1
      },
      cobros: {
        headers: EXPECTED_BACKEND_COLUMNS.cobros,
        rows: [
          { id_cobro: 2, fecha_cobro: "2026-07-23", metodo: "Transferencia", id_cliente: 1, monto: 20, banco: "ICBC" },
          { id_cobro: 10, fecha_cobro: "2026-07-24", metodo: "Transferencia", id_cliente: 1, monto: 100, banco: "ICBC" },
          { id_cobro: 1, fecha_cobro: "2026-07-22", metodo: "Efectivo", id_cliente: 1, monto: 10, banco: "" }
        ],
        rowCount: 3
      },
      pagos: {
        headers: EXPECTED_BACKEND_COLUMNS.pagos,
        rows: [{ id_pago: 1, fecha_pago: "2026-07-23", metodo: "Transferencia", banco: "ICBC", monto: 10 }],
        rowCount: 1
      },
      caja: {
        headers: EXPECTED_BACKEND_COLUMNS.caja,
        definition: { primaryKey: "cuenta" },
        rows: [{ cuenta: "Efectivo", monto: 100 }],
        rowCount: 1
      },
      sueldos_calculo: {
        headers: EXPECTED_BACKEND_COLUMNS.sueldos_calculo,
        rows: [],
        rowCount: 0
      }
    }
  };
  return {
    loadCache: () => clone(state),
    saveBackendCache: (next) => { state = clone(next); },
    value: () => clone(state)
  };
}

const registry = {
  version: 1,
  tables: [
    { name: "etiquetas", label: "Etiquetas", module: "maestros", primaryKey: "Id_Etiqueta" },
    { name: "otros_acreedores", label: "Otros acreedores", module: "maestros", primaryKey: "Id_Otro_Acreedor" },
    { name: "canales", label: "Canales", module: "maestros", primaryKey: "Id_Canal" },
    { name: "clientes", label: "Clientes", module: "maestros", primaryKey: "Id_Cliente" },
    { name: "cobros", label: "Cobros", module: "ventas", primaryKey: "Id_Cobro" },
    { name: "pagos", label: "Pagos", module: "compras", primaryKey: "Id_Pago" },
    { name: "caja", label: "Caja", module: "tesoreria", primaryKey: "cuenta" },
    { name: "sueldos_calculo", label: "Sueldos calculo", module: "compras", primaryKey: "Id_Sueldo", hidden: true }
  ]
};

function tableFromStore(store, tableName, options = {}) {
  const table = store.loadCache().tables[tableName];
  if (!table) return null;
  const definition = registry.tables.find((entry) => entry.name === tableName) || { name: tableName };
  const filteredRows = filterRows(table.rows, options.search, options.filters || options.filter);
  const order = resolveTableOrder({ ...table, definition }, filteredRows, options);
  const orderedRows = sortTableRows(filteredRows, order);
  const offset = Number(options.offset) || 0;
  const limit = options.all ? orderedRows.length : Math.min(Number(options.limit) || 500, 5000);
  return {
    name: tableName,
    definition,
    headers: table.headers,
    totalRows: orderedRows.length,
    offset,
    limit,
    order,
    rows: orderedRows.slice(offset, offset + limit)
  };
}

function adminService(store, hooks = {}) {
  return createAdminTableService({
    appendAdminAudit: hooks.appendAdminAudit || (() => {}),
    adminTablePolicy: ADMIN_TABLE_POLICY,
    backendEditableColumns,
    backendEditablePrimaryKey,
    backendId,
    backendNextNumericId,
    backendOverview: () => ({
      tables: registry.tables.filter((table) => !table.hidden).map((table) => ({
        ...table,
        headers: EXPECTED_BACKEND_COLUMNS[table.name] || []
      }))
    }),
    backendTable: (name, options) => tableFromStore(store, name, options),
    loadCache: store.loadCache,
    loadRegistry: () => clone(registry),
    readJsonBody,
    recordAllRowsRead: hooks.recordAllRowsRead || (() => {}),
    ensureAdminSessionBackup: hooks.ensureAdminSessionBackup || (() => null),
    saveBackendCache: store.saveBackendCache,
    sendJson
  });
}

async function invoke(handler, url, body, method = "GET") {
  const response = responseCapture();
  await handler({ method, url, headers: { host: "127.0.0.1:3000" }, body }, response);
  return response;
}

async function testAccess() {
  const config = createAccessConfig({});
  assert.strictEqual(config.mode, "local");
  assert.strictEqual(config.host, "127.0.0.1");
  assert.strictEqual(config.port, 3000);
  assert.throws(() => createAccessConfig({ ERP_DEPLOYMENT_MODE: "lan" }), /autenticacion y autorizacion/);
  assert.throws(() => createAccessConfig({ ERP_HOST: "0.0.0.0" }), /autenticacion y autorizacion/);
  assert.throws(
    () => createAccessConfig({ ERP_ALLOWED_ORIGINS: "https://externo.example" }),
    /solo admite origenes/
  );

  const access = createAccessControl({ accessConfig: config, sendJson, setCorsHeaders });
  const allowed = responseCapture();
  assert.strictEqual(await access({
    headers: { origin: "http://localhost:3000" }
  }, allowed), true);
  assert.strictEqual(allowed.headers["Access-Control-Allow-Origin"], "http://localhost:3000");
  assert.notStrictEqual(allowed.headers["Access-Control-Allow-Origin"], "*");

  const noOrigin = responseCapture();
  assert.strictEqual(await access({ headers: {} }, noOrigin), true);
  assert.strictEqual(noOrigin.headers["Access-Control-Allow-Origin"], undefined);

  const forbidden = responseCapture();
  assert.strictEqual(await access({ headers: { origin: "https://externo.example" } }, forbidden), false);
  assert.strictEqual(forbidden.status, 403);
  assert.strictEqual(forbidden.payload.code, "ORIGIN_FORBIDDEN");

  const serverSource = fs.readFileSync(path.resolve(__dirname, "..", "server.js"), "utf8");
  assert.match(serverSource, /server\.listen\(accessConfig\.port,\s*accessConfig\.host/);
  assert.match(serverSource, /http:\/\/\$\{accessConfig\.host\}:\$\{accessConfig\.port\}/);
}

async function testLocalHttpAccess() {
  const config = createAccessConfig({ PORT: "3000" });
  const applyRequestAccess = createAccessControl({ accessConfig: config, sendJson, setCorsHeaders });
  const server = http.createServer(createRequestHandler({
    applyRequestAccess,
    backendColumnsMap: () => ({}),
    backendOverview: () => ({ tables: [] }),
    backendSchema: () => ({ tables: [] }),
    handlers: {},
    sendJson,
    serveStaticFile: (_request, response) => sendJson(response, 404, { ok: false })
  }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, config.host, resolve);
  });
  try {
    assert.strictEqual(server.address().address, "127.0.0.1");
    const local = await httpRequest(server.address().port, "http://127.0.0.1:3000");
    assert.strictEqual(local.status, 200);
    assert.strictEqual(local.headers["access-control-allow-origin"], "http://127.0.0.1:3000");
    assert.notStrictEqual(local.headers["access-control-allow-origin"], "*");

    const localhostOrigin = await httpRequest(server.address().port, "http://localhost:3000", "localhost");
    assert.strictEqual(localhostOrigin.status, 200);
    const external = await httpRequest(server.address().port, "https://externo.example");
    assert.strictEqual(external.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function httpRequest(port, origin, hostname = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname,
      port,
      path: "/api/health",
      headers: origin ? { Origin: origin } : {}
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        payload: raw ? JSON.parse(raw) : null
      }));
    });
    request.on("error", reject);
  });
}

async function testAdminEditor() {
  const projectRegistry = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "..", "backend", "table-registry.json"),
    "utf8"
  ));
  const unclassified = projectRegistry.tables
    .filter((table) => !ADMIN_TABLE_POLICY[table.name])
    .map((table) => table.name);
  assert.deepStrictEqual(unclassified, []);
  projectRegistry.tables.forEach((table) => {
    assert.deepStrictEqual(
      Object.fromEntries(["read", "insert", "update", "delete"].map((key) => [key, ADMIN_TABLE_POLICY[table.name][key]])),
      { read: true, insert: true, update: true, delete: true }
    );
    assert.strictEqual(ADMIN_TABLE_POLICY[table.name].category, "administrative");
    assert.doesNotMatch(ADMIN_TABLE_POLICY[table.name].reason, /solo lectura|operativ|usar (?:el |los )?(?:m[oó]dulo|flujo)/i);
  });

  const store = fixtureStore();
  let backupCreated = false;
  let backupCalls = 0;
  const auditEntries = [];
  const adminReadMetrics = [];
  const service = adminService(store, {
    ensureAdminSessionBackup: () => {
      if (!backupCreated) {
        backupCreated = true;
        backupCalls += 1;
      }
    },
    appendAdminAudit: (entries) => auditEntries.push(...entries),
    recordAllRowsRead: (tableName, table) => adminReadMetrics.push({ tableName, count: table.rows.length })
  });

  assert.strictEqual((await invoke(service.handleAdminTableRequest, "/api/admin/tables/etiquetas?limit=20")).status, 200);
  const cobros = await invoke(service.handleAdminTableRequest, "/api/admin/tables/cobros?all=true&orderBy=id_cobro&orderDir=desc");
  assert.strictEqual(cobros.status, 200);
  assert.deepStrictEqual(cobros.payload.table.rows.map((row) => row.id_cobro), [10, 2, 1]);
  assert.deepStrictEqual(adminReadMetrics, [
    { tableName: "etiquetas", count: 1 },
    { tableName: "cobros", count: 3 }
  ]);
  assert.deepStrictEqual(cobros.payload.table.relations.id_cliente.options, [
    { value: "1", label: "Cliente fixture" }
  ]);
  assert.deepStrictEqual(cobros.payload.table.schema.columns.find((column) => column.name === "id_cliente").relation, {
    column: "id_cliente",
    table: "clientes",
    target: "id_cliente",
    displayColumn: "nombre_cliente",
    label: "Cliente",
    totalOptions: 1,
    truncated: false
  });
  const booleanFixture = await invoke(service.handleAdminTableRequest, "/api/admin/tables/otros_acreedores?limit=20");
  assert.strictEqual(
    booleanFixture.payload.table.schema.columns.find((column) => column.name === "nombre_otro_acreedor").type,
    "boolean"
  );

  const cellStore = fixtureStore();
  const cellService = adminService(cellStore);
  assert.strictEqual(typeof cellService.handleAdminTableCellUpdate, "function");
  const cellRouter = createRequestHandler({
    applyRequestAccess: async () => true,
    backendColumnsMap: () => ({}),
    backendOverview: () => ({ tables: [] }),
    backendSchema: () => ({ tables: [] }),
    handlers: cellService,
    sendJson,
    serveStaticFile: (_request, response) => sendJson(response, 404, { ok: false })
  });
  const cellTable = await invoke(
    cellService.handleAdminTableRequest,
    "/api/admin/tables/etiquetas?all=true&orderBy=id_etiqueta&orderDir=desc"
  );
  let cellResult = await invoke(cellRouter, "/api/admin/tables/etiquetas/cell", {
    primaryKey: "1",
    column: "etiqueta",
    value: "Mercaderia localizada",
    originalValue: "Mercaderia",
    tableVersion: cellTable.payload.table.version
  }, "PATCH");
  assert.strictEqual(cellResult.status, 200);
  assert.strictEqual(cellResult.payload.row.etiqueta, "Mercaderia localizada");
  assert.strictEqual(cellStore.value().tables.etiquetas.rows[0].etiqueta, "Mercaderia localizada");

  const beforeValueConflict = cellStore.value();
  cellResult = await invoke(cellService.handleAdminTableCellUpdate, "/api/admin/tables/etiquetas/cell", {
    primaryKey: "1",
    column: "etiqueta",
    value: "No debe persistir",
    originalValue: "Valor obsoleto",
    tableVersion: cellResult.payload.tableVersion
  });
  assert.strictEqual(cellResult.status, 409);
  assert.strictEqual(cellResult.payload.code, "ADMIN_VALUE_CONFLICT");
  assert.deepStrictEqual(cellStore.value(), beforeValueConflict);

  const currentCellVersion = (await invoke(
    cellService.handleAdminTableRequest,
    "/api/admin/tables/etiquetas?all=true"
  )).payload.table.version;
  cellResult = await invoke(cellService.handleAdminTableCellUpdate, "/api/admin/tables/etiquetas/cell", {
    primaryKey: "1",
    column: "id_etiqueta",
    value: 7,
    originalValue: 1,
    tableVersion: currentCellVersion
  });
  assert.strictEqual(cellResult.status, 200);
  assert.strictEqual(cellResult.payload.row.id_etiqueta, 7);
  assert.strictEqual(cellStore.value().tables.etiquetas.rows[0].id_etiqueta, 7);

  const channelTable = await invoke(
    cellService.handleAdminTableRequest,
    "/api/admin/tables/canales?all=true"
  );
  const beforeReferencedPrimaryChange = cellStore.value();
  cellResult = await invoke(cellService.handleAdminTableCellUpdate, "/api/admin/tables/canales/cell", {
    primaryKey: "1",
    column: "id_canal",
    value: 2,
    originalValue: 1,
    tableVersion: channelTable.payload.table.version
  });
  assert.strictEqual(cellResult.status, 400);
  assert.strictEqual(cellResult.payload.code, "ADMIN_PRIMARY_KEY_REFERENCED");
  assert.ok(cellResult.payload.dependencies.some((dependency) => dependency.table === "clientes"));
  assert.deepStrictEqual(cellStore.value(), beforeReferencedPrimaryChange);

  const collectionTable = await invoke(
    cellService.handleAdminTableRequest,
    "/api/admin/tables/cobros?all=true"
  );
  const beforeInvalidRelation = cellStore.value();
  cellResult = await invoke(cellService.handleAdminTableCellUpdate, "/api/admin/tables/cobros/cell", {
    primaryKey: "10",
    column: "id_cliente",
    value: 999,
    originalValue: 1,
    tableVersion: collectionTable.payload.table.version
  });
  assert.strictEqual(cellResult.status, 400);
  assert.strictEqual(cellResult.payload.code, "ADMIN_REFERENCE_INVALID");
  assert.deepStrictEqual(cellStore.value(), beforeInvalidRelation);

  const paymentTable = await invoke(
    cellService.handleAdminTableRequest,
    "/api/admin/tables/pagos?all=true"
  );
  cellResult = await invoke(cellService.handleAdminTableCellUpdate, "/api/admin/tables/pagos/cell", {
    primaryKey: "1",
    column: "monto",
    value: "$ 1.250,50",
    originalValue: 10,
    tableVersion: paymentTable.payload.table.version
  });
  assert.strictEqual(cellResult.status, 200);
  assert.strictEqual(cellResult.payload.row.monto, 1250.5);
  const beforeInvalidLocalizedMoney = cellStore.value();
  const invalidLocalizedMoney = await invoke(cellService.handleAdminTableCellUpdate, "/api/admin/tables/pagos/cell", {
    primaryKey: "1",
    column: "monto",
    value: "importe invalido",
    originalValue: 1250.5,
    tableVersion: cellResult.payload.tableVersion
  });
  assert.strictEqual(invalidLocalizedMoney.status, 400);
  assert.strictEqual(invalidLocalizedMoney.payload.code, "ADMIN_INVALID_MONEY");
  assert.deepStrictEqual(cellStore.value(), beforeInvalidLocalizedMoney);

  let result = await invoke(service.handleAdminTableSave, "/api/admin/tables/etiquetas", {
    rows: [{ id_etiqueta: 1, etiqueta: "Mercaderia actualizada", categoria_pnl: "Costo" }]
  });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(store.value().tables.etiquetas.rows[0].etiqueta, "Mercaderia actualizada");
  assert.strictEqual(result.payload.table.rows[0].etiqueta, "Mercaderia actualizada");
  assert.strictEqual(backupCalls, 1);
  assert.deepStrictEqual(auditEntries[0], {
    table: "etiquetas",
    operation: "update",
    primaryKey: "1"
  });

  result = await invoke(service.handleAdminTableSave, "/api/admin/tables/etiquetas", {
    tableVersion: "version-obsoleta",
    rows: [{ id_etiqueta: 1, etiqueta: "No debe persistir", categoria_pnl: "Costo" }]
  });
  assert.strictEqual(result.status, 409);
  assert.strictEqual(result.payload.code, "ADMIN_CONFLICT");
  assert.strictEqual(store.value().tables.etiquetas.rows[0].etiqueta, "Mercaderia actualizada");

  result = await invoke(service.handleAdminTableSave, "/api/admin/tables/etiquetas", {
    rows: [{ id_etiqueta: "", etiqueta: "Nueva", categoria_pnl: "Ingreso" }]
  });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(store.value().tables.etiquetas.rows[1].id_etiqueta, 2);
  assert.deepStrictEqual(result.payload.insertedRows.map((row) => row.id_etiqueta), [2]);

  const beforeAtomicRejection = store.value();
  result = await invoke(service.handleAdminTableSave, "/api/admin/tables/etiquetas", {
    rows: [
      { id_etiqueta: 1, etiqueta: "Cambio que no debe persistir", categoria_pnl: "Costo" },
      { id_etiqueta: 2, etiqueta: "", categoria_pnl: "Ingreso" }
    ]
  });
  assert.strictEqual(result.status, 400);
  assert.strictEqual(result.payload.field, "etiqueta");
  assert.strictEqual(result.payload.rowIndex, 1);
  assert.strictEqual(result.payload.rowKey, "2");
  assert.deepStrictEqual(store.value(), beforeAtomicRejection);

  result = await invoke(service.handleAdminTableSave, "/api/admin/tables/etiquetas", {
    newRows: [{ id_etiqueta: "", etiqueta: "", categoria_pnl: "" }]
  });
  assert.strictEqual(result.status, 400);
  assert.strictEqual(result.payload.code, "ADMIN_REQUIRED_FIELD");

  result = await invoke(service.handleAdminTableSave, "/api/admin/tables/etiquetas", { deletedIds: [1] });
  assert.strictEqual(result.status, 200);

  result = await invoke(service.handleAdminTableSave, "/api/admin/tables/pagos", {
    rows: [{ id_pago: 1, fecha_pago: "2026-07-23", metodo: "Efectivo", banco: "", monto: 10 }]
  });
  assert.strictEqual(result.status, 200);

  result = await invoke(service.handleAdminTableRequest, "/api/admin/tables/sueldos_calculo");
  assert.strictEqual(result.status, 403);
  result = await invoke(service.handleAdminTableRequest, "/api/admin/tables/no_registrada");
  assert.strictEqual(result.status, 403);

  result = await invoke(service.handleAdminTableSave, "/api/admin/tables/etiquetas", {
    rows: [{ id_etiqueta: 99, etiqueta: "Cambio de clave", categoria_pnl: "" }]
  });
  assert.strictEqual(result.status, 400);
  assert.strictEqual(result.payload.code, "ADMIN_PRIMARY_KEY_INVALID");

  result = await invoke(service.handleAdminTableSave, "/api/admin/tables/clientes", {
    rows: [{ id_cliente: "", nombre_cliente: "Nuevo", id_canal: 999 }]
  });
  assert.strictEqual(result.status, 400);
  assert.strictEqual(result.payload.code, "ADMIN_REFERENCE_INVALID");

  const beforeInvalidPayload = store.value();
  result = await invoke(service.handleAdminTableSave, "/api/admin/tables/pagos", {
    rows: [{ id_pago: 1, fecha_pago: "2026-02-30", metodo: "Efectivo", banco: "", monto: "invalido" }]
  });
  assert.strictEqual(result.status, 400);
  assert.strictEqual(result.payload.code, "ADMIN_INVALID_DATE");
  assert.deepStrictEqual(store.value(), beforeInvalidPayload);

  result = await invoke(service.handleAdminTableSave, "/api/admin/tables/pagos", {
    rows: [{ id_pago: 1, fecha_pago: "2026-07-23", metodo: "Efectivo", banco: "", monto: 10, intrusa: true }]
  });
  assert.strictEqual(result.status, 400);
  assert.strictEqual(result.payload.code, "ADMIN_COLUMN_FORBIDDEN");

  result = await invoke(service.handleAdminTableSave, "/api/admin/tables/caja", {
    newRows: [{ cuenta: "Banco fixture", monto: "$ 1.250,50" }]
  });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(store.value().tables.caja.rows[1].cuenta, "Banco fixture");
  assert.strictEqual(store.value().tables.caja.rows[1].monto, 1250.5);

  result = await invoke(service.handleAdminTableSave, "/api/admin/tables/canales", { deletedIds: [1] });
  assert.strictEqual(result.status, 400);
  assert.strictEqual(result.payload.code, "ADMIN_DELETE_REFERENCED");
  assert.strictEqual(backupCalls, 1);

  const rows = Array.from({ length: 650 }, (_, index) => ({ id_pago: index + 1 }));
  const order = resolveTableOrder(
    { headers: ["id_pago"], definition: { primaryKey: "Id_Pago" } },
    rows,
    {}
  );
  assert.deepStrictEqual(order, { column: "id_pago", direction: "desc", source: "primaryKey" });
  assert.deepStrictEqual(sortTableRows(rows, order).slice(0, 3).map((row) => row.id_pago), [650, 649, 648]);
  assert.deepStrictEqual(sortTableRows(rows, order).slice(300, 303).map((row) => row.id_pago), [350, 349, 348]);

  const largeRows = Array.from({ length: 8001 }, (_, index) => ({ id_pago: index + 1 }));
  assert.deepStrictEqual(
    sortTableRows(largeRows, { column: "id_pago", direction: "desc", source: "primaryKey" })
      .slice(0, 3)
      .map((row) => row.id_pago),
    [8001, 8000, 7999]
  );
  const textualRows = [{ cuenta: "Zeta" }, { cuenta: "Alfa" }, { cuenta: "Medio" }];
  assert.deepStrictEqual(
    sortTableRows(textualRows, { column: "cuenta", direction: "asc", source: "primaryKey" })
      .map((row) => row.cuenta),
    ["Alfa", "Medio", "Zeta"]
  );
  assert.deepStrictEqual(
    sortTableRows(textualRows, { column: "cuenta", direction: "desc", source: "primaryKey" })
      .map((row) => row.cuenta),
    ["Zeta", "Medio", "Alfa"]
  );
  assert.throws(
    () => resolveAdminTableOrder(
      { headers: ["id_pago", "monto"], definition: { primaryKey: "Id_Pago" } },
      { orderBy: "monto", orderDir: "desc" }
    ),
    (error) => error.code === "ADMIN_ORDER_COLUMN_INVALID"
  );
  assert.deepStrictEqual(
    resolveAdminTableOrder(
      { headers: ["cuenta", "monto"], definition: { primaryKey: "clave_inexistente" } },
      { orderDir: "asc" }
    ),
    {
      column: "cuenta",
      direction: "asc",
      source: "fallback",
      primaryKeyValid: false,
      warning: "La clave primaria configurada no existe; se ordena por cuenta."
    }
  );

  const searchableRows = [
    { id: 1, nombre: "Cliente Norte", monto: 10 },
    { id: 2, nombre: "Proveedor Sur", monto: 20 },
    { id: 3, nombre: "Cliente Centro", monto: 30 }
  ];
  assert.deepStrictEqual(filterRows(searchableRows, "cliente").map((row) => row.id), [1, 3]);
  assert.deepStrictEqual(filterRows(searchableRows, "", { nombre: "sur" }).map((row) => row.id), [2]);
  const dateRows = [
    { id: 1, fecha: "2026-06-16", estado: "Confirmado" },
    { id: 2, fecha: null, estado: "Pendiente" },
    { id: 3, fecha: "fecha-invalida", estado: "Pendiente" }
  ];
  ["16", "16/", "16/0", "16/06", "16/06/", "16/06/2026", "06/2026"].forEach((filter) => {
    assert.deepStrictEqual(filterRows(dateRows, "", { fecha: filter }).map((row) => row.id), [1]);
  });
  assert.deepStrictEqual(filterRows(dateRows, "", { fecha: "fecha-" }).map((row) => row.id), [3]);
  assert.deepStrictEqual(filterRows(dateRows, "", { fecha: "/" }).map((row) => row.id), [1]);
  assert.deepStrictEqual(filterRows(dateRows, "", { estado: "confirm" }).map((row) => row.id), [1]);
  assert.strictEqual(matchesColumnFilter(30, { operator: "gte", value: 20 }), true);
  assert.deepStrictEqual(normalizeColumnFilters({ NOMBRE: "cliente" }, ["id", "nombre"]), { nombre: "cliente" });
  assert.throws(() => normalizeColumnFilters({ intrusa: "x" }, ["id"]), /no existe/);
  assert.deepStrictEqual(
    columnFiltersFromSearchParams(new URLSearchParams("filter.nombre=cliente&filter=%7B%22id%22%3A%222%22%7D")),
    { id: "2", nombre: "cliente" }
  );
  assert.strictEqual(isGeneratedPrimaryKey("id_pago", [{ id_pago: 1 }, { id_pago: 4 }]), true);
  assert.strictEqual(isGeneratedPrimaryKey("id_pago", [{ id_pago: 4 }, { id_pago: 1 }]), false);
  assert.strictEqual(isGeneratedPrimaryKey("cuenta", [{ cuenta: "1" }, { cuenta: "2" }]), false);
  assert.ok(publicRelations("cobros", cobros.payload.table, store.value()).id_cliente);
}

async function testOperationalEndpointCompatibility() {
  const store = fixtureStore();
  const metrics = [];
  const service = createBackendTableService({
    backendEditableColumns,
    backendEditablePrimaryKey,
    backendId,
    backendNextNumericId,
    backendTable: (name, options) => tableFromStore(store, name, options),
    ensureBackendTable,
    expectedBackendColumns: EXPECTED_BACKEND_COLUMNS,
    loadCache: store.loadCache,
    readJsonBody,
    recordAllRowsRead: (tableName, table) => metrics.push({ tableName, count: table.rows.length }),
    saveBackendCache: store.saveBackendCache,
    sendJson
  });
  const result = await invoke(service.handleBackendTableSave, "/api/backend/tables/pagos", {
    rows: [{ id_pago: 1, fecha_pago: "2026-07-23", metodo: "Transferencia", banco: "ICBC", monto: 20 }]
  });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(store.value().tables.pagos.rows[0].monto, 20);

  const localized = await invoke(service.handleBackendTableSave, "/api/backend/tables/pagos", {
    rows: [{ id_pago: 1, fecha_pago: "2026-07-23", metodo: "Transferencia", banco: "ICBC", monto: "$ 999.645,25" }]
  });
  assert.strictEqual(localized.status, 200);
  assert.strictEqual(store.value().tables.pagos.rows[0].monto, 999645.25);

  const invalidSubcent = await invoke(service.handleBackendTableSave, "/api/backend/tables/pagos", {
    rows: [{ id_pago: 1, fecha_pago: "2026-07-23", metodo: "Transferencia", banco: "ICBC", monto: "20,001" }]
  });
  assert.strictEqual(invalidSubcent.status, 400);
  assert.strictEqual(store.value().tables.pagos.rows[0].monto, 999645.25);

  const allRows = await invoke(service.handleBackendTableRequest, "/api/backend/tables/pagos?all=true");
  assert.strictEqual(allRows.status, 200);
  assert.strictEqual(allRows.payload.table.rows.length, store.value().tables.pagos.rows.length);
  assert.deepStrictEqual(metrics, [{ tableName: "pagos", count: 1 }]);

  const editorSource = fs.readFileSync(
    path.resolve(__dirname, "..", "assets/js/modules/data-editor.js"),
    "utf8"
  );
  const indexSource = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
  const editorViewStart = indexSource.indexOf('id="view-data-editor"');
  const editorViewEnd = indexSource.indexOf('<section class="view"', editorViewStart + 1);
  const editorMarkup = indexSource.slice(editorViewStart, editorViewEnd > editorViewStart ? editorViewEnd : undefined);
  const stylesSource = fs.readFileSync(path.resolve(__dirname, "..", "assets/css/styles.css"), "utf8");

  assert.match(editorSource, /\/api\/admin\/tables/);
  assert.doesNotMatch(editorSource, /\/api\/backend\/tables/);
  assert.doesNotMatch(editorSource, /endpointScope/);
  assert.match(editorSource, /method:\s*"PATCH"/);
  assert.match(editorSource, /\/cell/);
  assert.match(editorSource, /all:\s*true/);
  assert.match(editorSource, /ErpMoneyColumns\?\.isMoneyColumn/);
  assert.match(editorSource, /parseMoneyInput\(rawValue, \{ allowEmpty: true \}\)/);
  assert.match(editorSource, /parsed\.ok && !parsed\.empty/);
  assert.match(editorSource, /: String\(rawValue \?\? ""\)/);
  assert.match(editorSource, /setupDataEditorGrid/);
  assert.match(editorSource, /data-editor-cell/);
  assert.match(editorSource, /meta\.type === "boolean"/);
  assert.match(editorSource, /setDataEditorCellState/);
  assert.match(editorSource, /DATA_EDITOR_ROW_HEIGHT/);
  assert.match(editorSource, /DATA_EDITOR_OVERSCAN/);
  assert.match(editorSource, /data-editor-viewport/);
  assert.match(editorSource, /data-editor-virtual-body/);
  assert.match(editorSource, /blank:new-row/);
  assert.match(editorSource, /data-editor-kind/);
  assert.match(editorSource, /data-editor-cell-state/);
  assert.match(editorSource, /data-editor-sort-primary/);
  assert.match(editorSource, /handleDataEditorGridPaste/);
  assert.match(editorSource, /rekeyDataEditorRowState/);
  assert.match(editorSource, /persistDataEditorCell\(row, column, value, revision\)/);
  assert.match(editorSource, /event\.key === "Enter"/);
  assert.match(editorSource, /event\.key === "Tab"/);
  assert.match(editorSource, /event\.key === "Escape"/);
  assert.match(editorSource, /const wasActive = active\?\.rowKey === cell\.dataset\.rowKey/);
  assert.match(editorSource, /if \(wasActive\) startDataEditorCellEdit\(cell\)/);
  assert.match(editorSource, /window\.getSelection\?\.\(\)\?\.removeAllRanges\(\)/);
  assert.match(editorSource, /editor\.setSelectionRange\(end, end\)/);
  assert.match(editorSource, /appendDataEditorTypedCharacter\(event\.key\)/);
  assert.doesNotMatch(editorSource, /editor\.select\(\)/);
  assert.doesNotMatch(editorSource, /startDataEditorCellEdit\(cell, event\.key\)/);
  assert.doesNotMatch(editorSource, /dataEditorViews\.secondary/);
  assert.doesNotMatch(editorSource, /data-editor-row-edit/);
  assert.doesNotMatch(editorSource, /showDataEditorRange/);
  assert.doesNotMatch(editorSource, /rangeMode/);

  const policySource = fs.readFileSync(
    path.resolve(__dirname, "..", "backend/config/admin-table-policy.js"),
    "utf8"
  );
  assert.doesNotMatch(policySource, /\breadonly\s*\(/);
  assert.doesNotMatch(policySource, /\boperational\s*\(/);

  assert.ok(editorViewStart >= 0);
  assert.match(editorMarkup, /id="data-editor-table"/);
  assert.match(editorMarkup, /id="data-editor-search"/);
  assert.match(editorMarkup, /id="data-editor-reload"/);
  [
    'id="data-editor-from"',
    'id="data-editor-to"',
    'id="data-editor-show-range"',
    'id="data-editor-recent"',
    "data-editor-page-size",
    'id="data-editor-save"',
    'id="data-editor-add-row"'
  ].forEach((removedContract) => assert.ok(!editorMarkup.includes(removedContract), removedContract));
  assert.doesNotMatch(editorMarkup, />\s*Pos\.\s*</);
  assert.doesNotMatch(editorMarkup, /Últimas 300|Guardar cambios|Agregar fila/);

  assert.match(stylesSource, /\.data-editor-spacer-row/);
  assert.match(stylesSource, /\.is-blank-row/);
  assert.match(stylesSource, /\.is-saving/);
  assert.match(stylesSource, /\.is-saved/);
  assert.match(stylesSource, /\.has-error/);
}

function testAllRowsMetrics() {
  const messages = [];
  const record = createTableReadMetrics({
    config: { warningRows: 1, warningBytes: 1, warningDurationMs: 1 },
    logger: {
      info: (message) => messages.push(message),
      warn: (message) => messages.push(message)
    }
  });
  const metric = record("clientes", { rows: [{ secreto: "no debe registrarse" }] }, Date.now() - 2);
  assert.strictEqual(metric.warning, true);
  assert.strictEqual(metric.rowCount, 1);
  assert.ok(metric.approximateBytes > 0);
  assert.ok(!messages[0].includes("no debe registrarse"));
}

async function testSql() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-admin-sql-"));
  const cacheFile = path.join(tempDir, "cache.json");
  const pythonExecutable = process.env.ERP_TEST_PYTHON || "python";
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({
      tables: {
        fixture: {
          headers: ["id", "value"],
          rows: Array.from({ length: 5105 }, (_, index) => ({ id: index + 1, value: `v${index + 1}` }))
        }
      }
    }), "utf8");
    const baseLimits = {
      maxRows: 5000,
      maxOutputBytes: 20 * 1024 * 1024,
      processTimeoutMs: 5000,
      sqliteTimeBudgetMs: 4000,
      sqliteCallbackBudget: 20000,
      sqliteProgressOperations: 10000
    };
    const run = createSqlService({
      cacheFile,
      limits: baseLimits,
      pythonExecutable,
      rootDir: path.resolve(__dirname, ".."),
      scriptFile: path.resolve(__dirname, "..", "tools", "backend-sqlite-query.py")
    });
    assert.strictEqual((await run("SELECT 1 AS ok")).rows[0].ok, 1);
    assert.strictEqual((await run("WITH x AS (SELECT 2 AS ok) SELECT ok FROM x")).rows[0].ok, 2);
    await assert.rejects(() => run("DELETE FROM fixture"), (error) => error.code === "SQL_FORBIDDEN");
    await assert.rejects(() => run("SELECT 1; SELECT 2"), (error) => error.code === "SQL_INVALID");
    const limited = await run("SELECT * FROM fixture");
    assert.strictEqual(limited.rows.length, 5000);
    assert.strictEqual(limited.limited, true);

    const budgetRun = createSqlService({
      cacheFile,
      limits: { ...baseLimits, sqliteCallbackBudget: 1, sqliteProgressOperations: 1 },
      pythonExecutable,
      rootDir: path.resolve(__dirname, ".."),
      scriptFile: path.resolve(__dirname, "..", "tools", "backend-sqlite-query.py")
    });
    await assert.rejects(
      () => budgetRun("WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x) SELECT * FROM x"),
      (error) => ["SQL_BUDGET_EXCEEDED", "SQL_TIMEOUT"].includes(error.code)
    );

    const productRun = createSqlService({
      cacheFile,
      limits: {
        ...baseLimits,
        sqliteCallbackBudget: 1000,
        sqliteProgressOperations: 1000
      },
      pythonExecutable,
      rootDir: path.resolve(__dirname, ".."),
      scriptFile: path.resolve(__dirname, "..", "tools", "backend-sqlite-query.py")
    });
    await assert.rejects(
      () => productRun("SELECT COUNT(*) AS total FROM fixture a, fixture b, fixture c"),
      (error) => ["SQL_BUDGET_EXCEEDED", "SQL_TIMEOUT"].includes(error.code)
    );
    assert.strictEqual((await run("SELECT 3 AS recovered")).rows[0].recovered, 3);

    const timeoutRun = createSqlService({
      cacheFile,
      limits: { ...baseLimits, processTimeoutMs: 1, sqliteTimeBudgetMs: 60000 },
      pythonExecutable,
      rootDir: path.resolve(__dirname, ".."),
      scriptFile: path.resolve(__dirname, "..", "tools", "backend-sqlite-query.py")
    });
    await assert.rejects(() => timeoutRun("SELECT * FROM fixture"), (error) => error.code === "SQL_TIMEOUT");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  await testAccess();
  await testLocalHttpAccess();
  await testAdminEditor();
  await testOperationalEndpointCompatibility();
  testAllRowsMetrics();
  await testSql();
  console.log("Administration hardening tests: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
