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
          amount: row.importe
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

test("calcula Saldo ICBC en centavos, incluye 09/06 y no duplica detalles", () => {
  const snapshot = serviceFor(fixture()).buildCashBoxSnapshot(fixture(), "icbc");

  assert.equal(snapshot.rule.initialBalanceCents, 380113005);
  assert.equal(snapshot.summary.collectionCount, 2);
  assert.equal(snapshot.summary.collectionTotalCents, 15010);
  assert.equal(snapshot.summary.paymentCount, 3);
  assert.equal(snapshot.summary.paymentTotalCents, 4005);
  assert.equal(snapshot.summary.calculatedBalanceCents, 380124010);
  assert.equal(snapshot.summary.latestBankMovement.id, "4");
  assert.equal(snapshot.summary.latestBankMovement.balanceCents, 380023010);
  assert.equal(snapshot.summary.differenceCents, -101000);
  assert.equal(snapshot.summary.status, "difference");
});

test("usa orden de importación estable para el último saldo del mismo día", () => {
  const cache = fixture();
  cache.tables.movimientos_bancarios.rows.push(
    {
      id_movimiento_bancario: 50,
      banco: "ICBC",
      fecha: "2026-06-14",
      importe: 1,
      saldo: 10,
      _bankImportedAt: "2026-06-14T08:00:00.000Z"
    },
    {
      id_movimiento_bancario: 5,
      banco: "ICBC",
      fecha: "2026-06-14",
      importe: 1,
      saldo: 20,
      _bankImportedAt: "2026-06-14T09:00:00.000Z"
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

  assert.deepEqual(snapshot.erpToBank.collections.map((row) => row.id), ["2"]);
  assert.deepEqual(snapshot.erpToBank.payments.map((row) => row.id), ["11", "12"]);
  assert.match(snapshot.erpToBank.collections[0].reason, /asociado a GAL/i);
  assert.match(snapshot.erpToBank.payments[0].reason, /cheque/i);
  assert.match(snapshot.erpToBank.payments[1].reason, /efectivo/i);
  assert.equal(snapshot.bankToErp.pendingCount, 1);
  assert.equal(snapshot.bankToErp.pendingGrossCents, 1000);
  assert.equal(snapshot.bankToErp.classifications[0].classification, "Gasto bancario sin vínculo");
  assert.ok(snapshot.bankToErp.gapFactors.some((item) => item.classification === "Fondo de inversión asociado"));
});

test("diferencia soporta resultado positivo, negativo y cero", () => {
  for (const [offsetCents, expectedStatus] of [[100, "difference"], [-100, "difference"], [0, "reconciled"]]) {
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
  assert.match(source, /No se pudo cargar Cajas/);
});
