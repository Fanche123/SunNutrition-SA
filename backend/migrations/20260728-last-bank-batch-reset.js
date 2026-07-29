const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPAIR_ID = "20260728-last-bank-batch-reset";
const EXPECTED_SOURCE_SHA256 = "6E4557CD0EF23B4C888E286B7747230824280B02C7252B8AAA1BBCC835CF0891";
const BANK = "ICBC";
const MOVEMENT_IDS = Object.freeze(Array.from({ length: 25 }, (_, index) => 163 + index));
const IMPORTED_AT = Object.freeze([
  "2026-07-28T18:19:09.783Z",
  "2026-07-28T18:19:09.784Z",
  "2026-07-28T18:19:09.785Z"
]);
const DEFAULT_CACHE = path.resolve(__dirname, "..", "..", "tmp", "backend-data-cache.json");
const DEFAULT_BACKUP = path.resolve(__dirname, "..", "..", "tmp", `backend-data-cache.${REPAIR_ID}.backup.json`);

function resetLastBankBatch(source) {
  const cache = clone(source);
  const tables = cache.tables || fail("TABLES_MISSING");
  const movements = exactBatch(tables);
  const movementKeys = new Set(movements.map((row) => text(row._bankMovementKey)));
  const operationKeys = new Set();
  for (const movementKey of movementKeys) {
    for (const stage of ["createExpenses", "createEgresses", "createPayments", "reconcile"]) {
      operationKeys.add(`${stage}:${movementKey.split(":")[0]}:${movementKey}`);
    }
  }
  const derived = {
    otros_gastos: rowsByOperation(tables, "otros_gastos", operationKeys),
    egresos: rowsByOperation(tables, "egresos", operationKeys),
    pagos: rowsByOperation(tables, "pagos", operationKeys),
    detalle_pagos: rowsByOperation(tables, "detalle_pagos", operationKeys)
  };
  assertLineage(tables, movements, derived, operationKeys);
  const alreadyReset = Object.values(derived).every((rows) => rows.length === 0)
    && movements.every(isPendingMovement);
  if (alreadyReset) return { cache, report: buildReport(movements, derived, true) };

  const expenseIds = new Set(derived.egresos.map((row) => text(row.id_egreso)));
  for (const source of derived.otros_gastos) {
    if (text(source.id_egreso) && !expenseIds.has(text(source.id_egreso))) {
      fail("SOURCE_LINK_OUTSIDE_BATCH", source.id_otros_gastos);
    }
  }
  removeRows(tables, "detalle_pagos", new Set(derived.detalle_pagos));
  removeRows(tables, "pagos", new Set(derived.pagos));
  removeRows(tables, "egresos", new Set(derived.egresos));
  removeRows(tables, "otros_gastos", new Set(derived.otros_gastos));
  for (const movement of movements) {
    movement.id_pago = "";
    movement.id_cobro = "";
    delete movement._bankOperationKey;
    delete movement._bankOperationPayload;
  }
  assertReset(cache.tables, movementKeys, operationKeys);
  return { cache, report: buildReport(movements, derived, false) };
}

function exactBatch(tables) {
  const ids = new Set(MOVEMENT_IDS.map(String));
  const rows = tableRows(tables, "movimientos_bancarios")
    .filter((row) => ids.has(text(row.id_movimiento_bancario)));
  if (rows.length !== MOVEMENT_IDS.length) fail("BATCH_MULTIPLICITY", rows.length);
  if (new Set(rows.map((row) => text(row.id_movimiento_bancario))).size !== MOVEMENT_IDS.length) {
    fail("BATCH_DUPLICATE_ID");
  }
  for (const row of rows) {
    if (text(row.banco) !== BANK || !IMPORTED_AT.includes(text(row._bankImportedAt))
      || !text(row._bankMovementKey) || Number(row.debito || 0) < 0 || Number(row.credito || 0) !== 0) {
      fail("BATCH_SIGNATURE_DRIFT", row.id_movimiento_bancario);
    }
  }
  const sameImport = tableRows(tables, "movimientos_bancarios").filter((row) => (
    text(row.banco) === BANK && IMPORTED_AT.includes(text(row._bankImportedAt))
  ));
  if (sameImport.length !== MOVEMENT_IDS.length) fail("BATCH_SCOPE_DRIFT", sameImport.length);
  return rows;
}

function assertLineage(tables, movements, derived, operationKeys) {
  const expected = { otros_gastos: 15, egresos: 15, pagos: 7, detalle_pagos: 7 };
  if (Object.values(derived).some((rows) => rows.length)) {
    for (const [table, count] of Object.entries(expected)) {
      if (derived[table].length !== count) fail("DERIVED_COUNT_DRIFT", `${table}:${derived[table].length}`);
    }
  }
  const paymentIds = new Set(derived.pagos.map((row) => text(row.id_pago)));
  const expenseIds = new Set(derived.egresos.map((row) => text(row.id_egreso)));
  for (const detail of derived.detalle_pagos) {
    if (!paymentIds.has(text(detail.id_pago)) || !expenseIds.has(text(detail.id_egreso))) {
      fail("PAYMENT_LINEAGE_DRIFT", detail.id_detalle_pago);
    }
  }
  const sourceIds = new Set(derived.otros_gastos.map((row) => text(row.id_otros_gastos)));
  for (const expense of derived.egresos) {
    if (derived.otros_gastos.filter((row) => text(row.id_egreso) === text(expense.id_egreso)).length !== 1) {
      fail("EXPENSE_SOURCE_DRIFT", expense.id_egreso);
    }
  }
  assertNoEconomicRows(tables, sourceIds, expenseIds, operationKeys);
  for (const movement of movements) {
    if (text(movement.id_pago) || text(movement.id_cobro) || text(movement.id_movimiento_fondo)) {
      fail("MOVEMENT_ASSOCIATION_DRIFT", movement.id_movimiento_bancario);
    }
  }
}

function assertNoEconomicRows(tables, sourceIds, expenseIds, operationKeys) {
  for (const table of ["gastos_economicos", "gastos_egresos"]) {
    for (const row of tableRows(tables, table)) {
      const values = Object.values(row).map(text);
      if (operationKeys.has(text(row._bankOperationKey))
        || values.some((value) => sourceIds.has(value) || expenseIds.has(value))) {
        fail("ECONOMIC_DERIVATIVE_REQUIRES_APPEND_ONLY_REVERSAL", table);
      }
    }
  }
}

function assertReset(tables, movementKeys, operationKeys) {
  const movements = exactBatch(tables);
  if (!movements.every(isPendingMovement)) fail("RESET_PENDING_FAILED");
  for (const table of ["otros_gastos", "egresos", "pagos", "detalle_pagos"]) {
    if (rowsByOperation(tables, table, operationKeys).length) fail("RESET_DERIVED_REMAINS", table);
  }
  const persistedKeys = new Set(movements.map((row) => text(row._bankMovementKey)));
  if (persistedKeys.size !== movementKeys.size || [...movementKeys].some((key) => !persistedKeys.has(key))) {
    fail("RESET_MOVEMENTS_CHANGED");
  }
}

function buildReport(movements, derived, idempotent) {
  const summarize = (rows, amountField) => ({
    count: rows.length,
    ids: rows.map(primaryId),
    amount: money(rows.reduce((sum, row) => sum + Number(row[amountField] || 0), 0))
  });
  return {
    repairId: REPAIR_ID,
    bank: BANK,
    batch: {
      movementIds: movements.map((row) => Number(row.id_movimiento_bancario)),
      movementKeys: movements.map((row) => row._bankMovementKey),
      importedAt: IMPORTED_AT,
      count: movements.length,
      debitAmount: money(movements.reduce((sum, row) => sum + Number(row.debito || 0), 0)),
      creditAmount: money(movements.reduce((sum, row) => sum + Number(row.credito || 0), 0))
    },
    removed: {
      otros_gastos: summarize(derived.otros_gastos, "_total"),
      egresos: summarize(derived.egresos, "total"),
      pagos: summarize(derived.pagos, "monto"),
      detalle_pagos: summarize(derived.detalle_pagos, "monto_cancelado")
    },
    economicRows: 0,
    idempotent
  };
}

function rowsByOperation(tables, table, keys) {
  return tableRows(tables, table).filter((row) => keys.has(text(row._bankOperationKey)));
}
function removeRows(tables, table, selected) {
  const descriptor = tables[table] || fail("TABLE_MISSING", table);
  descriptor.rows = tableRows(tables, table).filter((row) => !selected.has(row));
  descriptor.rowCount = descriptor.rows.length;
}
function tableRows(tables, table) {
  const rows = tables[table]?.rows;
  if (!Array.isArray(rows)) fail("TABLE_MISSING", table);
  return rows;
}
function isPendingMovement(row) {
  return !text(row.id_pago) && !text(row.id_cobro) && !text(row.id_movimiento_fondo)
    && !text(row._bankOperationKey);
}
function primaryId(row) {
  const key = Object.keys(row).find((name) => /^id_/.test(name));
  return row[key];
}
function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}
function text(value) {
  return String(value ?? "").trim();
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function fail(code, detail = "") {
  const error = new Error(`${code}${detail ? `: ${detail}` : ""}`);
  error.code = code;
  throw error;
}
function fileHash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();
}
function objectHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value, null, 2)).digest("hex").toUpperCase();
}
function writeAtomic(file, cache) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(cache, null, 2));
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function copyAtomic(source, destination) {
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    fs.copyFileSync(source, temporary);
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function restoreBackup(cacheFile, backupFile, expectedSourceHash = EXPECTED_SOURCE_SHA256, expectedAppliedHash = "") {
  if (!fs.existsSync(backupFile) || fileHash(backupFile) !== expectedSourceHash) fail("BACKUP_INVALID");
  const currentHash = fileHash(cacheFile);
  if (currentHash === expectedSourceHash) return { restored: false, idempotent: true, sha256: currentHash };
  if (!expectedAppliedHash || currentHash !== expectedAppliedHash) fail("RESTORE_TARGET_DRIFT", currentHash);
  copyAtomic(backupFile, cacheFile);
  if (fileHash(cacheFile) !== expectedSourceHash) fail("RESTORE_VERIFY_FAILED");
  return { restored: true, sha256: fileHash(cacheFile) };
}

function runCli(argv = process.argv.slice(2), expectedSourceHash = EXPECTED_SOURCE_SHA256) {
  const command = argv[0] || "dry-run";
  const cacheFile = path.resolve(argv[1] || DEFAULT_CACHE);
  const backupFile = path.resolve(argv[2] || DEFAULT_BACKUP);
  if (command === "restore") return restoreBackup(cacheFile, backupFile, expectedSourceHash, argv[3]);
  if (!["backup", "dry-run", "apply"].includes(command)) fail("COMMAND_INVALID", command);
  const sourceHash = fileHash(cacheFile);
  if (command === "backup") {
    if (sourceHash !== expectedSourceHash) fail("SOURCE_HASH_DRIFT", sourceHash);
    copyAtomic(cacheFile, backupFile);
    if (fileHash(backupFile) !== expectedSourceHash) fail("BACKUP_VERIFY_FAILED");
    JSON.parse(fs.readFileSync(backupFile, "utf8"));
    return { repairId: REPAIR_ID, backupFile, bytes: fs.statSync(backupFile).size, sha256: fileHash(backupFile) };
  }
  const current = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  const result = resetLastBankBatch(current);
  if (sourceHash !== expectedSourceHash && !result.report.idempotent) {
    fail("SOURCE_HASH_DRIFT", sourceHash);
  }
  if (command === "apply" && !result.report.idempotent) {
    if (!fs.existsSync(backupFile) || fileHash(backupFile) !== expectedSourceHash) fail("BACKUP_INVALID");
    writeAtomic(cacheFile, result.cache);
  }
  return { ...result.report, sourceSha256: sourceHash, resultSha256: objectHash(result.cache), backupFile };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(runCli(), null, 2));
  } catch (error) {
    console.error(`${error.code || "ERROR"}: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  EXPECTED_SOURCE_SHA256,
  IMPORTED_AT,
  MOVEMENT_IDS,
  REPAIR_ID,
  resetLastBankBatch,
  restoreBackup,
  runCli
};
