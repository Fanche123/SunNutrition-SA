const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const { EXPECTED_BACKEND_COLUMNS } = require("../backend/config/backend-columns");
const { createBankPersistenceService } = require("../backend/services/bank-persistence.service");
const { createExpenseClassificationService } = require("../backend/services/expense-classification.service");
const {
  applyInvestmentFundMovement,
  createInvestmentFundService,
  investmentFundState
} = require("../backend/services/investment-fund.service");
const { backendId, backendRowsById } = require("../backend/utils/ids");
const {
  backendNextNumericId,
  cleanBackendText,
  ensureBackendTable,
  normalizeLookupText
} = require("../backend/utils/runtime");

function fixture() {
  return {
    generatedAt: "fixture",
    tables: {
      etiquetas: {
        headers: EXPECTED_BACKEND_COLUMNS.etiquetas,
        rows: [{ id_etiqueta: "16", etiqueta: "Rendimiento Fondo" }],
        rowCount: 1
      },
      fondos_inversion_movimientos: {
        headers: EXPECTED_BACKEND_COLUMNS.fondos_inversion_movimientos,
        rows: [],
        rowCount: 0
      },
      movimientos_bancarios: {
        headers: EXPECTED_BACKEND_COLUMNS.movimientos_bancarios,
        rows: [
          bankRow(1, "2026-07-01", 12000000, 0, "DEB SUSC FCI"),
          bankRow(2, "2026-07-08", 0, 5000000.19, "CRED RESC FCI"),
          bankRow(3, "2026-07-14", 0, 1999999.79, "CRED RESC FCI"),
          bankRow(4, "2026-07-15", 0, 5048625.53, "CRED RESC FCI")
        ],
        rowCount: 4
      },
      gastos_economicos: {
        headers: EXPECTED_BACKEND_COLUMNS.gastos_economicos,
        rows: [],
        rowCount: 0
      }
    }
  };
}

function bankRow(id, fecha, debito, credito, detalle) {
  return {
    id_movimiento_bancario: id,
    banco: "ICBC",
    fecha,
    detalle,
    concepto: detalle,
    debito,
    credito,
    importe: credito - debito,
    saldo: 0,
    id_pago: "",
    id_cobro: "",
    id_movimiento_fondo: ""
  };
}

const common = {
  backendId,
  backendNextNumericId,
  expectedBackendColumns: EXPECTED_BACKEND_COLUMNS
};

function apply(cache, source) {
  return applyInvestmentFundMovement(cache, source, common);
}

test("saldo en centavos, asociaciones bancarias y rendimiento como gasto negativo", () => {
  const cache = fixture();
  apply(cache, {
    fecha: "2026-07-01",
    tipo: "deposito",
    importe: 12000000,
    id_movimiento_bancario: 1,
    clave_idempotencia: "deposito-1"
  });
  apply(cache, {
    fecha: "2026-07-08",
    tipo: "rescate",
    importe: 5000000.19,
    id_movimiento_bancario: 2,
    clave_idempotencia: "rescate-1"
  });
  apply(cache, {
    fecha: "2026-07-14",
    tipo: "rescate",
    importe: 1999999.79,
    id_movimiento_bancario: 3,
    clave_idempotencia: "rescate-2"
  });
  const yieldResult = apply(cache, {
    fecha: "2026-07-15",
    tipo: "rendimiento",
    importe: 48625.51,
    periodo_rendimiento: "2026-07",
    id_etiqueta: 16,
    clave_idempotencia: "rendimiento-2026-07"
  });
  apply(cache, {
    fecha: "2026-07-15",
    tipo: "rescate",
    importe: 5048625.53,
    id_movimiento_bancario: 4,
    clave_idempotencia: "rescate-3"
  });

  const state = investmentFundState(cache);
  assert.strictEqual(state.balance, 0);
  assert.strictEqual(cache.tables.movimientos_bancarios.rows[0].id_movimiento_fondo, 1);
  assert.strictEqual(cache.tables.movimientos_bancarios.rows[3].id_movimiento_fondo, 5);
  assert.strictEqual(cache.tables.movimientos_bancarios.rows.every((row) => !row.id_pago && !row.id_cobro), true);
  const economic = cache.tables.gastos_economicos.rows[0];
  assert.strictEqual(economic.id_gasto_economico, yieldResult.movement.id_gasto_economico);
  assert.strictEqual(economic.importe, -48625.51);
  assert.strictEqual(economic.estado, "confirmado");
  assert.strictEqual(economic.origen_tipo, "fondo_inversion");
  assert.strictEqual(economic.origen_id, "4");
});

test("rechaza importes, fechas, duplicados mensuales, saldo insuficiente y asociaciones incorrectas", () => {
  const invalid = fixture();
  assert.throws(() => apply(invalid, {
    fecha: "2026-02-30", tipo: "deposito", importe: 1, clave_idempotencia: "bad-date"
  }), (error) => error.code === "INVESTMENT_FUND_DATE_INVALID");
  assert.throws(() => apply(invalid, {
    fecha: "2026-07-01", tipo: "deposito", importe: "1,001", clave_idempotencia: "bad-money"
  }), (error) => error.code === "INVESTMENT_FUND_AMOUNT_INVALID");
  assert.throws(() => apply(invalid, {
    fecha: "2026-07-01", tipo: "rescate", importe: 1, clave_idempotencia: "no-balance"
  }), (error) => error.code === "INVESTMENT_FUND_INSUFFICIENT_BALANCE");
  assert.throws(() => apply(invalid, {
    fecha: "2026-07-08", tipo: "deposito", importe: 5000000.19, id_movimiento_bancario: 2, clave_idempotencia: "wrong-direction"
  }), (error) => error.code === "INVESTMENT_FUND_BANK_AMOUNT_MISMATCH");

  apply(invalid, { fecha: "2026-07-01", tipo: "deposito", importe: 100, clave_idempotencia: "manual-deposit" });
  apply(invalid, {
    fecha: "2026-07-15",
    tipo: "rendimiento",
    importe: 1,
    periodo_rendimiento: "2026-07",
    id_etiqueta: 16,
    clave_idempotencia: "yield-1"
  });
  assert.throws(() => apply(invalid, {
    fecha: "2026-07-20",
    tipo: "rendimiento",
    importe: 2,
    periodo_rendimiento: "2026-07",
    id_etiqueta: 16,
    clave_idempotencia: "yield-2"
  }), (error) => error.code === "INVESTMENT_FUND_PERIOD_DUPLICATE");
  const replay = apply(invalid, {
    fecha: "2026-07-15",
    tipo: "rendimiento",
    importe: 1,
    periodo_rendimiento: "2026-07",
    id_etiqueta: 16,
    clave_idempotencia: "yield-1"
  });
  assert.strictEqual(replay.idempotent, true);
  assert.strictEqual(invalid.tables.gastos_economicos.rows.length, 1);
});

test("un movimiento asociado al fondo deja de ser pendiente sin falsos pagos o cobros", () => {
  const cache = fixture();
  apply(cache, {
    fecha: "2026-07-01",
    tipo: "deposito",
    importe: 12000000,
    id_movimiento_bancario: 1,
    clave_idempotencia: "deposito-asociado"
  });
  const bankPersistence = createBankPersistenceService({
    backendBankMatches: (value, bank) => String(value).toLowerCase() === String(bank).toLowerCase(),
    backendId,
    backendIsoDate: (value) => String(value || ""),
    backendNextNumericId,
    backendNormalizeText: (value) => String(value || "").trim().toLowerCase(),
    backendNumber: Number,
    backendTagIdForName: () => "",
    cleanBackendText,
    compactBankText: cleanBackendText,
    crypto: require("crypto"),
    ensureBackendTable,
    loadCache: () => cache,
    normalizeBankCheckNumber: cleanBackendText,
    normalizeBankCuit: cleanBackendText,
    saveBackendCache: () => {}
  });
  const pending = bankPersistence.canonicalPendingBankMovements(cache.tables, "ICBC");
  assert.strictEqual(pending.some((row) => String(row.canonicalMovementId) === "1"), false);
  assert.strictEqual(cache.tables.movimientos_bancarios.rows[0].id_pago, "");
  assert.strictEqual(cache.tables.movimientos_bancarios.rows[0].id_cobro, "");
});

test("el endpoint persiste una sola vez y reintenta de forma idempotente", async () => {
  let persisted = fixture();
  let saves = 0;
  const service = createInvestmentFundService({
    backendId,
    backendNextNumericId,
    expectedBackendColumns: EXPECTED_BACKEND_COLUMNS,
    loadCache: () => persisted,
    readJsonBody: async (request) => request.body,
    saveBackendCache: (cache) => {
      persisted = cache;
      saves += 1;
    },
    sendJson: (response, status, payload) => Object.assign(response, { status, payload })
  });
  const request = {
    body: { fecha: "2026-07-01", tipo: "deposito", importe: 100, clave_idempotencia: "http-deposit" }
  };
  const first = {};
  await service.handleCreate(request, first);
  const replay = {};
  await service.handleCreate(request, replay);
  assert.strictEqual(first.status, 201);
  assert.strictEqual(replay.status, 200);
  assert.strictEqual(replay.payload.idempotent, true);
  assert.strictEqual(saves, 1);
});

test("Estado de Resultados consume el rendimiento una sola vez como gasto negativo", () => {
  const cache = fixture();
  apply(cache, { fecha: "2026-07-01", tipo: "deposito", importe: 100, clave_idempotencia: "deposit" });
  apply(cache, {
    fecha: "2026-07-15",
    tipo: "rendimiento",
    importe: 48.51,
    periodo_rendimiento: "2026-07",
    id_etiqueta: 16,
    clave_idempotencia: "yield"
  });
  const classification = createExpenseClassificationService({
    backendId,
    backendIsoDate: (value) => String(value || ""),
    backendNormalizeText: normalizeLookupText,
    backendNumber: (value) => Number(value || 0),
    backendRowsById,
    cleanBackendText,
    normalizeBankCuit: cleanBackendText,
    normalizeLookupText
  });
  const totals = classification.backendExpenseCategoryTotals(cache.tables, "2026-07-01", "2026-07-31");
  assert.strictEqual(totals["Rendimiento Fondo"], -48.51);
});

test("la integracion visual declara formulario, historial, estados y breakpoint reducido", () => {
  const root = path.resolve(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "assets/css/styles.css"), "utf8");
  const frontend = fs.readFileSync(path.join(root, "assets/js/modules/investment-fund.js"), "utf8");
  [
    "investment-fund-balance",
    "investment-fund-form",
    "investment-fund-type",
    "investment-fund-amount",
    "investment-fund-history-body",
    "investment-fund-form-status"
  ].forEach((id) => assert.match(html, new RegExp(`id=\"${id}\"`)));
  assert.match(html, /assets\/js\/modules\/investment-fund\.js/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.investment-fund-form\s*\{[\s\S]*grid-template-columns: 1fr/);
  assert.match(css, /\.investment-fund-history\s*\{[\s\S]*min-width: 940px/);
  assert.match(frontend, /escapeHtml\(row\.observacion/);
  assert.match(frontend, /data-money-input|ErpMoney\.parseInput/);
});
