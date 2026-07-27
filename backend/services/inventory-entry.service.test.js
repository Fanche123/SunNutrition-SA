const assert = require("node:assert/strict");
const test = require("node:test");

const { payrollCalendarForYear } = require("../../assets/js/config/payroll-calendars");
const InventoryPurchaseEvaluation = require("../../shared/inventory-purchase-evaluation");
const { createInventoryEntryService } = require("./inventory-entry.service");
const { createInventoryPurchaseSnapshotService } = require("./inventory-purchase-snapshot.service");

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
