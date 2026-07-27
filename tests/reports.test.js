const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const money = require("../shared/money");

const { createCashflowService } = require("../backend/services/cashflow.service");
const { createExpenseClassificationService } = require("../backend/services/expense-classification.service");
const { createIncomeCalculationService } = require("../backend/services/income-calculation.service");
const { createIncomeStatementService } = require("../backend/services/income-statement.service");
const { createPayrollSummaryService } = require("../backend/services/payroll-summary.service");

const id = (value) => String(value ?? "").trim();
const number = (value) => Number(value) || 0;
const normalize = (value) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
const isoDate = (value) => String(value || "").slice(0, 10);
const rowsById = (rows = [], key) => new Map(rows.map((row) => [id(row[key]), row]));
const groupRowsById = (rows = [], key) => {
  const result = new Map();
  rows.forEach((row) => {
    const keyValue = id(row[key]);
    if (!result.has(keyValue)) result.set(keyValue, []);
    result.get(keyValue).push(row);
  });
  return result;
};
const table = (rows = []) => ({ rows });

function reportHarness(tables) {
  const calculations = createIncomeCalculationService({
    backendGroupRowsById: groupRowsById,
    backendId: id,
    backendInventoryQuantity: number,
    backendRowsById: rowsById,
    roundBackendMoney: (value) => Math.round((value + Number.EPSILON) * 100) / 100
  });
  const classification = createExpenseClassificationService({
    backendId: id,
    backendIsoDate: calculations.backendIsoDate,
    backendNormalizeText: calculations.backendNormalizeText,
    backendNumber: calculations.backendNumber,
    backendRowsById: rowsById,
    cleanBackendText: (value) => String(value ?? "").trim(),
    normalizeBankCuit: (value) => String(value ?? ""),
    normalizeLookupText: normalize
  });
  const payroll = createPayrollSummaryService({
    backendId: id,
    backendIsoDate: calculations.backendIsoDate,
    backendNumber: calculations.backendNumber
  });
  return createIncomeStatementService({
    ...calculations,
    ...classification,
    backendGroupRowsById: groupRowsById,
    backendId: id,
    backendPayrollSummary: payroll,
    backendRowsById: rowsById,
    loadCache: () => ({ tables })
  });
}

function emptyReportTables() {
  return Object.fromEntries([
    "ventas", "clientes", "canales", "productos", "items", "pedidos", "detalle_pedidos",
    "inventarios", "detalle_inventarios", "sueldos", "etiquetas", "acreedores_etiquetas",
    "egresos", "recepciones", "compras", "entregas", "otros_gastos", "comisiones",
    "proveedores", "fletes", "empleados", "acreedores"
  ].map((name) => [name, table()]));
}

test("Estado de Resultados distingue mes vacío y usa inventarios valorizados persistidos", () => {
  const tables = emptyReportTables();
  const empty = reportHarness(tables)(2026, 6);
  assert.equal(empty.salesNet, 0);
  assert.equal(empty.initialInventory, null);
  assert.equal(empty.finalInventory, null);

  tables.items.rows.push({ id_item: 1, origen_tipo: "insumo" });
  tables.inventarios.rows.push(
    { id_inventario: 1, fecha: "2026-06-30", turno: "Tarde", valor_total: 100 },
    { id_inventario: 2, fecha: "2026-07-31", turno: "Tarde", valor_total: 40 }
  );
  tables.detalle_inventarios.rows.push(
    { id_inventario: 1, id_item: 1, cantidad: 1, costo_unitario_usado: 100 },
    { id_inventario: 2, id_item: 1, cantidad: 1, costo_unitario_usado: 40 }
  );
  const report = reportHarness(tables)(2026, 6);
  assert.equal(report.initialInventory.value, 100);
  assert.equal(report.finalInventory.value, 40);
  assert.equal(report.costOfSales.merchandise, 60);
});

test("Estado de Resultados agrega ventas, compras, sueldos, comisiones y no categorizados", () => {
  const tables = emptyReportTables();
  tables.ventas.rows.push({ id_venta: 1, fecha_factura: "2026-07-10", subtotal: 1000, id_cliente: 1, id_pedido: 1, tipo_factura: "Factura_A" });
  tables.clientes.rows.push({ id_cliente: 1, nombre_cliente: "Cliente", id_canal: 1 });
  tables.canales.rows.push({ id_canal: 1, comision: 5 });
  tables.pedidos.rows.push({ id_pedido: 1, id_cliente: 1, fecha_entrega: "2026-07-10" });
  tables.productos.rows.push({ id_producto: 1, cantidad_individual: 10 });
  tables.detalle_pedidos.rows.push({ id_pedido: 1, id_producto: 1, cantidad_cajas: 2 });
  tables.etiquetas.rows.push(
    { id_etiqueta: 1, etiqueta: "Mercaderia" },
    { id_etiqueta: 2, etiqueta: "Categoria nueva" }
  );
  tables.egresos.rows.push({ id_egreso: 1, subtotal: 200 }, { id_egreso: 2, subtotal: 30 });
  tables.recepciones.rows.push(
    { id_recepcion: 1, id_egreso: 1, fecha_recepcion: "2026-07-12", _etiqueta_gasto: "Mercaderia" },
    { id_recepcion: 2, id_egreso: 2, fecha_recepcion: "2026-07-13", _etiqueta_gasto: "Categoria nueva" }
  );
  tables.sueldos.rows.push({ id_sueldo: 1, fecha: "2026-07-20", id_empleado: 1, sueldo_bruto: 300, hs_trabajadas: 8, hs_extra: 2 });
  const report = reportHarness(tables)(2026, 6);
  assert.equal(report.salesNet, 1000);
  assert.equal(report.unitsSold, 20);
  assert.equal(report.costOfSales.merchandisePurchases, 200);
  assert.equal(report.costOfSales.commissions, 50);
  assert.equal(report.operatingExpenses.salaries, 300);
  assert.equal(report.payroll.totalHours, 10);
  assert.equal(report.uncategorized.length, 1);
});

test("cashflow cubre saldos parciales/completos, cheques, signos, centavos y cuatro semanas", () => {
  const tables = {
    caja: table([{ cuenta: "Banco ICBC", monto: 100.25 }, { cuenta: "Efectivo", monto: 50.5 }]),
    egresos: table([{ id_egreso: 1, total: 100.75, fecha_prevista_pago: "2026-07-25" }, { id_egreso: 2, total: 20, fecha_prevista_pago: "2026-07-25" }]),
    detalle_pagos: table([{ id_egreso: 1, monto_cancelado: 40.25 }, { id_egreso: 2, monto_cancelado: 20 }]),
    ventas: table([{ id_venta: 1, total: 200.5, fecha_factura: "2026-07-24", fecha_cobro: "2026-07-30", id_cliente: 1 }, { id_venta: 2, total: 20, fecha_factura: "2026-07-24" }]),
    cobros_detalle: table([{ id_venta: 1, monto_cancelado: 50.25 }, { id_venta: 2, monto_cancelado: 20 }]),
    cheques_recibidos: table([{ id_cheque_recibido: 1, estado: "Pendiente", fecha_uso: "2026-08-01", monto: 30.25, id_cliente: 1 }]),
    cheques_entregados: table([{ id_cheque_entregado: 1, estado: "Pendiente", fecha_uso: "2026-08-08", monto: 40.5, id_acreedor: 1 }]),
    clientes: table([{ id_cliente: 1, nombre_cliente: "Cliente" }]),
    acreedores: table([{ id_acreedor: 1, acuerdo_de_pago: "Proveedor" }]),
    cobros: table()
  };
  const build = createCashflowService({
    backendCreditorDisplayName: (row) => row?.acuerdo_de_pago || "",
    backendCurrentDateIso: () => "2026-07-23",
    backendExpenseSupplierName: () => "Proveedor",
    backendId: id,
    backendIsoDate: isoDate,
    backendNormalizeText: normalize,
    backendNumber: number,
    backendObjectSum: (values) => values.reduce((total, value) => total + number(value), 0),
    backendRowsById: rowsById,
    loadCache: () => ({ tables })
  });
  const report = build();
  assert.deepEqual(report.cards, {
    banks: 100.25, cash: 50.5,
    debts: 60.5, receivable: 150.25, checksOnHand: 30.25, checksToCover: 40.5
  });
  assert.equal(report.groups.find((group) => group.type === "payable").amount, -60.5);
  assert.equal(report.groups.find((group) => group.type === "receivable").amount, 150.25);
  assert.equal(report.weeks.length, 4);
  assert.equal(report.visibleGroups.every((group) => group.week.number <= 4), true);
});

test("UI de cashflow aplica búsqueda y overrides sin mutar el reporte backend", () => {
  const source = fs.readFileSync(path.join(__dirname, "../assets/js/modules/reports-cashflow.js"), "utf8");
  const context = {
    CASHFLOW_START_ISO: "2026-07-23",
    state: { cashflowDateOverrides: { "key-1": "2026-08-06" } },
    ErpMoney: money,
    moneyToCents: money.toCents,
    centsToMoney: money.fromCents,
    normalizeMoney: money.normalize,
    formatDate: (value) => value,
    formatMoney: (value) => String(value),
    normalizeCategory: normalize,
    removeAccents: (value) => String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, ""),
    toIsoDate: (date) => date.toISOString().slice(0, 10)
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const report = { groups: [{ overrideKey: "key-1", type: "payable", label: "Pago", date: "2026-07-24", party: "Proveedor Azul", documentType: "Factura", documentNumber: "A-1", amount: -25, count: 1 }] };
  const before = JSON.stringify(report);
  const groups = context.buildBackendCashflowGroupsForUi(report);
  assert.equal(groups[0].date, "2026-08-06");
  assert.equal(context.cashflowGroupMatchesSearch(groups[0], "azul"), true);
  assert.equal(context.cashflowGroupMatchesSearch(groups[0], "inexistente"), false);
  assert.equal(JSON.stringify(report), before);
});

test("Dashboard usa el calendario anual y aísla un fallo de calendario", () => {
  const context = {
    payrollCalendarForYear: (year) => year === 2026
      ? { configured: true, dates: new Set(["2026-07-09"]) }
      : { configured: false, dates: new Set() },
    toIsoDate: (date) => date.toISOString().slice(0, 10)
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../assets/js/modules/dashboard.js"), "utf8"), context);

  assert.equal(context.isDashboardInventoryBusinessDay(new Date("2026-07-08T12:00:00Z")), true);
  assert.equal(context.isDashboardInventoryBusinessDay(new Date("2026-07-09T12:00:00Z")), false);
  assert.throws(
    () => context.isDashboardInventoryBusinessDay(new Date("2027-07-08T12:00:00Z")),
    /Calendario laboral no configurado para 2027/
  );

  const inventory = context.calculateDashboardWidget("dias sin inventario", () => {
    throw new Error("Calendario laboral no configurado para 2027.");
  });
  const checks = context.calculateDashboardWidget("cheques", () => [{ id: "1" }]);
  const purchases = context.calculateDashboardWidget("compras", () => [{ id: "2" }]);
  const orders = context.calculateDashboardWidget("pedidos", () => [{ id: "3" }]);
  assert.match(inventory.error, /2027/);
  assert.equal(checks.value.length, 1);
  assert.equal(purchases.value.length, 1);
  assert.equal(orders.value.length, 1);
});

test("Dashboard cuenta cobros con cheque sin registro recibido por id_cobro", () => {
  const widget = {
    hidden: false,
    attributes: {},
    classList: { toggle() {} },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
  };
  const context = {
    backendId: id,
    normalizeCategory: normalize,
    normalizeMoney: money.normalize,
    parseDate: (value) => value || null,
    formatDate: (value) => value ? value.split("-").reverse().join("/") : "",
    formatMoney: money.format,
    formatNumber: String,
    escapeHtml: String,
    displayNameLabel: (value) => String(value || "").replace(/_/g, " "),
    comparableLookupId: id,
    rowsByKey: (rows, key) => new Map((rows || []).filter((row) => id(row[key])).map((row) => [id(row[key]), row])),
    dashboardExpandedWidget: "",
    els: {
      "dashboard-received-checks-widget": widget,
      "dashboard-received-checks-count": { textContent: "" },
      "dashboard-received-checks-summary": { textContent: "" },
      "dashboard-received-checks-list": { innerHTML: "" }
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../assets/js/modules/received-check-entry.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../assets/js/modules/dashboard.js"), "utf8"), context);

  const collections = [
    { id_cobro: 1, fecha_cobro: "2026-07-03", metodo: "Cheque", id_cliente: 10, monto: 125.5 },
    { id_cobro: "1", fecha_cobro: "2026-07-04", metodo: "E-Cheq" },
    { id_cobro: 2, fecha_cobro: "", metodo: "e cheque", id_cliente: 999, monto: 0 },
    { id_cobro: 3, fecha_cobro: "2026-07-01", metodo: "Transferencia" },
    { id_cobro: "", fecha_cobro: "2026-07-01", metodo: "Cheque" }
  ];

  assert.deepEqual(
    Array.from(context.pendingReceivedCheckCollections(collections, []), (row) => id(row.id_cobro)),
    ["2", "1"]
  );
  assert.deepEqual(
    Array.from(
      context.pendingReceivedCheckCollections(collections, [
        { id_cheque_recibido: 10, id_cobro: 1 },
        { id_cheque_recibido: 11, id_cobro: 1 },
        { id_cheque_recibido: 12, id_cobro: "" }
      ]),
      (row) => id(row.id_cobro)
    ),
    ["2"]
  );
  assert.equal(
    context.pendingReceivedCheckCollections(collections, [
      { id_cheque_recibido: 10, id_cobro: 1 },
      { id_cheque_recibido: 11, id_cobro: 2 }
    ]).length,
    0
  );

  context.dashboardWidgetData = { pendingReceivedChecks: [], errors: {} };
  context.renderDashboardReceivedChecksWidget();
  assert.equal(widget.hidden, true);

  context.dashboardWidgetData = {
    pendingReceivedChecks: context.buildDashboardPendingReceivedChecks(
      collections,
      [{ id_cheque_recibido: 99, id_cobro: 999 }],
      [{ id_cliente: 10, nombre_cliente: "Cliente_Uno" }]
    ),
    errors: {}
  };
  context.renderDashboardReceivedChecksWidget();
  assert.equal(widget.hidden, false);
  assert.equal(context.els["dashboard-received-checks-count"].textContent, "2");
  assert.match(context.els["dashboard-received-checks-list"].innerHTML, /03\/07\/2026 · Cliente Uno/);
  assert.match(context.els["dashboard-received-checks-list"].innerHTML, /125,50/);
  assert.match(context.els["dashboard-received-checks-list"].innerHTML, /Sin fecha · Cliente no disponible/);
  assert.match(context.els["dashboard-received-checks-list"].innerHTML, /0,00/);
  assert.doesNotMatch(context.els["dashboard-received-checks-list"].innerHTML, /dashboard-mini-row/);
  assert.match(context.els["dashboard-received-checks-list"].innerHTML, /dashboard-plain-row/);
});

function upcomingPaymentPlanDashboardContext(overrides = {}) {
  const context = {
    normalizeCategory: normalize,
    parseDate: (value) => {
      const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!match) return null;
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const date = new Date(year, month - 1, day);
      return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
        ? `${match[1]}-${match[2]}-${match[3]}`
        : null;
    },
    toIsoDate: (date) => [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-"),
    moneyToCents: money.toCents,
    centsToMoney: money.fromCents,
    ...overrides
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../assets/js/modules/dashboard.js"), "utf8"), context);
  return context;
}

test("Dashboard selecciona, deduplica y agrupa cuotas impagas dentro de cinco días hábiles", () => {
  const context = upcomingPaymentPlanDashboardContext();
  const quota = (idValue, firstDate, firstAmount, overrides = {}) => ({
    id_cuota_plan_pago: idValue,
    nro_cuota: idValue,
    estado: "Pendiente",
    fecha_primer_vencimiento: firstDate,
    fecha_segundo_vencimiento: "2026-08-15",
    total_primer_vencimiento: firstAmount,
    total_segundo_vencimiento: firstAmount,
    plan_nombre: "Plan ARCA",
    ...overrides
  });
  const result = context.buildDashboardUpcomingPaymentPlanQuotas([
    quota("1", "2026-07-24", 100.01),
    quota("2", "2026-07-31", 200.02),
    quota("3", "2026-08-03", 300.03),
    quota("4", "2026-07-24", 400.04, { estado: "Pagada" }),
    quota("5", "2026-07-20", 120, {
      estado: "Segundo vencimiento",
      fecha_segundo_vencimiento: "2026-07-27",
      total_segundo_vencimiento: 125.03
    }),
    quota("6", "2026-07-20", 60, {
      estado: "Vencida",
      fecha_segundo_vencimiento: "2026-07-23"
    }),
    quota("7", "2026-07-25", 75.04),
    quota("8", "2026-07-27", "monto-invalido"),
    quota("9", "2026-99-99", 90),
    quota("11", "2026-07-28", ""),
    quota("12", "2026-07-29", 10000000000000),
    quota("2", "2026-07-24", 999.99),
    quota("10", "2026-07-27", 24.96)
  ], { todayIso: "2026-07-24", businessDays: 5 });

  assert.equal(result.windowEnd, "2026-07-31");
  assert.equal(result.count, 5);
  assert.equal(result.totalCents, 52506);
  assert.equal(result.totalAmount, 525.06);
  assert.equal(result.invalidCount, 4);
  assert.equal(result.quotas.filter((item) => item.id === "2").length, 1);
  assert.equal(result.quotas.find((item) => item.id === "5").dueDate, "2026-07-27");
  assert.equal(result.quotas.find((item) => item.id === "5").amountCents, 12503);
  assert.equal(result.groups.find((group) => group.date === "2026-07-27").count, 2);
  assert.equal(result.groups.find((group) => group.date === "2026-07-27").amountCents, 14999);
  assert.equal(result.groups.some((group) => group.date === "2026-08-03"), false);
});

test("Dashboard calcula fronteras hábiles 0, 5 y 6 sin consumir el fin de semana", () => {
  const context = upcomingPaymentPlanDashboardContext();
  assert.equal(context.dashboardAddBusinessDaysIso("2026-07-24", 0), "2026-07-24");
  assert.equal(context.dashboardAddBusinessDaysIso("2026-07-24", 5), "2026-07-31");
  assert.equal(context.dashboardAddBusinessDaysIso("2026-07-24", 6), "2026-08-03");
});

test("Dashboard controla desbordes en acumulados por fecha y total", () => {
  const context = upcomingPaymentPlanDashboardContext();
  const maximumSafeQuota = (idValue, firstDate) => ({
    id_cuota_plan_pago: idValue,
    nro_cuota: idValue,
    estado: "Pendiente",
    fecha_primer_vencimiento: firstDate,
    fecha_segundo_vencimiento: "2026-08-15",
    total_primer_vencimiento: "9999999999999.99",
    total_segundo_vencimiento: "9999999999999.99",
    plan_nombre: "Plan límite"
  });

  const sameDate = context.buildDashboardUpcomingPaymentPlanQuotas([
    maximumSafeQuota("safe-group-1", "2026-07-27"),
    maximumSafeQuota("safe-group-2", "2026-07-27")
  ], { todayIso: "2026-07-24", businessDays: 5 });
  assert.equal(sameDate.count, 1);
  assert.equal(sameDate.invalidCount, 1);
  assert.equal(sameDate.groups.length, 1);
  assert.equal(sameDate.groups[0].count, 1);
  assert.equal(sameDate.totalAmount, 9999999999999.99);

  const differentDates = context.buildDashboardUpcomingPaymentPlanQuotas([
    maximumSafeQuota("safe-total-1", "2026-07-27"),
    maximumSafeQuota("safe-total-2", "2026-07-28")
  ], { todayIso: "2026-07-24", businessDays: 5 });
  assert.equal(differentDates.count, 1);
  assert.equal(differentDates.invalidCount, 1);
  assert.equal(differentDates.groups.length, 1);
  assert.equal(differentDates.totalAmount, 9999999999999.99);
});

test("Dashboard consume el estado derivado y las cuotas completas del contrato de Planes de pago", async () => {
  const requests = [];
  const context = upcomingPaymentPlanDashboardContext({
    requestBackendApi: async (requestPath) => {
      requests.push(requestPath);
      if (requestPath === "/api/treasury/payment-plans") {
        return { plans: [{ id_plan_pago: "1" }, { id_plan_pago: "2" }] };
      }
      const planId = requestPath.split("/").pop();
      return {
        plan: {
          nombre: `Plan ${planId}`,
          organismo: "ARCA",
          cuotas: [{ id_cuota_plan_pago: planId, estado: planId === "1" ? "Pagada" : "Segundo vencimiento" }]
        }
      };
    }
  });

  const quotas = await context.loadDashboardPaymentPlanQuotas();
  assert.deepEqual(requests, [
    "/api/treasury/payment-plans",
    "/api/treasury/payment-plans/1",
    "/api/treasury/payment-plans/2"
  ]);
  assert.equal(quotas.length, 2);
  assert.equal(quotas[0].estado, "Pagada");
  assert.equal(quotas[1].estado, "Segundo vencimiento");
  assert.equal(quotas[1].plan_nombre, "Plan 2");
});

test("Dashboard expande cuotas próximas con detalle individual y colapsa sin contenido residual", () => {
  const classes = new Set();
  const widget = {
    attributes: {},
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      }
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
  };
  const list = {
    innerHTML: "",
    insertAdjacentHTML(_position, html) {
      this.innerHTML += html;
    }
  };
  const context = upcomingPaymentPlanDashboardContext({
    dashboardExpandedWidget: "",
    dashboardWidgetData: {
      upcomingPaymentPlanQuotas: {
        count: 3,
        totalAmount: 1234568040.1,
        invalidCount: 0,
        groups: [
          { date: "2026-07-27", count: 2, amount: 149.99 },
          { date: "2026-07-28", count: 1, amount: 1234567890.11 }
        ],
        quotas: [
          {
            id: "1",
            planName: "Plan ARCA",
            planAgency: "ARCA",
            quotaNumber: "1",
            status: "Pendiente",
            dueDate: "2026-07-27",
            amountCents: 10000
          },
          {
            id: "2",
            planName: "Plan ARCA",
            planAgency: "ARCA",
            quotaNumber: "2",
            status: "Segundo vencimiento",
            dueDate: "2026-07-27",
            amountCents: 4999
          },
          {
            id: "3",
            planName: "Plan AFIP",
            planAgency: "ARCA",
            quotaNumber: "12",
            status: "Pendiente",
            dueDate: "2026-07-28",
            amountCents: 123456789011
          }
        ]
      },
      errors: {}
    },
    formatDate: (value) => value.split("-").reverse().join("/"),
    formatMoney: money.format,
    formatNumber: String,
    escapeHtml: String,
    displayNameLabel: String,
    els: {
      "dashboard-payment-plans-widget": widget,
      "dashboard-payment-plans-count": { textContent: "" },
      "dashboard-payment-plans-summary": { textContent: "" },
      "dashboard-payment-plans-list": list
    }
  });

  context.renderDashboardPaymentPlansWidget();
  assert.equal(classes.has("is-expanded"), false);
  assert.equal(widget.attributes["aria-expanded"], "false");
  assert.match(list.innerHTML, /dashboard-plain-row/);
  assert.match(list.innerHTML, /27\/07\/2026 · 2 cuotas/);
  assert.doesNotMatch(list.innerHTML, /dashboard-payment-plan-quota/);
  assert.doesNotMatch(list.innerHTML, /dashboard-mini-row/);

  context.dashboardExpandedWidget = "paymentPlans";
  context.renderDashboardPaymentPlansWidget();
  assert.equal(classes.has("is-expanded"), true);
  assert.equal(widget.attributes["aria-expanded"], "true");
  assert.equal((list.innerHTML.match(/dashboard-payment-plan-quota/g) || []).length, 3);
  assert.match(list.innerHTML, /Plan ARCA · Cuota 1/);
  assert.match(list.innerHTML, /27\/07\/2026 · Segundo vencimiento/);
  assert.match(list.innerHTML, /Plan AFIP · ARCA · Cuota 12/);
  assert.match(list.innerHTML, /1\.234\.567\.890,11/);
  assert.doesNotMatch(list.innerHTML, /dashboard-mini-row/);

  context.dashboardExpandedWidget = "";
  context.renderDashboardPaymentPlansWidget();
  assert.equal(classes.has("is-expanded"), false);
  assert.doesNotMatch(list.innerHTML, /dashboard-payment-plan-quota/);

  context.dashboardWidgetData.upcomingPaymentPlanQuotas = {
    count: 0,
    totalAmount: 0,
    invalidCount: 0,
    groups: [],
    quotas: []
  };
  context.renderDashboardPaymentPlansWidget();
  assert.match(list.innerHTML, /dashboard-plain-empty/);
  assert.doesNotMatch(list.innerHTML, /dashboard-mini-row/);
});

test("Dashboard registra nodos, accesibilidad y eventos del widget de cuotas próximas", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../assets/js/app.js"), "utf8");
  const htmlSource = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  [
    "dashboard-payment-plans-widget",
    "dashboard-payment-plans-count",
    "dashboard-payment-plans-summary",
    "dashboard-payment-plans-list"
  ].forEach((idValue) => {
    assert.match(htmlSource, new RegExp(`id="${idValue}"`));
    assert.match(appSource, new RegExp(`"${idValue}"`));
  });
  assert.match(
    htmlSource,
    /id="dashboard-payment-plans-widget" role="button" tabindex="0" aria-expanded="false"/
  );
  assert.match(
    appSource,
    /dashboard-payment-plans-widget"\]\?\.addEventListener\("click", \(\) => toggleDashboardWidget\("paymentPlans"\)\)/
  );
  assert.match(
    appSource,
    /dashboard-payment-plans-widget"\]\?\.addEventListener\("keydown", \(event\) => activateDashboardWidgetFromKeyboard\(event, "paymentPlans"\)\)/
  );
});

test("Dashboard muestra la fotografia fija de insumos a comprar y oculta el estado vacio", () => {
  const classes = new Set();
  const widget = {
    hidden: true,
    attributes: {},
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => force ? classes.add(name) : classes.delete(name)
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
  };
  const context = {
    dashboardExpandedWidget: "",
    dashboardWidgetData: {
      inventoryPurchaseSnapshot: {
        inventoryDate: "2026-07-20",
        items: [{
          itemName: "Azucar premium con nombre muy largo <script>",
          stock: 2.5,
          unit: "Kg",
          daysRemaining: 0.0352
        }]
      },
      errors: {}
    },
    displayNameLabel: (value) => String(value || "").replace(/_/g, " "),
    displayUnitLabel: (value) => String(value || "").replace(/_/g, " "),
    escapeHtml: (value) => String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;"),
    formatDate: (value) => value.split("-").reverse().join("/"),
    formatNumber: (value) => new Intl.NumberFormat("es-AR", { maximumFractionDigits: 4 }).format(value),
    els: {
      "dashboard-inventory-purchases-widget": widget,
      "dashboard-inventory-purchases-count": { textContent: "" },
      "dashboard-inventory-purchases-summary": { textContent: "" },
      "dashboard-inventory-purchases-list": { innerHTML: "" }
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../assets/js/modules/dashboard.js"), "utf8"), context);
  assert.equal(context.dashboardInventoryMeasurementLabel(0.0352), "0,0352");
  assert.equal(context.dashboardInventoryMeasurementLabel(0.0000000012345), "0,0000000012345");
  assert.equal(context.dashboardInventoryMeasurementLabel(12345.6789), "12.345,6789");

  context.renderDashboardInventoryPurchasesWidget();
  assert.equal(widget.hidden, false);
  assert.equal(widget.attributes["aria-expanded"], "false");
  assert.equal(context.els["dashboard-inventory-purchases-count"].textContent, "1");
  assert.match(context.els["dashboard-inventory-purchases-summary"].textContent, /20\/07\/2026/);
  assert.equal(context.els["dashboard-inventory-purchases-list"].innerHTML, "");
  assert.equal(classes.has("is-warning"), true);

  context.dashboardWidgetData.inventoryPurchaseSnapshot.items.push(
    {
      itemName: "Aceite",
      stock: 0,
      unit: "Lt",
      daysRemaining: 0
    },
    {
      itemName: "Caja 140",
      stock: 1234.75,
      unit: "Pack_25_Ud",
      daysRemaining: 12345.6789
    }
  );
  context.dashboardExpandedWidget = "inventoryPurchases";
  context.renderDashboardInventoryPurchasesWidget();
  assert.equal(classes.has("is-expanded"), true);
  assert.equal(widget.attributes["aria-expanded"], "true");
  assert.equal(context.els["dashboard-inventory-purchases-count"].textContent, "3");
  assert.match(context.els["dashboard-inventory-purchases-summary"].textContent, /3 insumos a comprar/);
  assert.match(context.els["dashboard-inventory-purchases-list"].innerHTML, /2,5 Kg/);
  assert.match(context.els["dashboard-inventory-purchases-list"].innerHTML, /0,0352 dias/);
  assert.match(context.els["dashboard-inventory-purchases-list"].innerHTML, /0 Lt/);
  assert.match(context.els["dashboard-inventory-purchases-list"].innerHTML, /0 dias/);
  assert.match(context.els["dashboard-inventory-purchases-list"].innerHTML, /1\.234,75 Pack 25 Ud/);
  assert.match(context.els["dashboard-inventory-purchases-list"].innerHTML, /12\.345,6789 dias/);
  assert.match(context.els["dashboard-inventory-purchases-list"].innerHTML, /&lt;script&gt;/);

  context.dashboardWidgetData = {
    inventoryPurchaseSnapshot: { inventoryDate: "2026-07-21", items: [] },
    errors: {}
  };
  context.renderDashboardInventoryPurchasesWidget();
  assert.equal(widget.hidden, true);
  assert.equal(widget.attributes["aria-expanded"], "false");
});

test("Dashboard registra el widget de insumos y consume solo el contrato de fotografia", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../assets/js/app.js"), "utf8");
  const dashboardSource = fs.readFileSync(path.join(__dirname, "../assets/js/modules/dashboard.js"), "utf8");
  const htmlSource = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  [
    "dashboard-inventory-purchases-widget",
    "dashboard-inventory-purchases-count",
    "dashboard-inventory-purchases-summary",
    "dashboard-inventory-purchases-list"
  ].forEach((idValue) => {
    assert.match(htmlSource, new RegExp(`id="${idValue}"`));
    assert.match(appSource, new RegExp(`"${idValue}"`));
  });
  assert.match(
    htmlSource,
    /id="dashboard-inventory-purchases-widget" role="button" tabindex="0" aria-expanded="false"/
  );
  assert.match(dashboardSource, /\/api\/inventory\/purchase-snapshot/);
  assert.doesNotMatch(dashboardSource, /dailyConsumptionForItem|DAILY_CONSUMPTION_BY_ITEM/);
});

test("Compras muestra la misma fotografia sin limitar el selector libre", () => {
  const selector = { value: "Aceite" };
  const context = {
    els: {
      "purchase-inventory-suggestions-count": { textContent: "" },
      "purchase-inventory-suggestions-status": { textContent: "" },
      "purchase-inventory-suggestions-list": { innerHTML: "" },
      "purchase-item-name": selector
    },
    displayNameLabel: (value) => String(value || "").replace(/_/g, " "),
    displayUnitLabel: (value) => String(value || "").replace(/_/g, " "),
    escapeHtml: (value) => String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;"),
    formatDate: (value) => value.split("-").reverse().join("/"),
    formatNumber: String,
    Intl
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../assets/js/modules/purchase-entry.js"), "utf8"), context);

  const snapshot = {
    inventoryDate: "2026-07-20",
    items: [
      { itemName: "Azucar <script>", stock: 2.5, unit: "Kg", daysRemaining: 0.0352 },
      { itemName: "Aceite", stock: 0, unit: "Lt", daysRemaining: 0 }
    ]
  };
  context.renderPurchaseInventorySuggestions(snapshot);

  assert.equal(selector.value, "Aceite");
  assert.equal(context.els["purchase-inventory-suggestions-count"].textContent, "2");
  assert.match(context.els["purchase-inventory-suggestions-status"].textContent, /20\/07\/2026/);
  assert.match(context.els["purchase-inventory-suggestions-status"].textContent, /selector de insumos permanece libre/i);
  assert.match(context.els["purchase-inventory-suggestions-list"].innerHTML, /2,5 Kg/);
  assert.match(context.els["purchase-inventory-suggestions-list"].innerHTML, /0,0352 dias de produccion/);
  assert.match(context.els["purchase-inventory-suggestions-list"].innerHTML, /0 Lt/);
  assert.match(context.els["purchase-inventory-suggestions-list"].innerHTML, /&lt;script&gt;/);

  context.renderPurchaseInventorySuggestions({ inventoryDate: "2026-07-21", items: [] });
  assert.equal(selector.value, "Aceite");
  assert.match(context.els["purchase-inventory-suggestions-list"].innerHTML, /No hay insumos a comprar/);
});

test("Compras registra la lista superior y lee la fotografia canonica", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../assets/js/app.js"), "utf8");
  const purchaseSource = fs.readFileSync(path.join(__dirname, "../assets/js/modules/purchase-entry.js"), "utf8");
  const htmlSource = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  [
    "purchase-inventory-suggestions-count",
    "purchase-inventory-suggestions-status",
    "purchase-inventory-suggestions-list"
  ].forEach((idValue) => {
    assert.match(htmlSource, new RegExp(`id="${idValue}"`));
    assert.match(appSource, new RegExp(`"${idValue}"`));
  });
  assert.match(purchaseSource, /requestBackendApi\("\/api\/inventory\/purchase-snapshot"\)/);
  assert.doesNotMatch(purchaseSource, /InventoryPurchaseEvaluation|DAILY_CONSUMPTION_BY_ITEM/);
  assert.match(purchaseSource, /inventoryPurchaseSnapshotItem/);
});

test("Inventario usa los mismos items de la fotografia sin recalcular umbrales", () => {
  const classes = new Set();
  const button = { dataset: {} };
  const alert = {
    hidden: true,
    title: "",
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      }
    },
    querySelector(selector) {
      return selector === "button" ? button : null;
    }
  };
  const row = {
    dataset: { itemId: "101", itemName: "Azucar" },
    querySelector(selector) {
      return selector === "[data-purchase-alert]" ? alert : null;
    }
  };
  const context = {
    inventoryPurchaseSnapshot: {
      inventoryDate: "2026-07-20",
      items: [{
        itemId: "101",
        itemName: "Azucar",
        stock: 2.5,
        unit: "Kg",
        daysRemaining: 0.0352,
        required: 284.0838,
        dailyConsumption: 71.02095,
        provider: "Proveedor Uno",
        leadDays: 5,
        businessDays: 4
      }]
    },
    els: {
      "inventory-detail-body": { querySelectorAll: () => [row] },
      "purchase-threshold-body": { innerHTML: "" },
      "purchase-threshold-snapshot-date": { textContent: "" }
    },
    normalizeCategory: (value) => String(value || "").toLowerCase(),
    displayNameLabel: String,
    displayUnitLabel: String,
    escapeHtml: String,
    formatDate: (value) => value.split("-").reverse().join("/"),
    formatNumber: (value) => String(value),
    formatNullableNumber: (value) => String(value),
    emptyRow: (_columns, message) => message,
    Intl
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../assets/js/modules/purchase-entry.js"), "utf8"), context);
  context.updateInventoryPurchaseAlerts();

  assert.equal(alert.hidden, false);
  assert.equal(classes.has("is-visible"), true);
  assert.equal(button.dataset.purchaseItem, "Azucar");
  assert.equal(button.dataset.purchaseItemId, "101");
  assert.match(alert.title, /Stock: 2.5/);
  assert.match(context.els["purchase-threshold-snapshot-date"].textContent, /20\/07\/2026/);
  assert.match(context.els["purchase-threshold-body"].innerHTML, /2,5 Kg/);
  assert.match(context.els["purchase-threshold-body"].innerHTML, /Comprar/);

  const purchaseSource = fs.readFileSync(path.join(__dirname, "../assets/js/modules/purchase-entry.js"), "utf8");
  assert.doesNotMatch(purchaseSource, /inventoryPurchaseAlert|inventoryPurchaseMetrics|DAILY_CONSUMPTION_BY_ITEM/);
  assert.match(purchaseSource, /renderPurchaseThresholdTable\(snapshotItems\)/);
});
