const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT_DIR = path.resolve(__dirname, "..");
const REGISTRY_FILE = path.join(__dirname, "table-registry.json");
const CACHE_FILE = path.join(ROOT_DIR, "tmp", "backend-data-cache.json");
const ADMIN_BACKUP_DIR = path.join(ROOT_DIR, "tmp", "admin-backups");
const ADMIN_AUDIT_FILE = path.join(ROOT_DIR, "tmp", "admin-audit.jsonl");
let adminSessionBackup = null;

function backendOverview() {
  const registry = loadRegistry();
  const cache = loadCache();
  const tableSummaries = visibleRegistryTables(registry).map((definition) => {
    const cached = cache.tables?.[definition.name] || {};
    const rows = cached.rows || [];
    return {
      name: definition.name,
      label: definition.label,
      module: definition.module,
      workbook: "Backend",
      sheet: definition.name,
      primaryKey: definition.primaryKey,
      rowCount: cached.rowCount || 0,
      headers: backendHeaders(cached.headers, rows)
    };
  });

  return {
    version: registry.version,
    generatedAt: cache.generatedAt || "",
    workbookDir: "Backend",
    sourceOfTruth: "backend",
    tableCount: tableSummaries.length,
    errors: (cache.errors || []).map((error) => ({
      ...error,
      workbook: "Backend",
      sheet: error.table || error.sheet || ""
    })),
    modules: moduleSummaries(tableSummaries),
    tables: tableSummaries
  };
}

function backendSchema() {
  const registry = loadRegistry();
  return {
    version: registry.version,
    generatedFrom: registry.generatedFrom,
    defaultWorkbookDir: "Backend",
    sourceOfTruth: "backend",
    tables: visibleRegistryTables(registry).map(backendDefinition)
  };
}

function backendTable(tableName, options = {}) {
  const cache = loadCache();
  const table = cache.tables?.[tableName];
  if (!table) return null;
  const registeredDefinition = (loadRegistry().tables || []).find((definition) => definition.name === tableName) || { name: tableName };
  const definition = { ...registeredDefinition, ...(table.definition || {}) };
  const allRows = table.rows || [];
  const headers = backendHeaders(table.headers, allRows);
  const filters = normalizeColumnFilters(options.filters || options.filter, headers);
  const filteredEntries = filterTableEntries(allRows, options.search, filters, headers);
  const filteredRows = filteredEntries.map((entry) => entry.row);
  const adminContinuous = options.adminContinuous === true;
  const persistedRange = options.persistedRange === true;
  const requestedOrder = String(options.orderBy || "").trim();
  const actualOrderColumn = requestedOrder
    ? headers.find((header) => normalizeName(header) === normalizeName(requestedOrder))
    : "";
  if (requestedOrder && !actualOrderColumn) {
    const error = new Error(`La columna ${requestedOrder} no existe en la tabla.`);
    error.code = "ADMIN_ORDER_COLUMN_INVALID";
    throw error;
  }
  const normalizedOptions = { ...options, orderBy: actualOrderColumn };
  const order = adminContinuous
    ? resolveAdminTableOrder({ ...table, definition, headers }, normalizedOptions)
    : persistedRange && !normalizedOptions.orderBy
    ? { column: "", direction: "desc", source: "physical" }
    : resolveTableOrder({ ...table, definition }, filteredRows, normalizedOptions);
  const rows = sortTableRows(filteredRows, order);
  if (adminContinuous) {
    return {
      name: tableName,
      definition: backendDefinition(definition),
      source: { type: "backend", table: tableName },
      headers,
      totalTableRows: allRows.length,
      totalRows: rows.length,
      offset: 0,
      limit: rows.length,
      order,
      filters,
      rows
    };
  }
  if (persistedRange) {
    const totalRows = filteredRows.length;
    const pageSize = Math.min(Math.max(Number(options.limit) || 300, 1), 500);
    const defaultTo = normalizedOptions.orderBy ? Math.min(pageSize, totalRows) : totalRows;
    const defaultFrom = normalizedOptions.orderBy ? 1 : Math.max(1, defaultTo - pageSize + 1);
    const requestedFrom = Number(options.from);
    const requestedTo = Number(options.to);
    const hasFrom = Number.isInteger(requestedFrom) && requestedFrom > 0;
    const hasTo = Number.isInteger(requestedTo) && requestedTo > 0;
    const from = hasFrom
      ? requestedFrom
      : hasTo
        ? Math.max(1, Math.min(requestedTo, totalRows) - pageSize + 1)
        : defaultFrom;
    const to = hasTo
      ? Math.min(requestedTo, totalRows)
      : hasFrom
        ? Math.min(from + pageSize - 1, totalRows)
        : defaultTo;
    if (totalRows && from > totalRows) {
      const error = new Error(`Desde no puede superar el total de ${totalRows} filas.`);
      error.code = "ADMIN_RANGE_INVALID";
      throw error;
    }
    if (hasFrom && hasTo && requestedTo - requestedFrom + 1 > 500) {
      const error = new Error("El rango administrativo no puede superar 500 filas.");
      error.code = "ADMIN_RANGE_TOO_LARGE";
      throw error;
    }
    const orderedEntries = order.column
      ? sortTableEntries(filteredEntries, order)
      : filteredEntries.slice().reverse();
    const selectedEntries = order.column
      ? orderedEntries.slice(Math.max(from - 1, 0), Math.max(to, 0))
      : filteredEntries.slice(Math.max(from - 1, 0), Math.max(to, 0)).reverse();
    return {
      name: tableName,
      definition: backendDefinition(definition),
      source: { type: "backend", table: tableName },
      headers,
      totalTableRows: allRows.length,
      totalRows,
      offset: Math.max(from - 1, 0),
      limit: Math.max(to - from + 1, 0),
      pageSize,
      range: { from: totalRows ? from : 0, to: totalRows ? to : 0 },
      order,
      filters,
      rowPositions: from <= to && from <= totalRows ? selectedEntries.map((entry) => entry.position) : [],
      rows: from <= to && from <= totalRows ? selectedEntries.map((entry) => entry.row) : []
    };
  }
  const offset = Math.max(Number(options.offset) || 0, 0);
  const limit = options.all ? rows.length : Math.min(Math.max(Number(options.limit) || 500, 1), 5000);

  return {
    name: tableName,
    definition: backendDefinition(definition),
    source: { type: "backend", table: tableName },
    headers,
    totalTableRows: allRows.length,
    totalRows: rows.length,
    offset,
    limit,
    order,
    filters,
    rows: rows.slice(offset, offset + limit)
  };
}

function resolveAdminTableOrder(table, options = {}) {
  const headers = backendHeaders(table.headers, table.rows || []);
  const configuredPrimary = String(table.definition?.primaryKey || "").trim();
  const primaryKey = headers.find((header) => normalizeName(header) === normalizeName(configuredPrimary));
  const fallbackColumn = headers[0] || "";
  const orderColumn = primaryKey || fallbackColumn;
  const requested = String(options.orderBy || "").trim();
  if (requested && normalizeName(requested) !== normalizeName(orderColumn)) {
    const error = new Error(`El Editor administrativo solo permite ordenar por ${orderColumn || "la clave primaria"}.`);
    error.code = "ADMIN_ORDER_COLUMN_INVALID";
    throw error;
  }
  return {
    column: orderColumn,
    direction: String(options.orderDir || "desc").toLowerCase() === "asc" ? "asc" : "desc",
    source: primaryKey ? "primaryKey" : "fallback",
    primaryKeyValid: Boolean(primaryKey),
    ...(primaryKey || !fallbackColumn
      ? {}
      : { warning: `La clave primaria configurada no existe; se ordena por ${fallbackColumn}.` })
  };
}

function persistedRangeRows(rows, from, to) {
  return rows.slice(Math.max(from - 1, 0), Math.max(to, 0)).reverse();
}

function resolveTableOrder(table, rows, options) {
  const headers = backendHeaders(table.headers, table.rows || []);
  const requested = String(options.orderBy || "").trim();
  if (requested && headers.includes(requested)) {
    return { column: requested, direction: options.orderDir === "asc" ? "asc" : "desc", source: "column" };
  }
  const configured = String(table.definition?.orderBy || "").trim();
  if (configured && headers.includes(configured)) {
    return { column: configured, direction: "desc", source: "configured" };
  }
  const rawPrimary = String(table.definition?.primaryKey || "");
  const normalizedPrimary = normalizeName(rawPrimary);
  const primaryKey = headers.find((header) => normalizeName(header) === normalizedPrimary) || headers[0] || "";
  const numericPrimary = primaryKey && rows.some((row) => String(row?.[primaryKey] ?? "").trim())
    && rows.every((row) => {
      const value = String(row?.[primaryKey] ?? "").trim();
      return !value || Number.isFinite(Number(value));
    });
  if (numericPrimary) return { column: primaryKey, direction: "desc", source: "primaryKey" };
  const technicalDate = headers.find((header) => /^(creado_en|created_at|fecha_creacion)$/i.test(header));
  if (technicalDate) return { column: technicalDate, direction: "desc", source: "technicalDate" };
  return { column: "", direction: "desc", source: "physical" };
}

function sortTableRows(rows, order) {
  if (!order.column) return rows.slice().reverse();
  const direction = order.direction === "asc" ? 1 : -1;
  return rows.slice().sort((left, right) => {
    const leftValue = left?.[order.column] ?? "";
    const rightValue = right?.[order.column] ?? "";
    const leftInteger = String(leftValue).trim();
    const rightInteger = String(rightValue).trim();
    if (/^[+-]?\d+$/.test(leftInteger) && /^[+-]?\d+$/.test(rightInteger)) {
      const leftBigInt = BigInt(leftInteger);
      const rightBigInt = BigInt(rightInteger);
      if (leftBigInt < rightBigInt) return -1 * direction;
      if (leftBigInt > rightBigInt) return direction;
      return 0;
    }
    const leftNumber = Number(leftValue);
    const rightNumber = Number(rightValue);
    if (String(leftValue).trim() && String(rightValue).trim() && Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      return (leftNumber - rightNumber) * direction;
    }
    return String(leftValue).localeCompare(String(rightValue), "es", { numeric: true }) * direction;
  });
}

function sortTableEntries(entries, order) {
  const positions = new Map(entries.map((entry) => [entry.row, entry.position]));
  return sortTableRows(entries.map((entry) => entry.row), order).map((row) => ({
    row,
    position: positions.get(row)
  }));
}

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function backendDefinition(definition) {
  return {
    ...definition,
    workbook: "Backend",
    sheet: definition.name,
    source: "backend"
  };
}

function backendHeaders(headers, rows) {
  if (Array.isArray(headers) && headers.length) return headers;
  const firstRow = Array.isArray(rows) ? rows.find((row) => row && typeof row === "object") : null;
  if (!firstRow) return [];

  // Algunas restauraciones históricas conservaron filas pero perdieron los encabezados.
  // Inferirlos desde la primera fila mantiene el mapa y el editor coherentes sin tocar datos.
  return Object.keys(firstRow).filter((key) => !key.startsWith("_"));
}

function loadRegistry() {
  return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
}

function saveBackendCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  const tempFile = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(cache, null, 2), "utf8");
  fs.renameSync(tempFile, CACHE_FILE);
}

function ensureAdminSessionBackup() {
  if (adminSessionBackup) return adminSessionBackup;
  if (!fs.existsSync(CACHE_FILE)) return null;
  fs.mkdirSync(ADMIN_BACKUP_DIR, { recursive: true });
  const source = fs.readFileSync(CACHE_FILE);
  const hash = crypto.createHash("sha256").update(source).digest("hex");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = path.join(ADMIN_BACKUP_DIR, `backend-data-cache-${stamp}.json`);
  fs.writeFileSync(backupFile, source);
  const verified = crypto.createHash("sha256").update(fs.readFileSync(backupFile)).digest("hex");
  if (verified !== hash) {
    fs.rmSync(backupFile, { force: true });
    throw new Error("No se pudo verificar el backup administrativo.");
  }
  adminSessionBackup = { file: backupFile, sha256: hash };
  return adminSessionBackup;
}

function appendAdminAudit(entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  fs.mkdirSync(path.dirname(ADMIN_AUDIT_FILE), { recursive: true });
  const lines = entries.map((entry) => JSON.stringify({
    at: new Date().toISOString(),
    table: entry.table,
    operation: entry.operation,
    primaryKey: String(entry.primaryKey ?? ""),
    ...(entry.previousPrimaryKey === undefined
      ? {}
      : { previousPrimaryKey: String(entry.previousPrimaryKey ?? "") }),
    ...(entry.column ? { column: String(entry.column) } : {}),
    result: entry.result || "ok"
  })).join("\n");
  fs.appendFileSync(ADMIN_AUDIT_FILE, `${lines}\n`, "utf8");
}

function visibleRegistryTables(registry) {
  return (registry.tables || []).filter((table) => !table.hidden);
}

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) {
    return {
      generatedAt: "",
      tables: {},
      errors: [{ error: "Todavia no existe la base de datos backend." }]
    };
  }

  return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
}

function moduleSummaries(tables) {
  const modules = new Map();
  tables.forEach((table) => {
    if (!modules.has(table.module)) {
      modules.set(table.module, {
        name: table.module,
        tableCount: 0,
        rowCount: 0,
        tables: []
      });
    }

    const module = modules.get(table.module);
    module.tableCount += 1;
    module.rowCount += table.rowCount || 0;
    module.tables.push({
      name: table.name,
      label: table.label,
      rowCount: table.rowCount || 0
    });
  });
  return [...modules.values()];
}

function filterRows(rows, search, filters = {}, headers = backendHeaders([], rows)) {
  return filterTableEntries(rows, search, normalizeColumnFilters(filters, headers), headers).map((entry) => entry.row);
}

function filterTableEntries(rows, search, filters = {}, headers = backendHeaders([], rows)) {
  const needle = String(search || "").trim().toLowerCase();
  const searchableColumns = headers.length ? headers : backendHeaders([], rows);
  return rows.map((row, index) => ({ row, position: index + 1 })).filter(({ row }) => {
    const matchesSearch = !needle || searchableColumns.some((column) => (
      String(row?.[column] ?? "").toLowerCase().includes(needle)
    ));
    if (!matchesSearch) return false;
    return Object.entries(filters).every(([column, expected]) => matchesColumnFilter(row?.[column], expected));
  });
}

function normalizeColumnFilters(rawFilters, headers) {
  if (!rawFilters) return {};
  if (typeof rawFilters !== "object" || Array.isArray(rawFilters)) {
    const error = new Error("Los filtros por columna deben enviarse como un objeto.");
    error.code = "ADMIN_FILTER_INVALID";
    throw error;
  }
  const actualByNormalized = new Map((headers || []).map((header) => [normalizeName(header), header]));
  const result = {};
  for (const [requestedColumn, expected] of Object.entries(rawFilters)) {
    if (expected === undefined || expected === null || expected === "") continue;
    const actualColumn = actualByNormalized.get(normalizeName(requestedColumn));
    if (!actualColumn) {
      const error = new Error(`La columna ${requestedColumn} no existe en la tabla.`);
      error.code = "ADMIN_FILTER_COLUMN_INVALID";
      throw error;
    }
    result[actualColumn] = expected;
  }
  return result;
}

function matchesColumnFilter(rawValue, rawFilter) {
  const value = String(rawValue ?? "");
  if (Array.isArray(rawFilter)) {
    const accepted = new Set(rawFilter.map((item) => String(item ?? "").trim().toLowerCase()));
    return accepted.has(value.trim().toLowerCase());
  }
  if (rawFilter && typeof rawFilter === "object") {
    const operator = String(rawFilter.operator || rawFilter.op || "contains").toLowerCase();
    const expected = String(rawFilter.value ?? "").trim();
    if (operator === "empty") return !value.trim();
    if (operator === "notempty") return Boolean(value.trim());
    if (operator === "equals" || operator === "eq") return value.trim().toLowerCase() === expected.toLowerCase();
    if (operator === "startswith") return value.trim().toLowerCase().startsWith(expected.toLowerCase());
    if (["gt", "gte", "lt", "lte"].includes(operator)) {
      const left = Number(value);
      const right = Number(expected);
      if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
      if (operator === "gt") return left > right;
      if (operator === "gte") return left >= right;
      if (operator === "lt") return left < right;
      return left <= right;
    }
    return value.toLowerCase().includes(expected.toLowerCase());
  }
  return value.toLowerCase().includes(String(rawFilter).trim().toLowerCase());
}

module.exports = {
  backendOverview,
  backendSchema,
  backendTable,
  appendAdminAudit,
  ensureAdminSessionBackup,
  loadCache,
  loadRegistry,
  filterRows,
  matchesColumnFilter,
  normalizeColumnFilters,
  persistedRangeRows,
  resolveAdminTableOrder,
  resolveTableOrder,
  saveBackendCache,
  sortTableRows
};
