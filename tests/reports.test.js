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
