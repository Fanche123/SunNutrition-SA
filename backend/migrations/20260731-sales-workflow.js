const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { EXPECTED_BACKEND_COLUMNS } = require("../config/backend-columns");

const MIGRATION_ID = "20260731-sales-workflow";
const TABLE_NAME = "gestion_ventas";
const DEFAULT_CACHE_FILE = path.resolve(__dirname, "..", "..", "tmp", "backend-data-cache.json");
const DEFAULT_BACKUP_FILE = path.resolve(__dirname, "..", "..", "tmp", "backend-data-cache.ERP-VTA-20260731-16.before.json");

function migrateSalesWorkflow(source) {
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
  assertUniqueWorkflowRows(table.rows);
  return {
    cache,
    report: {
      migrationId: MIGRATION_ID,
      action: "migrate",
      tableCreated: !existed,
      rowsModified: 0,
      rowCount: table.rows.length
    }
  };
}

function rollbackSalesWorkflow(source) {
  const cache = clone(source);
  const rows = cache.tables?.[TABLE_NAME]?.rows || [];
  if (rows.length) throw migrationError("SALES_WORKFLOW_ROLLBACK_HAS_DATA", "No se puede retirar la tabla porque ya contiene auditoría operativa.");
  delete cache.tables?.[TABLE_NAME];
  return { cache, report: { migrationId: MIGRATION_ID, action: "rollback", rowsModified: 0 } };
}

function createBackupManifest(serializedCache) {
  const source = Buffer.isBuffer(serializedCache) ? serializedCache : Buffer.from(String(serializedCache), "utf8");
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
    throw migrationError("SALES_WORKFLOW_BACKUP_MISMATCH", "El backup no coincide con su manifiesto verificable.");
  }
  if (JSON.stringify(current.tableCounts) !== JSON.stringify(manifest.tableCounts)) {
    throw migrationError("SALES_WORKFLOW_BACKUP_COUNTS_MISMATCH", "Los conteos del backup no coinciden con el manifiesto.");
  }
  return true;
}

function assertUniqueWorkflowRows(rows) {
  const orderIds = new Set();
  const creationKeys = new Set();
  rows.forEach((row) => {
    const orderId = text(row.id_pedido);
    const creationKey = text(row.clave_creacion_pedido);
    if (!orderId) throw migrationError("SALES_WORKFLOW_ORDER_REQUIRED", "Toda gestión debe pertenecer a un pedido.");
    if (orderIds.has(orderId)) throw migrationError("SALES_WORKFLOW_ORDER_DUPLICATE", `El pedido ${orderId} tiene más de una gestión.`);
    orderIds.add(orderId);
    if (creationKey) {
      if (creationKeys.has(creationKey)) throw migrationError("SALES_WORKFLOW_CREATION_KEY_DUPLICATE", `La clave ${creationKey} está duplicada.`);
      creationKeys.add(creationKey);
    }
  });
}

function requiredTable(cache, name) {
  const table = cache.tables?.[name];
  if (!table || !Array.isArray(table.rows)) throw migrationError("SALES_WORKFLOW_TABLE_INVALID", `Falta la tabla ${name}.`);
  if (!Array.isArray(table.headers)) table.headers = [];
  return table;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function text(value) {
  return String(value ?? "").trim();
}

function migrationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function runCli(argv = process.argv.slice(2)) {
  const command = argv[0] || "dry-run";
  if (!['dry-run', 'apply', 'rollback'].includes(command)) {
    throw migrationError("SALES_WORKFLOW_COMMAND_INVALID", `Comando no válido: ${command}.`);
  }
  const cacheFile = path.resolve(argv[1] || DEFAULT_CACHE_FILE);
  const backupFile = path.resolve(argv[2] || DEFAULT_BACKUP_FILE);
  const sourceBuffer = fs.readFileSync(cacheFile);
  const source = JSON.parse(sourceBuffer.toString("utf8"));
  if (command === "rollback") {
    const result = rollbackSalesWorkflow(source);
    if (JSON.stringify(result.cache) !== JSON.stringify(source)) writeAtomic(cacheFile, result.cache);
    return { command, cacheFile, backupFile, report: result.report };
  }
  const result = migrateSalesWorkflow(source);
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
  const storedManifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  verifyBackup(backupBuffer, storedManifest);
  if (crypto.createHash("sha256").update(sourceBuffer).digest("hex") !== storedManifest.sha256) {
    const current = JSON.parse(sourceBuffer.toString("utf8"));
    if (!current.tables?.[TABLE_NAME]) {
      throw migrationError("SALES_WORKFLOW_SOURCE_DRIFT", "El cache cambió respecto del backup antes de aplicar la migración.");
    }
  }
  return storedManifest;
}

function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(runCli(), null, 2));
  } catch (error) {
    console.error(`${error.code || "SALES_WORKFLOW_MIGRATION_FAILED"}: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  MIGRATION_ID,
  TABLE_NAME,
  assertUniqueWorkflowRows,
  createBackupManifest,
  migrateSalesWorkflow,
  rollbackSalesWorkflow,
  runCli,
  verifyBackup
};
