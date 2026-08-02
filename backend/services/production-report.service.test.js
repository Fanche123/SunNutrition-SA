const test = require("node:test");
const assert = require("node:assert/strict");
const { createProductionReportService } = require("./production-report.service");

function table(rows = []) {
  return { rows };
}

function fixture() {
  return {
    tables: {
      items: table([
        { id_item: 101, ud_conteo: "cajas" },
        { id_item: 102, ud_conteo: "cajas" }
      ]),
      productos: table([
        { id_producto: 1, id_item: 101, nombre_producto: "Barra A", cantidad_individual: 12 },
        { id_producto: 2, id_item: 102, nombre_producto: "Barra B", cantidad_individual: 24 }
      ]),
      inventarios: table([
        { id_inventario: 1, fecha: "2026-07-29", turno: "Tarde" },
        { id_inventario: 2, fecha: "2026-07-30", turno: "Mañana" },
        { id_inventario: 3, fecha: "2026-07-30", turno: "Mañana" },
        { id_inventario: 4, fecha: "2026-07-30", turno: "Tarde" }
      ]),
      detalle_inventarios: table([
        { id_inventario: 1, id_item: 101, cantidad: 10 },
        { id_inventario: 1, id_item: 102, cantidad: 5 },
        { id_inventario: 2, id_item: 101, cantidad: 98 },
        { id_inventario: 3, id_item: 101, cantidad: 12 },
        { id_inventario: 3, id_item: 102, cantidad: 5 },
        { id_inventario: 4, id_item: 101, cantidad: 15 },
        { id_inventario: 4, id_item: 102, cantidad: 4 }
      ]),
      entregas: table([
        { id_entrega: 10, fecha: "2026-07-30" },
        { id_entrega: 11, fecha: "2026-07-30" }
      ]),
      entregas_detalle: table([
        { id_entrega: 10, id_pedido: 20 },
        { id_entrega: 10, id_pedido: 20 },
        { id_entrega: 10, id_pedido: 21 },
        { id_entrega: 11, id_pedido: 22 }
      ]),
      detalle_pedidos: table([
        { id_pedido: 20, id_producto: 1, cantidad_cajas: 2 },
        { id_pedido: 21, id_producto: 1, cantidad_cajas: 1 },
        { id_pedido: 22, id_producto: 1, cantidad_cajas: 3 }
      ])
    }
  };
}

test("calcula mañana, tarde y día; ventas sólo en Mañana y deduplica entrega/pedido", () => {
  const cache = fixture();
  const report = createProductionReportService({ loadCache: () => cache })
    .buildProductionReport("2026-07-30", "2026-07-30");
  const rows = report.rows.filter((row) => row.productId === "1");
  assert.equal(rows[0].initialInventory, 10);
  assert.equal(rows[0].sales, 6);
  assert.equal(rows[0].finalInventory, 12);
  assert.equal(rows[0].production, 8);
  assert.equal(rows[1].sales, 0);
  assert.equal(rows[1].production, 3);
  assert.equal(report.daily.find((row) => row.productId === "1").production, 11);
  assert.equal(report.daily.find((row) => row.productId === "1").reconciled, true);
});

<<<<<<< ours
test("elige el mayor id como snapshot canónico, oculta cero y conserva alertas negativas", () => {
  const report = createProductionReportService({ loadCache: () => fixture() })
    .buildProductionReport("2026-07-30", "2026-07-30");
  const productB = report.rows.filter((row) => row.productId === "2");
  assert.equal(productB.length, 1);
  assert.equal(productB[0].shift, "Tarde");
  assert.equal(productB[0].production, -1);
  assert.equal(productB[0].status, "warning");
  assert.equal(report.daily.some((row) => row.productId === "2"), true);
=======
test("elige el mayor id como snapshot canónico y oculta resultados cero o negativos", () => {
  const report = createProductionReportService({ loadCache: () => fixture() })
    .buildProductionReport("2026-07-30", "2026-07-30");
  const productB = report.rows.filter((row) => row.productId === "2");
  assert.equal(productB.length, 0);
  assert.equal(report.daily.some((row) => row.productId === "2"), false);
>>>>>>> theirs
});

test("filtra producción cero por día y turno y convierte cajas con el factor canónico", () => {
  const report = createProductionReportService({ loadCache: () => fixture() })
    .buildProductionReport("2026-07-30", "2026-07-30");
  const productA = report.daily.find((row) => row.productId === "1");
  assert.equal(productA.production, 11);
  assert.equal(productA.unitsPerContainer, 12);
  assert.equal(productA.individualProduction, 132);
  assert.equal(productA.individualConversionStatus, "available");
  assert.equal(report.rows.some((row) => row.productId === "2" && row.shift === "Mañana"), false);
});

test("respeta unidades no convertibles e informa factores faltantes", () => {
  const cache = fixture();
  cache.tables.items.rows[0].ud_conteo = "kg";
  cache.tables.productos.rows[1].cantidad_individual = "";
<<<<<<< ours
=======
  cache.tables.detalle_inventarios.rows.find((row) => row.id_inventario === 4 && row.id_item === 102).cantidad = 6;
>>>>>>> theirs
  const report = createProductionReportService({ loadCache: () => cache })
    .buildProductionReport("2026-07-30", "2026-07-30");
  const kilograms = report.daily.find((row) => row.productId === "1");
  const missingFactor = report.daily.find((row) => row.productId === "2");
  assert.equal(kilograms.unit, "kg");
  assert.equal(kilograms.individualProduction, null);
  assert.equal(kilograms.individualConversionStatus, "not_applicable");
  assert.equal(missingFactor.individualProduction, null);
  assert.equal(missingFactor.individualConversionStatus, "missing_factor");
});

test("cada fecha se calcula y filtra sin arrastrar productos del día anterior", () => {
  const cache = fixture();
  cache.tables.inventarios.rows.push(
    { id_inventario: 5, fecha: "2026-07-31", turno: "Mañana" },
    { id_inventario: 6, fecha: "2026-07-31", turno: "Tarde" }
  );
  cache.tables.detalle_inventarios.rows.push(
    { id_inventario: 5, id_item: 101, cantidad: 15 },
    { id_inventario: 5, id_item: 102, cantidad: 4 },
    { id_inventario: 6, id_item: 101, cantidad: 15 },
    { id_inventario: 6, id_item: 102, cantidad: 6 }
  );
  const report = createProductionReportService({ loadCache: () => cache })
    .buildProductionReport("2026-07-31", "2026-07-31");
  assert.deepEqual(report.daily.map((row) => row.productId), ["2"]);
  assert.equal(report.daily[0].production, 2);
<<<<<<< ours
=======
});

test("muestra sólo A y cuenta un total ante producción positiva, cero y datos insuficientes", () => {
  const cache = fixture();
  cache.tables.items.rows.push({ id_item: 103, ud_conteo: "cajas" });
  cache.tables.productos.rows.push({
    id_producto: 3,
    id_item: 103,
    nombre_producto: "Producto C",
    cantidad_individual: 10
  });
  const report = createProductionReportService({ loadCache: () => cache })
    .buildProductionReport("2026-07-30", "2026-07-30");
  assert.deepEqual(report.daily.map((row) => row.productName), ["Barra A"]);
  assert.equal(report.daily.length, 1);
  assert.equal(report.rows.every((row) => Number.isFinite(row.production) && row.production > 0), true);
  assert.equal(report.rows.some((row) => row.productId === "2" || row.productId === "3"), false);
>>>>>>> theirs
});

test("faltantes se informan y no se inventan como cero", () => {
  const cache = fixture();
  cache.tables.inventarios.rows = cache.tables.inventarios.rows.filter((row) => row.id_inventario !== 4);
  const report = createProductionReportService({ loadCache: () => cache })
    .buildProductionReport("2026-07-30", "2026-07-30");
  assert.equal(report.rows.some((row) => row.productId === "1" && row.shift === "Tarde"), false);
  assert.equal(report.daily.some((row) => row.productId === "1"), false);
});

test("rechaza fechas inválidas y períodos mayores al límite", () => {
  const service = createProductionReportService({ loadCache: () => fixture() });
  assert.throws(() => service.buildProductionReport("2026-02-30", "2026-03-01"), /inválido/);
  assert.throws(() => service.buildProductionReport("2026-07-01", "2026-07-30junk"), /inválido/);
  assert.throws(() => service.buildProductionReport("2026-01-01", "2026-05-01"), /máximo/);
});

test("encadena Madrugada antes de Mañana y mantiene ventas sólo en Mañana", () => {
  const cache = fixture();
  cache.tables.inventarios.rows.push({ id_inventario: 5, fecha: "2026-07-30", turno: "Madrugada" });
  cache.tables.detalle_inventarios.rows.push({ id_inventario: 5, id_item: 101, cantidad: 11 });
  const report = createProductionReportService({ loadCache: () => cache })
    .buildProductionReport("2026-07-30", "2026-07-30");
  const rows = report.rows.filter((row) => row.productId === "1");
  assert.deepEqual(rows.map((row) => row.shift), ["Madrugada", "Mañana", "Tarde"]);
  assert.deepEqual(rows.map((row) => row.production), [1, 7, 3]);
  assert.deepEqual(rows.map((row) => row.sales), [0, 6, 0]);
  assert.equal(report.daily.find((row) => row.productId === "1").production, 11);
  assert.equal(report.daily.find((row) => row.productId === "1").reconciled, true);
});

test("distingue detalle ausente de cero persistido", () => {
  const cache = fixture();
  cache.tables.detalle_inventarios.rows = cache.tables.detalle_inventarios.rows
    .filter((row) => !(row.id_inventario === 3 && row.id_item === 101));
  const report = createProductionReportService({ loadCache: () => cache })
    .buildProductionReport("2026-07-30", "2026-07-30");
  const morning = report.rows.find((row) => row.productId === "1" && row.shift === "Mañana");
  const daily = report.daily.find((row) => row.productId === "1");
  assert.equal(morning, undefined);
  assert.equal(daily.production, 11);
  assert.equal(daily.reconciled, false);
  assert.equal(daily.status, "warning");
});
