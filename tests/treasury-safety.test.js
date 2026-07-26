const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const vm = require("vm");
const os = require("os");
const money = require("../shared/money");
const { createCollectionEntryService } = require("../backend/services/collection-entry.service");
const { createPaymentEntryService } = require("../backend/services/payment-entry.service");
const { createPartnerContributionsService } = require("../backend/services/partner-contributions.service");
const { createBankReconciliationService } = require("../backend/services/bank-reconciliation.service");
const { createCashflowService } = require("../backend/services/cashflow.service");
const { ensureBackendTable, backendNextNumericId, normalizePartnerName } = require("../backend/utils/runtime");

const backendId = (value) => String(value ?? "").trim();
const backendNumber = (value) => Number(value) || 0;
const cleanBackendText = (value) => String(value ?? "").trim();
const clone = (value) => JSON.parse(JSON.stringify(value));

async function invoke(handler, body) {
  let result;
  await handler(
    { body },
    { json(status, payload) { result = { status, payload }; } }
  );
  return result;
}

const readJsonBody = async (request) => request.body;
const sendJson = (response, status, payload) => response.json(status, payload);

function memoryStore(seed) {
  let persisted = clone(seed);
  return {
    loadCache: () => clone(persisted),
    saveBackendCache: (next) => { persisted = clone(next); },
    value: () => clone(persisted)
  };
}

function diskStore(filePath, seed) {
  if (seed !== undefined && !fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(seed, null, 2), "utf8");
  }
  return {
    loadCache: () => JSON.parse(fs.readFileSync(filePath, "utf8")),
    saveBackendCache: (next) => {
      const temporary = `${filePath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2), "utf8");
      fs.renameSync(temporary, filePath);
    },
    value: () => JSON.parse(fs.readFileSync(filePath, "utf8")),
    replace: (next) => fs.writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8")
  };
}

function baseTables() {
  return {
    generatedAt: "",
    tables: {
      ventas: { headers: ["id_venta", "total"], rows: [{ id_venta: 10, total: 100.25 }], rowCount: 1 },
      egresos: { headers: ["id_egreso", "total"], rows: [{ id_egreso: 20, total: 75.25 }], rowCount: 1 },
      cheques_recibidos: {
        headers: ["id_cheque_recibido", "monto", "estado"],
        rows: [{ id_cheque_recibido: 30, id_cobro: 1, monto: 100.25, estado: "Pendiente" }],
        rowCount: 1
      }
    }
  };
}

async function testCollectionAtomicityAndIdempotency() {
  const body = {
    operationId: "collection-1",
    collection: { fecha: "2026-07-23", metodo: "Transferencia", idCliente: 1, monto: 90.15 },
    details: [{ idVenta: 10, monto: 100.25 }],
    retentions: { ganancias: 5.05, iibb: 5.05 }
  };
  for (const failurePoint of ["after-collection", "after-details"]) {
    const store = memoryStore(baseTables());
    const service = createCollectionEntryService({
      backendId, backendNextNumericId, backendNumber, ensureBackendTable,
      loadCache: store.loadCache, readJsonBody, saveBackendCache: store.saveBackendCache, sendJson,
      failureInjector: (point) => { if (point === failurePoint) throw new Error("fallo inyectado"); }
    });
    const before = store.value();
    const result = await invoke(service.handleCollectionFullEntry, body);
    assert.strictEqual(result.status, 400);
    assert.deepStrictEqual(store.value(), before);
  }

  const store = memoryStore(baseTables());
  const service = createCollectionEntryService({
    backendId, backendNextNumericId, backendNumber, ensureBackendTable,
    loadCache: store.loadCache, readJsonBody, saveBackendCache: store.saveBackendCache, sendJson
  });
  assert.strictEqual((await invoke(service.handleCollectionFullEntry, body)).status, 200);
  assert.strictEqual((await invoke(service.handleCollectionFullEntry, body)).payload.idempotent, true);
  assert.strictEqual(store.value().tables.cobros.rows.length, 1);
  assert.strictEqual(store.value().tables.cobros_detalle.rows.length, 1);
  assert.strictEqual(store.value().tables.retenciones_ganancias.rows.length, 1);
  assert.strictEqual(store.value().tables.retenciones_iibb.rows.length, 1);
}

async function testPaymentAtomicityAndIdempotency() {
  const body = {
    operationId: "payment-1",
    payment: { fecha: "2026-07-23", metodo: "Transferencia", banco: "ICBC" },
    details: [{ idEgreso: 20, monto: 25.1 }, { idEgreso: 20, monto: 50.15 }]
  };
  const failedStore = memoryStore(baseTables());
  const failedService = createPaymentEntryService({
    backendId, backendNextNumericId, backendNumber, ensureBackendTable,
    loadCache: failedStore.loadCache, readJsonBody, saveBackendCache: failedStore.saveBackendCache, sendJson,
    failureInjector: (point) => { if (point === "after-payment") throw new Error("fallo inyectado"); }
  });
  const before = failedStore.value();
  assert.strictEqual((await invoke(failedService.handlePaymentFullEntry, body)).status, 400);
  assert.deepStrictEqual(failedStore.value(), before);

  const store = memoryStore(baseTables());
  const service = createPaymentEntryService({
    backendId, backendNextNumericId, backendNumber, ensureBackendTable,
    loadCache: store.loadCache, readJsonBody, saveBackendCache: store.saveBackendCache, sendJson
  });
  await invoke(service.handlePaymentFullEntry, body);
  assert.strictEqual((await invoke(service.handlePaymentFullEntry, body)).payload.idempotent, true);
  assert.strictEqual(store.value().tables.pagos.rows[0].monto, 75.25);
  assert.strictEqual(store.value().tables.detalle_pagos.rows.length, 2);
}

async function testContributionAtomicityAndSigns() {
  const body = {
    operationId: "contribution-1",
    contribution: { fecha: "2026-07-23", nombre: "Socio", tipo: "Aporte", monto: 10.25 }
  };
  const failedStore = memoryStore(baseTables());
  const failedService = createPartnerContributionsService({
    backendId, backendNextNumericId, backendNumber, ensureBackendTable, normalizePartnerName,
    loadCache: failedStore.loadCache, readJsonBody, saveBackendCache: failedStore.saveBackendCache, sendJson,
    failureInjector: (point) => { if (point === "after-expense") throw new Error("fallo inyectado"); }
  });
  const before = failedStore.value();
  assert.strictEqual((await invoke(failedService.handlePartnerContributionFullEntry, body)).status, 400);
  assert.deepStrictEqual(failedStore.value(), before);

  const store = memoryStore(baseTables());
  const service = createPartnerContributionsService({
    backendId, backendNextNumericId, backendNumber, ensureBackendTable, normalizePartnerName,
    loadCache: store.loadCache, readJsonBody, saveBackendCache: store.saveBackendCache, sendJson
  });
  await invoke(service.handlePartnerContributionFullEntry, body);
  assert.strictEqual((await invoke(service.handlePartnerContributionFullEntry, body)).payload.idempotent, true);
  const state = store.value();
  assert.strictEqual(state.tables.aportes_socios.rows[0].monto, 10.25);
  assert.strictEqual(state.tables.egresos.rows.find((row) => row._operationId === "contribution-1").total, -10.25);
}

function bankDependencies(store, overrides = {}) {
  const empty = () => [];
  return {
    analyzeBankMovement: (movement) => ({ ...movement, status: "listo" }),
    backendBankCollectionCandidates: empty,
    backendBankCreditPayableCandidates: empty,
    backendBankIdentityIndex: () => new Map(),
    backendBankPayableCandidates: empty,
    backendBankPaymentCandidates: empty,
    backendBankSourceCandidates: empty,
    backendId,
    backendIssuedChecksByNumber: () => new Map(),
    backendNormalizeText: (value) => cleanBackendText(value).toLowerCase(),
    backendNumber,
    backendPersistedBankMovementCounts: () => new Map(),
    backendReceivedCheckDepositGroups: empty,
    backendReceivedChecksByNumber: () => new Map(),
    bankMovementFingerprint: (movement, bank) => `${bank}|${movement.date}|${movement.amount}|${movement.detail || ""}`,
    cleanBackendText,
    createBankEgressForSource: () => null,
    createBankPaymentForExpense: () => null,
    createBankSourceExpense: () => null,
    ensureBackendTable,
    loadCache: store.loadCache,
    normalizeBackendBankDetails: (cache) => { cache.tables.datos_bancarios.headers = ["id_dato_bancario"]; },
    parseBankMovements: (csvText) => [{
      date: "2026-07-23", amount: 100.25, credit: 100.25, debit: 0, balance: 100.25, detail: csvText
    }],
    persistBankMovement: (tables, movement, bank, operationKey, operationPayload) => {
      ensureBackendTable(tables, "movimientos_bancarios");
      if (tables.movimientos_bancarios.rows.some((row) => row._bankOperationKey === operationKey)) return;
      tables.movimientos_bancarios.rows.push({
        id_movimiento_bancario: backendNextNumericId(tables.movimientos_bancarios.rows, "id_movimiento_bancario"),
        banco: bank, fecha: movement.date, importe: movement.amount,
        _bankOperationKey: operationKey, _bankOperationPayload: operationPayload
      });
      tables.movimientos_bancarios.rowCount = tables.movimientos_bancarios.rows.length;
    },
    readJsonBody,
    saveBackendCache: store.saveBackendCache,
    seedDefaultBankDetails: (cache) => {
      cache.tables.datos_bancarios.rows.push({ id_dato_bancario: 1, detalle: "propuesta" });
      return 1;
    },
    sendJson,
    updateIssuedCheckFromBankMovement: () => true,
    updateReceivedCheckFromBankMovement: () => true,
    ...overrides
  };
}

async function testAnalyzeAndApply() {
  const store = memoryStore(baseTables());
  const service = createBankReconciliationService(bankDependencies(store));
  const before = store.value();
  assert.strictEqual((await invoke(service.handleBankReconciliationAnalyze, { bank: "ICBC", csvText: "csv" })).status, 200);
  assert.strictEqual((await invoke(service.handleBankReconciliationAnalyze, { bank: "ICBC", csvText: "csv" })).status, 200);
  assert.deepStrictEqual(store.value(), before);

  const applyBody = { bank: "ICBC", csvText: "csv", applyMode: "reconcile" };
  await invoke(service.handleBankReconciliationApply, applyBody);
  await invoke(service.handleBankReconciliationApply, applyBody);
  assert.strictEqual(store.value().tables.movimientos_bancarios.rows.length, 1);
}

async function testDepositRollbackAndRetry() {
  const body = {
    bank: "ICBC",
    depositDate: "2026-07-23",
    checkIds: [30],
    movement: { date: "2026-07-23", amount: 100.25, credit: 100.25 }
  };
  const failedStore = memoryStore(baseTables());
  const failed = createBankReconciliationService(bankDependencies(failedStore, {
    failureInjector: (point) => { if (point === "after-check-updates") throw new Error("fallo inyectado"); }
  }));
  const before = failedStore.value();
  assert.strictEqual((await invoke(failed.handleBankReconciliationDepositChecks, body)).status, 400);
  assert.deepStrictEqual(failedStore.value(), before);

  const store = memoryStore(baseTables());
  const service = createBankReconciliationService(bankDependencies(store));
  await invoke(service.handleBankReconciliationDepositChecks, body);
  assert.strictEqual((await invoke(service.handleBankReconciliationDepositChecks, body)).payload.idempotent, true);
  assert.strictEqual(store.value().tables.movimientos_bancarios.rows.length, 1);
  assert.strictEqual(store.value().tables.cheques_recibidos.rows[0].estado, "Depositado");
}

function testStartupTwiceWithoutFinancialWrites() {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "erp-treasury-startup-"));
  const cacheFile = path.join(temporaryDirectory, "cache.json");
  fs.writeFileSync(cacheFile, JSON.stringify(baseTables(), null, 2), "utf8");
  const dataStore = require("../backend/data-store");
  const originalLoadCache = dataStore.loadCache;
  const originalSaveBackendCache = dataStore.saveBackendCache;
  const originalCreateServer = http.createServer;
  let writes = 0;
  dataStore.loadCache = () => JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  dataStore.saveBackendCache = (cache) => {
    writes += 1;
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), "utf8");
  };
  http.createServer = () => ({ listen() {} });
  const serverPath = require.resolve("../server");
  try {
    delete require.cache[serverPath];
    require(serverPath);
    delete require.cache[serverPath];
    require(serverPath);
  } finally {
    delete require.cache[serverPath];
    dataStore.loadCache = originalLoadCache;
    dataStore.saveBackendCache = originalSaveBackendCache;
    http.createServer = originalCreateServer;
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  assert.strictEqual(writes, 0);
}

function testCashflowDebtAndDashboardConsumers() {
  const cashflowCache = baseTables();
  cashflowCache.tables.egresos.rows[0] = {
    id_egreso: 20,
    total: 75.25,
    fecha_factura: "2026-07-23",
    fecha_prevista_pago: "2026-07-23",
    tipo_factura: "Factura A"
  };
  cashflowCache.tables.detalle_pagos = {
    headers: [],
    rows: [{ id_detalle_pago: 1, id_pago: 1, id_egreso: 20, monto_cancelado: 25.1 }],
    rowCount: 1
  };
  const rowsById = (rows, key) => new Map((rows || []).map((row) => [backendId(row[key]), row]));
  const buildCashflow = createCashflowService({
    backendCreditorDisplayName: () => "",
    backendCurrentDateIso: () => "2026-07-23",
    backendExpenseSupplierName: () => "Proveedor",
    backendId,
    backendIsoDate: (value) => cleanBackendText(value).slice(0, 10),
    backendNormalizeText: (value) => cleanBackendText(value).toLowerCase(),
    backendNumber,
    backendObjectSum: (values) => values.reduce((sum, value) => sum + backendNumber(value), 0),
    backendRowsById: rowsById,
    loadCache: () => clone(cashflowCache)
  });
  assert.strictEqual(buildCashflow().cards.debts, 50.15);
  cashflowCache.tables.detalle_pagos.rows.push({
    id_detalle_pago: 2, id_pago: 1, id_egreso: 20, monto_cancelado: 50.15
  });
  assert.strictEqual(buildCashflow().cards.debts, 0);

  const dashboardSource = fs.readFileSync(path.join(__dirname, "..", "assets/js/modules/dashboard.js"), "utf8");
  const context = {
    normalizeCategory: (value) => cleanBackendText(value).toLowerCase(),
    moneyToCents: money.toCents,
    Math
  };
  vm.createContext(context);
  vm.runInContext(dashboardSource, context);
  assert.strictEqual(context.isDashboardPendingCheck({ status: "Pendiente", amount: 100.25 }), true);
  assert.strictEqual(context.isDashboardPendingCheck({ status: "Debitado", amount: 100.25 }), false);
}

async function testDurableIdempotencyAcrossRestarts() {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "erp-treasury-idempotency-"));
  try {
    await testDurableCollection(path.join(temporaryDirectory, "collection.json"));
    await testDurablePayment(path.join(temporaryDirectory, "payment.json"));
    await testDurableContribution(path.join(temporaryDirectory, "contribution.json"));
    await testDurableApply(path.join(temporaryDirectory, "apply.json"));
    await testDurableDeposit(path.join(temporaryDirectory, "deposit.json"));
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function testDurableCollection(filePath) {
  const body = {
    operationId: "durable-collection",
    collection: { fecha: "2026-07-23", metodo: "Transferencia", idCliente: 1, monto: 90.15 },
    details: [{ idVenta: 10, monto: 100.25 }],
    retentions: { ganancias: 5.05, iibb: 5.05 }
  };
  let store = diskStore(filePath, baseTables());
  let service = createCollectionEntryService({
    backendId, backendNextNumericId, backendNumber, ensureBackendTable,
    loadCache: store.loadCache, readJsonBody, saveBackendCache: store.saveBackendCache, sendJson
  });
  await invoke(service.handleCollectionFullEntry, body);
  const applied = store.value();
  service = null;
  store = diskStore(filePath);
  service = createCollectionEntryService({
    backendId, backendNextNumericId, backendNumber, ensureBackendTable,
    loadCache: store.loadCache, readJsonBody, saveBackendCache: store.saveBackendCache, sendJson
  });
  assert.strictEqual((await invoke(service.handleCollectionFullEntry, body)).payload.idempotent, true);
  assert.deepStrictEqual(store.value(), applied);
  const contradiction = clone(body);
  contradiction.collection.banco = "GAL";
  assert.strictEqual((await invoke(service.handleCollectionFullEntry, contradiction)).status, 409);
  const withSecondSale = store.value();
  withSecondSale.tables.ventas.rows.push({ id_venta: 11, total: 100.25 });
  withSecondSale.tables.ventas.rowCount = 2;
  store.replace(withSecondSale);
  const legitimateNew = clone(body);
  legitimateNew.operationId = "durable-collection-new";
  legitimateNew.details = [{ idVenta: 11, monto: 100.25 }];
  assert.strictEqual((await invoke(service.handleCollectionFullEntry, legitimateNew)).status, 200);
  const partial = clone(applied);
  partial.tables.cobros_detalle.rows = [];
  store.replace(partial);
  assert.strictEqual((await invoke(service.handleCollectionFullEntry, body)).status, 409);
}

async function testDurablePayment(filePath) {
  const body = {
    operationId: "durable-payment",
    payment: { fecha: "2026-07-23", metodo: "Transferencia", banco: "ICBC" },
    details: [{ idEgreso: 20, monto: 75.25 }]
  };
  let store = diskStore(filePath, baseTables());
  let service = createPaymentEntryService({
    backendId, backendNextNumericId, backendNumber, ensureBackendTable,
    loadCache: store.loadCache, readJsonBody, saveBackendCache: store.saveBackendCache, sendJson
  });
  await invoke(service.handlePaymentFullEntry, body);
  const applied = store.value();
  service = null;
  store = diskStore(filePath);
  service = createPaymentEntryService({
    backendId, backendNextNumericId, backendNumber, ensureBackendTable,
    loadCache: store.loadCache, readJsonBody, saveBackendCache: store.saveBackendCache, sendJson
  });
  assert.strictEqual((await invoke(service.handlePaymentFullEntry, body)).payload.idempotent, true);
  assert.deepStrictEqual(store.value(), applied);
  const contradiction = clone(body);
  contradiction.payment.banco = "GAL";
  assert.strictEqual((await invoke(service.handlePaymentFullEntry, contradiction)).status, 409);
  const newCache = baseTables();
  newCache.tables.egresos.rows.push({ id_egreso: 21, total: 75.25 });
  store.replace(newCache);
  const legitimateNew = clone(body);
  legitimateNew.operationId = "durable-payment-new";
  legitimateNew.details = [{ idEgreso: 21, monto: 75.25 }];
  assert.strictEqual((await invoke(service.handlePaymentFullEntry, legitimateNew)).status, 200);
  const partial = clone(applied);
  partial.tables.detalle_pagos.rows = [];
  store.replace(partial);
  assert.strictEqual((await invoke(service.handlePaymentFullEntry, body)).status, 409);
}

async function testDurableContribution(filePath) {
  const body = {
    operationId: "durable-contribution",
    contribution: { fecha: "2026-07-23", nombre: "Socio", tipo: "Aporte", monto: 10.25 }
  };
  let store = diskStore(filePath, baseTables());
  let service = createPartnerContributionsService({
    backendId, backendNextNumericId, backendNumber, ensureBackendTable, normalizePartnerName,
    loadCache: store.loadCache, readJsonBody, saveBackendCache: store.saveBackendCache, sendJson
  });
  await invoke(service.handlePartnerContributionFullEntry, body);
  const applied = store.value();
  service = null;
  store = diskStore(filePath);
  service = createPartnerContributionsService({
    backendId, backendNextNumericId, backendNumber, ensureBackendTable, normalizePartnerName,
    loadCache: store.loadCache, readJsonBody, saveBackendCache: store.saveBackendCache, sendJson
  });
  assert.strictEqual((await invoke(service.handlePartnerContributionFullEntry, body)).payload.idempotent, true);
  assert.deepStrictEqual(store.value(), applied);
  const contradiction = clone(body);
  contradiction.contribution.monto = 11.25;
  assert.strictEqual((await invoke(service.handlePartnerContributionFullEntry, contradiction)).status, 409);
  const legitimateNew = clone(body);
  legitimateNew.operationId = "durable-contribution-new";
  assert.strictEqual((await invoke(service.handlePartnerContributionFullEntry, legitimateNew)).status, 200);
  const partial = clone(applied);
  partial.tables.egresos.rows = partial.tables.egresos.rows.filter((row) => row._operationId !== body.operationId);
  store.replace(partial);
  assert.strictEqual((await invoke(service.handlePartnerContributionFullEntry, body)).status, 409);
}

async function testDurableApply(filePath) {
  let store = diskStore(filePath, baseTables());
  let service = createBankReconciliationService(bankDependencies(store));
  const beforeAnalyze = store.value();
  await invoke(service.handleBankReconciliationAnalyze, { bank: "ICBC", csvText: "analyze-a" });
  service = null;
  store = diskStore(filePath);
  service = createBankReconciliationService(bankDependencies(store));
  await invoke(service.handleBankReconciliationAnalyze, { bank: "ICBC", csvText: "analyze-a" });
  assert.deepStrictEqual(store.value(), beforeAnalyze);
  const body = { bank: "ICBC", csvText: "apply-a", applyMode: "reconcile" };
  await invoke(service.handleBankReconciliationApply, body);
  const applied = store.value();
  service = null;
  store = diskStore(filePath);
  service = createBankReconciliationService(bankDependencies(store));
  await invoke(service.handleBankReconciliationApply, body);
  assert.deepStrictEqual(store.value().tables.movimientos_bancarios.rows, applied.tables.movimientos_bancarios.rows);
  const key = "ICBC|2026-07-23|100.25|apply-a:1";
  const contradiction = { ...body, reviewRows: { [key]: { banco: "GAL" } } };
  assert.strictEqual((await invoke(service.handleBankReconciliationApply, contradiction)).status, 409);
  const legitimateNew = { ...body, csvText: "apply-b" };
  assert.strictEqual((await invoke(service.handleBankReconciliationApply, legitimateNew)).status, 200);
  assert.strictEqual(store.value().tables.movimientos_bancarios.rows.length, 2);
  const partial = clone(applied);
  const appliedOperation = partial.tables.movimientos_bancarios.rows[0];
  partial.tables.movimientos_bancarios.rows = [];
  partial.tables.movimientos_bancarios.rowCount = 0;
  partial.tables.egresos = {
    rows: [{
      _bankOperationKey: appliedOperation._bankOperationKey,
      _bankOperationPayload: appliedOperation._bankOperationPayload
    }],
    rowCount: 1,
    headers: []
  };
  store.replace(partial);
  assert.strictEqual((await invoke(service.handleBankReconciliationApply, body)).status, 409);
}

async function testDurableDeposit(filePath) {
  const seed = baseTables();
  seed.tables.cheques_recibidos.rows.push({
    id_cheque_recibido: 31, id_cobro: 2, monto: 100.25, estado: "Pendiente"
  });
  seed.tables.cheques_recibidos.rowCount = 2;
  let store = diskStore(filePath, seed);
  let service = createBankReconciliationService(bankDependencies(store));
  const body = {
    bank: "ICBC", depositDate: "2026-07-23", checkIds: [30],
    movement: { date: "2026-07-23", amount: 100.25, credit: 100.25 }
  };
  await invoke(service.handleBankReconciliationDepositChecks, body);
  const applied = store.value();
  service = null;
  store = diskStore(filePath);
  service = createBankReconciliationService(bankDependencies(store));
  assert.strictEqual((await invoke(service.handleBankReconciliationDepositChecks, body)).payload.idempotent, true);
  assert.deepStrictEqual(store.value(), applied);
  const contradiction = clone(body);
  contradiction.movement.concept = "contenido distinto";
  assert.strictEqual((await invoke(service.handleBankReconciliationDepositChecks, contradiction)).status, 409);
  const legitimateNew = clone(body);
  legitimateNew.checkIds = [31];
  legitimateNew.movement.detail = "segundo depósito legítimo";
  assert.strictEqual((await invoke(service.handleBankReconciliationDepositChecks, legitimateNew)).status, 200);
  assert.strictEqual(store.value().tables.movimientos_bancarios.rows.length, 2);
  const partial = clone(applied);
  partial.tables.movimientos_bancarios.rows = [];
  partial.tables.movimientos_bancarios.rowCount = 0;
  store.replace(partial);
  assert.strictEqual((await invoke(service.handleBankReconciliationDepositChecks, body)).status, 409);
}

async function main() {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.doesNotMatch(serverSource, /ensurePaymentPlansHistory\s*\(/);
  assert.doesNotMatch(serverSource, /ensurePartnerContributionsHistory\s*\(/);
  assert.doesNotMatch(serverSource, /ensureBankDetailsSchema\s*\(/);
  testStartupTwiceWithoutFinancialWrites();
  testCashflowDebtAndDashboardConsumers();
  await testDurableIdempotencyAcrossRestarts();
  await testCollectionAtomicityAndIdempotency();
  await testPaymentAtomicityAndIdempotency();
  await testContributionAtomicityAndSigns();
  await testAnalyzeAndApply();
  await testDepositRollbackAndRetry();
  console.log("Treasury safety tests: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
