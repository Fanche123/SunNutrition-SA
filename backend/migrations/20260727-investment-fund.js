const crypto = require("crypto");
const { EXPECTED_BACKEND_COLUMNS } = require("../config/backend-columns");
const { applyInvestmentFundMovement } = require("../services/investment-fund.service");
const { backendId } = require("../utils/ids");
const { backendNextNumericId } = require("../utils/runtime");
const { toCents } = require("../../shared/money");

const MIGRATION_ID = "20260727-investment-fund";
const BANK_LINK_COLUMN = "id_movimiento_fondo";
const FUND_TABLE = "fondos_inversion_movimientos";
const INITIAL_DATA = Object.freeze({
  deposit: Object.freeze({ fecha: "2026-07-01", importe: 12000000 }),
  rescues: Object.freeze([
    Object.freeze({ fecha: "2026-07-08", importe: 5000000.19 }),
    Object.freeze({ fecha: "2026-07-14", importe: 1999999.79 }),
    Object.freeze({ fecha: "2026-07-15", importe: 5048625.53 })
  ]),
  yield: Object.freeze({ periodo: "2026-07", importe: 48625.51 })
});

function migrateInvestmentFund(cache) {
  const migrated = clone(cache);
  migrated.tables ||= {};
  const bankTable = requiredTable(migrated, "movimientos_bancarios");
  const beforeBankHeaders = [...bankTable.headers];
  bankTable.headers = unique([...bankTable.headers, BANK_LINK_COLUMN]);
  bankTable.rowCount = bankTable.rows.length;
  if (!migrated.tables[FUND_TABLE]) {
    migrated.tables[FUND_TABLE] = {
      headers: [...EXPECTED_BACKEND_COLUMNS[FUND_TABLE]],
      rows: [],
      rowCount: 0
    };
  }
  const fundTable = requiredTable(migrated, FUND_TABLE);
  fundTable.headers = [...EXPECTED_BACKEND_COLUMNS[FUND_TABLE]];
  fundTable.rowCount = fundTable.rows.length;
  return {
    cache: migrated,
    report: {
      migrationId: MIGRATION_ID,
      action: "migrate",
      bankColumnAdded: !beforeBankHeaders.includes(BANK_LINK_COLUMN),
      fundTableCreated: !cache.tables?.[FUND_TABLE],
      rowsModified: 0
    }
  };
}

function initializeInvestmentFundData(cache, options = {}) {
  const migrated = migrateInvestmentFund(cache).cache;
  const fundRows = migrated.tables[FUND_TABLE].rows;
  const existingInitial = fundRows.filter((row) => String(row.clave_idempotencia || "").startsWith(`${MIGRATION_ID}:initial:`));
  if (existingInitial.length) {
    if (existingInitial.length !== 5) throw migrationError("INVESTMENT_FUND_INITIAL_PARTIAL", "La inicializacion del fondo esta incompleta y requiere revision.");
    return { cache: migrated, report: { migrationId: MIGRATION_ID, action: "initialize", idempotent: true, inserted: 0 } };
  }

  const tag = uniqueTag(migrated, "Rendimiento Fondo");
  const bankIds = INITIAL_DATA.rescues.map((expected) => uniqueBankRescue(migrated, expected).id_movimiento_bancario);
  const yieldDate = validYieldDate(options.yieldDate, INITIAL_DATA.yield.periodo);
  const common = { backendId, backendNextNumericId, expectedBackendColumns: EXPECTED_BACKEND_COLUMNS };
  applyInvestmentFundMovement(migrated, {
    fecha: INITIAL_DATA.deposit.fecha,
    tipo: "deposito",
    importe: INITIAL_DATA.deposit.importe,
    referencia: "Deposito inicial autorizado",
    observacion: "Inicializacion ERP-20260727-FONDO-INVERSION-01",
    clave_idempotencia: `${MIGRATION_ID}:initial:deposit`
  }, common);
  INITIAL_DATA.rescues.slice(0, 2).forEach((rescue, index) => applyInvestmentFundMovement(migrated, {
    fecha: rescue.fecha,
    tipo: "rescate",
    importe: rescue.importe,
    id_movimiento_bancario: bankIds[index],
    referencia: "CRED RESC FCI",
    observacion: "Rescate ICBC autorizado",
    clave_idempotencia: `${MIGRATION_ID}:initial:rescue:${rescue.fecha}`
  }, common));
  applyInvestmentFundMovement(migrated, {
    fecha: yieldDate,
    tipo: "rendimiento",
    importe: INITIAL_DATA.yield.importe,
    periodo_rendimiento: INITIAL_DATA.yield.periodo,
    id_etiqueta: tag.id_etiqueta,
    referencia: "Rendimiento realizado julio 2026",
    observacion: "Interes a favor con impacto de gasto negativo.",
    clave_idempotencia: `${MIGRATION_ID}:initial:yield`
  }, common);
  const finalRescue = INITIAL_DATA.rescues[2];
  applyInvestmentFundMovement(migrated, {
    fecha: finalRescue.fecha,
    tipo: "rescate",
    importe: finalRescue.importe,
    id_movimiento_bancario: bankIds[2],
    referencia: "CRED RESC FCI",
    observacion: "Rescate ICBC autorizado",
    clave_idempotencia: `${MIGRATION_ID}:initial:rescue:${finalRescue.fecha}`
  }, common);
  return {
    cache: migrated,
    report: { migrationId: MIGRATION_ID, action: "initialize", idempotent: false, inserted: 5 }
  };
}

function rollbackInvestmentFund(cache) {
  const rolledBack = clone(cache);
  const bankTable = requiredTable(rolledBack, "movimientos_bancarios");
  const fundTable = rolledBack.tables?.[FUND_TABLE];
  if ((fundTable?.rows || []).length) {
    throw migrationError("INVESTMENT_FUND_ROLLBACK_HAS_DATA", "No se puede retirar el esquema porque el fondo ya contiene movimientos.");
  }
  if (bankTable.rows.some((row) => String(row[BANK_LINK_COLUMN] ?? "").trim())) {
    throw migrationError("INVESTMENT_FUND_ROLLBACK_HAS_LINKS", "No se puede retirar la relacion porque existen movimientos bancarios vinculados.");
  }
  bankTable.headers = bankTable.headers.filter((column) => column !== BANK_LINK_COLUMN);
  delete rolledBack.tables[FUND_TABLE];
  return {
    cache: rolledBack,
    report: { migrationId: MIGRATION_ID, action: "rollback", rowsModified: 0 }
  };
}

function uniqueBankRescue(cache, expected) {
  const matches = (cache.tables.movimientos_bancarios.rows || []).filter((row) => (
    normalize(row.banco) === "icbc"
    && String(row.fecha || "").trim() === expected.fecha
    && normalize(`${row.detalle || ""} ${row.concepto || ""}`).includes("cred resc fci")
    && Math.abs(toCents(row.credito || 0)) === toCents(expected.importe)
  ));
  if (matches.length !== 1) {
    throw migrationError(
      "INVESTMENT_FUND_BANK_MATCH_NOT_UNIQUE",
      `Se esperaba un unico rescate ICBC del ${expected.fecha} por ${expected.importe.toFixed(2)} y se encontraron ${matches.length}.`
    );
  }
  const row = matches[0];
  if (backendId(row.id_pago) || backendId(row.id_cobro) || backendId(row.id_movimiento_fondo)) {
    throw migrationError("INVESTMENT_FUND_BANK_MATCH_ALREADY_LINKED", `El rescate ICBC del ${expected.fecha} ya tiene otra asociacion.`);
  }
  return row;
}

function uniqueTag(cache, label) {
  const matches = (cache.tables?.etiquetas?.rows || []).filter((row) => normalize(row.etiqueta) === normalize(label));
  if (matches.length !== 1) {
    throw migrationError("INVESTMENT_FUND_TAG_NOT_UNIQUE", `La etiqueta ${label} no existe de forma inequivoca.`);
  }
  return matches[0];
}

function validYieldDate(value, period) {
  const candidate = String(value || "").trim();
  const match = candidate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match || !candidate.startsWith(`${period}-`)) {
    throw migrationError(
      "INVESTMENT_FUND_YIELD_DATE_REQUIRED",
      `La inicializacion requiere una fecha contable explicita del periodo ${period} para el rendimiento.`
    );
  }
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() !== Number(match[2]) - 1
    || date.getUTCDate() !== Number(match[3])
  ) {
    throw migrationError("INVESTMENT_FUND_YIELD_DATE_REQUIRED", "La fecha contable del rendimiento no es valida.");
  }
  return candidate;
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
    throw migrationError("INVESTMENT_FUND_BACKUP_MISMATCH", "El backup no coincide con su manifiesto verificable.");
  }
  if (JSON.stringify(current.tableCounts) !== JSON.stringify(manifest.tableCounts)) {
    throw migrationError("INVESTMENT_FUND_BACKUP_COUNTS_MISMATCH", "Los conteos del backup no coinciden con el manifiesto.");
  }
  return true;
}

function requiredTable(cache, name) {
  const table = cache.tables?.[name];
  if (!table || !Array.isArray(table.rows)) throw migrationError("INVESTMENT_FUND_TABLE_MISSING", `Falta la tabla ${name}.`);
  if (!Array.isArray(table.headers)) table.headers = [];
  return table;
}

function normalize(value) {
  return String(value ?? "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
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
  BANK_LINK_COLUMN,
  FUND_TABLE,
  INITIAL_DATA,
  MIGRATION_ID,
  createBackupManifest,
  initializeInvestmentFundData,
  migrateInvestmentFund,
  rollbackInvestmentFund,
  verifyBackup
};
