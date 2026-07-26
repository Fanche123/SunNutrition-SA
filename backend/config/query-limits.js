function createQueryLimits(env = process.env) {
  return Object.freeze({
    sql: Object.freeze({
      maxRows: integer(env.ERP_SQL_MAX_ROWS, 5000, 1, 5000),
      maxOutputBytes: integer(env.ERP_SQL_MAX_OUTPUT_BYTES, 20 * 1024 * 1024, 1024, 50 * 1024 * 1024),
      processTimeoutMs: integer(env.ERP_SQL_TIMEOUT_MS, 5000, 250, 60000),
      sqliteTimeBudgetMs: integer(env.ERP_SQL_SQLITE_BUDGET_MS, 4000, 100, 60000),
      sqliteCallbackBudget: integer(env.ERP_SQL_CALLBACK_BUDGET, 20000, 1, 1000000),
      sqliteProgressOperations: integer(env.ERP_SQL_PROGRESS_OPERATIONS, 10000, 100, 1000000)
    }),
    allRows: Object.freeze({
      warningRows: integer(env.ERP_ALL_WARNING_ROWS, 2500, 1, 10000000),
      warningBytes: integer(env.ERP_ALL_WARNING_BYTES, 2 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
      warningDurationMs: integer(env.ERP_ALL_WARNING_DURATION_MS, 250, 1, 60000),
      hardLimitEnabled: false
    })
  });
}

function integer(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(Math.max(number, minimum), maximum);
}

module.exports = { createQueryLimits };
