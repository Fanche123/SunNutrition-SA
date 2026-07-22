const crypto = require("crypto");
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const {
  backendOverview,
  backendSchema,
  backendSources,
  backendTable,
  loadCache,
  loadRegistry,
  saveBackendCache,
  saveBackendSources
} = require("./backend/data-store");
const { DEFAULT_BANK_DETAIL_RULES } = require("./backend/bank-rules");
const { MIME_TYPES } = require("./backend/http-config");

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const APP_STATE_FILE = path.join(ROOT_DIR, "tmp", "app-state.json");
const BACKEND_CACHE_FILE = path.join(ROOT_DIR, "tmp", "backend-data-cache.json");
const BACKEND_SQL_SCRIPT = path.join(ROOT_DIR, "tools", "backend-sqlite-query.py");
const PYTHON_EXECUTABLE = process.env.PYTHON_EXECUTABLE || path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
let cachedGoogleToken = null;

const EXPECTED_BACKEND_COLUMNS = {
  etiquetas: ["id_etiqueta", "etiqueta", "categoria_pnl"],
  acreedores: ["id_acreedor", "origen_tipo_acreedor", "origen_id_acreedor", "cuit_cuil", "cbu_alias", "acuerdo_de_pago"],
  otros_acreedores: ["id_otro_acreedor", "nombre_otro_acreedor"],
  acreedores_etiquetas: ["id_acreedor_etiqueta", "id_acreedor", "id_etiqueta"],
  proveedores: ["id_proveedor", "nombre", "telefono", "email", "tiempo_estimado_entrega", "pedido_minimo"],
  clientes: ["id_cliente", "nombre_cliente", "cuit", "direccion", "localidad", "contacto", "telefono", "email", "id_canal", "tipo", "tipo_comprobante", "plazo_cobro"],
  empleados: ["id_empleado", "nombre_empleado", "categoria_empleado", "fecha_alta", "fecha_baja", "dni", "fecha_nacimiento", "direccion_empleado", "localidad_empleado"],
  canales: ["id_canal", "nombre", "comision"],
  fletes: ["id_flete", "nombre_flete", "telefono_flete", "email_flete"],
  datos_bancarios: ["id_dato_bancario", "detalle", "id_acreedor", "id_etiqueta", "tipo_factura"],
  movimientos_bancarios: ["id_movimiento_bancario", "banco", "fecha", "cod_concepto", "concepto", "detalle", "cuit", "nro_cheque", "debito", "credito", "importe", "saldo", "id_pago", "id_cobro"],
  items: ["id_item", "origen_tipo", "id_origen", "ud_conteo"],
  productos: ["id_producto", "id_item", "nombre_producto", "capacidad_palet", "cantidad_individual", "precio_base", "costo_base", "costo_ud_individual"],
  subproductos: ["id_subproducto", "id_item", "nombre_subproducto", "ud_conteo"],
  insumos: ["id_insumo", "nombre", "ud_receta", "cantidad_receta", "tipo"],
  insumos_proveedores: ["id_insumos_proveedores", "id_insumo", "id_proveedor", "ud_proveedor", "cantidad_proveedor", "precio", "iva"],
  recetas: ["id_receta", "id_item_resultado", "id_item_componente", "cantidad_componente", "unidad_base"],
  pedidos: ["id_pedido", "fecha_pedido", "id_cliente", "fecha_entrega", "fecha_original"],
  detalle_pedidos: ["id_detalle_pedido", "id_pedido", "id_producto", "cantidad_cajas", "impuesto", "precio_ud", "bonificacion"],
  entregas: ["id_entrega", "fecha", "id_flete", "id_acreedor_etiqueta", "id_egreso"],
  entregas_detalle: ["id_entregas_detalle", "id_entrega", "id_pedido"],
  ventas: ["id_venta", "id_pedido", "id_cliente", "id_entrega", "tipo_factura", "nro_factura", "fecha_factura", "fecha_acordada", "iva", "subtotal", "total"],
  cobros: ["id_cobro", "fecha_cobro", "metodo", "id_cliente", "monto", "banco"],
  cobros_detalle: ["id_cobros_detalle", "id_cobro", "id_venta", "monto_cancelado"],
  retenciones_ganancias: ["id_retencion_ganancias", "id_cobro", "fecha", "id_cliente", "monto"],
  retenciones_iibb: ["id_retencion_iibb", "id_cobro", "fecha", "id_cliente", "monto"],
  caja: ["cuenta", "monto"],
  cheques_entregados: ["id_cheque_entregado", "id_pago", "id_acreedor", "nro_cheque", "fecha_entregado", "fecha_uso", "monto", "banco", "estado"],
  cheques_recibidos: ["id_cheque_recibido", "id_cobro", "fecha_entregado", "monto", "cliente", "id_cliente", "nro_cheque", "fecha_uso", "estado", "banco", "fecha_deposito", "id_deposito"],
  compras: ["id_compra", "id_proveedor", "fecha_pedido", "fecha_entrega_prevista"],
  detalle_compras: [
    "id_detalle_compra",
    "id_compra",
    "id_insumos_proveedores",
    "cantidad"
  ],
  recepciones: ["id_recepcion", "fecha_recepcion", "id_empleado", "id_compra", "id_acreedor_etiqueta", "id_egreso", "archivo_recepcion"],
  detalle_recepciones: ["id_detalle_recepcion", "id_recepcion", "id_insumo", "cantidad_recibida"],
  otros_gastos: ["id_otros_gastos", "fecha_otros_gastos", "id_acreedor", "id_acreedor_etiqueta", "id_egreso", "detalle"],
  aportes_socios: ["id_aporte_socio", "fecha", "nombre", "tipo", "monto", "id_egreso"],
  planes_pagos: ["id_plan_pago", "nombre", "organismo"],
  cuotas_planes_pagos: ["id_cuota_plan_pago", "id_plan_pago", "nro_cuota", "capital", "interes_financiero", "interes_resarcitorio", "total_primer_vencimiento", "fecha_primer_vencimiento", "total_segundo_vencimiento", "fecha_segundo_vencimiento", "id_egreso"],
  egresos: ["id_egreso", "fecha_factura", "fecha_prevista_pago", "id_etiqueta", "tipo_factura", "nro_factura", "iva", "per_ret_iva", "per_ret_iibb", "imp_internos", "subtotal", "total"],
  pagos: ["id_pago", "fecha_pago", "metodo", "banco", "monto"],
  detalle_pagos: ["id_detalle_pago", "id_pago", "id_egreso", "monto_cancelado"],
  sueldos: ["id_sueldo", "fecha", "id_empleado", "id_acreedor_etiqueta", "id_egreso", "valor_remunerativo", "valor_no_remunerativo", "hs_trabajadas", "hs_con_justificacion_medica", "hs_feriado", "hs_extra", "premios", "sueldo_bruto", "sueldo_neto"],
  comisiones: ["id_comision", "fecha", "id_canal", "id_acreedor_etiqueta", "id_egreso", "id_venta", "subtotal", "comision"],
  sueldos_calculo: ["id_sueldo", "fecha", "id_empleado", "valor_remunerativo", "valor_no_remunerativo", "hs_trabajadas", "hs_con_justificacion_medica", "hs_feriado", "hs_extra", "premios", "sueldo_bruto", "sueldo_neto"],
  inventarios: ["id_inventario", "fecha", "turno", "id_empleado", "valor_total"],
  detalle_inventarios: ["id_detalle_inventario", "id_inventario", "id_item", "cantidad", "costo_unitario_usado", "valor_total"]
};

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
      id_cobro: ["id_cobro"]
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
      id_deposito: ["id_deposito"]
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
  }
};

ensurePartnerContributionsHistory();
ensurePaymentPlansHistory();

const server = http.createServer(async (request, response) => {
  try {
    setCorsHeaders(response);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.url === "/api/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.url === "/api/backend/schema" && request.method === "GET") {
      sendJson(response, 200, { ok: true, schema: backendSchema() });
      return;
    }

    if (request.url === "/api/backend/tables" && request.method === "GET") {
      sendJson(response, 200, { ok: true, ...backendOverview() });
      return;
    }

    if (request.url === "/api/backend/sources" && request.method === "GET") {
      sendJson(response, 200, { ok: true, sources: backendSources() });
      return;
    }

    if (request.url === "/api/backend/map" && request.method === "GET") {
      sendJson(response, 200, { ok: true, map: backendColumnsMap() });
      return;
    }

    if (request.url.startsWith("/api/reports/income-statement") && request.method === "GET") {
      handleIncomeStatementReport(request, response);
      return;
    }

    if (request.url.startsWith("/api/reports/cashflow") && request.method === "GET") {
      handleCashflowReport(request, response);
      return;
    }

    if (request.url === "/api/bank-reconciliation/analyze" && request.method === "POST") {
      await handleBankReconciliationAnalyze(request, response);
      return;
    }

    if (request.url === "/api/bank-reconciliation/apply" && request.method === "POST") {
      await handleBankReconciliationApply(request, response);
      return;
    }

    if (request.url === "/api/bank-reconciliation/deposit-checks" && request.method === "POST") {
      await handleBankReconciliationDepositChecks(request, response);
      return;
    }

    if (request.url === "/api/backend/sql" && request.method === "POST") {
      await handleBackendSqlQuery(request, response);
      return;
    }

    if (request.url === "/api/reception-attachments" && request.method === "POST") {
      await handleReceptionAttachmentSave(request, response);
      return;
    }

    if (request.url === "/api/reception-invoice/read" && request.method === "POST") {
      await handleReceptionInvoiceRead(request, response);
      return;
    }

    if (request.url === "/api/payroll-scale/read" && request.method === "POST") {
      await handlePayrollScaleRead(request, response);
      return;
    }

    if (request.url === "/api/backend/sources" && request.method === "POST") {
      await handleBackendSourcesSave(request, response);
      return;
    }

    if (request.url === "/api/backend/refresh" && request.method === "POST") {
      await handleBackendRefresh(request, response);
      return;
    }

    if (request.url === "/api/creditors/create" && request.method === "POST") {
      await handleCreditorCreate(request, response);
      return;
    }

    if (request.url.startsWith("/api/backend/tables/") && request.method === "POST") {
      await handleBackendTableSave(request, response);
      return;
    }

    if (request.url.startsWith("/api/backend/tables/") && request.method === "GET") {
      handleBackendTableRequest(request, response);
      return;
    }

    if (request.url === "/api/app-state" && request.method === "GET") {
      await handleAppStateGet(response);
      return;
    }

    if (request.url === "/api/app-state" && request.method === "POST") {
      await handleAppStateSave(request, response);
      return;
    }

    if (request.url === "/api/imports/refresh" && request.method === "POST") {
      await handleImportsRefresh(request, response);
      return;
    }

    if (request.url === "/api/inventory/append" && request.method === "POST") {
      await handleInventoryAppend(request, response);
      return;
    }

    if (request.url === "/api/inventory/latest-date" && request.method === "GET") {
      await handleInventoryLatestDate(response);
      return;
    }

    if (request.url === "/api/inventory/full-entry" && request.method === "POST") {
      await handleInventoryFullEntry(request, response);
      return;
    }

    if (request.url === "/api/inventory-detail/template" && request.method === "GET") {
      await handleInventoryDetailTemplate(response);
      return;
    }

    if (request.url === "/api/inventory-detail/append" && request.method === "POST") {
      await handleInventoryDetailAppend(request, response);
      return;
    }

    if (request.url === "/api/inventory-detail/photo" && request.method === "POST") {
      await handleInventoryDetailPhoto(request, response);
      return;
    }

    if (request.url === "/api/purchases/full-entry" && request.method === "POST") {
      await handlePurchaseFullEntry(request, response);
      return;
    }

    if (request.url.startsWith("/api/")) {
      sendJson(response, 404, { error: "Endpoint no encontrado." });
      return;
    }

    serveStaticFile(request, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "Error interno del servidor." });
  }
});

ensureBankDetailsSchema();

server.listen(PORT, () => {
  console.log(`SunNutrition ERP escuchando en http://127.0.0.1:${PORT}`);
});

function handleBackendTableRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const tableName = decodeURIComponent(url.pathname.replace("/api/backend/tables/", "")).trim();
  const table = backendTable(tableName, {
    search: url.searchParams.get("search") || "",
    limit: url.searchParams.get("limit") || "",
    offset: url.searchParams.get("offset") || "",
    all: url.searchParams.get("all") === "true"
  });

  if (!table) {
    sendJson(response, 404, { ok: false, error: "Tabla no encontrada." });
    return;
  }

  sendJson(response, 200, { ok: true, table });
}

async function handleBackendTableSave(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const tableName = decodeURIComponent(url.pathname.replace("/api/backend/tables/", "")).trim();
    const body = await readJsonBody(request);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const deletedIds = Array.isArray(body.deletedIds) ? body.deletedIds.map(backendId).filter(Boolean) : [];
    if (!rows.length && !deletedIds.length) {
      sendJson(response, 400, { ok: false, error: "No hay filas para guardar." });
      return;
    }

    const cache = loadCache();
    cache.tables = cache.tables || {};
    let table = cache.tables[tableName];
    // Algunas tablas internas se crean al registrar su primer movimiento.
    if (!table && Object.prototype.hasOwnProperty.call(EXPECTED_BACKEND_COLUMNS, tableName)) {
      ensureBackendTable(cache.tables, tableName);
      table = cache.tables[tableName];
    }
    if (!table) {
      sendJson(response, 404, { ok: false, error: "Tabla no encontrada." });
      return;
    }

    const columns = backendEditableColumns(tableName, table);
    const primaryKey = backendEditablePrimaryKey(tableName, table, columns);
    const currentRows = Array.isArray(table.rows) ? table.rows : [];
    const byId = new Map();
    currentRows.forEach((row, index) => {
      const id = backendId(row[primaryKey]);
      if (id) byId.set(id, index);
    });

    let nextId = backendNextNumericId(currentRows, primaryKey);
    let updated = 0;
    let inserted = 0;
    let deleted = 0;

    if (primaryKey && deletedIds.length) {
      const idsToDelete = new Set(deletedIds);
      for (let index = currentRows.length - 1; index >= 0; index -= 1) {
        if (!idsToDelete.has(backendId(currentRows[index][primaryKey]))) continue;
        currentRows.splice(index, 1);
        deleted += 1;
      }
    }

    const rowsToSave = rows.filter((inputRow) => {
      const hasPrimaryKey = primaryKey && backendId(inputRow[primaryKey]);
      const hasEditableValue = columns.some((column) =>
        column !== primaryKey && String(inputRow[column] ?? "").trim() !== ""
      );
      return hasPrimaryKey || hasEditableValue;
    });

    rowsToSave.forEach((inputRow) => {
      const cleanRow = {};
      columns.forEach((column) => {
        cleanRow[column] = inputRow[column] ?? "";
      });

      if (primaryKey && !backendId(cleanRow[primaryKey])) {
        cleanRow[primaryKey] = nextId;
        nextId += 1;
      }

      const id = primaryKey ? backendId(cleanRow[primaryKey]) : "";
      const existingIndex = id ? byId.get(id) : undefined;
      if (existingIndex !== undefined) {
        currentRows[existingIndex] = {
          ...currentRows[existingIndex],
          ...cleanRow,
          _editedLocallyAt: new Date().toISOString()
        };
        updated += 1;
      } else {
        currentRows.push({
          _rowNumber: currentRows.length + 2,
          ...cleanRow,
          _editedLocallyAt: new Date().toISOString()
        });
        inserted += 1;
      }
    });

    table.rows = currentRows;
    table.rowCount = currentRows.length;
    table.headers = columns;
    cache.generatedAt = new Date().toISOString();
    saveBackendCache(cache);

    sendJson(response, 200, {
      ok: true,
      table: backendTable(tableName, { limit: body.limit || 300, offset: body.offset || 0, search: body.search || "" }),
      updated,
      inserted,
      deleted
    });
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message });
  }
}

function normalizeCreditorOriginType(value) {
  const normalized = backendNormalizeText(value);
  if (normalized === "proveedor") return "proveedor";
  if (normalized === "flete") return "flete";
  if (normalized === "empleado") return "empleado";
  if (normalized === "canal") return "canal";
  if (["otros", "otro acreedor", "otros acreedores"].includes(normalized)) return "otros acreedores";
  return "";
}

function creditorOriginDefinition(originType) {
  const definitions = {
    proveedor: {
      tableName: "proveedores",
      idColumn: "id_proveedor",
      nameColumn: "nombre",
      createRow: (id, name, extra) => ({
        id_proveedor: id,
        nombre: name,
        telefono: cleanBackendText(extra.telefono),
        email: cleanBackendText(extra.email),
        tiempo_estimado_entrega: cleanBackendText(extra.tiempo_estimado_entrega),
        pedido_minimo: cleanBackendText(extra.pedido_minimo)
      })
    },
    flete: {
      tableName: "fletes",
      idColumn: "id_flete",
      nameColumn: "nombre_flete",
      createRow: (id, name, extra) => ({
        id_flete: id,
        nombre_flete: name,
        telefono_flete: cleanBackendText(extra.telefono_flete),
        email_flete: cleanBackendText(extra.email_flete)
      })
    },
    empleado: {
      tableName: "empleados",
      idColumn: "id_empleado",
      nameColumn: "nombre_empleado",
      createRow: (id, name, extra) => ({
        id_empleado: id,
        nombre_empleado: name,
        categoria_empleado: cleanBackendText(extra.categoria_empleado),
        fecha_alta: cleanBackendText(extra.fecha_alta),
        fecha_baja: "",
        dni: cleanBackendText(extra.dni),
        fecha_nacimiento: "",
        direccion_empleado: cleanBackendText(extra.direccion_empleado),
        localidad_empleado: cleanBackendText(extra.localidad_empleado)
      })
    },
    canal: {
      tableName: "canales",
      idColumn: "id_canal",
      nameColumn: "nombre",
      createRow: (id, name, extra) => ({
        id_canal: id,
        nombre: name,
        comision: cleanBackendText(extra.comision)
      })
    },
    "otros acreedores": {
      tableName: "otros_acreedores",
      idColumn: "id_otro_acreedor",
      nameColumn: "nombre_otro_acreedor",
      createRow: (id, name) => ({
        id_otro_acreedor: id,
        nombre_otro_acreedor: name
      })
    }
  };
  return definitions[originType] || null;
}

function fillBlankOriginFields(target, source) {
  Object.entries(source).forEach(([key, value]) => {
    if (key.startsWith("id_") || value === "" || value === null || value === undefined) return;
    if (target[key] === "" || target[key] === null || target[key] === undefined) target[key] = value;
  });
}

async function handleCreditorCreate(request, response) {
  try {
    const body = await readJsonBody(request);
    const originType = normalizeCreditorOriginType(body.originType);
    const name = cleanBackendText(body.name);
    const tagId = backendId(body.idEtiqueta);
    const extra = body.extra && typeof body.extra === "object" ? body.extra : {};
    const supplierItems = Array.isArray(body.supplierItems) ? body.supplierItems : [];
    const originDefinition = creditorOriginDefinition(originType);

    if (!originDefinition || !name || !tagId) {
      sendJson(response, 400, { ok: false, error: "Completa tipo, nombre y etiqueta del acreedor." });
      return;
    }

    const cache = loadCache();
    const tables = cache.tables || (cache.tables = {});
    const requiredTables = [originDefinition.tableName, "acreedores", "acreedores_etiquetas", "datos_bancarios", "etiquetas"];
    if (originType === "proveedor") requiredTables.push("insumos", "insumos_proveedores");
    requiredTables.forEach((tableName) => ensureBackendTable(tables, tableName));
    const tagExists = tables.etiquetas.rows.some((row) => backendId(row.id_etiqueta) === tagId);
    if (!tagExists) {
      sendJson(response, 400, { ok: false, error: "La etiqueta seleccionada no existe." });
      return;
    }

    const originRows = tables[originDefinition.tableName].rows;
    const normalizedName = backendNormalizeText(name);
    let originRow = originRows.find((row) => backendNormalizeText(row[originDefinition.nameColumn]) === normalizedName);
    if (!originRow) {
      const originId = backendNextNumericId(originRows, originDefinition.idColumn);
      originRow = originDefinition.createRow(originId, name, extra);
      originRows.push({ _rowNumber: originRows.length + 2, ...originRow });
    } else {
      fillBlankOriginFields(originRow, originDefinition.createRow(originRow[originDefinition.idColumn], name, extra));
    }
    const originId = backendId(originRow[originDefinition.idColumn]);

    const creditors = tables.acreedores.rows;
    let creditor = creditors.find((row) =>
      normalizeCreditorOriginType(row.origen_tipo_acreedor) === originType &&
      backendId(row.origen_id_acreedor) === originId
    );
    if (!creditor) {
      creditor = {
        _rowNumber: creditors.length + 2,
        id_acreedor: backendNextNumericId(creditors, "id_acreedor"),
        origen_tipo_acreedor: originType,
        origen_id_acreedor: originId,
        cuit_cuil: cleanBackendText(body.cuit),
        cbu_alias: cleanBackendText(body.cbuAlias),
        acuerdo_de_pago: cleanBackendText(body.paymentTerms)
      };
      creditors.push(creditor);
    } else {
      if (!cleanBackendText(creditor.cuit_cuil) && cleanBackendText(body.cuit)) creditor.cuit_cuil = cleanBackendText(body.cuit);
      if (!cleanBackendText(creditor.cbu_alias) && cleanBackendText(body.cbuAlias)) creditor.cbu_alias = cleanBackendText(body.cbuAlias);
      if (!cleanBackendText(creditor.acuerdo_de_pago) && cleanBackendText(body.paymentTerms)) creditor.acuerdo_de_pago = cleanBackendText(body.paymentTerms);
    }
    const creditorId = backendId(creditor.id_acreedor);

    let savedSupplierItemCount = 0;
    if (originType === "proveedor") {
      const supplierRows = tables.insumos_proveedores.rows;
      const supplyIds = new Set(tables.insumos.rows.map((row) => backendId(row.id_insumo)));
      supplierItems
        .filter((item) => backendId(item?.idInsumo))
        .forEach((item) => {
          const supplyId = backendId(item.idInsumo);
          const presentation = cleanBackendText(item.udProveedor);
          const quantity = cleanBackendText(item.cantidadProveedor);
          if (!supplyIds.has(supplyId)) {
            throw new Error("Uno de los insumos seleccionados ya no existe.");
          }
          if (!presentation || !quantity) {
            throw new Error("Cada insumo debe tener presentación y cantidad por presentación.");
          }
          const existing = supplierRows.find((row) =>
            backendId(row.id_proveedor) === originId &&
            backendId(row.id_insumo) === supplyId &&
            backendNormalizeText(row.ud_proveedor) === backendNormalizeText(presentation) &&
            String(row.cantidad_proveedor ?? "").trim() === quantity
          );
          if (existing) {
            if (cleanBackendText(item.precio)) existing.precio = cleanBackendText(item.precio);
            if (cleanBackendText(item.iva)) existing.iva = cleanBackendText(item.iva);
          } else {
            supplierRows.push({
              _rowNumber: supplierRows.length + 2,
              id_insumos_proveedores: backendNextNumericId(supplierRows, "id_insumos_proveedores"),
              id_insumo: supplyId,
              id_proveedor: originId,
              ud_proveedor: presentation,
              cantidad_proveedor: quantity,
              precio: cleanBackendText(item.precio),
              iva: cleanBackendText(item.iva)
            });
          }
          savedSupplierItemCount += 1;
        });
    }

    const tagRows = tables.acreedores_etiquetas.rows;
    let creditorTag = tagRows.find((row) => backendId(row.id_acreedor) === creditorId && backendId(row.id_etiqueta) === tagId);
    if (!creditorTag) {
      creditorTag = {
        _rowNumber: tagRows.length + 2,
        id_acreedor_etiqueta: backendNextNumericId(tagRows, "id_acreedor_etiqueta"),
        id_acreedor: creditorId,
        id_etiqueta: tagId
      };
      tagRows.push(creditorTag);
    }

    const bankDetail = cleanBackendText(body.bankDetail);
    if (bankDetail) {
      const bankRows = tables.datos_bancarios.rows;
      const normalizedDetail = backendNormalizeText(bankDetail);
      const existingDetail = bankRows.find((row) => backendNormalizeText(row.detalle) === normalizedDetail);
      if (existingDetail && backendId(existingDetail.id_acreedor) && backendId(existingDetail.id_acreedor) !== creditorId) {
        sendJson(response, 409, { ok: false, error: "Ese detalle bancario ya esta asociado a otro acreedor." });
        return;
      }
      if (existingDetail) {
        existingDetail.id_acreedor = creditorId;
        existingDetail.id_etiqueta = tagId;
      } else {
        bankRows.push({
          _rowNumber: bankRows.length + 2,
          id_dato_bancario: backendNextNumericId(bankRows, "id_dato_bancario"),
          detalle: bankDetail,
          id_acreedor: creditorId,
          id_etiqueta: tagId
        });
      }
    }

    [...requiredTables].forEach((tableName) => {
      tables[tableName].headers = EXPECTED_BACKEND_COLUMNS[tableName];
      tables[tableName].rowCount = tables[tableName].rows.length;
    });
    cache.generatedAt = new Date().toISOString();
    saveBackendCache(cache);
    sendJson(response, 200, {
      ok: true,
      creditorId,
      creditorTagId: creditorTag.id_acreedor_etiqueta,
      message: savedSupplierItemCount
        ? `Acreedor, etiqueta y ${savedSupplierItemCount} insumo(s) proveedor guardados correctamente.`
        : "Acreedor y etiqueta guardados correctamente."
    });
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message || "No se pudo guardar el acreedor." });
  }
}

async function handleReceptionAttachmentSave(request, response) {
  try {
    const body = await readJsonBody(request);
    const receptionId = String(body.receptionId || "").trim();
    const fileName = sanitizeFileName(String(body.fileName || ""));
    const base64 = String(body.dataBase64 || "").trim();
    if (!receptionId || !fileName || !base64) {
      sendJson(response, 400, { ok: false, error: "Faltan datos del archivo de recepcion." });
      return;
    }

    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length || buffer.length > 20 * 1024 * 1024) {
      sendJson(response, 400, { ok: false, error: "El archivo de recepcion esta vacio o supera 20 MB." });
      return;
    }

    const attachmentDir = path.join(ROOT_DIR, "backend", "attachments", "recepciones");
    fs.mkdirSync(attachmentDir, { recursive: true });
    const storedName = `${sanitizeFileName(receptionId)}-${Date.now()}-${fileName}`;
    const storedPath = path.join(attachmentDir, storedName);
    fs.writeFileSync(storedPath, buffer);
    sendJson(response, 200, {
      ok: true,
      path: path.relative(ROOT_DIR, storedPath).replace(/\\/g, "/"),
      fileName
    });
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message });
  }
}

async function handleReceptionInvoiceRead(request, response) {
  try {
    const body = await readJsonBody(request);
    const fileDataUrl = String(body.fileDataUrl || body.imageDataUrl || "");
    const fileName = sanitizeFileName(body.fileName || "factura_remito");
    const mimeType = String(body.mimeType || dataUrlMimeType(fileDataUrl) || "").trim();
    const isImage = fileDataUrl.startsWith("data:image/");
    const isPdf = fileDataUrl.startsWith("data:application/pdf");
    if (!isImage && !isPdf) {
      sendJson(response, 400, { ok: false, error: "Falta una imagen o PDF valido de factura o remito." });
      return;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      sendJson(response, 400, { ok: false, error: "Falta configurar OPENAI_API_KEY para leer facturas." });
      return;
    }

    const invoice = isPdf
      ? await extractReceptionInvoiceFromPdf(apiKey, fileDataUrl, fileName, mimeType)
      : await extractReceptionInvoiceFromImage(apiKey, fileDataUrl);
    sendJson(response, 200, { ok: true, invoice });
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message });
  }
}

async function handlePayrollScaleRead(request, response) {
  try {
    const body = await readJsonBody(request);
    const fileDataUrl = String(body.fileDataUrl || "");
    const fileName = sanitizeFileName(body.fileName || "escala_salarial.pdf");
    if (!fileDataUrl.startsWith("data:application/pdf")) {
      sendJson(response, 400, { ok: false, error: "Adjunta un PDF valido de escala salarial." });
      return;
    }

    const text = extractPdfTextWithPython(fileDataUrl, fileName);
    const scale = parsePayrollScaleText(text);
    sendJson(response, 200, { ok: true, scale });
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message });
  }
}

function extractPdfTextWithPython(fileDataUrl, fileName) {
  const base64 = String(fileDataUrl).split(",")[1] || "";
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length || buffer.length > 20 * 1024 * 1024) {
    throw new Error("El PDF esta vacio o supera 20 MB.");
  }

  const tempDir = path.join(ROOT_DIR, "tmp", "uploads");
  fs.mkdirSync(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `${Date.now()}-${fileName}`);
  fs.writeFileSync(tempPath, buffer);
  const executable = fs.existsSync(PYTHON_EXECUTABLE) ? PYTHON_EXECUTABLE : "python";
  const script = [
    "import sys, pdfplumber",
    "sys.stdout.reconfigure(encoding='utf-8')",
    "path = sys.argv[1]",
    "parts = []",
    "with pdfplumber.open(path) as pdf:",
    "    for page in pdf.pages:",
    "        parts.append(page.extract_text() or '')",
    "print('\\n'.join(parts))"
  ].join("\n");
  const result = childProcess.spawnSync(executable, ["-c", script, tempPath], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
  fs.rmSync(tempPath, { force: true });
  if (result.status !== 0) {
    throw new Error((result.stderr || "No se pudo extraer texto del PDF.").trim());
  }
  return result.stdout || "";
}

function parsePayrollScaleText(text) {
  const categories = {};
  String(text || "").split(/\r?\n/).forEach((line) => {
    const cleanLine = line.replace(/\s+/g, " ").trim();
    if (!cleanLine || !/\$/.test(cleanLine)) return;
    const values = [...cleanLine.matchAll(/\$\s*([0-9.,\s]+)/g)]
      .map((match) => parsePayrollMoney(match[1]));
    if (!values.length) return;
    const name = cleanLine.split("$")[0].trim();
    if (!name || /PLANILLA|REMUNERATIVO|ADICIONALES|SUMA/i.test(name)) return;
    const normalized = normalizePayrollScaleKey(name);
    const isMonthly = values[0] > 100000;
    categories[normalized] = {
      label: name,
      type: isMonthly ? "monthly" : "hourly",
      remunerative: values[0] || 0,
      nonRemunerative: values[1] || 0,
      periods: {
        "2026-05": { remunerative: values[0] || 0, nonRemunerative: values[1] || 0 },
        "2026-06": { remunerative: values[0] || 0, nonRemunerative: values[1] || 0 },
        "2026-07": { remunerative: values[2] || values[0] || 0, nonRemunerative: values[3] || 0 },
        "2026-08": { remunerative: values[4] || values[2] || values[0] || 0, nonRemunerative: 0 }
      }
    };
  });
  return { categories };
}

function parsePayrollMoney(value) {
  const cleaned = String(value ?? "").replace(/[$\s]/g, "");
  if (!cleaned) return NaN;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized = cleaned;
  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSeparator = lastComma > lastDot ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    normalized = cleaned.split(thousandsSeparator).join("").replace(decimalSeparator, ".");
  } else if (lastComma >= 0) {
    normalized = cleaned.replace(",", ".");
  }
  const number = Number(normalized);
  return Number.isFinite(number) ? number : NaN;
}

function normalizePayrollScaleKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dataUrlMimeType(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+)[;,]/);
  return match ? match[1] : "";
}

function receptionInvoiceExtractionPrompt() {
  return `Lee esta factura o remito argentino y devolve SOLO JSON valido.
Campos esperados:
{
  "tipo_factura": "Factura_A|Factura_B|Factura_C|Remito_X",
  "nro_factura": "texto",
  "fecha_factura": "YYYY-MM-DD",
  "subtotal": numero,
  "iva": numero,
  "per_ret_iva": numero,
  "per_ret_iibb": numero,
  "imp_internos": numero,
  "total": numero
}
Si un dato no aparece, usa string vacio o 0. No inventes importes.`;
}

async function extractReceptionInvoiceFromImage(apiKey, imageDataUrl) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: receptionInvoiceExtractionPrompt()
            },
            {
              type: "image_url",
              image_url: { url: imageDataUrl, detail: "high" }
            }
          ]
        }
      ]
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || "No se pudo leer la factura.");
  const content = payload.choices?.[0]?.message?.content || "{}";
  return JSON.parse(content);
}

async function extractReceptionInvoiceFromPdf(apiKey, pdfDataUrl, fileName, mimeType) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
      temperature: 0,
      text: { format: { type: "json_object" } },
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: receptionInvoiceExtractionPrompt() },
            {
              type: "input_file",
              filename: fileName || `factura.${mimeType.includes("pdf") ? "pdf" : "bin"}`,
              file_data: pdfDataUrl
            }
          ]
        }
      ]
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || "No se pudo leer el PDF de la factura.");
  return JSON.parse(extractResponseText(payload) || "{}");
}

function extractResponseText(payload) {
  if (payload.output_text) return payload.output_text;
  const chunks = [];
  (payload.output || []).forEach((outputItem) => {
    (outputItem.content || []).forEach((contentItem) => {
      if (contentItem.text) chunks.push(contentItem.text);
    });
  });
  return chunks.join("\n").trim();
}

function sanitizeFileName(value) {
  return String(value || "archivo")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "archivo";
}

function handleIncomeStatementReport(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const year = Number(url.searchParams.get("year"));
    const month = Number(url.searchParams.get("month"));
    const comparisonMode = String(url.searchParams.get("comparison") || "none");

    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 0 || month > 11) {
      sendJson(response, 400, { ok: false, error: "Periodo invalido." });
      return;
    }

    const report = buildBackendIncomeStatementReport(year, month);
    const comparisonPeriod = backendComparisonPeriod(year, month, comparisonMode);
    const comparisonReport = comparisonPeriod
      ? buildBackendIncomeStatementReport(comparisonPeriod.year, comparisonPeriod.month)
      : null;

    sendJson(response, 200, { ok: true, report, comparisonReport });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error.message });
  }
}

function handleCashflowReport(request, response) {
  try {
    const report = buildBackendCashflowReport();
    sendJson(response, 200, { ok: true, report });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error.message });
  }
}

async function handleBankReconciliationAnalyze(request, response) {
  try {
    const body = await readJsonBody(request);
    const report = buildBankReconciliationReport(body);
    sendJson(response, 200, { ok: true, report });
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message });
  }
}

async function handleBankReconciliationApply(request, response) {
  try {
    const body = await readJsonBody(request);
    const report = buildBankReconciliationReport(body);
    const result = applyBankReconciliationReport(report);
    sendJson(response, 200, { ok: true, result });
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message });
  }
}

async function handleBankReconciliationDepositChecks(request, response) {
  try {
    const body = await readJsonBody(request);
    const bank = cleanBackendText(body.bank) || "ICBC";
    const movement = body.movement || null;
    const manualDeposit = Boolean(body.manualDeposit || !movement);
    const depositDate = cleanBackendText(body.depositDate || movement?.date);
    const checkIds = [...new Set((body.checkIds || []).map((id) => backendId(id)).filter(Boolean))];
    if (!checkIds.length) throw new Error("Selecciona al menos un cheque para depositar.");

    const cache = loadCache();
    if (!cache.tables) cache.tables = {};
    const tables = cache.tables;
    ensureBackendTable(tables, "cheques_recibidos");
    ensureBackendTable(tables, "movimientos_bancarios");

    const selectedChecks = checkIds.map((id) => (
      tables.cheques_recibidos.rows.find((row) => backendId(row.id_cheque_recibido) === id)
    ));
    if (selectedChecks.some((row) => !row)) throw new Error("Uno de los cheques seleccionados ya no existe.");
    if (selectedChecks.some((row) => backendNormalizeText(row.estado).includes("deposit"))) {
      throw new Error("Uno de los cheques seleccionados ya fue depositado.");
    }

    const selectedAmount = selectedChecks.reduce((total, row) => total + Math.abs(backendNumber(row.monto)), 0);
    const depositedAmount = manualDeposit ? selectedAmount : Math.abs(backendNumber(movement.amount ?? movement.credit));
    if (!depositDate) throw new Error("Indica la fecha del depósito.");
    if (!depositedAmount || (!manualDeposit && Math.abs(depositedAmount - selectedAmount) > 0.01)) {
      throw new Error("La suma de los cheques seleccionados no coincide con el crédito del banco.");
    }

    if (!manualDeposit) {
      const fingerprint = bankMovementFingerprint(movement, bank);
      const alreadyRegistered = (tables.movimientos_bancarios.rows || []).some((row) => (
        bankMovementFingerprint(row, row.banco || bank) === fingerprint
      ));
      if (alreadyRegistered) throw new Error("Este depósito ya fue conciliado.");
    }

    const timestamp = new Date().toISOString();
    const depositId = `deposito-${Date.now()}`;
    selectedChecks.forEach((row) => {
      row.estado = "Depositado";
      row.banco = bank;
      row.fecha_deposito = depositDate;
      row.id_deposito = depositId;
      row.fecha_uso = row.fecha_uso || depositDate;
      row._editedLocallyAt = timestamp;
    });
    if (!manualDeposit) {
      persistBankMovement(tables, {
        ...movement,
        debit: 0,
        credit: depositedAmount,
        amount: depositedAmount,
        checkMatch: {
          type: "cheque_recibido",
          ids: selectedChecks.map((row) => row.id_cheque_recibido),
          idCobro: selectedChecks[0].id_cobro
        }
      }, bank);
    }

    cache.generatedAt = timestamp;
    saveBackendCache(cache);
    sendJson(response, 200, { ok: true, checkCount: selectedChecks.length, amount: selectedAmount, manualDeposit });
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message });
  }
}

function buildBankReconciliationReport(body = {}) {
  const bank = String(body.bank || "ICBC").trim() || "ICBC";
  const csvText = String(body.csvText || "");
  if (!csvText.trim()) throw new Error("Falta cargar el archivo CSV del banco.");

  const cache = loadCache();
  if (!cache.tables) cache.tables = {};
  const bankDetailsHadInvoiceType = (cache.tables?.datos_bancarios?.headers || []).includes("tipo_factura");
  ensureBackendTable(cache.tables, "datos_bancarios");
  if (!bankDetailsHadInvoiceType) saveBackendCache(cache);
  if (seedDefaultBankDetails(cache)) {
    normalizeBackendBankDetails(cache);
    saveBackendCache(cache);
  }
  const tables = cache.tables || {};
  const movements = parseBankMovements(csvText);
  if (!movements.length) throw new Error("No se encontraron movimientos bancarios en el CSV.");

  const paymentCandidates = backendBankPaymentCandidates(tables, bank);
  const collectionCandidates = backendBankCollectionCandidates(tables, bank);
  const payableCandidates = backendBankPayableCandidates(tables);
  const creditPayableCandidates = backendBankCreditPayableCandidates(tables);
  const sourceCandidates = backendBankSourceCandidates(tables);
  const persistedMovementCounts = backendPersistedBankMovementCounts(tables, bank);
  const identityIndex = backendBankIdentityIndex(tables);
  const receivedChecksByNumber = backendReceivedChecksByNumber(tables);
  const issuedChecksByNumber = backendIssuedChecksByNumber(tables);
  const receivedCheckDepositGroups = backendReceivedCheckDepositGroups(tables, bank);
  const movementOccurrences = new Map();
  const analyzedMovements = movements.map((movement) => {
    const baseKey = bankMovementFingerprint(movement, bank);
    const occurrence = (movementOccurrences.get(baseKey) || 0) + 1;
    movementOccurrences.set(baseKey, occurrence);
    return analyzeBankMovement(
      { ...movement, movementKey: `${baseKey}:${occurrence}` },
      paymentCandidates,
      collectionCandidates,
      payableCandidates,
      creditPayableCandidates,
      sourceCandidates,
      persistedMovementCounts,
      identityIndex,
      receivedChecksByNumber,
      issuedChecksByNumber,
      receivedCheckDepositGroups,
      bank
    );
  });

  const reconciled = analyzedMovements.filter((movement) => movement.status === "conciliado");
  const ready = analyzedMovements.filter((movement) => movement.status === "listo");
  const pending = analyzedMovements.filter((movement) => !["conciliado", "listo"].includes(movement.status));
  const lastBalance = analyzedMovements.find((movement) => Number.isFinite(movement.balance))?.balance || 0;
  const pendingDebits = pending.filter((movement) => movement.amount < 0).reduce((total, movement) => total + Math.abs(movement.amount), 0);
  const pendingCredits = pending.filter((movement) => movement.amount > 0).reduce((total, movement) => total + movement.amount, 0);

  return {
    bank,
    source: "backend",
    rowsRead: movements.length,
    summary: {
      realBalance: lastBalance,
      reconciledCount: reconciled.length,
      readyCount: ready.length,
      pendingCount: pending.length,
      pendingDebits,
      pendingCredits,
      netPending: pendingCredits - pendingDebits
    },
    applyMode: body.applyMode || "all",
    movementKeys: Array.isArray(body.movementKeys) ? body.movementKeys.map(String) : [],
    reviewRows: body.reviewRows && typeof body.reviewRows === "object" ? body.reviewRows : {},
    lookupOptions: {
      invoiceTypes: backendBankLookupValues(tables.egresos?.rows, "tipo_factura", ["Factura A", "Factura B", "Factura C", "Remito X"]),
      paymentMethods: backendBankLookupValues(tables.pagos?.rows, "metodo", ["Transferencia", "Cheque", "Debito", "Movimiento bancario"])
    },
    movements: analyzedMovements
  };
}

function backendBankLookupValues(rows, column, defaults = []) {
  return [...new Set([
    ...defaults,
    ...(rows || []).map((row) => cleanBackendText(row[column]))
  ].filter(Boolean))].sort((left, right) => left.localeCompare(right, "es"));
}

function applyBankReconciliationReport(report) {
  const cache = loadCache();
  const tables = cache.tables || {};
  ensureBackendTable(tables, "acreedores");
  ensureBackendTable(tables, "otros_gastos");
  ensureBackendTable(tables, "egresos");
  ensureBackendTable(tables, "pagos");
  ensureBackendTable(tables, "detalle_pagos");
  ensureBackendTable(tables, "cheques_recibidos");
  ensureBackendTable(tables, "cheques_entregados");
  ensureBackendTable(tables, "movimientos_bancarios");

  const counters = {
    paymentsCreated: 0,
    egressesCreated: 0,
    expensesCreated: 0,
    paymentDetailsCreated: 0,
    checksUpdated: 0,
    movementsReconciled: 0,
    skipped: 0
  };
  const notes = [];
  const selectedKeys = new Set(report.movementKeys || []);
  const selectedMovements = (report.movements || []).filter((movement) => (
    !selectedKeys.size || selectedKeys.has(String(movement.movementKey || ""))
  ));

  selectedMovements.forEach((movement) => {
    if (report.applyMode === "createExpenses") {
      if (movement.status !== "agregar_gasto") return skipBankMovement(counters);
      const created = createBankSourceExpense(tables, movement, report.reviewRows?.[movement.movementKey]);
      if (!created) {
        counters.skipped += 1;
        notes.push(`${movement.date} · ${movement.detail || movement.concept}: debe completarse en ${movement.sourceDestination?.label || "su modulo operativo"}.`);
        return;
      }
      counters.expensesCreated += 1;
      notes.push(`${created.label} #${created.sourceId} creado desde el movimiento bancario.`);
      return;
    }

    if (report.applyMode === "createEgresses") {
      if (movement.status !== "agregar_egreso" || !movement.sourceMatch) return skipBankMovement(counters);
      const created = createBankEgressForSource(tables, movement, report.reviewRows?.[movement.movementKey]);
      if (!created) return skipBankMovement(counters);
      counters.egressesCreated += 1;
      notes.push(`Egreso #${created.expenseId} asociado a ${created.sourceLabel} #${created.sourceId}.`);
      return;
    }

    if (report.applyMode === "createPayments") {
      if (movement.status !== "agregar_pago" || movement.match?.type !== "egreso" || !movement.match.id) {
        return skipBankMovement(counters);
      }
      createBankPaymentForExpense(
        tables,
        movement,
        report.bank,
        movement.match.id,
        Math.abs(movement.amount),
        report.reviewRows?.[movement.movementKey]
      );
      counters.paymentsCreated += 1;
      counters.paymentDetailsCreated += 1;
      return;
    }

    if (report.applyMode === "reconcile") {
      if (movement.status !== "listo") return skipBankMovement(counters);
      if (movement.checkMatch) {
        const updated = movement.checkMatch.type === "cheque_entregado"
          ? updateIssuedCheckFromBankMovement(tables, movement, report.bank)
          : updateReceivedCheckFromBankMovement(tables, movement, report.bank);
        if (updated) counters.checksUpdated += 1;
      }
      persistBankMovement(tables, movement, report.bank);
      counters.movementsReconciled += 1;
      return;
    }

    counters.skipped += 1;
  });

  cache.generatedAt = new Date().toISOString();
  saveBackendCache(cache);
  return { ...counters, notes };
}

function skipBankMovement(counters) {
  counters.skipped += 1;
}

function ensureBackendTable(tables, tableName) {
  if (!tables[tableName]) {
    tables[tableName] = {
      headers: EXPECTED_BACKEND_COLUMNS[tableName] || [],
      rows: [],
      rowCount: 0
    };
  }
  if (!Array.isArray(tables[tableName].rows)) tables[tableName].rows = [];
  if (!Array.isArray(tables[tableName].headers) || !tables[tableName].headers.length) {
    tables[tableName].headers = EXPECTED_BACKEND_COLUMNS[tableName] || [];
  } else {
    const expectedHeaders = EXPECTED_BACKEND_COLUMNS[tableName] || [];
    tables[tableName].headers = [...new Set([...tables[tableName].headers, ...expectedHeaders])];
  }
}

function buildPlanPaymentInstallments({ startYear, startMonth, capitals, financial, firstTotal, secondTotal, resarcitorio }) {
  return capitals.map((capital, index) => {
    const monthOffset = startMonth - 1 + index;
    const year = startYear + Math.floor(monthOffset / 12);
    const month = String((monthOffset % 12) + 1).padStart(2, "0");
    return {
      nroCuota: index + 1,
      capital,
      interesFinanciero: financial[index],
      interesResarcitorio: resarcitorio,
      totalPrimerVencimiento: firstTotal,
      fechaPrimerVencimiento: `${year}-${month}-16`,
      totalSegundoVencimiento: secondTotal,
      fechaSegundoVencimiento: `${year}-${month}-26`
    };
  });
}

function ensurePaymentPlansHistory() {
  const cache = loadCache();
  if (!cache.tables) return;

  ensureBackendTable(cache.tables, "planes_pagos");
  ensureBackendTable(cache.tables, "cuotas_planes_pagos");
  ensureBackendTable(cache.tables, "egresos");

  const plans = [
    {
      nombre: "Plan de pagos ARCA 1",
      cuotas: buildPlanPaymentInstallments({
        startYear: 2026, startMonth: 3,
        capitals: [737285.75, 757561.11, 778394.04, 799799.88, 821794.37, 844393.72, 867614.55, 891473.95, 915989.48, 941117.19],
        financial: [283695.60, 263420.24, 242587.31, 221181.47, 199186.98, 176587.63, 153366.80, 129507.40, 104991.87, 79802.16],
        firstTotal: 1020981.35, secondTotal: 1030340.35, resarcitorio: 9359
      })
    },
    {
      nombre: "Plan de pagos ARCA 2",
      cuotas: buildPlanPaymentInstallments({
        startYear: 2026, startMonth: 3,
        capitals: [275632.87, 283212.77, 291001.12, 299003.65, 307226.25, 315674.87, 324356.04, 333275.83, 342440.91, 351858.04],
        financial: [106059.05, 98479.15, 90690.80, 82688.27, 74465.67, 66016.95, 57335.88, 48416.09, 39251.01, 29833.88],
        firstTotal: 381691.92, secondTotal: 385190.76, resarcitorio: 3498.84
      })
    },
    {
      nombre: "Plan de pagos ARCA 3",
      cuotas: buildPlanPaymentInstallments({
        startYear: 2026, startMonth: 7,
        capitals: [768958.32, 788049.67, 809721.04, 831988.37, 854868.05, 878376.92, 902532.29, 927351.89],
        financial: [185895.78, 164804.43, 143133.06, 120865.73, 97886.05, 74477.18, 50321.81, 25502.21],
        firstTotal: 952854.10, secondTotal: 961588.60, resarcitorio: 8734.50
      })
    }
  ];

  const planRows = cache.tables.planes_pagos.rows;
  const quotaRows = cache.tables.cuotas_planes_pagos.rows;
  const expenseRows = cache.tables.egresos.rows;
  let nextPlanId = Math.max(0, ...planRows.map((row) => Number(backendId(row.id_plan_pago)) || 0)) + 1;
  let nextQuotaId = Math.max(0, ...quotaRows.map((row) => Number(backendId(row.id_cuota_plan_pago)) || 0)) + 1;
  let nextExpenseId = Math.max(0, ...expenseRows.map((row) => Number(backendId(row.id_egreso)) || 0)) + 1;
  let changed = false;

  plans.forEach((definition) => {
    let plan = planRows.find((row) => normalizePartnerName(row.nombre) === normalizePartnerName(definition.nombre));
    if (!plan) {
      plan = { id_plan_pago: String(nextPlanId++), nombre: definition.nombre, organismo: "ARCA", _rowNumber: planRows.length + 1 };
      planRows.push(plan);
      changed = true;
    }
    const planId = backendId(plan.id_plan_pago);

    definition.cuotas.forEach((definitionQuota) => {
      let quota = quotaRows.find((row) => backendId(row.id_plan_pago) === planId && Number(row.nro_cuota) === definitionQuota.nroCuota);
      let expense = quota && expenseRows.find((row) => backendId(row.id_egreso) === backendId(quota.id_egreso));

      if (!expense) {
        expense = expenseRows.find((row) => {
          const amount = backendNumber(row.total);
          const matchesAmount = Math.abs(amount - definitionQuota.totalPrimerVencimiento) < 0.01 || Math.abs(amount - definitionQuota.totalSegundoVencimiento) < 0.01;
          const date = backendIsoDate(row.fecha_factura) || backendIsoDate(row.fecha_prevista_pago);
          return matchesAmount && (date === definitionQuota.fechaPrimerVencimiento || date === definitionQuota.fechaSegundoVencimiento);
        });
      }

      if (!expense) {
        expense = {
          id_egreso: String(nextExpenseId++),
          fecha_factura: definitionQuota.fechaPrimerVencimiento,
          fecha_prevista_pago: definitionQuota.fechaPrimerVencimiento,
          tipo_factura: "Plan de Pagos",
          nro_factura: `ARCA-${planId}-${definitionQuota.nroCuota}`,
          iva: 0,
          per_ret_iva: 0,
          per_ret_iibb: 0,
          imp_internos: 0,
          subtotal: definitionQuota.totalPrimerVencimiento,
          total: definitionQuota.totalPrimerVencimiento,
          _rowNumber: expenseRows.length + 1
        };
        expenseRows.push(expense);
        changed = true;
      }

      if (expense.tipo_factura !== "Plan de Pagos") {
        expense.tipo_factura = "Plan de Pagos";
        changed = true;
      }
      if (!expense.fecha_prevista_pago) {
        expense.fecha_prevista_pago = definitionQuota.fechaPrimerVencimiento;
        changed = true;
      }

      const values = {
        id_plan_pago: planId,
        nro_cuota: definitionQuota.nroCuota,
        capital: definitionQuota.capital,
        interes_financiero: definitionQuota.interesFinanciero,
        interes_resarcitorio: definitionQuota.interesResarcitorio,
        total_primer_vencimiento: definitionQuota.totalPrimerVencimiento,
        fecha_primer_vencimiento: definitionQuota.fechaPrimerVencimiento,
        total_segundo_vencimiento: definitionQuota.totalSegundoVencimiento,
        fecha_segundo_vencimiento: definitionQuota.fechaSegundoVencimiento,
        id_egreso: backendId(expense.id_egreso)
      };

      if (!quota) {
        quota = { id_cuota_plan_pago: String(nextQuotaId++), ...values, _rowNumber: quotaRows.length + 1 };
        quotaRows.push(quota);
        changed = true;
      } else {
        Object.entries(values).forEach(([key, value]) => {
          if (String(quota[key] ?? "") !== String(value ?? "")) {
            quota[key] = value;
            changed = true;
          }
        });
      }
    });
  });

  if (!changed) return;
  cache.tables.planes_pagos.rowCount = planRows.length;
  cache.tables.cuotas_planes_pagos.rowCount = quotaRows.length;
  cache.tables.egresos.rowCount = expenseRows.length;
  cache.generatedAt = new Date().toISOString();
  saveBackendCache(cache);
}

function ensurePartnerContributionsHistory() {
  const cache = loadCache();
  if (!cache.tables) return;

  ensureBackendTable(cache.tables, "aportes_socios");
  ensureBackendTable(cache.tables, "egresos");

  const historicalContributions = [
    { nombre: "Benjamin de Mayo", monto: 9577089 },
    { nombre: "Bautista de Mayo", monto: 12475995 },
    { nombre: "Miguel de Mayo", monto: 12475995 },
    { nombre: "Alejandro Ganzabal", monto: 15600000 },
    { nombre: "Facundo Aragon", monto: 2115000 }
  ];
  const rows = cache.tables.aportes_socios.rows;
  const linkedExpenseIds = new Set(rows.map((row) => String(row.id_egreso || "").trim()).filter(Boolean));
  let changed = false;

  historicalContributions.forEach((contribution) => {
    const exists = rows.some((row) => (
      normalizePartnerName(row.nombre) === normalizePartnerName(contribution.nombre)
      && String(row.tipo || "Aporte").trim().toLowerCase() === "aporte"
      && Math.abs(backendNumber(row.monto)) === contribution.monto
    ));
    if (exists) return;

    const matchedExpense = cache.tables.egresos.rows.find((expense) => (
      !linkedExpenseIds.has(String(expense.id_egreso || "").trim())
      && backendNumber(expense.total) < 0
      && Math.abs(backendNumber(expense.total)) === contribution.monto
    ));
    const id = rows.reduce((maxId, row) => Math.max(maxId, Number(row.id_aporte_socio) || 0), 0) + 1;
    rows.push({
      id_aporte_socio: id,
      fecha: matchedExpense?.fecha_factura || "",
      nombre: contribution.nombre,
      tipo: "Aporte",
      monto: contribution.monto,
      id_egreso: matchedExpense?.id_egreso || "",
      _rowNumber: rows.length + 2
    });
    if (matchedExpense?.id_egreso) linkedExpenseIds.add(String(matchedExpense.id_egreso));
    changed = true;
  });

  cache.tables.aportes_socios.rowCount = rows.length;
  if (changed) {
    cache.generatedAt = new Date().toISOString();
    saveBackendCache(cache);
  }
}

function normalizePartnerName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function ensureBankDetailsSchema() {
  const cache = loadCache();
  if (!cache.tables) return;

  const hasInvoiceType = (cache.tables.datos_bancarios?.headers || []).includes("tipo_factura");
  ensureBackendTable(cache.tables, "datos_bancarios");
  if (!hasInvoiceType) saveBackendCache(cache);
}

function backendValueIsBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function bankMovementBackendCreditorId(movement) {
  const match = movement?.providerMatch || {};
  if (match.idAcreedor) return backendId(match.idAcreedor);
  if (match.type === "acreedor" && match.id) return backendId(match.id);
  return "";
}

function bankMovementFingerprint(movement, bank) {
  const normalized = [
    backendNormalizeText(bank),
    backendIsoDate(movement.fecha || movement.date),
    backendNormalizeText(movement.cod_concepto || movement.code),
    backendNormalizeText(movement.concepto || movement.concept),
    backendNormalizeText(movement.detalle || movement.detail),
    normalizeBankCuit(movement.cuit),
    normalizeBankCheckNumber(movement.nro_cheque || movement.checkNumber),
    bankMoneyKey(movement.debito ?? movement.debit),
    bankMoneyKey(movement.credito ?? movement.credit),
    bankMoneyKey(movement.saldo ?? movement.balance)
  ].join("|");
  return crypto.createHash("sha1").update(normalized).digest("hex");
}

function bankMoneyKey(value) {
  return Math.round(backendNumber(value) * 100);
}

function backendPersistedBankMovementCounts(tables, bank) {
  const counts = new Map();
  (tables.movimientos_bancarios?.rows || []).forEach((row) => {
    if (!backendBankMatches(row.banco, bank)) return;
    const key = bankMovementFingerprint(row, row.banco || bank);
    if (!counts.has(key)) counts.set(key, []);
    counts.get(key).push({
      type: "movimiento_bancario",
      id: backendId(row.id_movimiento_bancario),
      idPago: backendId(row.id_pago),
      idCobro: backendId(row.id_cobro)
    });
  });
  return counts;
}

function consumePersistedBankMovement(movement, bank, persistedCounts) {
  const key = bankMovementFingerprint(movement, bank);
  const candidates = persistedCounts.get(key) || [];
  return candidates.shift() || null;
}

function persistBankMovement(tables, movement, bank) {
  const table = tables.movimientos_bancarios;
  const match = movement.match || {};
  const timestamp = new Date().toISOString();
  table.rows.push({
    _rowNumber: table.rows.length + 2,
    id_movimiento_bancario: backendNextNumericId(table.rows, "id_movimiento_bancario"),
    banco: bank,
    fecha: movement.date,
    cod_concepto: movement.code || "",
    concepto: movement.concept || "",
    detalle: movement.detail || "",
    cuit: movement.cuit || "",
    nro_cheque: movement.checkNumber || "",
    debito: movement.debit || 0,
    credito: movement.credit || 0,
    importe: movement.amount || 0,
    saldo: movement.balance || 0,
    id_pago: match.type === "pago" ? match.id : (movement.checkMatch?.idPago || ""),
    id_cobro: match.type === "cobro" ? match.id : (movement.checkMatch?.idCobro || ""),
    _editedLocallyAt: timestamp
  });
  table.rowCount = table.rows.length;
}

function bankSourceDestinationForOriginType(value) {
  const originType = backendNormalizeText(value);
  if (originType === "proveedor") return { table: "recepciones", label: "Recepciones" };
  if (originType === "flete") return { table: "entregas", label: "Logistica" };
  if (originType === "empleado") return { table: "sueldos", label: "Sueldos" };
  if (originType === "canal") return { table: "comisiones", label: "Comisiones" };
  return { table: "otros_gastos", label: "Otros gastos" };
}

function createBankSourceExpense(tables, movement, reviewRow = {}) {
  const destination = movement.sourceDestination || bankSourceDestinationForOriginType("");
  if (destination.table !== "otros_gastos") return null;

  const creditorId = bankMovementBackendCreditorId(movement);
  if (!creditorId) return null;
  const relationId = backendCreditorTagRelationId(creditorId, movement.idEtiqueta, tables);
  const table = tables.otros_gastos;
  const sourceId = backendNextNumericId(table.rows, "id_otros_gastos");
  table.rows.push({
    _rowNumber: table.rows.length + 2,
    id_otros_gastos: sourceId,
    fecha_otros_gastos: backendIsoDate(reviewRow.date) || movement.date,
    id_acreedor: creditorId,
    id_acreedor_etiqueta: relationId || movement.idAcreedorEtiqueta || "",
    id_egreso: "",
    detalle: compactBankText(reviewRow.detail || movement.detail || movement.concept),
    _total: Math.abs(movement.amount),
    _editedLocallyAt: new Date().toISOString()
  });
  table.rowCount = table.rows.length;
  return { sourceId, label: destination.label };
}

function createBankEgressForSource(tables, movement, reviewRow = {}) {
  const sourceMatch = movement.sourceMatch;
  const sourceTable = tables[sourceMatch?.table];
  const sourceRow = sourceTable?.rows?.find((row) => backendId(row[sourceMatch.idColumn]) === backendId(sourceMatch.id));
  if (!sourceRow || backendId(sourceRow.id_egreso)) return null;

  const expenseTable = tables.egresos;
  const expenseId = backendNextNumericId(expenseTable.rows, "id_egreso");
  const total = Math.abs(movement.amount);
  const tagId = backendId(sourceMatch.idEtiqueta || movement.idEtiqueta)
    || backendTagIdForName(movement.tag || movement.suggestedExpenseType, tables);
  const invoiceDate = backendIsoDate(reviewRow.date) || sourceMatch.invoiceDate || sourceMatch.date || movement.date;
  const timestamp = new Date().toISOString();

  expenseTable.rows.push({
    _rowNumber: expenseTable.rows.length + 2,
    id_egreso: expenseId,
    fecha_factura: invoiceDate,
    fecha_prevista_pago: movement.date,
    id_etiqueta: tagId,
    tipo_factura: cleanBackendText(reviewRow.tipo_factura)
      || sourceMatch.invoiceType
      || movement.providerMatch?.invoiceType
      || "",
    nro_factura: sourceMatch.invoiceNumber || movement.checkNumber || movement.rowNumber || "",
    iva: 0,
    per_ret_iva: 0,
    per_ret_iibb: 0,
    imp_internos: 0,
    subtotal: total,
    total,
    _editedLocallyAt: timestamp
  });
  sourceRow.id_egreso = expenseId;
  sourceRow._editedLocallyAt = timestamp;
  expenseTable.rowCount = expenseTable.rows.length;
  return {
    expenseId,
    sourceId: backendId(sourceMatch.id),
    sourceLabel: sourceMatch.label || sourceMatch.table
  };
}

function backendCreditorTagRelationId(creditorId, tagId, tables) {
  const normalizedCreditorId = backendId(creditorId);
  const normalizedTagId = backendId(tagId);
  const relations = (tables.acreedores_etiquetas?.rows || []).filter((relation) => (
    backendId(relation.id_acreedor) === normalizedCreditorId
  ));
  const exact = normalizedTagId
    ? relations.find((relation) => backendId(relation.id_etiqueta) === normalizedTagId)
    : null;
  return backendId((exact || relations[0])?.id_acreedor_etiqueta);
}

function createBankPaymentForExpense(tables, movement, bank, expenseId, amount, reviewRow = {}) {
  const paymentTable = tables.pagos;
  const detailTable = tables.detalle_pagos;
  const expense = (tables.egresos?.rows || []).find((row) => backendId(row.id_egreso) === backendId(expenseId));
  const signedAmount = backendNumber(expense?.total) < 0 ? -Math.abs(amount) : Math.abs(amount);
  const paymentId = backendNextNumericId(paymentTable.rows, "id_pago");
  const detailId = backendNextNumericId(detailTable.rows, "id_detalle_pago");
  const timestamp = new Date().toISOString();

  paymentTable.rows.push({
    _rowNumber: paymentTable.rows.length + 2,
    id_pago: paymentId,
    fecha_pago: backendIsoDate(reviewRow.date) || movement.date,
    metodo: cleanBackendText(reviewRow.metodo) || bankPaymentMethodFromMovement(movement),
    banco: cleanBackendText(reviewRow.banco) || bank,
    monto: signedAmount,
    _editedLocallyAt: timestamp
  });
  detailTable.rows.push({
    _rowNumber: detailTable.rows.length + 2,
    id_detalle_pago: detailId,
    id_pago: paymentId,
    id_egreso: expenseId,
    monto_cancelado: signedAmount,
    _editedLocallyAt: timestamp
  });
  paymentTable.rowCount = paymentTable.rows.length;
  detailTable.rowCount = detailTable.rows.length;
  return { paymentId, detailId };
}

function updateReceivedCheckFromBankMovement(tables, movement, bank) {
  const checkRows = tables.cheques_recibidos?.rows || [];
  const checkIds = new Set([
    movement.checkMatch?.id,
    ...(Array.isArray(movement.checkMatch?.ids) ? movement.checkMatch.ids : [])
  ].map(backendId).filter(Boolean));
  const rows = checkRows.filter((check) => checkIds.has(backendId(check.id_cheque_recibido)));
  if (!rows.length) {
    const byNumber = checkRows.find((check) => normalizeBankCheckNumber(check.nro_cheque) === normalizeBankCheckNumber(movement.checkNumber));
    if (byNumber) rows.push(byNumber);
  }
  if (!rows.length) return false;
  const timestamp = new Date().toISOString();
  rows.forEach((row) => {
    row.estado = "Depositado";
    row.banco = bank;
    row.fecha_deposito = row.fecha_deposito || movement.date;
    row.fecha_uso = row.fecha_uso || movement.date;
    row._editedLocallyAt = timestamp;
  });
  return true;
}

function updateIssuedCheckFromBankMovement(tables, movement, bank) {
  const checkId = backendId(movement.checkMatch?.id);
  const checkRows = tables.cheques_entregados?.rows || [];
  const row = checkRows.find((check) => backendId(check.id_cheque_entregado) === checkId)
    || checkRows.find((check) => normalizeBankCheckNumber(check.nro_cheque) === normalizeBankCheckNumber(movement.checkNumber));
  if (!row) return false;
  row.estado = "Debitado";
  row.banco = bank;
  row.fecha_uso = row.fecha_uso || movement.date;
  row._editedLocallyAt = new Date().toISOString();
  return true;
}

function bankPaymentMethodFromMovement(movement) {
  const detail = backendNormalizeText([movement.detail, movement.concept].filter(Boolean).join(" "));
  if (movement.checkNumber || detail.includes("cheque") || detail.includes("echeq") || detail.includes("ch camara")) return "Cheque";
  if (detail.includes("transfer") || detail.includes("tr.")) return "Transferencia";
  if (detail.includes("debito")) return "Debito";
  return "Movimiento bancario";
}

function parseBankMovements(csvText) {
  const rows = parseFlexibleDelimitedRows(csvText);
  if (!rows.length) return [];
  const headerIndex = rows.findIndex((row) => bankHeaderScore(row) >= 3);
  if (headerIndex < 0) return [];

  const headers = rows[headerIndex].map((header) => backendNormalizeText(header));
  const indexFor = (...names) => {
    const exact = headers.findIndex((header) => names.some((name) => header === name));
    if (exact >= 0) return exact;
    return headers.findIndex((header) => names.some((name) => header.includes(name)));
  };
  const dateIndex = indexFor("fecha_contable", "fecha_banco", "fecha");
  const codeIndex = indexFor("cod_de_concepto", "codigo_concepto", "cod_concepto");
  const conceptIndex = indexFor("concepto", "detalle_banco", "descripcion", "informacion_complementaria");
  const debitIndex = indexFor("debito_en", "debitos", "debito");
  const creditIndex = indexFor("credito_en", "creditos", "credito");
  const amountIndex = indexFor("movimiento_banco", "importe", "monto");
  const balanceIndex = indexFor("saldo_en", "saldo_banco", "saldo");
  const extraDetailIndex = indexFor("informacion_complementaria", "informacion", "referencia");
  const nameIndex = indexFor("nombre", "razon_social");
  const cbuIndex = indexFor("cbu_alias", "cbu", "alias");
  const channelIndex = indexFor("canal");
  const docTypeIndex = indexFor("tipo_doc", "tipo_documento");
  const docNumberIndex = indexFor("nro_doc", "numero_doc", "documento", "cuit", "cuil");
  const checkIndex = indexFor("nro_de_cheque", "nro_cheque", "numero_cheque", "cheque");

  return rows.slice(headerIndex + 1)
    .map((cells, index) => {
      const debit = debitIndex >= 0 ? Math.abs(backendNumber(cells[debitIndex])) : 0;
      const credit = creditIndex >= 0 ? Math.abs(backendNumber(cells[creditIndex])) : 0;
      const directAmount = amountIndex >= 0 ? backendNumber(cells[amountIndex]) : 0;
      const amount = credit || debit ? credit - debit : directAmount;
      const date = backendIsoDate(cells[dateIndex]);
      const bankConcept = compactBankText(cells[conceptIndex] || "");
      const detail = compactBankText([bankConcept, cells[extraDetailIndex]].filter(Boolean).join(" · "));
      const counterpartyName = compactBankText(cells[nameIndex] || "");
      const cuit = normalizeBankCuit(cells[docNumberIndex] || extractBankCuit(cells.join(" ")));
      const cbuAlias = compactBankText(cells[cbuIndex] || "");
      const concept = compactBankText([detail, counterpartyName, cuit || cbuAlias].filter(Boolean).join(" · "));
      const checkNumber = normalizeBankCheckNumber(checkIndex >= 0 ? cells[checkIndex] : "") || extractBankCheckNumber(cells.join(" "));
      if (!date || !amount) return null;
      return {
        rowNumber: headerIndex + index + 2,
        date,
        code: codeIndex >= 0 ? compactBankText(cells[codeIndex] || "") : "",
        concept,
        bankConcept,
        detail,
        counterpartyName,
        cuit,
        checkNumber,
        cbuAlias,
        docType: docTypeIndex >= 0 ? cells[docTypeIndex] || "" : "",
        amount,
        debit: amount < 0 ? Math.abs(amount) : 0,
        credit: amount > 0 ? amount : 0,
        balance: balanceIndex >= 0 ? backendNumber(cells[balanceIndex]) : 0,
        channel: channelIndex >= 0 ? cells[channelIndex] || "" : "",
        raw: cells
      };
    })
    .filter(Boolean);
}

function parseFlexibleDelimitedRows(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  const delimiters = [";", ",", "\t"];
  const delimiter = delimiters
    .map((candidate) => {
      const sampleRows = lines.slice(0, 10).map((line) => splitDelimitedLine(line, candidate));
      const headerScore = Math.max(...sampleRows.map((row) => bankHeaderScore(row)));
      const columnScore = Math.max(...sampleRows.map((row) => row.length));
      return { candidate, score: (headerScore * 100) + columnScore };
    })
    .sort((left, right) => right.score - left.score)[0]?.candidate || ";";
  return lines.map((line) => splitDelimitedLine(line, delimiter));
}

function splitDelimitedLine(line, delimiter) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      if (quoted && line[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function bankHeaderScore(row) {
  const normalized = row.map((cell) => backendNormalizeText(cell)).join("|");
  return ["fecha", "concepto", "debito", "credito", "saldo", "importe", "movimiento"].reduce(
    (score, token) => score + (normalized.includes(token) ? 1 : 0),
    0
  );
}

function analyzeBankMovement(
  movement,
  paymentCandidates,
  collectionCandidates,
  payableCandidates,
  creditPayableCandidates,
  sourceCandidates,
  persistedMovementCounts,
  identityIndex,
  receivedChecksByNumber = new Map(),
  issuedChecksByNumber = new Map(),
  receivedCheckDepositGroups = [],
  bank = ""
) {
  const identified = identifyBankCounterparty(movement, identityIndex);
  const identifiedName = compactBankText(identified?.name || "");
  const checkKey = normalizeBankCheckNumber(movement.checkNumber);
  const checkMatch = checkKey
    ? (movement.amount < 0 ? issuedChecksByNumber.get(checkKey) : receivedChecksByNumber.get(checkKey)) || null
    : null;
  const enrichedMovement = {
    ...movement,
    provider: identified ? identifiedName : "",
    tag: identified?.tagLabel || identified?.expenseType || "",
    tagOptions: identified?.tagOptions || [],
    idEtiqueta: identified?.idEtiqueta || "",
    providerMatch: identified || null,
    checkMatch,
    sourceDestination: identified?.sourceDestination || bankSourceDestinationForOriginType(identified?.originType),
    suggestedExpenseType: identified?.expenseType || "",
    suggestedCounterparty: identified ? null : {
      name: movement.counterpartyName || "",
      cuit: movement.cuit || "",
      cbuAlias: movement.cbuAlias || "",
      detail: movement.detail || ""
    }
  };
  const persistedMatch = consumePersistedBankMovement(enrichedMovement, bank, persistedMovementCounts);
  if (persistedMatch) {
    return {
      ...enrichedMovement,
      status: "conciliado",
      action: "Movimiento ya conciliado",
      match: persistedMatch
    };
  }

  const manualDepositMatch = bankManualCheckDepositMatch(enrichedMovement, receivedCheckDepositGroups);
  if (manualDepositMatch) {
    return {
      ...enrichedMovement,
      status: "listo",
      action: "Deposito de cheques listo para conciliar",
      checkMatch: {
        type: "cheque_recibido",
        ids: manualDepositMatch.checkIds,
        idCobro: manualDepositMatch.collectionIds[0] || ""
      },
      match: { type: "deposito_cheques", id: manualDepositMatch.id }
    };
  }

  if (movement.amount < 0) {
    const paymentMatch = bestBankMatch(enrichedMovement, paymentCandidates.filter((candidate) => candidate.direction !== "credito"), Math.abs(movement.amount), {
      requireExactDate: true,
      requireIdentity: true
    }) || uniqueExactBankMatch(enrichedMovement, paymentCandidates.filter((candidate) => candidate.direction !== "credito"), Math.abs(movement.amount));
    if (paymentMatch) {
      return {
        ...enrichedMovement,
        status: "listo",
        action: "Lista para conciliar",
        match: paymentMatch
      };
    }

    if (checkMatch?.idPago && Math.abs(backendNumber(checkMatch.amount) - Math.abs(movement.amount)) <= 5) {
      return {
        ...enrichedMovement,
        status: "listo",
        action: "Cheque listo para conciliar",
        match: { type: "pago", id: checkMatch.idPago }
      };
    }

    const planPaymentMatch = /^PAGO\s+AFIP\b/i.test(String(enrichedMovement.detail || ""))
      ? bestBankMatch(
        enrichedMovement,
        payableCandidates.filter((candidate) => candidate.planPayment),
        Math.abs(movement.amount),
        { requireExactDate: true, requireIdentity: false, maxDateDifference: 1 }
      )
      : null;
    if (planPaymentMatch) {
      return {
        ...enrichedMovement,
        status: "agregar_pago",
        action: "Agregar pago",
        match: planPaymentMatch
      };
    }

    const payableMatch = bestBankMatch(enrichedMovement, payableCandidates, Math.abs(movement.amount), {
      requireExactDate: false,
      requireIdentity: true,
      maxDateDifference: 365
    }) || exactPendingExpenseMatch(enrichedMovement, payableCandidates, Math.abs(movement.amount));
    if (payableMatch) {
      return {
        ...enrichedMovement,
        status: "agregar_pago",
        action: "Agregar pago",
        match: payableMatch
      };
    }

    const sourceMatch = bestBankSourceMatch(enrichedMovement, sourceCandidates);
    if (sourceMatch) {
      return {
        ...enrichedMovement,
        status: "agregar_egreso",
        action: "Agregar egreso",
        sourceMatch,
        match: null
      };
    }

    const hasExpenseIdentity = Boolean(bankMovementBackendCreditorId(enrichedMovement) && enrichedMovement.idEtiqueta);
    return {
      ...enrichedMovement,
      status: hasExpenseIdentity ? "agregar_gasto" : "revisar",
      action: hasExpenseIdentity ? "Agregar gasto" : "Revisar acreedor o etiqueta",
      match: null
    };
  }

  const collectionMatch = bestBankMatch(enrichedMovement, collectionCandidates, movement.amount, {
    requireExactDate: true,
    requireIdentity: Boolean(enrichedMovement.cuit || enrichedMovement.counterpartyName)
  });
  if (collectionMatch) {
    return {
      ...enrichedMovement,
      status: "listo",
      action: "Lista para conciliar",
      match: collectionMatch
    };
  }
  const creditPaymentMatch = bestBankMatch(
    enrichedMovement,
    paymentCandidates.filter((candidate) => candidate.direction === "credito"),
    movement.amount,
    { requireExactDate: true, requireIdentity: false }
  ) || uniqueExactBankMatch(
    enrichedMovement,
    paymentCandidates.filter((candidate) => candidate.direction === "credito"),
    movement.amount
  );
  if (creditPaymentMatch) {
    return {
      ...enrichedMovement,
      status: "listo",
      action: "Lista para conciliar",
      match: creditPaymentMatch
    };
  }
  if (checkMatch?.idCobro && Math.abs(backendNumber(checkMatch.amount) - movement.amount) <= 5) {
    return {
      ...enrichedMovement,
      status: "listo",
      action: "Cheque listo para conciliar",
      match: { type: "cobro", id: checkMatch.idCobro }
    };
  }
  const creditPayableMatch = bestBankMatch(enrichedMovement, creditPayableCandidates, movement.amount, {
    requireExactDate: true,
    requireIdentity: false
  }) || uniqueExactBankMatch(enrichedMovement, creditPayableCandidates, movement.amount);
  if (creditPayableMatch) {
    return {
      ...enrichedMovement,
      status: "agregar_pago",
      action: "Agregar pago",
      match: creditPayableMatch
    };
  }
  if (identified?.type === "datos_bancarios") {
    return {
      ...enrichedMovement,
      status: "listo",
      action: "Lista para conciliar",
      match: { type: "dato_bancario", id: identified.id }
    };
  }
  return {
    ...enrichedMovement,
    status: "revisar",
    action: "Ingreso a revisar",
    match: null
  };
}

function backendReceivedChecksByNumber(tables) {
  const checksByNumber = new Map();
  (tables.cheques_recibidos?.rows || []).forEach((check) => {
    const checkKey = normalizeBankCheckNumber(check.nro_cheque);
    if (!checkKey || checksByNumber.has(checkKey)) return;
    checksByNumber.set(checkKey, {
      type: "cheque_recibido",
      id: backendId(check.id_cheque_recibido),
      idCobro: backendId(check.id_cobro),
      number: check.nro_cheque,
      amount: backendNumber(check.monto),
      date: backendIsoDate(check.fecha_uso) || backendIsoDate(check.fecha_entregado),
      client: check.cliente || "",
      status: check.estado || ""
    });
  });
  return checksByNumber;
}

function backendReceivedCheckDepositGroups(tables, bank) {
  const groups = new Map();
  (tables.cheques_recibidos?.rows || []).forEach((check) => {
    if (!backendNormalizeText(check.estado).includes("deposit")) return;
    const depositId = cleanBackendText(check.id_deposito);
    if (!depositId) return;
    const checkBank = cleanBackendText(check.banco);
    if (checkBank && bank && backendNormalizeText(checkBank) !== backendNormalizeText(bank)) return;
    const group = groups.get(depositId) || { id: depositId, amount: 0, checkIds: [], collectionIds: [] };
    group.amount += Math.abs(backendNumber(check.monto));
    group.checkIds.push(backendId(check.id_cheque_recibido));
    if (backendId(check.id_cobro)) group.collectionIds.push(backendId(check.id_cobro));
    groups.set(depositId, group);
  });
  return [...groups.values()];
}

function bankMovementLooksLikeReceivedCheckDeposit(movement) {
  const detail = backendNormalizeText([movement?.detail, movement?.concept].filter(Boolean).join(" "));
  const amount = backendNumber(movement?.amount ?? movement?.credit);
  return amount > 0 && (detail.includes("depos") || detail.includes("dep ch") || detail.includes("echeq"));
}

function bankManualCheckDepositMatch(movement, depositGroups) {
  if (!bankMovementLooksLikeReceivedCheckDeposit(movement)) return null;
  const amount = Math.abs(backendNumber(movement.amount ?? movement.credit));
  const matches = depositGroups.filter((group) => Math.abs(group.amount - amount) <= 0.01);
  return matches.length === 1 ? matches[0] : null;
}

function backendIssuedChecksByNumber(tables) {
  const checksByNumber = new Map();
  (tables.cheques_entregados?.rows || []).forEach((check) => {
    const checkKey = normalizeBankCheckNumber(check.nro_cheque);
    if (!checkKey || checksByNumber.has(checkKey)) return;
    checksByNumber.set(checkKey, {
      type: "cheque_entregado",
      id: backendId(check.id_cheque_entregado),
      idPago: backendId(check.id_pago),
      number: check.nro_cheque,
      amount: backendNumber(check.monto),
      date: backendIsoDate(check.fecha_uso) || backendIsoDate(check.fecha_entregado),
      idAcreedor: backendId(check.id_acreedor),
      status: check.estado || ""
    });
  });
  return checksByNumber;
}

function bestBankMatch(movement, candidates, targetAmount, options = {}) {
  const maxDateDifference = Number.isFinite(options.maxDateDifference)
    ? Math.max(0, options.maxDateDifference)
    : 5;
  const matches = candidates
    .map((candidate) => {
      const amountDifference = Math.abs(candidate.amount - targetAmount);
      const dateDifference = Math.abs(bankDateDistance(movement.date, candidate.date));
      if (amountDifference > 5) return null;
      if (options.requireExactDate && dateDifference !== 0) return null;
      if (!options.requireExactDate && dateDifference > maxDateDifference) return null;

      const identity = bankIdentityScore(movement, candidate);
      if (options.requireIdentity && identity.score <= 0) return null;
      const score = 100 - amountDifference - (dateDifference * 4) + identity.score;
      return { ...candidate, amountDifference, dateDifference, identity: identity.reason, score };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);
  return matches[0] || null;
}

function uniqueExactBankMatch(movement, candidates, targetAmount) {
  const matches = candidates.filter((candidate) => (
    Math.abs(backendNumber(candidate.amount) - targetAmount) <= 5
    && bankDateDistance(movement.date, candidate.date) === 0
  ));

  if (matches.length !== 1) return null;
  const candidate = matches[0];
  const identity = bankIdentityScore(movement, candidate);
  return {
    ...candidate,
    amountDifference: Math.abs(backendNumber(candidate.amount) - targetAmount),
    dateDifference: 0,
    identity: identity.reason || "fecha y monto exactos",
    score: 100 + identity.score
  };
}

// Un pago puede llegar mucho despues de la fecha prevista de una factura. Cuando
// acreedor y saldo pendiente coinciden exactamente, se prioriza completar el pago.
function exactPendingExpenseMatch(movement, candidates, targetAmount) {
  const creditorId = bankMovementBackendCreditorId(movement);
  const movementCuit = normalizeBankCuit(movement.cuit);
  const movementParty = backendNormalizeText(movement.provider || movement.counterpartyName);
  const matches = (candidates || []).filter((candidate) => {
    if (Math.abs(backendNumber(candidate.amount) - targetAmount) > 0.01) return false;
    if (creditorId && backendId(candidate.idAcreedor) === creditorId) return true;

    const candidateCuit = normalizeBankCuit(candidate.cuit);
    if (movementCuit && candidateCuit && movementCuit === candidateCuit) return true;

    const candidateParty = backendNormalizeText(candidate.party);
    return Boolean(movementParty && candidateParty && (
      movementParty === candidateParty
      || movementParty.includes(candidateParty)
      || candidateParty.includes(movementParty)
    ));
  });

  // No se asocia automaticamente si hay dos facturas indistinguibles.
  if (matches.length !== 1) return null;

  const candidate = matches[0];
  const sameCreditor = creditorId && backendId(candidate.idAcreedor) === creditorId;
  const sameCuit = movementCuit && normalizeBankCuit(candidate.cuit) === movementCuit;
  return {
    ...candidate,
    amountDifference: Math.abs(backendNumber(candidate.amount) - targetAmount),
    dateDifference: candidate.date ? Math.abs(bankDateDistance(movement.date, candidate.date)) : null,
    identity: sameCreditor
      ? "acreedor y monto pendiente exactos"
      : sameCuit
        ? "CUIT y monto pendiente exactos"
        : "acreedor y monto pendiente exactos",
    score: 100
  };
}

function backendBankPaymentCandidates(tables, bank) {
  const detailsByPayment = backendGroupRowsById(tables.detalle_pagos?.rows, "id_pago");
  const expensesById = backendRowsById(tables.egresos?.rows, "id_egreso");
  return (tables.pagos?.rows || [])
    .map((payment) => {
      const paymentId = backendId(payment.id_pago);
      const details = detailsByPayment.get(paymentId) || [];
      const detailAmount = details.reduce((total, detail) => total + backendNumber(detail.monto_cancelado), 0);
      const signedAmount = backendNumber(payment.monto) || detailAmount;
      if (Math.abs(signedAmount) <= 0.01) return null;
      const firstExpense = expensesById.get(backendId(details[0]?.id_egreso));
      const counterparty = firstExpense ? backendExpenseCounterpartyInfo(firstExpense, tables) : null;
      return {
        type: "pago",
        id: paymentId,
        date: backendIsoDate(payment.fecha_pago),
        amount: Math.abs(signedAmount),
        direction: signedAmount < 0 ? "credito" : "debito",
        party: counterparty?.name || "",
        cuit: counterparty?.cuit || "",
        bank: payment.banco || "",
        description: compactBankText([
          payment.metodo || "Pago",
          payment.banco || "",
          firstExpense?.tipo_factura || "",
          firstExpense?.nro_factura || "",
          counterparty?.detail || ""
        ].filter(Boolean).join(" "))
      };
    })
    .filter((candidate) => candidate && candidate.date && backendBankMatches(candidate.bank, bank));
}

function backendBankCollectionCandidates(tables, bank) {
  const clientsById = backendRowsById(tables.clientes?.rows, "id_cliente");
  return (tables.cobros?.rows || [])
    .map((collection) => {
      const amount = backendNumber(collection.monto);
      if (amount <= 0) return null;
      const client = clientsById.get(backendId(collection.id_cliente));
      return {
        type: "cobro",
        id: backendId(collection.id_cobro),
        date: backendIsoDate(collection.fecha_cobro),
        amount,
        party: client?.nombre_cliente || "",
        cuit: normalizeBankCuit(client?.cuit),
        bank: collection.banco || "",
        description: `${collection.metodo || "Cobro"} ${collection.banco || ""}`.trim()
      };
    })
    .filter((candidate) => candidate && candidate.date && backendBankMatches(candidate.bank, bank));
}

function backendBankPayableCandidates(tables) {
  return backendBankExpenseCandidates(tables, (amount) => amount > 10);
}

function backendBankCreditPayableCandidates(tables) {
  return backendBankExpenseCandidates(tables, (amount) => amount < -10);
}

function backendBankExpenseCandidates(tables, isPendingAmount) {
  const paidByExpense = new Map();
  (tables.detalle_pagos?.rows || []).forEach((detail) => {
    const expenseId = backendId(detail.id_egreso);
    if (!expenseId) return;
    paidByExpense.set(expenseId, (paidByExpense.get(expenseId) || 0) + backendNumber(detail.monto_cancelado));
  });

  const creditorRelationsById = backendRowsById(tables.acreedores_etiquetas?.rows, "id_acreedor_etiqueta");
  const planExpenseIds = new Set(
    (tables.cuotas_planes_pagos?.rows || [])
      .map((row) => backendId(row.id_egreso))
      .filter(Boolean)
  );
  return (tables.egresos?.rows || [])
    .map((expense) => {
      const total = backendNumber(expense.total);
      const paid = paidByExpense.get(backendId(expense.id_egreso)) || 0;
      const pendingAmount = total - paid;
      if (!isPendingAmount(pendingAmount)) return null;
      const counterparty = backendExpenseCounterpartyInfo(expense, tables);
      const creditorRelation = creditorRelationsById.get(backendId(expense.id_acreedor_etiqueta));
      return {
        type: "egreso",
        id: backendId(expense.id_egreso),
        date: backendIsoDate(expense.fecha_prevista_pago) || backendIsoDate(expense.fecha_factura),
        amount: Math.abs(pendingAmount),
        planPayment: planExpenseIds.has(backendId(expense.id_egreso)),
        idAcreedor: backendId(creditorRelation?.id_acreedor) || backendId(expense._id_acreedor),
        party: counterparty.name,
        cuit: counterparty.cuit,
        description: compactBankText([
          expense.tipo_factura || "",
          expense.nro_factura || "",
          counterparty.detail || ""
        ].filter(Boolean).join(" "))
      };
    })
    .filter((candidate) => candidate && candidate.date);
}

function backendBankSourceCandidates(tables) {
  const creditorByOrigin = new Map();
  (tables.acreedores?.rows || []).forEach((creditor) => {
    const key = `${backendNormalizeText(creditor.origen_tipo_acreedor)}:${backendId(creditor.origen_id_acreedor)}`;
    if (key !== ":" && !creditorByOrigin.has(key)) creditorByOrigin.set(key, creditor);
  });
  const relationById = backendRowsById(tables.acreedores_etiquetas?.rows, "id_acreedor_etiqueta");
  const candidates = [];
  const pushCandidate = (config, row, details) => {
    if (backendId(row.id_egreso)) return;
    const creditor = creditorByOrigin.get(`${config.originType}:${backendId(details.originId)}`);
    const relation = relationById.get(backendId(row.id_acreedor_etiqueta));
    candidates.push({
      type: "gasto_origen",
      table: config.table,
      label: config.label,
      idColumn: config.idColumn,
      id: backendId(row[config.idColumn]),
      date: backendIsoDate(details.date),
      invoiceDate: backendIsoDate(row._fecha_factura),
      invoiceType: row._tipo_factura || "",
      invoiceNumber: row._nro_factura || "",
      amount: backendNumber(details.amount),
      idAcreedor: backendId(creditor?.id_acreedor) || backendId(details.idAcreedor),
      idEtiqueta: backendId(relation?.id_etiqueta),
      party: backendCreditorDisplayName(creditor, tables),
      cuit: normalizeBankCuit(creditor?.cuit_cuil),
      description: compactBankText(details.description || row.detalle || config.label)
    });
  };

  const purchasesById = backendRowsById(tables.compras?.rows, "id_compra");
  (tables.recepciones?.rows || []).forEach((row) => {
    const purchase = purchasesById.get(backendId(row.id_compra));
    pushCandidate(
      { table: "recepciones", label: "Recepcion", idColumn: "id_recepcion", originType: "proveedor" },
      row,
      {
        originId: purchase?.id_proveedor,
        date: row.fecha_recepcion,
        amount: row._total,
        description: "Recepcion de mercaderia"
      }
    );
  });

  (tables.otros_gastos?.rows || []).forEach((row) => {
    const creditor = (tables.acreedores?.rows || []).find((candidate) => backendId(candidate.id_acreedor) === backendId(row.id_acreedor));
    pushCandidate(
      {
        table: "otros_gastos",
        label: "Otro gasto",
        idColumn: "id_otros_gastos",
        originType: backendNormalizeText(creditor?.origen_tipo_acreedor) || "otros acreedores"
      },
      row,
      {
        originId: creditor?.origen_id_acreedor,
        idAcreedor: row.id_acreedor,
        date: row.fecha_otros_gastos,
        amount: row._total,
        description: row.detalle
      }
    );
  });

  (tables.sueldos?.rows || []).forEach((row) => pushCandidate(
    { table: "sueldos", label: "Sueldo", idColumn: "id_sueldo", originType: "empleado" },
    row,
    {
      originId: row.id_empleado,
      date: row.fecha,
      amount: row.sueldo_neto,
      description: "Sueldo"
    }
  ));

  (tables.entregas?.rows || []).forEach((row) => pushCandidate(
    { table: "entregas", label: "Entrega", idColumn: "id_entrega", originType: "flete" },
    row,
    {
      originId: row.id_flete,
      date: row.fecha,
      amount: row._total,
      description: "Logistica"
    }
  ));

  (tables.comisiones?.rows || []).forEach((row) => pushCandidate(
    { table: "comisiones", label: "Comision", idColumn: "id_comision", originType: "canal" },
    row,
    {
      originId: row.id_canal,
      date: row.fecha || row.fecha_comision,
      amount: row.comision,
      description: "Comision"
    }
  ));

  return candidates.filter((candidate) => candidate.id && candidate.date);
}

function bestBankSourceMatch(movement, candidates) {
  const creditorId = bankMovementBackendCreditorId(movement);
  if (!creditorId) return null;
  return (candidates || [])
    .map((candidate) => {
      if (backendId(candidate.idAcreedor) !== creditorId) return null;
      const dateDifference = Math.abs(bankDateDistance(movement.date, candidate.date));
      // Un gasto puede pagarse varios meses despues. Acreedor e importe exactos
      // son los criterios fuertes; la fecha solo ordena las coincidencias validas.
      if (dateDifference > 365) return null;
      const amountDifference = candidate.amount > 0
        ? Math.abs(candidate.amount - Math.abs(movement.amount))
        : Number.POSITIVE_INFINITY;
      if (Number.isFinite(amountDifference) && amountDifference > 5) return null;
      const score = 100 - (dateDifference * 2) - (Number.isFinite(amountDifference) ? amountDifference : 60);
      return { ...candidate, dateDifference, amountDifference, score };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score)[0] || null;
}

function backendBankIdentityIndex(tables) {
  const identities = [];
  const creditorsById = backendRowsById(tables.acreedores?.rows, "id_acreedor");
  const tagNameById = backendTagNameMap(tables);
  const creditorsByName = new Map();
  const creditorsByOrigin = new Map();
  (tables.acreedores?.rows || []).forEach((creditor) => {
    const key = `${backendNormalizeText(creditor.origen_tipo_acreedor)}:${backendId(creditor.origen_id_acreedor)}`;
    if (key !== ":" && !creditorsByOrigin.has(key)) creditorsByOrigin.set(key, creditor);
    const displayName = backendNormalizeText(backendCreditorDisplayName(creditor, tables));
    if (displayName && !creditorsByName.has(displayName)) creditorsByName.set(displayName, creditor);
  });
  const addIdentity = (identity) => {
    const name = compactBankText(identity.name || "");
    const cuit = normalizeBankCuit(identity.cuit || "");
    const detail = compactBankText(identity.detail || "");
    const cbuAlias = compactBankText(identity.cbuAlias || "");
    if (!name && !cuit && !detail && !cbuAlias) return;
    identities.push({
      ...identity,
      name,
      cuit,
      detail,
      cbuAlias,
      normalizedName: backendNormalizeText(name),
      normalizedDetail: backendNormalizeText(detail),
      normalizedCbuAlias: backendNormalizeText(cbuAlias)
    });
  };

  (tables.acreedores?.rows || []).forEach((creditor) => {
    const tagOptions = backendCreditorTagNames(creditor.id_acreedor, tables);
    const firstTag = tagOptions[0] || "";
    const firstTagId = backendTagIdForName(firstTag, tables);
    addIdentity({
      type: "acreedor",
      id: backendId(creditor.id_acreedor),
      name: backendCreditorDisplayName(creditor, tables),
      cuit: creditor.cuit_cuil,
      cbuAlias: creditor.cbu_alias,
      detail: "",
      tagOptions,
      idEtiqueta: firstTagId,
      idAcreedorEtiqueta: backendCreditorTagRelationId(creditor.id_acreedor, firstTagId, tables),
      tagLabel: firstTag,
      originType: creditor.origen_tipo_acreedor || "",
      originId: backendId(creditor.origen_id_acreedor),
      sourceDestination: bankSourceDestinationForOriginType(creditor.origen_tipo_acreedor)
    });
  });

  // Los ingresos pueden venir informados con el CUIT del cliente. Se indexan
  // aparte de los acreedores para evitar proponer altas duplicadas en cobros.
  (tables.clientes?.rows || []).forEach((client) => {
    addIdentity({
      type: "cliente",
      id: backendId(client.id_cliente),
      name: client.nombre_cliente,
      cuit: client.cuit || "",
      detail: "",
      originType: "cliente",
      originId: backendId(client.id_cliente)
    });
  });

  (tables.proveedores?.rows || []).forEach((provider) => {
    const creditor = creditorsByOrigin.get(`proveedor:${backendId(provider.id_proveedor)}`);
    addIdentity({
      type: "proveedor",
      id: backendId(provider.id_proveedor),
      idAcreedor: backendId(creditor?.id_acreedor),
      name: provider.nombre,
      cuit: provider.cuit || "",
      detail: "Proveedor",
      originType: "Proveedor",
      originId: backendId(provider.id_proveedor),
      sourceDestination: bankSourceDestinationForOriginType("Proveedor")
    });
  });

  // Datos bancarios guarda reglas explícitas: texto del extracto -> acreedor + etiqueta.
  (tables.datos_bancarios?.rows || []).forEach((bankData) => {
    const creditor = creditorsById.get(backendId(bankData.id_acreedor));
    const tagLabel = backendTagNameForId(bankData.id_etiqueta, tagNameById);
    addIdentity({
      type: "datos_bancarios",
      id: backendId(bankData.id_dato_bancario),
      idAcreedor: backendId(bankData.id_acreedor),
      idEtiqueta: backendId(bankData.id_etiqueta),
      invoiceType: cleanBackendText(bankData.tipo_factura),
      expenseType: tagLabel,
      tagLabel,
      name: backendCreditorDisplayName(creditor, tables),
      cuit: "",
      cbuAlias: "",
      detail: bankData.detalle || "",
      originType: creditor?.origen_tipo_acreedor || "",
      originId: backendId(creditor?.origen_id_acreedor),
      sourceDestination: bankSourceDestinationForOriginType(creditor?.origen_tipo_acreedor)
    });
  });

  return identities;
}

function identifyBankCounterparty(movement, identities) {
  const movementCuit = normalizeBankCuit(movement.cuit);
  const movementDetail = backendNormalizeText(movement.detail || movement.concept);

  // Si el banco informa CUIT, ese identificador manda. No usamos el detalle como
  // fallback porque textos genéricos del banco pueden terminar asociados a otro acreedor.
  if (movementCuit) {
    return (identities || [])
      .filter((identity) => identity.cuit && movementCuit === identity.cuit)
      .map((identity) => ({ ...identity, score: 100, reason: "CUIT" }))
      .sort((left, right) => right.score - left.score)[0] || null;
  }

  const scored = (identities || [])
    .filter((identity) => identity.type === "datos_bancarios")
    .map((identity) => {
      let score = 0;
      const reasons = [];
      if (identity.normalizedDetail && identity.normalizedDetail.length >= 4 && movementDetail) {
        if (movementDetail.includes(identity.normalizedDetail) || identity.normalizedDetail.includes(movementDetail)) {
          score += 55;
          reasons.push("detalle exacto");
        } else if (bankTextOverlapScore(movementDetail, identity.normalizedDetail) >= 2) {
          score += 20;
          reasons.push("detalle");
        }
      }
      return score ? { ...identity, score, reason: reasons.join(" + ") } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);

  return scored[0] || null;
}

function bankIdentityScore(movement, candidate) {
  const movementCuit = normalizeBankCuit(movement.cuit);
  const movementName = backendNormalizeText(movement.counterpartyName || movement.provider);
  const movementText = backendNormalizeText([movement.concept, movement.detail, movement.counterpartyName].filter(Boolean).join(" "));
  const candidateParty = backendNormalizeText(candidate.party);
  const candidateDescription = backendNormalizeText(candidate.description);
  const candidateCuit = normalizeBankCuit(candidate.cuit);

  if (movementCuit && candidateCuit && movementCuit === candidateCuit) {
    return { score: 70, reason: "CUIT" };
  }
  if (candidateParty && movementText.includes(candidateParty)) {
    return { score: 42, reason: "proveedor" };
  }
  if (movementName && candidateParty && (
    movementName.includes(candidateParty) || candidateParty.includes(movementName)
  )) {
    return { score: 38, reason: "nombre" };
  }
  if (candidateDescription && bankTextOverlapScore(movementText, candidateDescription) >= 2) {
    return { score: 24, reason: "detalle" };
  }
  return { score: 0, reason: "" };
}

function backendBankMatches(value, bank) {
  const normalizedValue = backendNormalizeText(value);
  const normalizedBank = backendNormalizeText(bank);
  return !normalizedValue || !normalizedBank || normalizedValue.includes(normalizedBank) || normalizedBank.includes(normalizedValue);
}

function backendEditableColumns(tableName, table) {
  const expected = EXPECTED_BACKEND_COLUMNS[tableName] || [];
  if (expected.length) return expected;
  return (table.headers || [])
    .map((column) => typeof column === "string" ? column : column.key || column.label || "")
    .filter((column) => column && !String(column || "").startsWith("_"));
}

function backendEditablePrimaryKey(tableName, table, columns) {
  const expectedPrimary = EXPECTED_BACKEND_COLUMNS[tableName]?.[0] || "";
  if (expectedPrimary) return expectedPrimary;
  const rawPrimary = table.definition?.primaryKey || "";
  const normalizedPrimary = backendNormalizeText(rawPrimary);
  return columns.find((column) => backendNormalizeText(column) === normalizedPrimary) || columns[0] || "";
}

function backendNextNumericId(rows, primaryKey) {
  if (!primaryKey) return "";
  const maxId = (rows || []).reduce((max, row) => {
    const number = Number(row?.[primaryKey]);
    return Number.isFinite(number) ? Math.max(max, Math.trunc(number)) : max;
  }, 0);
  return maxId + 1;
}

function bankDateDistance(leftIso, rightIso) {
  if (!leftIso || !rightIso) return 999;
  return Math.round(Math.abs(new Date(`${leftIso}T00:00:00`) - new Date(`${rightIso}T00:00:00`)) / 86400000);
}

function compactBankText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\s+·\s+/g, " · ")
    .trim();
}

function normalizeBankCuit(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  const withoutLeadingZeros = digits.replace(/^0+/, "");
  return withoutLeadingZeros.length >= 7 ? withoutLeadingZeros : digits;
}

function extractBankCuit(value) {
  const text = String(value || "");
  const match = text.match(/\b0*(20|23|24|27|30|33|34)\d{9}\b/);
  return match ? match[0] : "";
}

function normalizeBankCheckNumber(value) {
  const digits = String(value || "").replace(/\D/g, "").replace(/^0+/, "");
  return digits || "";
}

function extractBankCheckNumber(value) {
  const text = String(value || "").toUpperCase();
  if (!/(E\s*-?\s*CHEQ|ECHEQ|CHEQUE|CH\s|CH\.|CAMARA|CÁMARA)/.test(text)) return "";

  const markerMatch = text.match(/(?:E\s*-?\s*CHEQ|ECHEQ|CHEQUE|CH\.?|CAMARA|CÁMARA)\s*([0-9]{3,12})/);
  if (markerMatch) return normalizeBankCheckNumber(markerMatch[1]);

  const candidates = [...text.matchAll(/\b([0-9]{3,12})\b/g)].map((match) => match[1]);
  const nonCuitCandidates = candidates.filter((candidate) => normalizeBankCuit(candidate).length !== 11);
  return normalizeBankCheckNumber(nonCuitCandidates.at(-1) || candidates.at(-1) || "");
}

function bankTextOverlapScore(left, right) {
  const ignored = new Set(["de", "del", "la", "el", "los", "las", "sa", "srl", "sas", "y", "a", "por", "con", "pago", "transferencia", "transf"]);
  const leftTokens = new Set(String(left || "").split(/\s+/).filter((token) => token.length >= 3 && !ignored.has(token)));
  const rightTokens = String(right || "").split(/\s+/).filter((token) => token.length >= 3 && !ignored.has(token));
  return rightTokens.reduce((score, token) => score + (leftTokens.has(token) ? 1 : 0), 0);
}

function buildBackendCashflowReport() {
  const cache = loadCache();
  const tables = cache.tables || {};
  const startIso = backendCurrentDateIso();
  const initialCash = backendInitialCash(tables);
  const events = [
    ...backendCashflowPayableEvents(tables),
    ...backendCashflowReceivableEvents(tables),
    ...backendCashflowIssuedCheckEvents(tables),
    ...backendCashflowReceivedCheckEvents(tables, startIso)
  ].filter((event) => event.date && Math.abs(event.amount) > 10);

  const groups = backendCashflowGroups(events, startIso);
  const visibleGroups = groups.filter((group) => group.week.number <= 4);
  const weeks = backendCashflowWeeks(visibleGroups, initialCash.total, startIso);
  const payables = events.filter((event) => event.type === "payable");
  const receivables = events.filter((event) => event.type === "receivable");
  const checks = events.filter((event) => event.type === "received-check");
  const issuedChecks = events.filter((event) => event.type === "issued-check");

  return {
    source: "backend",
    startIso,
    cards: {
      banks: initialCash.banks,
      cash: initialCash.cash,
      checksOnHand: backendObjectSum(checks.map((event) => event.amount)),
      receivable: backendObjectSum(receivables.map((event) => event.amount)),
      debts: backendObjectSum(payables.map((event) => Math.abs(event.amount))),
      checksToCover: backendObjectSum(issuedChecks.map((event) => Math.abs(event.amount)))
    },
    groups,
    visibleGroups,
    weeks
  };
}

function backendInitialCash(tables) {
  const cashRows = tables.caja?.rows || tables.cash?.rows || [];
  const latestByAccount = new Map();

  cashRows.forEach((row) => {
    const account = String(row.cuenta || row.banco || row.account || row.nombre || "").trim();
    const amount = backendNumber(row.monto ?? row.total ?? row.valor ?? row.amount);
    if (!account || !amount) return;
    latestByAccount.set(backendNormalizeText(account), { account, amount });
  });

  const amountFor = (...names) => names.reduce((total, name) => {
    const normalized = backendNormalizeText(name);
    return total + (latestByAccount.get(normalized)?.amount || 0);
  }, 0);
  const banks = amountFor("Banco ICBC", "ICBC") + amountFor("Banco GAL", "GAL");
  const cash = amountFor("Efectivo");
  return { banks, cash, total: banks + cash };
}

function backendCashflowPayableEvents(tables) {
  const paidByExpense = new Map();
  (tables.detalle_pagos?.rows || []).forEach((detail) => {
    const expenseId = backendId(detail.id_egreso);
    if (!expenseId) return;
    paidByExpense.set(expenseId, (paidByExpense.get(expenseId) || 0) + backendNumber(detail.monto_cancelado));
  });

  return (tables.egresos?.rows || []).map((expense) => {
    const expenseId = backendId(expense.id_egreso);
    const invoiceType = expense.tipo_factura || "";
    if (!backendCashflowInvoiceTypeVisible(invoiceType)) return null;
    const balance = backendNumber(expense.total) - (paidByExpense.get(expenseId) || 0);
    if (balance <= 10) return null;
    return {
      type: "payable",
      label: "Pago",
      date: backendIsoDate(expense.fecha_prevista_pago) || backendIsoDate(expense.fecha_factura),
      party: backendExpenseSupplierName(expense, tables) || "Sin acreedor",
      documentType: invoiceType || "Sin tipo",
      documentNumber: expense.nro_factura || "Sin numero",
      effectiveDate: backendIsoDate(expense.fecha_factura),
      amount: -balance
    };
  }).filter(Boolean);
}

function backendCashflowReceivableEvents(tables) {
  const clientsById = backendRowsById(tables.clientes?.rows, "id_cliente");
  const collectedBySale = new Map();
  (tables.cobros_detalle?.rows || []).forEach((detail) => {
    const saleId = backendId(detail.id_venta);
    if (!saleId) return;
    collectedBySale.set(saleId, (collectedBySale.get(saleId) || 0) + backendNumber(detail.monto_cancelado));
  });

  return (tables.ventas?.rows || []).map((sale) => {
    const saleId = backendId(sale.id_venta);
    const balance = backendNumber(sale.total) - (collectedBySale.get(saleId) || 0);
    if (balance <= 10) return null;
    const client = clientsById.get(backendId(sale.id_cliente));
    return {
      type: "receivable",
      label: "Cobro",
      date: backendIsoDate(sale.fecha_acordada) || backendIsoDate(sale.fecha_factura),
      party: client?.nombre_cliente || "Sin cliente",
      documentType: sale.tipo_factura || "Sin tipo",
      documentNumber: sale.nro_factura || "Sin numero",
      effectiveDate: backendIsoDate(sale.fecha_factura),
      amount: balance
    };
  }).filter(Boolean);
}

function backendCashflowReceivedCheckEvents(tables, startIso) {
  const clientsById = backendRowsById(tables.clientes?.rows, "id_cliente");
  const cobrosById = backendRowsById(tables.cobros?.rows, "id_cobro");

  return (tables.cheques_recibidos?.rows || []).map((check) => {
    const collection = cobrosById.get(backendId(check.id_cobro));
    if (!backendCashflowCheckIsPending(check.estado)) return null;
    const useDate = backendIsoDate(check.fecha_uso);
    if (!useDate || useDate < startIso) return null;
    const amount = backendNumber(check.monto ?? collection?.monto);
    if (amount <= 10) return null;
    const client = clientsById.get(backendId(check.id_cliente || collection?.id_cliente));
    return {
      type: "received-check",
      label: "Cheque",
      date: useDate,
      party: check.cliente || client?.nombre_cliente || "Sin cliente",
      documentType: "Cheque",
      documentNumber: check.nro_cheque || "Sin numero",
      effectiveDate: backendIsoDate(check.fecha_entregado) || backendIsoDate(collection?.fecha_cobro),
      amount
    };
  }).filter(Boolean);
}

function backendCashflowIssuedCheckEvents(tables) {
  const creditorsById = backendRowsById(tables.acreedores?.rows, "id_acreedor");

  return (tables.cheques_entregados?.rows || []).map((check) => {
    if (!backendCashflowCheckIsPending(check.estado)) return null;
    const amount = backendNumber(check.monto);
    if (amount <= 10) return null;
    const creditor = creditorsById.get(backendId(check.id_acreedor));
    return {
      type: "issued-check",
      label: "Cheque a cubrir",
      date: backendIsoDate(check.fecha_uso),
      party: backendCreditorDisplayName(creditor, tables) || "Sin acreedor",
      documentType: "Cheque",
      documentNumber: check.nro_cheque || "Sin numero",
      effectiveDate: backendIsoDate(check.fecha_entregado),
      amount: -Math.abs(amount)
    };
  }).filter(Boolean);
}

function backendCashflowCheckIsPending(status) {
  const normalized = backendNormalizeText(status);
  return normalized === "pendiente";
}

function backendCashflowGroups(events, startIso) {
  const groups = new Map();

  events.forEach((event) => {
    const key = [
      event.type,
      event.date,
      backendNormalizeText(event.party),
      backendNormalizeText(event.documentType),
      backendNormalizeText(event.documentNumber),
      event.effectiveDate || "",
      event.amount
    ].join("|");
    if (!groups.has(key)) {
      groups.set(key, {
        ...event,
        overrideKey: backendCashflowOverrideKey(event),
        amount: 0,
        count: 0
      });
    }
    const group = groups.get(key);
    group.amount += event.amount;
    group.count += 1;
  });

  return [...groups.values()]
    .map((group) => ({ ...group, week: backendCashflowWeekForDate(group.date, startIso) }))
    .sort((left, right) => left.week.number - right.week.number || left.date.localeCompare(right.date) || left.party.localeCompare(right.party));
}

function backendCashflowWeeks(groups, initialCash, startIso) {
  let balance = initialCash;
  const weeks = new Map();
  for (let number = 1; number <= 4; number += 1) {
    weeks.set(number, { ...backendCashflowWeekForNumber(number, startIso), income: 0, outcome: 0, net: 0, balance: 0 });
  }

  groups.forEach((group) => {
    if (group.week.number > 4) return;
    const week = weeks.get(group.week.number);
    if (group.amount >= 0) week.income += group.amount;
    else week.outcome += Math.abs(group.amount);
    week.net += group.amount;
  });

  return [...weeks.values()].map((week) => {
    balance += week.net;
    return { ...week, balance };
  });
}

function backendCashflowWeekForDate(dateIso, startIso) {
  if (!dateIso || dateIso < startIso) return backendCashflowWeekForNumber(1, startIso);
  const days = Math.floor((new Date(`${dateIso}T00:00:00`) - new Date(`${startIso}T00:00:00`)) / 86400000);
  return backendCashflowWeekForNumber(Math.floor(days / 7) + 1, startIso);
}

function backendCashflowWeekForNumber(number, startIso) {
  const start = new Date(`${startIso}T00:00:00`);
  start.setDate(start.getDate() + ((number - 1) * 7));
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return {
    number,
    startIso: start.toISOString().slice(0, 10),
    endIso: end.toISOString().slice(0, 10)
  };
}

function backendCashflowOverrideKey(event) {
  return `${event.type}|${backendNormalizeText(event.party)}|${event.date}|${backendNormalizeText(event.documentType)}|${backendNormalizeText(event.documentNumber)}|${event.effectiveDate || ""}`;
}

function backendCashflowInvoiceTypeVisible(invoiceType) {
  const normalized = backendNormalizeText(invoiceType);
  return normalized !== "asiento" && normalized !== "remito a";
}

function buildBackendIncomeStatementReport(year, month) {
  const cache = loadCache();
  const tables = cache.tables || {};
  const startIso = backendMonthStartIso(year, month);
  const endIso = backendMonthEndIso(year, month);
  const dayBeforeStartIso = backendOffsetIsoDate(startIso, -1);

  const clientsById = backendRowsById(tables.clientes?.rows, "id_cliente");
  const channelsById = backendRowsById(tables.canales?.rows, "id_canal");
  const productsById = backendRowsById(tables.productos?.rows, "id_producto");
  const productByItemId = backendRowsById(tables.productos?.rows, "id_item");
  const itemsById = backendRowsById(tables.items?.rows, "id_item");
  const ordersById = backendRowsById(tables.pedidos?.rows, "id_pedido");
  const detailsByOrder = backendGroupRowsById(tables.detalle_pedidos?.rows, "id_pedido");
  const inventoryById = backendRowsById(tables.inventarios?.rows, "id_inventario");
  const inventoryDetailsByInventory = backendGroupRowsById(tables.detalle_inventarios?.rows, "id_inventario");

  const monthlySales = (tables.ventas?.rows || []).filter((sale) => {
    const date = backendIsoDate(sale.fecha_factura);
    return date >= startIso && date <= endIso;
  });

  const salesBuckets = { schools: 0, other: 0 };
  let salesNet = 0;
  let grossRevenueTaxBase = 0;
  let channelCommissionCost = 0;
  const customers = new Set();
  const orderIds = new Set();

  monthlySales.forEach((sale) => {
    const amount = backendNumber(sale.subtotal);
    salesNet += amount;
    const client = clientsById.get(backendId(sale.id_cliente));
    if (backendIsGrossRevenueTaxInvoice(sale.tipo_factura)) grossRevenueTaxBase += amount;
    const channel = channelsById.get(backendId(client?.id_canal));
    channelCommissionCost += amount * backendRate(channel?.comision);
    if (client?.id_cliente !== undefined) customers.add(backendId(client.id_cliente));
    if (backendIsSchoolClient(client)) salesBuckets.schools += amount;
    else salesBuckets.other += amount;
    if (sale.id_pedido !== undefined && sale.id_pedido !== "") orderIds.add(backendId(sale.id_pedido));
  });

  let unitsSold = 0;
  const monthlyOrderDetails = [];
  orderIds.forEach((orderId) => {
    (detailsByOrder.get(orderId) || []).forEach((detail) => {
      const product = productsById.get(backendId(detail.id_producto));
      const order = ordersById.get(orderId);
      const quantity = backendNumber(detail.cantidad_cajas) * backendNumber(product?.cantidad_individual || 1);
      unitsSold += quantity;
      monthlyOrderDetails.push({
        date: backendIsoDate(order?.fecha_entrega || order?.fecha_pedido),
        orderId,
        productId: detail.id_producto,
        individualQuantity: quantity,
        customer: clientsById.get(backendId(order?.id_cliente))?.nombre_cliente || ""
      });
    });
  });

  const expenseCategories = backendExpenseCategoryTotals(tables, startIso, endIso);
  const uncategorized = backendUncategorizedExpenseRows(tables, startIso, endIso);
  const expenseSubtotal = (categories) => {
    const normalized = new Set(categories.map(backendNormalizeText));
    return Object.entries(expenseCategories).reduce((total, [category, value]) => {
      return normalized.has(backendNormalizeText(category)) ? total + value : total;
    }, 0);
  };

  const initialInventory = backendLastInventorySummary(
    tables,
    "",
    dayBeforeStartIso,
    inventoryById,
    inventoryDetailsByInventory,
    productByItemId,
    itemsById
  );
  const finalInventory = backendLastInventorySummary(
    tables,
    startIso,
    endIso,
    inventoryById,
    inventoryDetailsByInventory,
    productByItemId,
    itemsById
  );
  const payrollRowsForHours = tables.sueldos?.rows || [];
  const payroll = backendPayrollSummary(payrollRowsForHours, startIso, endIso);
  const production = {
    initial: initialInventory,
    final: finalInventory,
    unitsSold,
    calculatedUnits: unitsSold + (finalInventory?.units || 0) - (initialInventory?.units || 0),
    unitsPerHour: 0
  };
  production.unitsPerHour = payroll.totalHours ? production.calculatedUnits / payroll.totalHours : 0;

  const merchandisePurchases = expenseSubtotal(["Mercaderia"]);
  const merchandiseCost = (initialInventory?.value || 0) + merchandisePurchases - (finalInventory?.value || 0);
  const costOfSales = {
    merchandise: merchandiseCost,
    merchandiseInitialInventory: initialInventory?.value || 0,
    merchandisePurchases,
    merchandiseFinalInventory: finalInventory?.value || 0,
    commissions: expenseSubtotal(["Comisiones"]) || channelCommissionCost,
    grossRevenueTax: grossRevenueTaxBase * 0.015,
    logistics: expenseSubtotal(["Logistica"])
  };
  const totalCostOfSales = merchandiseCost + costOfSales.commissions + costOfSales.grossRevenueTax + costOfSales.logistics;
  const grossMargin = salesNet - totalCostOfSales;

  const operatingExpenses = {
    salaries: payroll.totalGross || expenseSubtotal(["Sueldos"]),
    extraSalaries: expenseSubtotal(["Sueldos_Extras"]),
    admin: expenseSubtotal(["Administrativos"]),
    services: expenseSubtotal(["Servicios", "Herramientas_De_Trabajo"]),
    rent: expenseSubtotal(["Alquiler"]),
    maintenanceAndMisc: expenseSubtotal(["Cadeteria", "Limpieza", "Varios", "Otros", "Incentivos_Personal"])
  };
  const totalOperatingExpenses = backendObjectSum(operatingExpenses);
  const operatingResult = grossMargin - totalOperatingExpenses;

  const nonOperatingExpenses = {
    otherTaxes: expenseSubtotal(["Impuesto Cred", "Impuesto Deb", "Impuesto Sello", "Impuestos Internos"]),
    bankFees: expenseSubtotal(["Gastos Bancarios"]),
    interest: expenseSubtotal(["Intereses", "Rendimiento Fondo"]),
    generalInvestment: expenseSubtotal(["Inversion General", "Maquinaria"])
  };
  const totalNonOperatingExpenses = backendObjectSum(nonOperatingExpenses);
  const netResult = operatingResult - totalNonOperatingExpenses;

  return {
    source: "backend",
    year,
    month,
    startIso,
    endIso,
    monthlyOrderDetails,
    monthlyPayroll: payroll.rows,
    unitsSold,
    customerCount: customers.size,
    averagePrice: unitsSold ? salesNet / unitsSold : 0,
    payroll,
    production,
    salesNet,
    salesBuckets,
    costOfSales,
    totalCostOfSales,
    operatingExpenses,
    totalOperatingExpenses,
    nonOperatingExpenses,
    totalNonOperatingExpenses,
    initialInventory,
    finalInventory,
    grossMargin,
    operatingResult,
    netResult,
    uncategorized
  };
}

function backendStatementExpenseCategories() {
  return new Set([
    "mercaderia",
    "comisiones",
    "ingresos brutos",
    "logistica",
    "sueldos",
    "sueldos extras",
    "administrativos",
    "servicios",
    "herramientas de trabajo",
    "alquiler",
    "cadeteria",
    "limpieza",
    "varios",
    "otros",
    "incentivos personal",
    "impuesto cred",
    "impuesto deb",
    "impuesto sello",
    "impuestos internos",
    "gastos bancarios",
    "intereses",
    "rendimiento fondo",
    "inversion general",
    "maquinaria"
  ]);
}

function backendTagNameMap(tables) {
  const result = new Map();
  (tables.etiquetas?.rows || []).forEach((tag) => {
    const id = backendId(tag.id_etiqueta);
    const name = cleanBackendText(tag.etiqueta);
    if (id && name) result.set(id, name);
  });
  return result;
}

function backendTagNameForId(id, tagNameById) {
  return tagNameById.get(backendId(id)) || "";
}

function backendTagNameForCreditorTagId(creditorTagId, tables, helpers = {}) {
  const relationId = backendId(creditorTagId);
  if (!relationId) return "";
  const relationsById = helpers.relationsById || backendRowsById(tables.acreedores_etiquetas?.rows, "id_acreedor_etiqueta");
  const tagNameById = helpers.tagNameById || backendTagNameMap(tables);
  const relation = relationsById.get(relationId);
  return backendTagNameForId(relation?.id_etiqueta, tagNameById);
}

function backendTagIdForName(name, tables) {
  const normalized = normalizeLookupText(name);
  if (!normalized) return "";
  const tag = (tables.etiquetas?.rows || []).find((row) => normalizeLookupText(row.etiqueta) === normalized);
  return backendId(tag?.id_etiqueta);
}

function backendEconomicExpenseRows(tables, startIso, endIso) {
  const tagNameById = backendTagNameMap(tables);
  const creditorTagById = backendRowsById(tables.acreedores_etiquetas?.rows, "id_acreedor_etiqueta");
  const providersById = backendRowsById(tables.proveedores?.rows, "id_proveedor");
  const purchasesById = backendRowsById(tables.compras?.rows, "id_compra");
  const fletesById = backendRowsById(tables.fletes?.rows, "id_flete");
  const employeesById = backendRowsById(tables.empleados?.rows, "id_empleado");
  const creditorsById = backendRowsById(tables.acreedores?.rows, "id_acreedor");
  const channelsById = backendRowsById(tables.canales?.rows, "id_canal");
  const expensesById = backendRowsById(tables.egresos?.rows, "id_egreso");
  const rows = [];

  const categoryFor = (row) => {
    return backendTagNameForCreditorTagId(row.id_acreedor_etiqueta, tables, { relationsById: creditorTagById, tagNameById })
      || cleanBackendText(row._etiqueta_gasto)
      || backendTagNameForId(expensesById.get(backendId(row.id_egreso))?.id_etiqueta, tagNameById);
  };
  const amountFor = (row, columns) => {
    for (const column of columns) {
      const amount = backendNumber(row[column]);
      if (amount) return amount;
    }
    const linkedExpense = expensesById.get(backendId(row.id_egreso));
    return backendNumber(linkedExpense?.subtotal || linkedExpense?.total);
  };
  const add = (entry) => {
    const date = backendIsoDate(entry.date);
    if (date < startIso || date > endIso) return;
    if (!entry.category || !entry.amount) return;
    rows.push({ ...entry, date });
  };

  (tables.recepciones?.rows || []).forEach((reception) => {
    const purchase = purchasesById.get(backendId(reception.id_compra));
    const provider = providersById.get(backendId(purchase?.id_proveedor || reception._id_acreedor));
    add({
      id: reception.id_recepcion,
      date: reception.fecha_recepcion || reception._fecha_factura,
      supplier: provider?.nombre || cleanBackendText(reception._nombre_acreedor),
      category: categoryFor(reception) || "Mercaderia",
      amount: amountFor(reception, ["subtotal", "_subtotal", "total", "_total"]),
      source: `recepciones #${reception.id_recepcion || ""}`
    });
  });

  (tables.entregas?.rows || []).forEach((delivery) => {
    const carrier = fletesById.get(backendId(delivery.id_flete));
    add({
      id: delivery.id_entrega,
      date: delivery.fecha || delivery._fecha_factura,
      supplier: carrier?.nombre_flete || cleanBackendText(delivery._nombre_acreedor),
      category: categoryFor(delivery) || "Logistica",
      amount: amountFor(delivery, ["subtotal", "_subtotal", "total", "_total"]),
      source: `entregas #${delivery.id_entrega || ""}`
    });
  });

  (tables.otros_gastos?.rows || []).forEach((expense) => {
    const creditor = creditorsById.get(backendId(expense.id_acreedor));
    add({
      id: expense.id_otros_gastos,
      date: expense.fecha_otros_gastos || expense._fecha_factura,
      supplier: backendCreditorDisplayName(creditor, tables) || cleanBackendText(expense._nombre_acreedor),
      category: categoryFor(expense),
      amount: amountFor(expense, ["subtotal", "_subtotal", "total", "_total"]),
      source: `otros_gastos #${expense.id_otros_gastos || ""}`
    });
  });

  (tables.sueldos?.rows || []).forEach((salary) => {
    const employee = employeesById.get(backendId(salary.id_empleado));
    add({
      id: salary.id_sueldo,
      date: salary.fecha,
      supplier: employee?.nombre_empleado || "",
      category: categoryFor(salary) || "Sueldos",
      amount: amountFor(salary, ["sueldo_bruto", "sueldo_neto"]),
      source: `sueldos #${salary.id_sueldo || ""}`
    });
  });

  (tables.comisiones?.rows || []).forEach((commission) => {
    const channel = channelsById.get(backendId(commission.id_canal));
    add({
      id: commission.id_comision,
      date: commission.fecha,
      supplier: channel?.nombre || "",
      category: categoryFor(commission) || "Comisiones",
      amount: amountFor(commission, ["comision", "subtotal"]),
      source: `comisiones #${commission.id_comision || ""}`
    });
  });

  return rows;
}

function backendExpenseCategoryTotals(tables, startIso, endIso) {
  const totals = {};
  backendEconomicExpenseRows(tables, startIso, endIso).forEach((expense) => {
    totals[expense.category] = (totals[expense.category] || 0) + expense.amount;
  });

  return totals;
}

function backendUncategorizedExpenseRows(tables, startIso, endIso) {
  const statementCategories = backendStatementExpenseCategories();

  return backendEconomicExpenseRows(tables, startIso, endIso)
    .filter((expense) => {
      return !statementCategories.has(backendNormalizeText(expense.category));
    })
    .map((expense) => {
      return {
        id: expense.id || "",
        date: expense.date,
        supplier: expense.supplier || "",
        category: expense.category || "Sin categoria",
        subtotal: expense.amount,
        source: expense.source || ""
      };
    })
    .sort((left, right) => left.date.localeCompare(right.date) || String(left.supplier).localeCompare(String(right.supplier)));
}

function backendExpenseSupplierName(expense, tables) {
  return backendExpenseCounterpartyInfo(expense, tables).name;
}

function backendExpenseCounterpartyInfo(expense, tables) {
  const linkedOrigin = backendExpenseLinkedOrigin(expense, tables);
  const originType = backendExpenseSourceTypeKey(linkedOrigin.type);
  const originId = linkedOrigin.id;
  const providersById = backendRowsById(tables.proveedores?.rows, "id_proveedor");
  const creditorsById = backendRowsById(tables.acreedores?.rows, "id_acreedor");

  if (originType === "recepciones") {
    const receptionsById = backendRowsById(tables.recepciones?.rows, "id_recepcion");
    const purchasesById = backendRowsById(tables.compras?.rows, "id_compra");
    const reception = linkedOrigin.row || receptionsById.get(originId);
    const purchase = purchasesById.get(backendId(reception?.id_compra));
    const provider = providersById.get(backendId(purchase?.id_proveedor));
    return {
      name: provider?.nombre || "",
      cuit: normalizeBankCuit(provider?.cuit),
      detail: "Recepcion"
    };
  }

  if (originType === "otros gastos" || originType === "otros_gastos") {
    const otherExpensesById = backendRowsById(tables.otros_gastos?.rows, "id_otros_gastos");
    const otherExpense = linkedOrigin.row || otherExpensesById.get(originId);
    const creditor = creditorsById.get(backendId(otherExpense?.id_acreedor));
    return {
      name: backendCreditorDisplayName(creditor, tables),
      cuit: normalizeBankCuit(creditor?.cuit_cuil),
      detail: otherExpense?.detalle || backendCreditorTagNames(creditor?.id_acreedor, tables).join(" ")
    };
  }

  if (originType === "sueldos") {
    const salariesById = backendRowsById(tables.sueldos?.rows, "id_sueldo");
    const employeesById = backendRowsById(tables.empleados?.rows, "id_empleado");
    const salary = linkedOrigin.row || salariesById.get(originId);
    const employee = employeesById.get(backendId(salary?.id_empleado));
    return {
      name: employee?.nombre_empleado || "",
      cuit: normalizeBankCuit(employee?.cuit_cuil || employee?.dni),
      detail: "Sueldos"
    };
  }

  if (originType === "logistica") {
    const deliveriesById = backendRowsById(tables.entregas?.rows, "id_entrega");
    const freightsById = backendRowsById(tables.fletes?.rows, "id_flete");
    const delivery = linkedOrigin.row || deliveriesById.get(originId);
    const freight = freightsById.get(backendId(delivery?.id_flete));
    return {
      name: freight?.nombre_flete || "",
      cuit: normalizeBankCuit(freight?.cuit),
      detail: "Logistica"
    };
  }

  // Egresos historicos pueden no tener fila operativa enlazada. En esos casos
  // el import conserva el acreedor original en _id_acreedor.
  const historicalCreditor = creditorsById.get(backendId(expense._id_acreedor));
  if (historicalCreditor) {
    return {
      name: backendCreditorDisplayName(historicalCreditor, tables),
      cuit: normalizeBankCuit(historicalCreditor.cuit_cuil),
      detail: cleanBackendText(expense._etiqueta_gasto) || backendCreditorTagNames(historicalCreditor.id_acreedor, tables).join(" ")
    };
  }

  return { name: "", cuit: "", detail: "" };
}

function backendExpenseLinkedOrigin(expense, tables) {
  const expenseId = backendId(expense.id_egreso);
  if (expenseId) {
    for (const config of backendExpenseSourceConfigs()) {
      const row = (tables[config.table]?.rows || []).find((sourceRow) => backendId(sourceRow.id_egreso) === expenseId);
      if (row) return { type: config.type, id: backendId(row[config.idColumn]), row };
    }
  }

  // Compatibilidad con caches/imports viejos: el origen ya no pertenece al modelo de egresos.
  return {
    type: expense.origen_tipo || "",
    id: backendId(expense.origen_id),
    row: null
  };
}

function backendExpenseSourceConfigs() {
  return [
    { table: "recepciones", type: "recepciones", idColumn: "id_recepcion" },
    { table: "otros_gastos", type: "otros_gastos", idColumn: "id_otros_gastos" },
    { table: "sueldos", type: "sueldos", idColumn: "id_sueldo" },
    { table: "entregas", type: "logistica", idColumn: "id_entrega" },
    { table: "comisiones", type: "comisiones", idColumn: "id_comision" }
  ];
}

function backendExpenseSourceTypeKey(value) {
  const text = backendNormalizeText(value);
  if (text === "entregas" || text === "logistica") return "logistica";
  if (text === "otros gastos" || text === "otros_gastos") return "otros_gastos";
  return text;
}

function backendCreditorDisplayName(creditor, tables) {
  if (!creditor) return "";
  const originType = backendNormalizeText(creditor.origen_tipo_acreedor);
  const originId = backendId(creditor.origen_id_acreedor);

  if (originType === "proveedor") {
    return backendRowsById(tables.proveedores?.rows, "id_proveedor").get(originId)?.nombre || "";
  }
  if (originType === "empleado") {
    return backendRowsById(tables.empleados?.rows, "id_empleado").get(originId)?.nombre_empleado || "";
  }
  if (originType === "flete") {
    return backendRowsById(tables.fletes?.rows, "id_flete").get(originId)?.nombre_flete || "";
  }
  if (originType === "canal") {
    return backendRowsById(tables.canales?.rows, "id_canal").get(originId)?.nombre || "";
  }
  if (originType === "otros acreedores") {
    return backendRowsById(tables.otros_acreedores?.rows, "id_otro_acreedor").get(originId)?.nombre_otro_acreedor || "";
  }

  return creditor.acuerdo_de_pago || "";
}

function backendCreditorTagNames(creditorId, tables) {
  const normalizedCreditorId = backendId(creditorId);
  if (!normalizedCreditorId) return [];
  const tagNameById = backendTagNameMap(tables);
  const names = [];
  (tables.acreedores_etiquetas?.rows || []).forEach((relation) => {
    if (backendId(relation.id_acreedor) !== normalizedCreditorId) return;
    const tagName = backendTagNameForId(relation.id_etiqueta, tagNameById);
    if (tagName && !names.includes(tagName)) names.push(tagName);
  });
  return names;
}

function backendPayrollSummary(rows, startIso, endIso) {
  const employees = new Map();
  let totalGross = 0;

  rows.forEach((row) => {
    const date = backendIsoDate(row.fecha);
    if (date < startIso || date > endIso) return;

    const employee = backendId(row.id_empleado) || "Sin empleado";
    if (!employees.has(employee)) {
      employees.set(employee, {
        employee,
        date,
        workedHours: 0,
        extraHours: 0,
        totalHours: 0
      });
    }

    const workedHours = backendNumber(row.hs_trabajadas);
    const extraHours = backendNumber(row.hs_extra);
    const summary = employees.get(employee);
    summary.workedHours += workedHours;
    summary.extraHours += extraHours;
    summary.totalHours += workedHours + extraHours;
    totalGross += backendNumber(row.sueldo_bruto);
  });

  const summaryRows = [...employees.values()]
    .filter((row) => row.totalHours > 0)
    .sort((left, right) => right.totalHours - left.totalHours || String(left.employee).localeCompare(String(right.employee)));

  return {
    rows: summaryRows,
    employeeCount: summaryRows.length,
    totalHours: summaryRows.reduce((total, row) => total + row.totalHours, 0),
    totalGross
  };
}

function backendLastInventorySummary(tables, startIso, endIso, inventoryById, detailsByInventory, productByItemId, itemsById) {
  const rows = (tables.inventarios?.rows || [])
    .map((inventory) => ({ inventory, date: backendIsoDate(inventory.fecha) }))
    .filter((row) => row.date && (!startIso || row.date >= startIso) && (!endIso || row.date <= endIso))
    .sort((left, right) => {
      if (left.date !== right.date) return right.date.localeCompare(left.date);
      return backendTurnRank(right.inventory.turno) - backendTurnRank(left.inventory.turno);
    });

  if (!rows.length) return null;
  const latest = rows[0].inventory;
  let units = 0;
  let calculatedValue = 0;
  let valuedDetailCount = 0;
  const valueDetails = [];
  (detailsByInventory.get(backendId(latest.id_inventario)) || []).forEach((detail) => {
    const item = itemsById.get(backendId(detail.id_item));
    const product = productByItemId.get(backendId(detail.id_item));
    const originType = backendNormalizeText(item?.origen_tipo);
    const quantity = backendInventoryQuantity(detail.cantidad);
    const unitCost = backendNumber(detail.costo_unitario_usado);
    if (unitCost > 0) {
      calculatedValue += quantity * unitCost;
      valuedDetailCount += 1;
    }

    if (originType === "producto" || product) {
      units += quantity * backendNumber(product?.cantidad_individual || 1);
    }

    if (originType === "insumo") {
      valueDetails.push({
        id_item: detail.id_item,
        id_insumo: backendId(item?.id_origen),
        quantity,
        unitCost,
        value: roundBackendMoney(quantity * unitCost)
      });
    }
  });

  const storedValue = backendNumber(latest.valor_total);

  return {
    date: backendIsoDate(latest.fecha),
    turn: latest.turno || "",
    units,
    value: valuedDetailCount ? roundBackendMoney(calculatedValue) : storedValue,
    storedValue,
    valueDetails
  };
}

function backendLatestSupplyCostMap(tables, dateIso) {
  const purchasesById = backendRowsById(tables.compras?.rows, "id_compra");
  const expensesById = backendRowsById(tables.egresos?.rows, "id_egreso");
  const receptionsByPurchase = backendGroupRowsById(tables.recepciones?.rows, "id_compra");
  const receptionDetailsByReception = backendGroupRowsById(tables.detalle_recepciones?.rows, "id_recepcion");
  const suppliesById = backendRowsById(tables.insumos?.rows, "id_insumo");
  const supplierItemsById = backendRowsById(tables.insumos_proveedores?.rows, "id_insumos_proveedores");
  const candidatesBySupply = new Map();

  (tables.detalle_compras?.rows || []).forEach((detail) => {
    const purchase = purchasesById.get(backendId(detail.id_compra));
    if (!purchase) return;

    const receptionRows = receptionsByPurchase.get(backendId(detail.id_compra)) || [];
    const receptionDate = receptionRows
      .map((row) => backendIsoDate(row.fecha_recepcion))
      .filter(Boolean)
      .sort()
      .at(-1);
    const purchaseDate = receptionDate || backendIsoDate(purchase.fecha_pedido) || backendIsoDate(purchase.fecha_entrega_prevista);
    if (!purchaseDate) return;

    const supplierItem = supplierItemsById.get(backendId(detail.id_insumos_proveedores));
    if (!supplierItem) return;

    const supplyId = backendId(supplierItem.id_insumo);
    if (!supplyId) return;

    const supplyRecipeUnitsPerCountUnit = backendRecipeQuantity(suppliesById.get(supplyId)?.cantidad_receta) || 1;
    const supplierRecipeUnitsPerProviderUnit = backendNumber(supplierItem.cantidad_proveedor) || 1;
    const unitCost = backendReceptionRecipeUnitCost({
      detail,
      expenseRows: expensesById,
      receptionRows,
      receptionDetailsByReception,
      supplyId,
      supplierRecipeUnitsPerProviderUnit,
      supplierItem
    });
    if (!unitCost) return;

    if (!candidatesBySupply.has(supplyId)) candidatesBySupply.set(supplyId, []);
    candidatesBySupply.get(supplyId).push({
      date: purchaseDate,
      unitCost,
      supplierItemId: supplierItem.id_insumos_proveedores,
      supplyRecipeUnitsPerCountUnit,
      supplierRecipeUnitsPerProviderUnit
    });
  });

  const selectedBySupply = new Map();
  candidatesBySupply.forEach((candidates, supplyId) => {
    const sorted = candidates.slice().sort((left, right) => left.date.localeCompare(right.date));
    const previous = dateIso ? sorted.filter((candidate) => candidate.date <= dateIso).at(-1) : sorted.at(-1);
    selectedBySupply.set(supplyId, previous || sorted[0]);
  });

  return selectedBySupply;
}

function backendReceptionRecipeUnitCost({
  detail,
  expenseRows,
  receptionRows,
  receptionDetailsByReception,
  supplyId,
  supplierRecipeUnitsPerProviderUnit,
  supplierItem
}) {
  for (const reception of receptionRows) {
    const expense = expenseRows.get(backendId(reception.id_egreso));
    const expenseSubtotal = backendNumber(expense?.subtotal);
    if (!expenseSubtotal) continue;

    const receivedQuantity = (receptionDetailsByReception.get(backendId(reception.id_recepcion)) || [])
      .filter((row) => backendId(row.id_insumo) === supplyId)
      .reduce((total, row) => total + backendNumber(row.cantidad_recibida), 0);
    const providerUnits = receivedQuantity || backendNumber(detail.cantidad);
    const recipeUnits = providerUnits * supplierRecipeUnitsPerProviderUnit;
    if (recipeUnits > 0) return expenseSubtotal / recipeUnits;
  }

  const supplierUnitQuantity = backendNumber(supplierItem.cantidad_proveedor) || 1;
  const supplierUnitPrice = backendNumber(supplierItem.precio);
  return supplierUnitPrice ? supplierUnitPrice / supplierUnitQuantity : 0;
}

function backendRowsById(rows = [], idColumn) {
  const map = new Map();
  (rows || []).forEach((row) => {
    const id = backendId(row[idColumn]);
    if (id && !map.has(id)) map.set(id, row);
  });
  return map;
}

function backendGroupRowsById(rows = [], idColumn) {
  const map = new Map();
  (rows || []).forEach((row) => {
    const id = backendId(row[idColumn]);
    if (!id) return;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  });
  return map;
}

function backendId(value) {
  if (value === null || value === undefined || value === "") return "";
  const number = Number(value);
  if (Number.isFinite(number) && String(value).trim() !== "") return String(Math.trunc(number));
  return String(value).trim();
}

function backendIsoDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const local = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (local) {
    const day = local[1].padStart(2, "0");
    const month = local[2].padStart(2, "0");
    const year = local[3].length === 2 ? `20${local[3]}` : local[3];
    return `${year}-${month}-${day}`;
  }
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  return "";
}

function backendNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = String(value ?? "").trim();
  if (!text) return 0;
  const compact = text
    .replace(/\$/g, "")
    .replace(/\s/g, "")
    .replace(/[^\d,.-]/g, "");
  const normalized = normalizeBackendNumberText(compact);
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function backendRecipeQuantity(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = String(value ?? "").trim();
  if (!text) return 0;
  const normalized = text.replace(/\s/g, "").replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function backendRate(value) {
  const number = backendNumber(value);
  return number > 1 ? number / 100 : number;
}

function backendIsGrossRevenueTaxInvoice(invoiceType) {
  const normalized = backendNormalizeText(invoiceType);
  return normalized === "factura a" || normalized === "factura b";
}

function normalizeBackendNumberText(text) {
  if (!text) return "";
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      return text.replace(/\./g, "").replace(",", ".");
    }
    return text.replace(/,/g, "");
  }

  if (lastComma >= 0) {
    const decimals = text.length - lastComma - 1;
    if (decimals > 0 && decimals <= 2) return text.replace(/\./g, "").replace(",", ".");
    return text.replace(/,/g, "");
  }

  if (lastDot >= 0) {
    const decimals = text.length - lastDot - 1;
    const dotCount = (text.match(/\./g) || []).length;
    if (dotCount > 1 || decimals === 3) return text.replace(/\./g, "");
  }

  return text;
}

function backendNormalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ");
}

function backendIsSchoolClient(client) {
  const type = backendNormalizeText(client?.tipo);
  const name = backendNormalizeText(client?.nombre_cliente);
  return type.includes("escuela") || name.includes("escuela");
}

function backendObjectSum(object) {
  return Object.values(object).reduce((total, value) => total + (Number(value) || 0), 0);
}

function backendMonthStartIso(year, month) {
  return `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

function backendMonthEndIso(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
}

function backendCurrentDateIso() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function backendOffsetIsoDate(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function backendComparisonPeriod(year, month, mode) {
  if (mode === "previousMonth") {
    return month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 };
  }
  if (mode === "previousYear") return { year: year - 1, month };
  return null;
}

function backendTurnRank(turn) {
  const text = backendNormalizeText(turn);
  if (text.includes("madrugada")) return 1;
  if (text.includes("manana") || text.includes("mañana")) return 2;
  if (text.includes("tarde")) return 3;
  return 0;
}

async function handleBackendSqlQuery(request, response) {
  const body = await readJsonBody(request);
  try {
    const result = await runBackendSqlQuery(body.sql || "");
    sendJson(response, 200, { ok: true, ...result });
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message });
  }
}

async function runBackendSqlQuery(rawSql) {
  const sql = String(rawSql || "").trim();
  if (!sql) throw new Error("Escribi una consulta SQL.");
  if (!/^(select|with)\s+/i.test(sql)) throw new Error("Por seguridad solo se permiten consultas SELECT o WITH.");
  if (/\b(insert|update|delete|drop|alter|create|truncate|replace|attach|detach|pragma|vacuum|reindex)\b/i.test(sql)) {
    throw new Error("La consola SQL es solo de lectura.");
  }

  return executeBackendSqliteQuery(sql);
}

function executeBackendSqliteQuery(sql) {
  if (!fs.existsSync(BACKEND_SQL_SCRIPT)) {
    throw new Error("Falta el ejecutor SQL del backend.");
  }

  const executable = fs.existsSync(PYTHON_EXECUTABLE) ? PYTHON_EXECUTABLE : "python";
  const payload = JSON.stringify({
    sql,
    cacheFile: BACKEND_CACHE_FILE,
    maxRows: 5000
  });
  const result = childProcess.spawnSync(executable, [BACKEND_SQL_SCRIPT], {
    cwd: ROOT_DIR,
    input: payload,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8"
    },
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20
  });

  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "No se pudo ejecutar la consulta SQL.").trim();
    throw new Error(message);
  }

  const output = JSON.parse(result.stdout || "{}");
  if (!output.ok) throw new Error(output.error || "No se pudo ejecutar la consulta SQL.");
  return output;
}

function runBackendSqlQueryLegacy(rawSql) {
  const sql = String(rawSql || "").trim();
  if (!sql) throw new Error("Escribi una consulta SQL.");
  if (!/^select\s+/i.test(sql)) throw new Error("Por seguridad solo se permiten consultas SELECT.");
  if (/[;]/.test(sql)) throw new Error("Ejecuta una sola consulta por vez, sin punto y coma.");
  if (/\b(insert|update|delete|drop|alter|create|truncate|replace)\b/i.test(sql)) {
    throw new Error("La consola SQL es solo de lectura.");
  }

  const match = sql.match(/^select\s+(.+?)\s+from\s+([a-zA-Z_][\w]*)(?:\s+where\s+(.+?)(?=\s+order\s+by|\s+limit|$))?(?:\s+order\s+by\s+([a-zA-Z_][\w]*)(?:\s+(asc|desc))?)?(?:\s+limit\s+(\d+))?\s*$/i);
  if (!match) {
    throw new Error("Formato no reconocido. Usa SELECT columnas FROM tabla WHERE ... ORDER BY ... LIMIT ...");
  }

  const [, selectClause, tableName, whereClause, orderColumn, orderDirection, limitText] = match;
  const cache = loadCache();
  const table = cache.tables?.[tableName];
  if (!table) throw new Error(`No existe la tabla "${tableName}".`);

  const headers = backendSqlHeaders(table);
  let rows = [...(table.rows || [])];
  rows = applyBackendSqlWhere(rows, whereClause, headers);

  if (orderColumn) {
    const column = resolveBackendSqlColumn(orderColumn, headers);
    if (!column) throw new Error(`No existe la columna "${orderColumn}" en ${tableName}.`);
    const direction = String(orderDirection || "asc").toLowerCase();
    rows.sort((a, b) => compareBackendSqlSortValues(a[column], b[column], direction));
  }

  const limit = Math.min(Math.max(Number(limitText) || 200, 1), 1000);
  const selection = parseBackendSqlSelection(selectClause, headers);
  if (selection.aggregate) {
    const aggregateRow = buildBackendSqlAggregateRow(rows, selection.items);
    return {
      table: tableName,
      columns: selection.items.map((item) => item.alias),
      rows: [aggregateRow],
      rowCount: 1,
      totalRows: rows.length,
      limited: false
    };
  }

  const columns = selection.all ? headers : selection.items.map((item) => item.column);
  const projectedRows = rows.slice(0, limit).map((row) => {
    const projected = {};
    columns.forEach((column) => {
      projected[column] = row[column] ?? "";
    });
    return projected;
  });

  return {
    table: tableName,
    columns,
    rows: projectedRows,
    rowCount: projectedRows.length,
    totalRows: rows.length,
    limited: rows.length > projectedRows.length
  };
}

function backendSqlHeaders(table) {
  const fromHeaders = Array.isArray(table.headers) ? table.headers.map(backendHeaderKey).filter(Boolean) : [];
  const fromRows = (table.rows || []).flatMap((row) => Object.keys(row || {}));
  return [...new Set([...fromHeaders, ...fromRows].filter((column) => column !== "_rowNumber"))];
}

function parseBackendSqlSelection(selectClause, headers) {
  const parts = splitBackendSqlCsv(selectClause).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error("Faltan columnas en el SELECT.");
  if (parts.length === 1 && parts[0] === "*") return { all: true, aggregate: false, items: [] };

  const items = parts.map((part) => {
    const aggregateMatch = part.match(/^(count|sum|avg|min|max)\s*\(\s*(\*|[a-zA-Z_][\w]*)\s*\)(?:\s+as\s+([a-zA-Z_][\w]*))?$/i);
    if (aggregateMatch) {
      const fn = aggregateMatch[1].toLowerCase();
      const column = aggregateMatch[2] === "*" ? "*" : resolveBackendSqlColumn(aggregateMatch[2], headers);
      if (!column) throw new Error(`No existe la columna "${aggregateMatch[2]}".`);
      if (fn !== "count" && column === "*") throw new Error(`${fn.toUpperCase()} necesita una columna.`);
      return {
        type: "aggregate",
        fn,
        column,
        alias: aggregateMatch[3] || `${fn}_${column === "*" ? "total" : column}`
      };
    }

    const columnMatch = part.match(/^([a-zA-Z_][\w]*)(?:\s+as\s+([a-zA-Z_][\w]*))?$/i);
    if (!columnMatch) throw new Error(`No pude interpretar "${part}" en el SELECT.`);
    const column = resolveBackendSqlColumn(columnMatch[1], headers);
    if (!column) throw new Error(`No existe la columna "${columnMatch[1]}".`);
    return { type: "column", column, alias: columnMatch[2] || column };
  });

  const hasAggregate = items.some((item) => item.type === "aggregate");
  if (hasAggregate && items.some((item) => item.type !== "aggregate")) {
    throw new Error("Por ahora no se mezclan columnas comunes con agregados.");
  }
  return { all: false, aggregate: hasAggregate, items };
}

function applyBackendSqlWhere(rows, whereClause, headers) {
  if (!whereClause) return rows;
  if (/\s+or\s+/i.test(whereClause)) throw new Error("Por ahora el WHERE soporta condiciones unidas con AND.");

  const conditions = whereClause.split(/\s+and\s+/i).map((condition) => condition.trim()).filter(Boolean).map((condition) => {
    const match = condition.match(/^([a-zA-Z_][\w]*)\s*(=|!=|<>|>=|<=|>|<|like)\s*(.+)$/i);
    if (!match) throw new Error(`No pude interpretar la condicion "${condition}".`);
    const column = resolveBackendSqlColumn(match[1], headers);
    if (!column) throw new Error(`No existe la columna "${match[1]}".`);
    return {
      column,
      operator: match[2].toLowerCase(),
      value: parseBackendSqlValue(match[3])
    };
  });

  return rows.filter((row) => conditions.every((condition) => {
    return compareBackendSqlWhereValues(row[condition.column], condition.value, condition.operator);
  }));
}

function buildBackendSqlAggregateRow(rows, items) {
  const output = {};
  items.forEach((item) => {
    const values = item.column === "*" ? rows : rows.map((row) => row[item.column]).filter((value) => value !== "" && value !== null && value !== undefined);
    if (item.fn === "count") {
      output[item.alias] = item.column === "*" ? rows.length : values.length;
      return;
    }
    const numericValues = values.map(sqlNumber).filter((value) => Number.isFinite(value));
    if (item.fn === "sum") output[item.alias] = numericValues.reduce((sum, value) => sum + value, 0);
    if (item.fn === "avg") output[item.alias] = numericValues.length ? numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length : 0;
    if (item.fn === "min") output[item.alias] = numericValues.length ? Math.min(...numericValues) : "";
    if (item.fn === "max") output[item.alias] = numericValues.length ? Math.max(...numericValues) : "";
  });
  return output;
}

function resolveBackendSqlColumn(column, headers) {
  const normalized = normalizeHeader(column);
  return headers.find((header) => normalizeHeader(header) === normalized) || "";
}

function parseBackendSqlValue(rawValue) {
  const trimmed = String(rawValue || "").trim();
  const quoted = trimmed.match(/^(['"])(.*)\1$/);
  if (quoted) return quoted[2].replace(/\\(["'])/g, "$1");
  const number = sqlNumber(trimmed);
  return Number.isFinite(number) && /^-?[\d.,]+$/.test(trimmed) ? number : trimmed;
}

function compareBackendSqlWhereValues(left, right, operator) {
  if (operator === "like") {
    const pattern = String(right).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*");
    return new RegExp(`^${pattern}$`, "i").test(String(left ?? ""));
  }

  const leftNumber = sqlNumber(left);
  const rightNumber = typeof right === "number" ? right : sqlNumber(right);
  const useNumbers = Number.isFinite(leftNumber) && Number.isFinite(rightNumber);
  const leftValue = useNumbers ? leftNumber : String(left ?? "").toLowerCase();
  const rightValue = useNumbers ? rightNumber : String(right ?? "").toLowerCase();

  if (operator === "=") return leftValue === rightValue;
  if (operator === "!=" || operator === "<>") return leftValue !== rightValue;
  if (operator === ">") return leftValue > rightValue;
  if (operator === "<") return leftValue < rightValue;
  if (operator === ">=") return leftValue >= rightValue;
  if (operator === "<=") return leftValue <= rightValue;
  return false;
}

function compareBackendSqlSortValues(left, right, direction) {
  const leftNumber = sqlNumber(left);
  const rightNumber = sqlNumber(right);
  const useNumbers = Number.isFinite(leftNumber) && Number.isFinite(rightNumber);
  const leftValue = useNumbers ? leftNumber : String(left ?? "").toLowerCase();
  const rightValue = useNumbers ? rightNumber : String(right ?? "").toLowerCase();
  if (leftValue === rightValue) return 0;
  const result = leftValue > rightValue ? 1 : -1;
  return direction === "desc" ? -result : result;
}

function sqlNumber(value) {
  if (typeof value === "number") return value;
  const clean = String(value ?? "").replace(/\$/g, "").replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function splitBackendSqlCsv(text) {
  const parts = [];
  let current = "";
  let quote = "";
  let depth = 0;
  for (const char of String(text || "")) {
    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(depth - 1, 0);
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

function backendColumnsMap() {
  const registry = loadRegistry();
  const cache = loadCache();
  const tables = registry.tables.filter((definition) => !definition.hidden).map((definition) => {
    const cached = cache.tables?.[definition.name] || {};
    const actualColumns = Array.isArray(cached.headers) ? cached.headers.map(backendHeaderKey) : [];
    const expectedColumns = EXPECTED_BACKEND_COLUMNS[definition.name] || [];
    const actualSet = new Set(actualColumns.map(normalizeHeader));
    const expectedSet = new Set(expectedColumns.map(normalizeHeader));
    const extraColumns = actualColumns.filter((column) => !expectedSet.has(normalizeHeader(column)));
    const missingColumns = expectedColumns.filter((column) => !actualSet.has(normalizeHeader(column)));

    return {
      name: definition.name,
      label: definition.label,
      module: definition.module,
      workbook: definition.workbook,
      sheet: definition.sheet,
      rowCount: cached.rowCount || 0,
      expectedColumns,
      actualColumns,
      matchedColumns: actualColumns.filter((column) => expectedSet.has(normalizeHeader(column))),
      extraColumns,
      missingColumns,
      issueCount: extraColumns.length + missingColumns.length
    };
  });
  const modules = [...new Set(tables.map((table) => table.module))].sort();

  return {
    generatedAt: cache.generatedAt || "",
    tableCount: tables.length,
    issueCount: tables.reduce((total, table) => total + table.issueCount, 0),
    modules,
    tables
  };
}

function backendHeaderKey(header) {
  if (header && typeof header === "object" && "key" in header) return String(header.key || "");
  return String(header || "");
}

async function handleBackendSourcesSave(request, response) {
  const body = await readJsonBody(request);
  const sources = saveBackendSources(body.sources || {});
  sendJson(response, 200, { ok: true, sources });
}

async function handleBackendRefresh(request, response) {
  const body = await readJsonBody(request);
  const registry = loadRegistry();
  const previousCache = loadCache();
  const sources = Object.fromEntries(backendSources().map((source) => [source.workbook, source.url]));
  const requestedWorkbooks = new Set(
    (Array.isArray(body.workbooks) ? body.workbooks : [])
      .map((workbook) => String(workbook || "").trim())
      .filter(Boolean)
  );
  const refreshAll = requestedWorkbooks.size === 0;
  const accessToken = await googleAccessToken();
  const spreadsheetIds = new Map();
  const cache = {
    version: registry.version,
    generatedAt: new Date().toISOString(),
    workbookDir: "Google Sheets",
    tables: {},
    errors: []
  };

  for (const definition of registry.tables) {
    const previousTable = previousCache.tables?.[definition.name];
    if (definition.synthetic) {
      preserveBackendTable(cache, definition, previousTable);
      continue;
    }

    if (!refreshAll && !requestedWorkbooks.has(definition.workbook)) {
      preserveBackendTable(cache, definition, previousTable);
      continue;
    }

    const workbookUrl = sources[definition.workbook];

    if (!workbookUrl) {
      preserveBackendTable(cache, definition, previousTable);
      cache.errors.push({
        table: definition.name,
        workbook: definition.workbook,
        sheet: definition.sheet,
        error: "Falta URL configurada. Se conservaron los datos anteriores."
      });
      continue;
    }

    try {
      if (!spreadsheetIds.has(definition.workbook)) {
        const reference = googleSheetReference(workbookUrl);
        if (!reference?.spreadsheetId) throw new Error("URL de Google Sheets invalida.");
        spreadsheetIds.set(definition.workbook, reference.spreadsheetId);
      }

      const spreadsheetId = spreadsheetIds.get(definition.workbook);
      const payload = await sheetsGetValues(spreadsheetId, accessToken, quoteSheetName(definition.sheet));
      const values = payload.values || [];
      const cellErrors = findSpreadsheetCellErrors(values, definition.name);

      if (cellErrors.length) {
        preserveBackendTable(cache, definition, previousTable);
        cache.errors.push(...cellErrors.map((error) => ({
          table: definition.name,
          workbook: definition.workbook,
          sheet: definition.sheet,
          error: `Error de celda (${error.raw}) en fila ${error.row}. Se conservaron los datos anteriores.`,
          raw: error.raw
        })));
        continue;
      }

      cache.tables[definition.name] = buildBackendCachedTable(definition, values, workbookUrl);
    } catch (error) {
      preserveBackendTable(cache, definition, previousTable);
      cache.errors.push({
        table: definition.name,
        workbook: definition.workbook,
        sheet: definition.sheet,
        error: `${error.message}. Se conservaron los datos anteriores.`
      });
    }
  }

  finalizeBackendCache(cache);
  saveBackendCache(cache);
  sendJson(response, 200, {
    ok: true,
    generatedAt: cache.generatedAt,
    tableCount: Object.keys(cache.tables).length,
    refreshedWorkbooks: refreshAll ? [...new Set(registry.tables.map((table) => table.workbook))] : [...requestedWorkbooks],
    errors: cache.errors
  });
}

function preserveBackendTable(cache, definition, previousTable) {
  const expectedColumns = EXPECTED_BACKEND_COLUMNS[definition.name] || [];
  cache.tables[definition.name] = previousTable || {
    definition,
    headers: expectedColumns,
    rows: [],
    rowCount: 0,
    source: {
      workbook: definition.workbook || "",
      sheet: definition.sheet || "",
      synthetic: Boolean(definition.synthetic),
      preserved: false
    }
  };
}

function buildBackendCachedTable(definition, values, workbookUrl) {
  const headerIndex = detectBackendHeaderRow(values);
  const rawHeaders = values[headerIndex] || [];
  const headers = dedupeBackendHeaders(rawHeaders.map(normalizeBackendHeader));
  const rows = [];

  values.slice(headerIndex + 1).forEach((row, index) => {
    if (!row.some((value) => String(value ?? "").trim())) return;
    const record = { _rowNumber: headerIndex + index + 2 };
    headers.forEach((header, columnIndex) => {
      record[header] = cleanBackendCell(row[columnIndex]);
    });
    rows.push(record);
  });

  const projected = projectBackendTable(definition.name, headers, rows);

  return {
    definition,
    headers: projected.headers,
    rows: projected.rows,
    rowCount: projected.rows.length,
    _sourceRows: rows,
    source: {
      workbook: definition.workbook,
      sheet: definition.sheet,
      googleSheetUrl: workbookUrl,
      headerRow: headerIndex + 1
    }
  };
}

function projectBackendTable(tableName, headers, rows) {
  const projection = BACKEND_TABLE_PROJECTIONS[tableName];
  if (!projection) return { headers, rows };

  return {
    headers: projection.columns,
    rows: rows.map((row) => {
      const projected = { _rowNumber: row._rowNumber };
      projection.columns.forEach((column) => {
        projected[column] = valueFromBackendAliases(row, projection.aliases[column] || [column]);
      });
      return finalizeProjectedBackendRecord(tableName, projected, row);
    })
  };
}

function finalizeProjectedBackendRecord(tableName, projected, sourceRow) {
  if (tableName === "acreedores") {
    projected._nombre_acreedor = sourceRow.nombre || "";
    projected._etiqueta_gasto = sourceRow.etiqueta || sourceRow.categoria_gasto || sourceRow.tipo_gasto || "";
    return projected;
  }

  if (tableName === "recepciones") {
    projected._id_acreedor = sourceRow.id_acreedor || "";
    projected._etiqueta_gasto = sourceRow.tipo || "";
    projected._fecha_factura = sourceRow.fecha_factura || "";
    projected._tipo_factura = sourceRow.tipo_de_factura || sourceRow.tipo_factura || "";
    projected._nro_factura = sourceRow.nro_factura || "";
    projected._total = sourceRow.total || "";
    return projected;
  }

  if (tableName === "otros_gastos") {
    projected._id_acreedor = sourceRow.id_acreedor || "";
    projected._etiqueta_gasto = sourceRow.tipo || "";
    projected._fecha_factura = sourceRow.fecha_factura || "";
    projected._tipo_factura = sourceRow.tipo_de_factura || sourceRow.tipo_factura || "";
    projected._nro_factura = sourceRow.nro_factura || "";
    projected._total = sourceRow.total || "";
    return projected;
  }

  if (tableName === "entregas") {
    projected._id_acreedor = sourceRow.id_acreedor || "";
    projected._etiqueta_gasto = sourceRow.tipo || "Logistica";
    projected._fecha_factura = sourceRow.fecha_factura || "";
    projected._tipo_factura = sourceRow.tipo_de_factura || sourceRow.tipo_factura || "";
    projected._nro_factura = sourceRow.nro_factura || "";
    projected._total = sourceRow.total || "";
    return projected;
  }

  if (tableName === "egresos") {
    projected._id_acreedor = sourceRow.id_acreedor || "";
    projected._nombre_acreedor = sourceRow.nombre_acreedor || "";
    projected._etiqueta_gasto = sourceRow.tipo || "";
    return projected;
  }

  if (tableName === "detalle_pagos") {
    projected._nombre_acreedor = sourceRow.acreedor || sourceRow.nombre_acreedor || "";
    projected._fecha_factura = sourceRow.fecha || sourceRow.fecha_factura || "";
    projected._nro_factura = sourceRow.nro_factura || "";
    return projected;
  }

  if (tableName === "items") {
    projected._traduccion_ud_receta = sourceRow.traduccion_ud_receta || "";
    return projected;
  }

  if (tableName === "recetas") {
    projected._id_producto_resultado = sourceRow.id_producto || "";
    projected._tipo_componente = sourceRow.tipo || "";
    return projected;
  }

  if (tableName === "insumos") {
    projected._id_item = sourceRow.id_item || "";
    return projected;
  }

  if (tableName === "canales") {
    projected.comision = projected.comision || defaultChannelCommission(projected.id_canal);
    return projected;
  }

  if (tableName !== "sueldos" && tableName !== "sueldos_calculo") return projected;

  projected.fecha = payrollMonthToDate(projected.fecha);
  projected.premios = sumBackendNumbers(sourceRow.presentismo, sourceRow.premio_pochocleras, projected.premios);
  projected.id_sueldo = projected.id_sueldo || sourceRow._rowNumber || "";
  splitPayrollHolidayHours(projected);
  projected._empleado_nombre = sourceRow.empleado || sourceRow.nombre || "";
  projected._etiqueta_gasto = sourceRow.tipo || "Sueldos";
  projected._tipo_factura = sourceRow.tipo_de_factura || sourceRow.tipo_factura || "Recibo_Sueldo";
  projected._nro_factura = sourceRow.nro_factura || "";
  projected._neto = sourceRow.neto || projected.sueldo_neto || "";
  return projected;
}

function finalizeBackendCache(cache) {
  expandLegacyInventoryTurnTables(cache);
  mergePayrollCalculationRowsIntoSalaries(cache);

  normalizeOtherCreditors(cache);
  resolveCreditorOriginIds(cache);
  resolveBackendPayrollEmployees(cache);
  linkSourceRowsToExpenses(cache);
  linkPayrollRowsToExpenses(cache);
  ensureHistoricalExpenseCreditors(cache);
  seedDefaultBankDetails(cache);
  normalizeBackendTags(cache);
  assignPayrollCreditorTags(cache);
  ensureUniqueBackendSalaryIds(cache);
  sortBackendSalaryRows(cache);
  normalizeBackendBankDetails(cache);
  resolvePaymentExpenseIds(cache);

  const deliveryByOrder = new Map();
  (cache.tables?.entregas_detalle?.rows || []).forEach((detail) => {
    const orderId = String(detail.id_pedido || "").trim();
    if (orderId && !deliveryByOrder.has(orderId)) deliveryByOrder.set(orderId, detail.id_entrega || "");
  });
  const itemMetaById = new Map();
  (cache.tables?.items?.rows || []).forEach((item) => {
    if (item.id_item) itemMetaById.set(String(item.id_item), { ...item });
  });
  const itemOriginById = new Map();
  const resultItemByProductId = new Map();
  const subproductItemIds = new Set();
  (cache.tables?.productos?.rows || []).forEach((product) => {
    const itemId = String(product.id_item || "").trim();
    if (product.id_producto) resultItemByProductId.set(String(product.id_producto), product.id_item || "");
    if (itemId) itemOriginById.set(itemId, { origen_tipo: "producto", id_origen: product.id_producto || "" });
  });
  (cache.tables?.recetas?.rows || []).forEach((recipe) => {
    if (normalizeOriginType(recipe._tipo_componente) === "subproducto" && recipe.id_item_componente) {
      subproductItemIds.add(String(recipe.id_item_componente));
    }
  });
  (cache.tables?.insumos?.rows || []).forEach((supply) => {
    const itemId = String(supply._id_item || "").trim();
    if (itemId) itemOriginById.set(itemId, { origen_tipo: "insumo", id_origen: supply.id_insumo || "" });
  });

  buildBackendSubproductsTable(cache, subproductItemIds, itemMetaById);

  (cache.tables?.ventas?.rows || []).forEach((sale) => {
    if (!sale.id_entrega) sale.id_entrega = deliveryByOrder.get(String(sale.id_pedido || "").trim()) || "";
  });

  (cache.tables?.items?.rows || []).forEach((item) => {
    const itemId = String(item.id_item || "").trim();
    const origin = itemOriginById.get(itemId);
    if (subproductItemIds.has(itemId)) {
      item.origen_tipo = "subproducto";
      item.id_origen = item.id_item;
    } else if (origin) {
      item.origen_tipo = normalizeOriginType(origin.origen_tipo);
      item.id_origen = origin.id_origen;
    } else {
      item.origen_tipo = normalizeOriginType(item.origen_tipo);
    }
  });

  (cache.tables?.insumos?.rows || []).forEach((supply) => {
    const meta = itemMetaById.get(String(supply._id_item || "").trim());
    if (meta?._traduccion_ud_receta !== undefined && meta._traduccion_ud_receta !== "") {
      supply.cantidad_receta = meta._traduccion_ud_receta;
    }
    delete supply._id_item;
  });

  dedupeBackendRows(cache, "insumos", "id_insumo");
  (cache.tables?.recetas?.rows || []).forEach((recipe) => {
    if (!recipe.id_item_resultado) {
      recipe.id_item_resultado = resultItemByProductId.get(String(recipe._id_producto_resultado || "").trim()) || "";
    }
    delete recipe._id_producto_resultado;
    delete recipe._tipo_componente;
  });
  if (cache.tables?.productos?.rows) {
    cache.tables.productos.rows = cache.tables.productos.rows.filter((product) => {
      return !subproductItemIds.has(String(product.id_item || "").trim());
    });
    cache.tables.productos.rowCount = cache.tables.productos.rows.length;
  }

  fillEmptyPrimaryIds(cache);
  valueBackendInventories(cache);
  cleanupBackendAuxiliaryFields(cache);

  Object.values(cache.tables || {}).forEach((table) => {
    delete table._sourceRows;
  });
}

function buildBackendSubproductsTable(cache, subproductItemIds, itemMetaById) {
  if (!cache.tables) cache.tables = {};

  const rows = [];
  const seen = new Set();
  const pushSubproduct = (row) => {
    const subproductId = String(row.id_subproducto || row.id_item || "").trim();
    if (!subproductId || seen.has(subproductId)) return;
    seen.add(subproductId);
    rows.push({
      id_subproducto: subproductId,
      id_item: row.id_item || subproductId,
      nombre_subproducto: row.nombre_subproducto || `Subproducto_${subproductId}`,
      ud_conteo: row.ud_conteo || ""
    });
  };

  (cache.tables.productos?.rows || []).forEach((product) => {
    const itemId = String(product.id_item || "").trim();
    if (!subproductItemIds.has(itemId)) return;
    const meta = itemMetaById.get(itemId) || {};
    pushSubproduct({
      id_subproducto: itemId,
      id_item: itemId,
      nombre_subproducto: product.nombre_producto || product.nombre || "",
      ud_conteo: meta.ud_conteo || product.ud_conteo || ""
    });
  });

  subproductItemIds.forEach((itemId) => {
    const meta = itemMetaById.get(String(itemId)) || {};
    pushSubproduct({
      id_subproducto: itemId,
      id_item: itemId,
      nombre_subproducto: meta.nombre_subproducto || "",
      ud_conteo: meta.ud_conteo || ""
    });
  });

  cache.tables.subproductos = {
    definition: {
      name: "subproductos",
      label: "Subproductos",
      module: "inventario",
      workbook: "Informacion.xlsx",
      sheet: "Subproductos",
      primaryKey: "id_subproducto",
      synthetic: true
    },
    headers: EXPECTED_BACKEND_COLUMNS.subproductos,
    rows,
    rowCount: rows.length,
    source: { syntheticFrom: ["productos", "items", "recetas"] }
  };
}

function mergePayrollCalculationRowsIntoSalaries(cache) {
  const tables = cache.tables || {};
  const calculationTable = tables.sueldos_calculo;

  if (!calculationTable) return;
  ensureBackendTable(tables, "sueldos");

  const legacySalaryRows = tables.sueldos.rows || [];
  const calculationRows = (calculationTable.rows || []).map(normalizePayrollCalculationRow);
  const calculationKeys = new Set(calculationRows.map(payrollMonthEmployeeKey).filter(Boolean));

  calculationRows.forEach((calculationRow) => {
    const matchingLegacySalary = legacySalaryRows.find((salaryRow) => payrollRowsReferToSameSalary(salaryRow, calculationRow));
    if (matchingLegacySalary) fillBlankPayrollFields(calculationRow, matchingLegacySalary);
  });

  const unmatchedLegacyRows = legacySalaryRows
    .filter((salaryRow) => !calculationKeys.has(payrollMonthEmployeeKey(salaryRow)))
    .map(normalizePayrollCalculationRow);
  const mergedSalaryRows = [...calculationRows, ...unmatchedLegacyRows];

  tables.sueldos.headers = EXPECTED_BACKEND_COLUMNS.sueldos;
  tables.sueldos.rows = mergedSalaryRows;
  tables.sueldos.rowCount = mergedSalaryRows.length;
  tables.sueldos.source = {
    ...(tables.sueldos.source || {}),
    mergedFrom: ["Sueldos.xlsx · Calculo"]
  };

  // Calculo se usa como insumo interno para completar Sueldos. Borrarlo de la cache evita
  // que aparezca como una segunda tabla en el mapa, editor o consola SQL.
  delete tables.sueldos_calculo;
}

function normalizePayrollCalculationRow(row) {
  const normalized = {};
  EXPECTED_BACKEND_COLUMNS.sueldos.forEach((column) => {
    normalized[column] = row[column] ?? "";
  });
  normalized._rowNumber = row._rowNumber;
  normalized._empleado_nombre = row._empleado_nombre || "";
  normalized._etiqueta_gasto = row._etiqueta_gasto || "Sueldos";
  normalized._tipo_factura = row._tipo_factura || "Recibo_Sueldo";
  normalized._nro_factura = row._nro_factura || "";
  normalized._neto = row._neto || row.sueldo_neto || "";
  return normalized;
}

function payrollRowsReferToSameSalary(left, right) {
  const leftMonthEmployee = payrollMonthEmployeeKey(left);
  const rightMonthEmployee = payrollMonthEmployeeKey(right);
  if (!leftMonthEmployee || leftMonthEmployee !== rightMonthEmployee) return false;
  const leftEmployee = backendId(left?.id_empleado);
  const rightEmployee = backendId(right?.id_empleado);
  return Boolean(leftEmployee && rightEmployee);
}

function payrollMonthEmployeeKey(row) {
  const date = backendIsoDate(row?.fecha);
  const employeeId = backendId(row?.id_empleado);
  if (!date || !employeeId) return "";
  return `${date.slice(0, 7)}|${employeeId}`;
}

function fillBlankPayrollFields(target, source) {
  EXPECTED_BACKEND_COLUMNS.sueldos.forEach((column) => {
    if (target[column] === "" || target[column] === null || target[column] === undefined) {
      target[column] = source[column] ?? "";
    }
  });
  ["_empleado_nombre", "_etiqueta_gasto", "_tipo_factura", "_nro_factura", "_neto"].forEach((column) => {
    if (!target[column] && source[column]) target[column] = source[column];
  });
}

function assignPayrollCreditorTags(cache) {
  const tables = cache.tables || {};
  const salaries = tables.sueldos?.rows || [];
  if (!salaries.length) return;

  const creditorIdByEmployeeId = new Map();
  (tables.acreedores?.rows || []).forEach((creditor) => {
    if (creditorOriginTypeKey(creditor.origen_tipo_acreedor) !== "empleado") return;
    const employeeId = backendId(creditor.origen_id_acreedor);
    const creditorId = backendId(creditor.id_acreedor);
    if (employeeId && creditorId && !creditorIdByEmployeeId.has(employeeId)) {
      creditorIdByEmployeeId.set(employeeId, creditorId);
    }
  });

  const firstCreditorTagByCreditorId = new Map();
  (tables.acreedores_etiquetas?.rows || []).forEach((relation) => {
    const creditorId = backendId(relation.id_acreedor);
    const creditorTagId = backendId(relation.id_acreedor_etiqueta);
    if (creditorId && creditorTagId && !firstCreditorTagByCreditorId.has(creditorId)) {
      firstCreditorTagByCreditorId.set(creditorId, creditorTagId);
    }
  });

  salaries.forEach((salary) => {
    if (backendId(salary.id_acreedor_etiqueta)) return;
    const employeeId = backendId(salary.id_empleado);
    const creditorId = creditorIdByEmployeeId.get(employeeId);
    const creditorTagId = firstCreditorTagByCreditorId.get(creditorId);
    if (creditorTagId) salary.id_acreedor_etiqueta = creditorTagId;
  });
}

function sortBackendSalaryRows(cache) {
  const salaries = cache.tables?.sueldos?.rows;
  if (!Array.isArray(salaries)) return;

  salaries.sort((left, right) => {
    const leftId = Number(backendId(left.id_sueldo));
    const rightId = Number(backendId(right.id_sueldo));
    if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) return leftId - rightId;
    if (Number.isFinite(leftId) && !Number.isFinite(rightId)) return -1;
    if (!Number.isFinite(leftId) && Number.isFinite(rightId)) return 1;
    return backendIsoDate(left.fecha).localeCompare(backendIsoDate(right.fecha))
      || backendId(left.id_empleado).localeCompare(backendId(right.id_empleado));
  });
}

function ensureUniqueBackendSalaryIds(cache) {
  const salaries = cache.tables?.sueldos?.rows;
  if (!Array.isArray(salaries)) return;

  const usedIds = new Set();
  let nextId = backendNextNumericId(salaries, "id_sueldo");
  salaries.forEach((salary) => {
    const id = backendId(salary.id_sueldo);
    if (id && !usedIds.has(id)) {
      usedIds.add(id);
      return;
    }

    while (usedIds.has(String(nextId))) nextId += 1;
    salary.id_sueldo = nextId;
    usedIds.add(String(nextId));
    nextId += 1;
  });
}

function valueBackendInventories(cache) {
  const inventoryTable = cache.tables?.inventarios;
  const detailTable = cache.tables?.detalle_inventarios;
  if (!inventoryTable || !detailTable) return;

  (inventoryTable.rows || []).forEach((inventory) => {
    inventory.valor_total = 0;
  });

  const inventoriesById = backendRowsById(inventoryTable.rows, "id_inventario");
  const detailsByInventory = backendGroupRowsById(detailTable.rows, "id_inventario");
  const itemCostsByDate = new Map();

  (inventoryTable.rows || [])
    .slice()
    .sort((left, right) => {
      const leftDate = backendIsoDate(left.fecha);
      const rightDate = backendIsoDate(right.fecha);
      if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
      return backendTurnRank(left.turno) - backendTurnRank(right.turno);
    })
    .forEach((inventory) => {
      const inventoryId = backendId(inventory.id_inventario);
      const inventoryDate = backendIsoDate(inventory.fecha);
      if (!itemCostsByDate.has(inventoryDate)) {
        itemCostsByDate.set(inventoryDate, backendInventoryItemCostMap(cache, inventoryDate));
      }
      const itemCosts = itemCostsByDate.get(inventoryDate);
      let inventoryValue = 0;

      (detailsByInventory.get(inventoryId) || []).forEach((detail) => {
        detail.costo_unitario_usado = 0;
        detail.valor_total = 0;

        const unitCost = itemCosts.get(backendId(detail.id_item));
        if (!unitCost) return;

        const quantity = backendInventoryQuantity(detail.cantidad);
        const lineValue = quantity * unitCost;
        detail.costo_unitario_usado = roundBackendMoney(unitCost);
        detail.valor_total = roundBackendMoney(lineValue);
        inventoryValue += lineValue;
      });

      const storedInventory = inventoriesById.get(inventoryId) || inventory;
      storedInventory.valor_total = roundBackendMoney(inventoryValue);
    });

  inventoryTable.headers = EXPECTED_BACKEND_COLUMNS.inventarios;
  detailTable.headers = EXPECTED_BACKEND_COLUMNS.detalle_inventarios;
}

function backendInventoryItemCostMap(cache, dateIso) {
  const tables = cache.tables || {};
  const itemsById = backendRowsById(detailSafeRows(tables.items), "id_item");
  const suppliesById = backendRowsById(detailSafeRows(tables.insumos), "id_insumo");
  const recipesByResult = backendGroupRowsById(detailSafeRows(tables.recetas), "id_item_resultado");
  const supplyCosts = backendLatestSupplyCostMap(tables, dateIso);
  const recipeUnitMemo = new Map();
  const countUnitCosts = new Map();
  const visiting = new Set();

  const countToRecipe = (item) => {
    const itemTranslation = backendNumber(item?._traduccion_ud_receta);
    if (itemTranslation > 0) return itemTranslation;

    if (backendNormalizeText(item?.origen_tipo) === "insumo") {
      const supply = suppliesById.get(backendId(item?.id_origen));
      const supplyTranslation = backendNumber(supply?.cantidad_receta);
      if (supplyTranslation > 0) return supplyTranslation;
    }

    return 1;
  };

  const costPerRecipeUnit = (itemId) => {
    const normalizedItemId = backendId(itemId);
    if (!normalizedItemId) return 0;
    if (recipeUnitMemo.has(normalizedItemId)) return recipeUnitMemo.get(normalizedItemId);
    if (visiting.has(normalizedItemId)) return 0;

    visiting.add(normalizedItemId);
    const item = itemsById.get(normalizedItemId);
    let cost = 0;

    if (backendNormalizeText(item?.origen_tipo) === "insumo") {
      const supplyId = backendId(item?.id_origen);
      const supplyCost = supplyCosts.get(supplyId);
      if (supplyCost?.unitCost) cost = supplyCost.unitCost;
    } else {
      cost = (recipesByResult.get(normalizedItemId) || []).reduce((total, recipe) => {
        const componentQuantity = backendRecipeQuantity(recipe.cantidad_componente);
        const componentCost = costPerRecipeUnit(recipe.id_item_componente);
        return total + componentQuantity * componentCost;
      }, 0);
    }

    visiting.delete(normalizedItemId);
    recipeUnitMemo.set(normalizedItemId, cost);
    return cost;
  };

  itemsById.forEach((item, itemId) => {
    const cost = costPerRecipeUnit(itemId) * countToRecipe(item);
    if (cost > 0) countUnitCosts.set(itemId, cost);
  });

  return countUnitCosts;
}

function detailSafeRows(table) {
  return Array.isArray(table?.rows) ? table.rows : [];
}

// Las cantidades ya normalizadas usan punto decimal; no deben pasar por el parser monetario local.
function backendInventoryQuantity(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const normalized = String(value ?? "").trim().replace(/\s/g, "").replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function roundBackendMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100) / 100;
}

function normalizeOtherCreditors(cache) {
  ensureBackendTable(cache.tables, "otros_acreedores");
  const otherCreditors = [];
  const otherCreditorsByName = new Map();

  (cache.tables?.acreedores?.rows || []).forEach((creditor) => {
    const originType = creditorOriginTypeKey(creditor.origen_tipo_acreedor);
    if (originType !== "otros_acreedores") return;

    const creditorName = cleanBackendText(
      creditor._nombre_acreedor || creditor.acuerdo_de_pago || `Otro acreedor ${creditor.id_acreedor}`
    );
    const lookupKey = normalizeLookupText(creditorName);
    if (!lookupKey) return;

    let otherCreditor = otherCreditorsByName.get(lookupKey);
    if (!otherCreditor) {
      otherCreditor = {
        id_otro_acreedor: otherCreditors.length + 1,
        nombre_otro_acreedor: creditorName
      };
      otherCreditors.push(otherCreditor);
      otherCreditorsByName.set(lookupKey, otherCreditor);
    }

    creditor.origen_tipo_acreedor = "Otros Acreedores";
    creditor.origen_id_acreedor = otherCreditor.id_otro_acreedor;
  });

  cache.tables.otros_acreedores.headers = EXPECTED_BACKEND_COLUMNS.otros_acreedores;
  cache.tables.otros_acreedores.rows = otherCreditors;
  cache.tables.otros_acreedores.rowCount = otherCreditors.length;
  cache.tables.otros_acreedores.source = { syntheticFrom: ["acreedores"] };
}

function resolveCreditorOriginIds(cache) {
  const originMaps = {
    proveedor: backendRowsByName(cache.tables?.proveedores?.rows, "nombre", "id_proveedor"),
    empleado: backendRowsByName(cache.tables?.empleados?.rows, "nombre_empleado", "id_empleado"),
    canal: backendRowsByName(cache.tables?.canales?.rows, "nombre", "id_canal"),
    flete: backendRowsByName(cache.tables?.fletes?.rows, "nombre_flete", "id_flete"),
    otros_acreedores: backendRowsByName(cache.tables?.otros_acreedores?.rows, "nombre_otro_acreedor", "id_otro_acreedor")
  };

  (cache.tables?.acreedores?.rows || []).forEach((creditor) => {
    const originType = creditorOriginTypeKey(creditor.origen_tipo_acreedor);
    const creditorName = normalizeLookupText(creditor._nombre_acreedor);
    const originId = originMaps[originType]?.get(creditorName);
    if (originId) creditor.origen_id_acreedor = originId;
    delete creditor._nombre_acreedor;
  });
}

function resolveBackendPayrollEmployees(cache) {
  const employeeByName = new Map();
  (cache.tables?.empleados?.rows || []).forEach((employee) => {
    const key = normalizeLookupText(employee.nombre_empleado || employee.nombre);
    if (key && employee.id_empleado !== "") employeeByName.set(key, employee.id_empleado);
  });

  (cache.tables?.sueldos?.rows || []).forEach((salary) => {
    if (!salary.id_empleado) {
      salary.id_empleado = employeeByName.get(normalizeLookupText(salary._empleado_nombre)) || "";
    }
    delete salary._empleado_nombre;
  });
}

function linkSourceRowsToExpenses(cache) {
  const tables = cache.tables || {};
  const expenseRows = tables.egresos?.rows || [];
  const expenseByLegacyOrigin = new Map();
  const expenseByOperationalKey = new Map();

  expenseRows.forEach((expense) => {
    const expenseId = backendId(expense.id_egreso);
    const legacyType = backendExpenseSourceTypeKey(expense.origen_tipo);
    const legacyId = backendId(expense.origen_id);
    if (expenseId && legacyType && legacyId) {
      expenseByLegacyOrigin.set(`${legacyType}:${legacyId}`, expenseId);
    }

    const matchKey = expenseOperationalMatchKey(expense);
    if (expenseId && matchKey && !expenseByOperationalKey.has(matchKey)) {
      expenseByOperationalKey.set(matchKey, expenseId);
    }

    delete expense.origen_tipo;
    delete expense.origen_id;
  });

  backendExpenseSourceConfigs().forEach((config) => {
    (tables[config.table]?.rows || []).forEach((row) => {
      if (backendId(row.id_egreso)) return;
      const sourceId = backendId(row[config.idColumn]);
      const legacyMatch = expenseByLegacyOrigin.get(`${backendExpenseSourceTypeKey(config.type)}:${sourceId}`);
      if (legacyMatch) {
        row.id_egreso = legacyMatch;
        return;
      }

      const operationalMatch = expenseByOperationalKey.get(expenseOperationalMatchKey(row));
      if (operationalMatch) row.id_egreso = operationalMatch;
    });
  });

  if (tables.egresos) {
    tables.egresos.headers = EXPECTED_BACKEND_COLUMNS.egresos;
    tables.egresos.rowCount = expenseRows.length;
  }
}

// Relaciona sueldos historicos con el egreso que ya fue creado para ese pago.
// Se exige empleado, mes y monto para evitar asignaciones por aproximacion.
function linkPayrollRowsToExpenses(cache) {
  const tables = cache.tables || {};
  const salaries = tables.sueldos?.rows || [];
  const expenses = tables.egresos?.rows || [];
  if (!salaries.length || !expenses.length) return;

  const creditorByEmployee = new Map();
  (tables.acreedores?.rows || []).forEach((creditor) => {
    if (creditorOriginTypeKey(creditor.origen_tipo_acreedor) !== "empleado") return;
    const employeeId = backendId(creditor.origen_id_acreedor);
    const creditorId = backendId(creditor.id_acreedor);
    if (employeeId && creditorId && !creditorByEmployee.has(employeeId)) {
      creditorByEmployee.set(employeeId, creditorId);
    }
  });

  const candidates = expenses.filter((expense) => {
    const label = normalizeLookupText(expense._etiqueta_gasto || "");
    const invoiceType = normalizeLookupText(expense.tipo_factura || "");
    return label.includes("sueldo")
      || invoiceType.includes("sueldo")
      || invoiceType.includes("recibo");
  });

  salaries.forEach((salary) => {
    if (backendId(salary.id_egreso)) return;

    const employeeCreditorId = creditorByEmployee.get(backendId(salary.id_empleado));
    const salaryMonth = backendIsoDate(salary.fecha).slice(0, 7);
    const salaryAmounts = [salary.sueldo_neto, salary.sueldo_bruto]
      .map(backendNumber)
      .filter((amount) => amount !== 0);
    if (!employeeCreditorId || !salaryMonth || !salaryAmounts.length) return;

    let matches = candidates.filter((expense) => {
      const expenseMonth = backendIsoDate(expense.fecha_factura).slice(0, 7);
      const expenseCreditorId = backendId(expense._id_acreedor);
      const expenseAmount = backendNumber(expense.subtotal || expense.total);
      return expenseMonth === salaryMonth
        && expenseCreditorId === employeeCreditorId
        && salaryAmounts.some((amount) => Math.abs(expenseAmount - amount) < 0.01);
    });

    // Los imports antiguos pueden conservar un Asiento y un Remito duplicados.
    // Si existe una alternativa no contable, usarla como vínculo operativo.
    const nonAccountingMatches = matches.filter((expense) => {
      return normalizeLookupText(expense.tipo_factura) !== "asiento";
    });
    if (nonAccountingMatches.length) matches = nonAccountingMatches;
    if (matches.length === 1) salary.id_egreso = matches[0].id_egreso;
  });
}

function expenseOperationalMatchKey(row) {
  const values = [
    cleanBackendText(row._id_acreedor),
    normalizeBackendDateKey(row._fecha_factura || row.fecha_factura),
    normalizeLookupText(row._tipo_factura || row.tipo_factura),
    normalizeInvoiceNumber(row._nro_factura || row.nro_factura),
    normalizeBackendAmountKey(row._total || row.total)
  ];
  if (values.some((value) => !value)) return "";
  return values.join("|");
}

function resolvePaymentExpenseIds(cache) {
  const expenseByPaymentKey = new Map();
  (cache.tables?.egresos?.rows || []).forEach((expense) => {
    const key = paymentExpenseKey(expense._nombre_acreedor, expense.fecha_factura, expense.nro_factura);
    if (key && !expenseByPaymentKey.has(key)) expenseByPaymentKey.set(key, expense.id_egreso);
  });

  (cache.tables?.detalle_pagos?.rows || []).forEach((detail) => {
    if (cleanBackendText(detail.id_egreso)) return;
    const key = paymentExpenseKey(detail._nombre_acreedor, detail._fecha_factura, detail._nro_factura);
    const expenseId = expenseByPaymentKey.get(key);
    if (expenseId) detail.id_egreso = expenseId;
  });
}

function paymentExpenseKey(creditorName, invoiceDate, invoiceNumber) {
  const values = [
    normalizeLookupText(creditorName),
    normalizeBackendDateKey(invoiceDate),
    normalizeInvoiceNumber(invoiceNumber)
  ];
  if (values.some((value) => !value)) return "";
  return values.join("|");
}

function ensureHistoricalExpenseCreditors(cache) {
  const tables = cache.tables || {};
  ensureBackendTable(tables, "acreedores");
  const creditors = tables.acreedores.rows || [];
  const creditorsByName = new Map();

  creditors.forEach((creditor) => {
    const displayName = backendCreditorDisplayName(creditor, tables) || creditor.acuerdo_de_pago;
    const key = normalizeLookupText(displayName);
    if (key && !creditorsByName.has(key)) creditorsByName.set(key, creditor);
  });

  (tables.egresos?.rows || []).forEach((expense) => {
    const existingId = backendId(expense._id_acreedor);
    const creditorName = cleanBackendText(expense._nombre_acreedor);
    if (existingId || !creditorName) return;

    const key = normalizeLookupText(creditorName);
    let creditor = creditorsByName.get(key);
    if (!creditor) {
      const creditorId = backendNextNumericId(creditors, "id_acreedor");
      creditor = {
        _rowNumber: creditors.length + 2,
        id_acreedor: creditorId,
        origen_tipo_acreedor: "historico",
        origen_id_acreedor: "",
        cuit_cuil: "",
        cbu_alias: "",
        acuerdo_de_pago: creditorName
      };
      creditors.push(creditor);
      creditorsByName.set(key, creditor);
    }
    expense._id_acreedor = backendId(creditor.id_acreedor);
  });

  tables.acreedores.rowCount = creditors.length;
}

function normalizeBackendTags(cache) {
  ensureBackendTagsTable(cache);
  const tagIndex = backendTagIndex(cache);
  const existingCreditorTags = cache.tables?.acreedores_etiquetas;
  if ((existingCreditorTags?.rows || []).length) {
    existingCreditorTags.headers = EXPECTED_BACKEND_COLUMNS.acreedores_etiquetas;
    existingCreditorTags.rowCount = existingCreditorTags.rows.length;
    cache.tables.etiquetas.headers = EXPECTED_BACKEND_COLUMNS.etiquetas;
    cache.tables.etiquetas.rowCount = cache.tables.etiquetas.rows.length;
    return;
  }

  const creditorTagPairs = new Map();

  const tagIdFor = (value) => ensureBackendTag(cache, value, tagIndex);
  const addCreditorTag = (creditorId, tagValue) => {
    const normalizedCreditorId = backendId(creditorId);
    const tagId = tagIdFor(tagValue);
    if (!normalizedCreditorId || !tagId) return;
    creditorTagPairs.set(`${normalizedCreditorId}|${tagId}`, {
      id_acreedor: normalizedCreditorId,
      id_etiqueta: tagId
    });
  };

  (cache.tables?.egresos?.rows || []).forEach((expense) => {
    const tagId = tagIdFor(expense.id_etiqueta || expense._etiqueta_gasto);
    if (tagId) expense.id_etiqueta = tagId;
    addCreditorTag(expense._id_acreedor, tagId || expense._etiqueta_gasto);
  });

  (cache.tables?.otros_gastos?.rows || []).forEach((expense) => {
    const tagId = tagIdFor(expense.id_etiqueta || expense._etiqueta_gasto);
    if (tagId) expense.id_etiqueta = tagId;
    addCreditorTag(expense.id_acreedor || expense._id_acreedor, tagId || expense._etiqueta_gasto);
  });

  ["recepciones", "entregas"].forEach((tableName) => {
    (cache.tables?.[tableName]?.rows || []).forEach((row) => {
      const tagId = tagIdFor(row.id_etiqueta || row._etiqueta_gasto);
      if (tagId && "id_etiqueta" in row) row.id_etiqueta = tagId;
      addCreditorTag(row._id_acreedor || row.id_acreedor, tagId || row._etiqueta_gasto);
    });
  });

  (cache.tables?.datos_bancarios?.rows || []).forEach((bankDetail) => {
    addCreditorTag(bankDetail.id_acreedor, bankDetail.id_etiqueta);
  });

  (cache.tables?.acreedores?.rows || []).forEach((creditor) => {
    const fixedTag = fixedCreditorTag(creditor.origen_tipo_acreedor);
    addCreditorTag(creditor.id_acreedor, creditor._etiqueta_gasto || fixedTag);
  });

  const rows = [...creditorTagPairs.values()]
    .sort((left, right) => Number(left.id_acreedor) - Number(right.id_acreedor) || Number(left.id_etiqueta) - Number(right.id_etiqueta))
    .map((row, index) => ({
      id_acreedor_etiqueta: index + 1,
      id_acreedor: row.id_acreedor,
      id_etiqueta: row.id_etiqueta
    }));

  cache.tables.acreedores_etiquetas = {
    definition: {
      name: "acreedores_etiquetas",
      label: "Acreedores etiquetas",
      module: "maestros",
      workbook: "Informacion.xlsx",
      sheet: "Acreedores_Etiquetas",
      primaryKey: "id_acreedor_etiqueta",
      synthetic: true
    },
    headers: EXPECTED_BACKEND_COLUMNS.acreedores_etiquetas,
    rows,
    rowCount: rows.length,
    source: { syntheticFrom: ["acreedores", "egresos", "otros_gastos", "recepciones", "entregas"] }
  };

  cache.tables.etiquetas.headers = EXPECTED_BACKEND_COLUMNS.etiquetas;
  cache.tables.etiquetas.rowCount = cache.tables.etiquetas.rows.length;
}

function ensureBackendCreditorByName(tables, name, originType = "historico") {
  const cleanName = cleanBackendText(name);
  if (!cleanName) return null;
  ensureBackendTable(tables, "acreedores");
  const creditors = tables.acreedores.rows || [];
  const normalizedName = normalizeLookupText(cleanName);
  const existing = creditors.find((creditor) => {
    const displayName = backendCreditorDisplayName(creditor, tables) || creditor.acuerdo_de_pago;
    return normalizeLookupText(displayName) === normalizedName;
  });
  if (existing) return existing;

  const creditor = {
    _rowNumber: creditors.length + 2,
    id_acreedor: backendNextNumericId(creditors, "id_acreedor"),
    origen_tipo_acreedor: originType,
    origen_id_acreedor: "",
    cuit_cuil: "",
    cbu_alias: "",
    acuerdo_de_pago: cleanName
  };
  creditors.push(creditor);
  tables.acreedores.rowCount = creditors.length;
  return creditor;
}

function normalizeBackendBankDetails(cache) {
  ensureBackendTable(cache.tables, "datos_bancarios");
  const tagIndex = backendTagIndex(cache);
  const rows = [];

  (cache.tables.datos_bancarios.rows || []).forEach((row) => {
    const detail = cleanBackendText(row.detalle || row.concepto || row.descripcion || row.informacion_complementaria);
    const creditorId = backendId(row.id_acreedor);
    const tagId = ensureBackendTag(cache, row.id_etiqueta || row.tipo || row.categoria || row.categoria_gasto, tagIndex);
    if (!detail && !creditorId && !tagId) return;
    rows.push({
      _rowNumber: row._rowNumber,
      id_dato_bancario: backendId(row.id_dato_bancario) || rows.length + 1,
      detalle: detail,
      id_acreedor: creditorId,
      id_etiqueta: tagId,
      tipo_factura: cleanBackendText(row.tipo_factura)
    });
  });

  cache.tables.datos_bancarios.headers = EXPECTED_BACKEND_COLUMNS.datos_bancarios;
  cache.tables.datos_bancarios.rows = rows;
  cache.tables.datos_bancarios.rowCount = rows.length;
}

function seedDefaultBankDetails(cache) {
  ensureBackendTable(cache.tables, "datos_bancarios");
  ensureBackendTagsTable(cache);

  const rows = cache.tables.datos_bancarios.rows;
  const existingDetails = new Set(rows
    .map((row) => backendNormalizeText(row.detalle || row.concepto || row.descripcion))
    .filter(Boolean));
  const creditors = cache.tables?.acreedores?.rows || [];
  const tagIndex = backendTagIndex(cache);
  let added = 0;

  DEFAULT_BANK_DETAIL_RULES.forEach((rule) => {
    const normalizedDetail = backendNormalizeText(rule.detail);
    if (!normalizedDetail || existingDetails.has(normalizedDetail)) return;

    const creditor = creditors.find((candidate) => (
      backendNormalizeText(backendCreditorDisplayName(candidate, cache.tables))
      === backendNormalizeText(rule.creditor)
    )) || ensureBackendCreditorByName(cache.tables, rule.creditor, "dato_bancario");
    const idEtiqueta = ensureBackendTag(cache, rule.expenseType, tagIndex);
    if (!creditor || !idEtiqueta) return;

    rows.push({
      _rowNumber: rows.length + 2,
      id_dato_bancario: backendNextNumericId(rows, "id_dato_bancario"),
      detalle: rule.detail,
      id_acreedor: backendId(creditor.id_acreedor),
      id_etiqueta: idEtiqueta,
      tipo_factura: ""
    });
    existingDetails.add(normalizedDetail);
    added += 1;
  });

  cache.tables.datos_bancarios.headers = EXPECTED_BACKEND_COLUMNS.datos_bancarios;
  cache.tables.datos_bancarios.rowCount = rows.length;
  return added;
}

function ensureBackendTagsTable(cache) {
  if (!cache.tables) cache.tables = {};
  if (!cache.tables.etiquetas) {
    cache.tables.etiquetas = {
      definition: {
        name: "etiquetas",
        label: "Etiquetas",
        module: "maestros",
        workbook: "Informacion.xlsx",
        sheet: "Etiquetas",
        primaryKey: "id_etiqueta"
      },
      headers: EXPECTED_BACKEND_COLUMNS.etiquetas,
      rows: [],
      rowCount: 0,
      source: { syntheticFallback: true }
    };
  }
  cache.tables.etiquetas.rows ||= [];
}

function backendTagIndex(cache) {
  const byId = new Map();
  const byName = new Map();
  (cache.tables?.etiquetas?.rows || []).forEach((tag) => {
    const id = backendId(tag.id_etiqueta);
    if (!id) return;
    tag.id_etiqueta = id;
    const name = cleanBackendText(tag.etiqueta);
    if (name) byName.set(normalizeLookupText(name), id);
    byId.set(id, tag);
  });
  return { byId, byName };
}

function ensureBackendTag(cache, value, index = backendTagIndex(cache)) {
  const raw = cleanBackendText(value);
  if (!raw) return "";
  const numericId = backendId(raw);
  if (numericId && index.byId.has(numericId)) return numericId;

  const normalized = normalizeLookupText(raw);
  if (index.byName.has(normalized)) return index.byName.get(normalized);

  const nextId = backendNextNumericId(cache.tables.etiquetas.rows, "id_etiqueta");
  const tag = {
    id_etiqueta: nextId,
    etiqueta: raw,
    categoria_pnl: ""
  };
  cache.tables.etiquetas.rows.push(tag);
  index.byId.set(String(nextId), tag);
  index.byName.set(normalized, String(nextId));
  return String(nextId);
}

function fixedCreditorTag(originType) {
  const type = creditorOriginTypeKey(originType);
  if (type === "flete") return "Logistica";
  if (type === "empleado") return "Sueldos";
  if (type === "canal") return "Comisiones";
  return "";
}

function mostCommonBackendValue(counts) {
  if (!counts) return "";
  let bestValue = "";
  let bestCount = 0;
  counts.forEach((count, value) => {
    if (count > bestCount) {
      bestValue = value;
      bestCount = count;
    }
  });
  return bestValue;
}

function cleanBackendText(value) {
  return String(value ?? "").trim();
}

function normalizeBackendDateKey(value) {
  const text = cleanBackendText(value);
  if (!text) return "";
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const localMatch = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (localMatch) {
    const day = localMatch[1].padStart(2, "0");
    const month = localMatch[2].padStart(2, "0");
    const year = localMatch[3].length === 2 ? `20${localMatch[3]}` : localMatch[3];
    return `${year}-${month}-${day}`;
  }
  return normalizeLookupText(text);
}

function normalizeInvoiceNumber(value) {
  const text = cleanBackendText(value);
  if (!text) return "";
  const numeric = Number(text.replace(",", "."));
  if (Number.isFinite(numeric)) return String(Math.trunc(numeric));
  return normalizeLookupText(text);
}

function normalizeBackendAmountKey(value) {
  const text = cleanBackendText(value);
  if (!text) return "";
  const normalized = text
    .replace(/\$/g, "")
    .replace(/\s/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
  const number = Number(normalized);
  if (!Number.isFinite(number)) return normalizeLookupText(text);
  return String(Math.round(number * 100) / 100);
}

function cleanupBackendAuxiliaryFields(cache) {
  const auxiliaryColumns = [
    "_nombre_acreedor",
    "_neto",
    "_traduccion_ud_receta"
  ];

  Object.values(cache.tables || {}).forEach((table) => {
    (table.rows || []).forEach((row) => {
      auxiliaryColumns.forEach((column) => delete row[column]);
    });
  });
}

function backendRowsByName(rows = [], nameColumn, idColumn) {
  const result = new Map();
  rows.forEach((row) => {
    const key = normalizeLookupText(row[nameColumn]);
    const id = String(row[idColumn] ?? "").trim();
    if (key && id && !result.has(key)) result.set(key, id);
  });
  return result;
}

function creditorOriginTypeKey(value) {
  const text = normalizeLookupText(value);
  if (text.includes("proveedor")) return "proveedor";
  if (text.includes("empleado")) return "empleado";
  if (text.includes("canal")) return "canal";
  if (text.includes("flete")) return "flete";
  if (text.includes("otrosacreedores") || text === "otros") return "otros_acreedores";
  return "";
}

function fillEmptyPrimaryIds(cache) {
  Object.entries(cache.tables || {}).forEach(([tableName, table]) => {
    const primaryColumn = EXPECTED_BACKEND_COLUMNS[tableName]?.[0];
    const rows = table.rows || [];
    if (!primaryColumn || !primaryColumn.startsWith("id_") || !rows.length) return;

    const primaryIdIsEmpty = rows.every((row) => {
      return String(row[primaryColumn] ?? "").trim() === "";
    });
    if (!primaryIdIsEmpty) return;

    rows.forEach((row, index) => {
      row[primaryColumn] = index + 1;
    });
  });
}

function expandLegacyInventoryTurnTables(cache) {
  const inventoryTable = cache.tables?.inventarios;
  const detailTable = cache.tables?.detalle_inventarios;
  const sourceInventories = inventoryTable?._sourceRows || [];
  const sourceDetails = detailTable?._sourceRows || [];

  if (!inventoryTable || !detailTable || !isLegacyInventoryTurnSource(sourceInventories, sourceDetails)) return;

  const detailsByInventory = new Map();
  sourceDetails.forEach((detail) => {
    const inventoryId = String(valueFromBackendAliases(detail, ["id_inventario"]) || "").trim();
    if (!inventoryId) return;
    if (!detailsByInventory.has(inventoryId)) detailsByInventory.set(inventoryId, []);
    detailsByInventory.get(inventoryId).push(detail);
  });

  const migratedInventories = [];
  const migratedDetails = [];
  let nextInventoryId = 1;
  let nextDetailId = 1;

  sourceInventories
    .filter((inventory) => String(valueFromBackendAliases(inventory, ["id_inventario"]) || "").trim())
    .sort((left, right) => {
      return Number(valueFromBackendAliases(left, ["id_inventario"])) - Number(valueFromBackendAliases(right, ["id_inventario"]));
    })
    .forEach((inventory) => {
      const legacyInventoryId = String(valueFromBackendAliases(inventory, ["id_inventario"]) || "").trim();
      const legacyDetails = detailsByInventory.get(legacyInventoryId) || [];

      const turnGroups = legacyInventoryTurnDefinitions()
        .map((turn) => ({
          turn,
          details: legacyDetails
            .map((detail) => ({
              id_item: valueFromBackendAliases(detail, ["id_item"]),
              cantidad: cleanLegacyInventoryQuantity(valueFromBackendAliases(detail, turn.aliases))
            }))
            .filter((detail) => String(detail.id_item || "").trim() && detail.cantidad !== "")
        }))
        .filter((group) => group.details.length);
      const singleTurnDay = turnGroups.length === 1;

      turnGroups.forEach((group) => {
        const inventoryId = nextInventoryId;
        migratedInventories.push({
          id_inventario: inventoryId,
          fecha: valueFromBackendAliases(inventory, ["fecha"]),
          turno: singleTurnDay ? "Mañana" : group.turn.label,
          id_empleado: valueFromBackendAliases(inventory, ["id_empleado", "empleado"]),
          valor_total: 0
        });

        group.details.forEach((detail) => {
          migratedDetails.push({
            id_detalle_inventario: nextDetailId,
            id_inventario: inventoryId,
            id_item: detail.id_item,
            cantidad: detail.cantidad,
            costo_unitario_usado: 0,
            valor_total: 0
          });
          nextDetailId += 1;
        });

        nextInventoryId += 1;
      });
    });

  inventoryTable.headers = EXPECTED_BACKEND_COLUMNS.inventarios;
  inventoryTable.rows = migratedInventories;
  inventoryTable.rowCount = migratedInventories.length;
  inventoryTable.source = {
    ...(inventoryTable.source || {}),
    transformedFromLegacyTurns: true
  };

  detailTable.headers = EXPECTED_BACKEND_COLUMNS.detalle_inventarios;
  detailTable.rows = migratedDetails;
  detailTable.rowCount = migratedDetails.length;
  detailTable.source = {
    ...(detailTable.source || {}),
    transformedFromLegacyTurns: true
  };
}

function isLegacyInventoryTurnSource(sourceInventories, sourceDetails) {
  if (!sourceInventories.length || !sourceDetails.length) return false;
  const hasNewTurn = sourceInventories.some((inventory) => String(inventory.turno || "").trim());
  const hasLegacyTurnColumns = sourceDetails.some((detail) => {
    return legacyInventoryTurnDefinitions().some((turn) => turn.aliases.some((alias) => Object.prototype.hasOwnProperty.call(detail, alias)));
  });
  return !hasNewTurn && hasLegacyTurnColumns;
}

function legacyInventoryTurnDefinitions() {
  return [
    { label: "Madrugada", aliases: ["turno_madrugadacf", "turno_madrugada_cf", "turno_madrugada"] },
    { label: "Mañana", aliases: ["turno_mananacf", "turno_manana_cf", "turno_manana", "turno_mañanacf"] },
    { label: "Tarde", aliases: ["cantidad_formulario", "turno_tardecf", "turno_tarde_cf", "turno_tarde"] }
  ];
}

function cleanLegacyInventoryQuantity(value) {
  const text = String(value ?? "").trim();
  if (!text || /^[-–—]+$/.test(text)) return "";
  return text.replace(",", ".");
}

function payrollMonthToDate(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4})(\d{2})(?:\.0)?$/);
  if (!match) return value || "";
  return `${match[1]}-${match[2]}-01`;
}

function splitPayrollHolidayHours(payroll) {
  if (cleanBackendText(payroll.hs_feriado)) return;
  const combinedHours = parseBackendNumber(payroll.hs_con_justificacion_medica);
  if (!Number.isFinite(combinedHours) || combinedHours <= 0) {
    payroll.hs_feriado = "";
    return;
  }

  const holidayHours = Math.min(combinedHours, argentineBusinessHolidayCountInMonth(payroll.fecha) * 8);
  payroll.hs_feriado = formatBackendNumber(holidayHours);
  payroll.hs_con_justificacion_medica = formatBackendNumber(combinedHours - holidayHours);
}

function argentineBusinessHolidayCountInMonth(monthDate) {
  const match = String(monthDate || "").match(/^(\d{4})-(\d{2})-/);
  if (!match) return 0;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  return argentineNationalHolidays(year).filter((date) => {
    return date.getUTCMonth() === monthIndex && date.getUTCDay() >= 1 && date.getUTCDay() <= 5;
  }).length;
}

function argentineNationalHolidays(year) {
  const easter = easterSunday(year);
  const holidays = [
    dateOnly(year, 0, 1),
    addDays(easter, -48),
    addDays(easter, -47),
    dateOnly(year, 2, 24),
    dateOnly(year, 3, 2),
    addDays(easter, -2),
    dateOnly(year, 4, 1),
    dateOnly(year, 4, 25),
    transferArgentineHoliday(dateOnly(year, 5, 17)),
    dateOnly(year, 5, 20),
    dateOnly(year, 6, 9),
    transferArgentineHoliday(dateOnly(year, 7, 17)),
    transferArgentineHoliday(dateOnly(year, 9, 12)),
    transferArgentineHoliday(dateOnly(year, 10, 20)),
    dateOnly(year, 11, 8),
    dateOnly(year, 11, 25)
  ];
  return [...new Map(holidays.map((date) => [date.toISOString().slice(0, 10), date])).values()];
}

function transferArgentineHoliday(date) {
  const day = date.getUTCDay();
  if (day === 2 || day === 3) return addDays(date, 1 - day);
  if (day === 4 || day === 5) return addDays(date, 8 - day);
  return date;
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return dateOnly(year, month, day);
}

function dateOnly(year, monthIndex, day) {
  return new Date(Date.UTC(year, monthIndex, day));
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function parseBackendNumber(value) {
  if (typeof value === "number") return value;
  const text = String(value ?? "").trim().replace(",", ".");
  if (!text) return NaN;
  const number = Number(text);
  return Number.isFinite(number) ? number : NaN;
}

function formatBackendNumber(value) {
  if (!Number.isFinite(value)) return "";
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? rounded : rounded;
}

function sumBackendNumbers(...values) {
  const total = values.reduce((sum, value) => {
    const numeric = Number(String(value ?? "").replace(",", "."));
    return Number.isFinite(numeric) ? sum + numeric : sum;
  }, 0);
  return total || "";
}

function defaultChannelCommission(channelId) {
  const commissions = {
    1: 0.05,
    2: 0.06,
    3: 0.05,
    4: 0,
    5: 0.06,
    6: 0.05,
    7: 0.05
  };
  const id = Number(channelId);
  return Object.hasOwn(commissions, id) ? commissions[id] : "";
}

function normalizeLookupText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function valueFromBackendAliases(row, aliases) {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(row, alias)) return row[alias];
  }
  return "";
}

function detectBackendHeaderRow(values) {
  const maxRows = Math.min(values.length, 20);
  let bestIndex = 0;
  let bestScore = -Infinity;

  for (let index = 0; index < maxRows; index += 1) {
    const row = values[index] || [];
    const nonEmpty = row.filter((value) => String(value ?? "").trim()).length;
    if (nonEmpty < 2) continue;

    const normalized = row.map((value) => normalizeBackendHeader(value));
    const knownWords = normalized.filter((header) => {
      return /(^id_|fecha|nombre|tipo|monto|total|cantidad|cliente|proveedor|acreedor|item|producto|precio|iva|saldo)/.test(header);
    }).length;
    const formulaPenalty = row.filter((value) => String(value ?? "").trim().startsWith("=")).length;
    const score = knownWords * 4 + Math.min(nonEmpty, 12) - formulaPenalty * 3 - index * 0.2;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function normalizeBackendHeader(value, index) {
  const text = String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return text || `columna_${index + 1}`;
}

function dedupeBackendHeaders(headers) {
  const counts = new Map();
  return headers.map((header) => {
    const count = counts.get(header) || 0;
    counts.set(header, count + 1);
    return count ? `${header}_${count + 1}` : header;
  });
}

function cleanBackendCell(value) {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value.trim() : value;
}

async function handleAppStateGet(response) {
  if (!fs.existsSync(APP_STATE_FILE)) {
    sendJson(response, 200, { ok: true, state: null });
    return;
  }

  try {
    const state = JSON.parse(fs.readFileSync(APP_STATE_FILE, "utf8"));
    sendJson(response, 200, { ok: true, state });
  } catch {
    sendJson(response, 500, { error: "No se pudo leer el estado guardado de la app." });
  }
}

async function handleAppStateSave(request, response) {
  const body = await readJsonBody(request);
  const state = body.state;

  if (!state || typeof state !== "object" || Array.isArray(state)) {
    sendJson(response, 400, { error: "Estado invalido para guardar." });
    return;
  }

  fs.mkdirSync(path.dirname(APP_STATE_FILE), { recursive: true });
  const tempFile = `${APP_STATE_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(state), "utf8");
  fs.renameSync(tempFile, APP_STATE_FILE);
  sendJson(response, 200, { ok: true });
}

async function handleImportsRefresh(request, response) {
  const body = await readJsonBody(request);
  const entries = Array.isArray(body.entries) ? body.entries : [];
  const imports = [];
  const errors = [];

  for (const entry of entries) {
    const kind = String(entry.kind || "").trim();
    const rawUrl = String(entry.url || "").trim();
    if (!kind || !rawUrl) continue;

    try {
      const { text, rows } = await readImportSheet(rawUrl);
      if (rows.length < 2) {
        errors.push({
          source: labelForKind(kind),
          row: "-",
          reason: "El CSV no tiene datos para importar. Se conservaron los datos anteriores.",
          raw: rawUrl
        });
        continue;
      }

      const cellErrors = findSpreadsheetCellErrors(rows, kind);
      if (cellErrors.length) {
        errors.push({
          source: labelForKind(kind),
          row: cellErrors[0].row,
          reason: `Hay un error en una celda (${cellErrors[0].cell}). Se conservaron los datos anteriores.`,
          raw: cellErrors[0].raw || rawUrl
        });
        cellErrors.slice(1, 20).forEach((error) => {
          errors.push({
            source: labelForKind(kind),
            row: error.row,
            reason: `Celda con error (${error.cell})`,
            raw: error.raw
          });
        });
        continue;
      }

      imports.push({ kind, source: rawUrl, text });
    } catch (error) {
      errors.push({
        source: labelForKind(kind),
        row: "-",
        reason: `No se pudo cargar la URL: ${error.message}. Se conservaron los datos anteriores.`,
        raw: rawUrl
      });
    }
  }

  sendJson(response, 200, { ok: true, imports, errors });
}

async function readImportSheet(rawUrl) {
  const reference = googleSheetReference(rawUrl);
  if (reference) {
    try {
      const accessToken = await googleAccessToken();
      const sheetName = await sheetTitleByGid(reference.spreadsheetId, accessToken, reference.gid);
      const payload = await sheetsGetValues(reference.spreadsheetId, accessToken, quoteSheetName(sheetName));
      const rows = payload.values || [];
      return { rows, text: rowsToCsv(rows) };
    } catch (error) {
      const publicResult = await readPublicCsv(rawUrl).catch(() => null);
      if (publicResult) return publicResult;
      throw error;
    }
  }

  return readPublicCsv(rawUrl);
}

async function readPublicCsv(rawUrl) {
  const csvUrl = googleSheetCsvUrl(rawUrl, true);
  const csvResponse = await fetch(csvUrl, { cache: "no-store" });
  if (!csvResponse.ok) throw new Error(`HTTP ${csvResponse.status}`);

  const text = await csvResponse.text();
  return { text, rows: parseCsv(text) };
}

async function handleInventoryAppend(request, response) {
  const body = await readJsonBody(request);
  const date = String(body.date || "").trim();
  const employee = String(body.employee || "").trim();

  if (!isIsoDate(date)) {
    sendJson(response, 400, { error: "Falta una fecha valida para el inventario." });
    return;
  }

  if (!employee) {
    sendJson(response, 400, { error: "Falta el empleado responsable." });
    return;
  }

  const spreadsheetId = process.env.INVENTORY_SPREADSHEET_ID;
  if (!spreadsheetId) {
    sendJson(response, 500, { error: "Falta configurar INVENTORY_SPREADSHEET_ID en el backend." });
    return;
  }

  const accessToken = await googleAccessToken();
  const targetRange = await nextInventoryEntryRange(spreadsheetId, accessToken);
  const googleResponse = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(targetRange)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        values: [[date, employee]]
      })
    }
  );
  const payload = await googleResponse.json().catch(() => ({}));

  if (!googleResponse.ok) {
    sendJson(response, googleResponse.status, {
      error: payload.error?.message || "Google Sheets rechazo la carga."
    });
    return;
  }

  sendJson(response, 200, {
    ok: true,
    date,
    employee,
    updatedRange: payload.updatedRange || ""
  });
}

async function handleInventoryLatestDate(response) {
  const spreadsheetId = configuredSpreadsheetId();
  const accessToken = await googleAccessToken();
  const sheetName = process.env.INVENTORY_SHEET_NAME || "Inventario";
  const dateColumn = process.env.INVENTORY_DATE_COLUMN || "B";
  const payload = await sheetsGetValues(spreadsheetId, accessToken, `${quoteSheetName(sheetName)}!${dateColumn}:${dateColumn}`);
  const lastDate = (payload.values || [])
    .flat()
    .map(parseInventorySheetDate)
    .filter(Boolean)
    .sort()
    .at(-1);

  sendJson(response, 200, {
    lastDate: lastDate || "",
    nextDate: nextBusinessDayIso(lastDate)
  });
}

async function handleInventoryFullEntry(request, response) {
  const body = await readJsonBody(request);
  const date = String(body.date || "").trim();
  const employee = String(body.employee || "").trim();
  const employeeId = resolveInventoryEmployeeId(body.employeeId || employee);
  const selectedShifts = normalizeSelectedInventoryShifts(body.selectedShifts);
  const rows = Array.isArray(body.rows) ? body.rows : [];

  if (!isIsoDate(date)) {
    sendJson(response, 400, { error: "Falta una fecha valida para el inventario." });
    return;
  }

  if (!employee) {
    sendJson(response, 400, { error: "Falta el empleado responsable." });
    return;
  }

  if (!selectedShifts.length) {
    sendJson(response, 400, { error: "Falta indicar al menos un turno realizado." });
    return;
  }

  const cleanRows = normalizeInventoryDetailRows(rows);
  if (!cleanRows.length) {
    sendJson(response, 400, { error: "No hay items para cargar." });
    return;
  }

  const spreadsheetId = configuredSpreadsheetId();
  const accessToken = await googleAccessToken();
  const inventoryEntries = await inventoryTurnEntryRanges(spreadsheetId, accessToken, {
    date,
    employeeId,
    selectedShifts,
    cleanRows
  });
  const responsePayload = await sheetsBatchUpdate(spreadsheetId, accessToken, inventoryEntries.ranges);

  sendJson(response, 200, {
    ok: true,
    date,
    employee,
    inventoryIds: inventoryEntries.inventoryIds,
    rowsWritten: inventoryEntries.detailRowsWritten,
    updatedRanges: responsePayload.responses?.map((entry) => entry.updatedRange) || []
  });
}

async function handleInventoryDetailTemplate(response) {
  const spreadsheetId = configuredSpreadsheetId();
  const accessToken = await googleAccessToken();
  const inventorySheet = process.env.INVENTORY_SHEET_NAME || "Inventario";
  const sheetName = process.env.INVENTORY_DETAIL_SHEET_NAME || "Detalle_Inventario";
  const inventoryPayload = await sheetsGetValues(spreadsheetId, accessToken, `${quoteSheetName(inventorySheet)}!A:D`);
  const detailPayload = await sheetsGetValues(spreadsheetId, accessToken, `${quoteSheetName(sheetName)}!A:D`);
  const fullDetailPayload = await sheetsGetValues(spreadsheetId, accessToken, `${quoteSheetName(sheetName)}!A:K`);
  if (isLegacyInventoryDetailSheet(fullDetailPayload.values || [])) {
    sendJson(response, 200, buildLegacyInventoryDetailTemplate(fullDetailPayload.values || []));
    return;
  }

  const inventoryRows = parseNewInventoryRows(inventoryPayload.values || []);
  const lastInventory = latestInventoryTurn(inventoryRows);

  if (!lastInventory) {
    sendJson(response, 404, { error: "No hay detalle anterior para usar como plantilla." });
    return;
  }

  const itemNames = inventoryItemNameMap();
  const dataRows = (detailPayload.values || []).slice(1)
    .filter((row) => Number(row[1]) === lastInventory.id);
  const rows = dataRows
    .map((row) => {
      const itemId = cleanSheetInput(row[2]);
      return {
        itemId,
        itemName: itemNames.get(itemId) || defaultInventoryItemName(itemId),
        previousAfternoon: cleanSheetInput(row[3] || ""),
        previousMorning: "",
        previousDawn: ""
      };
    })
    .filter((row) => row.itemId || row.itemName);
  const nextInventoryId = await nextSheetNumericId(spreadsheetId, accessToken, inventorySheet, "A");

  sendJson(response, 200, {
    lastInventoryId: lastInventory.id,
    inventoryId: nextInventoryId,
    rows
  });
}

function isLegacyInventoryDetailSheet(values) {
  const headers = (values[0] || []).map(normalizeHeader);
  return headers.includes("cantidad_formulario")
    || headers.includes("turno_mananacf")
    || headers.includes("turno_madrugadacf");
}

function buildLegacyInventoryDetailTemplate(values) {
  const dataRows = values.slice(1)
    .filter((row) => Number(row[0]) > 0 && (String(row[1] || "").trim() || String(row[2] || "").trim()));
  const lastInventoryId = Math.max(...dataRows.map((row) => Number(row[0])).filter(Number.isFinite));

  if (!Number.isFinite(lastInventoryId)) {
    throw new Error("No hay detalle anterior para usar como plantilla.");
  }

  const rows = dataRows
    .filter((row) => Number(row[0]) === lastInventoryId)
    .map((row) => ({
      itemId: String(row[1] || defaultInventoryItemId(row[2])).trim(),
      itemName: String(row[2] || "").trim(),
      previousAfternoon: cleanSheetInput(row[4] || ""),
      previousMorning: cleanSheetInput(row[8] || ""),
      previousDawn: cleanSheetInput(row[10] || "")
    }))
    .filter((row) => row.itemId || row.itemName);

  return {
    lastInventoryId,
    inventoryId: lastInventoryId + 1,
    rows
  };
}

function defaultInventoryItemId(itemName) {
  return normalizeInventoryToken(itemName) === "contadoralipack" ? "0" : "";
}

async function handleInventoryDetailAppend(request, response) {
  const body = await readJsonBody(request);
  const inventoryId = Number(body.inventoryId);
  const rows = Array.isArray(body.rows) ? body.rows : [];

  if (!Number.isInteger(inventoryId) || inventoryId <= 0) {
    sendJson(response, 400, { error: "Falta un Id_Inventario valido." });
    return;
  }

  const cleanRows = normalizeInventoryDetailRows(rows);

  if (!cleanRows.length) {
    sendJson(response, 400, { error: "No hay items para cargar." });
    return;
  }

  const spreadsheetId = configuredSpreadsheetId();
  const accessToken = await googleAccessToken();
  const detailRanges = await inventoryDetailManualRanges(spreadsheetId, accessToken, inventoryId, cleanRows);
  const responsePayload = await sheetsBatchUpdate(spreadsheetId, accessToken, detailRanges);

  sendJson(response, 200, {
    ok: true,
    inventoryId,
    rowsWritten: cleanRows.length,
    updatedRanges: responsePayload.responses?.map((entry) => entry.updatedRange) || []
  });
}

async function handlePurchaseFullEntry(request, response) {
  const body = await readJsonBody(request);
  const purchase = normalizePurchasePayload(body);

  if (!purchase.supplier) {
    sendJson(response, 400, { error: "Falta el proveedor." });
    return;
  }

  if (!isIsoDate(purchase.orderDate) || !isIsoDate(purchase.expectedDeliveryDate)) {
    sendJson(response, 400, { error: "Faltan fechas validas para la compra." });
    return;
  }

  if (!purchase.itemName) {
    sendJson(response, 400, { error: "Falta el insumo." });
    return;
  }

  const spreadsheetId = configuredSpreadsheetId();
  const accessToken = await googleAccessToken();
  const purchaseId = await nextPurchaseId(spreadsheetId, accessToken);
  const ranges = await purchaseFullEntryRanges(spreadsheetId, accessToken, purchaseId, purchase);
  const responsePayload = await sheetsBatchUpdate(spreadsheetId, accessToken, ranges);

  sendJson(response, 200, {
    ok: true,
    purchaseId,
    updatedRanges: responsePayload.responses?.map((entry) => entry.updatedRange) || []
  });
}

function normalizePurchasePayload(body) {
  return {
    supplier: cleanSheetInput(body.supplier),
    orderDate: cleanSheetInput(body.orderDate),
    expectedDeliveryDate: cleanSheetInput(body.expectedDeliveryDate),
    itemId: cleanSheetInput(body.itemId),
    itemName: cleanSheetInput(body.itemName),
    quantity: cleanSheetInput(body.quantity),
    supplierUnit: cleanSheetInput(body.supplierUnit),
    countQuantity: cleanSheetInput(body.countQuantity),
    countUnit: cleanSheetInput(body.countUnit),
    recipeQuantity: cleanSheetInput(body.recipeQuantity),
    recipeUnit: cleanSheetInput(body.recipeUnit),
    invoiceType: cleanSheetInput(body.invoiceType),
    subtotal: cleanSheetInput(body.subtotal),
    ivaRate: cleanSheetInput(body.ivaRate),
    iva: cleanSheetInput(body.iva),
    total: cleanSheetInput(body.total)
  };
}

async function nextPurchaseId(spreadsheetId, accessToken) {
  const sheetName = process.env.PURCHASES_SHEET_NAME || "Compras";
  const payload = await sheetsGetValues(spreadsheetId, accessToken, `${quoteSheetName(sheetName)}!A:A`);
  const ids = (payload.values || []).flat().map(Number).filter(Number.isFinite);
  return Math.max(0, ...ids) + 1;
}

async function purchaseFullEntryRanges(spreadsheetId, accessToken, purchaseId, purchase) {
  const purchasesSheet = process.env.PURCHASES_SHEET_NAME || "Compras";
  const detailSheet = process.env.PURCHASE_DETAILS_SHEET_NAME || "Detalle_Compras";
  const purchaseRow = await nextSheetRowByColumn(spreadsheetId, accessToken, purchasesSheet, "B");
  const detailRow = await nextSheetRowByColumn(spreadsheetId, accessToken, detailSheet, "A");
  return [
    {
      range: `${quoteSheetName(purchasesSheet)}!B${purchaseRow}:B${purchaseRow}`,
      values: [[purchase.supplier]]
    },
    {
      range: `${quoteSheetName(purchasesSheet)}!D${purchaseRow}:E${purchaseRow}`,
      values: [[purchase.orderDate, purchase.expectedDeliveryDate]]
    },
    {
      range: `${quoteSheetName(detailSheet)}!A${detailRow}:A${detailRow}`,
      values: [[purchaseId]]
    },
    {
      range: `${quoteSheetName(detailSheet)}!C${detailRow}:H${detailRow}`,
      values: [[
        purchase.itemId,
        purchase.itemName,
        purchase.supplierUnit,
        purchase.quantity,
        purchase.expectedDeliveryDate,
        purchase.supplier
      ]]
    },
    {
      range: `${quoteSheetName(detailSheet)}!I${detailRow}:L${detailRow}`,
      values: [[
        purchase.countUnit,
        purchase.countQuantity,
        purchase.recipeUnit,
        purchase.recipeQuantity
      ]]
    },
    {
      range: `${quoteSheetName(detailSheet)}!M${detailRow}:Q${detailRow}`,
      values: [[
        purchase.invoiceType,
        purchase.subtotal,
        purchase.ivaRate,
        purchase.iva,
        purchase.total
      ]]
    }
  ];
}

async function handleInventoryDetailPhoto(request, response) {
  const body = await readJsonBody(request);
  const date = String(body.date || "").trim();
  const imageDataUrl = String(body.imageDataUrl || "");
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const selectedShifts = normalizeSelectedInventoryShifts(body.selectedShifts);

  if (!isIsoDate(date)) {
    sendJson(response, 400, { error: "Falta una fecha valida para leer la foto." });
    return;
  }

  if (!imageDataUrl.startsWith("data:image/")) {
    sendJson(response, 400, { error: "Falta una imagen valida." });
    return;
  }

  if (!rows.length) {
    sendJson(response, 400, { error: "Primero hay que preparar el detalle." });
    return;
  }

  try {
    const extracted = await extractInventoryFromPhoto({ date, imageDataUrl, rows, selectedShifts });
    sendJson(response, 200, extracted);
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
}

async function inventoryDetailManualRanges(spreadsheetId, accessToken, inventoryId, cleanRows) {
  const sheetName = process.env.INVENTORY_DETAIL_SHEET_NAME || "Detalle_Inventario";
  const startRow = await nextSheetRowByColumn(spreadsheetId, accessToken, sheetName, "A");
  const detailId = await nextSheetNumericId(spreadsheetId, accessToken, sheetName, "A");
  const values = cleanRows
    .filter((row) => row.afternoon !== "")
    .map((row, index) => [detailId + index, inventoryId, row.itemId, row.afternoon]);
  if (!values.length) return [];
  const endRow = startRow + values.length - 1;
  const quotedSheet = quoteSheetName(sheetName);
  return [
    {
      range: `${quotedSheet}!A${startRow}:D${endRow}`,
      values
    }
  ];
}

async function inventoryTurnEntryRanges(spreadsheetId, accessToken, { date, employeeId, selectedShifts, cleanRows }) {
  const inventorySheet = process.env.INVENTORY_SHEET_NAME || "Inventario";
  const detailSheet = process.env.INVENTORY_DETAIL_SHEET_NAME || "Detalle_Inventario";
  const firstInventoryId = await nextSheetNumericId(spreadsheetId, accessToken, inventorySheet, "A");
  const firstDetailId = await nextSheetNumericId(spreadsheetId, accessToken, detailSheet, "A");
  const inventoryRow = await nextSheetRowByColumn(spreadsheetId, accessToken, inventorySheet, "A");
  const detailRow = await nextSheetRowByColumn(spreadsheetId, accessToken, detailSheet, "A");
  const orderedShifts = ["dawn", "morning", "afternoon"].filter((shift) => selectedShifts.includes(shift));
  const inventoryIds = Object.fromEntries(orderedShifts.map((shift, index) => [shift, firstInventoryId + index]));
  const inventoryValues = orderedShifts.map((shift) => [
    inventoryIds[shift],
    date,
    inventoryShiftValueLabel(shift),
    employeeId
  ]);
  const detailValues = [];

  orderedShifts.forEach((shift) => {
    cleanRows.forEach((row) => {
      const quantity = row[shift];
      if (quantity === "") return;
      detailValues.push([
        firstDetailId + detailValues.length,
        inventoryIds[shift],
        row.itemId,
        quantity
      ]);
    });
  });

  const ranges = [];
  if (inventoryValues.length) {
    ranges.push({
      range: `${quoteSheetName(inventorySheet)}!A${inventoryRow}:D${inventoryRow + inventoryValues.length - 1}`,
      values: inventoryValues
    });
  }
  if (detailValues.length) {
    ranges.push({
      range: `${quoteSheetName(detailSheet)}!A${detailRow}:D${detailRow + detailValues.length - 1}`,
      values: detailValues
    });
  }

  return {
    ranges,
    inventoryIds,
    detailRowsWritten: detailValues.length
  };
}

function parseNewInventoryRows(values) {
  return values.slice(1)
    .map((row) => ({
      id: Number(row[0]),
      date: parseInventorySheetDate(row[1]),
      turno: cleanSheetInput(row[2]),
      employeeId: cleanSheetInput(row[3])
    }))
    .filter((row) => Number.isFinite(row.id) && row.id > 0);
}

function latestInventoryTurn(rows) {
  return [...rows].sort((a, b) => {
    const dateCompare = (a.date || "").localeCompare(b.date || "");
    if (dateCompare) return dateCompare;
    const shiftCompare = inventoryShiftSortOrder(a.turno) - inventoryShiftSortOrder(b.turno);
    if (shiftCompare) return shiftCompare;
    return a.id - b.id;
  }).at(-1) || null;
}

function inventoryShiftSortOrder(value) {
  const normalized = normalizeInventoryToken(value);
  if (normalized.includes("madrugada") || normalized === "dawn") return 0;
  if (normalized.includes("manana") || normalized.includes("mañana") || normalized === "morning") return 1;
  if (normalized.includes("tarde") || normalized === "afternoon") return 2;
  return 3;
}

function inventoryShiftValueLabel(shift) {
  return {
    dawn: "Madrugada",
    morning: "Mañana",
    afternoon: "Tarde"
  }[shift] || shift;
}

function inventoryItemNameMap() {
  const cache = loadCache();
  const names = new Map([
    ["0", "Contador Alipack"],
    ["3", "Barra_Pop"],
    ["4", "Granel Dulce"]
  ]);

  (cache.tables?.productos?.rows || []).forEach((row) => {
    const itemId = cleanSheetInput(row.id_item);
    const name = cleanSheetInput(row.nombre_producto);
    if (itemId && name) names.set(itemId, name);
  });

  const items = new Map((cache.tables?.items?.rows || []).map((row) => [
    cleanSheetInput(row.id_item),
    {
      originType: cleanSheetInput(row.origen_tipo).toLowerCase(),
      originId: cleanSheetInput(row.id_origen)
    }
  ]));
  const insumos = new Map((cache.tables?.insumos?.rows || []).map((row) => [
    cleanSheetInput(row.id_insumo),
    cleanSheetInput(row.nombre)
  ]));

  items.forEach((item, itemId) => {
    if (!itemId || names.has(itemId)) return;
    if (item.originType === "insumo" && insumos.has(item.originId)) {
      names.set(itemId, insumos.get(item.originId));
    }
  });

  return names;
}

function defaultInventoryItemName(itemId) {
  return itemId ? `Item ${itemId}` : "";
}

function resolveInventoryEmployeeId(value) {
  const text = cleanSheetInput(value);
  if (!text) return "";
  if (/^\d+$/.test(text)) return text;

  const target = normalizeCategory(text);
  const employee = (loadCache().tables?.empleados?.rows || []).find((row) =>
    normalizeCategory(row.nombre_empleado || row.nombre || "") === target
  );
  return cleanSheetInput(employee?.id_empleado) || text;
}

function normalizeInventoryDetailRows(rows) {
  return rows
    .map((row) => ({
      itemId: String(row.itemId || "").trim(),
      afternoon: cleanSheetInput(row.afternoon),
      morning: cleanSheetInput(row.morning),
      dawn: cleanSheetInput(row.dawn)
    }))
    .filter((row) => row.itemId);
}

function normalizeSelectedInventoryShifts(value) {
  const allowed = new Set(["dawn", "morning", "afternoon"]);
  return (Array.isArray(value) ? value : [])
    .map((shift) => String(shift || "").trim())
    .filter((shift, index, shifts) => allowed.has(shift) && shifts.indexOf(shift) === index);
}

function inventoryShiftServerLabel(shift) {
  return {
    dawn: "Turno Madrugada",
    morning: "Turno Mañana",
    afternoon: "Turno Tarde"
  }[shift] || shift;
}

async function extractInventoryFromPhoto({ date, imageDataUrl, rows, selectedShifts = [] }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Falta configurar OPENAI_API_KEY en el backend para leer fotos.");
  }

  const items = rows.map((row) => ({
    itemId: String(row.itemId || ""),
    itemName: String(row.itemName || "")
  }));
  const firstPassTranscription = await transcribeInventoryPhoto(apiKey, imageDataUrl, items, date, selectedShifts);
  const reviewedTranscription = await reviewInventoryPhotoTranscription(apiKey, imageDataUrl, items, date, firstPassTranscription, selectedShifts);
  const firstTranscription = normalizeInventoryPhotoTranscription(firstPassTranscription, selectedShifts);
  const transcription = normalizeInventoryPhotoTranscription(reviewedTranscription, selectedShifts);
  const firstMappedRows = mapTranscriptionToInventoryRows(date, items, firstTranscription, selectedShifts).rows;
  const reviewedMapped = mapTranscriptionToInventoryRows(date, items, transcription, selectedShifts);
  const mappedRows = {
    ...reviewedMapped,
    rows: filterInventoryRowsBySelectedShifts(mergeInventoryPhotoRows(firstMappedRows, reviewedMapped.rows), selectedShifts)
  };

  return {
    rows: mappedRows.rows,
    notes: [
      ...(Array.isArray(transcription.notes) ? transcription.notes : []),
      "Comparado contra primera lectura; diferencias marcadas en naranja.",
      ...mappedRows.notes
    ],
    transcription
  };
}

async function transcribeInventoryPhoto(apiKey, imageDataUrl, items, date, selectedShifts = []) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: inventoryPhotoTranscriptionPrompt(items, date, selectedShifts)
            },
            {
              type: "image_url",
              image_url: { url: imageDataUrl, detail: "high" }
            }
          ]
        }
      ]
    })
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error?.message || "OpenAI no pudo leer la foto.");
  }

  const content = payload.choices?.[0]?.message?.content || "{}";
  return JSON.parse(content);
}

async function reviewInventoryPhotoTranscription(apiKey, imageDataUrl, items, date, transcription, selectedShifts = []) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: inventoryPhotoReviewPrompt(items, date, transcription, selectedShifts)
            },
            {
              type: "image_url",
              image_url: { url: imageDataUrl, detail: "high" }
            }
          ]
        }
      ]
    })
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error?.message || "OpenAI no pudo repasar la lectura de la foto.");
  }

  const content = payload.choices?.[0]?.message?.content || "{}";
  return JSON.parse(content);
}

function inventoryPhotoTranscriptionPrompt(items, targetDate, selectedShifts = []) {
  const targetDateHints = inventoryPhotoDateHints(targetDate).join(", ");
  const activeShiftLabels = selectedShifts.map(inventoryShiftServerLabel).join(", ") || "ninguno";
  return `
Transcribi la tabla completa de una foto de inventario y devolve SOLO JSON valido.

Items esperados, para ayudarte a matchear filas:
${JSON.stringify(items, null, 2)}

Fecha objetivo que despues se va a completar en la app:
${targetDate} (${targetDateHints})

Turnos marcados por el usuario:
${activeShiftLabels}

Objetivo:
- La foto usa el formato nuevo: una sola fecha y tres columnas fijas de turno.
- Las columnas de cantidad se llaman exactamente: Turno Madrugada, Turno Mañana y Turno Tarde.
- Transcribi cada fila con su Id, Nombre y los tres turnos.
- Devolve cada cantidad en el campo que corresponde al encabezado impreso de la columna:
  "turnoMadrugada", "turnoManana" y "turnoTarde".
- Si un turno NO esta marcado por el usuario, devolve ese turno siempre como "" aunque veas algo escrito.

Reglas:
- Matchea nombres aunque haya guiones bajos, espacios o pequenas diferencias.
- La fecha suele estar escrita arriba como d/m/aaaa. Transcribila en "dateLabel".
- La columna "Turno Madrugada" del papel va en "turnoMadrugada".
- La columna "Turno Mañana" del papel va en "turnoManana".
- La columna "Turno Tarde" del papel va en "turnoTarde".
- No corras valores hacia la izquierda: si "Turno Madrugada" esta vacio, "Turno Mañana" sigue siendo "turnoManana" y "Turno Tarde" sigue siendo "turnoTarde".
- Si en una fila la primera columna de turno esta vacia y las dos columnas de la derecha tienen datos, devolve:
  "turnoMadrugada": "", "turnoManana": valor de la columna del medio, "turnoTarde": valor de la columna derecha.
- Si la columna Turno Madrugada esta vacia, NO pongas el valor de Turno Mañana en turnoMadrugada.
- Si la columna Turno Tarde tiene datos, NO la dejes vacia ni la pongas en turnoManana.
- Si un valor es raya, vacio, ilegible o no hay nada escrito, usa string vacio.
- Una raya horizontal, guion o "----" NO ES CERO y NO ES UN NUMERO: siempre debe ser "".
- Lee cada celda de forma independiente, respetando las columnas del papel.
- No copies un dato de Mañana a Tarde ni de Tarde a Mañana.
- El numero 0 escrito a mano si es un valor valido y debe devolverse como "0".
- Transcribi fracciones como decimal, por ejemplo "5 1/2" => "5.5".
- No sumes, no promedies y no completes valores que no se ven.

Formato exacto:
{
  "format": "single_date_shifts",
  "dateLabel": "22/6/2026",
  "shiftColumns": [
    { "key": "dawn", "label": "Turno Madrugada" },
    { "key": "morning", "label": "Turno Mañana" },
    { "key": "afternoon", "label": "Turno Tarde" }
  ],
  "rows": [
    {
      "itemId": "118",
      "itemName": "Barra_Pop_140Ud",
      "turnoMadrugada": "",
      "turnoManana": "55",
      "turnoTarde": "0"
    }
  ],
  "notes": []
}
`;
}

function inventoryPhotoReviewPrompt(items, targetDate, transcription, selectedShifts = []) {
  const activeShiftLabels = selectedShifts.map(inventoryShiftServerLabel).join(", ") || "ninguno";
  return `
Revisa una transcripcion de inventario contra la foto original y devolve SOLO JSON valido corregido.

Fecha objetivo:
${targetDate}

Turnos marcados por el usuario:
${activeShiftLabels}

Items esperados:
${JSON.stringify(items, null, 2)}

Transcripcion inicial:
${JSON.stringify(transcription, null, 2)}

Formato esperado de salida:
{
  "format": "single_date_shifts",
  "dateLabel": "22/6/2026",
  "shiftColumns": [
    { "key": "dawn", "label": "Turno Madrugada" },
    { "key": "morning", "label": "Turno Mañana" },
    { "key": "afternoon", "label": "Turno Tarde" }
  ],
  "rows": [
    {
      "itemId": "118",
      "itemName": "Barra_Pop_140Ud",
      "turnoMadrugada": "",
      "turnoManana": "55",
      "turnoTarde": "0"
    }
  ],
  "uncertainCells": [
    { "itemId": "6", "field": "turnoTarde", "reason": "El numero se ve tenue o parcialmente inclinado." }
  ],
  "notes": ["Repaso automatico realizado."]
}

Reglas de revision:
- No cambies la estructura del JSON.
- Compara celda por celda contra la foto.
- Las columnas del papel son fijas y van en este orden: Turno Madrugada, Turno Mañana, Turno Tarde.
- Si un turno NO esta marcado por el usuario, dejalo siempre como "".
- Si Turno Madrugada esta vacio, dejalo vacio. No corras Turno Mañana hacia Madrugada.
- Si hay un numero visible en Turno Mañana o Turno Tarde, no lo omitas.
- El numero 0 escrito a mano es un dato valido, no es vacio.
- Si una celda esta vacia, devolve "".
- Si una celda tiene una raya, guion o marca de ausencia, devolve "".
- Revisa especialmente filas donde una columna quedo vacia pero en la foto se ve un dato manuscrito.
- Si no estas seguro de una celda, igual devolve el mejor valor posible y agregala a "uncertainCells".
- En "uncertainCells", usa field exactamente como "turnoMadrugada", "turnoManana" o "turnoTarde".
- Marca como dudosa una celda si el numero es tenue, se cruza con una linea, parece corregido, esta cortado o podria confundirse con otro valor.
- No inventes valores que no esten visibles.
`;
}

function mapTranscriptionToInventoryRows(date, items, transcription, selectedShifts = []) {
  if (transcription.format === "single_date_shifts" || Array.isArray(transcription.shiftColumns)) {
    return mapShiftTranscriptionToInventoryRows(items, transcription, selectedShifts);
  }

  if (Array.isArray(transcription.physicalColumns) && transcription.physicalColumns.length) {
    return mapPhysicalTranscriptionToInventoryRows(date, items, transcription);
  }

  const columns = Array.isArray(transcription.columns) ? transcription.columns : [];
  const transcribedRows = Array.isArray(transcription.rows) ? transcription.rows : [];
  const targetDate = inventoryTargetDateParts(date);
  const targetColumn = findTranscribedInventoryDate(targetDate, columns, transcribedRows);

  if (!targetColumn) {
    return {
      rows: [],
      notes: [`No se encontro la fecha ${date} en la transcripcion.`]
    };
  }

  const targetDateLabel = targetColumn.dateLabel;
  const subcolumnCount = Number(targetColumn.subcolumnCount) || 1;
  const mappedRows = items.map((item) => {
    const transcribedRow = findTranscribedInventoryRow(item, transcribedRows);
    const values = valuesForTranscribedDate(transcribedRow, targetDateLabel, targetDate);
    const byShift = quantitiesByShift(values, subcolumnCount);
    return {
      itemId: item.itemId,
      itemName: item.itemName,
      ...byShift
    };
  });

  return {
    rows: mappedRows,
    notes: [`Fecha detectada: ${targetDateLabel}. Subcolumnas usadas: ${subcolumnCount}.`]
  };
}

function mergeInventoryPhotoRows(firstRows, reviewedRows) {
  const reviewedByItem = new Map(reviewedRows.map((row) => [String(row.itemId), row]));
  const firstByItem = new Map(firstRows.map((row) => [String(row.itemId), row]));
  const itemIds = new Set([...firstByItem.keys(), ...reviewedByItem.keys()]);

  return [...itemIds].map((itemId) => {
    const first = firstByItem.get(itemId) || {};
    const reviewed = reviewedByItem.get(itemId) || {};
    const merged = {
      ...first,
      ...reviewed,
      itemId: reviewed.itemId || first.itemId || itemId,
      itemName: reviewed.itemName || first.itemName || "",
      uncertain: { ...(first.uncertain || {}), ...(reviewed.uncertain || {}) }
    };

    ["dawn", "morning", "afternoon"].forEach((field) => {
      const firstValue = normalizeInventoryQuantity(first[field]);
      const reviewedValue = normalizeInventoryQuantity(reviewed[field]);

      if (firstValue && !reviewedValue) {
        merged[field] = firstValue;
        merged.uncertain[field] = "El repaso dejo esta celda vacia, pero la primera lectura vio un dato.";
      } else if (!firstValue && reviewedValue) {
        merged[field] = reviewedValue;
        merged.uncertain[field] = "El dato aparecio solo en el repaso automatico.";
      } else if (firstValue && reviewedValue && firstValue !== reviewedValue) {
        merged[field] = firstValue;
        merged.uncertain[field] = `Primera lectura: ${firstValue}. Repaso: ${reviewedValue}.`;
      } else {
        merged[field] = reviewedValue || firstValue || "";
      }
    });

    return merged;
  });
}

function filterInventoryRowsBySelectedShifts(rows, selectedShifts = []) {
  return rows.map((row) => {
    const values = filterShiftValuesBySelectedShifts([row.dawn, row.morning, row.afternoon], selectedShifts);
    return {
      ...row,
      dawn: values[0],
      morning: values[1],
      afternoon: values[2],
      uncertain: filterInventoryUncertaintyBySelectedShifts(row.uncertain || {}, selectedShifts)
    };
  });
}

function filterInventoryUncertaintyBySelectedShifts(uncertain, selectedShifts = []) {
  const selected = new Set(selectedShifts);
  return Object.fromEntries(Object.entries(uncertain).filter(([field]) => selected.has(field)));
}

function findTranscribedInventoryRow(item, rows) {
  const targetId = String(item.itemId || "");
  const targetName = normalizeInventoryToken(item.itemName);
  return rows.find((row) => String(row.itemId || "") === targetId)
    || rows.find((row) => normalizeInventoryToken(row.itemName || row.name) === targetName)
    || null;
}

function normalizeInventoryPhotoTranscription(transcription, selectedShifts = []) {
  const normalized = transcription && typeof transcription === "object" ? transcription : {};
  const physicalColumns = Array.isArray(normalized.physicalColumns) ? normalized.physicalColumns : [];
  const rows = Array.isArray(normalized.rows) ? normalized.rows : [];

  normalized.rows = rows.map((row) => {
    const valuesByColumn = { ...(row.valuesByColumn || {}) };
    const shiftValues = filterShiftValuesBySelectedShifts(normalizeSingleDateShiftValues(row), selectedShifts);
    physicalColumns.forEach((column) => {
      const key = column.key;
      if (!key) return;
      valuesByColumn[key] = normalizeInventoryQuantity(valuesByColumn[key]);
    });

    return {
      ...row,
      shiftValues,
      dawn: shiftValues[0],
      morning: shiftValues[1],
      afternoon: shiftValues[2],
      valuesByColumn
    };
  });

  return normalized;
}

function mapShiftTranscriptionToInventoryRows(items, transcription, selectedShifts = []) {
  const transcribedRows = Array.isArray(transcription.rows) ? transcription.rows : [];
  const shiftCorrection = detectNewInventoryShiftCorrection(transcribedRows, selectedShifts);
  const uncertainByItem = inventoryUncertaintyByItem(transcription.uncertainCells || [], shiftCorrection);
  const mappedRows = items.map((item) => {
    const transcribedRow = findTranscribedInventoryRow(item, transcribedRows);
    const rawShiftValues = inventoryShiftValues(transcribedRow);
    const shiftValues = filterShiftValuesBySelectedShifts(applyNewInventoryShiftCorrection(rawShiftValues, shiftCorrection), selectedShifts);
    const values = {
      dawn: shiftValues[0],
      morning: shiftValues[1],
      afternoon: shiftValues[2]
    };

    return {
      itemId: item.itemId,
      itemName: item.itemName,
      uncertain: uncertainByItem.get(String(item.itemId)) || {},
      ...values
    };
  });

  return {
    rows: mappedRows,
    notes: [
      shiftCorrection === "dawn_is_morning"
        ? "Chequeo automatico: se detecto que Mañana fue leida como Madrugada. Se reacomodo como Madrugada vacia, Mañana y Tarde."
        : "Turnos leidos por encabezado y respetados."
    ]
  };
}

function inventoryUncertaintyByItem(cells, shiftCorrection) {
  const byItem = new Map();
  if (!Array.isArray(cells)) return byItem;

  cells.forEach((cell) => {
    const itemId = String(cell.itemId || "").trim();
    const field = correctedInventoryUncertaintyField(cell.field, shiftCorrection);
    if (!itemId || !field) return;
    const current = byItem.get(itemId) || {};
    current[field] = String(cell.reason || "Dato a revisar.");
    byItem.set(itemId, current);
  });

  return byItem;
}

function correctedInventoryUncertaintyField(field, shiftCorrection) {
  const normalized = normalizeInventoryToken(field);
  const mapped = {
    turnomadrugada: "dawn",
    madrugada: "dawn",
    dawn: "dawn",
    turnomanana: "morning",
    turnomananã: "morning",
    manana: "morning",
    mananã: "morning",
    mañana: "morning",
    morning: "morning",
    turnotarde: "afternoon",
    tarde: "afternoon",
    afternoon: "afternoon"
  }[normalized];

  if (shiftCorrection !== "dawn_is_morning") return mapped || "";
  if (mapped === "dawn") return "morning";
  if (mapped === "morning" || mapped === "afternoon") return "afternoon";
  return "";
}

function detectNewInventoryShiftCorrection(rows, selectedShifts = []) {
  if (selectedShifts.length) return "";
  const usableRows = rows
    .map(inventoryShiftValues)
    .filter((values) => values.some((value) => value !== ""));

  if (!usableRows.length) return "";

  const dawnUsedRows = usableRows.filter((values) => values[0] !== "").length;
  const morningUsedRows = usableRows.filter((values) => values[1] !== "").length;
  const afternoonUsedRows = usableRows.filter((values) => values[2] !== "").length;
  const likelyMorningAndAfternoonRows = usableRows.filter((values) =>
    values[0] !== "" && (values[1] !== "" || values[2] !== "")
  ).length;

  if (
    dawnUsedRows >= Math.max(3, usableRows.length * 0.6)
    && likelyMorningAndAfternoonRows >= Math.max(3, usableRows.length * 0.6)
    && morningUsedRows + afternoonUsedRows >= dawnUsedRows
  ) {
    return "dawn_is_morning";
  }

  return "";
}

function applyNewInventoryShiftCorrection(values, correction) {
  if (correction !== "dawn_is_morning") return values;
  return [
    "",
    values[0] || "",
    values[2] || values[1] || ""
  ];
}

function filterShiftValuesBySelectedShifts(values, selectedShifts = []) {
  const selected = new Set(selectedShifts);
  const cleanValues = [0, 1, 2].map((index) => normalizeInventoryQuantity(values?.[index]));
  const corrected = [...cleanValues];

  if (!selected.has("dawn") && selected.has("morning") && selected.has("afternoon") && corrected[0]) {
    corrected[2] = corrected[2] || corrected[1];
    corrected[1] = corrected[0];
  } else if (!selected.has("dawn") && selected.has("morning") && corrected[0] && !corrected[1]) {
    corrected[1] = corrected[0];
  }

  if (!selected.has("morning") && selected.has("afternoon") && corrected[1] && !corrected[2]) {
    corrected[2] = corrected[1];
  }

  return [
    selected.has("dawn") ? corrected[0] : "",
    selected.has("morning") ? corrected[1] : "",
    selected.has("afternoon") ? corrected[2] : ""
  ];
}

function normalizeSingleDateShiftValues(row) {
  const explicitValues = [
    normalizeInventoryQuantity(row?.turnoMadrugada ?? row?.madrugada ?? row?.dawn),
    normalizeInventoryQuantity(row?.turnoManana ?? row?.turnoMañana ?? row?.manana ?? row?.mañana ?? row?.morning),
    normalizeInventoryQuantity(row?.turnoTarde ?? row?.tarde ?? row?.afternoon)
  ];

  if (explicitValues.some((value) => value !== "")) {
    return explicitValues;
  }

  if (Array.isArray(row?.shiftValues) && row.shiftValues.length >= 3) {
    return [0, 1, 2].map((index) => normalizeInventoryQuantity(row.shiftValues[index]));
  }

  return ["", "", ""];
}

function inventoryShiftValues(row) {
  if (!row) return ["", "", ""];
  if (Array.isArray(row.shiftValues)) {
    return [0, 1, 2].map((index) => normalizeInventoryQuantity(row.shiftValues[index]));
  }
  return [
    normalizeInventoryQuantity(row.dawn),
    normalizeInventoryQuantity(row.morning),
    normalizeInventoryQuantity(row.afternoon)
  ];
}

function mapPhysicalTranscriptionToInventoryRows(date, items, transcription) {
  const targetDate = inventoryTargetDateParts(date);
  const physicalColumns = transcription.physicalColumns
    .filter((column) => inventoryDateLabelMatches(column.dateLabel, targetDate));

  if (!physicalColumns.length) {
    return {
      rows: [],
      notes: [`No se encontro la fecha ${date} en la transcripcion por columnas.`]
    };
  }

  const transcribedRows = Array.isArray(transcription.rows) ? transcription.rows : [];
  const mappedRows = items.map((item) => {
    const transcribedRow = findTranscribedInventoryRow(item, transcribedRows);
    const values = physicalColumns.map((column) => valueForPhysicalColumn(transcribedRow, column.key));
    const byShift = quantitiesByShift(values, physicalColumns.length);
    return {
      itemId: item.itemId,
      itemName: item.itemName,
      ...byShift
    };
  });

  return {
    rows: mappedRows,
    notes: [`Fecha detectada: ${physicalColumns[0].dateLabel}. Columnas fisicas usadas: ${physicalColumns.length}.`]
  };
}

function valueForPhysicalColumn(row, columnKey) {
  if (!row?.valuesByColumn || typeof row.valuesByColumn !== "object") return "";
  return row.valuesByColumn[columnKey] ?? "";
}

function valuesForTranscribedDate(row, targetDateLabel, targetDate) {
  if (!row?.valuesByDate || typeof row.valuesByDate !== "object") return [];
  const entry = Object.entries(row.valuesByDate)
    .find(([label]) => normalizeInventoryToken(label) === normalizeInventoryToken(targetDateLabel)
      || inventoryDateLabelMatches(label, targetDate));
  return Array.isArray(entry?.[1]) ? entry[1] : [];
}

function quantitiesByShift(values, subcolumnCount) {
  const cleanValues = values.map(normalizeInventoryQuantity);
  if (subcolumnCount >= 3) {
    return {
      dawn: cleanValues[0] || "",
      morning: cleanValues[1] || "",
      afternoon: cleanValues[2] || ""
    };
  }
  if (subcolumnCount === 2) {
    return {
      dawn: "",
      morning: cleanValues[0] || "",
      afternoon: cleanValues[1] || ""
    };
  }
  return {
    dawn: "",
    morning: "",
    afternoon: cleanValues[0] || ""
  };
}

function normalizeInventoryQuantity(value) {
  const text = String(value ?? "").trim().replace(",", ".");
  if (!text || /^[-—–_]+$/.test(text)) return "";
  return text;
}

function normalizeInventoryToken(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_\s-]+/g, "")
    .replace(/[^a-z0-9/]/g, "");
}

function findTranscribedInventoryDate(targetDate, columns, rows) {
  const columnMatch = columns.find((column) => inventoryDateLabelMatches(column.dateLabel, targetDate));
  if (columnMatch) return columnMatch;

  for (const row of rows) {
    if (!row?.valuesByDate || typeof row.valuesByDate !== "object") continue;
    const match = Object.entries(row.valuesByDate)
      .find(([label]) => inventoryDateLabelMatches(label, targetDate));
    if (match) {
      const values = Array.isArray(match[1]) ? match[1] : [];
      return {
        dateLabel: match[0],
        subcolumnCount: values.length || 1
      };
    }
  }

  return null;
}

function inventoryTargetDateParts(date) {
  const [year, month, day] = String(date || "").split("-").map(Number);
  return {
    day,
    month,
    year
  };
}

function inventoryDateLabelMatches(label, targetDate) {
  const parts = parseInventoryDateLabel(label, targetDate.year);
  if (!parts) return false;
  if (parts.day !== targetDate.day || parts.month !== targetDate.month) return false;
  return !parts.year || parts.year === targetDate.year;
}

function parseInventoryDateLabel(label, fallbackYear) {
  const text = String(label || "").trim();
  const numbers = text.match(/\d+/g) || [];
  if (numbers.length >= 2) {
    return {
      day: Number(numbers[0]),
      month: Number(numbers[1]),
      year: normalizeInventoryYear(numbers[2], fallbackYear)
    };
  }

  const compact = text.replace(/\D/g, "");
  if (compact.length === 6) {
    return {
      day: Number(compact.slice(0, 2)),
      month: Number(compact.slice(2, 4)),
      year: normalizeInventoryYear(compact.slice(4, 6), fallbackYear)
    };
  }
  if (compact.length === 8) {
    return {
      day: Number(compact.slice(0, 2)),
      month: Number(compact.slice(2, 4)),
      year: normalizeInventoryYear(compact.slice(4, 8), fallbackYear)
    };
  }

  return null;
}

function normalizeInventoryYear(value, fallbackYear) {
  if (value === undefined || value === null || value === "") return fallbackYear;
  const year = Number(value);
  if (!Number.isFinite(year)) return fallbackYear;
  return year < 100 ? 2000 + year : year;
}

function inventoryPhotoDateHints(date) {
  const [year, month, day] = date.split("-");
  const shortYear = year.slice(2);
  return [
    `${Number(day)}/${Number(month)}/${shortYear}`,
    `${Number(day)}/${Number(month)}/${year}`,
    `${day}/${month}/${shortYear}`,
    `${day}/${month}/${year}`
  ];
}

async function nextInventoryEntryRange(spreadsheetId, accessToken) {
  const sheetName = process.env.INVENTORY_SHEET_NAME || "Inventario";
  const dateColumn = process.env.INVENTORY_DATE_COLUMN || "B";
  const employeeColumn = process.env.INVENTORY_EMPLOYEE_COLUMN || "C";
  const columnRange = `${quoteSheetName(sheetName)}!${employeeColumn}:${employeeColumn}`;
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(columnRange)}?majorDimension=ROWS`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error?.message || "No se pudo leer la columna de empleados.");
  }

  const nextRow = Math.max((payload.values || []).length + 1, 2);
  return `${quoteSheetName(sheetName)}!${dateColumn}${nextRow}:${employeeColumn}${nextRow}`;
}

async function nextSheetRowByColumn(spreadsheetId, accessToken, sheetName, column) {
  const range = `${quoteSheetName(sheetName)}!${column}:${column}`;
  const payload = await sheetsGetValues(spreadsheetId, accessToken, range);
  return Math.max((payload.values || []).length + 1, 2);
}

async function nextSheetNumericId(spreadsheetId, accessToken, sheetName, column) {
  const range = `${quoteSheetName(sheetName)}!${column}:${column}`;
  const payload = await sheetsGetValues(spreadsheetId, accessToken, range);
  const ids = (payload.values || [])
    .flat()
    .map((value) => Number(value))
    .filter(Number.isFinite);
  return Math.max(0, ...ids) + 1;
}

async function sheetsGetValues(spreadsheetId, accessToken, range) {
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?majorDimension=ROWS`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error?.message || "No se pudo leer Google Sheets.");
  }

  return payload;
}

async function sheetTitleByGid(spreadsheetId, accessToken, gid) {
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(sheetId,title))`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error?.message || "No se pudo leer la estructura de Google Sheets.");
  }

  const requestedGid = Number(gid || 0);
  const sheet = (payload.sheets || []).find((entry) => Number(entry.properties?.sheetId) === requestedGid)
    || (payload.sheets || [])[0];

  if (!sheet?.properties?.title) {
    throw new Error("No se encontro la pestana solicitada.");
  }

  return sheet.properties.title;
}

async function sheetsBatchUpdate(spreadsheetId, accessToken, data) {
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        valueInputOption: "USER_ENTERED",
        data
      })
    }
  );
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error?.message || "Google Sheets rechazo la carga.");
  }

  return payload;
}

function configuredSpreadsheetId() {
  const spreadsheetId = process.env.INVENTORY_SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error("Falta configurar INVENTORY_SPREADSHEET_ID en el backend.");
  }
  return spreadsheetId;
}

function cleanSheetInput(value) {
  return String(value ?? "").trim();
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00`);
  return !Number.isNaN(date.getTime()) && value === date.toISOString().slice(0, 10);
}

function parseInventorySheetDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";

  if (isIsoDate(text)) return text;

  const slashMatch = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (slashMatch) {
    const day = Number(slashMatch[1]);
    const month = Number(slashMatch[2]);
    const year = normalizeInventoryYear(slashMatch[3], new Date().getFullYear());
    return validDatePartsToIso(year, month, day);
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return validDatePartsToIso(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
  }

  return "";
}

function validDatePartsToIso(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return "";
  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0")
  ].join("-");
}

function nextBusinessDayIso(lastIso) {
  const date = lastIso ? new Date(`${lastIso}T00:00:00`) : new Date();
  if (lastIso) date.setDate(date.getDate() + 1);
  while ([0, 6].includes(date.getDay())) {
    date.setDate(date.getDate() + 1);
  }
  return validDatePartsToIso(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function quoteSheetName(sheetName) {
  return `'${sheetName.replace(/'/g, "''")}'`;
}

async function googleAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedGoogleToken && cachedGoogleToken.expiresAt > now + 60) {
    return cachedGoogleToken.token;
  }

  const credentials = googleCredentials();
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const claim = base64UrlJson({
    iss: credentials.clientEmail,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  });
  const unsignedJwt = `${header}.${claim}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsignedJwt)
    .sign(credentials.privateKey);
  const assertion = `${unsignedJwt}.${base64Url(signature)}`;

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const payload = await tokenResponse.json().catch(() => ({}));

  if (!tokenResponse.ok) {
    throw new Error(payload.error_description || payload.error || "No se pudo autenticar con Google.");
  }

  cachedGoogleToken = {
    token: payload.access_token,
    expiresAt: now + Number(payload.expires_in || 3600)
  };
  return cachedGoogleToken.token;
}

function googleCredentials() {
  const credentialsFile = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (credentialsFile && fs.existsSync(credentialsFile)) {
    const parsed = JSON.parse(fs.readFileSync(credentialsFile, "utf8"));
    return {
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key
    };
  }

  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!clientEmail || !privateKey) {
    throw new Error("Faltan credenciales de Google Sheets en el backend.");
  }

  return { clientEmail, privateKey };
}

function base64UrlJson(value) {
  return base64Url(Buffer.from(JSON.stringify(value)));
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function readJsonBody(request) {
  const maxBodySize = 15 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > maxBodySize) {
        reject(new Error("Body demasiado grande."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("JSON invalido."));
      }
    });
    request.on("error", reject);
  });
}

function googleSheetCsvUrl(rawUrl, cacheBust = false) {
  const url = new URL(rawUrl);
  if (url.hostname !== "docs.google.com") {
    if (cacheBust) url.searchParams.set("_", String(Date.now()));
    return url.toString();
  }

  if (url.pathname.includes("/pub")) {
    url.pathname = url.pathname.replace("/pubhtml", "/pub");
    url.searchParams.set("output", "csv");
    if (cacheBust) url.searchParams.set("_", String(Date.now()));
    return url.toString();
  }

  const sheetMatch = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!sheetMatch) return rawUrl;

  const spreadsheetId = sheetMatch[1];
  const hashGid = url.hash.match(/gid=(\d+)/)?.[1];
  const gid = url.searchParams.get("gid") || hashGid || "0";
  const csvUrl = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export`);
  csvUrl.searchParams.set("format", "csv");
  csvUrl.searchParams.set("gid", gid);
  if (cacheBust) csvUrl.searchParams.set("_", String(Date.now()));
  return csvUrl.toString();
}

function googleSheetReference(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.hostname !== "docs.google.com") return null;
  const sheetMatch = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!sheetMatch) return null;

  return {
    spreadsheetId: sheetMatch[1],
    gid: url.searchParams.get("gid") || url.hash.match(/gid=(\d+)/)?.[1] || "0"
  };
}

function rowsToCsv(rows) {
  return rows
    .map((row) => row.map(csvCell).join(","))
    .join("\n");
}

function csvCell(value) {
  const text = String(value ?? "");
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  rows.push(row);
  return rows;
}

function findSpreadsheetCellErrors(rows, kind) {
  const errors = [];
  const headers = normalizedHeadersWithFallback(rows[0] || []);
  rows.forEach((cells, rowIndex) => {
    cells.forEach((cell, columnIndex) => {
      const value = String(cell || "").trim();
      if (!isSpreadsheetErrorValue(value)) return;
      errors.push({
        source: labelForKind(kind),
        row: rowIndex + 1,
        cell: headers[columnIndex] || `Columna ${columnIndex + 1}`,
        raw: value
      });
    });
  });
  return errors;
}

function normalizedHeadersWithFallback(headers) {
  return headers.map((header, index) => normalizeHeader(header) || `columna_${index + 1}`);
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeOriginType(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text.includes("subproducto")) return "subproducto";
  if (text.includes("producto")) return "producto";
  if (text.includes("insumo")) return "insumo";
  return text;
}

function dedupeBackendRows(cache, tableName, key) {
  const table = cache.tables?.[tableName];
  if (!table?.rows) return;
  const seen = new Set();
  table.rows = table.rows.filter((row) => {
    const value = String(row[key] || "").trim();
    if (!value) return true;
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
  table.rowCount = table.rows.length;
}

function isSpreadsheetErrorValue(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) return false;
  return (
    [
      "#N/A",
      "#VALUE!",
      "#REF!",
      "#DIV/0!",
      "#ERROR!",
      "#NAME?",
      "#NUM!",
      "#NULL!",
      "#¡VALOR!",
      "#¡REF!",
      "#¡DIV/0!",
      "#¿NOMBRE?",
      "#¡NUM!",
      "#¡NULO!"
    ].includes(normalized) ||
    /^#[A-ZÁÉÍÓÚÑ¿?¡!0-9/]+$/.test(normalized)
  );
}

function labelForKind(kind) {
  return {
    expenses: "Egresos",
    sales: "Ventas",
    orderDetails: "Detalle pedidos",
    inventory: "Inventario",
    inventoryDetails: "Detalle inventario",
    payroll: "Sueldos",
    cash: "Caja",
    issuedChecks: "Cheques entregados",
    receivedChecks: "Cheques recibidos",
    creditors: "Acreedores",
    purchases: "Compras",
    purchaseDetails: "Detalle compras",
    providers: "Proveedores",
    recipes: "Recetas",
    itemInfo: "Items",
    supplyInfo: "Insumos"
  }[kind] || kind;
}

function serveStaticFile(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.normalize(path.join(ROOT_DIR, requestedPath));

  if (!filePath.startsWith(ROOT_DIR)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store, max-age=0"
    });
    response.end(content);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) return;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  });
}

