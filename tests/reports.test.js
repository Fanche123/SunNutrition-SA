const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const money = require("../shared/money");

const { createCashflowService } = require("../backend/services/cashflow.service");
const { createCoreHandlers } = require("../backend/services/core-handlers.service");
const { createExpenseClassificationService } = require("../backend/services/expense-classification.service");
const { createIncomeCalculationService } = require("../backend/services/income-calculation.service");
const { createIncomeStatementService } = require("../backend/services/income-statement.service");
const { createPayrollSummaryService } = require("../backend/services/payroll-summary.service");

test("Producción presenta unidades individuales y estados de conversión legibles", () => {
  const source = fs.readFileSync(path.join(__dirname, "../assets/js/modules/reports-production.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.match(html, /<th class="num">Unidades individuales<\/th>/);
  assert.match(source, /individualConversionStatus === "available"/);
  assert.match(source, /Factor no disponible/);
  assert.match(source, /No aplica/);
  assert.match(source, /No hubo producción positiva para el período/);
<<<<<<< ours
<<<<<<< ours
=======
  assert.match(source, /daily\.length} totales diarios con producción positiva/);
>>>>>>> theirs
=======
  assert.match(source, /daily\.length} totales diarios con producción positiva/);
>>>>>>> theirs
});

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
    "proveedores", "fletes", "empleados", "acreedores", "gastos_economicos",
    "cuotas_planes_pagos", "planes_pagos", "fondos_inversion_movimientos",
    "movimientos_bancarios", "otros_acreedores"
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
  const buildReport = reportHarness(tables);
  const report = buildReport(2026, 6);
  assert.equal(report.initialInventory.value, 100);
  assert.equal(report.finalInventory.value, 40);
  assert.equal(report.costOfSales.merchandise, 60);
  const merchandise = buildReport.buildDetail(2026, 6, "cost.merchandise");
  assert.equal(merchandise.count, 2);
  assert.equal(merchandise.total, report.costOfSales.merchandise);
  assert.equal(merchandise.rows.some((row) => /Inventario inicial/.test(row.reference)), true);
  assert.equal(merchandise.rows.some((row) => /Inventario final/.test(row.reference) && row.amount === -40), true);
});

test("Estado de Resultados usa gastos economicos confirmados y deriva el mes de la fecha", () => {
  const tables = emptyReportTables();
  tables.ventas.rows.push({ id_venta: 1, id_entrega: 1, fecha_factura: "2026-07-10", subtotal: 1000, id_cliente: 1, id_pedido: 1, tipo_factura: "Factura_A" });
  tables.entregas.rows.push({ id_entrega: "1", fecha: "2026-07-10" });
  tables.clientes.rows.push({ id_cliente: 1, nombre_cliente: "Cliente", id_canal: 1 });
  tables.canales.rows.push({ id_canal: 1, comision: 5 });
  tables.pedidos.rows.push({ id_pedido: 1, id_cliente: 1, fecha_entrega: "2026-07-10" });
  tables.productos.rows.push({ id_producto: 1, cantidad_individual: 10 });
  tables.detalle_pedidos.rows.push({ id_pedido: 1, id_producto: 1, cantidad_cajas: 2 });
  tables.etiquetas.rows.push(
    { id_etiqueta: 1, etiqueta: "Mercaderia" },
    { id_etiqueta: 2, etiqueta: "Categoria nueva" },
    { id_etiqueta: 3, etiqueta: "Sueldos" },
    { id_etiqueta: 4, etiqueta: "Comisiones" },
    { id_etiqueta: 5, etiqueta: "Ingresos Brutos" }
  );
  tables.egresos.rows.push({ id_egreso: 1, subtotal: 200 }, { id_egreso: 2, subtotal: 30 });
  tables.recepciones.rows.push(
    { id_recepcion: 1, id_egreso: 1, fecha_recepcion: "2026-07-12", _etiqueta_gasto: "Mercaderia" },
    { id_recepcion: 2, id_egreso: 2, fecha_recepcion: "2026-07-13", _etiqueta_gasto: "Categoria nueva" }
  );
  tables.sueldos.rows.push({ id_sueldo: 1, fecha: "2026-07-20", id_empleado: 1, sueldo_bruto: 300, hs_trabajadas: 8, hs_extra: 2 });
  tables.gastos_economicos.rows.push(
    { id_gasto_economico: 1, fecha_economica: "2026-07-12", id_etiqueta: 1, importe: 200, estado: "confirmado" },
    { id_gasto_economico: 2, fecha_economica: "2026-07-13", id_etiqueta: 2, importe: 30, estado: "confirmado" },
    { id_gasto_economico: 3, fecha_economica: "2026-07-20", id_etiqueta: 3, importe: 300, estado: "confirmado" },
    { id_gasto_economico: 4, fecha_economica: "2026-07-15", id_etiqueta: 4, importe: 40, estado: "confirmado" },
    { id_gasto_economico: 5, fecha_economica: "2026-07-18", id_etiqueta: 1, importe: 999, estado: "borrador" },
    { id_gasto_economico: 6, fecha_economica: "2026-08-01", id_etiqueta: 1, importe: 999, estado: "confirmado" },
    { id_gasto_economico: 7, fecha_economica: "2026-07-16", id_etiqueta: 5, importe: 17, estado: "confirmado" }
  );
  const report = reportHarness(tables)(2026, 6);
  assert.equal(report.salesNet, 1000);
  assert.equal(report.unitsSold, 20);
  assert.equal(report.costOfSales.merchandisePurchases, 200);
  assert.equal(report.costOfSales.commissions, 40);
  assert.equal(report.costOfSales.grossRevenueTax, 17);
  assert.equal(report.operatingExpenses.salaries, 300);
  assert.equal(report.payroll.totalHours, 10);
  assert.equal(report.uncategorized.length, 1);
});

test("Estado de Resultados imputa ventas solo por fecha de entrega sin duplicarlas", () => {
  const tables = emptyReportTables();
  tables.ventas.rows.push(
    { id_venta: 1, id_entrega: "10", fecha_factura: "2026-03-28", subtotal: 100, total: 121, id_cliente: 1, id_pedido: 1 },
    { id_venta: 2, id_entrega: 20, fecha_factura: "2026-04-10", subtotal: 200, total: 242, id_cliente: 2, id_pedido: 2 },
    { id_venta: 3, id_entrega: 30, fecha_factura: "2026-04-12", subtotal: 300, total: 363, id_cliente: 3, id_pedido: 3 },
    { id_venta: 3, id_entrega: 30, fecha_factura: "2026-04-12", subtotal: 999, total: 999, id_cliente: 3, id_pedido: 3 },
    { id_venta: 4, fecha_factura: "2026-04-13", subtotal: 400, total: 484, id_cliente: 4, id_pedido: 4 },
    { id_venta: 5, id_entrega: 999, fecha_factura: "2026-04-14", subtotal: 500, total: 605, id_cliente: 5, id_pedido: 5 },
    { id_venta: 6, id_entrega: 40, fecha_factura: "2026-04-15", subtotal: 600, total: 726, id_cliente: 6, id_pedido: 6 },
    { id_venta: 7, id_entrega: "50", fecha_factura: "2026-04-16", subtotal: 7.25, total: 999, id_cliente: 7, id_pedido: 7 },
    { id_venta: 8, id_entrega: 50, fecha_factura: "2026-04-17", subtotal: 8.75, total: 999, id_cliente: 8, id_pedido: 8 }
  );
  tables.entregas.rows.push(
    { id_entrega: 10, fecha: "2026-04-02" },
    { id_entrega: "20", fecha: "2026-05-03" },
    { id_entrega: "30", fecha: "2026-04-12" },
    { id_entrega: "40", fecha: "2026-04-31" },
    { id_entrega: 50, fecha: "2026-04-20" }
  );
  for (let value = 1; value <= 8; value += 1) {
    tables.clientes.rows.push({ id_cliente: value, nombre_cliente: `Cliente ${value}` });
    tables.pedidos.rows.push({ id_pedido: value, id_cliente: value });
    tables.productos.rows.push({ id_producto: value, cantidad_individual: 1 });
    tables.detalle_pedidos.rows.push({ id_pedido: value, id_producto: value, cantidad_cajas: 1 });
  }

  const march = reportHarness(tables)(2026, 2);
  const april = reportHarness(tables)(2026, 3);
  const may = reportHarness(tables)(2026, 4);

  assert.equal(march.salesNet, 0);
  assert.equal(april.salesNet, 416);
  assert.equal(may.salesNet, 200);
  assert.equal(april.unitsSold, 4);
  assert.equal(april.customerCount, 4);
  assert.deepEqual(
    april.salesDateIssues,
    [
      { id_venta: "4", id_entrega: "", reason: "missing_delivery_id" },
      { id_venta: "5", id_entrega: "999", reason: "delivery_not_found" },
      { id_venta: "6", id_entrega: "40", reason: "invalid_delivery_date" }
    ]
  );
});

test("Estado de Resultados no reconstruye IIBB desde ventas en ningun periodo", () => {
  const tables = emptyReportTables();
  tables.ventas.rows.push({
    id_venta: 1,
    fecha_factura: "2026-07-10",
    subtotal: 1000,
    tipo_factura: "Factura_A"
  });
  const report = reportHarness(tables)(2026, 6);
  assert.equal(report.costOfSales.grossRevenueTax, 0);
});

test("Estado de Resultados no reconstruye gastos de productores en ningun periodo", () => {
  const tables = emptyReportTables();
  tables.egresos.rows.push(
    { id_egreso: 1, subtotal: 200 },
    { id_egreso: 2, subtotal: 30 },
    { id_egreso: 3, subtotal: 40 },
    { id_egreso: 4, subtotal: 50 }
  );
  tables.recepciones.rows.push({
    id_recepcion: 1,
    id_egreso: 1,
    fecha_recepcion: "2026-03-12",
    _etiqueta_gasto: "Mercaderia"
  });
  tables.sueldos.rows.push({
    id_sueldo: 1,
    fecha: "2026-03-20",
    sueldo_bruto: 300,
    hs_trabajadas: 8
  });
  tables.otros_gastos.rows.push({
    id_otros_gastos: 1,
    fecha_otros_gastos: "2026-03-14",
    id_egreso: 2,
    id_acreedor_etiqueta: 3
  });
  tables.entregas.rows.push({
    id_entrega: 1,
    fecha: "2026-03-15",
    id_egreso: 3,
    id_acreedor_etiqueta: 4
  });
  tables.comisiones.rows.push({
    id_comision: 1,
    fecha: "2026-03-16",
    id_egreso: 4,
    id_acreedor_etiqueta: 5,
    comision: 50
  });
  tables.cuotas_planes_pagos.rows.push({
    id_cuota_plan_pago: 1,
    fecha_primer_vencimiento: "2026-03-16",
    interes_financiero: 60,
    id_egreso: 4
  });
  tables.etiquetas.rows.push(
    { id_etiqueta: 3, etiqueta: "Servicios" },
    { id_etiqueta: 4, etiqueta: "Logistica" },
    { id_etiqueta: 5, etiqueta: "Comisiones" }
  );
  tables.acreedores_etiquetas.rows.push(
    { id_acreedor_etiqueta: 3, id_etiqueta: 3 },
    { id_acreedor_etiqueta: 4, id_etiqueta: 4 },
    { id_acreedor_etiqueta: 5, id_etiqueta: 5 }
  );
  const withoutEconomicExpenses = reportHarness(tables)(2026, 2);
  assert.equal(withoutEconomicExpenses.costOfSales.merchandisePurchases, 0);
  assert.equal(withoutEconomicExpenses.costOfSales.commissions, 0);
  assert.equal(withoutEconomicExpenses.costOfSales.logistics, 0);
  assert.equal(withoutEconomicExpenses.operatingExpenses.salaries, 0);
  assert.equal(withoutEconomicExpenses.operatingExpenses.services, 0);
  assert.equal(withoutEconomicExpenses.uncategorized.length, 0);
  assert.equal(withoutEconomicExpenses.payroll.totalHours, 8);

  tables.etiquetas.rows.push(
    { id_etiqueta: 1, etiqueta: "Mercaderia" },
    { id_etiqueta: 2, etiqueta: "Sueldos" },
    { id_etiqueta: 7, etiqueta: "Impuestos Internos" }
  );
  tables.gastos_economicos.rows.push(
    { id_gasto_economico: 1, fecha_economica: "2026-03-12", id_etiqueta: 1, importe: 125, estado: "confirmado" },
    { id_gasto_economico: 2, fecha_economica: "2026-03-20", id_etiqueta: 2, importe: 250, estado: "confirmado" },
    { id_gasto_economico: 3, fecha_economica: "2026-03-31", id_etiqueta: 7, importe: 12.34, estado: "confirmado" }
  );
  const withEconomicExpenses = reportHarness(tables)(2026, 2);
  assert.equal(withEconomicExpenses.costOfSales.merchandisePurchases, 125);
  assert.equal(withEconomicExpenses.operatingExpenses.salaries, 250);
  assert.equal(withEconomicExpenses.totalCostOfSales, 125);
  assert.equal(withEconomicExpenses.totalOperatingExpenses, 250);
  assert.equal(withEconomicExpenses.nonOperatingExpenses.otherTaxes, 12.34);
});

test("Detalle del Estado de Resultados concilia movimientos, contrapartes, reversiones y ventas por entrega", () => {
  const tables = emptyReportTables();
  tables.etiquetas.rows.push(
    { id_etiqueta: 1, etiqueta: "Sueldos" },
    { id_etiqueta: 2, etiqueta: "Servicios" },
    { id_etiqueta: 3, etiqueta: "Intereses" },
    { id_etiqueta: 4, etiqueta: "Comisiones" },
    { id_etiqueta: 5, etiqueta: "Logistica" },
    { id_etiqueta: 6, etiqueta: "Gastos Bancarios" }
  );
  tables.empleados.rows.push({ id_empleado: 1, nombre_empleado: "Empleada Ana", dni: "30111222" });
  tables.sueldos.rows.push({ id_sueldo: 100, id_empleado: 1, fecha: "2026-04-30", sueldo_neto: 1000 });
  tables.proveedores.rows.push({ id_proveedor: 300, nombre: "Proveedor Norte", cuit: "30-11111111-1" });
  tables.acreedores.rows.push({
    id_acreedor: 1,
    origen_tipo_acreedor: "proveedor",
    origen_id_acreedor: 300
  });
  tables.otros_gastos.rows.push({
    id_otros_gastos: 200,
    id_acreedor: 1,
    detalle: "Internet abril",
    fecha_otros_gastos: "2026-04-10"
  });
  tables.planes_pagos.rows.push({ id_plan_pago: 1, nombre: "Plan 2026", organismo: "AFIP" });
  tables.cuotas_planes_pagos.rows.push({
    id_cuota_plan_pago: 400,
    id_plan_pago: 1,
    nro_cuota: 2,
    interes_financiero: 60,
    interes_resarcitorio: 5
  });
  tables.clientes.rows.push({
    id_cliente: 20,
    nombre_cliente: "Cliente Entregado",
    id_canal: 10,
    tipo: "Comercio"
  });
  tables.canales.rows.push({ id_canal: 10, nombre: "Canal Online" });
  tables.ventas.rows.push({
    id_venta: 500,
    id_entrega: 500,
    id_cliente: 20,
    fecha_factura: "2026-03-28",
    tipo_factura: "Factura_A",
    nro_factura: "A-500",
    subtotal: 200
  });
  tables.fletes.rows.push({ id_flete: 9, nombre_flete: "Flete Sur" });
  tables.entregas.rows.push(
    { id_entrega: 500, fecha: "2026-04-05" },
    { id_entrega: 501, fecha: "2026-04-06", id_flete: 9 }
  );
  tables.gastos_economicos.rows.push(
    {
      id_gasto_economico: 1,
      fecha_economica: "2026-04-30",
      id_etiqueta: 1,
      concepto: "Sueldo neto abril",
      tipo_movimiento: "original",
      importe: 1000,
      estado: "confirmado",
      origen_tipo: "sueldo",
      origen_id: 100
    },
    {
      id_gasto_economico: 2,
      fecha_economica: "2026-04-10",
      id_etiqueta: 2,
      concepto: "Servicio de internet",
      tipo_movimiento: "original",
      importe: 100,
      estado: "confirmado",
      origen_tipo: "otro_gasto",
      origen_id: 200
    },
    {
      id_gasto_economico: 3,
      fecha_economica: "2026-04-11",
      id_etiqueta: 2,
      concepto: "Servicio sin vinculo",
      tipo_movimiento: "original",
      importe: 50,
      estado: "confirmado",
      origen_tipo: "fixture_sin_vinculo",
      origen_id: 999
    },
    {
      id_gasto_economico: 4,
      fecha_economica: "2026-04-12",
      id_etiqueta: 2,
      concepto: "Reversion servicio",
      tipo_movimiento: "reversion",
      motivo: "Correccion",
      importe: -25,
      estado: "confirmado",
      origen_tipo: "fixture_sin_vinculo",
      origen_id: 999
    },
    {
      id_gasto_economico: 5,
      fecha_economica: "2026-04-15",
      id_etiqueta: 3,
      concepto: "Interes financiero cuota",
      tipo_movimiento: "original",
      importe: 60,
      estado: "confirmado",
      origen_tipo: "plan_pago",
      origen_id: 400
    },
    {
      id_gasto_economico: 6,
      fecha_economica: "2026-04-20",
      id_etiqueta: 3,
      concepto: "Interes resarcitorio cuota",
      tipo_movimiento: "ajuste",
      importe: 5,
      estado: "confirmado",
      origen_tipo: "plan_pago",
      origen_id: 400
    },
    {
      id_gasto_economico: 7,
      fecha_economica: "2026-04-05",
      id_etiqueta: 4,
      concepto: "Comision venta",
      tipo_movimiento: "original",
      importe: 20,
      estado: "confirmado",
      origen_tipo: "comision_venta",
      origen_id: 500
    },
    {
      id_gasto_economico: 8,
      fecha_economica: "2026-04-06",
      id_etiqueta: 5,
      concepto: "Logistica entrega",
      tipo_movimiento: "original",
      importe: 30,
      estado: "confirmado",
      origen_tipo: "logistica",
      origen_id: 501
    },
    {
      id_gasto_economico: 9,
      fecha_economica: "2026-04-08",
      id_etiqueta: 6,
      concepto: "Comision bancaria",
      tipo_movimiento: "original",
      importe: 15,
      estado: "confirmado",
      origen_tipo: "movimiento_bancario",
      origen_id: 1
    },
    {
      id_gasto_economico: 10,
      fecha_economica: "2026-04-09",
      id_etiqueta: 6,
      concepto: "Reversion comision bancaria",
      tipo_movimiento: "reversion",
      importe: -15,
      estado: "confirmado",
      origen_tipo: "movimiento_bancario",
      origen_id: 2
    }
  );

  const buildReport = reportHarness(tables);
  const report = buildReport(2026, 3);
  const detail = (key, pagination) => buildReport.buildDetail(2026, 3, key, pagination);

  const salaries = detail("operating.salaries");
  assert.equal(salaries.count, 1);
  assert.equal(salaries.rows[0].counterparty, "Empleada Ana");
  assert.equal(salaries.rows[0].date, "2026-04-30");
  assert.equal(salaries.rows[0].amount, 1000);

  const services = detail("operating.services");
  assert.equal(services.count, 3);
  assert.equal(services.rows[0].counterparty, "Proveedor Norte");
  assert.equal(services.rows.some((row) => !row.counterparty), true);
  assert.equal(services.rows.find((row) => row.amount < 0).amount, -25);

  const interests = detail("nonOperating.interest");
  assert.equal(interests.count, 2);
  assert.equal(interests.rows.every((row) => row.counterparty === "AFIP"), true);
  assert.equal(interests.total, report.nonOperatingExpenses.interest);

  const commissions = detail("cost.commissions");
  const logistics = detail("cost.logistics");
  assert.equal(commissions.rows[0].counterparty, "Canal Online");
  assert.equal(logistics.rows[0].counterparty, "Flete Sur");

  const bankFees = detail("nonOperating.bankFees");
  assert.equal(bankFees.count, 2);
  assert.equal(bankFees.total, 0);
  assert.equal(report.detailCounts["nonOperating.bankFees"], 2);

  const sales = detail("sales.other");
  assert.equal(sales.count, 1);
  assert.equal(sales.rows[0].counterparty, "Cliente Entregado");
  assert.equal(sales.rows[0].date, "2026-04-05");
  assert.equal(sales.rows[0].amount, 200);
  assert.match(sales.rows[0].reference, /A-500/);

  [
    ["operating.salaries", report.operatingExpenses.salaries],
    ["operating.services", report.operatingExpenses.services],
    ["nonOperating.interest", report.nonOperatingExpenses.interest],
    ["cost.commissions", report.costOfSales.commissions],
    ["cost.logistics", report.costOfSales.logistics],
    ["nonOperating.bankFees", report.nonOperatingExpenses.bankFees],
    ["sales.other", report.salesBuckets.other]
  ].forEach(([key, expectedTotal]) => {
    const result = detail(key);
    assert.equal(
      result.rows.reduce((sum, row) => sum + money.toCents(row.amount), 0),
      money.toCents(expectedTotal),
      key
    );
    assert.equal(result.reconciled, true);
  });

  const firstServicePage = detail("operating.services", { offset: 0, limit: 1 });
  assert.equal(firstServicePage.rows.length, 1);
  assert.equal(firstServicePage.count, 3);
  assert.equal(firstServicePage.total, report.operatingExpenses.services);
  assert.equal(firstServicePage.hasMore, true);
});

test("API de detalle rechaza conceptos no permitidos sin exponer filas", () => {
  const buildReport = reportHarness(emptyReportTables());
  const handlers = createCoreHandlers({
    buildBackendIncomeStatementDetail: buildReport.buildDetail,
    sendJson(response, status, payload) {
      response.status = status;
      response.payload = payload;
    }
  });
  const response = {};
  handlers.handleIncomeStatementDetail({
    url: "/api/reports/income-statement/detail?year=2026&month=3&concept=Servicios%27%20OR%201%3D1",
    headers: { host: "127.0.0.1" }
  }, response);

  assert.equal(response.status, 400);
  assert.equal(response.payload.code, "INCOME_STATEMENT_CONCEPT_INVALID");
  assert.equal(response.payload.detail, undefined);
  assert.equal(response.payload.report, undefined);
});

test("UI del detalle es lazy, accesible y se cierra al cambiar periodo o comparacion", () => {
  const reportSource = fs.readFileSync(path.join(__dirname, "../assets/js/modules/reports-cashflow.js"), "utf8");
  const appSource = fs.readFileSync(path.join(__dirname, "../assets/js/app.js"), "utf8");
  const htmlSource = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const stylesSource = fs.readFileSync(path.join(__dirname, "../assets/css/styles.css"), "utf8");

  assert.match(reportSource, /\/api\/reports\/income-statement\/detail\?/);
  assert.doesNotMatch(reportSource.slice(0, reportSource.indexOf("async function loadBackendCashflowReport")), /income-statement\/detail/);
  assert.match(reportSource, /data-statement-concept=/);
  assert.match(reportSource, /aria-controls="statement-detail-panel"/);
  assert.match(reportSource, /aria-expanded="false"/);
  assert.match(reportSource, /Sin contraparte vinculada/);
  assert.match(reportSource, /displayNameLabel\(row\.counterparty\)/);
  assert.match(reportSource, /visibleTotalCents !== moneyToCents\(detail\.total\)/);
  assert.match(htmlSource, /id="statement-detail-panel"[^>]*aria-live="polite"[^>]*tabindex="-1"/);
  assert.match(htmlSource, /id="statement-detail-close"/);
  assert.match(appSource, /period-select"[\s\S]*?closeIncomeStatementDetail\(\{ restoreFocus: false \}\)[\s\S]*?render\(\)/);
  assert.match(appSource, /comparison-select"[\s\S]*?closeIncomeStatementDetail\(\{ restoreFocus: false \}\)[\s\S]*?render\(\)/);
  assert.match(appSource, /event\.key !== "Escape"/);
  assert.match(stylesSource, /\.statement-concept-button:focus-visible/);
  assert.match(stylesSource, /@media \(max-width: 760px\)[\s\S]*?\.statement-detail-header/);
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

test("Dashboard muestra y expande el ultimo movimiento bancario sin agrandar la tarjeta cerrada", async () => {
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
  const requests = [];
  const context = upcomingPaymentPlanDashboardContext({
    requestBackendApi: async (requestPath) => {
      requests.push(requestPath);
      return {
        summary: {
          latestDate: "2026-07-25",
          daysElapsed: 2,
          bank: "ICBC",
          details: [
            { bank: "ICBC", account: "", latestDate: "2026-07-25", daysElapsed: 2 },
            { bank: "GAL", account: "", latestDate: "2026-07-20", daysElapsed: 7 }
          ]
        }
      };
    },
    dashboardExpandedWidget: "",
    dashboardWidgetData: { bankReconciliationSummary: null, errors: {} },
    formatDate: (value) => value.split("-").reverse().join("/"),
    formatNumber: String,
    escapeHtml: String,
    els: {
      "dashboard-bank-reconciliation-widget": widget,
      "dashboard-bank-reconciliation-days": { textContent: "" },
      "dashboard-bank-reconciliation-summary": { textContent: "" },
      "dashboard-bank-reconciliation-list": { innerHTML: "" }
    }
  });

  context.dashboardWidgetData.bankReconciliationSummary = await context.loadDashboardBankReconciliationSummary();
  assert.deepEqual(requests, ["/api/bank-reconciliation/summary"]);
  context.renderDashboardBankReconciliationWidget();
  assert.equal(context.els["dashboard-bank-reconciliation-days"].textContent, "2");
  assert.match(context.els["dashboard-bank-reconciliation-summary"].textContent, /25\/07\/2026 · Hace 2 dias · ICBC/);
  assert.equal(context.els["dashboard-bank-reconciliation-list"].innerHTML, "");
  assert.equal(classes.has("is-expanded"), false);

  context.dashboardExpandedWidget = "bankReconciliation";
  context.renderDashboardBankReconciliationWidget();
  assert.equal(classes.has("is-expanded"), true);
  assert.match(context.els["dashboard-bank-reconciliation-list"].innerHTML, /ICBC/);
  assert.match(context.els["dashboard-bank-reconciliation-list"].innerHTML, /GAL/);
  assert.equal(widget.attributes["aria-expanded"], "true");

  context.dashboardExpandedWidget = "";
  context.dashboardWidgetData.bankReconciliationSummary = {
    latestDate: "",
    daysElapsed: null,
    bank: "",
    details: []
  };
  context.renderDashboardBankReconciliationWidget();
  assert.equal(context.els["dashboard-bank-reconciliation-days"].textContent, "-");
  assert.match(context.els["dashboard-bank-reconciliation-summary"].textContent, /Sin movimientos bancarios registrados/);

  context.dashboardWidgetData.errors.bankReconciliation = "ultima fecha bancaria";
  context.renderDashboardBankReconciliationWidget();
  assert.equal(context.els["dashboard-bank-reconciliation-days"].textContent, "!");
  assert.match(
    context.els["dashboard-bank-reconciliation-summary"].textContent,
    /No se pudo cargar: ultima fecha bancaria/
  );
});

test("Dashboard registra nodos, endpoint y eventos del widget de conciliacion bancaria", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../assets/js/app.js"), "utf8");
  const dashboardSource = fs.readFileSync(path.join(__dirname, "../assets/js/modules/dashboard.js"), "utf8");
  const htmlSource = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  [
    "dashboard-bank-reconciliation-widget",
    "dashboard-bank-reconciliation-days",
    "dashboard-bank-reconciliation-summary",
    "dashboard-bank-reconciliation-list"
  ].forEach((idValue) => {
    assert.match(htmlSource, new RegExp(`id="${idValue}"`));
    assert.match(appSource, new RegExp(`"${idValue}"`));
  });
  assert.match(dashboardSource, /\/api\/bank-reconciliation\/summary/);
  assert.match(
    htmlSource,
    /id="dashboard-bank-reconciliation-widget" role="button" tabindex="0" aria-expanded="false"/
  );
  assert.match(
    appSource,
    /dashboard-bank-reconciliation-widget"\]\?\.addEventListener\("click", \(\) => toggleDashboardWidget\("bankReconciliation"\)\)/
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
        state: "valid_with_alerts",
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
  assert.match(context.els["dashboard-inventory-purchases-list"].innerHTML, /0 d\u00edas/);
  assert.match(context.els["dashboard-inventory-purchases-list"].innerHTML, /0 Lt/);
  assert.match(context.els["dashboard-inventory-purchases-list"].innerHTML, /0 d\u00edas/);
  assert.match(context.els["dashboard-inventory-purchases-list"].innerHTML, /1\.234,75 Pack 25 Ud/);
  assert.match(context.els["dashboard-inventory-purchases-list"].innerHTML, /12\.346 d\u00edas/);
  assert.match(context.els["dashboard-inventory-purchases-list"].innerHTML, /&lt;script&gt;/);
  assert.equal(context.dashboardProductionDaysLabel(1.49), "1 d\u00eda");
  assert.equal(context.dashboardProductionDaysLabel(1.5), "2 d\u00edas");

  context.dashboardWidgetData = {
    inventoryPurchaseSnapshot: {
      inventoryDate: "2026-07-21",
      state: "valid_no_alerts",
      items: []
    },
    errors: {}
  };
  context.renderDashboardInventoryPurchasesWidget();
  assert.equal(widget.hidden, true);
  assert.equal(widget.attributes["aria-expanded"], "false");

  context.dashboardExpandedWidget = "inventoryPurchases";
  context.dashboardWidgetData = {
    inventoryPurchaseSnapshot: {
      inventoryDate: "2026-07-22",
      state: "insufficient_dependencies",
      items: [],
      unavailableItems: [{ itemName: "Aceite" }]
    },
    errors: {}
  };
  context.renderDashboardInventoryPurchasesWidget();
  assert.equal(widget.hidden, false);
  assert.equal(context.els["dashboard-inventory-purchases-count"].textContent, "!");
  assert.match(context.els["dashboard-inventory-purchases-summary"].textContent, /dependencias insuficientes/);
  assert.match(context.els["dashboard-inventory-purchases-list"].innerHTML, /Aceite/);
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
    state: "valid_with_alerts",
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
  assert.match(context.els["purchase-inventory-suggestions-list"].innerHTML, /0 d\u00edas de producci\u00f3n/);
  assert.match(context.els["purchase-inventory-suggestions-list"].innerHTML, /0 Lt/);
  assert.match(context.els["purchase-inventory-suggestions-list"].innerHTML, /&lt;script&gt;/);
  assert.equal(context.purchaseInventoryDaysLabel(1.49), "1 d\u00eda de producci\u00f3n");
  assert.equal(context.purchaseInventoryDaysLabel(1.5), "2 d\u00edas de producci\u00f3n");

  context.renderPurchaseInventorySuggestions({
    inventoryDate: "2026-07-21",
    state: "valid_no_alerts",
    items: []
  });
  assert.equal(selector.value, "Aceite");
  assert.match(context.els["purchase-inventory-suggestions-list"].innerHTML, /evaluado y no requiere compras/);

  context.renderPurchaseInventorySuggestions({
    inventoryDate: "2026-07-22",
    state: "insufficient_dependencies",
    items: [],
    unavailableItems: [{ itemName: "Bobina_Barra_Pop" }]
  });
  assert.equal(selector.value, "Aceite");
  assert.equal(context.els["purchase-inventory-suggestions-count"].textContent, "!");
  assert.match(context.els["purchase-inventory-suggestions-status"].textContent, /faltan dependencias/);
  assert.match(context.els["purchase-inventory-suggestions-list"].innerHTML, /Bobina Barra Pop/);

  context.renderPurchaseInventorySuggestions({
    inventoryDate: "",
    state: "no_inventory",
    items: []
  });
  assert.equal(context.els["purchase-inventory-suggestions-count"].textContent, "0");
  assert.match(context.els["purchase-inventory-suggestions-status"].textContent, /No existe un inventario persistido/);
});

test("Compras registra la lista superior y lee la fotografia canonica", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../assets/js/app.js"), "utf8");
  const purchaseSource = fs.readFileSync(path.join(__dirname, "../assets/js/modules/purchase-entry.js"), "utf8");
  const htmlSource = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const stylesSource = fs.readFileSync(path.join(__dirname, "../assets/css/styles.css"), "utf8");
  [
    "purchase-inventory-suggestions-count",
    "purchase-inventory-suggestions-status",
    "purchase-inventory-suggestions-list",
    "inventory-production-rate-form",
    "inventory-production-rate",
    "inventory-production-rate-submit",
    "inventory-production-rate-status"
  ].forEach((idValue) => {
    assert.match(htmlSource, new RegExp(`id="${idValue}"`));
    assert.match(appSource, new RegExp(`"${idValue}"`));
  });
  assert.match(purchaseSource, /requestBackendApi\("\/api\/inventory\/purchase-snapshot"\)/);
  assert.match(purchaseSource, /\/api\/inventory\/purchase-snapshot\/production-rate/);
  assert.doesNotMatch(purchaseSource, /InventoryPurchaseEvaluation|DAILY_CONSUMPTION_BY_ITEM/);
  assert.match(purchaseSource, /inventoryPurchaseSnapshotItem/);
  assert.match(appSource, /inventory-production-rate-form"\]\?\.addEventListener\("submit", submitInventoryProductionRate\)/);
  assert.match(
    stylesSource,
    /@media \(max-width: 760px\)[\s\S]*?\.purchase-inventory-suggestions-header\s*\{\s*flex-direction: column;/
  );
  assert.match(
    stylesSource,
    /@media \(max-width: 760px\)[\s\S]*?\.inventory-production-rate-form > div\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto;/
  );
});

test("Compras valida, aplica y revierte la produccion diaria sin usar localStorage", async () => {
  const input = {
    value: "20.000",
    dataset: { minimum: "1", maximum: "1000000" },
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
  };
  const status = { textContent: "", dataset: {} };
  const button = { disabled: false };
  const requests = [];
  const snapshotAtTwentyThousand = {
    barsPerDay: 20000,
    minBarsPerDay: 1,
    maxBarsPerDay: 1000000,
    inventoryDate: "2026-07-20",
    state: "valid_with_alerts",
    items: [{ itemName: "Aceite", stock: 150, unit: "Kg", daysRemaining: 2.443 }]
  };
  const context = {
    inventoryPurchaseSnapshot: {
      barsPerDay: 30100,
      minBarsPerDay: 1,
      maxBarsPerDay: 1000000,
      inventoryDate: "2026-07-20",
      state: "valid_with_alerts",
      items: []
    },
    dashboardWidgetData: { inventoryPurchaseSnapshot: null },
    document: { activeElement: null },
    els: {
      "inventory-production-rate": input,
      "inventory-production-rate-submit": button,
      "inventory-production-rate-status": status,
      "purchase-inventory-suggestions-count": { textContent: "" },
      "purchase-inventory-suggestions-status": { textContent: "" },
      "purchase-inventory-suggestions-list": { innerHTML: "" }
    },
    requestBackendApi: async (requestPath, options) => {
      requests.push({ requestPath, options });
      return { ok: true, snapshot: snapshotAtTwentyThousand };
    },
    renderDashboardInventoryPurchasesWidget: () => {},
    displayNameLabel: String,
    displayUnitLabel: String,
    escapeHtml: String,
    formatDate: String,
    formatNumber: (value) => new Intl.NumberFormat("es-AR").format(value),
    Intl
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../assets/js/modules/purchase-entry.js"), "utf8"), context);

  context.document.activeElement = input;
  input.value = "40.000";
  context.syncInventoryProductionRateInput(snapshotAtTwentyThousand);
  assert.equal(input.value, "40.000");
  assert.equal(input.dataset.minimum, "1");
  assert.equal(input.dataset.maximum, "1000000");
  context.document.activeElement = null;
  input.value = "20.000";

  assert.equal(context.parseInventoryProductionRate("20000"), 20000);
  assert.equal(context.parseInventoryProductionRate("20.000"), 20000);
  ["", "0", "-1", "20,5", "texto", "1.000.001"].forEach((value) => {
    assert.equal(Number.isNaN(context.parseInventoryProductionRate(value)), true);
  });

  await context.submitInventoryProductionRate({ preventDefault() {} });
  assert.equal(requests[0].requestPath, "/api/inventory/purchase-snapshot/production-rate");
  assert.deepEqual(JSON.parse(requests[0].options.body), { barsPerDay: 20000 });
  assert.equal(context.inventoryPurchaseSnapshot.barsPerDay, 20000);
  assert.equal(context.dashboardWidgetData.inventoryPurchaseSnapshot.barsPerDay, 20000);
  assert.equal(input.value, "20.000");
  assert.equal(status.dataset.status, "success");

  context.requestBackendApi = async () => {
    throw new Error("Fallo simulado");
  };
  input.value = "40.000";
  await context.submitInventoryProductionRate({ preventDefault() {} });
  assert.equal(context.inventoryPurchaseSnapshot.barsPerDay, 20000);
  assert.equal(input.value, "20.000");
  assert.equal(status.dataset.status, "error");

  const purchaseSource = fs.readFileSync(path.join(__dirname, "../assets/js/modules/purchase-entry.js"), "utf8");
  assert.doesNotMatch(purchaseSource, /localStorage/);
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
      state: "valid_with_alerts",
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
  assert.match(context.els["purchase-threshold-body"].innerHTML, /0 d\u00edas de producci\u00f3n/);
  assert.match(context.els["purchase-threshold-body"].innerHTML, /Comprar/);

  context.inventoryPurchaseSnapshot = {
    inventoryDate: "2026-07-21",
    state: "insufficient_dependencies",
    items: [],
    unavailableItems: [{ itemName: "Aceite" }]
  };
  context.updateInventoryPurchaseAlerts();
  assert.match(context.els["purchase-threshold-snapshot-date"].textContent, /faltan dependencias/);
  assert.match(context.els["purchase-threshold-body"].innerHTML, /Aceite/);

  const purchaseSource = fs.readFileSync(path.join(__dirname, "../assets/js/modules/purchase-entry.js"), "utf8");
  assert.doesNotMatch(purchaseSource, /inventoryPurchaseAlert|inventoryPurchaseMetrics|DAILY_CONSUMPTION_BY_ITEM/);
  assert.match(purchaseSource, /renderPurchaseThresholdTable\(snapshotItems\)/);
});

test("Bootstrap carga solo Dashboard y difiere los modulos cerrados", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../assets/js/app.js"), "utf8");
  const bootstrapSource = appSource.slice(
    appSource.indexOf('document.addEventListener("DOMContentLoaded"'),
    appSource.indexOf("function cacheElements()")
  );

  assert.match(bootstrapSource, /switchView\("dashboard"\)/);
  assert.doesNotMatch(bootstrapSource, /loadDashboardWidgets\(\)/);
  assert.doesNotMatch(bootstrapSource, /initializeInventoryEntryDefaults\(\)/);
  assert.doesNotMatch(bootstrapSource, /initializeOperationalEntryDefaults\(\)/);
  assert.doesNotMatch(bootstrapSource, /initializeSalaryEntry\(\)/);
  assert.doesNotMatch(bootstrapSource, /loadOperationalEntryOptions\(\)/);
  assert.doesNotMatch(bootstrapSource, /loadPurchaseBackendOptions\(\)/);
  assert.doesNotMatch(bootstrapSource, /refreshInventoryDefaultDateFromBackend\(\)/);
  assert.equal((bootstrapSource.match(/bindEvents\(\)/g) || []).length, 1);
  assert.match(appSource, /if \(view === "dashboard"\) runViewLoad\(view, loadDashboardWidgets\)/);
  assert.match(appSource, /if \(view === "data-entry"\) initializeViewOnce\(view, initializeInventoryView\)/);
  assert.match(appSource, /if \(view === "salary-entry"\) initializeViewOnce\(view, initializeSalaryEntry\)/);
  assert.match(appSource, /if \(view === "results" \|\| view === "cashflow"\)/);
});

test("Inicializacion diferida comparte clics concurrentes y permite reintento seguro", async () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../assets/js/app.js"), "utf8");
  const start = appSource.indexOf("function initializeViewOnce(");
  const end = appSource.indexOf("function runViewLoad(", start);
  const context = {
    deferredViewInitializations: new Map(),
    Promise
  };
  vm.createContext(context);
  vm.runInContext(appSource.slice(start, end), context);

  let initializationCalls = 0;
  let finishInitialization;
  const initializer = () => {
    initializationCalls += 1;
    return new Promise((resolve) => {
      finishInitialization = resolve;
    });
  };
  const first = context.initializeViewOnce("sample", initializer, () => {});
  const concurrent = context.initializeViewOnce("sample", initializer, () => {});
  assert.equal(first, concurrent);
  assert.equal(initializationCalls, 0);
  await Promise.resolve();
  assert.equal(initializationCalls, 1);
  finishInitialization();
  assert.equal(await first, true);
  assert.equal(await context.initializeViewOnce("sample", initializer, () => {}), true);
  assert.equal(initializationCalls, 1);

  let failedCalls = 0;
  let visibleErrors = 0;
  const failsOnce = () => {
    failedCalls += 1;
    return failedCalls === 1 ? Promise.reject(new Error("fallo simulado")) : Promise.resolve();
  };
  assert.equal(await context.initializeViewOnce("retry", failsOnce, () => { visibleErrors += 1; }), false);
  assert.equal(await context.initializeViewOnce("retry", failsOnce, () => { visibleErrors += 1; }), true);
  assert.equal(failedCalls, 2);
  assert.equal(visibleErrors, 1);
});

test("Carga refrescable de Dashboard comparte la promesa activa sin bloquear reaperturas", async () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../assets/js/app.js"), "utf8");
  const start = appSource.indexOf("function runViewLoad(");
  const end = appSource.indexOf("function showDeferredViewError(", start);
  const context = {
    activeViewLoads: new Map(),
    Promise
  };
  vm.createContext(context);
  vm.runInContext(appSource.slice(start, end), context);

  let loadCalls = 0;
  let finishLoad;
  const loader = () => {
    loadCalls += 1;
    return new Promise((resolve) => {
      finishLoad = resolve;
    });
  };
  const first = context.runViewLoad("dashboard", loader, () => {});
  const concurrent = context.runViewLoad("dashboard", loader, () => {});
  assert.equal(first, concurrent);
  await Promise.resolve();
  assert.equal(loadCalls, 1);
  finishLoad();
  await first;

  const reopened = context.runViewLoad("dashboard", () => {
    loadCalls += 1;
    return Promise.resolve();
  }, () => {});
  await reopened;
  assert.equal(loadCalls, 2);
});

test("Reportes ejecuta la ultima actualizacion pedida durante una carga activa", async () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../assets/js/app.js"), "utf8");
  const start = appSource.indexOf("function runViewLoad(");
  const end = appSource.indexOf("function showDeferredViewError(", start);
  const context = {
    activeViewLoads: new Map(),
    queuedViewLoads: new Map(),
    Promise
  };
  vm.createContext(context);
  vm.runInContext(appSource.slice(start, end), context);

  const calls = [];
  let finishFirst;
  const first = context.runLatestViewLoad("report-results", () => {
    calls.push("first");
    return new Promise((resolve) => {
      finishFirst = resolve;
    });
  }, () => {});
  await Promise.resolve();
  context.runLatestViewLoad("report-results", () => {
    calls.push("latest");
    return Promise.resolve();
  }, () => {});
  assert.deepEqual(calls, ["first"]);
  finishFirst();
  await first;
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ["first", "latest"]);
});

test("Compras comparte la inicializacion al abrir desde una sugerencia", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../assets/js/modules/purchase-entry.js"), "utf8");
  const start = source.indexOf("async function openPurchaseEntryForItem(");
  const end = source.indexOf("function findPurchaseSupply(", start);
  const openSource = source.slice(start, end);

  let loadCalls = 0;
  let finishLoad;
  const initializationPromises = new Map();
  const context = {
    loadPurchaseBackendOptions: () => {
      loadCalls += 1;
      return new Promise((resolve) => {
        finishLoad = resolve;
      });
    },
    initializeViewOnce: (key, loader) => {
      if (initializationPromises.has(key)) return initializationPromises.get(key);
      const promise = Promise.resolve()
        .then(loader)
        .then(() => false)
        .finally(() => initializationPromises.delete(key));
      initializationPromises.set(key, promise);
      return promise;
    },
    Promise
  };
  context.switchView = () => {
    context.initializeViewOnce("purchase-entry", context.loadPurchaseBackendOptions);
  };
  vm.createContext(context);
  vm.runInContext(openSource, context);

  const opening = context.openPurchaseEntryForItem("Aceite", "7");
  await Promise.resolve();
  assert.equal(loadCalls, 1);
  finishLoad();
  await opening;
  assert.equal(loadCalls, 1);
});

test("Inventario y Recepciones propagan fallos para permitir reapertura", async () => {
  const inventoryContext = {
    els: { "inventory-date-input": { value: "" } },
    API_BASE_URL: "",
    fetch: async () => ({
      ok: false,
      json: async () => ({ error: "fallo de fecha" })
    }),
    Error
  };
  vm.createContext(inventoryContext);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../assets/js/modules/inventory-entry-coordinator.js"), "utf8"),
    inventoryContext
  );
  await assert.rejects(
    inventoryContext.refreshInventoryDefaultDateFromBackend(),
    /fallo de fecha/
  );

  const receptionContext = {
    els: { "reception-purchase-id": { value: "" } },
    backendTableRowsForEntry: async () => {
      throw new Error("fallo de compras");
    },
    loadIssuedCheckPendingPayments: async () => {},
    renderEntryDatalistOptions: () => {},
    Error,
    Map,
    Set,
    Promise
  };
  vm.createContext(receptionContext);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../assets/js/modules/reception-options.js"), "utf8"),
    receptionContext
  );
  await assert.rejects(
    receptionContext.loadReceptionPurchaseOptions(),
    /fallo de compras/
  );
  await assert.rejects(
    receptionContext.loadOperationalEntryOptions(),
    /fallo de compras/
  );
});

test("Coordinador comercial comparte la carga y renderiza solo la vista activa", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../assets/js/modules/operational-data-coordinator.js"),
    "utf8"
  );

  assert.match(source, /let commercialEntryLoadPromise = null/);
  assert.match(source, /if \(commercialEntryLoadPromise\) return commercialEntryLoadPromise/);
  assert.match(source, /renderActiveCommercialEntryView\(\)/);
  assert.doesNotMatch(source, /function renderCommercialEntryViews\(/);
  [
    "renderOrderEntry",
    "renderLogisticsEntry",
    "renderSalesEntry",
    "renderCollectionsEntry",
    "renderCommissionsEntry",
    "renderReceivedCheckEntry"
  ].forEach((renderer) => {
    assert.match(source, new RegExp(`"${renderer.replace(/^render/, "").replace(/Entry$/, "").toLowerCase()}|${renderer}`));
  });
});
