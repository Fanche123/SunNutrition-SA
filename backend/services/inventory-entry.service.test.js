const assert = require("node:assert/strict");
const test = require("node:test");

const { payrollCalendarForYear } = require("../../assets/js/config/payroll-calendars");
const InventoryPurchaseEvaluation = require("../../shared/inventory-purchase-evaluation");
const { createInventoryEntryService } = require("./inventory-entry.service");
const {
  SNAPSHOT_STATES,
  SNAPSHOT_VERSION,
  createInventoryPurchaseSnapshotService
} = require("./inventory-purchase-snapshot.service");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function backendId(value) {
  return String(value ?? "").trim();
}

function backendIsoDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function nextId(rows, column) {
  return rows.reduce((maximum, row) => Math.max(maximum, Number(row[column]) || 0), 0) + 1;
}

function ensureTable(tables, name) {
  if (!tables[name]) tables[name] = { rows: [], headers: [], rowCount: 0 };
}

function baseCache() {
  return {
    generatedAt: "",
    tables: {
      inventarios: { rows: [], headers: [], rowCount: 0 },
      detalle_inventarios: { rows: [], headers: [], rowCount: 0 },
      items: {
        rows: [
          { id_item: 101, origen_tipo: "insumo", id_origen: 10, ud_conteo: "Kg" },
          { id_item: 102, origen_tipo: "insumo", id_origen: 11, ud_conteo: "Lt" }
        ]
      },
      insumos: {
        rows: [
          { id_insumo: 10, nombre: "Azucar", ud_receta: "Kg" },
          { id_insumo: 11, nombre: "Aceite", ud_receta: "Lt" }
        ]
      },
      proveedores: {
        rows: [{ id_proveedor: 20, nombre: "Proveedor Uno", tiempo_estimado_entrega: 5 }]
      },
      insumos_proveedores: {
        rows: [
          { id_insumos_proveedores: 30, id_insumo: 10, id_proveedor: 20 },
          { id_insumos_proveedores: 31, id_insumo: 11, id_proveedor: 20 }
        ]
      },
      compras: {
        rows: [{ id_compra: 40, id_proveedor: 20, fecha_pedido: "2026-07-10", fecha_entrega_prevista: "2026-07-15" }]
      },
      detalle_compras: {
        rows: [
          { id_detalle_compra: 50, id_compra: 40, id_insumos_proveedores: 30 },
          { id_detalle_compra: 51, id_compra: 40, id_insumos_proveedores: 31 }
        ]
      }
    }
  };
}

function historicalCache() {
  const cache = baseCache();
  cache.tables.items.rows.push(
    { id_item: 103, origen_tipo: "insumo", id_origen: 12, ud_conteo: "Ud" }
  );
  cache.tables.insumos.rows.push(
    { id_insumo: 12, nombre: "Bobina_Barra_Pop", ud_receta: "Ud" }
  );
  cache.tables.insumos_proveedores.rows.push(
    { id_insumos_proveedores: 32, id_insumo: 12, id_proveedor: 20 }
  );
  cache.tables.detalle_compras.rows.push(
    { id_detalle_compra: 52, id_compra: 40, id_insumos_proveedores: 32 }
  );
  cache.tables.inventarios.rows.push(
    { id_inventario: 1705, fecha: "2026-07-03", turno: "Mañana", id_empleado: 4 },
    { id_inventario: 1706, fecha: "2026-07-03", turno: "Tarde", id_empleado: 4 }
  );
  cache.tables.detalle_inventarios.rows.push(
    { id_detalle_inventario: 1, id_inventario: 1705, id_item: 101, cantidad: 10000 },
    { id_detalle_inventario: 2, id_inventario: 1705, id_item: 102, cantidad: 150 },
    { id_detalle_inventario: 3, id_inventario: 1705, id_item: 103, cantidad: 10 },
    { id_detalle_inventario: 4, id_inventario: 1706, id_item: 101, cantidad: 10000 },
    { id_detalle_inventario: 5, id_inventario: 1706, id_item: 102, cantidad: 150 },
    { id_detalle_inventario: 6, id_inventario: 1706, id_item: 103, cantidad: 10 }
  );
  return cache;
}

function createHarness(initialCache = baseCache()) {
  let persisted = clone(initialCache);
  const responses = [];
  let saveCount = 0;
  const snapshotService = createInventoryPurchaseSnapshotService({
    backendId,
    backendIsoDate,
    defaultInventoryItemName: (itemId) => `Item ${itemId}`,
    payrollCalendarForYear
  });
  const dependencies = {
    backendId,
    backendIsoDate,
    backendNextNumericId: nextId,
    defaultInventoryItemName: (itemId) => `Item ${itemId}`,
    ensureBackendTable: ensureTable,
    inventoryItemNameMap: () => new Map(),
    isIsoDate: (value) => Boolean(backendIsoDate(value)),
    loadCache: () => clone(persisted),
    logError: () => {},
    nextBusinessDayIso: (value) => value,
    normalizeInventoryDetailRows: (rows) => rows.map((row) => ({
      itemId: backendId(row.itemId),
      dawn: row.dawn ?? "",
      morning: row.morning ?? "",
      afternoon: row.afternoon ?? ""
    })),
    normalizeSelectedInventoryShifts: (shifts) => (
      ["dawn", "morning", "afternoon"].filter((shift) => (shifts || []).includes(shift))
    ),
    readJsonBody: async (request) => request.body,
    resolveInventoryEmployeeId: () => "employee-1",
    saveBackendCache: (cache) => {
      saveCount += 1;
      persisted = clone(cache);
    },
    sendJson: (_response, status, payload) => responses.push({ status, payload }),
    valueBackendInventories: () => {},
    ...snapshotService
  };
  return {
    cache: () => clone(persisted),
    dependencies,
    responses,
    saveCount: () => saveCount
  };
}

async function submit(service, body) {
  await service.handleInventoryFullEntry({ body }, {});
}

function payload(date, rows) {
  return {
    date,
    employee: "Operario",
    selectedShifts: ["afternoon"],
    rows
  };
}

test("la regla compartida conserva umbral, decimales, cero e invalidos", () => {
  const daily = 496.65 * 0.143;
  assert.equal(InventoryPurchaseEvaluation.dailyConsumptionForItem("Azúcar"), daily);
  assert.equal(InventoryPurchaseEvaluation.inventoryPurchaseAlert({
    itemName: "Azucar",
    stock: daily * 4,
    provider: "Proveedor",
    leadDays: 5,
    businessDays: 4
  }), null);

  const zero = InventoryPurchaseEvaluation.inventoryPurchaseAlert({
    itemId: 1,
    itemName: "Azucar",
    stock: 0,
    unit: "Kg",
    provider: "Proveedor",
    leadDays: 5,
    businessDays: 4
  });
  assert.equal(zero.shouldBuy, true);
  assert.equal(zero.daysRemaining, 0);
  assert.equal(InventoryPurchaseEvaluation.inventoryPurchaseAlert({
    itemName: "Sin consumo",
    stock: 0,
    provider: "Proveedor",
    leadDays: 5,
    businessDays: 4
  }), null);
  assert.equal(InventoryPurchaseEvaluation.inventoryPurchaseAlert({
    itemName: "Azucar",
    stock: "invalido",
    provider: "Proveedor",
    leadDays: 5,
    businessDays: 4
  }), null);
  assert.equal(InventoryPurchaseEvaluation.inventoryPurchaseAlert({
    itemName: "Azucar",
    stock: "",
    provider: "Proveedor",
    leadDays: 5,
    businessDays: 4
  }), null);
});

test("la produccion diaria canonica escala cobertura y clasificacion de forma monotona", () => {
  const baseInput = {
    itemName: "Aceite",
    stock: 200,
    unit: "Kg",
    provider: "Proveedor",
    leadDays: 5,
    businessDays: 4
  };
  const atTwentyThousand = InventoryPurchaseEvaluation.inventoryPurchaseMetrics({
    ...baseInput,
    barsPerDay: 20000
  });
  const atFortyThousand = InventoryPurchaseEvaluation.inventoryPurchaseMetrics({
    ...baseInput,
    barsPerDay: 40000
  });
  const crossingStock = (atTwentyThousand.required + atFortyThousand.required) / 2;
  const lowProduction = InventoryPurchaseEvaluation.inventoryPurchaseMetrics({
    ...baseInput,
    stock: crossingStock,
    barsPerDay: 20000
  });
  const highProduction = InventoryPurchaseEvaluation.inventoryPurchaseMetrics({
    ...baseInput,
    stock: crossingStock,
    barsPerDay: 40000
  });

  assert.equal(atTwentyThousand.barsPerDay, 20000);
  assert.equal(atFortyThousand.barsPerDay, 40000);
  assert.ok(atTwentyThousand.daysRemaining > atFortyThousand.daysRemaining);
  assert.equal(lowProduction.shouldBuy, false);
  assert.equal(highProduction.shouldBuy, true);
  assert.ok(highProduction.dailyConsumption > lowProduction.dailyConsumption);
});

test("la configuracion usa 30.100 por compatibilidad y rechaza valores fuera del contrato", () => {
  assert.equal(
    InventoryPurchaseEvaluation.normalizeBarsPerDay(undefined),
    InventoryPurchaseEvaluation.DEFAULT_BARS_PER_DAY
  );
  assert.equal(InventoryPurchaseEvaluation.DEFAULT_BARS_PER_DAY, 30100);
  [0, -1, 1.5, 1000001, "20.000", "texto", Infinity, NaN].forEach((value) => {
    assert.equal(Number.isNaN(InventoryPurchaseEvaluation.normalizeBarsPerDay(value, NaN)), true);
  });
});

test("sin snapshot reconstruye el ultimo lote historico completo con la regla canonica sin escribir", async () => {
  const harness = createHarness(historicalCache());
  const service = createInventoryEntryService(harness.dependencies);
  await service.handleInventoryPurchaseSnapshot({});
  const snapshot = harness.responses.at(-1).payload.snapshot;

  assert.equal(harness.saveCount(), 0);
  assert.equal(snapshot.version, SNAPSHOT_VERSION);
  assert.equal(snapshot.source, "reconstructed");
  assert.equal(snapshot.state, SNAPSHOT_STATES.VALID_WITH_ALERTS);
  assert.equal(snapshot.inventoryDate, "2026-07-03");
  assert.equal(snapshot.barsPerDay, 30100);
  assert.deepEqual(snapshot.inventoryIds, ["1705", "1706"]);
  assert.deepEqual(snapshot.items.map((item) => item.itemName).sort(), ["Aceite", "Bobina_Barra_Pop"]);
  assert.equal(snapshot.items.find((item) => item.itemName === "Aceite").stock, 150);
  assert.equal(snapshot.items.find((item) => item.itemName === "Bobina_Barra_Pop").stock, 10);
  snapshot.items.forEach((item) => {
    assert.equal(item.shouldBuy, undefined);
    assert.ok(item.daysRemaining > 0);
    assert.ok(item.stock < item.required);
  });
});

test("el endpoint persiste el parametro y recalcula la misma fotografia sin tocar tablas", async () => {
  const harness = createHarness(historicalCache());
  let service = createInventoryEntryService(harness.dependencies);
  const originalTables = harness.cache().tables;

  await service.handleInventoryPurchaseProductionRate({ body: { barsPerDay: 20000 } }, {});
  const twentyThousandResponse = harness.responses.at(-1);
  const twentyThousandSnapshot = twentyThousandResponse.payload.snapshot;
  const twentyThousandDays = twentyThousandSnapshot.items
    .find((item) => item.itemName === "Aceite").daysRemaining;

  assert.equal(twentyThousandResponse.status, 200);
  assert.equal(harness.cache().inventoryPurchaseConfig.barsPerDay, 20000);
  assert.equal(harness.cache().inventoryPurchaseSnapshot.barsPerDay, 20000);
  assert.deepEqual(harness.cache().tables, originalTables);

  service = createInventoryEntryService(harness.dependencies);
  await service.handleInventoryPurchaseSnapshot({});
  assert.equal(harness.responses.at(-1).payload.snapshot.barsPerDay, 20000);

  await service.handleInventoryPurchaseProductionRate({ body: { barsPerDay: 40000 } }, {});
  const fortyThousandSnapshot = harness.responses.at(-1).payload.snapshot;
  const fortyThousandDays = fortyThousandSnapshot.items
    .find((item) => item.itemName === "Aceite").daysRemaining;

  assert.equal(fortyThousandSnapshot.barsPerDay, 40000);
  assert.ok(twentyThousandDays > fortyThousandDays);
  assert.deepEqual(harness.cache().tables, originalTables);
});

test("un parametro invalido o un fallo de guardado conserva el ultimo valor valido", async () => {
  const harness = createHarness(historicalCache());
  let service = createInventoryEntryService(harness.dependencies);
  await service.handleInventoryPurchaseProductionRate({ body: { barsPerDay: 20000 } }, {});
  const persisted = harness.cache();
  const savesBeforeInvalid = harness.saveCount();

  for (const value of [0, -1, "", "texto", "20000", "20.000", true, [20000], 1.5, 1000001]) {
    await service.handleInventoryPurchaseProductionRate({ body: { barsPerDay: value } }, {});
    assert.equal(harness.responses.at(-1).status, 400);
  }
  assert.equal(harness.saveCount(), savesBeforeInvalid);
  assert.deepEqual(harness.cache(), persisted);

  harness.dependencies.saveBackendCache = () => {
    throw new Error("fallo de guardado");
  };
  service = createInventoryEntryService(harness.dependencies);
  await service.handleInventoryPurchaseProductionRate({ body: { barsPerDay: 40000 } }, {});

  assert.equal(harness.responses.at(-1).status, 500);
  assert.match(harness.responses.at(-1).payload.error, /último valor válido/i);
  assert.deepEqual(harness.cache(), persisted);
});

test("una carga valida posterior conserva el parametro y reemplaza la evaluacion", async () => {
  const harness = createHarness();
  const service = createInventoryEntryService(harness.dependencies);
  await service.handleInventoryPurchaseProductionRate({ body: { barsPerDay: 20000 } }, {});
  await submit(service, payload("2026-07-20", [{ itemId: 101, afternoon: 0 }]));

  assert.equal(harness.cache().inventoryPurchaseConfig.barsPerDay, 20000);
  assert.equal(harness.cache().inventoryPurchaseSnapshot.barsPerDay, 20000);
  assert.equal(harness.cache().inventoryPurchaseSnapshot.inventoryDate, "2026-07-20");
});

test("la reconstruccion usa el tramo final del mismo dia sin mezclar una carga anterior", () => {
  const cache = historicalCache();
  cache.tables.inventarios.rows.push(
    { id_inventario: 1707, fecha: "2026-07-03", turno: "Mañana", id_empleado: 4 },
    { id_inventario: 1708, fecha: "2026-07-03", turno: "Tarde", id_empleado: 4 }
  );
  cache.tables.detalle_inventarios.rows.push(
    { id_detalle_inventario: 7, id_inventario: 1707, id_item: 102, cantidad: 10000 },
    { id_detalle_inventario: 8, id_inventario: 1707, id_item: 103, cantidad: 10000 },
    { id_detalle_inventario: 9, id_inventario: 1708, id_item: 102, cantidad: 10000 },
    { id_detalle_inventario: 10, id_inventario: 1708, id_item: 103, cantidad: 10000 }
  );
  const harness = createHarness(cache);
  const snapshot = harness.dependencies.readInventoryPurchaseSnapshot(harness.cache());

  assert.deepEqual(snapshot.inventoryIds, ["1707", "1708"]);
  assert.equal(snapshot.state, SNAPSHOT_STATES.VALID_NO_ALERTS);
  assert.deepEqual(snapshot.items, []);
});

test("un insumo omitido en el ultimo lote usa su existencia del inventario anterior", () => {
  const cache = baseCache();
  cache.tables.inventarios.rows.push(
    { id_inventario: 1, fecha: "2026-07-02", turno: "Tarde", id_empleado: 4 },
    { id_inventario: 2, fecha: "2026-07-03", turno: "Tarde", id_empleado: 4 }
  );
  cache.tables.detalle_inventarios.rows.push(
    { id_detalle_inventario: 1, id_inventario: 1, id_item: 102, cantidad: 0 },
    { id_detalle_inventario: 2, id_inventario: 2, id_item: 101, cantidad: 10000 }
  );
  const harness = createHarness(cache);
  const snapshot = harness.dependencies.readInventoryPurchaseSnapshot(harness.cache());

  assert.equal(snapshot.state, SNAPSHOT_STATES.VALID_WITH_ALERTS);
  assert.deepEqual(snapshot.items.map((item) => item.itemName), ["Aceite"]);
  assert.equal(snapshot.items[0].stock, 0);
  assert.deepEqual(snapshot.unavailableItems, []);
});

test("un insumo canonico sin detalle actual ni existencia previa no produce un vacio valido falso", () => {
  const cache = baseCache();
  cache.tables.inventarios.rows.push(
    { id_inventario: 1, fecha: "2026-07-03", turno: "Tarde", id_empleado: 4 }
  );
  cache.tables.detalle_inventarios.rows.push(
    { id_detalle_inventario: 1, id_inventario: 1, id_item: 101, cantidad: 10000 }
  );
  const harness = createHarness(cache);
  const snapshot = harness.dependencies.readInventoryPurchaseSnapshot(harness.cache());
  const unavailableAceite = snapshot.unavailableItems.find((item) => item.itemName === "Aceite");

  assert.equal(snapshot.state, SNAPSHOT_STATES.INSUFFICIENT_DEPENDENCIES);
  assert.deepEqual(snapshot.items, []);
  assert.ok(unavailableAceite);
  assert.ok(unavailableAceite.missingDependencies.includes("stock"));
  assert.ok(unavailableAceite.missingDependencies.includes("inventory_details"));
});

test("un snapshot vigente queda fijo y uno obsoleto se reconstruye desde tablas", async () => {
  const harness = createHarness();
  const service = createInventoryEntryService(harness.dependencies);
  await submit(service, payload("2026-07-02", [{ itemId: 101, afternoon: 0 }]));
  const stored = harness.dependencies.readInventoryPurchaseSnapshot(harness.cache());
  assert.equal(stored.source, "stored");
  assert.equal(stored.inventoryDate, "2026-07-02");

  const cache = historicalCache();
  cache.inventoryPurchaseSnapshot = stored;
  const historicalHarness = createHarness(cache);
  const rebuilt = historicalHarness.dependencies.readInventoryPurchaseSnapshot(historicalHarness.cache());
  assert.equal(rebuilt.source, "reconstructed");
  assert.equal(rebuilt.inventoryDate, "2026-07-03");
  assert.deepEqual(rebuilt.inventoryIds, ["1705", "1706"]);
});

test("distingue ausencia de inventario, dependencias insuficientes y evaluacion valida sin alertas", () => {
  const emptyHarness = createHarness();
  const noInventory = emptyHarness.dependencies.readInventoryPurchaseSnapshot(emptyHarness.cache());
  assert.equal(noInventory.state, SNAPSHOT_STATES.NO_INVENTORY);
  assert.equal(noInventory.inventoryDate, "");

  const incompleteCache = historicalCache();
  incompleteCache.tables.detalle_compras.rows = [];
  const incompleteHarness = createHarness(incompleteCache);
  const incomplete = incompleteHarness.dependencies.readInventoryPurchaseSnapshot(incompleteHarness.cache());
  assert.equal(incomplete.state, SNAPSHOT_STATES.INSUFFICIENT_DEPENDENCIES);
  assert.equal(incomplete.items.length, 0);
  assert.deepEqual(
    incomplete.unavailableItems.map((item) => item.itemName).sort(),
    ["Aceite", "Azucar", "Bobina_Barra_Pop"]
  );
  incomplete.unavailableItems.forEach((item) => {
    assert.ok(item.missingDependencies.includes("provider"));
    assert.ok(item.missingDependencies.includes("lead_days"));
  });

  const completeCache = historicalCache();
  completeCache.tables.detalle_inventarios.rows.forEach((row) => {
    row.cantidad = 10000;
  });
  const completeHarness = createHarness(completeCache);
  const noAlerts = completeHarness.dependencies.readInventoryPurchaseSnapshot(completeHarness.cache());
  assert.equal(noAlerts.state, SNAPSHOT_STATES.VALID_NO_ALERTS);
  assert.deepEqual(noAlerts.items, []);
  assert.deepEqual(noAlerts.unavailableItems, []);
});

test("una carga exitosa fija la evaluacion y una posterior la reemplaza sin mezclar", async () => {
  const harness = createHarness();
  const service = createInventoryEntryService(harness.dependencies);
  await submit(service, payload("2026-07-20", [
    { itemId: 101, afternoon: 10 },
    { itemId: 102, afternoon: 1000 }
  ]));

  assert.equal(harness.responses.at(-1).status, 200);
  const first = harness.cache().inventoryPurchaseSnapshot;
  assert.equal(first.inventoryDate, "2026-07-20");
  assert.deepEqual(first.items.map((item) => item.itemName), ["Azucar"]);
  assert.equal(first.items[0].stock, 10);
  assert.equal(first.items[0].unit, "Kg");
  assert.ok(first.items[0].daysRemaining > 0 && first.items[0].daysRemaining < 1);

  await submit(service, payload("2026-07-21", [
    { itemId: 101, afternoon: 1000 },
    { itemId: 102, afternoon: 1 }
  ]));
  const second = harness.cache().inventoryPurchaseSnapshot;
  assert.equal(second.inventoryDate, "2026-07-21");
  assert.deepEqual(second.items.map((item) => item.itemName), ["Aceite"]);
});

test("una carga posterior sin alertas limpia la anterior y sobrevive a una nueva instancia", async () => {
  const harness = createHarness();
  let service = createInventoryEntryService(harness.dependencies);
  await submit(service, payload("2026-07-20", [{ itemId: 101, afternoon: 0 }]));
  assert.equal(harness.cache().inventoryPurchaseSnapshot.items.length, 1);

  await submit(service, payload("2026-07-21", [{ itemId: 101, afternoon: 1000 }]));
  assert.deepEqual(harness.cache().inventoryPurchaseSnapshot.items, []);

  service = createInventoryEntryService(harness.dependencies);
  await service.handleInventoryPurchaseSnapshot({});
  assert.equal(harness.responses.at(-1).status, 200);
  assert.deepEqual(harness.responses.at(-1).payload.snapshot.items, []);
  assert.equal(harness.responses.at(-1).payload.snapshot.inventoryDate, "2026-07-21");
});

test("una carga fallida no reemplaza la ultima evaluacion valida", async () => {
  const harness = createHarness();
  const service = createInventoryEntryService(harness.dependencies);
  await submit(service, payload("2026-07-20", [{ itemId: 101, afternoon: 0 }]));
  const before = harness.cache().inventoryPurchaseSnapshot;
  const savesBefore = harness.saveCount();

  await assert.rejects(
    () => submit(service, payload("2027-07-20", [{ itemId: 101, afternoon: 0 }])),
    /Calendario laboral no configurado para 2027/
  );
  assert.equal(harness.saveCount(), savesBefore);
  assert.deepEqual(harness.cache().inventoryPurchaseSnapshot, before);
});

test("un fallo de persistencia conserva la fotografia anterior", async () => {
  const harness = createHarness();
  const service = createInventoryEntryService(harness.dependencies);
  await submit(service, payload("2026-07-20", [{ itemId: 101, afternoon: 0 }]));
  const before = harness.cache();
  harness.dependencies.saveBackendCache = () => {
    throw new Error("fallo de guardado");
  };
  const failingService = createInventoryEntryService(harness.dependencies);

  await assert.rejects(
    () => submit(failingService, payload("2026-07-21", [{ itemId: 101, afternoon: 1000 }])),
    /fallo de guardado/
  );
  assert.deepEqual(harness.cache(), before);
});

test("una segunda carga del mismo dia queda identificada por el inventario mas nuevo", async () => {
  const harness = createHarness();
  const service = createInventoryEntryService(harness.dependencies);
  await submit(service, payload("2026-07-20", [{ itemId: 101, afternoon: 0 }]));
  await submit(service, payload("2026-07-20", [{ itemId: 101, afternoon: 1000 }]));
  await service.handleInventoryPurchaseSnapshot({});

  const snapshot = harness.responses.at(-1).payload.snapshot;
  assert.equal(snapshot.inventoryDate, "2026-07-20");
  assert.deepEqual(snapshot.items, []);
  assert.deepEqual(snapshot.inventoryIds, ["2"]);
});

test("una carga con cantidad vacia usa la ultima existencia persistida", async () => {
  const cache = baseCache();
  cache.tables.inventarios.rows.push({ id_inventario: 1, fecha: "2026-07-17", turno: "Tarde" });
  cache.tables.detalle_inventarios.rows.push({
    id_detalle_inventario: 1,
    id_inventario: 1,
    id_item: 101,
    cantidad: 2.5
  });
  const harness = createHarness(cache);
  const service = createInventoryEntryService(harness.dependencies);
  await submit(service, payload("2026-07-20", [{ itemId: 101, afternoon: "" }]));
  assert.equal(harness.cache().inventoryPurchaseSnapshot.items[0].stock, 2.5);
});
