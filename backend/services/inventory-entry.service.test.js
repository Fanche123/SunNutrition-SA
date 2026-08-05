const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { payrollCalendarForYear } = require("../../assets/js/config/payroll-calendars");
const InventoryPurchaseEvaluation = require("../../shared/inventory-purchase-evaluation");
const {
  createInventoryEntryService,
  deliveredIndividualUnits,
  inventoryDeliveryExits,
  inventoryReceptionEntries
} = require("./inventory-entry.service");
const {
  SNAPSHOT_STATES,
  SNAPSHOT_VERSION,
  createInventoryPurchaseSnapshotService
} = require("./inventory-purchase-snapshot.service");
const { createInventoryPhotoService } = require("./inventory-photo.service");
const { normalizeInventoryToken } = require("./inventory-photo-mapping.service");

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
      contadores_alipack: { rows: [], headers: [], rowCount: 0 },
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
  const errors = [];
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
    logError: (error) => errors.push(String(error?.stack || error)),
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
    errors,
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

test("las salidas teoricas usan la entrega real, deduplican su vinculo y aplican el corte de Mañana", async () => {
  const cache = historicalCache();
  cache.tables.productos = {
    rows: [{ id_producto: 67, id_item: 118, nombre_producto: "Barra_Pop_140Ud", cantidad_individual: 140 }]
  };
  cache.tables.detalle_pedidos = {
    rows: [{ id_detalle_pedido: 1031, id_pedido: 1000, id_producto: 67, cantidad_cajas: 100 }]
  };
  cache.tables.entregas = {
    rows: [{ id_entrega: 570, fecha: "2026-07-06" }]
  };
  cache.tables.entregas_detalle = {
    rows: [
      { id_entregas_detalle: 1001, id_entrega: 570, id_pedido: 1000 },
      { id_entregas_detalle: 1002, id_entrega: 570, id_pedido: 1000 }
    ]
  };
  cache.tables.ventas = {
    rows: [
      { id_venta: 1020, id_entrega: 570, id_pedido: 1000, fecha_factura: "2026-07-10" },
      { id_venta: 1021, id_entrega: 570, id_pedido: 1000, fecha_factura: "2026-07-11" }
    ]
  };

  const exits = inventoryDeliveryExits(cache);
  assert.deepEqual(exits, [{
    deliveryId: "570",
    orderId: "1000",
    orderDetailId: "1031",
    date: "2026-07-06",
    shift: "morning",
    itemId: "118",
    productName: "Barra_Pop_140Ud",
    quantity: 100,
    unitsPerBox: 140,
    individualQuantity: 14000
  }]);

  const context = {
    inventoryDetailTemplate: { salesExits: exits },
    normalizeCategory: (value) => String(value || "").replaceAll("_", " ").toLowerCase(),
    selectedInventoryShifts: () => ["morning", "afternoon"]
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../../assets/js/modules/inventory-counter-review.js"), "utf8"),
    context
  );
  const morningSales = context.orderDetailsUnitsForDateAndProduct("2026-07-06", "Barra_Pop_140Ud", "morning", "118");
  const morningIndividualUnits = context.orderDetailsIndividualUnitsForDateAndProduct(
    "2026-07-06",
    "Barra_Pop_140Ud",
    "morning",
    "118"
  );
  const afternoonSales = context.orderDetailsUnitsForDateAndProduct("2026-07-06", "Barra_Pop_140Ud", "afternoon", "118");
  assert.equal(morningSales, 100);
  assert.equal(morningIndividualUnits, 14000);
  assert.equal(afternoonSales, 0);
  assert.equal(133 - morningSales, 33);
  assert.equal(morningIndividualUnits + ((26 - 97) * 140) + ((6.5 - 2.5) * 2000), 12060);
  assert.equal(Math.round((((12100 - 12060) / 12060) * 100) * 100) / 100, 0.33);
  assert.equal(0 + ((81 - 26) * 140) + ((7 - 6.5) * 2000), 8700);

  context.selectedInventoryShifts = () => ["afternoon"];
  assert.equal(
    context.orderDetailsUnitsForDateAndProduct("2026-07-06", "Barra_Pop_140Ud", "afternoon", "118"),
    100
  );
});

test("las entradas teoricas usan recepciones reales, detalle recibido, unidad de conteo y un unico corte de Mañana", () => {
  const cache = baseCache();
  cache.tables.items.rows.push({ id_item: 103, origen_tipo: "insumo", id_origen: 12, ud_conteo: "" });
  cache.tables.insumos.rows.push({ id_insumo: 12, nombre: "Sin unidad", ud_receta: "Bolsa" });
  cache.tables.recepciones = { rows: [
    { id_recepcion: 195, fecha_recepcion: "2026-07-06", id_compra: 195 },
    { id_recepcion: 196, fecha_recepcion: "2026-07-06", id_compra: 195 },
    { id_recepcion: 197, fecha_recepcion: "2026-07-06", id_compra: 197 },
    { id_recepcion: 198, fecha_recepcion: "2026-07-06", id_compra: 198 }
  ] };
  cache.tables.detalle_recepciones = { rows: [
    { id_detalle_recepcion: 210, id_recepcion: 195, id_insumo: 10, cantidad_recibida: 1000 },
    { id_detalle_recepcion: 210, id_recepcion: 195, id_insumo: 10, cantidad_recibida: 1000 },
    { id_detalle_recepcion: 211, id_recepcion: 196, id_insumo: 10, cantidad_recibida: 250 },
    { id_detalle_recepcion: 212, id_recepcion: 197, id_insumo: 11, cantidad_recibida: 30 },
    { id_detalle_recepcion: 213, id_recepcion: 198, id_insumo: 12, cantidad_recibida: 5 },
    { id_detalle_recepcion: 214, id_recepcion: 999, id_insumo: 10, cantidad_recibida: 500 }
  ] };

  const entries = inventoryReceptionEntries(cache);
  assert.deepEqual(entries, [
    {
      receptionId: "195",
      receptionDetailId: "210",
      date: "2026-07-06",
      shift: "morning",
      itemId: "101",
      quantity: 1000,
      unit: "Kg"
    },
    {
      receptionId: "196",
      receptionDetailId: "211",
      date: "2026-07-06",
      shift: "morning",
      itemId: "101",
      quantity: 250,
      unit: "Kg"
    },
    {
      receptionId: "197",
      receptionDetailId: "212",
      date: "2026-07-06",
      shift: "morning",
      itemId: "102",
      quantity: 30,
      unit: "Lt"
    }
  ]);
  assert.equal(entries.filter((entry) => entry.itemId === "101").reduce((sum, entry) => sum + entry.quantity, 0), 1250);

  const theoreticalContext = {
    inventoryDetailTemplate: { receptionEntries: entries.slice(0, 1) },
    inventoryPhotoApplied: true,
    normalizeCategory: (value) => String(value || "").replaceAll("_", " ").toLowerCase(),
    inventoryDetailTableRows: () => [
      { itemId: "101", itemName: "Maiz_Pisingallo", element: { key: "maiz" } },
      { itemId: "900", itemName: "Granel Dulce", element: { key: "granel" } }
    ],
    recipeRowsForTheoreticalStock: () => [],
    currentCounterUnits: () => 12060,
    isNeutralTheoreticalStockItem: (name) => name === "Granel Dulce",
    isBarraPopName: () => false,
    initialDetailStockForShift: (element) => element.key === "maiz" ? 1625 : 15.21568093385214,
    currentDetailStockForShift: (element) => element.key === "maiz" ? 2400 : 10,
    orderDetailsUnitsForDateAndProduct: () => 0,
    theoreticalRecipeUnitFactor: () => 1,
    granelDulceIngredientCoefficient: (name) => name === "maiz pisingallo" ? 1.285 : NaN
  };
  theoreticalContext.selectedInventoryShifts = () => ["morning", "afternoon"];
  theoreticalContext.inventoryShiftOrder = (shift) => ({ dawn: 0, morning: 1, afternoon: 2 }[shift] ?? -1);
  theoreticalContext.previousWorkedInventoryShift = (shift) => {
    const shifts = ["dawn", "morning", "afternoon"];
    const selected = new Set(theoreticalContext.selectedInventoryShifts());
    for (let index = shifts.indexOf(shift) - 1; index >= 0; index -= 1) {
      if (selected.has(shifts[index])) return shifts[index];
    }
    return "";
  };
  vm.createContext(theoreticalContext);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../../assets/js/modules/inventory-theoretical-model.js"), "utf8"),
    theoreticalContext
  );
  const morning = theoreticalContext.buildTheoreticalInventoryModel("2026-07-06", "morning")
    .rows.find((row) => row.itemId === "101");
  assert.ok(Math.abs(morning.theoreticalStock - 2376) < 0.000001);
  assert.equal(morning.receivedStock, 1000);
  assert.ok(Math.abs((((2400 - morning.theoreticalStock) / morning.theoreticalStock) * 100) - 1.0101010101) < 0.000001);
  assert.equal(theoreticalContext.receivedInventoryQuantityForDateAndItem("2026-07-06", "afternoon", "101"), 0);
  theoreticalContext.selectedInventoryShifts = () => ["afternoon"];
  assert.equal(theoreticalContext.receivedInventoryQuantityForDateAndItem("2026-07-06", "afternoon", "101"), 1000);
  assert.equal(theoreticalContext.receivedInventoryQuantityForDateAndItem("2026-07-06", "morning", "101"), 1000);
});

test("la conversion individual canonica no inventa factores ausentes", () => {
  assert.equal(deliveredIndividualUnits(100, 140), 14000);
  assert.equal(deliveredIndividualUnits(2, 50), 100);
  assert.equal(deliveredIndividualUnits(3, 1), 3);
  assert.equal(deliveredIndividualUnits(2.5, 40), 100);
  assert.equal(deliveredIndividualUnits(10, ""), null);
  assert.equal(deliveredIndividualUnits(10, 0), null);

  const context = {
    inventoryDetailTemplate: {
      salesExits: [{
        date: "2026-07-06",
        shift: "morning",
        itemId: "999",
        productName: "Producto_sin_factor",
        quantity: 10,
        individualQuantity: null
      }]
    },
    normalizeCategory: (value) => String(value || "").replaceAll("_", " ").toLowerCase(),
    selectedInventoryShifts: () => ["morning"]
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../../assets/js/modules/inventory-counter-review.js"), "utf8"),
    context
  );
  assert.equal(
    Number.isNaN(context.orderDetailsIndividualUnitsForDateAndProduct(
      "2026-07-06",
      "Producto_sin_factor",
      "morning",
      "999"
    )),
    true
  );
});

test("el preview del borrador usa el parametro canonico y no persiste", async () => {
  const cache = historicalCache();
  cache.inventoryPurchaseConfig = { version: 1, barsPerDay: 25000 };
  const harness = createHarness(cache);
  const service = createInventoryEntryService(harness.dependencies);

  await service.handleInventoryPurchaseDraft({ body: {
    date: "2026-07-06",
    selectedShifts: ["morning", "afternoon"],
    rows: [
      { itemId: 101, morning: 500, afternoon: 0 },
      { itemId: 102, morning: 500, afternoon: 500 },
      { itemId: 103, morning: 500, afternoon: 500 }
    ]
  } }, {});

  const response = harness.responses.at(-1);
  assert.equal(response.status, 200);
  assert.equal(harness.saveCount(), 0);
  assert.equal(response.payload.snapshot.source, "draft");
  assert.equal(response.payload.snapshot.barsPerDay, 25000);
  assert.equal(response.payload.snapshot.items.find((item) => item.itemName === "Azucar").stock, 0);

  await service.handleInventoryPurchaseDraft({ body: {
    date: "2026-07-06",
    selectedShifts: ["afternoon"],
    rows: [
      { itemId: 101, afternoon: "" },
      { itemId: 102, afternoon: 500 },
      { itemId: 103, afternoon: 500 }
    ]
  } }, {});
  const missing = harness.responses.at(-1).payload.snapshot;
  assert.equal(missing.state, SNAPSHOT_STATES.INSUFFICIENT_DEPENDENCIES);
  assert.ok(missing.unavailableItems.find((item) => (
    item.itemName === "Azucar" && item.missingDependencies.includes("stock")
  )));
  assert.equal(harness.saveCount(), 0);
});

test("preparar sin foto queda separado del OCR y el preview es una lectura sin persistencia", () => {
  const root = path.join(__dirname, "../..");
  const templateSource = fs.readFileSync(
    path.join(root, "assets/js/modules/inventory-detail-template.js"),
    "utf8"
  );
  const photoSource = fs.readFileSync(
    path.join(root, "assets/js/modules/inventory-detail-photo.js"),
    "utf8"
  );
  const purchaseSource = fs.readFileSync(
    path.join(root, "assets/js/modules/purchase-entry.js"),
    "utf8"
  );
  const submitSource = fs.readFileSync(
    path.join(root, "assets/js/modules/inventory-detail-submit.js"),
    "utf8"
  );
  const counterSource = fs.readFileSync(
    path.join(root, "assets/js/modules/inventory-counter-review.js"),
    "utf8"
  );
  const { READ_ONLY_POSTS } = require("./audit.service");
  const theoreticalSource = fs.readFileSync(
    path.join(root, "assets/js/modules/inventory-theoretical-model.js"),
    "utf8"
  );
  const granelStart = theoreticalSource.indexOf("function specialGranelIngredientTheoreticalStock(");
  const granelEnd = theoreticalSource.indexOf("function specialBobinaBarraPopTheoreticalStock(", granelStart);
  const granelSource = theoreticalSource.slice(granelStart, granelEnd);

  assert.match(templateSource, /\/api\/inventory-detail\/template/);
  assert.doesNotMatch(templateSource, /\/api\/inventory-detail\/photo|imageDataUrl|imageFileToDataUrl/);
  assert.match(photoSource, /\/api\/inventory-detail\/photo/);
  assert.match(photoSource, /imageFileToDataUrl/);
  assert.match(purchaseSource, /\/api\/inventory\/purchase-snapshot\/preview/);
  assert.match(purchaseSource, /window\.setTimeout\([\s\S]*?,\s*250\)/);
  assert.match(purchaseSource, /collectEditableInventoryDetailRows\(\)/);
  assert.match(purchaseSource, /Todavia no hay un detalle preparado para evaluar/);
  assert.match(purchaseSource, /Complet[^\n]+cantidades del[^\n]+ltimo turno seleccionado/);
  assert.match(purchaseSource, /no hay insumos a comprar/);
  assert.match(purchaseSource, /openPurchaseEntryForItem\(itemName, itemId = "", snapshot = inventoryPurchaseSnapshot\)/);
  assert.match(purchaseSource, /inventoryPurchaseSnapshotItem\([^\n]+snapshot\)/);
  assert.match(purchaseSource, /renderPurchaseInventorySuggestions\(payload\.snapshot\);[\s\S]*scheduleInventoryPurchaseDraftEvaluation\(\)/);
  assert.doesNotMatch(granelSource, /inventoryPhotoApplied|foto de inventario/);
  assert.doesNotMatch(submitSource, /receivedStock|receptionEntries/);
  assert.match(submitSource, /const counters = collectInventoryAlipackCounters\(\)/);
  assert.match(submitSource, /filter\(\(row\) => !isCounterAlipackName/);
  assert.match(counterSource, /counterFromLastPhotoTranscription\(shift\)/);
  assert.doesNotMatch(counterSource, /function syncManualCounterCorrection/);
  assert.match(submitSource, /if \(!response\.ok\) \{[\s\S]*?payload\.requestId[\s\S]*?throw new Error/);
  assert.match(submitSource, /renderInventoryDetailTemplate\(null\);[\s\S]*?catch \(error\)/);
  assert.equal(READ_ONLY_POSTS.has("/api/inventory/purchase-snapshot/preview"), true);
});

test("el envio manual exitoso persiste cabecera, detalle, snapshot e idempotencia en un unico guardado", async () => {
  const harness = createHarness();
  let valuationOptions;
  harness.dependencies.valueBackendInventories = (cache, inventoryIds, options) => {
    valuationOptions = options;
    const targetIds = new Set(inventoryIds.map(String));
    cache.tables.inventarios.rows
      .filter((row) => targetIds.has(String(row.id_inventario)))
      .forEach((row) => { row.valor_total = 123.45; });
    return { issues: [] };
  };
  const service = createInventoryEntryService(harness.dependencies);
  const before = harness.cache();
  await submit(service, {
    date: "2026-07-06",
    employee: "Operario",
    selectedShifts: ["morning", "afternoon"],
    counters: { morning: "1234.5", afternoon: "2345.75" },
    rows: [
      { itemId: 101, morning: 2400, afternoon: 2300 },
      { itemId: 102, morning: "", afternoon: 20 }
    ]
  });

  const response = harness.responses.at(-1);
  const saved = harness.cache();
  assert.equal(response.status, 200);
  assert.equal(response.payload.idempotent, false);
  assert.equal(response.payload.rowsWritten, 3);
  assert.equal(harness.saveCount(), 1);
  assert.equal(saved.tables.inventarios.rows.length - before.tables.inventarios.rows.length, 2);
  assert.deepEqual(saved.tables.inventarios.rows.map((row) => row.valor_total), [123.45, 123.45]);
  assert.equal(valuationOptions.allowStoredDetailCostFallback, false);
  assert.equal(saved.tables.detalle_inventarios.rows.length - before.tables.detalle_inventarios.rows.length, 3);
  assert.deepEqual(saved.tables.contadores_alipack.rows, [
    { id_contador_alipack: 1, id_inventario: 1, valor_contador: 1234.5 },
    { id_contador_alipack: 2, id_inventario: 2, valor_contador: 2345.75 }
  ]);
  assert.equal(response.payload.countersWritten, 2);
  assert.equal(saved.inventoryPurchaseSnapshot.inventoryDate, "2026-07-06");
  assert.equal(saved._inventoryFullEntryOperations.length, 1);
  assert.equal(saved.tables.recepciones, undefined);
  assert.equal(saved.tables.detalle_recepciones, undefined);
});

test("el envio manual resuelve un empleado nominal con el normalizador inyectado", async () => {
  const initialCache = baseCache();
  initialCache.tables.empleados = {
    rows: [{ id_empleado: 4, nombre_empleado: "María Pérez" }]
  };
  const harness = createHarness(initialCache);
  const photoService = createInventoryPhotoService({
    cleanBackendInput: (value) => String(value ?? "").trim(),
    loadCache: harness.dependencies.loadCache,
    normalizeInventoryToken
  });
  harness.dependencies.resolveInventoryEmployeeId = photoService.resolveInventoryEmployeeId;
  const service = createInventoryEntryService(harness.dependencies);

  await submit(service, {
    date: "2026-07-06",
    employee: "Maria Perez",
    selectedShifts: ["morning", "afternoon"],
    rows: [
      { itemId: 101, morning: "1376.5", afternoon: "2376.5" },
      { itemId: 102, morning: "", afternoon: "20.25" }
    ]
  });

  assert.equal(harness.responses.at(-1).status, 200);
  assert.equal(harness.cache().tables.inventarios.rows[0].id_empleado, "4");
  assert.equal(harness.saveCount(), 1);
});

test("un fallo intermedio devuelve error trazable y revierte cabeceras, detalles, snapshot y metadatos", async () => {
  const harness = createHarness(historicalCache());
  const before = harness.cache();
  harness.dependencies.valueBackendInventories = () => {
    const error = new Error("valuation-fixture-failure");
    error.code = "VALUATION_FIXTURE_FAILURE";
    throw error;
  };
  const service = createInventoryEntryService(harness.dependencies);
  await service.handleInventoryFullEntry({
    auditRequestId: "fixture-request-id",
    body: payload("2026-07-06", [{ itemId: 101, afternoon: 2400 }])
  }, {});

  const response = harness.responses.at(-1);
  assert.equal(response.status, 500);
  assert.equal(response.payload.code, "INVENTORY_FULL_ENTRY_FAILED");
  assert.equal(response.payload.requestId, "fixture-request-id");
  assert.match(response.payload.error, /No se realizo ningun cambio/i);
  assert.match(harness.errors.at(-1), /valuation-fixture-failure/);
  assert.match(harness.errors.at(-1), /inventory-entry\.service\.test\.js/);
  assert.equal(harness.saveCount(), 0);
  assert.deepEqual(harness.cache(), before);
});

test("un costo faltante rechaza la carga manual u OCR antes del unico guardado", async () => {
  const harness = createHarness();
  const before = harness.cache();
  harness.dependencies.valueBackendInventories = () => ({
    issues: [{ code: "MISSING_COST", inventoryId: "1", detailId: "1", itemId: "101", quantity: 5 }]
  });
  const service = createInventoryEntryService(harness.dependencies);

  await submit(service, payload("2026-07-06", [{ itemId: 101, afternoon: 5 }]));

  const response = harness.responses.at(-1);
  assert.equal(response.status, 422);
  assert.equal(response.payload.code, "INVENTORY_COST_UNAVAILABLE");
  assert.match(response.payload.error, /No se realizo ningun cambio/i);
  assert.equal(harness.saveCount(), 0);
  assert.deepEqual(harness.cache(), before);
});

test("reintentar exactamente el mismo payload devuelve los mismos ids sin duplicar", async () => {
  const harness = createHarness();
  const service = createInventoryEntryService(harness.dependencies);
  const requestPayload = {
    date: "2026-07-06",
    employee: "Operario",
    selectedShifts: ["afternoon", "morning"],
    counters: { morning: 111.25, afternoon: 222.5 },
    rows: [
      { itemId: 102, morning: 20, afternoon: 19 },
      { itemId: 101, morning: 2400, afternoon: 2300 }
    ]
  };
  await submit(service, requestPayload);
  const first = harness.responses.at(-1).payload;
  const afterFirst = harness.cache();
  await submit(service, {
    ...requestPayload,
    selectedShifts: ["morning", "afternoon"],
    rows: requestPayload.rows.slice().reverse()
  });
  const second = harness.responses.at(-1).payload;

  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.deepEqual(second.inventoryIds, first.inventoryIds);
  assert.equal(second.rowsWritten, first.rowsWritten);
  assert.equal(harness.saveCount(), 1);
  assert.deepEqual(harness.cache(), afterFirst);
});

test("un turno guarda un contador decimal y un contador vacio conserva el contrato opcional", async () => {
  const withCounter = createHarness();
  await submit(createInventoryEntryService(withCounter.dependencies), {
    date: "2026-07-06",
    employee: "Operario",
    selectedShifts: ["afternoon"],
    counters: { afternoon: "42.125" },
    rows: [{ itemId: 101, afternoon: 5 }]
  });
  assert.equal(withCounter.responses.at(-1).status, 200);
  assert.deepEqual(withCounter.cache().tables.contadores_alipack.rows, [
    { id_contador_alipack: 1, id_inventario: 1, valor_contador: 42.125 }
  ]);

  const withoutCounter = createHarness();
  await submit(createInventoryEntryService(withoutCounter.dependencies), {
    date: "2026-07-06",
    employee: "Operario",
    selectedShifts: ["afternoon"],
    counters: { afternoon: "" },
    rows: [{ itemId: 101, afternoon: 5 }]
  });
  assert.equal(withoutCounter.responses.at(-1).status, 200);
  assert.equal(withoutCounter.responses.at(-1).payload.countersWritten, 0);
  assert.deepEqual(withoutCounter.cache().tables.contadores_alipack.rows, []);
});

test("un item historico llamado Contador Alipack no vuelve a persistirse como detalle", async () => {
  const harness = createHarness();
  harness.dependencies.inventoryItemNameMap = () => new Map([
    ["101", "Azucar"],
    ["999", "Contador Alipack"]
  ]);
  await submit(createInventoryEntryService(harness.dependencies), {
    date: "2026-07-06",
    employee: "Operario",
    selectedShifts: ["afternoon"],
    counters: { afternoon: 321.5 },
    rows: [
      { itemId: 101, afternoon: 5 },
      { itemId: 999, afternoon: 321.5 }
    ]
  });
  assert.equal(harness.responses.at(-1).status, 200);
  assert.deepEqual(harness.cache().tables.detalle_inventarios.rows.map((row) => row.id_item), ["101"]);
  assert.equal(harness.cache().tables.contadores_alipack.rows[0].valor_contador, 321.5);
});

test("la plantilla oculta el item historico y conserva solo la fila canonica de interfaz", async () => {
  const cache = historicalCache();
  cache.tables.items.rows.push({ id_item: 0, origen_tipo: "contador", id_origen: 0, ud_conteo: "Ud" });
  cache.tables.detalle_inventarios.rows.push({
    id_detalle_inventario: 7,
    id_inventario: 1706,
    id_item: 0,
    cantidad: 456.75
  });
  const harness = createHarness(cache);
  harness.dependencies.inventoryItemNameMap = () => new Map([
    ["0", "Contador Alipack"],
    ["101", "Azucar"],
    ["102", "Aceite"],
    ["103", "Bobina_Barra_Pop"]
  ]);
  await createInventoryEntryService(harness.dependencies).handleInventoryDetailTemplate({});
  assert.equal(harness.responses.at(-1).status, 200);
  assert.equal(harness.responses.at(-1).payload.rows.some((row) => row.itemName === "Contador Alipack"), false);
});

test("la carga integral exige la migracion explicita y no autocrea la tabla", async () => {
  const cache = baseCache();
  delete cache.tables.contadores_alipack;
  const harness = createHarness(cache);
  const before = harness.cache();
  await submit(createInventoryEntryService(harness.dependencies), {
    date: "2026-07-06",
    employee: "Operario",
    selectedShifts: ["afternoon"],
    counters: { afternoon: 12.5 },
    rows: [{ itemId: 101, afternoon: 5 }]
  });
  assert.equal(harness.responses.at(-1).status, 503);
  assert.equal(harness.responses.at(-1).payload.code, "INVENTORY_ALIPACK_MIGRATION_REQUIRED");
  assert.match(harness.responses.at(-1).payload.error, /Falta aplicar la migracion/i);
  assert.equal(harness.saveCount(), 0);
  assert.deepEqual(harness.cache(), before);
});

test("un contador invalido se rechaza con mensaje comprensible antes de mutar", async () => {
  for (const invalid of [-1, "NaN", "Infinity", {}, true]) {
    const harness = createHarness();
    const before = harness.cache();
    await submit(createInventoryEntryService(harness.dependencies), {
      date: "2026-07-06",
      employee: "Operario",
      selectedShifts: ["afternoon"],
      counters: { afternoon: invalid },
      rows: [{ itemId: 101, afternoon: 5 }]
    });
    assert.equal(harness.responses.at(-1).status, 400);
    assert.equal(harness.responses.at(-1).payload.code, "INVALID_ALIPACK_COUNTER");
    assert.match(harness.responses.at(-1).payload.error, /finito y no negativo/i);
    assert.equal(harness.saveCount(), 0);
    assert.deepEqual(harness.cache(), before);
  }
});

test("el contador participa de la misma atomicidad sin alterar el cache persistido ante una falla", async () => {
  const harness = createHarness();
  const before = harness.cache();
  harness.dependencies.valueBackendInventories = (cache) => {
    assert.equal(cache.tables.contadores_alipack.rows.length, 1);
    throw new Error("fallo posterior al contador");
  };
  await submit(createInventoryEntryService(harness.dependencies), {
    date: "2026-07-06",
    employee: "Operario",
    selectedShifts: ["afternoon"],
    counters: { afternoon: 99.5 },
    rows: [{ itemId: 101, afternoon: 5 }]
  });
  assert.equal(harness.responses.at(-1).status, 500);
  assert.equal(harness.saveCount(), 0);
  assert.deepEqual(harness.cache(), before);
});

test("agregar el contador no cambia cabeceras, detalles, snapshot ni valuacion", async () => {
  const withoutCounter = createHarness();
  const withCounter = createHarness();
  const valuation = (cache, inventoryIds) => {
    const selected = new Set(inventoryIds.map(String));
    cache.tables.inventarios.rows
      .filter((row) => selected.has(String(row.id_inventario)))
      .forEach((row) => { row.valor_total = 250.75; });
    return { issues: [] };
  };
  withoutCounter.dependencies.valueBackendInventories = valuation;
  withCounter.dependencies.valueBackendInventories = valuation;
  const basePayload = {
    date: "2026-07-06",
    employee: "Operario",
    selectedShifts: ["afternoon"],
    rows: [{ itemId: 101, afternoon: 5.25 }]
  };
  await submit(createInventoryEntryService(withoutCounter.dependencies), basePayload);
  await submit(createInventoryEntryService(withCounter.dependencies), {
    ...basePayload,
    counters: { afternoon: 99.125 }
  });
  assert.deepEqual(withCounter.cache().tables.inventarios.rows, withoutCounter.cache().tables.inventarios.rows);
  assert.deepEqual(withCounter.cache().tables.detalle_inventarios.rows, withoutCounter.cache().tables.detalle_inventarios.rows);
  assert.deepEqual(withCounter.cache().inventoryPurchaseSnapshot, withoutCounter.cache().inventoryPurchaseSnapshot);
  assert.equal(withCounter.cache().tables.inventarios.rows[0].valor_total, 250.75);
});

test("un payload sin items se rechaza antes de abrir la transaccion", async () => {
  const harness = createHarness();
  const before = harness.cache();
  const service = createInventoryEntryService(harness.dependencies);
  await submit(service, payload("2026-07-06", []));

  assert.equal(harness.responses.at(-1).status, 400);
  assert.match(harness.responses.at(-1).payload.error, /No hay items/i);
  assert.equal(harness.saveCount(), 0);
  assert.deepEqual(harness.cache(), before);
});

test("la plantilla manual devuelve el siguiente id real sin escribir", async () => {
  const harness = createHarness(historicalCache());
  const service = createInventoryEntryService(harness.dependencies);

  await service.handleInventoryDetailTemplate({});

  assert.equal(harness.responses.at(-1).status, 200);
  assert.equal(harness.responses.at(-1).payload.lastInventoryId, 1706);
  assert.equal(harness.responses.at(-1).payload.inventoryId, 1707);
  assert.equal(harness.saveCount(), 0);
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

  await submit(service, payload("2027-07-20", [{ itemId: 101, afternoon: 0 }]));
  assert.equal(harness.responses.at(-1).status, 500);
  assert.match(harness.errors.at(-1), /Calendario laboral no configurado para 2027/);
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

  await submit(failingService, payload("2026-07-21", [{ itemId: 101, afternoon: 1000 }]));
  assert.equal(harness.responses.at(-1).status, 500);
  assert.match(harness.errors.at(-1), /fallo de guardado/);
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
