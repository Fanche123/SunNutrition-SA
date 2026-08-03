const test = require("node:test");
const assert = require("node:assert/strict");
const { createProductionReportService } = require("./production-report.service");

const table = (rows = []) => ({ rows });
function fixture() {
  const quantities = {
    1: { 3: 1, 4: 50, 14: 5, 118: 10 },
    2: { 3: 1, 4: 51, 14: 6, 118: 12 },
    3: { 3: 1, 4: 52, 14: 6, 118: 13 }
  };
  return { tables: {
    items: table([
      { id_item: 3, ud_conteo: "Bolsones" }, { id_item: 4, ud_conteo: "Kg" },
      { id_item: 14, ud_conteo: "Kg" }, { id_item: 118, ud_conteo: "cajas" }
    ]),
    productos: table([
      { id_producto: 67, id_item: 118, nombre_producto: "Barra_Pop_140Ud", cantidad_individual: 140 },
      { id_producto: 5, id_item: 14, nombre_producto: "Materia_Prima_Pochoclo_Dulce", cantidad_individual: 1 }
    ]),
    subproductos: table([
      { id_subproducto: 3, id_item: 3, nombre_subproducto: "Barra_Pop", ud_conteo: "Bolsones" },
      { id_subproducto: 4, id_item: 4, nombre_subproducto: "Granel Dulce", ud_conteo: "Kg" }
    ]),
    recetas: table([
      { id_receta: 152, id_item_resultado: 118, id_item_componente: 3, cantidad_componente: 140, unidad_base: "Ud" },
      { id_receta: 6, id_item_resultado: 3, id_item_componente: 4, cantidad_componente: 0.02, unidad_base: "Kg" }
    ]),
    inventarios: table([
      { id_inventario: 1, fecha: "2026-07-29", turno: "Tarde" },
      { id_inventario: 2, fecha: "2026-07-30", turno: "Mañana" },
      { id_inventario: 3, fecha: "2026-07-30", turno: "Tarde" }
    ]),
    detalle_inventarios: table(Object.entries(quantities).flatMap(([inventoryId, values]) =>
      Object.entries(values).map(([itemId, cantidad]) => ({ id_inventario: inventoryId, id_item: itemId, cantidad })))),
    entregas: table([{ id_entrega: 10, fecha: "2026-07-30" }]),
    entregas_detalle: table([{ id_entrega: 10, id_pedido: 20 }, { id_entrega: 10, id_pedido: 20 }]),
    detalle_pedidos: table([{ id_pedido: 20, id_producto: 67, cantidad_cajas: 2 }])
  } };
}

const service = (cache = fixture()) => createProductionReportService({ loadCache: () => cache });

test("resuelve opciones e IDs canónicos y selecciona Barra_Pop por defecto", () => {
  const report = service().buildProductionReport("2026-07-30", "2026-07-30");
  assert.deepEqual(report.options.map((row) => [row.name, row.itemId]), [
    ["Barra_Pop", "3"], ["Barra_Pop_140_Ud", "118"], ["Granel_Dulce", "4"], ["Materia_Prima_Pochoclo_Dulce", "14"]
  ]);
  assert.equal(report.selected.itemId, "3");
});

test("selecciona un solo producto y calcula métricas sobre días positivos", () => {
  const report = service().buildProductionReport("2026-07-30", "2026-07-30", "118");
  assert.equal(report.selected.name, "Barra_Pop_140_Ud");
  assert.equal(report.daily.length, 1);
  assert.deepEqual(report.metrics, { total: 5, average: 5, bestDate: "2026-07-30", bestProduction: 5, positiveDays: 1, unit: "cajas", unitsPerContainer: 140 });
  assert.equal(report.daily[0].individualProduction, 700);
});

test("asigna salidas de ventas sólo a Mañana y deduplica entrega/pedido", () => {
  const report = service().buildProductionReport("2026-07-30", "2026-07-30", "118");
  assert.deepEqual(report.rows.map((row) => [row.shift, row.sales, row.production]), [["Mañana", 2, 4], ["Tarde", 0, 1]]);
});

test("calcula Barra_Pop en unidades y conserva la equivalencia fraccionaria en bolsones", () => {
  const report = service().buildProductionReport("2026-07-30", "2026-07-30", "3");
  assert.equal(report.daily[0].recipeConsumption, 700);
  assert.equal(report.daily[0].production, 700);
  assert.equal(report.daily[0].unit, "Ud");
  assert.equal(report.daily[0].secondaryProduction, 0.35);
  assert.equal(report.daily[0].secondaryUnit, "bolsones");
});

test("calcula Granel_Dulce encadenando recetas reales", () => {
  const report = service().buildProductionReport("2026-07-30", "2026-07-30", "4");
  assert.equal(report.daily[0].recipeConsumption, 14);
  assert.equal(report.daily[0].production, 16);
  assert.equal(report.daily[0].unit, "Kg");
});

test("10 cajas de 140 aportan 1.400 Ud a Barra_Pop sin redondear bolsones", () => {
  const cache = fixture();
  cache.tables.detalle_inventarios.rows.find((row) => String(row.id_inventario) === "3" && String(row.id_item) === "118").cantidad = 18;
  const boxes = service(cache).buildProductionReport("2026-07-30", "2026-07-30", "118");
  assert.equal(boxes.daily[0].production, 10);
  assert.equal(boxes.daily[0].unit, "cajas");
  assert.equal(boxes.daily[0].secondaryProduction, 1400);
  const barra = service(cache).buildProductionReport("2026-07-30", "2026-07-30", "3");
  assert.equal(barra.daily[0].production, 1400);
  assert.equal(barra.daily[0].secondaryProduction, 0.7);
});

test("un descendiente producido y dieciséis ausentes sólo suma el aporte producido", () => {
  const cache = fixture();
  for (let index = 0; index < 16; index += 1) {
    const itemId = 200 + index;
    cache.tables.items.rows.push({ id_item: itemId, ud_conteo: "cajas" });
    cache.tables.productos.rows.push({ id_producto: itemId, id_item: itemId, nombre_producto: `Variante_${index}`, cantidad_individual: 1 });
    cache.tables.recetas.rows.push({ id_receta: 300 + index, id_item_resultado: itemId, id_item_componente: 3, cantidad_componente: 1, unidad_base: "Ud" });
  }
  const report = service(cache).buildProductionReport("2026-07-30", "2026-07-30", "3");
  assert.equal(report.daily[0].production, 700);
  assert.deepEqual(report.unavailableReasons, []);
});

test("todos los descendientes ausentes aportan cero sin datos insuficientes", () => {
  const cache = fixture();
  cache.tables.recetas.rows = cache.tables.recetas.rows.filter((row) => row.id_item_resultado !== 118);
  cache.tables.recetas.rows.push({ id_receta: 300, id_item_resultado: 999, id_item_componente: 3, cantidad_componente: 140, unidad_base: "Ud" });
  const report = service(cache).buildProductionReport("2026-07-30", "2026-07-30", "3");
  assert.equal(report.daily.length, 0);
  assert.deepEqual(report.unavailableReasons, []);
});

test("varias dependencias producidas se suman una vez cada una", () => {
  const cache = fixture();
  cache.tables.items.rows.push({ id_item: 119, ud_conteo: "cajas" });
  cache.tables.productos.rows.push({ id_producto: 68, id_item: 119, nombre_producto: "Otra_Barra", cantidad_individual: 50 });
  cache.tables.recetas.rows.push({ id_receta: 154, id_item_resultado: 119, id_item_componente: 3, cantidad_componente: 50, unidad_base: "Ud" });
  cache.tables.detalle_inventarios.rows.push(
    { id_inventario: 1, id_item: 119, cantidad: 0 },
    { id_inventario: 2, id_item: 119, cantidad: 1 },
    { id_inventario: 3, id_item: 119, cantidad: 2 }
  );
  const report = service(cache).buildProductionReport("2026-07-30", "2026-07-30", "3");
  assert.equal(report.daily[0].recipeConsumption, 800);
  assert.equal(report.daily[0].production, 800);
});

test("dependencia positiva con unidad inválida informa sólo esa dependencia", () => {
  const cache = fixture();
  cache.tables.recetas.rows[0].unidad_base = "Kg";
  const report = service(cache).buildProductionReport("2026-07-30", "2026-07-30", "3");
  assert.equal(report.daily.length, 0);
  assert.equal(report.unavailableReasons.length, 1);
  assert.match(report.unavailableReasons[0], /Barra_Pop_140Ud/);
});

test("producción descendiente cero o null aporta cero y un ciclo no se duplica", () => {
  const cache = fixture();
  cache.tables.detalle_inventarios.rows.filter((row) => String(row.id_item) === "118").forEach((row) => { row.cantidad = 10; });
  cache.tables.entregas_detalle.rows = [];
  cache.tables.recetas.rows.push({ id_receta: 160, id_item_resultado: 4, id_item_componente: 3, cantidad_componente: 1, unidad_base: "Ud" });
  const report = service(cache).buildProductionReport("2026-07-30", "2026-07-30", "3");
  assert.equal(report.daily[0].production, 2);
  assert.deepEqual(report.unavailableReasons, []);
});

test("una cantidad de receta inválida vuelve insuficiente el cálculo", () => {
  const cache = fixture();
  cache.tables.recetas.rows[0].cantidad_componente = 0;
  const report = service(cache).buildProductionReport("2026-07-30", "2026-07-30", "3");
  assert.equal(report.daily.length, 0);
  assert.match(report.unavailableReasons.join(" "), /cantidad inválida en receta 152/);
});

test("no muestra cero, negativos ni grupos vacíos", () => {
  const cache = fixture();
  cache.tables.detalle_inventarios.rows.filter((row) => ["2", "3"].includes(String(row.id_inventario)) && String(row.id_item) === "14").forEach((row) => { row.cantidad = 5; });
  const report = service(cache).buildProductionReport("2026-07-30", "2026-07-30", "14");
  assert.equal(report.daily.length, 0);
  assert.equal(report.rows.length, 0);
});

test("no inventa conversión individual cuando la unidad canónica no es contenedor", () => {
  const cache = fixture();
  cache.tables.productos.rows.find((row) => row.id_item === 118).cantidad_individual = "";
  const report = service(cache).buildProductionReport("2026-07-30", "2026-07-30", "118");
  assert.equal(report.metrics.unitsPerContainer, null);
  assert.equal(report.daily[0].individualConversionStatus, "missing_factor");
  assert.equal(report.daily[0].individualProduction, null);
});

test("omite resultados con datos insuficientes y valida el período", () => {
  const cache = fixture();
  cache.tables.detalle_inventarios.rows = cache.tables.detalle_inventarios.rows.filter((row) => !(String(row.id_inventario) === "3" && String(row.id_item) === "4"));
  assert.equal(service(cache).buildProductionReport("2026-07-30", "2026-07-30", "4").daily.length, 0);
  assert.throws(() => service().buildProductionReport("2026-02-30", "2026-03-01"), /inválido/);
  assert.throws(() => service().buildProductionReport("2026-01-01", "2026-05-01"), /máximo/);
});
