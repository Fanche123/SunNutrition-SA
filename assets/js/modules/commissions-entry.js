function commissionRowsForSelectedPeriod({ ignoreChannelFilter = false } = {}) {
  const selectedChannelId = ignoreChannelFilter ? "" : backendId(els["commissions-channel-filter"]?.value);
  const selectedMonth = selectedCommissionMonthKey();
  const clientsById = mapRowsById(commercialEntryData.clientes, "id_cliente");
  const salesById = mapRowsById(commercialEntryData.ventas, "id_venta");
  const channelsById = mapRowsById(commercialEntryData.canales, "id_canal");
  const detailsByCollectionId = groupRowsById(commercialEntryData.cobros_detalle, "id_cobro");

  return commercialEntryData.cobros
    .filter((collection) => {
      const date = parseDate(collection.fecha_cobro);
      return Boolean(date) && date.slice(0, 7) === selectedMonth;
    })
    .map((collection) => {
      const detailRows = detailsByCollectionId.get(backendId(collection.id_cobro)) || [];
      const saleCalculations = detailRows.map((detail) => {
        const sale = salesById.get(backendId(detail.id_venta));
        if (!sale) return null;
        const client = clientsById.get(backendId(sale.id_cliente || collection.id_cliente));
        const channel = channelsById.get(backendId(client?.id_canal));
        const channelId = backendId(channel?.id_canal);
        if (selectedChannelId && channelId !== selectedChannelId) return null;
        const totalCents = moneyToCents(sale.total);
        const subtotalCents = moneyToCents(sale.subtotal);
        const paidCents = Math.max(0, Math.min(totalCents, moneyToCents(detail.monto_cancelado)));
        const commissionRate = parseCommissionRate(channel?.comision);

        /*
          Comision economica:
          se paga sobre el subtotal proporcionalmente cobrado. Si el cliente paga
          una parte de una factura con IVA, esa misma proporcion aplica al subtotal.
        */
        const commissionableSubtotalCents = totalCents > 0
          ? proportionalCommissionCents(subtotalCents, paidCents, totalCents)
          : 0;
        const commissionCents = ErpMoney.multiplyCents(
          centsToMoney(commissionableSubtotalCents),
          commissionRate
        );
        return {
          sale,
          client,
          channel,
          paidAmount: centsToMoney(paidCents),
          commissionRate,
          commissionableSubtotal: centsToMoney(commissionableSubtotalCents),
          commission: centsToMoney(commissionCents)
        };
      }).filter(Boolean);

      if (!saleCalculations.length) return null;
      const firstSale = saleCalculations[0];
      const mixedChannels = new Set(saleCalculations.map((row) => backendId(row.channel?.id_canal))).size > 1;
      const invoiceLabels = saleCalculations.map((row) => row.sale.nro_factura || row.sale.id_venta || "-");
      const commissionableSubtotal = centsToMoney(saleCalculations.reduce(
        (sumCents, row) => sumCents + moneyToCents(row.commissionableSubtotal),
        0
      ));
      const commission = centsToMoney(saleCalculations.reduce(
        (sumCents, row) => sumCents + moneyToCents(row.commission),
        0
      ));
      const collectedAmount = centsToMoney(saleCalculations.reduce(
        (sumCents, row) => sumCents + moneyToCents(row.paidAmount),
        0
      ));
      const weightedRate = commissionableSubtotal ? commission / commissionableSubtotal : 0;

      return {
        collection,
        clientName: clientNameFromMap(collection.id_cliente || firstSale.sale.id_cliente, clientsById),
        channelName: mixedChannels ? "Varios canales" : displayNameLabel(firstSale.channel?.nombre || "Sin canal"),
        invoiceLabels,
        collectedAmount,
        commissionableSubtotal,
        commissionRate: weightedRate,
        commission,
        saleCalculations
      };
    })
    .filter(Boolean)
    .sort((left, right) => String(left.collection.fecha_cobro || "").localeCompare(String(right.collection.fecha_cobro || "")));
}

function ensureCommissionMonthFilter() {
  const input = els["commissions-month-filter"];
  if (!input || input.value) return;
  input.value = `${state.selectedYear}-${String(state.selectedMonth + 1).padStart(2, "0")}`;
}

function selectedCommissionMonthKey() {
  ensureCommissionMonthFilter();
  return String(els["commissions-month-filter"]?.value || "");
}

function selectedCommissionExpenseRows() {
  const selectedIds = new Set([...selectedCommissionCollectionIds].map(comparableLookupId));
  return commissionRowsForSelectedPeriod().filter((row) => selectedIds.has(comparableLookupId(row.collection.id_cobro)));
}

function commissionSelectedChannelId(rows) {
  const channelIds = new Set();
  rows.forEach((row) => row.saleCalculations.forEach((saleRow) => {
    const channelId = backendId(saleRow.channel?.id_canal);
    if (channelId) channelIds.add(channelId);
  }));
  return channelIds.size === 1 ? [...channelIds][0] : "";
}

function commissionCreditorTagForChannel(channelId) {
  const creditor = commercialEntryData.acreedores.find((row) => (
    normalizeCategory(row.origen_tipo_acreedor || row.origen_tipo || "").includes("canal")
    && comparableLookupId(row.origen_id_acreedor || row.origen_id) === comparableLookupId(channelId)
  ));
  if (!creditor) return null;

  const creditorTag = commercialEntryData.acreedores_etiquetas
    .filter((row) => comparableLookupId(row.id_acreedor) === comparableLookupId(creditor.id_acreedor))
    .sort((left, right) => Number(left.id_acreedor_etiqueta || 0) - Number(right.id_acreedor_etiqueta || 0))[0];
  return creditorTag ? { creditor, creditorTag } : null;
}

function updateCommissionExpenseDraft() {
  const rows = selectedCommissionExpenseRows();
  const selection = els["commissions-expense-selection"];
  if (selection) selection.textContent = `${rows.length} cobro${rows.length === 1 ? "" : "s"} seleccionado${rows.length === 1 ? "" : "s"}`;

  if (!rows.length) {
    updateCommissionExpenseTotal();
    return;
  }

  const subtotalCents = rows.reduce((sumCents, row) => sumCents + moneyToCents(row.commission), 0);
  const subtotalInput = els["commissions-expense-subtotal"];
  if (subtotalInput && subtotalInput.dataset.touched !== "true") {
    subtotalInput.value = formatMoneyInput(centsToMoney(subtotalCents));
  }

  const latestCollectionDate = rows.reduce((latest, row) => (
    String(row.collection.fecha_cobro || "") > latest ? String(row.collection.fecha_cobro || "") : latest
  ), "");
  if (els["commissions-expense-invoice-date"] && !els["commissions-expense-invoice-date"].value) {
    els["commissions-expense-invoice-date"].value = latestCollectionDate || toIsoDate(new Date());
  }

  const invoiceType = backendId(els["commissions-expense-invoice-type"]?.value);
  const ivaInput = els["commissions-expense-iva"];
  if (ivaInput && ivaInput.dataset.touched !== "true") {
    const ivaCents = invoiceType === "Factura_A"
      ? ErpMoney.percentageCents(entryMoneyValue("commissions-expense-subtotal"), 21)
      : 0;
    ivaInput.value = formatMoneyInput(centsToMoney(ivaCents));
  }
  updateCommissionExpenseTotal();
}

function updateCommissionExpenseTotal() {
  const totalInput = els["commissions-expense-total"];
  if (!totalInput || totalInput.dataset.touched === "true") return;
  const totalCents = [
    "commissions-expense-subtotal",
    "commissions-expense-iva",
    "commissions-expense-vat-retention",
    "commissions-expense-iibb-retention",
    "commissions-expense-internal-taxes"
  ].reduce((sum, id) => sum + entryMoneyCents(id), 0);
  totalInput.value = totalCents ? formatMoneyInput(centsToMoney(totalCents)) : "";
}

function updateCommissionExpenseFileName() {
  const file = els["commissions-expense-file"]?.files?.[0];
  if (els["commissions-expense-file-chip"]) els["commissions-expense-file-chip"].classList.toggle("is-empty", !file);
  if (els["commissions-expense-file-name"]) els["commissions-expense-file-name"].textContent = file ? file.name : "Sin archivo";
  if (els["commissions-expense-file-size"]) els["commissions-expense-file-size"].textContent = file ? formatFileSize(file.size) : "-";
}

function setupCommissionExpenseFileDropZone() {
  setupFileDropZone({
    dropZone: els["commissions-expense-file-drop-zone"],
    input: els["commissions-expense-file"],
    acceptFile: isReceptionReadableAttachment,
    respectDisabled: true,
    onAccepted: (file) => {
      updateCommissionExpenseFileName();
      setCommercialStatus("commissions-expense-status", `Factura lista: ${file.name}. Para completar los campos compatibles, presioná Leer factura.`, "success");
    },
    onRejected: () => setCommercialStatus("commissions-expense-status", "Arrastrá una imagen o un PDF válido de la factura.", "error")
  });
}

function clearCommissionExpenseFile() {
  commissionsExpenseInvoiceReadRequestId += 1;
  if (els["commissions-expense-file"]) els["commissions-expense-file"].value = "";
  updateCommissionExpenseFileName();
  setCommercialStatus("commissions-expense-status", "", "");
}

function canAutofillCommissionExpenseField(id) {
  const input = els[id];
  return Boolean(input && (input.dataset.touched !== "true" || !String(input.value || "").trim()));
}

async function autofillCommissionExpenseFromAttachment() {
  const file = els["commissions-expense-file"]?.files?.[0];
  if (!file) {
    setCommercialStatus("commissions-expense-status", "Adjuntá una factura antes de leer.", "error");
    return;
  }
  if (!isReceptionReadableAttachment(file)) {
    setCommercialStatus("commissions-expense-status", "Adjuntá una imagen o un PDF válido de la factura.", "error");
    return;
  }

  const requestId = commissionsExpenseInvoiceReadRequestId + 1;
  commissionsExpenseInvoiceReadRequestId = requestId;
  setCommercialStatus("commissions-expense-status", "Leyendo factura para precargar el egreso de comisiones...", "pending");
  try {
    const fileDataUrl = await receptionAttachmentToDataUrl(file);
    const response = await fetch(`${API_BASE_URL}/api/reception-invoice/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileDataUrl, fileName: file.name, mimeType: file.type })
    });
    const payload = await response.json().catch(() => ({}));
    if (requestId !== commissionsExpenseInvoiceReadRequestId) return;
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    applyCommissionExpenseInvoiceRead(payload.invoice || {});
    setCommercialStatus("commissions-expense-status", "Factura leída. Revisá y corregí los datos antes de guardar.", "success");
  } catch (error) {
    setCommercialStatus("commissions-expense-status", `No se pudo leer automáticamente: ${error.message}. Completá o corregí los datos manualmente.`, "error");
  }
}

function applyCommissionExpenseInvoiceRead(invoice) {
  const simpleFields = [
    ["commissions-expense-invoice-type", normalizeReceptionInvoiceType(invoice.tipo_factura || invoice.invoiceType)],
    ["commissions-expense-invoice-number", invoice.nro_factura || invoice.invoiceNumber],
    ["commissions-expense-invoice-date", parseDate(invoice.fecha_factura || invoice.invoiceDate)]
  ];
  simpleFields.forEach(([id, value]) => {
    if (value && canAutofillCommissionExpenseField(id)) {
      els[id].value = String(value).trim();
      els[id].dataset.touched = "true";
    }
  });
  [
    ["commissions-expense-subtotal", invoice.subtotal],
    ["commissions-expense-iva", invoice.iva],
    ["commissions-expense-vat-retention", invoice.per_ret_iva],
    ["commissions-expense-iibb-retention", invoice.per_ret_iibb],
    ["commissions-expense-internal-taxes", invoice.imp_internos],
    ["commissions-expense-total", invoice.total]
  ].forEach(([id, value]) => {
    const number = parseMoney(value);
    if (canAutofillCommissionExpenseField(id) && Number.isFinite(number) && number >= 0) {
      els[id].value = decimalPurchaseDisplay(number);
      els[id].dataset.touched = "true";
    }
  });
  updateCommissionExpenseTotal();
}

async function submitCommissionExpenseEntry(event) {
  event.preventDefault();
  const rows = selectedCommissionExpenseRows();
  const channelId = commissionSelectedChannelId(rows);
  const relation = commissionCreditorTagForChannel(channelId);
  const invoiceType = backendId(els["commissions-expense-invoice-type"]?.value);
  const invoiceNumber = backendId(els["commissions-expense-invoice-number"]?.value);
  const invoiceDate = parseDate(els["commissions-expense-invoice-date"]?.value);
  const total = entryMoneyValue("commissions-expense-total");

  if (!rows.length || !channelId) {
    setCommercialStatus("commissions-expense-status", "Selecciona cobros de un unico canal para generar el egreso.", "error");
    return;
  }
  if (!relation) {
    setCommercialStatus("commissions-expense-status", "El canal seleccionado no tiene acreedor y etiqueta configurados.", "error");
    return;
  }
  if (!invoiceType || !invoiceNumber || !invoiceDate || total <= 0) {
    setCommercialStatus("commissions-expense-status", "Completa tipo, numero, fecha y total del egreso.", "error");
    return;
  }

  const button = event.submitter || els["commissions-expense-submit"];
  setCommercialButtonLoading(button, true, "Guardando...");
  setCommercialStatus("commissions-expense-status", "Guardando comisiones y egreso...", "pending");

  try {
    const [expenseId, commissionStartId] = await Promise.all([
      nextBackendPrimaryId("egresos", "id_egreso"),
      nextBackendPrimaryIdOrOne("comisiones", "id_comision")
    ]);
    const labelId = await tagIdFromCreditorTagId(relation.creditorTag.id_acreedor_etiqueta);
    const commissionRows = rows.flatMap((row) => row.saleCalculations.map((saleRow) => ({
      fecha: row.collection.fecha_cobro,
      id_canal: channelId,
      id_acreedor_etiqueta: relation.creditorTag.id_acreedor_etiqueta,
      id_egreso: String(expenseId),
      id_venta: saleRow.sale.id_venta,
      subtotal: normalizeMoney(saleRow.commissionableSubtotal),
      comision: normalizeMoney(saleRow.commission)
    }))).map((row, index) => ({ ...row, id_comision: String(Number(commissionStartId) + index) }));

    await saveBackendEntryRows("egresos", [{
      id_egreso: String(expenseId),
      fecha_factura: invoiceDate,
      fecha_prevista_pago: parseDate(els["commissions-expense-payment-date"]?.value) || invoiceDate,
      id_etiqueta: labelId,
      tipo_factura: invoiceType,
      nro_factura: invoiceNumber,
      iva: entryMoneyValue("commissions-expense-iva"),
      per_ret_iva: entryMoneyValue("commissions-expense-vat-retention"),
      per_ret_iibb: entryMoneyValue("commissions-expense-iibb-retention"),
      imp_internos: entryMoneyValue("commissions-expense-internal-taxes"),
      subtotal: entryMoneyValue("commissions-expense-subtotal"),
      total
    }]);
    await saveBackendEntryRows("comisiones", commissionRows);

    selectedCommissionCollectionIds = new Set();
    event.target.reset();
    [
      "commissions-expense-invoice-type",
      "commissions-expense-invoice-number",
      "commissions-expense-invoice-date",
      "commissions-expense-payment-date",
      "commissions-expense-subtotal",
      "commissions-expense-iva",
      "commissions-expense-vat-retention",
      "commissions-expense-iibb-retention",
      "commissions-expense-internal-taxes",
      "commissions-expense-total"
    ].forEach((id) => {
      delete els[id]?.dataset.touched;
    });
    commissionsExpenseInvoiceReadRequestId += 1;
    updateCommissionExpenseFileName();
    if (els["commissions-expense-invoice-type"]) els["commissions-expense-invoice-type"].value = "Factura_C";
    commercialEntryData.loaded = false;
    await loadCommercialEntryData(true);
    setCommercialStatus("commissions-expense-status", `Egreso de comisiones #${expenseId} guardado y asociado a ${rows.length} cobro(s).`, "success");
  } catch (error) {
    setCommercialStatus("commissions-expense-status", `No se pudo guardar el egreso de comisiones: ${error.message}`, "error");
  } finally {
    setCommercialButtonLoading(button, false);
  }
}

function parseCommissionRate(value) {
  const rate = parseQuantity(value);
  return rate > 1 ? rate / 100 : rate;
}

function proportionalCommissionCents(subtotalCents, paidCents, totalCents) {
  if (totalCents <= 0 || paidCents <= 0 || subtotalCents <= 0) return 0;
  const denominator = BigInt(totalCents);
  return Number(
    ((BigInt(subtotalCents) * BigInt(paidCents)) + (denominator / 2n))
      / denominator
  );
}

function formatCommissionRate(value) {
  return new Intl.NumberFormat("es-AR", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(value || 0);
}

function commissionSelectableCheckboxes() {
  return [...(els["commissions-collection-body"]?.querySelectorAll("[data-commission-collection-select]") || [])]
    .filter((checkbox) => !checkbox.disabled);
}

function syncCommissionSelectAllButton() {
  const toggle = els["commissions-select-all"];
  if (!toggle) return;
  const checkboxes = commissionSelectableCheckboxes();
  const selectedCount = checkboxes.filter((checkbox) => checkbox.checked).length;
  toggle.disabled = checkboxes.length === 0;
  toggle.checked = checkboxes.length > 0 && selectedCount === checkboxes.length;
  toggle.indeterminate = selectedCount > 0 && selectedCount < checkboxes.length;
}

function toggleAllVisibleCommissionRows() {
  const toggle = els["commissions-select-all"];
  const checkboxes = commissionSelectableCheckboxes();
  if (!toggle || !checkboxes.length) {
    syncCommissionSelectAllButton();
    return;
  }
  const shouldSelect = toggle.checked;
  checkboxes.forEach((checkbox) => {
    checkbox.checked = shouldSelect;
    const collectionId = backendId(checkbox.dataset.commissionCollectionSelect);
    if (shouldSelect) selectedCommissionCollectionIds.add(collectionId);
    else selectedCommissionCollectionIds.delete(collectionId);
  });
  syncCommissionSelectAllButton();
  updateCommissionExpenseDraft();
}


function renderCommissionsEntry() {
  ensureCommissionMonthFilter();
  fillCommissionChannelOptions();

  const body = els["commissions-collection-body"];
  if (!body) return;

  const rows = commissionRowsForSelectedPeriod();
  if (els["commissions-download-png"]) els["commissions-download-png"].disabled = rows.length === 0;
  const visibleCollectionIds = new Set(rows.map((row) => backendId(row.collection.id_cobro)));
  selectedCommissionCollectionIds = new Set(
    [...selectedCommissionCollectionIds].filter((collectionId) => visibleCollectionIds.has(collectionId))
  );
  const summary = rows.reduce((totals, row) => {
    totals.collections += 1;
    totals.commissionableSubtotal = centsToMoney(
      moneyToCents(totals.commissionableSubtotal) + moneyToCents(row.commissionableSubtotal)
    );
    totals.commission = centsToMoney(
      moneyToCents(totals.commission) + moneyToCents(row.commission)
    );
    return totals;
  }, { collections: 0, commissionableSubtotal: 0, commission: 0 });

  if (els["commissions-summary-collections"]) els["commissions-summary-collections"].textContent = String(summary.collections);
  if (els["commissions-summary-subtotal"]) els["commissions-summary-subtotal"].textContent = formatMoney(summary.commissionableSubtotal);
  if (els["commissions-summary-commission"]) els["commissions-summary-commission"].textContent = formatMoney(summary.commission);
  setEntryStatus("commissions-status", rows.length ? "" : "No hay cobros comisionables para el mes y canal seleccionados.", rows.length ? "" : "pending");

  body.innerHTML = rows.length ? rows.map((row) => `
    <tr>
      <td><input type="checkbox" data-commission-collection-select="${escapeHtml(row.collection.id_cobro)}"${selectedCommissionCollectionIds.has(backendId(row.collection.id_cobro)) ? " checked" : ""} aria-label="Seleccionar cobro"></td>
      <td>${formatDate(row.collection.fecha_cobro)}</td>
      <td>${escapeHtml(row.clientName)}</td>
      <td>${escapeHtml(row.invoiceLabels.join(", ") || "-")}</td>
      <td>${escapeHtml(displayNameLabel(row.collection.metodo || "-"))}</td>
      <td class="num">${formatMoney(row.collectedAmount)}</td>
      <td class="num">${formatMoney(row.commissionableSubtotal)}</td>
      <td class="num">${formatCommissionRate(row.commissionRate)}</td>
      <td class="num">${formatMoney(row.commission)}</td>
    </tr>
  `).join("") : `<tr><td class="empty" colspan="9">No hay cobros comisionables para el mes y canal seleccionados.</td></tr>`;
  syncCommissionSelectAllButton();
  updateCommissionExpenseDraft();
}

function fillCommissionChannelOptions() {
  const select = els["commissions-channel-filter"];
  if (!select) return;

  const current = select.value;
  const channelsById = new Map();
  commissionRowsForSelectedPeriod({ ignoreChannelFilter: true }).forEach((row) => {
    row.saleCalculations.forEach(({ channel }) => {
      const value = backendId(channel?.id_canal);
      if (!value || channelsById.has(value)) return;
      channelsById.set(value, {
        value,
        label: displayNameLabel(String(channel?.nombre || value).trim())
      });
    });
  });
  const channels = [...channelsById.values()]
    .sort((left, right) => left.label.localeCompare(right.label, "es", { sensitivity: "base" }));
  select.innerHTML = `<option value="">Todos los canales</option>${channels.map((channel) => {
    return `<option value="${escapeHtml(channel.value)}">${escapeHtml(channel.label)}</option>`;
  }).join("")}`;
  select.value = channels.some((channel) => channel.value === current) ? current : "";
  select.disabled = channels.length === 0;
}

async function downloadCommissionsPng() {
  const button = els["commissions-download-png"];
  const rows = commissionRowsForSelectedPeriod();
  if (!button || button.disabled || !rows.length) return;
  const monthKey = selectedCommissionMonthKey();

  setCommercialButtonLoading(button, true, "Generando...");
  setCommercialStatus("commissions-status", "Generando reporte PNG...", "pending");
  try {
    const summary = rows.reduce((totals, row) => {
      totals.commissionableSubtotal = centsToMoney(
        moneyToCents(totals.commissionableSubtotal) + moneyToCents(row.commissionableSubtotal)
      );
      totals.commission = centsToMoney(
        moneyToCents(totals.commission) + moneyToCents(row.commission)
      );
      return totals;
    }, { commissionableSubtotal: 0, commission: 0 });
    const scale = 2;
    const width = 1560;
    const padding = 42;
    const titleHeight = 92;
    const cardsHeight = 112;
    const headerHeight = 54;
    const columns = [
      { label: "Fecha cobro", width: 130, align: "left", value: (row) => formatDate(row.collection.fecha_cobro) },
      { label: "Cliente", width: 220, align: "left", value: (row) => row.clientName },
      { label: "Facturas", width: 260, align: "left", value: (row) => row.invoiceLabels.join(", ") || "-" },
      { label: "Método", width: 160, align: "left", value: (row) => displayNameLabel(row.collection.metodo || "-") },
      { label: "Cobrado", width: 175, align: "right", value: (row) => formatMoney(row.collectedAmount) },
      { label: "Subtotal comisionable", width: 220, align: "right", value: (row) => formatMoney(row.commissionableSubtotal) },
      { label: "% comisión", width: 135, align: "right", value: (row) => formatCommissionRate(row.commissionRate) },
      { label: "Comisión", width: 175, align: "right", value: (row) => formatMoney(row.commission) }
    ];
    const measuringCanvas = document.createElement("canvas");
    const measuringContext = measuringCanvas.getContext("2d");
    measuringContext.font = "400 16px Arial, sans-serif";
    const rowLayouts = rows.map((row) => {
      const lines = columns.map((column) => wrapCommissionCanvasText(
        measuringContext,
        column.value(row),
        column.width - 20
      ));
      return { row, lines, height: Math.max(48, Math.max(...lines.map((values) => values.length)) * 21 + 20) };
    });
    const height = padding + titleHeight + cardsHeight + headerHeight
      + rowLayouts.reduce((total, layout) => total + layout.height, 0) + padding;
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);

    const monthLabel = commissionMonthLabel(monthKey);
    context.fillStyle = "#0d1f33";
    context.font = "800 30px Arial, sans-serif";
    context.textAlign = "center";
    context.fillText(`Comisiones del mes de ${monthLabel}`, width / 2, padding + 38);
    context.textAlign = "left";

    const cards = [
      ["Cobros del período", String(rows.length)],
      ["Subtotal comisionable", formatMoney(summary.commissionableSubtotal)],
      ["Total comisiones", formatMoney(summary.commission)]
    ];
    const cardGap = 18;
    const cardWidth = (width - padding * 2 - cardGap * 2) / 3;
    const cardsTop = padding + titleHeight;
    cards.forEach(([label, value], index) => {
      const x = padding + index * (cardWidth + cardGap);
      context.fillStyle = "#f3f8f8";
      context.fillRect(x, cardsTop, cardWidth, 82);
      context.fillStyle = "#526173";
      context.font = "700 15px Arial, sans-serif";
      context.fillText(label, x + 18, cardsTop + 28);
      context.fillStyle = "#073f46";
      context.font = "800 24px Arial, sans-serif";
      context.fillText(value, x + 18, cardsTop + 61);
    });

    let y = cardsTop + cardsHeight;
    context.fillStyle = "#e8f1f3";
    context.fillRect(padding, y, width - padding * 2, headerHeight);
    let x = padding;
    context.font = "800 15px Arial, sans-serif";
    columns.forEach((column) => {
      context.fillStyle = "#294052";
      context.textAlign = column.align;
      context.fillText(column.label, column.align === "right" ? x + column.width - 10 : x + 10, y + 33);
      x += column.width;
    });

    y += headerHeight;
    rowLayouts.forEach((layout, rowIndex) => {
      if (rowIndex % 2 === 1) {
        context.fillStyle = "#fafcfd";
        context.fillRect(padding, y, width - padding * 2, layout.height);
      }
      x = padding;
      context.font = "400 16px Arial, sans-serif";
      columns.forEach((column, columnIndex) => {
        context.fillStyle = columnIndex >= 4 ? "#17334f" : "#465463";
        context.textAlign = column.align;
        layout.lines[columnIndex].forEach((line, lineIndex) => {
          context.fillText(line, column.align === "right" ? x + column.width - 10 : x + 10, y + 29 + lineIndex * 21);
        });
        x += column.width;
      });
      context.strokeStyle = "#e2e8f0";
      context.beginPath();
      context.moveTo(padding, y + layout.height);
      context.lineTo(width - padding, y + layout.height);
      context.stroke();
      y += layout.height;
    });
    context.textAlign = "left";

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error("No se pudo generar la imagen.")), "image/png");
    });
    const objectUrl = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      link.download = `comisiones-${monthKey}.png`;
      link.href = objectUrl;
      link.click();
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
    setCommercialStatus("commissions-status", "Reporte PNG descargado.", "success");
  } catch (error) {
    setCommercialStatus("commissions-status", `No se pudo generar el reporte PNG: ${error.message}`, "error");
  } finally {
    setCommercialButtonLoading(button, false);
  }
}

function commissionMonthLabel(monthKey) {
  const [year, month] = String(monthKey || "").split("-").map(Number);
  if (!year || !month) return "periodo seleccionado";
  return new Intl.DateTimeFormat("es-AR", { month: "long", year: "numeric" })
    .format(new Date(year, month - 1, 1));
}

function wrapCommissionCanvasText(context, value, maxWidth) {
  const words = String(value || "-").trim().split(/\s+/);
  const lines = [];
  let current = "";
  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (current && context.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  });
  if (current) lines.push(current);
  return lines.length ? lines : ["-"];
}

