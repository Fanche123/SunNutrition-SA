let productionReportInitialized = false;

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
    document.getElementById("production-period-form").addEventListener("submit", (event) => {
      event.preventDefault();
      loadProductionReport();
    });
    productionReportInitialized = true;
  }
  return loadProductionReport();
}

async function loadProductionReport() {
  const start = document.getElementById("production-start").value;
  const end = document.getElementById("production-end").value;
  const status = document.getElementById("production-status");
  const body = document.getElementById("production-body");
  status.textContent = "Cargando producción...";
  body.innerHTML = '<tr><td class="empty" colspan="8">Cargando...</td></tr>';
  try {
    const response = await fetch(`${API_BASE_URL}/api/reports/production?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo cargar el reporte.");
    renderProductionReport(payload.report);
    status.textContent = `${payload.report.daily.length} totales diarios con producción positiva. Inventarios persistidos y entregas por fecha real.`;
    status.dataset.status = "success";
    return true;
  } catch (error) {
    status.textContent = error.message;
    status.dataset.status = "error";
    body.innerHTML = `<tr><td class="empty" colspan="8">${escapeHtml(error.message)}</td></tr>`;
    return false;
  }
}

function renderProductionReport(report) {
  const body = document.getElementById("production-body");
  const details = new Map();
  report.rows.forEach((row) => {
    const key = `${row.date}|${row.productId}`;
    if (!details.has(key)) details.set(key, []);
    details.get(key).push(row);
  });
  if (!report.daily.length) {
    body.innerHTML = '<tr><td class="empty" colspan="8">No hubo producción positiva para el período.</td></tr>';
    return;
  }
  body.innerHTML = report.daily.map((day) => {
    const key = `${day.date}|${day.productId}`;
    return `<tr class="production-daily-row">
      <td><button class="toggle-row" type="button" aria-expanded="false" data-production-toggle="${escapeHtml(key)}"><span class="chevron" aria-hidden="true"></span>${formatDate(day.date)} · Total día</button></td>
      ${productionCells(day)}
    </tr>${(details.get(key) || []).map((row) => `<tr class="production-shift-row" data-production-detail="${escapeHtml(key)}" hidden><td>${escapeHtml(row.shift)}</td>${productionCells(row)}</tr>`).join("")}`;
  }).join("");
  body.querySelectorAll("[data-production-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const open = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!open));
      body.querySelectorAll(`[data-production-detail="${CSS.escape(button.dataset.productionToggle)}"]`).forEach((row) => { row.hidden = open; });
    });
  });
}

function productionCells(row) {
  return `<td>${escapeHtml(row.productName)}</td><td class="num">${productionValue(row.initialInventory, row.unit)}</td><td class="num">${productionValue(row.sales, row.unit)}</td><td class="num">${productionValue(row.finalInventory, row.unit)}</td><td class="num">${productionValue(row.production, row.unit)}</td><td class="num">${individualProductionValue(row)}</td><td>${productionStatus(row)}</td>`;
}

function individualProductionValue(row) {
  if (row.individualConversionStatus === "available") return `${formatNumber(row.individualProduction)} unidades`;
  if (row.individualConversionStatus === "missing_factor") return '<span class="production-conversion-missing">Factor no disponible</span>';
  return `<span class="production-conversion-na">No aplica (${escapeHtml(row.unit)})</span>`;
}

function productionValue(value, unit) {
  return value === null ? "—" : `${formatNumber(value)} ${escapeHtml(unit)}`;
}

function productionStatus(row) {
  if (row.status === "insufficient") return `<span class="production-status is-insufficient">${escapeHtml(row.warning)}</span>`;
  if (row.status === "warning") return `<span class="production-status is-warning">${escapeHtml(row.warning)}</span>`;
  return '<span class="production-status is-ok">Conciliado</span>';
}
