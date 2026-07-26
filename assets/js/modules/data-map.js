async function loadDataMap(force = false) {
  if (backendDataMap && !force) {
    renderDataMap();
    return;
  }

  if (els["data-map-summary"]) els["data-map-summary"].textContent = "Leyendo estructura del backend...";
  try {
    const response = await fetch(`${API_BASE_URL}/api/backend/map`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    backendDataMap = payload.map || null;
    syncDataMapModuleOptions();
    renderDataMap();
  } catch (error) {
    if (els["data-map-summary"]) {
      els["data-map-summary"].textContent = `No se pudo cargar el mapa: ${error.message}`;
    }
    if (els["data-map-body"]) {
      els["data-map-body"].innerHTML = `<div class="data-map-empty">No se pudo leer el mapa de datos.</div>`;
    }
  }
}

function syncDataMapModuleOptions() {
  if (!els["data-map-module"] || !backendDataMap) return;
  const current = els["data-map-module"].value || "all";
  const modules = backendDataMap.modules || [];
  els["data-map-module"].innerHTML = [
    `<option value="all">Todos</option>`,
    ...modules.map((module) => `<option value="${escapeHtml(module)}">${escapeHtml(dataMapModuleLabel(module))}</option>`)
  ].join("");
  els["data-map-module"].value = modules.includes(current) ? current : "all";
}

function renderDataMap() {
  if (!els["data-map-body"] || !backendDataMap) return;

  const selectedModule = els["data-map-module"]?.value || "all";
  const onlyIssues = Boolean(els["data-map-only-issues"]?.checked);
  const tables = (backendDataMap.tables || []).filter((table) => {
    if (selectedModule !== "all" && table.module !== selectedModule) return false;
    if (onlyIssues && !table.issueCount) return false;
    return true;
  });
  const issueTables = (backendDataMap.tables || []).filter((table) => table.issueCount > 0).length;
  const updatedLabel = backendDataMap.generatedAt ? ` Ultima lectura: ${formatDateTime(backendDataMap.generatedAt)}.` : "";

  els["data-map-summary"].textContent =
    `${backendDataMap.tableCount} tablas, ${issueTables} con diferencias, ${backendDataMap.issueCount} columnas a revisar.${updatedLabel}`;

  if (!tables.length) {
    els["data-map-body"].innerHTML = `<div class="data-map-empty">No hay tablas para mostrar con este filtro.</div>`;
    return;
  }

  const byModule = groupBy(tables, "module");
  els["data-map-body"].innerHTML = Object.entries(byModule)
    .map(([module, moduleTables]) => dataMapModuleSection(module, moduleTables))
    .join("");
}

function dataMapModuleSection(module, tables) {
  const issueCount = tables.reduce((total, table) => total + table.issueCount, 0);
  return `
    <section class="data-map-module data-map-module-${escapeHtml(module)}">
      <header>
        <div>
          <h3>${escapeHtml(dataMapModuleLabel(module))}</h3>
          <span>${tables.length} tablas</span>
        </div>
        <strong class="${issueCount ? "has-issues" : "is-ok"}">${issueCount ? `${issueCount} diferencias` : "Sin diferencias"}</strong>
      </header>
      <div class="data-map-grid">
        ${tables.map(dataMapTableCard).join("")}
      </div>
    </section>
  `;
}

function dataMapTableCard(table) {
  const extraCount = table.extraColumns?.length || 0;
  const missingCount = table.missingColumns?.length || 0;
  return `
    <article class="data-map-card ${table.issueCount ? "has-issues" : "is-ok"}">
      <div class="data-map-card-head">
        <div>
          <h4>${escapeHtml(table.label || table.name)}</h4>
          <span>${escapeHtml(table.workbook)} &middot; ${escapeHtml(table.sheet)}</span>
        </div>
        <strong>${formatNumber(table.rowCount)} filas</strong>
      </div>
      <div class="data-map-status-row">
        <span class="data-map-pill is-ok">${(table.matchedColumns || []).length} OK</span>
        <span class="data-map-pill ${extraCount ? "is-extra" : "is-muted"}">${extraCount} sobran</span>
        <span class="data-map-pill ${missingCount ? "is-missing" : "is-muted"}">${missingCount} faltan</span>
      </div>
      ${dataMapColumnGroup("Columnas importadas", table.actualColumns || [], table.expectedColumns || [], "actual")}
      ${missingCount ? dataMapMissingGroup(table.missingColumns) : ""}
    </article>
  `;
}

function dataMapColumnGroup(title, columns, expectedColumns, mode) {
  const expectedSet = new Set((expectedColumns || []).map(normalizeColumnName));
  return `
    <div class="data-map-columns">
      <span>${escapeHtml(title)}</span>
      <div>
        ${columns.length ? columns.map((column) => {
          const status = mode === "actual" && !expectedSet.has(normalizeColumnName(column)) ? "is-extra" : "is-ok";
          return `<mark class="data-map-column ${status}">${escapeHtml(column)}</mark>`;
        }).join("") : `<em>Sin columnas</em>`}
      </div>
    </div>
  `;
}

function dataMapMissingGroup(columns) {
  return `
    <div class="data-map-columns">
      <span>Faltantes del modelo</span>
      <div>${columns.map((column) => `<mark class="data-map-column is-missing">${escapeHtml(column)}</mark>`).join("")}</div>
    </div>
  `;
}
