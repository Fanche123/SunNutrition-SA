const assert = require("assert");
const { createBankParserService } = require("../backend/services/bank-parser.service");
const { createBankPersistenceService } = require("../backend/services/bank-persistence.service");
const { createCashBoxesService } = require("../backend/services/cash-boxes.service");
const { migrateInternalTransferCatalog } = require("../backend/migrations/20260729-internal-transfer-catalog");
const bankUtils = require("../backend/utils/bank");
const ids = require("../backend/utils/ids");
const runtime = require("../backend/utils/runtime");

function fixture() {
  return {
    tables: {
      acreedores: { rows: [{ id_acreedor: "52", origen_tipo_acreedor: "Otros Acreedores", origen_id_acreedor: "16", cuit_cuil: "30-71755041-9", acuerdo_de_pago: "0" }] },
      otros_acreedores: { rows: [{ id_otro_acreedor: "16", nombre_otro_acreedor: "Propio" }] },
      etiquetas: { rows: [], rowCount: 0 },
      acreedores_etiquetas: { rows: [], rowCount: 0 },
      egresos: { rows: [], rowCount: 0 },
      pagos: { rows: [], rowCount: 0 },
      detalle_pagos: { rows: [], rowCount: 0 }
      , gastos_economicos: { rows: [], rowCount: 0 }
      , gastos_egresos: { rows: [], rowCount: 0 }
      , movimientos_bancarios: { rows: [], rowCount: 0 }
      , cobros: { rows: [] }
      , cobros_detalle: { rows: [] }
      , cheques_recibidos: { rows: [] }
      , cheques_entregados: { rows: [] }
      , clientes: { rows: [] }
    }
  };
}

function dependencies() {
  const clean = (v) => String(v || "").trim();
  const normalize = (v) => clean(v).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const parser = createBankParserService({
    ...bankUtils, ...ids, ...runtime,
    backendIsoDate: (v) => v,
    backendNormalizeText: normalize,
    backendNumber: Number,
    bankManualCheckDepositMatch: () => null,
    bankMovementBackendCreditorId: (movement) => String(movement.providerMatch?.idAcreedor || ""),
    bankSourceDestinationForOriginType: () => ({ table: "otros_gastos", label: "Otros gastos" }),
    bestBankMatch: () => null,
    bestBankSourceMatch: () => null,
    cleanBackendText: clean,
    compactBankText: clean,
    consumePersistedBankMovement: () => null,
    exactPendingExpenseMatch: () => null,
    identifyBankCounterparty: (_movement, identities) => identities[0] || null,
    uniqueExactBankMatch: () => null
  });
  const persistence = createBankPersistenceService({
    ...bankUtils, ...ids, ...runtime,
    backendIsoDate: (v) => v,
    backendNormalizeText: normalize,
    backendNumber: Number,
    backendTagIdForName: () => "",
    cleanBackendText: clean,
    compactBankText: clean,
    ensureBackendTable: () => {}
  });
  return { parser, persistence };
}

function analyze(cache, overrides = {}) {
  const { parser } = dependencies();
  const movement = {
    date: "2026-07-24", amount: -60000, debit: 60000, credit: 0,
    bankConcept: "TRANSF CONNBKG", detail: "TRANSF CONNBKG",
    concept: "TRANSF CONNBKG · SUNNUTRITION SA · 30717550419",
    cuit: "30717550419", movementKey: "same:1", rowNumber: 1,
    ...overrides
  };
  return parser.analyzeBankMovement(
    movement, [], [], [], [], [], new Map(),
    [{
      type: "acreedor",
      id: "52",
      idAcreedor: "52",
      name: "Propio",
      cuit: "30717550419",
      tagOptionDetails: [{
        idEtiqueta: cache.tables.etiquetas.rows[0].id_etiqueta,
        idAcreedorEtiqueta: cache.tables.acreedores_etiquetas.rows[0].id_acreedor_etiqueta,
        name: "Transferencia interna - Galicia"
      }]
    }],
    new Map(), new Map(), [], "ICBC", new Set()
  );
}

function run() {
  const first = migrateInternalTransferCatalog(fixture());
  assert.deepStrictEqual(first.report, { tagInserted: true, relationInserted: true, idAcreedor: "52", idEtiqueta: "1" });
  const second = migrateInternalTransferCatalog(first.cache);
  assert.strictEqual(second.report.tagInserted, false);
  assert.strictEqual(second.report.relationInserted, false);

  const movement = analyze(second.cache);
  assert.strictEqual(movement.status, "agregar_egreso");
  assert.strictEqual(movement.classificationType, "transferencia_interna");
  assert.strictEqual(movement.provider, "Propio");
  assert.strictEqual(movement.tag, "Transferencia interna - Galicia");
  assert.strictEqual(analyze(second.cache, { cuit: "30111111118" }).status, "revisar");
  assert.strictEqual(analyze(second.cache, { cuit: "" }).status, "revisar");
  assert.strictEqual(analyze(second.cache, { amount: 60000, debit: 0, credit: 60000 }).status, "revisar");
  assert.strictEqual(analyze(second.cache, { detail: "TRANSF PROVEEDOR", bankConcept: "TRANSF PROVEEDOR" }).status, "revisar");
  assert.strictEqual(analyze(second.cache, { detail: "TRANSF CONNBKG FONDO", bankConcept: "TRANSF CONNBKG FONDO" }).status, "revisar");

  const { persistence } = dependencies();
  const tables = second.cache.tables;
  const economicBefore = JSON.stringify({
    gastos_economicos: tables.gastos_economicos.rows,
    gastos_egresos: tables.gastos_egresos.rows
  });
  const created = persistence.createBankEgressForSource(tables, movement, {}, "createEgresses:key:1", "{}");
  assert.ok(created.expenseId);
  assert.strictEqual(tables.egresos.rows.length, 1);
  assert.strictEqual(tables.egresos.rows[0]._financialClassification, "transferencia_interna");
  assert.strictEqual(tables.egresos.rows[0].total, 60000);
  assert.strictEqual(tables.otros_gastos, undefined);
  assert.strictEqual(JSON.stringify({
    gastos_economicos: tables.gastos_economicos.rows,
    gastos_egresos: tables.gastos_egresos.rows
  }), economicBefore);
  const payment = persistence.createBankPaymentForExpense(tables, movement, "ICBC", created.expenseId, 60000, {}, "createPayments:key:1", "{}");
  assert.ok(payment.paymentId);
  assert.strictEqual(tables.pagos.rows[0].banco, "ICBC");
  assert.strictEqual(tables.pagos.rows[0].monto, 60000);
  assert.strictEqual(tables.detalle_pagos.rows[0].id_egreso, created.expenseId);
  const cash = createCashBoxesService({
    backendBankMatches: (value, bank) => String(value || "").toLowerCase() === String(bank || "").toLowerCase(),
    backendExpenseCounterpartyInfo: () => ({ name: "Propio" }),
    backendGroupRowsById: ids.backendGroupRowsById,
    backendId: ids.backendId,
    backendIsoDate: (value) => String(value || ""),
    backendNormalizeText: (value) => String(value || "").toLowerCase(),
    backendRowsById: ids.backendRowsById,
    canonicalPendingBankMovements: () => [],
    loadCache: () => second.cache,
    sendJson: () => {}
  }).buildCashBoxSnapshot(second.cache, "icbc");
  assert.strictEqual(cash.erpToBank.payments[0].classification, "Transferencia interna");
  assert.strictEqual(cash.summary.paymentTotalCents, 6000000);
  console.log("internal-transfer.test.js: ok");
}

run();
