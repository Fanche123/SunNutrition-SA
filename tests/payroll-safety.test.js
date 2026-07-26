const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createPayrollExpenseEntryService } = require("../backend/services/payroll-expense-entry.service");
const { createPayrollSummaryService } = require("../backend/services/payroll-summary.service");
const { createAttachmentsService } = require("../backend/services/attachments.service");
const { ensureBackendTable, backendNextNumericId } = require("../backend/utils/runtime");
const money = require("../shared/money");

const backendId = (value) => String(value ?? "").trim();
const backendNumber = (value) => Number(value) || 0;
const clone = (value) => JSON.parse(JSON.stringify(value));
const readJsonBody = async (request) => request.body;
const sendJson = (response, status, payload) => response.json(status, payload);

async function invoke(handler, body) {
  let result;
  await handler({ body }, { json(status, payload) { result = { status, payload }; } });
  return result;
}

function seedCache() {
  return {
    generatedAt: "",
    tables: {
      sueldos: {
        rows: [
          { id_sueldo: 1, fecha: "2026-07-01", id_empleado: 10, id_acreedor_etiqueta: 100, id_egreso: "", sueldo_bruto: 120.48, sueldo_neto: 100, hs_trabajadas: 160, hs_extra: 0 },
          { id_sueldo: 2, fecha: "2026-07-01", id_empleado: 11, id_acreedor_etiqueta: 101, id_egreso: "", sueldo_bruto: 240.96, sueldo_neto: 200, hs_trabajadas: 160, hs_extra: 8 }
        ],
        rowCount: 2
      },
      egresos: { rows: [], rowCount: 0 },
      acreedores_etiquetas: {
        rows: [
          { id_acreedor_etiqueta: 100, id_acreedor: 20, id_etiqueta: 5 },
          { id_acreedor_etiqueta: 101, id_acreedor: 21, id_etiqueta: 5 }
        ],
        rowCount: 2
      },
      etiquetas: { rows: [{ id_etiqueta: 5, etiqueta: "Sueldos" }], rowCount: 1 }
    }
  };
}

function validBody() {
  return {
    salaryIds: ["1", "2"],
    concepts: [
      { type: "salary", salaryId: "1", amount: 100 },
      { type: "salary", salaryId: "2", amount: 200 }
    ],
    expense: {
      fecha_factura: "2026-07-31",
      fecha_prevista_pago: "2026-08-05",
      id_etiqueta: "5",
      tipo_factura: "Recibo_Sueldo",
      nro_factura: "JUL-2026",
      iva: 0,
      per_ret_iva: 0,
      per_ret_iibb: 0,
      imp_internos: 0,
      subtotal: 300,
      total: 300
    }
  };
}

function store(seed = seedCache(), options = {}) {
  let persisted = clone(seed);
  let saves = 0;
  return {
    loadCache: () => clone(persisted),
    saveBackendCache: (next) => {
      saves += 1;
      if (options.failSave) throw new Error("fallo de disco");
      persisted = clone(next);
    },
    value: () => clone(persisted),
    saves: () => saves
  };
}

function service(memory, failureInjector) {
  return createPayrollExpenseEntryService({
    backendId,
    backendNextNumericId,
    backendNumber,
    ensureBackendTable,
    loadCache: memory.loadCache,
    readJsonBody,
    saveBackendCache: memory.saveBackendCache,
    sendJson,
    failureInjector
  });
}

async function testAtomicPersistenceAndDurableRetry() {
  const memory = store();
  const first = await invoke(service(memory).handlePayrollExpenseEntry, validBody());
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.payload.idempotent, false);
  assert.strictEqual(memory.saves(), 1);
  assert.strictEqual(memory.value().tables.egresos.rows.length, 1);
  assert(memory.value().tables.sueldos.rows.every((row) => String(row.id_egreso) === "1"));

  const lostResponseRetry = await invoke(service(memory).handlePayrollExpenseEntry, validBody());
  assert.strictEqual(lostResponseRetry.status, 200);
  assert.strictEqual(lostResponseRetry.payload.idempotent, true);
  assert.strictEqual(memory.saves(), 1);

  const restartedServiceRetry = await invoke(service(memory).handlePayrollExpenseEntry, validBody());
  assert.strictEqual(restartedServiceRetry.payload.idempotent, true);
  assert.strictEqual(memory.value().tables.egresos.rows.length, 1);
}

async function testFailuresNeverPersistPartialState() {
  for (const point of ["before-mutation", "after-association"]) {
    const memory = store();
    const before = memory.value();
    const result = await invoke(service(memory, (current) => {
      if (current === point) throw new Error("fallo inyectado");
    }).handlePayrollExpenseEntry, validBody());
    assert.strictEqual(result.status, 400);
    assert.deepStrictEqual(memory.value(), before);
  }
  const failedSave = store(seedCache(), { failSave: true });
  const before = failedSave.value();
  assert.strictEqual((await invoke(service(failedSave).handlePayrollExpenseEntry, validBody())).status, 400);
  assert.deepStrictEqual(failedSave.value(), before);
}

async function testConflictsAndInvalidPayload() {
  const partial = seedCache();
  partial.tables.sueldos.rows[0].id_egreso = 9;
  partial.tables.egresos.rows.push({ id_egreso: 9, ...validBody().expense });
  const partialStore = store(partial);
  assert.strictEqual((await invoke(service(partialStore).handlePayrollExpenseEntry, validBody())).status, 409);
  assert.strictEqual(partialStore.saves(), 0);

  const contradictory = seedCache();
  contradictory.tables.sueldos.rows[0].id_egreso = 9;
  contradictory.tables.sueldos.rows[1].id_egreso = 9;
  contradictory.tables.egresos.rows.push({ id_egreso: 9, ...validBody().expense, total: 999 });
  assert.strictEqual((await invoke(service(store(contradictory)).handlePayrollExpenseEntry, validBody())).status, 409);

  const invalid = validBody();
  invalid.expense.total = 301;
  const invalidStore = store();
  assert.strictEqual((await invoke(service(invalidStore).handlePayrollExpenseEntry, invalid)).status, 400);
  assert.strictEqual(invalidStore.saves(), 0);
}

async function testSameEmployeePeriodAndConsumers() {
  const seed = seedCache();
  seed.tables.sueldos.rows[1].id_empleado = 10;
  const memory = store(seed);
  assert.strictEqual((await invoke(service(memory).handlePayrollExpenseEntry, validBody())).status, 200);
  const summary = createPayrollSummaryService({
    backendId,
    backendIsoDate: (value) => String(value || ""),
    backendNumber
  })(memory.value().tables.sueldos.rows, "2026-07-01", "2026-07-31");
  assert.strictEqual(summary.totalGross, 361.44);
  assert.strictEqual(memory.value().tables.egresos.rows[0].total, 300);
}

function testCalendarsAndSalaryCalculation() {
  const context = {
    console,
    Date,
    Set,
    state: { payrollEntry: { selectedPeriod: "2026-07", exceptions: [] } },
    salaryEntryEmployees: [],
    salaryEntryScale: { categories: {} },
    normalizeCategory: (value) => String(value).toLowerCase(),
    normalizeSearchText: (value) => String(value).toLowerCase(),
    parseMoney: (value) => {
      const result = money.parseInput(value);
      return result.ok && !result.empty ? result.amount : 0;
    },
    parseQuantity: (value) => {
      const parsed = Number(String(value ?? "").trim().replace(",", "."));
      return Number.isFinite(parsed) ? parsed : 0;
    },
    parseMoneyInput: money.parseInput,
    moneyToCents: money.toCents,
    centsToMoney: money.fromCents,
    formatMoney: money.format,
    formatMoneyInput: money.formatInput,
    ErpMoney: money,
    escapeHtml: (value) => String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;"),
    toIsoDate: (date) => date.toISOString().slice(0, 10),
    dateFromIso: (value) => new Date(`${value}T00:00:00Z`),
    addDays: (date, days) => new Date(date.getTime() + days * 86400000),
    isBusinessDay: (date) => ![0, 6].includes(date.getUTCDay())
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../assets/js/config/payroll-calendars.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../assets/js/modules/salary-entry.js"), "utf8"), context);
  assert.strictEqual(vm.runInContext("payrollCalendarForYear(2026).configured", context), true);
  assert.strictEqual(vm.runInContext("payrollCalendarForYear(2027).configured", context), false);

  context.salaryEntryEmployees = [
    { id: "1", name: "Horario", category: "hora", contractType: "Cooperativa" },
    { id: "2", name: "Mensual", category: "mes", contractType: "Cooperativa" }
  ];
  context.salaryEntryScale = {
    categories: {
      hora: { type: "hourly", periods: { "2026-07": { remunerative: 10, nonRemunerative: 5 } } },
      mes: { type: "monthly", periods: { "2026-07": { remunerative: 1000, nonRemunerative: 100 } } }
    }
  };
  const rows = vm.runInContext("buildSalaryRows()", context);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].scaleConfigured, true);
  assert.strictEqual(
    money.toCents(rows[0].valorRemunerativo),
    money.multiplyCents(10, rows[0].workedHours + rows[0].justifiedHours + rows[0].holidayHours)
  );
  assert.strictEqual(rows[1].sueldoBruto, 1100);
  assert.strictEqual(rows[1].sueldoNeto, 913);
  assert.strictEqual(vm.runInContext('salaryExceptionAmount({ type: "extra_hours", hours: "1,5" })', context), 1.5);

  context.awardTestRow = {
    workedHours: 0,
    justifiedHours: 0,
    extraHours: 0,
    awardsCents: 0,
    awards: 0
  };
  vm.runInContext('applySalaryException(awardTestRow, { type: "award", hours: "0,10" })', context);
  vm.runInContext('applySalaryException(awardTestRow, { type: "award", hours: "0,20" })', context);
  assert.strictEqual(context.awardTestRow.awardsCents, 30);
  assert.strictEqual(context.awardTestRow.awards, 0.3);
  context.awardException = {
    id: "award-1",
    employeeId: "1",
    type: "award",
    hours: 999645.25,
    startDate: "2026-07-01",
    endDate: "2026-07-01",
    note: ""
  };
  const awardHtml = vm.runInContext("salaryExceptionRow(awardException)", context);
  assert(awardHtml.includes('type="text"'));
  assert(awardHtml.includes('inputmode="decimal"'));
  assert(awardHtml.includes("data-money-input"));
  assert(awardHtml.includes("data-salary-exception-money"));
  assert(awardHtml.includes('value="999.645,25"'));
  assert(!awardHtml.includes('type="number" step="0.5" value="999645.25"'));

  const laborSummary = vm.runInContext(`salaryLaborCostSummary([
    { employee: { contractType: "Relacion de dependencia" }, sueldoBruto: 100.01, sueldoNeto: 83.01 },
    { employee: { contractType: "Relacion de dependencia" }, sueldoBruto: 200.02, sueldoNeto: 166.02 },
    { employee: { contractType: "Cooperativa" }, sueldoBruto: 999, sueldoNeto: 1 },
    { employee: { contractType: "Cooperativa" }, sueldoBruto: 999, sueldoNeto: 1 }
  ], { cooperativeEmployeeCost: 10.01 })`, context);
  assert.strictEqual(laborSummary.dependencyCount, 2);
  assert.strictEqual(laborSummary.dependencyGross, 300.03);
  assert.strictEqual(laborSummary.employeeContributionsTotal, 51);
  assert.strictEqual(laborSummary.employerContributionsTotal, 77.41);
  assert.strictEqual(laborSummary.socialChargesTotal, 128.41);
  assert.strictEqual(laborSummary.dependencyGrossCents, 30003);
  assert.strictEqual(laborSummary.employeeContributionsCents, 5100);
  assert.strictEqual(laborSummary.employerContributionsCents, 7741);
  assert.strictEqual(laborSummary.socialChargesCents, 12841);
  assert.strictEqual(laborSummary.cooperativeCount, 2);
  assert.strictEqual(laborSummary.cooperativeTotal, 20.02);
  assert.strictEqual(laborSummary.cooperativeTotalCents, 2002);

  const emptyDependencySummary = vm.runInContext(
    `salaryLaborCostSummary([{ employee: { contractType: "Cooperativa" }, sueldoBruto: 1000, sueldoNeto: 1 }], { cooperativeEmployeeCost: 25 })`,
    context
  );
  assert.strictEqual(emptyDependencySummary.dependencyCount, 0);
  assert.strictEqual(emptyDependencySummary.socialChargesTotal, 0);

  const fractionalPercentageSummary = vm.runInContext(`salaryLaborCostSummary([
    { employee: { contractType: "Relacion de dependencia" }, sueldoBruto: 0.02, sueldoNeto: 0.02 }
  ], { cooperativeEmployeeCostCents: 0, cooperativeEmployeeCost: 0 })`, context);
  assert.strictEqual(fractionalPercentageSummary.employerContributionsCents, 1);
}

function createSalaryLaborUiContext() {
  const container = {
    innerHTML: "",
    nodes: {},
    querySelector(selector) {
      return this.nodes[selector] || null;
    }
  };
  const context = {
    console,
    Date,
    state: {
      payrollEntry: {
        selectedPeriod: "2026-07",
        exceptions: [],
        laborCosts: { cooperativeCostByPeriod: { "2026-07": 10.01 } }
      }
    },
    salaryEntryEmployees: [],
    salaryEntryScale: { categories: {} },
    salaryLaborCostUi: {
      periodKey: "2026-07",
      socialEditing: false,
      socialDraft: "",
      socialError: "",
      socialOverrideCents: null,
      cooperativeEditing: false,
      cooperativeDraft: "",
      cooperativeError: ""
    },
    els: { "salary-labor-costs": container },
    DEFAULT_COOPERATIVE_EMPLOYEE_COST: 0,
    normalizeSearchText: (value) => String(value).toLowerCase(),
    parseMoney: Number,
    parseMoneyInput: money.parseInput,
    moneyToCents: money.toCents,
    centsToMoney: money.fromCents,
    formatMoney: money.format,
    formatMoneyInput: money.formatInput,
    ErpMoney: money,
    escapeHtml: (value) => String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;"),
    createDefaultPayrollState: () => ({
      laborCosts: { cooperativeCostByPeriod: {} }
    }),
    renderSalaryExpenseEntry() {},
    saveState: () => {
      context.saveCalls += 1;
    },
    saveCalls: 0
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../assets/js/modules/salary-entry.js"), "utf8"),
    context
  );
  context.testSalaryRows = [
    { employee: { contractType: "Relacion de dependencia" }, sueldoBruto: 100.01, sueldoNeto: 83.01 },
    { employee: { contractType: "Relacion de dependencia" }, sueldoBruto: 200.02, sueldoNeto: 166.02 },
    { employee: { contractType: "Cooperativa" }, sueldoBruto: 0, sueldoNeto: 0 },
    { employee: { contractType: "Cooperativa" }, sueldoBruto: 0, sueldoNeto: 0 }
  ];
  vm.runInContext("buildSalaryRows = () => testSalaryRows", context);
  return { context, container };
}

function salaryLaborAction(context, action) {
  context.salaryLaborTestEvent = {
    target: {
      closest: () => ({ dataset: { salaryLaborAction: action } })
    }
  };
  vm.runInContext("handleSalaryLaborCostAction(salaryLaborTestEvent)", context);
}

function testSalaryLaborCostPresentationAndEditing() {
  const { context, container } = createSalaryLaborUiContext();
  vm.runInContext("renderSalaryLaborCosts(testSalaryRows)", context);
  const readOnlyHtml = container.innerHTML;

  assert.strictEqual((readOnlyHtml.match(/class="salary-labor-cost-row"/g) || []).length, 2);
  assert(readOnlyHtml.includes("$ 51,00"));
  assert(readOnlyHtml.includes("$ 77,41"));
  assert(readOnlyHtml.includes("$ 128,41"));
  assert(readOnlyHtml.includes("$ 10,01"));
  assert(readOnlyHtml.includes("$ 20,02"));
  assert(!readOnlyHtml.includes("<strong"));
  assert(!readOnlyHtml.includes('type="number"'));
  assert(
    readOnlyHtml.indexOf("Aportes del empleado") <
      readOnlyHtml.indexOf("Empleador + ART (25,8 %)") &&
      readOnlyHtml.indexOf("Empleador + ART (25,8 %)") <
      readOnlyHtml.indexOf("Total cargas sociales")
  );
  assert(
    readOnlyHtml.indexOf("salary-labor-cost-spacer") <
      readOnlyHtml.indexOf("Costo por persona") &&
      readOnlyHtml.indexOf("Costo por persona") <
      readOnlyHtml.indexOf("Total Cooperativa")
  );

  salaryLaborAction(context, "edit-social");
  assert.strictEqual(context.salaryLaborCostUi.socialDraft, "128,41");
  assert.strictEqual(money.toCents(context.salaryLaborCostUi.socialDraft), 12841);
  assert(container.innerHTML.includes('id="salary-social-charge-total-input"'));
  assert(container.innerHTML.includes('type="text"'));
  assert(container.innerHTML.includes('inputmode="decimal"'));
  assert(container.innerHTML.includes("data-money-input"));
  assert(container.innerHTML.includes('value="128,41"'));

  container.nodes["#salary-social-charge-total-input"] = { value: "importe inválido" };
  salaryLaborAction(context, "save-social");
  assert.strictEqual(context.salaryLaborCostUi.socialOverrideCents, null);
  assert.strictEqual(context.salaryLaborCostUi.socialEditing, true);
  assert.strictEqual(context.salaryLaborCostUi.socialError, "INVALID_FORMAT");
  assert(container.innerHTML.includes("Ingresá un importe válido."));

  context.salaryLaborCostUi.socialOverrideCents = 999;
  salaryLaborAction(context, "cancel-social");
  assert.strictEqual(context.salaryLaborCostUi.socialOverrideCents, null);
  assert.strictEqual(context.salaryLaborCostUi.socialEditing, false);
  assert(container.innerHTML.includes("$ 128,41"));
  assert(!container.innerHTML.includes("$ 9,99"));

  salaryLaborAction(context, "edit-cooperative");
  assert.strictEqual(context.salaryLaborCostUi.cooperativeDraft, "10,01");
  assert.strictEqual(money.toCents(context.salaryLaborCostUi.cooperativeDraft), 1001);
  container.nodes["#salary-cooperative-cost-per-employee"] = { value: "10,123" };
  salaryLaborAction(context, "save-cooperative");
  assert.strictEqual(context.state.payrollEntry.laborCosts.cooperativeCostByPeriod["2026-07"], 10.01);
  assert.strictEqual(context.salaryLaborCostUi.cooperativeEditing, true);
  assert.strictEqual(context.salaryLaborCostUi.cooperativeError, "TOO_MANY_DECIMALS");
  assert.strictEqual(context.saveCalls, 0);
  assert(container.innerHTML.includes("Ingresá como máximo dos decimales."));

  container.nodes["#salary-cooperative-cost-per-employee"] = { value: "$ 999.645,25" };
  salaryLaborAction(context, "save-cooperative");
  assert.strictEqual(context.state.payrollEntry.laborCosts.cooperativeCostByPeriod["2026-07"], 999645.25);
  assert.strictEqual(context.salaryLaborCostUi.cooperativeEditing, false);
  assert.strictEqual(context.saveCalls, 1);
  assert(container.innerHTML.includes("$ 1.999.290,50"));
}

function testSalaryLaborOverrideFeedsExpenseRow() {
  const { context } = createSalaryLaborUiContext();
  context.state.payrollEntry.laborExpenses = {
    socialChargeExpenseByPeriod: {},
    cooperativeExpenseByPeriod: {}
  };
  context.salaryExpenseEntryData = { expenses: [] };
  context.isoDateFromMixedValue = (value) => String(value || "");
  context.backendId = backendId;
  context.salaryLaborCostUi.socialOverrideCents = 12999;
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../assets/js/modules/salary-expense-entry.js"), "utf8"),
    context
  );

  const laborRows = vm.runInContext('salaryExpenseLaborRows("2026-07")', context);
  const socialRow = laborRows.find((row) => row.rowType === "labor-social");
  assert(socialRow);
  assert.strictEqual(money.toCents(socialRow.netSalary), 12999);
}

async function testScalePeriods() {
  async function readScale(text, periodKey) {
    const fakeFs = {
      existsSync: () => true,
      mkdirSync() {},
      writeFileSync() {},
      rmSync() {}
    };
    const attachmentService = createAttachmentsService({
      childProcess: { spawnSync: () => ({ status: 0, stdout: text, stderr: "" }) },
      fs: fakeFs,
      path,
      pythonExecutable: "python",
      readJsonBody,
      rootDir: "C:\\isolated",
      sendJson
    });
    return invoke(attachmentService.handlePayrollScaleRead, {
      fileDataUrl: "data:application/pdf;base64,ZmFrZQ==",
      fileName: "fixture.pdf",
      periodKey
    });
  }
  const detected = await readScale("JULIO 2027\nOPERARIO $ 10,00 $ 2,00", "");
  assert.deepStrictEqual(detected.payload.scale.periods, ["2027-07"]);
  const selected = await readScale("OPERARIO $ 10,00 $ 2,00", "2028-03");
  assert.deepStrictEqual(selected.payload.scale.periods, ["2028-03"]);
  const unknown = await readScale("OPERARIO $ 10,00 $ 2,00", "");
  assert.strictEqual(unknown.payload.scale.periodSource, "unknown");
  assert.deepStrictEqual(unknown.payload.scale.periods, []);
}

function testEstimatedNetPresentationAndSecondaryStateSeparation() {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const salarySource = fs.readFileSync(path.join(__dirname, "../assets/js/modules/salary-entry.js"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../assets/css/styles.css"), "utf8");
  const expenseSource = fs.readFileSync(path.join(__dirname, "../assets/js/modules/salary-expense-entry.js"), "utf8");
  const laborRenderSource = salarySource.slice(
    salarySource.indexOf("function renderSalaryLaborCosts"),
    salarySource.indexOf("function addSalaryExceptionRow")
  );
  assert(html.includes("Neto estimado"));
  assert(html.includes("Estimacion: 83 % del sueldo bruto"));
  assert(salarySource.includes("ErpMoney.percentageCents(row.sueldoBruto, 83)"));
  assert(salarySource.includes("ErpMoney.percentageCents(centsToMoney(dependencyGrossCents), 25.8)"));
  assert(!salarySource.includes("salaryMoneyToCents"));
  assert(expenseSource.includes("persistPayrollSecondaryState"));
  assert(expenseSource.includes("actualizacion secundaria de app-state"));
  assert(salarySource.includes("Valor manual temporal"));
  assert(salarySource.includes("data-salary-exception-money"));
  assert(salarySource.includes("parseMoneyInput(input.value"));
  assert(salarySource.includes('salaryLaborCostActions("social"'));
  assert(expenseSource.includes("salaryLaborCostUi.socialOverrideCents"));
  assert(expenseSource.includes("Number.isInteger(salaryLaborCostUi.socialOverrideCents)"));
  assert(!salarySource.includes("salary-cooperative-total-input"));
  assert(salarySource.includes('class="salary-labor-cost-display"'));
  assert(!salarySource.includes("readonly"));
  assert(!laborRenderSource.includes("<strong"));
  assert(laborRenderSource.includes('type="text"'));
  assert(laborRenderSource.includes('inputmode="decimal"'));
  assert(laborRenderSource.includes("data-money-input"));
  assert(
    salarySource.indexOf('class="salary-labor-cost-value salary-labor-cost-spacer"') <
      salarySource.indexOf('class="salary-labor-cost-value salary-labor-cost-cooperative-value"')
  );
  assert(styles.includes("--salary-labor-cost-columns: minmax(220px, 1fr) 165px 180px 190px 92px"));
  assert(styles.includes("grid-template-columns: var(--salary-labor-cost-columns)"));
  assert(/\.salary-labor-cost-display\s*\{[\s\S]*?justify-content:\s*center;[\s\S]*?font-weight:\s*400\s*!important;[\s\S]*?text-align:\s*center;/m.test(styles));
  assert(/\.salary-labor-cost-title\s*\{[\s\S]*?text-align:\s*center;/m.test(styles));
  assert(/@media \(max-width:\s*700px\)[\s\S]*?\.salary-labor-cost-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/m.test(styles));
}

async function testAppStateFailureAndRecoveryAreSecondary() {
  let localSaves = 0;
  let localSaveOptions;
  const context = {
    state: {
      payrollEntry: {
        laborExpenses: {
          socialChargeExpenseByPeriod: {},
          cooperativeExpenseByPeriod: {}
        }
      }
    },
    salaryExpenseEntryData: {
      expenses: [{
        id_egreso: 44,
        fecha_factura: "2026-07-31",
        tipo_factura: "Cargas_Sociales"
      }]
    },
    createDefaultPayrollState: () => ({
      laborExpenses: { socialChargeExpenseByPeriod: {}, cooperativeExpenseByPeriod: {} }
    }),
    isoDateFromMixedValue: (value) => String(value || ""),
    backendId,
    normalizeSearchText: (value) => String(value || "").toLowerCase().replace(/_/g, " "),
    saveState: (options) => {
      localSaves += 1;
      localSaveOptions = options;
    },
    canUseServerState: () => true,
    fetch: async () => ({ ok: false, status: 500 }),
    API_BASE_URL: "",
    compactStateForStorage: (value) => value,
    console
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../assets/js/modules/salary-expense-entry.js"), "utf8"), context);
  await assert.rejects(() => vm.runInContext("persistPayrollSecondaryState()", context));
  assert.strictEqual(localSaves, 1);
  assert.strictEqual(localSaveOptions.scheduleRemote, false);
  assert.strictEqual(vm.runInContext("reconcileSalaryLaborExpenseStateFromBackend()", context), true);
  assert.strictEqual(context.state.payrollEntry.laborExpenses.socialChargeExpenseByPeriod["2026-07"], "44");
}

async function run() {
  await testAtomicPersistenceAndDurableRetry();
  await testFailuresNeverPersistPartialState();
  await testConflictsAndInvalidPayload();
  await testSameEmployeePeriodAndConsumers();
  testCalendarsAndSalaryCalculation();
  testSalaryLaborCostPresentationAndEditing();
  testSalaryLaborOverrideFeedsExpenseRow();
  await testScalePeriods();
  testEstimatedNetPresentationAndSecondaryStateSeparation();
  await testAppStateFailureAndRecoveryAreSecondary();
  console.log("payroll-safety.test.js: OK");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
