const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createArcaInvoicingService, suggestReceiptType } = require("./arca-invoicing.service");

function cacheFixture() {
  return {
    tables: {
      pedidos: { rows: [
        { id_pedido: 1, id_cliente: 10, fecha_pedido: "2026-07-01", fecha_entrega: "2026-07-05" },
        { id_pedido: 2, id_cliente: 10, fecha_pedido: "2026-07-02", fecha_entrega: "2026-07-06" },
        { id_pedido: 3, id_cliente: 10, fecha_pedido: "2026-07-03", fecha_entrega: "2026-07-07" },
        { id_pedido: 4, id_cliente: 11, fecha_pedido: "2026-07-04", fecha_entrega: "2026-07-08" },
        { id_pedido: 5, id_cliente: 10, fecha_pedido: "2026-07-05", fecha_entrega: "2026-07-09" },
        { id_pedido: 6, id_cliente: 10, fecha_pedido: "2026-07-06", fecha_entrega: "2026-07-10" }
      ] },
      clientes: { rows: [
        {
          id_cliente: 10,
          nombre_cliente: "Cliente Uno",
          cuit: "30-12345678-9",
          tipo: "IVA Responsable Inscripto",
          direccion: "Calle 1",
          localidad: "Rosario",
          tipo_comprobante: "Factura A"
        },
        { id_cliente: 11, nombre_cliente: "Incompleto", cuit: "", tipo: "", direccion: "" }
      ] },
      productos: { rows: [
        { id_producto: 20, nombre_producto: "Barra", cantidad_individual: 10 }
      ] },
      detalle_pedidos: { rows: [
        { id_detalle_pedido: 101, id_pedido: 1, id_producto: 20, cantidad_cajas: 2, precio_ud: 100, bonificacion: 10 },
        { id_detalle_pedido: 102, id_pedido: 2, id_producto: 20, cantidad_cajas: 2, precio_ud: 121, bonificacion: 10 },
        { id_detalle_pedido: 103, id_pedido: 3, id_producto: 20, cantidad_cajas: 1, precio_ud: 100, bonificacion: 0 },
        { id_detalle_pedido: 104, id_pedido: 4, id_producto: 20, cantidad_cajas: 1, precio_ud: 0, bonificacion: 0 },
        { id_detalle_pedido: 105, id_pedido: 5, id_producto: 20, cantidad_cajas: 2, precio_ud: 121, bonificacion: 10 },
        { id_detalle_pedido: 106, id_pedido: 6, id_producto: 20, cantidad_cajas: 1, precio_ud: 100, bonificacion: 0 }
      ] },
      entregas: { rows: [{ id_entrega: 50, fecha: "2026-07-09" }] },
      entregas_detalle: { rows: [
        { id_entregas_detalle: 1, id_entrega: 50, id_pedido: 2 },
        { id_entregas_detalle: 2, id_entrega: 999, id_pedido: 1 },
        { id_entregas_detalle: 3, id_entrega: 50, id_pedido: 6 }
      ] },
      ventas: { rows: [
        { id_venta: 80, id_pedido: 3, tipo_factura: "Factura_A", nro_factura: "0001-1" },
        { id_venta: 81, id_pedido: 6, tipo_factura: "Factura_A", nro_factura: "0001-2" }
      ] }
    }
  };
}

function serviceFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arca-invoicing-"));
  const auditFile = path.join(directory, "audit.jsonl");
  const cache = cacheFixture();
  const responses = [];
  const service = createArcaInvoicingService({
    auditFile,
    backendId: (value) => value === null || value === undefined ? "" : String(value),
    crypto,
    fs,
    loadCache: () => cache,
    path,
    readJsonBody: async (request) => request.body,
    sendJson: (_response, status, payload) => {
      responses.push({ status, payload });
      return payload;
    }
  });
  return { auditFile, cache, directory, responses, service };
}

function validPrepare(orderId = 1, receiptType = "Factura_A") {
  return {
    orderId,
    pointOfSale: "00001",
    receiptType,
    issuerCondition: "responsable_inscripto",
    recipientCondition: "responsable_inscripto",
    invoiceDate: "2026-07-30",
    vatRates: {
      101: 21,
      102: 21,
      105: 21
    }
  };
}

test("lista únicamente pedidos sin entrega real y sin factura antes de paginar", () => {
  const fixture = serviceFixture();
  const firstPage = fixture.service.orders(fixture.cache, { status: "unbilled", limit: 2, offset: 0 });
  const secondPage = fixture.service.orders(fixture.cache, { status: "unbilled", limit: 2, offset: 2 });

  assert.equal(firstPage.total, 3);
  assert.equal(firstPage.rows.length, 2);
  assert.equal(secondPage.total, 3);
  assert.equal(secondPage.rows.length, 1);
  assert.deepEqual(
    [...firstPage.rows, ...secondPage.rows].map((row) => row.id_pedido),
    ["1", "4", "5"]
  );
  assert.equal(firstPage.rows[0].fecha_entrega_prevista, "2026-07-05");
  assert.equal(firstPage.rows[0].fecha_pedido, "2026-07-01");
  assert.equal(firstPage.rows[0].entrega.estado, "entrega_pendiente");
  assert.equal(firstPage.rows[0].productos[0].unidades_individuales, 20);
  assert.equal(
    [...firstPage.rows, ...secondPage.rows].find((row) => row.id_pedido === "4").facturacion_estado,
    "datos_incompletos"
  );
});

test("ordena por entrega prevista antes de paginar, desempata por pedido y deja fechas inválidas al final", () => {
  const fixture = serviceFixture();
  const orders = fixture.cache.tables.pedidos.rows;
  orders.find((order) => order.id_pedido === 1).fecha_entrega = "2026-08-02";
  orders.find((order) => order.id_pedido === 4).fecha_entrega = "2026-08-01";
  orders.find((order) => order.id_pedido === 5).fecha_entrega = "2026-08-01";

  const firstPage = fixture.service.orders(fixture.cache, { limit: 2, offset: 0 });
  const secondPage = fixture.service.orders(fixture.cache, { limit: 2, offset: 2 });
  assert.deepEqual(firstPage.rows.map((row) => row.id_pedido), ["4", "5"]);
  assert.deepEqual(secondPage.rows.map((row) => row.id_pedido), ["1"]);

  orders.find((order) => order.id_pedido === 4).fecha_entrega = "2026-02-30";
  orders.find((order) => order.id_pedido === 5).fecha_entrega = "";
  const withMissingDates = fixture.service.orders(fixture.cache, { limit: 20 });
  assert.deepEqual(withMissingDates.rows.map((row) => row.id_pedido), ["1", "4", "5"]);
});

test("no expone pedidos entregados o facturados aunque se pidan filtros amplios", () => {
  const fixture = serviceFixture();
  const all = fixture.service.orders(fixture.cache, { status: "all", limit: 20 });
  const billed = fixture.service.orders(fixture.cache, { status: "billed", limit: 20 });

  assert.deepEqual(all.rows.map((row) => row.id_pedido).sort(), ["1", "4", "5"]);
  assert.equal(billed.total, 0);
});

test("una actualización excluye el pedido apenas aparece una entrega o venta persistida", () => {
  const fixture = serviceFixture();
  assert.equal(fixture.service.orders(fixture.cache, { orderId: 1 }).total, 1);

  fixture.cache.tables.entregas_detalle.rows.push({
    id_entregas_detalle: 4,
    id_entrega: 50,
    id_pedido: 1
  });
  assert.equal(fixture.service.orders(fixture.cache, { orderId: 1 }).total, 0);

  fixture.cache.tables.entregas_detalle.rows.pop();
  fixture.cache.tables.ventas.rows.push({ id_venta: 82, id_pedido: 1 });
  assert.equal(fixture.service.orders(fixture.cache, { orderId: 1 }).total, 0);
});

test("calcula cajas por unidades, bonificación y Factura A sin duplicar precio por caja", () => {
  const fixture = serviceFixture();
  const prepared = fixture.service.prepare(validPrepare(), fixture.cache);

  assert.equal(prepared.lines[0].individualUnits, 20);
  assert.equal(prepared.lines[0].gross, 2000);
  assert.equal(prepared.lines[0].discountAmount, 200);
  assert.equal(prepared.lines[0].netSubtotal, 1800);
  assert.equal(prepared.lines[0].vat, 378);
  assert.equal(prepared.lines[0].total, 2178);
  assert.deepEqual(prepared.invoice.totals, { netSubtotal: 1800, vat: 378, total: 2178 });
});

test("normaliza Factura B con precio individual IVA incluido", () => {
  const fixture = serviceFixture();
  const body = validPrepare(5, "Factura_B");
  body.recipientCondition = "consumidor_final";
  const prepared = fixture.service.prepare(body, fixture.cache);

  assert.equal(prepared.lines[0].individualUnits, 20);
  assert.equal(prepared.lines[0].gross, 2420);
  assert.equal(prepared.lines[0].total, 2178);
  assert.equal(prepared.lines[0].netSubtotal, 1800);
  assert.equal(prepared.lines[0].vat, 378);
});

test("usa el mismo redondeo de bonificación que la comparación de Ventas", () => {
  const pricing = require("../../shared/order-pricing");
  const line = pricing.calculateLine({
    boxes: 1,
    unitsPerBox: 1,
    unitPrice: "0.01",
    discountPercent: 50,
    vatRate: 0,
    receiptType: "Factura_B"
  });

  assert.equal(line.total, 0.01);
  assert.equal(line.discountAmount, 0);
});

test("bloquea datos maestros, punto de venta, IVA y tipo fiscal ambiguos o incompatibles", () => {
  const fixture = serviceFixture();
  assert.throws(() => fixture.service.prepare(validPrepare(4), fixture.cache), /Faltan datos del pedido/);
  assert.throws(() => fixture.service.prepare({ ...validPrepare(), pointOfSale: "" }, fixture.cache), /punto de venta/);
  assert.throws(() => fixture.service.prepare({ ...validPrepare(), vatRates: {} }, fixture.cache), /alícuota de IVA/);
  assert.throws(() => fixture.service.prepare({
    ...validPrepare(),
    receiptType: "Factura_B"
  }, fixture.cache), /requieren revisar Factura A/);
  assert.throws(() => fixture.service.prepare({
    ...validPrepare(),
    invoiceDate: "2026-02-31"
  }, fixture.cache), /fecha del comprobante no es válida/);
});

test("la revisión identifica el snapshot y detecta una carrera antes de abrir ARCA", () => {
  const fixture = serviceFixture();
  const first = fixture.service.prepare(validPrepare(), fixture.cache);
  const same = fixture.service.prepare(validPrepare(), fixture.cache);

  assert.match(first.revision, /^[a-f0-9]{64}$/);
  assert.equal(first.revision, same.revision);
  assert.ok(Date.parse(first.expiresAt) > Date.now());

  fixture.cache.tables.ventas.rows.push({ id_venta: 999, id_pedido: 1 });
  assert.throws(() => fixture.service.prepare(validPrepare(), fixture.cache), /ya fue facturado/);
});

test("sólo sugiere A, B o C con condiciones explícitas", () => {
  assert.equal(suggestReceiptType("responsable_inscripto", "responsable_inscripto"), "Factura_A");
  assert.equal(suggestReceiptType("responsable_inscripto", "monotributista"), "Factura_A");
  assert.equal(suggestReceiptType("responsable_inscripto", "consumidor_final"), "Factura_B");
  assert.equal(suggestReceiptType("monotributista", "responsable_inscripto"), "Factura_C");
  assert.equal(suggestReceiptType("", "consumidor_final"), "");
});

test("preparar y auditar no crea ventas ni guarda payload o secretos", async () => {
  const fixture = serviceFixture();
  const salesBefore = JSON.stringify(fixture.cache.tables.ventas.rows);
  await fixture.service.handlePreparePost({ body: validPrepare() }, {});
  await fixture.service.handleAuditPost({
    body: { orderId: 1, status: "review_reached", reason: "" }
  }, {});

  assert.equal(fixture.responses[0].status, 200);
  assert.equal(JSON.stringify(fixture.cache.tables.ventas.rows), salesBefore);
  const auditText = fs.readFileSync(fixture.auditFile, "utf8");
  assert.match(auditText, /"status":"prepared"/);
  assert.match(auditText, /"status":"review_reached"/);
  assert.doesNotMatch(auditText, /cuit|precio|payload|cookie|token|clave|cae/i);
});

test("rechaza pedido facturado por carrera sin alterar datos", () => {
  const fixture = serviceFixture();
  assert.throws(() => fixture.service.prepare(validPrepare(3), fixture.cache), /ya fue facturado/);
});

test("rechaza pedido entregado por carrera sin alterar datos", () => {
  const fixture = serviceFixture();
  assert.throws(() => fixture.service.prepare(validPrepare(2), fixture.cache), /entrega real/);
});
