const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const vm = require("vm");
const { createCashBoxesService } = require("../backend/services/cash-boxes.service");
const { backendId, backendGroupRowsById, backendRowsById } = require("../backend/utils/ids");
const { backendBankMatches: rawBackendBankMatches } = require("../backend/utils/bank");

const backendNormalizeText = (value) => String(value || "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .trim()
  .toLowerCase();
const backendBankMatches = (value, bank) => rawBackendBankMatches(value, bank, backendNormalizeText);
const backendIsoDate = (value) => {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === text ? text : "";
};

function serviceFor(cache) {
  return createCashBoxesService({
    backendBankMatches,
    backendExpenseCounterpartyInfo: (expense) => ({
      name: expense._counterparty || "",
      cuit: "",
      detail: ""
    }),
    backendGroupRowsById,
    backendId,
    backendIsoDate,
    backendNormalizeText,
    backendRowsById,
    canonicalPendingBankMovements: (tables, bank) => (
      (tables.movimientos_bancarios?.rows || [])
        .filter((row) => backendBankMatches(row.banco, bank))
        .filter((row) => !backendId(row.id_pago) && !backendId(row.id_cobro) && !backendId(row.id_movimiento_fondo))
        .map((row) => ({
          canonicalMovementId: backendId(row.id_movimiento_bancario),
          concept: row.concepto || "",
          bankConcept: row.concepto || "",
          detail: row.detalle || "",
          channel: row._bankChannel || "",
          amount: row.importe,
          debit: Math.abs(Number(row.debito || (Number(row.importe) < 0 ? row.importe : 0))),
          credit: Math.abs(Number(row.credito || (Number(row.importe) > 0 ? row.importe : 0))),
          date: backendIsoDate(row.fecha),
          movementKey: row._bankMovementKey || ""
        }))
    ),
    loadCache: () => cache,
    sendJson: (response, status, payload) => response.json(status, payload)
  });
}

function fixture() {
  return {
    tables: {
      clientes: {
        rows: [
          { id_cliente: 1, nombre_cliente: "Cliente asociado" },
          { id_cliente: 2, nombre_cliente: "Cliente pendiente" },
          { id_cliente: 3, nombre_cliente: "Cliente previo" }
        ]
      },
      cobros: {
        rows: [
          { id_cobro: 1, fecha_cobro: "2026-06-09", metodo: "Transferencia", banco: "ICBC", id_cliente: 1, monto: 100.10 },
          { id_cobro: 2, fecha_cobro: "2026-06-10", metodo: "Efectivo", banco: "", id_cliente: 2, monto: 50 },
          { id_cobro: 3, fecha_cobro: "2026-06-08", metodo: "Transferencia", banco: "ICBC", id_cliente: 3, monto: 999 }
        ]
      },
      cobros_detalle: {
        rows: [
          { id_cobros_detalle: 1, id_cobro: 1, id_venta: 10, monto_cancelado: 60 },
          { id_cobros_detalle: 2, id_cobro: 1, id_venta: 11, monto_cancelado: 40.10 }
        ]
      },
      pagos: {
        rows: [
          { id_pago: 10, fecha_pago: "2026-06-09", metodo: "Transferencia", banco: "ICBC", monto: 25.05 },
          { id_pago: 11, fecha_pago: "2026-06-11", metodo: "Cheque", banco: "", monto: 20 },
          { id_pago: 12, fecha_pago: "2026-06-12", metodo: "Efectivo", banco: "", monto: -5 }
        ]
      },
      detalle_pagos: {
        rows: [
          { id_detalle_pago: 1, id_pago: 10, id_egreso: 100, monto_cancelado: 10 },
          { id_detalle_pago: 2, id_pago: 10, id_egreso: 101, monto_cancelado: 15.05 },
          { id_detalle_pago: 3, id_pago: 11, id_egreso: 102, monto_cancelado: 20 },
          { id_detalle_pago: 4, id_pago: 12, id_egreso: 103, monto_cancelado: -5 }
        ]
      },
      egresos: {
        rows: [
          { id_egreso: 100, _counterparty: "Proveedor A" },
          { id_egreso: 101, _counterparty: "Proveedor B" },
          { id_egreso: 102, _counterparty: "Proveedor C" },
          { id_egreso: 103, _counterparty: "Reversión" }
        ]
      },
      movimientos_bancarios: {
        rows: [
          {
            id_movimiento_bancario: 1,
            banco: "ICBC",
            fecha: "2026-06-09",
            importe: 100.10,
            saldo: 3801230.15,
            id_cobro: 1,
            id_pago: "",
            id_movimiento_fondo: "",
            _bankImportedAt: "2026-06-09T10:00:00.000Z"
          },
          {
            id_movimiento_bancario: 2,
            banco: "ICBC",
            fecha: "2026-06-09",
            debito: 25.05,
            credito: 0,
            importe: -25.05,
            saldo: 3801205.10,
            id_cobro: "",
            id_pago: 10,
            id_movimiento_fondo: "",
            _bankImportedAt: "2026-06-09T11:00:00.000Z"
          },
          {
            id_movimiento_bancario: 3,
            banco: "ICBC",
            fecha: "2026-06-12",
            concepto: "Suscripción FCI",
            detalle: "Fondo",
            importe: -1000,
            saldo: 3800240.10,
            id_cobro: "",
            id_pago: "",
            id_movimiento_fondo: 7,
            _bankImportedAt: "2026-06-12T09:00:00.000Z"
          },
          {
            id_movimiento_bancario: 4,
            banco: "ICBC",
            fecha: "2026-06-13",
            concepto: "Comisión",
            detalle: "Gasto bancario",
            importe: -10,
            saldo: 3800230.10,
            id_cobro: "",
            id_pago: "",
            id_movimiento_fondo: "",
            _bankImportedAt: "2026-06-13T09:00:00.000Z"
          },
          {
            id_movimiento_bancario: 99,
            banco: "GAL",
            fecha: "2099-01-01",
            importe: 999,
            saldo: 999999,
            id_cobro: 2,
            id_pago: "",
            id_movimiento_fondo: ""
          }
        ]
      }
    }
  };
}

test("calcula Saldo ICBC en centavos, incluye 09/06 y sólo atribuye cobros legítimos", () => {
  const snapshot = serviceFor(fixture()).buildCashBoxSnapshot(fixture(), "icbc");

  assert.equal(snapshot.rule.initialBalanceCents, 380113005);
  assert.equal(snapshot.summary.collectionCount, 1);
  assert.equal(snapshot.summary.collectionTotalCents, 10010);
  assert.equal(snapshot.summary.paymentCount, 1);
  assert.equal(snapshot.summary.paymentTotalCents, 2505);
  assert.equal(snapshot.summary.calculatedBalanceCents, 380120510);
  assert.equal(snapshot.summary.latestBankMovement.id, "4");
  assert.equal(snapshot.summary.latestBankMovement.balanceCents, 380023010);
  assert.equal(snapshot.summary.differenceCents, -97500);
  assert.equal(snapshot.summary.status, "difference");
});

test("usa el orden fuente descendente estable, no importación ni posición, para el último saldo del mismo día", () => {
  const cache = fixture();
  cache.tables.movimientos_bancarios.rows.push(
    {
      id_movimiento_bancario: 50,
      banco: "ICBC",
      fecha: "2026-06-14",
      importe: 1,
      saldo: 10,
      _bankSourceOrder: 3,
      _bankImportedAt: "2099-01-01T00:00:00.000Z"
    },
    {
      id_movimiento_bancario: 5,
      banco: "ICBC",
      fecha: "2026-06-14",
      importe: 1,
      saldo: 20,
      _bankSourceOrder: 2,
      _bankImportedAt: "2000-01-01T00:00:00.000Z"
    }
  );

  const latest = serviceFor(cache).buildCashBoxSnapshot(cache, "icbc").summary.latestBankMovement;
  assert.equal(latest.id, "5");
  assert.equal(latest.balanceCents, 2000);
});

test("separa asociaciones reales, sugerencias y vínculos de otros bancos", () => {
  const cache = fixture();
  cache.tables.cobros.rows[1]._suggestedBankMovementId = 4;
  const snapshot = serviceFor(cache).buildCashBoxSnapshot(cache, "icbc");

  assert.deepEqual(snapshot.erpToBank.collections.map((row) => row.id), []);
  assert.deepEqual(snapshot.erpToBank.payments.map((row) => row.id), []);
  assert.equal(snapshot.bankToErp.pendingCount, 1);
  assert.equal(snapshot.bankToErp.pendingGrossCents, 1000);
  assert.equal(snapshot.bankToErp.classifications[0].classification, "Gasto bancario sin vínculo");
  assert.ok(snapshot.bankToErp.gapFactors.some((item) => item.classification === "Fondo de inversión asociado"));
});

test("diferencia soporta resultado positivo, negativo y cero con asociaciones pendientes", () => {
  for (const [offsetCents, expectedStatus] of [[100, "difference"], [-100, "difference"], [0, "balanced_with_pending_associations"]]) {
    const cache = fixture();
    const service = serviceFor(cache);
    const calculated = service.buildCashBoxSnapshot(cache, "icbc").summary.calculatedBalanceCents;
    const last = cache.tables.movimientos_bancarios.rows.find((row) => row.id_movimiento_bancario === 4);
    last.saldo = (calculated + offsetCents) / 100;
    const snapshot = service.buildCashBoxSnapshot(cache, "icbc");
    assert.equal(snapshot.summary.differenceCents, offsetCents);
    assert.equal(snapshot.summary.status, expectedStatus);
  }
});

test("expone pendientes Banco → ERP por signo, con totales, filas y el mismo corte", () => {
  const cache = fixture();
  cache.tables.movimientos_bancarios.rows.push(
    {
      id_movimiento_bancario: 5,
      banco: "ICBC",
      fecha: "2026-06-12",
      concepto: "Transferencia recibida",
      detalle: "Cliente sin asociación",
      credito: 30,
      debito: 0,
      importe: 30,
      saldo: 3800260.10
    },
    {
      id_movimiento_bancario: 6,
      banco: "ICBC",
      fecha: "2026-06-12",
      concepto: "Pago proveedor",
      detalle: "Proveedor sin asociación",
      credito: 0,
      debito: 12,
      importe: -12,
      saldo: 3800248.10
    },
    {
      id_movimiento_bancario: 7,
      banco: "ICBC",
      fecha: "2026-06-12",
      concepto: "Cobro asociado",
      credito: 99,
      importe: 99,
      id_cobro: 1,
      saldo: 3800347.10
    },
    {
      id_movimiento_bancario: 8,
      banco: "ICBC",
      fecha: "2026-06-14",
      concepto: "Movimiento posterior al corte seleccionado",
      credito: 500,
      importe: 500,
      saldo: 999,
      _bankSourceOrder: 99
    }
  );
  cache.tables.movimientos_bancarios.rows.find((row) => row.id_movimiento_bancario === 4)._bankSourceOrder = 1;
  cache.tables.movimientos_bancarios.rows.find((row) => row.id_movimiento_bancario === 8)._bankSourceOrder = 1;

  const snapshot = serviceFor(cache).buildCashBoxSnapshot(cache, "icbc");

  assert.equal(snapshot.summary.latestBankMovement.id, "8");
  assert.equal(snapshot.bankToErp.pendingCreditCount, 2);
  assert.equal(snapshot.bankToErp.pendingCreditTotalCents, 53000);
  assert.equal(snapshot.bankToErp.pendingDebitCount, 2);
  assert.equal(snapshot.bankToErp.pendingDebitTotalCents, 2200);
  assert.equal(snapshot.bankToErp.pendingNetCents, 50800);
  assert.equal(
    snapshot.bankToErp.credits.reduce((total, row) => total + row.amountCents, 0),
    snapshot.bankToErp.pendingCreditTotalCents
  );
  assert.equal(
    snapshot.bankToErp.debits.reduce((total, row) => total + row.amountCents, 0),
    snapshot.bankToErp.pendingDebitTotalCents
  );
  assert.equal(snapshot.bankToErp.credits.some((row) => row.id === "7"), false);
  assert.match(snapshot.bankToErp.credits[0].reason, /Sin id_cobro/);
  assert.match(snapshot.bankToErp.debits[0].reason, /Sin id_pago/);
  assert.equal(
    snapshot.bankToErp.pendingNetGapCents,
    snapshot.bankToErp.pendingNetCents - snapshot.erpToBank.pendingNetCents
  );
});

test("saldo cero con pendientes conserva estado de asociaciones incompletas", () => {
  const cache = fixture();
  const service = serviceFor(cache);
  const calculated = service.buildCashBoxSnapshot(cache, "icbc").summary.calculatedBalanceCents;
  cache.tables.movimientos_bancarios.rows.find((row) => row.id_movimiento_bancario === 4).saldo = calculated / 100;

  const snapshot = service.buildCashBoxSnapshot(cache, "icbc");
  assert.equal(snapshot.summary.differenceCents, 0);
  assert.equal(snapshot.summary.status, "balanced_with_pending_associations");
});

test("endpoint valida box y entrega sólo el snapshot focalizado", async () => {
  const cache = fixture();
  const service = serviceFor(cache);
  const invoke = async (url) => {
    let result;
    await service.handleCashBoxesGet(
      { url },
      { json(status, payload) { result = { status, payload }; } }
    );
    return result;
  };

  const invalid = await invoke("/api/treasury/cash-boxes?box=desconocida");
  assert.equal(invalid.status, 400);
  const valid = await invoke("/api/treasury/cash-boxes?box=icbc");
  assert.equal(valid.status, 200);
  assert.equal(valid.payload.ok, true);
  assert.equal(Object.hasOwn(valid.payload, "tables"), false);
  assert.equal(JSON.stringify(valid.payload).includes("cobros_detalle"), false);
});

test("reconoce cheques y eCheq sólo por depósito canónico, fecha y banco destino", () => {
  const cache = fixture();
  cache.tables.cobros.rows.push(
    { id_cobro: 20, fecha_cobro: "2026-06-10", metodo: "Cheque", banco: "ICBC", id_cliente: 1, monto: 300 },
    { id_cobro: 21, fecha_cobro: "2026-06-11", metodo: "eCheq", banco: "ICBC", id_cliente: 1, monto: 400 },
    { id_cobro: 22, fecha_cobro: "2026-06-12", metodo: "Transferencia + Cheque", banco: "ICBC", id_cliente: 1, monto: 150 }
  );
  cache.tables.cheques_recibidos = {
    rows: [
      { id_cheque_recibido: 1, id_cobro: 20, monto: 300, estado: "Pendiente", banco: "ICBC" },
      {
        id_cheque_recibido: 2,
        id_cobro: 21,
        monto: 400,
        estado: "Acreditado",
        banco: "ICBC",
        id_deposito: "deposito-echeq-1",
        fecha_deposito: "2026-06-20"
      },
      {
        id_cheque_recibido: 3,
        id_cobro: 22,
        monto: 50,
        estado: "Depositado",
        banco: "ICBC",
        id_deposito: "deposito-fisico-1",
        fecha_deposito: "2026-06-21"
      },
      {
        id_cheque_recibido: 4,
        id_cobro: 20,
        monto: 25,
        estado: "Depositado",
        banco: "GAL",
        id_deposito: "deposito-otro-banco",
        fecha_deposito: "2026-06-22"
      },
      { id_cheque_recibido: 5, id_cobro: 21, monto: 10, estado: "Pendiente", banco: "ICBC" }
    ]
  };
  cache.tables.movimientos_bancarios.rows.push({
    id_movimiento_bancario: 200,
    banco: "ICBC",
    fecha: "2026-06-22",
    importe: 1,
    saldo: 3800231.10,
    _bankSourceOrder: 2
  });

  const snapshot = serviceFor(cache).buildCashBoxSnapshot(cache, "icbc");
  const addedCents = snapshot.summary.collectionTotalCents - 10010;

  assert.equal(addedCents, 55000);
  assert.equal(snapshot.summary.collectionCount, 4);
  assert.ok(snapshot.erpToBank.collections.some((row) => (
    row.id === "deposito-echeq-1" && row.date === "2026-06-20" && row.amountCents === 40000
  )));
  assert.ok(snapshot.erpToBank.collections.some((row) => (
    row.id === "deposito-fisico-1" && row.date === "2026-06-21" && row.amountCents === 5000
  )));
  assert.equal(snapshot.erpToBank.collections.some((row) => row.id === "deposito-otro-banco"), false);
});

test("suma encabezados ICBC, conserva pendientes y excluye efectivo/endoso", () => {
  const cache = fixture();
  cache.tables.pagos.rows.push(
    { id_pago: 30, fecha_pago: "2026-06-10", metodo: "Transferencia", banco: "ICBC", monto: 500 },
    { id_pago: 31, fecha_pago: "2026-06-10", metodo: "Efectivo", banco: "ICBC", monto: 100 },
    { id_pago: 32, fecha_pago: "2026-06-10", metodo: "Endoso", banco: "ICBC", monto: 200 }
  );
  cache.tables.cobros.rows.push(
    { id_cobro: 30, fecha_cobro: "2026-06-10", metodo: "Efectivo", banco: "ICBC", monto: 100 },
    { id_cobro: 31, fecha_cobro: "2026-06-10", metodo: "Endoso", banco: "ICBC", monto: 200 }
  );
  cache.tables.movimientos_bancarios.rows.push({
    id_movimiento_bancario: 201,
    banco: "ICBC",
    fecha: "2026-06-13",
    debito: 0,
    credito: 500,
    importe: 500,
    saldo: 3800730.10,
    id_pago: 30,
    _bankSourceOrder: 1
  });

  const snapshot = serviceFor(cache).buildCashBoxSnapshot(cache, "icbc");
  assert.equal(snapshot.summary.collectionTotalCents, 10010);
  assert.equal(snapshot.summary.paymentTotalCents, 52505);
  assert.equal(snapshot.erpToBank.payments.some((row) => row.id === "30"), false);
  assert.equal(snapshot.erpToBank.payments.some((row) => ["31", "32"].includes(row.id)), false);
});

test("rescates del fondo son pagos negativos y nunca cobros", () => {
  const cache = fixture();
  cache.tables.pagos.rows.push(
    {
      id_pago: 40,
      fecha_pago: "2026-06-12",
      metodo: "Fondo de inversion - Deposito",
      banco: "ICBC",
      monto: 120
    },
    {
      id_pago: 41,
      fecha_pago: "2026-06-13",
      metodo: "Fondo de inversion - Rescate",
      banco: "ICBC",
      monto: -50
    }
  );
  cache.tables.movimientos_bancarios.rows.push(
    {
      id_movimiento_bancario: 210,
      banco: "ICBC",
      fecha: "2026-06-12",
      debito: 120,
      credito: 0,
      importe: -120,
      saldo: 3800110.10,
      id_pago: 40,
      id_movimiento_fondo: 20
    },
    {
      id_movimiento_bancario: 211,
      banco: "ICBC",
      fecha: "2026-06-13",
      debito: 0,
      credito: 50,
      importe: 50,
      saldo: 3800160.10,
      id_pago: 41,
      id_movimiento_fondo: 21,
      _bankSourceOrder: 1
    }
  );

  const snapshot = serviceFor(cache).buildCashBoxSnapshot(cache, "icbc");
  assert.equal(snapshot.summary.collectionCount, 1);
  assert.equal(snapshot.summary.collectionTotalCents, 10010);
  assert.equal(snapshot.summary.paymentCount, 3);
  assert.equal(snapshot.summary.paymentTotalCents, 9505);
  assert.equal(snapshot.erpToBank.payments.some((row) => ["40", "41"].includes(row.id)), false);
});

test("cheques emitidos entran sólo con evidencia de débito ICBC", () => {
  const cache = fixture();
  cache.tables.pagos.rows.push(
    { id_pago: 50, fecha_pago: "2026-06-10", metodo: "Cheque", banco: "ICBC", monto: 80 },
    { id_pago: 51, fecha_pago: "2026-06-10", metodo: "Cheque debitado", banco: "ICBC", monto: 90 }
  );

  const snapshot = serviceFor(cache).buildCashBoxSnapshot(cache, "icbc");
  assert.equal(snapshot.summary.paymentCount, 2);
  assert.equal(snapshot.summary.paymentTotalCents, 11505);
  assert.match(snapshot.warnings.join(" "), /Pago 50 excluido/);
});

test("frontend conserva filtros focalizados y estados vacíos declarados", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../assets/js/modules/cash-boxes.js"),
    "utf8"
  );
  const context = {
    globalThis: null,
    document: {
      addEventListener() {},
      getElementById() { return null; }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);

  const rows = [
    { date: "2026-06-09", counterparty: "Cliente Norte", reference: "Cobro #1" },
    { date: "2026-06-10", counterparty: "Proveedor Sur", reference: "Pago #2" }
  ];
  assert.deepEqual(
    Array.from(context.CashBoxesModule.filterRows(rows, "norte"), (row) => row.reference),
    ["Cobro #1"]
  );
  assert.deepEqual(
    Array.from(context.CashBoxesModule.filterRows(rows, "10/06")),
    []
  );
  assert.match(source, /No hay cobros sin contrapartida ICBC/);
  assert.match(source, /No hay créditos bancarios sin contrapartida ERP en el corte/);
  assert.match(source, /El saldo cuadra, pero faltan asociaciones individuales/);
  assert.match(source, /No se pudo cargar Caja/);
});

test("DOM de Caja declara filas, totales y estados vacíos Banco → ERP", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.match(html, /Movimientos bancarios sin contrapartida ERP/);
  assert.match(html, /id="cash-box-bank-credits-body"/);
  assert.match(html, /id="cash-box-bank-debits-body"/);
  assert.match(html, /id="cash-box-erp-pending-net"/);
  assert.match(html, /id="cash-box-pending-net-gap-bank"/);
  assert.match(html, /id="cash-box-pending-net-gap"/);
  assert.match(html, /Los importes brutos y conteos pueden diferir/);
});
