(function initializeSalesWorkflowModule(root) {
  "use strict";

  const state = {
    bound: false,
    loading: false,
    loadVersion: 0,
    managed: false,
    rows: [],
    activeAction: "",
    activeOrder: null,
    movedNode: null,
    marker: null,
    dirty: false,
    orderOperationId: ""
  };

  async function loadSalesWorkflow() {
    bind();
    const requestedManaged = state.managed;
    const loadVersion = ++state.loadVersion;
    state.loading = true;
    setStatus(requestedManaged ? "Cargando pedidos gestionados..." : "Cargando bandeja...", "pending");
    try {
      const payload = await requestBackendApi(`/api/sales/workflow?managed=${requestedManaged ? "1" : "0"}`);
      if (loadVersion !== state.loadVersion) return;
      state.rows = Array.isArray(payload.rows) ? payload.rows : [];
      render();
      setStatus(
        state.rows.length
          ? `${state.rows.length} pedido${state.rows.length === 1 ? "" : "s"} ${requestedManaged ? "gestionado" : "abierto"}${state.rows.length === 1 ? "" : "s"}.`
          : requestedManaged ? "No hay pedidos gestionados." : "No hay pedidos abiertos.",
        "success"
      );
    } catch (error) {
      if (loadVersion !== state.loadVersion) return;
      state.rows = [];
      render();
      setStatus(`No se pudo cargar Gestión de Ventas: ${error.message}`, "error");
    } finally {
      if (loadVersion === state.loadVersion) state.loading = false;
    }
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;
    byId("sales-workflow-new-order")?.addEventListener("click", openNewOrder);
    byId("sales-workflow-managed-toggle")?.addEventListener("click", toggleManaged);
    byId("sales-workflow-body")?.addEventListener("click", handleTableAction);
    byId("sales-workflow-dialog")?.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDialog();
    });
    byId("sales-workflow-dialog")?.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeDialog();
    });
    byId("sales-workflow-dialog")?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeDialog();
    });
    byId("sales-workflow-dialog")?.addEventListener("input", () => { state.dirty = true; });
    byId("sales-workflow-dialog")?.addEventListener("change", () => { state.dirty = true; });
    document.querySelector(".sales-workflow-dialog-close")?.addEventListener("click", () => closeDialog());
    root.addEventListener("sales-workflow:order-saved", handleOperationSaved);
    root.addEventListener("sales-workflow:delivery-saved", handleOperationSaved);
    root.addEventListener("sales-workflow:sale-saved", handleOperationSaved);
  }

  function render() {
    const body = byId("sales-workflow-body");
    if (!body) return;
    body.innerHTML = state.rows.length ? state.rows.map(renderRow).join("") : `
      <tr><td class="empty" colspan="8">${state.managed ? "No hay pedidos gestionados." : "No hay pedidos abiertos."}</td></tr>`;
  }

  function renderRow(row) {
    const timing = row.managed ? "" : deliveryTiming(row.fecha_entrega_prevista);
    const rowClass = timing ? ` class="sales-workflow-${timing}"` : "";
    return `<tr${rowClass}>
      <td>${escapeHtml(formatDate(row.fecha_entrega_prevista) || "Sin fecha")}${timingLabel(timing)}</td>
      <td><strong>#${escapeHtml(row.id_pedido)}</strong>${row.historicalResolved ? '<small class="sales-workflow-note">Histórico resuelto</small>' : ""}</td>
      <td>${escapeHtml(displayNameLabel(row.cliente) || `Cliente ${row.id_cliente}`)}</td>
      <td class="sales-workflow-detail">${escapeHtml(row.detalle_resumido || "Sin detalle")}</td>
      <td>${actionButton(row, "arca", "Crear factura")}</td>
      <td>${actionButton(row, "delivery", "Nueva entrega")}</td>
      <td>${actionButton(row, "sale", "Adjuntar y registrar")}</td>
      <td>${closeButton(row)}</td>
    </tr>`;
  }

  function actionButton(row, action, pendingLabel) {
    const complete = Boolean(row.completion?.[action]);
    const label = complete ? `✓ ${action === "arca" ? "Factura" : action === "delivery" ? "Entrega" : "Venta"}` : pendingLabel;
    return `<button type="button" class="sales-workflow-action ${complete ? "is-complete" : "is-pending"}"
      data-sales-workflow-action="${action}" data-order-id="${escapeHtml(row.id_pedido)}">${label}</button>`;
  }

  function closeButton(row) {
    if (row.managed) return `<button type="button" class="sales-workflow-close is-complete" data-sales-workflow-action="managed-detail" data-order-id="${escapeHtml(row.id_pedido)}">✓ Gestionado</button>`;
    return `<button type="button" class="sales-workflow-close${row.canClose ? " is-ready" : ""}" data-sales-workflow-action="close" data-order-id="${escapeHtml(row.id_pedido)}" ${row.canClose ? "" : "disabled"} aria-label="Cerrar pedido ${escapeHtml(row.id_pedido)}">✓</button>`;
  }

  async function handleTableAction(event) {
    const button = event.target.closest("[data-sales-workflow-action]");
    if (!button) return;
    const row = state.rows.find((item) => String(item.id_pedido) === String(button.dataset.orderId));
    if (!row) return;
    const action = button.dataset.salesWorkflowAction;
    if (action === "close") return closeOrder(row, button);
    if (action === "managed-detail") return openDetail(row, "managed");
    if (row.completion?.[action]) return openDetail(row, action);
    if (action === "arca") return openArca(row);
    if (action === "delivery") return openDelivery(row);
    if (action === "sale") return openSale(row);
  }

  async function openNewOrder() {
    await loadCommercialEntryData(true);
    renderOrderEntry();
    state.orderOperationId = newOperationId("pedido");
    openMovedDialog("Nuevo pedido", document.querySelector("#view-orders-entry > .panel"), "order", null);
  }

  async function openArca(row) {
    setStatus(`Preparando el pedido #${row.id_pedido}...`, "pending");
    try {
      await loadDeferredScript("tools/arca-extension/arca-fiscal-contract.js?v=20260730-operation-data", "initializeArcaFiscalContract");
      await loadDeferredScript("shared/order-pricing.js?v=20260724-money-contract", "OrderPricing");
      const initialize = await loadDeferredScript("assets/js/modules/arca-invoicing.js?v=20260731-orders-restore", "initializeArcaInvoicing");
      await initialize();
      await root.selectArcaInvoicingOrder(row.id_pedido);
      // La bandeja ya determinó el pedido. Sólo se reutiliza la revisión canónica:
      // la lista/radios de ARCA permanece en su pantalla y no puede cambiar la selección.
      openMovedDialog("Crear factura", document.querySelector("#view-arca-invoicing > .arca-invoicing-layout > .arca-review-panel"), "arca", row);
      const footer = byId("sales-workflow-dialog-footer");
      footer.hidden = false;
      footer.innerHTML = `<p>El ERP no emite ni consulta el CAE. Confirmá sólo después de generar la factura manualmente.</p>
        <button type="button" id="sales-workflow-arca-confirm">Confirmar factura generada</button>`;
      byId("sales-workflow-arca-confirm")?.addEventListener("click", () => confirmArca(row));
      setStatus("", "");
    } catch (error) {
      setStatus(`No se pudo abrir Facturación ARCA: ${error.message}`, "error");
    }
  }

  async function openDelivery(row) {
    await loadCommercialEntryData(true);
    renderLogisticsEntry();
    openMovedDialog("Nueva entrega", document.querySelector("#view-logistics-entry > .panel:first-child"), "delivery", row);
    const checkbox = [...document.querySelectorAll("[data-logistics-order]")]
      .find((input) => String(input.dataset.logisticsOrder) === String(row.id_pedido));
    if (checkbox) {
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    }
    state.dirty = false;
  }

  async function openSale(row) {
    initializeSalesInvoiceEntry();
    await loadUnbilledSalesOrders();
    root.selectSalesInvoiceWorkflowOrder(row);
    openMovedDialog("Adjuntar factura y crear venta", document.querySelector("#view-sales-invoice-entry > .panel"), "sale", row);
  }

  function openDetail(row, action) {
    const content = action === "arca"
      ? `<dl class="sales-workflow-detail-list"><dt>Pedido</dt><dd>#${escapeHtml(row.id_pedido)}</dd><dt>Confirmada</dt><dd>${escapeHtml(formatDateTime(row.workflow?.factura_arca_confirmada_en) || "Histórica, inferida por venta y entrega")}</dd><dt>Usuario</dt><dd>${escapeHtml(row.workflow?.factura_arca_confirmada_por || "Histórico")}</dd></dl>`
      : action === "delivery"
        ? `<dl class="sales-workflow-detail-list"><dt>Entrega</dt><dd>#${escapeHtml(row.delivery?.id_entrega || "-")}</dd><dt>Fecha</dt><dd>${escapeHtml(formatDate(row.delivery?.fecha) || "-")}</dd><dt>Flete</dt><dd>${escapeHtml(row.delivery?.id_flete || "-")}</dd></dl>`
        : action === "sale"
          ? saleDetail(row)
          : `<dl class="sales-workflow-detail-list"><dt>Pedido</dt><dd>#${escapeHtml(row.id_pedido)}</dd><dt>Estado</dt><dd>${row.historicalResolved ? "Histórico resuelto antes del workflow" : "Cerrado manualmente"}</dd><dt>Cierre</dt><dd>${escapeHtml(formatDateTime(row.workflow?.cerrado_en) || "Inicialización histórica")}</dd><dt>Usuario</dt><dd>${escapeHtml(row.workflow?.cerrado_por || "Histórico")}</dd></dl>`;
    openHtmlDialog(action === "managed" ? "Pedido gestionado" : "Detalle", content, action, row);
  }

  function saleDetail(row) {
    const sale = row.sale || {};
    const fileLink = sale.archivo_factura
      ? `<a href="/${escapeHtml(sale.archivo_factura)}" target="_blank" rel="noopener">Abrir ${escapeHtml(sale.archivo_factura_nombre || "factura")}</a>`
      : "Sin adjunto";
    return `<dl class="sales-workflow-detail-list"><dt>Venta</dt><dd>#${escapeHtml(sale.id_venta || "-")}</dd><dt>Comprobante</dt><dd>${escapeHtml(`${sale.tipo_factura || ""} ${sale.nro_factura || ""}`.trim() || "-")}</dd><dt>Fecha</dt><dd>${escapeHtml(formatDate(sale.fecha_factura) || "-")}</dd><dt>Total</dt><dd>${escapeHtml(formatMoney(sale.total || 0))}</dd><dt>Archivo</dt><dd>${fileLink}</dd></dl>`;
  }

  function openMovedDialog(title, node, action, row) {
    if (!node) throw new Error("El formulario reutilizable no está disponible.");
    restoreMovedNode();
    const marker = document.createComment(`sales-workflow-${action}`);
    node.parentNode.insertBefore(marker, node);
    state.marker = marker;
    state.movedNode = node;
    state.activeAction = action;
    state.activeOrder = row;
    state.dirty = false;
    byId("sales-workflow-dialog").dataset.action = action;
    byId("sales-workflow-dialog-title").textContent = title;
    byId("sales-workflow-dialog-body").replaceChildren(node);
    const footer = byId("sales-workflow-dialog-footer");
    footer.hidden = true;
    footer.replaceChildren();
    byId("sales-workflow-dialog").showModal();
    firstFocusable()?.focus();
  }

  function openHtmlDialog(title, html, action, row) {
    restoreMovedNode();
    state.activeAction = action;
    state.activeOrder = row;
    state.dirty = false;
    byId("sales-workflow-dialog").dataset.action = action;
    byId("sales-workflow-dialog-title").textContent = title;
    byId("sales-workflow-dialog-body").innerHTML = `<section class="sales-workflow-readonly-detail">${html}</section>`;
    const footer = byId("sales-workflow-dialog-footer");
    footer.hidden = true;
    footer.replaceChildren();
    byId("sales-workflow-dialog").showModal();
    firstFocusable()?.focus();
  }

  async function confirmArca(row) {
    if (!root.confirm("¿Confirmás que la factura fue generada fuera del ERP?")) return;
    const button = byId("sales-workflow-arca-confirm");
    if (button) button.disabled = true;
    try {
      await requestBackendApi("/api/sales/workflow/arca-confirmation", {
        method: "POST",
        body: JSON.stringify({ orderId: row.id_pedido })
      });
      closeDialog(true);
      await loadSalesWorkflow();
    } catch (error) {
      setStatus(error.message, "error");
      if (button) button.disabled = false;
    }
  }

  async function closeOrder(row, button) {
    if (!row.canClose || !root.confirm(`¿Cerrar la gestión del pedido #${row.id_pedido}?`)) return;
    button.disabled = true;
    try {
      await requestBackendApi("/api/sales/workflow/close", {
        method: "POST",
        body: JSON.stringify({ orderId: row.id_pedido })
      });
      await loadSalesWorkflow();
    } catch (error) {
      setStatus(error.message, "error");
      button.disabled = false;
    }
  }

  function closeDialog(force = false) {
    const dialog = byId("sales-workflow-dialog");
    if (!dialog?.open) return;
    if (!force && state.dirty && !root.confirm("Hay cambios sin guardar. ¿Cerrar el popup y descartarlos?")) return;
    if (state.activeAction === "arca") root.cancelArcaInvoicing?.("manual_abort");
    dialog.close();
    restoreMovedNode();
    state.activeAction = "";
    state.activeOrder = null;
    state.dirty = false;
    delete dialog.dataset.action;
  }

  function restoreMovedNode() {
    if (state.movedNode && state.marker?.parentNode) state.marker.parentNode.insertBefore(state.movedNode, state.marker);
    state.marker?.remove();
    state.movedNode = null;
    state.marker = null;
  }

  async function handleOperationSaved() {
    state.orderOperationId = "";
    closeDialog(true);
    await loadSalesWorkflow();
  }

  async function toggleManaged() {
    state.managed = !state.managed;
    const button = byId("sales-workflow-managed-toggle");
    button?.setAttribute("aria-pressed", String(state.managed));
    if (button) button.textContent = state.managed ? "Volver a abiertos" : "Ver gestionados";
    byId("sales-workflow-new-order").hidden = state.managed;
    await loadSalesWorkflow();
  }

  function orderRequestMetadata() {
    if (state.activeAction !== "order") return null;
    state.orderOperationId ||= newOperationId("pedido");
    return { operationId: state.orderOperationId };
  }

  function newOperationId(prefix) {
    const id = root.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}:${id}`;
  }

  function deliveryTiming(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return "";
    const today = toIsoDate(new Date());
    const tomorrow = toIsoDate(new Date(Date.now() + 86400000));
    if (value < today) return "overdue";
    if (value === today) return "today";
    if (value === tomorrow) return "tomorrow";
    return "";
  }

  function timingLabel(timing) {
    return timing ? `<span class="sales-workflow-timing">${{ overdue: "Vencido", today: "Hoy", tomorrow: "Mañana" }[timing]}</span>` : "";
  }

  function formatDateTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("es-AR");
  }

  function firstFocusable() {
    return byId("sales-workflow-dialog")?.querySelector("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]");
  }

  function setStatus(message, kind) {
    const status = byId("sales-workflow-status");
    if (!status) return;
    status.textContent = message;
    status.className = `form-status${kind ? ` ${kind}` : ""}`;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  root.loadSalesWorkflow = loadSalesWorkflow;
  root.SalesWorkflow = {
    isActionOpen: (action) => state.activeAction === action,
    orderRequestMetadata
  };
})(window);
