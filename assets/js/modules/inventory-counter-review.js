function inventoryDetailTableRows() {
  return [...els["inventory-detail-body"].querySelectorAll("tr[data-item-id]")].map((element) => ({
    element,
    itemId: element.dataset.itemId || "",
    itemName: element.dataset.itemName || element.children[2]?.textContent?.trim() || ""
  }));
}

function recipeRowsForTheoreticalStock() {
  return (state.recipes || []).filter((recipe) =>
    recipe.productName
    && recipe.componentName
    && Number.isFinite(recipe.quantity)
    && recipe.quantity > 0
  );
}

function currentCounterUnits(shift = firstSelectedInventoryShift()) {
  const manualCounter = manualCounterUnitsForShift(shift);
  if (Number.isFinite(manualCounter)) return manualCounter;

  const counterRow = findInventoryDetailRowByName("Contador alipack");
  const currentCounter = counterRow ? currentDetailStockForShift(counterRow, shift) : NaN;
  return Number.isFinite(currentCounter) ? currentCounter : counterFromLastPhotoTranscription(shift);
}

function manualCounterUnitsForShift(shift) {
  const inputId = {
    morning: "inventory-counter-manual-morning",
    afternoon: "inventory-counter-manual-afternoon",
    dawn: "inventory-counter-manual-dawn"
  }[shift];
  if (!inputId) return NaN;
  const value = els[inputId]?.value || "";
  return String(value).trim() ? parseQuantity(value) : NaN;
}

function clearManualCounterCorrections() {
  ["inventory-counter-manual-morning", "inventory-counter-manual-afternoon", "inventory-counter-manual-dawn"].forEach((id) => {
    if (els[id]) els[id].value = "";
  });
}

function updateInventoryCounterReview() {
  const hasDetailRows = Boolean(els["inventory-detail-body"]?.querySelector("tr[data-item-id]"));
  if (!hasDetailRows) return;

  updateCounterReviewField("afternoon");
  updateCounterReviewField("morning");
  updateCounterReviewField("dawn");
  renderCounterTheoreticalComparison("afternoon");
  renderCounterTheoreticalComparison("morning");
  renderCounterTheoreticalComparison("dawn");
}

function updateCounterReviewField(shift) {
  const manualId = {
    morning: "inventory-counter-manual-morning",
    afternoon: "inventory-counter-manual-afternoon",
    dawn: "inventory-counter-manual-dawn"
  }[shift];
  const manualInput = els[manualId];
  const aiCounter = counterFromLastPhotoTranscription(shift);
  const rowCounter = currentCounterFromDetailRow(shift);
  const visibleCounter = Number.isFinite(aiCounter) ? aiCounter : rowCounter;
  const shiftEnabled = isInventoryShiftEnabled(shift);

  if (manualInput) {
    manualInput.disabled = !shiftEnabled;
    manualInput.placeholder = Number.isFinite(visibleCounter) ? formatRoundedNumber(visibleCounter) : "-";
    if (!shiftEnabled) {
      manualInput.value = "";
      manualInput.dataset.autoValue = "";
      return;
    }
    const autoValue = Number.isFinite(visibleCounter) ? String(visibleCounter) : "";
    if (!manualInput.value || manualInput.value === manualInput.dataset.autoValue) {
      manualInput.value = autoValue;
    }
    manualInput.dataset.autoValue = autoValue;
  }
}

function currentCounterFromDetailRow(shift) {
  const counterRow = findInventoryDetailRowByName("Contador alipack");
  return counterRow ? currentDetailStockForShift(counterRow, shift) : NaN;
}

function renderCounterTheoreticalComparison(shift) {
  const theoreticalCell = els[`inventory-counter-theoretical-${shift}`];
  const diffCell = els[`inventory-counter-diff-${shift}`];
  const input = els[`inventory-counter-manual-${shift}`];
  [theoreticalCell, diffCell, input].forEach((element) => {
    element?.classList.remove("stock-diff-yellow", "stock-diff-orange", "stock-diff-red");
  });
  if (!theoreticalCell || !diffCell || !input) return;

  const theoreticalCounter = theoreticalCounterUnitsForShift(shift);
  const roundedTheoreticalCounter = roundedNumberValue(theoreticalCounter);
  const loadedCounter = manualCounterUnitsForShift(shift);
  if (!Number.isFinite(theoreticalCounter)) {
    theoreticalCell.textContent = "-";
    diffCell.textContent = "-";
    theoreticalCell.title = "Faltan stocks para calcular el contador teorico.";
    diffCell.title = "";
    return;
  }

  theoreticalCell.textContent = formatRoundedNumber(theoreticalCounter);
  theoreticalCell.title = "Ventas + diferencia Barra_Pop_140Ud x 140 + diferencia Barra_Pop x 2000";
  if (!Number.isFinite(loadedCounter) || !Number.isFinite(roundedTheoreticalCounter) || roundedTheoreticalCounter === 0) {
    diffCell.textContent = "-";
    diffCell.title = "Falta contador cargado para comparar.";
    return;
  }

  const differencePercent = ((loadedCounter - roundedTheoreticalCounter) / roundedTheoreticalCounter) * 100;
  diffCell.textContent = formatRoundedPercentValue(differencePercent);
  diffCell.title = `Teorico redondeado: ${formatRoundedNumber(theoreticalCounter)} | Teorico real: ${formatNumber(theoreticalCounter)} | Cargado: ${formatNumber(loadedCounter)}`;
  markTheoreticalStockDifferenceLevel([input, theoreticalCell, diffCell], differencePercent);
}

function theoreticalCounterUnitsForShift(shift) {
  const targetRow = findInventoryDetailRowByName("Barra_Pop_140Ud");
  const bagRow = findInventoryDetailRowByName("Barra_Pop");
  if (!targetRow || !bagRow) return NaN;

  const previousTargetStock = initialDetailStockForShift(targetRow, shift);
  const currentTargetStock = currentDetailStockForShift(targetRow, shift);
  const previousBagStock = initialDetailStockForShift(bagRow, shift);
  const currentBagStock = currentDetailStockForShift(bagRow, shift);
  if (![previousTargetStock, currentTargetStock, previousBagStock, currentBagStock].every(Number.isFinite)) {
    return NaN;
  }

  const sales = orderDetailsIndividualUnitsForDateAndProduct(
    els["inventory-date-input"]?.value || "",
    "Barra_Pop_140Ud",
    shift,
    targetRow.dataset.itemId
  );
  return sales
    + ((currentTargetStock - previousTargetStock) * 140)
    + ((currentBagStock - previousBagStock) * 2000);
}

function isBarraPopName(itemName) {
  return normalizeCategory(itemName) === "barra pop";
}

function isNeutralTheoreticalStockItem(itemName) {
  return normalizeCategory(itemName) === "granel dulce";
}

function theoreticalRecipeUnitFactor(itemName) {
  return isBarraPopName(itemName) ? 2000 : 1;
}

function granelDulceIngredientCoefficient(itemName) {
  return {
    "maiz pisingallo": 1.285,
    azucar: 0.143,
    aceite: 0.186,
    "escencia de vainilla": 0.007,
    "esencia de vainilla": 0.007
  }[normalizeCategory(itemName)] ?? NaN;
}

function markTheoreticalStockMissing(cell, message) {
  if (!cell) return;
  cell.textContent = "-";
  cell.classList.remove("missing-theoretical-stock");
  cell.title = message;
}

function findInventoryDetailRowByName(itemName) {
  const targetName = normalizeCategory(itemName);
  return [...els["inventory-detail-body"].querySelectorAll("tr[data-item-id]")]
    .find((row) => normalizeCategory(row.dataset.itemName || "") === targetName) || null;
}

function previousDetailStock(row) {
  return firstFiniteQuantity([
    row.dataset.previousAfternoon,
    row.dataset.previousMorning,
    row.dataset.previousDawn
  ]);
}

function initialDetailStockForShift(row, shift) {
  const previousWorkedShift = previousWorkedInventoryShift(shift);
  if (previousWorkedShift) return currentDetailStockForShift(row, previousWorkedShift);
  return previousDetailStock(row);
}

function previousWorkedInventoryShift(shift) {
  const shiftOrder = ["dawn", "morning", "afternoon"];
  const selected = new Set(selectedInventoryShifts());
  const shiftIndex = shiftOrder.indexOf(shift);
  if (shiftIndex <= 0) return "";

  for (let index = shiftIndex - 1; index >= 0; index -= 1) {
    if (selected.has(shiftOrder[index])) return shiftOrder[index];
  }
  return "";
}

function currentDetailStockForShift(row, shift) {
  if (!shift) return NaN;
  const value = detailInputValue(row, shift);
  if (!String(value).trim()) return NaN;
  return parseQuantity(value);
}

function firstFiniteQuantity(values) {
  for (const value of values) {
    const quantity = parseQuantity(value);
    if (Number.isFinite(quantity) && String(value ?? "").trim() !== "") return quantity;
  }
  return NaN;
}

function orderDetailsUnitsForDateAndProduct(dateIso, productName, selectedShift, itemId = "") {
  return orderDetailsForDateAndProduct(dateIso, productName, selectedShift, itemId)
    .reduce((total, exit) => total + (Number(exit.quantity) || 0), 0);
}

function orderDetailsIndividualUnitsForDateAndProduct(dateIso, productName, selectedShift, itemId = "") {
  const exits = orderDetailsForDateAndProduct(dateIso, productName, selectedShift, itemId);
  if (exits.some((exit) => (
    exit.individualQuantity === null
    || exit.individualQuantity === ""
    || !Number.isFinite(Number(exit.individualQuantity))
  ))) return NaN;
  return exits.reduce((total, exit) => total + Number(exit.individualQuantity), 0);
}

function orderDetailsForDateAndProduct(dateIso, productName, selectedShift, itemId = "") {
  const targetProduct = normalizeCategory(productName);
  const targetItemId = String(itemId || "").trim();
  const previousShift = previousWorkedInventoryShift(selectedShift);
  const previousOrder = inventoryShiftOrder(previousShift);
  const selectedOrder = inventoryShiftOrder(selectedShift);
  return (inventoryDetailTemplate?.salesExits || [])
    .filter((exit) => {
      const exitOrder = inventoryShiftOrder(exit.shift);
      const matchesItem = targetItemId && String(exit.itemId || "").trim() === targetItemId;
      return exit.date === dateIso
        && (matchesItem || normalizeCategory(exit.productName) === targetProduct)
        && exitOrder > previousOrder
        && exitOrder <= selectedOrder;
    });
}

function inventoryShiftOrder(shift) {
  return { dawn: 0, morning: 1, afternoon: 2 }[shift] ?? -1;
}

function counterFromLastPhotoTranscription(shift = firstSelectedInventoryShift()) {
  if (!lastInventoryPhotoTranscription?.rows?.length) return NaN;
  if (!shift) return NaN;
  const counterRow = lastInventoryPhotoTranscription.rows.find((row) =>
    isCounterAlipackName(row.itemName || row.name || row.product || "")
  );
  if (!counterRow) return NaN;

  return firstFiniteQuantity([
    inventoryTranscriptionShiftValue(counterRow, shift),
    counterRow[shift],
    shift === "afternoon" ? counterRow.turnoTarde : "",
    shift === "morning" ? counterRow.turnoManana : "",
    shift === "dawn" ? counterRow.turnoMadrugada : ""
  ]);
}

function isCounterAlipackName(value) {
  const normalized = normalizeCategory(value);
  return normalized.includes("contador") && normalized.includes("alipack");
}

function renderTheoreticalStockBreakdown(data) {
  const panel = document.getElementById("theoretical-stock-breakdown");
  if (!panel) return;

  if (!data) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }

  panel.hidden = false;
  const selectedShiftLabel = inventoryShiftLabel(data.selectedShift);
  const rows = Array.isArray(data.highlightedRows) ? data.highlightedRows : [];
  panel.innerHTML = `
    <div class="theoretical-stock-title">Stock teorico</div>
    <div class="theoretical-stock-grid">
      <span>Turno usado</span><strong>${escapeHtml(selectedShiftLabel || "-")}</strong>
      <span>Contador alipack</span><strong>${formatNullableNumber(data.counterUnits)}</strong>
      <span>Recetas aplicadas</span><strong>${formatNumber(data.recipesApplied || 0)}</strong>
    </div>
    ${rows.length ? `
      <div class="table-wrap theoretical-stock-table-wrap">
        <table class="data-entry-table theoretical-stock-table">
          <thead>
            <tr>
              <th>Item</th>
              <th class="num">Anterior</th>
              <th class="num">Entradas</th>
              <th class="num">Produccion</th>
              <th class="num">Ventas</th>
              <th class="num">Consumo recetas</th>
              <th class="num">Teorico</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => `
              <tr>
                <td>${escapeHtml(row.itemName)}</td>
                <td class="num">${formatNullableNumber(row.previousStock)}</td>
                <td class="num">${formatNullableNumber(row.receivedStock)}</td>
                <td class="num">${formatNullableNumber(row.producedStock)}</td>
                <td class="num">${formatNullableNumber(row.sales)}</td>
                <td class="num">${formatNullableNumber(row.consumedStock)}</td>
                <td class="num">${formatNullableNumber(row.theoreticalStock)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    ` : ""}
    ${data.missing?.length ? `<div class="theoretical-stock-missing">Falta: ${escapeHtml(data.missing.join(", "))}</div>` : ""}
  `;
}

function inventoryShiftLabel(field) {
  return {
    dawn: "Madrugada",
    morning: "Mañana",
    afternoon: "Tarde"
  }[field] || "";
}

function formatNullableNumber(value) {
  return Number.isFinite(value) ? formatNumber(value) : "-";
}
