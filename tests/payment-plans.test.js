const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createBankMatchingService } = require("../backend/services/bank-matching.service");
const { createPaymentPlansService } = require("../backend/services/payment-plans.service");
const money = require("../shared/money");
const {
  backendNextNumericId,
  ensureBackendTable,
  isIsoDate,
  normalizePartnerName
} = require("../backend/utils/runtime");

function fixture() {
  return {
    generatedAt: "",
    tables: {
      planes_pagos: table(["id_plan_pago", "nombre", "organismo"], [
        { id_plan_pago: 1, nombre: "Plan existente", organismo: "ARCA" }
      ]),
      cuotas_planes_pagos: table([], [
        quota(1, 1, 1, { id_egreso: 10 }),
        quota(2, 1, 2)
      ]),
      egresos: table([], [
        { id_egreso: 10, total: 120, fecha_prevista_pago: "2026-08-10", acreedor: "ARCA", nro_factura: "A-10" },
        { id_egreso: 11, total: 150, fecha_prevista_pago: "2026-09-10", acreedor: "ARCA", nro_factura: "A-11" },
        { id_egreso: 12, total: 175, fecha_prevista_pago: "2026-10-10", acreedor: "Municipalidad", nro_factura: "M-12" }
      ]),
      detalle_pagos: table([], [{ id_detalle_pago: 1, id_pago: 50, id_egreso: 10, monto_cancelado: 120 }]),
      pagos: table([], [{ id_pago: 50, total: 120 }]),
      movimientos_bancarios: table([], [])
    }
  };
}

function table(headers, rows) {
  return { headers, rows, rowCount: rows.length };
}

function quota(id, planId, number, overrides = {}) {
  return {
    id_cuota_plan_pago: id,
    id_plan_pago: planId,
    nro_cuota: number,
    capital: 100,
    interes_financiero: 20,
    interes_resarcitorio: 5,
    total_primer_vencimiento: 120,
    fecha_primer_vencimiento: "2026-08-10",
    total_segundo_vencimiento: 125,
    fecha_segundo_vencimiento: "2026-08-20",
    id_egreso: "",
    ...overrides
  };
}

function createHarness(initial = fixture(), options = {}) {
  let cache = JSON.parse(JSON.stringify(initial));
  let saves = 0;
  const service = createPaymentPlansService({
    backendId: (value) => String(value ?? "").trim(),
    backendIsoDate: (value) => isIsoDate(String(value || "")) ? String(value) : "",
    backendNextNumericId,
    backendNumber: (value) => Number(value) || 0,
    ensureBackendTable,
    isIsoDate,
    loadCache: () => cache,
    normalizePartnerName,
    readJsonBody: async (request) => request.body,
    saveBackendCache: (next) => {
      if (options.failSave) throw new Error("fallo simulado");
      cache = next;
      saves += 1;
    },
    sendJson: (response, status, payload) => {
      response.status = status;
      response.payload = payload;
      return response;
    },
    failureInjector: options.failureInjector
  });
  return { service, getCache: () => cache, getSaves: () => saves };
}

async function invoke(handler, url, body = {}) {
  const response = {};
  await handler({ url, headers: { host: "localhost" }, body }, response);
  return response;
}

function validQuota(overrides = {}) {
  const value = quota("", "", 1, overrides);
  delete value.id_cuota_plan_pago;
  delete value.id_plan_pago;
  return value;
}

async function testReadAndCreate() {
  const harness = createHarness();
  let response = await invoke(harness.service.handlePaymentPlansList, "/api/treasury/payment-plans");
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.payload.plans.length, 1);

  response = await invoke(harness.service.handlePaymentPlanGet, "/api/treasury/payment-plans/1");
  assert.strictEqual(response.payload.plan.cuotas.length, 2);
  assert.strictEqual(response.payload.plan.cuotas[0].estado, "Pagada");
  assert.strictEqual(response.payload.plan.cuotas[1].estado === "Pagada", false);
  assert.strictEqual(response.payload.plan.totales.pagadas, 1);
  assert.strictEqual(response.payload.plan.totales.saldo_pendiente, 120);

  response = await invoke(harness.service.handlePaymentPlanCreate, "/api/treasury/payment-plans", {
    operationId: "create-empty",
    plan: { nombre: "Sin cuotas", organismo: "ARCA" },
    quotas: []
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.payload.plan.cuotas.length, 0);
  assert.strictEqual(harness.getSaves(), 1);

  const multi = {
    operationId: "create-multi",
    plan: { nombre: "Varias", organismo: "Municipalidad" },
    quotas: [validQuota(), validQuota({ nro_cuota: 2, fecha_primer_vencimiento: "2026-09-10", fecha_segundo_vencimiento: "2026-09-20" })]
  };
  response = await invoke(harness.service.handlePaymentPlanCreate, "/api/treasury/payment-plans", multi);
  assert.strictEqual(response.payload.plan.cuotas.length, 2);
  const retry = await invoke(harness.service.handlePaymentPlanCreate, "/api/treasury/payment-plans", multi);
  assert.strictEqual(retry.payload.idempotent, true);
  assert.strictEqual(harness.getCache().tables.planes_pagos.rows.filter((row) => row.nombre === "Varias").length, 1);
  const conflict = await invoke(harness.service.handlePaymentPlanCreate, "/api/treasury/payment-plans", {
    ...multi,
    plan: { ...multi.plan, nombre: "Distinto" }
  });
  assert.strictEqual(conflict.status, 409);
}

async function testPendingBalanceFromAppliedPayments() {
  const initial = fixture();
  initial.tables.cuotas_planes_pagos.rows.push(quota(3, 1, 3, { id_egreso: 11 }));
  initial.tables.cuotas_planes_pagos.rowCount = 3;
  initial.tables.egresos.rows.push({ id_egreso: 11, total: 120, fecha_prevista_pago: "2026-08-10" });
  initial.tables.egresos.rowCount = 2;
  initial.tables.detalle_pagos.rows.push({ id_detalle_pago: 2, id_egreso: 11, monto_cancelado: 45.25 });
  initial.tables.detalle_pagos.rowCount = 2;
  const harness = createHarness(initial);
  const response = await invoke(harness.service.handlePaymentPlanGet, "/api/treasury/payment-plans/1");
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.payload.plan.totales.pagadas, 1);
  assert.strictEqual(response.payload.plan.totales.saldo_pendiente, 194.75);
  assert.strictEqual(response.payload.plan.cuotas[2].monto_pagado, 45.25);
  assert.notStrictEqual(response.payload.plan.cuotas[2].estado, "Pagada");
}

async function testCanonicalCentValidation() {
  const harness = createHarness();
  assert.strictEqual(money.sumCents("737.285,75", "283.695,60"), 102098135);
  assert.strictEqual(money.format(money.sum("737.285,75", "283.695,60")), "$ 1.020.981,35");
  assert.strictEqual(money.sumCents("0,10", "0,20"), 30);
  const quotas = [
    validQuota({
      nro_cuota: 1,
      capital: "737.285,75",
      interes_financiero: "283.695,60",
      interes_resarcitorio: 0,
      total_primer_vencimiento: "1.020.981,35",
      total_segundo_vencimiento: "1.020.981,35"
    }),
    validQuota({
      nro_cuota: 2,
      capital: "0,10",
      interes_financiero: "0,20",
      interes_resarcitorio: 0,
      total_primer_vencimiento: "0,30",
      total_segundo_vencimiento: "0,30"
    }),
    validQuota({
      nro_cuota: 3,
      capital: 0.105,
      interes_financiero: 0.105,
      interes_resarcitorio: 0,
      total_primer_vencimiento: 0.22,
      total_segundo_vencimiento: 0.22
    })
  ];
  let response = await invoke(harness.service.handlePaymentPlanCreate, "/api/treasury/payment-plans", {
    operationId: "cent-validation-valid",
    plan: { nombre: "Centavos", organismo: "Fixture" },
    quotas
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.payload.plan.cuotas[0].total_primer_vencimiento, 1020981.35);
  assert.strictEqual(response.payload.plan.cuotas[1].total_primer_vencimiento, 0.30);
  assert.strictEqual(response.payload.plan.cuotas[2].capital, 0.11);
  assert.strictEqual(response.payload.plan.cuotas[2].total_primer_vencimiento, 0.22);

  const before = JSON.stringify(harness.getCache());
  response = await invoke(harness.service.handlePaymentPlanCreate, "/api/treasury/payment-plans", {
    operationId: "cent-validation-invalid",
    plan: { nombre: "Diferencia", organismo: "Fixture" },
    quotas: [validQuota({
      capital: "0,10",
      interes_financiero: "0,20",
      total_primer_vencimiento: "0,31",
      total_segundo_vencimiento: "0,31"
    })]
  });
  assert.strictEqual(response.status, 400);
  assert.match(response.payload.error, /\$ 0,01 \(1 centavo\)/);
  assert.strictEqual(JSON.stringify(harness.getCache()), before);
}

async function testAtomicFullEdit() {
  const harness = createHarness();
  const body = {
    operationId: "edit-full",
    plan: { id_plan_pago: 1, nombre: "Plan editado", organismo: "ARCA" },
    quotas: [
      { ...validQuota({ nro_cuota: 1, capital: 110, interes_financiero: 20, total_primer_vencimiento: 130, total_segundo_vencimiento: 135, id_egreso: 10 }), id_cuota_plan_pago: 1 },
      { ...validQuota({ nro_cuota: 2, interes_financiero: 30, total_primer_vencimiento: 130, total_segundo_vencimiento: 135 }), id_cuota_plan_pago: 2 },
      validQuota({ nro_cuota: 3, fecha_primer_vencimiento: "2026-10-10", fecha_segundo_vencimiento: "2026-10-20" })
    ]
  };
  let response = await invoke(harness.service.handlePaymentPlanUpdate, "/api/treasury/payment-plans/1", body);
  assert.strictEqual(response.status, 200);
  assert.strictEqual(harness.getSaves(), 1);
  assert.strictEqual(response.payload.plan.nombre, "Plan editado");
  assert.strictEqual(response.payload.plan.cuotas.length, 3);
  assert.strictEqual(response.payload.plan.cuotas[0].id_egreso, "10");
  assert.strictEqual(response.payload.plan.cuotas[0].capital, 110);
  assert.strictEqual(response.payload.plan.cuotas[1].interes_financiero, 30);
  const matchingTables = JSON.parse(JSON.stringify(harness.getCache().tables));
  matchingTables.detalle_pagos.rows = [];
  const matching = createBankMatchingService({
    backendExpenseCounterpartyInfo: () => ({ name: "ARCA", cuit: "", detail: "" }),
    backendId: (value) => String(value ?? "").trim(),
    backendIsoDate: (value) => String(value || ""),
    backendNumber: (value) => Number(value) || 0,
    backendRowsById: (rows, key) => new Map((rows || []).map((row) => [String(row[key] ?? "").trim(), row])),
    compactBankText: (value) => String(value || "")
  });
  const candidates = matching.backendBankPayableCandidates(matchingTables);
  assert.strictEqual(candidates.find((candidate) => candidate.id === "10")?.planPayment, true);

  response = await invoke(harness.service.handlePaymentPlanUpdate, "/api/treasury/payment-plans/1", {
    operationId: "delete-linked",
    plan: body.plan,
    quotas: body.quotas.slice(1)
  });
  assert.strictEqual(response.status, 409);
  assert.strictEqual(harness.getCache().tables.cuotas_planes_pagos.rows.some((row) => String(row.id_cuota_plan_pago) === "1"), true);
}

async function testValidationAndDelete() {
  const cases = [
    [validQuota({ nro_cuota: 2 }), 409],
    [validQuota({ capital: -1, total_primer_vencimiento: 19, total_segundo_vencimiento: 24 }), 400],
    [validQuota({ fecha_primer_vencimiento: "2026-99-99" }), 400]
  ];
  for (const [input, status] of cases) {
    const harness = createHarness();
    const response = await invoke(harness.service.handlePaymentPlanQuotaAdd, "/api/treasury/payment-plans/1/quotas", {
      operationId: `invalid-${status}-${JSON.stringify(input)}`,
      quota: input
    });
    assert.strictEqual(response.status, status);
    assert.strictEqual(harness.getSaves(), 0);
  }

  const harness = createHarness();
  assert.strictEqual((await invoke(harness.service.handlePaymentPlanGet, "/api/treasury/payment-plans/99")).status, 404);
  assert.strictEqual((await invoke(harness.service.handlePaymentPlanQuotaUpdate, "/api/treasury/payment-plans/1/quotas/99", {
    operationId: "missing-quota", quota: { ...validQuota(), id_cuota_plan_pago: 99 }
  })).status, 404);
  assert.strictEqual((await invoke(harness.service.handlePaymentPlanQuotaDelete, "/api/treasury/payment-plans/1/quotas/1/delete", {
    operationId: "delete-linked"
  })).status, 409);
  assert.strictEqual((await invoke(harness.service.handlePaymentPlanQuotaDelete, "/api/treasury/payment-plans/1/quotas/2/delete", {
    operationId: "delete-safe"
  })).status, 200);
  assert.strictEqual(harness.getCache().tables.cuotas_planes_pagos.rows.length, 1);
}

async function testFailuresDoNotMutate() {
  const initial = fixture();
  const injected = createHarness(initial, { failureInjector: (stage) => {
    if (stage === "before-persist") throw new Error("fallo previo");
  } });
  let response = await invoke(injected.service.handlePaymentPlanQuotaAdd, "/api/treasury/payment-plans/1/quotas", {
    operationId: "failure-before", quota: validQuota({ nro_cuota: 3 })
  });
  assert.strictEqual(response.status, 400);
  assert.deepStrictEqual(injected.getCache(), initial);

  const failedSave = createHarness(initial, { failSave: true });
  response = await invoke(failedSave.service.handlePaymentPlanQuotaAdd, "/api/treasury/payment-plans/1/quotas", {
    operationId: "failure-save", quota: validQuota({ nro_cuota: 3 })
  });
  assert.strictEqual(response.status, 400);
  assert.deepStrictEqual(failedSave.getCache(), initial);
}

async function testExpenseLinkEditing() {
  const unprotected = fixture();
  unprotected.tables.detalle_pagos.rows = [];
  unprotected.tables.detalle_pagos.rowCount = 0;
  unprotected.tables.pagos.rows = [];
  unprotected.tables.pagos.rowCount = 0;
  const harness = createHarness(unprotected);
  const untouchedFinancialRows = JSON.parse(JSON.stringify({
    egresos: harness.getCache().tables.egresos.rows,
    detalle_pagos: harness.getCache().tables.detalle_pagos.rows,
    pagos: harness.getCache().tables.pagos.rows,
    movimientos_bancarios: harness.getCache().tables.movimientos_bancarios.rows
  }));

  let response = await invoke(harness.service.handlePaymentPlanQuotaUpdate, "/api/treasury/payment-plans/1/quotas/2", {
    operationId: "assign-expense",
    quota: { ...validQuota({ nro_cuota: 2, id_egreso: 11 }), id_cuota_plan_pago: 2 }
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.payload.quota.id_egreso, "11");

  const beforeDuplicate = JSON.parse(JSON.stringify(harness.getCache()));
  response = await invoke(harness.service.handlePaymentPlanQuotaUpdate, "/api/treasury/payment-plans/1/quotas/1", {
    operationId: "duplicate-expense",
    quota: { ...validQuota({ id_egreso: 11 }), id_cuota_plan_pago: 1 }
  });
  assert.strictEqual(response.status, 409);
  assert.deepStrictEqual(harness.getCache(), beforeDuplicate);

  response = await invoke(harness.service.handlePaymentPlanQuotaUpdate, "/api/treasury/payment-plans/1/quotas/1", {
    operationId: "replace-expense",
    quota: { ...validQuota({ id_egreso: 12 }), id_cuota_plan_pago: 1 }
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.payload.quota.id_egreso, "12");
  assert.strictEqual(harness.getCache().tables.egresos.rows.some((expense) => String(expense.id_egreso) === "10"), true);

  response = await invoke(harness.service.handlePaymentPlanQuotaUpdate, "/api/treasury/payment-plans/1/quotas/1", {
    operationId: "unlink-expense",
    quota: { ...validQuota({ id_egreso: "" }), id_cuota_plan_pago: 1 }
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.payload.quota.id_egreso, "");

  response = await invoke(harness.service.handlePaymentPlanQuotaAdd, "/api/treasury/payment-plans/1/quotas", {
    operationId: "new-linked-quota",
    quota: validQuota({ nro_cuota: 3, id_egreso: 10 })
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.payload.quota.id_egreso, "10");
  response = await invoke(harness.service.handlePaymentPlanQuotaAdd, "/api/treasury/payment-plans/1/quotas", {
    operationId: "new-unlinked-quota",
    quota: validQuota({ nro_cuota: 4, id_egreso: "" })
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.payload.quota.id_egreso, "");

  response = await invoke(harness.service.handlePaymentPlanGet, "/api/treasury/payment-plans/1");
  assert.strictEqual(response.payload.plan.cuotas.find((item) => item.id_cuota_plan_pago === "3").id_egreso, "10");
  assert.deepStrictEqual({
    egresos: harness.getCache().tables.egresos.rows,
    detalle_pagos: harness.getCache().tables.detalle_pagos.rows,
    pagos: harness.getCache().tables.pagos.rows,
    movimientos_bancarios: harness.getCache().tables.movimientos_bancarios.rows
  }, untouchedFinancialRows);

  const missingBefore = JSON.parse(JSON.stringify(harness.getCache()));
  response = await invoke(harness.service.handlePaymentPlanQuotaUpdate, "/api/treasury/payment-plans/1/quotas/2", {
    operationId: "missing-expense",
    quota: { ...validQuota({ nro_cuota: 2, id_egreso: 999 }), id_cuota_plan_pago: 2 }
  });
  assert.strictEqual(response.status, 400);
  assert.deepStrictEqual(harness.getCache(), missingBefore);

  for (const invalidId of ["abc", "-1", "0", "1.5"]) {
    const beforeInvalid = JSON.parse(JSON.stringify(harness.getCache()));
    response = await invoke(harness.service.handlePaymentPlanQuotaUpdate, "/api/treasury/payment-plans/1/quotas/2", {
      operationId: `invalid-expense-id-${invalidId}`,
      quota: { ...validQuota({ nro_cuota: 2, id_egreso: invalidId }), id_cuota_plan_pago: 2 }
    });
    assert.strictEqual(response.status, 400);
    assert.match(response.payload.error, /entero positivo/i);
    assert.deepStrictEqual(harness.getCache(), beforeInvalid);
  }
}

async function testProtectedExpenseLinksAndAtomicRollback() {
  const paidHarness = createHarness();
  const paidBefore = JSON.parse(JSON.stringify(paidHarness.getCache()));
  let response = await invoke(paidHarness.service.handlePaymentPlanQuotaUpdate, "/api/treasury/payment-plans/1/quotas/1", {
    operationId: "replace-paid-expense",
    quota: { ...validQuota({ id_egreso: 11 }), id_cuota_plan_pago: 1 }
  });
  assert.strictEqual(response.status, 409);
  assert.deepStrictEqual(paidHarness.getCache(), paidBefore);

  response = await invoke(paidHarness.service.handlePaymentPlanQuotaUpdate, "/api/treasury/payment-plans/1/quotas/1", {
    operationId: "unlink-paid-expense",
    quota: { ...validQuota({ id_egreso: "" }), id_cuota_plan_pago: 1 }
  });
  assert.strictEqual(response.status, 409);
  assert.deepStrictEqual(paidHarness.getCache(), paidBefore);

  const reconciled = fixture();
  reconciled.tables.movimientos_bancarios.rows.push({ id_movimiento_bancario: 1, id_pago: 50 });
  reconciled.tables.movimientos_bancarios.rowCount = 1;
  const reconciledHarness = createHarness(reconciled);
  response = await invoke(reconciledHarness.service.handlePaymentPlanQuotaUpdate, "/api/treasury/payment-plans/1/quotas/1", {
    operationId: "replace-reconciled-expense",
    quota: { ...validQuota({ id_egreso: 11 }), id_cuota_plan_pago: 1 }
  });
  assert.strictEqual(response.status, 409);
  assert.match(response.payload.error, /conciliaci/i);

  const atomicBefore = JSON.parse(JSON.stringify(paidHarness.getCache()));
  response = await invoke(paidHarness.service.handlePaymentPlanUpdate, "/api/treasury/payment-plans/1", {
    operationId: "atomic-link-conflict",
    plan: { id_plan_pago: 1, nombre: "No debe persistir", organismo: "Otro" },
    quotas: [
      { ...validQuota({ id_egreso: 11 }), id_cuota_plan_pago: 1 },
      { ...validQuota({ nro_cuota: 2, id_egreso: 11 }), id_cuota_plan_pago: 2 }
    ]
  });
  assert.strictEqual(response.status, 409);
  assert.deepStrictEqual(paidHarness.getCache(), atomicBefore);
}

function testRegistryAndAdministrativePolicy() {
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "backend", "table-registry.json"), "utf8"));
  const names = new Set(registry.tables.map((table) => table.name));
  assert(names.has("planes_pagos"));
  assert(names.has("cuotas_planes_pagos"));
  const { ADMIN_TABLE_POLICY } = require("../backend/config/admin-table-policy");
  ["planes_pagos", "cuotas_planes_pagos"].forEach((name) => {
    assert.strictEqual(ADMIN_TABLE_POLICY[name].read, true);
    assert.strictEqual(ADMIN_TABLE_POLICY[name].insert, true);
    assert.strictEqual(ADMIN_TABLE_POLICY[name].update, true);
    assert.strictEqual(ADMIN_TABLE_POLICY[name].delete, true);
  });
}

function testExpenseLinkEditorContract() {
  const source = fs.readFileSync(path.join(__dirname, "..", "assets", "js", "modules", "payment-plans.js"), "utf8");
  const viewRow = source.slice(source.indexOf("function quotaRow("), source.indexOf("function editableQuotaRow("));
  const editRow = source.slice(source.indexOf("function editableQuotaRow("), source.indexOf("function compactEditorInput("));
  assert.match(source, /<th scope="col">ID egreso<\/th>/);
  assert.match(viewRow, /<strong>\$\{escapeHtml\(quota\.id_egreso\)\}<\/strong>/);
  assert.match(viewRow, /Sin vínculo/);
  assert.doesNotMatch(viewRow, /payment-plan-expense-id-input/);
  assert.match(editRow, /expenseIdInput\(quota\)/);
  assert.match(source, /<input class="payment-plan-expense-id-input"/);
  assert.match(source, /data-quota-editor-field="id_egreso"/);
  assert.match(source, /type="number" inputmode="numeric" min="1" step="1"/);
  assert.doesNotMatch(source, /payment-plan-expense-select|<select[^>]*id="payment-plan-quota-id_egreso"/);
  assert.match(source, /applyQuotaEditor\(elements, \{ forSave: true \}\)/);
  assert.match(source, /request\(`\/api\/treasury\/payment-plans\/\$\{encodeURIComponent\(savedPlanId\)\}`\)/);
  assert.match(source, /payment-plan-quota-field-error/);
  assert.match(source, /function hasUnsavedChanges\(\)/);
  assert.match(source, /global\.PaymentPlansModule = \{ renderPaymentPlans, hasUnsavedChanges \}/);
  assert.match(source, /global\.addEventListener\("beforeunload"/);
  assert.match(source, /const firstTotalCents = capitalCents \+ financialInterestCents/);
  assert.match(source, /total_primer_vencimiento: centsToMoney\(moneyToCents\(quota\.total_primer_vencimiento\)\)/);
  assert.doesNotMatch(source, /function round\(value\)/);
  const appSource = fs.readFileSync(path.join(__dirname, "..", "assets", "js", "app.js"), "utf8");
  assert.match(appSource, /Hay cambios sin guardar en Planes de pago/);
}

async function main() {
  await testReadAndCreate();
  await testPendingBalanceFromAppliedPayments();
  await testCanonicalCentValidation();
  await testAtomicFullEdit();
  await testValidationAndDelete();
  await testFailuresDoNotMutate();
  await testExpenseLinkEditing();
  await testProtectedExpenseLinksAndAtomicRollback();
  testRegistryAndAdministrativePolicy();
  testExpenseLinkEditorContract();
  console.log("Payment plans tests: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
