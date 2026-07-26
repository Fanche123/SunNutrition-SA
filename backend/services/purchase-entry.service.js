function createPurchaseEntryService(dependencies) {
  const { backendId, backendNextNumericId, backendRowsById, cleanBackendInput, ensureBackendTable, isIsoDate, loadCache, normalizeLookupText, readJsonBody, saveBackendCache, sendJson } = dependencies;

async function handlePurchaseFullEntry(request, response) {
  try {
    const body = await readJsonBody(request);
    const purchase = normalizePurchasePayload(body);
    const quantity = Number(purchase.quantity);

    if (!purchase.supplier) {
      sendJson(response, 400, { ok: false, error: "Falta el proveedor." });
      return;
    }

    if (!isIsoDate(purchase.orderDate) || !isIsoDate(purchase.expectedDeliveryDate)) {
      sendJson(response, 400, { ok: false, error: "Faltan fechas validas para la compra." });
      return;
    }

    if (!purchase.itemName) {
      sendJson(response, 400, { ok: false, error: "Falta el insumo." });
      return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      sendJson(response, 400, { ok: false, error: "La cantidad de la compra debe ser mayor a cero." });
      return;
    }

    const cache = loadCache();
    cache.tables = cache.tables || {};
    ensureBackendTable(cache.tables, "compras");
    ensureBackendTable(cache.tables, "detalle_compras");
    const providerId = resolveBackendProviderId(cache.tables, purchase.supplier);
    const supplierItemId = resolveBackendSupplierItemId(cache.tables, purchase.itemId, purchase.itemName, providerId);
    if (!providerId) {
      sendJson(response, 400, { ok: false, error: "El proveedor no existe en las tablas del backend." });
      return;
    }
    if (!supplierItemId) {
      sendJson(response, 400, { ok: false, error: "El insumo del proveedor no existe en las tablas del backend." });
      return;
    }

    const purchaseId = backendNextNumericId(cache.tables.compras.rows, "id_compra");
    const detailId = backendNextNumericId(cache.tables.detalle_compras.rows, "id_detalle_compra");
    cache.tables.compras.rows.push({
      id_compra: purchaseId,
      id_proveedor: providerId,
      fecha_pedido: purchase.orderDate,
      fecha_entrega_prevista: purchase.expectedDeliveryDate
    });
    cache.tables.detalle_compras.rows.push({
      id_detalle_compra: detailId,
      id_compra: purchaseId,
      id_insumos_proveedores: supplierItemId,
      cantidad: quantity
    });
    finalizeBackendTable(cache.tables.compras);
    finalizeBackendTable(cache.tables.detalle_compras);
    saveBackendCache(cache);

    sendJson(response, 200, {
      ok: true,
      purchaseId,
      detailId,
      backendTables: ["compras", "detalle_compras"]
    });
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message || "No se pudo guardar la compra." });
  }
}

function resolveBackendProviderId(tables, value) {
  const normalized = normalizeLookupText(value);
  const match = (tables.proveedores?.rows || []).find((row) => (
    backendId(row.id_proveedor) === backendId(value)
    || normalizeLookupText(row.nombre) === normalized
  ));
  return match ? backendId(match.id_proveedor) : "";
}

function resolveBackendSupplierItemId(tables, itemId, itemName, providerId) {
  const supplierItems = tables.insumos_proveedores?.rows || [];
  const direct = supplierItems.find((row) => backendId(row.id_insumos_proveedores) === backendId(itemId));
  if (direct && (!providerId || backendId(direct.id_proveedor) === backendId(providerId))) {
    return backendId(direct.id_insumos_proveedores);
  }
  const supplies = backendRowsById(tables.insumos?.rows, "id_insumo");
  const normalizedName = normalizeLookupText(itemName);
  const match = supplierItems.find((row) => {
    if (providerId && backendId(row.id_proveedor) !== backendId(providerId)) return false;
    if (backendId(row.id_insumo) === backendId(itemId)) return true;
    return normalizeLookupText(supplies.get(backendId(row.id_insumo))?.nombre) === normalizedName;
  });
  return match ? backendId(match.id_insumos_proveedores) : "";
}

function finalizeBackendTable(table) {
  table.rowCount = table.rows.length;
  table.updatedAt = new Date().toISOString();
}

function normalizePurchasePayload(body) {
  return {
    supplier: cleanBackendInput(body.supplier),
    orderDate: cleanBackendInput(body.orderDate),
    expectedDeliveryDate: cleanBackendInput(body.expectedDeliveryDate),
    itemId: cleanBackendInput(body.itemId),
    itemName: cleanBackendInput(body.itemName),
    quantity: cleanBackendInput(body.quantity),
    supplierUnit: cleanBackendInput(body.supplierUnit),
    countQuantity: cleanBackendInput(body.countQuantity),
    countUnit: cleanBackendInput(body.countUnit),
    recipeQuantity: cleanBackendInput(body.recipeQuantity),
    recipeUnit: cleanBackendInput(body.recipeUnit),
    invoiceType: cleanBackendInput(body.invoiceType),
    subtotal: cleanBackendInput(body.subtotal),
    ivaRate: cleanBackendInput(body.ivaRate),
    iva: cleanBackendInput(body.iva),
    total: cleanBackendInput(body.total)
  };
}

  return { handlePurchaseFullEntry };
}

module.exports = { createPurchaseEntryService };
