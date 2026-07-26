function updateTheoreticalInventoryStock() {
  const body = els["inventory-detail-body"];
  if (!body) return;
  renderTheoreticalStockBreakdown(null);

  body.querySelectorAll("tr[data-item-id]").forEach((row) => {
    row.querySelectorAll(".theoretical-stock-cell").forEach((cell) => {
      cell.textContent = "-";
      cell.title = "";
      cell.classList.remove("missing-theoretical-stock", "stock-diff-yellow", "stock-diff-orange", "stock-diff-red");
    });
    row.querySelectorAll(".theoretical-diff-cell").forEach((diffCell) => {
      diffCell.textContent = "-";
      diffCell.title = "";
      diffCell.classList.remove("diff-positive", "diff-negative", "diff-neutral", "stock-diff-yellow", "stock-diff-orange", "stock-diff-red");
    });
    row.querySelectorAll(".detail-quantity-input").forEach((input) => {
      input.classList.remove("stock-diff-yellow", "stock-diff-orange", "stock-diff-red");
    });
  });

  const selectedDate = els["inventory-date-input"]?.value || "";
  const theoreticalShifts = selectedInventoryShifts().filter((shift) => ["dawn", "morning", "afternoon"].includes(shift));
  const missingRows = [];
  if (!selectedDate) missingRows.push("fecha");
  if (!theoreticalShifts.length) missingRows.push("turno realizado");
  if (missingRows.length) {
    renderTheoreticalStockBreakdown({
      missing: missingRows,
      selectedShift: theoreticalShifts[0] || ""
    });
    updateInventoryPurchaseAlerts();
    return;
  }

  const models = theoreticalShifts.map((shift) => buildTheoreticalInventoryModel(selectedDate, shift));
  models.forEach((model) => {
    model.rows.forEach((row) => {
      const cell = row.element.querySelector(`.theoretical-stock-cell[data-theoretical-shift="${model.selectedShift}"]`);
      const diffCell = row.element.querySelector(`.theoretical-diff-cell[data-theoretical-shift="${model.selectedShift}"]`);
      if (!cell) return;
      if (Number.isFinite(row.theoreticalStock)) {
        cell.textContent = formatRoundedNumber(row.theoreticalStock);
        cell.classList.remove("missing-theoretical-stock", "stock-diff-yellow", "stock-diff-orange", "stock-diff-red");
        cell.title = `Inicial: ${formatNullableNumber(row.previousStock)} | Produccion: ${formatNullableNumber(row.producedStock)} | Ventas: ${formatNullableNumber(row.sales)} | Consumo recetas: ${formatNullableNumber(row.consumedStock)}`;
        renderTheoreticalStockDifference(diffCell, row, model.selectedShift);
        return;
      }
      if (row.missing.length) markTheoreticalStockMissing(cell, `Falta: ${row.missing.join(", ")}`);
    });
  });
  renderTheoreticalStockBreakdown(models[0]);
  updateInventoryPurchaseAlerts();
}

function renderTheoreticalStockDifference(cell, row, shift) {
  if (!cell) return;
  const loadedStock = currentDetailStockForShift(row.element, shift);
  const roundedTheoreticalStock = roundedNumberValue(row.theoreticalStock);
  const stockCell = row.element.querySelector(`.theoretical-stock-cell[data-theoretical-shift="${shift}"]`);
  const loadedInput = row.element.querySelector(`[data-detail-field="${shift}"]`);
  [stockCell, loadedInput, cell].forEach((element) => {
    element?.classList.remove("stock-diff-yellow", "stock-diff-orange", "stock-diff-red");
  });
  if (!Number.isFinite(loadedStock) || !Number.isFinite(roundedTheoreticalStock) || roundedTheoreticalStock === 0) {
    cell.textContent = "-";
    cell.title = "Falta stock cargado para comparar.";
    cell.classList.remove("diff-positive", "diff-negative", "diff-neutral", "stock-diff-yellow", "stock-diff-orange", "stock-diff-red");
    return;
  }

  const differencePercent = ((loadedStock - roundedTheoreticalStock) / roundedTheoreticalStock) * 100;
  cell.textContent = formatRoundedPercentValue(differencePercent);
  cell.title = `Teorico redondeado: ${formatRoundedNumber(row.theoreticalStock)} | Teorico real: ${formatNumber(row.theoreticalStock)} | Cargado: ${formatNumber(loadedStock)}`;
  cell.classList.toggle("diff-positive", differencePercent > 0);
  cell.classList.toggle("diff-negative", differencePercent < 0);
  cell.classList.toggle("diff-neutral", differencePercent === 0);
  markTheoreticalStockDifferenceLevel([loadedInput, stockCell, cell], differencePercent);
}

function markTheoreticalStockDifferenceLevel(elements, differencePercent) {
  const absoluteDifference = Math.abs(differencePercent);
  elements.filter(Boolean).forEach((element) => {
    element.classList.toggle("stock-diff-red", absoluteDifference > 50);
    element.classList.toggle("stock-diff-orange", absoluteDifference > 25 && absoluteDifference <= 50);
    element.classList.toggle("stock-diff-yellow", absoluteDifference > 10 && absoluteDifference <= 25);
  });
}

function shouldDelayPhotoBasedTheoreticalStock(itemName) {
  return Number.isFinite(granelDulceIngredientCoefficient(itemName)) && !inventoryPhotoApplied;
}

function buildTheoreticalInventoryModel(selectedDate, selectedShift) {
  const detailRows = inventoryDetailTableRows();
  const recipes = recipeRowsForTheoreticalStock();
  const productionByProduct = new Map();
  let consumptionByComponent = new Map();
  const counterUnits = currentCounterUnits(selectedShift);
  const recipeProductKeys = new Set(recipes.map((recipe) => normalizeCategory(recipe.productName)));

  detailRows.forEach((row) => {
    const itemKey = normalizeCategory(row.itemName);
    if (shouldDelayPhotoBasedTheoreticalStock(row.itemName)) return;
    if (isNeutralTheoreticalStockItem(row.itemName)) return;
    if (!recipeProductKeys.has(itemKey) && !isBarraPopName(row.itemName)) return;

    const sales = orderDetailsUnitsForDateAndProduct(selectedDate, row.itemName);
    const previousStock = initialDetailStockForShift(row.element, selectedShift);
    const currentStock = currentDetailStockForShift(row.element, selectedShift);
    let produced = NaN;

    if (isBarraPopName(row.itemName) && Number.isFinite(counterUnits)) {
      produced = counterUnits;
    } else if (Number.isFinite(previousStock) && Number.isFinite(currentStock)) {
      produced = currentStock - previousStock + sales;
    }

    if (Number.isFinite(produced)) productionByProduct.set(itemKey, produced);
  });

  applyNeutralIntermediateProduction(detailRows, recipes, productionByProduct, selectedShift);

  for (let index = 0; index < 3; index += 1) {
    consumptionByComponent = buildRecipeConsumptionByComponent(recipes, productionByProduct);
    detailRows.forEach((row) => {
      const itemKey = normalizeCategory(row.itemName);
      if (shouldDelayPhotoBasedTheoreticalStock(row.itemName)) return;
      if (isNeutralTheoreticalStockItem(row.itemName)) {
        return;
      }
      if (!recipeProductKeys.has(itemKey) || isBarraPopName(row.itemName)) return;

      const previousStock = initialDetailStockForShift(row.element, selectedShift);
      const currentStock = currentDetailStockForShift(row.element, selectedShift);
      if (!Number.isFinite(previousStock) || !Number.isFinite(currentStock)) return;

      const factor = theoreticalRecipeUnitFactor(row.itemName);
      const sales = orderDetailsUnitsForDateAndProduct(selectedDate, row.itemName);
      const consumedByParents = (consumptionByComponent.get(itemKey) || 0) / factor;
      productionByProduct.set(itemKey, currentStock - previousStock + sales + consumedByParents);
    });
    applyNeutralIntermediateProduction(detailRows, recipes, productionByProduct, selectedShift);
  }
  consumptionByComponent = buildRecipeConsumptionByComponent(recipes, productionByProduct);

  const rows = detailRows.map((row) => {
    const itemKey = normalizeCategory(row.itemName);
    const previousStock = initialDetailStockForShift(row.element, selectedShift);
    const currentStock = currentDetailStockForShift(row.element, selectedShift);
    const sales = orderDetailsUnitsForDateAndProduct(selectedDate, row.itemName);
    const factor = theoreticalRecipeUnitFactor(row.itemName);
    const producedRaw = productionByProduct.get(itemKey);
    const consumedRaw = consumptionByComponent.get(itemKey) || 0;
    const producedStock = Number.isFinite(producedRaw) ? producedRaw / factor : 0;
    const consumedStock = consumedRaw / factor;
    const missing = [];
    const specialStock = specialTheoreticalStockForRow(row, detailRows, selectedDate, counterUnits, selectedShift);

    if (specialStock) {
      return {
        ...row,
        selectedShift,
        previousStock: specialStock.previousStock,
        producedStock: specialStock.producedStock,
        consumedStock: specialStock.consumedStock,
        sales: specialStock.sales,
        theoreticalStock: specialStock.theoreticalStock,
        missing: specialStock.missing
      };
    }

    if (isNeutralTheoreticalStockItem(row.itemName)) {
      return {
        ...row,
        selectedShift,
        previousStock,
        producedStock: 0,
        consumedStock: 0,
        sales,
        theoreticalStock: currentStock,
        missing: Number.isFinite(currentStock) ? [] : [`stock actual ${row.itemName}`]
      };
    }

    if (!Number.isFinite(previousStock)) missing.push(`stock anterior ${row.itemName}`);
    const needsCounterDrivenConsumption = requiresCounterDrivenConsumption(row.itemName, recipes);
    if (needsCounterDrivenConsumption && !Number.isFinite(counterUnits)) {
      missing.push("Contador alipack actual");
    }
    const theoreticalStock = Number.isFinite(previousStock)
      && !(needsCounterDrivenConsumption && !Number.isFinite(counterUnits))
      ? previousStock + producedStock - sales - consumedStock
      : NaN;

    return {
      ...row,
      selectedShift,
      previousStock,
      producedStock,
      consumedStock,
      sales,
      theoreticalStock,
      missing
    };
  });

  return {
    selectedShift,
    counterUnits,
    recipesApplied: recipes.length,
    rows,
    highlightedRows: rows
      .filter((row) => Number.isFinite(row.theoreticalStock) && (row.consumedStock || row.producedStock || row.sales))
      .slice(0, 12)
  };
}

function requiresCounterDrivenConsumption(itemName, recipes) {
  const itemKey = normalizeCategory(itemName);
  return recipes.some((recipe) =>
    normalizeCategory(recipe.productName) === "granel dulce"
    && normalizeCategory(recipe.componentName) === itemKey
  );
}

function applyNeutralIntermediateProduction(detailRows, recipes, productionByProduct, selectedShift) {
  detailRows
    .filter((row) => isNeutralTheoreticalStockItem(row.itemName))
    .forEach((row) => {
      const itemKey = normalizeCategory(row.itemName);
      const consumedByParents = recipes
        .filter((recipe) => normalizeCategory(recipe.componentName) === itemKey)
        .reduce((total, recipe) => {
          const parentProduced = productionByProduct.get(normalizeCategory(recipe.productName));
          return Number.isFinite(parentProduced) ? total + (parentProduced * recipe.quantity) : total;
        }, 0);
      const previousStock = initialDetailStockForShift(row.element, selectedShift);
      const currentStock = currentDetailStockForShift(row.element, selectedShift);
      const stockDelta = Number.isFinite(previousStock) && Number.isFinite(currentStock)
        ? currentStock - previousStock
        : 0;

      if (consumedByParents > 0 || stockDelta !== 0) {
        productionByProduct.set(itemKey, consumedByParents + stockDelta);
      }
    });
}

function buildRecipeConsumptionByComponent(recipes, productionByProduct) {
  const consumptionByComponent = new Map();
  recipes.forEach((recipe) => {
    const produced = productionByProduct.get(normalizeCategory(recipe.productName));
    if (!Number.isFinite(produced)) return;
    const componentKey = normalizeCategory(recipe.componentName);
    consumptionByComponent.set(componentKey, (consumptionByComponent.get(componentKey) || 0) + (produced * recipe.quantity));
  });
  return consumptionByComponent;
}

function specialTheoreticalStockForRow(row, detailRows, selectedDate, counterUnits, selectedShift) {
  const itemName = normalizeCategory(row.itemName);
  const granelIngredientCoefficient = granelDulceIngredientCoefficient(itemName);
  if (Number.isFinite(granelIngredientCoefficient)) {
    return specialGranelIngredientTheoreticalStock(row, detailRows, counterUnits, granelIngredientCoefficient, selectedShift);
  }
  if (itemName === "bobina barra pop") {
    return specialBobinaBarraPopTheoreticalStock(row, counterUnits, selectedShift);
  }
  if (itemName === "caja 140") {
    return specialCaja140TheoreticalStock(row, detailRows, selectedDate, selectedShift);
  }
  if (itemName === "barra pop") {
    return specialBarraPopTheoreticalStock(row, detailRows, selectedDate, counterUnits, selectedShift);
  }
  if (itemName !== "barra pop 140ud") return null;

  const bagRow = detailRows.find((detailRow) => isBarraPopName(detailRow.itemName));
  const previousStock = initialDetailStockForShift(row.element, selectedShift);
  const previousBagStock = bagRow ? initialDetailStockForShift(bagRow.element, selectedShift) : NaN;
  const currentBagStock = bagRow ? currentDetailStockForShift(bagRow.element, selectedShift) : NaN;
  const sales = orderDetailsUnitsForDateAndProduct(selectedDate, row.itemName);
  const missing = [];

  if (!Number.isFinite(previousStock)) missing.push("stock anterior Barra_Pop_140Ud");
  if (!Number.isFinite(previousBagStock)) missing.push("stock anterior Barra_Pop");
  if (!Number.isFinite(currentBagStock)) missing.push("stock actual Barra_Pop");
  if (!Number.isFinite(counterUnits)) missing.push("Contador alipack actual");

  const theoreticalStock = missing.length
    ? NaN
    : previousStock - sales + ((previousBagStock * 2000) - (currentBagStock * 2000) + counterUnits) / 140;

  return {
    previousStock,
    producedStock: Number.isFinite(previousBagStock) && Number.isFinite(currentBagStock) && Number.isFinite(counterUnits)
      ? ((previousBagStock - currentBagStock) * 2000 + counterUnits) / 140
      : NaN,
    consumedStock: 0,
    sales,
    theoreticalStock,
    missing
  };
}

function specialGranelIngredientTheoreticalStock(row, detailRows, counterUnits, coefficient, selectedShift) {
  const granelRow = detailRows.find((detailRow) => isNeutralTheoreticalStockItem(detailRow.itemName));
  const previousStock = initialDetailStockForShift(row.element, selectedShift);
  const previousGranelStock = granelRow ? initialDetailStockForShift(granelRow.element, selectedShift) : NaN;
  const currentGranelStock = granelRow ? currentDetailStockForShift(granelRow.element, selectedShift) : NaN;
  const missing = [];

  if (!inventoryPhotoApplied) missing.push("foto de inventario aplicada");
  if (!Number.isFinite(previousStock)) missing.push(`stock anterior ${row.itemName}`);
  if (!Number.isFinite(counterUnits)) missing.push("Contador alipack actual");
  if (!Number.isFinite(previousGranelStock)) missing.push("stock anterior Granel Dulce");
  if (!Number.isFinite(currentGranelStock)) missing.push("stock actual Granel Dulce");

  const granelProduced = Number.isFinite(counterUnits)
    && Number.isFinite(previousGranelStock)
    && Number.isFinite(currentGranelStock)
    ? (counterUnits * 0.0165) + (currentGranelStock - previousGranelStock)
    : NaN;
  const consumedStock = Number.isFinite(granelProduced) ? granelProduced * coefficient : NaN;

  return {
    previousStock,
    producedStock: 0,
    consumedStock,
    sales: 0,
    theoreticalStock: missing.length ? NaN : previousStock - consumedStock,
    missing
  };
}

function specialBobinaBarraPopTheoreticalStock(row, counterUnits, selectedShift) {
  const previousStock = initialDetailStockForShift(row.element, selectedShift);
  const missing = [];

  if (!Number.isFinite(previousStock)) missing.push("stock anterior Bobina_Barra_Pop");
  if (!Number.isFinite(counterUnits)) missing.push("Contador alipack actual");

  const consumedStock = Number.isFinite(counterUnits) ? counterUnits / 5212 : NaN;
  return {
    previousStock,
    producedStock: 0,
    consumedStock,
    sales: 0,
    theoreticalStock: missing.length ? NaN : previousStock - consumedStock,
    missing
  };
}

function specialCaja140TheoreticalStock(row, detailRows, selectedDate, selectedShift) {
  const previousStock = initialDetailStockForShift(row.element, selectedShift);
  const targetBoxesProduced = barraPop140ProducedBoxes(detailRows, selectedDate, selectedShift);
  const missing = [];

  if (!Number.isFinite(previousStock)) missing.push("stock anterior Caja_140");
  if (!Number.isFinite(targetBoxesProduced)) missing.push("produccion Barra_Pop_140Ud");

  const consumedStock = Number.isFinite(targetBoxesProduced) ? targetBoxesProduced / 25 : NaN;
  return {
    previousStock,
    producedStock: 0,
    consumedStock,
    sales: 0,
    theoreticalStock: missing.length ? NaN : previousStock - consumedStock,
    missing
  };
}

function specialBarraPopTheoreticalStock(row, detailRows, selectedDate, counterUnits, selectedShift) {
  const targetRow = detailRows.find((detailRow) => normalizeCategory(detailRow.itemName) === "barra pop 140ud");
  const previousStock = initialDetailStockForShift(row.element, selectedShift);
  const previousTargetStock = targetRow ? initialDetailStockForShift(targetRow.element, selectedShift) : NaN;
  const currentTargetStock = targetRow ? currentDetailStockForShift(targetRow.element, selectedShift) : NaN;
  const targetSales = orderDetailsUnitsForDateAndProduct(selectedDate, "Barra_Pop_140Ud");
  const missing = [];

  if (!Number.isFinite(previousStock)) missing.push("stock anterior Barra_Pop");
  if (!Number.isFinite(counterUnits)) missing.push("Contador alipack actual");
  if (!Number.isFinite(previousTargetStock)) missing.push("stock anterior Barra_Pop_140Ud");
  if (!Number.isFinite(currentTargetStock)) missing.push("stock actual Barra_Pop_140Ud");

  const targetBoxesProduced = barraPop140ProducedBoxes(detailRows, selectedDate, selectedShift);
  const theoreticalStock = missing.length
    ? NaN
    : previousStock + ((counterUnits - (targetBoxesProduced * 140)) / 2000);

  return {
    previousStock,
    producedStock: Number.isFinite(counterUnits) ? counterUnits / 2000 : NaN,
    consumedStock: Number.isFinite(targetBoxesProduced) ? (targetBoxesProduced * 140) / 2000 : NaN,
    sales: 0,
    theoreticalStock,
    missing
  };
}

function barraPop140ProducedBoxes(detailRows, selectedDate, selectedShift) {
  const targetRow = detailRows.find((detailRow) => normalizeCategory(detailRow.itemName) === "barra pop 140ud");
  if (!targetRow) return NaN;

  const previousTargetStock = initialDetailStockForShift(targetRow.element, selectedShift);
  const currentTargetStock = currentDetailStockForShift(targetRow.element, selectedShift);
  const targetSales = orderDetailsUnitsForDateAndProduct(selectedDate, "Barra_Pop_140Ud");
  return Number.isFinite(previousTargetStock) && Number.isFinite(currentTargetStock)
    ? currentTargetStock - previousTargetStock + targetSales
    : NaN;
}

