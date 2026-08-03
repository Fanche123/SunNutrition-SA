function createCoreHandlers(dependencies) {
  const { APP_STATE_FILE, backendComparisonPeriod, buildBackendCashflowReport, buildBackendIncomeStatementDetail, buildBackendIncomeStatementReport, buildProductionReport, readAppState, readJsonBody, runBackendSqlQuery, sendJson, writeAppState } = dependencies;

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

function handleIncomeStatementDetail(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const year = Number(url.searchParams.get("year"));
    const month = Number(url.searchParams.get("month"));
    const concept = String(url.searchParams.get("concept") || "");
    const offset = url.searchParams.get("offset");
    const limit = url.searchParams.get("limit");

    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 0 || month > 11) {
      sendJson(response, 400, { ok: false, error: "Periodo invalido." });
      return;
    }

    const detail = buildBackendIncomeStatementDetail(year, month, concept, { offset, limit });
    sendJson(response, 200, { ok: true, detail });
  } catch (error) {
    sendJson(response, error.status || 500, {
      ok: false,
      code: error.code || "INCOME_STATEMENT_DETAIL_ERROR",
      error: error.message
    });
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

function handleProductionReport(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const report = buildProductionReport(
      String(url.searchParams.get("start") || ""),
      String(url.searchParams.get("end") || ""),
      String(url.searchParams.get("itemId") || "")
    );
    sendJson(response, 200, { ok: true, report });
  } catch (error) {
    sendJson(response, error.status || 500, {
      ok: false,
      code: error.code || "PRODUCTION_REPORT_ERROR",
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

  const stateToWrite = { ...state };
  request.auditSummary = {
    action: "update",
    module: "application",
    entity: "app-state",
    fields: Object.keys(stateToWrite)
  };
  writeAppState(APP_STATE_FILE, stateToWrite);
  sendJson(response, 200, { ok: true });
}

  return { handleAppStateGet, handleAppStateSave, handleBackendSqlQuery, handleCashflowReport, handleIncomeStatementDetail, handleIncomeStatementReport, handleProductionReport };
}

module.exports = { createCoreHandlers };
