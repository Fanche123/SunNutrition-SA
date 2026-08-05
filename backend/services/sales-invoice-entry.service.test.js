const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  createSalesInvoiceEntryService,
  expectedOrderSubtotal
} = require("./sales-invoice-entry.service");

test("calcula subtotal esperado por unidades individuales, bonificación y centavos", () => {
  const result = expectedOrderSubtotal([
    {
      id_producto: 20,
      producto: "Barra Pop 140Ud",
      cantidad_cajas: 40,
      unidades_por_caja: 140,
      precio_unitario: "10.25",
      bonificacion: 5
    },
    {
      id_producto: 21,
      producto: "Otro producto",
      cantidad_cajas: 2,
      unidades_por_caja: 12,
      precio_unitario: "3.33",
      bonificacion: 0
    }
  ]);

  assert.equal(result.estado, "calculable");
  assert.equal(result.lineas[0].unidades_individuales, 5600);
  assert.equal(result.lineas[0].subtotal_esperado, 54530);
  assert.equal(result.lineas[1].subtotal_esperado, 79.92);
  assert.equal(result.subtotal_esperado, 54609.92);
});

test("no reemplaza datos faltantes por cero", () => {
  const result = expectedOrderSubtotal([{
    id_producto: 20,
    cantidad_cajas: 40,
    unidades_por_caja: "",
    precio_unitario: "10.25",
    bonificacion: 0
  }]);

  assert.equal(result.estado, "datos_insuficientes");
  assert.deepEqual(result.campos_faltantes, ["unidades por caja"]);
  assert.equal(result.subtotal_esperado, null);
});

test("comparte con ARCA el redondeo final después de aplicar la bonificación", () => {
  const result = expectedOrderSubtotal([{
    id_producto: 20,
    cantidad_cajas: 1,
    unidades_por_caja: 1,
    precio_unitario: "0.01",
    bonificacion: 50
  }]);

  assert.equal(result.subtotal_esperado, 0.01);
});

test("el subtotal esperado no agrega IVA al precio individual del pedido", () => {
  const result = expectedOrderSubtotal([{
    id_producto: 20,
    cantidad_cajas: 1,
    unidades_por_caja: 20,
    precio_unitario: "121.00",
    bonificacion: 10
  }]);

  assert.equal(result.estado, "calculable");
  assert.equal(result.subtotal_esperado, 2178);
});

function baseCache() {
  return {
    tables: {
      pedidos: { rows: [
        { id_pedido: 1, id_cliente: 10, fecha_pedido: "2026-07-01", fecha_entrega: "2026-07-03" },
        { id_pedido: 2, id_cliente: 10, fecha_pedido: "2026-07-02", fecha_entrega: "2026-07-04" },
        { id_pedido: 3, id_cliente: 11, fecha_pedido: "2026-07-02", fecha_entrega: "2026-07-04" }
      ], rowCount: 3 },
      clientes: { rows: [
        { id_cliente: 10, nombre_cliente: "Cliente_A", cuit: "30-1", plazo_cobro: "30_Dias" },
        { id_cliente: 11, nombre_cliente: "Cliente_B", cuit: "30-2" }
      ], rowCount: 2 },
      productos: { rows: [{ id_producto: 20, nombre_producto: "Barra" }], rowCount: 1 },
      detalle_pedidos: { rows: [
        { id_detalle_pedido: 1, id_pedido: 1, id_producto: 20, cantidad_cajas: 2 },
        { id_detalle_pedido: 2, id_pedido: 2, id_producto: 20, cantidad_cajas: 3 }
      ], rowCount: 2 },
      entregas: { rows: [{ id_entrega: 30, fecha: "2026-07-05" }], rowCount: 1 },
      entregas_detalle: { rows: [{ id_entregas_detalle: 1, id_entrega: 30, id_pedido: 1 }], rowCount: 1 },
      fletes: { rows: [{ id_flete: 40, nombre: "Flete" }], rowCount: 1 },
      ventas: { rows: [], rowCount: 0 }
    }
  };
}

function validBody(orderId = 1) {
  return {
    orderIds: [orderId],
    invoice: {
      tipoFactura: "Factura_A",
      nroFactura: "0001-000001",
      fechaFactura: "2026-07-06",
      fechaAcordada: "2026-08-06",
      subtotal: 100,
      iva: 21,
      total: 121
    }
  };
}

function fixture(options = {}) {
  let source = options.source || baseCache();
  let saved = null;
  let saves = 0;
  let synchronized = false;
  const responses = [];
  const service = createSalesInvoiceEntryService({
    backendId: (value) => value === null || value === undefined || value === "" ? "" : String(value),
    backendNextNumericId: (rows, key) => rows.reduce((max, row) => Math.max(max, Number(row[key]) || 0), 0) + 1,
    ensureBackendTable: (tables, name) => { tables[name] ||= { rows: [], rowCount: 0 }; },
    isIsoDate: (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")),
    loadCache: () => source,
    readJsonBody: async (request) => request.body,
    saveBackendCache: (cache) => {
      if (options.failSave) throw new Error("fallo de persistencia");
      saves += 1;
      saved = cache;
      source = cache;
    },
    sendJson: (_response, status, payload) => {
      responses.push({ status, payload });
      return payload;
    },
    synchronizeEconomicExpenses: (cache) => {
      synchronized = true;
      cache.economicSync = true;
      return cache;
    },
    failureInjector: options.failureInjector,
    crypto: options.crypto,
    fs: options.fs,
    path: options.path,
    rootDir: options.rootDir
  });
  return {
    service,
    responses,
    saved: () => saved,
    saves: () => saves,
    synchronized: () => synchronized,
    source: () => source
  };
}

async function submit(ctx, body = validBody()) {
  await ctx.service.handleSalesInvoiceFullEntry({ body }, {});
  return ctx.responses.at(-1);
}

test("consulta sólo pedidos sin relación canónica en ventas", () => {
  const source = baseCache();
  source.tables.ventas.rows.push({ id_venta: 9, id_pedido: 2, id_cliente: 10 });
  const rows = fixture({ source }).service.unbilledOrders();
  assert.deepEqual(rows.map((row) => row.id_pedido), ["1", "3"]);
  assert.equal(rows[0].id_entrega, "30");
  assert.equal(rows[0].fecha_entrega, "2026-07-05");
  assert.equal(rows[0].cantidad_cajas, 2);
  assert.equal(rows[0].plazo_cobro, "30_Dias");
});

test("no aplica heurísticas de cobro, entrega, cliente, fecha o monto", () => {
  const source = baseCache();
  source.tables.cobros = { rows: [{ id_cobro: 1, id_cliente: 10, monto: 121 }] };
  const rows = fixture({ source }).service.unbilledOrders();
  assert.deepEqual(rows.map((row) => row.id_pedido), ["1", "2", "3"]);
});

test("navegación consolida el flujo y conserva Saldos Pendientes", () => {
  const root = path.resolve(__dirname, "../..");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "assets/js/app.js"), "utf8");
  assert.match(html, /data-view="sales-workflow"[^>]*>Gestión de Ventas</);
  assert.doesNotMatch(html, /data-view="sales-invoice-entry"[^>]*>Ventas</);
  assert.match(html, /data-view="sales-entry"[^>]*>Saldos Pendientes</);
  assert.match(app, /"sales-workflow": \["Gestión de Ventas"/);
  assert.match(app, /"sales-entry": \["Saldos Pendientes"/);
});

test("la lectura OCR sólo propone campos y el guardado exige submit explícito", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../assets/js/modules/sales-invoice-entry.js"),
    "utf8"
  );
  assert.match(source, /applySalesInvoiceProposal\(payload\.invoice/);
  assert.match(source, /form\.addEventListener\("submit", submitSalesInvoice\)/);
  assert.doesNotMatch(source, /applySalesInvoiceProposal[\s\S]{0,300}submitSalesInvoice\(/);
  assert.match(source, /Podés completar la venta manualmente/);
});

test("venta del workflow guarda un adjunto canónico y el reintento no duplica venta ni archivo", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-sales-workflow-"));
  try {
    const ctx = fixture({ crypto, fs, path, rootDir });
    const body = {
      ...validBody(1),
      workflow: true,
      attachment: {
        fileName: "factura.html",
        mimeType: "image/png",
        fileDataUrl: `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("imagen-factura-fixture")]).toString("base64")}`
      }
    };
    const first = await submit(ctx, body);
    const second = await submit(ctx, body);
    assert.equal(first.status, 200);
    assert.equal(second.payload.idempotent, true);
    assert.equal(ctx.source().tables.ventas.rows.length, 1);
    assert.equal(ctx.source().tables.gestion_ventas.rows.length, 1);
    const workflow = ctx.source().tables.gestion_ventas.rows[0];
    assert.ok(workflow.archivo_factura_hash);
    assert.match(workflow.archivo_factura, /\.png$/);
    assert.doesNotMatch(workflow.archivo_factura, /\.html$/);
    assert.equal(fs.existsSync(path.join(rootDir, workflow.archivo_factura)), true);
    assert.equal(fs.readdirSync(path.join(rootDir, "backend", "attachments", "ventas")).length, 1);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("rechaza una imagen declarada cuyo contenido no tiene firma válida", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-sales-workflow-invalid-image-"));
  try {
    const ctx = fixture({ crypto, fs, path, rootDir });
    const response = await submit(ctx, {
      ...validBody(1),
      workflow: true,
      attachment: {
        fileName: "factura.png",
        mimeType: "image/png",
        fileDataUrl: `data:image/png;base64,${Buffer.from("contenido-no-png").toString("base64")}`
      }
    });
    assert.equal(response.status, 400);
    assert.match(response.payload.error, /contenido del adjunto/);
    assert.equal(ctx.source().tables.ventas.rows.length, 0);
    assert.equal(fs.existsSync(path.join(rootDir, "backend", "attachments", "ventas")), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("guarda una venta con relación canónica y fecha económica por entrega", async () => {
  const ctx = fixture();
  const response = await submit(ctx);
  assert.equal(response.status, 200);
  assert.equal(ctx.saves(), 1);
  assert.equal(ctx.synchronized(), true);
  assert.deepEqual(ctx.saved().tables.ventas.rows[0], {
    _rowNumber: 2,
    id_venta: 1,
    id_pedido: "1",
    id_cliente: "10",
    id_entrega: "30",
    tipo_factura: "Factura_A",
    nro_factura: "0001-000001",
    fecha_factura: "2026-07-06",
    fecha_acordada: "2026-08-06",
    iva: 21,
    subtotal: 100,
    total: 121,
    _editedLocallyAt: ctx.saved().tables.ventas.rows[0]._editedLocallyAt
  });
  assert.equal(ctx.service.unbilledOrders(ctx.saved()).some((row) => row.id_pedido === "1"), false);
});

test("acepta Remito X con el valor canonico del formulario", async () => {
  const ctx = fixture();
  const body = validBody();
  body.invoice.tipoFactura = "Remito_X";
  const response = await submit(ctx, body);

  assert.equal(response.status, 200);
  assert.equal(ctx.saved().tables.ventas.rows[0].tipo_factura, "Remito_X");
});

test("rechaza selección múltiple sin inventar reparto contable", async () => {
  const ctx = fixture();
  const response = await submit(ctx, { ...validBody(), orderIds: [1, 2] });
  assert.equal(response.status, 400);
  assert.match(response.payload.error, /un solo pedido/);
  assert.equal(ctx.saves(), 0);
});

test("rechaza una carrera cuando el pedido ya fue facturado con otro comprobante", async () => {
  const source = baseCache();
  source.tables.ventas.rows.push({
    id_venta: 8, id_pedido: 1, id_cliente: 10, tipo_factura: "Factura_A",
    nro_factura: "0001-OTRA", fecha_factura: "2026-07-06", fecha_acordada: "",
    subtotal: 100, iva: 21, total: 121
  });
  const ctx = fixture({ source });
  const response = await submit(ctx);
  assert.equal(response.status, 409);
  assert.match(response.payload.error, /otra operación/);
  assert.equal(ctx.saves(), 0);
});

test("serializa dos intentos concurrentes y sólo persiste una venta", async () => {
  const ctx = fixture();
  const competingBody = validBody();
  competingBody.invoice.nroFactura = "0001-COMPITE";
  await Promise.all([
    ctx.service.handleSalesInvoiceFullEntry({ body: validBody() }, {}),
    ctx.service.handleSalesInvoiceFullEntry({ body: competingBody }, {})
  ]);
  assert.deepEqual(ctx.responses.map((response) => response.status), [200, 409]);
  assert.equal(ctx.saves(), 1);
  assert.equal(ctx.source().tables.ventas.rows.length, 1);
});

test("factura sin entrega adquiere el vínculo económico al crear la entrega posterior", async () => {
  const ctx = fixture();
  assert.equal((await submit(ctx, validBody(3))).status, 200);
  assert.equal(ctx.source().tables.ventas.rows[0].id_entrega, "");

  await ctx.service.handleSalesDeliveryFullEntry({
    body: { orderIds: [3], fleetId: 40, deliveryDate: "2026-07-20" }
  }, {});
  const deliveryResponse = ctx.responses.at(-1);
  assert.equal(deliveryResponse.status, 200);
  assert.equal(ctx.saves(), 2);
  assert.equal(ctx.source().tables.ventas.rows[0].id_entrega, deliveryResponse.payload.deliveryId);
  assert.equal(
    ctx.source().tables.entregas.rows.find((row) => row.id_entrega === deliveryResponse.payload.deliveryId).fecha,
    "2026-07-20"
  );
  assert.equal(
    ctx.source().tables.entregas_detalle.rows.find((row) => row.id_pedido === "3").id_entrega,
    deliveryResponse.payload.deliveryId
  );
});

test("una relación sin entrega padre no bloquea recrear la entrega", async () => {
  const source = baseCache();
  source.tables.entregas_detalle.rows.push({
    id_entregas_detalle: 2,
    id_entrega: "",
    id_pedido: 3
  });
  const ctx = fixture({ source });
  await ctx.service.handleSalesDeliveryFullEntry({
    body: { orderIds: [3], fleetId: 40, deliveryDate: "2026-07-20" }
  }, {});
  const response = ctx.responses.at(-1);
  assert.equal(response.status, 200);
  assert.equal(ctx.saves(), 1);
  assert.equal(
    ctx.source().tables.entregas_detalle.rows
      .filter((row) => String(row.id_pedido) === "3" && String(row.id_entrega)).length,
    1
  );
  const invoiceResponse = await submit(ctx, validBody(3));
  assert.equal(invoiceResponse.status, 200);
  assert.equal(
    String(ctx.source().tables.ventas.rows.find((row) => String(row.id_pedido) === "3").id_entrega),
    String(response.payload.deliveryId)
  );
});

test("rechaza factura fiscal duplicada para otro pedido del mismo cliente", async () => {
  const source = baseCache();
  source.tables.ventas.rows.push({
    id_venta: 8, id_pedido: 2, id_cliente: 10,
    tipo_factura: "Factura_A", nro_factura: "0001-000001"
  });
  const ctx = fixture({ source });
  const response = await submit(ctx);
  assert.equal(response.status, 409);
  assert.match(response.payload.error, /factura ya está registrada/);
});

test("reintento idéntico es idempotente y no vuelve a persistir", async () => {
  const ctx = fixture();
  const first = await submit(ctx);
  const second = await submit(ctx);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.payload.idempotent, true);
  assert.equal(ctx.saves(), 1);
  assert.equal(ctx.source().tables.ventas.rows.length, 1);
});

test("fallo antes del guardado conserva el snapshot original", async () => {
  const ctx = fixture({
    failureInjector: (stage) => {
      if (stage === "before-save") throw new Error("fallo controlado");
    }
  });
  const response = await submit(ctx);
  assert.equal(response.status, 400);
  assert.equal(ctx.source().tables.ventas.rows.length, 0);
  assert.equal(ctx.saves(), 0);
});

test("fallo de persistencia no muta el snapshot original", async () => {
  const ctx = fixture({ failSave: true });
  const response = await submit(ctx);
  assert.equal(response.status, 400);
  assert.equal(ctx.source().tables.ventas.rows.length, 0);
  assert.equal(ctx.saves(), 0);
});

for (const [label, mutate, pattern] of [
  ["importe negativo", (body) => { body.invoice.iva = -1; }, /no puede ser negativo/],
  ["total incoherente", (body) => { body.invoice.total = 120; }, /debe coincidir/],
  ["fecha inválida", (body) => { body.invoice.fechaFactura = ""; }, /fecha de factura/]
]) {
  test(`valida ${label}`, async () => {
    const ctx = fixture();
    const body = validBody();
    mutate(body);
    const response = await submit(ctx, body);
    assert.equal(response.status, 400);
    assert.match(response.payload.error, pattern);
    assert.equal(ctx.saves(), 0);
  });
}
