function renderOrderEntry() {
  fillSelectOptions(els["order-client"], commercialEntryData.clientes, "id_cliente", "nombre_cliente", "Cliente");
  fillSelectOptions(els["order-product"], commercialEntryData.productos, "id_producto", "nombre_producto", "Producto");
  if (els["order-date"] && !els["order-date"].value) els["order-date"].value = toIsoDate(new Date());
  if (els["order-delivery-date"] && !els["order-delivery-date"].value) els["order-delivery-date"].value = toIsoDate(new Date());
  renderOrderDraftDetails();
}

function renderSalesEntry() {
  const allPendingRows = pendingSalesRows();
  fillPendingSalesClientOptions(allPendingRows);
  const selectedClientId = els["sales-client-filter"]?.value || "";
  const rows = (selectedClientId ? pendingSalesRows(selectedClientId) : [...allPendingRows])
    .sort((a, b) => selectedClientId
      ? String(a.sale.fecha_factura || "").localeCompare(String(b.sale.fecha_factura || ""))
      : clientName(a.sale.id_cliente).localeCompare(clientName(b.sale.id_cliente)) || String(a.sale.fecha_factura || "").localeCompare(String(b.sale.fecha_factura || "")));
  const body = els["sales-pending-body"];
  const total = centsToMoney(rows.reduce((acc, row) => acc + moneyToCents(row.balance), 0));

  if (els["sales-client-debt-total"]) els["sales-client-debt-total"].textContent = formatMoney(total);
  if (els["sales-client-debt-count"]) els["sales-client-debt-count"].textContent = String(rows.length);
  if (!body) return;

  body.innerHTML = rows.length ? rows.map((row) => `
    <tr>
      <td>${escapeHtml(clientName(row.sale.id_cliente))}</td>
      <td>${escapeHtml(row.sale.nro_factura || row.sale.id_venta || "-")}</td>
      <td>${formatDate(row.sale.fecha_factura)}</td>
      <td class="num">${formatMoney(row.total)}</td>
      <td class="num muted-cell">${formatMoney(row.paid)}</td>
      <td class="num debt-balance">${formatMoney(row.balance)}</td>
    </tr>
  `).join("") : `<tr><td class="empty" colspan="6">No hay ventas pendientes.</td></tr>`;
}

function fillPendingSalesClientOptions(pendingRows) {
  const select = els["sales-client-filter"];
  if (!select) return;
  const current = select.value;
  const clientIdsWithDebt = new Set(pendingRows.map((row) => backendId(row.sale.id_cliente)));
  const debtClients = commercialEntryData.clientes
    .filter((client) => clientIdsWithDebt.has(backendId(client.id_cliente)))
    .sort((a, b) => displayNameLabel(a.nombre_cliente || a.nombre).localeCompare(displayNameLabel(b.nombre_cliente || b.nombre)));
  const options = debtClients.map((client) => {
    const value = backendId(client.id_cliente);
    return `<option value="${escapeHtml(value)}">${escapeHtml(displayNameLabel(client.nombre_cliente || client.nombre || value))}</option>`;
  }).join("");
  select.innerHTML = `<option value="">Todos los clientes</option>${options}`;
  select.value = clientIdsWithDebt.has(backendId(current)) ? current : "";
}

function clientName(clientId) {
  const client = mapRowsById(commercialEntryData.clientes, "id_cliente").get(backendId(clientId));
  return displayNameLabel(client?.nombre_cliente || client?.nombre || clientId || "Sin cliente");
}

function clientNameFromMap(clientId, clientsById) {
  const client = clientsById.get(backendId(clientId));
  return displayNameLabel(client?.nombre_cliente || client?.nombre || clientId || "Sin cliente");
}

function salePaidAmounts() {
  const paidCentsBySale = commercialEntryData.cobros_detalle.reduce((amounts, row) => {
    const saleId = backendId(row.id_venta);
    amounts.set(saleId, (amounts.get(saleId) || 0) + moneyToCents(row.monto_cancelado));
    return amounts;
  }, new Map());
  return new Map([...paidCentsBySale].map(([saleId, paidCents]) => [saleId, centsToMoney(paidCents)]));
}

function pendingSalesRows(clientId = "") {
  const paidAmounts = salePaidAmounts();
  const selectedClient = backendId(clientId);
  return commercialEntryData.ventas
    .map((sale) => {
      const totalCents = moneyToCents(sale.total);
      const paidCents = moneyToCents(paidAmounts.get(backendId(sale.id_venta)) || 0);
      return {
        sale,
        total: centsToMoney(totalCents),
        paid: centsToMoney(paidCents),
        balance: centsToMoney(Math.max(0, totalCents - paidCents))
      };
    })
    .filter((row) => moneyToCents(row.balance) > 1 && (!selectedClient || backendId(row.sale.id_cliente) === selectedClient))
    .sort((a, b) => String(a.sale.fecha_factura || "").localeCompare(String(b.sale.fecha_factura || "")));
}

async function submitOrderEntry(event) {
  event.preventDefault();
  const button = event.submitter;
  setCommercialButtonLoading(button, true, "Guardando...");
  setCommercialStatus("orders-status", "Guardando pedido...", "pending");

  try {
    const deliveryDate = els["order-delivery-date"]?.value || "";
    const currentDetail = currentOrderDraftDetail();
    const details = currentDetail ? [...orderDraftDetails, currentDetail] : [...orderDraftDetails];
    if (!details.length) throw new Error("Agrega al menos un detalle válido.");
    const result = await saveSalesOrder({
      fechaPedido: els["order-date"]?.value || "",
      idCliente: els["order-client"]?.value || "",
      fechaEntrega: deliveryDate,
      fechaOriginal: els["order-original-date"]?.value || deliveryDate
    }, details);
    setCommercialStatus("orders-status", `Pedido #${result.orderId} guardado.`, "success");
    event.target.reset();
    orderDraftDetails = [];
    setOrderCurrentDetailRequired(true);
    renderOrderDraftDetails();
    resetLogisticsExpenseFormState();
    commercialEntryData.loaded = false;
    await loadCommercialEntryData(true);
  } catch (error) {
    setCommercialStatus("orders-status", `No se pudo guardar el pedido: ${error.message}`, "error");
  } finally {
    setCommercialButtonLoading(button, false);
  }
}

function currentOrderDraftDetail() {
  const idProducto = els["order-product"]?.value || "";
  const quantityValue = els["order-boxes"]?.value || "";
  if (!idProducto && !quantityValue) return null;
  const unitPrice = parseMoneyInput(els["order-unit-price"]?.value || "", { allowEmpty: true, allowNegative: false });
  const discount = parsePercentagePoints(els["order-discount"]?.value || "");
  return {
    idProducto,
    cantidadCajas: Number(quantityValue),
    impuesto: els["order-tax"]?.value || "A",
    precioUd: unitPrice.ok ? unitPrice.amount : 0,
    bonificacion: Number.isFinite(discount) ? discount : NaN
  };
}

function addOrderDraftDetail() {
  const detail = currentOrderDraftDetail();
  if (!detail?.idProducto || !Number.isFinite(detail.cantidadCajas) || detail.cantidadCajas <= 0) {
    setCommercialStatus("orders-status", "Selecciona un producto y una cantidad mayor que cero.", "error");
    return;
  }
  if (!Number.isFinite(detail.bonificacion) || detail.bonificacion < 0) {
    setCommercialStatus("orders-status", "Ingresá una bonificación porcentual válida y no negativa.", "error");
    return;
  }
  orderDraftDetails.push(detail);
  clearOrderCurrentDetail();
  setOrderCurrentDetailRequired(false);
  renderOrderDraftDetails();
  setCommercialStatus("orders-status", "Detalle agregado al pedido.", "success");
}

function removeOrderDraftDetail(event) {
  const button = event.target.closest("[data-order-detail-remove]");
  if (!button) return;
  const index = Number(button.dataset.orderDetailRemove);
  if (!Number.isInteger(index) || index < 0 || index >= orderDraftDetails.length) return;
  orderDraftDetails.splice(index, 1);
  setOrderCurrentDetailRequired(!orderDraftDetails.length);
  renderOrderDraftDetails();
}

function clearOrderCurrentDetail() {
  ["order-product", "order-boxes", "order-unit-price", "order-discount"].forEach((id) => {
    if (els[id]) els[id].value = "";
  });
  if (els["order-tax"]) els["order-tax"].value = "A";
}

function setOrderCurrentDetailRequired(required) {
  if (els["order-product"]) els["order-product"].required = required;
  if (els["order-boxes"]) els["order-boxes"].required = required;
}

function renderOrderDraftDetails() {
  const body = els["order-details-draft"];
  if (!body) return;
  if (!orderDraftDetails.length) {
    body.innerHTML = `<tr><td class="empty" colspan="6">El detalle actual se guardará con el pedido.</td></tr>`;
    return;
  }
  const productsById = mapRowsById(commercialEntryData.productos, "id_producto");
  body.innerHTML = orderDraftDetails.map((detail, index) => {
    const product = productsById.get(backendId(detail.idProducto));
    return `
      <tr>
        <td>${escapeHtml(displayNameLabel(product?.nombre_producto || product?.nombre || detail.idProducto))}</td>
        <td class="num">${formatNumber(detail.cantidadCajas)}</td>
        <td>${escapeHtml(detail.impuesto)}</td>
        <td class="num">${formatMoney(detail.precioUd)}</td>
        <td class="num">${formatPercentagePoints(detail.bonificacion)}</td>
        <td><button type="button" class="secondary" data-order-detail-remove="${index}">Quitar</button></td>
      </tr>
    `;
  }).join("");
}

function parsePercentagePoints(value) {
  const text = String(value ?? "").trim();
  if (!text) return 0;
  const withoutSymbol = text.endsWith("%") ? text.slice(0, -1).trim() : text;
  if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(withoutSymbol)) return NaN;
  return parseQuantity(withoutSymbol);
}

function formatPercentagePoints(value) {
  const percentage = parsePercentagePoints(value);
  return Number.isFinite(percentage) ? `${formatNumber(percentage)}%` : "-";
}
