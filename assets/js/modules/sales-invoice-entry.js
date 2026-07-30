let salesInvoiceOrders = [];
let selectedSalesInvoiceOrderId = "";
let salesInvoiceFileReading = false;
let salesInvoiceReadToken = 0;
const SALES_INVOICE_READ_ENDPOINT = "/api/sales/invoice/read";

function initializeSalesInvoiceEntry() {
  const form = document.getElementById("sales-invoice-form");
  if (!form || form.dataset.bound === "true") return;
  form.dataset.bound = "true";
  form.addEventListener("submit", submitSalesInvoice);
  document.getElementById("sales-invoice-read")?.addEventListener("click", readSalesInvoiceAttachment);
  document.getElementById("sales-invoice-file")?.addEventListener("change", handleSalesInvoiceFileChange);
  document.getElementById("sales-invoice-file-clear")?.addEventListener("click", clearSalesInvoiceFile);
  document.getElementById("sales-invoice-orders-body")?.addEventListener("change", selectSalesInvoiceOrder);
  ["sales-invoice-subtotal", "sales-invoice-total", "sales-invoice-type"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", updateSalesInvoiceComparison);
    document.getElementById(id)?.addEventListener("change", updateSalesInvoiceComparison);
  });
  setupFileDropZone({
    dropZone: document.getElementById("sales-invoice-file-drop-zone"),
    input: document.getElementById("sales-invoice-file"),
    acceptFile: isSalesInvoiceReadableAttachment,
    onAccepted: handleSalesInvoiceFileChange,
    onRejected: () => setSalesInvoiceStatus("El archivo debe ser una imagen o PDF válido.", "error"),
    respectDisabled: true
  });
  updateSalesInvoiceFileUi();
  updateSalesInvoiceComparison();
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
    updateSalesInvoiceComparison();
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
  updateSalesInvoiceComparison();
  setSalesInvoiceStatus("Pedido seleccionado. La factura se guardará sólo después de tu confirmación.", "success");
}

async function readSalesInvoiceAttachment() {
  const input = document.getElementById("sales-invoice-file");
  const file = input?.files?.[0];
  if (!file) {
    setSalesInvoiceStatus("Adjuntá una imagen o PDF antes de leer.", "error");
    return;
  }
  if (!isSalesInvoiceReadableAttachment(file)) {
    setSalesInvoiceStatus("El archivo debe ser una imagen o PDF válido.", "error");
    return;
  }
  if (salesInvoiceFileReading) return;
  salesInvoiceFileReading = true;
  const readToken = ++salesInvoiceReadToken;
  updateSalesInvoiceFileUi();
  setSalesInvoiceStatus("Leyendo factura para proponer datos...", "pending");
  try {
    const fileDataUrl = await salesInvoiceFileDataUrl(file);
    if (!salesInvoiceReadIsCurrent(file, input, readToken)) return;
    const payload = await requestBackendApi(SALES_INVOICE_READ_ENDPOINT, {
      method: "POST",
      body: JSON.stringify({ fileDataUrl, fileName: file.name, mimeType: file.type })
    });
    if (!salesInvoiceReadIsCurrent(file, input, readToken)) return;
    applySalesInvoiceProposal(payload.invoice || {});
    const missing = Array.isArray(payload.missingFields) && payload.missingFields.length
      ? ` Faltan: ${payload.missingFields.join(", ")}.`
      : "";
    const warnings = Array.isArray(payload.reviewWarnings) && payload.reviewWarnings.length
      ? ` ${payload.reviewWarnings.join(" ")}`
      : "";
    setSalesInvoiceStatus(
      `Lectura completada. Revisá y corregí todos los campos antes de guardar.${missing}${warnings}`,
      warnings ? "pending" : "success"
    );
  } catch (error) {
    if (salesInvoiceReadIsCurrent(file, input, readToken)) {
      setSalesInvoiceStatus(salesInvoiceReadErrorMessage(error), "error");
    }
  } finally {
    if (readToken === salesInvoiceReadToken) {
      salesInvoiceFileReading = false;
      updateSalesInvoiceFileUi();
    }
  }
}

function salesInvoiceReadIsCurrent(
  file,
  input,
  token,
  currentToken = salesInvoiceReadToken,
  reading = salesInvoiceFileReading
) {
  return Boolean(
    reading
    && token === currentToken
    && input?.files?.[0] === file
  );
}

function salesInvoiceReadErrorMessage(error) {
  const manualFallback = "Podés completar la venta manualmente.";
  if (error?.code === "INVALID_FILE") {
    return `No se pudo leer el archivo: ${error.message} Elegí otro PDF o imagen. ${manualFallback}`;
  }
  if (error?.code === "SERVICE_NOT_CONFIGURED") {
    return `La lectura automática no está configurada: ${error.message} ${manualFallback}`;
  }
  if (error?.code === "UNREADABLE_RESPONSE") {
    return `El archivo no contiene datos de factura o remito interpretables: ${error.message} ${manualFallback}`;
  }
  if (error?.code === "SERVICE_UNAVAILABLE" || error?.code === "SERVICE_TIMEOUT") {
    return `No se pudo conectar con el proveedor de lectura: ${error.message} ${manualFallback}`;
  }
  if (String(error?.code || "").startsWith("PROVIDER_")) {
    return `El proveedor rechazó la lectura: ${error.message} ${manualFallback}`;
  }
  if (error?.code) {
    return `No se pudo leer automáticamente: ${error.message} ${manualFallback}`;
  }
  if (error?.status) {
    return `El servidor rechazó la lectura (HTTP ${error.status}). Intentá nuevamente o consultá al administrador. ${manualFallback}`;
  }
  return `No se pudo conectar con el servicio de lectura. Revisá la conexión e intentá nuevamente. ${manualFallback}`;
}

function isSalesInvoiceReadableAttachment(file) {
  return Boolean(file && (file.type?.startsWith("image/") || file.type === "application/pdf" || /\.pdf$/i.test(file.name)));
}

function salesInvoiceFileUiState(file, reading = false) {
  return {
    hasFile: Boolean(file),
    fileName: file?.name || "Sin archivo",
    fileSize: file ? formatFileSize(file.size) : "-",
    canRead: Boolean(file) && !reading,
    canChange: !reading
  };
}

function updateSalesInvoiceFileUi() {
  const file = document.getElementById("sales-invoice-file")?.files?.[0];
  const ui = salesInvoiceFileUiState(file, salesInvoiceFileReading);
  const chip = document.getElementById("sales-invoice-file-chip");
  const name = document.getElementById("sales-invoice-file-name");
  const size = document.getElementById("sales-invoice-file-size");
  const readButton = document.getElementById("sales-invoice-read");
  const clearButton = document.getElementById("sales-invoice-file-clear");
  const input = document.getElementById("sales-invoice-file");
  const dropZone = document.getElementById("sales-invoice-file-drop-zone");
  chip?.classList.toggle("is-empty", !ui.hasFile);
  if (name) {
    name.textContent = ui.fileName;
    name.title = ui.hasFile ? ui.fileName : "";
  }
  if (size) size.textContent = ui.fileSize;
  if (readButton) readButton.disabled = !ui.canRead;
  if (clearButton) clearButton.disabled = !ui.canChange;
  if (input) input.disabled = !ui.canChange;
  dropZone?.classList.toggle("is-disabled", !ui.canChange);
  dropZone?.setAttribute("aria-disabled", String(!ui.canChange));
}

function handleSalesInvoiceFileChange() {
  if (salesInvoiceFileReading) return;
  salesInvoiceReadToken += 1;
  updateSalesInvoiceFileUi();
}

function clearSalesInvoiceFile() {
  if (salesInvoiceFileReading) return;
  const input = document.getElementById("sales-invoice-file");
  if (input) input.value = "";
  salesInvoiceReadToken += 1;
  updateSalesInvoiceFileUi();
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
  updateSalesInvoiceComparison();
}

function salesInvoiceComparison(
  order,
  invoiceSubtotal,
  invoiceType,
  money = ErpMoney,
  invoiceTotal = invoiceSubtotal
) {
  if (invoiceType === "Remito_X") return { state: "not_applicable", label: "No aplica" };
  const expected = order?.comparacion_factura;
  if (!order) return { state: "insufficient", label: "Datos insuficientes", missing: ["pedido"] };
  if (expected?.estado !== "calculable") {
    return {
      state: "insufficient",
      label: "Datos insuficientes",
      missing: expected?.campos_faltantes || ["detalle del pedido"]
    };
  }
  const expectedCents = salesInvoiceCentsOrNull(expected.subtotal_esperado, money);
  if (expectedCents === null) {
    return { state: "insufficient", label: "Datos insuficientes", missing: ["subtotal esperado"] };
  }
  const lines = expected.lineas || [];
  const comparesGrossTotal = invoiceType === "Factura_B";
  const invoiceCents = salesInvoiceCentsOrNull(
    comparesGrossTotal ? invoiceTotal : invoiceSubtotal,
    money
  );
  if (invoiceCents === null) {
    return {
      state: "insufficient",
      label: "Datos insuficientes",
      missing: [comparesGrossTotal ? "total de factura" : "subtotal de factura"],
      expectedCents,
      lines,
      comparesGrossTotal
    };
  }
  const differenceCents = invoiceCents - expectedCents;
  return {
    state: differenceCents === 0 ? "match" : "difference",
    label: differenceCents === 0 ? "Coincide" : "Diferencia",
    expectedCents,
    invoiceCents,
    differenceCents,
    differencePercent: expectedCents === 0 ? null : (differenceCents * 100) / expectedCents,
    lines,
    comparesGrossTotal
  };
}

function salesInvoiceCentsOrNull(value, money = ErpMoney) {
  if (value === "" || value === null || value === undefined) return null;
  try {
    const cents = money.toCents(value);
    return cents >= 0 ? cents : null;
  } catch {
    return null;
  }
}

function updateSalesInvoiceComparison() {
  const panel = document.getElementById("sales-invoice-comparison");
  if (!panel) return;
  const order = salesInvoiceOrders.find((item) => String(item.id_pedido) === selectedSalesInvoiceOrderId);
  const subtotal = document.getElementById("sales-invoice-subtotal")?.value ?? "";
  const total = document.getElementById("sales-invoice-total")?.value ?? "";
  const invoiceType = document.getElementById("sales-invoice-type")?.value || "";
  const result = salesInvoiceComparison(order, subtotal, invoiceType, ErpMoney, total);
  panel.dataset.state = result.state;
  setSalesInvoiceComparisonText("sales-invoice-comparison-state", result.label);
  setSalesInvoiceComparisonText("sales-invoice-comparison-expected",
    result.expectedCents === undefined ? "—" : ErpMoney.format(ErpMoney.fromCents(result.expectedCents)));
  setSalesInvoiceComparisonText("sales-invoice-comparison-invoice",
    result.invoiceCents === undefined ? "—" : ErpMoney.format(ErpMoney.fromCents(result.invoiceCents)));
  setSalesInvoiceComparisonText(
    "sales-invoice-comparison-invoice-label",
    result.comparesGrossTotal ? "Total de factura" : "Subtotal de factura"
  );
  setSalesInvoiceComparisonText("sales-invoice-comparison-difference",
    result.differenceCents === undefined ? "—" : signedSalesInvoiceMoney(result.differenceCents));
  setSalesInvoiceComparisonText("sales-invoice-comparison-percent",
    result.differencePercent === undefined || result.differencePercent === null
      ? "—"
      : `${result.differencePercent > 0 ? "+" : ""}${result.differencePercent.toFixed(2)}%`);
  const explanation = document.getElementById("sales-invoice-comparison-explanation");
  if (explanation) {
    explanation.textContent = result.missing?.length
      ? `Falta: ${result.missing.join(", ")}.`
      : result.differenceCents > 0
        ? "La factura es mayor que el pedido."
        : result.differenceCents < 0
          ? "La factura es menor que el pedido."
          : result.state === "match"
            ? result.comparesGrossTotal
              ? "Los totales con IVA incluido coinciden al centavo."
              : "Los subtotales netos coinciden al centavo."
            : "El remito no tiene subtotal fiscal comparable.";
  }
  renderSalesInvoiceComparisonLines(result.lines || []);
}

function setSalesInvoiceComparisonText(id, text) {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

function signedSalesInvoiceMoney(cents) {
  const prefix = cents > 0 ? "+" : cents < 0 ? "−" : "";
  return `${prefix}${ErpMoney.format(ErpMoney.fromCents(Math.abs(cents)))}`;
}

function renderSalesInvoiceComparisonLines(lines) {
  const details = document.getElementById("sales-invoice-comparison-details");
  const body = document.getElementById("sales-invoice-comparison-lines");
  if (!details || !body) return;
  details.hidden = lines.length <= 1;
  body.innerHTML = lines.map((line) => `<tr>
    <td>${escapeHtml(displayNameLabel(line.producto) || `Producto ${line.id_producto}`)}</td>
    <td class="num">${escapeHtml(formatNumber(line.cantidad_cajas))}</td>
    <td class="num">${escapeHtml(formatNumber(line.unidades_por_caja))}</td>
    <td class="num">${escapeHtml(formatNumber(line.unidades_individuales))}</td>
    <td class="num">${escapeHtml(ErpMoney.format(line.precio_unitario))}</td>
    <td class="num">${escapeHtml(`${formatNumber(line.bonificacion)}%`)}</td>
    <td class="num">${escapeHtml(ErpMoney.format(line.subtotal_esperado))}</td>
  </tr>`).join("");
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
    updateSalesInvoiceFileUi();
    selectedSalesInvoiceOrderId = "";
    updateSalesInvoiceComparison();
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
  module.exports = {
    SALES_INVOICE_READ_ENDPOINT,
    applySalesInvoiceProposal,
    isSalesInvoiceReadableAttachment,
    salesInvoiceReadIsCurrent,
    salesInvoiceComparison,
    salesInvoiceFileUiState,
    salesInvoiceReadErrorMessage
  };
}
