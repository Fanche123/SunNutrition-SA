const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { fromCents, toCents } = require("../../shared/money");

const REPAIR_ID = "ERP-DAT-20260728-11";
const REPAIR_KEY = "ERP-DAT-20260728-11:reverse-economic-expense:467";
const DEFAULT_CACHE = path.resolve(__dirname, "../../tmp/backend-data-cache.json");
const DEFAULT_BACKUP = path.resolve(__dirname, "../../tmp/repair-backups/ERP-DAT-20260728-11/backend-data-cache.before.json");
const EXPECTED_SOURCE_SHA256 = "B68CC46E9352A2ED154D033E3BD0B5C35307EC4BFB27F1C16BFEB3A56A5BB5C3";

function repairIcBcDuplicates(cache, options = {}) {
  const next = clone(cache);
  const tables = next.tables || {};
  const report = { repairId: REPAIR_ID, changes: [], omittedAmbiguous: [7, 8, 97, 99, 93, 95] };
  if (hasRepairMarker(tables)) {
    assertPostconditions(tables);
    return { cache: next, report: { ...report, idempotent: true } };
  }

  assertPreconditions(tables);
  reverseEconomicDuplicate(tables, options.timestamp || new Date().toISOString(), report);
  removeDuplicateChain(tables, report);
  redirectPartnerContribution(tables, report);
  reassignProvenBankLinks(tables, report);
  Object.values(tables).forEach((table) => {
    if (Array.isArray(table?.rows)) table.rowCount = table.rows.length;
  });
  assertPostconditions(tables);
  return { cache: next, report: { ...report, idempotent: false } };
}

function assertPreconditions(tables) {
  [
    ["egresos", "id_egreso", 7262, 762300], ["egresos", "id_egreso", 7293, 762300],
    ["egresos", "id_egreso", 7279, 63525], ["egresos", "id_egreso", 7303, 63525],
    ["egresos", "id_egreso", 7885, -500000000], ["egresos", "id_egreso", 7886, -500000000]
  ].forEach(([table, key, value, cents]) => {
    const row = exact(tables, table, key, value);
    if (toCents(row.total) !== cents) fail("PRECONDITION_AMOUNT", `${table}.${key}=${value}`);
  });
  assertLink(tables, "detalle_pagos", "id_detalle_pago", 6549, "id_pago", 5786, "id_egreso", 7293, 762300);
  assertLink(tables, "detalle_pagos", "id_detalle_pago", 6559, "id_pago", 5796, "id_egreso", 7303, 63525);
  assertLink(tables, "detalle_pagos", "id_detalle_pago", 6650, "id_pago", 5881, "id_egreso", 7885, -500000000);
  assertLink(tables, "otros_gastos", "id_otros_gastos", 5509, "id_egreso", 7293);
  assertLink(tables, "otros_gastos", "id_otros_gastos", 5519, "id_egreso", 7303);
  const expense = exact(tables, "gastos_economicos", "id_gasto_economico", 467);
  if (expense.estado !== "confirmado" || expense.tipo_movimiento !== "original" || toCents(expense.importe) !== 762300
    || String(expense.origen_id) !== "5509") fail("PRECONDITION_ECONOMIC", "gasto 467");
  const application = exact(tables, "gastos_egresos", "id_gasto_egreso", 275);
  if (application.estado !== "vigente" || application.tipo_aplicacion !== "original"
    || String(application.id_gasto_economico) !== "467" || String(application.id_egreso) !== "7293"
    || toCents(application.importe_aplicado) !== 762300) fail("PRECONDITION_APPLICATION", "aplicacion 275");
  assertLink(tables, "aportes_socios", "id_aporte_socio", 6, "id_egreso", 7886);
  [
    [21, 5784, "2026-07-02", 4042479, "IMP S/CRED CT"],
    [23, 5784, "2026-07-02", 4042479, "R/RECAUDACION IB SIRCREB CONV."],
    [17, 5785, "2026-07-03", 1023750, "R/RECAUDACION IB SIRCREB CONV."],
    [18, 5785, "2026-07-03", 1023750, "IMP S/CRED CT"],
    [7, 5814, "2026-07-07", 259085, "R/RECAUDACION IB SIRCREB CONV."],
    [8, 5814, "2026-07-07", 259085, "IMP S/CRED CT"],
    [97, 5838, "2026-07-17", 217332, "IMP S/CRED CT"],
    [99, 5838, "2026-07-17", 217332, "R/RECAUDACION IB SIRCREB CONV."],
    [93, 5835, "2026-07-20", 10076646, "IMP S/CRED CT"],
    [95, 5835, "2026-07-20", 10076646, "R/RECAUDACION IB SIRCREB CONV."]
  ].forEach(([movement, payment, date, cents, concept]) => assertBankSignature(tables, movement, payment, date, cents, concept));
  [
    [5784, "2026-07-02", 4042479, 7291], [5794, "2026-07-02", 4042479, 7301],
    [5785, "2026-07-03", 1023750, 7292], [5795, "2026-07-03", 1023750, 7302],
    [5786, "2026-06-18", 762300, 7293], [5796, "2026-06-18", 63525, 7303]
  ].forEach(([payment, date, cents, expense]) => assertPaymentSignature(tables, payment, date, cents, expense));
  assertUntouchedSentinels(tables);
}

function reverseEconomicDuplicate(tables, timestamp, report) {
  const expenseTable = required(tables, "gastos_economicos");
  const applicationTable = required(tables, "gastos_egresos");
  const original = exact(tables, "gastos_economicos", "id_gasto_economico", 467);
  const application = exact(tables, "gastos_egresos", "id_gasto_egreso", 275);
  const expenseId = nextId(expenseTable.rows, "id_gasto_economico");
  const applicationId = nextId(applicationTable.rows, "id_gasto_egreso");
  application.id_egreso = "7262";
  const expensePayload = {
    fecha_economica: original.fecha_economica, id_etiqueta: original.id_etiqueta,
    concepto: "Reversion duplicado Caja ICBC 7293", tipo_economico: original.tipo_economico,
    tipo_movimiento: "reversion", importe: fromCents(-toCents(original.importe)), estado: "confirmado",
    origen_tipo: original.origen_tipo, origen_id: original.origen_id,
    origen_subclave: `${original.origen_subclave}:reversion_erp_dat_20260728_11`,
    id_gasto_precedente: String(original.id_gasto_economico),
    motivo: "Reversion append-only de duplicado confirmado Caja ICBC",
    clave_idempotencia: REPAIR_KEY
  };
  expenseTable.rows.push({
    _rowNumber: expenseTable.rows.length + 2, id_gasto_economico: expenseId, ...expensePayload,
    hash_payload: hashObject(expensePayload), creado_en: timestamp, actualizado_en: timestamp, confirmado_en: timestamp
  });
  application.estado = "revertida";
  const appPayload = {
    id_gasto_economico: String(original.id_gasto_economico), id_egreso: "7262",
    importe_aplicado: fromCents(toCents(application.importe_aplicado)),
    componente_egreso: application.componente_egreso, componente_otro: application.componente_otro,
    tipo_aplicacion: "reversion", estado: "revertida",
    id_aplicacion_precedente: String(application.id_gasto_egreso),
    motivo: "Aplicacion revertida por duplicado Caja ICBC", clave_idempotencia: `${REPAIR_KEY}:application:275`
  };
  applicationTable.rows.push({
    _rowNumber: applicationTable.rows.length + 2, id_gasto_egreso: applicationId, ...appPayload,
    hash_payload: hashObject(appPayload), creado_en: timestamp
  });
  report.changes.push({ table: "gastos_economicos", action: "insert", id: expenseId, amount: -7623 });
  report.changes.push({ table: "gastos_egresos", action: "update", id: 275, estado: "revertida", id_egreso: 7262 });
  report.changes.push({ table: "gastos_egresos", action: "insert", id: applicationId, precedent: 275 });
}

function removeDuplicateChain(tables, report) {
  ensurePaymentHasOnlyDetail(tables, 5786, 6549);
  ensurePaymentHasOnlyDetail(tables, 5796, 6559);
  ensureExpenseReferences(tables, 7293, { details: [6549], sources: [5509], applications: [] });
  ensureExpenseReferences(tables, 7303, { details: [6559], sources: [5519], applications: [] });
  [["detalle_pagos", "id_detalle_pago", 6549], ["pagos", "id_pago", 5786],
    ["egresos", "id_egreso", 7293], ["otros_gastos", "id_otros_gastos", 5509],
    ["detalle_pagos", "id_detalle_pago", 6559], ["pagos", "id_pago", 5796],
    ["egresos", "id_egreso", 7303], ["otros_gastos", "id_otros_gastos", 5519]]
    .forEach(([table, key, id]) => removeExact(tables, table, key, id, report));
}

function redirectPartnerContribution(tables, report) {
  const detail = exact(tables, "detalle_pagos", "id_detalle_pago", 6650);
  detail.id_egreso = 7886;
  report.changes.push({ table: "detalle_pagos", action: "update", id: 6650, id_egreso: 7886 });
  ensureNoReferences(tables, 7885);
  removeExact(tables, "egresos", "id_egreso", 7885, report);
}

function reassignProvenBankLinks(tables, report) {
  [[23, 5794], [18, 5795]].forEach(([movementId, paymentId]) => {
    const movement = exact(tables, "movimientos_bancarios", "id_movimiento_bancario", movementId);
    movement.id_pago = String(paymentId);
    report.changes.push({ table: "movimientos_bancarios", action: "update", id: movementId, id_pago: paymentId });
  });
}

function assertPostconditions(tables) {
  [7293, 7303, 7885].forEach((id) => {
    if (find(tables, "egresos", "id_egreso", id).length) fail("POSTCONDITION_DELETE", `egreso ${id}`);
  });
  [5786, 5796].forEach((id) => {
    if (find(tables, "pagos", "id_pago", id).length) fail("POSTCONDITION_DELETE", `pago ${id}`);
  });
  if (String(exact(tables, "detalle_pagos", "id_detalle_pago", 6650).id_egreso) !== "7886") fail("POSTCONDITION_CONTRIBUTION");
  const originalApplication = exact(tables, "gastos_egresos", "id_gasto_egreso", 275);
  if (originalApplication.estado !== "revertida" || String(originalApplication.id_egreso) !== "7262") fail("POSTCONDITION_APPLICATION");
  const reversalApplication = exact(tables, "gastos_egresos", "clave_idempotencia", `${REPAIR_KEY}:application:275`);
  if (reversalApplication.estado !== "revertida" || reversalApplication.tipo_aplicacion !== "reversion"
    || String(reversalApplication.id_egreso) !== "7262" || String(reversalApplication.id_aplicacion_precedente) !== "275") {
    fail("POSTCONDITION_APPLICATION_REVERSAL");
  }
  [[21, 5784], [23, 5794], [17, 5785], [18, 5795], [7, 5814], [8, 5814],
    [97, 5838], [99, 5838], [93, 5835], [95, 5835]].forEach(([movement, payment]) => {
    assertLink(tables, "movimientos_bancarios", "id_movimiento_bancario", movement, "id_pago", payment);
  });
  assertUntouchedSentinels(tables);
}

function assertUntouchedSentinels(tables) {
  exact(tables, "egresos", "id_egreso", 7270);
  exact(tables, "egresos", "id_egreso", 7888);
  [340,342,404,407,411,420,450,453,475,476,492,493,524,525,599,600,632,634,802,806,927,934,955,958,990,996,1162,1163]
    .forEach((id) => exact(tables, "egresos", "id_egreso", id));
}

function hasRepairMarker(tables) {
  return find(tables, "gastos_economicos", "clave_idempotencia", REPAIR_KEY).length > 0;
}

function ensureNoReferences(tables, expenseId) {
  const refs = [
    ...find(tables, "otros_gastos", "id_egreso", expenseId),
    ...find(tables, "aportes_socios", "id_egreso", expenseId),
    ...find(tables, "detalle_pagos", "id_egreso", expenseId),
    ...find(tables, "gastos_egresos", "id_egreso", expenseId).filter((row) => row.estado === "vigente")
  ];
  if (refs.length) fail("REFERENCES_REMAIN", `egreso ${expenseId}`);
}

function ensurePaymentHasOnlyDetail(tables, paymentId, detailId) {
  const details = find(tables, "detalle_pagos", "id_pago", paymentId);
  if (details.length !== 1 || String(details[0].id_detalle_pago) !== String(detailId)) fail("PAYMENT_REFERENCES_DRIFT", paymentId);
  const bank = find(tables, "movimientos_bancarios", "id_pago", paymentId);
  if (bank.length) fail("PAYMENT_BANK_REFERENCE", paymentId);
}

function ensureExpenseReferences(tables, expenseId, expected) {
  const actual = {
    details: find(tables, "detalle_pagos", "id_egreso", expenseId).map((r) => Number(r.id_detalle_pago)).sort(),
    sources: find(tables, "otros_gastos", "id_egreso", expenseId).map((r) => Number(r.id_otros_gastos)).sort(),
    applications: find(tables, "gastos_egresos", "id_egreso", expenseId).map((r) => Number(r.id_gasto_egreso)).sort()
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("EXPENSE_REFERENCES_DRIFT", expenseId);
}

function assertBankSignature(tables, movementId, paymentId, date, cents, concept) {
  const row = exact(tables, "movimientos_bancarios", "id_movimiento_bancario", movementId);
  if (row.banco !== "ICBC" || row.fecha !== date || toCents(row.debito) !== cents || toCents(row.credito) !== 0
    || toCents(row.importe) !== -cents || row.concepto !== concept || row.detalle !== concept
    || String(row.id_pago) !== String(paymentId) || String(row.id_cobro || "") || String(row.id_movimiento_fondo || "")) {
    fail("BANK_SIGNATURE_DRIFT", movementId);
  }
}

function assertPaymentSignature(tables, paymentId, date, cents, expenseId) {
  const payment = exact(tables, "pagos", "id_pago", paymentId);
  if (payment.fecha_pago !== date || payment.banco !== "ICBC" || payment.metodo !== "Transferencia"
    || toCents(payment.monto) !== cents) fail("PAYMENT_SIGNATURE_DRIFT", paymentId);
  const details = find(tables, "detalle_pagos", "id_pago", paymentId);
  if (details.length !== 1 || String(details[0].id_egreso) !== String(expenseId)
    || toCents(details[0].monto_cancelado) !== cents) fail("PAYMENT_DETAIL_SIGNATURE_DRIFT", paymentId);
}

function assertLink(tables, table, key, value, linkA, expectedA, linkB, expectedB, cents) {
  const row = exact(tables, table, key, value);
  if (String(row[linkA]) !== String(expectedA) || (linkB && String(row[linkB]) !== String(expectedB))) {
    fail("PRECONDITION_LINK", `${table}.${key}=${value}`);
  }
  if (cents !== undefined && toCents(row.monto_cancelado) !== cents) fail("PRECONDITION_AMOUNT", `${table}.${key}=${value}`);
}

function removeExact(tables, tableName, key, value, report) {
  const table = required(tables, tableName);
  exact(tables, tableName, key, value);
  table.rows = table.rows.filter((row) => String(row[key]) !== String(value));
  report.changes.push({ table: tableName, action: "delete", id: value });
}

function exact(tables, table, key, value) {
  const rows = find(tables, table, key, value);
  if (rows.length !== 1) fail("PRECONDITION_MULTIPLICITY", `${table}.${key}=${value}: ${rows.length}`);
  return rows[0];
}
function find(tables, table, key, value) {
  return required(tables, table).rows.filter((row) => String(row[key]) === String(value));
}
function required(tables, name) {
  if (!tables[name] || !Array.isArray(tables[name].rows)) fail("TABLE_MISSING", name);
  return tables[name];
}
function nextId(rows, key) {
  return rows.reduce((max, row) => Math.max(max, Number(row[key]) || 0), 0) + 1;
}
function hashObject(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
function writeAtomic(file, cache) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(cache, null, 2));
  fs.renameSync(temporary, file);
}

function runCli(argv = process.argv.slice(2)) {
  const command = argv[0] || "dry-run";
  const cacheFile = path.resolve(argv[1] || DEFAULT_CACHE);
  const backupFile = path.resolve(argv[2] || DEFAULT_BACKUP);
  if (command === "restore") {
    if (!fs.existsSync(backupFile)) fail("BACKUP_MISSING", backupFile);
    if (fileHash(backupFile) !== EXPECTED_SOURCE_SHA256) fail("BACKUP_INVALID");
    writeAtomic(cacheFile, JSON.parse(fs.readFileSync(backupFile, "utf8")));
    if (fileHash(cacheFile) !== EXPECTED_SOURCE_SHA256) fail("RESTORE_VERIFY_FAILED");
    return { restored: true, sha256: fileHash(cacheFile) };
  }
  const currentHash = fileHash(cacheFile);
  const currentCache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  if (currentHash !== EXPECTED_SOURCE_SHA256 && !hasRepairMarker(currentCache.tables || {})) {
    fail("SOURCE_HASH_DRIFT", currentHash);
  }
  const result = repairIcBcDuplicates(currentCache, {
    timestamp: "2026-07-28T18:00:00.000Z"
  });
  if (command === "apply" && !result.report.idempotent) {
    if (!fs.existsSync(backupFile) || fileHash(backupFile) !== EXPECTED_SOURCE_SHA256) fail("BACKUP_INVALID");
    writeAtomic(cacheFile, result.cache);
  } else if (command !== "dry-run" && command !== "apply") {
    fail("COMMAND_INVALID", command);
  }
  return { ...result.report, sourceSha256: currentHash, resultSha256: hashObject(result.cache) };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(runCli(), null, 2));
  } catch (error) {
    console.error(`${error.code || "ERROR"}: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { EXPECTED_SOURCE_SHA256, REPAIR_ID, REPAIR_KEY, repairIcBcDuplicates, runCli };
