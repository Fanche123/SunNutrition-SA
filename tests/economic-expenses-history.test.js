const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EXPECTED_BACKEND_COLUMNS } = require("../backend/config/backend-columns");
const {
  backfillHistoricalEconomicExpenses,
  createBackupManifest,
  migrateEconomicExpenseSchema,
  verifyBackup
} = require("../backend/migrations/20260727-economic-expenses-history");
const { createBackendTableService } = require("../backend/services/backend-table.service");
const { createPaymentEntryService } = require("../backend/services/payment-entry.service");
const {
  backendEditableColumns,
  backendEditablePrimaryKey,
  backendNextNumericId,
  ensureBackendTable
} = require("../backend/utils/runtime");

function table(name, rows = []) {
  return {
    headers: [...(EXPECTED_BACKEND_COLUMNS[name] || [])],
    rows,
    rowCount: rows.length
  };
}

function fixture() {
  return {
    generatedAt: "fixture",
    tables: {
      etiquetas: table("etiquetas", [
        { id_etiqueta: "1", etiqueta: "Mercaderia" },
        { id_etiqueta: "2", etiqueta: "Servicios" },
        { id_etiqueta: "3", etiqueta: "Logistica" },
        { id_etiqueta: "4", etiqueta: "Comisiones" },
        { id_etiqueta: "5", etiqueta: "Sueldos" },
        { id_etiqueta: "6", etiqueta: "IVA" },
        { id_etiqueta: "8", etiqueta: "Intereses" },
        { id_etiqueta: "9", etiqueta: "Impuestos Internos" }
      ]),
      acreedores_etiquetas: table("acreedores_etiquetas", [
        { id_acreedor_etiqueta: "11", id_acreedor: "1", id_etiqueta: "1" },
        { id_acreedor_etiqueta: "12", id_acreedor: "2", id_etiqueta: "2" },
        { id_acreedor_etiqueta: "13", id_acreedor: "3", id_etiqueta: "3" },
        { id_acreedor_etiqueta: "14", id_acreedor: "4", id_etiqueta: "4" },
        { id_acreedor_etiqueta: "15", id_acreedor: "5", id_etiqueta: "5" },
        { id_acreedor_etiqueta: "16", id_acreedor: "6", id_etiqueta: "6" }
      ]),
      egresos: table("egresos", [
        { id_egreso: "101", subtotal: 100, iva: 21, total: 121 },
        { id_egreso: "102", subtotal: 50, iva: 10.5, total: 60.5 },
        { id_egreso: "103", subtotal: 30, iva: 6.3, total: 36.3 },
        { id_egreso: "104", subtotal: 40, total: 40 },
        { id_egreso: "105", subtotal: 250, total: 250 },
        { id_egreso: "106", subtotal: 21, total: 21 },
        { id_egreso: "107", subtotal: 10, total: 10 },
        { id_egreso: "108", subtotal: 12, total: 12 },
        { id_egreso: "109", subtotal: 80, total: 96.8 }
      ]),
      recepciones: table("recepciones", [
        { id_recepcion: "1", fecha_recepcion: "2026-04-01", id_acreedor_etiqueta: "11", id_egreso: "101" },
        { id_recepcion: "2", fecha_recepcion: "2026-03-31", id_acreedor_etiqueta: "11", id_egreso: "107" },
        { id_recepcion: "3", fecha_recepcion: "2026-07-20", id_acreedor_etiqueta: "11", id_egreso: "" },
        { id_recepcion: "4", fecha_recepcion: "2026-07-21", id_acreedor_etiqueta: "11", id_egreso: "109" },
        { id_recepcion: "5", fecha_recepcion: "2026-07-22", id_acreedor_etiqueta: "11", id_egreso: "109" }
      ]),
      otros_gastos: table("otros_gastos", [
        { id_otros_gastos: "1", fecha_otros_gastos: "2026-05-10", id_acreedor_etiqueta: "12", id_egreso: "102", detalle: "Servicio mensual" },
        { id_otros_gastos: "2", fecha_otros_gastos: "2026-05-11", id_acreedor_etiqueta: "16", id_egreso: "106", detalle: "IVA" },
        { id_otros_gastos: "3", fecha_otros_gastos: "2026-08-01", id_acreedor_etiqueta: "12", id_egreso: "108", detalle: "Futuro" }
      ]),
      entregas: table("entregas", [
        { id_entrega: "1", fecha: "2026-06-10", id_acreedor_etiqueta: "13", id_egreso: "103" },
        { id_entrega: "2", fecha: "2026-06-11", id_acreedor_etiqueta: "", id_egreso: "107" }
      ]),
      comisiones: table("comisiones", [
        { id_comision: "1", fecha: "2026-06-15", id_acreedor_etiqueta: "14", id_egreso: "104", subtotal: 1000, comision: 40 }
      ]),
      sueldos: table("sueldos", [
        { id_sueldo: "1", fecha: "2026-07-01", id_acreedor_etiqueta: "15", id_egreso: "105", sueldo_bruto: 300, sueldo_neto: 250 }
      ]),
      cuotas_planes_pagos: table("cuotas_planes_pagos", [
        {
          id_cuota_plan_pago: "1",
          capital: 100,
          fecha_primer_vencimiento: "2026-06-16",
          fecha_segundo_vencimiento: "2026-06-26",
          interes_financiero: 20,
          interes_resarcitorio: 5,
          id_egreso: "108"
        }
      ]),
      pagos: table("pagos", []),
      detalle_pagos: table("detalle_pagos", []),
      aportes_socios: table("aportes_socios", [
        { id_aporte_socio: "1", fecha: "2026-05-01", monto: 1000 }
      ]),
      fondos_inversion_movimientos: table("fondos_inversion_movimientos", [
        { id_movimiento_fondo: "1", fecha: "2026-06-01", tipo: "deposito", importe: 500 }
      ]),
      gastos_economicos: { headers: [], rows: [], rowCount: 0 },
      gastos_egresos: { headers: [], rows: [], rowCount: 0 }
    }
  };
}

test("backfill reconoce subtotales economicos, excluye IVA/capital y deja confirmados", () => {
  const result = backfillHistoricalEconomicExpenses(fixture(), {
    throughDate: "2026-07-27",
    now: "2026-07-27T12:00:00.000Z"
  });
  const expenses = result.cache.tables.gastos_economicos.rows;
  const applications = result.cache.tables.gastos_egresos.rows;

  assert.equal(result.report.insertedExpenses, 5);
  assert.equal(result.report.insertedApplications, 3);
  assert.equal(expenses.reduce((sum, row) => sum + row.importe, 0), 450);
  assert.equal(expenses.every((row) => row.estado === "confirmado"), true);
  assert.equal(expenses.every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.fecha_economica)), true);
  assert.equal(expenses.every((row) => row.tipo_movimiento === "original"), true);
  assert.equal(expenses.every((row) => row.id_gasto_precedente === "" && row.motivo === ""), true);
  assert.equal(expenses.every((row) => row.clave_idempotencia && /^[a-f0-9]{64}$/.test(row.hash_payload)), true);
  assert.equal(expenses.some((row) => row.id_etiqueta === "6"), false);
  assert.equal(expenses.some((row) => row.origen_tipo === "comision"), false);
  assert.equal(expenses.find((row) => row.origen_tipo === "sueldo").importe, 250);
  assert.equal(expenses.find((row) => row.origen_subclave === "interes_financiero").importe, 20);
  assert.equal(expenses.some((row) => row.origen_subclave === "interes_resarcitorio"), false);
  assert.equal(applications.some((row) => (
    expenses.find((expense) => expense.id_gasto_economico === row.id_gasto_economico)?.origen_tipo === "sueldo"
  )), false);
  assert.equal(result.report.producers.recepcion.skipped.subtotal_economico_faltante, 1);
  assert.equal(result.report.producers.recepcion.skipped.egreso_compartido_sin_asignacion, 2);
  assert.equal(result.report.producers.otro_gasto.skipped.iva_no_resultado, 1);
  assert.equal(result.report.producers.logistica.skipped.vinculo_etiqueta_faltante, 1);
  assert.deepEqual(result.report.exclusions, { aportes_socios: 1, fondo_capital: 1 });
});

test("intereses de cuotas excluyen capital y condicionan el resarcitorio a la instancia real", () => {
  const source = fixture();
  source.tables.pagos.rows.push(
    { id_pago: "1", fecha_pago: "2026-06-15" },
    { id_pago: "2", fecha_pago: "2026-06-20" }
  );
  source.tables.detalle_pagos.rows.push(
    { id_detalle_pago: "1", id_pago: "1", id_egreso: "108", monto_cancelado: 60 },
    { id_detalle_pago: "2", id_pago: "2", id_egreso: "108", monto_cancelado: 60 }
  );

  const first = backfillHistoricalEconomicExpenses(source, {
    throughDate: "2026-07-27",
    now: "2026-07-27T12:00:00.000Z"
  });
  const planRows = first.cache.tables.gastos_economicos.rows.filter(
    (row) => row.origen_tipo === "plan_pago"
  );
  assert.deepEqual(
    planRows.map((row) => [row.origen_subclave, row.importe]),
    [["interes_financiero", 20], ["interes_resarcitorio", 5]]
  );
  assert.equal(planRows.reduce((sum, row) => sum + row.importe, 0), 25);

  const second = backfillHistoricalEconomicExpenses(first.cache, {
    throughDate: "2026-07-27",
    now: "2026-07-27T13:00:00.000Z"
  });
  assert.equal(second.cache.tables.gastos_economicos.rows.length, first.cache.tables.gastos_economicos.rows.length);
  assert.equal(second.report.idempotent, true);
});

test("quitar una cuota revierte sus intereses confirmados sin eliminarlos", () => {
  const first = backfillHistoricalEconomicExpenses(fixture(), {
    throughDate: "2026-07-27",
    now: "2026-07-27T12:00:00.000Z"
  });
  first.cache.tables.cuotas_planes_pagos.rows = [];
  first.cache.tables.cuotas_planes_pagos.rowCount = 0;

  const second = backfillHistoricalEconomicExpenses(first.cache, {
    throughDate: "2026-07-27",
    now: "2026-07-27T13:00:00.000Z"
  });
  const financialRows = second.cache.tables.gastos_economicos.rows.filter(
    (row) => row.origen_tipo === "plan_pago" && row.origen_subclave === "interes_financiero"
  );
  assert.equal(financialRows.reduce((sum, row) => sum + row.importe, 0), 0);
  assert.equal(financialRows.some((row) => row.tipo_movimiento === "reversion" && row.importe === -20), true);
});

test("guardar el pago que completa una cuota sincroniza el resarcitorio en el mismo snapshot", async () => {
  let stored = fixture();
  stored.tables.egresos.rows.find((row) => row.id_egreso === "108").total = 120;
  let response;
  const service = createPaymentEntryService({
    backendId: (value) => String(value ?? "").trim(),
    backendNextNumericId,
    backendNumber: (value) => Number(value) || 0,
    ensureBackendTable,
    loadCache: () => JSON.parse(JSON.stringify(stored)),
    readJsonBody: async () => ({
      operationId: "pago-cuota-segunda-instancia",
      payment: { fecha: "2026-06-20", metodo: "Transferencia", banco: "Banco" },
      details: [{ idEgreso: "108", monto: 120 }]
    }),
    saveBackendCache: (cache) => {
      stored = cache;
    },
    sendJson: (_target, status, payload) => {
      response = { status, payload };
    },
    synchronizeEconomicExpenses: (cache) => backfillHistoricalEconomicExpenses(cache, {
      throughDate: "2026-07-27",
      now: "2026-07-27T12:00:00.000Z"
    }).cache
  });

  await service.handlePaymentFullEntry({}, {});

  assert.equal(response.status, 200);
  const planRows = stored.tables.gastos_economicos.rows.filter(
    (row) => row.origen_tipo === "plan_pago"
  );
  assert.equal(planRows.find((row) => row.origen_subclave === "interes_financiero").importe, 20);
  assert.equal(planRows.find((row) => row.origen_subclave === "interes_resarcitorio").importe, 5);
});

test("corrige sueldo bruto confirmado con reversion y conserva el neto idempotente", () => {
  const source = fixture();
  source.tables.gastos_economicos.rows.push({
    id_gasto_economico: "90",
    fecha_economica: "2026-07-01",
    id_etiqueta: "5",
    concepto: "Sueldo #1",
    tipo_economico: "operativo",
    tipo_movimiento: "original",
    importe: 300,
    estado: "confirmado",
    origen_tipo: "sueldo",
    origen_id: "1",
    origen_subclave: "sueldo_bruto",
    id_gasto_precedente: "",
    motivo: "",
    clave_idempotencia: "historico-sueldo-bruto",
    hash_payload: "historico",
    creado_en: "2026-07-01T12:00:00.000Z",
    actualizado_en: "2026-07-01T12:00:00.000Z",
    confirmado_en: "2026-07-01T12:00:00.000Z"
  });

  const first = backfillHistoricalEconomicExpenses(source, {
    throughDate: "2026-07-27",
    now: "2026-07-27T12:00:00.000Z"
  });
  const salaryRows = first.cache.tables.gastos_economicos.rows.filter(
    (row) => row.origen_tipo === "sueldo" && row.origen_id === "1"
  );
  assert.equal(salaryRows.reduce((sum, row) => sum + row.importe, 0), 250);
  assert.equal(salaryRows.some((row) => row.tipo_movimiento === "reversion" && row.importe === -300), true);
  assert.equal(salaryRows.some((row) => row.origen_subclave === "sueldo_neto" && row.importe === 250), true);

  const second = backfillHistoricalEconomicExpenses(first.cache, {
    throughDate: "2026-07-27",
    now: "2026-07-27T13:00:00.000Z"
  });
  assert.equal(second.cache.tables.gastos_economicos.rows.length, first.cache.tables.gastos_economicos.rows.length);
});

test("deduplica fuentes salariales equivalentes por empleado y periodo", () => {
  const source = fixture();
  source.tables.sueldos.rows[0].id_empleado = "1";
  source.tables.sueldos.rows.push({
    id_sueldo: "2",
    fecha: "2026-07-31",
    id_empleado: "1",
    id_acreedor_etiqueta: "15",
    id_egreso: "105",
    sueldo_bruto: "",
    sueldo_neto: 250
  });

  const first = backfillHistoricalEconomicExpenses(source, {
    throughDate: "2026-07-31",
    now: "2026-07-31T12:00:00.000Z"
  });
  const salaryNetRows = first.cache.tables.gastos_economicos.rows.filter(
    (row) => row.origen_tipo === "sueldo" && row.origen_subclave === "sueldo_neto"
  );
  assert.equal(salaryNetRows.length, 1);
  assert.equal(salaryNetRows[0].origen_id, "1");
  assert.equal(salaryNetRows[0].importe, 250);
  assert.equal(first.report.producers.sueldo.skipped.fuente_duplicada_empleado_periodo, 1);

  const second = backfillHistoricalEconomicExpenses(first.cache, {
    throughDate: "2026-07-31",
    now: "2026-07-31T13:00:00.000Z"
  });
  assert.equal(second.report.idempotent, true);
  assert.equal(second.report.insertedExpenses, 0);
});

test("backfill es idempotente y no duplica gastos ni aplicaciones", () => {
  const first = backfillHistoricalEconomicExpenses(fixture(), {
    throughDate: "2026-07-27",
    now: "2026-07-27T12:00:00.000Z"
  });
  const second = backfillHistoricalEconomicExpenses(first.cache, {
    throughDate: "2026-07-27",
    now: "2026-07-27T13:00:00.000Z"
  });
  assert.equal(second.report.idempotent, true);
  assert.equal(second.report.insertedExpenses, 0);
  assert.equal(second.report.insertedApplications, 0);
  assert.equal(second.report.replayedApplications, 3);
  assert.deepEqual(second.cache, first.cache);
});

test("resuelve otros gastos historicos por etiqueta canonica del acreedor", () => {
  const source = fixture();
  source.tables.egresos.rows.push(
    { id_egreso: "110", subtotal: 25, iva: 5.25, total: 30.25 },
    { id_egreso: "111", subtotal: 10, iva: 2.1, total: 12.1 }
  );
  source.tables.otros_gastos.rows.push(
    {
      id_otros_gastos: "4",
      fecha_otros_gastos: "2026-04-15",
      id_acreedor: "2",
      id_acreedor_etiqueta: "",
      id_egreso: "110",
      detalle: "Servicio",
      _etiqueta_gasto: "Servicios"
    },
    {
      id_otros_gastos: "5",
      fecha_otros_gastos: "2026-04-16",
      id_acreedor: "2",
      id_acreedor_etiqueta: "",
      id_egreso: "111",
      detalle: "Sin clasificar",
      _etiqueta_gasto: "Etiqueta inexistente"
    }
  );

  const result = backfillHistoricalEconomicExpenses(source, {
    throughDate: "2026-07-27",
    now: "2026-07-27T12:00:00.000Z"
  });
  const expense = result.cache.tables.gastos_economicos.rows.find(
    (row) => row.origen_tipo === "otro_gasto" && row.origen_id === "4"
  );
  const application = result.cache.tables.gastos_egresos.rows.find(
    (row) => String(row.id_gasto_economico) === String(expense.id_gasto_economico)
  );

  assert.equal(expense.id_etiqueta, "2");
  assert.equal(expense.importe, 25);
  assert.equal(application.id_egreso, "110");
  assert.equal(application.importe_aplicado, 25);
  assert.equal(result.report.producers.otro_gasto.skipped.vinculo_etiqueta_faltante, 1);
});

test("revierte IIBB historico de otros gastos para conservar el 1,5% sobre ventas", () => {
  const source = fixture();
  source.tables.egresos.rows.push({
    id_egreso: "190",
    subtotal: 12,
    total: 12
  });
  source.tables.etiquetas.rows.push({ id_etiqueta: "7", etiqueta: "Ingresos Brutos" });
  source.tables.gastos_economicos.rows.push({
    id_gasto_economico: "90",
    fecha_economica: "2026-06-10",
    id_etiqueta: "7",
    concepto: "Percepcion IIBB",
    tipo_economico: "operativo",
    tipo_movimiento: "original",
    importe: 12,
    estado: "confirmado",
    origen_tipo: "otro_gasto",
    origen_id: "900",
    origen_subclave: "base_subtotal",
    id_gasto_precedente: "",
    motivo: "",
    clave_idempotencia: "original-iibb",
    hash_payload: "original",
    creado_en: "2026-06-10T12:00:00.000Z",
    actualizado_en: "2026-06-10T12:00:00.000Z",
    confirmado_en: "2026-06-10T12:00:00.000Z"
  });
  source.tables.gastos_egresos.rows.push({
    id_gasto_egreso: "90",
    id_gasto_economico: "90",
    id_egreso: "190",
    importe_aplicado: 12,
    componente_egreso: "base_subtotal",
    componente_otro: "",
    tipo_aplicacion: "original",
    estado: "vigente",
    id_aplicacion_precedente: "",
    motivo: "",
    clave_idempotencia: "original-iibb-app",
    hash_payload: "original",
    creado_en: "2026-06-10T12:00:00.000Z"
  });

  const first = backfillHistoricalEconomicExpenses(source, {
    throughDate: "2026-07-27",
    now: "2026-07-27T12:00:00.000Z"
  });
  const reversal = first.cache.tables.gastos_economicos.rows.find(
    (row) => row.tipo_movimiento === "reversion" && String(row.id_gasto_precedente) === "90"
  );
  const originalApplication = first.cache.tables.gastos_egresos.rows.find(
    (row) => String(row.id_gasto_egreso) === "90"
  );
  const applicationReversal = first.cache.tables.gastos_egresos.rows.find(
    (row) => row.tipo_aplicacion === "reversion" && String(row.id_aplicacion_precedente) === "90"
  );

  assert.equal(reversal.importe, -12);
  assert.equal(reversal.motivo, "Ingresos Brutos se reconoce al 1,5% de ventas A/B");
  assert.equal(originalApplication.estado, "revertida");
  assert.equal(applicationReversal.estado, "revertida");
  assert.equal(first.report.corrections.iibbOtherExpenseInserted, 1);
  assert.equal(first.report.corrections.iibbApplicationInserted, 1);

  const second = backfillHistoricalEconomicExpenses(first.cache, {
    throughDate: "2026-07-27",
    now: "2026-07-27T13:00:00.000Z"
  });
  assert.equal(second.report.corrections.iibbOtherExpenseReplayed, 1);
  assert.equal(second.report.corrections.iibbApplicationReplayed, 1);
  assert.equal(second.report.insertedExpenses, 0);
  assert.equal(second.report.insertedApplications, 0);
});

test("materializa IIBB al 1,5% y resuelve Logistica por la relacion canonica del flete", () => {
  const source = fixture();
  source.tables.etiquetas.rows.push({ id_etiqueta: "7", etiqueta: "Ingresos Brutos" });
  source.tables.etiquetas.rowCount += 1;
  source.tables.ventas = table("ventas", [
    { id_venta: "1", fecha_factura: "2026-04-10", tipo_factura: "Factura_A", subtotal: 1000 },
    { id_venta: "2", fecha_factura: "2026-04-11", tipo_factura: "Factura_B", subtotal: 2000 },
    { id_venta: "3", fecha_factura: "2026-04-12", tipo_factura: "Factura_C", subtotal: 3000 }
  ]);
  source.tables.fletes = table("fletes", [{ id_flete: "9", nombre_flete: "Flete" }]);
  source.tables.acreedores = table("acreedores", [{
    id_acreedor: "3",
    origen_tipo_acreedor: "flete",
    origen_id_acreedor: "9"
  }]);
  source.tables.entregas.rows[1].id_flete = "9";

  const first = backfillHistoricalEconomicExpenses(source, {
    throughDate: "2026-07-27",
    now: "2026-07-27T12:00:00.000Z"
  });
  const expenses = first.cache.tables.gastos_economicos.rows;
  const applications = first.cache.tables.gastos_egresos.rows;
  const grossRevenueTaxes = expenses.filter((row) => row.origen_tipo === "ingresos_brutos");
  const logistics = expenses.filter((row) => row.origen_tipo === "logistica");

  assert.equal(grossRevenueTaxes.length, 2);
  assert.equal(grossRevenueTaxes.reduce((sum, row) => sum + row.importe, 0), 45);
  assert.equal(grossRevenueTaxes.every((row) => row.id_etiqueta === "7"), true);
  assert.equal(logistics.length, 2);
  assert.equal(logistics.reduce((sum, row) => sum + row.importe, 0), 40);
  assert.equal(first.report.producers.ingresos_brutos.inserted, 2);
  assert.equal(first.report.producers.logistica.inserted, 2);
  assert.equal(applications.some((row) => (
    grossRevenueTaxes.some((expense) => expense.id_gasto_economico === row.id_gasto_economico)
  )), false);

  const second = backfillHistoricalEconomicExpenses(first.cache, {
    throughDate: "2026-07-27",
    now: "2026-07-27T13:00:00.000Z"
  });
  assert.equal(second.report.insertedExpenses, 0);
  assert.equal(second.report.producers.ingresos_brutos.replayed, 2);
  assert.equal(second.cache.tables.gastos_economicos.rows.length, expenses.length);
});

test("materializa Comisiones desde el canal de cada venta y no desde la tabla comisiones", () => {
  const source = fixture();
  source.tables.clientes = table("clientes", [{ id_cliente: "1", id_canal: "9" }]);
  source.tables.canales = table("canales", [{ id_canal: "9", nombre: "Canal", comision: 0.05 }]);
  source.tables.acreedores = table("acreedores", [{
    id_acreedor: "4",
    origen_tipo_acreedor: "canal",
    origen_id_acreedor: "9"
  }]);
  source.tables.ventas = table("ventas", [
    { id_venta: "1", id_cliente: "1", fecha_factura: "2026-04-10", tipo_factura: "Factura_C", subtotal: 1000 },
    { id_venta: "2", id_cliente: "1", fecha_factura: "2026-04-11", tipo_factura: "Factura_C", subtotal: 2000 },
    { id_venta: "3", id_cliente: "1", fecha_factura: "2026-04-12", tipo_factura: "Factura_C", subtotal: "" }
  ]);

  const first = backfillHistoricalEconomicExpenses(source, {
    throughDate: "2026-07-27",
    now: "2026-07-27T12:00:00.000Z"
  });
  const commissions = first.cache.tables.gastos_economicos.rows.filter(
    (row) => row.origen_tipo === "comision_venta"
  );

  assert.equal(commissions.length, 2);
  assert.equal(commissions.reduce((sum, row) => sum + row.importe, 0), 150);
  assert.equal(commissions.every((row) => row.id_etiqueta === "4"), true);
  assert.equal(first.report.producers.comision_venta.inserted, 2);
  assert.equal(first.report.producers.comision_venta.skipped.subtotal_economico_faltante, 1);
  assert.equal(first.cache.tables.gastos_economicos.rows.some((row) => row.origen_tipo === "comision"), false);

  const second = backfillHistoricalEconomicExpenses(first.cache, {
    throughDate: "2026-07-27",
    now: "2026-07-27T13:00:00.000Z"
  });
  assert.equal(second.report.producers.comision_venta.replayed, 2);
  assert.equal(second.report.insertedExpenses, 0);
});

test("guardar una venta materializa IIBB y comision en el mismo snapshot", async () => {
  let stored = fixture();
  stored.tables.etiquetas.rows.push({ id_etiqueta: "7", etiqueta: "Ingresos Brutos" });
  stored.tables.ventas = table("ventas");
  stored.tables.clientes = table("clientes", [{ id_cliente: "1", id_canal: "9" }]);
  stored.tables.canales = table("canales", [{ id_canal: "9", nombre: "Canal", comision: 0.05 }]);
  stored.tables.acreedores = table("acreedores", [{
    id_acreedor: "4",
    origen_tipo_acreedor: "canal",
    origen_id_acreedor: "9"
  }]);
  let response;
  const service = createBackendTableService({
    backendEditableColumns,
    backendEditablePrimaryKey,
    backendId: (value) => String(value ?? "").trim(),
    backendNextNumericId,
    backendTable: (name) => stored.tables[name],
    ensureBackendTable,
    expectedBackendColumns: EXPECTED_BACKEND_COLUMNS,
    loadCache: () => JSON.parse(JSON.stringify(stored)),
    readJsonBody: async () => ({
      rows: [{
        id_venta: "1",
        id_cliente: "1",
        fecha_factura: "2026-04-10",
        tipo_factura: "Factura_A",
        subtotal: 1000
      }]
    }),
    saveBackendCache: (cache) => {
      stored = cache;
    },
    sendJson: (_target, status, payload) => {
      response = { status, payload };
    },
    synchronizeEconomicExpenses: (cache) => backfillHistoricalEconomicExpenses(cache, {
      throughDate: "2026-07-27",
      now: "2026-07-27T12:00:00.000Z"
    }).cache
  });

  await service.handleBackendTableSave({
    url: "/api/backend/tables/ventas",
    headers: { host: "127.0.0.1" }
  }, {});

  assert.equal(response.status, 200);
  const taxes = stored.tables.gastos_economicos.rows.filter((row) => row.origen_tipo === "ingresos_brutos");
  const commissions = stored.tables.gastos_economicos.rows.filter((row) => row.origen_tipo === "comision_venta");
  assert.equal(taxes.length, 1);
  assert.equal(taxes[0].importe, 15);
  assert.equal(taxes[0].estado, "confirmado");
  assert.equal(commissions.length, 1);
  assert.equal(commissions[0].importe, 50);
  assert.equal(commissions[0].estado, "confirmado");
});

test("migracion reemplaza periodo mensual solo con fecha canonica del origen", () => {
  const source = fixture();
  source.tables.fondos_inversion_movimientos.rows.push({
    id_movimiento_fondo: "9",
    fecha: "2026-07-15",
    tipo: "rendimiento",
    importe: 10
  });
  source.tables.gastos_economicos.rows.push({
    id_gasto_economico: "1",
    periodo_economico: "2026-07",
    id_etiqueta: "2",
    concepto: "Rendimiento",
    tipo_economico: "interes_financiero",
    tipo_movimiento: "original",
    importe: -10,
    estado: "confirmado",
    origen_tipo: "fondo_inversion",
    origen_id: "9",
    origen_subclave: "2026-07",
    id_gasto_precedente: "",
    motivo: "",
    clave_idempotencia: "rendimiento-9",
    hash_payload: "anterior"
  });
  const migrated = migrateEconomicExpenseSchema(source);
  const row = migrated.cache.tables.gastos_economicos.rows[0];
  assert.equal(row.fecha_economica, "2026-07-15");
  assert.equal(Object.hasOwn(row, "periodo_economico"), false);
  assert.deepEqual(
    migrated.cache.tables.gastos_economicos.headers,
    EXPECTED_BACKEND_COLUMNS.gastos_economicos
  );
});

test("backup de la cache es verificable antes de persistir", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "erp-economic-expenses-"));
  try {
    const source = Buffer.from(JSON.stringify(fixture(), null, 2));
    const backupPath = path.join(directory, "backend-data-cache.backup.json");
    fs.writeFileSync(backupPath, source);
    const manifest = createBackupManifest(source);
    assert.equal(verifyBackup(fs.readFileSync(backupPath), manifest), true);
    fs.appendFileSync(backupPath, "\n");
    assert.throws(
      () => verifyBackup(fs.readFileSync(backupPath), manifest),
      (error) => error.code === "ECONOMIC_EXPENSE_BACKUP_MISMATCH"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("impuestos internos se reconocen por egreso, fecha de factura y etiqueta canonica", () => {
  const source = fixture();
  source.tables.egresos.rows.push(
    {
      id_egreso: "201",
      fecha_factura: "2026-04-30",
      fecha_prevista_pago: "2026-05-20",
      imp_internos: "1.234,56",
      subtotal: 10000,
      total: 12434.56
    },
    {
      id_egreso: "202",
      fecha_factura: "2026-05-01",
      imp_internos: "",
      subtotal: 10,
      total: 10
    }
  );

  const first = backfillHistoricalEconomicExpenses(source, {
    throughDate: "2026-07-27",
    now: "2026-07-27T12:00:00.000Z"
  });
  const internalTaxes = first.cache.tables.gastos_economicos.rows.filter(
    (row) => row.origen_tipo === "egreso" && row.origen_subclave === "impuestos_internos"
  );
  assert.equal(internalTaxes.length, 1);
  assert.equal(internalTaxes[0].fecha_economica, "2026-04-30");
  assert.equal(internalTaxes[0].id_etiqueta, "9");
  assert.equal(internalTaxes[0].importe, 1234.56);
  assert.equal(first.cache.tables.gastos_egresos.rows.some((row) => (
    row.id_egreso === "201"
    && row.componente_egreso === "otro"
    && row.componente_otro === "impuestos_internos"
    && row.importe_aplicado === 1234.56
  )), true);

  const second = backfillHistoricalEconomicExpenses(first.cache, {
    throughDate: "2026-07-27",
    now: "2026-07-27T13:00:00.000Z"
  });
  assert.equal(second.report.insertedExpenses, 0);
  assert.equal(second.report.insertedApplications, 0);
});

test("cambios y anulaciones de impuestos internos son append-only", () => {
  const source = fixture();
  source.tables.egresos.rows.push({
    id_egreso: "301",
    fecha_factura: "2026-06-30",
    imp_internos: 100,
    subtotal: 1000,
    total: 1310
  });
  const first = backfillHistoricalEconomicExpenses(source, { throughDate: "2026-07-27" });
  const edited = JSON.parse(JSON.stringify(first.cache));
  const expense = edited.tables.egresos.rows.find((row) => row.id_egreso === "301");
  expense.fecha_factura = "2026-07-01";
  expense.imp_internos = 125;
  const second = backfillHistoricalEconomicExpenses(edited, { throughDate: "2026-07-27" });
  const movements = second.cache.tables.gastos_economicos.rows.filter(
    (row) => row.origen_tipo === "egreso" && row.origen_id === "301"
  );
  assert.equal(movements.reduce((sum, row) => sum + Math.round(row.importe * 100), 0), 12500);
  assert.equal(movements.at(-1).fecha_economica, "2026-07-01");
  assert.equal(movements.at(-1).tipo_movimiento, "ajuste");

  const annulled = JSON.parse(JSON.stringify(second.cache));
  annulled.tables.egresos.rows.find((row) => row.id_egreso === "301").imp_internos = 0;
  const third = backfillHistoricalEconomicExpenses(annulled, { throughDate: "2026-07-27" });
  const finalMovements = third.cache.tables.gastos_economicos.rows.filter(
    (row) => row.origen_tipo === "egreso" && row.origen_id === "301"
  );
  assert.equal(finalMovements.reduce((sum, row) => sum + Math.round(row.importe * 100), 0), 0);
  assert.equal(finalMovements.at(-1).tipo_movimiento, "reversion");
});
