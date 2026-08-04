const InventoryPurchaseEvaluation = require("../../shared/inventory-purchase-evaluation");

const SNAPSHOT_KEY = "inventoryPurchaseSnapshot";
const CONFIG_KEY = "inventoryPurchaseConfig";
const CONFIG_VERSION = 1;
const SNAPSHOT_VERSION = 3;
const SNAPSHOT_STATES = Object.freeze({
  NO_INVENTORY: "no_inventory",
  INSUFFICIENT_DEPENDENCIES: "insufficient_dependencies",
  VALID_NO_ALERTS: "valid_no_alerts",
  VALID_WITH_ALERTS: "valid_with_alerts"
});

function createInventoryPurchaseSnapshotService(dependencies) {
  const {
    backendId,
    backendIsoDate,
    defaultInventoryItemName,
    payrollCalendarForYear
  } = dependencies;

  function buildInventoryPurchaseSnapshot(cache, input) {
    return evaluateInventoryPurchaseSnapshot(cache, input, {
      source: "stored",
      tolerateCalendarErrors: false
    });
  }

  function evaluateInventoryPurchaseSnapshot(cache, input, options = {}) {
    const config = readInventoryPurchaseConfig(cache);
    const date = backendIsoDate(input.date);
    const inventoryIds = Object.values(input.inventoryIds || {}).map(backendId).filter(Boolean);
    const selectedShifts = Array.isArray(input.selectedShifts) ? input.selectedShifts : [];
    const cleanRows = Array.isArray(input.cleanRows) ? input.cleanRows : [];
    const previousStocks = previousStockByItem(cache, date, inventoryIds);
    const itemContext = inventoryItemContext(cache.tables || {});
    const providerContext = inventoryProviderContext(cache.tables || {});
    const unavailableItems = [];

    const items = cleanRows.map((row) => {
      const itemId = backendId(row.itemId);
      const item = itemContext.get(itemId) || {
        name: defaultInventoryItemName(itemId),
        unit: "",
        supplyId: ""
      };
      const previousStock = previousStocks.get(itemId);
      const allowPreviousStockFallback = options.allowPreviousStockFallback !== false;
      const stock = currentOrPreviousStock(
        row,
        selectedShifts,
        allowPreviousStockFallback ? previousStock : Number.NaN
      );
      const hasResolvableInventoryDetail = selectedShifts.some((shift) => hasInventoryQuantity(row[shift]))
        || (allowPreviousStockFallback && hasInventoryQuantity(previousStock));
      const provider = providerContext.get(item.supplyId) || {};
      let businessDays = Number.NaN;
      let calendarUnavailable = false;
      if (provider.leadDays) {
        try {
          businessDays = countInventoryConsumptionDays(date, provider.leadDays);
        } catch (error) {
          if (!options.tolerateCalendarErrors) throw error;
          calendarUnavailable = true;
        }
      }
      const metrics = InventoryPurchaseEvaluation.inventoryPurchaseMetrics({
        itemId,
        itemName: item.name,
        stock,
        unit: item.unit,
        provider: provider.name,
        leadDays: provider.leadDays,
        businessDays,
        barsPerDay: config.barsPerDay
      });
      if (!metrics.dailyConsumption) return null;
      if (!metrics.canEvaluate) {
        unavailableItems.push(snapshotUnavailableItem(metrics, {
          calendarUnavailable,
          missingInventoryDetails: !hasResolvableInventoryDetail
        }));
        return null;
      }
      return metrics.shouldBuy ? snapshotItem(metrics) : null;
    }).filter(Boolean);
    const state = unavailableItems.length
      ? SNAPSHOT_STATES.INSUFFICIENT_DEPENDENCIES
      : items.length
        ? SNAPSHOT_STATES.VALID_WITH_ALERTS
        : SNAPSHOT_STATES.VALID_NO_ALERTS;

    return {
      version: SNAPSHOT_VERSION,
      ...snapshotProductionConfig(config.barsPerDay),
      inventoryDate: date,
      inventoryIds,
      state,
      source: options.source || "stored",
      items,
      unavailableItems
    };
  }

  function storeInventoryPurchaseSnapshot(cache, snapshot) {
    cache[SNAPSHOT_KEY] = snapshot;
    return snapshot;
  }

  function readInventoryPurchaseSnapshot(cache) {
    const config = readInventoryPurchaseConfig(cache);
    const snapshot = cache?.[SNAPSHOT_KEY];
    if (
      snapshot
      && Number(snapshot.version) === SNAPSHOT_VERSION
      && Number(snapshot.barsPerDay) === config.barsPerDay
      && validSnapshotState(snapshot.state)
      && snapshotMatchesLatestInventory(cache, snapshot)
    ) {
      return normalizeSnapshot(snapshot, "stored");
    }
    return rebuildInventoryPurchaseSnapshot(cache);
  }

  function rebuildInventoryPurchaseSnapshot(cache) {
    const config = readInventoryPurchaseConfig(cache);
    const batch = latestInventoryBatch(cache);
    const latestDate = latestInventoryDate(cache);
    if (!latestDate) return emptySnapshot(config.barsPerDay);
    if (!batch.length) {
      return emptySnapshot(
        config.barsPerDay,
        SNAPSHOT_STATES.INSUFFICIENT_DEPENDENCIES,
        latestDate,
        [],
        [{
          itemId: "",
          itemName: "Ultimo inventario",
          missingDependencies: ["inventory_batch"]
        }]
      );
    }
    const inventoryIds = Object.fromEntries(batch.map((row) => [
      inventoryShiftKey(row.turno),
      backendId(row.id_inventario)
    ]));
    const selectedShifts = batch.map((row) => inventoryShiftKey(row.turno)).filter(Boolean);
    const details = cache.tables?.detalle_inventarios?.rows || [];
    const shiftByInventoryId = new Map(batch.map((row) => [
      backendId(row.id_inventario),
      inventoryShiftKey(row.turno)
    ]));
    const rowsByItem = new Map();

    details.forEach((detail) => {
      const shift = shiftByInventoryId.get(backendId(detail.id_inventario));
      if (!shift) return;
      const itemId = backendId(detail.id_item);
      if (!itemId) return;
      if (!rowsByItem.has(itemId)) {
        rowsByItem.set(itemId, { itemId, dawn: "", morning: "", afternoon: "" });
      }
      rowsByItem.get(itemId)[shift] = detail.cantidad ?? "";
    });

    const date = backendIsoDate(batch.at(-1)?.fecha);
    const evaluableItems = inventoryItemContext(cache.tables || {});
    evaluableItems.forEach((item, itemId) => {
      if (!InventoryPurchaseEvaluation.dailyConsumptionForItem(item.name)) return;
      if (!rowsByItem.has(itemId)) {
        rowsByItem.set(itemId, { itemId, dawn: "", morning: "", afternoon: "" });
      }
    });
    if (!rowsByItem.size) return emptySnapshot(
      config.barsPerDay,
      SNAPSHOT_STATES.INSUFFICIENT_DEPENDENCIES,
      date,
      Object.values(inventoryIds),
      [{
        itemId: "",
        itemName: "Ultimo inventario",
        missingDependencies: ["inventory_details"]
      }]
    );
    return evaluateInventoryPurchaseSnapshot(cache, {
      date,
      inventoryIds,
      selectedShifts,
      cleanRows: [...rowsByItem.values()]
    }, {
      source: "reconstructed",
      tolerateCalendarErrors: true
    });
  }

  function clearInventoryPurchaseSnapshot(cache, inventoryDate = "", inventoryIds = []) {
    const config = readInventoryPurchaseConfig(cache);
    return storeInventoryPurchaseSnapshot(cache, {
      version: 0,
      ...snapshotProductionConfig(config.barsPerDay),
      inventoryDate: backendIsoDate(inventoryDate),
      inventoryIds: inventoryIds.map(backendId).filter(Boolean),
      state: "pending",
      source: "stored",
      items: [],
      unavailableItems: []
    });
  }

  function readInventoryPurchaseConfig(cache) {
    const configuredValue = cache?.[CONFIG_KEY]?.barsPerDay;
    const barsPerDay = InventoryPurchaseEvaluation.normalizeBarsPerDay(configuredValue);
    return {
      version: CONFIG_VERSION,
      barsPerDay: Number.isFinite(barsPerDay)
        ? barsPerDay
        : InventoryPurchaseEvaluation.DEFAULT_BARS_PER_DAY
    };
  }

  function updateInventoryPurchaseConfig(cache, value) {
    const barsPerDay = typeof value === "number"
      ? InventoryPurchaseEvaluation.normalizeBarsPerDay(value, NaN)
      : Number.NaN;
    if (!Number.isFinite(barsPerDay)) {
      const error = new Error(
        `La producción diaria debe ser un entero entre ${InventoryPurchaseEvaluation.MIN_BARS_PER_DAY} y ${InventoryPurchaseEvaluation.MAX_BARS_PER_DAY}.`
      );
      error.code = "INVALID_BARS_PER_DAY";
      throw error;
    }
    cache[CONFIG_KEY] = { version: CONFIG_VERSION, barsPerDay };
    const snapshot = rebuildInventoryPurchaseSnapshot(cache);
    storeInventoryPurchaseSnapshot(cache, snapshot);
    return { config: readInventoryPurchaseConfig(cache), snapshot };
  }

  function latestInventoryBatch(cache) {
    const latestDate = latestInventoryDate(cache);
    if (!latestDate) return [];
    const sameDate = (cache.tables?.inventarios?.rows || [])
      .filter((row) => (
        backendIsoDate(row.fecha) === latestDate
        && backendId(row.id_inventario)
        && inventoryShiftKey(row.turno)
      ))
      .sort(compareInventoryRows);
    const latest = sameDate.at(-1);
    if (!latest) return [];
    const batch = [latest];
    let currentShiftOrder = inventoryShiftOrder(latest.turno);
    const employeeId = backendId(latest.id_empleado);

    for (let index = sameDate.length - 2; index >= 0; index -= 1) {
      const candidate = sameDate[index];
      const candidateShiftOrder = inventoryShiftOrder(candidate.turno);
      if (backendId(candidate.id_empleado) !== employeeId) break;
      if (candidateShiftOrder >= currentShiftOrder) break;
      batch.unshift(candidate);
      currentShiftOrder = candidateShiftOrder;
    }
    return batch;
  }

  function previousStockByItem(cache, currentDate, currentInventoryIds) {
    const currentIds = new Set(currentInventoryIds);
    const inventories = cache.tables?.inventarios?.rows || [];
    const details = cache.tables?.detalle_inventarios?.rows || [];
    const previousDates = inventories
      .filter((row) => !currentIds.has(backendId(row.id_inventario)))
      .map((row) => backendIsoDate(row.fecha))
      .filter((date) => date && date <= currentDate)
      .sort();
    const previousDate = previousDates.at(-1);
    if (!previousDate) return new Map();

    const previousInventories = inventories.filter((row) => (
      !currentIds.has(backendId(row.id_inventario))
      && backendIsoDate(row.fecha) === previousDate
    ));
    const inventoryByShift = new Map(previousInventories.map((row) => [
      inventoryShiftKey(row.turno),
      backendId(row.id_inventario)
    ]));
    const detailByInventoryAndItem = new Map(details.map((detail) => [
      `${backendId(detail.id_inventario)}:${backendId(detail.id_item)}`,
      detail.cantidad
    ]));
    const itemIds = new Set(details.map((detail) => backendId(detail.id_item)).filter(Boolean));
    const result = new Map();
    itemIds.forEach((itemId) => {
      for (const shift of ["afternoon", "morning", "dawn"]) {
        const inventoryId = inventoryByShift.get(shift);
        const quantity = detailByInventoryAndItem.get(`${inventoryId}:${itemId}`);
        if (hasInventoryQuantity(quantity)) {
          result.set(itemId, Number(quantity));
          break;
        }
      }
    });
    return result;
  }

  function inventoryItemContext(tables) {
    const suppliesById = new Map((tables.insumos?.rows || []).map((row) => [backendId(row.id_insumo), row]));
    return new Map((tables.items?.rows || []).map((item) => {
      const itemId = backendId(item.id_item);
      const supplyId = normalizeCategory(item.origen_tipo) === "insumo" ? backendId(item.id_origen) : "";
      const supply = suppliesById.get(supplyId);
      return [itemId, {
        name: String(supply?.nombre || defaultInventoryItemName(itemId)).trim(),
        unit: String(supply?.ud_receta || item.ud_conteo || "").trim(),
        supplyId
      }];
    }));
  }

  function inventoryProviderContext(tables) {
    const purchasesById = new Map((tables.compras?.rows || []).map((row) => [backendId(row.id_compra), row]));
    const supplierLinksById = new Map((tables.insumos_proveedores?.rows || []).map((row) => [
      backendId(row.id_insumos_proveedores),
      row
    ]));
    const providersById = new Map((tables.proveedores?.rows || []).map((row) => [backendId(row.id_proveedor), row]));
    const candidatesBySupply = new Map();

    (tables.detalle_compras?.rows || []).forEach((detail) => {
      const purchase = purchasesById.get(backendId(detail.id_compra));
      const supplierLink = supplierLinksById.get(backendId(detail.id_insumos_proveedores));
      const supplyId = backendId(supplierLink?.id_insumo);
      if (!purchase || !supplierLink || !supplyId) return;
      if (!candidatesBySupply.has(supplyId)) candidatesBySupply.set(supplyId, []);
      candidatesBySupply.get(supplyId).push({ detail, purchase, supplierLink });
    });

    const result = new Map();
    candidatesBySupply.forEach((candidates, supplyId) => {
      const latest = candidates.sort(comparePurchaseCandidate).at(-1);
      const providerId = backendId(latest.purchase.id_proveedor || latest.supplierLink.id_proveedor);
      const provider = providersById.get(providerId);
      const name = String(provider?.nombre || "").trim();
      let leadDays = Number(provider?.tiempo_estimado_entrega) || 0;
      if (!leadDays) leadDays = historicalLeadDays(tables.compras?.rows || [], providerId);
      if (name && leadDays) result.set(supplyId, { name, leadDays });
    });
    return result;
  }

  function historicalLeadDays(purchases, providerId) {
    const latest = purchases
      .filter((purchase) => (
        backendId(purchase.id_proveedor) === providerId
        && backendIsoDate(purchase.fecha_pedido)
        && backendIsoDate(purchase.fecha_entrega_prevista)
      ))
      .sort(comparePurchaseRows)
      .at(-1);
    if (!latest) return 0;
    const start = Date.parse(`${backendIsoDate(latest.fecha_pedido)}T00:00:00Z`);
    const end = Date.parse(`${backendIsoDate(latest.fecha_entrega_prevista)}T00:00:00Z`);
    return Math.max(0, Math.round((end - start) / 86400000));
  }

  function countInventoryConsumptionDays(startIso, totalDays) {
    const start = Date.parse(`${startIso}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(totalDays) || totalDays <= 0) return 0;
    let count = 0;
    for (let offset = 1; offset <= totalDays; offset += 1) {
      const date = new Date(start + offset * 86400000);
      const day = date.getUTCDay();
      if (day === 0 || day === 6) continue;
      const calendar = payrollCalendarForYear(date.getUTCFullYear());
      if (!calendar.configured) {
        throw new Error(`Calendario laboral no configurado para ${date.getUTCFullYear()}.`);
      }
      if (!calendar.dates.has(date.toISOString().slice(0, 10))) count += 1;
    }
    return count;
  }

  function latestInventoryDate(cache) {
    return (cache.tables?.inventarios?.rows || [])
      .map((row) => backendIsoDate(row.fecha))
      .filter(Boolean)
      .sort()
      .at(-1) || "";
  }

  function snapshotMatchesLatestInventory(cache, snapshot) {
    const latestDate = latestInventoryDate(cache);
    if (!latestDate || backendIsoDate(snapshot.inventoryDate) !== latestDate) return false;
    const latestInventoryIds = (cache.tables?.inventarios?.rows || [])
      .filter((row) => backendIsoDate(row.fecha) === latestDate)
      .map((row) => backendId(row.id_inventario))
      .filter(Boolean);
    const snapshotIds = new Set((snapshot.inventoryIds || []).map(backendId).filter(Boolean));
    const latestInventoryId = latestInventoryIds
      .sort((left, right) => (Number(left) || 0) - (Number(right) || 0))
      .at(-1);
    return Boolean(latestInventoryId && snapshotIds.has(latestInventoryId));
  }

  return {
    buildInventoryPurchaseSnapshot,
    clearInventoryPurchaseSnapshot,
    evaluateInventoryPurchaseSnapshot,
    latestInventoryBatch,
    readInventoryPurchaseConfig,
    readInventoryPurchaseSnapshot,
    rebuildInventoryPurchaseSnapshot,
    storeInventoryPurchaseSnapshot,
    updateInventoryPurchaseConfig
  };
}

function currentOrPreviousStock(row, selectedShifts, previousStock) {
  const enabled = new Set(selectedShifts);
  for (const shift of ["afternoon", "morning", "dawn"]) {
    if (!enabled.has(shift)) continue;
    if (hasInventoryQuantity(row[shift])) return Number(row[shift]);
  }
  return hasInventoryQuantity(previousStock) ? Number(previousStock) : NaN;
}

function hasInventoryQuantity(value) {
  return String(value ?? "").trim() !== "" && Number.isFinite(Number(value));
}

function snapshotItem(item) {
  return {
    itemId: String(item.itemId ?? "").trim(),
    itemName: String(item.itemName || "").trim(),
    stock: Number(item.stock),
    unit: String(item.unit || "").trim(),
    daysRemaining: Number(item.daysRemaining),
    required: Number(item.required),
    dailyConsumption: Number(item.dailyConsumption),
    provider: String(item.provider || "").trim(),
    leadDays: Number(item.leadDays),
    businessDays: Number(item.businessDays)
  };
}

function snapshotUnavailableItem(item, options = {}) {
  const missingDependencies = [];
  if (!Number.isFinite(item.stock)) missingDependencies.push("stock");
  if (options.missingInventoryDetails) missingDependencies.push("inventory_details");
  if (!item.provider) missingDependencies.push("provider");
  if (!Number.isFinite(item.leadDays) || item.leadDays <= 0) missingDependencies.push("lead_days");
  if (options.calendarUnavailable) missingDependencies.push("business_calendar");
  return {
    itemId: String(item.itemId ?? "").trim(),
    itemName: String(item.itemName || "").trim(),
    missingDependencies: [...new Set(missingDependencies)]
  };
}

function validSnapshotItem(item) {
  return Boolean(
    item.itemId
    && item.itemName
    && Number.isFinite(item.stock)
    && Number.isFinite(item.daysRemaining)
    && Number.isFinite(item.required)
    && Number.isFinite(item.dailyConsumption)
  );
}

function validSnapshotUnavailableItem(item) {
  return Boolean(
    item
    && typeof item === "object"
    && !Array.isArray(item)
    && Array.isArray(item.missingDependencies)
  );
}

function normalizeSnapshot(snapshot, source = "") {
  const items = (snapshot.items || [])
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map(snapshotItem)
    .filter(validSnapshotItem);
  const unavailableItems = (snapshot.unavailableItems || [])
    .filter(validSnapshotUnavailableItem)
    .map((item) => ({
      itemId: String(item.itemId ?? "").trim(),
      itemName: String(item.itemName || "").trim(),
      missingDependencies: [...new Set(item.missingDependencies.map((value) => String(value || "").trim()).filter(Boolean))]
    }));
  return {
    version: SNAPSHOT_VERSION,
    ...snapshotProductionConfig(InventoryPurchaseEvaluation.normalizeBarsPerDay(snapshot.barsPerDay)),
    inventoryDate: String(snapshot.inventoryDate || "").trim(),
    inventoryIds: (snapshot.inventoryIds || []).map((value) => String(value ?? "").trim()).filter(Boolean),
    state: validSnapshotState(snapshot.state)
      ? snapshot.state
      : unavailableItems.length
        ? SNAPSHOT_STATES.INSUFFICIENT_DEPENDENCIES
        : items.length
          ? SNAPSHOT_STATES.VALID_WITH_ALERTS
          : SNAPSHOT_STATES.VALID_NO_ALERTS,
    source: source || String(snapshot.source || "").trim() || "stored",
    items,
    unavailableItems
  };
}

function validSnapshotState(value) {
  return Object.values(SNAPSHOT_STATES).includes(value);
}

function emptySnapshot(
  barsPerDay = InventoryPurchaseEvaluation.DEFAULT_BARS_PER_DAY,
  state = SNAPSHOT_STATES.NO_INVENTORY,
  inventoryDate = "",
  inventoryIds = [],
  unavailableItems = []
) {
  return {
    version: SNAPSHOT_VERSION,
    ...snapshotProductionConfig(barsPerDay),
    inventoryDate,
    inventoryIds,
    state,
    source: "reconstructed",
    items: [],
    unavailableItems
  };
}

function snapshotProductionConfig(barsPerDay) {
  return {
    barsPerDay,
    minBarsPerDay: InventoryPurchaseEvaluation.MIN_BARS_PER_DAY,
    maxBarsPerDay: InventoryPurchaseEvaluation.MAX_BARS_PER_DAY
  };
}

function comparePurchaseCandidate(left, right) {
  const rowComparison = comparePurchaseRows(left.purchase, right.purchase);
  if (rowComparison) return rowComparison;
  return Number(left.detail.id_detalle_compra) - Number(right.detail.id_detalle_compra);
}

function comparePurchaseRows(left, right) {
  const dateComparison = String(left.fecha_pedido || "").localeCompare(String(right.fecha_pedido || ""));
  if (dateComparison) return dateComparison;
  return Number(left.id_compra) - Number(right.id_compra);
}

function inventoryShiftKey(value) {
  const normalized = normalizeCategory(value);
  if (normalized.includes("madrug")) return "dawn";
  if (normalized.includes("manan")) return "morning";
  if (normalized.includes("tarde")) return "afternoon";
  return "";
}

function inventoryShiftOrder(value) {
  return { dawn: 0, morning: 1, afternoon: 2 }[inventoryShiftKey(value)] ?? Number.POSITIVE_INFINITY;
}

function compareInventoryRows(left, right) {
  const leftId = Number(left.id_inventario);
  const rightId = Number(right.id_inventario);
  if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) {
    return leftId - rightId;
  }
  return String(left.id_inventario || "").localeCompare(String(right.id_inventario || ""));
}

function normalizeCategory(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

module.exports = {
  CONFIG_KEY,
  CONFIG_VERSION,
  SNAPSHOT_KEY,
  SNAPSHOT_STATES,
  SNAPSHOT_VERSION,
  createInventoryPurchaseSnapshotService
};
