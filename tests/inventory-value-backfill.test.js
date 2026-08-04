const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildInventoryValueBackfill,
  logicalNonDerivedHash,
  runInventoryValueBackfill
} = require("../backend/migrations/20260804-inventory-values");

function table(rows = []) {
  return { rows, rowCount: rows.length, headers: rows[0] ? Object.keys(rows[0]) : [] };
}

function fixtureCache() {
  return {
    generatedAt: "fixture",
    tables: {
      items: table([{ id_item: 8, origen_tipo: "insumo", id_origen: 5, ud_conteo: "Rollo" }]),
      insumos: table([{ id_insumo: 5, nombre: "Bobina_Barra_Pop", ud_receta: "Ud", cantidad_receta: 5442 }]),
      insumos_proveedores: table([{
        id_insumos_proveedores: 60,
        id_insumo: 5,
        ud_proveedor: "Kg",
        cantidad_proveedor: 714,
        precio: 12632.95
      }]),
      compras: table([{ id_compra: 200, fecha_pedido: "2026-06-18", fecha_entrega_prevista: "2026-07-14" }]),
      detalle_compras: table([{
        id_detalle_compra: 214,
        id_compra: 200,
        id_insumos_proveedores: 60,
        id_insumo: 5,
        cantidad: 1092.03,
        cantidad_proveedor: 714,
        ud_proveedor: "Kg"
      }]),
      recepciones: table([{ id_recepcion: 200, id_compra: 200, id_egreso: 7939, fecha_recepcion: "2026-07-14" }]),
      detalle_recepciones: table([{
        id_detalle_recepcion: 215,
        id_recepcion: 200,
        id_insumo: 5,
        cantidad_recibida: 143.2762624035281
      }]),
      egresos: table([{ id_egreso: 7939, subtotal: 13795341.98 }]),
      recetas: table([{
        id_receta: 6,
        id_item_resultado: 3,
        id_item_componente: 4,
        cantidad_componente: 0.02,
        unidad_base: "Kg"
      }]),
      inventarios: table([{
        id_inventario: 1744,
        fecha: "2026-07-31",
        turno: "Tarde",
        id_empleado: 4,
        valor_total: 78691346.96
      }]),
      detalle_inventarios: table([{
        id_detalle_inventario: 30526,
        id_inventario: 1744,
        id_item: 8,
        cantidad: 98,
        costo_unitario_usado: 733853.7,
        valor_total: 71917662.6
      }])
    }
  };
}

test("el backfill puro corrige detalle primero y deriva la cabecera al centavo", () => {
  const source = fixtureCache();
  const sourceHash = logicalNonDerivedHash(source, { ignoreBarraPopRecipeQuantity: true });
  const first = buildInventoryValueBackfill(source);

  assert.equal(first.report.changedRows, 1);
  assert.equal(first.report.changedDetailRows, 1);
  assert.equal(first.report.inventory1744.after, 9435921.18);
  assert.equal(first.cache.tables.inventarios.rows[0].valor_total, 9435921.18);
  assert.deepEqual(first.cache.tables.detalle_inventarios.rows[0], {
    id_detalle_inventario: 30526,
    id_inventario: 1744,
    id_item: 8,
    cantidad: 98,
    costo_unitario_usado: 96284.91,
    valor_total: 9435921.18
  });
  assert.equal(first.report.recipeCorrection.before, 0.02);
  assert.equal(first.report.recipeCorrection.after, 0.0165);
  assert.equal(first.cache.tables.recetas.rows[0].cantidad_componente, 0.0165);
  assert.equal(logicalNonDerivedHash(first.cache, { ignoreBarraPopRecipeQuantity: true }), sourceHash);
  assert.equal(buildInventoryValueBackfill(first.cache).report.changedRows, 0);
  assert.equal(buildInventoryValueBackfill(first.cache).report.changedDetailRows, 0);
});

test("la receta canonica usa 16,5 g por Barra_Pop y el segundo dry-run es idempotente", () => {
  const first = buildInventoryValueBackfill(fixtureCache());
  const second = buildInventoryValueBackfill(first.cache);

  assert.equal(first.report.recipeCorrection.changed, true);
  assert.equal(first.report.recipeCorrection.unidadBase, "Kg");
  assert.equal(first.cache.tables.recetas.rows[0].cantidad_componente * 1000, 16.5);
  assert.equal(second.report.recipeCorrection.changed, false);
  assert.equal(second.report.changedDetailRows, 0);
  assert.equal(second.report.changedInventoryRows, 0);
  assert.equal(second.report.idempotent, true);
});

test("una diferencia exacta de un centavo se corrige sin tolerancia paralela", () => {
  const source = fixtureCache();
  source.tables.detalle_inventarios.rows[0].costo_unitario_usado = 96284.91;
  source.tables.detalle_inventarios.rows[0].valor_total = 9435921.18;
  source.tables.inventarios.rows[0].valor_total = 9435921.19;

  const result = buildInventoryValueBackfill(source);

  assert.equal(result.report.changedRows, 1);
  assert.equal(result.report.changedDetailRows, 0);
  assert.equal(result.report.idempotent, false);
  assert.equal(result.cache.tables.inventarios.rows[0].valor_total, 9435921.18);
});

test("un detalle sin costo demostrable omite el inventario completo", () => {
  const source = fixtureCache();
  source.tables.items.rows.push({ id_item: 9, origen_tipo: "insumo", id_origen: 6, ud_conteo: "Pack_25_Ud" });
  source.tables.insumos.rows.push({ id_insumo: 6, nombre: "Caja_40", ud_receta: "Ud", cantidad_receta: 25 });
  source.tables.detalle_inventarios.rows.push({
    id_detalle_inventario: 30527,
    id_inventario: 1744,
    id_item: 9,
    cantidad: 2,
    costo_unitario_usado: 0,
    valor_total: 0
  });

  const before = structuredClone(source);
  const result = buildInventoryValueBackfill(source);

  assert.equal(result.report.changedInventoryRows, 0);
  assert.equal(result.report.changedDetailRows, 0);
  assert.equal(result.report.diagnostics.omittedInventories, 1);
  assert.equal(result.report.diagnostics.omittedInventoryRows[0].id, "1744");
  before.tables.recetas.rows[0].cantidad_componente = 0.0165;
  assert.deepEqual(result.cache, before);
});

test("un precio disponible solo en el maestro mutable omite el inventario completo", () => {
  const source = fixtureCache();
  source.tables.recepciones.rows = [];
  source.tables.detalle_recepciones.rows = [];
  source.tables.egresos.rows = [];
  source.tables.detalle_compras.rows[0].cantidad_proveedor = "";
  source.tables.insumos_proveedores.rows[0].cantidad_proveedor = 714;
  source.tables.insumos_proveedores.rows[0].precio = 12632.95;
  source.tables.detalle_inventarios.rows[0].costo_unitario_usado = "";
  source.tables.detalle_inventarios.rows[0].valor_total = "";

  const result = buildInventoryValueBackfill(source);

  assert.equal(result.report.changedDetailRows, 0);
  assert.equal(result.report.changedInventoryRows, 0);
  assert.equal(result.report.diagnostics.omittedInventories, 1);
  assert.equal(result.report.diagnostics.unsupportedCostSourceRows, 1);
  assert.equal(result.report.diagnostics.omittedInventoryRows[0].issues[0].code, "UNSUPPORTED_COST_SOURCE");
});

test("apply crea backup verificable y restore no pisa escrituras posteriores", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-inventory-backfill-"));
  try {
    const cacheFile = path.join(tempDir, "backend-data-cache.json");
    const evidenceDir = path.join(tempDir, "evidence");
    fs.writeFileSync(cacheFile, JSON.stringify(fixtureCache(), null, 2));

    const dryRun = runInventoryValueBackfill("dry-run", { cacheFile, evidenceDir });
    assert.equal(dryRun.report.changedRows, 1);
    assert.equal(fs.existsSync(dryRun.backupFile), false);

    const applied = runInventoryValueBackfill("apply", { cacheFile, evidenceDir });
    assert.equal(applied.report.changedRows, 1);
    assert.equal(applied.report.changedDetailRows, 1);
    assert.equal(applied.postApplyDryRun.changedRows, 0);
    assert.equal(applied.postApplyDryRun.changedDetailRows, 0);
    assert.equal(fs.existsSync(applied.backup.file || applied.backup.path), true);
    assert.equal(fs.existsSync(applied.auditFile), true);
    assert.equal(runInventoryValueBackfill("dry-run", { cacheFile, evidenceDir }).report.changedRows, 0);

    const restored = runInventoryValueBackfill("restore", { cacheFile, evidenceDir });
    assert.equal(restored.restored, true);
    const restoredCache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert.equal(restoredCache.tables.inventarios.rows[0].valor_total, 78691346.96);
    assert.equal(restoredCache.tables.detalle_inventarios.rows[0].costo_unitario_usado, 733853.7);

    runInventoryValueBackfill("apply", { cacheFile, evidenceDir });
    const laterCache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    laterCache.laterWrite = true;
    fs.writeFileSync(cacheFile, JSON.stringify(laterCache, null, 2));
    assert.throws(
      () => runInventoryValueBackfill("restore", { cacheFile, evidenceDir }),
      (error) => error.code === "INVENTORY_BACKFILL_RESTORE_TARGET_DRIFT"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("un fallo posterior no revierte una escritura concurrente posterior", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-inventory-concurrency-"));
  try {
    const cacheFile = path.join(tempDir, "backend-data-cache.json");
    const evidenceDir = path.join(tempDir, "evidence");
    fs.writeFileSync(cacheFile, JSON.stringify(fixtureCache(), null, 2));

    assert.throws(
      () => runInventoryValueBackfill("apply", {
        cacheFile,
        evidenceDir,
        afterWrite: () => {
          const concurrent = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
          concurrent.concurrentWrite = true;
          fs.writeFileSync(cacheFile, JSON.stringify(concurrent, null, 2));
          throw new Error("fallo posterior simulado");
        }
      }),
      /fallo posterior simulado/
    );
    assert.equal(JSON.parse(fs.readFileSync(cacheFile, "utf8")).concurrentWrite, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
