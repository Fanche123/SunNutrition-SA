(function exposeCashBoxesModule(root) {
  "use strict";

  const state = {
    management: null,
    activeDetail: "",
    lastFocus: null,
    requestSequence: 0,
    detailRequestSequence: 0
  };

  const detailTitles = {
    bank: ["Banco", "Cuenta ICBC"],
    cash: ["Efectivo", "Caja y movimientos"],
    "received-checks": ["Cheques recibidos", "Pendientes disponibles"],
    "issued-checks": ["Cheques entregados", "Pendientes de cobertura"],
    fund: ["Fondo de inversión", "Saldo y movimientos"],
    other: ["Otros movimientos financieros", "Aportes, retiros y transferencias internas"]
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

  function moneyFromCents(cents, fallback = "No disponible") {
    if (!Number.isSafeInteger(cents)) return fallback;
    return ErpMoney.format(ErpMoney.fromCents(cents));
  }

  async function loadCashBoxes() {
    const sequence = ++state.requestSequence;
    setLoadingState();
    try {
      const managementPayload = await requestBackendApi("/api/treasury/cash-boxes?box=icbc&view=management");
      if (sequence !== state.requestSequence) return;
      state.management = managementPayload.management;
      renderManagement();
      setStatus("Gestión de Tesorería actualizada desde fuentes canónicas del backend.", "ok");
    } catch (error) {
      if (sequence !== state.requestSequence) return;
      state.management = null;
      renderManagementError();
      setStatus(`No se pudo actualizar Gestión de Tesorería: ${error.message}`, "error");
    }
  }

  function setLoadingState() {
    setStatus("Cargando posición financiera...");
    [
      "treasury-bank-balance",
      "treasury-cash-balance",
      "treasury-received-checks-balance",
      "treasury-issued-checks-balance",
      "treasury-fund-balance",
      "treasury-liquidity-total"
    ].forEach((id) => setText(id, "—"));
    setText("treasury-bank-caption", "Actualizando saldo ERP");
    setText("treasury-cash-caption", "Actualizando fuente canónica");
    setText("treasury-received-checks-caption", "Actualizando disponibilidad");
    setText("treasury-issued-checks-caption", "Actualizando compromisos");
    setText("treasury-fund-caption", "Actualizando posición");
    setText("treasury-position-updated", "Actualizando…");
    ["collections", "payments"].forEach((type) => {
      setText(`treasury-${type}-count`, "—");
      setText(`treasury-${type}-total`, "Actualizando…");
      setText(`treasury-${type}-latest`, "Actualizando…");
    });
    renderWarnings([]);
  }

  function renderManagement() {
    const management = state.management;
    if (!management) return;
    const { position, operations } = management;
    const bank = position.bankAccounts?.[0];
    setText("treasury-bank-balance", moneyFromCents(bank?.erpBalanceCents));
    setText("treasury-bank-caption", bank?.latestBankMovement
      ? `Saldo ERP · último movimiento bancario ${displayDate(bank.latestBankMovement.date)}`
      : "Saldo ERP · sin movimientos bancarios");
    setText("treasury-cash-balance", position.cash.available
      ? moneyFromCents(position.cash.balanceCents)
      : "No disponible");
    setText("treasury-cash-caption", position.cash.available
      ? "Saldo canónico de caja"
      : "Falta fuente canónica única");
    setText("treasury-received-checks-balance", moneyFromCents(position.receivedChecks.availableTotalCents));
    setText("treasury-received-checks-caption", `${position.receivedChecks.availableCount} disponible(s)`);
    setText("treasury-issued-checks-balance", moneyFromCents(position.issuedChecks.pendingTotalCents));
    setText("treasury-issued-checks-caption", `${position.issuedChecks.pendingCount} pendiente(s) · compromiso`);
    setText("treasury-fund-balance", position.fund.available
      ? moneyFromCents(position.fund.balanceCents)
      : "No disponible");
    setText("treasury-fund-caption", `${position.fund.subscriptionCount} suscripción(es) · ${position.fund.redemptionCount} rescate(s)`);
    setText("treasury-liquidity-total", position.liquidityAvailable
      ? moneyFromCents(position.liquidityTotalCents)
      : "No calculable");
    setText("treasury-position-updated", `Actualizado ${displayDateTime(management.generatedAt)}`);
    renderOperationSummary("collections", operations.collections);
    renderOperationSummary("payments", operations.payments);
    renderWarnings(management.warnings || []);
  }

  function renderOperationSummary(type, summary) {
    const singular = type === "collections" ? "cobro" : "pago";
    setText(`treasury-${type}-count`, String(summary?.count || 0));
    setText(`treasury-${type}-total`, `${moneyFromCents(summary?.totalCents, "$ 0,00")} registrados`);
    setText(`treasury-${type}-latest`, summary?.latestDate
      ? `Último ${singular}: ${displayDate(summary.latestDate)}`
      : `Sin ${singular}s`);
  }

  function renderWarnings(warnings) {
    const container = byId("cash-box-warnings");
    if (!container) return;
    container.hidden = !warnings.length;
    container.innerHTML = warnings.length
      ? `<strong>Fuentes que requieren revisión</strong><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`
      : "";
  }

  async function openTreasuryDetail(detailId, trigger) {
    if (!detailTitles[detailId]) return;
    const dialog = byId("treasury-detail-dialog");
    const card = dialog?.querySelector(".treasury-dialog-card");
    const body = byId("treasury-detail-body");
    if (!dialog || !card || !body) return;
    const detailSequence = ++state.detailRequestSequence;
    state.activeDetail = detailId;
    state.lastFocus = trigger || document.activeElement;
    const [title, eyebrow] = detailTitles[detailId];
    setText("treasury-detail-title", title);
    setText("treasury-detail-eyebrow", eyebrow);
    body.innerHTML = '<p class="empty">Cargando detalle bajo demanda...</p>';
    dialog.hidden = false;
    document.body.classList.add("treasury-dialog-open");
    const closeButton = dialog.querySelector(".treasury-dialog-close");
    (closeButton || card).focus();
    root.requestAnimationFrame?.(() => {
      if (!dialog.hidden) (closeButton || card).focus();
    });
    try {
      const payload = await requestBackendApi(`/api/treasury/cash-boxes?box=icbc&view=management&detail=${encodeURIComponent(detailId)}`);
      if (state.activeDetail !== detailId || detailSequence !== state.detailRequestSequence) return;
      renderDetail(payload.detail);
    } catch (error) {
      if (state.activeDetail !== detailId || detailSequence !== state.detailRequestSequence) return;
      body.innerHTML = `<p class="empty is-error">${escapeHtml(error.message)}</p>`;
    }
  }

  function closeTreasuryDetail({ restoreFocus = true } = {}) {
    const dialog = byId("treasury-detail-dialog");
    if (!dialog || dialog.hidden) return;
    dialog.hidden = true;
    document.body.classList.remove("treasury-dialog-open");
    state.detailRequestSequence += 1;
    state.activeDetail = "";
    const target = state.lastFocus;
    state.lastFocus = null;
    if (restoreFocus && target && typeof target.focus === "function" && document.contains(target)) target.focus();
  }

  function renderDetail(detail) {
    const body = byId("treasury-detail-body");
    if (!body || !detail) return;
    if (detail.id === "bank") body.innerHTML = renderBankDetail(detail.bank);
    if (detail.id === "cash") body.innerHTML = renderCashDetail(detail);
    if (detail.id === "received-checks") body.innerHTML = renderReceivedChecksDetail(detail);
    if (detail.id === "issued-checks") body.innerHTML = renderIssuedChecksDetail(detail);
    if (detail.id === "fund") body.innerHTML = renderFundDetail(detail);
    if (detail.id === "other") body.innerHTML = renderOtherDetail(detail);
  }

  function renderBankDetail(snapshot) {
    const latest = snapshot.summary.latestBankMovement;
    const internalTransfers = snapshot.erpToBank.internalTransfers || [];
    return `
      <div class="treasury-detail-metrics">
        ${detailMetric("Saldo ERP", moneyFromCents(snapshot.summary.calculatedBalanceCents))}
        ${detailMetric("Último saldo bancario", moneyFromCents(latest?.balanceCents))}
        ${detailMetric("Diferencia", moneyFromCents(snapshot.summary.differenceCents))}
      </div>
      ${detailTable("Movimientos bancarios sin contrapartida", snapshot.bankToErp.movements, [
        ["date", "Fecha", displayDate], ["detail", "Detalle"], ["amountCents", "Importe", moneyFromCents]
      ], snapshot.bankToErp.movementsLimited)}
      ${detailTable("Pagos sin contrapartida", snapshot.erpToBank.payments, [
        ["date", "Fecha", displayDate], ["counterparty", "Contraparte"], ["amountCents", "Importe", moneyFromCents]
      ], snapshot.erpToBank.paymentsLimited)}
      ${detailTable("Cobros sin contrapartida", snapshot.erpToBank.collections, [
        ["date", "Fecha", displayDate], ["counterparty", "Contraparte"], ["amountCents", "Importe", moneyFromCents]
      ], snapshot.erpToBank.collectionsLimited)}
      ${detailTable("Transferencias internas identificadas", internalTransfers, [
        ["date", "Fecha", displayDate], ["reference", "Referencia"], ["amountCents", "Importe", moneyFromCents]
      ], snapshot.erpToBank.internalTransfersLimited)}
      <div class="treasury-actions"><button type="button" data-treasury-view="bank-reconciliation">Abrir Conciliación bancaria</button></div>`;
  }

  function renderCashDetail(detail) {
    const sourceNote = detail.summary.available
      ? `Saldo conciliado desde ${detail.summary.source}. Apertura: ${moneyFromCents(detail.summary.openingCents)}; corte cobro #${detail.summary.cutoff?.collectionId || "0"} y pago #${detail.summary.cutoff?.paymentId || "0"}.`
      : "La Caja Efectivo canónica no está disponible; no se reconstruyó desde cobros o pagos históricos.";
    return `${detailMetric("Saldo actual", detail.summary.available ? moneyFromCents(detail.summary.balanceCents) : "No disponible")}
      <p class="treasury-detail-note">${escapeHtml(sourceNote)}</p>
      ${detailTable("Libro de Caja Efectivo", detail.movements, [
        ["registeredAt", "Registrado", displayDateTime], ["date", "Fecha operativa", displayDate], ["type", "Tipo"], ["reference", "Fuente"], ["amountCents", "Importe", moneyFromCents], ["balanceCents", "Saldo", moneyFromCents], ["actor", "Usuario"]
      ])}`;
  }

  function renderReceivedChecksDetail(detail) {
    return `<div class="treasury-detail-metrics">
      ${detailMetric("Total pendiente disponible", `${detail.summary.availableCount} · ${moneyFromCents(detail.summary.availableTotalCents)}`)}
      ${nextCheckMetric("Próximo cheque a depositar", detail.summary.next, "No hay cheques pendientes con fecha programada")}
    </div>${detailTable("Cheques pendientes disponibles", detail.checks, [
      ["date", "Fecha", displayDate], ["number", "Cheque"], ["counterparty", "Cliente"], ["amountCents", "Importe", moneyFromCents]
    ], false, "No hay cheques pendientes disponibles.")}<div class="treasury-actions"><button type="button" data-treasury-view="received-check-entry">Gestionar cheques recibidos</button></div>`;
  }

  function renderIssuedChecksDetail(detail) {
    return `<div class="treasury-detail-metrics">
      ${detailMetric("Total pendiente a cubrir", `${detail.summary.pendingCount} · ${moneyFromCents(detail.summary.pendingTotalCents)}`)}
      ${nextCheckMetric("Próximo cheque a cubrir", detail.summary.next, "No hay cheques pendientes con fecha programada")}
    </div><p class="treasury-detail-note">Los pendientes se muestran como compromiso y no se restan nuevamente del saldo bancario.</p>
    ${detailTable("Instrumentos pendientes de débito o cobertura", detail.checks, [
      ["date", "Fecha", displayDate], ["instrument", "Instrumento"], ["number", "Cheque"], ["amountCents", "Importe", moneyFromCents]
    ], false, "No hay instrumentos pendientes de débito o cobertura.")}
    <p class="treasury-detail-note is-secondary">Los cheques recibidos endosados se consultan en su gestión completa: el modelo vigente los registra como pagos por Endoso, no como débitos bancarios pendientes.</p>
    <div class="treasury-actions"><button type="button" data-treasury-view="issued-check-entry">Gestionar cheques entregados</button><button type="button" class="secondary" data-treasury-view="received-check-entry">Ver endosos</button></div>`;
  }

  function renderFundDetail(detail) {
    return `<div class="treasury-detail-metrics">
      ${detailMetric("Saldo", detail.summary.available ? moneyFromCents(detail.summary.balanceCents) : "No disponible")}
      ${detailMetric("Suscripciones", String(detail.summary.subscriptionCount))}
      ${detailMetric("Rescates", String(detail.summary.redemptionCount))}
      ${detailMetric("Rendimientos", String(detail.summary.yieldCount))}
    </div>${detailTable("Historial reciente", detail.movements, [
      ["date", "Fecha", displayDate], ["type", "Tipo"], ["amountCents", "Importe", moneyFromCents], ["balanceCents", "Saldo", moneyFromCents], ["reference", "Referencia"]
    ])}<div class="treasury-actions"><button type="button" data-treasury-view="investment-fund">Abrir Fondo de inversión</button></div>`;
  }

  function renderOtherDetail(detail) {
    return `${detailTable("Aportes y retiros de socios", detail.contributions, [
      ["date", "Fecha", displayDate], ["counterparty", "Socio"], ["type", "Tipo"], ["amountCents", "Importe", moneyFromCents]
    ])}${detailTable("Transferencias internas identificadas", detail.internalTransfers, [
      ["date", "Fecha", displayDate], ["id", "Pago"], ["amountCents", "Importe", moneyFromCents]
    ])}<p class="treasury-detail-note">Sólo se muestran categorías ya persistidas. No se inventaron ajustes ni tratamientos contables.</p>
    <div class="treasury-actions"><button type="button" data-treasury-view="partner-contributions-entry">Gestionar aportes y retiros</button><button type="button" class="secondary" data-treasury-view="payments-entry">Ver pagos</button></div>`;
  }

  function detailMetric(label, value) {
    return `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></article>`;
  }

  function nextCheckMetric(label, check, emptyMessage) {
    if (!check) return `<article><span>${escapeHtml(label)}</span><strong>Sin fecha programada</strong><small>${escapeHtml(emptyMessage)}</small></article>`;
    const identification = [
      check.instrument,
      check.number ? `Cheque ${check.number}` : `ID ${check.id || "—"}`,
      check.counterparty
    ].filter(Boolean).join(" · ");
    return `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(displayDate(check.date))}</strong><small>${escapeHtml(identification)} · ${escapeHtml(moneyFromCents(check.amountCents))}</small></article>`;
  }

  function detailTable(title, rows, columns, limited = false, emptyMessage = "Sin movimientos para mostrar.") {
    const safeRows = Array.isArray(rows) ? rows : [];
    return `<section class="treasury-detail-section"><h3>${escapeHtml(title)}</h3><div class="table-wrap"><table><thead><tr>${columns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join("")}</tr></thead><tbody>${safeRows.length
      ? safeRows.map((row) => `<tr>${columns.map(([key, , formatter]) => `<td>${escapeHtml(String(formatter ? formatter(row[key]) : (row[key] || "—")))}</td>`).join("")}</tr>`).join("")
      : `<tr><td class="empty" colspan="${columns.length}">${escapeHtml(emptyMessage)}</td></tr>`}</tbody></table></div>${limited ? '<p class="treasury-list-note">Se muestran los 8 movimientos más recientes.</p>' : ""}</section>`;
  }

  function renderManagementError() {
    [
      "treasury-bank-balance",
      "treasury-cash-balance",
      "treasury-received-checks-balance",
      "treasury-issued-checks-balance",
      "treasury-fund-balance",
      "treasury-liquidity-total"
    ].forEach((id) => setText(id, "No disponible"));
    setText("treasury-bank-caption", "No se pudo actualizar el saldo ERP");
    setText("treasury-cash-caption", "No se pudo actualizar la fuente canónica");
    setText("treasury-received-checks-caption", "No se pudo actualizar la disponibilidad");
    setText("treasury-issued-checks-caption", "No se pudieron actualizar los compromisos");
    setText("treasury-fund-caption", "No se pudo actualizar la posición");
    setText("treasury-position-updated", "Datos no actualizados");
    ["collections", "payments"].forEach((type) => {
      setText(`treasury-${type}-count`, "—");
      setText(`treasury-${type}-total`, "Datos no actualizados");
      setText(`treasury-${type}-latest`, "Volvé a intentar");
    });
    renderWarnings(["No se conservaron importes anteriores: la posición financiera no pudo actualizarse."]);
  }

  function bindEvents() {
    byId("cash-boxes-refresh")?.addEventListener("click", loadCashBoxes);
    byId("view-cashbox")?.addEventListener("click", (event) => {
      const detailButton = event.target.closest("[data-treasury-detail]");
      if (detailButton) {
        openTreasuryDetail(detailButton.dataset.treasuryDetail, detailButton);
        return;
      }
      const closeButton = event.target.closest("[data-treasury-close]");
      if (closeButton) {
        closeTreasuryDetail();
        return;
      }
      const viewButton = event.target.closest("[data-treasury-view]");
      if (viewButton) {
        const targetView = viewButton.dataset.treasuryView;
        closeTreasuryDetail({ restoreFocus: false });
        switchView(targetView);
        focusViewHeading(targetView);
        return;
      }
    });
    document.addEventListener("keydown", handleDialogKeyboard);
  }

  function handleDialogKeyboard(event) {
    const dialog = byId("treasury-detail-dialog");
    if (!dialog || dialog.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeTreasuryDetail();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialog.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const focusIsInside = focusable.includes(document.activeElement);
    if (event.shiftKey && (!focusIsInside || document.activeElement === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!focusIsInside || document.activeElement === last)) {
      event.preventDefault();
      first.focus();
    }
  }

  function focusViewHeading(viewId) {
    const heading = byId(`view-${viewId}`)?.querySelector("h1, h2");
    if (!heading) return;
    heading.setAttribute("tabindex", "-1");
    heading.focus();
  }

  function displayDate(value) {
    const text = String(value || "").trim();
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : (text || "—");
  }

  function displayDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("es-AR", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "America/Argentina/Buenos_Aires"
    }).format(date);
  }

  root.loadCashBoxes = loadCashBoxes;
  root.CashBoxesModule = { load: loadCashBoxes, openDetail: openTreasuryDetail };
  document.addEventListener("DOMContentLoaded", bindEvents, { once: true });
})(globalThis);
