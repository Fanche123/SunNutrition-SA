const assert = require("node:assert/strict");
const test = require("node:test");
const { createSalesOrderEntryService } = require("./sales-order-entry.service");

function createFixture(options = {}) {
  const source = {
    generatedAt: "",
    tables: {
      clientes: { rows: [{ id_cliente: 1 }], rowCount: 1 },
      productos: { rows: [{ id_producto: 10 }, { id_producto: 11 }], rowCount: 2 },
      pedidos: { rows: [], rowCount: 0 },
      detalle_pedidos: { rows: [], rowCount: 0 }
    }
  };
  let saved = null;
  let saveCount = 0;
  const responses = [];
  const service = createSalesOrderEntryService({
    backendId: (value) => value === null || value === undefined || value === "" ? "" : String(value),
    backendNextNumericId: (rows, key) => rows.reduce((max, row) => Math.max(max, Number(row[key]) || 0), 0) + 1,
    backendNumber: (value) => Number(value) || 0,
    ensureBackendTable: (tables, name) => {
      tables[name] ||= { rows: [], rowCount: 0 };
    },
    isIsoDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")),
    loadCache: () => source,
    readJsonBody: async (request) => request.body,
    saveBackendCache: (cache) => {
      if (options.failSave) throw new Error("fallo de persistencia");
      saveCount += 1;
      saved = cache;
    },
    sendJson: (_response, status, payload) => {
      responses.push({ status, payload });
      return payload;
    },
    failureInjector: options.failureInjector
  });
  return { service, source, responses, saved: () => saved, saveCount: () => saveCount };
}

function validBody(details = [{
  idProducto: 10,
  cantidadCajas: 2,
  impuesto: "A",
  precioUd: 150,
  bonificacion: 0
}]) {
  return {
    order: {
      idCliente: 1,
      fechaPedido: "2026-07-23",
      fechaEntrega: "2026-07-24",
      fechaOriginal: "2026-07-24"
    },
    details
  };
}

async function submit(fixture, body) {
  await fixture.service.handleSalesOrderFullEntry({ body }, {});
  return fixture.responses.at(-1);
}

test("guarda encabezado y un detalle con una sola persistencia", async () => {
  const fixture = createFixture();
  const result = await submit(fixture, validBody());
  assert.equal(result.status, 200);
  assert.equal(fixture.saved().tables.pedidos.rows.length, 1);
  assert.equal(fixture.saved().tables.detalle_pedidos.rows.length, 1);
  assert.equal(fixture.saved().tables.detalle_pedidos.rows[0].id_pedido, result.payload.orderId);
  assert.equal(fixture.saveCount(), 1);
  assert.deepEqual(
    Object.keys(fixture.saved().tables.pedidos.rows[0]).filter((key) => !key.startsWith("_")),
    ["id_pedido", "fecha_pedido", "id_cliente", "fecha_entrega", "fecha_original"]
  );
  assert.deepEqual(
    Object.keys(fixture.saved().tables.detalle_pedidos.rows[0]).filter((key) => !key.startsWith("_")),
    ["id_detalle_pedido", "id_pedido", "id_producto", "cantidad_cajas", "impuesto", "precio_ud", "bonificacion"]
  );
});

test("genera IDs backend para varios detalles", async () => {
  const fixture = createFixture();
  const result = await submit(fixture, validBody([
    { idProducto: 10, cantidadCajas: 2, impuesto: "A", precioUd: 150, bonificacion: 0 },
    { idProducto: 11, cantidadCajas: 1, impuesto: "B", precioUd: 90, bonificacion: 5 }
  ]));
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.detailIds, [1, 2]);
  assert.equal(fixture.saved().tables.detalle_pedidos.rows.length, 2);
});

for (const [name, mutate] of [
  ["cliente inexistente", (body) => { body.order.idCliente = 999; }],
  ["producto inexistente", (body) => { body.details[0].idProducto = 999; }],
  ["cantidad inválida", (body) => { body.details[0].cantidadCajas = 0; }],
  ["payload sin detalles", (body) => { body.details = []; }]
]) {
  test(`responde 400 para ${name} sin persistir`, async () => {
    const fixture = createFixture();
    const body = validBody();
    mutate(body);
    const result = await submit(fixture, body);
    assert.equal(result.status, 400);
    assert.equal(fixture.saved(), null);
    assert.equal(fixture.source.tables.pedidos.rows.length, 0);
    assert.equal(fixture.source.tables.detalle_pedidos.rows.length, 0);
  });
}

test("un fallo antes del guardado no deja filas aisladas", async () => {
  const fixture = createFixture({
    failureInjector: (stage) => {
      if (stage === "after-order") throw new Error("fallo antes del detalle");
    }
  });
  const result = await submit(fixture, validBody());
  assert.equal(result.status, 400);
  assert.equal(fixture.source.tables.pedidos.rows.length, 0);
  assert.equal(fixture.source.tables.detalle_pedidos.rows.length, 0);
});

test("un fallo durante la persistencia no modifica la instancia original", async () => {
  const fixture = createFixture({ failSave: true });
  const result = await submit(fixture, validBody());
  assert.equal(result.status, 400);
  assert.equal(fixture.source.tables.pedidos.rows.length, 0);
  assert.equal(fixture.source.tables.detalle_pedidos.rows.length, 0);
});

test("reintentar después de un fallo guarda una sola unidad coherente", async () => {
  let fail = true;
  const fixture = createFixture({
    failureInjector: (stage) => {
      if (stage === "before-save" && fail) {
        fail = false;
        throw new Error("fallo transitorio");
      }
    }
  });
  assert.equal((await submit(fixture, validBody())).status, 400);
  assert.equal((await submit(fixture, validBody())).status, 200);
  assert.equal(fixture.saved().tables.pedidos.rows.length, 1);
  assert.equal(fixture.saved().tables.detalle_pedidos.rows.length, 1);
});
