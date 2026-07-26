async function loadInventoryDetailTemplate() {
  const date = els["inventory-date-input"].value;
  if (!date) {
    renderInventoryDetailTemplate(null);
    setInventoryDetailStatus("ElegĂ­ una fecha para preparar el detalle.", "pending");
    return;
  }

  const button = els["inventory-detail-load"];
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Preparando...";
  setInventoryDetailStatus("Leyendo el Ăşltimo detalle cargado...", "pending");

  try {
    const response = await fetch(`${API_BASE_URL}/api/inventory-detail/template`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);

    inventoryDetailTemplate = payload;
    renderInventoryDetailTemplate(payload);
    setInventoryDetailStatus(`Detalle preparado con ${payload.rows.length} items.`, "success");
  } catch (error) {
    renderInventoryDetailTemplate(null);
    setInventoryDetailStatus(`No se pudo preparar el detalle: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function renderInventoryDetailTemplate(template) {
  inventoryDetailTemplate = template;
  lastInventoryPhotoTranscription = null;
  inventoryPhotoApplied = false;
  renderInventoryPhotoTranscription(null);
  if (els["inventory-detail-id-label"]) {
    els["inventory-detail-id-label"].textContent = `Id inventario: ${template?.inventoryId || "-"}`;
  }

  if (!template?.rows?.length) {
    els["inventory-detail-body"].innerHTML = emptyRow(12, "Todavia no hay detalle preparado.");
    return;
  }

  els["inventory-detail-body"].innerHTML = template.rows.map((row) => `
    <tr data-item-id="${escapeHtml(row.itemId)}" data-item-name="${escapeHtml(row.itemName)}" data-previous-afternoon="${escapeHtml(row.previousAfternoon || "")}" data-previous-morning="${escapeHtml(row.previousMorning || "")}" data-previous-dawn="${escapeHtml(row.previousDawn || "")}">
      <td>${escapeHtml(template.inventoryId)}</td>
      <td>${escapeHtml(row.itemId)}</td>
      <td>
        <span class="inventory-item-name">${escapeHtml(row.itemName)}</span>
        <span class="inventory-purchase-alert" data-purchase-alert hidden>
          <span class="inventory-alert-icon">!</span>
          <button type="button" data-purchase-item="${escapeHtml(row.itemName)}" data-purchase-item-id="${escapeHtml(row.itemId)}">Comprar</button>
        </span>
      </td>
      <td class="num dawn-stock-cell"><input class="detail-quantity-input" data-detail-field="dawn" type="number" step="any"></td>
      <td class="num theoretical-stock-cell dawn-theoretical-stock-cell" data-theoretical-shift="dawn">-</td>
      <td class="num theoretical-diff-cell dawn-theoretical-diff-cell" data-theoretical-shift="dawn">-</td>
      <td class="num morning-stock-cell"><input class="detail-quantity-input" data-detail-field="morning" type="number" step="any"></td>
      <td class="num theoretical-stock-cell morning-theoretical-stock-cell" data-theoretical-shift="morning">-</td>
      <td class="num theoretical-diff-cell morning-theoretical-diff-cell" data-theoretical-shift="morning">-</td>
      <td class="num afternoon-stock-cell"><input class="detail-quantity-input" data-detail-field="afternoon" type="number" step="any"></td>
      <td class="num theoretical-stock-cell afternoon-theoretical-stock-cell" data-theoretical-shift="afternoon">-</td>
      <td class="num theoretical-diff-cell afternoon-theoretical-diff-cell" data-theoretical-shift="afternoon">-</td>
    </tr>
  `).join("") + renderCounterAlipackRow();
  els["inventory-detail-body"].querySelectorAll(".detail-quantity-input").forEach((input) => {
    input.addEventListener("input", () => {
      updateInventoryCounterReview();
      updateTheoreticalInventoryStock();
    });
  });
  cacheInventoryCounterInputs();
  bindInventoryCounterInputs();
  clearDisabledInventoryShiftInputs();
  clearManualCounterCorrections();
  updateInventoryCounterReview();
  updateTheoreticalInventoryStock();
}

function cacheInventoryCounterInputs() {
  [
    "inventory-counter-manual-morning",
    "inventory-counter-manual-afternoon",
    "inventory-counter-manual-dawn",
    "inventory-counter-theoretical-morning",
    "inventory-counter-theoretical-afternoon",
    "inventory-counter-theoretical-dawn",
    "inventory-counter-diff-morning",
    "inventory-counter-diff-afternoon",
    "inventory-counter-diff-dawn"
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });
}

function bindInventoryCounterInputs() {
  ["inventory-counter-manual-morning", "inventory-counter-manual-afternoon", "inventory-counter-manual-dawn"].forEach((id) => {
    els[id]?.addEventListener("input", () => {
      syncManualCounterCorrection(id);
      updateInventoryCounterReview();
      updateTheoreticalInventoryStock();
    });
  });
}

function renderCounterAlipackRow() {
  return `
    <tr class="inventory-counter-row">
      <td></td>
      <td></td>
      <td>
        <strong>Contador Alipack</strong>
      </td>
      <td class="num dawn-stock-cell">
        <input id="inventory-counter-manual-dawn" type="number" step="any" placeholder="-">
      </td>
      <td class="num theoretical-stock-cell" id="inventory-counter-theoretical-dawn">-</td>
      <td class="num theoretical-diff-cell" id="inventory-counter-diff-dawn">-</td>
      <td class="num morning-stock-cell">
        <input id="inventory-counter-manual-morning" type="number" step="any" placeholder="-">
      </td>
      <td class="num theoretical-stock-cell" id="inventory-counter-theoretical-morning">-</td>
      <td class="num theoretical-diff-cell" id="inventory-counter-diff-morning">-</td>
      <td class="num afternoon-stock-cell">
        <input id="inventory-counter-manual-afternoon" type="number" step="any" placeholder="-">
      </td>
      <td class="num theoretical-stock-cell" id="inventory-counter-theoretical-afternoon">-</td>
      <td class="num theoretical-diff-cell" id="inventory-counter-diff-afternoon">-</td>
    </tr>
  `;
}

