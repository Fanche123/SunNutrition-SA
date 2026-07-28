(function exposeCashBoxesModule(root) {
  "use strict";

  const state = {
    snapshot: null,
    collectionFilter: "",
    paymentFilter: "",
    bankCreditFilter: "",
    bankDebitFilter: ""
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    const element = byId(id);
    if (element) element.textContent = value;
  }

  function setStatus(message, status = "") {
    const element = byId("cash-boxes-status");
    if (!element) return;
    element.textContent = message;
    if (status) element.dataset.status = status;
    else delete element.dataset.status;
  }

  function moneyFromCents(cents, fallback = "$ 0,00") {
    if (!Number.isSafeInteger(cents)) return fallback;
    return ErpMoney.format(ErpMoney.fromCents(cents));
  }

  function recordLabel(count) {
    return `${count} ${count === 1 ? "registro" : "registros"}`;
  }

  async function loadCashBoxes() {
    setLoadingState();
    try {
      const payload = await requestBackendApi("/api/treasury/cash-boxes?box=icbc");
      state.snapshot = payload.snapshot;
      renderCashBoxSnapshot();
      setStatus("Control ICBC actualizado con la regla backend compartida.", "ok");
    } catch (error) {
      state.snapshot = null;
      renderErrorState(error);
    }
  }

  function setLoadingState() {
    setStatus("Cargando Saldo del ICBC...");
    setText("cash-box-status-badge", "Calculando");
    renderPendingBody("cash-box-pending-collections-body", [], "", "Cargando cobros pendientes...");
    renderPendingBody("cash-box-pending-payments-body", [], "", "Cargando pagos pendientes...");
    renderBankPendingBody("cash-box-bank-credits-body", [], "", "Cargando créditos bancarios pendientes...");
    renderBankPendingBody("cash-box-bank-debits-body", [], "", "Cargando débitos bancarios pendientes...");
  }

  function renderCashBoxSnapshot() {
    const snapshot = state.snapshot;
    if (!snapshot) return;
    const { rule, summary, erpToBank, bankToErp } = snapshot;

    setText("cash-box-rule-caption", `${rule.formula} · desde ${displayDate(rule.initialDate)} inclusive`);
    setText(
      "cash-box-scope-description",
      `Se incluyen cobros/pagos con ICBC y depósitos efectivos de cheques/eCheq desde el ${displayDate(rule.initialDate)} inclusive. Los cheques recibidos se computan al depositarse y los emitidos sólo al debitarse.`
    );
    setText("cash-box-initial-balance", moneyFromCents(rule.initialBalanceCents));
    setText("cash-box-initial-date", `Desde ${displayDate(rule.initialDate)} inclusive`);
    setText("cash-box-collections-total", moneyFromCents(summary.collectionTotalCents));
    setText("cash-box-collections-count", recordLabel(summary.collectionCount));
    setText("cash-box-payments-total", moneyFromCents(summary.paymentTotalCents));
    setText("cash-box-payments-count", recordLabel(summary.paymentCount));
    setText("cash-box-calculated-balance", moneyFromCents(summary.calculatedBalanceCents));

    const latest = summary.latestBankMovement;
    setText(
      "cash-box-bank-balance",
      latest ? moneyFromCents(latest.balanceCents, "Saldo no disponible") : "Sin saldo"
    );
    setText(
      "cash-box-bank-movement",
      latest ? `${displayDate(latest.date)} · Movimiento #${latest.id || "sin ID"}` : "Sin movimientos bancarios ICBC"
    );
    setText(
      "cash-box-difference",
      moneyFromCents(summary.differenceCents, "Sin comparar")
    );
    renderBalanceStatus(summary.status);

    setText("cash-box-bank-pending-count", String(bankToErp.pendingCount));
    setText("cash-box-bank-pending-gross", moneyFromCents(bankToErp.pendingGrossCents));
    setText("cash-box-bank-pending-net", moneyFromCents(bankToErp.pendingNetCents));
    setText("cash-box-erp-pending-net", moneyFromCents(erpToBank.pendingNetCents));
    setText("cash-box-pending-net-gap-bank", moneyFromCents(bankToErp.pendingNetCents));
    setText("cash-box-pending-net-gap", moneyFromCents(bankToErp.pendingNetGapCents));
    setText(
      "cash-box-bank-credits-summary",
      `${bankToErp.pendingCreditCount} pendiente(s) · ${moneyFromCents(bankToErp.pendingCreditTotalCents)}`
    );
    setText(
      "cash-box-bank-debits-summary",
      `${bankToErp.pendingDebitCount} pendiente(s) · ${moneyFromCents(bankToErp.pendingDebitTotalCents)}`
    );
    renderGapFactors(bankToErp.gapFactors || []);
    renderWarnings(snapshot.warnings || []);

    setText(
      "cash-box-pending-collections-summary",
      `${erpToBank.pendingCollectionCount} pendiente(s) · ${moneyFromCents(erpToBank.pendingCollectionTotalCents)}`
    );
    setText(
      "cash-box-pending-payments-summary",
      `${erpToBank.pendingPaymentCount} pendiente(s) · ${moneyFromCents(erpToBank.pendingPaymentTotalCents)}`
    );
    renderPendingTables();
    renderBankPendingTables();
  }

  function renderBalanceStatus(status) {
    const badge = byId("cash-box-status-badge");
    const differenceCard = byId("cash-box-difference-card");
    if (!badge || !differenceCard) return;
    badge.classList.remove("is-reconciled", "is-difference", "is-unavailable");
    differenceCard.classList.remove("is-reconciled", "is-difference", "is-unavailable");

    const presentation = {
      reconciled: { text: "Conciliado", className: "is-reconciled" },
      balanced_with_pending_associations: {
        text: "El saldo cuadra, pero faltan asociaciones individuales",
        className: "is-difference"
      },
      difference: { text: "Con diferencia", className: "is-difference" },
      unavailable: { text: "Sin saldo bancario", className: "is-unavailable" }
    }[status] || { text: "Sin calcular", className: "is-unavailable" };
    badge.textContent = presentation.text;
    badge.classList.add(presentation.className);
    differenceCard.classList.add(presentation.className);
  }

  function renderGapFactors(factors) {
    const container = byId("cash-box-gap-factors");
    if (!container) return;
    if (!factors.length) {
      container.innerHTML = '<p class="cash-box-empty-note">No hay factores bancarios especiales identificados en la brecha.</p>';
      return;
    }
    container.innerHTML = factors.map((factor) => `
      <article>
        <span>${escapeHtml(factor.classification)}</span>
        <strong>${escapeHtml(String(factor.count))}</strong>
        <small>Neto ${escapeHtml(moneyFromCents(factor.netCents))} · Bruto ${escapeHtml(moneyFromCents(factor.grossCents))}</small>
      </article>
    `).join("");
  }

  function renderWarnings(warnings) {
    const container = byId("cash-box-warnings");
    if (!container) return;
    container.hidden = !warnings.length;
    container.innerHTML = warnings.length
      ? `<strong>Revisar alcance</strong><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`
      : "";
  }

  function renderPendingTables() {
    const snapshot = state.snapshot;
    if (!snapshot) return;
    renderPendingBody(
      "cash-box-pending-collections-body",
      snapshot.erpToBank.collections || [],
      state.collectionFilter,
      "No hay cobros sin contrapartida ICBC."
    );
    renderPendingBody(
      "cash-box-pending-payments-body",
      snapshot.erpToBank.payments || [],
      state.paymentFilter,
      "No hay pagos sin contrapartida ICBC."
    );
  }

  function renderPendingBody(bodyId, rows, filter, emptyMessage) {
    const body = byId(bodyId);
    if (!body) return;
    const visibleRows = filterRows(rows, filter);
    if (!visibleRows.length) {
      const message = rows.length && filter
        ? "No hay resultados para el filtro aplicado."
        : emptyMessage;
      body.innerHTML = `<tr><td class="empty" colspan="6">${escapeHtml(message)}</td></tr>`;
      return;
    }
    body.innerHTML = visibleRows.map((row) => `
      <tr>
        <td>${escapeHtml(displayDate(row.date))}</td>
        <td>${escapeHtml(row.counterparty || "-")}</td>
        <td>${escapeHtml(row.reference || "-")}</td>
        <td>${escapeHtml(row.instrument || "-")}</td>
        <td class="num">${escapeHtml(moneyFromCents(row.amountCents))}</td>
        <td>
          <span class="cash-box-row-status ${escapeHtml(statusClass(row.status))}">${escapeHtml(statusLabel(row.status))}</span>
          <small class="cash-box-row-reason">${escapeHtml(row.reason || "")}</small>
        </td>
      </tr>
    `).join("");
  }

  function renderBankPendingTables() {
    const bankToErp = state.snapshot?.bankToErp;
    if (!bankToErp) return;
    renderBankPendingBody(
      "cash-box-bank-credits-body",
      bankToErp.credits || [],
      state.bankCreditFilter,
      "No hay créditos bancarios sin contrapartida ERP en el corte."
    );
    renderBankPendingBody(
      "cash-box-bank-debits-body",
      bankToErp.debits || [],
      state.bankDebitFilter,
      "No hay débitos bancarios sin contrapartida ERP en el corte."
    );
  }

  function renderBankPendingBody(bodyId, rows, filter, emptyMessage) {
    const body = byId(bodyId);
    if (!body) return;
    const visibleRows = filterRows(rows, filter);
    if (!visibleRows.length) {
      const message = rows.length && filter ? "No hay resultados para el filtro aplicado." : emptyMessage;
      body.innerHTML = `<tr><td class="empty" colspan="6">${escapeHtml(message)}</td></tr>`;
      return;
    }
    body.innerHTML = visibleRows.map((row) => `
      <tr>
        <td>${escapeHtml(displayDate(row.date))}</td>
        <td>${escapeHtml(row.detail || "-")}</td>
        <td>${escapeHtml(row.reference || "-")}</td>
        <td><span class="cash-box-row-status">${row.type === "credit" ? "Crédito" : "Débito"}</span></td>
        <td class="num">${escapeHtml(moneyFromCents(row.amountCents))}</td>
        <td><small class="cash-box-row-reason">${escapeHtml(row.reason || "")}</small></td>
      </tr>
    `).join("");
  }

  function filterRows(rows, filter) {
    const query = normalizedText(filter);
    if (!query) return rows;
    return rows.filter((row) => normalizedText([
      row.date,
      row.counterparty,
      row.detail,
      row.reference,
      row.instrument,
      row.reason
    ].join(" ")).includes(query));
  }

  function normalizedText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  function statusClass(status) {
    return status === "declared_icbc" ? "is-ok" : "is-review";
  }

  function statusLabel(status) {
    return {
      declared_icbc: "ICBC declarado",
      other_bank: "Otro banco",
      cash: "Efectivo",
      non_bank: "No bancario",
      check: "Cheque",
      bank_unspecified: "Banco sin informar"
    }[status] || "Revisar";
  }

  function displayDate(value) {
    const text = String(value || "").trim();
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : (text || "-");
  }

  function renderErrorState(error) {
    setStatus(`No se pudo cargar Caja: ${error.message}`, "error");
    setText("cash-box-status-badge", "Error");
    renderBalanceStatus("unavailable");
    renderPendingBody("cash-box-pending-collections-body", [], "", "No se pudieron cargar los cobros.");
    renderPendingBody("cash-box-pending-payments-body", [], "", "No se pudieron cargar los pagos.");
    renderBankPendingBody("cash-box-bank-credits-body", [], "", "No se pudieron cargar los créditos bancarios.");
    renderBankPendingBody("cash-box-bank-debits-body", [], "", "No se pudieron cargar los débitos bancarios.");
  }

  function bindCashBoxEvents() {
    byId("cash-boxes-refresh")?.addEventListener("click", loadCashBoxes);
    byId("cash-box-open-reconciliation")?.addEventListener("click", () => switchView("bank-reconciliation"));
    byId("cash-box-collections-filter")?.addEventListener("input", (event) => {
      state.collectionFilter = event.target.value;
      renderPendingTables();
    });
    byId("cash-box-payments-filter")?.addEventListener("input", (event) => {
      state.paymentFilter = event.target.value;
      renderPendingTables();
    });
    byId("cash-box-bank-credits-filter")?.addEventListener("input", (event) => {
      state.bankCreditFilter = event.target.value;
      renderBankPendingTables();
    });
    byId("cash-box-bank-debits-filter")?.addEventListener("input", (event) => {
      state.bankDebitFilter = event.target.value;
      renderBankPendingTables();
    });
  }

  root.loadCashBoxes = loadCashBoxes;
  root.CashBoxesModule = {
    filterRows,
    load: loadCashBoxes,
    render: renderCashBoxSnapshot
  };
  document.addEventListener("DOMContentLoaded", bindCashBoxEvents, { once: true });
})(globalThis);
