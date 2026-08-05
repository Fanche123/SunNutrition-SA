const ADMIN_TABLE_POLICY = {
  etiquetas: editable(["etiqueta"]),
  otros_acreedores: editable(["nombre_otro_acreedor"]),
  proveedores: editable(["nombre"]),
  clientes: editable(["nombre_cliente"], {
    references: [{ column: "id_canal", table: "canales", target: "id_canal", optional: true }]
  }),
  empleados: editable(["nombre_empleado"], {
    isoDates: ["fecha_alta", "fecha_baja"]
  }),
  canales: editable(["nombre"]),
  fletes: editable(["nombre_flete"]),

  acreedores: editable(),
  acreedores_etiquetas: editable(),
  datos_bancarios: editable(),
  items: editable(),
  productos: editable(),
  subproductos: editable(),
  insumos: editable(),
  insumos_proveedores: editable(),
  recetas: editable(),
  caja: editable(),
  sueldos_calculo: editable(),
  planes_pagos: editable(),
  cuotas_planes_pagos: editable(),
  gastos_economicos: editable(),
  gastos_egresos: editable(),
  fondos_inversion_movimientos: policy(
    true,
    false,
    false,
    false,
    "operational-readonly",
    "Los movimientos del fondo se administran desde Tesoreria para conservar saldos y relaciones."
  ),
  caja_efectivo_movimientos: policy(
    true,
    false,
    false,
    false,
    "operational-readonly",
    "El libro de Caja Efectivo es append-only y se administra desde los flujos confirmados de Tesoreria."
  ),

  movimientos_bancarios: editable(),
  pedidos: editable(),
  detalle_pedidos: editable(),
  entregas: editable(),
  entregas_detalle: editable(),
  ventas: editable(),
  cobros: editable(),
  cobros_detalle: editable(),
  retenciones_ganancias: editable(),
  retenciones_iibb: editable(),
  cheques_entregados: editable(),
  cheques_recibidos: editable(),
  compras: editable(),
  detalle_compras: editable(),
  recepciones: editable(),
  detalle_recepciones: editable(),
  otros_gastos: editable(),
  aportes_socios: editable(),
  egresos: editable(),
  pagos: editable(),
  detalle_pagos: editable(),
  comisiones: editable(),
  sueldos: editable(),
  inventarios: editable(),
  detalle_inventarios: editable(),
  contadores_alipack: policy(
    true,
    false,
    false,
    false,
    "operational-readonly",
    "Los contadores Alipack se registran unicamente con la carga integral de Inventario."
  )
};

function editable(required = [], validation = {}) {
  return policy(
    true,
    true,
    true,
    true,
    "administrative",
    "Edicion directa habilitada en el Editor de datos.",
    { required, ...validation }
  );
}

function policy(read, insert, update, remove, category, reason, validation = {}) {
  return Object.freeze({
    read,
    insert,
    update,
    delete: remove,
    category,
    reason,
    validation: Object.freeze(validation)
  });
}

function adminTableCapability(tableName) {
  const entry = ADMIN_TABLE_POLICY[tableName];
  if (!entry) {
    return {
      read: false,
      insert: false,
      update: false,
      delete: false,
      category: "denied",
      reason: "Tabla no habilitada para Administracion."
    };
  }
  const { validation, ...capability } = entry;
  return capability;
}

module.exports = { ADMIN_TABLE_POLICY, adminTableCapability };
