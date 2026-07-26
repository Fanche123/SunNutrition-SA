const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const { createBankMatchingService } = require("../backend/services/bank-matching.service");
const { createBankParserService } = require("../backend/services/bank-parser.service");
const { createBankPersistenceService } = require("../backend/services/bank-persistence.service");
const { createBankReconciliationService } = require("../backend/services/bank-reconciliation.service");
const { createCollectionEntryService } = require("../backend/services/collection-entry.service");
const { createPaymentEntryService } = require("../backend/services/payment-entry.service");
const { createPartnerContributionsService } = require("../backend/services/partner-contributions.service");
const { createPayrollExpenseEntryService } = require("../backend/services/payroll-expense-entry.service");
const { createSalesOrderEntryService } = require("../backend/services/sales-order-entry.service");
const {
  validateReceivedCheckEndorsementOperation
} = require("../backend/utils/received-check-endorsement");
const {
  backendNextNumericId,
  ensureBackendTable
} = require("../backend/utils/runtime");
const {
  parseStrictMoneyInput,
  strictMoneyToCents
} = require("../backend/utils/money-input");

const backendId = (value) => String(value ?? "").trim();
const backendNumber = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const normalized = String(value ?? "").trim().replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const readJsonBody = async (request) => request.body;
const sendJson = (response, status, payload) => response.json(status, payload);

function memoryStore(seed) {
  let value = clone(seed);
  return {
    loadCache: () => clone(value),
    saveBackendCache: (next) => { value = clone(next); },
    value: () => clone(value)
  };
}

async function invoke(handler, body) {
  let result;
  await handler(
    { body },
    { json(status, payload) { result = { status, payload }; } }
  );
  return result;
}

test("el helper backend valida payload monetario localizado sin redondear subcentavos", () => {
  assert.equal(strictMoneyToCents("$ 1.234,56"), 123456);
  assert.equal(strictMoneyToCents(0.1 + 0.2), 30);
  assert.equal(strictMoneyToCents("", { emptyAsZero: true }), 0);
  assert.equal(parseStrictMoneyInput("-12,34").cents, -1234);
  assert.throws(
    () => strictMoneyToCents(1.001),
    (error) => error.code === "TOO_MANY_DECIMALS"
  );
  assert.throws(
    () => strictMoneyToCents(1.0000000001),
    (error) => error.code === "TOO_MANY_DECIMALS"
  );
  assert.throws(
    () => strictMoneyToCents("importe-inválido"),
    (error) => error.code === "INVALID_FORMAT"
  );
});

test("cobros y pagos suman 0,10 + 0,20 exactamente en centavos", async () => {
  const collectionStore = memoryStore({
    tables: {
      ventas: { rows: [{ id_venta: 1, total: 0.3 }] }
    }
  });
  const collection = createCollectionEntryService({
    backendId,
    backendNextNumericId,
    backendNumber,
    ensureBackendTable,
    loadCache: collectionStore.loadCache,
    readJsonBody,
    saveBackendCache: collectionStore.saveBackendCache,
    sendJson
  });
  const collectionResult = await invoke(collection.handleCollectionFullEntry, {
    operationId: "money-collection",
    collection: {
      fecha: "2026-07-24",
      metodo: "Transferencia",
      idCliente: 1,
      monto: "$ 0,30"
    },
    details: [
      { idVenta: 1, monto: "0,10" },
      { idVenta: 1, monto: "0,20" }
    ],
    retentions: { ganancias: 0, iibb: 0 }
  });
  assert.equal(collectionResult.status, 200);
  assert.equal(collectionStore.value().tables.cobros.rows[0].monto, 0.3);

  const paymentStore = memoryStore({
    tables: {
      egresos: { rows: [{ id_egreso: 1, total: 0.3 }] }
    }
  });
  const payment = createPaymentEntryService({
    backendId,
    backendNextNumericId,
    backendNumber,
    ensureBackendTable,
    loadCache: paymentStore.loadCache,
    readJsonBody,
    saveBackendCache: paymentStore.saveBackendCache,
    sendJson
  });
  const paymentResult = await invoke(payment.handlePaymentFullEntry, {
    operationId: "money-payment",
    payment: { fecha: "2026-07-24", metodo: "Transferencia" },
    details: [
      { idEgreso: 1, monto: 0.1 },
      { idEgreso: 1, monto: 0.2 }
    ]
  });
  assert.equal(paymentResult.status, 200);
  assert.equal(paymentStore.value().tables.pagos.rows[0].monto, 0.3);
});

test("aportes y egreso salarial persisten sumas exactas en centavos", async () => {
  const contributionStore = memoryStore({
    tables: {
      aportes_socios: { rows: [] },
      egresos: { rows: [] }
    }
  });
  const contributions = createPartnerContributionsService({
    backendId,
    backendNextNumericId,
    backendNumber,
    ensureBackendTable,
    loadCache: contributionStore.loadCache,
    normalizePartnerName: (value) => String(value ?? "").trim().toLowerCase(),
    readJsonBody,
    saveBackendCache: contributionStore.saveBackendCache,
    sendJson
  });
  const contributionResult = await invoke(contributions.handlePartnerContributionFullEntry, {
    operationId: "money-contribution",
    contribution: {
      fecha: "2026-07-24",
      nombre: "Socio",
      tipo: "Aporte",
      monto: 0.1 + 0.2
    }
  });
  assert.equal(contributionResult.status, 200);
  assert.equal(contributionStore.value().tables.aportes_socios.rows[0].monto, 0.3);
  assert.equal(contributionStore.value().tables.egresos.rows[0].total, -0.3);

  const payrollStore = memoryStore({
    tables: {
      sueldos: {
        rows: [
          { id_sueldo: 1, sueldo_neto: 0.1, id_acreedor_etiqueta: 10, id_egreso: "" },
          { id_sueldo: 2, sueldo_neto: 0.2, id_acreedor_etiqueta: 11, id_egreso: "" }
        ]
      },
      egresos: { rows: [] },
      acreedores_etiquetas: {
        rows: [
          { id_acreedor_etiqueta: 10 },
          { id_acreedor_etiqueta: 11 }
        ]
      },
      etiquetas: { rows: [{ id_etiqueta: 5 }] }
    }
  });
  const payroll = createPayrollExpenseEntryService({
    backendId,
    backendNextNumericId,
    backendNumber,
    ensureBackendTable,
    loadCache: payrollStore.loadCache,
    readJsonBody,
    saveBackendCache: payrollStore.saveBackendCache,
    sendJson
  });
  const payrollResult = await invoke(payroll.handlePayrollExpenseEntry, {
    salaryIds: [1, 2],
    concepts: [
      { type: "salary", salaryId: 1, amount: 0.1 },
      { type: "salary", salaryId: 2, amount: 0.2 }
    ],
    expense: {
      fecha_factura: "2026-07-31",
      id_etiqueta: 5,
      tipo_factura: "Recibo_Sueldo",
      nro_factura: "JUL-2026",
      subtotal: "0,30",
      total: "$ 0,30",
      iva: 0,
      per_ret_iva: 0,
      per_ret_iibb: 0,
      imp_internos: 0
    }
  });
  assert.equal(payrollResult.status, 200);
  assert.equal(payrollStore.value().tables.egresos.rows[0].total, 0.3);
});

test("las escrituras monetarias rechazan subcentavos numéricos y formatos inválidos", async () => {
  const collectionStore = memoryStore({
    tables: { ventas: { rows: [{ id_venta: 1, total: 2 }] } }
  });
  const collection = createCollectionEntryService({
    backendId,
    backendNextNumericId,
    backendNumber,
    ensureBackendTable,
    loadCache: collectionStore.loadCache,
    readJsonBody,
    saveBackendCache: collectionStore.saveBackendCache,
    sendJson
  });
  const invalidCollection = await invoke(collection.handleCollectionFullEntry, {
    operationId: "invalid-money-collection",
    collection: {
      fecha: "2026-07-24",
      metodo: "Transferencia",
      idCliente: 1,
      monto: 1.001
    },
    details: [{ idVenta: 1, monto: 1 }],
    retentions: { ganancias: 0, iibb: 0 }
  });
  assert.equal(invalidCollection.status, 400);
  assert.match(invalidCollection.payload.error, /máximo dos decimales/);

  const malformedCollection = await invoke(collection.handleCollectionFullEntry, {
    operationId: "malformed-money-collection",
    collection: {
      fecha: "2026-07-24",
      metodo: "Transferencia",
      idCliente: 1,
      monto: "importe-inválido"
    },
    details: [{ idVenta: 1, monto: 1 }],
    retentions: { ganancias: 0, iibb: 0 }
  });
  assert.equal(malformedCollection.status, 400);
  assert.equal(collectionStore.value().tables.cobros, undefined);

  const paymentStore = memoryStore({
    tables: { egresos: { rows: [{ id_egreso: 1, total: 2 }] } }
  });
  const payment = createPaymentEntryService({
    backendId,
    backendNextNumericId,
    backendNumber,
    ensureBackendTable,
    loadCache: paymentStore.loadCache,
    readJsonBody,
    saveBackendCache: paymentStore.saveBackendCache,
    sendJson
  });
  const invalidPayment = await invoke(payment.handlePaymentFullEntry, {
    operationId: "invalid-money-payment",
    payment: { fecha: "2026-07-24", metodo: "Transferencia" },
    details: [{ idEgreso: 1, monto: 1.001 }]
  });
  assert.equal(invalidPayment.status, 400);
  assert.equal(paymentStore.value().tables.pagos, undefined);

  const contributionStore = memoryStore({
    tables: {
      aportes_socios: { rows: [] },
      egresos: { rows: [] }
    }
  });
  const contributions = createPartnerContributionsService({
    backendId,
    backendNextNumericId,
    backendNumber,
    ensureBackendTable,
    loadCache: contributionStore.loadCache,
    normalizePartnerName: (value) => String(value ?? "").trim().toLowerCase(),
    readJsonBody,
    saveBackendCache: contributionStore.saveBackendCache,
    sendJson
  });
  const invalidContribution = await invoke(contributions.handlePartnerContributionFullEntry, {
    operationId: "invalid-money-contribution",
    contribution: {
      fecha: "2026-07-24",
      nombre: "Socio",
      tipo: "Aporte",
      monto: 1.001
    }
  });
  assert.equal(invalidContribution.status, 400);
  assert.equal(contributionStore.value().tables.aportes_socios.rows.length, 0);

  const payrollStore = memoryStore({ tables: {} });
  const payroll = createPayrollExpenseEntryService({
    backendId,
    backendNextNumericId,
    backendNumber,
    ensureBackendTable,
    loadCache: payrollStore.loadCache,
    readJsonBody,
    saveBackendCache: payrollStore.saveBackendCache,
    sendJson
  });
  const invalidPayroll = await invoke(payroll.handlePayrollExpenseEntry, {
    salaryIds: [],
    concepts: [{ type: "labor-social", amount: 1.001 }],
    expense: {
      fecha_factura: "2026-07-31",
      id_etiqueta: 5,
      tipo_factura: "Recibo_Sueldo",
      nro_factura: "JUL-2026",
      subtotal: 1.001,
      total: 1.001
    }
  });
  assert.equal(invalidPayroll.status, 400);
  assert.equal(payrollStore.value().tables.egresos, undefined);
});

test("matching bancario conserva tolerancias de un centavo y cinco pesos", () => {
  const service = createBankMatchingService({
    backendNormalizeText: (value) => String(value ?? "").toLowerCase(),
    backendNumber,
    cleanBackendText: (value) => String(value ?? "").trim(),
    bankDateDistance: () => 0,
    bankMovementBackendCreditorId: () => "",
    normalizeBankCheckNumber: (value) => String(value ?? ""),
    normalizeBankCuit: (value) => String(value ?? ""),
    backendIsoDate: (value) => String(value ?? ""),
    backendId
  });
  const groups = service.backendReceivedCheckDepositGroups({
    cheques_recibidos: {
      rows: [
        { id_cheque_recibido: 1, estado: "Depositado", id_deposito: "d-1", monto: 0.1 },
        { id_cheque_recibido: 2, estado: "Depositado", id_deposito: "d-1", monto: 0.2 }
      ]
    }
  }, "");
  assert.equal(groups[0].amount, 0.3);
  assert.equal(
    service.bankManualCheckDepositMatch(
      { amount: 0.31, detail: "deposito" },
      groups
    )?.id,
    "d-1"
  );
  assert.equal(
    service.bankManualCheckDepositMatch(
      { amount: 0.32, detail: "deposito" },
      groups
    ),
    null
  );

  const candidate = { amount: 100, date: "2026-07-24", party: "", description: "" };
  assert(service.bestBankMatch(
    { amount: 105, date: "2026-07-24" },
    [candidate],
    105,
    {}
  ));
  assert.equal(service.bestBankMatch(
    { amount: 105.01, date: "2026-07-24" },
    [candidate],
    105.01,
    {}
  ), null);
});

test("parser y persistencia bancaria normalizan importes a centavos", () => {
  const parser = createBankParserService({
    backendIsoDate: (value) => String(value ?? ""),
    backendNormalizeText: (value) => String(value ?? "").toLowerCase(),
    backendNumber,
    compactBankText: (value) => String(value ?? "").trim(),
    extractBankCheckNumber: () => "",
    extractBankCuit: () => "",
    normalizeBankCheckNumber: () => "",
    normalizeBankCuit: () => ""
  });
  const movements = parser.parseBankMovements(
    "Fecha;Debito;Credito;Saldo\n2026-07-24;0,10;0,30;0,20"
  );
  assert.equal(movements.length, 1);
  assert.equal(movements[0].amount, 0.2);
  assert.equal(movements[0].balance, 0.2);

  const persistence = createBankPersistenceService({
    backendBankMatches: () => true,
    backendId,
    backendIsoDate: (value) => String(value ?? ""),
    backendNextNumericId,
    backendNormalizeText: (value) => String(value ?? "").toLowerCase(),
    backendNumber,
    crypto,
    normalizeBankCheckNumber: (value) => String(value ?? ""),
    normalizeBankCuit: (value) => String(value ?? "")
  });
  assert.equal(persistence.bankMoneyKey(0.1 + 0.2), 30);
  const tables = { movimientos_bancarios: { rows: [], rowCount: 0 } };
  persistence.persistBankMovement(tables, {
    date: "2026-07-24",
    debit: 0,
    credit: 0.1 + 0.2,
    amount: 0.1 + 0.2,
    balance: 0.1 + 0.2
  }, "ICBC");
  assert.equal(tables.movimientos_bancarios.rows[0].importe, 0.3);
});

test("deposito bancario exige coincidencia exacta en centavos", async () => {
  function depositService(store) {
    return createBankReconciliationService({
      backendId,
      backendNormalizeText: (value) => String(value ?? "").toLowerCase(),
      backendNumber,
      bankMovementFingerprint: (movement, bank) => `${bank}|${movement.date}|${movement.amount}`,
      cleanBackendText: (value) => String(value ?? "").trim(),
      ensureBackendTable,
      loadCache: store.loadCache,
      persistBankMovement: (tables, movement, bank, operationKey, operationPayload) => {
        tables.movimientos_bancarios.rows.push({
          banco: bank,
          fecha: movement.date,
          importe: movement.amount,
          _bankOperationKey: operationKey,
          _bankOperationPayload: operationPayload
        });
      },
      readJsonBody,
      saveBackendCache: store.saveBackendCache,
      sendJson
    });
  }

  const seed = {
    tables: {
      cheques_recibidos: {
        rows: [
          { id_cheque_recibido: 1, estado: "Pendiente", monto: 0.1 },
          { id_cheque_recibido: 2, estado: "Pendiente", monto: 0.2 }
        ]
      },
      movimientos_bancarios: { rows: [] }
    }
  };
  const acceptedStore = memoryStore(seed);
  const accepted = await invoke(
    depositService(acceptedStore).handleBankReconciliationDepositChecks,
    {
      bank: "ICBC",
      depositDate: "2026-07-24",
      checkIds: [1, 2],
      movement: { date: "2026-07-24", amount: 0.3, credit: 0.3 }
    }
  );
  assert.equal(accepted.status, 200);
  assert.equal(accepted.payload.amount, 0.3);

  const rejectedStore = memoryStore(seed);
  const rejected = await invoke(
    depositService(rejectedStore).handleBankReconciliationDepositChecks,
    {
      bank: "ICBC",
      depositDate: "2026-07-24",
      checkIds: [1, 2],
      movement: { date: "2026-07-24", amount: 0.31, credit: 0.31 }
    }
  );
  assert.equal(rejected.status, 400);

  for (const incompatible of [
    { estado: "Endosado", id_pago_endoso: 9 },
    { estado: "Depositado", id_deposito: "deposito-anterior" },
    { estado: "Cobrado" },
    { estado: "Descontado" },
    { estado: "Perdido" },
    { estado: "Pendiente", fecha_endoso: "2026-07-20" }
  ]) {
    const blockedSeed = JSON.parse(JSON.stringify(seed));
    Object.assign(blockedSeed.tables.cheques_recibidos.rows[0], incompatible);
    const blockedStore = memoryStore(blockedSeed);
    const blocked = await invoke(
      depositService(blockedStore).handleBankReconciliationDepositChecks,
      {
        bank: "ICBC",
        depositDate: "2026-07-24",
        checkIds: [1],
        manualDeposit: true
      }
    );
    assert.equal(blocked.status, 409);
    assert.deepEqual(blockedStore.value(), blockedSeed);
  }
});

test("pedido persiste precio monetario y bonificacion porcentual sin mezclarlos", async () => {
  const store = memoryStore({
    tables: {
      clientes: { rows: [{ id_cliente: 1 }] },
      productos: { rows: [{ id_producto: 1 }] },
      pedidos: { rows: [] },
      detalle_pedidos: { rows: [] }
    }
  });
  const service = createSalesOrderEntryService({
    backendId,
    backendNextNumericId,
    backendNumber,
    ensureBackendTable,
    isIsoDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
    loadCache: store.loadCache,
    readJsonBody,
    saveBackendCache: store.saveBackendCache,
    sendJson
  });
  const result = await invoke(service.handleSalesOrderFullEntry, {
    order: {
      idCliente: 1,
      fechaPedido: "2026-07-24",
      fechaEntrega: "2026-07-25"
    },
    details: [{
      idProducto: 1,
      cantidadCajas: 1,
      impuesto: "A",
      precioUd: 397055.25,
      bonificacion: "0,30"
    }]
  });
  assert.equal(result.status, 200);
  assert.equal(store.value().tables.detalle_pedidos.rows[0].precio_ud, 397055.25);
  assert.equal(store.value().tables.detalle_pedidos.rows[0].bonificacion, 0.3);
});

test("endoso compara el total exacto de cheques y pago en centavos", () => {
  const previousRows = [
    { id_cheque_recibido: 1, estado: "Pendiente", monto: 0.1 },
    { id_cheque_recibido: 2, estado: "Pendiente", monto: 0.2 }
  ];
  const payment = { id_pago: 9, metodo: "Endoso", monto: 0.3 };
  const endorsedRows = previousRows.map((row) => ({
    ...row,
    estado: "Endosado",
    id_pago_endoso: 9,
    fecha_endoso: "2026-07-24"
  }));
  assert.doesNotThrow(() => validateReceivedCheckEndorsementOperation({
    previousRows,
    endorsedRows,
    payment,
    payments: []
  }));
  assert.throws(
    () => validateReceivedCheckEndorsementOperation({
      previousRows,
      endorsedRows,
      payment: { ...payment, monto: 0.31 },
      payments: []
    }),
    (error) => error.code === "RECEIVED_CHECK_ENDORSEMENT_TOTAL_MISMATCH"
  );
});
