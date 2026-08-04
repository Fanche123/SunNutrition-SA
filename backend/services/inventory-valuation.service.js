const { fromCents, multiplyCents, normalize } = require("../../shared/money");

const COMPOUND_COUNT_UNIT_FACTORS = Object.freeze({
  "barra pop": 2000
});

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

  function calculateBackendInventoryValuations(cache, inventoryIds = null, options = {}) {
    const inventoryTable = cache.tables?.inventarios;
    const detailTable = cache.tables?.detalle_inventarios;
    if (!inventoryTable || !detailTable) return { inventories: [], issues: [] };

    const targetInventoryIds = inventoryIds
      ? new Set(inventoryIds.map(backendId).filter(Boolean))
      : null;
    const inventoriesToValue = (inventoryTable.rows || []).filter((inventory) => (
      !targetInventoryIds || targetInventoryIds.has(backendId(inventory.id_inventario))
    ));
    const detailsByInventory = backendGroupRowsById(detailTable.rows, "id_inventario");
    const itemCostsByCutoff = new Map();
    const issues = [];
    const allowStoredDetailCostFallback = options.allowStoredDetailCostFallback !== false;
  
    const inventories = inventoriesToValue
      .slice()
      .sort((left, right) => {
        const leftDate = backendIsoDate(left.fecha);
        const rightDate = backendIsoDate(right.fecha);
        if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
        return backendTurnRank(left.turno) - backendTurnRank(right.turno);
      })
      .map((inventory) => {
        const inventoryId = backendId(inventory.id_inventario);
        const inventoryDate = backendIsoDate(inventory.fecha);
        const cutoffKey = `${inventoryDate}:${backendTurnRank(inventory.turno)}`;
        const inventoryDetails = detailsByInventory.get(inventoryId) || [];
        const storedDetailCosts = new Map(inventoryDetails
          .map((detail) => [backendId(detail.id_item), positiveNormalizedMoney(detail.costo_unitario_usado)])
          .filter(([, cost]) => cost > 0));
        const costKey = options.requireHistoricalEvidence ? `${cutoffKey}:${inventoryId}` : cutoffKey;
        if (!itemCostsByCutoff.has(costKey)) {
          itemCostsByCutoff.set(costKey, backendInventoryItemCostMap(cache, inventoryDate, inventory.turno, {
            includeEvidence: options.requireHistoricalEvidence === true,
            storedDetailCosts
          }));
        }
        const itemCosts = itemCostsByCutoff.get(costKey);
        let inventoryValueCents = 0;
  
        const details = inventoryDetails.map((detail) => {
          const quantity = backendInventoryQuantity(detail.cantidad);
          const invalidQuantity = !isValidInventoryQuantity(detail.cantidad);
          const itemCost = itemCosts.get(backendId(detail.id_item));
          const costEvidence = itemCost && typeof itemCost === "object" ? itemCost : null;
          const calculatedUnitCost = positiveNormalizedMoney(costEvidence ? costEvidence.value : itemCost);
          const demonstrableCost = !costEvidence || costEvidence.demonstrable;
          const storedDetailUnitCost = positiveNormalizedMoney(detail.costo_unitario_usado);
          const eligibleCalculatedUnitCost = options.requireHistoricalEvidence && !demonstrableCost
            ? 0
            : calculatedUnitCost;
          const normalizedUnitCost = eligibleCalculatedUnitCost
            || (allowStoredDetailCostFallback ? storedDetailUnitCost : 0);
          const valuationSource = eligibleCalculatedUnitCost > 0
            ? "canonical_cost_at_cutoff"
            : normalizedUnitCost > 0
              ? "stored_detail_cost_snapshot"
              : "unavailable";
          const lineValueCents = multiplyCents(normalizedUnitCost, quantity);
          inventoryValueCents += lineValueCents;
          if (invalidQuantity) {
            issues.push({
              code: "INVALID_QUANTITY",
              inventoryId,
              detailId: backendId(detail.id_detalle_inventario),
              itemId: backendId(detail.id_item)
            });
          } else if (quantity < 0) {
            issues.push({
              code: "NEGATIVE_QUANTITY",
              inventoryId,
              detailId: backendId(detail.id_detalle_inventario),
              itemId: backendId(detail.id_item),
              quantity
            });
          } else if (quantity > 0 && calculatedUnitCost > 0 && !demonstrableCost) {
            issues.push({
              code: "UNSUPPORTED_COST_SOURCE",
              inventoryId,
              detailId: backendId(detail.id_detalle_inventario),
              itemId: backendId(detail.id_item),
              quantity,
              costSources: costEvidence.sources
            });
          } else if (quantity > 0 && !(normalizedUnitCost > 0)) {
            issues.push({
              code: "MISSING_COST",
              inventoryId,
              detailId: backendId(detail.id_detalle_inventario),
              itemId: backendId(detail.id_item),
              quantity
            });
          }
          return {
            detail,
            detailId: backendId(detail.id_detalle_inventario),
            itemId: backendId(detail.id_item),
            quantity,
            unitCost: normalizedUnitCost,
            value: fromCents(lineValueCents),
            valuationSource,
            costSources: costEvidence?.sources || []
          };
        });

        return {
          inventory,
          inventoryId,
          date: inventoryDate,
          turn: inventory.turno || "",
          storedValue: normalizedMoney(inventory.valor_total),
          value: fromCents(inventoryValueCents),
          details
        };
      });

    return { inventories, issues };
  }

  function valueBackendInventories(cache, inventoryIds = null, options = {}) {
    const inventoryTable = cache.tables?.inventarios;
    const detailTable = cache.tables?.detalle_inventarios;
    if (!inventoryTable || !detailTable) return { inventories: [], issues: [] };
    const result = calculateBackendInventoryValuations(cache, inventoryIds, options);

    result.inventories.forEach((valuation) => {
      valuation.inventory.valor_total = valuation.value;
      valuation.details.forEach((detailValuation) => {
        detailValuation.detail.costo_unitario_usado = detailValuation.unitCost;
        detailValuation.detail.valor_total = detailValuation.value;
      });
    });
    inventoryTable.headers = expectedBackendColumns.inventarios;
    detailTable.headers = expectedBackendColumns.detalle_inventarios;
    return result;
  }
  
  function backendInventoryItemCostMap(cache, dateIso, cutoffTurn = "", options = {}) {
    const tables = cache.tables || {};
    const itemsById = backendRowsById(detailSafeRows(tables.items), "id_item");
    const suppliesById = backendRowsById(detailSafeRows(tables.insumos), "id_insumo");
    const subproductsById = backendRowsById(detailSafeRows(tables.subproductos), "id_subproducto");
    const recipesByResult = backendGroupRowsById(detailSafeRows(tables.recetas), "id_item_resultado");
    const supplyCosts = backendLatestSupplyCostMap(tables, dateIso, cutoffTurn);
    const recipeUnitMemo = new Map();
    const countUnitCosts = new Map();
    const visiting = new Set();
    const storedDetailCosts = options.storedDetailCosts instanceof Map ? options.storedDetailCosts : new Map();
  
    const countToRecipe = (item) => {
      const itemTranslation = backendNumber(item?._traduccion_ud_receta);
      if (itemTranslation > 0) return itemTranslation;
  
      if (backendNormalizeText(item?.origen_tipo) === "insumo") {
        const supply = suppliesById.get(backendId(item?.id_origen));
        const supplyTranslation = backendNumber(supply?.cantidad_receta);
        if (supplyTranslation > 0) return supplyTranslation;
      }

      if (backendNormalizeText(item?.origen_tipo) === "subproducto") {
        const subproduct = subproductsById.get(backendId(item?.id_origen));
        const configuredFactor = COMPOUND_COUNT_UNIT_FACTORS[backendNormalizeText(subproduct?.nombre_subproducto)];
        if (configuredFactor > 0) return configuredFactor;
      }
  
      return 1;
    };
  
    const costPerRecipeUnit = (itemId) => {
      const normalizedItemId = backendId(itemId);
      if (!normalizedItemId) return costEvidence(0, [], false);
      if (recipeUnitMemo.has(normalizedItemId)) return recipeUnitMemo.get(normalizedItemId);
      if (visiting.has(normalizedItemId)) return costEvidence(0, ["recipe_cycle"], false);
  
      visiting.add(normalizedItemId);
      const item = itemsById.get(normalizedItemId);
      let evidence = costEvidence(0, [], false);
  
      if (backendNormalizeText(item?.origen_tipo) === "insumo") {
        const supplyId = backendId(item?.id_origen);
        const supplyCost = supplyCosts.get(supplyId);
        if (supplyCost?.unitCost) {
          const historical = isHistoricalCostSource(supplyCost.valuationSource);
          const storedCountCost = storedDetailCosts.get(normalizedItemId);
          evidence = !historical && storedCountCost > 0
            ? costEvidence(
              divideStoredCountCost(storedCountCost, countToRecipe(item)),
              ["stored_detail_cost_snapshot"],
              true
            )
            : costEvidence(
              supplyCost.unitCost,
              [supplyCost.valuationSource || "unavailable"],
              historical
            );
        }
      } else {
        const components = (recipesByResult.get(normalizedItemId) || []).map((recipe) => {
          const componentQuantity = backendRecipeQuantity(recipe.cantidad_componente);
          const component = costPerRecipeUnit(recipe.id_item_componente);
          return { component, componentQuantity };
        });
        const costCents = components.reduce((total, row) => (
          total + multiplyCents(row.component.value, row.componentQuantity)
        ), 0);
        evidence = costEvidence(
          fromCents(costCents),
          components.flatMap((row) => row.component.sources),
          components.length > 0 && components.every((row) => row.component.demonstrable)
        );
      }
  
      visiting.delete(normalizedItemId);
      recipeUnitMemo.set(normalizedItemId, evidence);
      return evidence;
    };
  
    itemsById.forEach((item, itemId) => {
      if (backendNormalizeText(item?.origen_tipo) === "insumo") {
        const supplyCost = supplyCosts.get(backendId(item?.id_origen));
        if (supplyCost && Object.prototype.hasOwnProperty.call(supplyCost, "countUnitCost")) {
          const countUnitCost = normalize(supplyCost.countUnitCost);
          if (countUnitCost > 0) {
            const historical = isHistoricalCostSource(supplyCost.valuationSource);
            const storedCountCost = storedDetailCosts.get(itemId);
            const evidence = !historical && storedCountCost > 0
              ? costEvidence(storedCountCost, ["stored_detail_cost_snapshot"], true)
              : costEvidence(
                countUnitCost,
                [supplyCost.valuationSource || "unavailable"],
                historical
              );
            countUnitCosts.set(itemId, options.includeEvidence ? evidence : evidence.value);
          }
          return;
        }
      }

      const recipeUnitCost = costPerRecipeUnit(itemId);
      const costCents = multiplyCents(recipeUnitCost.value, countToRecipe(item));
      if (costCents > 0) {
        const evidence = costEvidence(fromCents(costCents), recipeUnitCost.sources, recipeUnitCost.demonstrable);
        countUnitCosts.set(itemId, options.includeEvidence ? evidence : evidence.value);
      }
    });
  
    return countUnitCosts;
  }
  
  function detailSafeRows(table) {
    return Array.isArray(table?.rows) ? table.rows : [];
  }

  function costEvidence(value, sources, demonstrable) {
    return {
      value: normalize(value),
      sources: [...new Set(sources.filter(Boolean))],
      demonstrable: Boolean(demonstrable)
    };
  }

  function divideStoredCountCost(countCost, factor) {
    const normalizedFactor = backendRecipeQuantity(factor);
    return normalizedFactor > 0 ? normalize(countCost / normalizedFactor) : 0;
  }

  function isHistoricalCostSource(source) {
    return [
      "historical_reception_provider_unit",
      "historical_reception_count_unit",
      "historical_provider_quantity_fallback",
      "historical_purchase_line_fallback",
      "stored_detail_cost_snapshot"
    ].includes(source);
  }

  function positiveNormalizedMoney(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || !(number > 0)) return 0;
    return normalize(number);
  }

  function normalizedMoney(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return normalize(number);
  }

  function isValidInventoryQuantity(value) {
    if (typeof value === "number") return Number.isFinite(value);
    const text = String(value ?? "").trim().replace(/\s/g, "").replace(",", ".");
    return Boolean(text) && Number.isFinite(Number(text));
  }

  return { backendInventoryItemCostMap, calculateBackendInventoryValuations, valueBackendInventories };
}

module.exports = { COMPOUND_COUNT_UNIT_FACTORS, createInventoryValuationService };
