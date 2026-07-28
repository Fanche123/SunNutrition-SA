const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { EXPECTED_BACKEND_COLUMNS } = require("../backend/config/backend-columns");
const {
  createBackupManifest,
  initializeInvestmentFundData,
  migrateInvestmentFund,
  rollbackInvestmentFund,
  verifyBackup
} = require("../backend/migrations/20260727-investment-fund");
const { investmentFundState } = require("../backend/services/investment-fund.service");

function fixture(finalCredit = 5048625.53) {
  const rescues = [
    ["2026-07-08", 5000000.19],
    ["2026-07-14", 1999999.79],
    ["2026-07-15", finalCredit]
  ];
  return {
    generatedAt: "fixture",
    tables: {
      movimientos_bancarios: {
        headers: EXPECTED_BACKEND_COLUMNS.movimientos_bancarios.filter((column) => column !== "id_movimiento_fondo"),
        rows: rescues.map(([fecha, credito], index) => ({
          id_movimiento_bancario: index + 1,
          banco: "ICBC",
          fecha,
          concepto: "CRED RESC FCI",
          detalle: "CRED RESC FCI",
          debito: 0,
          credito,
          importe: credito,
          saldo: 0,
          id_pago: "",
          id_cobro: ""
        })),
        rowCount: 3
      },
      etiquetas: {
        headers: EXPECTED_BACKEND_COLUMNS.etiquetas,
        rows: [{ id_etiqueta: "16", etiqueta: "Rendimiento Fondo" }],
        rowCount: 1
      },
      pagos: {
        headers: EXPECTED_BACKEND_COLUMNS.pagos,
        rows: [],
        rowCount: 0
      },
      gastos_economicos: {
        headers: EXPECTED_BACKEND_COLUMNS.gastos_economicos,
        rows: [],
        rowCount: 0
      }
    }
  };
}

test("migracion forward, idempotencia y rollback vacio", () => {
  const source = fixture();
  const first = migrateInvestmentFund(source);
  const second = migrateInvestmentFund(first.cache);
  assert.strictEqual(first.report.fundTableCreated, true);
  assert.strictEqual(second.report.fundTableCreated, false);
  assert.deepStrictEqual(first.cache.tables.fondos_inversion_movimientos.headers, EXPECTED_BACKEND_COLUMNS.fondos_inversion_movimientos);
  assert.strictEqual(first.cache.tables.movimientos_bancarios.headers.includes("id_movimiento_fondo"), true);
  assert.deepStrictEqual(second.cache, first.cache);
  assert.deepStrictEqual(rollbackInvestmentFund(first.cache).cache, source);
});

test("backup verificable y rechazo de rollback con datos", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "erp-investment-fund-"));
  try {
    const source = Buffer.from(JSON.stringify(fixture(), null, 2));
    const backupPath = path.join(directory, "backend-data-cache.backup.json");
    fs.writeFileSync(backupPath, source);
    const manifest = createBackupManifest(source);
    assert.strictEqual(verifyBackup(fs.readFileSync(backupPath), manifest), true);
    const initialized = initializeInvestmentFundData(
      JSON.parse(source.toString("utf8")),
      { yieldDate: "2026-07-15" }
    ).cache;
    assert.throws(() => rollbackInvestmentFund(initialized), (error) => error.code === "INVESTMENT_FUND_ROLLBACK_HAS_DATA");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("inicializacion autorizada es atomica, exacta e idempotente", () => {
  const initialized = initializeInvestmentFundData(fixture(), { yieldDate: "2026-07-15" });
  assert.strictEqual(initialized.report.inserted, 5);
  assert.strictEqual(investmentFundState(initialized.cache).balance, 0);
  assert.strictEqual(initialized.cache.tables.gastos_economicos.rows[0].importe, -48625.51);
  assert.strictEqual(initialized.cache.tables.movimientos_bancarios.rows.every((row) => row.id_movimiento_fondo), true);
  assert.strictEqual(initialized.cache.tables.movimientos_bancarios.rows.every((row) => row.id_pago), true);
  assert.deepStrictEqual(
    initialized.cache.tables.pagos.rows.map((row) => row.monto),
    [12000000, -5000000.19, -1999999.79, -5048625.53]
  );
  const replay = initializeInvestmentFundData(initialized.cache, { yieldDate: "2026-07-15" });
  assert.strictEqual(replay.report.idempotent, true);
  assert.deepStrictEqual(replay.cache, initialized.cache);
});

test("la coincidencia por importe debe ser exacta; no aproxima el dato real discrepante", () => {
  const source = fixture(5048625.63);
  const before = JSON.stringify(source);
  assert.throws(
    () => initializeInvestmentFundData(source, { yieldDate: "2026-07-15" }),
    (error) => error.code === "INVESTMENT_FUND_BANK_MATCH_NOT_UNIQUE"
  );
  assert.strictEqual(JSON.stringify(source), before);
});

test("la inicializacion exige fecha contable explicita para el rendimiento", () => {
  assert.throws(
    () => initializeInvestmentFundData(fixture()),
    (error) => error.code === "INVESTMENT_FUND_YIELD_DATE_REQUIRED"
  );
});
