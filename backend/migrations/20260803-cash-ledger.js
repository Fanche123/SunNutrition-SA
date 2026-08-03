const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { EXPECTED_BACKEND_COLUMNS } = require("../config/backend-columns");

const MIGRATION_ID = "20260803-cash-ledger";
const TABLE_NAME = "caja_efectivo_movimientos";
const OPENING_CENTS = 14500000;
const DEFAULT_CACHE_FILE = path.resolve(__dirname, "..", "..", "tmp", "backend-data-cache.json");
const DEFAULT_BACKUP_FILE = path.resolve(__dirname, "..", "..", "tmp", `backend-data-cache.${MIGRATION_ID}.before.json`);

function migrateCashLedger(source, options = {}) {
  const cache = clone(source);
  cache.tables ||= {};
  const existed = Boolean(cache.tables[TABLE_NAME]);
  if (!existed) {
    cache.tables[TABLE_NAME] = { headers: [...EXPECTED_BACKEND_COLUMNS[TABLE_NAME]], rows: [], rowCount: 0 };
  }
  const table = requiredTable(cache, TABLE_NAME);
  table.headers = unique([...table.headers, ...EXPECTED_BACKEND_COLUMNS[TABLE_NAME]]);
  const openings = table.rows.filter((row) => row.tipo === "apertura");
  if (openings.length > 1) throw migrationError("CASH_LEDGER_OPENING_DUPLICATE", "Existe más de una apertura de Caja Efectivo.");
  let initialized = false;
  if (!openings.length) {
    if (table.rows.length) throw migrationError("CASH_LEDGER_OPENING_MISSING", "El libro contiene movimientos sin asiento de apertura.");
    const registeredAt = String(options.registeredAt || new Date().toISOString()).trim();
    const cutoffCollectionId = maximumId(cache.tables.cobros?.rows, "id_cobro");
    const cutoffPaymentId = maximumId(cache.tables.pagos?.rows, "id_pago");
    const key = `${MIGRATION_ID}:opening`;
    const payload = { amountCents: OPENING_CENTS, cutoffCollectionId, cutoffPaymentId, registeredAt };
    table.rows.push({
      _rowNumber: 2,
      id_movimiento_caja: 1,
      fecha_registro: registeredAt,
      fecha_operativa: registeredAt.slice(0, 10),
      tipo: "apertura",
      importe: OPENING_CENTS / 100,
      fuente_tipo: "inicializacion",
      fuente_id: MIGRATION_ID,
      id_cobro: "",
      id_pago: "",
      operacion_id: MIGRATION_ID,
      referencia: "Saldo inicial autorizado de Caja Efectivo",
      usuario_id: "system",
      usuario_nombre: "Migración controlada",
      corte_id_cobro: cutoffCollectionId,
      corte_id_pago: cutoffPaymentId,
      clave_idempotencia: key,
      hash_payload: sha256(stableStringify(payload))
    });
    initialized = true;
  } else {
    assertOpening(openings[0]);
  }
  assertUniqueKeys(table.rows);
  table.rowCount = table.rows.length;
  return {
    cache,
    report: {
      migrationId: MIGRATION_ID,
      action: "migrate-and-initialize",
      tableCreated: !existed,
      initialized,
      openingCents: OPENING_CENTS,
      cutoffCollectionId: table.rows[0].corte_id_cobro,
      cutoffPaymentId: table.rows[0].corte_id_pago,
      rowCount: table.rows.length
    }
  };
}

function rollbackCashLedger(source) {
  const cache = clone(source);
  const rows = cache.tables?.[TABLE_NAME]?.rows || [];
  if (rows.length > 1) throw migrationError("CASH_LEDGER_ROLLBACK_HAS_MOVEMENTS", "No se puede retirar la caja porque ya contiene movimientos posteriores a la apertura.");
  if (rows.length === 1) assertOpening(rows[0]);
  delete cache.tables?.[TABLE_NAME];
  return { cache, report: { migrationId: MIGRATION_ID, action: "rollback", rowsRemoved: rows.length } };
}

function assertOpening(row) {
  if (row.tipo !== "apertura" || Number(row.importe) !== OPENING_CENTS / 100 || row.clave_idempotencia !== `${MIGRATION_ID}:opening`) {
    throw migrationError("CASH_LEDGER_OPENING_CONFLICT", "La apertura existente no coincide con el contrato autorizado de ARS 145.000.");
  }
}

function assertUniqueKeys(rows) {
  const keys = new Set();
  for (const row of rows) {
    const key = String(row.clave_idempotencia || "").trim();
    if (!key) throw migrationError("CASH_LEDGER_KEY_REQUIRED", "Todo movimiento de caja requiere clave de idempotencia.");
    if (keys.has(key)) throw migrationError("CASH_LEDGER_KEY_DUPLICATE", `La clave ${key} está duplicada.`);
    keys.add(key);
  }
}

function createBackupManifest(serializedCache) {
  const source = Buffer.isBuffer(serializedCache) ? serializedCache : Buffer.from(String(serializedCache), "utf8");
  const cache = JSON.parse(source.toString("utf8"));
  return {
    migrationId: MIGRATION_ID,
    sha256: sha256(source),
    bytes: source.length,
    tableCounts: Object.fromEntries(Object.entries(cache.tables || {}).map(([name, table]) => [name, Array.isArray(table?.rows) ? table.rows.length : 0]))
  };
}

function verifyBackup(serializedCache, manifest) {
  const current = createBackupManifest(serializedCache);
  if (current.sha256 !== manifest.sha256 || current.bytes !== manifest.bytes || JSON.stringify(current.tableCounts) !== JSON.stringify(manifest.tableCounts)) {
    throw migrationError("CASH_LEDGER_BACKUP_MISMATCH", "El backup de Caja Efectivo no coincide con su manifiesto verificable.");
  }
  return true;
}

function runCli(argv = process.argv.slice(2)) {
  const command = argv[0] || "dry-run";
  if (!["dry-run", "apply", "rollback"].includes(command)) throw migrationError("CASH_LEDGER_COMMAND_INVALID", `Comando no válido: ${command}.`);
  const cacheFile = path.resolve(argv[1] || DEFAULT_CACHE_FILE);
  const backupFile = path.resolve(argv[2] || DEFAULT_BACKUP_FILE);
  const sourceBuffer = fs.readFileSync(cacheFile);
  const source = JSON.parse(sourceBuffer.toString("utf8"));
  const result = command === "rollback" ? rollbackCashLedger(source) : migrateCashLedger(source);
  if (command === "apply") {
    const manifest = ensureVerifiedBackup(sourceBuffer, backupFile);
    if (JSON.stringify(result.cache) !== JSON.stringify(source)) writeAtomic(cacheFile, result.cache);
    return { command, cacheFile, backupFile, backup: manifest, report: result.report };
  }
  if (command === "rollback" && JSON.stringify(result.cache) !== JSON.stringify(source)) writeAtomic(cacheFile, result.cache);
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
  if (sha256(sourceBuffer) !== stored.sha256 && !JSON.parse(sourceBuffer.toString("utf8")).tables?.[TABLE_NAME]) {
    throw migrationError("CASH_LEDGER_SOURCE_DRIFT", "El cache cambió respecto del backup antes de aplicar la migración.");
  }
  return stored;
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

function requiredTable(cache, name) {
  const table = cache.tables?.[name];
  if (!table || !Array.isArray(table.rows)) throw migrationError("CASH_LEDGER_TABLE_INVALID", `Falta la tabla ${name}.`);
  if (!Array.isArray(table.headers)) table.headers = [];
  return table;
}

function maximumId(rows, column) {
  return (rows || []).reduce((maximum, row) => Math.max(maximum, Number(row?.[column]) || 0), 0);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function unique(values) { return [...new Set(values.filter(Boolean))]; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function migrationError(code, message) { const error = new Error(message); error.code = code; return error; }

if (require.main === module) {
  try { console.log(JSON.stringify(runCli(), null, 2)); }
  catch (error) { console.error(`${error.code || "CASH_LEDGER_MIGRATION_FAILED"}: ${error.message}`); process.exitCode = 1; }
}

module.exports = {
  MIGRATION_ID,
  OPENING_CENTS,
  TABLE_NAME,
  assertUniqueKeys,
  createBackupManifest,
  migrateCashLedger,
  rollbackCashLedger,
  runCli,
  verifyBackup
};
