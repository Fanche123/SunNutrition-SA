let incomeStatementDetailRequestId = 0;
let incomeStatementDetailState = null;
const INCOME_STATEMENT_DETAIL_PAGE_SIZE = 200;

async function loadBackendStatementReport() {
  const requestId = backendStatementRequestId + 1;
  backendStatementRequestId = requestId;

  try {
    const params = new URLSearchParams({
      year: String(state.selectedYear),
      month: String(state.selectedMonth),
      comparison: state.selectedComparison || "none"
    });
    const response = await fetch(`${API_BASE_URL}/api/reports/income-statement?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo leer el Estado de Resultados desde backend.");
    if (requestId !== backendStatementRequestId) return;

    renderStatement(payload.report, payload.comparisonReport || null);
    renderWarnings(payload.report);
    renderTables(payload.report);
    return true;
  } catch (error) {
    if (requestId !== backendStatementRequestId) return;
    renderStatementLoadError(error);
    return false;
  }
}

async function loadBackendCashflowReport() {
  const requestId = backendCashflowRequestId + 1;
  backendCashflowRequestId = requestId;

  try {
    const response = await fetch(`${API_BASE_URL}/api/reports/cashflow`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo leer el cashflow desde backend.");
    if (requestId !== backendCashflowRequestId) return;
    backendCashflowReport = payload.report;
    renderCashflow();
    return true;
  } catch (error) {
    if (requestId !== backendCashflowRequestId) return;
    renderCashflowLoadError(error, Boolean(backendCashflowReport));
    return false;
  }
}

function renderStatementLoadError(error) {
  closeIncomeStatementDetail({ restoreFocus: false });
  const message = escapeHtml(error?.message || "No se pudo actualizar el Estado de Resultados.");
  els["statement-body"].innerHTML = emptyRow(5, `Error de carga: ${message} No se muestran resultados anteriores.`);
  els.warnings.innerHTML = `<div class="notice warn">Falló la actualización del Estado de Resultados. Reintente la carga.</div>`;
}

function renderCashflowLoadError(error, hadPreviousReport) {
  const detail = escapeHtml(error?.message || "No se pudo actualizar el cashflow.");
  const previous = hadPreviousReport ? " El resultado anterior fue descartado." : "";
  backendCashflowReport = null;
  renderBackendCashflowCards({ cards: {} });
  if (els["cashflow-timeline"]) {
    els["cashflow-timeline"].innerHTML = emptyRow(4, `Error de carga: ${detail}${previous} Reintente la carga.`);
  }
}

function buildComparisonReport() {
  const comparisonPeriod = getComparisonPeriod(state.selectedYear, state.selectedMonth, state.selectedComparison);
  return comparisonPeriod
    ? buildReport(comparisonPeriod.year, comparisonPeriod.month)
    : null;
}

function getComparisonPeriod(year, month, mode) {
  if (mode === "previousMonth") {
    const date = new Date(year, month - 1, 1);
    return { year: date.getFullYear(), month: date.getMonth() };
  }

  if (mode === "previousYear") {
    return { year: year - 1, month };
  }

  return null;
}

function comparisonLabel(report) {
  return report ? `${MONTHS[report.month]} ${report.year}` : "";
}

/*
  CÄ‚Ë‡lculo del Estado de Resultados.
  Criterios vigentes:
  - Ventas: siempre por Subtotal, sin IVA ni retenciones.
  - MercaderÄ‚Â­a: inventario inicial + egresos Mercaderia - inventario final.
  - Inventario inicial: Ä‚Ĺźltimo registro disponible anterior al mes seleccionado.
  - Inventario final: Ä‚Ĺźltimo registro disponible del mes seleccionado.
  - Ingresos Brutos: 1,5% del Subtotal de ventas con Factura_A.
  - Uds Vendidas: suma Cantidad_Individual del detalle de pedidos del perÄ‚Â­odo.
  - Precio Promedio: facturaciÄ‚Ĺ‚n neta / unidades vendidas.
  - ProducciÄ‚Ĺ‚n: unidades vendidas + inventario final individual - inventario inicial individual.
*/
function buildReport(year, month) {
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 0);
  const startIso = toIsoDate(start);
  const endIso = toIsoDate(end);

  const monthlySales = state.sales.filter((row) => row.date >= startIso && row.date <= endIso);
  const monthlyExpenses = state.expenses.filter((row) => row.date >= startIso && row.date <= endIso);
  const monthlyOrderDetails = filterOrderDetailsForReport(state.orderDetails, monthlySales, startIso, endIso);
  const monthlyPayroll = state.payroll.filter((row) => row.date >= startIso && row.date <= endIso);
  const uncategorized = [];

  monthlyExpenses.forEach((expense) => {
    if (!expense.category.trim()) {
      uncategorized.push(expense);
    }
  });

  const dayBeforeStartIso = toIsoDate(new Date(year, month, 0));
  const initialInventory = lastInventoryBetween("", dayBeforeStartIso);
  const finalInventory = lastInventoryBetween(startIso, endIso);
  const salesBuckets = {
    schools: sumSalesByCategories(monthlySales, ["Escuelas"]),
    other: reportMoneySum(
      monthlySales.filter((sale) => !matchesAnyCategory(sale.category, ["Escuelas"])),
      "subtotal"
    )
  };
  const salesNet = centsToMoney(moneyToCents(salesBuckets.schools) + moneyToCents(salesBuckets.other));
  const unitsSold = sum(monthlyOrderDetails, "individualQuantity");
  const customerCount = countCustomers(monthlySales, monthlyOrderDetails);
  const averagePrice = unitsSold ? ErpMoney.divide(salesNet, unitsSold) : 0;
  const production = buildProductionSummary("", dayBeforeStartIso, startIso, endIso, unitsSold);
  const payroll = buildPayrollSummary(monthlyPayroll);
  production.unitsPerHour = payroll.totalHours ? production.calculatedUnits / payroll.totalHours : 0;

  const expenseSubtotal = (categories) => sumExpensesByCategories(monthlyExpenses, categories, "subtotal");
  const merchandiseCost = centsToMoney(
    moneyToCents(initialInventory?.value || 0)
    + moneyToCents(expenseSubtotal(["Mercaderia"]))
    - moneyToCents(finalInventory?.value || 0)
  );

  const costOfSales = {
    merchandise: merchandiseCost,
    commissions: expenseSubtotal(["Comisiones"]),
    grossRevenueTax: ErpMoney.percentage(
      sumSalesByInvoiceType(monthlySales, ["Factura_A", "Factura_B"]),
      1.5
    ),
    logistics: expenseSubtotal(["Logistica"])
  };
  const totalCostOfSales = centsToMoney(Object.values(costOfSales).reduce(
    (total, value) => total + moneyToCents(value),
    0
  ));
  const grossMargin = centsToMoney(moneyToCents(salesNet) - moneyToCents(totalCostOfSales));

  const operatingExpenses = {
    salaries: expenseSubtotal(["Sueldos"]),
    extraSalaries: expenseSubtotal(["Sueldos_Extras"]),
    admin: expenseSubtotal(["Administrativos"]),
    services: expenseSubtotal(["Servicios", "Herramientas_De_Trabajo"]),
    rent: expenseSubtotal(["Alquiler"]),
    maintenanceAndMisc: expenseSubtotal(["Cadeteria", "Limpieza", "Varios", "Otros", "Incentivos_Personal"])
  };
  const totalOperatingExpenses = centsToMoney(Object.values(operatingExpenses).reduce(
    (total, value) => total + moneyToCents(value),
    0
  ));
  const operatingResult = centsToMoney(moneyToCents(grossMargin) - moneyToCents(totalOperatingExpenses));

  const nonOperatingExpenses = {
    otherTaxes: expenseSubtotal(["Impuesto Cred", "Impuesto Deb", "Impuesto Sello"]),
    bankFees: expenseSubtotal(["Gastos Bancarios"]),
    interest: expenseSubtotal(["Intereses", "Rendimiento Fondo"]),
    generalInvestment: expenseSubtotal(["Inversion General", "Maquinaria"])
  };
  const totalNonOperatingExpenses = centsToMoney(Object.values(nonOperatingExpenses).reduce(
    (total, value) => total + moneyToCents(value),
    0
  ));
  const netResult = centsToMoney(moneyToCents(operatingResult) - moneyToCents(totalNonOperatingExpenses));

  return {
    year,
    month,
    startIso,
    endIso,
    monthlyOrderDetails,
    monthlyPayroll,
    unitsSold,
    customerCount,
    averagePrice,
    payroll,
    production,
    salesNet,
    salesBuckets,
    costOfSales,
    totalCostOfSales,
    operatingExpenses,
    totalOperatingExpenses,
    nonOperatingExpenses,
    totalNonOperatingExpenses,
    initialInventory,
    finalInventory,
    grossMargin,
    operatingResult,
    netResult,
    uncategorized
  };
}

function sumSalesByCategories(rows, categories) {
  return reportMoneySum(rows.filter((row) => matchesAnyCategory(row.category, categories)), "subtotal");
}

function sumSalesByInvoiceType(rows, invoiceTypes) {
  return reportMoneySum(rows.filter((row) => matchesAnyCategory(row.invoiceType, invoiceTypes)), "subtotal");
}

function sumExpensesByCategories(rows, categories, field) {
  return reportMoneySum(rows.filter((row) => matchesAnyCategory(row.category, categories)), field);
}

function reportMoneySum(rows, field) {
  return centsToMoney((rows || []).reduce(
    (totalCents, row) => totalCents + moneyToCents(row?.[field] || 0),
    0
  ));
}

function buildProductionSummary(initialStartIso, initialEndIso, startIso, endIso, unitsSold) {
  const initial = lastInventoryDetailUnitsBetween(initialStartIso, initialEndIso);
  const final = lastInventoryDetailUnitsBetween(startIso, endIso);
  const initialUnits = initial?.units || 0;
  const finalUnits = final?.units || 0;

  /*
    Criterio pedido por el negocio:
    producciÄ‚Ĺ‚n mensual = ventas individuales + inventario final individual - inventario inicial individual.
    El inventario inicial usa el Ä‚Ĺźltimo registro previo; el final, el Ä‚Ĺźltimo del mes.
  */
  return {
    initial,
    final,
    unitsSold,
    calculatedUnits: unitsSold + finalUnits - initialUnits
  };
}

function buildPayrollSummary(monthlyPayroll) {
  const employees = new Map();

  monthlyPayroll.forEach((row) => {
    const employee = row.employee || "Sin empleado";
    if (!employees.has(employee)) {
      employees.set(employee, {
        employee,
        date: row.date,
        workedHours: 0,
        extraHours: 0,
        totalHours: 0
      });
    }

    const summary = employees.get(employee);
    summary.workedHours += row.workedHours;
    summary.extraHours += row.extraHours;
    summary.totalHours += row.totalHours;
  });

  const rows = [...employees.values()]
    .filter((row) => row.totalHours > 0)
    .sort((a, b) => b.totalHours - a.totalHours || a.employee.localeCompare(b.employee));

  return {
    rows,
    employeeCount: rows.length,
    totalHours: rows.reduce((total, row) => total + row.totalHours, 0)
  };
}

function countCustomers(monthlySales, monthlyOrderDetails) {
  const customers = new Set();

  monthlyOrderDetails.forEach((detail) => {
    if (detail.customer) customers.add(normalizeCategory(detail.customer));
  });

  monthlySales.forEach((sale) => {
    if (sale.customer) customers.add(normalizeCategory(sale.customer));
  });

  return customers.size;
}

function lastInventoryDetailUnitsBetween(startIso, endIso) {
  const rows = state.inventoryDetails.filter((row) => row.date >= startIso && row.date <= endIso);
  const lastDate = rows.map((row) => row.date).sort((a, b) => b.localeCompare(a))[0];
  if (!lastDate) return null;

  return {
    date: lastDate,
    units: sum(rows.filter((row) => row.date === lastDate), "individualQuantity")
  };
}

function isInventoryProduct(itemName) {
  return /^Barra/i.test(String(itemName || "").trim());
}

function inventoryProductUnits(itemName, recipeQuantity) {
  const multiplier = String(itemName || "").match(/_(\d+)Ud$/i)?.[1];
  return recipeQuantity * (multiplier ? Number(multiplier) : 1);
}

/*
  Detalle de pedidos:
  - Con Fecha_Entrega se filtra directo por mes.
  - Con Id_Venta o Id_Pedido se puede cruzar contra ventas del mes.
  - Sin fecha ni IDs no se asigna a un mes para no duplicar unidades por cliente.
*/
function filterOrderDetailsForReport(orderDetails, monthlySales, startIso, endIso) {
  const monthlySaleIds = new Set(monthlySales.map((sale) => String(sale.id || "")).filter(Boolean));
  const monthlyOrderIds = new Set(monthlySales.map((sale) => String(sale.orderId || "")).filter(Boolean));

  return orderDetails.filter((detail) => {
    if (detail.date) return detail.date >= startIso && detail.date <= endIso;
    if (detail.saleId) return monthlySaleIds.has(String(detail.saleId));
    if (detail.orderId) return monthlyOrderIds.has(String(detail.orderId));
    return false;
  });
}

function matchesAnyCategory(value, categories) {
  const normalized = normalizeCategory(value);
  return categories.some((category) => normalizeCategory(category) === normalized);
}

function normalizeCategory(value) {
  return removeAccents(value).trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
}

function normalizeInventoryToken(value) {
  return normalizeCategory(value).replace(/\s+/g, "");
}

function normalizeSearchText(value) {
  return removeAccents(String(value || "")).trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
}

// Busca el Ä‚Ĺźltimo inventario cargado dentro de un rango mensual.
function lastInventoryBetween(startIso, endIso) {
  return [...state.inventory]
    .filter((row) => row.date >= startIso && row.date <= endIso)
    .sort((a, b) => b.date.localeCompare(a.date))[0] || null;
}

// Renderiza el Estado de Resultados con grupos desplegables y porcentajes sobre ventas.
function renderStatement(report, comparisonReport = null) {
  closeIncomeStatementDetail({ restoreFocus: false });
  els["period-label"].textContent = "";
  const base = report.salesNet;
  const comparisonBase = comparisonReport?.salesNet || 0;
  const comparison = comparisonReport
    ? { report: comparisonReport, label: comparisonLabel(comparisonReport), base: comparisonBase }
    : null;

  const rows = [
    statementHeader(report, comparison),
    groupTotal("ventas", "Facturacion", report.salesNet, comparison?.report.salesNet, base, comparison, "ventas-netas"),
    childLine("ventas", "Escuelas", report.salesBuckets.schools, comparison?.report.salesBuckets.schools, base, comparison, "sales.schools", report.detailCounts?.["sales.schools"]),
    childLine("ventas", "Otros", report.salesBuckets.other, comparison?.report.salesBuckets.other, base, comparison, "sales.other", report.detailCounts?.["sales.other"]),
    groupTotal("costo-ventas", "Costo de ventas", report.totalCostOfSales, comparison?.report.totalCostOfSales, base, comparison, "costo-de-ventas"),
    childLine("costo-ventas", "Mercaderia", report.costOfSales.merchandise, comparison?.report.costOfSales.merchandise, base, comparison, "cost.merchandise", report.detailCounts?.["cost.merchandise"]),
    childLine("costo-ventas", "Comisiones", report.costOfSales.commissions, comparison?.report.costOfSales.commissions, base, comparison, "cost.commissions", report.detailCounts?.["cost.commissions"]),
    childLine("costo-ventas", "Ingresos Brutos", report.costOfSales.grossRevenueTax, comparison?.report.costOfSales.grossRevenueTax, base, comparison, "cost.grossRevenueTax", report.detailCounts?.["cost.grossRevenueTax"]),
    childLine("costo-ventas", "Logistica", report.costOfSales.logistics, comparison?.report.costOfSales.logistics, base, comparison, "cost.logistics", report.detailCounts?.["cost.logistics"]),
    utilityTotal("Utilidad bruta", report.grossMargin, comparison?.report.grossMargin, base, comparison),
    groupTotal("gastos-operativos", "Gastos operativos", report.totalOperatingExpenses, comparison?.report.totalOperatingExpenses, base, comparison, "gastos-operativos"),
    childLine("gastos-operativos", "Sueldos", report.operatingExpenses.salaries, comparison?.report.operatingExpenses.salaries, base, comparison, "operating.salaries", report.detailCounts?.["operating.salaries"]),
    childLine("gastos-operativos", "Sueldos_Extras", report.operatingExpenses.extraSalaries, comparison?.report.operatingExpenses.extraSalaries, base, comparison, "operating.extraSalaries", report.detailCounts?.["operating.extraSalaries"]),
    childLine("gastos-operativos", "Administrativos", report.operatingExpenses.admin, comparison?.report.operatingExpenses.admin, base, comparison, "operating.admin", report.detailCounts?.["operating.admin"]),
    childLine("gastos-operativos", "Servicios", report.operatingExpenses.services, comparison?.report.operatingExpenses.services, base, comparison, "operating.services", report.detailCounts?.["operating.services"]),
    childLine("gastos-operativos", "Alquiler", report.operatingExpenses.rent, comparison?.report.operatingExpenses.rent, base, comparison, "operating.rent", report.detailCounts?.["operating.rent"]),
    childLine("gastos-operativos", "Mantenimiento y Varios", report.operatingExpenses.maintenanceAndMisc, comparison?.report.operatingExpenses.maintenanceAndMisc, base, comparison, "operating.maintenanceAndMisc", report.detailCounts?.["operating.maintenanceAndMisc"]),
    utilityTotal("Utilidad operativa", report.operatingResult, comparison?.report.operatingResult, base, comparison),
    groupTotal("gastos-no-operativos", "Gastos no operativos", report.totalNonOperatingExpenses, comparison?.report.totalNonOperatingExpenses, base, comparison, "gastos-no-operativos"),
    childLine("gastos-no-operativos", "Otros Impuestos", report.nonOperatingExpenses.otherTaxes, comparison?.report.nonOperatingExpenses.otherTaxes, base, comparison, "nonOperating.otherTaxes", report.detailCounts?.["nonOperating.otherTaxes"]),
    childLine("gastos-no-operativos", "Gastos Bancarios", report.nonOperatingExpenses.bankFees, comparison?.report.nonOperatingExpenses.bankFees, base, comparison, "nonOperating.bankFees", report.detailCounts?.["nonOperating.bankFees"]),
    childLine("gastos-no-operativos", "Intereses", report.nonOperatingExpenses.interest, comparison?.report.nonOperatingExpenses.interest, base, comparison, "nonOperating.interest", report.detailCounts?.["nonOperating.interest"]),
    childLine("gastos-no-operativos", "Inversion General", report.nonOperatingExpenses.generalInvestment, comparison?.report.nonOperatingExpenses.generalInvestment, base, comparison, "nonOperating.generalInvestment", report.detailCounts?.["nonOperating.generalInvestment"]),
    grand("Utilidad", report.netResult, comparison?.report.netResult, base, comparison, "utilidad")
  ];

  els["statement-body"].innerHTML = rows.join("");

  setPlainMetric("metric-units", formatNumber(report.unitsSold));
  els["metric-units-customers"].textContent = `Clientes: ${formatNumber(report.customerCount)}`;
  setPlainMetric("metric-production", formatNumber(report.production.calculatedUnits));
  els["metric-production-hour"].textContent = report.payroll.totalHours
    ? `Barritas/Hora: ${formatNumber(report.production.unitsPerHour)}`
    : "Barritas/Hora: -";
  setMetric("metric-sales", report.salesNet);
  setMetric("metric-cogs", report.totalCostOfSales);
  setMetric("metric-operating-expenses", report.totalOperatingExpenses);
  setMetric("metric-margin", report.totalNonOperatingExpenses);
  setMetric("metric-net", report.netResult);
  setMetricRate("metric-sales-rate", report.salesNet, base);
  setMetricRate("metric-cogs-rate", report.totalCostOfSales, base);
  setMetricRate("metric-operating-expenses-rate", report.totalOperatingExpenses, base);
  setMetricRate("metric-margin-rate", report.totalNonOperatingExpenses, base);
  setMetricRate("metric-net-rate", report.netResult, base);
  setUnitMetric("metric-sales-unit", "Por Ud", report.salesNet, report.unitsSold);
  setUnitMetric("metric-cogs-unit", "Por Ud", report.totalCostOfSales, report.unitsSold);
  setUnitMetric("metric-operating-expenses-unit", "Por Ud", report.totalOperatingExpenses, report.unitsSold);
  setUnitMetric("metric-operating-expenses-produced-unit", "Por Ud Producida", report.totalOperatingExpenses, report.production.calculatedUnits);
  setUnitMetric("metric-margin-unit", "Por Ud", report.totalNonOperatingExpenses, report.unitsSold);
  setUnitMetric("metric-net-unit", "Por Ud", report.netResult, report.unitsSold);
  setUtilityProducedMetric(report);
}

async function openIncomeStatementDetail(button) {
  const concept = button?.dataset.statementConcept || "";
  if (!concept) return;
  if (incomeStatementDetailState?.trigger === button && button.getAttribute("aria-expanded") === "true") {
    closeIncomeStatementDetail();
    return;
  }

  closeIncomeStatementDetail({ restoreFocus: false });
  const panel = document.getElementById("statement-detail-panel");
  const title = document.getElementById("statement-detail-title");
  const period = document.getElementById("statement-detail-period");
  const summary = document.getElementById("statement-detail-summary");
  const body = document.getElementById("statement-detail-body");
  const more = document.getElementById("statement-detail-more");
  if (!panel || !title || !period || !summary || !body || !more) return;

  const label = button.querySelector("span")?.textContent?.trim() || "Detalle del concepto";
  incomeStatementDetailState = {
    concept,
    year: state.selectedYear,
    month: state.selectedMonth,
    trigger: button,
    rows: [],
    count: 0,
    total: 0,
    hasMore: false
  };
  button.setAttribute("aria-expanded", "true");
  panel.hidden = false;
  title.textContent = label;
  period.textContent = `${MONTHS[state.selectedMonth]} ${state.selectedYear}`;
  summary.textContent = "Cargando movimientos...";
  body.innerHTML = emptyRow(4, "Cargando detalle...");
  more.hidden = true;
  more.disabled = false;
  panel.focus({ preventScroll: true });
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  await loadIncomeStatementDetailPage(true);
}

async function loadIncomeStatementDetailPage(reset = false) {
  const active = incomeStatementDetailState;
  if (!active) return;
  const more = document.getElementById("statement-detail-more");
  const offset = reset ? 0 : active.rows.length;
  const requestId = incomeStatementDetailRequestId + 1;
  incomeStatementDetailRequestId = requestId;
  if (more) more.disabled = true;

  try {
    const params = new URLSearchParams({
      year: String(active.year),
      month: String(active.month),
      concept: active.concept,
      offset: String(offset),
      limit: String(INCOME_STATEMENT_DETAIL_PAGE_SIZE)
    });
    const response = await fetch(`${API_BASE_URL}/api/reports/income-statement/detail?${params.toString()}`, {
      cache: "no-store"
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "No se pudo cargar el detalle del concepto.");
    }
    if (requestId !== incomeStatementDetailRequestId || incomeStatementDetailState !== active) return;
    const detail = payload.detail;
    if (
      detail?.concept !== active.concept
      || detail?.period?.year !== active.year
      || detail?.period?.month !== active.month
    ) {
      throw new Error("El detalle recibido no corresponde al periodo solicitado.");
    }

    active.rows = reset ? [...detail.rows] : [...active.rows, ...detail.rows];
    active.count = detail.count;
    active.total = detail.total;
    active.hasMore = detail.hasMore;
    renderIncomeStatementDetail(active);
  } catch (error) {
    if (requestId !== incomeStatementDetailRequestId || incomeStatementDetailState !== active) return;
    renderIncomeStatementDetailError(error, Boolean(active.rows.length));
  } finally {
    if (requestId === incomeStatementDetailRequestId && more) more.disabled = false;
  }
}

function renderIncomeStatementDetail(detail) {
  const summary = document.getElementById("statement-detail-summary");
  const body = document.getElementById("statement-detail-body");
  const more = document.getElementById("statement-detail-more");
  if (!summary || !body || !more) return;

  const complete = !detail.hasMore && detail.rows.length === detail.count;
  if (complete) {
    const visibleTotalCents = detail.rows.reduce((sum, row) => sum + moneyToCents(row.amount), 0);
    if (visibleTotalCents !== moneyToCents(detail.total)) {
      renderIncomeStatementDetailError(new Error("El detalle no concilia con el total del concepto."), false);
      return;
    }
  }

  const movementLabel = detail.count === 1 ? "1 movimiento" : `${detail.count} movimientos`;
  const visibleLabel = detail.rows.length < detail.count
    ? ` · ${detail.rows.length} visibles`
    : "";
  summary.textContent = `${movementLabel}${visibleLabel} · Total conciliado: ${formatMoney(detail.total)}`;
  summary.dataset.status = "success";
  body.innerHTML = detail.rows.length
    ? detail.rows.map((row) => `
      <tr>
        <td>${formatDate(row.date)}</td>
        <td>${escapeHtml(row.counterparty ? displayNameLabel(row.counterparty) : "Sin contraparte vinculada")}</td>
        <td>${escapeHtml(row.reference || "Sin referencia disponible")}</td>
        <td class="num ${row.amount < 0 ? "negative" : ""}">${formatMoney(row.amount)}</td>
      </tr>
    `).join("")
    : emptyRow(4, "No hay movimientos para este concepto en el periodo.");
  more.hidden = !detail.hasMore;
}

function renderIncomeStatementDetailError(error, preserveRows) {
  const summary = document.getElementById("statement-detail-summary");
  const body = document.getElementById("statement-detail-body");
  const more = document.getElementById("statement-detail-more");
  if (summary) {
    summary.textContent = error?.message || "No se pudo cargar el detalle.";
    summary.dataset.status = "error";
  }
  if (body && !preserveRows) {
    body.innerHTML = emptyRow(4, "No se pudo mostrar el detalle. Reintente la apertura.");
  }
  if (more) more.hidden = true;
}

function closeIncomeStatementDetail(options = {}) {
  const { restoreFocus = true } = options;
  const activeTrigger = incomeStatementDetailState?.trigger;
  incomeStatementDetailRequestId += 1;
  incomeStatementDetailState = null;
  document.querySelectorAll("[data-statement-concept][aria-expanded='true']").forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });
  const panel = document.getElementById("statement-detail-panel");
  if (panel) panel.hidden = true;
  if (restoreFocus && activeTrigger?.isConnected) activeTrigger.focus();
}

function closeIncomeStatementDetailForGroup(group) {
  const activeRow = incomeStatementDetailState?.trigger?.closest("[data-group]");
  if (activeRow?.dataset.group === group) closeIncomeStatementDetail({ restoreFocus: false });
}

function setUtilityProducedMetric(report) {
  const soldUnits = report.unitsSold;
  const producedUnits = report.production.calculatedUnits;

  if (!soldUnits || !producedUnits) {
    els["metric-net-produced-unit"].textContent = "Por Ud Producida: -";
    return;
  }

  // Fórmula vigente con un único redondeo final en el contrato monetario.
  const resultPerProducedUnit = ErpMoney.sumRatios([
    { value: report.salesNet, divisor: soldUnits },
    { value: centsToMoney(-moneyToCents(report.totalCostOfSales)), divisor: soldUnits },
    { value: centsToMoney(-moneyToCents(report.totalOperatingExpenses)), divisor: producedUnits },
    { value: centsToMoney(-moneyToCents(report.totalNonOperatingExpenses)), divisor: soldUnits }
  ]);

  els["metric-net-produced-unit"].textContent = `Por Ud Producida: ${formatMoney(resultPerProducedUnit)}`;
}

function statementHeader(report, comparison) {
  const currentLabel = `${MONTHS[report.month]} ${report.year}`;

  if (comparison) {
    return `
      <tr>
        <th>Concepto</th>
        <th class="num current-amount-heading">${currentLabel}</th>
        <th class="num comparison-heading">${comparison.label}</th>
        <th class="num current-percent-heading">${currentLabel}</th>
        <th class="num comparison-heading">${comparison.label}</th>
      </tr>
    `;
  }

  return `
    <tr>
      <th>Concepto</th>
      <th class="num">Monto</th>
      <th class="num">% facturacion</th>
    </tr>
  `;
}

function statLine(label, value, comparisonValue, format = "number", comparison = null) {
  const formattedValue = format === "money" ? formatMoney(value) : formatNumber(value);
  const formattedComparison = format === "money" ? formatMoney(comparisonValue || 0) : formatNumber(comparisonValue || 0);

  if (comparison) {
    return `
      <tr class="stat-row">
        <td>${label}</td>
        <td class="num current-cell">${formattedValue}</td>
        <td class="num comparison-cell">${formattedComparison}</td>
        <td class="num">-</td>
        <td class="num comparison-cell">-</td>
      </tr>
    `;
  }

  return `
    <tr class="stat-row">
      <td>${label}</td>
      <td class="num">${formattedValue}</td>
      <td class="num">-</td>
    </tr>
  `;
}

function childLine(group, label, value, comparisonValue, base = 0, comparison = null, conceptKey = "", detailCount = 0) {
  const conceptLabel = escapeHtml(label);
  const labelContent = conceptKey && detailCount > 0
    ? `
      <button
        class="statement-concept-button"
        type="button"
        data-statement-concept="${escapeHtml(conceptKey)}"
        aria-controls="statement-detail-panel"
        aria-expanded="false"
      >
        <span>${conceptLabel}</span>
        <span class="statement-concept-hint" aria-hidden="true">Ver detalle</span>
      </button>
    `
    : conceptLabel;
  return `
    <tr class="detail-row statement-row-${group}" data-group="${group}" hidden>
      <td>${labelContent}</td>
      ${statementValueCells(value || 0, comparisonValue || 0, base, comparison)}
    </tr>
  `;
}

// Fila resumida desplegable: abre/cierra las filas hijas con el mismo data-group.
function groupTotal(group, label, value, comparisonValue, base = 0, comparison = null, icon = "") {
  return `
    <tr class="group-row statement-row-${group}">
      <td>
        <button class="toggle-row" type="button" data-toggle-group="${group}" aria-expanded="false">
          ${statementIcon(icon)}
          <span class="chevron" aria-hidden="true"></span>
          ${label}
        </button>
      </td>
      ${statementValueCells(value, comparisonValue || 0, base, comparison)}
    </tr>
  `;
}

function utilityTotal(label, value, comparisonValue, base = 0, comparison = null, icon = "") {
  const signClass = value < 0 ? "negative-row" : "positive-row";
  return `
    <tr class="total-row utility-row ${signClass}">
      <td>${statementIcon(icon)}${label}</td>
      ${statementValueCells(value, comparisonValue || 0, base, comparison, true)}
    </tr>
  `;
}

function grand(label, value, comparisonValue, base = 0, comparison = null, icon = "") {
  const signClass = value < 0 ? "negative-row" : "positive-row";
  return `
    <tr class="grand-row ${signClass}">
      <td>${statementIcon(icon)}${label}</td>
      ${statementValueCells(value, comparisonValue || 0, base, comparison, true)}
    </tr>
  `;
}

function statementValueCells(value, comparisonValue, base, comparison, colorBySign = false) {
  const valueClass = value < 0 ? "negative" : colorBySign ? "positive" : "";
  if (!comparison) {
    return `
      <td class="num ${valueClass}">${formatMoney(value)}</td>
      <td class="num ${valueClass}">${formatPercentOfSales(value, base)}</td>
    `;
  }

  return `
    <td class="num current-cell current-amount-cell ${valueClass}">${formatMoney(value)}</td>
    <td class="num comparison-cell">${formatMoney(comparisonValue)}</td>
    <td class="num current-cell current-percent-cell ${valueClass}">${formatPercentOfSales(value, base)}</td>
    <td class="num comparison-cell">${formatPercentOfSales(comparisonValue, comparison.base)}</td>
  `;
}

function statementIcon(name) {
  if (!name) return "";
  return `<img src="assets/icons/${name}.svg?v=${ICON_VERSION}" alt="" class="statement-icon statement-icon-${name}">`;
}

// Advertencias visibles para datos faltantes o importaciones con errores.
function renderWarnings(report) {
  const warnings = [];

  if (!report.initialInventory) {
    warnings.push("Falta inventario inicial: no hay un valor monetizado anterior al mes seleccionado.");
  }

  if (!report.finalInventory) {
    warnings.push("Falta inventario final: no hay valor monetizado cargado en el mes seleccionado.");
  }

  if (report.uncategorized.length) {
    warnings.push(`Hay ${report.uncategorized.length} egreso(s) sin categoria para revisar.`);
  }

  els.warnings.innerHTML = warnings.map((warning) => (
    `<div class="notice warn">${warning}</div>`
  )).join("");
}

// Renderiza tablas auxiliares usando el reporte calculado y los datos crudos.
function renderTables(report) {
  renderDataTable("expenses", state.expenses, expenseRow);
  renderDataTable("sales", state.sales, saleRow);
  renderDataTable("orderDetails", state.orderDetails, orderDetailRow);
  renderDataTable("inventory", state.inventory, inventoryRow);
  renderDataTable("inventoryDetails", state.inventoryDetails, inventoryDetailRow);
  renderDataTable("payroll", state.payroll, payrollRow);
  renderProductionSummary(report);
  renderPayrollSummary(report);
  renderCustomerUnits(report);
  renderExpenseCategories();

  els["uncategorized-body"].innerHTML = report.uncategorized.length
    ? report.uncategorized.map((row) => `
      <tr>
        <td>${formatDate(row.date)}</td>
        <td>${escapeHtml(row.supplier)}</td>
        <td>${escapeHtml(row.category || "Sin categoria")}</td>
        <td class="num">${formatMoney(row.subtotal)}</td>
        <td>${escapeHtml(row.source || "")}</td>
      </tr>
    `).join("")
    : emptyRow(5, "No hay egresos sin categoria en el periodo.");

  els["review-count"].textContent = `${report.uncategorized.length} registros`;

}

// Ventas se filtra por perÄ‚Â­odo; egresos e inventario muestran histÄ‚Ĺ‚rico operativo.
/*
  Estado Financiero:
  - Saldo es la deuda pendiente de cada egreso.
  - Fecha_Prevista_Pago ubica ese saldo en el calendario financiero.
  - En ventas, Saldo y Fecha_Acordada forman las facturas por cobrar.
  La pantalla no usa el filtro mensual: muestra todas las deudas pendientes.
*/
function renderFinancialStatement() {
  if (!els["financial-overdue-balance"] || !els["financial-payments-body"]) return;
  const pendingExpenses = state.expenses.filter((expense) => (
    Math.abs(moneyToCents(expense.balance)) > 1000 && isFinancialInvoiceTypeVisible(expense.invoiceType)
  ));
  const pendingSales = state.sales.filter((sale) => moneyToCents(sale.balance) > 1000);
  const pendingIssuedChecks = state.issuedChecks.filter(isPendingFinancialCheck);
  const pendingReceivedChecks = state.receivedChecks.filter(isPendingFinancialCheck);

  els["financial-overdue-balance"].textContent = formatMoney(reportMoneySum(pendingExpenses, "balance"));
  els["financial-month-balance"].textContent = formatMoney(reportMoneySum(pendingSales, "balance"));
  els["financial-cash-banks"].textContent = formatMoney(centsToMoney(
    moneyToCents(cashAmountFor("Banco ICBC")) + moneyToCents(cashAmountFor("Banco GAL"))
  ));
  els["financial-cash-cash"].textContent = formatMoney(cashAmountFor("Efectivo"));
  els["financial-checks-on-hand"].textContent = formatMoney(reportMoneySum(pendingReceivedChecks, "amount"));
  els["financial-checks-to-cover"].textContent = formatMoney(reportMoneySum(pendingIssuedChecks, "amount"));

  const payableRows = [...pendingExpenses]
    .sort((a, b) => {
      if (!a.expectedPaymentDate && b.expectedPaymentDate) return 1;
      if (a.expectedPaymentDate && !b.expectedPaymentDate) return -1;
      return (a.expectedPaymentDate || "").localeCompare(b.expectedPaymentDate || "") || numericId(a.id) - numericId(b.id);
    });
  const receivableRows = [...pendingSales]
    .sort((a, b) => {
      if (!a.expectedCollectionDate && b.expectedCollectionDate) return 1;
      if (a.expectedCollectionDate && !b.expectedCollectionDate) return -1;
      return (a.expectedCollectionDate || "").localeCompare(b.expectedCollectionDate || "") || numericId(a.id) - numericId(b.id);
    });

  els["financial-payments-body"].innerHTML = payableRows.length
    ? payableRows.slice(0, 250).map(financialPaymentRow).join("")
    : emptyRow(6, "No hay deudas pendientes cargadas.");
  els["financial-count-label"].textContent = `${payableRows.length} registros`;

  els["financial-receivables-body"].innerHTML = receivableRows.length
    ? receivableRows.slice(0, 250).map(financialReceivableRow).join("")
    : emptyRow(6, "No hay facturas por cobrar en las tablas del backend.");
  els["financial-receivables-count-label"].textContent = `${receivableRows.length} registros`;

  els["financial-received-checks-body"].innerHTML = pendingReceivedChecks.length
    ? pendingReceivedChecks.slice(0, 250).map(financialReceivedCheckRow).join("")
    : emptyRow(6, "No hay cheques recibidos pendientes.");
  els["financial-received-checks-count-label"].textContent = `${pendingReceivedChecks.length} registros`;

  els["financial-issued-checks-body"].innerHTML = pendingIssuedChecks.length
    ? pendingIssuedChecks.slice(0, 250).map(financialIssuedCheckRow).join("")
    : emptyRow(5, "No hay cheques entregados pendientes.");
  els["financial-issued-checks-count-label"].textContent = `${pendingIssuedChecks.length} registros`;
}

function financialPaymentRow(expense) {
  return `
    <tr>
      <td>${formatDate(expense.date)}</td>
      <td>${escapeHtml(expense.supplier)}</td>
      <td>${escapeHtml(expense.invoiceType)}</td>
      <td>${escapeHtml(expense.invoiceNumber)}</td>
      <td class="num">${formatMoney(expense.balance)}</td>
      <td>${formatDate(expense.expectedPaymentDate)}</td>
    </tr>
  `;
}

function isFinancialInvoiceTypeVisible(invoiceType) {
  return !["asiento", "remito a"].includes(normalizeCategory(invoiceType));
}

function financialReceivableRow(sale) {
  return `
    <tr>
      <td>${formatDate(sale.date)}</td>
      <td>${escapeHtml(sale.customer)}</td>
      <td>${escapeHtml(sale.invoiceType)}</td>
      <td>${escapeHtml(sale.invoiceNumber)}</td>
      <td class="num">${formatMoney(sale.balance)}</td>
      <td>${formatDate(sale.expectedCollectionDate)}</td>
    </tr>
  `;
}

function financialReceivedCheckRow(check) {
  return `
    <tr>
      <td>${formatDate(check.date)}</td>
      <td>${escapeHtml(check.customer)}</td>
      <td>${escapeHtml(check.checkNumber)}</td>
      <td>${formatDate(check.useDate)}</td>
      <td>${escapeHtml(check.bank)}</td>
      <td class="num">${formatMoney(check.amount)}</td>
    </tr>
  `;
}

function financialIssuedCheckRow(check) {
  return `
    <tr>
      <td>${formatDate(check.date)}</td>
      <td>${escapeHtml(check.supplier)}</td>
      <td>${escapeHtml(check.checkNumber)}</td>
      <td>${formatDate(check.useDate)}</td>
      <td class="num">${formatMoney(check.amount)}</td>
    </tr>
  `;
}

function isPendingFinancialCheck(check) {
  return normalizeCategory(check.status) === "pendiente" && Math.abs(moneyToCents(check.amount)) > 1000;
}

function cashAmountFor(account) {
  const found = state.cash.find((row) => normalizeCategory(row.account) === normalizeCategory(account));
  return found?.amount || 0;
}

/*
  Cashflow proyectado.
  Cada movimiento conserva su fecha original, pero la pantalla permite moverlo mediante
  overrides guardados en localStorage. Los grupos se unifican por tipo + fecha + contraparte.
*/
function renderCashflow() {
  if (!backendCashflowReport) {
    renderBackendCashflowCards({ cards: {} });
    if (els["cashflow-timeline"]) {
      els["cashflow-timeline"].innerHTML = emptyRow(4, "Cargando cashflow desde backend.");
    }
    return;
  }

  const groups = buildCashflowGroups();
  const visibleGroups = groups.filter((group) => group.week.number <= 4);
  const searchTerm = normalizeSearchText(els["cashflow-search"]?.value || "");
  const tableGroups = searchTerm
    ? visibleGroups.filter((group) => cashflowGroupMatchesSearch(group, searchTerm))
    : visibleGroups;
  const initialCash = centsToMoney(
    moneyToCents(backendCashflowReport.cards?.banks || 0)
    + moneyToCents(backendCashflowReport.cards?.cash || 0)
  );
  const weeklyTimeline = buildCashflowWeeklyTimeline(tableGroups, initialCash)
    .filter((week) => !searchTerm || tableGroups.some((group) => group.week.number === week.number));

  renderBackendCashflowCards(backendCashflowReport);

  els["cashflow-timeline"].innerHTML = tableGroups.length
    ? cashflowWeeklyRows(weeklyTimeline, tableGroups, Boolean(searchTerm))
    : emptyRow(4, searchTerm ? "No hay movimientos que coincidan con la busqueda." : "No hay movimientos para proyectar desde backend.");
}

function buildCashflowGroups() {
  if (!backendCashflowReport) return [];
  return buildBackendCashflowGroupsForUi(backendCashflowReport);
}

function buildLegacyCashflowGroups() {
  const events = [
    ...cashflowPayableEvents(),
    ...cashflowReceivableEvents(),
    ...cashflowIssuedCheckEvents(),
    ...cashflowReceivedCheckEvents()
  ];
  const groups = new Map();

  events.forEach((event) => {
    const originalDate = event.date || "";
    const overrideKey = cashflowOverrideKey(event.type, event.party, originalDate, event.documentType, event.documentNumber, event.effectiveDate);
    const date = state.cashflowDateOverrides[overrideKey] || originalDate;
    if (!date) return;
    const groupKey = [
      event.type,
      date,
      normalizeCategory(event.party),
      normalizeCategory(event.documentType),
      normalizeCategory(event.documentNumber),
      event.effectiveDate || "",
      event.amount
    ].join("|");
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        type: event.type,
        label: event.label,
        date,
        party: event.party,
        documentType: event.documentType,
        documentNumber: event.documentNumber,
        effectiveDate: event.effectiveDate,
        amount: 0,
        count: 0,
        overrideKey
      });
    }
    const group = groups.get(groupKey);
    group.amount = centsToMoney(moneyToCents(group.amount) + moneyToCents(event.amount));
    group.count += 1;
  });

  return [...groups.values()]
    .map((group) => ({ ...group, week: cashflowWeekForDate(group.date) }))
    .sort((a, b) => a.week.number - b.week.number || a.date.localeCompare(b.date) || a.party.localeCompare(b.party));
}

function renderBackendCashflowCards(report) {
  const cards = report.cards || {};
  els["financial-overdue-balance"].textContent = formatMoney(cards.debts || 0);
  els["financial-month-balance"].textContent = formatMoney(cards.receivable || 0);
  els["financial-cash-banks"].textContent = formatMoney(cards.banks || 0);
  els["financial-cash-cash"].textContent = formatMoney(cards.cash || 0);
  els["financial-checks-on-hand"].textContent = formatMoney(cards.checksOnHand || 0);
  els["financial-checks-to-cover"].textContent = formatMoney(cards.checksToCover || 0);
}

function buildBackendCashflowGroupsForUi(report) {
  return (report.groups || [])
    .map((group) => {
      const overrideKey = group.overrideKey || cashflowOverrideKey(
        group.type,
        group.party,
        group.date,
        group.documentType,
        group.documentNumber,
        group.effectiveDate
      );
      const date = state.cashflowDateOverrides[overrideKey] || group.date || "";
      return {
        type: group.type,
        label: group.label,
        date,
        party: group.party,
        documentType: group.documentType,
        documentNumber: group.documentNumber,
        effectiveDate: group.effectiveDate,
        amount: normalizeMoney(group.amount || 0),
        count: Number(group.count) || 1,
        overrideKey,
        week: cashflowWeekForDate(date)
      };
    })
    .filter((group) => group.date && Math.abs(moneyToCents(group.amount)) > 1000)
    .sort((a, b) => a.week.number - b.week.number || a.date.localeCompare(b.date) || a.party.localeCompare(b.party));
}

function cashflowGroupMatchesSearch(group, searchTerm) {
  const typeLabel = cashflowTypeGroupLabel(group.type);
  const searchable = [
    group.label,
    typeLabel,
    group.party,
    group.documentType,
    group.documentNumber,
    formatDate(group.effectiveDate),
    `Semana ${group.week.number}`,
    formatDate(group.date),
    formatMoney(group.amount),
    String(group.count)
  ].join(" ");

  return normalizeSearchText(searchable).includes(searchTerm);
}

function captureCashflowExpandedState() {
  const expanded = {
    weeks: [],
    types: [],
    parties: []
  };

  document.querySelectorAll("[data-toggle-cashflow-week][aria-expanded='true']").forEach((button) => {
    expanded.weeks.push(button.dataset.toggleCashflowWeek);
  });
  document.querySelectorAll("[data-toggle-cashflow-type][aria-expanded='true']").forEach((button) => {
    expanded.types.push(button.dataset.toggleCashflowType);
  });
  document.querySelectorAll("[data-toggle-cashflow-party][aria-expanded='true']").forEach((button) => {
    expanded.parties.push(button.dataset.toggleCashflowParty);
  });

  return expanded;
}

function restoreCashflowExpandedState(expanded) {
  (expanded.weeks || []).forEach((week) => {
    const button = document.querySelector(`[data-toggle-cashflow-week="${cssEscape(week)}"]`);
    if (!button) return;
    button.setAttribute("aria-expanded", "true");
    document.querySelectorAll(`.cashflow-type-row[data-cashflow-week="${cssEscape(week)}"]`).forEach((row) => {
      row.hidden = false;
    });
  });

  (expanded.types || []).forEach((typeKey) => {
    const button = document.querySelector(`[data-toggle-cashflow-type="${cssEscape(typeKey)}"]`);
    if (!button) return;
    button.setAttribute("aria-expanded", "true");
    document.querySelectorAll(`.cashflow-party-row[data-cashflow-type="${cssEscape(typeKey)}"]`).forEach((row) => {
      row.hidden = false;
    });
  });

  (expanded.parties || []).forEach((partyKey) => {
    const button = document.querySelector(`[data-toggle-cashflow-party="${cssEscape(partyKey)}"]`);
    if (!button) return;
    button.setAttribute("aria-expanded", "true");
    document.querySelectorAll(`.cashflow-week-detail[data-cashflow-party="${cssEscape(partyKey)}"]`).forEach((row) => {
      row.hidden = false;
    });
  });
}

function cssEscape(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function startCashflowRowDrag(event) {
  const row = event.target.closest("[data-cashflow-drag-keys]");
  if (!row || event.button !== 0 || event.target.closest("input, select")) return;

  const table = row.closest("table");
  const rowRect = row.getBoundingClientRect();
  const tableRect = table.getBoundingClientRect();

  cashflowDragState = {
    row,
    table,
    keys: JSON.parse(row.dataset.cashflowDragKeys || "[]"),
    expandedState: captureCashflowExpandedState(),
    startX: event.clientX,
    startY: event.clientY,
    offsetY: event.clientY - rowRect.top,
    left: tableRect.left,
    width: tableRect.width,
    preview: null,
    dropRow: null,
    active: false
  };

  document.addEventListener("mousemove", moveCashflowRowDrag);
  document.addEventListener("mouseup", endCashflowRowDrag);
}

function moveCashflowRowDrag(event) {
  if (!cashflowDragState) return;
  const distance = Math.max(
    Math.abs(event.clientX - cashflowDragState.startX),
    Math.abs(event.clientY - cashflowDragState.startY)
  );

  if (!cashflowDragState.active && distance < 5) return;

  event.preventDefault();
  if (!cashflowDragState.active) {
    cashflowDragState.preview = createCashflowDragPreview(cashflowDragState.row);
    cashflowDragState.active = true;
    cashflowSuppressNextClick = true;
    collapseCashflowToWeekRows();
  }

  cashflowDragState.preview.style.left = `${cashflowDragState.left}px`;
  cashflowDragState.preview.style.top = `${event.clientY - cashflowDragState.offsetY}px`;
  updateCashflowDropTarget(event.clientY);
}

function endCashflowRowDrag(event) {
  document.removeEventListener("mousemove", moveCashflowRowDrag);
  document.removeEventListener("mouseup", endCashflowRowDrag);
  if (!cashflowDragState) return;

  if (cashflowDragState.active) {
    event.preventDefault();
    const dropRow = cashflowDropRowAt(event.clientY);
    if (dropRow) {
      const expandedState = cashflowDragState.expandedState;
      cashflowDragState.keys.forEach((key) => {
        state.cashflowDateOverrides[key] = dropRow.dataset.cashflowWeekStart;
      });
      saveState();
      cleanupCashflowDrag();
      renderCashflow();
      restoreCashflowExpandedState(expandedState);
      return;
    }
  }

  const expandedState = cashflowDragState.expandedState;
  cleanupCashflowDrag();
  restoreCashflowExpandedState(expandedState);
}

function updateCashflowDropTarget(clientY) {
  const dropRow = cashflowDropRowAt(clientY);
  if (cashflowDragState.dropRow === dropRow) return;
  if (cashflowDragState.dropRow) cashflowDragState.dropRow.classList.remove("cashflow-drop-target");
  cashflowDragState.dropRow = dropRow;
  if (dropRow) dropRow.classList.add("cashflow-drop-target");
}

function cashflowDropRowAt(clientY) {
  const x = cashflowDragState.left + 24;
  return document.elementFromPoint(x, clientY)?.closest("[data-cashflow-drop-week]") || null;
}

function cleanupCashflowDrag() {
  document.querySelectorAll(".cashflow-drag-source-hidden").forEach((row) => {
    row.classList.remove("cashflow-drag-source-hidden");
  });
  document.querySelectorAll(".cashflow-drag-preview").forEach((preview) => {
    preview.remove();
  });
  document.querySelectorAll(".cashflow-drop-target").forEach((row) => {
    row.classList.remove("cashflow-drop-target");
  });
  cashflowDragState = null;
}

function collapseCashflowToWeekRows() {
  document.querySelectorAll("[data-toggle-cashflow-week], [data-toggle-cashflow-type], [data-toggle-cashflow-party]").forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });
  document.querySelectorAll(".cashflow-type-row, .cashflow-party-row, .cashflow-week-detail").forEach((row) => {
    row.hidden = true;
  });
}

function createCashflowDragPreview(row) {
  document.querySelectorAll(".cashflow-drag-preview").forEach((preview) => {
    preview.remove();
  });

  const table = document.createElement("table");
  const tbody = document.createElement("tbody");
  const clone = row.cloneNode(true);

  table.className = "cashflow-week-table cashflow-drag-preview";
  table.style.width = `${row.closest("table").offsetWidth}px`;
  [...row.children].forEach((cell, index) => {
    if (clone.children[index]) clone.children[index].style.width = `${cell.offsetWidth}px`;
  });

  tbody.appendChild(clone);
  table.appendChild(tbody);
  document.body.appendChild(table);
  return table;
}

function cashflowPayableEvents() {
  return state.expenses
    .filter((expense) => (
      Math.abs(moneyToCents(expense.balance)) > 1000
      && isFinancialInvoiceTypeVisible(expense.invoiceType)
    ))
    .map((expense) => ({
      type: "payable",
      label: "Pago",
      date: expense.expectedPaymentDate,
      party: expense.supplier || "Sin acreedor",
      documentType: expense.invoiceType || "Sin tipo",
      documentNumber: expense.invoiceNumber || "Sin numero",
      effectiveDate: expense.date,
      amount: centsToMoney(-moneyToCents(expense.balance))
    }));
}

function cashflowReceivableEvents() {
  return state.sales
    .filter((sale) => moneyToCents(sale.balance) > 1000)
    .map((sale) => ({
      type: "receivable",
      label: "Cobro",
      date: sale.expectedCollectionDate,
      party: sale.customer || "Sin cliente",
      documentType: sale.invoiceType || "Sin tipo",
      documentNumber: sale.invoiceNumber || "Sin numero",
      effectiveDate: sale.date,
      amount: centsToMoney(moneyToCents(sale.balance))
    }));
}

function cashflowIssuedCheckEvents() {
  return state.issuedChecks
    .filter(isPendingFinancialCheck)
    .map((check) => ({
      type: "issued-check",
      label: "Cheque a cubrir",
      date: check.useDate,
      party: check.supplier || "Sin acreedor",
      documentType: "Cheque",
      documentNumber: check.checkNumber || "Sin numero",
      effectiveDate: check.date,
      amount: centsToMoney(-Math.abs(moneyToCents(check.amount)))
    }));
}

function cashflowReceivedCheckEvents() {
  return state.receivedChecks
    .filter(isPendingFinancialCheck)
    .map((check) => ({
      type: "received-check",
      label: "Cheque en mano",
      date: check.useDate,
      party: check.customer || "Sin cliente",
      documentType: "Cheque",
      documentNumber: check.checkNumber || "Sin numero",
      effectiveDate: check.date,
      amount: centsToMoney(moneyToCents(check.amount))
    }));
}

function buildCashflowWeeklyTimeline(groups, initialCash) {
  let balanceCents = moneyToCents(initialCash);
  const byWeek = new Map();

  for (let weekNumber = 1; weekNumber <= 4; weekNumber += 1) {
    byWeek.set(weekNumber, { ...cashflowWeekForNumber(weekNumber), income: 0, outcome: 0, net: 0, balance: 0 });
  }

  groups.forEach((group) => {
    const week = group.week || cashflowWeekForDate(group.date);
    if (week.number > 4) return;
    const row = byWeek.get(week.number);
    const amountCents = moneyToCents(group.amount);
    if (amountCents >= 0) row.income += amountCents;
    else row.outcome += Math.abs(amountCents);
    row.net += amountCents;
  });

  return [...byWeek.values()].sort((a, b) => a.number - b.number).map((week) => {
    balanceCents += week.net;
    return {
      ...week,
      income: centsToMoney(week.income),
      outcome: centsToMoney(week.outcome),
      net: centsToMoney(week.net),
      balance: centsToMoney(balanceCents)
    };
  });
}

function cashflowWeeklyRows(weeks, groups, forceOpen = false) {
  const typeGroupsByWeek = cashflowTypeGroupsByWeek(groups);

  return weeks.map((week) => (
    `${cashflowWeekRow(week, forceOpen)}${(typeGroupsByWeek.get(week.number) || []).map((typeGroup) => cashflowTypeRow(typeGroup, forceOpen)).join("")}`
  )).join("");
}

function cashflowTypeGroupsByWeek(groups) {
  const typeGroups = new Map();

  groups.forEach((group) => {
    const typeKey = `${group.week.number}|${group.type}`;
    if (!typeGroups.has(typeKey)) {
      typeGroups.set(typeKey, {
        key: typeKey,
        week: group.week,
        type: group.type,
        label: cashflowTypeGroupLabel(group.type),
        amount: 0,
        count: 0,
        partyGroups: new Map()
      });
    }

    const typeGroup = typeGroups.get(typeKey);
    typeGroup.amount = centsToMoney(moneyToCents(typeGroup.amount) + moneyToCents(group.amount));
    typeGroup.count += group.count;

    const partyKey = `${typeKey}|${normalizeCategory(group.party)}`;
    if (!typeGroup.partyGroups.has(partyKey)) {
      typeGroup.partyGroups.set(partyKey, {
        key: partyKey,
        week: group.week,
        type: group.type,
        label: group.label,
        party: group.party,
        amount: 0,
        count: 0,
        details: []
      });
    }
    const partyGroup = typeGroup.partyGroups.get(partyKey);
    partyGroup.amount = centsToMoney(moneyToCents(partyGroup.amount) + moneyToCents(group.amount));
    partyGroup.count += group.count;
    partyGroup.details.push(group);
  });

  const byWeek = new Map();
  [...typeGroups.values()]
    .sort((a, b) => a.week.number - b.week.number || cashflowTypeSort(a.type) - cashflowTypeSort(b.type))
    .forEach((typeGroup) => {
      typeGroup.partyGroups = [...typeGroup.partyGroups.values()]
        .sort((a, b) => a.party.localeCompare(b.party) || a.label.localeCompare(b.label));
      if (!byWeek.has(typeGroup.week.number)) byWeek.set(typeGroup.week.number, []);
      byWeek.get(typeGroup.week.number).push(typeGroup);
    });

  return byWeek;
}

function cashflowTypeGroupLabel(type) {
  return {
    payable: "Pagos",
    receivable: "Cobros",
    "received-check": "Cheques",
    "issued-check": "Cheques Entregados"
  }[type] || type;
}

function cashflowTypeSort(type) {
  return {
    payable: 1,
    "issued-check": 2,
    receivable: 3,
    "received-check": 4
  }[type] || 99;
}

function cashflowWeekRow(week, forceOpen = false) {
  return `
    <tr class="cashflow-week-summary" data-cashflow-drop-week="${week.number}" data-cashflow-week-start="${week.startIso}">
      <td>
        <button class="toggle-row" type="button" data-toggle-cashflow-week="${week.number}" aria-expanded="${forceOpen ? "true" : "false"}">
          <span class="chevron" aria-hidden="true"></span>
          Semana ${week.number}
        </button>
      </td>
      <td class="num positive">${formatMoney(week.income)}</td>
      <td class="num negative">${formatMoney(week.outcome)}</td>
      <td class="num ${week.balance < 0 ? "negative" : "positive"}">${formatMoney(week.balance)}</td>
    </tr>
  `;
}

function cashflowTypeRow(typeGroup, forceOpen = false) {
  return `
    <tr class="cashflow-type-row" data-cashflow-week="${typeGroup.week.number}"${forceOpen ? "" : " hidden"}>
      <td>
        <button class="toggle-row cashflow-indent-1" type="button" data-toggle-cashflow-type="${escapeHtml(typeGroup.key)}" data-cashflow-week="${typeGroup.week.number}" aria-expanded="${forceOpen ? "true" : "false"}">
          <span class="chevron" aria-hidden="true"></span>
          ${escapeHtml(typeGroup.label)}
          <span class="muted-inline">(${typeGroup.count})</span>
        </button>
      </td>
      <td class="num ${typeGroup.amount > 0 ? "positive" : ""}">${typeGroup.amount > 0 ? formatMoney(typeGroup.amount) : "-"}</td>
      <td class="num ${typeGroup.amount < 0 ? "negative" : ""}">${typeGroup.amount < 0 ? formatMoney(Math.abs(typeGroup.amount)) : "-"}</td>
      <td></td>
    </tr>
    ${typeGroup.partyGroups.map((partyGroup) => cashflowPartyRow(partyGroup, typeGroup.key, forceOpen)).join("")}
  `;
}

function cashflowPartyRow(partyGroup, typeKey = partyGroup.key.split("|").slice(0, 2).join("|"), forceOpen = false) {
  const hasTypeParent = Boolean(typeKey);
  const typeAttribute = hasTypeParent ? ` data-cashflow-type="${escapeHtml(typeKey)}"` : "";
  const indentClass = hasTypeParent ? "cashflow-indent-2" : "cashflow-indent-1";
  const dragKeys = escapeHtml(JSON.stringify(partyGroup.details.map((group) => group.overrideKey)));
  const label = `${partyGroup.label} Ă‚Â· ${partyGroup.party}`;
  const firstCell = true
    ? `
        <button class="toggle-row ${indentClass}" type="button" data-toggle-cashflow-party="${escapeHtml(partyGroup.key)}"${typeAttribute} data-cashflow-week="${partyGroup.week.number}" aria-expanded="${forceOpen ? "true" : "false"}">
          <span class="drag-handle" aria-hidden="true">Ă˘Â ĹĽ</span>
          <span class="chevron" aria-hidden="true"></span>
          ${escapeHtml(partyGroup.party)}
          <span class="muted-inline">(${partyGroup.count})</span>
        </button>
      `
    : `
        <div class="${indentClass}">
          ${escapeHtml(partyGroup.party)}
          <span class="muted-inline">(${partyGroup.count})</span>
          <br><span class="muted-inline">${formatDate(detail.date)}</span>
        </div>
      `;

  return `
    <tr class="cashflow-party-row" data-cashflow-drag-keys="${dragKeys}" data-cashflow-week="${partyGroup.week.number}"${typeAttribute}${forceOpen ? "" : " hidden"}>
      <td>${firstCell}</td>
      <td class="num ${partyGroup.amount > 0 ? "positive" : ""}">${partyGroup.amount > 0 ? formatMoney(partyGroup.amount) : "-"}</td>
      <td class="num ${partyGroup.amount < 0 ? "negative" : ""}">${partyGroup.amount < 0 ? formatMoney(Math.abs(partyGroup.amount)) : "-"}</td>
      <td></td>
    </tr>
    ${partyGroup.details.map((group) => cashflowWeekDetailRow(group, partyGroup.key, forceOpen)).join("")}
  `;
}

function cashflowWeekDetailRow(group, partyKey, forceOpen = false) {
  const typeKey = partyKey.split("|").slice(0, 2).join("|");
  const dateLabel = {
    payable: "Fecha de gasto",
    receivable: "Fecha de Entrega",
    "received-check": "Fecha de uso",
    "issued-check": "Fecha de uso"
  }[group.type] || "Fecha efectiva";
  const dragKeys = escapeHtml(JSON.stringify([group.overrideKey]));
  return `
    <tr class="cashflow-week-detail" data-cashflow-drag-keys="${dragKeys}" data-cashflow-week="${group.week.number}" data-cashflow-type="${escapeHtml(typeKey)}" data-cashflow-party="${escapeHtml(partyKey)}"${forceOpen ? "" : " hidden"}>
      <td>
        <div class="cashflow-indent-3">
          <span class="drag-handle" aria-hidden="true">Ă˘Â ĹĽ</span>
          ${escapeHtml(group.documentType || "Sin tipo")} - ${escapeHtml(group.documentNumber || "Sin numero")}<br>
          <span class="muted-inline">${dateLabel}: ${formatDate(group.effectiveDate)}</span>
        </div>
      </td>
      <td class="num ${group.amount > 0 ? "positive" : ""}">${group.amount > 0 ? formatMoney(group.amount) : "-"}</td>
      <td class="num ${group.amount < 0 ? "negative" : ""}">${group.amount < 0 ? formatMoney(Math.abs(group.amount)) : "-"}</td>
      <td></td>
    </tr>
  `;
}

function cashflowWeekSelect(dateIso, overrideKey) {
  const currentWeek = cashflowWeekForDate(dateIso).number;
  const options = [1, 2, 3, 4].map((weekNumber) => {
    const week = cashflowWeekForNumber(weekNumber);
    const selected = weekNumber === currentWeek ? " selected" : "";
    return `<option value="${week.startIso}"${selected}>Semana ${weekNumber}</option>`;
  }).join("");

  return `
    <select class="cashflow-week-select" aria-label="Cambio de semana" data-cashflow-key="${escapeHtml(overrideKey)}">
      ${options}
    </select>
  `;
}

function cashflowOverrideKey(type, party, date, documentType = "", documentNumber = "", effectiveDate = "") {
  return `${type}|${normalizeCategory(party)}|${date}|${normalizeCategory(documentType)}|${normalizeCategory(documentNumber)}|${effectiveDate}`;
}

function cashflowWeekForDate(dateIso) {
  if (!dateIso || dateIso < CASHFLOW_START_ISO) {
    return cashflowWeekForNumber(1);
  }

  const days = daysBetweenIso(CASHFLOW_START_ISO, dateIso);
  const number = Math.floor(days / 7) + 1;
  return cashflowWeekForNumber(number);
}

function cashflowWeekForNumber(number) {
  const startIso = addDaysIso(CASHFLOW_START_ISO, (number - 1) * 7);
  const endIso = addDaysIso(startIso, 6);
  return {
    number,
    startIso,
    endIso,
    rangeLabel: number === 1
      ? `hasta ${formatDate(endIso)}`
      : `${formatDate(startIso)} al ${formatDate(endIso)}`
  };
}

function daysBetweenIso(startIso, endIso) {
  return Math.floor((dateFromIso(endIso) - dateFromIso(startIso)) / 86400000);
}

function addDaysIso(startIso, days) {
  const date = dateFromIso(startIso);
  date.setDate(date.getDate() + days);
  return toIsoDate(date);
}

function dateFromIso(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function renderDataTable(kind, rows, rowRenderer) {
  const body = els[tableBodyIdForKind(kind)];
  const countLabel = els[countLabelIdForKind(kind)];
  if (!body || !countLabel) return;
  const displayRows = filteredRowsForTable(kind, rows);
  const sorted = [...displayRows].sort((a, b) => {
    if (kind === "sales") return numericId(a.id) - numericId(b.id);
    if (kind === "orderDetails") return a.customer.localeCompare(b.customer) || a.product.localeCompare(b.product);
    if (kind === "payroll") return a.employee.localeCompare(b.employee);
    if (kind === "inventory") return b.date.localeCompare(a.date) || inventoryTurnOrder(a.turn) - inventoryTurnOrder(b.turn);
    if (kind === "inventoryDetails") {
      return b.date.localeCompare(a.date)
        || inventoryTurnOrder(a.turn) - inventoryTurnOrder(b.turn)
        || numericId(a.inventoryId) - numericId(b.inventoryId)
        || numericId(a.itemId) - numericId(b.itemId);
    }
    return b.date.localeCompare(a.date);
  });
  const colspans = {
    expenses: 11,
    sales: 10,
    orderDetails: 3,
    inventory: 4,
    inventoryDetails: 7,
    payroll: 3
  };
  body.innerHTML = sorted.length
    ? sorted.slice(0, 200).map(rowRenderer).join("")
    : emptyRow(colspans[kind], "Todavia no hay datos cargados.");
  countLabel.textContent = ["sales", "orderDetails", "payroll"].includes(kind)
    ? `${displayRows.length} registros del periodo`
    : `${rows.length} registros`;
}

function inventoryTurnOrder(value) {
  const normalized = normalizeCategory(value);
  if (normalized === "madrugada" || normalized === "turno madrugada") return 0;
  if (normalized === "manana" || normalized === "maĂ±ana" || normalized === "turno manana" || normalized === "turno maĂ±ana") return 1;
  if (normalized === "tarde" || normalized === "turno tarde") return 2;
  return 3;
}

function tableBodyIdForKind(kind) {
  return {
    expenses: "expenses-body",
    sales: "sales-body",
    orderDetails: "order-details-body",
    inventory: "inventory-body",
    inventoryDetails: "inventory-details-body",
    payroll: "payroll-body"
  }[kind];
}

function countLabelIdForKind(kind) {
  return {
    expenses: "expenses-count-label",
    sales: "sales-count-label",
    orderDetails: "order-details-count-label",
    inventory: "inventory-count-label",
    inventoryDetails: "inventory-details-count-label",
    payroll: "payroll-count-label"
  }[kind];
}

function filteredRowsForTable(kind, rows) {
  if (kind === "sales" || kind === "payroll") return filterRowsBySelectedPeriod(rows);
  if (kind === "orderDetails") {
    const start = new Date(state.selectedYear, state.selectedMonth, 1);
    const end = new Date(state.selectedYear, state.selectedMonth + 1, 0);
    const startIso = toIsoDate(start);
    const endIso = toIsoDate(end);
    const monthlySales = state.sales.filter((row) => row.date >= startIso && row.date <= endIso);
    return filterOrderDetailsForReport(rows, monthlySales, startIso, endIso);
  }
  return rows;
}

function numericId(value) {
  const number = Number(String(value || "").replace(/\D/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function filterRowsBySelectedPeriod(rows) {
  const start = new Date(state.selectedYear, state.selectedMonth, 1);
  const end = new Date(state.selectedYear, state.selectedMonth + 1, 0);
  const startIso = toIsoDate(start);
  const endIso = toIsoDate(end);
  return rows.filter((row) => row.date >= startIso && row.date <= endIso);
}

function expenseRow(row) {
  return `
    <tr>
      <td>${escapeHtml(row.id)}</td>
      <td>${formatDate(row.date)}</td>
      <td>${escapeHtml(row.supplier)}</td>
      <td>${escapeHtml(row.category)}</td>
      <td>${escapeHtml(row.invoiceType)}</td>
      <td class="num">${formatMoney(row.subtotal)}</td>
      <td class="num">${formatMoney(row.vat)}</td>
      <td class="num">${formatMoney(row.vatRetention)}</td>
      <td class="num">${formatMoney(row.iibbRetention)}</td>
      <td class="num">${formatMoney(row.internalTaxes)}</td>
      <td class="num">${formatMoney(row.total)}</td>
    </tr>
  `;
}

// Separa categorÄ‚Â­as de egresos entre las que entran al reporte y las pendientes.
function renderExpenseCategories() {
  if (
    !els["expense-categories-body"]
    || !els["expense-categories-count"]
    || !els["unclassified-categories-body"]
  ) return;
  const categories = new Map();

  state.expenses.forEach((expense) => {
    const name = expense.category || "Sin categoria";
    if (!categories.has(name)) {
      categories.set(name, { name, count: 0, subtotal: 0 });
    }
    const category = categories.get(name);
    category.count += 1;
    category.subtotal = centsToMoney(
      moneyToCents(category.subtotal) + moneyToCents(expense.subtotal)
    );
  });

  const rows = [...categories.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const classified = [];
  const unclassified = [];

  rows.forEach((row) => {
    const classification = reportClassificationForCategory(row.name);
    if (classification) {
      classified.push({ ...row, classification });
    } else {
      unclassified.push(row);
    }
  });

  els["expense-categories-body"].innerHTML = classified.length
    ? classified.map((row) => {
      return `
        <tr>
          <td>${escapeHtml(row.name)}</td>
          <td class="num">${row.count}</td>
          <td class="num">${formatMoney(row.subtotal)}</td>
          <td>${escapeHtml(row.classification)}</td>
        </tr>
      `;
    }).join("")
    : emptyRow(4, "Todavia no hay categorias clasificadas.");

  els["expense-categories-count"].textContent = `${classified.length} categorias`;

  els["unclassified-categories-body"].innerHTML = unclassified.length
    ? unclassified.map((row) => `
      <tr>
        <td>${escapeHtml(row.name)}</td>
        <td class="num">${row.count}</td>
        <td class="num">${formatMoney(row.subtotal)}</td>
      </tr>
    `).join("")
    : emptyRow(3, "No hay categorias sin clasificar.");

  els["unclassified-categories-count"].textContent = `${unclassified.length} categorias`;
}

// Mapeo fijo de categorÄ‚Â­as de egresos hacia la estructura actual del reporte.
function reportClassificationForCategory(category) {
  const groups = [
    ["Costo de ventas / Mercaderia", ["Mercaderia"]],
    ["Costo de ventas / Comisiones", ["Comisiones"]],
    ["Costo de ventas / Logistica", ["Logistica"]],
    ["Gastos operativos / Sueldos", ["Sueldos"]],
    ["Gastos operativos / Sueldos_Extras", ["Sueldos_Extras"]],
    ["Gastos operativos / Administrativos", ["Administrativos"]],
    ["Gastos operativos / Servicios", ["Servicios", "Herramientas_De_Trabajo"]],
    ["Gastos operativos / Alquiler", ["Alquiler"]],
    ["Gastos operativos / Mantenimiento y Varios", ["Cadeteria", "Limpieza", "Varios", "Otros", "Incentivos_Personal"]],
    ["Gastos no operativos / Otros Impuestos", ["Impuesto Cred", "Impuesto Deb", "Impuesto Sello"]],
    ["Gastos no operativos / Gastos Bancarios", ["Gastos Bancarios"]],
    ["Gastos no operativos / Intereses", ["Intereses", "Rendimiento Fondo"]],
    ["Gastos no operativos / Inversion General", ["Inversion General", "Maquinaria"]]
  ];

  const match = groups.find(([, categories]) => matchesAnyCategory(category, categories));
  return match ? match[0] : "";
}

function saleRow(row) {
  return `
    <tr>
      <td>${escapeHtml(row.id)}</td>
      <td>${escapeHtml(row.customer)}</td>
      <td>${formatDate(row.date)}</td>
      <td>${escapeHtml(row.invoiceType)}</td>
      <td class="num">${formatMoney(row.vat)}</td>
      <td class="num">${formatMoney(row.vatRetention)}</td>
      <td class="num">${formatMoney(row.iibbRetention)}</td>
      <td class="num">${formatMoney(row.incomeTaxRetention)}</td>
      <td class="num">${formatMoney(row.subtotal)}</td>
      <td class="num">${formatMoney(row.total)}</td>
    </tr>
  `;
}

function orderDetailRow(row) {
  return `
    <tr>
      <td>${escapeHtml(row.product)}</td>
      <td>${escapeHtml(row.customer)}</td>
      <td class="num">${formatNumber(row.individualQuantity)}</td>
    </tr>
  `;
}

function payrollRow(row) {
  return `
    <tr>
      <td>${escapeHtml(row.employee)}</td>
      <td>${formatMonthYear(row.date)}</td>
      <td class="num">${formatNumber(row.totalHours)}</td>
    </tr>
  `;
}

function renderPayrollSummary(report) {
  if (!els["payroll-body"] || !els["payroll-count-label"]) return;
  els["payroll-body"].innerHTML = report.payroll.rows.length
    ? report.payroll.rows.map(payrollRow).join("")
    : emptyRow(3, "No hay horas cargadas para el periodo.");

  els["payroll-count-label"].textContent = `${report.payroll.rows.length} empleados del periodo`;
  els["payroll-summary-label"].textContent = `${MONTHS[report.month]} ${report.year}`;
  els["payroll-employee-count"].textContent = formatNumber(report.payroll.employeeCount);
  els["payroll-hours-total"].textContent = formatNumber(report.payroll.totalHours);
}

function renderCustomerUnits(report) {
  if (!els["customer-units-body"] || !els["customer-units-count-label"]) return;
  const unitsByCustomer = new Map();

  report.monthlyOrderDetails.forEach((detail) => {
    const customer = detail.customer || "Sin cliente";
    unitsByCustomer.set(customer, (unitsByCustomer.get(customer) || 0) + detail.individualQuantity);
  });

  const rows = [...unitsByCustomer.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  els["customer-units-body"].innerHTML = rows.length
    ? rows.map(([customer, units]) => `
      <tr>
        <td>${escapeHtml(customer)}</td>
        <td class="num">${formatNumber(units)}</td>
      </tr>
    `).join("")
    : emptyRow(2, "No hay unidades cargadas para el periodo.");

  els["customer-units-count-label"].textContent = `${rows.length} clientes`;
}

function inventoryRow(row) {
  return `
    <tr>
      <td>${escapeHtml(row.id || "")}</td>
      <td>${formatDate(row.date)}</td>
      <td>${escapeHtml(row.turn || "-")}</td>
      <td>${escapeHtml(row.employeeId || "-")}</td>
    </tr>
  `;
}

function inventoryDetailRow(row) {
  return `
    <tr>
      <td>${escapeHtml(row.id || "")}</td>
      <td>${escapeHtml(row.inventoryId || "")}</td>
      <td>${formatDate(row.date)}</td>
      <td>${escapeHtml(row.turn || "-")}</td>
      <td>${escapeHtml(row.itemId || "")}</td>
      <td>${escapeHtml(row.itemName)}</td>
      <td class="num">${formatNumber(row.quantity)}</td>
    </tr>
  `;
}

function renderProductionSummary(report) {
  if (!els["production-body"] || !els["production-count-label"]) return;
  const initialLabel = report.production.initial
    ? `${formatNumber(report.production.initial.units)} (${formatDate(report.production.initial.date)})`
    : "-";
  const finalLabel = report.production.final
    ? `${formatNumber(report.production.final.units)} (${formatDate(report.production.final.date)})`
    : "-";

  els["production-body"].innerHTML = `
    <tr>
      <td>${formatNumber(report.production.unitsSold)}</td>
      <td>${finalLabel}</td>
      <td>${initialLabel}</td>
      <td class="num">${formatNumber(report.production.calculatedUnits)}</td>
    </tr>
  `;
  els["production-count-label"].textContent = `${MONTHS[report.month]} ${report.year}`;
}

