async function loadOperationalEntryOptions() {
  const optionRequests = [
    ["empleados", "reception-employee-options", "id_empleado", ["nombre_empleado"]]
  ];

  await Promise.all(optionRequests.map(async ([tableName, datalistId, valueColumn, labelColumns]) => {
    const rows = await backendTableRowsForEntry(tableName);
    renderEntryDatalistOptions(datalistId, rows, valueColumn, labelColumns);
  }));
  await Promise.all([
    loadReceptionPurchaseOptions(),
    loadIssuedCheckPendingPayments()
  ]);
}

async function loadReceptionPurchaseOptions() {
  const select = els["reception-purchase-id"];
  if (!select) return;

  const currentValue = select.value;
  const [purchases, receptions, purchaseDetails, suppliers, supplies, providers, items, labels] = await Promise.all([
    backendTableRowsForEntry("compras"),
    backendTableRowsForEntry("recepciones"),
    backendTableRowsForEntry("detalle_compras"),
    backendTableRowsForEntry("insumos_proveedores"),
    backendTableRowsForEntry("insumos"),
    backendTableRowsForEntry("proveedores"),
    backendTableRowsForEntry("items"),
    backendTableRowsForEntry("etiquetas")
  ]);

  const receivedPurchaseIds = new Set(receptions.map((row) => String(row.id_compra ?? "").trim()).filter(Boolean));
  const detailsByPurchaseId = groupRowsByKey(purchaseDetails, "id_compra");
  const suppliersById = rowsByKey(suppliers, "id_insumos_proveedores");
  const suppliesById = rowsByKey(supplies, "id_insumo");
  const providersById = rowsByKey(providers, "id_proveedor");
  const itemsBySupplyId = rowsByKey(
    items.filter((row) => normalizeCategory(row.origen_tipo) === "insumo"),
    "id_origen"
  );
  const labelsByName = rowsByNormalizedValue(labels, "etiqueta");
  const pendingPurchases = purchases.filter((purchase) => {
    const purchaseId = String(purchase.id_compra ?? "").trim();
    return purchaseId && !receivedPurchaseIds.has(purchaseId);
  }).sort((a, b) => {
    const dateA = String(a.fecha_entrega_prevista || "9999-12-31");
    const dateB = String(b.fecha_entrega_prevista || "9999-12-31");
    return dateA.localeCompare(dateB);
  });

  receptionPendingPurchases = new Map();
  selectedReceptionPurchaseIds = new Set();

  select.innerHTML = `<option value="">Elegir compra pendiente</option>` + pendingPurchases.map((purchase) => {
    const purchaseId = String(purchase.id_compra ?? "").trim();
    const firstDetail = (detailsByPurchaseId.get(purchaseId) || [])[0] || {};
    const supplier = suppliersById.get(String(firstDetail.id_insumos_proveedores ?? "").trim()) || {};
    const supply = suppliesById.get(String(supplier.id_insumo ?? "").trim()) || {};
    const provider = providersById.get(String(purchase.id_proveedor ?? "").trim()) || {};
    const option = buildReceptionPendingOption(purchase, firstDetail, supplier, supply, provider, itemsBySupplyId, labelsByName);
    if (option) receptionPendingPurchases.set(purchaseId, option);
    const labelParts = [
      `#${purchaseId}`,
      displayNameLabel(provider.nombre || `Proveedor ${purchase.id_proveedor || "-"}`),
      displayNameLabel(supply.nombre || "Sin insumo"),
      purchase.fecha_entrega_prevista ? `Entrega ${formatDate(purchase.fecha_entrega_prevista)}` : ""
    ].filter(Boolean);
    return `<option value="${escapeHtml(purchaseId)}">${escapeHtml(labelParts.join(" - "))}</option>`;
  }).join("");

  if (pendingPurchases.some((purchase) => String(purchase.id_compra ?? "").trim() === currentValue)) {
    select.value = currentValue;
  }
  renderReceptionPendingPurchases();
  fillReceptionFromSelectedPurchase();
}

function buildReceptionPendingOption(purchase, detail, supplier, supply, provider, itemsBySupplyId, labelsByName) {
  const purchaseId = String(purchase.id_compra ?? "").trim();
  if (!purchaseId || !String(detail.id_detalle_compra ?? "").trim()) return null;
  const supplierQuantity = parseQuantity(detail.cantidad);
  const recipePerSupplierUnit = parseQuantity(supplier.cantidad_proveedor) || 1;
  const recipePerCountUnit = parseQuantity(supply.cantidad_receta) || 1;
  const recipeQuantity = supplierQuantity * recipePerSupplierUnit;
  const countQuantity = recipePerCountUnit ? recipeQuantity / recipePerCountUnit : recipeQuantity;
  const item = itemsBySupplyId.get(String(supply.id_insumo ?? "").trim()) || {};
  return {
    purchase,
    detail,
    supplier,
    supply,
    provider,
    purchaseId,
    supplierQuantity,
    recipeQuantity,
    countQuantity,
    recipePerSupplierUnit,
    recipePerCountUnit,
    unitPrice: parseMoney(supplier.precio),
    ivaRate: parseRate(supplier.iva),
    expenseLabelId: String(labelsByName.get(normalizeCategory("Mercaderia"))?.id_etiqueta ?? "").trim(),
    supplierUnit: supplier.ud_proveedor || "",
    recipeUnit: supply.ud_receta || "",
    countUnit: item.ud_conteo || supply.ud_conteo || supply.ud_receta || ""
  };
}

function renderReceptionPendingPurchases() {
  const body = els["reception-pending-body"];
  if (!body) return;
  const options = [...receptionPendingPurchases.values()];
  if (!options.length) {
    body.innerHTML = `<tr><td class="empty" colspan="5">No hay compras pendientes de recibir.</td></tr>`;
    return;
  }
  const selectedId = String(els["reception-purchase-id"]?.value || "").trim();
  body.innerHTML = options.map((option) => `
    <tr data-reception-purchase-id="${escapeHtml(option.purchaseId)}" class="${selectedReceptionPurchaseIds.has(option.purchaseId) || option.purchaseId === selectedId ? "is-selected" : ""}">
      <td><input type="checkbox" data-reception-purchase-select="${escapeHtml(option.purchaseId)}" ${selectedReceptionPurchaseIds.has(option.purchaseId) ? "checked" : ""} aria-label="Seleccionar compra ${escapeHtml(option.purchaseId)}"> ${formatDate(option.purchase.fecha_entrega_prevista)}</td>
      <td>${escapeHtml(displayNameLabel(option.supply.nombre || "Sin insumo"))}</td>
      <td>${escapeHtml(displayNameLabel(option.provider.nombre || `Proveedor ${option.purchase.id_proveedor || "-"}`))}</td>
      <td class="num">${escapeHtml(purchasePresentationLabel(option.supplierQuantity, option.supplierUnit))}</td>
      <td class="num">${escapeHtml(purchaseQuantityLabel(option.countQuantity, option.countUnit))}</td>
    </tr>
  `).join("");
}

function selectReceptionPendingPurchase(purchaseId) {
  if (!els["reception-purchase-id"]) return;
  const id = String(purchaseId || "").trim();
  selectedReceptionPurchaseIds = id ? new Set([id]) : new Set();
  els["reception-purchase-id"].value = id;
  renderReceptionPendingPurchases();
  fillReceptionFromSelectedPurchase();
}

function toggleReceptionPurchaseSelection(purchaseId, checked) {
  const id = String(purchaseId || "").trim();
  if (!id) return;
  if (checked) {
    if (selectedReceptionPurchaseIds.size >= 2 && !selectedReceptionPurchaseIds.has(id)) {
      setEntryStatus("reception-status", "Podes asociar como maximo dos recepciones a una misma factura.", "error");
      renderReceptionPendingPurchases();
      return;
    }
    selectedReceptionPurchaseIds.add(id);
  } else {
    selectedReceptionPurchaseIds.delete(id);
  }
  const firstId = [...selectedReceptionPurchaseIds][0] || "";
  if (els["reception-purchase-id"]) els["reception-purchase-id"].value = firstId;
  renderReceptionPendingPurchases();
  fillReceptionFromSelectedPurchase();
}
