async function loadDashboardWidgets() {
  if (!els["dashboard-checks-widget"]) return;
  renderDashboardLoading();

  const source = (name, promise) => promise
    .then((rows) => ({ name, rows, error: "" }))
    .catch((error) => ({ name, rows: [], error: error?.message || `No se pudo cargar ${name}.` }));

  try {
    const results = await Promise.all([
      source("cheques entregados", backendTableRowsForEntry("cheques_entregados")),
      source("acreedores", backendTableRowsForEntry("acreedores")),
      source("inventarios", backendTableRowsForEntry("inventarios")),
      source("compras", backendTableRowsForEntry("compras")),
      source("recepciones", backendTableRowsForEntry("recepciones")),
      source("detalle de compras", backendTableRowsForEntry("detalle_compras")),
      source("vinculos de insumos", backendTableRowsForEntry("insumos_proveedores")),
      source("insumos", backendTableRowsForEntry("insumos")),
      source("proveedores", backendTableRowsForEntry("proveedores")),
      source("items", backendTableRowsForEntry("items")),
      source("etiquetas", backendTableRowsForEntry("etiquetas")),
      source("pedidos", backendTableRowsForEntry("pedidos")),
      source("detalle de pedidos", backendTableRowsForEntry("detalle_pedidos")),
      source("clientes", backendTableRowsForEntry("clientes")),
      source("productos", backendTableRowsForEntry("productos")),
      source("entregas", backendTableRowsForEntry("entregas")),
      source("detalle de entregas", backendTableRowsForEntry("entregas_detalle")),
      source("deudas", loadExpenseDebtTables())
    ]);
    const [
      issuedChecks,
      creditors,
      inventories,
      purchases,
      receptions,
      purchaseDetails,
      supplierLinks,
      supplies,
      providers,
      items,
      labels,
      orders,
      orderDetails,
      clients,
      products,
      deliveries,
      deliveryDetails,
      expenseDebtTables
    ] = results.map((result) => result.rows);
    const errorFor = (indexes) => indexes
      .map((index) => results[index])
      .filter((result) => result.error)
      .map((result) => result.name)
      .join(", ");
    const checksCalculation = calculateDashboardWidget("cheques pendientes", () => buildDashboardChecks(issuedChecks, creditors, expenseDebtTables));
    const inventoryCalculation = calculateDashboardWidget("dias sin inventario", () => buildDashboardMissingInventoryDays(inventories));
    const purchasesCalculation = calculateDashboardWidget("compras pendientes", () => buildDashboardPendingPurchases({
      purchases,
      receptions,
      purchaseDetails,
      supplierLinks,
      supplies,
      providers,
      items,
      labels
    }));
    const ordersCalculation = calculateDashboardWidget("pedidos pendientes", () => buildDashboardPendingOrders({
      orders,
      orderDetails,
      clients,
      products,
      deliveries,
      deliveryDetails
    }));
    const combinedError = (...messages) => messages.filter(Boolean).join("; ");

    dashboardWidgetData = {
      checks: checksCalculation.value,
      missingInventoryDays: inventoryCalculation.value,
      pendingPurchases: purchasesCalculation.value,
      pendingOrders: ordersCalculation.value,
      errors: {
        checks: combinedError(errorFor([0, 1, 17]), checksCalculation.error),
        inventory: combinedError(errorFor([2]), inventoryCalculation.error),
        purchases: combinedError(errorFor([3, 4, 5, 6, 7, 8, 9, 10]), purchasesCalculation.error),
        orders: combinedError(errorFor([11, 12, 13, 14, 15, 16]), ordersCalculation.error)
      }
    };
    renderDashboardWidgets();
  } catch (error) {
    renderDashboardError(error.message || "No se pudo leer el dashboard.");
  }
}

function calculateDashboardWidget(label, callback) {
  try {
    return { value: callback(), error: "" };
  } catch (error) {
    return { value: [], error: error?.message || `No se pudo calcular ${label}.` };
  }
}

function renderDashboardLoading() {
  els["dashboard-checks-count"].textContent = "-";
  els["dashboard-next-check"].textContent = "Cargando cheques pendientes...";
  els["dashboard-week-checks"].innerHTML = "";
  els["dashboard-inventory-count"].textContent = "-";
  els["dashboard-inventory-summary"].textContent = "Cargando calendario de inventario...";
  els["dashboard-inventory-list"].innerHTML = "";
  els["dashboard-purchases-count"].textContent = "-";
  els["dashboard-purchases-summary"].textContent = "Cargando compras pendientes...";
  els["dashboard-purchases-list"].innerHTML = "";
  els["dashboard-orders-count"].textContent = "-";
  els["dashboard-orders-summary"].textContent = "Cargando pedidos pendientes...";
  els["dashboard-orders-list"].innerHTML = "";
}

function renderDashboardError(message) {
  ["dashboard-checks-widget", "dashboard-inventory-widget", "dashboard-purchases-widget", "dashboard-orders-widget"].forEach((id) => {
    els[id]?.classList.remove("is-warning", "is-danger");
  });
  els["dashboard-next-check"].textContent = message;
  els["dashboard-inventory-summary"].textContent = message;
  els["dashboard-purchases-summary"].textContent = message;
  els["dashboard-orders-summary"].textContent = message;
}

function buildDashboardChecks(checks, creditors, expenseTables = {}) {
  const fallbackCreditorsById = rowsByKey(creditors, "id_acreedor");
  const lookups = expenseDebtLookups(expenseTables);
  const expensesById = rowsByKey(expenseTables.egresos?.rows || [], "id_egreso");
  const paymentDetailsByPaymentId = groupRowsByComparableKey(expenseTables.detalle_pagos?.rows || [], "id_pago");

  return (checks || [])
    .map((check) => {
      const directCreditorId = backendId(check.id_acreedor);
      const paymentDetails = paymentDetailsByPaymentId.get(comparableLookupId(check.id_pago)) || [];
      const linkedExpense = paymentDetails
        .map((detail) => expensesById.get(comparableLookupId(detail.id_egreso)))
        .find(Boolean);
      const linkedCreditorId = linkedExpense ? resolveExpenseCreditorId(linkedExpense, lookups) : "";
      const creditorId = directCreditorId || linkedCreditorId;
      const fallbackCreditor = fallbackCreditorsById.get(comparableLookupId(creditorId)) || {};
      const creditorName = creditorId
        ? creditorDisplayName(creditorId, lookups)
        : displayNameLabel(fallbackCreditor.nombre || check.acreedor || "");

      return {
        id: String(check.id_cheque_entregado ?? "").trim(),
        paymentId: String(check.id_pago ?? "").trim(),
        creditor: creditorName && creditorName !== `Acreedor ${creditorId}` ? creditorName : displayNameLabel(fallbackCreditor.nombre || check.acreedor || "Sin acreedor"),
        number: String(check.nro_cheque ?? "").trim(),
        date: parseDate(check.fecha_entregado),
        dueDate: parseDate(check.fecha_uso),
        amount: normalizeMoney(check.monto),
        bank: check.banco || "",
        status: check.estado || ""
      };
    })
    .filter((check) => isDashboardPendingCheck(check))
    .sort((a, b) => (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31") || a.id.localeCompare(b.id));
}

function isDashboardPendingCheck(check) {
  const status = normalizeCategory(check.status);
  const isClosed = ["pagado", "cubierto", "debitado", "cobrado", "anulado", "rechazado"].includes(status);
  return !isClosed && Math.abs(moneyToCents(check.amount)) > 1000;
}

function dashboardCheckUrgency(check) {
  if (!check.dueDate) return "";
  const today = toIsoDate(new Date());
  const tomorrow = toIsoDate(addDays(new Date(), 1));
  if (check.dueDate <= tomorrow) return "danger";
  if (check.dueDate <= dashboardWeekEndIso()) return "warning";
  return "";
}

function dashboardWeekEndIso() {
  const today = new Date();
  const daysUntilSunday = 7 - today.getDay();
  return toIsoDate(addDays(today, daysUntilSunday === 7 ? 0 : daysUntilSunday));
}

function buildDashboardMissingInventoryDays(inventories) {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  const loadedDates = new Set((inventories || []).map((row) => parseDate(row.fecha)).filter(Boolean));
  const missingDays = [];

  // El control se mide por dia habil: si hubo al menos un turno cargado, ese dia queda cubierto.
  for (let cursor = new Date(start); cursor <= today; cursor = addDays(cursor, 1)) {
    if (!isDashboardInventoryBusinessDay(cursor)) continue;
    const iso = toIsoDate(cursor);
    if (!loadedDates.has(iso)) missingDays.push(iso);
  }

  return missingDays;
}

function isDashboardInventoryBusinessDay(date) {
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  const calendar = payrollCalendarForYear(date.getFullYear());
  if (!calendar.configured) {
    throw new Error(`Calendario laboral no configurado para ${date.getFullYear()}.`);
  }
  return !calendar.dates.has(toIsoDate(date));
}

function buildDashboardPendingPurchases(tables) {
  const receivedPurchaseIds = new Set((tables.receptions || [])
    .map((row) => String(row.id_compra ?? "").trim())
    .filter(Boolean));
  const detailsByPurchaseId = groupRowsByKey(tables.purchaseDetails, "id_compra");
  const suppliersById = rowsByKey(tables.supplierLinks, "id_insumos_proveedores");
  const suppliesById = rowsByKey(tables.supplies, "id_insumo");
  const providersById = rowsByKey(tables.providers, "id_proveedor");
  const itemsBySupplyId = rowsByKey(
    (tables.items || []).filter((row) => normalizeCategory(row.origen_tipo) === "insumo"),
    "id_origen"
  );
  const labelsByName = rowsByNormalizedValue(tables.labels, "etiqueta");

  return (tables.purchases || [])
    .map((purchase) => {
      const purchaseId = String(purchase.id_compra ?? "").trim();
      if (!purchaseId || receivedPurchaseIds.has(purchaseId)) return null;
      const firstDetail = (detailsByPurchaseId.get(purchaseId) || [])[0] || {};
      const supplier = suppliersById.get(comparableLookupId(firstDetail.id_insumos_proveedores)) || {};
      const supply = suppliesById.get(comparableLookupId(supplier.id_insumo)) || {};
      const provider = providersById.get(comparableLookupId(purchase.id_proveedor)) || {};
      const option = buildReceptionPendingOption(purchase, firstDetail, supplier, supply, provider, itemsBySupplyId, labelsByName);
      if (!option) return null;
      return {
        ...option,
        expectedDate: parseDate(purchase.fecha_entrega_prevista)
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.expectedDate || "9999-12-31").localeCompare(b.expectedDate || "9999-12-31") || a.purchaseId.localeCompare(b.purchaseId));
}

function buildDashboardPendingOrders(tables) {
  const deliveriesById = mapRowsById(tables.deliveries || [], "id_entrega");
  const deliveredOrderIds = new Set(
    (tables.deliveryDetails || [])
      .filter((row) => backendId(deliveriesById.get(backendId(row.id_entrega))?.id_flete))
      .map((row) => backendId(row.id_pedido))
      .filter(Boolean)
  );
  const clientsById = mapRowsById(tables.clients || [], "id_cliente");
  const productsById = mapRowsById(tables.products || [], "id_producto");
  const orderDetailsByOrder = groupRowsById(tables.orderDetails || [], "id_pedido");

  return (tables.orders || [])
    .filter((order) => {
      const orderId = backendId(order.id_pedido);
      return orderId && !deliveredOrderIds.has(orderId);
    })
    .map((order) => {
      const orderId = backendId(order.id_pedido);
      const client = clientsById.get(backendId(order.id_cliente)) || {};
      const details = (orderDetailsByOrder.get(orderId) || [])
        .map((detail) => {
          const product = productsById.get(backendId(detail.id_producto)) || {};
          const productName = product.nombre_producto || product.nombre || detail.id_producto || "Producto";
          return `${displayNameLabel(productName)} (${formatNumber(parseQuantity(detail.cantidad_cajas))})`;
        })
        .join(", ");
      return {
        id: orderId,
        deliveryDate: parseDate(order.fecha_entrega),
        orderDate: parseDate(order.fecha_pedido),
        originalDate: parseDate(order.fecha_original),
        clientName: displayNameLabel(client.nombre_cliente || client.nombre || order.id_cliente || "Sin cliente"),
        details
      };
    })
    .sort((a, b) => (a.deliveryDate || "9999-12-31").localeCompare(b.deliveryDate || "9999-12-31") || a.id.localeCompare(b.id));
}

function dashboardOrderUrgency(order) {
  if (!order.deliveryDate) return "";
  const today = toIsoDate(new Date());
  const tomorrow = toIsoDate(addDays(new Date(), 1));
  if (order.deliveryDate <= tomorrow) return "danger";
  if (order.deliveryDate <= dashboardWeekEndIso()) return "warning";
  return "";
}

function renderDashboardWidgets() {
  renderDashboardChecksWidget();
  renderDashboardInventoryWidget();
  renderDashboardPurchasesWidget();
  renderDashboardOrdersWidget();
}

function renderDashboardChecksWidget() {
  const checks = dashboardWidgetData.checks;
  const loadError = dashboardWidgetData.errors?.checks;
  const weekChecks = checks.filter((check) => check.dueDate && check.dueDate <= dashboardWeekEndIso());
  const nextCheck = checks[0];
  const hasDanger = checks.some((check) => dashboardCheckUrgency(check) === "danger");
  const hasWarning = checks.some((check) => dashboardCheckUrgency(check) === "warning");
  const isExpanded = dashboardExpandedWidget === "checks";

  els["dashboard-checks-count"].textContent = loadError ? "!" : formatNumber(checks.length);
  els["dashboard-next-check"].textContent = nextCheck
    ? `Proximo: ${formatDate(nextCheck.dueDate)} - ${nextCheck.creditor} - ${formatMoney(nextCheck.amount)}`
    : loadError
    ? `No se pudo cargar: ${loadError}.`
    : "No hay cheques pendientes de cubrir.";
  els["dashboard-week-checks"].innerHTML = isExpanded
    ? loadError ? dashboardLoadError(loadError) : dashboardChecksTable(checks)
    : weekChecks.length
    ? weekChecks.slice(0, 4).map(dashboardCheckMiniRow).join("")
    : `<div class="dashboard-empty">Sin cheques a cubrir esta semana.</div>`;
  els["dashboard-checks-widget"].classList.toggle("is-danger", hasDanger);
  els["dashboard-checks-widget"].classList.toggle("is-warning", !hasDanger && hasWarning);
  els["dashboard-checks-widget"].classList.toggle("is-expanded", isExpanded);
}

function dashboardCheckMiniRow(check) {
  const urgency = dashboardCheckUrgency(check);
  return `
    <div class="dashboard-mini-row ${urgency ? `is-${urgency}` : ""}">
      <span>${formatDate(check.dueDate)} Â· ${escapeHtml(check.creditor)}</span>
      <strong>${formatMoney(check.amount)}</strong>
    </div>
  `;
}

function renderDashboardInventoryWidget() {
  const missingDays = dashboardWidgetData.missingInventoryDays;
  const loadError = dashboardWidgetData.errors?.inventory;
  const isExpanded = dashboardExpandedWidget === "inventory";
  els["dashboard-inventory-count"].textContent = loadError ? "!" : formatNumber(missingDays.length);
  els["dashboard-inventory-summary"].textContent = loadError
    ? `No se pudo cargar: ${loadError}.`
    : missingDays.length
    ? `${missingDays.length} dia(s) habiles del mes sin inventario.`
    : "Inventario al dia en el mes actual.";
  els["dashboard-inventory-list"].innerHTML = isExpanded
    ? loadError ? dashboardLoadError(loadError) : dashboardInventoryTable(missingDays)
    : missingDays.length
    ? missingDays.slice(0, 5).map((date) => `<div class="dashboard-mini-row"><span>${formatDate(date)}</span><strong>Ir a cargar</strong></div>`).join("")
    : `<div class="dashboard-empty">Click para abrir la carga de inventario.</div>`;
  els["dashboard-inventory-widget"].classList.toggle("is-expanded", isExpanded);
}

function renderDashboardPurchasesWidget() {
  const purchases = dashboardWidgetData.pendingPurchases;
  const loadError = dashboardWidgetData.errors?.purchases;
  const nextPurchase = purchases[0];
  const isExpanded = dashboardExpandedWidget === "purchases";
  els["dashboard-purchases-count"].textContent = loadError ? "!" : formatNumber(purchases.length);
  els["dashboard-purchases-summary"].textContent = nextPurchase
    ? `Proxima: ${formatDate(nextPurchase.expectedDate)} - ${displayNameLabel(nextPurchase.supply.nombre || "Sin insumo")}`
    : loadError
    ? `No se pudo cargar: ${loadError}.`
    : "No hay compras pendientes de recepcion.";
  els["dashboard-purchases-list"].innerHTML = isExpanded
    ? loadError ? dashboardLoadError(loadError) : dashboardPurchasesTable(purchases)
    : purchases.length
    ? purchases.slice(0, 4).map(dashboardPurchaseMiniRow).join("")
    : `<div class="dashboard-empty">Sin compras pendientes.</div>`;
  els["dashboard-purchases-widget"].classList.toggle("is-expanded", isExpanded);
}

function dashboardPurchaseMiniRow(purchase) {
  return `
    <div class="dashboard-mini-row">
      <span>${formatDate(purchase.expectedDate)} Â· ${escapeHtml(displayNameLabel(purchase.provider.nombre || "Sin proveedor"))}</span>
      <strong>${escapeHtml(purchasePresentationLabel(purchase.supplierQuantity, purchase.supplierUnit))}</strong>
    </div>
  `;
}

function renderDashboardOrdersWidget() {
  const orders = dashboardWidgetData.pendingOrders;
  const loadError = dashboardWidgetData.errors?.orders;
  const weekOrders = orders.filter((order) => order.deliveryDate && order.deliveryDate <= dashboardWeekEndIso());
  const nextOrder = orders[0];
  const hasDanger = orders.some((order) => dashboardOrderUrgency(order) === "danger");
  const hasWarning = orders.some((order) => dashboardOrderUrgency(order) === "warning");
  const isExpanded = dashboardExpandedWidget === "orders";

  els["dashboard-orders-count"].textContent = loadError ? "!" : formatNumber(orders.length);
  els["dashboard-orders-summary"].textContent = nextOrder
    ? `Proximo: ${formatDate(nextOrder.deliveryDate)} - ${nextOrder.clientName}`
    : loadError
    ? `No se pudo cargar: ${loadError}.`
    : "No hay pedidos pendientes de entrega.";
  els["dashboard-orders-list"].innerHTML = isExpanded
    ? loadError ? dashboardLoadError(loadError) : dashboardOrdersTable(orders)
    : weekOrders.length
    ? weekOrders.slice(0, 4).map(dashboardOrderMiniRow).join("")
    : `<div class="dashboard-empty">Sin pedidos pendientes esta semana.</div>`;
  els["dashboard-orders-widget"].classList.toggle("is-danger", hasDanger);
  els["dashboard-orders-widget"].classList.toggle("is-warning", !hasDanger && hasWarning);
  els["dashboard-orders-widget"].classList.toggle("is-expanded", isExpanded);
}

function dashboardLoadError(sources) {
  return `<div class="dashboard-empty dashboard-expanded-empty">No se pudo cargar: ${escapeHtml(sources)}. Reintente la carga.</div>`;
}

function dashboardOrderMiniRow(order) {
  const urgency = dashboardOrderUrgency(order);
  return `
    <div class="dashboard-mini-row ${urgency ? `is-${urgency}` : ""}">
      <span>${formatDate(order.deliveryDate)} Â· ${escapeHtml(order.clientName)}</span>
      <strong>#${escapeHtml(order.id)}</strong>
    </div>
  `;
}

function activateDashboardWidgetFromKeyboard(event, target) {
  if (!["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  toggleDashboardWidget(target);
}

function toggleDashboardWidget(target) {
  dashboardExpandedWidget = dashboardExpandedWidget === target ? "" : target;
  renderDashboardWidgets();
}

function dashboardInventoryTable(missingDays) {
  if (!missingDays.length) {
    return `<div class="dashboard-empty dashboard-expanded-empty">No hay dias habiles pendientes de inventario.</div>`;
  }
  return `
    <div class="table-wrap dashboard-expanded-table">
      <table>
        <thead>
          <tr>
            <th>Fecha pendiente</th>
            <th>Accion sugerida</th>
          </tr>
        </thead>
        <tbody>
          ${missingDays.map((date) => `
            <tr>
              <td>${formatDate(date)}</td>
              <td>Cargar inventario</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function dashboardChecksTable(checks) {
  if (!checks.length) return `<div class="dashboard-empty dashboard-expanded-empty">No hay cheques pendientes.</div>`;
  return `
    <div class="table-wrap dashboard-expanded-table">
      <table>
        <thead>
          <tr>
            <th>Fecha uso</th>
            <th>Acreedor</th>
            <th>Nro cheque</th>
            <th>Banco</th>
            <th class="num">Monto</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          ${checks.map((check) => `
            <tr class="${dashboardCheckUrgency(check) ? `dashboard-row-${dashboardCheckUrgency(check)}` : ""}">
              <td>${formatDate(check.dueDate)}</td>
              <td>${escapeHtml(check.creditor)}</td>
              <td>${escapeHtml(check.number || "-")}</td>
              <td>${escapeHtml(check.bank || "-")}</td>
              <td class="num">${formatMoney(check.amount)}</td>
              <td>${escapeHtml(check.status || "Pendiente")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function dashboardPurchasesTable(purchases) {
  if (!purchases.length) return `<div class="dashboard-empty dashboard-expanded-empty">No hay compras pendientes.</div>`;
  return `
    <div class="table-wrap dashboard-expanded-table">
      <table>
        <thead>
          <tr>
            <th>Entrega prevista</th>
            <th>Compra</th>
            <th>Proveedor</th>
            <th>Insumo</th>
            <th class="num">Unidad proveedor</th>
            <th class="num">Unidad conteo</th>
          </tr>
        </thead>
        <tbody>
          ${purchases.map((purchase) => `
            <tr>
              <td>${formatDate(purchase.expectedDate)}</td>
              <td>#${escapeHtml(purchase.purchaseId)}</td>
              <td>${escapeHtml(displayNameLabel(purchase.provider.nombre || "Sin proveedor"))}</td>
              <td>${escapeHtml(displayNameLabel(purchase.supply.nombre || "Sin insumo"))}</td>
              <td class="num">${escapeHtml(purchasePresentationLabel(purchase.supplierQuantity, purchase.supplierUnit))}</td>
              <td class="num">${escapeHtml(purchaseQuantityLabel(purchase.countQuantity, purchase.countUnit))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function dashboardOrdersTable(orders) {
  if (!orders.length) return `<div class="dashboard-empty dashboard-expanded-empty">No hay pedidos pendientes de entrega.</div>`;
  return `
    <div class="table-wrap dashboard-expanded-table">
      <table>
        <thead>
          <tr>
            <th>Fecha entrega</th>
            <th>Pedido</th>
            <th>Cliente</th>
            <th>Detalle</th>
            <th>Fecha pedido</th>
          </tr>
        </thead>
        <tbody>
          ${orders.map((order) => `
            <tr class="${dashboardOrderUrgency(order) ? `dashboard-row-${dashboardOrderUrgency(order)}` : ""}">
              <td>${formatDate(order.deliveryDate)}</td>
              <td>#${escapeHtml(order.id)}</td>
              <td>${escapeHtml(order.clientName)}</td>
              <td>${escapeHtml(order.details || "-")}</td>
              <td>${formatDate(order.orderDate)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderCounts() {
  if (els["count-sales"]) els["count-sales"].textContent = state.sales.length;
  if (els["count-expenses"]) els["count-expenses"].textContent = state.expenses.length;
  if (els["count-inventory"]) els["count-inventory"].textContent = state.inventory.length;
  if (els["count-inventory-details"]) els["count-inventory-details"].textContent = state.inventoryDetails.length;
  if (els["count-order-details"]) els["count-order-details"].textContent = state.orderDetails.length;
  if (els["count-payroll"]) els["count-payroll"].textContent = state.payroll.length;
  if (els["count-errors"]) els["count-errors"].textContent = state.importErrors.length;
}

// Colorea las tarjetas resumen segÄ‚Ĺźn signo.
function setMetric(id, value) {
  const el = els[id];
  const metric = el.closest(".metric");
  el.textContent = formatMoney(value);
  metric.classList.toggle("negative", value < 0);
  metric.classList.toggle("positive", value > 0);
}

function setPlainMetric(id, value) {
  els[id].textContent = value;
}

function setMetricRate(id, value, base) {
  els[id].textContent = formatPercentOfSales(value, base);
}

function setUnitMetric(id, label, amount, units) {
  els[id].textContent = units
    ? `${label}: ${formatMoney(ErpMoney.divide(amount, units))}`
    : `${label}: -`;
}

