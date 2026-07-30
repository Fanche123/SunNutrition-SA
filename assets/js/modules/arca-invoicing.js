(function exposeArcaInvoicing(root) {
  "use strict";

  const state = {
    bound: false,
    rows: [],
    total: 0,
    offset: 0,
    limit: 25,
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
  const VAT_RATES = [0, 2.5, 5, 10.5, 21, 27];
  const POLL_TIMEOUT_MS = 5 * 60 * 1000;
  const MAX_POLL_FAILURES = 3;

  async function initializeArcaInvoicing() {
    bind();
    defaultInvoiceDate();
    restoreExtensionId();
    await Promise.all([loadOrders(), loadAudit()]);
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;
    byId("arca-orders-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await discardPreparedContext("manual_abort");
      state.offset = 0;
      loadOrders();
    });
    byId("arca-orders-body")?.addEventListener("click", selectOrderFromEvent);
    byId("arca-previous")?.addEventListener("click", () => changePage(-1));
    byId("arca-next")?.addEventListener("click", () => changePage(1));
    byId("arca-prepare-form")?.addEventListener("submit", prepareInvoice);
    byId("arca-open")?.addEventListener("click", openArca);
    byId("arca-extension-check")?.addEventListener("click", verifyExtension);
    byId("arca-refresh-status")?.addEventListener("click", refreshExtensionStatus);
    byId("arca-cancel")?.addEventListener("click", () => cancelActiveSession("manual_abort"));
    ["arca-issuer-condition", "arca-recipient-condition"].forEach((id) => {
      byId(id)?.addEventListener("change", updateReceiptSuggestion);
    });
    byId("arca-extension-id")?.addEventListener("change", saveExtensionId);
    byId("arca-prepare-form")?.addEventListener("input", clearPreparedState);
    byId("arca-prepare-form")?.addEventListener("change", clearPreparedState);
    byId("arca-products-body")?.addEventListener("change", clearPreparedState);
    root.addEventListener?.("pagehide", cancelOnPageHide);
  }

  async function loadOrders() {
    setStatus("Cargando pedidos...", "pending");
    const params = new URLSearchParams({
      query: byId("arca-search")?.value || "",
      status: byId("arca-status-filter")?.value || "unbilled",
      limit: String(state.limit),
      offset: String(state.offset)
    });
    try {
      const payload = await requestBackendApi(`/api/sales/arca/orders?${params}`);
      state.rows = Array.isArray(payload.rows) ? payload.rows : [];
      state.total = Number(payload.total) || 0;
      if (!state.rows.some((row) => row.id_pedido === state.selected?.id_pedido)) {
        await discardPreparedContext("manual_abort");
        state.selected = null;
      }
      renderOrders();
      renderSelection();
      setStatus(
        state.total ? `${state.total} pedido${state.total === 1 ? "" : "s"} encontrado${state.total === 1 ? "" : "s"}.` : "No hay pedidos para estos filtros.",
        "success"
      );
    } catch (error) {
      state.rows = [];
      state.total = 0;
      renderOrders();
      setStatus(`No se pudieron cargar los pedidos: ${error.message}`, "error");
    }
  }

  function renderOrders() {
    const body = byId("arca-orders-body");
    if (!body) return;
    body.innerHTML = state.rows.length ? state.rows.map((row) => {
      const selected = row.id_pedido === state.selected?.id_pedido;
      const deliveryTiming = expectedDeliveryTiming(row.fecha_entrega_prevista);
      const rowClasses = [
        selected ? "is-selected" : "",
        deliveryTiming ? `is-delivery-${deliveryTiming}` : ""
      ].filter(Boolean).join(" ");
      return `<tr class="${rowClasses}">
        <td><button type="button" class="secondary compact-button" data-arca-order="${escapeHtml(row.id_pedido)}"
          >${selected ? "Elegido" : "Revisar"}</button></td>
        <td>#${escapeHtml(row.id_pedido)}</td>
        <td>${escapeHtml(displayNameLabel(row.cliente) || "-")}</td>
        <td>${expectedDeliveryMarkup(row.fecha_entrega_prevista, deliveryTiming)}</td>
        <td><span class="arca-badge entrega_pendiente">Entrega pendiente</span></td>
        <td><span class="arca-badge ${escapeHtml(row.facturacion_estado)}">${escapeHtml(billingLabel(row.facturacion_estado))}</span></td>
        <td>${escapeHtml(row.faltantes?.join(", ") || "-")}</td>
      </tr>`;
    }).join("") : '<tr><td class="empty" colspan="7">No hay pedidos para mostrar.</td></tr>';
    const from = state.total ? state.offset + 1 : 0;
    const to = Math.min(state.offset + state.limit, state.total);
    if (byId("arca-page-info")) byId("arca-page-info").textContent = `${from}–${to} de ${state.total}`;
    if (byId("arca-previous")) byId("arca-previous").disabled = state.offset === 0;
    if (byId("arca-next")) byId("arca-next").disabled = state.offset + state.limit >= state.total;
  }

  async function selectOrderFromEvent(event) {
    const button = event.target.closest("[data-arca-order]");
    if (!button) return;
    const next = state.rows.find((row) => row.id_pedido === button.dataset.arcaOrder) || null;
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
    const order = state.selected;
    text("arca-summary-order", `#${order.id_pedido}`);
    text("arca-summary-client", order.cliente || "-");
    text("arca-summary-cuit", order.cuit || "Falta CUIT");
    text("arca-summary-condition", order.condicion_fiscal || "Falta condición fiscal");
    text("arca-summary-address", order.domicilio || "Falta domicilio");
    text("arca-summary-date", formatDate(order.fecha_pedido));
    text("arca-summary-delivery", `Prevista ${formatDate(order.fecha_entrega_prevista)}`);
    const recipientSelect = byId("arca-recipient-condition");
    const inferredCondition = normalizeFiscalCondition(order.condicion_fiscal);
    if (recipientSelect && inferredCondition) recipientSelect.value = inferredCondition;
    const configuredType = normalizeReceiptType(order.tipo_comprobante_configurado);
    if (configuredType && byId("arca-receipt-type")) byId("arca-receipt-type").value = configuredType;
    renderProducts(order.productos || []);
    updateReceiptSuggestion();
    renderPreparedSummary();
  }

  function renderProducts(products) {
    const body = byId("arca-products-body");
    if (!body) return;
    body.innerHTML = products.map((product) => `<tr>
      <td>${escapeHtml(displayNameLabel(product.producto) || "-")}</td>
      <td class="num">${escapeHtml(formatNumber(product.cantidad_cajas))}</td>
      <td class="num">${escapeHtml(formatNumber(product.unidades_por_caja))}</td>
      <td class="num">${escapeHtml(formatNumber(product.unidades_individuales))}</td>
      <td class="num">${escapeHtml(formatMoney(product.precio_unidad_individual))}</td>
      <td class="num">${escapeHtml(`${formatNumber(product.bonificacion)}%`)}</td>
      <td>
        <select data-arca-vat="${escapeHtml(product.id_detalle_pedido)}" aria-label="IVA de ${escapeHtml(product.producto)}" required>
          <option value="">Elegir IVA</option>
          ${VAT_RATES.map((rate) => `<option value="${rate}">${formatNumber(rate)}%</option>`).join("")}
        </select>
      </td>
    </tr>`).join("");
  }

  function updateReceiptSuggestion() {
    const issuer = byId("arca-issuer-condition")?.value || "";
    const recipient = byId("arca-recipient-condition")?.value || "";
    const suggestion = suggestReceiptType(issuer, recipient);
    text("arca-receipt-suggestion", suggestion
      ? `Sugerencia según condiciones seleccionadas: ${suggestion.replace("_", " ")}.`
      : "Seleccioná ambas condiciones para obtener una sugerencia.");
  }

  async function prepareInvoice(event) {
    event.preventDefault();
    if (!state.selected) return setStatus("Seleccioná un pedido.", "error");
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const vatRates = {};
    const vatSelects = [...(byId("arca-products-body")?.querySelectorAll("[data-arca-vat]") || [])];
    if (!vatSelects.length || vatSelects.some((select) => !select.value)) {
      setStatus("Seleccioná la alícuota de IVA de todos los productos.", "error");
      return;
    }
    vatSelects.forEach((select) => {
      vatRates[select.dataset.arcaVat] = select.value;
    });
    setButtonLoading(event.submitter, true, "Preparando...");
    try {
      const prepareRequest = {
        orderId: state.selected.id_pedido,
        pointOfSale: byId("arca-point-of-sale")?.value || "",
        receiptType: byId("arca-receipt-type")?.value || "",
        issuerCondition: byId("arca-issuer-condition")?.value || "",
        recipientCondition: byId("arca-recipient-condition")?.value || "",
        invoiceDate: byId("arca-invoice-date")?.value || "",
        vatRates
      };
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
      renderPreparedSummary();
      await loadAudit();
      setStatus("Factura preparada localmente. Revisá el resumen antes de abrir ARCA.", "success");
    } catch (error) {
      state.prepared = null;
      renderPreparedSummary();
      setStatus(`No se pudo preparar: ${error.message}`, "error");
    } finally {
      setButtonLoading(event.submitter, false);
    }
  }

  function renderPreparedSummary() {
    const panel = byId("arca-prepared-summary");
    const openButton = byId("arca-open");
    if (panel) panel.hidden = !state.prepared;
    if (openButton) openButton.disabled = !state.prepared;
    if (!state.prepared) return;
    const { payload } = state.prepared;
    text("arca-total-net", formatMoney(payload.invoice.totals.netSubtotal));
    text("arca-total-vat", formatMoney(payload.invoice.totals.vat));
    text("arca-total-final", formatMoney(payload.invoice.totals.total));
    const body = byId("arca-prepared-lines");
    if (body) body.innerHTML = payload.lines.map((line) => `<tr>
      <td>${escapeHtml(line.description)}</td>
      <td class="num">${escapeHtml(formatNumber(line.individualUnits))}</td>
      <td class="num">${escapeHtml(formatMoney(line.unitPrice))}</td>
      <td class="num">${escapeHtml(`${formatNumber(line.discountPercent)}%`)}</td>
      <td class="num">${escapeHtml(`${formatNumber(line.vatRate)}%`)}</td>
      <td class="num">${escapeHtml(formatMoney(line.netSubtotal))}</td>
      <td class="num">${escapeHtml(formatMoney(line.vat))}</td>
      <td class="num">${escapeHtml(formatMoney(line.total))}</td>
    </tr>`).join("");
  }

  async function openArca() {
    if (!state.prepared) return setStatus("Prepará la factura antes de abrir ARCA.", "error");
    const preparedBeforeRevalidation = state.prepared;
    const launchSequence = ++state.launchSequence;
    const extensionId = extensionIdValue();
    if (!validExtensionId(extensionId)) {
      return setStatus("Ingresá el ID válido de la extensión instalada.", "error");
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
      if (state.launchSequence !== launchSequence || state.prepared !== preparedForExtension) {
        await cancelExtensionSession(extensionId, preparedForExtension.sessionId, { closeTab: true });
        await recordTerminalStatus("interrupted", "manual_abort", preparedForExtension.orderId);
        return;
      }
      if (!response?.ok) throw new Error("La extensión rechazó la sesión.");
      state.sessionActive = true;
      setStatus("ARCA abierto. Login, MFA y CAPTCHA son manuales. El ERP seguirá el estado sin leer secretos.", "pending");
      startPolling();
    } catch (error) {
      if (state.launchSequence === launchSequence && state.prepared === preparedForExtension) {
        await discardPreparedContext("extension_unavailable", { auditPrepared: true });
        setStatus(`No se pudo iniciar la extensión: ${error.message}`, "error");
      }
    }
  }

  async function verifyExtension() {
    const extensionId = extensionIdValue();
    if (!validExtensionId(extensionId)) return setStatus("El ID de extensión no es válido.", "error");
    try {
      const response = await extensionMessage(extensionId, { type: "PING" });
      if (!response?.ok || response.mode !== "review_only") throw new Error("Contrato incompatible.");
      setStatus("Extensión verificada en modo exclusivo de revisión.", "success");
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
          await cancelExtensionSession(extensionId, prepared.sessionId);
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
    if (validExtensionId(extensionId) && root.chrome?.runtime?.sendMessage) {
      root.chrome.runtime.sendMessage(extensionId, {
        type: "CANCEL_SESSION",
        sessionId: prepared.sessionId
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

  function defaultInvoiceDate() {
    const input = byId("arca-invoice-date");
    if (input && !input.value) input.value = localDateIso(new Date());
  }

  function localDateIso(date) {
    return [
      String(date.getFullYear()).padStart(4, "0"),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
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

  function cancelExtensionSession(extensionId, sessionId, { closeTab = false } = {}) {
    return extensionMessage(extensionId, {
      type: "CANCEL_SESSION",
      sessionId,
      closeTab
    });
  }

  function saveExtensionId() {
    const value = extensionIdValue();
    if (validExtensionId(value)) root.localStorage?.setItem("sunnutrition.arcaExtensionId", value);
  }

  function restoreExtensionId() {
    const input = byId("arca-extension-id");
    const saved = root.localStorage?.getItem("sunnutrition.arcaExtensionId") || "";
    if (input && validExtensionId(saved)) input.value = saved;
  }

  function extensionIdValue() {
    return String(byId("arca-extension-id")?.value || "").trim().toLowerCase();
  }

  function validExtensionId(value) {
    return /^[a-p]{32}$/.test(String(value || ""));
  }

  function suggestReceiptType(issuer, recipient) {
    if (issuer === "responsable_inscripto") {
      return ["responsable_inscripto", "monotributista"].includes(recipient)
        ? "Factura_A"
        : (recipient ? "Factura_B" : "");
    }
    return ["monotributista", "exento"].includes(issuer) && recipient ? "Factura_C" : "";
  }

  function normalizeFiscalCondition(value) {
    const textValue = normalizeText(value);
    if (/monotrib/.test(textValue)) return "monotributista";
    if (/responsable.*inscrip/.test(textValue)) return "responsable_inscripto";
    if (/consumidor.*final/.test(textValue)) return "consumidor_final";
    if (/exent/.test(textValue)) return "exento";
    if (/no.*alcanz/.test(textValue)) return "no_alcanzado";
    if (/no.*categoriz/.test(textValue)) return "no_categorizado";
    return "";
  }

  function normalizeReceiptType(value) {
    const match = normalizeText(value).match(/factura\s*([abc])\b/);
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
      initial: "punto de venta y tipo de comprobante",
      recipient: "datos del receptor",
      lines: "líneas e importes"
    };
    return {
      prepared: "Datos preparados; abriendo ARCA...",
      waiting_login: "Esperando el login manual en ARCA. La extensión no lee credenciales.",
      waiting_representative: "Esperando que elijas SunNutrition manualmente en ARCA.",
      service_recognized: "Comprobantes en línea reconocido. Elegí Generar comprobantes manualmente.",
      completing_stage: `Completando ${stageLabels[stage] || "una etapa reconocida"} en ARCA.`,
      fields_completed: `Campos de ${stageLabels[stage] || "la etapa reconocida"} completos; revisalos y continuá manualmente.`
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
  if (typeof module === "object" && module.exports) {
    module.exports = {
      argentinaCalendarIso,
      expectedDeliveryMarkup,
      expectedDeliveryTiming,
      extensionStatusLabel,
      normalizeFiscalCondition,
      normalizeReceiptType,
      localDateIso,
      suggestReceiptType,
      validExtensionId
    };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
