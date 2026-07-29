const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  IMPORTED_AT,
  MOVEMENT_IDS,
  resetLastBankBatch,
  restoreBackup,
  runCli
} = require("../backend/migrations/20260728-last-bank-batch-reset");

const table = (rows) => ({ rows, rowCount: rows.length });
const clone = (value) => JSON.parse(JSON.stringify(value));

function fixture() {
  const movements = MOVEMENT_IDS.map((id, index) => ({
    id_movimiento_bancario: id,
    banco: "ICBC",
    debito: index + 1,
    credito: 0,
    id_pago: "",
    id_cobro: "",
    _bankImportedAt: IMPORTED_AT[Math.min(index, 2)],
    _bankMovementKey: `${String(id).padStart(40, "0")}:1`
  }));
  const selected = movements.slice(0, 15);
  const operation = (stage, movement) => `${stage}:${movement._bankMovementKey.split(":")[0]}:${movement._bankMovementKey}`;
  const sources = selected.map((movement, index) => ({
    id_otros_gastos: 5605 + index,
    id_egreso: 7902 + index,
    _total: index + 1,
    _bankOperationKey: operation("createExpenses", movement)
  }));
  const expenses = selected.map((movement, index) => ({
    id_egreso: 7902 + index,
    total: index + 1,
    _bankOperationKey: operation("createEgresses", movement)
  }));
  const payments = selected.slice(0, 7).map((movement, index) => ({
    id_pago: 5902 + index,
    monto: index + 1,
    _bankOperationKey: operation("createPayments", movement)
  }));
  const details = payments.map((payment, index) => ({
    id_detalle_pago: 6665 + index,
    id_pago: payment.id_pago,
    id_egreso: 7902 + index,
    monto_cancelado: index + 1,
    _bankOperationKey: payment._bankOperationKey
  }));
  return {
    marker: { preserved: true },
    tables: {
      movimientos_bancarios: table([{ id_movimiento_bancario: 1, banco: "ICBC" }, ...movements]),
      otros_gastos: table([{ id_otros_gastos: 1 }, ...sources]),
      egresos: table([{ id_egreso: 1 }, ...expenses]),
      pagos: table([{ id_pago: 1 }, ...payments]),
      detalle_pagos: table([{ id_detalle_pago: 1 }, ...details]),
      gastos_economicos: table([]),
      gastos_egresos: table([])
    }
  };
}

test("dry-run revierte solo el lote exacto y el segundo resultado es estable", () => {
  const source = fixture();
  const before = clone(source);
  const first = resetLastBankBatch(source);
  assert.deepEqual(source, before);
  assert.equal(first.report.batch.count, 25);
  assert.deepEqual(
    Object.fromEntries(Object.entries(first.report.removed).map(([name, value]) => [name, value.count])),
    { otros_gastos: 15, egresos: 15, pagos: 7, detalle_pagos: 7 }
  );
  assert.deepEqual(first.cache.marker, source.marker);
  assert.equal(first.cache.tables.movimientos_bancarios.rows.length, 26);
  assert.equal(first.cache.tables.movimientos_bancarios.rows.slice(1).every((row) => !row.id_pago && !row.id_cobro), true);
  for (const tableName of ["otros_gastos", "egresos", "pagos", "detalle_pagos"]) {
    assert.deepEqual(first.cache.tables[tableName].rows, [source.tables[tableName].rows[0]]);
  }
  const second = resetLastBankBatch(first.cache);
  assert.equal(second.report.idempotent, true);
  assert.deepEqual(second.cache, first.cache);
});

test("aborta atomicamente si aparece un derivado economico", () => {
  const source = fixture();
  source.tables.gastos_economicos.rows.push({ id_gasto_economico: 1, origen_id: 5605 });
  const before = clone(source);
  assert.throws(() => resetLastBankBatch(source), /ECONOMIC_DERIVATIVE_REQUIRES_APPEND_ONLY_REVERSAL/);
  assert.deepEqual(source, before);
});

test("aborta si el timestamp incluye otro movimiento o cambia una asociacion", () => {
  const extra = fixture();
  extra.tables.movimientos_bancarios.rows.push({
    id_movimiento_bancario: 999,
    banco: "ICBC",
    debito: 1,
    credito: 0,
    _bankImportedAt: IMPORTED_AT[0],
    _bankMovementKey: "extra:1"
  });
  assert.throws(() => resetLastBankBatch(extra), /BATCH_SCOPE_DRIFT/);
  const associated = fixture();
  associated.tables.movimientos_bancarios.rows[1].id_pago = 10;
  assert.throws(() => resetLastBankBatch(associated), /MOVEMENT_ASSOCIATION_DRIFT/);
});

test("restore recupera los mismos bytes y rechaza deriva posterior", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "last-bank-reset-"));
  const cacheFile = path.join(directory, "cache.json");
  const backupFile = path.join(directory, "backup.json");
  const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();
  try {
    fs.writeFileSync(backupFile, JSON.stringify({ state: "before" }));
    fs.writeFileSync(cacheFile, JSON.stringify({ state: "applied" }));
    const sourceHash = hash(backupFile);
    const appliedHash = hash(cacheFile);
    assert.equal(restoreBackup(cacheFile, backupFile, sourceHash, appliedHash).restored, true);
    assert.equal(hash(cacheFile), sourceHash);
    fs.writeFileSync(cacheFile, JSON.stringify({ state: "later" }));
    const bytes = fs.readFileSync(cacheFile);
    assert.throws(() => restoreBackup(cacheFile, backupFile, sourceHash, appliedHash), /RESTORE_TARGET_DRIFT/);
    assert.deepEqual(fs.readFileSync(cacheFile), bytes);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI backup, apply y restore usa el hash publicado y recupera byte a byte", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "last-bank-reset-cli-"));
  const cacheFile = path.join(directory, "cache.json");
  const backupFile = path.join(directory, "backup.json");
  const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(fixture(), null, 2));
    const sourceBytes = fs.readFileSync(cacheFile);
    const sourceHash = hash(cacheFile);
    runCli(["backup", cacheFile, backupFile], sourceHash);
    const applied = runCli(["apply", cacheFile, backupFile], sourceHash);
    assert.equal(applied.resultSha256, hash(cacheFile));
    const restored = runCli(["restore", cacheFile, backupFile, applied.resultSha256], sourceHash);
    assert.equal(restored.restored, true);
    assert.deepEqual(fs.readFileSync(cacheFile), sourceBytes);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("la UI bloquea todas las acciones y conserva el mensaje despues del render canonico", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "assets", "js", "modules", "bank-reconciliation-core.js"),
    "utf8"
  );
  const lockIndex = source.indexOf("setBankReconciliationActionButtonsDisabled(true)");
  const requestIndex = source.indexOf("await fetch(`${API_BASE_URL}/api/bank-reconciliation/apply`");
  const finalRenderIndex = source.lastIndexOf("renderBankReconciliation();");
  const finalStatusIndex = source.lastIndexOf("setBankReconciliationStatus(finalStatus.message, finalStatus.type)");
  assert.ok(lockIndex >= 0 && lockIndex < requestIndex);
  assert.ok(finalRenderIndex >= 0 && finalRenderIndex < finalStatusIndex);
  assert.match(source, /if \(bankReconciliationApplyInFlight\)[\s\S]*Ya hay una accion de conciliacion en curso/);
  assert.match(source, /refreshBankReconciliationFromBackend\(\{ force: true \}\)/);
});
