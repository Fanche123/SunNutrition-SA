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
const { createBankParserService } = require("../backend/services/bank-parser.service");
const { createBankPersistenceService } = require("../backend/services/bank-persistence.service");
const { createBankReferenceService } = require("../backend/services/bank-reference.service");
const { createCashflowService } = require("../backend/services/cashflow.service");
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
  await testDurableIdempotencyAcrossRestarts();
  await testCollectionAtomicityAndIdempotency();
  await testPaymentAtomicityAndIdempotency();
  await testContributionAtomicityAndSigns();
  testBankReferenceNormalizerInjection();
  await testIcBcAnalyzeFixtures();
  await testPersistentPendingBankMovements();
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
