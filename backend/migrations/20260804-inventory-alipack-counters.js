const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { EXPECTED_BACKEND_COLUMNS } = require("../config/backend-columns");

const MIGRATION_ID = "20260804-inventory-alipack-counters";
const TABLE_NAME = "contadores_alipack";
const DEFAULT_CACHE_FILE = path.resolve(__dirname, "..", "..", "tmp", "backend-data-cache.json");
const DEFAULT_BACKUP_FILE = path.resolve(__dirname, "..", "..", "tmp", `backend-data-cache.${MIGRATION_ID}.before.json`);

function migrateInventoryAlipackCounters(source) {
  const cache = clone(source);
  cache.tables ||= {};
  const existed = Boolean(cache.tables[TABLE_NAME]);
  if (!existed) {
    cache.tables[TABLE_NAME] = {
      headers: [...EXPECTED_BACKEND_COLUMNS[TABLE_NAME]],
      rows: [],
      rowCount: 0
    };
  }
  const table = requiredTable(cache, TABLE_NAME);
  table.headers = unique([...table.headers, ...EXPECTED_BACKEND_COLUMNS[TABLE_NAME]]);
  table.rowCount = table.rows.length;
  assertInventoryAlipackCounterRows(cache);
  return {
    cache,
    report: {
      migrationId: MIGRATION_ID,
      action: "create-table",
      tableCreated: !existed,
      rowsBackfilled: 0,
      rowCount: table.rows.length
    }
  };
}

function rollbackInventoryAlipackCounters(source) {
  const cache = clone(source);
  const table = cache.tables?.[TABLE_NAME];
  if (!table) return { cache, report: { migrationId: MIGRATION_ID, action: "rollback", tableRemoved: false } };
  if ((table.rows || []).length) {
    throw migrationError(
      "INVENTORY_ALIPACK_ROLLBACK_HAS_ROWS",
      "No se puede retirar la tabla de contadores Alipack porque ya contiene registros operativos."
    );
  }
  delete cache.tables[TABLE_NAME];
  return { cache, report: { migrationId: MIGRATION_ID, action: "rollback", tableRemoved: true } };
}

function assertInventoryAlipackCounterRows(cache) {
  const inventoryIds = new Set((cache.tables?.inventarios?.rows || []).map((row) => cleanId(row.id_inventario)).filter(Boolean));
  const primaryKeys = new Set();
  const linkedInventories = new Set();
  for (const row of cache.tables?.[TABLE_NAME]?.rows || []) {
    const primaryKey = cleanId(row.id_contador_alipack);
    const inventoryId = cleanId(row.id_inventario);
    const value = Number(row.valor_contador);
    if (!primaryKey || primaryKeys.has(primaryKey)) {
      throw migrationError("INVENTORY_ALIPACK_PRIMARY_KEY_INVALID", "La tabla contiene una clave primaria vacia o duplicada.");
    }
    if (!inventoryId || linkedInventories.has(inventoryId)) {
      throw migrationError("INVENTORY_ALIPACK_INVENTORY_DUPLICATE", "Cada inventario puede tener como maximo un Contador Alipack.");
    }
    if (!inventoryIds.has(inventoryId)) {
      throw migrationError("INVENTORY_ALIPACK_ORPHAN", `El contador referencia un inventario inexistente (${inventoryId || "sin id"}).`);
    }
    if (!Number.isFinite(value) || value < 0 || String(row.valor_contador ?? "").trim() === "") {
      throw migrationError("INVENTORY_ALIPACK_VALUE_INVALID", `El contador del inventario ${inventoryId} no es valido.`);
    }
    primaryKeys.add(primaryKey);
    linkedInventories.add(inventoryId);
  }
  return true;
}

function createBackupManifest(serializedCache) {
  const source = Buffer.isBuffer(serializedCache) ? serializedCache : Buffer.from(String(serializedCache), "utf8");
  const cache = JSON.parse(source.toString("utf8"));
  return {
    migrationId: MIGRATION_ID,
    sha256: sha256(source),
    bytes: source.length,
    tableCounts: Object.fromEntries(Object.entries(cache.tables || {}).map(([name, table]) => [
      name,
      Array.isArray(table?.rows) ? table.rows.length : 0
    ]))
  };
}

function verifyBackup(serializedCache, manifest) {
  const current = createBackupManifest(serializedCache);
  if (
    current.sha256 !== manifest.sha256
    || current.bytes !== manifest.bytes
    || JSON.stringify(current.tableCounts) !== JSON.stringify(manifest.tableCounts)
  ) {
    throw migrationError("INVENTORY_ALIPACK_BACKUP_MISMATCH", "El backup no coincide con su manifiesto verificable.");
  }
  return true;
}

function runCli(argv = process.argv.slice(2)) {
  const command = argv[0] || "dry-run";
  if (!["dry-run", "apply", "rollback"].includes(command)) {
    throw migrationError("INVENTORY_ALIPACK_COMMAND_INVALID", `Comando no valido: ${command}.`);
  }
  const cacheFile = path.resolve(argv[1] || DEFAULT_CACHE_FILE);
  const backupFile = path.resolve(argv[2] || DEFAULT_BACKUP_FILE);
  const sourceBuffer = fs.readFileSync(cacheFile);
  const source = JSON.parse(sourceBuffer.toString("utf8"));

  if (command === "rollback") {
    assertRollbackIsSafe(source);
    const backupBuffer = verifiedBackupBuffer(backupFile);
    const backup = JSON.parse(backupBuffer.toString("utf8"));
    if (backup.tables?.[TABLE_NAME]) {
      throw migrationError(
        "INVENTORY_ALIPACK_BACKUP_TABLE_PRESENT",
        "El backup ya contenia la tabla y no permite retirar este esquema de forma segura."
      );
    }
    const result = rollbackInventoryAlipackCounters(source);
    writeAtomic(cacheFile, result.cache);
    return {
      command,
      cacheFile,
      backupFile,
      report: result.report
    };
  }

  const result = migrateInventoryAlipackCounters(source);
  if (command === "apply") {
    const manifest = ensureVerifiedBackup(sourceBuffer, backupFile);
    if (JSON.stringify(result.cache) !== JSON.stringify(source)) writeAtomic(cacheFile, result.cache);
    return { command, cacheFile, backupFile, backup: manifest, report: result.report };
  }
  return { command, cacheFile, backupFile, report: result.report };
}

function ensureVerifiedBackup(sourceBuffer, backupFile) {
  const manifestFile = `${backupFile}.manifest.json`;
  if (!fs.existsSync(backupFile)) fs.writeFileSync(backupFile, sourceBuffer, { flag: "wx" });
  const backupBuffer = fs.readFileSync(backupFile);
  const manifest = createBackupManifest(backupBuffer);
  if (!fs.existsSync(manifestFile)) fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { flag: "wx" });
  const stored = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  verifyBackup(backupBuffer, stored);
  const current = JSON.parse(sourceBuffer.toString("utf8"));
  if (sha256(sourceBuffer) !== stored.sha256 && !current.tables?.[TABLE_NAME]) {
    throw migrationError("INVENTORY_ALIPACK_SOURCE_DRIFT", "El cache cambio respecto del backup antes de aplicar la migracion.");
  }
  return stored;
}

function verifiedBackupBuffer(backupFile) {
  const manifestFile = `${backupFile}.manifest.json`;
  if (!fs.existsSync(backupFile) || !fs.existsSync(manifestFile)) {
    throw migrationError("INVENTORY_ALIPACK_BACKUP_MISSING", "Falta el backup verificable requerido para restaurar.");
  }
  const backupBuffer = fs.readFileSync(backupFile);
  verifyBackup(backupBuffer, JSON.parse(fs.readFileSync(manifestFile, "utf8")));
  return backupBuffer;
}

function assertRollbackIsSafe(cache) {
  const table = cache.tables?.[TABLE_NAME];
  if (!table) throw migrationError("INVENTORY_ALIPACK_TABLE_MISSING", "La tabla de contadores Alipack no existe.");
  if ((table.rows || []).length) {
    throw migrationError(
      "INVENTORY_ALIPACK_ROLLBACK_HAS_ROWS",
      "No se puede restaurar el backup porque la tabla ya contiene registros operativos."
    );
  }
}

function writeAtomic(file, value) {
  writeAtomicBuffer(file, Buffer.from(JSON.stringify(value, null, 2), "utf8"));
}

function writeAtomicBuffer(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, value);
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function requiredTable(cache, name) {
  const table = cache.tables?.[name];
  if (!table || !Array.isArray(table.rows)) {
    throw migrationError("INVENTORY_ALIPACK_TABLE_INVALID", `Falta la tabla ${name}.`);
  }
  if (!Array.isArray(table.headers)) table.headers = [];
  return table;
}

function cleanId(value) { return String(value ?? "").trim(); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function migrationError(code, message) { const error = new Error(message); error.code = code; return error; }

if (require.main === module) {
  try { console.log(JSON.stringify(runCli(), null, 2)); }
  catch (error) { console.error(`${error.code || "INVENTORY_ALIPACK_MIGRATION_FAILED"}: ${error.message}`); process.exitCode = 1; }
}

module.exports = {
  MIGRATION_ID,
  TABLE_NAME,
  assertInventoryAlipackCounterRows,
  createBackupManifest,
  migrateInventoryAlipackCounters,
  rollbackInventoryAlipackCounters,
  runCli,
  verifyBackup
};
