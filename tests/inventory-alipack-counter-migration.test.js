const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ADMIN_TABLE_POLICY, adminTableCapability } = require("../backend/config/admin-table-policy");
const { ADMIN_TABLE_RELATIONS } = require("../backend/config/admin-table-relations");
const { EXPECTED_BACKEND_COLUMNS } = require("../backend/config/backend-columns");
const { BACKEND_TABLE_PROJECTIONS } = require("../backend/config/backend-projections");
const registry = require("../backend/table-registry.json");
const {
  TABLE_NAME,
  assertInventoryAlipackCounterRows,
  createBackupManifest,
  migrateInventoryAlipackCounters,
  rollbackInventoryAlipackCounters,
  runCli,
  verifyBackup
} = require("../backend/migrations/20260804-inventory-alipack-counters");
const { createAdminTableService } = require("../backend/services/admin-table.service");
const { createBackendMapService } = require("../backend/services/backend-map.service");
const { buildSanitizedSqlSchema } = require("../backend/services/sql.service");
const { normalizeHeader } = require("../backend/utils/runtime");

function fixture() {
  return {
    generatedAt: "fixture",
    tables: {
      inventarios: {
        headers: EXPECTED_BACKEND_COLUMNS.inventarios,
        rows: [
          { id_inventario: 10, fecha: "2026-08-04", turno: "Manana", id_empleado: 1, valor_total: 100 },
          { id_inventario: 11, fecha: "2026-08-04", turno: "Tarde", id_empleado: 1, valor_total: 200 }
        ],
        rowCount: 2
      },
      detalle_inventarios: {
        headers: EXPECTED_BACKEND_COLUMNS.detalle_inventarios,
        rows: [
          { id_detalle_inventario: 1, id_inventario: 10, id_item: 1, cantidad: 2, costo_unitario_usado: 50, valor_total: 100 },
          { id_detalle_inventario: 2, id_inventario: 11, id_item: 1, cantidad: 4, costo_unitario_usado: 50, valor_total: 200 }
        ],
        rowCount: 2
      }
    }
  };
}

test("la migracion crea una tabla vacia, no hace backfill y es idempotente", () => {
  const source = fixture();
  const sourceBefore = JSON.stringify(source);
  const first = migrateInventoryAlipackCounters(source);
  const second = migrateInventoryAlipackCounters(first.cache);

  assert.equal(JSON.stringify(source), sourceBefore);
  assert.equal(first.report.tableCreated, true);
  assert.equal(first.report.rowsBackfilled, 0);
  assert.deepEqual(first.cache.tables[TABLE_NAME], {
    headers: EXPECTED_BACKEND_COLUMNS[TABLE_NAME],
    rows: [],
    rowCount: 0
  });
  assert.equal(second.report.tableCreated, false);
  assert.deepEqual(second.cache, first.cache);
  assert.deepEqual(rollbackInventoryAlipackCounters(first.cache).cache, source);
});

test("dry-run, apply, segundo apply y rollback usan backup verificable sobre copia aislada", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "erp-alipack-migration-"));
  const cacheFile = path.join(directory, "cache.json");
  const backupFile = path.join(directory, "before.json");
  const original = Buffer.from(JSON.stringify(fixture(), null, 2), "utf8");
  try {
    fs.writeFileSync(cacheFile, original);
    const dryRun = runCli(["dry-run", cacheFile, backupFile]);
    assert.equal(dryRun.report.tableCreated, true);
    assert.equal(fs.existsSync(backupFile), false);
    assert.deepEqual(fs.readFileSync(cacheFile), original);

    const applied = runCli(["apply", cacheFile, backupFile]);
    assert.equal(applied.report.tableCreated, true);
    assert.equal(verifyBackup(fs.readFileSync(backupFile), applied.backup), true);
    assert.deepEqual(applied.backup, createBackupManifest(original));
    assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, "utf8")).tables[TABLE_NAME].rows, []);

    const second = runCli(["apply", cacheFile, backupFile]);
    assert.equal(second.report.tableCreated, false);
    const afterApply = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    afterApply.tables.inventarios.rows.push({
      id_inventario: 12,
      fecha: "2026-08-05",
      turno: "Tarde",
      id_empleado: 1,
      valor_total: 300
    });
    afterApply.tables.inventarios.rowCount = 3;
    fs.writeFileSync(cacheFile, JSON.stringify(afterApply, null, 2));
    runCli(["rollback", cacheFile, backupFile]);
    const rolledBack = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert.equal(rolledBack.tables[TABLE_NAME], undefined);
    assert.equal(rolledBack.tables.inventarios.rows.length, 3);
    assert.equal(rolledBack.tables.inventarios.rows.at(-1).id_inventario, 12);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("la integridad rechaza duplicados y huerfanos y el rollback protege filas operativas", () => {
  const migrated = migrateInventoryAlipackCounters(fixture()).cache;
  migrated.tables[TABLE_NAME].rows = [
    { id_contador_alipack: 1, id_inventario: 10, valor_contador: 100.5 },
    { id_contador_alipack: 2, id_inventario: 10, valor_contador: 101.5 }
  ];
  assert.throws(() => assertInventoryAlipackCounterRows(migrated), /maximo un Contador/i);

  migrated.tables[TABLE_NAME].rows = [
    { id_contador_alipack: 1, id_inventario: 999, valor_contador: 100.5 }
  ];
  assert.throws(() => assertInventoryAlipackCounterRows(migrated), /inexistente/i);
  assert.throws(() => rollbackInventoryAlipackCounters(migrated), /registros operativos/i);
});

test("registry, Editor, Mapa y SQL exponen la tabla y su relacion en modo lectura", () => {
  const definition = registry.tables.find((table) => table.name === TABLE_NAME);
  assert.ok(definition);
  assert.deepEqual(EXPECTED_BACKEND_COLUMNS[TABLE_NAME], ["id_contador_alipack", "id_inventario", "valor_contador"]);
  assert.equal(BACKEND_TABLE_PROJECTIONS[TABLE_NAME].columns, EXPECTED_BACKEND_COLUMNS[TABLE_NAME]);
  assert.deepEqual(adminTableCapability(TABLE_NAME), {
    read: true,
    insert: false,
    update: false,
    delete: false,
    category: "operational-readonly",
    reason: ADMIN_TABLE_POLICY[TABLE_NAME].reason
  });

  const relation = ADMIN_TABLE_RELATIONS.find((entry) => entry.sourceTable === TABLE_NAME && entry.column === "id_inventario");
  assert.deepEqual(relation && { table: relation.table, target: relation.target }, {
    table: "inventarios",
    target: "id_inventario"
  });

  const migrated = migrateInventoryAlipackCounters(fixture()).cache;
  const backendMap = createBackendMapService({
    EXPECTED_BACKEND_COLUMNS,
    loadCache: () => migrated,
    loadRegistry: () => registry,
    normalizeHeader
  })();
  const mappedTable = backendMap.tables.find((table) => table.name === TABLE_NAME);
  assert.equal(mappedTable.issueCount, 0);
  assert.deepEqual(mappedTable.actualColumns, EXPECTED_BACKEND_COLUMNS[TABLE_NAME]);

  let adminResponse;
  const adminService = createAdminTableService({
    adminTablePolicy: ADMIN_TABLE_POLICY,
    backendTable: () => ({
      definition,
      headers: EXPECTED_BACKEND_COLUMNS[TABLE_NAME],
      rows: [],
      order: { column: "id_contador_alipack", direction: "asc" }
    }),
    loadCache: () => migrated,
    loadRegistry: () => registry,
    recordAllRowsRead: () => {},
    sendJson: (_response, status, payload) => { adminResponse = { status, payload }; }
  });
  adminService.handleAdminTableRequest({
    url: `/api/admin/tables/${TABLE_NAME}`,
    headers: { host: "127.0.0.1" }
  }, {});
  assert.equal(adminResponse.status, 200);
  assert.deepEqual(adminResponse.payload.table.capabilities, {
    read: true,
    insert: false,
    update: false,
    delete: false,
    category: "operational-readonly",
    reason: ADMIN_TABLE_POLICY[TABLE_NAME].reason
  });
  assert.equal(adminResponse.payload.table.relations.id_inventario.table, "inventarios");

  const sqlSchema = buildSanitizedSqlSchema({
    expectedBackendColumns: EXPECTED_BACKEND_COLUMNS,
    registry,
    relations: ADMIN_TABLE_RELATIONS
  });
  const sqlTable = sqlSchema.tables.find((table) => table.name === TABLE_NAME);
  assert.deepEqual(sqlTable.columns.find((column) => column.name === "id_inventario").relation, {
    table: "inventarios",
    column: "id_inventario"
  });
});
