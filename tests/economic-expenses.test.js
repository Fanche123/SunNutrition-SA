const assert = require("assert");
const { EXPECTED_BACKEND_COLUMNS } = require("../backend/config/backend-columns");
const { ADMIN_TABLE_POLICY } = require("../backend/config/admin-table-policy");
const { createEconomicExpensesService } = require("../backend/services/economic-expenses.service");
const { createEconomicExpenseApplicationsService } = require("../backend/services/economic-expense-applications.service");
const { createEconomicExpenseComparisonService } = require("../backend/services/economic-expense-comparison.service");
const { ensureBackendTable, backendNextNumericId } = require("../backend/utils/runtime");

function createHarness() {
  let cache = {
    tables: {
      etiquetas: table(["id_etiqueta"], [{ id_etiqueta: "1" }]),
      egresos: table(EXPECTED_BACKEND_COLUMNS.egresos, [{ id_egreso: "10", subtotal: 100, total: 121 }]),
      gastos_economicos: table(EXPECTED_BACKEND_COLUMNS.gastos_economicos, []),
      gastos_egresos: table(EXPECTED_BACKEND_COLUMNS.gastos_egresos, [])
    }
  };
  let saves = 0;
  const dependencies = {
    backendId: (value) => String(value ?? "").trim(),
    backendNextNumericId,
    backendNumber: (value) => Number(value || 0),
    ensureBackendTable,
    expectedBackendColumns: EXPECTED_BACKEND_COLUMNS,
    loadCache: () => cache,
    readJsonBody: async (request) => request.body || {},
    saveBackendCache: (next) => {
      cache = next;
      saves += 1;
    },
    sendJson: (response, status, payload) => Object.assign(response, { status, payload })
  };
  return { dependencies, get cache() { return cache; }, get saves() { return saves; } };
}

function table(headers, rows) {
  return { headers, rows, rowCount: rows.length };
}

async function call(handler, url, body = {}) {
  const response = {};
  await handler({ url, headers: { host: "127.0.0.1" }, body }, response);
  return response;
}

function draftPayload(overrides = {}) {
  return {
    periodo_economico: "2026-03",
    id_etiqueta: "1",
    concepto: "Servicio mensual",
    tipo_economico: "operativo",
    tipo_movimiento: "original",
    importe: 100,
    origen_tipo: "fixture",
    origen_id: "20",
    origen_subclave: "principal",
    clave_idempotencia: "draft-1",
    ...overrides
  };
}

async function main() {
  const harness = createHarness();
  const expenses = createEconomicExpensesService(harness.dependencies);
  const applications = createEconomicExpenseApplicationsService(harness.dependencies);

  let response = await call(expenses.handleDraftCreate, "/api/economic-expenses/drafts", draftPayload());
  assert.equal(response.status, 201);
  assert.equal(harness.saves, 1);
  const expenseId = response.payload.expense.id_gasto_economico;
  assert.deepStrictEqual(
    [ADMIN_TABLE_POLICY.gastos_economicos, ADMIN_TABLE_POLICY.gastos_egresos].map((policy) =>
      [policy.read, policy.insert, policy.update, policy.delete]
    ),
    [[true, true, true, true], [true, true, true, true]]
  );

  response = await call(expenses.handleDraftCreate, "/api/economic-expenses/drafts", draftPayload({
    clave_idempotencia: "discard-1",
    origen_subclave: "descartable"
  }));
  const discardId = response.payload.expense.id_gasto_economico;
  response = await call(expenses.handleDiscard, `/api/economic-expenses/${discardId}/discard`, {
    clave_idempotencia: "discard-operation-1",
    motivo: "Carga cancelada"
  });
  assert.equal(response.status, 200);
  assert.equal(response.payload.expense.estado, "descartado");

  response = await call(expenses.handleDraftUpdate, `/api/economic-expenses/${expenseId}/draft`, {
    concepto: "Servicio mensual corregido",
    clave_idempotencia: "draft-edit-1"
  });
  assert.equal(response.status, 200);
  assert.equal(response.payload.expense.concepto, "Servicio mensual corregido");

  response = await call(expenses.handleConfirm, `/api/economic-expenses/${expenseId}/confirm`, {
    clave_idempotencia: "confirm-1"
  });
  assert.equal(response.status, 200);
  assert.equal(response.payload.expense.estado, "confirmado");

  response = await call(expenses.handleDraftUpdate, `/api/economic-expenses/${expenseId}/draft`, { concepto: "No permitido" });
  assert.equal(response.status, 409);

  response = await call(expenses.handleDraftCreate, "/api/economic-expenses/drafts", draftPayload({
    clave_idempotencia: "draft-2",
    origen_subclave: "periodo-2026-04",
    periodo_economico: "2026-04"
  }));
  assert.equal(response.status, 201);
  const secondId = response.payload.expense.id_gasto_economico;
  response = await call(expenses.handleConfirm, `/api/economic-expenses/${secondId}/confirm`, { clave_idempotencia: "confirm-2" });
  assert.equal(response.status, 200);

  response = await call(expenses.handleDraftCreate, "/api/economic-expenses/drafts", draftPayload({
    clave_idempotencia: "draft-duplicate"
  }));
  assert.equal(response.status, 201);
  response = await call(expenses.handleConfirm, `/api/economic-expenses/${response.payload.expense.id_gasto_economico}/confirm`, {
    clave_idempotencia: "confirm-duplicate"
  });
  assert.equal(response.status, 409);

  response = await call(expenses.handleDraftCreate, "/api/economic-expenses/drafts", draftPayload({
    clave_idempotencia: "missing-period",
    periodo_economico: "",
    origen_subclave: "sin-periodo"
  }));
  assert.equal(response.status, 201);
  response = await call(expenses.handleConfirm, `/api/economic-expenses/${response.payload.expense.id_gasto_economico}/confirm`, {
    clave_idempotencia: "missing-period-confirm"
  });
  assert.equal(response.status, 400);

  response = await call(expenses.handleDraftCreate, "/api/economic-expenses/drafts", draftPayload({
    clave_idempotencia: "missing-label",
    id_etiqueta: "",
    origen_subclave: "sin-etiqueta"
  }));
  response = await call(expenses.handleConfirm, `/api/economic-expenses/${response.payload.expense.id_gasto_economico}/confirm`, {
    clave_idempotencia: "missing-label-confirm"
  });
  assert.equal(response.status, 400);

  response = await call(expenses.handleDraftCreate, "/api/economic-expenses/drafts", draftPayload({
    clave_idempotencia: "missing-subkey",
    origen_subclave: ""
  }));
  response = await call(expenses.handleConfirm, `/api/economic-expenses/${response.payload.expense.id_gasto_economico}/confirm`, {
    clave_idempotencia: "missing-subkey-confirm"
  });
  assert.equal(response.status, 400);

  response = await call(expenses.handleAdjustment, `/api/economic-expenses/${expenseId}/adjustments`, draftPayload({
    importe: 10,
    motivo: "Ajuste positivo",
    origen_subclave: "ajuste-1",
    clave_idempotencia: "adjust-1"
  }));
  assert.equal(response.status, 201);
  response = await call(expenses.handleAdjustment, `/api/economic-expenses/${expenseId}/adjustments`, draftPayload({
    importe: -5,
    motivo: "Ajuste negativo",
    origen_subclave: "ajuste-2",
    clave_idempotencia: "adjust-2"
  }));
  assert.equal(response.status, 201);

  response = await call(expenses.handleReversal, `/api/economic-expenses/${expenseId}/reversals`, draftPayload({
    importe: -100,
    motivo: "Reversion total",
    origen_subclave: "reversion-1",
    clave_idempotencia: "reverse-expense-1"
  }));
  assert.equal(response.status, 201);

  const applicationPayload = {
    id_gasto_economico: expenseId,
    id_egreso: "10",
    importe_aplicado: 40,
    componente_egreso: "base_subtotal",
    clave_idempotencia: "application-1"
  };
  response = await call(applications.handleCreate, "/api/economic-expenses/applications", applicationPayload);
  assert.equal(response.status, 201);
  const applicationId = response.payload.application.id_gasto_egreso;
  response = await call(applications.handleCreate, "/api/economic-expenses/applications", applicationPayload);
  assert.equal(response.status, 200);
  assert.equal(response.payload.idempotent, true);
  response = await call(applications.handleCreate, "/api/economic-expenses/applications", {
    ...applicationPayload,
    importe_aplicado: 41
  });
  assert.equal(response.status, 409);

  response = await call(applications.handleCreate, "/api/economic-expenses/applications", {
    ...applicationPayload,
    importe_aplicado: 70,
    clave_idempotencia: "overapply-1"
  });
  assert.equal(response.status, 409);

  response = await call(applications.handleReplace, `/api/economic-expenses/applications/${applicationId}/replace`, {
    importe_aplicado: 50,
    motivo: "Correccion",
    clave_idempotencia: "replace-1"
  });
  assert.equal(response.status, 201);
  const replacementId = response.payload.application.id_gasto_egreso;
  response = await call(applications.handleReverse, `/api/economic-expenses/applications/${replacementId}/reverse`, {
    motivo: "Aplicacion anulada",
    clave_idempotencia: "reverse-application-1"
  });
  assert.equal(response.status, 201);

  response = await call(applications.handleReconciliation, "/api/economic-expenses/reconciliation/expenses/10");
  assert.equal(response.status, 200);
  assert.equal(response.payload.reconciliation.importe_aplicado, 0);

  const comparison = createEconomicExpenseComparisonService({
    ...harness.dependencies,
    buildLegacyReport: () => ({
      totalCostOfSales: 10,
      totalOperatingExpenses: 20,
      totalNonOperatingExpenses: 5
    })
  });
  response = await call(comparison.handleComparison, "/api/reports/income-statement/economic-comparison?year=2026&month=2");
  assert.equal(response.status, 200);
  assert.equal(response.payload.diagnostic, true);
  assert.equal(response.payload.economic.totalConfirmed, 5);

  const emptyHarness = createHarness();
  const emptyComparison = createEconomicExpenseComparisonService({
    ...emptyHarness.dependencies,
    buildLegacyReport: () => ({ totalCostOfSales: 0, totalOperatingExpenses: 0, totalNonOperatingExpenses: 0 })
  });
  response = await call(emptyComparison.handleComparison, "/api/reports/income-statement/economic-comparison?year=2025&month=0");
  assert.equal(response.status, 200);
  assert.equal(response.payload.economic.totalConfirmed, 0);

  console.log("economic-expenses.test.js: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
