const ORDER_DEFAULT_PRODUCT_LABEL = "Barra Pop 140Ud";
const orderCatalogComboboxes = new Map();

function renderOrderEntry() {
  const clientCombobox = ensureOrderCatalogCombobox({
    name: "Cliente",
    inputId: "order-client",
    valueId: "order-client-id",
    listboxId: "order-client-listbox",
    rows: commercialEntryData.clientes,
    idKey: "id_cliente",
    labelKey: "nombre_cliente"
  });
  const productCombobox = ensureOrderCatalogCombobox({
    name: "Producto",
    inputId: "order-product",
    valueId: "order-product-id",
    listboxId: "order-product-listbox",
    rows: commercialEntryData.productos,
    idKey: "id_producto",
    labelKey: "nombre_producto"
  });
  clientCombobox?.refresh(commercialEntryData.clientes);
  productCombobox?.refresh(commercialEntryData.productos);
  applyDefaultOrderProduct(productCombobox, commercialEntryData.productos);
  if (els["order-date"] && !els["order-date"].value) els["order-date"].value = toIsoDate(new Date());
  if (els["order-delivery-date"] && !els["order-delivery-date"].value) els["order-delivery-date"].value = toIsoDate(new Date());
  renderOrderDraftDetails();
}

function ensureOrderCatalogCombobox(config) {
  if (orderCatalogComboboxes.has(config.inputId)) return orderCatalogComboboxes.get(config.inputId);
  const input = els[config.inputId];
  const valueInput = els[config.valueId];
  const listbox = els[config.listboxId];
  if (!input || !valueInput || !listbox) return null;
  const combobox = createCatalogCombobox({ ...config, input, valueInput, listbox });
  orderCatalogComboboxes.set(config.inputId, combobox);
  return combobox;
}

function normalizeCatalogSearch(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .trim();
}

function catalogOptionLabel(row, labelKey) {
  return displayNameLabel(row?.[labelKey] || row?.nombre || "");
}

function isCatalogOptionActive(row) {
  for (const key of ["activo", "activa", "active", "habilitado", "habilitada", "enabled"]) {
    if (!(key in (row || {}))) continue;
    return !["false", "0", "no", "inactivo", "inactiva", "deshabilitado", "deshabilitada"]
      .includes(normalizeCatalogSearch(row[key]));
  }
  if ("estado" in (row || {})) {
    return !["inactivo", "inactiva", "deshabilitado", "deshabilitada", "baja"]
      .includes(normalizeCatalogSearch(row.estado));
  }
  return true;
}

function filterCatalogOptions(rows, labelKey, query) {
  const normalizedQuery = normalizeCatalogSearch(query);
  return (rows || [])
    .filter(isCatalogOptionActive)
    .map((row, originalIndex) => ({
      row,
      originalIndex,
      label: catalogOptionLabel(row, labelKey),
      normalizedLabel: normalizeCatalogSearch(catalogOptionLabel(row, labelKey))
    }))
    .filter((option) => !normalizedQuery || option.normalizedLabel.includes(normalizedQuery))
    .sort((left, right) => {
      const leftStarts = left.normalizedLabel.startsWith(normalizedQuery);
      const rightStarts = right.normalizedLabel.startsWith(normalizedQuery);
      if (leftStarts !== rightStarts) return leftStarts ? -1 : 1;
      return left.label.localeCompare(right.label, "es", { sensitivity: "base" })
        || left.originalIndex - right.originalIndex;
    });
}

function createCatalogCombobox({ name, input, valueInput, listbox, rows, idKey, labelKey, inputId }) {
  let catalogRows = rows || [];
  let visibleOptions = [];
  let activeIndex = -1;
  let selectedId = backendId(valueInput.value);
  let selectedLabel = "";

  function optionId(index) {
    return `${inputId}-option-${index}`;
  }

  function selectedRow() {
    return catalogRows.find((row) => backendId(row[idKey]) === selectedId && isCatalogOptionActive(row));
  }

  function validSelectedId() {
    const row = selectedRow();
    if (!row) return "";
    const label = catalogOptionLabel(row, labelKey);
    return input.value === label ? backendId(row[idKey]) : "";
  }

  function close() {
    listbox.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    activeIndex = -1;
  }

  function renderOptions(query = input.value) {
    visibleOptions = filterCatalogOptions(catalogRows, labelKey, query);
    activeIndex = visibleOptions.length ? 0 : -1;
    listbox.innerHTML = visibleOptions.length
      ? visibleOptions.map((option, index) => `
          <span id="${optionId(index)}" class="catalog-combobox-option${index === activeIndex ? " is-active" : ""}"
            role="option" aria-selected="${backendId(option.row[idKey]) === selectedId}" data-catalog-index="${index}">
            ${escapeHtml(option.label)}
          </span>`).join("")
      : `<span class="catalog-combobox-empty">No hay ${escapeHtml(name.toLocaleLowerCase())}s compatibles.</span>`;
    listbox.hidden = false;
    input.setAttribute("aria-expanded", "true");
    syncActiveDescendant();
  }

  function syncActiveDescendant() {
    const options = listbox.querySelectorAll?.("[role='option']") || [];
    options.forEach((option, index) => option.classList.toggle("is-active", index === activeIndex));
    if (activeIndex >= 0) input.setAttribute("aria-activedescendant", optionId(activeIndex));
    else input.removeAttribute("aria-activedescendant");
  }

  function selectIndex(index) {
    const option = visibleOptions[index];
    if (!option) return false;
    selectedId = backendId(option.row[idKey]);
    selectedLabel = option.label;
    valueInput.value = selectedId;
    input.value = selectedLabel;
    input.setCustomValidity("");
    close();
    return true;
  }

  function invalidateSelection() {
    selectedId = "";
    selectedLabel = "";
    valueInput.value = "";
    input.setCustomValidity(input.value ? `Seleccioná un ${name.toLocaleLowerCase()} válido del listado.` : "");
  }

  input.addEventListener("input", () => {
    if (input.value !== selectedLabel) invalidateSelection();
    renderOptions();
  });
  input.addEventListener("focus", () => renderOptions());
  input.addEventListener("click", () => renderOptions());
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (listbox.hidden) renderOptions();
      else if (visibleOptions.length) {
        const direction = event.key === "ArrowDown" ? 1 : -1;
        activeIndex = (activeIndex + direction + visibleOptions.length) % visibleOptions.length;
        syncActiveDescendant();
      }
      return;
    }
    if (event.key === "Enter" && !listbox.hidden && activeIndex >= 0) {
      event.preventDefault();
      selectIndex(activeIndex);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") close();
  });
  input.addEventListener("blur", () => setTimeout(close, 0));
  listbox.addEventListener("mousedown", (event) => event.preventDefault());
  listbox.addEventListener("click", (event) => {
    const option = event.target.closest?.("[data-catalog-index]");
    if (!option) return;
    event.preventDefault();
    event.stopPropagation();
    selectIndex(Number(option.dataset.catalogIndex));
  });

  function refresh(nextRows) {
    catalogRows = nextRows || [];
    const row = selectedRow();
    if (row) {
      selectedLabel = catalogOptionLabel(row, labelKey);
      input.value = selectedLabel;
      valueInput.value = selectedId;
      input.setCustomValidity("");
    } else if (selectedId) {
      invalidateSelection();
    }
    close();
  }

  function selectById(id) {
    const canonicalId = backendId(id);
    const row = catalogRows.find((item) => backendId(item[idKey]) === canonicalId && isCatalogOptionActive(item));
    if (!row) return false;
    visibleOptions = [{ row, label: catalogOptionLabel(row, labelKey) }];
    return selectIndex(0);
  }

  function clear() {
    selectedId = "";
    selectedLabel = "";
    input.value = "";
    valueInput.value = "";
    input.setCustomValidity("");
    close();
  }

  refresh(catalogRows);
  return { clear, close, refresh, selectById, validSelectedId };
}

function applyDefaultOrderProduct(productCombobox, products) {
  if (!productCombobox || productCombobox.validSelectedId() || orderDraftDetails.length) return;
  if (els["order-product"]?.value || els["order-product-id"]?.value) return;
  const defaultProduct = findDefaultOrderProduct(products);
  if (defaultProduct) productCombobox.selectById(defaultProduct.id_producto);
}

function findDefaultOrderProduct(products) {
  return (products || []).find((product) =>
    catalogOptionLabel(product, "nombre_producto") === ORDER_DEFAULT_PRODUCT_LABEL
    && isCatalogOptionActive(product)
  );
}

function selectedOrderCatalogId(inputId) {
  return orderCatalogComboboxes.get(inputId)?.validSelectedId() || "";
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
    if (!selectedOrderCatalogId("order-client")) {
      throw new Error("Seleccioná un cliente válido del listado.");
    }
    if (els["order-product"]?.value && !selectedOrderCatalogId("order-product")) {
      throw new Error("Seleccioná un producto válido del listado.");
    }
    const currentDetail = currentOrderDraftDetail();
    const details = currentDetail ? [...orderDraftDetails, currentDetail] : [...orderDraftDetails];
    if (!details.length) throw new Error("Agrega al menos un detalle válido.");
    const result = await saveSalesOrder({
      fechaPedido: els["order-date"]?.value || "",
      idCliente: selectedOrderCatalogId("order-client"),
      fechaEntrega: deliveryDate,
      fechaOriginal: els["order-original-date"]?.value || deliveryDate
    }, details, window.SalesWorkflow?.orderRequestMetadata?.() || null);
    setCommercialStatus("orders-status", `Pedido #${result.orderId} guardado.`, "success");
    event.target.reset();
    orderDraftDetails = [];
    orderCatalogComboboxes.get("order-client")?.clear();
    orderCatalogComboboxes.get("order-product")?.clear();
    setOrderCurrentDetailRequired(true);
    renderOrderDraftDetails();
    resetLogisticsExpenseFormState();
    commercialEntryData.loaded = false;
    await loadCommercialEntryData(true);
    window.dispatchEvent(new CustomEvent("sales-workflow:order-saved", { detail: result }));
  } catch (error) {
    setCommercialStatus("orders-status", `No se pudo guardar el pedido: ${error.message}`, "error");
  } finally {
    setCommercialButtonLoading(button, false);
  }
}

function currentOrderDraftDetail() {
  const idProducto = selectedOrderCatalogId("order-product");
  const quantityValue = els["order-boxes"]?.value || "";
  const unitPrice = parseMoneyInput(els["order-unit-price"]?.value || "", { allowEmpty: true, allowNegative: false });
  const discount = parsePercentagePoints(els["order-discount"]?.value || "");
  return orderDetailFromDraftValues({
    idProducto,
    cantidadCajas: quantityValue,
    impuesto: els["order-tax"]?.value || "A",
    precioUd: unitPrice.ok ? unitPrice.amount : 0,
    bonificacion: Number.isFinite(discount) ? discount : NaN
  });
}

function orderDetailFromDraftValues({
  idProducto,
  cantidadCajas,
  impuesto = "A",
  precioUd = 0,
  bonificacion = 0
}) {
  if (!String(cantidadCajas ?? "").trim()) return null;
  return {
    idProducto,
    cantidadCajas: Number(cantidadCajas),
    impuesto,
    precioUd,
    bonificacion
  };
}

function addOrderDraftDetail() {
  const detail = currentOrderDraftDetail();
  if (!detail?.idProducto || !Number.isFinite(detail.cantidadCajas) || detail.cantidadCajas <= 0) {
    setCommercialStatus("orders-status", "Seleccioná un producto válido del listado y una cantidad mayor que cero.", "error");
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
  ["order-boxes", "order-unit-price", "order-discount"].forEach((id) => {
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

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    createCatalogCombobox,
    findDefaultOrderProduct,
    filterCatalogOptions,
    isCatalogOptionActive,
    normalizeCatalogSearch,
    orderDetailFromDraftValues
  };
}
