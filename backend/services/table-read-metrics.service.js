function createTableReadMetrics({ config, logger = console }) {
  return function recordAllRowsRead(tableName, table, startedAt) {
    const durationMs = Math.max(Date.now() - startedAt, 0);
    const rowCount = Array.isArray(table?.rows) ? table.rows.length : 0;
    const approximateBytes = Buffer.byteLength(JSON.stringify(table?.rows || []), "utf8");
    const warning = rowCount >= config.warningRows
      || approximateBytes >= config.warningBytes
      || durationMs >= config.warningDurationMs;
    const metric = {
      event: "backend_all_rows_read",
      table: String(tableName || ""),
      rowCount,
      durationMs,
      approximateBytes,
      warning
    };
    const method = warning ? "warn" : "info";
    if (typeof logger[method] === "function") logger[method](JSON.stringify(metric));
    return metric;
  };
}

module.exports = { createTableReadMetrics };
