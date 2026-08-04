async function loadSqlSchema(force = false) {
  if (backendSqlSchema && !force) {
    renderSqlTables();
    return;
  }

  if (els["sql-table-list"]) els["sql-table-list"].innerHTML = `<div class="sql-empty">Leyendo tablas...</div>`;
  try {
    const response = await fetch(`${API_BASE_URL}/api/backend/tables`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    backendSqlSchema = payload || null;
    renderSqlTables();
  } catch (error) {
    if (els["sql-table-list"]) els["sql-table-list"].innerHTML = `<div class="sql-empty">No se pudieron leer las tablas.</div>`;
    setSqlStatus(`No se pudo cargar el esquema: ${error.message}`, "warn");
  }
}

function renderSqlTables() {
  if (!els["sql-table-list"] || !backendSqlSchema) return;
  const tables = backendSqlSchema.tables || [];
  if (els["sql-table-count"]) els["sql-table-count"].textContent = `${tables.length} tablas`;

  const byModule = groupBy(tables, "module");
  els["sql-table-list"].innerHTML = Object.entries(byModule).map(([module, moduleTables]) => `
    <section class="sql-table-module">
      <h3>${escapeHtml(dataMapModuleLabel(module))}</h3>
      ${moduleTables.map((table) => `
        <button type="button" class="sql-table-button" data-sql-table="${escapeHtml(table.name)}">
          <strong>${escapeHtml(table.name)}</strong>
          <span>${escapeHtml(sqlTableColumnLabels(table).join(", "))}</span>
        </button>
      `).join("")}
    </section>
  `).join("");

  els["sql-table-list"].querySelectorAll("[data-sql-table]").forEach((button) => {
    button.addEventListener("click", () => {
      els["sql-query"].value = `SELECT * FROM ${button.dataset.sqlTable} LIMIT 20`;
      runSqlQuery();
    });
  });
}

function sqlTableColumnLabels(table) {
  return (table.headers || table.columns || []).map((header) => {
    if (typeof header === "string") return header;
    return header.key || header.label || "";
  }).filter(Boolean);
}

async function runSqlQuery() {
  const sql = els["sql-query"]?.value || "";
  if (!sql.trim()) {
    setSqlStatus("Escribi una consulta SQL.", "warn");
    return;
  }

  const originalText = els["sql-run"]?.textContent;
  if (els["sql-run"]) {
    els["sql-run"].disabled = true;
    els["sql-run"].textContent = "Ejecutando...";
  }
  setSqlStatus("Ejecutando consulta...", "loading");

  try {
    const response = await fetch(`${API_BASE_URL}/api/backend/sql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    renderSqlResults(payload);
    const limitedLabel = payload.limited ? " Se muestran las primeras filas por limite." : "";
    setSqlStatus(`${payload.rowCount} fila(s) devueltas.${limitedLabel}`, "ok");
  } catch (error) {
    if (els["sql-results"]) els["sql-results"].innerHTML = "";
    setSqlStatus(error.message, "warn");
  } finally {
    if (els["sql-run"]) {
      els["sql-run"].disabled = false;
      els["sql-run"].textContent = originalText;
    }
  }
}

function renderSqlResults(payload) {
  if (!els["sql-results"]) return;
  const columns = payload.columns || [];
  const rows = payload.rows || [];
  if (!columns.length) {
    els["sql-results"].innerHTML = `<div class="sql-empty">La consulta no devolvio columnas.</div>`;
    return;
  }

  els["sql-results"].innerHTML = `
    <div class="sql-result-head">
      <strong>${escapeHtml(payload.table || "Resultado")}</strong>
      <span>${payload.rowCount} fila(s) devueltas</span>
    </div>
    <div class="table-wrap sql-table-wrap">
      <table>
        <thead>
          <tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${rows.length ? rows.map((row) => `
            <tr>${columns.map((column) => `<td>${escapeHtml(formatSqlCell(row[column], column, payload.table))}</td>`).join("")}</tr>
          `).join("") : emptyRow(columns.length, "La consulta no devolvio filas.")}
        </tbody>
      </table>
    </div>
  `;
}

function formatSqlCell(value, column = "", tableName = "") {
  if (value === null || value === undefined || value === "") return "";
  if (isDataEditorMoneyColumn(tableName, column)) return formatMoney(value);
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toLocaleString("es-AR", { maximumFractionDigits: 4 });
  return value;
}

let sqlGenerationInFlight = false;
let sqlGenerationSequence = 0;

async function generateSqlProposal() {
  if (sqlGenerationInFlight) return;
  const requestValue = els["sql-request"]?.value || "";
  const request = requestValue.trim();
  if (!request) {
    setSqlGenerationStatus("Describí la consulta que querés generar.", "warn");
    els["sql-request"]?.focus();
    return;
  }

  sqlGenerationInFlight = true;
  const generationId = ++sqlGenerationSequence;
  const initialSql = els["sql-query"]?.value || "";
  const originalText = els["sql-generate"]?.textContent;
  if (els["sql-generate"]) {
    els["sql-generate"].disabled = true;
    els["sql-generate"].textContent = "Generando...";
    els["sql-generate"].setAttribute("aria-busy", "true");
  }
  setSqlGenerationStatus("Generando una propuesta segura...", "loading");

  try {
    let response;
    try {
      response = await fetch(`${API_BASE_URL}/api/backend/sql/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request })
      });
    } catch {
      throw new Error("No se pudo contactar al servidor del ERP. Verificá que esté iniciado e intentá nuevamente.");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok || typeof payload.sql !== "string") {
      const errorMessage = payload.error || `El servidor del ERP respondió HTTP ${response.status}.`;
      const providerStatus = Number.isInteger(payload.providerStatus)
        && !errorMessage.includes(`HTTP ${payload.providerStatus}`)
        ? ` OpenAI respondió HTTP ${payload.providerStatus}.`
        : "";
      throw new Error(`${errorMessage}${providerStatus}`);
    }
    if (generationId !== sqlGenerationSequence
      || (els["sql-request"]?.value || "") !== requestValue
      || (els["sql-query"]?.value || "") !== initialSql) {
      setSqlGenerationStatus("La propuesta quedó desactualizada y no reemplazó tus cambios.", "warn");
      return;
    }
    if (els["sql-query"]) {
      els["sql-query"].value = payload.sql;
      els["sql-query"].focus();
    }
    setSqlGenerationStatus("Propuesta lista para revisar. Todavía no fue ejecutada.", "ok");
  } catch (error) {
    setSqlGenerationStatus(error.message || "No se pudo generar la consulta. Podés escribir SQL manualmente.", "warn");
  } finally {
    sqlGenerationInFlight = false;
    if (els["sql-generate"]) {
      els["sql-generate"].disabled = false;
      els["sql-generate"].textContent = originalText;
      els["sql-generate"].removeAttribute("aria-busy");
    }
  }
}

function setSqlStatus(message, status) {
  if (!els["sql-status"]) return;
  els["sql-status"].textContent = message;
  els["sql-status"].dataset.status = status;
}

function setSqlGenerationStatus(message, status) {
  if (!els["sql-generate-status"]) return;
  els["sql-generate-status"].textContent = message;
  els["sql-generate-status"].dataset.status = status;
}

