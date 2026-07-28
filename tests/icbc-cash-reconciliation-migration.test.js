const assert = require("assert");
const test = require("node:test");
const { EXPECTED_BACKEND_COLUMNS } = require("../backend/config/backend-columns");
const {
  createBackupManifest,
  migrateIcBcCashReconciliation,
  rollbackIcBcCashReconciliation,
  verifyBackup
} = require("../backend/migrations/20260728-icbc-cash-reconciliation");

function fixture() {
  return {
    generatedAt: "fixture",
    tables: {
      pagos: table(EXPECTED_BACKEND_COLUMNS.pagos, [
        payment(10, "2026-07-03", "Transferencia", "ICBC", 12000000),
        payment(20, "2026-05-15", "Echeq", "", 100),
        payment(21, "2026-06-09", "Echeq Debitado", "ICBC", 100),
        payment(22, "2026-05-20", "Cheque", "", 200),
        payment(30, "2024-03-14", "Movimiento bancario", "ICBC", 300)
      ]),
      detalle_pagos: table(EXPECTED_BACKEND_COLUMNS.detalle_pagos, [
        { id_detalle_pago: 1, id_pago: 20, id_egreso: 900, monto_cancelado: 100 },
        { id_detalle_pago: 2, id_pago: 21, id_egreso: "", monto_cancelado: 100 },
        { id_detalle_pago: 3, id_pago: 22, id_egreso: 901, monto_cancelado: 200 }
      ]),
      movimientos_bancarios: table(EXPECTED_BACKEND_COLUMNS.movimientos_bancarios, [
        bankMovement(1, "2026-07-03", 12000000, 0, "", 1, ""),
        bankMovement(2, "2026-07-08", 0, 5000000.19, "", 2, ""),
        bankMovement(3, "2026-06-09", 100, 0, 20, "", "1001"),
        bankMovement(4, "2026-06-23", 200, 0, 22, "", "1002"),
        bankMovement(5, "2026-07-16", 300, 0, 30, "", "")
      ]),
      fondos_inversion_movimientos: table(
        EXPECTED_BACKEND_COLUMNS.fondos_inversion_movimientos.filter((column) => column !== "id_pago"),
        [
          fundMovement(1, "2026-07-01", "deposito", 12000000, 1),
          fundMovement(2, "2026-07-08", "rescate", 5000000.19, 2),
          fundMovement(3, "2026-07-08", "rendimiento", 10, "")
        ]
      ),
      cheques_entregados: table(EXPECTED_BACKEND_COLUMNS.cheques_entregados, [
        issuedCheck(1, 20, "1001", 100),
        issuedCheck(2, 22, "1002", 200)
      ])
    }
  };
}

function table(headers, rows) {
  return { headers: [...headers], rows, rowCount: rows.length };
}

function payment(id, date, method, bank, amount) {
  return {
    id_pago: id,
    fecha_pago: date,
    metodo: method,
    banco: bank,
    monto: amount
  };
}

function bankMovement(id, date, debit, credit, paymentId, fundId, checkNumber) {
  return {
    id_movimiento_bancario: id,
    banco: "ICBC",
    fecha: date,
    detalle: checkNumber ? `CH CAMARA ${checkNumber}` : fundId === 1 ? "DEB SUSCR FCI" : "CRED RESC FCI",
    nro_cheque: checkNumber,
    debito: debit,
    credito: credit,
    importe: credit - debit,
    id_pago: paymentId,
    id_cobro: "",
    id_movimiento_fondo: fundId
  };
}

function fundMovement(id, date, type, amount, bankMovementId) {
  return {
    id_movimiento_fondo: id,
    fecha: date,
    tipo: type,
    importe: amount,
    periodo_rendimiento: type === "rendimiento" ? "2026-07" : "",
    id_movimiento_bancario: bankMovementId,
    id_gasto_economico: type === "rendimiento" ? 50 : "",
    clave_idempotencia: `fund-${id}`
  };
}

function issuedCheck(id, paymentId, number, amount) {
  return {
    id_cheque_entregado: id,
    id_pago: paymentId,
    nro_cheque: number,
    fecha_entregado: "2026-05-01",
    fecha_uso: "2026-06-08",
    monto: amount,
    banco: "ICBC",
    estado: "Debitado"
  };
}

test("backfill ICBC es exacto, idempotente y reversible", () => {
  const source = fixture();
  const first = migrateIcBcCashReconciliation(source, { timestamp: "2026-07-28T15:00:00.000Z" });
  assert.deepStrictEqual(first.report, {
    migrationId: "20260728-icbc-cash-reconciliation",
    action: "migrate",
    fundColumnAdded: true,
    fundPaymentsCreated: 1,
    fundPaymentsReused: 1,
    issuedCheckPaymentsCreated: 1,
    issuedCheckPaymentsReused: 1,
    bankDebitPaymentsCreated: 1,
    bankDebitPaymentsReused: 0,
    bankLinksReassigned: 3,
    exclusions: [],
    idempotent: false
  });
  assert.strictEqual(source.tables.fondos_inversion_movimientos.headers.includes("id_pago"), false);
  assert.strictEqual(first.cache.tables.fondos_inversion_movimientos.headers.includes("id_pago"), true);

  const [deposit, rescue, yieldMovement] = first.cache.tables.fondos_inversion_movimientos.rows;
  assert.strictEqual(String(deposit.id_pago), "10");
  assert.ok(rescue.id_pago);
  assert.ok(!yieldMovement.id_pago);
  const rescuePayment = first.cache.tables.pagos.rows.find((row) => String(row.id_pago) === String(rescue.id_pago));
  assert.strictEqual(rescuePayment.monto, -5000000.19);
  assert.strictEqual(rescuePayment.banco, "ICBC");
  assert.strictEqual(first.cache.tables.movimientos_bancarios.rows[1].id_pago, rescue.id_pago);
  assert.strictEqual(first.cache.tables.movimientos_bancarios.rows[1].id_movimiento_fondo, 2);

  assert.strictEqual(String(first.cache.tables.movimientos_bancarios.rows[2].id_pago), "21");
  assert.notStrictEqual(String(first.cache.tables.movimientos_bancarios.rows[3].id_pago), "22");
  assert.notStrictEqual(String(first.cache.tables.movimientos_bancarios.rows[4].id_pago), "30");
  assert.strictEqual(first.cache.tables.cheques_entregados.rows[0]._bankDebitPaymentId, "21");
  assert.ok(first.cache.tables.cheques_entregados.rows[1]._bankDebitPaymentId);
  const bankDebitPayment = first.cache.tables.pagos.rows.find((row) => (
    String(row.id_pago) === String(first.cache.tables.movimientos_bancarios.rows[4].id_pago)
  ));
  assert.strictEqual(bankDebitPayment.fecha_pago, "2026-07-16");
  assert.strictEqual(bankDebitPayment.monto, 300);
  assert.strictEqual(bankDebitPayment._icbcCashBackfillKind, "bank_debit");

  const second = migrateIcBcCashReconciliation(first.cache, { timestamp: "2026-07-28T16:00:00.000Z" });
  assert.strictEqual(second.report.idempotent, true);
  assert.deepStrictEqual(second.cache, first.cache);

  const rolledBack = rollbackIcBcCashReconciliation(first.cache);
  assert.strictEqual(rolledBack.cache.tables.pagos.rows.length, source.tables.pagos.rows.length);
  assert.strictEqual(rolledBack.cache.tables.fondos_inversion_movimientos.headers.includes("id_pago"), false);
  assert.deepStrictEqual(
    rolledBack.cache.tables.movimientos_bancarios.rows.map((row) => String(row.id_pago || "")),
    source.tables.movimientos_bancarios.rows.map((row) => String(row.id_pago || ""))
  );
});

test("backup verificable detecta cualquier cambio", () => {
  const serialized = Buffer.from(JSON.stringify(fixture(), null, 2));
  const manifest = createBackupManifest(serialized);
  assert.strictEqual(verifyBackup(serialized, manifest), true);
  const changed = Buffer.from(serialized.toString("utf8").replace("12000000", "12000001"));
  assert.throws(() => verifyBackup(changed, manifest), (error) => error.code === "ICBC_BACKUP_MISMATCH");
});

test("una relación ambigua falla sin mutar el origen", () => {
  const source = fixture();
  source.tables.pagos.rows.push(payment(30, "2026-07-03", "Movimiento bancario", "ICBC", 12000000));
  const before = JSON.stringify(source);
  assert.throws(
    () => migrateIcBcCashReconciliation(source),
    (error) => error.code === "ICBC_FUND_PAYMENT_AMBIGUOUS"
  );
  assert.strictEqual(JSON.stringify(source), before);
});

test("un rendimiento con pago histórico se rechaza", () => {
  const source = fixture();
  source.tables.fondos_inversion_movimientos.rows[2].id_pago = 99;
  assert.throws(
    () => migrateIcBcCashReconciliation(source),
    (error) => error.code === "ICBC_FUND_YIELD_HAS_PAYMENT"
  );
});
