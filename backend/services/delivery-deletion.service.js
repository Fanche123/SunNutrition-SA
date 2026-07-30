const crypto = require("crypto");

const DELIVERY_DELETE_ALLOWLIST = Object.freeze({
  entregas_detalle: Object.freeze({ action: "delete", column: "id_entrega" }),
  ventas: Object.freeze({ action: "unlink", column: "id_entrega" })
});

function previewDeliveryDeletion(cache, deletedIds) {
  const ids = normalizedIds(deletedIds);
  if (!ids.size) throw deliveryError("ADMIN_DELETE_IDS_REQUIRED", "Seleccioná al menos una entrega.");
  const tables = cache?.tables || {};
  const deliveries = rows(tables, "entregas");
  const selected = deliveries.filter((row) => ids.has(text(row.id_entrega)));
  const missingIds = [...ids].filter((id) => !selected.some((row) => text(row.id_entrega) === id));
  const detailRows = rows(tables, "entregas_detalle").filter((row) => ids.has(text(row.id_entrega)));
  const salesRows = rows(tables, "ventas").filter((row) => ids.has(text(row.id_entrega)));
  const blocked = [];
  const blockedRows = [];

  selected.forEach((delivery) => {
    if (text(delivery.id_egreso)) {
      blocked.push({
        table: "entregas",
        column: "id_egreso",
        count: 1,
        reason: `La entrega ${text(delivery.id_entrega)} tiene un egreso asociado y requiere una baja financiera separada.`
      });
      blockedRows.push({ table: "entregas", row: delivery });
    }
  });
  for (const [tableName, table] of Object.entries(tables)) {
    if (tableName === "entregas" || DELIVERY_DELETE_ALLOWLIST[tableName]) continue;
    for (const column of tableColumns(table).filter((name) => normalize(name) === "identrega")) {
      const matches = (table.rows || []).filter((row) => ids.has(text(row[column])));
      const count = matches.length;
      if (count) {
        blocked.push({
          table: tableName,
          column,
          count,
          reason: "La dependencia no está incluida en la lista segura de baja de entregas."
        });
        matches.forEach((row) => blockedRows.push({ table: tableName, column, row }));
      }
    }
  }

  const plan = {
    kind: "delivery",
    selectedIds: [...ids].sort(),
    missingIds,
    canApply: selected.length > 0 && missingIds.length === 0 && blocked.length === 0,
    deleted: [
      { table: "entregas", count: selected.length },
      ...(detailRows.length ? [{ table: "entregas_detalle", count: detailRows.length }] : [])
    ],
    unlinked: salesRows.length ? [{ table: "ventas", column: "id_entrega", count: salesRows.length }] : [],
    updated: [],
    preserved: detailRows.length
      ? [{
        table: "pedidos",
        count: new Set(detailRows.map((row) => text(row.id_pedido)).filter(Boolean)).size,
        reason: "Los pedidos se conservan y vuelven a quedar disponibles para otra entrega."
      }]
      : [],
    blocked,
    affected: {
      entregas: selected.map((row) => text(row.id_entrega)).sort(),
      entregas_detalle: detailRows.map((row) => text(row.id_entregas_detalle)).sort(),
      ventas: salesRows.map((row) => text(row.id_venta)).sort()
    }
  };
  plan.stateHash = stateHash({
    entregas: selected,
    entregas_detalle: detailRows,
    ventas: salesRows,
    blocked: blockedRows
  });
  plan.token = planToken(plan);
  return plan;
}

function applyDeliveryDeletion(cache, deletedIds, suppliedToken) {
  const ids = normalizedIds(deletedIds);
  const deliveries = rows(cache?.tables || {}, "entregas");
  if (ids.size && [...ids].every((id) => !deliveries.some((row) => text(row.id_entrega) === id))) {
    return { idempotent: true, plan: emptyPlan(ids) };
  }
  const plan = previewDeliveryDeletion(cache, deletedIds);
  if (!plan.canApply) {
    const error = deliveryError("ADMIN_DELIVERY_DELETE_BLOCKED", "No se puede eliminar la entrega con las dependencias actuales.");
    error.plan = plan;
    throw error;
  }
  if (!suppliedToken || suppliedToken !== plan.token) {
    const error = deliveryError("ADMIN_DELETE_PLAN_CONFLICT", "Las conexiones de la entrega cambiaron. Revisá la vista previa nuevamente.");
    error.plan = plan;
    throw error;
  }

  const tables = cache.tables;
  tables.entregas.rows = tables.entregas.rows.filter((row) => !ids.has(text(row.id_entrega)));
  tables.entregas_detalle.rows = tables.entregas_detalle.rows.filter((row) => !ids.has(text(row.id_entrega)));
  tables.ventas.rows.forEach((row) => {
    if (ids.has(text(row.id_entrega))) row.id_entrega = "";
  });
  for (const tableName of ["entregas", "entregas_detalle", "ventas"]) {
    tables[tableName].rowCount = tables[tableName].rows.length;
  }
  return { idempotent: false, plan };
}

function emptyPlan(ids) {
  return {
    kind: "delivery",
    selectedIds: [...ids].sort(),
    canApply: true,
    deleted: [],
    unlinked: [],
    updated: [],
    preserved: [],
    blocked: []
  };
}

function rows(tables, tableName) {
  const result = tables?.[tableName]?.rows;
  if (!Array.isArray(result)) throw deliveryError("ADMIN_TABLE_NOT_FOUND", `Falta la tabla ${tableName}.`);
  return result;
}

function tableColumns(table) {
  return Array.isArray(table?.headers) && table.headers.length
    ? table.headers
    : Object.keys(table?.rows?.[0] || {}).filter((column) => !column.startsWith("_"));
}

function normalizedIds(values) {
  return new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean));
}

function planToken(plan) {
  return crypto.createHash("sha256").update(JSON.stringify({
    kind: plan.kind,
    selectedIds: plan.selectedIds,
    missingIds: plan.missingIds,
    affected: plan.affected,
    blocked: plan.blocked,
    stateHash: plan.stateHash
  })).digest("hex");
}

function stateHash(value) {
  return crypto.createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function text(value) {
  return String(value ?? "").trim();
}

function normalize(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function deliveryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  DELIVERY_DELETE_ALLOWLIST,
  applyDeliveryDeletion,
  previewDeliveryDeletion
};
