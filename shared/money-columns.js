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

  const normalizedSets = Object.freeze(Object.fromEntries(
    Object.entries(columnsByTable).map(([table, columns]) => [table, new Set(columns)])
  ));

  function isMoneyColumn(tableName, columnName) {
    const table = String(tableName || "").trim().toLowerCase();
    const column = String(columnName || "").trim().toLowerCase();
    return normalizedSets[table]?.has(column) || false;
  }

  return Object.freeze({ columnsByTable, isMoneyColumn });
});
