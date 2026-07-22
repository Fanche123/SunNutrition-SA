const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const REGISTRY_FILE = path.join(__dirname, "table-registry.json");
const CACHE_FILE = path.join(ROOT_DIR, "tmp", "backend-data-cache.json");
const SOURCES_FILE = path.join(ROOT_DIR, "tmp", "backend-sources.json");
const DEFAULT_BACKEND_SOURCES = {
  "Caja (1).xlsx": "https://docs.google.com/spreadsheets/d/1BAusksHyttro_QxZtAUWTs9EHdzNUIQ6wqVABMsWRgQ/edit?gid=568298913#gid=568298913",
  "Compras.xlsx": "https://docs.google.com/spreadsheets/d/1jq1-GDpWODoZyvzx2M1nM_AC1pBarfGJG5-R91CNdZ0/edit?gid=0#gid=0",
  "Egresos.xlsx": "https://docs.google.com/spreadsheets/d/1qUXEafy7wUoLm_S-axOk2ZOE2w-ArvQPzKIUIV56Bek/edit?gid=0#gid=0",
  "Informacion.xlsx": "https://docs.google.com/spreadsheets/d/1J6byHbqScKH96vvVmQJdnQfTIMWDSt_bGNxfils850A/edit?gid=0#gid=0",
  "Inventario.xlsx": "https://docs.google.com/spreadsheets/d/1G4lIvbfH2JFpEKVoFd7Hn0tOyCERtYYs7T7-8agtmbI/edit?gid=0#gid=0",
  "OtrosGastos.xlsx": "https://docs.google.com/spreadsheets/d/1BKIRj76V8z0AoUeiqbBpW6ARBFxtD9STRSD2s4w4DVg/edit#gid=0",
  "Sueldos.xlsx": "https://docs.google.com/spreadsheets/d/1qQza5fHg7ZIhBbpz9M-o0ZhDUXVWoxEHForxpoSNMq0/edit?gid=1312570023#gid=1312570023",
  "Ventas (1).xlsx": "https://docs.google.com/spreadsheets/d/1O_RUJno7jZDfTv3LHzLJM7ooiXh4DLohxOFfJq1mVyY/edit?gid=0#gid=0"
};

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
      workbook: definition.workbook,
      sheet: definition.sheet,
      primaryKey: definition.primaryKey,
      rowCount: cached.rowCount || 0,
      headers: backendHeaders(cached.headers, rows)
    };
  });

  return {
    version: registry.version,
    generatedAt: cache.generatedAt || "",
    workbookDir: cache.workbookDir || registry.defaultWorkbookDir,
    tableCount: tableSummaries.length,
    errors: cache.errors || [],
    modules: moduleSummaries(tableSummaries),
    tables: tableSummaries
  };
}

function backendSchema() {
  const registry = loadRegistry();
  return {
    version: registry.version,
    generatedFrom: registry.generatedFrom,
    defaultWorkbookDir: registry.defaultWorkbookDir,
    sources: backendSources(),
    tables: visibleRegistryTables(registry)
  };
}

function backendTable(tableName, options = {}) {
  const cache = loadCache();
  const table = cache.tables?.[tableName];
  if (!table) return null;

  const rows = filterRows(table.rows || [], options.search);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const limit = options.all ? rows.length : Math.min(Math.max(Number(options.limit) || 500, 1), 5000);

  return {
    name: tableName,
    definition: table.definition,
    source: table.source,
    headers: backendHeaders(table.headers, table.rows || []),
    totalRows: rows.length,
    offset,
    limit,
    rows: rows.slice(offset, offset + limit)
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

function backendSources() {
  const registry = loadRegistry();
  const savedSources = { ...DEFAULT_BACKEND_SOURCES, ...loadSavedSources() };
  const visibleTables = visibleRegistryTables(registry);
  return uniqueWorkbooks(registry.tables).map((workbook) => ({
    workbook,
    url: savedSources[workbook] || "",
    tableCount: visibleTables.filter((table) => table.workbook === workbook).length
  }));
}

function saveBackendSources(sources) {
  const registry = loadRegistry();
  const validWorkbooks = new Set(uniqueWorkbooks(registry.tables));
  const cleanSources = {};

  Object.entries(sources || {}).forEach(([workbook, url]) => {
    if (validWorkbooks.has(workbook) && String(url || "").trim()) {
      cleanSources[workbook] = String(url).trim();
    }
  });

  fs.mkdirSync(path.dirname(SOURCES_FILE), { recursive: true });
  fs.writeFileSync(SOURCES_FILE, JSON.stringify(cleanSources, null, 2), "utf8");
  return backendSources();
}

function saveBackendCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  const tempFile = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(cache, null, 2), "utf8");
  fs.renameSync(tempFile, CACHE_FILE);
}

function loadSavedSources() {
  if (!fs.existsSync(SOURCES_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SOURCES_FILE, "utf8"));
  } catch {
    return {};
  }
}

function uniqueWorkbooks(tables) {
  return [...new Set(tables.map((table) => table.workbook).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function visibleRegistryTables(registry) {
  return (registry.tables || []).filter((table) => !table.hidden);
}

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) {
    return {
      generatedAt: "",
      tables: {},
      errors: [{ error: "Todavia no existe cache de datos. Ejecutar tools/build-table-cache.py." }]
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

function filterRows(rows, search) {
  const needle = String(search || "").trim().toLowerCase();
  if (!needle) return rows;

  return rows.filter((row) => {
    return Object.values(row).some((value) => String(value ?? "").toLowerCase().includes(needle));
  });
}

module.exports = {
  backendOverview,
  backendSchema,
  backendSources,
  backendTable,
  loadCache,
  loadRegistry,
  saveBackendCache,
  saveBackendSources
};
