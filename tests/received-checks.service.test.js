const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createReceivedChecksService } = require("../backend/services/received-checks.service");
const { ensureBackendTable } = require("../backend/utils/runtime");

const clone = (value) => JSON.parse(JSON.stringify(value));
const backendId = (value) => String(value ?? "").trim();
const readJsonBody = async (request) => request.body;
const sendJson = (response, status, payload) => response.json(status, payload);

function seed() {
  return {
    generatedAt: "",
    tables: {
      pagos: {
        headers: ["id_pago", "fecha_pago", "metodo", "monto"],
        rows: [
          {
            id_pago: 10,
            fecha_pago: "2026-07-24",
            metodo: "Endoso",
            monto: 300.3,
            _operationId: "payment-create-10",
            _operationPayload: "{\"payment\":\"original\"}"
          },
          { id_pago: 11, fecha_pago: "2026-07-24", metodo: "Transferencia", monto: 50 }
        ],
        rowCount: 2
      },
      cheques_recibidos: {
        headers: ["id_cheque_recibido", "monto", "estado", "id_deposito", "id_pago_endoso", "fecha_endoso"],
        rows: [
          { id_cheque_recibido: 1, monto: 100.1, estado: "Pendiente" },
          { id_cheque_recibido: 2, monto: 200.2, estado: "Pendiente" },
          { id_cheque_recibido: 3, monto: 50, estado: "Depositado", id_deposito: 8 },
          { id_cheque_recibido: 4, monto: 50, estado: "Pendiente", id_pago_endoso: 99 }
        ],
        rowCount: 4
      },
      cobros: { headers: [], rows: [{ id_cobro: 1 }], rowCount: 1 },
      egresos: { headers: [], rows: [{ id_egreso: 1 }], rowCount: 1 },
      detalle_pagos: { headers: [], rows: [{ id_detalle_pago: 1, id_pago: 10 }], rowCount: 1 },
      caja: { headers: [], rows: [{ id_caja: 1 }], rowCount: 1 },
      movimientos_bancarios: { headers: [], rows: [], rowCount: 0 }
    }
  };
}

function diskStore(initial) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "erp-received-checks-"));
  const file = path.join(directory, "cache.json");
  fs.writeFileSync(file, JSON.stringify(initial, null, 2), "utf8");
  return {
    file,
    loadCache: () => JSON.parse(fs.readFileSync(file, "utf8")),
    saveBackendCache: (next) => {
      const temporary = `${file}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2), "utf8");
      fs.renameSync(temporary, file);
    },
    value: () => JSON.parse(fs.readFileSync(file, "utf8"))
  };
}

function service(store, failureInjector) {
  return createReceivedChecksService({
    backendId,
    ensureBackendTable,
    loadCache: store.loadCache,
    readJsonBody,
    saveBackendCache: store.saveBackendCache,
    sendJson,
    failureInjector
  });
}

async function invoke(handler, body) {
  let result;
  await handler({ body }, { json(status, payload) { result = { status, payload }; } });
  return result;
}

const validBody = {
  operationId: "endorsement-20260724-1",
  paymentId: 10,
  endorsementDate: "2026-07-24",
  checkIds: [2, 1]
};

function pendingPaymentsSeed() {
  const paymentPayload = (date, details, method = "Endoso") => JSON.stringify({
    details,
    payment: { banco: "", fecha: date, metodo: method }
  });
  const currentPayments = [
    {
      id_pago: 101,
      fecha_pago: "2026-07-25",
      metodo: "Endoso",
      monto: 200,
      _operationId: "payment-create-101",
      _operationPayload: paymentPayload("2026-07-25", [{ idEgreso: 501, monto: 200 }])
    },
    {
      id_pago: 102,
      fecha_pago: "2026-07-26",
      metodo: "Endoso",
      monto: 300,
      _operationId: "endorsement-102",
      _operationPayload: "{\"checkIds\":[1]}",
      _paymentCreationOperationId: "payment-create-102",
      _paymentCreationOperationPayload: paymentPayload("2026-07-26", [{ idEgreso: 502, monto: 300 }])
    },
    {
      id_pago: 103,
      fecha_pago: "2026-07-26",
      metodo: "Endoso",
      monto: 150,
      _operationId: "payment-create-103",
      _operationPayload: paymentPayload("2026-07-26", [{ idEgreso: 503, monto: 150 }])
    },
    {
      id_pago: 104,
      fecha_pago: "2026-07-26",
      metodo: "Transferencia",
      monto: 80,
      _operationId: "payment-create-104",
      _operationPayload: paymentPayload("2026-07-26", [{ idEgreso: 504, monto: 80 }], "Transferencia")
    }
  ];
  return {
    generatedAt: "",
    tables: {
      pagos: {
        headers: [],
        rows: [
          { id_pago: 100, fecha_pago: "2026-03-01", metodo: "Endoso", monto: 900 },
          ...currentPayments,
          {
            id_pago: 105,
            fecha_pago: "",
            metodo: "Endoso",
            monto: 70,
            _operationId: "payment-create-105",
            _operationPayload: "{incompleto"
          }
        ],
        rowCount: 6
      },
      detalle_pagos: {
        headers: [],
        rows: [
          { id_detalle_pago: 1, id_pago: 100, id_egreso: 500, monto_cancelado: 900 },
          { id_detalle_pago: 2, id_pago: 101, id_egreso: 501, monto_cancelado: 200, _operationId: "payment-create-101" },
          { id_detalle_pago: 3, id_pago: 102, id_egreso: 502, monto_cancelado: 300, _operationId: "payment-create-102" },
          { id_detalle_pago: 4, id_pago: 103, id_egreso: 503, monto_cancelado: 150, _operationId: "payment-create-103" },
          { id_detalle_pago: 5, id_pago: 104, id_egreso: 504, monto_cancelado: 80, _operationId: "payment-create-104" }
        ],
        rowCount: 5
      },
      cheques_recibidos: {
        headers: [],
        rows: [
          {
            id_cheque_recibido: 1,
            monto: 100,
            estado: "Endosado",
            id_pago_endoso: 102,
            fecha_endoso: "2026-07-26"
          },
          {
            id_cheque_recibido: 2,
            monto: 150,
            estado: "Endosado",
            id_pago_endoso: 103,
            fecha_endoso: "2026-07-26"
          },
          {
            id_cheque_recibido: 9,
            monto: 50,
            estado: "Endosado",
            id_pago_endoso: 101,
            fecha_endoso: "2026-07-26"
          },
          {
            id_cheque_recibido: 9,
            monto: 50,
            estado: "Endosado",
            id_pago_endoso: 102,
            fecha_endoso: "2026-07-26"
          },
          {
            id_cheque_recibido: 10,
            monto: 30,
            estado: "Pendiente",
            id_pago_endoso: 101,
            fecha_endoso: ""
          }
        ],
        rowCount: 5
      }
    }
  };
}

test("lista solo pagos Endoso reconocidos por el flujo actual y calcula pendientes válidos", async () => {
  const store = diskStore(pendingPaymentsSeed());
  const before = store.value();
  const result = await invoke(service(store).handlePendingEndorsementPaymentsList, {});

  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(
    result.payload.payments.map((item) => ({
      id: item.payment.id_pago,
      total: item.paymentCents,
      assigned: item.assignedCents,
      difference: item.differenceCents
    })),
    [
      { id: 101, total: 20000, assigned: 0, difference: 20000 },
      { id: 102, total: 30000, assigned: 10000, difference: 20000 }
    ]
  );
  assert.deepStrictEqual(store.value(), before);
});

test("endosa uno o varios cheques con una sola persistencia y sin tocar otras tablas", async () => {
  const store = diskStore(seed());
  const before = store.value();
  const result = await invoke(service(store).handleReceivedChecksEndorse, validBody);
  assert.strictEqual(result.status, 201);
  assert.deepStrictEqual(result.payload.checkIds, ["1", "2"]);
  const after = store.value();
  assert.strictEqual(after.tables.pagos.rows[0]._operationId, validBody.operationId);
  assert.strictEqual(after.tables.pagos.rows[0]._paymentCreationOperationId, "payment-create-10");
  assert.strictEqual(after.tables.pagos.rows[0]._paymentCreationOperationPayload, "{\"payment\":\"original\"}");
  assert.deepStrictEqual(after.tables.cobros, before.tables.cobros);
  assert.deepStrictEqual(after.tables.egresos, before.tables.egresos);
  assert.deepStrictEqual(after.tables.detalle_pagos, before.tables.detalle_pagos);
  assert.deepStrictEqual(after.tables.caja, before.tables.caja);
  assert.deepStrictEqual(after.tables.movimientos_bancarios, before.tables.movimientos_bancarios);
  assert.deepStrictEqual(
    after.tables.cheques_recibidos.rows.slice(0, 2).map((row) => ({
      estado: row.estado,
      pago: row.id_pago_endoso,
      fecha: row.fecha_endoso
    })),
    [
      { estado: "Endosado", pago: "10", fecha: "2026-07-24" },
      { estado: "Endosado", pago: "10", fecha: "2026-07-24" }
    ]
  );
});

test("idempotencia durable sobrevive a recrear servicio y recargar cache", async () => {
  const store = diskStore(seed());
  assert.strictEqual((await invoke(service(store).handleReceivedChecksEndorse, validBody)).status, 201);
  const applied = store.value();
  const recreated = service(store);
  const replay = await invoke(recreated.handleReceivedChecksEndorse, { ...validBody, checkIds: [1, 2] });
  assert.strictEqual(replay.status, 200);
  assert.strictEqual(replay.payload.idempotent, true);
  assert.deepStrictEqual(store.value(), applied);
  const contradiction = await invoke(recreated.handleReceivedChecksEndorse, {
    ...validBody,
    endorsementDate: "2026-07-25"
  });
  assert.strictEqual(contradiction.status, 409);
  assert.deepStrictEqual(store.value(), applied);
});

test("rechaza totales, métodos, IDs duplicados y cheques incompatibles sin escritura parcial", async () => {
  const cases = [
    [{ ...validBody, checkIds: [1] }, 409],
    [{ ...validBody, paymentId: 11, checkIds: [3] }, 409],
    [{ ...validBody, checkIds: [1, 1] }, 400],
    [{ ...validBody, checkIds: [3] }, 409],
    [{ ...validBody, checkIds: [4] }, 409],
    [{ ...validBody, checkIds: [999] }, 404]
  ];
  for (const [body, expected] of cases) {
    const store = diskStore(seed());
    const before = store.value();
    assert.strictEqual((await invoke(service(store).handleReceivedChecksEndorse, body)).status, expected);
    assert.deepStrictEqual(store.value(), before);
  }
});

test("un fallo después de actualizar el snapshot no persiste ninguna fila", async () => {
  const store = diskStore(seed());
  const before = store.value();
  const failing = service(store, (point) => {
    if (point === "after-check-updates") throw new Error("fallo inyectado");
  });
  assert.strictEqual((await invoke(failing.handleReceivedChecksEndorse, validBody)).status, 400);
  assert.deepStrictEqual(store.value(), before);
});

test("la navegación visible queda unificada y Pagos ofrece Endoso", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const receivedCheckModule = fs.readFileSync(
    path.join(__dirname, "..", "assets", "js", "modules", "received-check-entry.js"),
    "utf8"
  );
  assert.strictEqual((html.match(/data-view="received-check-entry"/g) || []).length, 1);
  assert.strictEqual((html.match(/data-view="deposited-checks-entry"/g) || []).length, 0);
  assert.match(html, /<option value="Endoso">Endoso<\/option>/);
  assert.match(html, /id="view-deposited-checks-entry"/);
  assert.match(html, /data-view="issued-check-entry"/);
  assert.match(receivedCheckModule, /\/api\/treasury\/received-checks\/pending-endorsement-payments/);
  assert.doesNotMatch(receivedCheckModule, /backendTableRowsForEntry\("pagos"\)/);
});
