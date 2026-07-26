function ensureBackendTable(tables, tableName) {
  if (!tables[tableName]) {
    tables[tableName] = {
      headers: EXPECTED_BACKEND_COLUMNS[tableName] || [],
      rows: [],
      rowCount: 0
    };
  }
  if (!Array.isArray(tables[tableName].rows)) tables[tableName].rows = [];
  if (!Array.isArray(tables[tableName].headers) || !tables[tableName].headers.length) {
    tables[tableName].headers = EXPECTED_BACKEND_COLUMNS[tableName] || [];
  } else {
    const expectedHeaders = EXPECTED_BACKEND_COLUMNS[tableName] || [];
    tables[tableName].headers = [...new Set([...tables[tableName].headers, ...expectedHeaders])];
  }
}

function normalizePartnerName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function backendEditableColumns(tableName, table) {
  const expected = EXPECTED_BACKEND_COLUMNS[tableName] || [];
  if (expected.length) return expected;
  return (table.headers || [])
    .map((column) => typeof column === "string" ? column : column.key || column.label || "")
    .filter((column) => column && !String(column || "").startsWith("_"));
}

function backendEditablePrimaryKey(tableName, table, columns) {
  const expectedPrimary = EXPECTED_BACKEND_COLUMNS[tableName]?.[0] || "";
  if (expectedPrimary) return expectedPrimary;
  const rawPrimary = table.definition?.primaryKey || "";
  const normalizedPrimary = backendNormalizeText(rawPrimary);
  return columns.find((column) => backendNormalizeText(column) === normalizedPrimary) || columns[0] || "";
}

function backendNextNumericId(rows, primaryKey) {
  if (!primaryKey) return "";
  const maxId = (rows || []).reduce((max, row) => {
    const number = Number(row?.[primaryKey]);
    return Number.isFinite(number) ? Math.max(max, Math.trunc(number)) : max;
  }, 0);
  return maxId + 1;
}

function cleanBackendText(value) {
  return String(value ?? "").trim();
}

function creditorOriginTypeKey(value) {
  const text = normalizeLookupText(value);
  if (text.includes("proveedor")) return "proveedor";
  if (text.includes("empleado")) return "empleado";
  if (text.includes("canal")) return "canal";
  if (text.includes("flete")) return "flete";
  if (text.includes("otrosacreedores") || text === "otros") return "otros_acreedores";
  return "";
}

function normalizeLookupText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function cleanBackendInput(value) {
  return String(value ?? "").trim();
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00`);
  return !Number.isNaN(date.getTime()) && value === date.toISOString().slice(0, 10);
}

function validDatePartsToIso(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return "";
  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0")
  ].join("-");
}

function nextBusinessDayIso(lastIso) {
  const date = lastIso ? new Date(`${lastIso}T00:00:00`) : new Date();
  if (lastIso) date.setDate(date.getDate() + 1);
  while ([0, 6].includes(date.getDay())) {
    date.setDate(date.getDate() + 1);
  }
  return validDatePartsToIso(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}


module.exports = { ensureBackendTable, normalizePartnerName, backendEditableColumns, backendEditablePrimaryKey, backendNextNumericId, cleanBackendText, creditorOriginTypeKey, normalizeLookupText, cleanBackendInput, isIsoDate, validDatePartsToIso, nextBusinessDayIso, normalizeHeader };
const { EXPECTED_BACKEND_COLUMNS } = require("../config/backend-columns");
