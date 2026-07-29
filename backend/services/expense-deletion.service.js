const crypto = require("crypto");
const { fromCents, toCents } = require("../../shared/money");

const DIRECT_RULES = Object.freeze({
  gastos_egresos: { action: "delete", column: "id_egreso", preserves: "gastos_economicos" },
  detalle_pagos: { action: "delete", column: "id_egreso", recalculates: "pagos" },
  entregas: { action: "unlink", column: "id_egreso" },
  recepciones: { action: "unlink", column: "id_egreso" },
  otros_gastos: { action: "unlink", column: "id_egreso" },
  aportes_socios: { action: "unlink", column: "id_egreso" },
  cuotas_planes_pagos: { action: "unlink", column: "id_egreso" },
  sueldos: { action: "unlink", column: "id_egreso" },
  comisiones: { action: "unlink", column: "id_egreso" }
});

const PAYMENT_LINK_RULES = Object.freeze({
  movimientos_bancarios: "id_pago",
  cheques_entregados: "id_pago",
  cheques_recibidos: "id_pago_endoso",
  fondos_inversion_movimientos: "id_pago"
});

function previewExpenseDeletion(cache, requestedIds) {
  const ids = normalizedIds(requestedIds);
  if (!ids.length) throw serviceError("ADMIN_DELETE_IDS_REQUIRED", "Seleccioná al menos un egreso.");
  if (ids.length > 500) throw serviceError("ADMIN_DELETE_LIMIT", "No se pueden eliminar más de 500 egresos por operación.");

  const expenseRows = rows(cache, "egresos");
  const present = new Set(expenseRows.map((row) => id(row.id_egreso)).filter(Boolean));
  const missingIds = ids.filter((expenseId) => !present.has(expenseId));
  const selected = new Set(ids.filter((expenseId) => present.has(expenseId)));
  const deleted = [];
  const unlinked = [];
  const preserved = [];
  const blocked = [];
  const affectedPaymentIds = new Set();

  for (const [tableName, rule] of Object.entries(DIRECT_RULES)) {
    const table = cache.tables?.[tableName];
    if (!table) continue;
    const matching = rows(cache, tableName).filter((row) => selected.has(id(row[rule.column])));
    if (!matching.length) continue;
    const primaryKey = tablePrimaryKey(tableName, table);
    const recordIds = matching.map((row) => id(row[primaryKey])).filter(Boolean);
    if (rule.action === "delete") deleted.push(summary(tableName, matching.length, recordIds));
    else unlinked.push({ ...summary(tableName, matching.length, recordIds), column: rule.column });
    if (tableName === "detalle_pagos") matching.forEach((row) => affectedPaymentIds.add(id(row.id_pago)));
    if (tableName === "gastos_egresos") {
      const economicIds = unique(matching.map((row) => id(row.id_gasto_economico)).filter(Boolean));
      if (economicIds.length) preserved.push({
        table: "gastos_economicos",
        count: economicIds.length,
        ids: economicIds,
        reason: "El gasto económico es independiente y permanece en el Estado de Resultados."
      });
    }
  }

  for (const [tableName, table] of Object.entries(cache.tables || {})) {
    if (tableName === "egresos" || DIRECT_RULES[tableName]) continue;
    const columns = tableColumns(table);
    for (const column of columns.filter((name) => normalize(name) === "idegreso")) {
      const matching = rows(cache, tableName).filter((row) => selected.has(id(row[column])));
      if (matching.length) blocked.push({
        table: tableName,
        column,
        count: matching.length,
        reason: "La relación no tiene una regla segura habilitada."
      });
    }
  }

  const removedDetailIds = new Set(
    rows(cache, "detalle_pagos")
      .filter((row) => selected.has(id(row.id_egreso)))
      .map((row) => id(row.id_detalle_pago))
  );
  const paymentUpdates = [];
  for (const paymentId of [...affectedPaymentIds].filter(Boolean).sort(naturalCompare)) {
    const payment = rows(cache, "pagos").find((row) => id(row.id_pago) === paymentId);
    if (!payment) {
      blocked.push({
        table: "detalle_pagos",
        column: "id_pago",
        count: 1,
        reason: `El pago ${paymentId} no existe y no puede recalcularse.`
      });
      continue;
    }
    const remaining = rows(cache, "detalle_pagos").filter((row) => (
      id(row.id_pago) === paymentId && !removedDetailIds.has(id(row.id_detalle_pago))
    ));
    const nextAmount = centsToMoney(remaining.reduce((total, row) => total + moneyToCents(row.monto_cancelado), 0));
    paymentUpdates.push({ id_pago: paymentId, monto_anterior: payment.monto, monto_nuevo: nextAmount });
    preserved.push({
      table: "pagos",
      count: 1,
      ids: [paymentId],
      reason: remaining.length
        ? "El pago compartido se conserva con el total de sus aplicaciones restantes."
        : "El pago independiente se conserva con total cero."
    });
    for (const [tableName, column] of Object.entries(PAYMENT_LINK_RULES)) {
      const matching = rows(cache, tableName).filter((row) => id(row[column]) === paymentId);
      if (!matching.length) continue;
      const primaryKey = tablePrimaryKey(tableName, cache.tables[tableName]);
      unlinked.push({
        ...summary(tableName, matching.length, matching.map((row) => id(row[primaryKey])).filter(Boolean)),
        column
      });
      preserved.push({
        table: tableName,
        count: matching.length,
        ids: matching.map((row) => id(row[primaryKey])).filter(Boolean),
        reason: tableName === "movimientos_bancarios"
          ? "El movimiento bancario se conserva y vuelve a pendiente."
          : "El registro independiente se conserva sin el pago modificado."
      });
    }
  }

  const plan = {
    table: "egresos",
    ids,
    existingIds: [...selected].sort(naturalCompare),
    missingIds,
    deleted: mergeSummaries(deleted),
    unlinked: mergeUnlinked(unlinked),
    updated: paymentUpdates.length ? [{ table: "pagos", count: paymentUpdates.length, rows: paymentUpdates }] : [],
    preserved: mergePreserved(preserved),
    blocked,
    canApply: blocked.length === 0
  };
  plan.token = planToken(cache, plan);
  return plan;
}

function applyExpenseDeletion(cache, requestedIds, expectedToken) {
  const plan = previewExpenseDeletion(cache, requestedIds);
  if (plan.missingIds.length === plan.ids.length) {
    return { cache, plan: { ...plan, idempotent: true }, idempotent: true };
  }
  if (!expectedToken) throw serviceError("ADMIN_DELETE_PLAN_REQUIRED", "El plan de eliminación confirmado es obligatorio.");
  if (plan.token !== expectedToken) {
    const error = serviceError("ADMIN_DELETE_PLAN_CONFLICT", "Las conexiones cambiaron desde la vista previa. Revisá el plan actualizado.");
    error.plan = plan;
    throw error;
  }
  if (plan.blocked.length) {
    const error = serviceError("ADMIN_DELETE_BLOCKED", "Existen relaciones sin una regla segura de desvinculación.");
    error.plan = plan;
    throw error;
  }

  const selected = new Set(plan.existingIds);
  const affectedPaymentIds = new Set(
    rows(cache, "detalle_pagos")
      .filter((row) => selected.has(id(row.id_egreso)))
      .map((row) => id(row.id_pago))
      .filter(Boolean)
  );
  for (const [tableName, rule] of Object.entries(DIRECT_RULES)) {
    const table = cache.tables?.[tableName];
    if (!table) continue;
    const matching = rows(cache, tableName).filter((row) => selected.has(id(row[rule.column])));
    if (!matching.length) continue;
    if (rule.action === "delete") {
      table.rows = rows(cache, tableName).filter((row) => !selected.has(id(row[rule.column])));
    } else {
      table.rows = rows(cache, tableName).map((row) => (
        selected.has(id(row[rule.column])) ? { ...row, [rule.column]: "" } : row
      ));
    }
    refreshTable(table);
  }
  for (const paymentId of affectedPaymentIds) {
    const remaining = rows(cache, "detalle_pagos").filter((row) => id(row.id_pago) === paymentId);
    const nextAmount = centsToMoney(remaining.reduce((total, row) => total + moneyToCents(row.monto_cancelado), 0));
    const paymentTable = cache.tables?.pagos;
    if (paymentTable) {
      paymentTable.rows = rows(cache, "pagos").map((row) => (
        id(row.id_pago) === paymentId ? { ...row, monto: nextAmount } : row
      ));
      refreshTable(paymentTable);
    }
    for (const [tableName, column] of Object.entries(PAYMENT_LINK_RULES)) {
      const table = cache.tables?.[tableName];
      if (!table) continue;
      const matching = rows(cache, tableName).some((row) => id(row[column]) === paymentId);
      if (!matching) continue;
      table.rows = rows(cache, tableName).map((row) => (
        id(row[column]) === paymentId ? { ...row, [column]: "" } : row
      ));
      refreshTable(table);
    }
  }
  const expenseTable = cache.tables.egresos;
  expenseTable.rows = rows(cache, "egresos").filter((row) => !selected.has(id(row.id_egreso)));
  refreshTable(expenseTable);
  cache.generatedAt = new Date().toISOString();
  return { cache, plan, idempotent: false };
}

function planToken(cache, plan) {
  const relevant = {};
  for (const tableName of ["egresos", ...Object.keys(DIRECT_RULES), "pagos", ...Object.keys(PAYMENT_LINK_RULES)]) {
    if (cache.tables?.[tableName]) relevant[tableName] = rows(cache, tableName);
  }
  for (const item of plan.blocked) relevant[item.table] = rows(cache, item.table);
  return crypto.createHash("sha256").update(stableStringify({ ids: plan.ids, relevant })).digest("hex");
}

function rows(cache, tableName) {
  return Array.isArray(cache.tables?.[tableName]?.rows) ? cache.tables[tableName].rows : [];
}

function tableColumns(table) {
  if (Array.isArray(table?.headers) && table.headers.length) return table.headers;
  const first = (table?.rows || []).find((row) => row && typeof row === "object");
  return first ? Object.keys(first).filter((column) => !column.startsWith("_")) : [];
}

function tablePrimaryKey(tableName, table) {
  return table?.definition?.primaryKey || tableColumns(table)[0] || `id_${tableName.replace(/s$/, "")}`;
}

function refreshTable(table) {
  table.rowCount = table.rows.length;
  table.updatedAt = new Date().toISOString();
}

function summary(table, count, ids) {
  return { table, count, ids: unique(ids).sort(naturalCompare) };
}

function mergeSummaries(items) {
  return mergeBy(items, (item) => item.table, (group) => summary(
    group[0].table,
    group.reduce((total, item) => total + item.count, 0),
    group.flatMap((item) => item.ids)
  ));
}

function mergeUnlinked(items) {
  return mergeBy(items, (item) => `${item.table}:${item.column}`, (group) => ({
    ...summary(group[0].table, group.reduce((total, item) => total + item.count, 0), group.flatMap((item) => item.ids)),
    column: group[0].column
  }));
}

function mergePreserved(items) {
  return mergeBy(items, (item) => `${item.table}:${item.reason}`, (group) => ({
    table: group[0].table,
    count: group.reduce((total, item) => total + item.count, 0),
    ids: unique(group.flatMap((item) => item.ids)).sort(naturalCompare),
    reason: group[0].reason
  }));
}

function mergeBy(items, keyFor, build) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFor(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()].map(build).sort((left, right) => left.table.localeCompare(right.table));
}

function normalizedIds(values) {
  return unique((Array.isArray(values) ? values : []).map(id).filter(Boolean)).sort(naturalCompare);
}

function unique(values) {
  return [...new Set(values)];
}

function id(value) {
  return String(value ?? "").trim();
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function naturalCompare(left, right) {
  return String(left).localeCompare(String(right), "es", { numeric: true });
}

function moneyToCents(value) {
  try {
    return toCents(value);
  } catch {
    throw serviceError("ADMIN_DELETE_PAYMENT_INVALID", `Importe de pago inválido: ${value}.`);
  }
}

function centsToMoney(value) {
  return fromCents(value);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function serviceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  DIRECT_RULES,
  PAYMENT_LINK_RULES,
  applyExpenseDeletion,
  previewExpenseDeletion
};
