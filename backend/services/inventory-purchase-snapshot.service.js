const InventoryPurchaseEvaluation = require("../../shared/inventory-purchase-evaluation");

const SNAPSHOT_KEY = "inventoryPurchaseSnapshot";
const SNAPSHOT_VERSION = 1;

function createInventoryPurchaseSnapshotService(dependencies) {
  const {
    backendId,
    backendIsoDate,
    defaultInventoryItemName,
    payrollCalendarForYear
  } = dependencies;

  function buildInventoryPurchaseSnapshot(cache, input) {
    const date = backendIsoDate(input.date);
    const inventoryIds = Object.values(input.inventoryIds || {}).map(backendId).filter(Boolean);
    const selectedShifts = Array.isArray(input.selectedShifts) ? input.selectedShifts : [];
    const cleanRows = Array.isArray(input.cleanRows) ? input.cleanRows : [];
    const previousStocks = previousStockByItem(cache, date, inventoryIds);
    const itemContext = inventoryItemContext(cache.tables || {});
    const providerContext = inventoryProviderContext(cache.tables || {});

    const items = cleanRows.map((row) => {
      const itemId = backendId(row.itemId);
      const item = itemContext.get(itemId) || {
        name: defaultInventoryItemName(itemId),
        unit: "",
        supplyId: ""
      };
      const stock = currentOrPreviousStock(row, selectedShifts, previousStocks.get(itemId));
      const provider = providerContext.get(item.supplyId) || {};
      const businessDays = provider.leadDays
        ? countInventoryConsumptionDays(date, provider.leadDays)
        : 0;
      return InventoryPurchaseEvaluation.inventoryPurchaseAlert({
        itemId,
        itemName: item.name,
        stock,
        unit: item.unit,
        provider: provider.name,
        leadDays: provider.leadDays,
        businessDays
      });
    }).filter(Boolean).map(snapshotItem);

    return {
      version: SNAPSHOT_VERSION,
      inventoryDate: date,
      inventoryIds,
      items
    };
  }

  function storeInventoryPurchaseSnapshot(cache, snapshot) {
    cache[SNAPSHOT_KEY] = snapshot;
    return snapshot;
  }

  function readInventoryPurchaseSnapshot(cache) {
    const snapshot = cache?.[SNAPSHOT_KEY];
    if (!snapshot || Number(snapshot.version) !== SNAPSHOT_VERSION) return emptySnapshot();
    if (!snapshotMatchesLatestInventory(cache, snapshot)) return emptySnapshot(latestInventoryDate(cache));
    return {
      version: SNAPSHOT_VERSION,
      inventoryDate: backendIsoDate(snapshot.inventoryDate),
      inventoryIds: (snapshot.inventoryIds || []).map(backendId).filter(Boolean),
      items: (snapshot.items || [])
        .filter((item) => item && typeof item === "object" && !Array.isArray(item))
        .map(snapshotItem)
        .filter(validSnapshotItem)
    };
  }

  function clearInventoryPurchaseSnapshot(cache, inventoryDate = "", inventoryIds = []) {
    return storeInventoryPurchaseSnapshot(cache, {
      version: SNAPSHOT_VERSION,
      inventoryDate: backendIsoDate(inventoryDate),
      inventoryIds: inventoryIds.map(backendId).filter(Boolean),
      items: []
    });
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
    readInventoryPurchaseSnapshot,
    storeInventoryPurchaseSnapshot
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

function emptySnapshot(inventoryDate = "") {
  return {
    version: SNAPSHOT_VERSION,
    inventoryDate,
    inventoryIds: [],
    items: []
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

function normalizeCategory(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

module.exports = {
  SNAPSHOT_KEY,
  SNAPSHOT_VERSION,
  createInventoryPurchaseSnapshotService
};
