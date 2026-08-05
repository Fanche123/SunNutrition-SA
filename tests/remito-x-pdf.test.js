const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  LINES_PER_PAGE,
  buildRemitoXData,
  generateRemitoXPdf,
  normalizeReceiptType,
  remitoXFileName
} = require("../backend/services/remito-x-pdf.service");
const { createSalesWorkflowService } = require("../backend/services/sales-workflow.service");

const rootDir = path.resolve(__dirname, "..");
const template = fs.readFileSync(path.join(rootDir, "backend", "templates", "remito-x-template.pdf"));
const backendId = (value) => value === null || value === undefined || value === "" ? "" : String(value);
const nextId = (rows, key) => rows.reduce((maximum, row) => Math.max(maximum, Number(row[key]) || 0), 0) + 1;

function fixture(lineCount = 1) {
  const products = [];
  const details = [];
  for (let index = 1; index <= lineCount; index += 1) {
    products.push({
      id_producto: index,
      nombre_producto: index === 2
        ? "Producto_de_prueba_con_descripción_extensa_para_validar_ajuste"
        : `Producto_Prueba_${index}`,
      cantidad_individual: 10
    });
    details.push({
      id_detalle_pedido: index,
      id_pedido: 42,
      id_producto: index,
      cantidad_cajas: index,
      precio_ud: 2.5,
      bonificacion: 0
    });
  }
  return {
    generatedAt: "",
    tables: {
      clientes: { rows: [{
        id_cliente: 1,
        nombre_cliente: "Cliente_Prueba_Ágil_SRL",
        direccion: "Calle_Ficticia_1234",
        localidad: "San_Martín",
        cuit: "30-12345678-9",
        tipo_comprobante: "Remito X"
      }] },
      productos: { rows: products },
      pedidos: { rows: [{ id_pedido: 42, id_cliente: 1, fecha_pedido: "2026-08-01", fecha_entrega: "2026-08-03" }] },
      detalle_pedidos: { rows: details },
      entregas: { rows: [] },
      entregas_detalle: { rows: [] },
      ventas: { rows: [] },
      gestion_ventas: { rows: [], rowCount: 0 }
    }
  };
}

test("normaliza Remito X sin convertir Factura A/B", () => {
  assert.equal(normalizeReceiptType("Remito_X"), "Remito_X");
  assert.equal(normalizeReceiptType("remito-x"), "Remito_X");
  assert.equal(normalizeReceiptType("Remito X"), "Remito_X");
  assert.equal(normalizeReceiptType("Factura A"), "Factura_A");
  assert.equal(normalizeReceiptType("factura_b"), "Factura_B");
  assert.equal(normalizeReceiptType("clasificación comercial"), "");
});

test("genera una página fiel con los datos calculados y sin valores del ejemplo", () => {
  const data = buildRemitoXData(fixture(), 42, backendId);
  const pdf = generateRemitoXPdf(template, data);
  const source = pdf.toString("latin1");

  assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.match(source, /\/Count 1/);
  assert.match(source, /\(00042\) Tj/);
  assert.match(source, /\(Cliente_Prueba_Ágil_SRL\) Tj/);
  assert.match(source, /\(30-12345678-9\) Tj/);
  assert.match(source, /\(Producto_Prueba_1\) Tj/);
  assert.match(source, /\(\$25\.00\) Tj/);
  assert.doesNotMatch(source, /Galletitas_Individuales_SRL|Barra_Pop_140Ud|\$348,651\.00|0\.00%/);
  assert.equal(remitoXFileName(data), "Remito_X_Pedido_42_Cliente_Prueba_Agil_SRL.pdf");
});

test("deja el espacio de CUIT completamente vacío cuando falta o es inválido", () => {
  for (const cuit of ["", "CUIT incompleto 30-1234"]) {
    const source = fixture();
    source.tables.clientes.rows[0].cuit = cuit;
    const data = buildRemitoXData(source, 42, backendId);
    const pdf = generateRemitoXPdf(template, data);
    const overlaySource = pdf.subarray(template.length).toString("latin1");

    assert.equal(data.cuit, "");
    assert.doesNotMatch(overlaySource, /\(\) Tj/);
    assert.doesNotMatch(overlaySource, /30-1234|Sin CUIT|N\/A/);
  }
});

test("pagina todos los productos sin perder líneas y deja el total general en la última página", () => {
  const data = buildRemitoXData(fixture(LINES_PER_PAGE + 2), 42, backendId);
  const pdf = generateRemitoXPdf(template, data);
  const source = pdf.toString("latin1");

  assert.match(source, /\/Count 2/);
  assert.match(source, /\(Producto_Prueba_13\) Tj/);
  assert.match(source, /\(Producto_Prueba_14\) Tj/);
  assert.match(source, /\(Producto_Prueba_15\) Tj/);
  assert.match(source, /\(Página 1\/2\) Tj/);
  assert.match(source, /\(Página 2\/2\) Tj/);
  assert.match(source, /\(120\) Tj/);
  assert.match(source, /\(\$3,000\.00\) Tj/);
});

test("bloquea datos obligatorios ausentes y tipos que no sean Remito X", () => {
  const missingAddress = fixture();
  missingAddress.tables.clientes.rows[0].direccion = "";
  assert.throws(
    () => buildRemitoXData(missingAddress, 42, backendId),
    /domicilio del cliente/
  );

  const invoiceA = fixture();
  invoiceA.tables.clientes.rows[0].tipo_comprobante = "Factura_A";
  assert.throws(
    () => buildRemitoXData(invoiceA, 42, backendId),
    /no está configurado para Remito X/
  );
});

test("el endpoint completa el workflow sólo después de generar el PDF", async () => {
  let source = fixture();
  const tablesBefore = JSON.stringify({
    pedidos: source.tables.pedidos,
    detalle_pedidos: source.tables.detalle_pedidos,
    clientes: source.tables.clientes,
    productos: source.tables.productos,
    ventas: source.tables.ventas,
    entregas: source.tables.entregas
  });
  const jsonResponses = [];
  const response = {
    status: 0,
    headers: {},
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; }
  };
  const service = createSalesWorkflowService({
    backendId,
    backendNextNumericId: nextId,
    ensureBackendTable: (tables, name) => { tables[name] ||= { headers: [], rows: [], rowCount: 0 }; },
    loadCache: () => source,
    readJsonBody: async (request) => request.body,
    saveBackendCache: (cache) => { source = cache; },
    sendJson: (_response, status, payload) => { jsonResponses.push({ status, payload }); return payload; },
    fs,
    path,
    rootDir
  });

  await service.handleRemitoX({ body: { orderId: 42 }, accessIdentity: { mode: "local" } }, response);

  assert.equal(jsonResponses.length, 0);
  assert.equal(response.status, 200);
  assert.equal(response.headers["Content-Type"], "application/pdf");
  assert.match(response.headers["Content-Disposition"], /Remito_X_Pedido_42_Cliente_Prueba_Agil_SRL\.pdf/);
  assert.equal(response.body.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.ok(source.tables.gestion_ventas.rows[0].factura_arca_confirmada_en);
  assert.equal(source.tables.gestion_ventas.rows[0].origen, "remito_x_generado");
  assert.equal(JSON.stringify({
    pedidos: source.tables.pedidos,
    detalle_pedidos: source.tables.detalle_pedidos,
    clientes: source.tables.clientes,
    productos: source.tables.productos,
    ventas: source.tables.ventas,
    entregas: source.tables.entregas
  }), tablesBefore);
});

test("el endpoint genera el PDF y completa el workflow con CUIT ausente o inválido", async () => {
  for (const cuit of ["", "incompleto"]) {
    let source = fixture();
    source.tables.clientes.rows[0].cuit = cuit;
    const responses = [];
    const response = {
      status: 0,
      headers: {},
      body: null,
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { this.body = body; }
    };
    const service = createSalesWorkflowService({
      backendId,
      backendNextNumericId: nextId,
      ensureBackendTable: (tables, name) => { tables[name] ||= { headers: [], rows: [], rowCount: 0 }; },
      loadCache: () => source,
      readJsonBody: async (request) => request.body,
      saveBackendCache: (cache) => { source = cache; },
      sendJson: (_response, status, payload) => { responses.push({ status, payload }); return payload; },
      fs,
      path,
      rootDir
    });

    await service.handleRemitoX({ body: { orderId: 42 } }, response);

    assert.equal(responses.length, 0);
    assert.equal(response.status, 200);
    assert.equal(response.headers["Content-Type"], "application/pdf");
    assert.equal(response.body.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.ok(source.tables.gestion_ventas.rows[0].factura_arca_confirmada_en);
    assert.equal(source.tables.gestion_ventas.rows[0].origen, "remito_x_generado");
  }
});

test("Factura A/B y ARCA conservan la exigencia de CUIT válido", () => {
  const arcaServiceSource = fs.readFileSync(
    path.join(rootDir, "backend", "services", "arca-invoicing.service.js"),
    "utf8"
  );
  const fiscalContractSource = fs.readFileSync(
    path.join(rootDir, "tools", "arca-extension", "arca-fiscal-contract.js"),
    "utf8"
  );

  assert.match(arcaServiceSource, /digits\(client\.cuit\)\.length !== 11/);
  assert.match(fiscalContractSource, /customer\?\.cuit[\s\S]{0,80}length !== 11/);
  assert.match(fiscalContractSource, /Factura_A/);
  assert.match(fiscalContractSource, /Factura_B/);
});

test("la UI bifurca Remito X antes de cargar ARCA y conserva el botón Crear factura", () => {
  const source = fs.readFileSync(path.join(rootDir, "assets", "js", "modules", "sales-workflow.js"), "utf8");
  const remitoBranch = source.indexOf('if (row.tipo_comprobante_configurado === "Remito_X")');
  const arcaLoad = source.indexOf('loadDeferredScript("tools/arca-extension/arca-fiscal-contract.js');
  assert.ok(remitoBranch > -1 && remitoBranch < arcaLoad);
  assert.match(source, /fetch\("\/api\/sales\/workflow\/remito-x"/);
  assert.match(source, /actionButton\(row, "arca", "Crear factura"\)/);
});
