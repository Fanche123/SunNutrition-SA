function updateInventoryPurchaseAlerts() {
  const rows = els["inventory-detail-body"]?.querySelectorAll("tr[data-item-id]") || [];
  const snapshotItems = Array.isArray(inventoryPurchaseSnapshot?.items)
    ? inventoryPurchaseSnapshot.items
    : [];
  rows.forEach((row) => {
    const itemName = row.dataset.itemName || "";
    const alert = row.querySelector("[data-purchase-alert]");
    if (!alert) return;

    const data = inventoryPurchaseSnapshotItem(itemName, row.dataset.itemId);
    alert.hidden = !data;
    alert.classList.toggle("is-visible", Boolean(data));
    if (data) {
      alert.title = `Stock: ${formatNumber(data.stock)} | Minimo: ${formatNumber(data.required)} | Proveedor: ${data.provider} | Entrega: ${data.leadDays} dias corridos / ${data.businessDays} dias habiles`;
      const button = alert.querySelector("button");
      if (button) {
        button.dataset.purchaseItem = itemName;
        button.dataset.purchaseItemId = row.dataset.itemId || "";
      }
    }
  });
  renderPurchaseThresholdTable(snapshotItems);
}

function inventoryPurchaseSnapshotItem(itemName, itemId = "") {
  const normalizedId = String(itemId || "").trim();
  const normalizedName = normalizeCategory(itemName);
  return (inventoryPurchaseSnapshot?.items || []).find((item) => (
    (normalizedId && String(item.itemId || "").trim() === normalizedId)
    || normalizeCategory(item.itemName) === normalizedName
  )) || null;
}

function renderPurchaseThresholdTable(infos) {
  if (!els["purchase-threshold-body"]) return;
  if (els["purchase-threshold-snapshot-date"]) {
    els["purchase-threshold-snapshot-date"].textContent = inventoryPurchaseSnapshotStatusMessage(
      inventoryPurchaseSnapshot
    );
  }

  els["purchase-threshold-body"].innerHTML = infos.length
    ? infos.map((info) => `
      <tr>
        <td>${escapeHtml(displayNameLabel(info.itemName || "Insumo sin nombre"))}</td>
        <td class="num">${escapeHtml(purchaseInventoryQuantityLabel(info.stock, info.unit))}</td>
        <td>${escapeHtml(info.provider || missingPurchaseProviderLabel())}</td>
        <td class="num">${formatLeadAndConsumptionDays(info)}</td>
        <td class="num">${escapeHtml(purchaseInventoryDaysLabel(info.daysRemaining))}</td>
        <td class="num">${formatNumber(info.dailyConsumption)}</td>
        <td class="num" title="${escapeHtml(formatStockMinimumFormula(info))}">${formatNullableNumber(info.required)}</td>
        <td><span class="purchase-threshold-state is-low">Comprar</span></td>
      </tr>
    `).join("")
    : emptyRow(8, inventoryPurchaseSnapshotEmptyMessage(inventoryPurchaseSnapshot));
}

function formatLeadAndConsumptionDays(info) {
  if (!info.leadDays) return "-";
  return `${formatNumber(info.leadDays)} corr. / ${formatNumber(info.businessDays)} hab.`;
}

function formatStockMinimumFormula(info) {
  if (!Number.isFinite(info.required)) return "";
  return `Stock minimo = ${formatNumber(info.dailyConsumption)} consumo diario x ${formatNumber(info.businessDays)} dias habiles`;
}

function isBusinessDay(date) {
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  const calendar = payrollCalendarForYear(date.getFullYear());
  if (!calendar.configured) {
    throw new Error(`Calendario laboral no configurado para ${date.getFullYear()}.`);
  }
  return !calendar.dates.has(toIsoDate(date));
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function lastPurchaseProviderForItem(itemName) {
  const key = normalizeCategory(itemName);
  const details = [...(state.purchaseDetails || [])]
    .filter((row) => purchaseDetailMatchesItem(row, key))
    .sort((a, b) => purchaseDetailSortValue(b) - purchaseDetailSortValue(a));
  const detail = details.find((row) => row.supplier || row.id);
  if (!detail) return "";
  if (detail.supplier) return detail.supplier;
  return purchaseSupplierById(detail.id);
}

function purchaseDetailMatchesItem(row, itemKey) {
  const detailKey = normalizeCategory(row.itemName);
  if (!detailKey || !itemKey) return false;
  return detailKey === itemKey || detailKey.includes(itemKey) || itemKey.includes(detailKey);
}

function missingPurchaseProviderLabel() {
  if (!(state.purchaseDetails || []).length) return "Falta Detalle_Compras";
  if (!(state.purchases || []).length) return "Falta Compras";
  if (!(state.providers || []).length) return "Falta Proveedores";
  return "Sin proveedor";
}

function reconcilePurchaseDetailSuppliers() {
  if (!Array.isArray(state.purchaseDetails) || !state.purchaseDetails.length) return;
  state.purchaseDetails = state.purchaseDetails.map((row) => ({
    ...row,
    supplier: row.supplier || purchaseSupplierById(row.id)
  }));
}

function purchaseDetailSortValue(row) {
  const dateValue = row.date ? new Date(`${row.date}T00:00:00`).getTime() : 0;
  const idValue = Number(row.id) || 0;
  return dateValue + idValue;
}

function purchaseSupplierById(id) {
  const purchase = (state.purchases || []).find((row) => String(row.id) === String(id));
  return purchase?.supplier || "";
}

function lastPurchaseUnitForItem(itemName) {
  const key = normalizeCategory(itemName);
  const detail = [...(state.purchaseDetails || [])]
    .sort((a, b) => purchaseDetailSortValue(b) - purchaseDetailSortValue(a))
    .find((row) => normalizeCategory(row.itemName) === key && row.supplierUnit);
  return detail?.supplierUnit || "";
}

function inventoryUnitForItem(itemName) {
  const backendSupply = purchaseBackendOptions.supplies.find((row) => normalizeCategory(row.nombre) === normalizeCategory(itemName));
  if (backendSupply?.ud_receta) return backendSupply.ud_receta;
  const item = itemInfoForInventoryItem(itemName);
  if (item?.countUnit) return item.countUnit;
  const key = normalizeInventoryToken(itemName);
  return {
    maizpisingallo: "Kg",
    azucar: "Kg",
    aceite: "Lt",
    escenciadevainilla: "Kg",
    esenciadevainilla: "Kg",
    bobinabarrapop: "Rollo",
    caja140: "Pack_25_Ud"
  }[key] || "";
}

function itemInfoForInventoryItem(itemName) {
  const key = normalizeCategory(itemName);
  const backendSupply = purchaseBackendOptions.supplies.find((row) => normalizeCategory(row.nombre) === key);
  if (backendSupply) {
    return {
      itemId: String(backendSupply.id_insumo ?? "").trim(),
      itemName: backendSupply.nombre || "",
      countUnit: purchaseCountUnitForSupply(backendSupply),
      recipeUnitFactor: parseQuantity(backendSupply.cantidad_receta) || 1
    };
  }
  return (state.itemInfo || []).find((row) => (
    normalizeCategory(row.itemName) === key
  )) || null;
}

function purchaseCountUnitForSupply(supply) {
  const supplyId = String(supply?.id_insumo ?? "").trim();
  const backendItem = purchaseBackendOptions.itemsBySupplyId.get(supplyId) || {};
  return backendItem.ud_conteo || supply?.ud_conteo || supply?.ud_receta || "";
}

function supplyInfoForPurchase(itemName, provider, supplierUnit = "") {
  const backendInfo = purchaseBackendSupplierInfo();
  if (backendInfo) return backendInfo;
  const itemKey = normalizeCategory(itemName);
  const providerKey = normalizeCategory(provider);
  const unitKey = normalizeCategory(supplierUnit);
  const rows = (state.supplyInfo || []).filter((row) => normalizeCategory(row.itemName) === itemKey);
  return rows.find((row) => providerNameMatches(row.supplier, providerKey))
    || rows.find((row) => normalizeCategory(row.supplierUnit) === unitKey)
    || rows[0]
    || null;
}

function recipeUnitsFromCountUnits(itemName, countQuantity) {
  const factor = itemInfoForInventoryItem(itemName)?.recipeUnitFactor;
  if (Number.isFinite(factor) && factor > 0) return countQuantity * factor;
  return countQuantity;
}

function roundedPurchaseOrder(itemName, missingStock, stockUnit, supplierUnit, provider) {
  if (!Number.isFinite(missingStock)) return { stockQuantity: "", supplierQuantity: "" };
  const supplyInfo = supplyInfoForPurchase(itemName, provider, supplierUnit);
  const recipeUnitFactor = itemInfoForInventoryItem(itemName)?.recipeUnitFactor || 1;
  const supplierRecipeQuantity = Number(supplyInfo?.recipeQuantity) || supplierUnitPackSize(supplierUnit);
  if (!supplierRecipeQuantity || !recipeUnitFactor) {
    const fallbackQuantity = Math.max(Math.ceil(missingStock), providerMinimumOrder(provider));
    return { stockQuantity: fallbackQuantity, supplierQuantity: "" };
  }

  const minimumSupplierQuantity = providerMinimumOrder(provider);
  const missingRecipeUnits = recipeUnitsFromCountUnits(itemName, missingStock);
  const baseSupplierQuantity = Math.max(
    Math.ceil(missingRecipeUnits / supplierRecipeQuantity),
    minimumSupplierQuantity
  );
  if (shouldPrettifyDirectSupplierUnit(supplierUnit)) {
    const prettySupplierQuantity = prettifyPurchaseQuantity(baseSupplierQuantity, supplierUnit);
    return {
      stockQuantity: (prettySupplierQuantity * supplierRecipeQuantity) / recipeUnitFactor,
      supplierQuantity: prettySupplierQuantity
    };
  }

  const baseStockQuantity = (baseSupplierQuantity * supplierRecipeQuantity) / recipeUnitFactor;
  const prettyStockQuantity = prettifyPurchaseQuantity(baseStockQuantity, stockUnit);
  const supplierQuantityFromStock = Math.ceil(recipeUnitsFromCountUnits(itemName, prettyStockQuantity) / supplierRecipeQuantity);
  return {
    stockQuantity: (supplierQuantityFromStock * supplierRecipeQuantity) / recipeUnitFactor,
    supplierQuantity: supplierQuantityFromStock
  };
}

function providerMinimumOrder(providerName) {
  const selectedMinimum = parseMoney(selectedPurchaseProvider()?.pedido_minimo);
  if (selectedMinimum) return selectedMinimum;
  const key = normalizeCategory(providerName);
  const provider = (state.providers || []).find((row) => providerNameMatches(row.name, key));
  return Number(provider?.minimumOrder) || 0;
}

function prettifyPurchaseQuantity(value, unit) {
  if (!Number.isFinite(value)) return "";
  const normalizedUnit = normalizeInventoryToken(unit);
  const maxValue = value * 1.15;
  const steps = ["kg", "lt"].includes(normalizedUnit)
    ? [1000, 500, 100, 50, 10, 5, 1]
    : [100, 50, 10, 5, 1];
  for (const step of steps) {
    const rounded = Math.ceil(value / step) * step;
    if (rounded <= maxValue) return rounded;
  }
  return Math.ceil(value);
}

function shouldPrettifyDirectSupplierUnit(unit) {
  return ["kg", "lt"].includes(normalizeInventoryToken(unit));
}

function supplierUnitPackSize(supplierUnit) {
  const text = String(supplierUnit || "");
  const match = text.match(/(?:^|_)(\d+(?:[.,]\d+)?)(?=kg|lt|ud|rollo|rollos|$)/i);
  if (!match) return 1;
  return parseQuantity(match[1]);
}

function providerLeadDays(providerName) {
  const selectedDays = Number(selectedPurchaseProvider()?.tiempo_estimado_entrega);
  if (selectedDays) return selectedDays;
  const key = normalizeCategory(providerName);
  const provider = (state.providers || []).find((row) => providerNameMatches(row.name, key));
  const configuredDays = Number(provider?.leadDays) || 0;
  if (configuredDays) return configuredDays;
  return purchaseLeadDaysFromHistory(providerName);
}

function providerNameMatches(candidateName, providerKey) {
  const candidateKey = normalizeCategory(candidateName);
  if (!candidateKey || !providerKey) return false;
  if (candidateKey === providerKey) return true;
  if (candidateKey.includes(providerKey) || providerKey.includes(candidateKey)) return true;
  return normalizedEditDistance(candidateKey, providerKey) <= 2;
}

function normalizedEditDistance(a, b) {
  const left = normalizeInventoryToken(a);
  const right = normalizeInventoryToken(b);
  if (!left || !right) return Infinity;
  const matrix = Array.from({ length: left.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= right.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
    }
  }
  return matrix[left.length][right.length];
}

function purchaseLeadDaysFromHistory(providerName) {
  const key = normalizeCategory(providerName);
  const purchase = [...(state.purchases || [])]
    .filter((row) => providerNameMatches(row.supplier, key) && row.date && row.expectedDeliveryDate)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];
  if (!purchase) return 0;

  const start = dateFromIso(purchase.date);
  const end = dateFromIso(purchase.expectedDeliveryDate);
  if (!start || !end) return 0;
  return Math.max(0, Math.round((end - start) / 86400000));
}

function updatePurchaseItemOptions() {
  const select = els["purchase-item-name"];
  if (!select) return;
  const currentValue = select.value;
  const sortedSupplies = [...purchaseBackendOptions.supplies]
    .filter((row) => String(row.id_insumo ?? "").trim())
    .sort((a, b) => displayNameLabel(a.nombre || "").localeCompare(displayNameLabel(b.nombre || "")));
  select.innerHTML = `<option value="">Elegir insumo</option>` + sortedSupplies.map((row) => `
    <option value="${escapeHtml(String(row.id_insumo ?? "").trim())}" data-raw-value="${escapeHtml(row.nombre || "")}">
      ${escapeHtml(displayNameLabel(row.nombre || `Insumo ${row.id_insumo}`))}
    </option>
  `).join("");
  if (sortedSupplies.some((row) => String(row.id_insumo ?? "").trim() === currentValue)) {
    select.value = currentValue;
  }
  syncSelectedPurchaseSupply();
}

function canonicalPurchaseItemName(value) {
  const key = normalizeCategory(value);
  const backendSupply = purchaseBackendOptions.supplies.find((row) => normalizeCategory(row.nombre) === key);
  if (backendSupply?.nombre) return backendSupply.nombre;
  return [
    ...(state.itemInfo || []).map((row) => row.itemName),
    ...(state.supplyInfo || []).map((row) => row.itemName),
    ...(state.purchaseDetails || []).map((row) => row.itemName)
  ].find((name) => normalizeCategory(name) === key) || value;
}

function selectedPurchaseSupplyId() {
  return String(els["purchase-item-name"]?.value || els["purchase-item-id"]?.value || "").trim();
}

function selectedPurchaseSupply() {
  return purchaseBackendOptions.suppliesById.get(selectedPurchaseSupplyId()) || null;
}

function selectedPurchaseSupplierLink() {
  return purchaseBackendOptions.supplierLinksById.get(String(els["purchase-provider"]?.value || "").trim()) || null;
}

function selectedPurchaseProvider() {
  const link = selectedPurchaseSupplierLink();
  return purchaseBackendOptions.providersById.get(String(link?.id_proveedor ?? "").trim()) || null;
}

function syncSelectedPurchaseSupply() {
  if (els["purchase-item-id"]) els["purchase-item-id"].value = selectedPurchaseSupplyId();
  const supply = selectedPurchaseSupply();
  setPurchaseUnitLabel(els["purchase-quantity-unit"], purchaseCountUnitForSupply(supply) || inventoryUnitForItem(supply?.nombre));
  setPurchaseUnitLabel(els["purchase-recipe-unit"], supply?.ud_receta || inventoryUnitForItem(supply?.nombre));
}

function syncSelectedPurchaseSupplier() {
  const link = selectedPurchaseSupplierLink();
  if (els["purchase-supplier-id"]) els["purchase-supplier-id"].value = String(link?.id_insumos_proveedores ?? "").trim();
  setPurchaseUnitLabel(els["purchase-unit"], link?.ud_proveedor || "");
  const invoiceType = els["purchase-invoice-type"]?.value || "Factura_A";
  if (els["purchase-iva-rate"]) els["purchase-iva-rate"].textContent = invoiceType === "Factura_A" ? formatRateLabel(parseRate(link?.iva)) : "0%";
  updatePurchaseSummary();
}

function purchaseBackendSupplierInfo() {
  const supply = selectedPurchaseSupply();
  const link = selectedPurchaseSupplierLink();
  if (!supply || !link) return null;
  return {
    itemName: supply.nombre || "",
    providerName: selectedPurchaseProvider()?.nombre || "",
    recipeUnit: supply.ud_receta || "",
    countUnit: purchaseCountUnitForSupply(supply) || supply.ud_receta || "",
    recipeUnitFactor: parseQuantity(supply.cantidad_receta) || 1,
    supplierUnit: link.ud_proveedor || "",
    recipeQuantity: parseQuantity(link.cantidad_proveedor) || 1,
    price: parseMoney(link.precio),
    ivaRate: parseRate(link.iva),
    minimumOrder: parseMoney(selectedPurchaseProvider()?.pedido_minimo)
  };
}

async function openPurchaseEntryForItem(itemName, itemId = "") {
  switchView("purchase-entry");
  const initialized = await initializeViewOnce("purchase-entry", loadPurchaseBackendOptions);
  if (!initialized) return;
  const supply = findPurchaseSupply(itemName, itemId);
  if (supply && els["purchase-item-name"]) {
    els["purchase-item-name"].value = String(supply.id_insumo ?? "").trim();
  }
  syncSelectedPurchaseSupply();
  updatePurchaseProviderOptions();
  const snapshotItem = inventoryPurchaseSnapshotItem(supply?.nombre || itemName, itemId);
  const preferredProvider = snapshotItem?.provider || lastPurchaseProviderForItem(supply?.nombre || itemName);
  selectPreferredPurchaseSupplier(preferredProvider);
  const today = toIsoDate(new Date());
  els["purchase-order-date"].value = today;
  const currentItemName = rawInputValue(els["purchase-item-name"]) || itemName;
  const supplierInfo = purchaseBackendSupplierInfo() || supplyInfoForPurchase(currentItemName, rawInputValue(els["purchase-provider"]), lastPurchaseUnitForItem(currentItemName));
  const supplierUnit = supplierInfo?.supplierUnit || lastPurchaseUnitForItem(itemName);
  const stockUnit = supplierInfo?.countUnit || inventoryUnitForItem(currentItemName);
  setPurchaseUnitLabel(els["purchase-quantity-unit"], stockUnit);
  const missingStock = snapshotItem ? Math.max(0, snapshotItem.required - snapshotItem.stock) : NaN;
  const roundedOrder = roundedPurchaseOrder(currentItemName, missingStock, stockUnit, supplierUnit, rawInputValue(els["purchase-provider"]));
  const recipeQuantity = recipeUnitsFromCountUnits(currentItemName, Number(roundedOrder.stockQuantity));
  els["purchase-quantity"].value = integerPurchaseDisplay(roundedOrder.stockQuantity);
  if (els["purchase-recipe-quantity"]) els["purchase-recipe-quantity"].value = integerPurchaseDisplay(recipeQuantity);
  if (els["purchase-recipe-quantity"]) els["purchase-recipe-quantity"].dataset.requiredValue = integerPurchaseDisplay(recipeQuantity);
  setPurchaseUnitLabel(els["purchase-recipe-unit"], supplierInfo?.recipeUnit || stockUnit);
  if (els["purchase-supplier-quantity"]) els["purchase-supplier-quantity"].value = integerPurchaseDisplay(roundedOrder.supplierQuantity);
  setPurchaseUnitLabel(els["purchase-unit"], supplierUnit);
  if (els["purchase-invoice-type"]) els["purchase-invoice-type"].value = "Factura_A";
  updatePurchasePricing("quantity");
  updatePurchaseExpectedDate();
  updatePurchaseSummary();
  setPurchaseStatus("", "");
}

function findPurchaseSupply(itemName, itemId = "") {
  const id = String(itemId || "").trim();
  if (id && purchaseBackendOptions.suppliesById.has(id)) return purchaseBackendOptions.suppliesById.get(id);
  const key = normalizeCategory(itemName);
  return purchaseBackendOptions.supplies.find((row) => normalizeCategory(row.nombre) === key) || null;
}

function selectPreferredPurchaseSupplier(providerName) {
  const select = els["purchase-provider"];
  if (!select) return;
  const providerKey = normalizeCategory(providerName);
  const matchingOption = [...select.options].find((option) => {
    const providerId = option.dataset.providerId;
    const provider = purchaseBackendOptions.providersById.get(String(providerId || "").trim()) || {};
    return providerKey && providerNameMatches(provider.nombre, providerKey);
  });
  if (matchingOption) select.value = matchingOption.value;
  else if (!select.value && select.options.length > 1) select.selectedIndex = 1;
  syncSelectedPurchaseSupplier();
}

function updatePurchaseUnitsAfterSelection() {
  if (Number.isFinite(parseOptionalPurchaseNumber(els["purchase-supplier-quantity"]?.value))) {
    updatePurchaseUnitsFromField("supplier");
    return;
  }
  if (Number.isFinite(parseOptionalPurchaseNumber(els["purchase-quantity"]?.value))) {
    updatePurchaseUnitsFromField("count");
    return;
  }
  updatePurchasePricing("quantity");
  updatePurchaseSummary();
}

function updatePurchaseUnitsFromField(source) {
  const itemName = rawInputValue(els["purchase-item-name"]);
  const provider = rawInputValue(els["purchase-provider"]);
  const supplierUnit = purchaseUnitValue(els["purchase-unit"]) || lastPurchaseUnitForItem(itemName);
  const supplierInfo = supplyInfoForPurchase(itemName, provider, supplierUnit);
  const conversion = purchaseQuantityConversion(itemName, provider, supplierUnit, supplierInfo);
  setPurchaseUnitLabel(els["purchase-recipe-unit"], supplierInfo?.recipeUnit || inventoryUnitForItem(itemName));
  setPurchaseUnitLabel(els["purchase-unit"], supplierInfo?.supplierUnit || supplierUnit);

  const countInput = els["purchase-quantity"];
  const recipeInput = els["purchase-recipe-quantity"];
  const supplierInput = els["purchase-supplier-quantity"];
  const count = parseOptionalPurchaseNumber(countInput?.value);
  const recipe = parseOptionalPurchaseNumber(recipeInput?.value);
  const supplier = parseOptionalPurchaseNumber(supplierInput?.value);
  const normalized = normalizedPurchaseQuantities(source, { count, recipe, supplier }, conversion);
  if (!normalized) {
    updatePurchasePricing("quantity");
    updatePurchaseSummary();
    return;
  }

  recipeInput.value = integerPurchaseDisplay(normalized.recipe);
  recipeInput.dataset.requiredValue = integerPurchaseDisplay(normalized.recipe);
  countInput.value = integerPurchaseDisplay(normalized.count);
  supplierInput.value = integerPurchaseDisplay(normalized.supplier);
  updatePurchasePricing("quantity");
  updatePurchaseSummary();
}

function purchaseQuantityConversion(itemName, provider, supplierUnit, supplierInfo) {
  const recipePerCountUnit = itemInfoForInventoryItem(itemName)?.recipeUnitFactor || 1;
  const recipePerSupplierUnit = Number(supplierInfo?.recipeQuantity) || supplierUnitPackSize(supplierUnit) || 1;
  return {
    recipePerCountUnit,
    recipePerSupplierUnit,
    minimumSupplierUnits: Math.max(1, providerMinimumOrder(provider) || 0)
  };
}

function normalizedPurchaseQuantities(source, quantities, conversion) {
  const recipePerCountUnit = conversion.recipePerCountUnit || 1;
  const recipePerSupplierUnit = conversion.recipePerSupplierUnit || 1;
  let desiredRecipeQuantity = NaN;
  let desiredSupplierUnits = NaN;

  if (source === "recipe" && Number.isFinite(quantities.recipe)) {
    desiredRecipeQuantity = quantities.recipe;
  } else if (source === "count" && Number.isFinite(quantities.count)) {
    desiredRecipeQuantity = quantities.count * recipePerCountUnit;
  } else if (source === "supplier" && Number.isFinite(quantities.supplier)) {
    desiredSupplierUnits = quantities.supplier;
    desiredRecipeQuantity = desiredSupplierUnits * recipePerSupplierUnit;
  } else {
    return null;
  }

  if (!Number.isFinite(desiredRecipeQuantity) || desiredRecipeQuantity <= 0) {
    return { recipe: 0, count: 0, supplier: 0 };
  }

  /*
    La compra real solo puede hacerse por unidades completas de proveedor.
    Por eso una necesidad menor a un tanque, bolsa o caja se eleva a 1 unidad
    y se recalculan la unidad de receta y la unidad de conteo.
  */
  const supplierUnits = Math.max(
    Math.ceil(desiredRecipeQuantity / recipePerSupplierUnit),
    conversion.minimumSupplierUnits
  );
  const recipe = supplierUnits * recipePerSupplierUnit;
  return {
    recipe,
    count: recipe / recipePerCountUnit,
    supplier: supplierUnits
  };
}

function updatePurchasePricing(source = "quantity") {
  const subtotalInput = els["purchase-subtotal"];
  const ivaInput = els["purchase-iva"];
  const totalInput = els["purchase-total"];
  if (!subtotalInput || !ivaInput || !totalInput) return;

  const itemName = rawInputValue(els["purchase-item-name"]);
  const provider = rawInputValue(els["purchase-provider"]);
  const supplierUnit = purchaseUnitValue(els["purchase-unit"]) || lastPurchaseUnitForItem(itemName);
  const supplierInfo = supplyInfoForPurchase(itemName, provider, supplierUnit);
  const invoiceType = els["purchase-invoice-type"]?.value || "Factura_A";
  const ivaRate = invoiceType === "Factura_A" ? Number(supplierInfo?.ivaRate) || 0 : 0;

  if (source === "quantity") {
    const supplierQuantity = parseOptionalPurchaseNumber(els["purchase-supplier-quantity"]?.value);
    const unitPrice = parseMoneyInput(supplierInfo?.price, { allowNegative: false });
    subtotalInput.value = Number.isFinite(supplierQuantity) && unitPrice.ok && !unitPrice.empty
      ? formatMoneyInput(centsToMoney(
        ErpMoney.multiplyCents(centsToMoney(unitPrice.cents), supplierQuantity)
      ))
      : "";
  }

  const subtotal = parseMoneyInput(subtotalInput.value, { allowNegative: false });
  const normalizedSubtotalCents = subtotal.ok && !subtotal.empty ? subtotal.cents : 0;
  if (source !== "iva") {
    const ivaCents = invoiceType === "Factura_A"
      ? ErpMoney.multiplyCents(centsToMoney(normalizedSubtotalCents), ivaRate)
      : 0;
    ivaInput.value = formatMoneyInput(centsToMoney(ivaCents));
  }

  const iva = parseMoneyInput(ivaInput.value, { allowNegative: false });
  const ivaCents = iva.ok && !iva.empty ? iva.cents : 0;
  totalInput.value = formatMoneyInput(centsToMoney(normalizedSubtotalCents + ivaCents));
  els["purchase-iva-rate"].textContent = invoiceType === "Factura_A" ? formatRateLabel(ivaRate) : "0%";
  updatePurchaseSummary();
}

function updatePurchaseSummary() {
  const body = els["purchase-order-body"];
  if (!body) return;

  const rows = new Map(purchaseOrderRows()
    .filter((row) => purchaseOrderFieldSelected(row.key))
    .map((row) => [row.key, row]));
  const hasRows = rows.size > 0;
  body.innerHTML = hasRows
    ? [
      purchaseSummaryLines(rows, ["provider", "item", "orderDate", "delivery"]),
      purchaseSummarySection("Cantidades", rows, ["recipeQuantity", "buyQuantity", "presentation", "difference"]),
      purchaseSummarySection("Facturacion", rows, ["invoiceType", "subtotal", "iva", "total"])
    ].filter(Boolean).join("")
    : `<div class="purchase-order-empty">Selecciona datos para armar la orden.</div>`;
}

function purchaseSummaryLines(rows, keys) {
  return keys.map((key) => purchaseSummaryRow(rows.get(key))).filter(Boolean).join("");
}

function purchaseSummarySection(title, rows, keys) {
  const content = purchaseSummaryLines(rows, keys);
  if (!content) return "";
  return `
    <div class="purchase-summary-section">
      <h4>
        ${purchaseSummarySectionIcon(title)}
        <span>${escapeHtml(title)}</span>
      </h4>
      ${content}
    </div>
  `;
}

function purchaseSummarySectionIcon(title) {
  const icon = {
    Cantidades: "purchase-quantities",
    Facturacion: "purchase-invoice"
  }[title];
  return icon ? `<img src="assets/icons/${icon}.svg" alt="">` : "";
}

function purchaseSummaryRow(row) {
  if (!row) return "";
  return `
    <div class="purchase-order-line ${row.key === "difference" || row.key === "total" ? "is-highlight" : ""}">
      <span>${escapeHtml(row.label)}</span>
      <strong>
        ${escapeHtml(row.value || "-")}
        ${row.detail ? `<small>${escapeHtml(row.detail)}</small>` : ""}
      </strong>
    </div>
  `;
}

function purchaseSummaryData() {
  const rows = new Map(purchaseOrderRows()
    .filter((row) => purchaseOrderFieldSelected(row.key))
    .map((row) => [row.key, row]));
  return [
    { type: "line", row: rows.get("provider") },
    { type: "line", row: rows.get("item") },
    { type: "line", row: rows.get("orderDate") },
    { type: "line", row: rows.get("delivery") },
    { type: "section", title: "Cantidades" },
    { type: "line", row: rows.get("recipeQuantity") },
    { type: "line", row: rows.get("buyQuantity") },
    { type: "line", row: rows.get("presentation") },
    { type: "line", row: rows.get("difference"), highlight: true },
    { type: "section", title: "Facturacion" },
    { type: "line", row: rows.get("invoiceType") },
    { type: "line", row: rows.get("subtotal") },
    { type: "line", row: rows.get("iva") },
    { type: "line", row: rows.get("total"), highlight: true }
  ].filter((entry) => entry.type === "section" || entry.row);
}

function downloadPurchaseOrderPng() {
  const entries = purchaseSummaryData();
  if (!entries.length) return;

  const scale = 2;
  const width = 760;
  const padding = 44;
  const lineHeight = 54;
  const sectionHeight = 48;
  const headerHeight = 96;
  const footer = 36;
  const height = headerHeight + footer + entries.reduce((total, entry) => (
    total + (entry.type === "section" ? sectionHeight : lineHeight)
  ), 0);

  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d");
  context.scale(scale, scale);

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "#d7e1ea";
  context.lineWidth = 1;
  roundedCanvasRect(context, 12, 12, width - 24, height - 24, 14);
  context.stroke();

  context.fillStyle = "rgba(15, 118, 110, 0.09)";
  roundedCanvasRect(context, padding, 34, width - padding * 2, 62, 8);
  context.fill();
  context.fillStyle = "#005f5b";
  context.font = "800 26px Arial, sans-serif";
  context.fillText("Orden de Compra", padding + 20, 74);

  let y = headerHeight + 18;
  entries.forEach((entry) => {
    if (entry.type === "section") {
      context.fillStyle = "#006c68";
      context.font = "800 22px Arial, sans-serif";
      context.fillText(entry.title, padding, y + 28);
      y += sectionHeight;
      return;
    }

    const row = entry.row;
    if (entry.highlight) {
      context.fillStyle = "rgba(15, 118, 110, 0.075)";
      context.fillRect(padding - 10, y + 4, width - padding * 2 + 20, lineHeight - 8);
    }
    context.fillStyle = "#465463";
    context.font = "400 18px Arial, sans-serif";
    context.fillText(row.label, padding, y + 32);
    context.fillStyle = entry.highlight ? "#005f5b" : "#0d1f33";
    context.font = "800 18px Arial, sans-serif";
    context.textAlign = "right";
    context.fillText(row.value || "-", width - padding, y + 32);
    context.textAlign = "left";
    context.strokeStyle = "#e2e8f0";
    context.beginPath();
    context.moveTo(padding, y + lineHeight - 2);
    context.lineTo(width - padding, y + lineHeight - 2);
    context.stroke();
    y += lineHeight;
  });

  const link = document.createElement("a");
  const supplier = displayNameLabel(rawInputValue(els["purchase-provider"])) || "proveedor";
  const date = els["purchase-order-date"]?.value || toIsoDate(new Date());
  link.download = `orden-compra-${supplier.replace(/\s+/g, "-").toLowerCase()}-${date}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

function roundedCanvasRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function purchaseOrderRows() {
  return [
    {
      key: "provider",
      label: "Proveedor",
      value: displayNameLabel(rawInputValue(els["purchase-provider"]))
    },
    {
      key: "item",
      label: "Insumo",
      value: displayNameLabel(rawInputValue(els["purchase-item-name"]))
    },
    {
      key: "orderDate",
      label: "Fecha del pedido",
      value: formatDate(els["purchase-order-date"]?.value)
    },
    {
      key: "delivery",
      label: "Fecha de Entrega",
      value: formatDate(els["purchase-expected-date"]?.value)
    },
    {
      key: "recipeQuantity",
      label: "Unidad de receta",
      value: purchaseQuantityLabel(els["purchase-recipe-quantity"]?.value, purchaseUnitValue(els["purchase-recipe-unit"]))
    },
    {
      key: "buyQuantity",
      label: "Unidad de conteo",
      value: purchaseQuantityLabel(els["purchase-quantity"]?.value, purchaseUnitValue(els["purchase-quantity-unit"]))
    },
    {
      key: "difference",
      label: "Diferencia",
      value: purchaseQuantityDifferenceLabel()
    },
    {
      key: "presentation",
      label: "Unidad del proveedor",
      value: purchasePresentationLabel(els["purchase-supplier-quantity"]?.value, purchaseUnitValue(els["purchase-unit"]))
    },
    {
      key: "invoiceType",
      label: "Tipo de Factura",
      value: displayNameLabel(els["purchase-invoice-type"]?.value || "Factura_A"),
      group: "pricing"
    },
    {
      key: "subtotal",
      label: "Subtotal",
      value: purchaseOrderMoneyLabel(els["purchase-subtotal"]?.value),
      group: "pricing"
    },
    {
      key: "iva",
      label: `IVA (${els["purchase-iva-rate"]?.textContent || "0%"})`,
      value: purchaseOrderMoneyLabel(els["purchase-iva"]?.value),
      group: "pricing"
    },
    {
      key: "total",
      label: "Total",
      value: purchaseOrderMoneyLabel(els["purchase-total"]?.value),
      group: "pricing"
    }
  ];
}

function purchaseOrderFieldSelected(key) {
  return Boolean(document.querySelector(`[data-purchase-order-toggle="${key}"]`)?.checked);
}

function purchaseQuantityLabel(quantity, unit) {
  const number = parseOptionalPurchaseNumber(quantity);
  const quantityLabel = Number.isFinite(number) ? formatNumber(number) : "";
  const unitLabel = displayUnitLabel(unit || "");
  return [quantityLabel, unitLabel].filter(Boolean).join(" ");
}

function purchasePresentationLabel(quantity, unit) {
  const number = parseOptionalPurchaseNumber(quantity);
  const quantityLabel = Number.isFinite(number) ? formatNumber(number) : "";
  const unitLabel = displayUnitLabel(unit || "");
  if (unitLabel && quantityLabel) return `${unitLabel} (${quantityLabel})`;
  return unitLabel || quantityLabel;
}

function purchaseQuantityDifferenceLabel() {
  const required = parseOptionalPurchaseNumber(els["purchase-recipe-quantity"]?.value);
  const bought = parseOptionalPurchaseNumber(els["purchase-quantity"]?.value);
  if (!Number.isFinite(required) || !Number.isFinite(bought)) return "";
  const recipeUnit = purchaseUnitValue(els["purchase-recipe-unit"]);
  const countUnit = purchaseUnitValue(els["purchase-quantity-unit"]);
  const itemName = rawInputValue(els["purchase-item-name"]);
  const boughtRecipeUnits = recipeUnitsFromCountUnits(itemName, bought);
  const diff = boughtRecipeUnits - required;
  const unit = recipeUnit || countUnit;
  return `${formatNumber(diff)} ${displayUnitLabel(unit)}`.trim();
}

function purchaseMoneyLabel(value) {
  const number = parseOptionalPurchaseNumber(value);
  return Number.isFinite(number) ? formatMoney(number) : "";
}

function purchaseOrderMoneyLabel(value) {
  const parsed = parseMoneyInput(value, { allowEmpty: true });
  return parsed.ok && !parsed.empty ? formatMoney(parsed.amount) : "";
}

function formatRateLabel(rate) {
  return new Intl.NumberFormat("es-AR", {
    style: "percent",
    minimumFractionDigits: 0,
    maximumFractionDigits: 1
  }).format(rate || 0);
}

function parseOptionalPurchaseNumber(value) {
  const text = String(value ?? "").trim();
  if (!text) return NaN;
  return parseQuantity(text);
}

function setPurchaseUnitLabel(element, rawUnit) {
  if (!element) return;
  const value = String(rawUnit || "").trim();
  element.dataset.rawUnit = value;
  element.textContent = value ? displayUnitLabel(value) : "-";
}

function purchaseUnitValue(element) {
  return String(element?.dataset?.rawUnit || element?.textContent || "").trim();
}

function displayUnitLabel(value) {
  return String(value || "").replace(/_/g, " ");
}

function displayNameLabel(value) {
  return String(value || "").replace(/_/g, " ");
}

function setDisplayInputValue(input, rawValue) {
  if (!input) return;
  const value = String(rawValue || "").trim();
  input.dataset.rawValue = value;
  input.value = displayNameLabel(value);
}

function rawInputValue(input) {
  if (!input) return "";
  if (input.tagName === "SELECT") {
    const option = input.selectedOptions?.[0];
    const rawOptionValue = String(option?.dataset?.rawValue || "").trim();
    return rawOptionValue || String(option?.textContent || input.value || "").trim();
  }
  const displayed = String(input.value || "").trim();
  const raw = String(input.dataset.rawValue || "").trim();
  return raw && displayNameLabel(raw) === displayed ? raw : displayed;
}

function updatePurchaseExpectedDate() {
  if (!els["purchase-order-date"] || !els["purchase-expected-date"]) return;
  const orderDate = els["purchase-order-date"].value || toIsoDate(new Date());
  const leadDays = providerLeadDays(rawInputValue(els["purchase-provider"]));
  const date = dateFromIso(orderDate);
  date.setDate(date.getDate() + leadDays);
  els["purchase-expected-date"].value = toIsoDate(date);
}

function roundForInput(value) {
  if (!Number.isFinite(value)) return "";
  return String(Math.ceil(value * 100) / 100);
}

function integerPurchaseDisplay(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return String(Math.ceil(number));
}

function decimalPurchaseDisplay(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return formatMoneyInput(number);
}

async function submitPurchase(event) {
  event.preventDefault();
  const supplierLink = selectedPurchaseSupplierLink();
  const supply = selectedPurchaseSupply();
  const supplierQuantity = parseOptionalPurchaseNumber(els["purchase-supplier-quantity"]?.value);
  const orderDate = els["purchase-order-date"]?.value || "";
  const expectedDeliveryDate = els["purchase-expected-date"]?.value || "";

  if (!supply || !supplierLink || !orderDate || !expectedDeliveryDate || !Number.isFinite(supplierQuantity) || supplierQuantity <= 0) {
    setPurchaseStatus("Completa insumo, proveedor, fechas y cantidad proveedor.", "error");
    return;
  }

  const button = els["purchase-submit"];
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Enviando...";
  setPurchaseStatus("Guardando compra en backend...", "pending");

  try {
    const response = await fetch(`${API_BASE_URL}/api/purchases/full-entry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        supplier: String(supplierLink.id_proveedor ?? "").trim(),
        orderDate,
        expectedDeliveryDate,
        itemId: String(supplierLink.id_insumos_proveedores ?? "").trim(),
        itemName: supply.nombre || "",
        quantity: supplierQuantity
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);

    backendDataMap = null;
    dataEditorSchema = null;
    setPurchaseStatus(`Compra #${payload.purchaseId} guardada en backend.`, "success");
  } catch (error) {
    setPurchaseStatus(`No se pudo guardar la compra: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function parseSupplierUnitEntry(value) {
  const match = String(value || "").trim().match(/^(\d+(?:[.,]\d+)?)\s+(.+)$/);
  if (!match) return { quantity: "", unit: value };
  return {
    quantity: String(parseQuantity(match[1])),
    unit: match[2].trim()
  };
}

function setPurchaseStatus(message, status) {
  if (!els["purchase-status"]) return;
  els["purchase-status"].textContent = message;
  els["purchase-status"].dataset.status = status;
}

async function loadPurchaseInventorySuggestions() {
  const list = els["purchase-inventory-suggestions-list"];
  const status = els["purchase-inventory-suggestions-status"];
  if (!list || !status) return;

  status.textContent = "Cargando recomendacion del ultimo inventario...";
  try {
    const payload = await requestBackendApi("/api/inventory/purchase-snapshot");
    inventoryPurchaseSnapshot = payload?.snapshot && !Array.isArray(payload.snapshot)
      ? payload.snapshot
      : {
          inventoryDate: "",
          inventoryIds: [],
          state: "no_inventory",
          source: "reconstructed",
          items: [],
          unavailableItems: []
        };
    renderPurchaseInventorySuggestions(inventoryPurchaseSnapshot);
    updateInventoryPurchaseAlerts();
  } catch (error) {
    els["purchase-inventory-suggestions-count"].textContent = "!";
    status.textContent = `No se pudo cargar la recomendacion: ${error.message || "error desconocido"}.`;
    list.innerHTML = "";
    throw error;
  }
}

function renderPurchaseInventorySuggestions(snapshot) {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const count = els["purchase-inventory-suggestions-count"];
  const status = els["purchase-inventory-suggestions-status"];
  const list = els["purchase-inventory-suggestions-list"];
  if (!count || !status || !list) return;

  syncInventoryProductionRateInput(snapshot);
  const state = inventoryPurchaseSnapshotState(snapshot);
  count.textContent = state === "insufficient_dependencies" ? "!" : formatNumber(items.length);
  status.textContent = `${inventoryPurchaseSnapshotStatusMessage(snapshot)} El selector de insumos permanece libre.`;
  const itemRows = items.length
    ? items.map((item) => `
        <div class="purchase-inventory-suggestion-row">
          <strong>${escapeHtml(displayNameLabel(item.itemName || "Insumo sin nombre"))}</strong>
          <span>${escapeHtml(purchaseInventoryQuantityLabel(item.stock, item.unit))}</span>
          <span>${escapeHtml(purchaseInventoryDaysLabel(item.daysRemaining))}</span>
        </div>
      `).join("")
    : "";
  const stateMessage = state === "insufficient_dependencies" || !items.length
    ? `<p class="purchase-inventory-suggestions-empty">${escapeHtml(inventoryPurchaseSnapshotEmptyMessage(snapshot))}</p>`
    : "";
  list.innerHTML = `${itemRows}${stateMessage}`;
}

function inventoryPurchaseSnapshotState(snapshot) {
  if (snapshot?.state) return snapshot.state;
  if (!snapshot?.inventoryDate) return "no_inventory";
  return Array.isArray(snapshot.items) && snapshot.items.length
    ? "valid_with_alerts"
    : "valid_no_alerts";
}

function inventoryPurchaseSnapshotStatusMessage(snapshot) {
  const state = inventoryPurchaseSnapshotState(snapshot);
  if (state === "no_inventory") return "No existe un inventario persistido para evaluar.";
  const dateLabel = snapshot?.inventoryDate ? formatDate(snapshot.inventoryDate) : "fecha desconocida";
  if (state === "insufficient_dependencies") {
    return `El inventario del ${dateLabel} existe, pero faltan dependencias para completar la evaluacion.`;
  }
  return `Inventario del ${dateLabel} evaluado correctamente.`;
}

function inventoryPurchaseSnapshotEmptyMessage(snapshot) {
  const state = inventoryPurchaseSnapshotState(snapshot);
  if (state === "no_inventory") return "No existe un inventario persistido para evaluar.";
  if (state === "insufficient_dependencies") {
    const names = (snapshot?.unavailableItems || [])
      .map((item) => displayNameLabel(item.itemName || "Insumo sin nombre"))
      .filter(Boolean);
    return names.length
      ? `No se pudo completar la evaluacion de: ${names.join(", ")}.`
      : "No se pudo completar la evaluacion porque faltan datos del inventario o sus dependencias.";
  }
  return "El ultimo inventario fue evaluado y no requiere compras.";
}

function purchaseInventoryQuantityLabel(stock, unit) {
  const quantity = Number(stock);
  const label = purchaseInventoryMeasurementLabel(quantity);
  return [label, displayUnitLabel(unit)].filter(Boolean).join(" ");
}

function purchaseInventoryDaysLabel(daysRemaining) {
  const days = Number(daysRemaining);
  if (!Number.isFinite(days)) return "-";
  const roundedDays = Math.round(days);
  return `${formatNumber(roundedDays)} ${roundedDays === 1 ? "d\u00eda" : "d\u00edas"} de producci\u00f3n`;
}

function purchaseInventoryMeasurementLabel(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat("es-AR", { maximumSignificantDigits: 10 }).format(value)
    : "-";
}

function syncInventoryProductionRateInput(snapshot) {
  const input = els["inventory-production-rate"];
  if (!input) return;
  input.dataset.minimum = String(snapshot?.minBarsPerDay ?? "");
  input.dataset.maximum = String(snapshot?.maxBarsPerDay ?? "");
  if (globalThis.document?.activeElement === input) return;
  const barsPerDay = Number(snapshot?.barsPerDay);
  input.value = Number.isInteger(barsPerDay) ? formatNumber(barsPerDay) : "";
  input.setAttribute("aria-invalid", "false");
}

function parseInventoryProductionRate(value) {
  const input = els["inventory-production-rate"];
  const minimum = Number(input?.dataset?.minimum);
  const maximum = Number(input?.dataset?.maximum);
  if (!Number.isInteger(minimum) || !Number.isInteger(maximum)) return NaN;
  const compact = String(value || "").trim().replace(/\s+/g, "");
  if (!compact || (!/^\d+$/.test(compact) && !/^\d{1,3}(?:\.\d{3})+$/.test(compact))) {
    return NaN;
  }
  const barsPerDay = Number(compact.replace(/\./g, ""));
  return Number.isInteger(barsPerDay) && barsPerDay >= minimum && barsPerDay <= maximum
    ? barsPerDay
    : NaN;
}

async function submitInventoryProductionRate(event) {
  event?.preventDefault();
  const input = els["inventory-production-rate"];
  const button = els["inventory-production-rate-submit"];
  const status = els["inventory-production-rate-status"];
  if (!input || !button || !status) return;

  const barsPerDay = parseInventoryProductionRate(input.value);
  if (!Number.isFinite(barsPerDay)) {
    input.setAttribute("aria-invalid", "true");
    status.dataset.status = "error";
    status.textContent = `Ingresa un entero entre ${formatNumber(Number(input.dataset.minimum))} y ${formatNumber(Number(input.dataset.maximum))}.`;
    return;
  }

  const previousSnapshot = inventoryPurchaseSnapshot;
  input.setAttribute("aria-invalid", "false");
  button.disabled = true;
  status.dataset.status = "";
  status.textContent = "Guardando y recalculando...";
  try {
    const payload = await requestBackendApi("/api/inventory/purchase-snapshot/production-rate", {
      method: "POST",
      body: JSON.stringify({ barsPerDay })
    });
    inventoryPurchaseSnapshot = payload.snapshot;
    dashboardWidgetData.inventoryPurchaseSnapshot = payload.snapshot;
    renderPurchaseInventorySuggestions(payload.snapshot);
    updateInventoryPurchaseAlerts();
    renderDashboardInventoryPurchasesWidget();
    input.value = formatNumber(payload.snapshot.barsPerDay);
    status.dataset.status = "success";
    status.textContent = "Producci\u00f3n diaria actualizada.";
  } catch (error) {
    inventoryPurchaseSnapshot = previousSnapshot;
    input.value = Number.isInteger(Number(previousSnapshot?.barsPerDay))
      ? formatNumber(Number(previousSnapshot.barsPerDay))
      : "";
    input.setAttribute("aria-invalid", "true");
    status.dataset.status = "error";
    status.textContent = error.message || "No se pudo guardar. Se conserva el ultimo valor valido.";
  } finally {
    button.disabled = false;
  }
}

async function loadPurchaseBackendOptions({ force = false } = {}) {
  const inventorySuggestionsPromise = loadPurchaseInventorySuggestions();
  if (purchaseBackendOptions.loaded && !force) {
    await inventorySuggestionsPromise;
    updatePurchaseItemOptions();
    updatePurchaseProviderOptions();
    return purchaseBackendOptions;
  }

  const [, supplies, supplierLinks, providers, items] = await Promise.all([
    inventorySuggestionsPromise,
    backendTableRowsForEntry("insumos"),
    backendTableRowsForEntry("insumos_proveedores"),
    backendTableRowsForEntry("proveedores"),
    backendTableRowsForEntry("items")
  ]);

  purchaseBackendOptions = {
    loaded: true,
    supplies,
    supplierLinks,
    providers,
    items,
    suppliesById: rowsByKey(supplies, "id_insumo"),
    supplierLinksById: rowsByKey(supplierLinks, "id_insumos_proveedores"),
    providersById: rowsByKey(providers, "id_proveedor"),
    itemsBySupplyId: rowsByKey(
      items.filter((row) => normalizeCategory(row.origen_tipo) === "insumo"),
      "id_origen"
    )
  };
  updatePurchaseItemOptions();
  updatePurchaseProviderOptions();
  return purchaseBackendOptions;
}

function updatePurchaseProviderOptions() {
  const select = els["purchase-provider"];
  if (!select) return;

  const currentValue = select.value;
  const supplyId = selectedPurchaseSupplyId();
  const supplierLinks = purchaseBackendOptions.supplierLinks
    .filter((row) => String(row.id_insumo ?? "").trim() === supplyId)
    .sort((a, b) => {
      const providerA = purchaseBackendOptions.providersById.get(String(a.id_proveedor ?? "").trim()) || {};
      const providerB = purchaseBackendOptions.providersById.get(String(b.id_proveedor ?? "").trim()) || {};
      return displayNameLabel(providerA.nombre || "").localeCompare(displayNameLabel(providerB.nombre || ""));
    });

  select.innerHTML = `<option value="">Elegir proveedor</option>` + supplierLinks.map((link) => {
    const provider = purchaseBackendOptions.providersById.get(String(link.id_proveedor ?? "").trim()) || {};
    const providerName = provider.nombre || `Proveedor ${link.id_proveedor || ""}`;
    const unitLabel = displayUnitLabel(link.ud_proveedor || "");
    const label = unitLabel ? `${displayNameLabel(providerName)} - ${unitLabel}` : displayNameLabel(providerName);
    return `
      <option
        value="${escapeHtml(String(link.id_insumos_proveedores ?? "").trim())}"
        data-provider-id="${escapeHtml(String(link.id_proveedor ?? "").trim())}"
        data-raw-value="${escapeHtml(providerName)}"
      >${escapeHtml(label)}</option>
    `;
  }).join("");

  if (supplierLinks.some((row) => String(row.id_insumos_proveedores ?? "").trim() === currentValue)) {
    select.value = currentValue;
  } else if (supplierLinks.length === 1) {
    select.value = String(supplierLinks[0].id_insumos_proveedores ?? "").trim();
  }
  syncSelectedPurchaseSupplier();
}

