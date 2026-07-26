function createCoreHandlers(dependencies) {
  const { APP_STATE_FILE, backendComparisonPeriod, buildBackendCashflowReport, buildBackendIncomeStatementReport, readAppState, readJsonBody, runBackendSqlQuery, sendJson, writeAppState } = dependencies;

function handleIncomeStatementReport(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const year = Number(url.searchParams.get("year"));
    const month = Number(url.searchParams.get("month"));
    const comparisonMode = String(url.searchParams.get("comparison") || "none");

    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 0 || month > 11) {
      sendJson(response, 400, { ok: false, error: "Periodo invalido." });
      return;
    }

    const report = buildBackendIncomeStatementReport(year, month);
    const comparisonPeriod = backendComparisonPeriod(year, month, comparisonMode);
    const comparisonReport = comparisonPeriod
      ? buildBackendIncomeStatementReport(comparisonPeriod.year, comparisonPeriod.month)
      : null;

    sendJson(response, 200, { ok: true, report, comparisonReport });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error.message });
  }
}

function handleCashflowReport(request, response) {
  try {
    const report = buildBackendCashflowReport();
    sendJson(response, 200, { ok: true, report });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error.message });
  }
}

async function handleBackendSqlQuery(request, response) {
  const body = await readJsonBody(request);
  try {
    const result = await runBackendSqlQuery(body.sql || "");
    sendJson(response, 200, { ok: true, ...result });
  } catch (error) {
    const status = ["SQL_TIMEOUT", "SQL_BUDGET_EXCEEDED"].includes(error.code) ? 408 : 400;
    sendJson(response, status, {
      ok: false,
      code: error.code || "SQL_EXECUTION_ERROR",
      error: error.message
    });
  }
}

async function handleAppStateGet(response) {
  try {
    const state = readAppState(APP_STATE_FILE);
    sendJson(response, 200, { ok: true, state });
  } catch {
    sendJson(response, 500, { error: "No se pudo leer el estado guardado de la app." });
  }
}

async function handleAppStateSave(request, response) {
  const body = await readJsonBody(request);
  const state = body.state;

  if (!state || typeof state !== "object" || Array.isArray(state)) {
    sendJson(response, 400, { error: "Estado invalido para guardar." });
    return;
  }

  writeAppState(APP_STATE_FILE, state);
  sendJson(response, 200, { ok: true });
}

  return { handleAppStateGet, handleAppStateSave, handleBackendSqlQuery, handleCashflowReport, handleIncomeStatementReport };
}

module.exports = { createCoreHandlers };
