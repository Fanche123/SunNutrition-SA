const { EXPECTED_BACKEND_COLUMNS } = require('./backend-columns');

const BACKEND_TABLE_PROJECTIONS = {
  etiquetas: {
    columns: EXPECTED_BACKEND_COLUMNS.etiquetas,
    aliases: {
      id_etiqueta: ["id_etiqueta"],
      etiqueta: ["etiqueta", "etiquetas", "nombre"],
      categoria_pnl: ["categoria_pnl", "categoria_p_n_l", "categoria", "categoria_estado_resultados"]
    }
  },
  acreedores: {
    columns: EXPECTED_BACKEND_COLUMNS.acreedores,
    aliases: {
      id_acreedor: ["id_acreedor"],
      origen_tipo_acreedor: ["origen_tipo_acreedor", "tipo"],
      origen_id_acreedor: ["origen_id_acreedor", "id_proveedor", "id_empleado", "id_canal", "id_flete"],
      cuit_cuil: ["cuit_cuil", "cuit", "cuil"],
      cbu_alias: ["cbu_alias", "cbu", "alias"],
      acuerdo_de_pago: ["acuerdo_de_pago"]
    }
  },
  otros_acreedores: {
    columns: EXPECTED_BACKEND_COLUMNS.otros_acreedores,
    aliases: {
      id_otro_acreedor: ["id_otro_acreedor", "id"],
      nombre_otro_acreedor: ["nombre_otro_acreedor", "nombre"]
    }
  },
  acreedores_etiquetas: {
    columns: EXPECTED_BACKEND_COLUMNS.acreedores_etiquetas,
    aliases: {
      id_acreedor_etiqueta: ["id_acreedor_etiqueta"],
      id_acreedor: ["id_acreedor"],
      id_etiqueta: ["id_etiqueta"]
    }
  },
  proveedores: {
    columns: EXPECTED_BACKEND_COLUMNS.proveedores,
    aliases: {
      id_proveedor: ["id_proveedor"],
      nombre: ["nombre"],
      telefono: ["telefono"],
      email: ["email"],
      tiempo_estimado_entrega: ["tiempo_estimado_entrega"],
      pedido_minimo: ["pedido_minimo", "minimo_de_pedido"]
    }
  },
  clientes: {
    columns: EXPECTED_BACKEND_COLUMNS.clientes,
    aliases: {
      id_cliente: ["id_cliente"],
      nombre_cliente: ["nombre_cliente", "nombre"],
      cuit: ["cuit"],
      direccion: ["direccion"],
      localidad: ["localidad"],
      contacto: ["contacto", "nombre_contacto"],
      telefono: ["telefono"],
      email: ["email"],
      id_canal: ["id_canal"],
      tipo: ["tipo", "id_tipo_cliente"],
      tipo_comprobante: ["tipo_comprobante", "tipo_de_comprobante"],
      plazo_cobro: ["plazo_cobro", "id_plazo_cobro"]
    }
  },
  empleados: {
    columns: EXPECTED_BACKEND_COLUMNS.empleados,
    aliases: {
      id_empleado: ["id_empleado"],
      nombre_empleado: ["nombre_empleado", "nombre"],
      categoria_empleado: ["categoria_empleado", "categoria"],
      fecha_alta: ["fecha_alta"],
      fecha_baja: ["fecha_baja"],
      dni: ["dni"],
      fecha_nacimiento: ["fecha_nacimiento"],
      direccion_empleado: ["direccion_empleado", "direccion"],
      localidad_empleado: ["localidad_empleado", "localidad"]
    }
  },
  canales: {
    columns: EXPECTED_BACKEND_COLUMNS.canales,
    aliases: {
      id_canal: ["id_canal"],
      nombre: ["nombre"],
      comision: ["comision"]
    }
  },
  fletes: {
    columns: EXPECTED_BACKEND_COLUMNS.fletes,
    aliases: {
      id_flete: ["id_flete"],
      nombre_flete: ["nombre_flete", "nombre"],
      telefono_flete: ["telefono_flete", "telefono"],
      email_flete: ["email_flete", "email"]
    }
  },
  datos_bancarios: {
    columns: EXPECTED_BACKEND_COLUMNS.datos_bancarios,
    aliases: {
      id_dato_bancario: ["id_dato_bancario", "id"],
      detalle: ["detalle", "informacion_complementaria", "descripcion"],
      id_acreedor: ["id_acreedor"],
      id_etiqueta: ["id_etiqueta"],
      tipo_factura: ["tipo_factura", "tipo de factura"]
    }
  },
  movimientos_bancarios: {
    columns: EXPECTED_BACKEND_COLUMNS.movimientos_bancarios,
    aliases: {
      id_movimiento_bancario: ["id_movimiento_bancario", "id", "id_movimiento"],
      banco: ["banco"],
      fecha: ["fecha", "fecha_contable", "fecha_banco"],
      cod_concepto: ["cod_concepto", "cod_de_concepto", "codigo_concepto"],
      concepto: ["concepto"],
      detalle: ["detalle", "informacion_complementaria", "descripcion"],
      cuit: ["cuit", "cuil", "nro_doc", "nro_documento"],
      nro_cheque: ["nro_cheque", "nro_de_cheque", "numero_cheque", "cheque"],
      debito: ["debito", "debito_en", "debito_en_$", "debitos"],
      credito: ["credito", "credito_en", "credito_en_$", "creditos"],
      importe: ["importe", "monto", "movimiento"],
      saldo: ["saldo", "saldo_en", "saldo_en_$"],
      id_pago: ["id_pago"],
      id_cobro: ["id_cobro"],
      id_movimiento_fondo: ["id_movimiento_fondo"]
    }
  },
  fondos_inversion_movimientos: {
    columns: EXPECTED_BACKEND_COLUMNS.fondos_inversion_movimientos,
    aliases: {
      id_movimiento_fondo: ["id_movimiento_fondo", "id"],
      fecha: ["fecha"],
      tipo: ["tipo"],
      importe: ["importe", "monto"],
      periodo_rendimiento: ["periodo_rendimiento", "periodo"],
      id_movimiento_bancario: ["id_movimiento_bancario"],
      id_pago: ["id_pago"],
      id_gasto_economico: ["id_gasto_economico"],
      referencia: ["referencia"],
      observacion: ["observacion"],
      clave_idempotencia: ["clave_idempotencia"],
      hash_payload: ["hash_payload"],
      creado_en: ["creado_en"]
    }
  },
  items: {
    columns: EXPECTED_BACKEND_COLUMNS.items,
    aliases: {
      id_item: ["id_item"],
      origen_tipo: ["origen_tipo", "tipo"],
      id_origen: ["id_origen"],
      ud_conteo: ["ud_conteo"]
    }
  },
  productos: {
    columns: EXPECTED_BACKEND_COLUMNS.productos,
    aliases: {
      id_producto: ["id_producto"],
      id_item: ["id_item"],
      nombre_producto: ["nombre_producto", "nombre"],
      capacidad_palet: ["capacidad_palet"],
      cantidad_individual: ["cantidad_individual"],
      precio_base: ["precio_base", "precio_original"],
      costo_base: ["costo_base", "costo"],
      costo_ud_individual: ["costo_ud_individual"]
    }
  },
  subproductos: {
    columns: EXPECTED_BACKEND_COLUMNS.subproductos,
    aliases: {
      id_subproducto: ["id_subproducto", "id_item"],
      id_item: ["id_item"],
      nombre_subproducto: ["nombre_subproducto", "nombre_producto", "nombre"],
      ud_conteo: ["ud_conteo"]
    }
  },
  insumos: {
    columns: EXPECTED_BACKEND_COLUMNS.insumos,
    aliases: {
      id_insumo: ["id_insumo"],
      nombre: ["nombre"],
      ud_receta: ["ud_receta"],
      cantidad_receta: ["cantidad_receta"],
      tipo: ["tipo"]
    }
  },
  insumos_proveedores: {
    columns: EXPECTED_BACKEND_COLUMNS.insumos_proveedores,
    aliases: {
      id_insumos_proveedores: ["id_insumos_proveedores"],
      id_insumo: ["id_insumo"],
      id_proveedor: ["id_proveedor"],
      ud_proveedor: ["ud_proveedor"],
      cantidad_proveedor: ["cantidad_proveedor", "cantidad_receta"],
      precio: ["precio", "precio_unitario"],
      iva: ["iva"]
    }
  },
  recetas: {
    columns: EXPECTED_BACKEND_COLUMNS.recetas,
    aliases: {
      id_receta: ["id_receta", "_rowNumber"],
      id_item_resultado: ["id_item_resultado"],
      id_item_componente: ["id_item_componente", "id_item"],
      cantidad_componente: ["cantidad_componente", "cantidad"],
      unidad_base: ["unidad_base", "ud_receta"]
    }
  },
  pedidos: {
    columns: EXPECTED_BACKEND_COLUMNS.pedidos,
    aliases: {
      id_pedido: ["id_pedido"],
      fecha_pedido: ["fecha_pedido", "fecha"],
      id_cliente: ["id_cliente"],
      fecha_entrega: ["fecha_entrega"],
      fecha_original: ["fecha_original"]
    }
  },
  detalle_pedidos: {
    columns: EXPECTED_BACKEND_COLUMNS.detalle_pedidos,
    aliases: {
      id_detalle_pedido: ["id_detalle_pedido"],
      id_pedido: ["id_pedido"],
      id_producto: ["id_producto"],
      cantidad_cajas: ["cantidad_cajas"],
      impuesto: ["impuesto"],
      precio_ud: ["precio_ud", "precio_unidad"],
      bonificacion: ["bonificacion", "bonif"]
    }
  },
  entregas: {
    columns: EXPECTED_BACKEND_COLUMNS.entregas,
    aliases: {
      id_entrega: ["id_entrega"],
      fecha: ["fecha"],
      id_flete: ["id_flete"],
      id_acreedor_etiqueta: ["id_acreedor_etiqueta"],
      id_egreso: ["id_egreso"]
    }
  },
  entregas_detalle: {
    columns: EXPECTED_BACKEND_COLUMNS.entregas_detalle,
    aliases: {
      id_entregas_detalle: ["id_entregas_detalle", "id_entrega_pedido", "_rowNumber"],
      id_entrega: ["id_entrega"],
      id_pedido: ["id_pedido"]
    }
  },
  ventas: {
    columns: EXPECTED_BACKEND_COLUMNS.ventas,
    aliases: {
      id_venta: ["id_venta"],
      id_pedido: ["id_pedido"],
      id_cliente: ["id_cliente"],
      id_entrega: ["id_entrega"],
      tipo_factura: ["tipo_factura"],
      nro_factura: ["nro_factura"],
      fecha_factura: ["fecha_factura"],
      fecha_acordada: ["fecha_acordada", "fecha_prevista_cobro", "fecha_prevista_de_cobro"],
      iva: ["iva"],
      subtotal: ["subtotal", "sub_total"],
      total: ["total"]
    }
  },
  cobros: {
    columns: EXPECTED_BACKEND_COLUMNS.cobros,
    aliases: {
      id_cobro: ["id_cobro"],
      fecha_cobro: ["fecha_cobro", "fecha"],
      metodo: ["metodo", "forma_cobro", "id_forma_pago"],
      id_cliente: ["id_cliente"],
      monto: ["monto", "total"],
      banco: ["banco"]
    }
  },
  cobros_detalle: {
    columns: EXPECTED_BACKEND_COLUMNS.cobros_detalle,
    aliases: {
      id_cobros_detalle: ["id_cobros_detalle", "id_cobro_venta", "_rowNumber"],
      id_cobro: ["id_cobro"],
      id_venta: ["id_venta"],
      monto_cancelado: ["monto_cancelado"]
    }
  },
  retenciones_ganancias: {
    columns: EXPECTED_BACKEND_COLUMNS.retenciones_ganancias,
    aliases: {
      id_retencion_ganancias: ["id_retencion_ganancias", "id_retencion", "_rowNumber"],
      id_cobro: ["id_cobro"],
      fecha: ["fecha", "fecha_retencion"],
      id_cliente: ["id_cliente"],
      monto: ["monto", "retencion_ganancias", "ret_ganancias"]
    }
  },
  retenciones_iibb: {
    columns: EXPECTED_BACKEND_COLUMNS.retenciones_iibb,
    aliases: {
      id_retencion_iibb: ["id_retencion_iibb", "id_retencion", "_rowNumber"],
      id_cobro: ["id_cobro"],
      fecha: ["fecha", "fecha_retencion"],
      id_cliente: ["id_cliente"],
      monto: ["monto", "retencion_iibb", "ret_iibb", "ingresos_brutos"]
    }
  },
  caja: {
    columns: EXPECTED_BACKEND_COLUMNS.caja,
    aliases: {
      cuenta: ["cuenta", "formato", "banco", "account"],
      monto: ["monto", "saldo", "saldo_inicial"]
    }
  },
  cheques_entregados: {
    columns: EXPECTED_BACKEND_COLUMNS.cheques_entregados,
    aliases: {
      id_cheque_entregado: ["id_cheque_entregado", "id_chequeentregado"],
      id_pago: ["id_pago"],
      id_acreedor: ["id_acreedor"],
      nro_cheque: ["nro_cheque"],
      fecha_entregado: ["fecha_entregado"],
      fecha_uso: ["fecha_uso", "fecha_de_uso"],
      monto: ["monto"],
      acreedor: ["acreedor"],
      banco: ["banco"],
      estado: ["estado"]
    }
  },
  cheques_recibidos: {
    columns: EXPECTED_BACKEND_COLUMNS.cheques_recibidos,
    aliases: {
      id_cheque_recibido: ["id_cheque_recibido", "id_chequerecibido"],
      id_cobro: ["id_cobro"],
      fecha_entregado: ["fecha_entregado"],
      monto: ["monto"],
      cliente: ["cliente"],
      id_cliente: ["id_cliente"],
      nro_cheque: ["nro_cheque"],
      fecha_uso: ["fecha_uso", "fecha_de_uso"],
      estado: ["estado"],
      banco: ["banco"],
      fecha_deposito: ["fecha_deposito"],
      id_deposito: ["id_deposito"],
      id_pago_endoso: ["id_pago_endoso"],
      fecha_endoso: ["fecha_endoso"]
    }
  },
  compras: {
    columns: EXPECTED_BACKEND_COLUMNS.compras,
    aliases: {
      id_compra: ["id_compra"],
      id_proveedor: ["id_proveedor"],
      fecha_pedido: ["fecha_pedido"],
      fecha_entrega_prevista: ["fecha_entrega_prevista"]
    }
  },
  detalle_compras: {
    columns: EXPECTED_BACKEND_COLUMNS.detalle_compras,
    aliases: {
      id_detalle_compra: ["id_detalle_compra"],
      id_compra: ["id_compra"],
      id_insumos_proveedores: ["id_insumos_proveedores", "id_insumo", "id_item"],
      cantidad: ["cantidad"]
    }
  },
  gestion_compras: {
    columns: EXPECTED_BACKEND_COLUMNS.gestion_compras,
    aliases: {
      id_gestion_compra: ["id_gestion_compra"], id_compra: ["id_compra"], cerrado_en: ["cerrado_en"],
      cerrado_por: ["cerrado_por"], claves_recepcion: ["claves_recepcion"], clave_factura: ["clave_factura"],
      creado_en: ["creado_en"], actualizado_en: ["actualizado_en"]
    }
  },
  recepciones: {
    columns: EXPECTED_BACKEND_COLUMNS.recepciones,
    aliases: {
      id_recepcion: ["id_recepcion"],
      fecha_recepcion: ["fecha_recepcion", "fecha"],
      id_empleado: ["id_empleado"],
      id_compra: ["id_compra"],
      id_acreedor_etiqueta: ["id_acreedor_etiqueta"],
      id_egreso: ["id_egreso"],
      archivo_recepcion: ["archivo_recepcion", "archivo", "comprobante"]
    }
  },
  detalle_recepciones: {
    columns: EXPECTED_BACKEND_COLUMNS.detalle_recepciones,
    aliases: {
      id_detalle_recepcion: ["id_detalle_recepcion"],
      id_recepcion: ["id_recepcion"],
      id_insumo: ["id_insumo", "id_item"],
      cantidad_recibida: ["cantidad_recibida", "cantidad"]
    }
  },
  otros_gastos: {
    columns: EXPECTED_BACKEND_COLUMNS.otros_gastos,
    aliases: {
      id_otros_gastos: ["id_otros_gastos", "id_gasto"],
      fecha_otros_gastos: ["fecha_otros_gastos", "fecha"],
      id_acreedor: ["id_acreedor"],
      id_acreedor_etiqueta: ["id_acreedor_etiqueta"],
      id_egreso: ["id_egreso"],
      detalle: ["detalle"]
    }
  },
  aportes_socios: {
    columns: EXPECTED_BACKEND_COLUMNS.aportes_socios,
    aliases: {
      id_aporte_socio: ["id_aporte_socio", "id"],
      fecha: ["fecha", "fecha_aporte"],
      nombre: ["nombre", "socio"],
      tipo: ["tipo", "tipo_movimiento"],
      monto: ["monto", "importe", "total"],
      id_egreso: ["id_egreso"]
    }
  },
  egresos: {
    columns: EXPECTED_BACKEND_COLUMNS.egresos,
    aliases: {
      id_egreso: ["id_egreso"],
      fecha_factura: ["fecha_factura"],
      fecha_prevista_pago: ["fecha_prevista_pago", "fecha_prevista_de_pago", "fecha prevista pago", "fecha prevista de pago"],
      id_etiqueta: ["id_etiqueta"],
      tipo_factura: ["tipo_factura", "tipo_de_factura"],
      nro_factura: ["nro_factura"],
      iva: ["iva"],
      per_ret_iva: ["per_ret_iva"],
      per_ret_iibb: ["per_ret_iibb"],
      imp_internos: ["imp_internos", "i_internos"],
      subtotal: ["subtotal"],
      total: ["total"]
    }
  },
  pagos: {
    columns: EXPECTED_BACKEND_COLUMNS.pagos,
    aliases: {
      id_pago: ["id_pago"],
      fecha_pago: ["fecha_pago", "fecha"],
      metodo: ["metodo", "id_forma_pago", "forma_pago"],
      banco: ["banco"],
      monto: ["monto"]
    }
  },
  detalle_pagos: {
    columns: EXPECTED_BACKEND_COLUMNS.detalle_pagos,
    aliases: {
      id_detalle_pago: ["id_detalle_pago", "id_pago_egreso"],
      id_pago: ["id_pago"],
      id_egreso: ["id_egreso"],
      monto_cancelado: ["monto_cancelado"]
    }
  },
  sueldos: {
    columns: EXPECTED_BACKEND_COLUMNS.sueldos,
    aliases: {
      id_sueldo: ["id_sueldo", "_rowNumber"],
      fecha: ["fecha", "mes"],
      id_empleado: ["id_empleado"],
      id_acreedor_etiqueta: ["id_acreedor_etiqueta"],
      id_egreso: ["id_egreso"],
      valor_remunerativo: ["valor_remunerativo"],
      valor_no_remunerativo: ["valor_no_remunerativo"],
      hs_trabajadas: ["hs_trabajadas"],
      hs_con_justificacion_medica: ["hs_con_justificacion_medica", "no_trabajadas_c_justificativo_o_feriados"],
      hs_feriado: ["hs_feriado"],
      hs_extra: ["hs_extra"],
      premios: ["premios"],
      sueldo_bruto: ["sueldo_bruto", "bruto"],
      sueldo_neto: ["sueldo_neto", "neto"]
    }
  },
  comisiones: {
    columns: EXPECTED_BACKEND_COLUMNS.comisiones,
    aliases: {
      id_comision: ["id_comision", "_rowNumber"],
      fecha: ["fecha"],
      id_canal: ["id_canal"],
      id_acreedor_etiqueta: ["id_acreedor_etiqueta"],
      id_egreso: ["id_egreso"],
      id_venta: ["id_venta"],
      subtotal: ["subtotal"],
      comision: ["comision"]
    }
  },
  sueldos_calculo: {
    columns: EXPECTED_BACKEND_COLUMNS.sueldos_calculo,
    aliases: {
      id_sueldo: ["id_sueldo"],
      fecha: ["fecha", "mes"],
      id_empleado: ["id_empleado"],
      valor_remunerativo: ["valor_remunerativo"],
      valor_no_remunerativo: ["valor_no_remunerativo"],
      hs_trabajadas: ["hs_trabajadas"],
      hs_con_justificacion_medica: ["hs_con_justificacion_medica", "no_trabajadas_c_justificativo_o_feriados"],
      hs_feriado: ["hs_feriado"],
      hs_extra: ["hs_extra"],
      premios: ["premios", "presentismo", "premio_pochocleras"],
      sueldo_bruto: ["sueldo_bruto", "bruto"],
      sueldo_neto: ["sueldo_neto", "neto"]
    }
  },
  inventarios: {
    columns: EXPECTED_BACKEND_COLUMNS.inventarios,
    aliases: {
      id_inventario: ["id_inventario"],
      fecha: ["fecha"],
      turno: ["turno"],
      id_empleado: ["id_empleado"],
      valor_total: ["valor_total"]
    }
  },
  detalle_inventarios: {
    columns: EXPECTED_BACKEND_COLUMNS.detalle_inventarios,
    aliases: {
      id_detalle_inventario: ["id_detalle_inventario", "_rowNumber"],
      id_inventario: ["id_inventario"],
      id_item: ["id_item"],
      cantidad: ["cantidad", "cantidad_formulario"],
      costo_unitario_usado: ["costo_unitario_usado"],
      valor_total: ["valor_total"]
    }
  },
  contadores_alipack: {
    columns: EXPECTED_BACKEND_COLUMNS.contadores_alipack,
    aliases: {
      id_contador_alipack: ["id_contador_alipack"],
      id_inventario: ["id_inventario"],
      valor_contador: ["valor_contador", "contador_alipack"]
    }
  }
};

module.exports = { BACKEND_TABLE_PROJECTIONS };
