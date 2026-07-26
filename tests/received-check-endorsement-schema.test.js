const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EXPECTED_BACKEND_COLUMNS } = require("../backend/config/backend-columns");
const { BACKEND_TABLE_PROJECTIONS } = require("../backend/config/backend-projections");
const { ADMIN_TABLE_POLICY } = require("../backend/config/admin-table-policy");
const { backendSchema } = require("../backend/data-store");
const { createBackendMapService } = require("../backend/services/backend-map.service");
const { normalizeHeader } = require("../backend/utils/runtime");
const {
  validateReceivedCheckEndorsementOperation,
  validateReceivedCheckEndorsementRow
} = require("../backend/utils/received-check-endorsement");
const {
  ADDED_COLUMNS,
  createBackupManifest,
  migrateReceivedCheckEndorsement,
  rollbackReceivedCheckEndorsement,
  verifyBackup
} = require("../backend/migrations/20260724-received-check-endorsement");

function fixture() {
  return {
    generatedAt: "fixture",
    tables: {
      pagos: {
        headers: ["id_pago", "fecha_pago", "metodo", "banco", "monto"],
        rows: [
          { id_pago: 50, fecha_pago: "2026-07-24", metodo: "Endoso", banco: "", monto: 150.25 },
          { id_pago: 51, fecha_pago: "2026-07-24", metodo: "Transferencia", banco: "ICBC", monto: 150.25 }
        ],
        rowCount: 2
      },
      cheques_recibidos: {
        headers: EXPECTED_BACKEND_COLUMNS.cheques_recibidos.filter((column) => !ADDED_COLUMNS.includes(column)),
        rows: [
          { id_cheque_recibido: 1, id_cobro: 10, monto: 100.25, estado: "Pendiente" },
          { id_cheque_recibido: 2, id_cobro: 11, monto: 50, estado: "Pendiente" },
          { id_cheque_recibido: 3, id_cobro: 12, monto: 20, estado: "Depositado", id_deposito: "deposito-1", fecha_deposito: "2026-07-23" },
          { id_cheque_recibido: 4, id_cobro: 13, monto: 30, estado: "Endosado" },
          { id_cheque_recibido: 5, id_cobro: 14, monto: 40, estado: "Cobrado" }
        ],
        rowCount: 5
      }
    }
  };
}

function endorsedRows(cache) {
  return cache.tables.cheques_recibidos.rows.slice(0, 2).map((row) => ({
    ...row,
    estado: "Endosado",
    id_pago_endoso: 50,
    fecha_endoso: "2026-07-24",
    id_deposito: "",
    fecha_deposito: ""
  }));
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => error?.code === code);
}

function testSchemaAndHistoricalCompatibility() {
  const source = fixture();
  const beforeRows = JSON.stringify(source.tables.cheques_recibidos.rows);
  const migrated = migrateReceivedCheckEndorsement(source);
  assert.strictEqual(migrated.report.beforeCount, 5);
  assert.strictEqual(migrated.report.afterCount, 5);
  assert.strictEqual(migrated.report.rowsModified, 0);
  assert.deepStrictEqual(migrated.cache.tables.cheques_recibidos.headers, EXPECTED_BACKEND_COLUMNS.cheques_recibidos);
  assert.strictEqual(JSON.stringify(migrated.cache.tables.cheques_recibidos.rows), beforeRows);
  assert.strictEqual(source.tables.cheques_recibidos.headers.includes("id_pago_endoso"), false);
  assert.strictEqual(source.tables.cheques_recibidos.headers.includes("fecha_endoso"), false);
  assert.strictEqual(BACKEND_TABLE_PROJECTIONS.cheques_recibidos.aliases.id_pago_endoso.includes("id_pago_endoso"), true);
  assert.strictEqual(BACKEND_TABLE_PROJECTIONS.cheques_recibidos.aliases.fecha_endoso.includes("fecha_endoso"), true);
}

function testStrictNewStateValidation() {
  const cache = fixture();
  const valid = endorsedRows(cache);
  validateReceivedCheckEndorsementRow(valid[0], cache.tables.pagos.rows);
  validateReceivedCheckEndorsementOperation({
    previousRows: cache.tables.cheques_recibidos.rows,
    endorsedRows: valid,
    payment: cache.tables.pagos.rows[0],
    payments: cache.tables.pagos.rows
  });

  expectCode("RECEIVED_CHECK_ENDORSEMENT_PAYMENT_REQUIRED", () => {
    validateReceivedCheckEndorsementRow({ ...valid[0], id_pago_endoso: "" }, cache.tables.pagos.rows);
  });
  expectCode("RECEIVED_CHECK_ENDORSEMENT_DATE_REQUIRED", () => {
    validateReceivedCheckEndorsementRow({ ...valid[0], fecha_endoso: "" }, cache.tables.pagos.rows);
  });
  expectCode("RECEIVED_CHECK_ENDORSEMENT_DEPOSIT_CONFLICT", () => {
    validateReceivedCheckEndorsementRow({ ...valid[0], id_deposito: "deposito-2" }, cache.tables.pagos.rows);
  });
  expectCode("RECEIVED_CHECK_ENDORSEMENT_PAYMENT_NOT_FOUND", () => {
    validateReceivedCheckEndorsementRow({ ...valid[0], id_pago_endoso: 999 }, cache.tables.pagos.rows);
  });
  expectCode("RECEIVED_CHECK_ENDORSEMENT_METHOD_INVALID", () => {
    validateReceivedCheckEndorsementRow({ ...valid[0], id_pago_endoso: 51 }, cache.tables.pagos.rows);
  });
  expectCode("RECEIVED_CHECK_ENDORSEMENT_TOTAL_MISMATCH", () => {
    validateReceivedCheckEndorsementOperation({
      previousRows: cache.tables.cheques_recibidos.rows,
      endorsedRows: valid.slice(0, 1),
      payment: cache.tables.pagos.rows[0],
      payments: cache.tables.pagos.rows
    });
  });
  expectCode("RECEIVED_CHECK_ENDORSEMENT_NOT_PENDING", () => {
    validateReceivedCheckEndorsementOperation({
      previousRows: cache.tables.cheques_recibidos.rows,
      endorsedRows: [{
        ...cache.tables.cheques_recibidos.rows[2],
        estado: "Endosado",
        id_pago_endoso: 50,
        fecha_endoso: "2026-07-24",
        id_deposito: "",
        fecha_deposito: ""
      }],
      payment: { ...cache.tables.pagos.rows[0], monto: 20 },
      payments: cache.tables.pagos.rows
    });
  });
}

function testMapAndAdministrationPolicy() {
  const migrated = migrateReceivedCheckEndorsement(fixture()).cache;
  const schemaDefinition = backendSchema().tables.find((table) => table.name === "cheques_recibidos");
  assert.strictEqual(schemaDefinition.primaryKey, "id_cheque_recibido");
  const registry = {
    tables: [{
      name: "cheques_recibidos",
      label: "Cheques recibidos",
      module: "ventas",
      primaryKey: "id_cheque_recibido"
    }]
  };
  const map = createBackendMapService({
    EXPECTED_BACKEND_COLUMNS,
    loadCache: () => migrated,
    loadRegistry: () => registry,
    normalizeHeader
  })();
  assert.strictEqual(map.tables[0].issueCount, 0);
  assert.deepStrictEqual(map.tables[0].missingColumns, []);
  assert.deepStrictEqual(map.tables[0].extraColumns, []);
  assert.strictEqual(ADMIN_TABLE_POLICY.cheques_recibidos.read, true);
  assert.strictEqual(ADMIN_TABLE_POLICY.cheques_recibidos.insert, true);
  assert.strictEqual(ADMIN_TABLE_POLICY.cheques_recibidos.update, true);
  assert.strictEqual(ADMIN_TABLE_POLICY.cheques_recibidos.delete, true);
}

function testBackupRestartAndRollback() {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "erp-check-endorsement-"));
  try {
    const sourcePath = path.join(temporaryDirectory, "source.json");
    const backupPath = path.join(temporaryDirectory, "backup.json");
    const migratedPath = path.join(temporaryDirectory, "migrated.json");
    const source = fixture();
    const serialized = JSON.stringify(source, null, 2);
    fs.writeFileSync(sourcePath, serialized, "utf8");
    fs.copyFileSync(sourcePath, backupPath);

    const manifest = createBackupManifest(fs.readFileSync(sourcePath));
    assert.strictEqual(verifyBackup(fs.readFileSync(backupPath), manifest), true);

    const migration = migrateReceivedCheckEndorsement(JSON.parse(fs.readFileSync(sourcePath, "utf8")));
    fs.writeFileSync(migratedPath, JSON.stringify(migration.cache, null, 2), "utf8");
    const reloaded = JSON.parse(fs.readFileSync(migratedPath, "utf8"));
    assert.deepStrictEqual(reloaded.tables.cheques_recibidos.headers, EXPECTED_BACKEND_COLUMNS.cheques_recibidos);
    assert.strictEqual(reloaded.tables.cheques_recibidos.rows.length, source.tables.cheques_recibidos.rows.length);

    const rollback = rollbackReceivedCheckEndorsement(reloaded);
    assert.deepStrictEqual(rollback.cache, source);
    assert.strictEqual(rollback.report.rowsModified, 0);

    const withEndorsement = migrateReceivedCheckEndorsement(source).cache;
    withEndorsement.tables.cheques_recibidos.rows[0].id_pago_endoso = 50;
    withEndorsement.tables.cheques_recibidos.rows[0].fecha_endoso = "2026-07-24";
    expectCode("ENDORSEMENT_ROLLBACK_HAS_DATA", () => rollbackReceivedCheckEndorsement(withEndorsement));
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function main() {
  testSchemaAndHistoricalCompatibility();
  testStrictNewStateValidation();
  testMapAndAdministrationPolicy();
  testBackupRestartAndRollback();
  console.log("Received-check endorsement schema tests: OK");
}

main();
