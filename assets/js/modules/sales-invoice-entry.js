let salesInvoiceOrders = [];
let selectedSalesInvoiceOrderId = "";

function initializeSalesInvoiceEntry() {
  const form = document.getElementById("sales-invoice-form");
  if (!form || form.dataset.bound === "true") return;
  form.dataset.bound = "true";
  form.addEventListener("submit", submitSalesInvoice);
  document.getElementById("sales-invoice-read")?.addEventListener("click", readSalesInvoiceAttachment);
  document.getElementById("sales-invoice-orders-body")?.addEventListener("change", selectSalesInvoiceOrder);
}

async function loadUnbilledSalesOrders() {
  initializeSalesInvoiceEntry();
  setSalesInvoiceStatus("Cargando pedidos sin factura...", "pending");
  try {
    const payload = await requestBackendApi("/api/sales/unbilled-orders");
    salesInvoiceOrders = Array.isArray(payload.orders) ? payload.orders : [];
    if (!salesInvoiceOrders.some((order) => String(order.id_pedido) === selectedSalesInvoiceOrderId)) {
      selectedSalesInvoiceOrderId = "";
    }
    renderUnbilledSalesOrders();
    setSalesInvoiceStatus(
      salesInvoiceOrders.length ? "Seleccioná un pedido y completá la factura." : "No hay pedidos sin factura.",
      "success"
    );
  } catch (error) {
    salesInvoiceOrders = [];
    renderUnbilledSalesOrders();
    setSalesInvoiceStatus(`No se pudieron cargar los pedidos: ${error.message}`, "error");
  }
}

function renderUnbilledSalesOrders() {
  const body = document.getElementById("sales-invoice-orders-body");
  if (!body) return;
  body.innerHTML = salesInvoiceOrders.length ? salesInvoiceOrders.map((order) => {
    const products = order.productos?.map((item) => (
      `${displayNameLabel(item.producto || `Producto ${item.id_producto}`)} (${formatNumber(item.cantidad_cajas)})`
    )).join(", ") || "-";
    return `<tr>
      <td><input type="radio" name="sales-invoice-order" value="${escapeHtml(order.id_pedido)}"
        aria-label="Seleccionar pedido ${escapeHtml(order.id_pedido)}"
        ${String(order.id_pedido) === selectedSalesInvoiceOrderId ? "checked" : ""}></td>
      <td>${escapeHtml(order.id_pedido)}</td>
      <td>${escapeHtml(displayNameLabel(order.cliente) || `Cliente ${order.id_cliente}`)}</td>
      <td>${escapeHtml(formatDate(order.fecha_pedido))}</td>
      <td>${escapeHtml(order.id_entrega ? `#${order.id_entrega} · ${formatDate(order.fecha_entrega)}` : "Sin entrega")}</td>
      <td>${escapeHtml(products)}</td>
      <td class="num">${escapeHtml(formatNumber(order.cantidad_cajas))}</td>
    </tr>`;
  }).join("") : '<tr><td class="empty" colspan="7">No hay pedidos sin factura.</td></tr>';
}

function selectSalesInvoiceOrder(event) {
  if (event.target?.name !== "sales-invoice-order") return;
  selectedSalesInvoiceOrderId = String(event.target.value || "");
  setSalesInvoiceStatus("Pedido seleccionado. La factura se guardará sólo después de tu confirmación.", "success");
}

async function readSalesInvoiceAttachment() {
  const file = document.getElementById("sales-invoice-file")?.files?.[0];
  if (!file) {
    setSalesInvoiceStatus("Adjuntá una imagen o PDF antes de leer.", "error");
    return;
  }
  if (!(file.type.startsWith("image/") || file.type === "application/pdf" || /\.pdf$/i.test(file.name))) {
    setSalesInvoiceStatus("El archivo debe ser una imagen o PDF válido.", "error");
    return;
  }
  setSalesInvoiceStatus("Leyendo factura para proponer datos...", "pending");
  try {
    const fileDataUrl = await salesInvoiceFileDataUrl(file);
    const payload = await requestBackendApi("/api/reception-invoice/read", {
      method: "POST",
      body: JSON.stringify({ fileDataUrl, fileName: file.name, mimeType: file.type })
    });
    applySalesInvoiceProposal(payload.invoice || {});
    const missing = Array.isArray(payload.missingFields) && payload.missingFields.length
      ? ` Faltan: ${payload.missingFields.join(", ")}.`
      : "";
    setSalesInvoiceStatus(`Lectura completada. Revisá y corregí todos los campos antes de guardar.${missing}`, "success");
  } catch (error) {
    setSalesInvoiceStatus(`No se pudo leer automáticamente: ${error.message} Podés completar la venta manualmente.`, "error");
  }
}

function applySalesInvoiceProposal(invoice) {
  const values = {
    "sales-invoice-type": invoice.tipo_factura,
    "sales-invoice-number": invoice.nro_factura,
    "sales-invoice-date": invoice.fecha_factura,
    "sales-invoice-subtotal": invoice.subtotal,
    "sales-invoice-iva": invoice.iva,
    "sales-invoice-total": invoice.total
  };
  Object.entries(values).forEach(([id, value]) => {
    const input = document.getElementById(id);
    if (input && value !== null && value !== undefined && value !== "") input.value = value;
  });
}

async function submitSalesInvoice(event) {
  event.preventDefault();
  if (!selectedSalesInvoiceOrderId) {
    setSalesInvoiceStatus("Seleccioná un pedido sin factura.", "error");
    return;
  }
  const invoice = {
    tipoFactura: document.getElementById("sales-invoice-type")?.value || "",
    nroFactura: document.getElementById("sales-invoice-number")?.value || "",
    fechaFactura: document.getElementById("sales-invoice-date")?.value || "",
    fechaAcordada: document.getElementById("sales-invoice-due-date")?.value || "",
    subtotal: salesInvoiceMoneyValue("sales-invoice-subtotal"),
    iva: salesInvoiceMoneyValue("sales-invoice-iva"),
    total: salesInvoiceMoneyValue("sales-invoice-total")
  };
  if ([invoice.subtotal, invoice.iva, invoice.total].some((value) => value === null)) {
    setSalesInvoiceStatus("Revisá subtotal, IVA y total: deben ser importes válidos no negativos.", "error");
    return;
  }
  setSalesInvoiceStatus("Guardando venta...", "pending");
  try {
    await requestBackendApi("/api/sales/invoices/full-entry", {
      method: "POST",
      body: JSON.stringify({ orderIds: [selectedSalesInvoiceOrderId], invoice })
    });
    event.target.reset();
    selectedSalesInvoiceOrderId = "";
    await loadUnbilledSalesOrders();
    setSalesInvoiceStatus("Venta guardada. El pedido fue retirado de la lista.", "success");
  } catch (error) {
    await loadUnbilledSalesOrders();
    setSalesInvoiceStatus(error.message, "error");
  }
}

function salesInvoiceMoneyValue(id) {
  const parsed = parseMoneyInput(document.getElementById(id)?.value || "", { allowEmpty: false, allowNegative: false });
  return parsed.ok && !parsed.empty ? parsed.amount : null;
}

function salesInvoiceFileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
    reader.readAsDataURL(file);
  });
}

function setSalesInvoiceStatus(message, kind = "") {
  const status = document.getElementById("sales-invoice-status");
  if (!status) return;
  status.textContent = message;
  status.className = `form-status${kind ? ` ${kind}` : ""}`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { applySalesInvoiceProposal };
}
