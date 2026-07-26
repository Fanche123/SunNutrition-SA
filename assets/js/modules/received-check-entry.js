function renderReceivedCheckEntry() {
  const body = els["received-check-pending-body"];
  if (!body) return;

  const existingCheckCollectionIds = new Set(commercialEntryData.cheques_recibidos.map((check) => backendId(check.id_cobro)).filter(Boolean));
  const pendingChecks = commercialEntryData.cobros
    .filter((collection) => isCheckCollectionMethod(collection.metodo) && !existingCheckCollectionIds.has(backendId(collection.id_cobro)))
    .sort((a, b) => String(a.fecha_cobro || "").localeCompare(String(b.fecha_cobro || "")));

  if (els["received-check-count"]) els["received-check-count"].textContent = `${pendingChecks.length} cobro${pendingChecks.length === 1 ? "" : "s"}`;
  body.innerHTML = pendingChecks.length ? pendingChecks.map((collection) => `
    <tr>
      <td>${formatDate(collection.fecha_cobro)}</td>
      <td>${escapeHtml(clientName(collection.id_cliente))}</td>
      <td>${escapeHtml(displayNameLabel(collection.metodo || "Cheque"))}</td>
      <td class="num">${formatMoney(parseMoney(collection.monto))}</td>
      <td>${escapeHtml(collection.banco || "-")}</td>
      <td><button type="button" data-create-received-check="${escapeHtml(collection.id_cobro)}">Cargar cheque</button></td>
    </tr>
  `).join("") : `<tr><td class="empty" colspan="6">No hay cobros con cheque pendientes.</td></tr>`;
  loadReceivedChecksUnified();
}

function isCheckCollectionMethod(value) {
  const method = normalizeCategory(value);
  return method.includes("cheque") || method.includes("echeq") || method.includes("e cheque");
}

function openReceivedCheckDraft(collectionId) {
  const collection = commercialEntryData.cobros.find((row) => backendId(row.id_cobro) === backendId(collectionId));
  if (!collection) return;
  const receivedDate = collection.fecha_cobro || toIsoDate(new Date());
  if (els["received-check-collection-id"]) els["received-check-collection-id"].value = collection.id_cobro || "";
  if (els["received-check-client-id"]) els["received-check-client-id"].value = collection.id_cliente || "";
  if (els["received-check-collection-label"]) els["received-check-collection-label"].value = `Cobro ${collection.id_cobro} - ${formatDate(receivedDate)}`;
  if (els["received-check-client-name"]) els["received-check-client-name"].value = displayNameLabel(clientName(collection.id_cliente));
  if (els["received-check-amount"]) els["received-check-amount"].value = formatMoneyInput(normalizeMoney(collection.monto));
  if (els["received-check-number"]) els["received-check-number"].value = "";
  if (els["received-check-received-date"]) els["received-check-received-date"].value = receivedDate;
  if (els["received-check-use-date"]) els["received-check-use-date"].value = receivedDate;
  if (els["received-check-bank"]) els["received-check-bank"].value = collection.banco || "";
  if (els["received-check-state"]) els["received-check-state"].value = "Pendiente";
  setCommercialStatus("received-check-status", "Completa el numero y la fecha de uso del cheque.", "pending");
  if (els["received-check-form"]) els["received-check-form"].hidden = false;
  els["received-check-number"]?.focus();
}

async function submitReceivedCheckEntry(event) {
  event.preventDefault();
  const collectionId = String(els["received-check-collection-id"]?.value || "").trim();
  const clientId = String(els["received-check-client-id"]?.value || "").trim();
  const checkNumber = String(els["received-check-number"]?.value || "").trim();
  const receivedDate = String(els["received-check-received-date"]?.value || "").trim();
  const useDate = String(els["received-check-use-date"]?.value || "").trim();
  const amount = entryMoneyValue("received-check-amount");

  if (!collectionId || !checkNumber || !receivedDate || !useDate || amount <= 0) {
    setCommercialStatus("received-check-status", "Selecciona un cobro pendiente y completa numero, fechas y monto del cheque.", "error");
    return;
  }

  const button = els["received-check-submit"];
  const originalText = button?.textContent || "Guardar cheque recibido";
  if (button) {
    button.disabled = true;
    button.textContent = "Guardando...";
  }
  setCommercialStatus("received-check-status", "Guardando cheque recibido...", "pending");

  try {
    const checkId = await nextBackendPrimaryId("cheques_recibidos", "id_cheque_recibido");
    await saveBackendEntryRows("cheques_recibidos", [{
      id_cheque_recibido: checkId,
      id_cobro: collectionId,
      fecha_entregado: receivedDate,
      monto: amount,
      cliente: clientName(clientId),
      id_cliente: clientId,
      nro_cheque: checkNumber,
      fecha_uso: useDate,
      estado: "Pendiente",
      banco: String(els["received-check-bank"]?.value || "").trim()
    }]);

    commercialEntryData.loaded = false;
    await loadCommercialEntryData(true);
    els["received-check-form"]?.reset();
    if (els["received-check-form"]) els["received-check-form"].hidden = true;
    setCommercialStatus("received-check-status", `Cheque ${checkId} asociado al cobro ${collectionId}.`, "success");
  } catch (error) {
    setCommercialStatus("received-check-status", error.message || "No se pudo guardar el cheque recibido.", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

let receivedChecksUnifiedBound = false;
let receivedChecksUnifiedLoading = false;
let receivedChecksUnifiedData = { payments: [], paymentDetails: [] };
let receivedChecksSelectedIds = new Set();
let receivedChecksEndorsementOperationId = "";

async function loadReceivedChecksUnified() {
  if (receivedChecksUnifiedLoading || !document.getElementById("received-check-available-body")) return;
  receivedChecksUnifiedLoading = true;
  bindReceivedChecksUnified();
  try {
    const [payments, paymentDetails] = await Promise.all([
      backendTableRowsForEntry("pagos").catch(() => []),
      backendTableRowsForEntry("detalle_pagos").catch(() => [])
    ]);
    receivedChecksUnifiedData = { payments, paymentDetails };
    const availableIds = new Set(receivedCheckAvailableRows().map((row) => backendId(row.id_cheque_recibido)));
    receivedChecksSelectedIds = new Set([...receivedChecksSelectedIds].filter((id) => availableIds.has(id)));
    renderReceivedChecksUnified();
  } catch (error) {
    setReceivedChecksUnifiedStatus(error.message || "No se pudieron cargar los cheques.", "error");
  } finally {
    receivedChecksUnifiedLoading = false;
  }
}

function bindReceivedChecksUnified() {
  if (receivedChecksUnifiedBound) return;
  receivedChecksUnifiedBound = true;
  document.getElementById("received-check-available-body")?.addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-received-check-select]");
    if (!checkbox) return;
    const id = backendId(checkbox.dataset.receivedCheckSelect);
    if (checkbox.checked) receivedChecksSelectedIds.add(id);
    else receivedChecksSelectedIds.delete(id);
    renderReceivedChecksSelection();
  });
  document.getElementById("received-check-select-all")?.addEventListener("change", (event) => {
    const ids = receivedCheckAvailableRows().map((row) => backendId(row.id_cheque_recibido));
    receivedChecksSelectedIds = event.target.checked ? new Set(ids) : new Set();
    renderReceivedChecksUnified();
  });
  document.getElementById("received-check-deposit-open")?.addEventListener("click", openReceivedCheckDepositPanel);
  document.getElementById("received-check-endorse-open")?.addEventListener("click", openReceivedCheckEndorsePanel);
  document.getElementById("received-check-deposit-confirm")?.addEventListener("click", confirmReceivedCheckDeposit);
  document.getElementById("received-check-deposit-credit")?.addEventListener("input", renderReceivedCheckDepositSummary);
  document.getElementById("received-check-endorse-confirm")?.addEventListener("click", confirmReceivedCheckEndorsement);
  document.getElementById("received-check-endorse-payment")?.addEventListener("change", renderReceivedCheckEndorsementSummary);
  document.querySelectorAll("[data-received-check-close-panel]").forEach((button) => {
    button.addEventListener("click", closeReceivedCheckActionPanels);
  });
  document.getElementById("received-check-history-open")?.addEventListener("click", () => {
    document.getElementById("received-check-history-panel").hidden = false;
    renderReceivedCheckHistory();
  });
  document.getElementById("received-check-history-close")?.addEventListener("click", () => {
    document.getElementById("received-check-history-panel").hidden = true;
    document.getElementById("received-check-available-body")?.closest(".panel")?.scrollIntoView({ block: "start" });
  });
  document.getElementById("received-check-pending-payments-body")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-assign-received-checks]");
    if (!button) return;
    openReceivedCheckEndorsePanel(button.dataset.assignReceivedChecks);
  });
}

function receivedCheckAvailableRows() {
  return (commercialEntryData.cheques_recibidos || []).filter((row) => (
    String(row.estado || "").trim() === "Pendiente"
    && !backendId(row.id_deposito)
    && !backendId(row.id_pago_endoso)
    && !String(row.fecha_deposito || "").trim()
    && !String(row.fecha_endoso || "").trim()
  ));
}

function renderReceivedChecksUnified() {
  const body = document.getElementById("received-check-available-body");
  if (!body) return;
  const available = receivedCheckAvailableRows();
  body.innerHTML = available.length ? available.map((check) => `
    <tr>
      <td><input type="checkbox" data-received-check-select="${escapeHtml(backendId(check.id_cheque_recibido))}" ${receivedChecksSelectedIds.has(backendId(check.id_cheque_recibido)) ? "checked" : ""}></td>
      <td>${escapeHtml(check.nro_cheque || "-")}</td>
      <td>${escapeHtml(check.cliente || clientName(check.id_cliente) || "-")}</td>
      <td>${escapeHtml(check.banco || "-")}</td>
      <td>${formatDate(check.fecha_entregado)}</td>
      <td>${formatDate(check.fecha_uso)}</td>
      <td class="num">${formatMoney(centsToMoney(moneyToCents(check.monto)))}</td>
      <td><span class="status-chip pending">Pendiente</span></td>
    </tr>
  `).join("") : `<tr><td class="empty" colspan="8">No hay cheques disponibles.</td></tr>`;
  renderReceivedChecksSelection();
  renderReceivedCheckPendingPayments();
  if (!document.getElementById("received-check-history-panel")?.hidden) renderReceivedCheckHistory();
}

function selectedReceivedChecks() {
  return receivedCheckAvailableRows().filter((row) => (
    receivedChecksSelectedIds.has(backendId(row.id_cheque_recibido))
  ));
}

function renderReceivedChecksSelection() {
  const selected = selectedReceivedChecks();
  const totalCents = selected.reduce((sum, row) => sum + moneyToCents(row.monto), 0);
  const count = document.getElementById("received-check-selected-count");
  const total = document.getElementById("received-check-selected-total");
  if (count) count.textContent = String(selected.length);
  if (total) total.textContent = formatMoney(centsToMoney(totalCents));
  ["received-check-deposit-open", "received-check-endorse-open"].forEach((id) => {
    const button = document.getElementById(id);
    if (button) button.disabled = !selected.length;
  });
  const selectAll = document.getElementById("received-check-select-all");
  const availableCount = receivedCheckAvailableRows().length;
  if (selectAll) {
    selectAll.checked = availableCount > 0 && selected.length === availableCount;
    selectAll.indeterminate = selected.length > 0 && selected.length < availableCount;
    selectAll.disabled = availableCount === 0;
  }
  if (!document.getElementById("received-check-endorse-panel")?.hidden) {
    renderReceivedCheckEndorsementSummary();
  }
  if (!document.getElementById("received-check-deposit-panel")?.hidden) {
    renderReceivedCheckDepositSummary();
  }
}

function openReceivedCheckDepositPanel() {
  if (!selectedReceivedChecks().length) return;
  closeReceivedCheckActionPanels();
  const panel = document.getElementById("received-check-deposit-panel");
  panel.hidden = false;
  document.getElementById("received-check-deposit-date").value = toIsoDate(new Date());
  document.getElementById("received-check-deposit-count").textContent = String(selectedReceivedChecks().length);
  document.getElementById("received-check-deposit-credit").value = "";
  renderReceivedCheckDepositSummary();
  panel.scrollIntoView({ block: "nearest" });
}

function renderReceivedCheckDepositSummary() {
  const selected = selectedReceivedChecks();
  const selectedCents = selected.reduce((sum, row) => sum + moneyToCents(row.monto), 0);
  const creditText = document.getElementById("received-check-deposit-credit")?.value || "";
  const hasCredit = creditText.trim() !== "";
  const creditCents = hasCredit ? moneyToCents(parseMoney(creditText)) : 0;
  document.getElementById("received-check-deposit-count").textContent = String(selected.length);
  document.getElementById("received-check-deposit-total").textContent = formatMoney(centsToMoney(selectedCents));
  document.getElementById("received-check-deposit-difference").textContent = hasCredit
    ? formatMoney(centsToMoney(Math.abs(creditCents - selectedCents)))
    : "-";
  const confirm = document.getElementById("received-check-deposit-confirm");
  if (confirm) confirm.disabled = !selected.length || (hasCredit && creditCents !== selectedCents);
}

function openReceivedCheckEndorsePanel(paymentId = "") {
  if (!selectedReceivedChecks().length && !paymentId) return;
  closeReceivedCheckActionPanels();
  const panel = document.getElementById("received-check-endorse-panel");
  const select = document.getElementById("received-check-endorse-payment");
  const payments = pendingEndorsementPayments();
  select.innerHTML = `<option value="">Elegir pago</option>${payments.map((item) => `
    <option value="${escapeHtml(backendId(item.payment.id_pago))}">Pago ${escapeHtml(item.payment.id_pago)} · ${formatDate(item.payment.fecha_pago)} · ${formatMoney(centsToMoney(item.paymentCents))}</option>
  `).join("")}`;
  select.value = paymentId && payments.some((item) => backendId(item.payment.id_pago) === backendId(paymentId))
    ? backendId(paymentId)
    : "";
  document.getElementById("received-check-endorse-date").value = toIsoDate(new Date());
  panel.hidden = false;
  renderReceivedCheckEndorsementSummary();
  panel.scrollIntoView({ block: "nearest" });
}

function closeReceivedCheckActionPanels() {
  ["received-check-deposit-panel", "received-check-endorse-panel"].forEach((id) => {
    const panel = document.getElementById(id);
    if (panel) panel.hidden = true;
  });
}

async function confirmReceivedCheckDeposit() {
  const selected = selectedReceivedChecks();
  const depositDate = document.getElementById("received-check-deposit-date")?.value || "";
  const bank = document.getElementById("received-check-deposit-bank")?.value || "";
  const creditText = document.getElementById("received-check-deposit-credit")?.value || "";
  const creditCents = creditText.trim() ? moneyToCents(parseMoney(creditText)) : 0;
  const selectedCents = selected.reduce((sum, row) => sum + moneyToCents(row.monto), 0);
  if (!selected.length || !depositDate || !bank) return;
  if (creditText.trim() && creditCents !== selectedCents) return;
  try {
    const movement = creditText.trim() ? {
      date: depositDate,
      amount: centsToMoney(creditCents),
      credit: centsToMoney(creditCents),
      detail: "Depósito de cheques recibidos"
    } : null;
    const response = await fetch(`${API_BASE_URL}/api/bank-reconciliation/deposit-checks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bank,
        depositDate,
        manualDeposit: !movement,
        movement,
        checkIds: selected.map((row) => backendId(row.id_cheque_recibido))
      })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo registrar el depósito.");
    receivedChecksSelectedIds.clear();
    closeReceivedCheckActionPanels();
    commercialEntryData.loaded = false;
    await loadCommercialEntryData(true);
    setReceivedChecksUnifiedStatus(`${payload.checkCount} cheque(s) depositado(s) por ${formatMoney(payload.amount)}.`, "success");
  } catch (error) {
    setReceivedChecksUnifiedStatus(error.message, "error");
  }
}

async function confirmReceivedCheckEndorsement() {
  const selected = selectedReceivedChecks();
  const paymentId = document.getElementById("received-check-endorse-payment")?.value || "";
  const endorsementDate = document.getElementById("received-check-endorse-date")?.value || "";
  const summary = endorsementSelectionSummary(paymentId);
  if (!selected.length || !paymentId || !endorsementDate || summary.differenceCents !== 0) return;
  try {
    receivedChecksEndorsementOperationId ||= newTreasuryOperationId("endoso-cheques");
    const response = await fetch(`${API_BASE_URL}/api/treasury/received-checks/endorse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationId: receivedChecksEndorsementOperationId,
        paymentId,
        checkIds: selected.map((row) => backendId(row.id_cheque_recibido)),
        endorsementDate
      })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo confirmar el endoso.");
    receivedChecksEndorsementOperationId = "";
    receivedChecksSelectedIds.clear();
    closeReceivedCheckActionPanels();
    commercialEntryData.loaded = false;
    await loadCommercialEntryData(true);
    setReceivedChecksUnifiedStatus(`${payload.checkIds.length} cheque(s) endosado(s) al pago ${payload.paymentId}.`, "success");
  } catch (error) {
    setReceivedChecksUnifiedStatus(error.message, "error");
  }
}

function pendingEndorsementPayments() {
  const assignedByPayment = new Map();
  (commercialEntryData.cheques_recibidos || []).forEach((check) => {
    const paymentId = backendId(check.id_pago_endoso);
    if (!paymentId) return;
    assignedByPayment.set(paymentId, (assignedByPayment.get(paymentId) || 0) + moneyToCents(check.monto));
  });
  return (receivedChecksUnifiedData.payments || [])
    .filter((payment) => String(payment.metodo || "").trim() === "Endoso")
    .map((payment) => {
      const paymentCents = moneyToCents(payment.monto);
      const assignedCents = assignedByPayment.get(backendId(payment.id_pago)) || 0;
      return { payment, paymentCents, assignedCents, differenceCents: paymentCents - assignedCents };
    })
    .filter((item) => item.differenceCents !== 0);
}

function renderReceivedCheckPendingPayments() {
  const body = document.getElementById("received-check-pending-payments-body");
  if (!body) return;
  const payments = pendingEndorsementPayments();
  body.innerHTML = payments.length ? payments.map((item) => `
    <tr>
      <td>${formatDate(item.payment.fecha_pago)}</td>
      <td>Pago ${escapeHtml(item.payment.id_pago)}${item.payment.referencia ? ` · ${escapeHtml(item.payment.referencia)}` : ""}</td>
      <td class="num">${formatMoney(centsToMoney(item.paymentCents))}</td>
      <td class="num">${formatMoney(centsToMoney(item.assignedCents))}</td>
      <td class="num">${formatMoney(centsToMoney(Math.abs(item.differenceCents)))}</td>
      <td><button type="button" data-assign-received-checks="${escapeHtml(item.payment.id_pago)}">Asignar cheques</button></td>
    </tr>
  `).join("") : `<tr><td class="empty" colspan="6">No hay pagos con endoso pendientes.</td></tr>`;
}

function endorsementSelectionSummary(paymentId) {
  const selectedCents = selectedReceivedChecks().reduce((sum, row) => sum + moneyToCents(row.monto), 0);
  const payment = receivedChecksUnifiedData.payments.find((row) => backendId(row.id_pago) === backendId(paymentId));
  const paymentCents = payment ? moneyToCents(payment.monto) : 0;
  return { selectedCents, paymentCents, differenceCents: paymentCents - selectedCents };
}

function renderReceivedCheckEndorsementSummary() {
  const paymentId = document.getElementById("received-check-endorse-payment")?.value || "";
  const summary = endorsementSelectionSummary(paymentId);
  document.getElementById("received-check-endorse-total").textContent = formatMoney(centsToMoney(summary.selectedCents));
  document.getElementById("received-check-endorse-payment-total").textContent = formatMoney(centsToMoney(summary.paymentCents));
  document.getElementById("received-check-endorse-difference").textContent = formatMoney(centsToMoney(Math.abs(summary.differenceCents)));
  const confirm = document.getElementById("received-check-endorse-confirm");
  if (confirm) confirm.disabled = !paymentId || !selectedReceivedChecks().length || summary.differenceCents !== 0;
}

function renderReceivedCheckHistory() {
  const body = document.getElementById("received-check-history-body");
  if (!body) return;
  const rows = [...(commercialEntryData.cheques_recibidos || [])]
    .sort((a, b) => receivedCheckRelevantDate(b).localeCompare(receivedCheckRelevantDate(a)))
    .slice(0, 20);
  body.innerHTML = rows.length ? rows.map((check) => {
    const status = String(check.estado || "-").trim();
    const historicalEndorsement = status === "Endosado" && !backendId(check.id_pago_endoso);
    return `<tr>
      <td>${escapeHtml(check.nro_cheque || "-")}</td>
      <td>${escapeHtml(check.cliente || clientName(check.id_cliente) || "-")}</td>
      <td>${escapeHtml(check.banco || "-")}</td>
      <td class="num">${formatMoney(centsToMoney(moneyToCents(check.monto)))}</td>
      <td>${formatDate(receivedCheckRelevantDate(check))}</td>
      <td>${escapeHtml(historicalEndorsement ? "Endosado histórico" : status)}</td>
      <td>${escapeHtml(status === "Depositado" ? (check.id_deposito || "Sin identificador de depósito") : "-")}</td>
      <td>${escapeHtml(historicalEndorsement ? "Sin vínculo de pago" : (check.id_pago_endoso || "-"))}${check.fecha_endoso ? ` · ${formatDate(check.fecha_endoso)}` : ""}</td>
    </tr>`;
  }).join("") : `<tr><td class="empty" colspan="8">No hay cheques registrados.</td></tr>`;
}

function receivedCheckRelevantDate(check) {
  return String(check.fecha_endoso || check.fecha_deposito || check.fecha_uso || check.fecha_entregado || "");
}

function setReceivedChecksUnifiedStatus(message, type) {
  setCommercialStatus("received-check-unified-status", message, type);
}

