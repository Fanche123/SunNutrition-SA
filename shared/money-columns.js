(function exposeErpMoneyColumns(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.ErpMoneyColumns = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createErpMoneyColumns() {
  "use strict";

  const columnsByTable = Object.freeze({
    movimientos_bancarios: ["monto", "importe", "debito", "credito", "debe", "haber", "saldo", "amount", "debit", "credit"],
    fondos_inversion_movimientos: ["importe", "saldo_resultante"],
    proveedores: ["pedido_minimo"],
    productos: ["precio_base", "costo_base", "costo_ud_individual"],
    insumos_proveedores: ["precio"],
    detalle_pedidos: ["precio_ud"],
    ventas: ["subtotal", "iva", "per_ret_iva", "per_ret_iibb", "imp_internos", "total", "saldo"],
    cobros: ["monto", "total"],
    cobros_detalle: ["monto_cancelado"],
    retenciones_ganancias: ["monto"],
    retenciones_iibb: ["monto"],
    caja: ["monto", "saldo"],
    cheques_entregados: ["monto"],
    cheques_recibidos: ["monto"],
    cuotas_planes_pagos: [
      "capital",
      "interes_financiero",
      "interes_resarcitorio",
      "total_primer_vencimiento",
      "total_segundo_vencimiento",
      "monto_pagado"
    ],
    aportes_socios: ["monto"],
    egresos: ["iva", "per_ret_iva", "per_ret_iibb", "imp_internos", "subtotal", "total", "saldo"],
    pagos: ["monto", "total"],
    detalle_pagos: ["monto_cancelado"],
    comisiones: ["subtotal", "comision"],
    sueldos: ["sueldo_bruto", "sueldo_neto", "valor_remunerativo", "valor_no_remunerativo", "premios", "total"],
    sueldos_calculo: ["sueldo_bruto", "sueldo_neto", "valor_remunerativo", "valor_no_remunerativo", "premios", "total"],
    gastos_economicos: ["importe", "monto", "capital", "intereses", "total"],
    gastos_egresos: ["importe_aplicado", "monto", "monto_aplicado"],
    inventarios: ["valor_total"],
    detalle_inventarios: ["costo", "costo_unitario", "costo_unitario_usado", "valor", "valor_total"]
  });
  Object.values(columnsByTable).forEach(Object.freeze);

  const percentageColumnsByTable = Object.freeze({
    insumos_proveedores: ["iva"]
  });
  Object.values(percentageColumnsByTable).forEach(Object.freeze);

  const normalizedSets = Object.freeze(Object.fromEntries(
    Object.entries(columnsByTable).map(([table, columns]) => [table, new Set(columns)])
  ));
  const normalizedPercentageSets = Object.freeze(Object.fromEntries(
    Object.entries(percentageColumnsByTable).map(([table, columns]) => [table, new Set(columns)])
  ));

  function isMoneyColumn(tableName, columnName) {
    const table = String(tableName || "").trim().toLowerCase();
    const column = String(columnName || "").trim().toLowerCase();
    return normalizedSets[table]?.has(column) || false;
  }

  function isPercentageColumn(tableName, columnName) {
    const table = String(tableName || "").trim().toLowerCase();
    const column = String(columnName || "").trim().toLowerCase();
    return normalizedPercentageSets[table]?.has(column) || false;
  }

  function parsePercentageInput(rawValue, options = {}) {
    const allowEmpty = options.allowEmpty !== false;
    if (typeof rawValue !== "string" && typeof rawValue !== "number") {
      return { ok: false, value: null, empty: false };
    }
    const text = String(rawValue).trim();
    if (!text) return allowEmpty
      ? { ok: true, value: null, empty: true }
      : { ok: false, value: null, empty: false };
    const normalized = text.replace(/\s*%\s*$/, "").trim().replace(",", ".");
    if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
      return { ok: false, value: null, empty: false };
    }
    const value = Number(normalized);
    return Number.isFinite(value)
      ? { ok: true, value: Math.round(value * 100) / 100, empty: false }
      : { ok: false, value: null, empty: false };
  }

  function formatPercentage(rawValue) {
    const parsed = parsePercentageInput(rawValue, { allowEmpty: false });
    if (!parsed.ok) throw new TypeError("Invalid percentage value");
    return `${parsed.value.toFixed(2)}%`;
  }

  return Object.freeze({
    columnsByTable,
    percentageColumnsByTable,
    isMoneyColumn,
    isPercentageColumn,
    parsePercentageInput,
    formatPercentage
  });
});
