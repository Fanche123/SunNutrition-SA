let productionReportInitialized = false;
let productionReportRequestSequence = 0;

function initializeProductionReport() {
  const start = document.getElementById("production-start");
  const end = document.getElementById("production-end");
  if (!start.value || !end.value) {
    const monthEnd = new Date(state.selectedYear, state.selectedMonth + 1, 0).getDate();
    const month = String(state.selectedMonth + 1).padStart(2, "0");
    start.value = `${state.selectedYear}-${month}-01`;
    end.value = `${state.selectedYear}-${month}-${String(monthEnd).padStart(2, "0")}`;
  }
  if (!productionReportInitialized) {
    document.getElementById("production-period-form").addEventListener("submit", (event) => { event.preventDefault(); loadProductionReport(); });
    document.getElementById("production-product").addEventListener("change", loadProductionReport);
    productionReportInitialized = true;
  }
  return loadProductionReport();
}

async function loadProductionReport() {
  const requestSequence = ++productionReportRequestSequence;
  const start = document.getElementById("production-start").value;
  const end = document.getElementById("production-end").value;
  const selector = document.getElementById("production-product");
  const status = document.getElementById("production-status");
  const body = document.getElementById("production-body");
  status.textContent = "Cargando producción...";
  body.innerHTML = '<p class="production-empty">Cargando...</p>';
  clearProductionPresentation("Cargando datos...");
  try {
    const itemId = selector.value;
    const response = await fetch(`${API_BASE_URL}/api/reports/production?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&itemId=${encodeURIComponent(itemId)}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo cargar el reporte.");
    if (requestSequence !== productionReportRequestSequence) return false;
    syncProductionOptions(selector, payload.report.options, payload.report.selected.itemId);
    renderProductionReport(payload.report);
    status.textContent = payload.report.daily.length
      ? `${payload.report.metrics.positiveDays} días con producción positiva · ${escapeHtml(payload.report.selected.canonicalName)}`
      : payload.report.unavailableReasons.length
        ? productionUnavailableMessage(payload.report.unavailableReasons)
        : "Sin producción positiva para el producto y período seleccionados.";
    status.dataset.status = "success";
    return true;
  } catch (error) {
    if (requestSequence !== productionReportRequestSequence) return false;
    status.textContent = error.message;
    status.dataset.status = "error";
    body.innerHTML = `<p class="production-empty">${escapeHtml(error.message)}</p>`;
    clearProductionPresentation("No se pudo cargar el reporte.");
    return false;
  }
}

function productionUnavailableMessage(reasons) {
  const visible = reasons.slice(0, 2).join("; ");
  const remaining = reasons.length - 2;
  return `Datos insuficientes: falta ${visible}${remaining > 0 ? ` y ${remaining} dependencias más` : ""}.`;
}

function clearProductionPresentation(message) {
  document.getElementById("production-metrics").innerHTML = "";
  document.getElementById("production-chart-unit").textContent = "";
  document.getElementById("production-chart").innerHTML = `<p class="production-chart-empty">${escapeHtml(message)}</p>`;
}

function syncProductionOptions(selector, options, selectedItemId) {
  const signature = options.map((option) => `${option.itemId}:${option.name}`).join("|");
  if (selector.dataset.signature !== signature) {
    selector.innerHTML = options.map((option) => `<option value="${escapeHtml(option.itemId)}">${escapeHtml(option.name)}</option>`).join("");
    selector.dataset.signature = signature;
  }
  selector.value = selectedItemId;
}

function renderProductionReport(report) {
  renderProductionMetrics(report.metrics);
  renderProductionChart(report.daily, report.metrics.unit);
  const body = document.getElementById("production-body");
  const details = new Map();
  report.rows.forEach((row) => {
    const key = `${row.date}|${row.productId}`;
    if (!details.has(key)) details.set(key, []);
    details.get(key).push(row);
  });
  if (!report.daily.length) {
    body.innerHTML = '<p class="production-empty">No hubo producción positiva para el período.</p>';
    return;
  }
  body.innerHTML = report.daily.map((day, dayIndex) => {
    const key = `${day.date}|${day.productId}`;
    const shiftRows = details.get(key) || [];
    const visibleShiftTotal = shiftRows.reduce((sum, row) => sum + row.production, 0);
    const detailRows = shiftRows.length && Math.abs(visibleShiftTotal - day.production) < 0.000001 ? shiftRows : [];
    const total = day.production;
    const initiallyOpen = dayIndex === 0 && detailRows.length;
    const toggle = detailRows.length ? `data-production-toggle="${escapeHtml(key)}" aria-expanded="${initiallyOpen ? "true" : "false"}"` : "disabled";
    return `<article class="production-day-card">
      <button class="production-day-summary" type="button" ${toggle}>
        <span class="production-day-date"><span class="chevron" aria-hidden="true"></span><b>${formatDate(day.date)}</b></span>
        <span class="production-day-total"><strong>${productionValue(day.production, day.unit)}</strong><small>${secondaryValue(day)}</small></span>
        ${productionFlow(day)}
      </button>
      <div class="production-shift-panels" data-production-detail="${escapeHtml(key)}"${initiallyOpen ? "" : " hidden"}>${detailRows.map((row) => productionShiftPanel(row, total)).join("")}</div>
    </article>`;
  }).join("");
  body.querySelectorAll("[data-production-toggle]").forEach((button) => button.addEventListener("click", () => {
    const open = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", String(!open));
    body.querySelectorAll(`[data-production-detail="${CSS.escape(button.dataset.productionToggle)}"]`).forEach((row) => { row.hidden = open; });
  }));
}

function productionFlow(row) {
  return `<span class="production-flow"><span><small>Inventario inicial</small><b>${productionValue(row.initialInventory, row.unit)}</b></span><i>→</i><span><small>Producción</small><b>+${productionValue(row.production, row.unit)}</b></span><i>→</i><span><small>Salidas</small><b>${productionValue(row.outputs, row.unit)}</b></span><i>→</i><span><small>Inventario final</small><b>${productionValue(row.finalInventory, row.unit)}</b></span></span>`;
}

function productionShiftPanel(row, total) {
  const percentage = total > 0 ? (row.production / total) * 100 : 0;
  return `<section class="production-shift-card"><span class="production-shift-icon" aria-hidden="true">◒</span><div class="production-shift-main"><span>${escapeHtml(row.shift)}</span><strong>${productionValue(row.production, row.unit)}</strong><small>${secondaryValue(row)}</small></div><div class="production-shift-share"><i style="width:${percentage}%"></i></div><b>${formatNumber(percentage)}%</b><div class="production-shift-facts"><span>Inicial <b>${productionValue(row.initialInventory, row.unit)}</b></span><span>Salidas <b>${productionValue(row.outputs, row.unit)}</b></span><span>Final <b>${productionValue(row.finalInventory, row.unit)}</b></span></div></section>`;
}

function renderProductionMetrics(metrics) {
  const cards = [
    ["▣", "Producción total", productionValue(metrics.total, metrics.unit), ""],
    ["◴", "Promedio diario", productionValue(metrics.average, metrics.unit), ""],
    ["♜", "Mejor día", metrics.bestDate ? productionValue(metrics.bestProduction, metrics.unit) : "—", metrics.bestDate ? formatDate(metrics.bestDate) : ""],
    ["▦", "Días producidos", formatNumber(metrics.positiveDays), ""]
  ];
  document.getElementById("production-metrics").innerHTML = cards.map(([icon, label, value, note]) => `<article class="production-metric-card"><i aria-hidden="true">${icon}</i><div><span>${label}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ""}</div></article>`).join("");
}

function renderProductionChart(daily, unit) {
  const chart = document.getElementById("production-chart");
  document.getElementById("production-chart-unit").textContent = unit;
  if (!daily.length) { chart.innerHTML = '<p class="production-chart-empty">Sin días con producción positiva.</p>'; return; }
  const chronological = [...daily].reverse();
  const maximum = Math.max(...chronological.map((day) => day.production));
  const ticks = [maximum, maximum * .75, maximum * .5, maximum * .25, 0];
  chart.innerHTML = `<div class="production-chart-axis">${ticks.map((tick) => `<span>${formatNumber(tick)}</span>`).join("")}</div><div class="production-chart-grid">${ticks.map(() => "<i></i>").join("")}</div><div class="production-bars" style="--production-days:${chronological.length}">${chronological.map((day) => {
    const height = Math.max(4, (day.production / maximum) * 100);
    const accessibleLabel = `${formatDate(day.date)}: ${productionValue(day.production, unit)}`;
    return `<div class="production-bar-column" title="${escapeHtml(accessibleLabel)}" aria-label="${escapeHtml(accessibleLabel)}"><div class="production-bar-track"><span style="bottom:calc(${height}% + 4px)">${formatNumber(day.production)}</span><i style="height:${height}%"></i></div><small>${escapeHtml(day.date.slice(8, 10))}/${escapeHtml(day.date.slice(5, 7))}</small></div>`;
  }).join("")}</div>`;
}

function individualProductionValue(row) {
  if (row.individualConversionStatus === "available") return `${formatNumber(row.individualProduction)} unidades`;
  if (row.individualConversionStatus === "missing_factor") return '<span class="production-conversion-missing">Factor no disponible</span>';
  return `<span class="production-conversion-na">No aplica</span>`;
}

function secondaryValue(row) {
  if (Number.isFinite(row.secondaryProduction) && row.secondaryUnit) return `${formatNumber(row.secondaryProduction)} ${escapeHtml(row.secondaryUnit)}`;
  return individualProductionValue(row);
}

function productionValue(value, unit) { return value === null ? "—" : `${formatNumber(value)} ${escapeHtml(unit)}`; }
