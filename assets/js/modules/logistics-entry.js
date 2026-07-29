function renderLogisticsEntry() {
  const body = els["logistics-pending-body"];
  if (!body) return;

  const deliveriesById = mapRowsById(commercialEntryData.entregas, "id_entrega");
  const deliveredOrderIds = new Set(
    commercialEntryData.entregas_detalle
      .filter((row) => {
        const delivery = deliveriesById.get(backendId(row.id_entrega));
        return backendId(delivery?.id_flete);
      })
      .map((row) => backendId(row.id_pedido))
  );
  const clientsById = mapRowsById(commercialEntryData.clientes, "id_cliente");
  const orderDetailsByOrder = groupRowsById(commercialEntryData.detalle_pedidos, "id_pedido");
  const productsById = mapRowsById(commercialEntryData.productos, "id_producto");
  const pendingOrders = commercialEntryData.pedidos
    .filter((order) => !deliveredOrderIds.has(backendId(order.id_pedido)))
    .sort((a, b) => String(a.fecha_entrega || "").localeCompare(String(b.fecha_entrega || "")));

  fillSelectOptions(els["logistics-delivery-fleet"], commercialEntryData.fletes, "id_flete", "nombre_flete", "Flete");
  if (els["logistics-delivery-fleet"]) els["logistics-delivery-fleet"].value = logisticsDefaultFleetId();
  if (els["logistics-delivery-date"] && !els["logistics-delivery-date"].value) {
    els["logistics-delivery-date"].value = pendingOrders[0]?.fecha_entrega || toIsoDate(new Date());
  }

  if (!pendingOrders.length) {
    body.innerHTML = `<tr><td class="empty" colspan="5">No hay pedidos pendientes.</td></tr>`;
    updateLogisticsOrderSelectionSummary();
    renderLogisticsExpenseEntry();
    return;
  }

  body.innerHTML = pendingOrders.map((order) => {
    const orderId = backendId(order.id_pedido);
    const detail = (orderDetailsByOrder.get(orderId) || [])
      .map((row) => {
        const product = productsById.get(backendId(row.id_producto));
        const productName = product?.nombre_producto || product?.nombre || row.id_producto;
        return `${displayNameLabel(productName)} (${formatNumber(parseQuantity(row.cantidad_cajas))})`;
      })
      .join(", ");
    return `
      <tr>
        <td><input type="checkbox" data-logistics-order="${escapeHtml(orderId)}"></td>
        <td>${formatDate(order.fecha_entrega)}</td>
        <td>${escapeHtml(clientName(order.id_cliente))}</td>
        <td>#${escapeHtml(orderId)}</td>
        <td>${escapeHtml(detail || "-")}</td>
      </tr>
    `;
  }).join("");
  updateLogisticsOrderSelectionSummary();
  renderLogisticsExpenseEntry();
}

function logisticsDefaultFleetId() {
  const defaultFleet = commercialEntryData.fletes.find((fleet) => normalizeCategory(fleet.nombre_flete || fleet.nombre).includes("transporte vision"));
  return backendId(defaultFleet?.id_flete);
}

function selectedLogisticsOrderIds() {
  return [...document.querySelectorAll("[data-logistics-order]:checked")]
    .map((input) => backendId(input.dataset.logisticsOrder))
    .filter(Boolean);
}

function updateLogisticsOrderSelectionSummary() {
  const selectedCount = selectedLogisticsOrderIds().length;
  if (els["logistics-order-selection"]) {
    els["logistics-order-selection"].textContent = `${selectedCount} pedido${selectedCount === 1 ? "" : "s"} seleccionado${selectedCount === 1 ? "" : "s"}`;
  }
}

function renderLogisticsExpenseEntry() {
  const body = els["logistics-expense-delivery-body"];
  if (!body) return;

  const rows = logisticsExpenseDeliveryRows();
  body.innerHTML = rows.length ? rows.map((row) => `
    <tr>
      <td><input type="checkbox" data-logistics-expense-delivery="${escapeHtml(row.deliveryId)}"></td>
      <td>${formatDate(row.delivery.fecha)}</td>
      <td>${escapeHtml(row.fleetName)}</td>
      <td>${escapeHtml(row.orderSummary || "-")}</td>
    </tr>
  `).join("") : `<tr><td class="empty" colspan="4">No hay entregas sin egreso asociado.</td></tr>`;

  if (els["logistics-expense-invoice-date"] && !els["logistics-expense-invoice-date"].value) {
    els["logistics-expense-invoice-date"].value = toIsoDate(new Date());
  }
  updateLogisticsExpenseSelectionSummary();
}

function logisticsExpenseDeliveryRows() {
  const fleetsById = mapRowsById(commercialEntryData.fletes, "id_flete");
  const deliveryDetailsByDelivery = groupRowsById(commercialEntryData.entregas_detalle, "id_entrega");
  const clientsById = mapRowsById(commercialEntryData.clientes, "id_cliente");
  const ordersById = mapRowsById(commercialEntryData.pedidos, "id_pedido");

  return commercialEntryData.entregas
    .filter((delivery) => backendId(delivery.id_flete) && !backendId(delivery.id_egreso))
    .map((delivery) => {
      const deliveryId = backendId(delivery.id_entrega);
      const fleet = fleetsById.get(backendId(delivery.id_flete));
      const orderSummary = (deliveryDetailsByDelivery.get(deliveryId) || [])
        .map((detail) => {
          const order = ordersById.get(backendId(detail.id_pedido));
          return `#${backendId(detail.id_pedido)} ${clientNameFromMap(order?.id_cliente, clientsById)}`;
        })
        .join(", ");
      return {
        delivery,
        deliveryId,
        fleetName: displayNameLabel(fleet?.nombre_flete || fleet?.nombre || delivery.id_flete),
        orderSummary
      };
    })
    .sort((a, b) => String(a.delivery.fecha || "").localeCompare(String(b.delivery.fecha || "")));
}

function updateLogisticsExpenseSelectionSummary() {
  const selectedCount = selectedLogisticsExpenseDeliveryIds().length;
  if (els["logistics-expense-selection"]) {
    els["logistics-expense-selection"].textContent = `${selectedCount} entrega${selectedCount === 1 ? "" : "s"} seleccionada${selectedCount === 1 ? "" : "s"}`;
  }
  autofillLogisticsPaymentDateFromAgreement();
}

function selectedLogisticsExpenseDeliveryIds() {
  return [...document.querySelectorAll("[data-logistics-expense-delivery]:checked")]
    .map((input) => backendId(input.dataset.logisticsExpenseDelivery))
    .filter(Boolean);
}

function logisticsSelectedExpenseDeliveries() {
  const selectedDeliveryIds = new Set(selectedLogisticsExpenseDeliveryIds());
  return commercialEntryData.entregas.filter((delivery) => selectedDeliveryIds.has(backendId(delivery.id_entrega)));
}

function logisticsSelectedExpenseCreditor() {
  const selectedDelivery = logisticsSelectedExpenseDeliveries()[0];
  const selectedFleetId = backendId(selectedDelivery?.id_flete);
  if (!selectedFleetId) return null;

  return commercialEntryData.acreedores.find((creditor) => {
    const creditorOriginType = normalizeCategory(creditor.origen_tipo_acreedor || creditor.origen_tipo || "");
    return creditorOriginType.includes("flete") && backendId(creditor.origen_id_acreedor || creditor.origen_id) === selectedFleetId;
  }) || null;
}

function paymentDaysFromAgreement(value) {
  const agreementText = String(value || "").trim();
  if (!agreementText) return null;
  if (normalizeCategory(agreementText).includes("contado")) return 0;

  const directDays = Number(agreementText.replace(",", "."));
  if (Number.isFinite(directDays)) return Math.max(0, Math.trunc(directDays));

  const daysMatch = agreementText.match(/-?\d+(?:[,.]\d+)?/);
  if (!daysMatch) return null;
  const parsedDays = Number(daysMatch[0].replace(",", "."));
  return Number.isFinite(parsedDays) ? Math.max(0, Math.trunc(parsedDays)) : null;
}

function autofillLogisticsPaymentDateFromAgreement({ force = false } = {}) {
  const paymentInput = els["logistics-expense-payment-date"];
  const invoiceDateIso = parseDate(els["logistics-expense-invoice-date"]?.value);
  if (!paymentInput || !invoiceDateIso) return;

  const creditor = logisticsSelectedExpenseCreditor();
  const paymentDays = paymentDaysFromAgreement(creditor?.acuerdo_de_pago || creditor?.acuerda_de_pago || creditor?.acuerdo_pago);
  if (paymentDays === null) return;

  const canUpdate = force || !paymentInput.value || paymentInput.dataset.autoAgreement === "true";
  if (!canUpdate) return;

  paymentInput.value = toIsoDate(addDays(new Date(`${invoiceDateIso}T00:00:00`), paymentDays));
  paymentInput.dataset.autoAgreement = "true";
}

function updateLogisticsExpenseTotalFromInputs() {
  [
    "logistics-expense-subtotal",
    "logistics-expense-iva",
    "logistics-expense-vat-retention",
    "logistics-expense-iibb-retention",
    "logistics-expense-internal-taxes"
  ].forEach((id) => {
    const input = els[id];
    if (input && document.activeElement === input) input.dataset.touched = "true";
  });

  const totalCents = [
    "logistics-expense-subtotal",
    "logistics-expense-iva",
    "logistics-expense-vat-retention",
    "logistics-expense-iibb-retention",
    "logistics-expense-internal-taxes"
  ].reduce((sum, id) => sum + entryMoneyCents(id), 0);
  if (els["logistics-expense-total"]) els["logistics-expense-total"].value = formatMoneyInput(centsToMoney(totalCents));
}

function updateLogisticsFileName() {
  const file = els["logistics-file"]?.files?.[0];
  if (els["logistics-file-chip"]) els["logistics-file-chip"].classList.toggle("is-empty", !file);
  if (els["logistics-file-name"]) els["logistics-file-name"].textContent = file ? file.name : "Sin archivo";
  if (els["logistics-file-size"]) els["logistics-file-size"].textContent = file ? formatFileSize(file.size) : "-";
}

function setupLogisticsFileDropZone() {
  setupFileDropZone({
    dropZone: els["logistics-file-drop-zone"],
    input: els["logistics-file"],
    acceptFile: isReceptionReadableAttachment,
    respectDisabled: true,
    onAccepted: (file) => {
      updateLogisticsFileName();
      setCommercialStatus("logistics-expense-status", `Factura/remito listo: ${file.name}. Para completar el egreso, presiona Leer factura.`, "success");
    },
    onRejected: () => setCommercialStatus("logistics-expense-status", "Arrastra una imagen o PDF valido de factura/remito.", "error")
  });
}

function clearLogisticsFile() {
  if (els["logistics-file"]) els["logistics-file"].value = "";
  updateLogisticsFileName();
  setCommercialStatus("logistics-expense-status", "", "");
}

function updateLogisticsWithoutFile() {
  const withoutFile = Boolean(els["logistics-without-file"]?.checked);
  if (els["logistics-file"]) {
    els["logistics-file"].disabled = withoutFile;
    if (withoutFile) els["logistics-file"].value = "";
  }
  updateLogisticsFileName();
  if (withoutFile) {
    autofillLogisticsExpenseWithoutFile();
    setCommercialStatus("logistics-expense-status", "Sin remito ni factura: se completo como Remito X. Revisa los importes antes de guardar.", "pending");
  }
}

async function autofillLogisticsExpenseWithoutFile({ keepInvoiceNumber = false } = {}) {
  if (els["logistics-expense-invoice-type"]) els["logistics-expense-invoice-type"].value = "Remito_X";
  if (!keepInvoiceNumber && els["logistics-expense-invoice-number"]) {
    await setAutomaticLogisticsInvoiceNumber();
  }
  const today = toIsoDate(new Date());
  if (els["logistics-expense-invoice-date"] && !els["logistics-expense-invoice-date"].value) els["logistics-expense-invoice-date"].value = today;
  autofillLogisticsPaymentDateFromAgreement();
  if (els["logistics-expense-payment-date"] && !els["logistics-expense-payment-date"].value) els["logistics-expense-payment-date"].value = today;
  setLogisticsExpenseReferenceLabels("-", "-", "-");
}

async function setAutomaticLogisticsInvoiceNumber() {
  const input = els["logistics-expense-invoice-number"];
  if (!input) return;
  input.value = "Calculando nro...";
  try {
    input.value = await nextBackendPrimaryId("egresos", "id_egreso");
  } catch {
    input.value = "";
    setCommercialStatus("logistics-expense-status", "No se pudo calcular el nro automatico del remito. Completalo manualmente.", "error");
  }
}

function setLogisticsExpenseReferenceLabels(subtotal = "-", iva = "-", total = "-") {
  if (els["logistics-expense-subtotal-ref"]) els["logistics-expense-subtotal-ref"].textContent = subtotal;
  if (els["logistics-expense-iva-ref"]) els["logistics-expense-iva-ref"].textContent = iva;
  if (els["logistics-expense-total-ref"]) els["logistics-expense-total-ref"].textContent = total;
}

async function autofillLogisticsExpenseFromAttachment() {
  const readButton = els["logistics-invoice-read"];
  if (readButton?.disabled) return;
  const selectedDeliveryIds = selectedLogisticsExpenseDeliveryIds();
  const file = els["logistics-file"]?.files?.[0];
  if (!selectedDeliveryIds.length) {
    setCommercialStatus("logistics-expense-status", "Primero selecciona al menos una entrega.", "error");
    return;
  }
  if (els["logistics-without-file"]?.checked) {
    setCommercialStatus("logistics-expense-status", "Desmarca Sin remito ni factura para leer un archivo.", "error");
    return;
  }
  if (!file) {
    setCommercialStatus("logistics-expense-status", "Adjunta una factura o remito antes de leer.", "error");
    return;
  }
  if (!isReceptionReadableAttachment(file)) {
    setCommercialStatus("logistics-expense-status", "Adjunta una imagen o PDF valido de factura/remito.", "error");
    return;
  }

  const requestId = logisticsInvoiceReadRequestId + 1;
  logisticsInvoiceReadRequestId = requestId;
  setCommercialButtonLoading(readButton, true, "Leyendo...");
  setCommercialStatus("logistics-expense-status", "Leyendo factura/remito para precargar egreso logistico...", "pending");
  try {
    const fileDataUrl = await receptionAttachmentToDataUrl(file);
    const response = await fetch(`${API_BASE_URL}/api/reception-invoice/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileDataUrl,
        fileName: file.name,
        mimeType: file.type
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (requestId !== logisticsInvoiceReadRequestId) return;
    if (!response.ok || !payload.ok) {
      throw new Error(logisticsInvoiceReadErrorMessage(payload, response.status));
    }
    applyLogisticsInvoiceRead(payload.invoice || {});
    const missing = Array.isArray(payload.missingFields) ? payload.missingFields : [];
    const message = missing.length
      ? "Factura/remito leido parcialmente. Revisa los campos vacios antes de guardar."
      : "Factura/remito leido. Revisa y corrige los datos antes de guardar.";
    setCommercialStatus("logistics-expense-status", message, missing.length ? "pending" : "success");
  } catch (error) {
    const message = error instanceof TypeError
      ? "No se pudo contactar al servidor del ERP. Verifica que siga disponible e intenta nuevamente."
      : error.message;
    setCommercialStatus("logistics-expense-status", message, "error");
  } finally {
    setCommercialButtonLoading(readButton, false);
  }
}

function logisticsInvoiceReadErrorMessage(payload, status) {
  const messages = {
    INVALID_FILE: "El archivo no es un PDF o imagen valido. Selecciona otro archivo o completa los datos manualmente.",
    SERVICE_NOT_CONFIGURED: "La lectura automatica no esta configurada. Completa los datos manualmente o consulta al administrador.",
    PROVIDER_AUTHENTICATION: "La credencial de lectura no es valida o no tiene permiso. Consulta al administrador.",
    PROVIDER_QUOTA: "La lectura automatica alcanzo su limite de uso. Intenta mas tarde o consulta al administrador.",
    PROVIDER_MODEL: "El modelo configurado no esta disponible para leer este archivo. Consulta al administrador.",
    PROVIDER_REQUEST: "El servicio rechazo la solicitud de lectura. Consulta al administrador o completa los datos manualmente.",
    SERVICE_TIMEOUT: "La lectura automatica demoro demasiado. Intenta nuevamente en unos minutos o completa los datos manualmente.",
    SERVICE_UNAVAILABLE: "La lectura automatica no esta disponible temporalmente. Intenta nuevamente en unos minutos o completa los datos manualmente.",
    UNREADABLE_RESPONSE: "El servicio no pudo interpretar los datos de la factura. Revisa el archivo o completa los datos manualmente."
  };
  return messages[payload?.code]
    || (status >= 500
      ? messages.SERVICE_UNAVAILABLE
      : "No se pudo completar la lectura automatica. Intenta nuevamente o completa los datos manualmente.");
}

function applyLogisticsInvoiceRead(invoice) {
  const type = normalizeReceptionInvoiceType(invoice.tipo_factura || invoice.invoiceType);
  if (type && els["logistics-expense-invoice-type"]) els["logistics-expense-invoice-type"].value = type;
  if (invoice.nro_factura || invoice.invoiceNumber) els["logistics-expense-invoice-number"].value = String(invoice.nro_factura || invoice.invoiceNumber).trim();
  if (invoice.fecha_factura || invoice.invoiceDate) {
    els["logistics-expense-invoice-date"].value = parseDate(invoice.fecha_factura || invoice.invoiceDate) || els["logistics-expense-invoice-date"].value;
  }
  [
    ["logistics-expense-subtotal", invoice.subtotal],
    ["logistics-expense-iva", invoice.iva],
    ["logistics-expense-vat-retention", invoice.per_ret_iva],
    ["logistics-expense-iibb-retention", invoice.per_ret_iibb],
    ["logistics-expense-internal-taxes", invoice.imp_internos],
    ["logistics-expense-total", invoice.total]
  ].forEach(([id, value]) => {
    const number = parseMoney(value);
    if (els[id] && value !== null && value !== "" && Number.isFinite(number) && number >= 0) {
      els[id].value = decimalPurchaseDisplay(number);
      els[id].dataset.touched = "true";
    }
  });
  setLogisticsExpenseReferenceLabels("-", "-", "-");
  autofillLogisticsPaymentDateFromAgreement();
  if (!(invoice.total !== null && invoice.total !== "" && Number.isFinite(parseMoney(invoice.total)))) {
    updateLogisticsExpenseTotalFromInputs();
  }
}


async function createDeliveryForSelectedOrders() {
  const selectedOrderIds = selectedLogisticsOrderIds();
  const fleetId = els["logistics-delivery-fleet"]?.value || "";
  const deliveryDate = els["logistics-delivery-date"]?.value || toIsoDate(new Date());
  if (!selectedOrderIds.length) {
    setCommercialStatus("logistics-status", "Selecciona al menos un pedido para crear la entrega.", "error");
    return;
  }
  if (!fleetId) {
    setCommercialStatus("logistics-status", "Selecciona el flete de la entrega.", "error");
    return;
  }
  const button = els["logistics-delivery-create"];
  setCommercialButtonLoading(button, true, "Creando...");
  setCommercialStatus("logistics-status", "Creando entrega...", "pending");

  try {
    const result = await requestBackendApi("/api/sales/deliveries/full-entry", {
      method: "POST",
      body: JSON.stringify({ orderIds: selectedOrderIds, fleetId, deliveryDate })
    });
    const deliveryId = result.deliveryId;
    setCommercialStatus("logistics-status", `Entrega #${deliveryId} creada con ${selectedOrderIds.length} pedido(s).`, "success");
    commercialEntryData.loaded = false;
    await loadCommercialEntryData(true);
  } catch (error) {
    setCommercialStatus("logistics-status", `No se pudo crear la entrega: ${error.message}`, "error");
  } finally {
    setCommercialButtonLoading(button, false);
  }
}

async function submitLogisticsExpenseEntry(event) {
  event.preventDefault();
  const selectedDeliveryIds = selectedLogisticsExpenseDeliveryIds();
  if (!selectedDeliveryIds.length) {
    setCommercialStatus("logistics-expense-status", "Selecciona al menos una entrega para asociar al egreso.", "error");
    return;
  }

  const invoiceType = backendId(els["logistics-expense-invoice-type"]?.value);
  const invoiceNumber = backendId(els["logistics-expense-invoice-number"]?.value);
  const invoiceDate = backendId(els["logistics-expense-invoice-date"]?.value);
  const total = entryMoneyValue("logistics-expense-total");
  if (!invoiceType || !invoiceNumber || !invoiceDate || total <= 0) {
    setCommercialStatus("logistics-expense-status", "Completa tipo, numero, fecha y total del egreso.", "error");
    return;
  }

  const button = event.submitter || els["logistics-expense-submit"];
  setCommercialButtonLoading(button, true, "Guardando...");
  setCommercialStatus("logistics-expense-status", "Guardando egreso logistico...", "pending");

  try {
    const expenseId = await nextBackendPrimaryId("egresos", "id_egreso");
    const logisticsLabelId = logisticsExpenseLabelId();
    const selectedDeliveries = commercialEntryData.entregas.filter((delivery) => selectedDeliveryIds.includes(backendId(delivery.id_entrega)));

    await saveBackendEntryRows("egresos", [{
      id_egreso: expenseId,
      fecha_factura: invoiceDate,
      fecha_prevista_pago: backendId(els["logistics-expense-payment-date"]?.value) || invoiceDate,
      id_etiqueta: logisticsLabelId,
      tipo_factura: invoiceType,
      nro_factura: invoiceNumber,
      iva: entryMoneyValue("logistics-expense-iva"),
      per_ret_iva: entryMoneyValue("logistics-expense-vat-retention"),
      per_ret_iibb: entryMoneyValue("logistics-expense-iibb-retention"),
      imp_internos: entryMoneyValue("logistics-expense-internal-taxes"),
      subtotal: entryMoneyValue("logistics-expense-subtotal"),
      total
    }]);

    await saveBackendEntryRows("entregas", selectedDeliveries.map((delivery) => ({
      ...delivery,
      id_egreso: expenseId
    })));

    event.target.reset();
    commercialEntryData.loaded = false;
    await loadCommercialEntryData(true);
    setCommercialStatus("logistics-expense-status", `Egreso logistico #${expenseId} guardado y asociado a ${selectedDeliveryIds.length} entrega(s).`, "success");
  } catch (error) {
    setCommercialStatus("logistics-expense-status", `No se pudo guardar el egreso logistico: ${error.message}`, "error");
  } finally {
    setCommercialButtonLoading(button, false);
  }
}


function resetLogisticsExpenseFormState() {
  if (els["logistics-file"]) els["logistics-file"].disabled = false;
  if (els["logistics-expense-payment-date"]) delete els["logistics-expense-payment-date"].dataset.autoAgreement;
  [
    "logistics-expense-subtotal",
    "logistics-expense-iva",
    "logistics-expense-vat-retention",
    "logistics-expense-iibb-retention",
    "logistics-expense-internal-taxes",
    "logistics-expense-total"
  ].forEach((id) => {
    if (els[id]) delete els[id].dataset.touched;
  });
  updateLogisticsFileName();
  setLogisticsExpenseReferenceLabels("-", "-", "-");
}

function logisticsExpenseLabelId() {
  const label = commercialEntryData.etiquetas.find((row) => normalizeCategory(row.etiqueta || row.nombre).includes("logistica"));
  return backendId(label?.id_etiqueta);
}

