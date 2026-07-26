const crypto = require("crypto");

const MIGRATION_ID = "20260724-received-check-endorsement";
const ADDED_COLUMNS = Object.freeze(["id_pago_endoso", "fecha_endoso"]);

function migrateReceivedCheckEndorsement(cache) {
  const migrated = clone(cache);
  const table = requiredTable(migrated);
  const before = snapshot(table);
  table.headers = unique([...(table.headers || []), ...ADDED_COLUMNS]);
  table.rowCount = table.rows.length;
  assertRowsUnchanged(before.rows, table.rows);
  return {
    cache: migrated,
    report: report(before, table, "migrate")
  };
}

function rollbackReceivedCheckEndorsement(cache) {
  const rolledBack = clone(cache);
  const table = requiredTable(rolledBack);
  const before = snapshot(table);
  const populated = table.rows.filter((row) => ADDED_COLUMNS.some((column) => clean(row[column])));
  if (populated.length) {
    throw migrationError("ENDORSEMENT_ROLLBACK_HAS_DATA", "No se puede retirar el esquema de endoso porque ya existen filas con datos de endoso.");
  }
  table.headers = (table.headers || []).filter((column) => !ADDED_COLUMNS.includes(headerKey(column)));
  table.rowCount = table.rows.length;
  assertRowsUnchanged(before.rows, table.rows);
  return {
    cache: rolledBack,
    report: report(before, table, "rollback")
  };
}

function createBackupManifest(serializedCache) {
  const source = Buffer.isBuffer(serializedCache)
    ? serializedCache
    : Buffer.from(String(serializedCache), "utf8");
  const cache = JSON.parse(source.toString("utf8"));
  return {
    migrationId: MIGRATION_ID,
    sha256: crypto.createHash("sha256").update(source).digest("hex"),
    bytes: source.length,
    tableCounts: Object.fromEntries(Object.entries(cache.tables || {}).map(([name, table]) => [
      name,
      Array.isArray(table?.rows) ? table.rows.length : 0
    ]))
  };
}

function verifyBackup(serializedCache, manifest) {
  const current = createBackupManifest(serializedCache);
  if (current.sha256 !== manifest.sha256 || current.bytes !== manifest.bytes) {
    throw migrationError("ENDORSEMENT_BACKUP_MISMATCH", "El backup no coincide con su manifiesto verificable.");
  }
  if (JSON.stringify(current.tableCounts) !== JSON.stringify(manifest.tableCounts)) {
    throw migrationError("ENDORSEMENT_BACKUP_COUNTS_MISMATCH", "Los conteos del backup no coinciden con el manifiesto.");
  }
  return true;
}

function requiredTable(cache) {
  const table = cache?.tables?.cheques_recibidos;
  if (!table || !Array.isArray(table.rows)) {
    throw migrationError("ENDORSEMENT_TABLE_MISSING", "Falta la tabla cheques_recibidos.");
  }
  if (!Array.isArray(table.headers)) table.headers = [];
  return table;
}

function snapshot(table) {
  return {
    headers: clone(table.headers || []),
    rows: clone(table.rows || []),
    rowCount: table.rows.length
  };
}

function report(before, after, action) {
  return {
    migrationId: MIGRATION_ID,
    action,
    beforeCount: before.rowCount,
    afterCount: after.rows.length,
    addedColumns: action === "migrate" ? [...ADDED_COLUMNS] : [],
    removedColumns: action === "rollback" ? [...ADDED_COLUMNS] : [],
    rowsModified: 0
  };
}

function assertRowsUnchanged(beforeRows, afterRows) {
  if (JSON.stringify(beforeRows) !== JSON.stringify(afterRows)) {
    throw migrationError("ENDORSEMENT_ROWS_CHANGED", "La migración de esquema no puede modificar filas históricas.");
  }
}

function headerKey(header) {
  if (header && typeof header === "object") return String(header.key || header.label || "");
  return String(header || "");
}

function unique(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = headerKey(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function clean(value) {
  return String(value ?? "").trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function migrationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  ADDED_COLUMNS,
  MIGRATION_ID,
  createBackupManifest,
  migrateReceivedCheckEndorsement,
  rollbackReceivedCheckEndorsement,
  verifyBackup
};
