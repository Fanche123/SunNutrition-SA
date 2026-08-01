(function exposeArcaInvoicing(root) {
  "use strict";

  const ARCA_FISCAL = typeof module === "object" && module.exports
    ? require("../../../tools/arca-extension/arca-fiscal-contract")
    : root.ArcaFiscalContract;
  const ORDER_PRICING = typeof module === "object" && module.exports
    ? require("../../../shared/order-pricing")
    : root.OrderPricing;
  const state = {
    bound: false,
    rows: [],
    total: 0,
    loadError: "",
    selected: null,
    prepared: null,
    pollTimer: null,
    pollStartedAt: 0,
    pollFailures: 0,
    pollInFlight: false,
    sessionActive: false,
    launchSequence: 0,
    auditedTerminalStatus: ""
  };
  const POLL_TIMEOUT_MS = 5 * 60 * 1000;
  const MAX_POLL_FAILURES = 3;

  async function initializeArcaInvoicing() {
    bind();
    restoreExtensionId();
    await Promise.all([loadOrders(), loadAudit()]);
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;
    byId("arca-orders-body")?.addEventListener("click", selectOrderFromEvent);
    byId("arca-prepare-form")?.addEventListener("submit", prepareInvoice);
    byId("arca-extension-check")?.addEventListener("click", verifyExtension);
    byId("arca-refresh-status")?.addEventListener("click", refreshExtensionStatus);
    byId("arca-cancel")?.addEventListener("click", () => cancelActiveSession("manual_abort"));
    byId("arca-receipt-type")?.addEventListener("change", renderCompactReview);
    byId("arca-prepare-form")?.addEventListener("input", clearPreparedState);
    byId("arca-prepare-form")?.addEventListener("change", clearPreparedState);
    root.addEventListener?.("pagehide", cancelOnPageHide);
  }

  async function loadOrders() {
    setStatus("Cargando pedidos...", "pending");
    try {
      const orders = await loadAllEligibleOrders();
      state.rows = orders;
      state.total = orders.length;
      state.loadError = "";
      if (!state.rows.some((row) => row.id_pedido === state.selected?.id_pedido)) {
        await discardPreparedContext("manual_abort");
        state.selected = null;
      }
      renderOrders();
      renderSelection();
      setStatus(
        state.total ? `${state.total} pedido${state.total === 1 ? "" : "s"} encontrado${state.total === 1 ? "" : "s"}.` : "No hay pedidos pendientes de facturación.",
        "success"
      );
    } catch (error) {
      state.rows = [];
      state.total = 0;
      state.loadError = `No se pudieron cargar los pedidos: ${error.message}`;
      renderOrders();
      setStatus(state.loadError, "error");
    }
  }

  function normalizeOrdersPayload(payload) {
    if (!Array.isArray(payload?.rows) || !Number.isSafeInteger(payload.total) || payload.total < 0) {
      throw new Error("La respuesta del servidor no tiene el formato esperado.");
    }
    return { rows: payload.rows, total: payload.total };
  }

  function renderOrders() {
    const body = byId("arca-orders-body");
    if (!body) return;
    body.innerHTML = state.loadError
      ? `<tr><td class="empty arca-load-error" colspan="7">${escapeHtml(state.loadError)}</td></tr>`
      : state.rows.length ? state.rows.map((row) => {
      const selected = row.id_pedido === state.selected?.id_pedido;
      const deliveryTiming = expectedDeliveryTiming(row.fecha_entrega_prevista);
      const rowClasses = [
        selected ? "is-selected" : "",
        deliveryTiming ? `is-delivery-${deliveryTiming}` : ""
      ].filter(Boolean).join(" ");
      return `<tr class="${rowClasses}">
        <td class="arca-order-selector"><input type="radio" name="arca-selected-order"
          data-arca-order="${escapeHtml(row.id_pedido)}" value="${escapeHtml(row.id_pedido)}"
          aria-label="Seleccionar pedido ${escapeHtml(row.id_pedido)} de ${escapeHtml(displayNameLabel(row.cliente) || "cliente sin nombre")}"${selected ? " checked" : ""}></td>
        <td>#${escapeHtml(row.id_pedido)}</td>
        <td>${escapeHtml(displayNameLabel(row.cliente) || "-")}</td>
        <td>${expectedDeliveryMarkup(row.fecha_entrega_prevista, deliveryTiming)}</td>
        <td><span class="arca-badge ${escapeHtml(row.entrega?.estado || "entrega_pendiente")}">${escapeHtml(row.entrega?.id_entrega ? `Entrega #${row.entrega.id_entrega}` : "Entrega pendiente")}</span></td>
        <td><span class="arca-badge ${escapeHtml(row.facturacion_estado)}">${escapeHtml(billingLabel(row.facturacion_estado))}</span></td>
        <td>${escapeHtml(row.faltantes?.join(", ") || "-")}</td>
      </tr>`;
    }).join("") : '<tr><td class="empty" colspan="7">No hay pedidos pendientes de facturación.</td></tr>';
  }

  async function selectOrderFromEvent(event) {
    const selector = event.target.closest("[data-arca-order]");
    if (!selector) return;
    const next = state.rows.find((row) => row.id_pedido === selector.dataset.arcaOrder) || null;
    if (next?.id_pedido === state.selected?.id_pedido) return;
    await discardPreparedContext("manual_abort");
    state.selected = next;
    state.auditedTerminalStatus = "";
    renderOrders();
    renderSelection();
    setStatus("Pedido seleccionado. Revisá los datos fiscales y prepará la factura.", "success");
  }

  function renderSelection() {
    const empty = byId("arca-selection-empty");
    const content = byId("arca-selection-content");
    if (empty) empty.hidden = Boolean(state.selected);
    if (content) content.hidden = !state.selected;
    if (!state.selected || !content) return;
    const defaults = reviewDefaultsForOrder(state.selected);
    text("arca-summary-client", defaults.client);
    const receiptSelect = byId("arca-receipt-type");
    if (receiptSelect) receiptSelect.value = defaults.receiptType;
    if (byId("arca-invoice-date")) byId("arca-invoice-date").value = defaults.invoiceDate;
    renderCompactReview();
  }

  function renderCompactReview() {
    clearPreparedState();
    const receiptType = byId("arca-receipt-type")?.value || "";
    let lines = [];
    try {
      lines = receiptType && state.selected && !state.selected.faltantes?.length
        ? compactReviewLines(state.selected, receiptType)
        : [];
    } catch {
      lines = [];
    }
    const totals = lines.length ? ORDER_PRICING.calculateInvoice(lines) : null;
    text("arca-review-product", lines.map((line) => line.description).join(" · ") || "-");
    text("arca-review-units", lines.map((line) => `${formatNumber(line.quantity)} ${line.unitText}`).join(" · ") || "-");
    text("arca-review-unit-price", lines.map((line) => formatMoney(line.unitPrice)).join(" · ") || "-");
    text("arca-review-subtotal", totals ? formatMoney(totals.netSubtotal) : "-");
    text("arca-review-total", totals ? formatMoney(totals.total) : "-");
  }

  function compactReviewLines(order, receiptType) {
    return (order?.productos || []).map((product) => {
      const isUnits = product.clasificacion_arca === "units";
      const calculation = isUnits
        ? ORDER_PRICING.calculateLine({
          boxes: product.cantidad_cajas,
          unitsPerBox: product.unidades_por_caja,
          unitPrice: product.precio_unidad_individual,
          discountPercent: product.bonificacion,
          vatRate: ARCA_FISCAL.CONTRACT.vatRate,
          receiptType
        })
        : ORDER_PRICING.calculateMeasuredLine({
          quantity: product.cantidad_arca,
          unitPrice: product.precio_unidad_individual,
          discountPercent: product.bonificacion,
          vatRate: ARCA_FISCAL.CONTRACT.vatRate,
          receiptType
        });
      return {
        description: ARCA_FISCAL.buildLineDescription(product.cantidad_cajas, product.producto, order.domicilio),
        quantity: product.cantidad_arca,
        unitText: product.unidad_arca,
        ...calculation
      };
    });
  }

  function reviewDefaultsForOrder(order) {
    return Object.freeze({
      client: clientDisplayLabel(order?.cliente || "-") || "-",
      receiptType: normalizeReceiptType(order?.tipo_comprobante_configurado),
      invoiceDate: invoiceDateFromOrder(order)
    });
  }

  async function selectOrderById(orderId) {
    const next = state.rows.find((row) => String(row.id_pedido) === String(orderId)) || null;
    if (!next) throw new Error(`El pedido ${orderId} no está disponible para preparar en ARCA.`);
    if (next.id_pedido !== state.selected?.id_pedido) await discardPreparedContext("manual_abort");
    state.selected = next;
    state.auditedTerminalStatus = "";
    renderOrders();
    renderSelection();
    return next;
  }

  async function loadAllEligibleOrders() {
    const rows = [];
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const payload = await requestBackendApi(`/api/sales/arca/orders?limit=${limit}&offset=${offset}`);
      const page = normalizeOrdersPayload(payload);
      rows.push(...page.rows);
      if (rows.length >= page.total || page.rows.length === 0) return rows;
    }
  }

  function clientDisplayLabel(value) {
    return String(value || "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  }

  async function prepareInvoice(event) {
    event.preventDefault();
    if (!state.selected) return setStatus("Seleccioná un pedido.", "error");
    const invoiceDate = byId("arca-invoice-date")?.value || "";
    if (!ARCA_FISCAL.validIsoCalendarDate(invoiceDate)) {
      setStatus("Ingresá una fecha válida para el comprobante.", "error");
      byId("arca-invoice-date")?.focus();
      return;
    }
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    setButtonLoading(event.submitter, true, "Preparando...");
    try {
      const prepareRequest = buildPrepareRequest(
        state.selected.id_pedido,
        byId("arca-receipt-type")?.value || "",
        invoiceDate
      );
      const result = await requestBackendApi("/api/sales/arca/prepare", {
        method: "POST",
        body: JSON.stringify(prepareRequest)
      });
      state.prepared = {
        sessionId: result.sessionId,
        payload: result.payload,
        orderId: state.selected.id_pedido,
        prepareRequest
      };
      await loadAudit();
      setStatus("Factura preparada de forma segura. Abriendo la asistencia ARCA hasta revisión.", "pending");
      await openArca();
    } catch (error) {
      state.prepared = null;
      renderPreparedSummary();
      setStatus(`No se pudo preparar: ${error.message}`, "error");
    } finally {
      setButtonLoading(event.submitter, false);
    }
  }

  function renderPreparedSummary() {}

  async function openArca() {
    if (!state.prepared) return setStatus("Prepará la factura antes de abrir ARCA.", "error");
    const preparedBeforeRevalidation = state.prepared;
    const launchSequence = ++state.launchSequence;
    const extensionId = extensionIdValue();
    if (!validExtensionId(extensionId)) {
      return setStatus("No hay una extensión ARCA configurada en este navegador.", "error");
    }
    try {
      const compatibilityError = extensionContractCompatibilityError(
        await extensionMessage(extensionId, { type: "PING" })
      );
      if (compatibilityError) throw new Error(compatibilityError);
    } catch (error) {
      setStatus(`No se pudo iniciar la extensión: ${error.message}`, "error");
      return;
    }
    let current;
    try {
      current = await requestBackendApi("/api/sales/arca/prepare", {
        method: "POST",
        body: JSON.stringify(preparedBeforeRevalidation.prepareRequest)
      });
    } catch (error) {
      await discardPreparedContext("unexpected_response", { auditPrepared: true });
      setStatus(`La preparación dejó de ser válida y no se abrió ARCA: ${error.message}`, "error");
      return;
    }
    if (state.launchSequence !== launchSequence || state.prepared !== preparedBeforeRevalidation) return;
    state.prepared = {
      ...preparedBeforeRevalidation,
      sessionId: current.sessionId,
      payload: current.payload
    };
    const preparedForExtension = state.prepared;
    if (current.payload.revision !== preparedBeforeRevalidation.payload.revision) {
      renderPreparedSummary();
      setStatus("Los datos del pedido cambiaron. Revisá nuevamente el resumen antes de abrir ARCA.", "error");
      return;
    }
    try {
      const response = await extensionMessage(extensionId, {
        type: "PREPARE_SESSION",
        sessionId: preparedForExtension.sessionId,
        payload: preparedForExtension.payload
      });
      const responseGeneration = Number(response?.generation);
      const hasValidGeneration = response?.ok === true
        && Number.isSafeInteger(responseGeneration)
        && responseGeneration > 0;
      if (hasValidGeneration) preparedForExtension.generation = responseGeneration;
      if (state.launchSequence !== launchSequence || state.prepared !== preparedForExtension) {
        if (hasValidGeneration) {
          await cancelExtensionSession(extensionId, preparedForExtension.sessionId, {
            closeTab: true,
            revision: preparedForExtension.payload.revision,
            generation: preparedForExtension.generation
          });
        }
        await recordTerminalStatus("interrupted", "manual_abort", preparedForExtension.orderId);
        return;
      }
      if (!response?.ok || !hasValidGeneration) {
        const rejectedResponse = response?.ok
          ? { ...response, reason: "invalid_extension_response" }
          : response;
        const preparationError = new Error(extensionPreparationError(rejectedResponse));
        preparationError.reason = safePreparationRejectionReason(rejectedResponse?.reason);
        throw preparationError;
      }
      state.sessionActive = true;
      setStatus(
        "ARCA abierto. La extensión usa la clave cifrada; MFA y CAPTCHA siguen siendo manuales. El ERP no lee secretos.",
        "pending"
      );
      startPolling();
    } catch (error) {
      if (state.launchSequence === launchSequence && state.prepared === preparedForExtension) {
        await discardPreparedContext(error.reason || "extension_unavailable", { auditPrepared: true });
        setStatus(`No se pudo iniciar la extensión: ${error.message}`, "error");
      }
    }
  }

  async function verifyExtension() {
    const extensionId = extensionIdValue();
    if (!validExtensionId(extensionId)) return setStatus("El ID de extensión no es válido.", "error");
    try {
      const response = await extensionMessage(extensionId, { type: "PING" });
      const compatibilityError = extensionContractCompatibilityError(response);
      if (compatibilityError) throw new Error(compatibilityError);
      setStatus(
        `Extensión verificada en modo exclusivo de revisión (contrato ${ARCA_FISCAL.CONTRACT.version}).`,
        "success"
      );
    } catch (error) {
      setStatus(`No se pudo verificar la extensión: ${error.message}`, "error");
    }
  }

  function startPolling() {
    stopPolling();
    state.pollStartedAt = Date.now();
    state.pollFailures = 0;
    state.pollTimer = setInterval(refreshExtensionStatus, 2000);
    refreshExtensionStatus();
  }

  async function refreshExtensionStatus() {
    if (!state.prepared || state.pollInFlight) return;
    if (state.pollStartedAt && Date.now() - state.pollStartedAt >= POLL_TIMEOUT_MS) {
      await discardPreparedContext("timeout", { auditPrepared: true });
      setStatus("La asistencia se detuvo de forma segura: tiempo agotado.", "error");
      return;
    }
    const extensionId = extensionIdValue();
    if (!validExtensionId(extensionId)) {
      await discardPreparedContext("extension_unavailable", { auditPrepared: true });
      setStatus("La asistencia se detuvo porque el ID de la extensión dejó de ser válido.", "error");
      return;
    }
    state.pollInFlight = true;
    try {
      const response = await extensionMessage(extensionId, {
        type: "GET_SESSION_STATUS",
        sessionId: state.prepared.sessionId
      });
      if (!response?.ok) throw new Error("Estado no disponible.");
      state.pollFailures = 0;
      if (response.status === "review_reached") {
        stopPolling();
        state.sessionActive = false;
        await recordTerminalStatus("review_reached", "", state.prepared.orderId);
        setStatus("ARCA llegó a la revisión final. La automatización terminó; la emisión queda exclusivamente a tu cargo.", "success");
      } else if (response.status === "interrupted") {
        stopPolling();
        state.sessionActive = false;
        await recordTerminalStatus("interrupted", response.reason || "unexpected_response", state.prepared.orderId);
        setStatus(`La asistencia se detuvo de forma segura: ${interruptionLabel(response.reason)}.`, "error");
      } else {
        setStatus(extensionStatusLabel(response.status, response.stage), "pending");
      }
    } catch {
      state.pollFailures += 1;
      if (state.pollFailures >= MAX_POLL_FAILURES) {
        await discardPreparedContext("extension_unavailable", { auditPrepared: true });
        setStatus("La asistencia se detuvo de forma segura porque la extensión dejó de responder.", "error");
      } else {
        setStatus("No se pudo consultar el estado de la extensión. Se reintentará sin emitir nada.", "error");
      }
    } finally {
      state.pollInFlight = false;
    }
  }

  function stopPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    state.pollStartedAt = 0;
    state.pollFailures = 0;
  }

  async function recordTerminalStatus(status, reason, orderId = state.prepared?.orderId || state.selected?.id_pedido) {
    const auditKey = `${orderId}:${status}:${reason}`;
    if (!orderId || state.auditedTerminalStatus === auditKey) return;
    state.auditedTerminalStatus = auditKey;
    try {
      await requestBackendApi("/api/sales/arca/audit", {
        method: "POST",
        body: JSON.stringify({ orderId, status, reason })
      });
      await loadAudit();
    } catch {
      state.auditedTerminalStatus = "";
    }
  }

  async function discardPreparedContext(reason, { auditPrepared = false } = {}) {
    state.launchSequence += 1;
    const prepared = state.prepared;
    const wasActive = state.sessionActive;
    stopPolling();
    state.sessionActive = false;
    state.prepared = null;
    renderPreparedSummary();
    if (prepared && wasActive) {
      const extensionId = extensionIdValue();
      if (validExtensionId(extensionId)) {
        try {
          await cancelExtensionSession(extensionId, prepared.sessionId, {
            revision: prepared.payload.revision,
            generation: prepared.generation
          });
        } catch {
          // La sesión local se invalida aunque la extensión ya no responda.
        }
      }
    }
    if (prepared && (wasActive || auditPrepared)) {
      await recordTerminalStatus("interrupted", reason, prepared.orderId);
    }
  }

  async function cancelActiveSession(reason) {
    await discardPreparedContext(reason, { auditPrepared: state.sessionActive });
    setStatus("La asistencia se canceló localmente sin emitir ni modificar la venta.", "error");
  }

  function cancelOnPageHide() {
    const prepared = state.prepared;
    if (!prepared || !state.sessionActive) return;
    const extensionId = extensionIdValue();
    if (
      validExtensionId(extensionId)
      && root.chrome?.runtime?.sendMessage
      && Number.isSafeInteger(prepared.generation)
      && prepared.generation > 0
    ) {
      root.chrome.runtime.sendMessage(extensionId, {
        type: "CANCEL_SESSION",
        sessionId: prepared.sessionId,
        revision: prepared.payload.revision,
        generation: prepared.generation
      }, () => void root.chrome.runtime.lastError);
    }
    root.fetch?.("/api/sales/arca/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: prepared.orderId, status: "interrupted", reason: "manual_abort" }),
      keepalive: true
    }).catch(() => {});
    state.sessionActive = false;
    state.prepared = null;
    stopPolling();
  }

  async function loadAudit() {
    const body = byId("arca-audit-body");
    if (!body) return;
    try {
      const payload = await requestBackendApi("/api/sales/arca/audit");
      const entries = Array.isArray(payload.entries) ? payload.entries : [];
      body.innerHTML = entries.length ? entries.map((entry) => `<tr>
        <td>${escapeHtml(formatAuditDate(entry.at))}</td>
        <td>#${escapeHtml(entry.orderId)}</td>
        <td>${escapeHtml(auditStatusLabel(entry.status))}</td>
        <td>${escapeHtml(entry.reason ? interruptionLabel(entry.reason) : "-")}</td>
      </tr>`).join("") : '<tr><td class="empty" colspan="4">Todavía no hay preparaciones registradas.</td></tr>';
    } catch {
      body.innerHTML = '<tr><td class="empty" colspan="4">No se pudo leer la auditoría local.</td></tr>';
    }
  }

  function clearPreparedState() {
    if (!state.prepared) return;
    if (state.sessionActive) {
      cancelActiveSession("manual_abort");
      return;
    }
    state.launchSequence += 1;
    state.prepared = null;
    renderPreparedSummary();
  }

  async function changePage(direction) {
    await discardPreparedContext("manual_abort");
    state.offset = Math.max(0, state.offset + (direction * state.limit));
    loadOrders();
  }

  function invoiceDateFromOrder(order) {
    const value = String(order?.fecha_entrega_prevista || "");
    return ARCA_FISCAL.validIsoCalendarDate(value) ? value : "";
  }

  function buildPrepareRequest(orderId, receiptType, invoiceDate) {
    return Object.freeze({
      orderId,
      receiptType,
      invoiceDate
    });
  }

  function setInvoiceDateFromOrder(order, input = byId("arca-invoice-date")) {
    const value = invoiceDateFromOrder(order);
    if (input) input.value = value;
    return value;
  }

  function fiscalSummaryForReceipt(receiptType) {
    const rule = ARCA_FISCAL.ruleForReceipt(receiptType);
    const vatLabel = ARCA_FISCAL.CONTRACT.vatRate.toLocaleString("es-AR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    return rule
      ? `${rule.label} · Cliente: ${rule.recipientConditionLabel} · IVA fijo ${vatLabel}%.`
      : "Seleccioná Factura A o Factura B.";
  }

  function extensionMessage(extensionId, message) {
    return new Promise((resolve, reject) => {
      if (!root.chrome?.runtime?.sendMessage) return reject(new Error("Chrome/Edge no expone la extensión."));
      root.chrome.runtime.sendMessage(extensionId, message, (response) => {
        if (root.chrome.runtime.lastError) reject(new Error(root.chrome.runtime.lastError.message));
        else resolve(response);
      });
    });
  }

  function extensionContractCompatibilityError(response) {
    if (
      response?.ok === true
      && response.mode === "review_only"
      && response.contractVersion === ARCA_FISCAL.CONTRACT.version
    ) return "";
    if (
      response?.ok === true
      && response.mode === "review_only"
      && Number.isInteger(response.contractVersion)
    ) {
      return `La extensión cargada usa el contrato ${response.contractVersion}; `
        + `se requiere el ${ARCA_FISCAL.CONTRACT.version}. Recargala desde chrome://extensions.`;
    }
    return "Contrato incompatible.";
  }

  function extensionPreparationError(response) {
    const reason = String(response?.reason || "");
    if (reason === "contract_incompatible") {
      const extensionContract = Number.isInteger(response?.contractVersion)
        ? ` La extensión espera el contrato ${response.contractVersion}.`
        : "";
      return `El ERP preparó una sesión con un contrato incompatible.${extensionContract} `
        + "Reiniciá el servidor local y volvé a preparar la factura.";
    }
    return {
      payload_invalid: "Los datos preparados no cumplen el contrato fiscal vigente. Volvé a preparar la factura.",
      session_expired: "La sesión preparada venció. Volvé a preparar la factura.",
      origin_rejected: "La extensión rechazó el origen. Abrí el ERP desde http://127.0.0.1:3000.",
      association_failed: "La pestaña abierta no pudo asociarse a la sesión nueva. Cancelá y volvé a preparar.",
      manual_action_required: "Guardá nuevamente la clave cifrada desde el ícono de la extensión."
    }[reason] || "La extensión devolvió una respuesta no reconocida al preparar la sesión.";
  }

  function safePreparationRejectionReason(reason) {
    const allowed = new Set([
      "association_failed",
      "contract_incompatible",
      "manual_action_required",
      "origin_rejected",
      "payload_invalid",
      "session_expired",
      "invalid_extension_response"
    ]);
    return allowed.has(String(reason || "")) ? String(reason) : "extension_unavailable";
  }

  function cancelExtensionSession(
    extensionId,
    sessionId,
    { closeTab = false, revision = "", generation = 0 } = {}
  ) {
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      return Promise.resolve({ ok: false, status: "rejected", reason: "invalid_extension_response" });
    }
    return extensionMessage(extensionId, {
      type: "CANCEL_SESSION",
      sessionId,
      revision,
      generation,
      closeTab
    });
  }

  function restoreExtensionId() {
    return extensionIdValue();
  }

  function extensionIdValue() {
    const configured = root.localStorage?.getItem("sunnutrition.arcaExtensionId")
      || byId("arca-extension-id")?.value
      || "";
    return String(configured).trim().toLowerCase();
  }

  function validExtensionId(value) {
    return /^[a-p]{32}$/.test(String(value || ""));
  }

  function suggestReceiptType(issuer, recipient) {
    if (issuer !== ARCA_FISCAL.CONTRACT.issuerCondition) return "";
    return ARCA_FISCAL.CONTRACT.receiptTypes.find(
      (receiptType) => ARCA_FISCAL.ruleForReceipt(receiptType)?.recipientCondition === recipient
    ) || "";
  }

  function normalizeReceiptType(value) {
    const match = normalizeText(value).match(/^factura[ _-]*([ab])$/);
    return match ? `Factura_${match[1].toUpperCase()}` : "";
  }

  function normalizeText(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  }

  function setButtonLoading(button, loading, label = "") {
    if (!button) return;
    if (loading) {
      button.dataset.originalLabel = button.textContent;
      button.textContent = label;
    } else if (button.dataset.originalLabel) {
      button.textContent = button.dataset.originalLabel;
      delete button.dataset.originalLabel;
    }
    button.disabled = loading;
  }

  function setStatus(message, kind) {
    const status = byId("arca-status");
    if (!status) return;
    status.textContent = message;
    status.dataset.status = kind;
  }

  function billingLabel(value) {
    return {
      listo: "Listo",
      datos_incompletos: "Datos incompletos"
    }[value] || value;
  }

  function extensionStatusLabel(value, stage = "") {
    const stageLabels = {
      representative: "empresa representada",
      service: "Generar comprobantes",
      initial: "punto de venta y tipo de comprobante",
      emission: "datos de emisión",
      recipient: "datos del receptor",
      lines: "líneas e importes"
    };
    return {
      prepared: "Datos preparados; abriendo ARCA...",
      waiting_login: "Completando el acceso con la clave cifrada. MFA y CAPTCHA requieren intervención manual.",
      waiting_representative: "Validando y eligiendo SunNutrition en ARCA.",
      service_recognized: "Comprobantes en línea reconocido; abriendo Generar comprobantes.",
      completing_stage: `Completando ${stageLabels[stage] || "una etapa reconocida"} en ARCA.`,
      fields_completed: `Campos de ${stageLabels[stage] || "la etapa reconocida"} completos; avanzando a la siguiente etapa segura.`
    }[value] || "Asistencia en curso.";
  }

  function interruptionLabel(value) {
    return {
      extension_unavailable: "extensión no disponible",
      invalid_extension_response: "respuesta inválida de la extensión",
      manual_abort: "cancelada por el usuario",
      network_error: "red no disponible",
      screen_unrecognized: "pantalla no reconocida",
      selector_changed: "ARCA cambió un campo o selector",
      session_expired: "sesión vencida",
      timeout: "tiempo agotado",
      unexpected_response: "respuesta inesperada"
    }[value] || "motivo no reconocido";
  }

  function auditStatusLabel(value) {
    return {
      prepared: "Preparado",
      review_reached: "Llegó a revisión",
      interrupted: "Interrumpido"
    }[value] || value;
  }

  function formatAuditDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("es-AR");
  }

  function expectedDeliveryMarkup(value, timing = expectedDeliveryTiming(value)) {
    if (!validIsoCalendarDate(value)) return "Sin fecha prevista";
    const timingLabel = timing === "today"
      ? "Entrega hoy"
      : (timing === "tomorrow" ? "Entrega mañana" : "");
    return `<span class="arca-delivery-date">${escapeHtml(formatDate(value))}${
      timingLabel
        ? `<span class="arca-delivery-priority">${escapeHtml(timingLabel)}</span>`
        : ""
    }</span>`;
  }

  function expectedDeliveryTiming(value, now = new Date()) {
    if (!validIsoCalendarDate(value)) return "";
    const today = argentinaCalendarIso(now);
    if (value === today) return "today";
    return value === addIsoCalendarDays(today, 1) ? "tomorrow" : "";
  }

  function argentinaCalendarIso(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function addIsoCalendarDays(value, days) {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return date.toISOString().slice(0, 10);
  }

  function validIsoCalendarDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
  }

  function byId(id) {
    return root.document?.getElementById(id);
  }

  function text(id, value) {
    const element = byId(id);
    if (element) element.textContent = value;
  }

  root.initializeArcaInvoicing = initializeArcaInvoicing;
  root.cancelArcaInvoicing = cancelActiveSession;
  root.selectArcaInvoicingOrder = selectOrderById;
  if (typeof module === "object" && module.exports) {
    module.exports = {
      argentinaCalendarIso,
      buildPrepareRequest,
      compactReviewLines,
      expectedDeliveryMarkup,
      expectedDeliveryTiming,
      extensionContractCompatibilityError,
      extensionPreparationError,
      safePreparationRejectionReason,
      extensionStatusLabel,
      fiscalSummaryForReceipt,
      invoiceDateFromOrder,
      normalizeReceiptType,
      normalizeOrdersPayload,
      reviewDefaultsForOrder,
      setInvoiceDateFromOrder,
      suggestReceiptType,
      validExtensionId,
      __testing: { cancelOnPageHide, openArca, state }
    };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
