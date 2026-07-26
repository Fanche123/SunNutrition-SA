function createBankReferenceService(dependencies) {
  const { DEFAULT_BANK_DETAIL_RULES, EXPECTED_BACKEND_COLUMNS, backendCreditorDisplayName, backendId, backendNextNumericId, cleanBackendText, ensureBackendTable, normalizeLookupText } = dependencies;

function ensureBackendCreditorByName(tables, name, originType = "historico") {
  const cleanName = cleanBackendText(name);
  if (!cleanName) return null;
  ensureBackendTable(tables, "acreedores");
  const creditors = tables.acreedores.rows || [];
  const normalizedName = normalizeLookupText(cleanName);
  const existing = creditors.find((creditor) => {
    const displayName = backendCreditorDisplayName(creditor, tables) || creditor.acuerdo_de_pago;
    return normalizeLookupText(displayName) === normalizedName;
  });
  if (existing) return existing;

  const creditor = {
    _rowNumber: creditors.length + 2,
    id_acreedor: backendNextNumericId(creditors, "id_acreedor"),
    origen_tipo_acreedor: originType,
    origen_id_acreedor: "",
    cuit_cuil: "",
    cbu_alias: "",
    acuerdo_de_pago: cleanName
  };
  creditors.push(creditor);
  tables.acreedores.rowCount = creditors.length;
  return creditor;
}

function normalizeBackendBankDetails(cache) {
  ensureBackendTable(cache.tables, "datos_bancarios");
  const tagIndex = backendTagIndex(cache);
  const rows = [];

  (cache.tables.datos_bancarios.rows || []).forEach((row) => {
    const detail = cleanBackendText(row.detalle || row.concepto || row.descripcion || row.informacion_complementaria);
    const creditorId = backendId(row.id_acreedor);
    const tagId = ensureBackendTag(cache, row.id_etiqueta || row.tipo || row.categoria || row.categoria_gasto, tagIndex);
    if (!detail && !creditorId && !tagId) return;
    rows.push({
      _rowNumber: row._rowNumber,
      id_dato_bancario: backendId(row.id_dato_bancario) || rows.length + 1,
      detalle: detail,
      id_acreedor: creditorId,
      id_etiqueta: tagId,
      tipo_factura: cleanBackendText(row.tipo_factura)
    });
  });

  cache.tables.datos_bancarios.headers = EXPECTED_BACKEND_COLUMNS.datos_bancarios;
  cache.tables.datos_bancarios.rows = rows;
  cache.tables.datos_bancarios.rowCount = rows.length;
}

function seedDefaultBankDetails(cache) {
  ensureBackendTable(cache.tables, "datos_bancarios");
  ensureBackendTagsTable(cache);

  const rows = cache.tables.datos_bancarios.rows;
  const existingDetails = new Set(rows
    .map((row) => backendNormalizeText(row.detalle || row.concepto || row.descripcion))
    .filter(Boolean));
  const creditors = cache.tables?.acreedores?.rows || [];
  const tagIndex = backendTagIndex(cache);
  let added = 0;

  DEFAULT_BANK_DETAIL_RULES.forEach((rule) => {
    const normalizedDetail = backendNormalizeText(rule.detail);
    if (!normalizedDetail || existingDetails.has(normalizedDetail)) return;

    const creditor = creditors.find((candidate) => (
      backendNormalizeText(backendCreditorDisplayName(candidate, cache.tables))
      === backendNormalizeText(rule.creditor)
    )) || ensureBackendCreditorByName(cache.tables, rule.creditor, "dato_bancario");
    const idEtiqueta = ensureBackendTag(cache, rule.expenseType, tagIndex);
    if (!creditor || !idEtiqueta) return;

    rows.push({
      _rowNumber: rows.length + 2,
      id_dato_bancario: backendNextNumericId(rows, "id_dato_bancario"),
      detalle: rule.detail,
      id_acreedor: backendId(creditor.id_acreedor),
      id_etiqueta: idEtiqueta,
      tipo_factura: ""
    });
    existingDetails.add(normalizedDetail);
    added += 1;
  });

  cache.tables.datos_bancarios.headers = EXPECTED_BACKEND_COLUMNS.datos_bancarios;
  cache.tables.datos_bancarios.rowCount = rows.length;
  return added;
}

function ensureBackendTagsTable(cache) {
  if (!cache.tables) cache.tables = {};
  if (!cache.tables.etiquetas) {
    cache.tables.etiquetas = {
      definition: {
        name: "etiquetas",
        label: "Etiquetas",
        module: "maestros",
        workbook: "Backend",
        sheet: "etiquetas",
        primaryKey: "id_etiqueta"
      },
      headers: EXPECTED_BACKEND_COLUMNS.etiquetas,
      rows: [],
      rowCount: 0,
      source: { type: "backend", syntheticFallback: true }
    };
  }
  cache.tables.etiquetas.rows ||= [];
}

function backendTagIndex(cache) {
  const byId = new Map();
  const byName = new Map();
  (cache.tables?.etiquetas?.rows || []).forEach((tag) => {
    const id = backendId(tag.id_etiqueta);
    if (!id) return;
    tag.id_etiqueta = id;
    const name = cleanBackendText(tag.etiqueta);
    if (name) byName.set(normalizeLookupText(name), id);
    byId.set(id, tag);
  });
  return { byId, byName };
}

function ensureBackendTag(cache, value, index = backendTagIndex(cache)) {
  const raw = cleanBackendText(value);
  if (!raw) return "";
  const numericId = backendId(raw);
  if (numericId && index.byId.has(numericId)) return numericId;

  const normalized = normalizeLookupText(raw);
  if (index.byName.has(normalized)) return index.byName.get(normalized);

  const nextId = backendNextNumericId(cache.tables.etiquetas.rows, "id_etiqueta");
  const tag = {
    id_etiqueta: nextId,
    etiqueta: raw,
    categoria_pnl: ""
  };
  cache.tables.etiquetas.rows.push(tag);
  index.byId.set(String(nextId), tag);
  index.byName.set(normalized, String(nextId));
  return String(nextId);
}

function fixedCreditorTag(originType) {
  const type = creditorOriginTypeKey(originType);
  if (type === "flete") return "Logistica";
  if (type === "empleado") return "Sueldos";
  if (type === "canal") return "Comisiones";
  return "";
}

function mostCommonBackendValue(counts) {
  if (!counts) return "";
  let bestValue = "";
  let bestCount = 0;
  counts.forEach((count, value) => {
    if (count > bestCount) {
      bestValue = value;
      bestCount = count;
    }
  });
  return bestValue;
}

  return { normalizeBackendBankDetails, seedDefaultBankDetails };
}

module.exports = { createBankReferenceService };
