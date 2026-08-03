const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const vm = require("vm");
const os = require("os");
const crypto = require("crypto");
const money = require("../shared/money");
const { createCollectionEntryService } = require("../backend/services/collection-entry.service");
const { createPaymentEntryService } = require("../backend/services/payment-entry.service");
const { createPartnerContributionsService } = require("../backend/services/partner-contributions.service");
const { createBankReconciliationService } = require("../backend/services/bank-reconciliation.service");
const { createBankMatchingService } = require("../backend/services/bank-matching.service");
const { createBankParserService } = require("../backend/services/bank-parser.service");
const { createBankPersistenceService } = require("../backend/services/bank-persistence.service");
const { createBankReferenceService } = require("../backend/services/bank-reference.service");
const { createCashflowService } = require("../backend/services/cashflow.service");
const { migrateCashLedger } = require("../backend/migrations/20260803-cash-ledger");
const { createIncomeCalculationService } = require("../backend/services/income-calculation.service");
const { backendGroupRowsById, backendRowsById } = require("../backend/utils/ids");
const {
  backendBankMatches,
  compactBankText,
  extractBankCheckNumber,
  extractBankCuit,
  normalizeBankCheckNumber,
  normalizeBankCuit
} = require("../backend/utils/bank");
const { ensureBackendTable, backendNextNumericId, normalizeLookupText, normalizePartnerName } = require("../backend/utils/runtime");

const backendId = (value) => String(value ?? "").trim();
const backendNumber = (value) => Number(value) || 0;
const cleanBackendText = (value) => String(value ?? "").trim();
const clone = (value) => JSON.parse(JSON.stringify(value));
const pendingBankRows = (cache) => (cache.tables?.movimientos_bancarios?.rows || []).filter(
  (row) => !backendId(row.id_pago) && !backendId(row.id_cobro)
);
const backendIsoDate = (value) => {
  const text = cleanBackendText(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  return match
    ? `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`
    : "";
};

async function invoke(handler, body) {
  return invokeRequest(handler, { body });
}

async function invokeRequest(handler, request = {}) {
  let result;
  await handler(
    request,
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
  return migrateCashLedger({
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
  }, { registeredAt: "2026-08-03T12:00:00.000Z" }).cache;
}

function bankTestTables() {
  const cache = baseTables();
  cache.tables.cobros = { headers: ["id_cobro"], rows: [{ id_cobro: 1 }], rowCount: 1 };
  cache.tables.pagos = { headers: ["id_pago"], rows: [{ id_pago: 2 }], rowCount: 1 };
  return cache;
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
  const backendNormalizeText = (value) => cleanBackendText(value).toLowerCase();
  const persistence = createBankPersistenceService({
    backendBankMatches: (value, bank) => backendBankMatches(value, bank, backendNormalizeText),
    backendId,
    backendIsoDate,
    backendNextNumericId,
    backendNormalizeText,
    backendNumber,
    backendTagIdForName: () => "",
    cleanBackendText,
    compactBankText,
    crypto,
    ensureBackendTable,
    loadCache: store.loadCache,
    normalizeBankCheckNumber,
    normalizeBankCuit,
    saveBackendCache: store.saveBackendCache
  });
  return {
    analyzeBankMovement: (movement) => ({
      ...movement,
      status: "listo",
      match: money.toCents(movement.amount) < 0
        ? { type: "pago", id: 2 }
        : { type: "cobro", id: 1 }
    }),
    backendBankCollectionCandidates: empty,
    backendBankCreditPayableCandidates: empty,
    backendBankIdentityIndex: () => new Map(),
    backendBankPayableCandidates: empty,
    backendBankPaymentCandidates: empty,
    backendBankSourceCandidates: empty,
    backendId,
    backendIssuedChecksByNumber: () => new Map(),
    backendNormalizeText,
    backendNumber,
    backendReceivedCheckDepositGroups: empty,
    backendReceivedChecksByNumber: () => new Map(),
    bankMovementAssociation: persistence.bankMovementAssociation,
    bankMovementFingerprint: persistence.bankMovementFingerprint,
    canonicalPendingBankMovements: persistence.canonicalPendingBankMovements,
    cleanBackendText,
    createBankEgressForSource: () => null,
    createBankPaymentForExpense: () => null,
    _createBankPaymentForExpense: persistence.createBankPaymentForExpense,
    createBankSourceExpense: () => null,
    ensureBackendTable,
    importBankMovements: persistence.importBankMovements,
    loadCache: store.loadCache,
    normalizeBackendBankDetails: (cache) => { cache.tables.datos_bancarios.headers = ["id_dato_bancario"]; },
    parseBankMovements: (csvText) => [{
      date: "2026-07-23", amount: 100.25, credit: 100.25, debit: 0, balance: 100.25, detail: csvText
    }],
    persistBankMovement: persistence.persistBankMovement,
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

function bankParserFixture() {
  const calculations = createIncomeCalculationService({
    backendGroupRowsById,
    backendId,
    backendInventoryQuantity: () => 0,
    backendRowsById
  });
  const parser = createBankParserService({
    backendIsoDate: calculations.backendIsoDate,
    backendNormalizeText: calculations.backendNormalizeText,
    backendNumber: calculations.backendNumber,
    compactBankText,
    extractBankCheckNumber,
    extractBankCuit,
    normalizeBankCheckNumber,
    normalizeBankCuit
  });
  return {
    backendNormalizeText: calculations.backendNormalizeText,
    parseBankMovements: parser.parseBankMovements
  };
}

function testBankReferenceNormalizerInjection() {
  const { backendNormalizeText } = bankParserFixture();
  const cache = {
    tables: {
      acreedores: { headers: ["id_acreedor"], rows: [], rowCount: 0 },
      datos_bancarios: { headers: ["id_dato_bancario"], rows: [], rowCount: 0 },
      etiquetas: { headers: ["id_etiqueta"], rows: [], rowCount: 0 }
    }
  };
  const { seedDefaultBankDetails } = createBankReferenceService({
    DEFAULT_BANK_DETAIL_RULES: [{
      detail: "COMISI\u00d3N BANCARIA",
      creditor: "ICBC",
      expenseType: "Gastos bancarios"
    }],
    EXPECTED_BACKEND_COLUMNS: {
      acreedores: ["id_acreedor"],
      datos_bancarios: ["id_dato_bancario", "detalle", "id_acreedor", "id_etiqueta", "tipo_factura"],
      etiquetas: ["id_etiqueta", "etiqueta", "categoria_pnl"]
    },
    backendCreditorDisplayName: (creditor) => creditor.acuerdo_de_pago || "",
    backendId,
    backendNextNumericId,
    backendNormalizeText,
    cleanBackendText,
    ensureBackendTable,
    normalizeLookupText
  });

  assert.strictEqual(seedDefaultBankDetails(cache), 1);
  assert.strictEqual(seedDefaultBankDetails(cache), 0);
  assert.strictEqual(cache.tables.datos_bancarios.rows.length, 1);
  assert.strictEqual(cache.tables.datos_bancarios.rows[0].detalle, "COMISI\u00d3N BANCARIA");
}

function testBankPaymentRejectsCashMethod() {
  const store = memoryStore(bankTestTables());
  const dependencies = bankDependencies(store);
  const cache = store.value();
  cache.tables.detalle_pagos = { headers: [], rows: [], rowCount: 0 };
  const before = JSON.stringify(cache);
  assert.throws(() => dependencies._createBankPaymentForExpense(
    cache.tables,
    { date: "2026-08-03", detail: "Débito bancario" },
    "ICBC",
    20,
    10,
    { metodo: "Efectivo" },
    "bank-payment-cash",
    "payload"
  ), /no puede crear un pago en Efectivo/i);
  assert.equal(JSON.stringify(cache), before);
}

async function testIcBcAnalyzeFixtures() {
  const store = memoryStore(bankTestTables());
  const { backendNormalizeText, parseBankMovements } = bankParserFixture();
  const realFormatCsv = [
    "Movimientos de CC $ 0920/02105179/95,,,",
    "Fecha contable;Cod de Concepto;Concepto;Debito en $;Credito en $;Saldo en $;Informacion Complementaria;Nro de cheque;Sucursal Origen;Canal;Banco;CBU/Alias;Tipo trf;Referencia;Nombre;Tipo doc;Nro doc,,,",
    "20/07/2026;260;IMP S/CRED CT;-100766,46;;14216090,79;2;;0920;PROCESO BATCH,",
    "17/07/2026;232;DEPOS. ECHEQ. NRO. : 40610385;;836647,00;6990798,34;0000000281;040610385;0920;BUSSINESS SERVER,"
  ].join("\n");
  const validCsv = [
    "Fecha;Concepto;Informacion complementaria;Debito;Credito;Saldo;Nro de cheque;CUIT;Nombre",
    "20/07/2026;TRANSFERENCIA;  CAF\u00c9 DEL SUR  ;1.234,56;;98.765,44;00001234;30-12345678-9;  \u00c1RBOL S.A.  ",
    "21/07/2026;ACREDITACI\u00d3N;;;2.500,00;101.265,44;;;;"
  ].join("\n");
  const emptyCsv = "Fecha;Concepto;Debito;Credito;Saldo";
  const partiallyInvalidCsv = [
    "Fecha;Concepto;Debito;Credito;Saldo",
    "22/07/2026;MOVIMIENTO VALIDO;;1.000,00;102.265,44",
    "31/02/2026;FECHA IMPOSIBLE;;500,00;102.765,44"
  ].join("\n");
  const dependencies = bankDependencies(store, {
    analyzeBankMovement: (movement) => ({ ...movement, status: "revisar" }),
    backendBankPaymentCandidates: (_tables, bank) => {
      assert.strictEqual(backendBankMatches(" \u00cdCBC ", bank, backendNormalizeText), true);
      assert.strictEqual(backendBankMatches("", bank, backendNormalizeText), true);
      return [];
    },
    parseBankMovements
  });
  const service = createBankReconciliationService(dependencies);
  const realFormatMovements = parseBankMovements(realFormatCsv);
  assert.strictEqual(realFormatMovements.length, 2);
  assert.strictEqual(realFormatMovements[0].amount, -100766.46);
  assert.strictEqual(realFormatMovements[0].balance, 14216090.79);
  assert.strictEqual(realFormatMovements[1].amount, 836647);
  assert.strictEqual(realFormatMovements[1].checkNumber, "40610385");

  const first = await invoke(service.handleBankReconciliationAnalyze, { bank: "ICBC", csvText: validCsv });
  const second = await invoke(service.handleBankReconciliationAnalyze, { bank: "ICBC", csvText: validCsv });
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.payload.report.merge.newCount, 2);
  assert.strictEqual(second.payload.report.merge.newCount, 0);
  assert.strictEqual(second.payload.report.merge.duplicateCount, 2);
  assert.strictEqual(first.payload.report.rowsRead, 2);
  assert.strictEqual(first.payload.report.movements.length, 2);
  assert.strictEqual(first.payload.report.movements[0].date, "2026-07-20");
  assert.strictEqual(first.payload.report.movements[0].amount, -1234.56);
  assert.strictEqual(first.payload.report.movements[0].debit, 1234.56);
  assert.strictEqual(first.payload.report.movements[0].credit, 0);
  assert.strictEqual(first.payload.report.movements[0].balance, 98765.44);
  assert.strictEqual(first.payload.report.movements[0].cuit, "30123456789");
  assert.strictEqual(first.payload.report.movements[0].checkNumber, "1234");
  assert.strictEqual(first.payload.report.movements[0].counterpartyName, "\u00c1RBOL S.A.");
  assert.strictEqual(first.payload.report.movements[1].amount, 2500);
  assert.strictEqual(first.payload.report.movements[1].balance, 101265.44);
  assert.strictEqual(first.payload.report.summary.pendingDebits, 1234.56);
  assert.strictEqual(first.payload.report.summary.pendingCredits, 2500);
  assert.strictEqual(first.payload.report.summary.netPending, 1265.44);

  const afterValidImport = store.value();
  const empty = await invoke(service.handleBankReconciliationAnalyze, { bank: "ICBC", csvText: emptyCsv });
  assert.strictEqual(empty.status, 400);
  assert.match(empty.payload.error, /no contiene movimientos bancarios validos/i);
  assert.deepStrictEqual(store.value(), afterValidImport);
  assert.strictEqual(pendingBankRows(store.value()).length, 2);

  const partiallyInvalid = await invoke(service.handleBankReconciliationAnalyze, {
    bank: "ICBC",
    csvText: partiallyInvalidCsv
  });
  assert.strictEqual(partiallyInvalid.status, 400);
  assert.match(partiallyInvalid.payload.error, /fila 3.*fecha bancaria invalida/i);
  assert.deepStrictEqual(store.value(), afterValidImport);
  assert.strictEqual(pendingBankRows(store.value()).length, 2);

  const loggedErrors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => loggedErrors.push(args);
  try {
    const malformed = await invoke(service.handleBankReconciliationAnalyze, {
      bank: "ICBC",
      csvText: "archivo;sin;encabezados\n1;2;3"
    });
    assert.strictEqual(malformed.status, 400);
    assert.match(malformed.payload.error, /encabezados bancarios reconocibles/i);

    const unexpectedService = createBankReconciliationService(bankDependencies(store, {
      parseBankMovements: () => {
        throw new ReferenceError("detalleInterno is not defined");
      }
    }));
    const unexpected = await invoke(unexpectedService.handleBankReconciliationAnalyze, {
      bank: "ICBC",
      csvText: validCsv
    });
    assert.strictEqual(unexpected.status, 500);
    assert.doesNotMatch(unexpected.payload.error, /detalleInterno|ReferenceError/i);
  } finally {
    console.error = originalConsoleError;
  }
  assert.ok(loggedErrors.some((args) => String(args[1]?.message || "").includes("detalleInterno")));
}

async function testPersistentPendingBankMovements() {
  const store = memoryStore(bankTestTables());
  const fixtureMovements = {
    first: [
      { date: "2026-07-23", amount: 100, credit: 100, debit: 0, balance: 100, detail: "A", cuit: "" },
      { date: "2026-07-24", amount: -50, credit: 0, debit: 50, balance: 50, detail: "B", checkNumber: "" }
    ],
    overlap: [
      { date: "2026-07-24", amount: -50, credit: 0, debit: 50, balance: 50, detail: "B", checkNumber: "" },
      { date: "2026-07-25", amount: 25, credit: 25, debit: 0, balance: 75, detail: "C", cbuAlias: "" }
    ],
    twins: [
      { date: "2026-07-26", amount: 10, credit: 10, debit: 0, balance: 85, detail: "Operacion repetida" },
      { date: "2026-07-26", amount: 10, credit: 10, debit: 0, balance: 85, detail: "Operacion repetida" }
    ]
  };
  const dependencies = bankDependencies(store, {
    now: () => new Date("2026-07-27T15:00:00.000Z"),
    parseBankMovements: (csvText) => clone(fixtureMovements[csvText] || [])
  });
  let service = createBankReconciliationService(dependencies);

  const first = await invoke(service.handleBankReconciliationAnalyze, { bank: "ICBC", csvText: "first" });
  assert.strictEqual(first.status, 200);
  assert.deepStrictEqual(first.payload.report.merge, { newCount: 2, duplicateCount: 0, totalPending: 2 });
  const repeated = await invoke(service.handleBankReconciliationAnalyze, { bank: "ICBC", csvText: "first" });
  assert.deepStrictEqual(repeated.payload.report.merge, { newCount: 0, duplicateCount: 2, totalPending: 2 });
  assert.strictEqual(pendingBankRows(store.value()).length, 2);

  service = createBankReconciliationService(dependencies);
  const restored = await invokeRequest(service.handleBankReconciliationState, {
    url: "/api/bank-reconciliation/state?bank=ICBC"
  });
  assert.strictEqual(restored.payload.report.movements.length, 2);

  const overlapped = await invoke(service.handleBankReconciliationAnalyze, { bank: "ICBC", csvText: "overlap" });
  assert.deepStrictEqual(overlapped.payload.report.merge, { newCount: 1, duplicateCount: 1, totalPending: 3 });
  const twins = await invoke(service.handleBankReconciliationAnalyze, { bank: "ICBC", csvText: "twins" });
  assert.strictEqual(twins.payload.report.merge.newCount, 2);
  assert.strictEqual(twins.payload.report.movements.filter((movement) => movement.detail === "Operacion repetida").length, 2);
  await invoke(service.handleBankReconciliationAnalyze, { bank: "ICBC", csvText: "twins" });
  assert.strictEqual(pendingBankRows(store.value()).length, 5);

  const movementC = twins.payload.report.movements.find((movement) => movement.detail === "C");
  const partialResult = await invoke(service.handleBankReconciliationApply, {
    bank: "ICBC",
    applyMode: "reconcile",
    movementKeys: [movementC.movementKey]
  });
  assert.strictEqual(partialResult.status, 200);
  assert.strictEqual(partialResult.payload.result.movementsReconciled, 1);
  assert.strictEqual(pendingBankRows(store.value()).length, 4);
  assert.strictEqual(partialResult.payload.result.reconciliation.latestDate, "2026-07-26");
  assert.strictEqual(partialResult.payload.result.reconciliation.daysElapsed, 1);

  const afterPartial = await invokeRequest(service.handleBankReconciliationState, {
    url: "/api/bank-reconciliation/state?bank=ICBC"
  });
  const movementA = afterPartial.payload.report.movements.find((movement) => movement.detail === "A");
  await invoke(service.handleBankReconciliationApply, {
    bank: "ICBC",
    applyMode: "reconcile",
    movementKeys: [movementA.movementKey]
  });
  const summaryAfterOlder = await invokeRequest(service.handleBankReconciliationSummary);
  assert.strictEqual(summaryAfterOlder.payload.summary.latestDate, "2026-07-26");
  assert.strictEqual(summaryAfterOlder.payload.summary.daysElapsed, 1);

  const beforeFailure = store.value();
  service = createBankReconciliationService(bankDependencies(store, {
    now: () => new Date("2026-07-27T15:00:00.000Z"),
    parseBankMovements: (csvText) => clone(fixtureMovements[csvText] || []),
    failureInjector: (point) => {
      if (point === "before-bank-reconciliation-save") throw new Error("fallo atomico simulado");
    }
  }));
  const pendingBeforeFailure = await invokeRequest(service.handleBankReconciliationState, {
    url: "/api/bank-reconciliation/state?bank=ICBC"
  });
  const failedKey = pendingBeforeFailure.payload.report.movements[0].movementKey;
  const failed = await invoke(service.handleBankReconciliationApply, {
    bank: "ICBC",
    applyMode: "reconcile",
    movementKeys: [failedKey]
  });
  assert.strictEqual(failed.status, 400);
  assert.deepStrictEqual(store.value(), beforeFailure);

  service = createBankReconciliationService(dependencies);
  const remaining = await invokeRequest(service.handleBankReconciliationState, {
    url: "/api/bank-reconciliation/state?bank=ICBC"
  });
  const total = await invoke(service.handleBankReconciliationApply, {
    bank: "ICBC",
    applyMode: "reconcile",
    movementKeys: remaining.payload.report.movements.map((movement) => movement.movementKey)
  });
  assert.strictEqual(total.status, 200);
  assert.strictEqual(pendingBankRows(store.value()).length, 0);
  const fullyReconciled = store.value();
  await invoke(service.handleBankReconciliationApply, {
    bank: "ICBC",
    applyMode: "reconcile",
    movementKeys: remaining.payload.report.movements.map((movement) => movement.movementKey)
  });
  assert.deepStrictEqual(store.value(), fullyReconciled);

  const emptyStore = memoryStore(bankTestTables());
  const emptyService = createBankReconciliationService(bankDependencies(emptyStore, {
    now: () => new Date("2026-07-27T15:00:00.000Z")
  }));
  const emptySummary = await invokeRequest(emptyService.handleBankReconciliationSummary);
  assert.strictEqual(emptySummary.payload.summary.latestDate, "");
  assert.strictEqual(emptySummary.payload.summary.daysElapsed, null);

  const invalidDateSeed = bankTestTables();
  invalidDateSeed.tables.movimientos_bancarios = {
    headers: ["id_movimiento_bancario", "banco", "fecha"],
    rows: [{ id_movimiento_bancario: 1, banco: "ICBC", fecha: "fecha-invalida" }],
    rowCount: 1
  };
  const invalidDateService = createBankReconciliationService(bankDependencies(memoryStore(invalidDateSeed)));
  const invalidDateSummary = await invokeRequest(invalidDateService.handleBankReconciliationSummary);
  assert.strictEqual(invalidDateSummary.payload.summary.latestDate, "");
  assert.strictEqual(invalidDateSummary.payload.summary.daysElapsed, null);

  const localDaySeed = bankTestTables();
  localDaySeed.tables.movimientos_bancarios = {
    headers: ["id_movimiento_bancario", "banco", "fecha", "id_pago", "id_cobro"],
    rows: [{ id_movimiento_bancario: 1, banco: "ICBC", fecha: "2026-07-26", id_pago: "", id_cobro: "" }],
    rowCount: 1
  };
  const localDayService = createBankReconciliationService(bankDependencies(memoryStore(localDaySeed), {
    now: () => new Date("2026-07-27T01:30:00.000Z")
  }));
  const localDaySummary = await invokeRequest(localDayService.handleBankReconciliationSummary);
  assert.strictEqual(localDaySummary.payload.summary.latestDate, "2026-07-26");
  assert.strictEqual(localDaySummary.payload.summary.daysElapsed, 0);

  const futureSeed = bankTestTables();
  futureSeed.tables.movimientos_bancarios = {
    headers: ["id_movimiento_bancario", "banco", "fecha"],
    rows: [{ id_movimiento_bancario: 1, banco: "GAL", fecha: "2099-01-01", id_cobro: 1 }],
    rowCount: 1
  };
  const futureStore = memoryStore(futureSeed);
  const futureService = createBankReconciliationService(bankDependencies(futureStore, {
    now: () => new Date("2026-07-27T15:00:00.000Z")
  }));
  const futureSummary = await invokeRequest(futureService.handleBankReconciliationSummary);
  assert.strictEqual(futureSummary.payload.summary.daysElapsed, 0);
  assert.strictEqual(futureSummary.payload.summary.details[0].bank, "GAL");

  const failedImportStore = memoryStore(bankTestTables());
  const failedImportBefore = failedImportStore.value();
  const failedImportService = createBankReconciliationService(bankDependencies(failedImportStore, {
    parseBankMovements: () => clone(fixtureMovements.first),
    failureInjector: (point) => {
      if (point === "before-bank-reconciliation-save") throw new Error("fallo atomico de importacion");
    }
  }));
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const failedImport = await invoke(failedImportService.handleBankReconciliationAnalyze, {
      bank: "ICBC",
      csvText: "first"
    });
    assert.strictEqual(failedImport.status, 500);
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepStrictEqual(failedImportStore.value(), failedImportBefore);

  const controlledErrorService = createBankReconciliationService(bankDependencies(emptyStore, {
    loadCache: () => { throw new Error("fallo controlado de resumen"); }
  }));
  const controlledError = await invokeRequest(controlledErrorService.handleBankReconciliationSummary);
  assert.strictEqual(controlledError.status, 400);
  assert.strictEqual(controlledError.payload.ok, false);
  assert.match(controlledError.payload.error, /fallo controlado de resumen/i);
}

async function testAnalyzeAndApply() {
  const store = memoryStore(bankTestTables());
  const service = createBankReconciliationService(bankDependencies(store));
  const first = await invoke(service.handleBankReconciliationAnalyze, { bank: "ICBC", csvText: "csv" });
  assert.strictEqual(first.status, 200);
  assert.strictEqual((await invoke(service.handleBankReconciliationAnalyze, { bank: "ICBC", csvText: "csv" })).status, 200);
  assert.strictEqual(pendingBankRows(store.value()).length, 1);

  const applyBody = {
    bank: "ICBC",
    applyMode: "reconcile",
    movementKeys: [first.payload.report.movements[0].movementKey]
  };
  await invoke(service.handleBankReconciliationApply, applyBody);
  await invoke(service.handleBankReconciliationApply, applyBody);
  assert.strictEqual(store.value().tables.movimientos_bancarios.rows.length, 1);
  assert.strictEqual(pendingBankRows(store.value()).length, 0);
}

async function testIdenticalReconciledOccurrenceDoesNotReappear() {
  const store = memoryStore(bankTestTables());
  const identicalMovements = [
    { date: "2026-07-26", amount: 10, credit: 10, debit: 0, balance: 10, detail: "Operacion identica" },
    { date: "2026-07-26", amount: 10, credit: 10, debit: 0, balance: 10, detail: "Operacion identica" }
  ];
  const dependencies = bankDependencies(store, {
    parseBankMovements: () => clone(identicalMovements)
  });
  let service = createBankReconciliationService(dependencies);
  const analyzed = await invoke(service.handleBankReconciliationAnalyze, { bank: "ICBC", csvText: "twins" });
  const secondOccurrence = analyzed.payload.report.movements.find((movement) => movement.movementKey.endsWith(":2"));
  assert.ok(secondOccurrence);

  const partial = await invoke(service.handleBankReconciliationApply, {
    bank: "ICBC",
    applyMode: "reconcile",
    movementKeys: [secondOccurrence.movementKey]
  });
  assert.strictEqual(partial.status, 200);
  assert.strictEqual(pendingBankRows(store.value()).length, 1);

  service = createBankReconciliationService(dependencies);
  const reanalyzed = await invoke(service.handleBankReconciliationAnalyze, { bank: "ICBC", csvText: "twins" });
  assert.deepStrictEqual(reanalyzed.payload.report.merge, { newCount: 0, duplicateCount: 2, totalPending: 1 });
  assert.strictEqual(reanalyzed.payload.report.movements.length, 1);
  assert.ok(reanalyzed.payload.report.movements[0].movementKey.endsWith(":1"));
  assert.strictEqual(store.value().tables.movimientos_bancarios.rows.length, 2);
  assert.ok(store.value().tables.movimientos_bancarios.rows[1]._bankMovementKey.endsWith(":2"));
}

async function testAdditionalIdenticalOccurrenceUsesMultisetCounts() {
  const store = memoryStore(bankTestTables());
  const movement = {
    date: "2026-07-26",
    amount: 10,
    credit: 10,
    debit: 0,
    balance: 10,
    detail: "Operacion identica adicional"
  };
  const service = createBankReconciliationService(bankDependencies(store, {
    parseBankMovements: (csvText) => Array.from(
      { length: csvText === "triplets" ? 3 : 2 },
      () => clone(movement)
    )
  }));

  const twins = await invoke(service.handleBankReconciliationAnalyze, {
    bank: "ICBC",
    csvText: "twins"
  });
  const repeated = await invoke(service.handleBankReconciliationAnalyze, {
    bank: "ICBC",
    csvText: "twins"
  });
  const triplets = await invoke(service.handleBankReconciliationAnalyze, {
    bank: "ICBC",
    csvText: "triplets"
  });

  assert.deepStrictEqual(twins.payload.report.merge, {
    newCount: 2,
    duplicateCount: 0,
    totalPending: 2
  });
  assert.deepStrictEqual(repeated.payload.report.merge, {
    newCount: 0,
    duplicateCount: 2,
    totalPending: 2
  });
  assert.deepStrictEqual(triplets.payload.report.merge, {
    newCount: 1,
    duplicateCount: 2,
    totalPending: 3
  });
  assert.strictEqual(store.value().tables.movimientos_bancarios.rows.length, 3);
}

async function testBankReconciliationActionSequenceRefreshesCanonicalState() {
  const seed = bankTestTables();
  Object.assign(seed.tables, {
    acreedores: {
      headers: ["id_acreedor", "acuerdo_de_pago"],
      rows: [
        { id_acreedor: 10, acuerdo_de_pago: "Proveedor secuencia" },
        { id_acreedor: 20, acuerdo_de_pago: "Acreedor corregido" }
      ],
      rowCount: 2
    },
    acreedores_etiquetas: {
      headers: ["id_acreedor_etiqueta", "id_acreedor", "id_etiqueta"],
      rows: [
        { id_acreedor_etiqueta: 100, id_acreedor: 10, id_etiqueta: 5 },
        { id_acreedor_etiqueta: 200, id_acreedor: 20, id_etiqueta: 6 }
      ],
      rowCount: 2
    },
    etiquetas: {
      headers: ["id_etiqueta", "etiqueta"],
      rows: [
        { id_etiqueta: 5, etiqueta: "Administrativos" },
        { id_etiqueta: 6, etiqueta: "Servicios" }
      ],
      rowCount: 2
    },
    otros_gastos: { headers: [], rows: [], rowCount: 0 },
    detalle_pagos: { headers: [], rows: [], rowCount: 0 }
  });
  const store = memoryStore(seed);
  const movements = [
    { date: "2026-07-28", amount: -120.5, debit: 120.5, credit: 0, balance: 879.5, detail: "Gasto secuencia A", rowNumber: 1 },
    { date: "2026-07-28", amount: -80.25, debit: 80.25, credit: 0, balance: 799.25, detail: "Gasto secuencia B", rowNumber: 2 }
  ];
  const sourceCandidates = (tables) => (tables.otros_gastos?.rows || [])
    .filter((row) => !backendId(row.id_egreso))
    .map((row) => ({
      type: "gasto_origen",
      table: "otros_gastos",
      label: "Otro gasto",
      idColumn: "id_otros_gastos",
      id: backendId(row.id_otros_gastos),
      date: backendIsoDate(row.fecha_otros_gastos),
      amount: row._total,
      idAcreedor: backendId(row.id_acreedor),
      idEtiqueta: "5",
      party: "Proveedor secuencia",
      description: row.detalle
    }));
  const payableCandidates = (tables) => (tables.egresos?.rows || [])
    .filter((row) => ["100", "200"].includes(backendId(row.id_acreedor_etiqueta)))
    .filter((row) => !(tables.detalle_pagos?.rows || []).some(
      (detail) => backendId(detail.id_egreso) === backendId(row.id_egreso)
    ))
    .map((row) => ({ type: "egreso", id: backendId(row.id_egreso), amount: row.total }));
  const paymentCandidates = (tables) => (tables.pagos?.rows || []).flatMap((payment) => (
    (tables.detalle_pagos?.rows || [])
      .filter((detail) => backendId(detail.id_pago) === backendId(payment.id_pago))
      .map((detail) => ({
        type: "pago",
        id: backendId(payment.id_pago),
        expenseId: backendId(detail.id_egreso),
        amount: Math.abs(backendNumber(payment.monto))
      }))
  ));
  const analyzeBankMovement = (
    movement,
    payments,
    _collections,
    payables,
    _creditPayables,
    sources
  ) => {
    const exactAmount = (candidate) => money.toCents(candidate.amount) === Math.abs(money.toCents(movement.amount));
    const payment = payments.find(exactAmount);
    if (payment) return { ...movement, status: "listo", action: "Lista para conciliar", match: payment };
    const payable = payables.find(exactAmount);
    if (payable) return { ...movement, status: "agregar_pago", action: "Agregar pago", match: payable };
    const sourceMatch = sources.find((candidate) => (
      exactAmount(candidate) && candidate.description === movement.detail
    ));
    if (sourceMatch) {
      return { ...movement, status: "agregar_egreso", action: "Agregar egreso", sourceMatch, match: null };
    }
    return {
      ...movement,
      status: "agregar_gasto",
      action: "Agregar gasto",
      idEtiqueta: "5",
      provider: "Proveedor secuencia",
      providerMatch: { type: "datos_bancarios", idAcreedor: "10" },
      sourceDestination: { table: "otros_gastos", label: "Otros gastos" },
      match: null
    };
  };
  const persistence = createBankPersistenceService({
    backendBankMatches: (value, bank) => backendBankMatches(value, bank, (text) => cleanBackendText(text).toLowerCase()),
    backendId,
    backendIsoDate,
    backendNextNumericId,
    backendNormalizeText: (value) => cleanBackendText(value).toLowerCase(),
    backendNumber,
    backendTagIdForName: () => "5",
    cleanBackendText,
    compactBankText,
    crypto,
    ensureBackendTable,
    loadCache: store.loadCache,
    normalizeBankCheckNumber,
    normalizeBankCuit,
    saveBackendCache: store.saveBackendCache
  });
  const service = createBankReconciliationService(bankDependencies(store, {
    analyzeBankMovement,
    backendBankPayableCandidates: payableCandidates,
    backendBankPaymentCandidates: paymentCandidates,
    backendBankSourceCandidates: sourceCandidates,
    createBankEgressForSource: persistence.createBankEgressForSource,
    createBankPaymentForExpense: persistence.createBankPaymentForExpense,
    createBankSourceExpense: persistence.createBankSourceExpense,
    parseBankMovements: () => clone(movements)
  }));
  const state = async () => invokeRequest(service.handleBankReconciliationState, {
    url: "/api/bank-reconciliation/state?bank=ICBC"
  });
  const apply = (
    applyMode,
    report,
    movementKeys = report.movements.map((movement) => movement.movementKey),
    selection = { idAcreedor: "10", idAcreedorEtiqueta: "100" }
  ) => {
    const selected = report.movements.filter((movement) => movementKeys.includes(movement.movementKey));
    const reviewRows = applyMode === "createExpenses"
      ? Object.fromEntries(selected.map((movement) => [movement.movementKey, {
        idAcreedor: selection.idAcreedor,
        idAcreedorEtiqueta: selection.idAcreedorEtiqueta,
        canonicalMovementId: movement.canonicalMovementId,
        expectedDate: movement.date,
        expectedAmount: movement.amount,
        date: movement.date,
        detail: movement.detail
      }]))
      : {};
    return invoke(service.handleBankReconciliationApply, { bank: "ICBC", applyMode, movementKeys, reviewRows });
  };

  let report = (await invoke(service.handleBankReconciliationAnalyze, { bank: "ICBC", csvText: "fixture" })).payload.report;
  assert.deepStrictEqual(report.movements.map((movement) => movement.status), ["agregar_gasto", "agregar_gasto"]);

  const firstKey = report.movements[0].movementKey;
  const beforeDraftConfirmation = store.value();
  assert.deepStrictEqual(store.value(), beforeDraftConfirmation);
  await apply("createExpenses", report, [firstKey], { idAcreedor: "20", idAcreedorEtiqueta: "200" });
  assert.strictEqual(store.value().tables.otros_gastos.rows[0].id_acreedor, "20");
  assert.strictEqual(store.value().tables.otros_gastos.rows[0].id_acreedor_etiqueta, "200");
  const firstBankRow = store.value().tables.movimientos_bancarios.rows.find((row) => row._bankMovementKey === firstKey);
  assert.strictEqual(firstBankRow._bankManualCreditorId, "20");
  assert.strictEqual(firstBankRow._bankManualTagId, "6");
  assert.strictEqual(firstBankRow._bankManualCreditorTagRelationId, "200");
  assert.strictEqual(firstBankRow._bankManualClassificationSource, "bank-reconciliation:createExpenses");
  const contradictoryReplay = await apply(
    "createExpenses",
    report,
    [firstKey],
    { idAcreedor: "10", idAcreedorEtiqueta: "100" }
  );
  assert.strictEqual(contradictoryReplay.status, 409);
  assert.strictEqual(store.value().tables.otros_gastos.rows.length, 1);
  report = (await state()).payload.report;
  assert.strictEqual(report.movements.find((movement) => movement.movementKey === firstKey).status, "agregar_egreso");
  assert.strictEqual(report.movements.filter((movement) => movement.status === "agregar_gasto").length, 1);
  const remainingKey = report.movements.find((movement) => movement.status === "agregar_gasto").movementKey;
  const expensesBeforeInvalid = store.value().tables.otros_gastos.rows.length;
  const invalidResult = await apply(
    "createExpenses",
    report,
    [remainingKey],
    { idAcreedor: "20", idAcreedorEtiqueta: "100" }
  );
  assert.strictEqual(invalidResult.payload.result.expensesCreated, 0);
  assert.strictEqual(invalidResult.payload.result.skipped, 1);
  assert.strictEqual(store.value().tables.otros_gastos.rows.length, expensesBeforeInvalid);
  assert.strictEqual(
    store.value().tables.movimientos_bancarios.rows.find((row) => row._bankMovementKey === remainingKey)._bankManualCreditorId,
    undefined
  );
  const remainingMovement = report.movements.find((movement) => movement.movementKey === remainingKey);
  const staleResult = await invoke(service.handleBankReconciliationApply, {
    bank: "ICBC",
    applyMode: "createExpenses",
    movementKeys: [remainingKey],
    reviewRows: {
      [remainingKey]: {
        idAcreedor: "10",
        idAcreedorEtiqueta: "100",
        canonicalMovementId: remainingMovement.canonicalMovementId,
        expectedDate: "2026-07-27",
        expectedAmount: remainingMovement.amount,
        date: remainingMovement.date,
        detail: remainingMovement.detail
      }
    }
  });
  assert.strictEqual(staleResult.payload.result.expensesCreated, 0);
  assert.match(staleResult.payload.result.notes[0], /cambio desde el analisis/i);
  assert.strictEqual(store.value().tables.otros_gastos.rows.length, expensesBeforeInvalid);
  const remainingExpensesResult = await apply("createExpenses", report, [remainingKey]);
  assert.strictEqual(remainingExpensesResult.status, 200, remainingExpensesResult.payload.error);
  assert.strictEqual(remainingExpensesResult.payload.result.expensesCreated, 1);
  await apply("createExpenses", report, [remainingKey]);
  report = (await state()).payload.report;
  assert.strictEqual(
    report.movements.every((movement) => movement.status === "agregar_egreso"),
    true,
    JSON.stringify(report.movements.map((movement) => ({ detail: movement.detail, status: movement.status })))
  );
  assert.strictEqual(store.value().tables.otros_gastos.rows.length, 2);

  await apply("createEgresses", report);
  await apply("createEgresses", report);
  report = (await state()).payload.report;
  assert.strictEqual(report.movements.every((movement) => movement.status === "agregar_pago"), true);
  assert.strictEqual(store.value().tables.egresos.rows.filter((row) => ["100", "200"].includes(backendId(row.id_acreedor_etiqueta))).length, 2);

  await apply("createPayments", report);
  await apply("createPayments", report);
  report = (await state()).payload.report;
  assert.strictEqual(report.movements.every((movement) => movement.status === "listo"), true);
  assert.strictEqual(report.movements.some((movement) => movement.status.startsWith("agregar_")), false);
  assert.strictEqual(store.value().tables.pagos.rows.filter((row) => row._bankOperationKey).length, 2);
  assert.strictEqual(store.value().tables.detalle_pagos.rows.filter((row) => row._bankOperationKey).length, 2);

  const refreshed = await invoke(service.handleBankReconciliationAnalyze, { bank: "ICBC", csvText: "fixture" });
  assert.strictEqual(refreshed.payload.report.merge.newCount, 0);
  assert.strictEqual(refreshed.payload.report.movements.every((movement) => movement.status === "listo"), true);
  assert.strictEqual(store.value().tables.otros_gastos.rows.length, 2);
}

function testBankReconciliationNextActionDom() {
  const context = {
    API_BASE_URL: "",
    bankReconciliationReport: {
      movements: [{
        movementKey: "next-payment",
        status: "agregar_pago",
        date: "2026-07-28",
        detail: "Pago pendiente",
        amount: -120.5,
        match: { id: "501", description: "Proveedor secuencia" }
      }],
      lookupOptions: {}
    },
    bankReconciliationExcludedMovementKeys: new Set(),
    bankReconciliationRefreshPromise: null,
    bankReconciliationFileText: "",
    bankCheckDepositDraft: null,
    els: {
      "bank-reconciliation-bank": { value: "ICBC" },
      "bank-reconciliation-file": { disabled: false },
      "bank-reconciliation-file-clear": { disabled: false },
      "bank-reconciliation-analyze": { disabled: false },
      "bank-expense-stage-count": { textContent: "" },
      "bank-expense-stage-body": { innerHTML: "" },
      "bank-create-expenses": { disabled: false },
      "bank-egress-stage-count": { textContent: "" },
      "bank-egress-stage-body": { innerHTML: "" },
      "bank-create-egresses": { disabled: false },
      "bank-payment-stage-count": { textContent: "" },
      "bank-payment-stage-body": { innerHTML: "" },
      "bank-create-payments": { disabled: true },
      "bank-movements-stage": { hidden: false },
      "bank-expense-stage": { hidden: false },
      "bank-egress-stage": { hidden: false },
      "bank-payment-stage": { hidden: false },
      "bank-fund-stage": { hidden: false },
      "bank-fund-stage-count": { textContent: "" },
      "bank-fund-stage-body": { innerHTML: "" }
    },
    document: {
      getElementById(id) { return context.els[id] || null; },
      addEventListener: () => {}
    },
    emptyRow: (_columns, message) => message,
    escapeHtml: (value) => String(value ?? ""),
    formatBankMoney: (value) => String(value),
    formatMoney: (value) => String(value),
    formatDate: (value) => String(value),
    investmentFundTypeLabel: (value) => String(value),
    renderBankCheckDepositReview: () => {},
    renderInvestmentFundReconciliationCandidates: () => {},
    setupFileDropZone: () => {}
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "assets/js/modules/bank-reconciliation-core.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "assets/js/modules/bank-reconciliation-render.js"), "utf8"), context);
  context.setBankReconciliationStageVisibility("bank-movements-stage", false);
  assert.strictEqual(context.els["bank-movements-stage"].hidden, true);
  context.setBankReconciliationStageVisibility("bank-movements-stage", true);
  assert.strictEqual(context.els["bank-movements-stage"].hidden, false);
  context.renderBankReconciliationStages();
  assert.strictEqual(context.els["bank-expense-stage"].hidden, true);
  assert.strictEqual(context.els["bank-egress-stage"].hidden, true);
  assert.strictEqual(context.els["bank-payment-stage"].hidden, false);
  assert.strictEqual(context.els["bank-create-expenses"].disabled, true);
  assert.strictEqual(context.els["bank-create-egresses"].disabled, true);
  assert.strictEqual(context.els["bank-create-payments"].disabled, false);
  assert.match(context.els["bank-payment-stage-body"].innerHTML, /next-payment/);
  assert.match(context.els["bank-payment-stage-body"].innerHTML, /Egreso #501/);
  assert.doesNotMatch(context.els["bank-expense-stage-body"].innerHTML, /next-payment/);

  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "assets/js/modules/investment-fund.js"), "utf8"), context);
  context.renderInvestmentFundReconciliationCandidates([]);
  assert.strictEqual(context.els["bank-fund-stage"].hidden, true);
  context.renderInvestmentFundReconciliationCandidates([{
    id: "fund-1",
    type: "aporte",
    confidence: "review",
    movement: { fecha: "2026-07-28", banco: "ICBC", detalle: "Fondo", importe: 10 }
  }]);
  assert.strictEqual(context.els["bank-fund-stage"].hidden, false);

  context.bankReconciliationReport = {
    movements: [
      {
        canonicalMovementId: "77",
        movementKey: "editable-expense",
        status: "agregar_gasto",
        date: "2026-07-22",
        detail: "Gasto bancario",
        amount: -55,
        providerMatch: {
          type: "datos_bancarios",
          idAcreedor: "10",
          idAcreedorEtiqueta: "100"
        },
        sourceDestination: { table: "otros_gastos", label: "Otros gastos" }
      },
      {
        canonicalMovementId: "78",
        movementKey: "bank-rule-expense",
        status: "agregar_gasto",
        date: "2026-07-22",
        detail: "Lodiser",
        amount: -65,
        providerMatch: {
          type: "datos_bancarios",
          idAcreedor: "20",
          idAcreedorEtiqueta: "200"
        },
        sourceDestination: { table: "otros_gastos", label: "Otros gastos" }
      },
      {
        canonicalMovementId: "79",
        movementKey: "no-valid-suggestion",
        status: "agregar_gasto",
        date: "2026-07-22",
        detail: "Sin sugerencia",
        amount: -75,
        providerMatch: null,
        sourceDestination: { table: "otros_gastos", label: "Otros gastos" }
      }
    ],
    lookupOptions: {
      creditors: [{ id: "10", name: "Benjamin" }, { id: "20", name: "Acreedor alternativo" }],
      creditorTags: [
        { idAcreedorEtiqueta: "100", idAcreedor: "10", idEtiqueta: "5", tagName: "Administrativos" },
        { idAcreedorEtiqueta: "200", idAcreedor: "20", idEtiqueta: "6", tagName: "Servicios" }
      ]
    }
  };
  context.renderBankReconciliationStages();
  assert.strictEqual(context.els["bank-expense-stage"].hidden, false);
  assert.strictEqual(context.els["bank-egress-stage"].hidden, true);
  assert.strictEqual(context.els["bank-payment-stage"].hidden, true);
  const expenseMarkup = context.els["bank-expense-stage-body"].innerHTML;
  assert.match(expenseMarkup, /data-bank-expense-creditor/);
  assert.match(expenseMarkup, /data-bank-expense-tag/);
  assert.doesNotMatch(expenseMarkup, /<label[^>]*>Acreedor<\/label>/);
  assert.doesNotMatch(expenseMarkup, /<label[^>]*>Etiqueta<\/label>/);
  assert.match(expenseMarkup, /<select aria-label="Acreedor"[^>]*data-bank-expense-creditor>/);
  assert.match(expenseMarkup, /<select aria-label="Etiqueta"[^>]*data-bank-expense-tag>/);
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const expenseStageMarkup = html.slice(
    html.indexOf('id="bank-expense-stage"'),
    html.indexOf('id="bank-egress-stage"')
  );
  assert.strictEqual((expenseStageMarkup.match(/<th>Acreedor<\/th>/g) || []).length, 1);
  assert.strictEqual((expenseStageMarkup.match(/<th>Etiqueta<\/th>/g) || []).length, 1);
  assert.match(expenseMarkup, /data-bank-canonical-movement-id="77"/);
  assert.match(expenseMarkup, /value="10" selected/);
  assert.match(expenseMarkup, /value="100" selected/);
  assert.match(expenseMarkup, /value="20" selected/);
  assert.match(expenseMarkup, /value="200" selected/);
  assert.strictEqual(context.els["bank-create-expenses"].disabled, false);
  vm.runInContext(`bankExpenseReviewDrafts.set("editable-expense", {
    idAcreedor: "", idAcreedorEtiqueta: "", date: "2026-07-21", detail: ""
  })`, context);
  context.renderBankReconciliationStages();
  const preservedDraftMarkup = context.els["bank-expense-stage-body"].innerHTML;
  assert.match(preservedDraftMarkup, /type="date" value="2026-07-21"/);
  assert.doesNotMatch(preservedDraftMarkup, /value="10" selected/);
  assert.doesNotMatch(preservedDraftMarkup, />Gasto bancario<\/option>/);
  assert.match(preservedDraftMarkup, /value="20" selected/);
  assert.match(preservedDraftMarkup, /value="200" selected/);
  context.bankReconciliationReport.movements = [
    context.bankReconciliationReport.movements.find((movement) => movement.movementKey === "no-valid-suggestion")
  ];
  context.renderBankReconciliationStages();
  const noSuggestionMarkup = context.els["bank-expense-stage-body"].innerHTML;
  assert.match(noSuggestionMarkup, /data-bank-movement-key="no-valid-suggestion"/);
  assert.doesNotMatch(noSuggestionMarkup, / selected/);
  context.setBankReconciliationActionButtonsDisabled(true);
  assert.strictEqual(context.els["bank-reconciliation-bank"].disabled, true);
  assert.strictEqual(context.els["bank-reconciliation-file"].disabled, true);
  assert.strictEqual(context.els["bank-reconciliation-file-clear"].disabled, true);
  assert.strictEqual(context.els["bank-reconciliation-analyze"].disabled, true);
}

function testLegacyBankEgressRecoversCreditorFromLinkedSource() {
  const matching = createBankMatchingService({
    backendExpenseCounterpartyInfo: () => ({ name: "Proveedor secuencia", cuit: "", detail: "Gasto secuencia" }),
    backendId,
    backendIsoDate,
    backendNumber,
    backendRowsById,
    compactBankText
  });
  const tables = {
    egresos: {
      rows: [{
        id_egreso: 501,
        fecha_factura: "2026-07-28",
        fecha_prevista_pago: "2026-07-28",
        total: 120.5,
        id_acreedor_etiqueta: "",
        _bankOperationKey: "createEgresses:fingerprint:movement-key:1"
      }]
    },
    otros_gastos: {
      rows: [{ id_otros_gastos: 50, id_egreso: 501, id_acreedor_etiqueta: 100 }]
    },
    acreedores_etiquetas: {
      rows: [{ id_acreedor_etiqueta: 100, id_acreedor: 10, id_etiqueta: 5 }]
    },
    detalle_pagos: { rows: [] },
    cuotas_planes_pagos: { rows: [] }
  };
  const candidate = matching.backendBankPayableCandidates(tables)[0];
  assert.strictEqual(candidate.id, "501");
  assert.strictEqual(candidate.idAcreedor, "10");
  assert.strictEqual(candidate.movementKey, "movement-key:1");
}

function testBankLineageSelectsRepeatedExpenseOneToOne() {
  const parser = createBankParserService({
    backendIsoDate,
    backendNormalizeText: (value) => cleanBackendText(value).toLowerCase(),
    backendNumber,
    bankManualCheckDepositMatch: () => null,
    bankMovementBackendCreditorId: () => "10",
    bankSourceDestinationForOriginType: () => ({ table: "otros_gastos", label: "Otros gastos" }),
    bestBankMatch: () => null,
    bestBankSourceMatch: (_movement, candidates) => candidates[0] || null,
    cleanBackendText,
    compactBankText,
    consumePersistedBankMovement: () => null,
    exactPendingExpenseMatch: () => null,
    extractBankCheckNumber,
    extractBankCuit,
    identifyBankCounterparty: () => ({
      name: "ICBC",
      tagLabel: "Gastos Bancarios",
      idEtiqueta: "5",
      idAcreedor: "10",
      sourceDestination: { table: "otros_gastos", label: "Otros gastos" }
    }),
    normalizeBankCheckNumber,
    normalizeBankCuit,
    uniqueExactBankMatch: () => null
  });
  const dates = ["2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"];
  const repeated = dates.flatMap((date, dayIndex) => [126, 600].map((amount, amountIndex) => ({
    date,
    amount: -amount,
    movementKey: `repeated-${dayIndex}-${amountIndex}:1`
  })));
  const distinct = Array.from({ length: 7 }, (_, index) => ({
    date: `2026-07-${21 + index}`,
    amount: -(700 + index),
    movementKey: `distinct-${index}:1`
  }));
  const movements = [...repeated, ...distinct];
  const payables = [...movements].reverse().map((movement, index) => ({
    type: "egreso",
    id: String(8000 + index),
    amount: Math.abs(movement.amount),
    date: movement.date,
    idAcreedor: "10",
    movementKey: movement.movementKey
  }));

  movements.forEach((movement) => {
    const analyzed = parser.analyzeBankMovement(
      movement,
      [],
      [],
      payables,
      [],
      [],
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      [],
      "ICBC",
      new Set()
    );
    assert.strictEqual(analyzed.status, "agregar_pago");
    assert.strictEqual(analyzed.match.movementKey, movement.movementKey);
  });

  const alteredLineage = parser.analyzeBankMovement(
    repeated[0],
    [],
    [],
    [{ ...payables.find((candidate) => candidate.movementKey === repeated[0].movementKey), amount: 100 }],
    [],
    [],
    new Map(),
    new Map(),
    new Map(),
    new Map(),
    [],
    "ICBC",
    new Set()
  );
  assert.strictEqual(alteredLineage.status, "agregar_gasto");

  const partial = parser.analyzeBankMovement(
    repeated[0],
    [],
    [],
    [],
    [],
    [{
      type: "gasto_origen",
      table: "otros_gastos",
      label: "Otro gasto",
      idColumn: "id_otros_gastos",
      id: "9001",
      date: repeated[0].date,
      amount: 126,
      idAcreedor: "10",
      movementKey: "other-movement:1"
    }, {
      type: "gasto_origen",
      table: "otros_gastos",
      label: "Otro gasto",
      idColumn: "id_otros_gastos",
      id: "9002",
      date: repeated[0].date,
      amount: 126,
      idAcreedor: "10",
      movementKey: repeated[0].movementKey
    }],
    new Map(),
    new Map(),
    new Map(),
    new Map(),
    [],
    "ICBC",
    new Set()
  );
  assert.strictEqual(partial.status, "agregar_egreso");
  assert.strictEqual(partial.sourceMatch.id, "9002");
}

async function testDepositRollbackAndRetry() {
  const failedStore = memoryStore(bankTestTables());
  const failed = createBankReconciliationService(bankDependencies(failedStore, {
    failureInjector: (point) => { if (point === "after-check-updates") throw new Error("fallo inyectado"); }
  }));
  const failedAnalyze = await invoke(failed.handleBankReconciliationAnalyze, {
    bank: "ICBC",
    csvText: "deposito con rollback"
  });
  const failedBody = {
    bank: "ICBC",
    depositDate: "2026-07-23",
    checkIds: [30],
    movement: failedAnalyze.payload.report.movements[0]
  };
  const before = failedStore.value();
  assert.strictEqual((await invoke(failed.handleBankReconciliationDepositChecks, failedBody)).status, 400);
  assert.deepStrictEqual(failedStore.value(), before);

  const store = memoryStore(bankTestTables());
  const service = createBankReconciliationService(bankDependencies(store));
  const analyzed = await invoke(service.handleBankReconciliationAnalyze, {
    bank: "ICBC",
    csvText: "deposito correcto"
  });
  const body = {
    bank: "ICBC",
    depositDate: "2026-07-23",
    checkIds: [30],
    movement: analyzed.payload.report.movements[0]
  };
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

async function testCommissionExpenseResolvesCanonicalCreditorInPayments() {
  const requestedTables = [];
  const comparableId = (value) => {
    const text = backendId(value);
    return /^-?\d+(?:\.0+)?$/.test(text) ? String(Number(text)) : text;
  };
  const context = {
    backendTableRowsForEntry: async (tableName) => {
      requestedTables.push(tableName);
      return [];
    },
    centsToMoney: money.fromCents,
    comparableLookupId: comparableId,
    displayNameLabel: (value) => cleanBackendText(value).replaceAll("_", " "),
    isFinancialInvoiceTypeVisible: () => true,
    moneyToCents: money.toCents,
    normalizeCategory: (value) => cleanBackendText(value).toLowerCase(),
    normalizeEmployeeContractType: (value) => value,
    normalizeMoney: (value) => money.fromCents(money.toCents(value)),
    normalizeSearchText: (value) => cleanBackendText(value).toLowerCase(),
    parseDate: (value) => cleanBackendText(value),
    rowsByKey: (rows, key) => (rows || []).reduce((map, row) => {
      const rawId = backendId(row[key]);
      if (!rawId) return map;
      map.set(rawId, row);
      map.set(comparableId(rawId), row);
      return map;
    }, new Map()),
    groupRowsByComparableKey: (rows, key) => (rows || []).reduce((groups, row) => {
      const id = comparableId(row[key]);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(row);
      return groups;
    }, new Map())
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "assets/js/modules/issued-check-pending.js"), "utf8"),
    context
  );
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "assets/js/modules/payment-entry.js"), "utf8"),
    context
  );

  await context.loadExpenseDebtTables();
  assert(requestedTables.includes("comisiones"));

  const tables = {
    egresos: { rows: [{ id_egreso: "9001", tipo_factura: "Factura_C", total: 1250.5 }] },
    detalle_pagos: { rows: [] },
    etiquetas: { rows: [{ id_etiqueta: "7", etiqueta: "Comisiones" }] },
    acreedores: { rows: [{ id_acreedor: "13", origen_tipo_acreedor: "Canal", origen_id_acreedor: "1" }] },
    acreedores_etiquetas: { rows: [{ id_acreedor_etiqueta: 21, id_acreedor: "13", id_etiqueta: "7" }] },
    comisiones: { rows: [
      { id_comision: "1", id_egreso: "9001", id_canal: "1", id_acreedor_etiqueta: "21.0" },
      { id_comision: "2", id_egreso: "9001", id_canal: "1", id_acreedor_etiqueta: 21 }
    ] },
    canales: { rows: [{ id_canal: "1", nombre: "Canal fixture" }] }
  };
  const rows = context.buildExpenseDebtRows(tables);

  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].creditorId, "13");
  assert.strictEqual(rows[0].creditor, "Canal fixture");

  tables.acreedores.rows.push({ id_acreedor: "14", origen_tipo_acreedor: "Canal", origen_id_acreedor: "2" });
  tables.acreedores_etiquetas.rows.push({ id_acreedor_etiqueta: "22", id_acreedor: "14", id_etiqueta: "7" });
  tables.comisiones.rows[1].id_acreedor_etiqueta = "22";
  assert.strictEqual(context.buildExpenseDebtRows(tables)[0].creditor, "Sin acreedor");

  tables.comisiones.rows[1].id_acreedor_etiqueta = "999";
  assert.strictEqual(context.buildExpenseDebtRows(tables)[0].creditor, "Sin acreedor");
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
  let store = diskStore(filePath, bankTestTables());
  let service = createBankReconciliationService(bankDependencies(store));
  const analyzed = await invoke(service.handleBankReconciliationAnalyze, { bank: "ICBC", csvText: "analyze-a" });
  assert.strictEqual(store.value().tables.movimientos_bancarios.rows.length, 1);
  assert.strictEqual(store.value().tables.movimientos_bancarios.rows[0].id_cobro, "");
  service = null;
  store = diskStore(filePath);
  service = createBankReconciliationService(bankDependencies(store));
  const state = await invoke(service.handleBankReconciliationState, undefined);
  assert.strictEqual(state.payload.report.movements.length, 1);
  const body = {
    bank: "ICBC",
    applyMode: "reconcile",
    movementKeys: [analyzed.payload.report.movements[0].movementKey]
  };
  const beforeApply = store.value();
  await invoke(service.handleBankReconciliationApply, body);
  const applied = store.value();
  service = null;
  store = diskStore(filePath);
  service = createBankReconciliationService(bankDependencies(store));
  await invoke(service.handleBankReconciliationApply, body);
  assert.deepStrictEqual(store.value(), applied);
  assert.strictEqual(applied.tables.movimientos_bancarios.rows[0].id_cobro, "1");

  const appliedOperation = applied.tables.movimientos_bancarios.rows[0];
  const partial = clone(beforeApply);
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
  const seed = bankTestTables();
  seed.tables.cheques_recibidos.rows.push({
    id_cheque_recibido: 31, id_cobro: 1, monto: 100.25, estado: "Pendiente"
  });
  seed.tables.cheques_recibidos.rowCount = 2;
  let store = diskStore(filePath, seed);
  let service = createBankReconciliationService(bankDependencies(store));
  const analyzed = await invoke(service.handleBankReconciliationAnalyze, {
    bank: "ICBC",
    csvText: "deposito durable"
  });
  const body = {
    bank: "ICBC", depositDate: "2026-07-23", checkIds: [30],
    movement: analyzed.payload.report.movements[0]
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
  const secondAnalyzed = await invoke(service.handleBankReconciliationAnalyze, {
    bank: "ICBC",
    csvText: "segundo deposito legitimo"
  });
  legitimateNew.movement = secondAnalyzed.payload.report.movements.find(
    (movement) => movement.detail === "segundo deposito legitimo"
  );
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
  await testCommissionExpenseResolvesCanonicalCreditorInPayments();
  await testDurableIdempotencyAcrossRestarts();
  await testCollectionAtomicityAndIdempotency();
  await testPaymentAtomicityAndIdempotency();
  await testContributionAtomicityAndSigns();
  testBankReferenceNormalizerInjection();
  testBankPaymentRejectsCashMethod();
  await testIcBcAnalyzeFixtures();
  await testPersistentPendingBankMovements();
  await testBankReconciliationActionSequenceRefreshesCanonicalState();
  testBankReconciliationNextActionDom();
  testLegacyBankEgressRecoversCreditorFromLinkedSource();
  testBankLineageSelectsRepeatedExpenseOneToOne();
  await testAnalyzeAndApply();
  await testIdenticalReconciledOccurrenceDoesNotReappear();
  await testAdditionalIdenticalOccurrenceUsesMultisetCounts();
  await testDepositRollbackAndRetry();
  console.log("Treasury safety tests: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
