function createBackendMapService(dependencies) {
  const { EXPECTED_BACKEND_COLUMNS, loadCache, loadRegistry, normalizeHeader } = dependencies;

function backendColumnsMap() {
  const registry = loadRegistry();
  const cache = loadCache();
  const tables = registry.tables.filter((definition) => !definition.hidden).map((definition) => {
    const cached = cache.tables?.[definition.name] || {};
    const actualColumns = Array.isArray(cached.headers) ? cached.headers.map(backendHeaderKey) : [];
    const expectedColumns = EXPECTED_BACKEND_COLUMNS[definition.name] || [];
    const actualSet = new Set(actualColumns.map(normalizeHeader));
    const expectedSet = new Set(expectedColumns.map(normalizeHeader));
    const extraColumns = actualColumns.filter((column) => !expectedSet.has(normalizeHeader(column)));
    const missingColumns = expectedColumns.filter((column) => !actualSet.has(normalizeHeader(column)));

    return {
      name: definition.name,
      label: definition.label,
      module: definition.module,
      workbook: "Backend",
      sheet: definition.name,
      rowCount: cached.rowCount || 0,
      expectedColumns,
      actualColumns,
      matchedColumns: actualColumns.filter((column) => expectedSet.has(normalizeHeader(column))),
      extraColumns,
      missingColumns,
      issueCount: extraColumns.length + missingColumns.length
    };
  });
  const modules = [...new Set(tables.map((table) => table.module))].sort();

  return {
    generatedAt: cache.generatedAt || "",
    sourceOfTruth: "backend",
    tableCount: tables.length,
    issueCount: tables.reduce((total, table) => total + table.issueCount, 0),
    modules,
    tables
  };
}

function backendHeaderKey(header) {
  if (header && typeof header === "object" && "key" in header) return String(header.key || "");
  return String(header || "");
}

  return backendColumnsMap;
}

module.exports = { createBackendMapService };
