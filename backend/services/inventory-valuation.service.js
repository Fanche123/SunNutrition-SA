const { fromCents, multiplyCents, normalize } = require("../../shared/money");

function createInventoryValuationService(dependencies) {
  const {
    backendGroupRowsById,
    backendId,
    backendInventoryQuantity,
    backendIsoDate,
    backendLatestSupplyCostMap,
    backendNormalizeText,
    backendNumber,
    backendRecipeQuantity,
    backendRowsById,
    backendTurnRank,
    expectedBackendColumns
  } = dependencies;

  function valueBackendInventories(cache, inventoryIds = null) {
    const inventoryTable = cache.tables?.inventarios;
    const detailTable = cache.tables?.detalle_inventarios;
    if (!inventoryTable || !detailTable) return;

    const targetInventoryIds = inventoryIds
      ? new Set(inventoryIds.map(backendId).filter(Boolean))
      : null;
    const inventoriesToValue = (inventoryTable.rows || []).filter((inventory) => (
      !targetInventoryIds || targetInventoryIds.has(backendId(inventory.id_inventario))
    ));

    inventoriesToValue.forEach((inventory) => {
      inventory.valor_total = 0;
    });
  
    const inventoriesById = backendRowsById(inventoryTable.rows, "id_inventario");
    const detailsByInventory = backendGroupRowsById(detailTable.rows, "id_inventario");
    const itemCostsByDate = new Map();
  
    inventoriesToValue
      .slice()
      .sort((left, right) => {
        const leftDate = backendIsoDate(left.fecha);
        const rightDate = backendIsoDate(right.fecha);
        if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
        return backendTurnRank(left.turno) - backendTurnRank(right.turno);
      })
      .forEach((inventory) => {
        const inventoryId = backendId(inventory.id_inventario);
        const inventoryDate = backendIsoDate(inventory.fecha);
        if (!itemCostsByDate.has(inventoryDate)) {
          itemCostsByDate.set(inventoryDate, backendInventoryItemCostMap(cache, inventoryDate));
        }
        const itemCosts = itemCostsByDate.get(inventoryDate);
        let inventoryValueCents = 0;
  
        (detailsByInventory.get(inventoryId) || []).forEach((detail) => {
          detail.costo_unitario_usado = 0;
          detail.valor_total = 0;
  
          const unitCost = itemCosts.get(backendId(detail.id_item));
          if (!unitCost) return;
  
          const quantity = backendInventoryQuantity(detail.cantidad);
          const normalizedUnitCost = normalize(unitCost);
          const lineValueCents = multiplyCents(normalizedUnitCost, quantity);
          detail.costo_unitario_usado = normalizedUnitCost;
          detail.valor_total = fromCents(lineValueCents);
          inventoryValueCents += lineValueCents;
        });
  
        const storedInventory = inventoriesById.get(inventoryId) || inventory;
        storedInventory.valor_total = fromCents(inventoryValueCents);
      });
  
    inventoryTable.headers = expectedBackendColumns.inventarios;
    detailTable.headers = expectedBackendColumns.detalle_inventarios;
  }
  
  function backendInventoryItemCostMap(cache, dateIso) {
    const tables = cache.tables || {};
    const itemsById = backendRowsById(detailSafeRows(tables.items), "id_item");
    const suppliesById = backendRowsById(detailSafeRows(tables.insumos), "id_insumo");
    const recipesByResult = backendGroupRowsById(detailSafeRows(tables.recetas), "id_item_resultado");
    const supplyCosts = backendLatestSupplyCostMap(tables, dateIso);
    const recipeUnitMemo = new Map();
    const countUnitCosts = new Map();
    const visiting = new Set();
  
    const countToRecipe = (item) => {
      const itemTranslation = backendNumber(item?._traduccion_ud_receta);
      if (itemTranslation > 0) return itemTranslation;
  
      if (backendNormalizeText(item?.origen_tipo) === "insumo") {
        const supply = suppliesById.get(backendId(item?.id_origen));
        const supplyTranslation = backendNumber(supply?.cantidad_receta);
        if (supplyTranslation > 0) return supplyTranslation;
      }
  
      return 1;
    };
  
    const costPerRecipeUnit = (itemId) => {
      const normalizedItemId = backendId(itemId);
      if (!normalizedItemId) return 0;
      if (recipeUnitMemo.has(normalizedItemId)) return recipeUnitMemo.get(normalizedItemId);
      if (visiting.has(normalizedItemId)) return 0;
  
      visiting.add(normalizedItemId);
      const item = itemsById.get(normalizedItemId);
      let cost = 0;
  
      if (backendNormalizeText(item?.origen_tipo) === "insumo") {
        const supplyId = backendId(item?.id_origen);
        const supplyCost = supplyCosts.get(supplyId);
        if (supplyCost?.unitCost) cost = supplyCost.unitCost;
      } else {
        const costCents = (recipesByResult.get(normalizedItemId) || []).reduce((total, recipe) => {
          const componentQuantity = backendRecipeQuantity(recipe.cantidad_componente);
          const componentCost = costPerRecipeUnit(recipe.id_item_componente);
          return total + multiplyCents(componentCost, componentQuantity);
        }, 0);
        cost = fromCents(costCents);
      }
  
      visiting.delete(normalizedItemId);
      recipeUnitMemo.set(normalizedItemId, cost);
      return cost;
    };
  
    itemsById.forEach((item, itemId) => {
      const costCents = multiplyCents(costPerRecipeUnit(itemId), countToRecipe(item));
      if (costCents > 0) countUnitCosts.set(itemId, fromCents(costCents));
    });
  
    return countUnitCosts;
  }
  
  function detailSafeRows(table) {
    return Array.isArray(table?.rows) ? table.rows : [];
  }

  return { backendInventoryItemCostMap, valueBackendInventories };
}

module.exports = { createInventoryValuationService };
