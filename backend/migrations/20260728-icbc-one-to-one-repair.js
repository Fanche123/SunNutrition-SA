const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { toCents } = require("../../shared/money");

const REPAIR_ID = "ERP-TES-20260728-12";
const DEFAULT_CACHE = path.resolve(__dirname, "../../tmp/backend-data-cache.json");
const DEFAULT_BACKUP = path.resolve(
  __dirname,
  "../../tmp/repair-backups/ERP-TES-20260728-12/backend-data-cache.before.json"
);
const EXPECTED_SOURCE_SHA256 = "1670A202D5866105457AAEAEE615EBA194EAAF78F738B9B6E58F3F42DAFFA862";
const EXPECTED_APPLIED_SHA256 = "6CD4BF2D6A44258684F748285015D61FF0C4B7C5560AD540A1AA1F29A1C3ACE6";
const ASSIGNMENTS = Object.freeze([
  { movementId: 8, fromPaymentId: 5814, toPaymentId: 5815, concept: "IMP S/CRED CT", cents: 259085 },
  { movementId: 95, fromPaymentId: 5835, toPaymentId: 5837, concept: "R/RECAUDACION IB SIRCREB CONV.", cents: 10076646 },
  { movementId: 99, fromPaymentId: 5838, toPaymentId: 5840, concept: "R/RECAUDACION IB SIRCREB CONV.", cents: 217332 }
]);
const PRESERVED = Object.freeze([
  { movementId: 7, paymentId: 5814, concept: "R/RECAUDACION IB SIRCREB CONV.", cents: 259085 },
  { movementId: 93, paymentId: 5835, concept: "IMP S/CRED CT", cents: 10076646 },
  { movementId: 97, paymentId: 5838, concept: "IMP S/CRED CT", cents: 217332 }
]);

function repairIcBcOneToOne(cache) {
  const next = clone(cache);
  const tables = next.tables || {};
  if (isApplied(tables)) {
    assertPostconditions(tables);
    return { cache: next, report: report(true) };
  }
  assertPreconditions(tables);
  ASSIGNMENTS.forEach(({ movementId, toPaymentId }) => {
    exact(tables, "movimientos_bancarios", "id_movimiento_bancario", movementId).id_pago = String(toPaymentId);
  });
  assertPostconditions(tables);
  return { cache: next, report: report(false) };
}

function assertPreconditions(tables) {
  PRESERVED.forEach((item) => assertMovement(tables, item));
  ASSIGNMENTS.forEach(({ toPaymentId, ...item }) => {
    assertMovement(tables, { ...item, paymentId: item.fromPaymentId });
    assertPayment(tables, item.fromPaymentId, item.cents);
    assertPayment(tables, toPaymentId, item.cents);
    if (bankReferences(tables, toPaymentId).length !== 0) fail("TARGET_PAYMENT_NOT_ORPHAN", toPaymentId);
  });
  assertSharedExpense(tables, 5814, 5815, "14");
  assertSharedExpense(tables, 5835, 5837, "11");
  assertSharedExpense(tables, 5838, 5840, "11");
}

function assertPostconditions(tables) {
  PRESERVED.forEach((item) => assertMovement(tables, item));
  ASSIGNMENTS.forEach(({ movementId, toPaymentId, concept, cents }) => {
    assertMovement(tables, { movementId, paymentId: toPaymentId, concept, cents });
  });
  [...PRESERVED.map((item) => item.paymentId), ...ASSIGNMENTS.map((item) => item.toPaymentId)]
    .forEach((paymentId) => {
      if (bankReferences(tables, paymentId).length !== 1) fail("PAYMENT_LINK_MULTIPLICITY", paymentId);
    });
}

function assertSharedExpense(tables, leftPaymentId, rightPaymentId, expectedTagId) {
  const left = onlyPaymentDetail(tables, leftPaymentId);
  const right = onlyPaymentDetail(tables, rightPaymentId);
  if (String(left.id_egreso) !== String(right.id_egreso)) fail("EXPENSE_PATTERN_DRIFT", `${leftPaymentId}/${rightPaymentId}`);
  const expense = exact(tables, "egresos", "id_egreso", left.id_egreso);
  if (String(expense.id_etiqueta) !== expectedTagId) fail("EXPENSE_CONCEPT_DRIFT", expense.id_egreso);
}

function assertMovement(tables, { movementId, paymentId, concept, cents }) {
  const row = exact(tables, "movimientos_bancarios", "id_movimiento_bancario", movementId);
  if (row.banco !== "ICBC" || row.concepto !== concept || row.detalle !== concept
    || toCents(row.debito) !== cents || toCents(row.importe) !== -cents
    || String(row.id_pago) !== String(paymentId) || String(row.id_cobro || "")
    || String(row.id_movimiento_fondo || "")) fail("MOVEMENT_SIGNATURE_DRIFT", movementId);
}

function assertPayment(tables, paymentId, cents) {
  const payment = exact(tables, "pagos", "id_pago", paymentId);
  if (payment.banco !== "ICBC" || toCents(payment.monto) !== cents) fail("PAYMENT_SIGNATURE_DRIFT", paymentId);
  const detail = onlyPaymentDetail(tables, paymentId);
  if (toCents(detail.monto_cancelado) !== cents) fail("PAYMENT_DETAIL_DRIFT", paymentId);
}

function onlyPaymentDetail(tables, paymentId) {
  const details = find(tables, "detalle_pagos", "id_pago", paymentId);
  if (details.length !== 1) fail("PAYMENT_DETAIL_MULTIPLICITY", paymentId);
  return details[0];
}

function bankReferences(tables, paymentId) {
  return find(tables, "movimientos_bancarios", "id_pago", paymentId);
}

function isApplied(tables) {
  return ASSIGNMENTS.every(({ movementId, toPaymentId }) => (
    find(tables, "movimientos_bancarios", "id_movimiento_bancario", movementId)
      .some((row) => String(row.id_pago) === String(toPaymentId))
  ));
}

function report(idempotent) {
  return {
    repairId: REPAIR_ID,
    idempotent,
    changes: idempotent ? [] : ASSIGNMENTS.map(({ movementId, fromPaymentId, toPaymentId, concept }) => ({
      table: "movimientos_bancarios",
      action: "update",
      id: movementId,
      field: "id_pago",
      before: String(fromPaymentId),
      after: String(toPaymentId),
      reason: `asignacion uno-a-uno autorizada: ${concept}`
    }))
  };
}

function exact(tables, table, key, value) {
  const rows = find(tables, table, key, value);
  if (rows.length !== 1) fail("ROW_MULTIPLICITY", `${table}.${key}=${value}: ${rows.length}`);
  return rows[0];
}
function find(tables, table, key, value) {
  const rows = tables[table]?.rows;
  if (!Array.isArray(rows)) fail("TABLE_MISSING", table);
  return rows.filter((row) => String(row[key]) === String(value));
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
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").toUpperCase();
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

function restoreBackup(cacheFile, backupFile, expectedSourceHash = EXPECTED_SOURCE_SHA256, expectedAppliedHash = EXPECTED_APPLIED_SHA256) {
  if (!fs.existsSync(backupFile) || fileHash(backupFile) !== expectedSourceHash) fail("BACKUP_INVALID");
  const currentHash = fileHash(cacheFile);
  if (currentHash === expectedSourceHash) return { restored: false, idempotent: true, sha256: currentHash };
  if (currentHash !== expectedAppliedHash) fail("RESTORE_TARGET_DRIFT", currentHash);
  copyAtomic(backupFile, cacheFile);
  if (fileHash(cacheFile) !== expectedSourceHash) fail("RESTORE_VERIFY_FAILED");
  return { restored: true, sha256: fileHash(cacheFile) };
}

function runCli(argv = process.argv.slice(2)) {
  const command = argv[0] || "dry-run";
  const cacheFile = path.resolve(argv[1] || DEFAULT_CACHE);
  const backupFile = path.resolve(argv[2] || DEFAULT_BACKUP);
  if (command === "restore") {
    return restoreBackup(cacheFile, backupFile);
  }
  if (!["dry-run", "apply"].includes(command)) fail("COMMAND_INVALID", command);
  const sourceHash = fileHash(cacheFile);
  const current = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  if (sourceHash !== EXPECTED_SOURCE_SHA256 && !isApplied(current.tables || {})) {
    fail("SOURCE_HASH_DRIFT", sourceHash);
  }
  const result = repairIcBcOneToOne(current);
  if (command === "apply" && !result.report.idempotent) {
    if (!fs.existsSync(backupFile) || fileHash(backupFile) !== EXPECTED_SOURCE_SHA256) fail("BACKUP_INVALID");
    writeAtomic(cacheFile, result.cache);
  }
  return { ...result.report, sourceSha256: sourceHash, resultSha256: objectHash(result.cache) };
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
  ASSIGNMENTS,
  EXPECTED_APPLIED_SHA256,
  EXPECTED_SOURCE_SHA256,
  PRESERVED,
  REPAIR_ID,
  repairIcBcOneToOne,
  restoreBackup,
  runCli
};
