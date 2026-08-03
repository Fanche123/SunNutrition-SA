const assert = require("assert");
const test = require("node:test");
const { EXPECTED_BACKEND_COLUMNS } = require("../backend/config/backend-columns");
const {
  OPENING_CENTS,
  createBackupManifest,
  migrateCashLedger,
  rollbackCashLedger,
  verifyBackup
} = require("../backend/migrations/20260803-cash-ledger");
const {
  appendCashSourceMovement,
  assertCashSourceMovement,
  canonicalCashMethod,
  cashLedgerSnapshot,
  reconcileCashSourceRows
} = require("../backend/services/cash-ledger.service");
const { createCollectionEntryService } = require("../backend/services/collection-entry.service");
const { createPaymentEntryService } = require("../backend/services/payment-entry.service");
const { backendNextNumericId, ensureBackendTable } = require("../backend/utils/runtime");
const { createBackendTableService } = require("../backend/services/backend-table.service");

function fixture() {
  return {
    generatedAt: "fixture",
    tables: {
      cobros: {
        headers: EXPECTED_BACKEND_COLUMNS.cobros,
        rows: [{ id_cobro: 798, fecha_cobro: "2026-08-02", metodo: "Efectivo", monto: 999999 }],
        rowCount: 1
      },
      pagos: {
        headers: EXPECTED_BACKEND_COLUMNS.pagos,
        rows: [{ id_pago: 5925, fecha_pago: "2026-08-02", metodo: "Efectivo", monto: 888888 }],
        rowCount: 1
      }
    }
  };
}

test("inicializa exactamente ARS 145.000 y registra cortes sin backfill", () => {
  const source = fixture();
  const before = JSON.stringify(source);
  const first = migrateCashLedger(source, { registeredAt: "2026-08-03T15:00:00.000Z" });
  const second = migrateCashLedger(first.cache, { registeredAt: "2026-08-03T16:00:00.000Z" });
  const snapshot = cashLedgerSnapshot(first.cache);
  assert.equal(snapshot.balanceCents, OPENING_CENTS);
  assert.equal(snapshot.movements.length, 1);
  assert.deepEqual(snapshot.cutoff, {
    collectionId: "798",
    paymentId: "5925",
    registeredAt: "2026-08-03T15:00:00.000Z"
  });
  assert.equal(first.report.initialized, true);
  assert.equal(second.report.initialized, false);
  assert.deepEqual(second.cache, first.cache);
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(rollbackCashLedger(first.cache).cache, source);
});

test("backup verificable detecta cualquier alteración", () => {
  const source = Buffer.from(JSON.stringify(fixture()));
  const manifest = createBackupManifest(source);
  assert.equal(verifyBackup(source, manifest), true);
  assert.throws(() => verifyBackup(Buffer.concat([source, Buffer.from(" ")]), manifest), /backup/i);
});

test("cobro suma, pago resta, reintento no duplica y otros métodos no impactan", () => {
  const cache = migrateCashLedger(fixture(), { registeredAt: "2026-08-03T15:00:00.000Z" }).cache;
  const collection = { id_cobro: 799, fecha_cobro: "2026-08-03", metodo: "Efectivo", monto: 2500 };
  const payment = { id_pago: 5926, fecha_pago: "2026-08-03", metodo: "Efectivo", monto: 700 };
  appendCashSourceMovement(cache, { sourceType: "cobro", sourceRow: collection, operationId: "cobro-799" });
  appendCashSourceMovement(cache, { sourceType: "cobro", sourceRow: collection, operationId: "cobro-799" });
  appendCashSourceMovement(cache, { sourceType: "pago", sourceRow: payment, operationId: "pago-5926" });
  appendCashSourceMovement(cache, {
    sourceType: "cobro",
    sourceRow: { id_cobro: 800, fecha_cobro: "2026-08-03", metodo: "Transferencia", monto: 9999 },
    operationId: "cobro-800"
  });
  const snapshot = cashLedgerSnapshot(cache);
  assert.equal(snapshot.balanceCents, OPENING_CENTS + 250000 - 70000);
  assert.equal(snapshot.movements.length, 3);
  assert.equal(canonicalCashMethod(" Efectivo "), "efectivo");
  for (const method of ["Extraccion_Efectivo", "Efectivo + Cheque", "Transferencia", "Cheque", "Echeq"]) {
    assert.equal(canonicalCashMethod(method), "");
  }
});

test("baja o modificación de fuente genera compensación append-only", () => {
  const cache = migrateCashLedger(fixture(), { registeredAt: "2026-08-03T15:00:00.000Z" }).cache;
  const payment = { id_pago: 5926, fecha_pago: "2026-08-03", metodo: "Efectivo", monto: 700 };
  appendCashSourceMovement(cache, { sourceType: "pago", sourceRow: payment, operationId: "pago-5926" });
  reconcileCashSourceRows(cache, "pago", [payment], [], { operationId: "baja-pago-5926" });
  reconcileCashSourceRows(cache, "pago", [payment], [], { operationId: "baja-pago-5926" });
  const snapshot = cashLedgerSnapshot(cache);
  assert.equal(snapshot.balanceCents, OPENING_CENTS);
  assert.deepEqual(snapshot.movements.map((row) => row.amountCents), [OPENING_CENTS, -70000, 70000]);
  assert.throws(() => rollbackCashLedger(cache), /movimientos posteriores/i);
});

test("el corte bloquea backfill y una fuente post-corte que pasa a Efectivo se incorpora", () => {
  const cache = migrateCashLedger(fixture(), { registeredAt: "2026-08-03T15:00:00.000Z" }).cache;
  const historical = { id_cobro: 500, fecha_cobro: "2026-08-03", metodo: "Efectivo", monto: 100 };
  assert.equal(appendCashSourceMovement(cache, { sourceType: "cobro", sourceRow: historical, operationId: "historical-retry" }), null);
  assert.equal(assertCashSourceMovement(cache, { sourceType: "cobro", sourceRow: historical, operationId: "historical-retry" }), true);
  reconcileCashSourceRows(
    cache,
    "cobro",
    [{ id_cobro: 799, fecha_cobro: "2026-08-03", metodo: "Transferencia", monto: 250 }],
    [{ id_cobro: 799, fecha_cobro: "2026-08-03", metodo: "Efectivo", monto: 250 }],
    { operationId: "admin-change-799" }
  );
  assert.equal(cashLedgerSnapshot(cache).balanceCents, OPENING_CENTS + 25000);
  assert.equal(cashLedgerSnapshot(cache).movements.length, 2);
});

test("el endpoint genérico rechaza cualquier mutación del libro incluso para owner", async () => {
  const service = createBackendTableService({ sendJson: (response, status, payload) => response.json(status, payload) });
  let result;
  await service.handleBackendTableSave({
    url: "/api/backend/tables/caja_efectivo_movimientos",
    headers: { host: "127.0.0.1" },
    accessIdentity: { user: { role: "owner" } }
  }, { json(status, payload) { result = { status, payload }; } });
  assert.equal(result.status, 403);
  assert.equal(result.payload.code, "CASH_LEDGER_APPEND_ONLY");
});

test("los flujos confirmados guardan fuente y caja en el mismo snapshot; una falla no mueve saldo", async () => {
  const seed = migrateCashLedger({
    tables: {
      cobros: { headers: EXPECTED_BACKEND_COLUMNS.cobros, rows: [], rowCount: 0 },
      pagos: { headers: EXPECTED_BACKEND_COLUMNS.pagos, rows: [], rowCount: 0 },
      ventas: { headers: ["id_venta", "total"], rows: [{ id_venta: 1, total: 1000 }], rowCount: 1 },
      egresos: { headers: ["id_egreso", "total"], rows: [{ id_egreso: 1, total: 300 }], rowCount: 1 }
    }
  }, { registeredAt: "2026-08-03T15:00:00.000Z" }).cache;
  let persisted = JSON.parse(JSON.stringify(seed));
  const dependencies = {
    backendId: (value) => String(value ?? "").trim(),
    backendNextNumericId,
    backendNumber: (value) => Number(value) || 0,
    ensureBackendTable,
    loadCache: () => JSON.parse(JSON.stringify(persisted)),
    readJsonBody: async (request) => request.body,
    saveBackendCache: (cache) => { persisted = JSON.parse(JSON.stringify(cache)); },
    sendJson: (response, status, payload) => response.json(status, payload)
  };
  const invoke = async (handler, body) => {
    let result;
    await handler({ body, accessIdentity: { user: { id: "u1", displayName: "Usuario prueba" } } }, {
      json(status, payload) { result = { status, payload }; }
    });
    return result;
  };
  const collectionService = createCollectionEntryService(dependencies);
  const collectionBody = {
    operationId: "cash-collection-1",
    collection: { fecha: "2026-08-03", metodo: "Efectivo", idCliente: 1, monto: 1000 },
    details: [{ idVenta: 1, monto: 1000 }],
    retentions: {}
  };
  assert.equal((await invoke(collectionService.handleCollectionFullEntry, collectionBody)).status, 200);
  assert.equal((await invoke(collectionService.handleCollectionFullEntry, collectionBody)).payload.idempotent, true);

  const paymentService = createPaymentEntryService(dependencies);
  const paymentBody = {
    operationId: "cash-payment-1",
    payment: { fecha: "2026-08-03", metodo: "Efectivo" },
    details: [{ idEgreso: 1, monto: 300 }]
  };
  assert.equal((await invoke(paymentService.handlePaymentFullEntry, paymentBody)).status, 200);
  assert.equal((await invoke(paymentService.handlePaymentFullEntry, paymentBody)).payload.idempotent, true);
  assert.equal(cashLedgerSnapshot(persisted).balanceCents, OPENING_CENTS + 100000 - 30000);
  assert.deepEqual(
    cashLedgerSnapshot(persisted).movements.slice(1).map((row) => [row.sourceType, row.sourceId, row.actor]),
    [["cobro", "1", "Usuario prueba"], ["pago", "1", "Usuario prueba"]]
  );

  const beforeFailure = JSON.stringify(persisted);
  const failed = createCollectionEntryService({
    ...dependencies,
    failureInjector(point) { if (point === "after-details") throw new Error("falla inyectada"); }
  });
  const failedBody = {
    operationId: "cash-collection-failed",
    collection: { fecha: "2026-08-03", metodo: "Efectivo", idCliente: 1, monto: 1 },
    details: [{ idVenta: 1, monto: 1 }],
    retentions: {}
  };
  assert.equal((await invoke(failed.handleCollectionFullEntry, failedBody)).status, 400);
  assert.equal(JSON.stringify(persisted), beforeFailure);
});
