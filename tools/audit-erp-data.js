"use strict";

/*
 * Auditoria de solo lectura para el cache central del ERP.
 *
 * El reporte funcional necesita distinguir entre una columna opcional vacia y
 * una relacion que deberia existir. Por eso este script combina perfiles
 * genericos con controles de negocio explicitos. Nunca modifica el cache.
 */

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const CACHE_FILE = path.join(ROOT_DIR, "tmp", "backend-data-cache.json");
const OUTPUT_FILE = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT_DIR, "tmp", "erp-data-audit.json");

const FOREIGN_KEYS = {
  acreedores_etiquetas: {
    id_acreedor: ["acreedores", "id_acreedor"],
    id_etiqueta: ["etiquetas", "id_etiqueta"]
  },
  clientes: { id_canal: ["canales", "id_canal"] },
  datos_bancarios: {
    id_acreedor: ["acreedores", "id_acreedor"],
    id_etiqueta: ["etiquetas", "id_etiqueta"]
  },
  movimientos_bancarios: {
    id_pago: ["pagos", "id_pago"],
    id_cobro: ["cobros", "id_cobro"]
  },
  productos: { id_item: ["items", "id_item"] },
  subproductos: { id_item: ["items", "id_item"] },
  insumos_proveedores: {
    id_insumo: ["insumos", "id_insumo"],
    id_proveedor: ["proveedores", "id_proveedor"]
  },
  recetas: {
    id_item_resultado: ["items", "id_item"],
    id_item_componente: ["items", "id_item"]
  },
  pedidos: { id_cliente: ["clientes", "id_cliente"] },
  detalle_pedidos: {
    id_pedido: ["pedidos", "id_pedido"],
    id_producto: ["productos", "id_producto"]
  },
  entregas: {
    id_flete: ["fletes", "id_flete"],
    id_acreedor_etiqueta: ["acreedores_etiquetas", "id_acreedor_etiqueta"],
    id_egreso: ["egresos", "id_egreso"]
  },
  entregas_detalle: {
    id_entrega: ["entregas", "id_entrega"],
    id_pedido: ["pedidos", "id_pedido"]
  },
  ventas: {
    id_pedido: ["pedidos", "id_pedido"],
    id_cliente: ["clientes", "id_cliente"],
    id_entrega: ["entregas", "id_entrega"]
  },
  cobros: { id_cliente: ["clientes", "id_cliente"] },
  cobros_detalle: {
    id_cobro: ["cobros", "id_cobro"],
    id_venta: ["ventas", "id_venta"]
  },
  retenciones_ganancias: {
    id_cobro: ["cobros", "id_cobro"],
    id_cliente: ["clientes", "id_cliente"]
  },
  retenciones_iibb: {
    id_cobro: ["cobros", "id_cobro"],
    id_cliente: ["clientes", "id_cliente"]
  },
  cheques_entregados: {
    id_pago: ["pagos", "id_pago"],
    id_acreedor: ["acreedores", "id_acreedor"]
  },
  cheques_recibidos: {
    id_cobro: ["cobros", "id_cobro"],
    id_cliente: ["clientes", "id_cliente"]
  },
  compras: { id_proveedor: ["proveedores", "id_proveedor"] },
  detalle_compras: {
    id_compra: ["compras", "id_compra"],
    id_insumos_proveedores: ["insumos_proveedores", "id_insumos_proveedores"]
  },
  recepciones: {
    id_empleado: ["empleados", "id_empleado"],
    id_compra: ["compras", "id_compra"],
    id_acreedor_etiqueta: ["acreedores_etiquetas", "id_acreedor_etiqueta"],
    id_egreso: ["egresos", "id_egreso"]
  },
  detalle_recepciones: {
    id_recepcion: ["recepciones", "id_recepcion"],
    id_insumo: ["insumos", "id_insumo"]
  },
  otros_gastos: {
    id_acreedor: ["acreedores", "id_acreedor"],
    id_acreedor_etiqueta: ["acreedores_etiquetas", "id_acreedor_etiqueta"],
    id_egreso: ["egresos", "id_egreso"]
  },
  egresos: { id_etiqueta: ["etiquetas", "id_etiqueta"] },
  detalle_pagos: {
    id_pago: ["pagos", "id_pago"],
    id_egreso: ["egresos", "id_egreso"]
  },
  sueldos: {
    id_empleado: ["empleados", "id_empleado"],
    id_acreedor_etiqueta: ["acreedores_etiquetas", "id_acreedor_etiqueta"],
    id_egreso: ["egresos", "id_egreso"]
  },
  comisiones: {
    id_canal: ["canales", "id_canal"],
    id_acreedor_etiqueta: ["acreedores_etiquetas", "id_acreedor_etiqueta"],
    id_venta: ["ventas", "id_venta"]
  },
  inventarios: { id_empleado: ["empleados", "id_empleado"] },
  detalle_inventarios: {
    id_inventario: ["inventarios", "id_inventario"],
    id_item: ["items", "id_item"]
  }
};

const OPTIONAL_FOREIGN_KEYS = new Set([
  "clientes.id_canal",
  "movimientos_bancarios.id_pago",
  "movimientos_bancarios.id_cobro",
  "entregas.id_acreedor_etiqueta",
  "entregas.id_egreso",
  "ventas.id_entrega",
  "cheques_entregados.id_acreedor",
  "cheques_recibidos.id_cliente",
  "recepciones.id_acreedor_etiqueta",
  "recepciones.id_egreso",
  "otros_gastos.id_acreedor_etiqueta",
  "otros_gastos.id_egreso",
  "sueldos.id_acreedor_etiqueta",
  "sueldos.id_egreso",
  "comisiones.id_acreedor_etiqueta"
]);

const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
const tables = cache.tables || {};
const headerCache = new Map();
const indexCache = new Map();

function rows(tableName) {
  return Array.isArray(tables[tableName]?.rows) ? tables[tableName].rows : [];
}

function headers(tableName) {
  if (headerCache.has(tableName)) return headerCache.get(tableName);
  const configured = tables[tableName]?.headers || [];
  const discovered = new Set(configured);
  rows(tableName).forEach((row) => {
    Object.keys(row || {}).filter((key) => !key.startsWith("_")).forEach((key) => discovered.add(key));
  });
  const tableHeaders = [...discovered];
  headerCache.set(tableName, tableHeaders);
  return tableHeaders;
}

function id(value) {
  return String(value ?? "").trim().replace(/\.0+$/, "");
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function number(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const raw = String(value ?? "").trim().replace(/\s/g, "").replace(/\$/g, "");
  if (!raw) return 0;
  const commaIndex = raw.lastIndexOf(",");
  const dotIndex = raw.lastIndexOf(".");
  let normalizedNumber = raw;
  if (commaIndex >= 0 && dotIndex >= 0) {
    normalizedNumber = commaIndex > dotIndex
      ? raw.replace(/\./g, "").replace(",", ".")
      : raw.replace(/,/g, "");
  } else if (commaIndex >= 0) {
    normalizedNumber = /,\d{1,2}$/.test(raw) ? raw.replace(",", ".") : raw.replace(/,/g, "");
  }
  const parsed = Number(normalizedNumber);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalized(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseDate(value) {
  if (isBlank(value)) return null;
  const text = String(value).trim();
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return validDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
  match = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    return validDateParts(year, Number(match[2]), Number(match[1]));
  }
  match = text.match(/^(\d{4})(\d{2})$/);
  if (match) return validDateParts(Number(match[1]), Number(match[2]), 1);
  return null;
}

function validDateParts(year, month, day) {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function indexFor(tableName, key) {
  const cacheKey = `${tableName}.${key}`;
  if (!indexCache.has(cacheKey)) {
    indexCache.set(cacheKey, new Set(rows(tableName).map((row) => id(row[key])).filter(Boolean)));
  }
  return indexCache.get(cacheKey);
}

function samples(values, limit = 8) {
  return [...new Set(values.map((value) => String(value)))].slice(0, limit);
}

function tableProfile(tableName, table) {
  const tableRows = rows(tableName);
  const tableHeaders = headers(tableName);
  const primaryKey = tableHeaders[0] || "";
  const columnProfiles = tableHeaders.map((column) => {
    const populated = tableRows.filter((row) => !isBlank(row[column])).length;
    return {
      column,
      populated,
      blank: tableRows.length - populated,
      fillRate: tableRows.length ? Number((populated / tableRows.length * 100).toFixed(2)) : 0,
      completelyEmpty: populated === 0
    };
  });
  const ids = tableRows.map((row) => id(row[primaryKey])).filter(Boolean);
  const idCounts = ids.reduce((map, value) => map.set(value, (map.get(value) || 0) + 1), new Map());
  const duplicateIds = [...idCounts.entries()].filter(([, count]) => count > 1);
  const effectivelyEmptyRows = tableRows.filter((row) => (
    tableHeaders.every((column) => isBlank(row[column]))
  )).length;
  const dateIssues = [];
  tableHeaders.filter((column) => /fecha|^mes$/.test(column)).forEach((column) => {
    const invalid = tableRows
      .filter((row) => !isBlank(row[column]) && !parseDate(row[column]))
      .map((row) => row[column]);
    if (invalid.length) dateIssues.push({ column, count: invalid.length, samples: samples(invalid) });
  });
  return {
    name: tableName,
    rowCount: tableRows.length,
    columnCount: tableHeaders.length,
    primaryKey,
    blankPrimaryKeys: tableRows.filter((row) => isBlank(row[primaryKey])).length,
    duplicatePrimaryKeyValues: duplicateIds.length,
    duplicatePrimaryKeyRows: duplicateIds.reduce((total, [, count]) => total + count, 0),
    duplicatePrimaryKeySamples: duplicateIds.slice(0, 10).map(([value, count]) => ({ value, count })),
    effectivelyEmptyRows,
    completelyEmptyColumns: columnProfiles.filter((column) => column.completelyEmpty).map((column) => column.column),
    columns: columnProfiles,
    invalidDates: dateIssues,
    source: table.source || null
  };
}

function foreignKeyAudit() {
  const findings = [];
  Object.entries(FOREIGN_KEYS).forEach(([tableName, relations]) => {
    Object.entries(relations).forEach(([column, [targetTable, targetColumn]]) => {
      const targetIds = indexFor(targetTable, targetColumn);
      const sourceRows = rows(tableName);
      const blankRows = sourceRows.filter((row) => isBlank(row[column]));
      const orphanRows = sourceRows.filter((row) => !isBlank(row[column]) && !targetIds.has(id(row[column])));
      findings.push({
        relation: `${tableName}.${column} -> ${targetTable}.${targetColumn}`,
        sourceRows: sourceRows.length,
        blank: blankRows.length,
        blankIsOptional: OPTIONAL_FOREIGN_KEYS.has(`${tableName}.${column}`),
        orphan: orphanRows.length,
        orphanSamples: orphanRows.slice(0, 8).map((row) => ({
          primaryId: id(row[headers(tableName)[0]]),
          value: row[column]
        }))
      });
    });
  });
  return findings;
}

function creditorOriginAudit() {
  const originTables = {
    proveedor: ["proveedores", "id_proveedor", "nombre"],
    empleado: ["empleados", "id_empleado", "nombre_empleado"],
    canal: ["canales", "id_canal", "nombre"],
    flete: ["fletes", "id_flete", "nombre_flete"],
    otros_acreedores: ["otros_acreedores", "id_otro_acreedor", "nombre_otro_acreedor"],
    otro_acreedor: ["otros_acreedores", "id_otro_acreedor", "nombre_otro_acreedor"]
  };
  const invalid = [];
  rows("acreedores").forEach((row) => {
    const type = normalized(row.origen_tipo_acreedor).replace(/ /g, "_");
    const relation = originTables[type];
    if (!relation) {
      invalid.push({ id_acreedor: row.id_acreedor, type: row.origen_tipo_acreedor, originId: row.origen_id_acreedor, reason: "tipo no reconocido" });
      return;
    }
    if (!indexFor(relation[0], relation[1]).has(id(row.origen_id_acreedor))) {
      invalid.push({ id_acreedor: row.id_acreedor, type: row.origen_tipo_acreedor, originId: row.origen_id_acreedor, reason: `no existe en ${relation[0]}` });
    }
  });
  return invalid;
}

function duplicateBusinessKeys() {
  const definitions = [
    ["acreedores_etiquetas", ["id_acreedor", "id_etiqueta"]],
    ["datos_bancarios", ["detalle", "id_acreedor", "id_etiqueta"]],
    ["insumos_proveedores", ["id_insumo", "id_proveedor", "ud_proveedor"]],
    ["pedidos", ["id_cliente", "fecha_pedido", "fecha_entrega"]],
    ["entregas_detalle", ["id_entrega", "id_pedido"]],
    ["cobros_detalle", ["id_cobro", "id_venta"]],
    ["detalle_compras", ["id_compra", "id_insumos_proveedores"]],
    ["recepciones", ["id_compra"]],
    ["detalle_recepciones", ["id_recepcion", "id_insumo"]],
    ["detalle_pagos", ["id_pago", "id_egreso"]],
    ["sueldos", ["id_empleado", "fecha"]],
    ["inventarios", ["fecha", "turno"]],
    ["detalle_inventarios", ["id_inventario", "id_item"]],
    ["egresos", ["fecha_factura", "nro_factura", "total"]],
    ["ventas", ["fecha_factura", "nro_factura", "total"]],
    ["cheques_entregados", ["nro_cheque", "banco"]],
    ["cheques_recibidos", ["nro_cheque", "banco"]]
  ];
  return definitions.map(([tableName, columns]) => {
    const counts = new Map();
    rows(tableName).forEach((row) => {
      const parts = columns.map((column) => normalized(row[column]));
      if (parts.some((part) => !part)) return;
      const key = parts.join("|");
      if (!counts.has(key)) counts.set(key, []);
      counts.get(key).push(id(row[headers(tableName)[0]]));
    });
    const duplicates = [...counts.entries()].filter(([, ids]) => ids.length > 1);
    return {
      table: tableName,
      columns,
      duplicateGroups: duplicates.length,
      affectedRows: duplicates.reduce((total, [, ids]) => total + ids.length, 0),
      samples: duplicates.slice(0, 8).map(([key, ids]) => ({ key, ids }))
    };
  });
}

function aggregateBy(rowsToAggregate, keyColumn, amountColumn) {
  const totals = new Map();
  rowsToAggregate.forEach((row) => {
    const key = id(row[keyColumn]);
    if (!key) return;
    totals.set(key, (totals.get(key) || 0) + number(row[amountColumn]));
  });
  return totals;
}

function financialAudit() {
  const paidByExpense = aggregateBy(rows("detalle_pagos"), "id_egreso", "monto_cancelado");
  const collectedBySale = aggregateBy(rows("cobros_detalle"), "id_venta", "monto_cancelado");
  const egressBalances = rows("egresos").map((row) => {
    const total = number(row.total);
    const paid = paidByExpense.get(id(row.id_egreso)) || 0;
    return { id: id(row.id_egreso), total, paid, balance: total - paid };
  });
  const saleBalances = rows("ventas").map((row) => {
    const total = number(row.total);
    const collected = collectedBySale.get(id(row.id_venta)) || 0;
    return { id: id(row.id_venta), total, collected, balance: total - collected };
  });
  const egressArithmetic = rows("egresos").filter((row) => {
    const expected = number(row.subtotal) + number(row.iva) + number(row.per_ret_iva) + number(row.per_ret_iibb) + number(row.imp_internos);
    return Math.abs(number(row.total) - expected) > 1;
  });
  const salesArithmetic = rows("ventas").filter((row) => (
    Math.abs(number(row.total) - number(row.subtotal) - number(row.iva)) > 1
  ));
  return {
    egresses: {
      count: egressBalances.length,
      total: sum(egressBalances.map((row) => row.total)),
      paid: sum(egressBalances.map((row) => row.paid)),
      outstanding: sum(egressBalances.filter((row) => row.balance > 0.01).map((row) => row.balance)),
      outstandingCount: egressBalances.filter((row) => row.balance > 0.01).length,
      overpaidCount: egressBalances.filter((row) => row.balance < -0.01).length,
      overpaidAmount: Math.abs(sum(egressBalances.filter((row) => row.balance < -0.01).map((row) => row.balance))),
      arithmeticMismatchCount: egressArithmetic.length,
      arithmeticMismatchSamples: egressArithmetic.slice(0, 8).map((row) => row.id_egreso)
    },
    sales: {
      count: saleBalances.length,
      total: sum(saleBalances.map((row) => row.total)),
      collected: sum(saleBalances.map((row) => row.collected)),
      outstanding: sum(saleBalances.filter((row) => row.balance > 0.01).map((row) => row.balance)),
      outstandingCount: saleBalances.filter((row) => row.balance > 0.01).length,
      overCollectedCount: saleBalances.filter((row) => row.balance < -0.01).length,
      overCollectedAmount: Math.abs(sum(saleBalances.filter((row) => row.balance < -0.01).map((row) => row.balance))),
      arithmeticMismatchCount: salesArithmetic.length,
      arithmeticMismatchSamples: salesArithmetic.slice(0, 8).map((row) => row.id_venta)
    }
  };
}

function sourceLinkAudit() {
  const sourceDefinitions = [
    ["recepciones", "id_recepcion"],
    ["entregas", "id_entrega"],
    ["otros_gastos", "id_otros_gastos"],
    ["sueldos", "id_sueldo"],
    ["comisiones", "id_comision"]
  ];
  const linkedEgressIds = new Set();
  const sourceTables = sourceDefinitions.map(([tableName, primaryKey]) => {
    const tableRows = rows(tableName);
    const missing = tableRows.filter((row) => isBlank(row.id_egreso));
    const linked = tableRows.filter((row) => !isBlank(row.id_egreso));
    linked.forEach((row) => linkedEgressIds.add(id(row.id_egreso)));
    return {
      table: tableName,
      rows: tableRows.length,
      linkedToEgress: linked.length,
      withoutEgress: missing.length,
      withoutEgressSamples: missing.slice(0, 8).map((row) => id(row[primaryKey]))
    };
  });
  const egressRows = rows("egresos");
  const withoutSource = egressRows.filter((row) => !linkedEgressIds.has(id(row.id_egreso)));
  return {
    sources: sourceTables,
    egressesWithoutReverseSource: withoutSource.length,
    egressesWithoutReverseSourceSamples: withoutSource.slice(0, 20).map((row) => id(row.id_egreso))
  };
}

function inventoryAudit() {
  const inventoryRows = rows("inventarios");
  const detailRows = rows("detalle_inventarios");
  const detailByInventory = new Map();
  detailRows.forEach((row) => {
    const key = id(row.id_inventario);
    if (!detailByInventory.has(key)) detailByInventory.set(key, []);
    detailByInventory.get(key).push(row);
  });
  const valuedInventories = inventoryRows.map((row) => ({
    id: id(row.id_inventario),
    date: parseDate(row.fecha),
    shift: row.turno,
    value: number(row.valor_total),
    detailRows: (detailByInventory.get(id(row.id_inventario)) || []).length
  }));
  const positiveValues = valuedInventories.filter((row) => row.value > 0).map((row) => row.value).sort((a, b) => a - b);
  return {
    inventories: inventoryRows.length,
    detailRows: detailRows.length,
    withoutDetails: valuedInventories.filter((row) => row.detailRows === 0).length,
    zeroOrBlankValue: valuedInventories.filter((row) => row.value <= 0).length,
    negativeDetailQuantity: detailRows.filter((row) => number(row.cantidad) < 0).length,
    negativeDetailValue: detailRows.filter((row) => number(row.valor_total) < 0).length,
    zeroCostWithQuantity: detailRows.filter((row) => number(row.cantidad) !== 0 && number(row.costo_unitario_usado) === 0).length,
    medianPositiveInventoryValue: percentile(positiveValues, 0.5),
    percentile95InventoryValue: percentile(positiveValues, 0.95),
    maximumInventoryValue: positiveValues.at(-1) || 0,
    maximumInventorySamples: valuedInventories.sort((a, b) => b.value - a.value).slice(0, 10)
  };
}

function operationalAudit() {
  const receivedPurchaseIds = new Set(rows("recepciones").map((row) => id(row.id_compra)).filter(Boolean));
  const deliveredOrderIds = new Set(rows("entregas_detalle").map((row) => id(row.id_pedido)).filter(Boolean));
  const invoicedOrderIds = new Set(rows("ventas").map((row) => id(row.id_pedido)).filter(Boolean));
  const detailsByOrder = new Set(rows("detalle_pedidos").map((row) => id(row.id_pedido)).filter(Boolean));
  return {
    purchasesWithoutReception: rows("compras").filter((row) => !receivedPurchaseIds.has(id(row.id_compra))).length,
    purchasesWithoutDetail: rows("compras").filter((row) => !rows("detalle_compras").some((detail) => id(detail.id_compra) === id(row.id_compra))).length,
    ordersWithoutDetail: rows("pedidos").filter((row) => !detailsByOrder.has(id(row.id_pedido))).length,
    ordersWithoutDelivery: rows("pedidos").filter((row) => !deliveredOrderIds.has(id(row.id_pedido))).length,
    ordersWithoutSale: rows("pedidos").filter((row) => !invoicedOrderIds.has(id(row.id_pedido))).length,
    deliveriesWithoutEgress: rows("entregas").filter((row) => isBlank(row.id_egreso)).length,
    receptionsWithoutEgress: rows("recepciones").filter((row) => isBlank(row.id_egreso)).length,
    salariesWithoutEgress: rows("sueldos").filter((row) => isBlank(row.id_egreso)).length,
    otherExpensesWithoutEgress: rows("otros_gastos").filter((row) => isBlank(row.id_egreso)).length,
    commissionsWithoutRows: rows("comisiones").length === 0,
    bankMovementsWithoutRows: rows("movimientos_bancarios").length === 0,
    bankIdentityRulesWithoutRows: rows("datos_bancarios").length === 0
  };
}

function masterDataAudit() {
  const duplicateNameDefinitions = [
    ["proveedores", "nombre"],
    ["clientes", "nombre_cliente"],
    ["empleados", "nombre_empleado"],
    ["canales", "nombre"],
    ["fletes", "nombre_flete"],
    ["otros_acreedores", "nombre_otro_acreedor"],
    ["productos", "nombre_producto"],
    ["subproductos", "nombre_subproducto"],
    ["insumos", "nombre"]
  ];
  const duplicateNames = duplicateNameDefinitions.map(([tableName, column]) => {
    const map = new Map();
    rows(tableName).forEach((row) => {
      const key = normalized(row[column]);
      if (!key) return;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ id: id(row[headers(tableName)[0]]), value: row[column] });
    });
    const duplicates = [...map.values()].filter((group) => group.length > 1);
    return { table: tableName, column, duplicateGroups: duplicates.length, samples: duplicates.slice(0, 8) };
  });
  const missingPnl = rows("etiquetas").filter((row) => isBlank(row.categoria_pnl));
  const suppliesWithoutProvider = rows("insumos").filter((supply) => (
    !rows("insumos_proveedores").some((relation) => id(relation.id_insumo) === id(supply.id_insumo))
  ));
  return {
    duplicateNames,
    creditorOriginIssues: creditorOriginAudit(),
    labelsWithoutPnlCategory: missingPnl.length,
    labelsWithoutPnlCategorySamples: missingPnl.slice(0, 10).map((row) => ({ id: row.id_etiqueta, name: row.etiqueta })),
    suppliesWithoutProvider: suppliesWithoutProvider.length,
    suppliesWithoutProviderSamples: suppliesWithoutProvider.slice(0, 10).map((row) => ({ id: row.id_insumo, name: row.nombre })),
    supplierRelationsWithoutPrice: rows("insumos_proveedores").filter((row) => number(row.precio) <= 0).length,
    supplierRelationsWithoutVat: rows("insumos_proveedores").filter((row) => isBlank(row.iva)).length,
    clientsWithoutChannel: rows("clientes").filter((row) => isBlank(row.id_canal)).length,
    clientsWithoutReceiptType: rows("clientes").filter((row) => isBlank(row.tipo_comprobante)).length,
    activeEmployees: rows("empleados").filter((row) => !isBlank(row.fecha_alta) && isBlank(row.fecha_baja)).length,
    activeEmployeesWithoutHiringType: rows("empleados").filter((row) => !isBlank(row.fecha_alta) && isBlank(row.fecha_baja) && isBlank(row.contratacion)).length
  };
}

function sum(values) {
  return Number(values.reduce((total, value) => total + number(value), 0).toFixed(2));
}

function percentile(sortedValues, fraction) {
  if (!sortedValues.length) return 0;
  const index = Math.min(Math.floor((sortedValues.length - 1) * fraction), sortedValues.length - 1);
  return Number(sortedValues[index].toFixed(2));
}

const profiles = Object.entries(tables).map(([tableName, table]) => tableProfile(tableName, table));
const audit = {
  generatedAt: new Date().toISOString(),
  sourceCache: CACHE_FILE,
  sourceGeneratedAt: cache.generatedAt || "",
  sourceErrors: cache.errors || [],
  summary: {
    tableCount: profiles.length,
    totalRows: profiles.reduce((total, profile) => total + profile.rowCount, 0),
    tablesWithoutRows: profiles.filter((profile) => profile.rowCount === 0).map((profile) => profile.name),
    completelyEmptyColumnCount: profiles.reduce((total, profile) => total + profile.completelyEmptyColumns.length, 0),
    tablesWithDuplicatePrimaryKeys: profiles.filter((profile) => profile.duplicatePrimaryKeyValues > 0).map((profile) => profile.name),
    effectivelyEmptyRows: profiles.reduce((total, profile) => total + profile.effectivelyEmptyRows, 0)
  },
  tableProfiles: profiles,
  foreignKeys: foreignKeyAudit(),
  duplicateBusinessKeys: duplicateBusinessKeys(),
  masterData: masterDataAudit(),
  operational: operationalAudit(),
  sourceLinks: sourceLinkAudit(),
  finance: financialAudit(),
  inventory: inventoryAudit()
};

fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(audit, null, 2), "utf8");
process.stdout.write(`${OUTPUT_FILE}\n`);
