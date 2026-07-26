function renderCollectionsEntry() {
  fillCollectionClientOptions(pendingSalesRows());
  if (els["collection-date"] && !els["collection-date"].value) els["collection-date"].value = toIsoDate(new Date());

  const clientId = els["collection-client"]?.value || "";
  const rows = clientId ? pendingSalesRows(clientId) : [];
  const body = els["collections-invoice-body"];
  if (!body) return;

  body.innerHTML = rows.length ? rows.map((row) => `
    <tr data-collection-sale="${escapeHtml(row.sale.id_venta)}">
      <td><input type="checkbox" data-collection-select></td>
      <td>${escapeHtml(row.sale.nro_factura || row.sale.id_venta || "-")}</td>
      <td>${formatDate(row.sale.fecha_factura)}</td>
      <td class="num">${formatBankMoney(row.balance)}</td>
      <td><input type="checkbox" data-collection-full checked></td>
      <td><input type="text" inputmode="decimal" data-money-input data-collection-amount value="${escapeHtml(formatMoneyInput(row.balance))}"></td>
    </tr>
  `).join("") : `<tr><td class="empty" colspan="6">Este cliente no tiene facturas pendientes.</td></tr>`;
  updateCollectionTotal();
}

function fillCollectionClientOptions(pendingRows) {
  const select = els["collection-client"];
  if (!select) return;

  const current = select.value;
  const clientIdsWithDebt = new Set(pendingRows.map((row) => backendId(row.sale.id_cliente)));
  const debtClients = commercialEntryData.clientes
    .filter((client) => clientIdsWithDebt.has(backendId(client.id_cliente)))
    .sort((left, right) => {
      return displayNameLabel(left.nombre_cliente || left.nombre)
        .localeCompare(displayNameLabel(right.nombre_cliente || right.nombre));
    });

  const options = debtClients.map((client) => {
    const value = backendId(client.id_cliente);
    const label = displayNameLabel(client.nombre_cliente || client.nombre || value);
    return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
  }).join("");

  select.innerHTML = `<option value="">Elegir cliente con saldo</option>${options}`;
  select.value = clientIdsWithDebt.has(backendId(current)) ? current : "";
}

function updateCollectionTotal() {
  const invoiceTotalCents = collectionSelectedRows().reduce((acc, row) => acc + moneyToCents(row.amount), 0);
  const retentions = collectionRetentionAmounts();
  const retentionsCents = moneyToCents(retentions.total);
  const expectedReceivedCents = Math.max(0, invoiceTotalCents - retentionsCents);
  const receivedInput = els["collection-received-total"];
  if (receivedInput && !receivedInput.dataset.touched) {
    receivedInput.value = formatMoneyInput(centsToMoney(expectedReceivedCents));
  }

  const receivedCents = Math.max(0, entryMoneyCents("collection-received-total", { allowNegative: false }));
  const differenceCents = receivedCents + retentionsCents - invoiceTotalCents;
  const received = centsToMoney(receivedCents);
  if (els["collection-total"]) els["collection-total"].textContent = formatBankMoney(received);
  if (els["collection-retentions-total"]) els["collection-retentions-total"].textContent = formatBankMoney(retentions.total);
  if (els["collection-invoices-total"]) els["collection-invoices-total"].textContent = formatBankMoney(centsToMoney(invoiceTotalCents));
  if (els["collection-difference"]) {
    els["collection-difference"].textContent = formatBankMoney(centsToMoney(differenceCents));
    els["collection-difference"].classList.toggle("is-unbalanced", differenceCents !== 0);
  }
}

function collectionRetentionAmounts() {
  const incomeTaxCents = Math.max(0, entryMoneyCents("collection-income-tax-retention", { allowNegative: false }));
  const grossRevenueCents = Math.max(0, entryMoneyCents("collection-iibb-retention", { allowNegative: false }));
  return {
    incomeTax: centsToMoney(incomeTaxCents),
    grossRevenue: centsToMoney(grossRevenueCents),
    total: centsToMoney(incomeTaxCents + grossRevenueCents)
  };
}

function collectionSelectedRows() {
  return [...document.querySelectorAll("[data-collection-sale]")].map((row) => {
    const selected = row.querySelector("[data-collection-select]")?.checked;
    const amountInput = row.querySelector("[data-collection-amount]");
    const fullInput = row.querySelector("[data-collection-full]");
    const saleId = row.dataset.collectionSale;
    const pending = pendingSalesRows(els["collection-client"]?.value).find((saleRow) => backendId(saleRow.sale.id_venta) === backendId(saleId));
    const parsed = parseMoneyInput(amountInput?.value || "", { allowEmpty: true, allowNegative: false });
    const amountCents = fullInput?.checked
      ? moneyToCents(pending?.balance || 0)
      : (parsed.ok ? parsed.cents : 0);
    return { selected, saleId, amount: centsToMoney(amountCents) };
  }).filter((row) => row.selected && row.amount > 0);
}

async function submitCollectionEntry(event) {
  event.preventDefault();
  const rows = collectionSelectedRows();
  if (!rows.length) {
    setCommercialStatus("collections-status", "Selecciona al menos una factura para saldar.", "error");
    return;
  }
  const retentions = collectionRetentionAmounts();
  const invoiceTotalCents = rows.reduce((acc, row) => acc + moneyToCents(row.amount), 0);
  const collectedAmountCents = Math.max(0, entryMoneyCents("collection-received-total", { allowNegative: false }));
  const retentionsCents = moneyToCents(retentions.total);
  if (retentionsCents > invoiceTotalCents) {
    setCommercialStatus("collections-status", "Las retenciones no pueden superar el total aplicado a facturas.", "error");
    return;
  }
  if (collectedAmountCents + retentionsCents !== invoiceTotalCents) {
    setCommercialStatus("collections-status", "El cobro recibido mas las retenciones debe coincidir con el total aplicado a facturas.", "error");
    return;
  }

  const button = event.submitter;
  setCommercialButtonLoading(button, true, "Guardando...");
  setCommercialStatus("collections-status", "Guardando cobro...", "pending");

  try {
    pendingCollectionOperationId ||= newTreasuryOperationId("cobro");
    const result = await saveTreasuryOperation("/api/treasury/collections", {
      operationId: pendingCollectionOperationId,
      collection: {
        fecha: els["collection-date"]?.value || "",
        metodo: els["collection-method"]?.value || "",
        idCliente: els["collection-client"]?.value || "",
        monto: centsToMoney(collectedAmountCents),
        banco: els["collection-bank"]?.value || ""
      },
      details: rows.map((row) => ({ idVenta: row.saleId, monto: row.amount })),
      retentions: { ganancias: retentions.incomeTax, iibb: retentions.grossRevenue }
    });
    const collectionId = result.collectionId;
    pendingCollectionOperationId = "";
    setCommercialStatus("collections-status", `Cobro #${collectionId} guardado.`, "success");
    commercialEntryData.loaded = false;
    await loadCommercialEntryData(true);
    // Mantiene sincronizado el extracto ya analizado con el cobro recién guardado.
    if (bankReconciliationFileText.trim()) await analyzeBankReconciliation();
  } catch (error) {
    setCommercialStatus("collections-status", `No se pudo guardar el cobro: ${error.message}`, "error");
  } finally {
    setCommercialButtonLoading(button, false);
  }
}

function downloadSalesDebtSummaryPng() {
  const selectedClientId = els["sales-client-filter"]?.value || "";
  const rows = pendingSalesRows(selectedClientId);
  if (!rows.length) return;

  const clientLabel = selectedClientId ? clientName(selectedClientId) : "Todos los clientes";
  const total = centsToMoney(rows.reduce((acc, row) => acc + moneyToCents(row.balance), 0));
  const scale = 2;
  const width = 760;
  const rowHeight = 42;
  const height = 170 + rows.length * rowHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d");
  context.scale(scale, scale);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#e8f4f2";
  context.fillRect(32, 28, width - 64, 70);
  context.fillStyle = "#005f5b";
  context.font = "800 26px Arial, sans-serif";
  context.fillText("Resumen de deuda", 54, 72);
  context.fillStyle = "#0d1f33";
  context.font = "700 18px Arial, sans-serif";
  context.fillText(clientLabel, 32, 130);
  context.textAlign = "right";
  context.fillText(formatMoney(total), width - 32, 130);
  context.textAlign = "left";

  let y = 170;
  rows.forEach((row) => {
    context.fillStyle = "#eef3f7";
    context.fillRect(32, y - 28, width - 64, 1);
    context.fillStyle = "#465463";
    context.font = "400 16px Arial, sans-serif";
    context.fillText(`${row.sale.nro_factura || row.sale.id_venta} · ${formatDate(row.sale.fecha_factura)}`, 32, y);
    context.textAlign = "right";
    context.fillStyle = "#0d1f33";
    context.font = "800 16px Arial, sans-serif";
    context.fillText(formatMoney(row.balance), width - 32, y);
    context.textAlign = "left";
    y += rowHeight;
  });

  const link = document.createElement("a");
  link.download = `resumen-deuda-${clientLabel.replace(/\s+/g, "-").toLowerCase()}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

let pendingCollectionOperationId = "";
