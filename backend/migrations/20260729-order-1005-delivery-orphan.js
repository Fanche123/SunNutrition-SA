const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPAIR_ID = "20260729-order-1005-delivery-orphan";
const EXPECTED_SOURCE_SHA256 = "1003E8F9A370CFBADBF0E6E76D3ACA9FFF8A102F8772F999579DBDCF2F3F3E05";
const ORDER_ID = "1005";
const DETAIL_ID = "1006";
const DEFAULT_CACHE = path.resolve(__dirname, "..", "..", "tmp", "backend-data-cache.json");
const DEFAULT_BACKUP = path.resolve(
  __dirname,
  "..",
  "..",
  "tmp",
  "backend-data-cache.ERP-DATA-20260729-36.before.json"
);

function repairOrder1005DeliveryOrphan(source) {
  const cache = clone(source);
  const tables = cache.tables || fail("TABLES_MISSING");
  const orders = tableRows(tables, "pedidos");
  const deliveries = tableRows(tables, "entregas");
  const details = tableRows(tables, "entregas_detalle");
  const sales = tableRows(tables, "ventas");
  const order = orders.filter((row) => text(row.id_pedido) === ORDER_ID);
  if (order.length !== 1 || text(order[0].id_cliente) !== "37") fail("ORDER_SIGNATURE_DRIFT");

  const matches = details.filter((row) => text(row.id_pedido) === ORDER_ID);
  if (!matches.length) return {
    cache,
    report: report(tables, null, true)
  };
  if (
    matches.length !== 1
    || text(matches[0].id_entregas_detalle) !== DETAIL_ID
    || text(matches[0].id_entrega)
  ) {
    fail("ORPHAN_SIGNATURE_DRIFT");
  }
  if (deliveries.some((row) => text(row.id_entrega) && text(row.id_entrega) === text(matches[0].id_entrega))) {
    fail("DELIVERY_PARENT_EXISTS");
  }
  const orderSales = sales.filter((row) => text(row.id_pedido) === ORDER_ID);
  if (orderSales.some((row) => text(row.id_entrega))) fail("SALE_HAS_VALID_DELIVERY");

  const beforeCount = details.length;
  tables.entregas_detalle.rows = details.filter((row) => row !== matches[0]);
  tables.entregas_detalle.rowCount = tables.entregas_detalle.rows.length;
  if (tables.entregas_detalle.rows.length !== beforeCount - 1) fail("REPAIR_COUNT_INVALID");
  if (tables.entregas_detalle.rows.some((row) => text(row.id_pedido) === ORDER_ID)) {
    fail("ORPHAN_REMAINS");
  }
  return {
    cache,
    report: report(tables, matches[0], false)
  };
}

function report(tables, removed, idempotent) {
  return {
    repairId: REPAIR_ID,
    orderId: ORDER_ID,
    removed: removed ? {
      table: "entregas_detalle",
      id_entregas_detalle: text(removed.id_entregas_detalle),
      id_entrega: text(removed.id_entrega),
      id_pedido: text(removed.id_pedido)
    } : null,
    counts: {
      pedidos: tableRows(tables, "pedidos").length,
      entregas: tableRows(tables, "entregas").length,
      entregas_detalle: tableRows(tables, "entregas_detalle").length,
      ventas: tableRows(tables, "ventas").length
    },
    idempotent
  };
}

function runCli(argv = process.argv.slice(2), expectedSourceHash = EXPECTED_SOURCE_SHA256) {
  const command = argv[0] || "dry-run";
  const cacheFile = path.resolve(argv[1] || DEFAULT_CACHE);
  const backupFile = path.resolve(argv[2] || DEFAULT_BACKUP);
  if (!["dry-run", "apply"].includes(command)) fail("COMMAND_INVALID", command);
  const sourceHash = fileHash(cacheFile);
  if (!fs.existsSync(backupFile) || fileHash(backupFile) !== expectedSourceHash) fail("BACKUP_INVALID");
  const backupSource = JSON.parse(fs.readFileSync(backupFile, "utf8"));
  const expectedApplied = repairOrder1005DeliveryOrphan(backupSource);
  const expectedAppliedHash = objectHash(expectedApplied.cache);
  if (sourceHash !== expectedSourceHash && sourceHash !== expectedAppliedHash) {
    fail("SOURCE_HASH_DRIFT", sourceHash);
  }
  const source = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  const result = repairOrder1005DeliveryOrphan(source);
  if (sourceHash === expectedAppliedHash && !result.report.idempotent) fail("APPLIED_SIGNATURE_DRIFT");
  const resultHash = objectHash(result.cache);
  if (command === "apply" && !result.report.idempotent) {
    writeAtomic(cacheFile, result.cache);
    if (fileHash(cacheFile) !== resultHash) fail("WRITE_VERIFY_FAILED");
  }
  return {
    command,
    sourceSha256: sourceHash,
    resultSha256: command === "apply" ? fileHash(cacheFile) : resultHash,
    backup: {
      path: backupFile,
      bytes: fs.statSync(backupFile).size,
      sha256: fileHash(backupFile)
    },
    report: result.report
  };
}

function tableRows(tables, tableName) {
  const result = tables?.[tableName]?.rows;
  if (!Array.isArray(result)) fail("TABLE_MISSING", tableName);
  return result;
}

function fileHash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();
}

function objectHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value, null, 2)).digest("hex").toUpperCase();
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function text(value) {
  return String(value ?? "").trim();
}

function fail(code, detail = "") {
  const error = new Error(`${code}${detail ? `: ${detail}` : ""}`);
  error.code = code;
  throw error;
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(runCli(), null, 2));
  } catch (error) {
    console.error(`${error.code || "REPAIR_FAILED"}: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  DETAIL_ID,
  EXPECTED_SOURCE_SHA256,
  ORDER_ID,
  REPAIR_ID,
  repairOrder1005DeliveryOrphan,
  runCli
};
