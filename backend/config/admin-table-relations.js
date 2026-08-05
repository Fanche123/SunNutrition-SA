const ADMIN_TABLE_RELATIONS = Object.freeze([
  relation("cobros", "id_cliente", "clientes", "id_cliente", "nombre_cliente", "Cliente"),
  relation("compras", "id_proveedor", "proveedores", "id_proveedor", "nombre", "Proveedor"),
  relation("recepciones", "id_empleado", "empleados", "id_empleado", "nombre_empleado", "Empleado"),
  relation("sueldos", "id_empleado", "empleados", "id_empleado", "nombre_empleado", "Empleado"),
  relation("inventarios", "id_empleado", "empleados", "id_empleado", "nombre_empleado", "Empleado"),
  relation("contadores_alipack", "id_inventario", "inventarios", "id_inventario", "id_inventario", "Inventario"),
  relation("cuotas_planes_pagos", "id_plan_pago", "planes_pagos", "id_plan_pago", "nombre", "Plan de pago"),
  relation("detalle_pedidos", "id_producto", "productos", "id_producto", "nombre_producto", "Producto")
]);

function relation(sourceTable, column, table, target, displayColumn, label) {
  return Object.freeze({ sourceTable, column, table, target, displayColumn, label });
}

function adminRelationsForTable(tableName) {
  return ADMIN_TABLE_RELATIONS.filter((entry) => entry.sourceTable === tableName);
}

module.exports = { ADMIN_TABLE_RELATIONS, adminRelationsForTable };
