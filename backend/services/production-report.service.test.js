const test = require("node:test");
const assert = require("node:assert/strict");
const { createProductionReportService } = require("./production-report.service");

function table(rows = []) {
  return { rows };
}

function fixture() {
  return {
    tables: {
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

test("elige el mayor id como snapshot canónico y conserva cero real", () => {
  const report = createProductionReportService({ loadCache: () => fixture() })
    .buildProductionReport("2026-07-30", "2026-07-30");
  const productB = report.rows.filter((row) => row.productId === "2");
  assert.equal(productB[0].production, 0);
  assert.equal(productB[0].status, "ok");
  assert.equal(productB[1].production, -1);
  assert.equal(productB[1].status, "warning");
});

test("faltantes se informan y no se inventan como cero", () => {
  const cache = fixture();
  cache.tables.inventarios.rows = cache.tables.inventarios.rows.filter((row) => row.id_inventario !== 4);
  const report = createProductionReportService({ loadCache: () => cache })
    .buildProductionReport("2026-07-30", "2026-07-30");
  const afternoon = report.rows.find((row) => row.productId === "1" && row.shift === "Tarde");
  const daily = report.daily.find((row) => row.productId === "1");
  assert.equal(afternoon.production, null);
  assert.match(afternoon.warning, /inventario final de Tarde/);
  assert.equal(daily.production, null);
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
  assert.equal(morning.production, null);
  assert.equal(morning.status, "insufficient");
  assert.equal(daily.production, 11);
  assert.equal(daily.reconciled, false);
  assert.equal(daily.status, "warning");
});
