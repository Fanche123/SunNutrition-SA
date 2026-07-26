function setCommercialStatus(id, message, status) {
  const element = els[id];
  if (!element) return;
  element.textContent = message;
  element.dataset.status = status || "";
}

function setCommercialButtonLoading(button, loading, text) {
  if (!button) return;
  if (loading) {
    button.dataset.originalText = button.textContent;
    button.textContent = text || "Procesando...";
    button.disabled = true;
    return;
  }
  button.textContent = button.dataset.originalText || button.textContent;
  button.disabled = false;
}

function renderEntryDatalistOptions(datalistId, rows, valueColumn, labelColumns) {
  const datalist = els[datalistId];
  if (!datalist) return;
  datalist.innerHTML = rows
    .map((row) => {
      const value = String(row[valueColumn] ?? "").trim();
      if (!value) return "";
      const label = labelColumns
        .map((column) => String(row[column] ?? "").trim())
        .filter(Boolean)
        .join(" - ");
      return `<option value="${escapeHtml(value)}"${label ? ` label="${escapeHtml(label)}"` : ""}></option>`;
    })
    .join("");
}

function entryNumberValue(inputId) {
  const value = Number(String(els[inputId]?.value || "").replace(",", "."));
  return Number.isFinite(value) ? value : 0;
}

function entryMoneyState(inputId, options = {}) {
  const input = els[inputId];
  return parseMoneyInput(input?.value ?? "", {
    allowEmpty: options.allowEmpty !== false,
    allowNegative: options.allowNegative !== false
  });
}

function entryMoneyCents(inputId, options = {}) {
  const parsed = entryMoneyState(inputId, options);
  return parsed.ok && !parsed.empty ? parsed.cents : 0;
}

function entryMoneyValue(inputId, options = {}) {
  return centsToMoney(entryMoneyCents(inputId, options));
}

function roundToDecimals(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function setEntryStatus(elementId, message, status) {
  const element = els[elementId];
  if (!element) return;
  element.textContent = message || "";
  element.dataset.status = status || "";
}

function rowsByKey(rows, key) {
  return (rows || []).reduce((map, row) => {
    const rawId = String(row[key] ?? "").trim();
    if (!rawId) return map;

    map.set(rawId, row);

    // Los datos del backend pueden llegar desde CSV/SQLite como "32", 32 o 32.0.
    // Guardamos una clave numÄ‚â€žĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â©rica estable para que los cruces entre tablas no fallen
    // por diferencias de formato en IDs importados.
    const normalizedId = normalizedLookupId(rawId);
    if (normalizedId && !map.has(normalizedId)) map.set(normalizedId, row);

    return map;
  }, new Map());
}

function normalizedLookupId(value) {
  const text = String(value ?? "").trim();
  if (!text || !/^-?\d+(?:\.0+)?$/.test(text)) return "";
  return String(Number(text));
}

function comparableLookupId(value) {
  return normalizedLookupId(value) || String(value ?? "").trim();
}

function rowsByNormalizedValue(rows, key) {
  return new Map((rows || [])
    .map((row) => [normalizeCategory(row[key]), row])
    .filter(([value]) => value));
}

function groupRowsByKey(rows, key) {
  return (rows || []).reduce((groups, row) => {
    const id = String(row[key] ?? "").trim();
    if (!id) return groups;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
    return groups;
  }, new Map());
}

function groupRowsByComparableKey(rows, key) {
  return (rows || []).reduce((groups, row) => {
    const id = comparableLookupId(row[key]);
    if (!id) return groups;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
    return groups;
  }, new Map());
}

async function fillReceptionFromSelectedPurchase() {
  const purchaseId = String(els["reception-purchase-id"]?.value || "").trim();
  clearReceptionDetailFields();
  if (!purchaseId) return;

  try {
    const option = receptionPendingPurchases.get(purchaseId);
    if (!option) {
      setEntryStatus("reception-status", "No encontre el detalle de esa compra.", "error");
      return;
    }

    if (els["reception-date"] && option.purchase.fecha_entrega_prevista) els["reception-date"].value = option.purchase.fecha_entrega_prevista;
    if (els["reception-provider"]) els["reception-provider"].value = displayNameLabel(option.provider.nombre || `Proveedor ${option.purchase.id_proveedor || ""}`);
    if (els["reception-supply-id"]) els["reception-supply-id"].value = option.supply.id_insumo || "";
    if (els["reception-supply-name"]) els["reception-supply-name"].value = displayNameLabel(option.supply.nombre || "");
    setReceptionUnitLabel(els["reception-supplier-unit"], option.supplierUnit);
    setReceptionUnitLabel(els["reception-count-unit"], option.countUnit);
    setReceptionUnitLabel(els["reception-recipe-unit"], option.recipeUnit);
    setReceptionQuantityInputs(option);
    prepareReceptionExpenseReferenceDisplay(option);
    if (els["reception-without-file"]?.checked) autofillReceptionExpenseFromPurchase();
    renderReceptionPendingPurchases();
    setEntryStatus("reception-status", "Compra pendiente cargada. Revisa cantidad recibida y adjunta remito o factura si corresponde.", "pending");
  } catch (error) {
    setEntryStatus("reception-status", error.message, "error");
  }
}

function fillSelectOptions(select, rows, valueColumn, labelColumn, emptyLabel) {
  if (!select) return;
  const current = select.value;
  const options = rows.map((row) => {
    const value = String(row[valueColumn] ?? "").trim();
    const label = displayNameLabel(row[labelColumn] || row.nombre || value);
    return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
  }).join("");
  select.innerHTML = emptyLabel ? `<option value="">${escapeHtml(emptyLabel)}</option>${options}` : options;
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function mapRowsById(rows, idColumn) {
  return new Map(rows.map((row) => [backendId(row[idColumn]), row]));
}

function groupRowsById(rows, idColumn) {
  return rows.reduce((groups, row) => {
    const id = backendId(row[idColumn]);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
    return groups;
  }, new Map());
}

function backendId(value) {
  return String(value ?? "").trim();
}


function dataMapModuleLabel(module) {
  return {
    maestros: "Tablas maestras",
    compras: "Compras / Egresos / Pagos",
    inventario: "Inventario / Produccion",
    ventas: "Ventas / Cobros",
    sueldos: "Sueldos"
  }[module] || module;
}

function groupBy(rows, key) {
  return rows.reduce((groups, row) => {
    const groupKey = row[key] || "otros";
    groups[groupKey] = groups[groupKey] || [];
    groups[groupKey].push(row);
    return groups;
  }, {});
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function normalizeColumnName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

