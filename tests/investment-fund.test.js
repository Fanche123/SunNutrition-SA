const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const { EXPECTED_BACKEND_COLUMNS } = require("../backend/config/backend-columns");
const { createBankPersistenceService } = require("../backend/services/bank-persistence.service");
const { createBankReconciliationService } = require("../backend/services/bank-reconciliation.service");
const { createExpenseClassificationService } = require("../backend/services/expense-classification.service");
const {
  applyInvestmentFundMovement,
  classifyInvestmentFundCandidate,
  createInvestmentFundService,
  investmentFundCandidates,
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

function analyzedMovement(id, detail, amount, options = {}) {
  return {
    canonicalMovementId: id,
    movementKey: `ICBC:${id}`,
    bank: "ICBC",
    date: options.date || "2026-07-20",
    detail,
    concept: detail,
    debit: amount < 0 ? Math.abs(amount) : 0,
    credit: amount > 0 ? amount : 0,
    amount,
    match: options.match || null,
    checkMatch: options.checkMatch || null,
    sourceMatch: options.sourceMatch || null
  };
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
  assert.strictEqual(cache.tables.movimientos_bancarios.rows.every((row) => row.id_pago && !row.id_cobro), true);
  assert.deepStrictEqual(
    cache.tables.pagos.rows.map((row) => row.monto),
    [12000000, -5000000.19, -1999999.79, -5048625.53]
  );
  assert.deepStrictEqual(
    cache.tables.fondos_inversion_movimientos.rows.map((row) => row.id_pago),
    [1, 2, 3, "", 4]
  );
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

test("un movimiento asociado al fondo deja de ser pendiente con pago ICBC trazable y sin cobro", () => {
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
  assert.strictEqual(cache.tables.movimientos_bancarios.rows[0].id_pago, 1);
  assert.strictEqual(cache.tables.movimientos_bancarios.rows[0].id_cobro, "");
  assert.strictEqual(cache.tables.fondos_inversion_movimientos.rows[0].id_pago, 1);
  assert.strictEqual(cache.tables.pagos.rows[0].banco, "ICBC");
  assert.strictEqual(cache.tables.pagos.rows[0].monto, 12000000);
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

test("clasifica suscripciones, rescates, rendimientos y cuotapartes solo con evidencia fuerte", () => {
  const tables = fixture().tables;
  tables.fondos_inversion_movimientos.rows.push({
    id_movimiento_fondo: 1,
    fecha: "2026-07-01",
    tipo: "deposito",
    importe: 10000
  });
  const candidates = investmentFundCandidates([
    analyzedMovement(10, "DEB SUSC FCI", -1500.25),
    analyzedMovement(11, "CRED RESC FCI", 500.1),
    analyzedMovement(12, "RENDIMIENTO FCI", 25.55),
    analyzedMovement(13, "COMPRA CUOTAPARTES", -100),
    analyzedMovement(14, "VENTA CUOTAPARTES", 80)
  ], tables);

  assert.deepStrictEqual(candidates.map((row) => [row.confidence, row.type]), [
    ["reliable", "deposito"],
    ["reliable", "rescate"],
    ["review", "rendimiento"],
    ["reliable", "deposito"],
    ["reliable", "rescate"]
  ]);
  assert.strictEqual(candidates[0].payload.importe, 1500.25);
  assert.strictEqual(candidates[0].payload.id_movimiento_bancario, "10");
  assert.strictEqual(candidates[0].payload.clave_idempotencia, "fondo-banco:10");
  assert.strictEqual(candidates[2].payload, null);
  assert.match(candidates[2].reason, /exclusivamente economico|solo como movimiento economico/i);
});

test("marca ambiguedad, signo contradictorio, datos incompletos y asociaciones competidoras sin payload", () => {
  const tables = fixture().tables;
  const cases = [
    analyzedMovement(20, "RESCATE", 100),
    analyzedMovement(21, "DEB RESCATE FC", -100),
    analyzedMovement(22, "MOVIMIENTO FCI", 100),
    analyzedMovement(23, "CRED RESC FCI", 100, { match: { type: "cobro", id: 9 } }),
    analyzedMovement(29, "DEB SUSC FCI", -100, { sourceMatch: { type: "recepcion", id: 7 } }),
    analyzedMovement("", "DEB SUSC FCI", -100)
  ].map((movement) => classifyInvestmentFundCandidate(movement, tables));
  assert.strictEqual(cases.every((candidate) => candidate.confidence === "review"), true);
  assert.strictEqual(cases.every((candidate) => candidate.payload === null), true);

  const missingYieldTag = classifyInvestmentFundCandidate(
    analyzedMovement(24, "RENDIMIENTO FCI", 10),
    { etiquetas: { rows: [] } }
  );
  assert.strictEqual(missingYieldTag.confidence, "review");
  assert.match(missingYieldTag.reason, /movimiento economico/);
  assert.strictEqual(classifyInvestmentFundCandidate(analyzedMovement(25, "TRANSFERENCIA PROVEEDOR", -10), tables), null);
});

test("una regla descriptiva de datos bancarios no bloquea un rescate FCI confiable", () => {
  const tables = fixture().tables;
  tables.fondos_inversion_movimientos.rows.push({
    id_movimiento_fondo: 1,
    fecha: "2026-07-01",
    tipo: "deposito",
    importe: 1000
  });
  const candidate = classifyInvestmentFundCandidate(
    analyzedMovement(26, "CRED RESC FCI", 100, { match: { type: "dato_bancario", id: 37 } }),
    tables
  );
  assert.strictEqual(candidate.confidence, "reliable");
  assert.strictEqual(candidate.type, "rescate");
  assert.strictEqual(candidate.payload.id_movimiento_bancario, "26");
});

test("un rescate sin saldo y cualquier rendimiento bancario quedan sin accion automatica", () => {
  const tables = fixture().tables;
  const rescue = classifyInvestmentFundCandidate(
    analyzedMovement(27, "CRED RESC FCI", 100),
    tables
  );
  assert.strictEqual(rescue.confidence, "review");
  assert.match(rescue.reason, /saldo disponible/);

  tables.fondos_inversion_movimientos.rows.push({
    id_movimiento_fondo: 1,
    fecha: "2026-07-10",
    tipo: "rendimiento",
    importe: 10,
    periodo_rendimiento: "2026-07"
  });
  const duplicateYield = classifyInvestmentFundCandidate(
    analyzedMovement(28, "RENDIMIENTO FCI", 10),
    tables
  );
  assert.strictEqual(duplicateYield.confidence, "review");
  assert.match(duplicateYield.reason, /movimiento economico/);
});

test("el candidato bancario se registra una vez y no admite otra operacion sobre la misma fila", () => {
  const cache = fixture();
  const candidate = classifyInvestmentFundCandidate(
    analyzedMovement(1, "DEB SUSC FCI", -12000000, { date: "2026-07-01" }),
    cache.tables
  );
  const first = apply(cache, candidate.payload);
  const retry = apply(cache, candidate.payload);
  assert.strictEqual(first.idempotent, false);
  assert.strictEqual(retry.idempotent, true);
  assert.strictEqual(cache.tables.fondos_inversion_movimientos.rows.length, 1);
  assert.strictEqual(cache.tables.movimientos_bancarios.rows[0].id_movimiento_fondo, 1);
  assert.throws(() => apply(cache, {
    ...candidate.payload,
    clave_idempotencia: "otro-intento"
  }), (error) => error.code === "INVESTMENT_FUND_BANK_ALREADY_LINKED");
});

test("createExpenses no ejecuta una segunda ruta financiera para un candidato FCI", async () => {
  let persisted = fixture();
  let expenseCalls = 0;
  const pendingMovement = analyzedMovement(1, "DEB SUSC FCI", -12000000, { date: "2026-07-01" });
  const service = createBankReconciliationService({
    analyzeBankMovement: (movement) => ({
      ...movement,
      status: "agregar_gasto",
      providerMatch: { type: "datos_bancarios", id: 37 },
      match: null
    }),
    backendBankCollectionCandidates: () => [],
    backendBankCreditPayableCandidates: () => [],
    backendBankIdentityIndex: () => new Map(),
    backendBankPayableCandidates: () => [],
    backendBankPaymentCandidates: () => [],
    backendBankSourceCandidates: () => [],
    backendId,
    backendIssuedChecksByNumber: () => new Map(),
    backendNormalizeText: (value) => String(value || "").trim().toLowerCase(),
    backendNumber: Number,
    backendReceivedCheckDepositGroups: () => [],
    backendReceivedChecksByNumber: () => new Map(),
    bankMovementAssociation: () => ({ idPago: "", idCobro: "" }),
    bankMovementFingerprint: () => "fci",
    canonicalPendingBankMovements: () => [pendingMovement],
    cleanBackendText: (value) => String(value || "").trim(),
    createBankEgressForSource: () => null,
    createBankPaymentForExpense: () => null,
    createBankSourceExpense: () => {
      expenseCalls += 1;
      return { sourceId: 1, label: "Gasto" };
    },
    ensureBackendTable,
    importBankMovements: () => ({ newCount: 0, duplicateCount: 0 }),
    loadCache: () => persisted,
    normalizeBackendBankDetails: () => {},
    parseBankMovements: () => [],
    persistBankMovement: () => {},
    readJsonBody: async (request) => request.body,
    saveBackendCache: (cache) => { persisted = cache; },
    seedDefaultBankDetails: () => 0,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    updateIssuedCheckFromBankMovement: () => false,
    updateReceivedCheckFromBankMovement: () => false
  });
  const response = {};
  await service.handleBankReconciliationApply({
    body: {
      bank: "ICBC",
      applyMode: "createExpenses",
      movementKeys: [pendingMovement.movementKey],
      reviewRows: {}
    }
  }, response);
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.payload.result.expensesCreated, 0);
  assert.strictEqual(response.payload.result.skipped, 1);
  assert.strictEqual(expenseCalls, 0);
  assert.strictEqual(persisted.tables.otros_gastos.rows.length, 0);
  assert.match(response.payload.result.notes[0], /Movimientos de fondo para agregar/);
});

test("un rendimiento bancario no crea pago, cobro ni vínculo bancario propio", () => {
  const cache = fixture();
  cache.tables.movimientos_bancarios.rows.push(
    bankRow(30, "2026-07-20", 0, 48625.51, "RENDIMIENTO FCI")
  );
  const candidate = classifyInvestmentFundCandidate(
    analyzedMovement(30, "RENDIMIENTO FCI", 48625.51),
    cache.tables
  );
  assert.strictEqual(candidate.confidence, "review");
  assert.strictEqual(candidate.payload, null);
  assert.throws(() => apply(cache, {
    fecha: "2026-07-20",
    tipo: "rendimiento",
    importe: 48625.51,
    periodo_rendimiento: "2026-07",
    id_etiqueta: 16,
    id_movimiento_bancario: 30,
    clave_idempotencia: "rendimiento-bancario"
  }), (error) => error.code === "INVESTMENT_FUND_YIELD_BANK_NOT_ALLOWED");
  assert.strictEqual(cache.tables.pagos.rows.length, 0);
  assert.strictEqual(cache.tables.gastos_economicos.rows.length, 0);
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
  const bankRender = fs.readFileSync(path.join(root, "assets/js/modules/bank-reconciliation-render.js"), "utf8");
  [
    "investment-fund-balance",
    "investment-fund-form",
    "investment-fund-type",
    "investment-fund-amount",
    "investment-fund-history-body",
    "investment-fund-form-status"
  ].forEach((id) => assert.match(html, new RegExp(`id=\"${id}\"`)));
  assert.match(html, /assets\/js\/modules\/investment-fund\.js/);
  assert.match(html, /data-view="payment-plans"[\s\S]*data-view="investment-fund"[\s\S]*data-view="partner-contributions-entry"/);
  const fundView = html.slice(html.indexOf('id="view-investment-fund"'), html.indexOf('id="view-bank-reconciliation"'));
  const reconciliationView = html.slice(html.indexOf('id="view-bank-reconciliation"'), html.indexOf('id="view-dashboard"'));
  assert.match(fundView, /id="investment-fund-form"/);
  assert.doesNotMatch(reconciliationView, /id="investment-fund-form"/);
  assert.match(reconciliationView, /Pagos para agregar[\s\S]*Movimientos de fondo para agregar/);
  assert.match(reconciliationView, /id="bank-fund-stage-body"/);
  ["bank-movements-stage", "bank-expense-stage", "bank-egress-stage", "bank-payment-stage", "bank-fund-stage"]
    .forEach((id) => assert.match(reconciliationView, new RegExp(`id="${id}" hidden`)));
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.investment-fund-form\s*\{[\s\S]*grid-template-columns: 1fr/);
  assert.match(css, /\.investment-fund-history\s*\{[\s\S]*min-width: 940px/);
  assert.match(frontend, /escapeHtml\(row\.observacion/);
  assert.match(frontend, /data-money-input|ErpMoney\.parseInput/);
  assert.match(frontend, /data-register-fund-candidate/);
  assert.match(bankRender, /bankReconciliationIsInvestmentFundCandidate/);
  assert.match(bankRender, /readyMovements = bankReconciliationMovementsByStatus\("listo"\)/);
});
