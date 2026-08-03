const crypto = require("crypto");
const { fromCents, toCents } = require("../../shared/money");

const CASH_LEDGER_TABLE = "caja_efectivo_movimientos";
const CASH_METHOD = "efectivo";

function canonicalCashMethod(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return normalized === CASH_METHOD ? CASH_METHOD : "";
}

function cashSourceEffectCents(sourceType, row) {
  if (!row || !canonicalCashMethod(row.metodo)) return 0;
  const amount = Math.abs(toCents(row.monto, { allowEmpty: false }));
  if (sourceType === "cobro") return amount;
  if (sourceType === "pago") return -amount;
  throw ledgerError("CASH_LEDGER_SOURCE_INVALID", `Fuente de caja no válida: ${sourceType}.`);
}

function appendCashSourceMovement(cache, input) {
  const sourceType = String(input.sourceType || "").trim();
  const sourceId = sourceIdFor(sourceType, input.sourceRow);
  if (!sourceId) throw ledgerError("CASH_LEDGER_SOURCE_ID_REQUIRED", "El movimiento de caja requiere una fuente identificable.");
  if (!canonicalCashMethod(input.sourceRow?.metodo)) return null;
  const table = requiredLedger(cache);
  if (!isSourceAfterCutoff(table, sourceType, sourceId)) return null;
  const amountCents = cashSourceEffectCents(sourceType, input.sourceRow);
  const operationId = text(input.operationId);
  if (!operationId) throw ledgerError("CASH_LEDGER_OPERATION_REQUIRED", "El movimiento de caja requiere una clave de operación.");
  const key = `${sourceType}:${sourceId}:${operationId}:alta`;
  const existing = findByKey(table.rows, key);
  const payloadHash = movementHash({ sourceType, sourceId, amountCents, operationId, kind: sourceType });
  if (existing) {
    if (existing.hash_payload !== payloadHash) {
      throw ledgerError("CASH_LEDGER_IDEMPOTENCY_CONFLICT", "La clave de caja ya existe con otro contenido.");
    }
    return existing;
  }
  return appendMovement(cache, {
    tipo: sourceType,
    importeCents: amountCents,
    sourceType,
    sourceId,
    operationId,
    key,
    payloadHash,
    sourceRow: input.sourceRow,
    actor: input.actor,
    registeredAt: input.registeredAt,
    reference: `${sourceType === "cobro" ? "Cobro" : "Pago"} efectivo #${sourceId}`
  });
}

function assertCashSourceMovement(cache, input) {
  const sourceType = String(input.sourceType || "").trim();
  const sourceId = sourceIdFor(sourceType, input.sourceRow);
  if (!canonicalCashMethod(input.sourceRow?.metodo)) return true;
  const operationId = text(input.operationId);
  const table = requiredLedger(cache);
  if (!isSourceAfterCutoff(table, sourceType, sourceId)) return true;
  const amountCents = cashSourceEffectCents(sourceType, input.sourceRow);
  const key = `${sourceType}:${sourceId}:${operationId}:alta`;
  const existing = findByKey(table.rows, key);
  const expectedHash = movementHash({ sourceType, sourceId, amountCents, operationId, kind: sourceType });
  if (!existing || existing.hash_payload !== expectedHash) {
    throw ledgerError("CASH_LEDGER_SOURCE_INCOMPLETE", `La operación ${sourceType} #${sourceId} no tiene un asiento de caja consistente.`);
  }
  return true;
}

function reconcileCashSourceRows(cache, sourceType, beforeRows, afterRows, input = {}) {
  const table = requiredLedger(cache);
  const idColumn = sourceType === "cobro" ? "id_cobro" : sourceType === "pago" ? "id_pago" : "";
  if (!idColumn) throw ledgerError("CASH_LEDGER_SOURCE_INVALID", `Fuente de caja no válida: ${sourceType}.`);
  const beforeById = rowMap(beforeRows, idColumn);
  const afterById = rowMap(afterRows, idColumn);
  const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
  const results = [];
  for (const sourceId of ids) {
    if (!isSourceAfterCutoff(table, sourceType, sourceId)) continue;
    const before = beforeById.get(sourceId) || null;
    const after = afterById.get(sourceId) || null;
    const wasTracked = table.rows.some((row) => row.fuente_tipo === sourceType && text(row.fuente_id) === sourceId);
    const beforeEffect = before ? cashSourceEffectCents(sourceType, before) : 0;
    const afterEffect = after ? cashSourceEffectCents(sourceType, after) : 0;
    if (!wasTracked) {
      if (!afterEffect) continue;
      if (beforeEffect) {
        throw ledgerError("CASH_LEDGER_UNTRACKED_SOURCE", `${sourceType} #${sourceId} es efectivo y posterior al corte, pero no tiene asiento de origen.`);
      }
      results.push(appendCashSourceMovement(cache, {
        sourceType,
        sourceRow: after,
        operationId: text(input.operationId) || `administracion:${sourceType}:${sourceId}`,
        actor: input.actor,
        registeredAt: input.registeredAt
      }));
      continue;
    }
    const deltaCents = afterEffect - beforeEffect;
    if (!deltaCents) continue;
    const operationId = text(input.operationId);
    if (!operationId) throw ledgerError("CASH_LEDGER_OPERATION_REQUIRED", "La compensación de caja requiere una clave de operación.");
    const key = `${sourceType}:${sourceId}:${operationId}:compensacion`;
    const payloadHash = movementHash({ sourceType, sourceId, deltaCents, operationId, kind: "reversion" });
    const existing = findByKey(table.rows, key);
    if (existing) {
      if (existing.hash_payload !== payloadHash) {
        throw ledgerError("CASH_LEDGER_IDEMPOTENCY_CONFLICT", "La compensación de caja ya existe con otro contenido.");
      }
      results.push(existing);
      continue;
    }
    results.push(appendMovement(cache, {
      tipo: "reversion",
      importeCents: deltaCents,
      sourceType,
      sourceId,
      operationId,
      key,
      payloadHash,
      sourceRow: after || before,
      actor: input.actor,
      registeredAt: input.registeredAt,
      reference: after
        ? `Compensación por modificación de ${sourceType} #${sourceId}`
        : `Compensación por baja de ${sourceType} #${sourceId}`
    }));
  }
  return results.filter(Boolean);
}

function cashLedgerSnapshot(cache) {
  const table = requiredLedger(cache);
  const rows = [...table.rows].sort((left, right) => Number(left.id_movimiento_caja) - Number(right.id_movimiento_caja));
  const openings = rows.filter((row) => row.tipo === "apertura");
  if (openings.length !== 1) {
    throw ledgerError("CASH_LEDGER_OPENING_INVALID", "La Caja Efectivo debe tener exactamente un asiento de apertura.");
  }
  let balanceCents = 0;
  const movements = rows.map((row) => {
    const amountCents = toCents(row.importe, { allowEmpty: false });
    balanceCents = safeAdd(balanceCents, amountCents);
    return {
      id: text(row.id_movimiento_caja),
      registeredAt: text(row.fecha_registro),
      date: text(row.fecha_operativa),
      type: text(row.tipo),
      sourceType: text(row.fuente_tipo),
      sourceId: text(row.fuente_id),
      reference: text(row.referencia),
      actor: row.tipo === "apertura" && text(row.usuario_id) === "system"
        ? "Migración controlada"
        : text(row.usuario_nombre) || text(row.usuario_id),
      amountCents,
      balanceCents
    };
  });
  return {
    balanceCents,
    openingCents: toCents(openings[0].importe, { allowEmpty: false }),
    cutoff: {
      collectionId: text(openings[0].corte_id_cobro),
      paymentId: text(openings[0].corte_id_pago),
      registeredAt: text(openings[0].fecha_registro)
    },
    movements
  };
}

function appendMovement(cache, input) {
  const table = requiredLedger(cache);
  const nextId = table.rows.reduce((maximum, row) => Math.max(maximum, Number(row.id_movimiento_caja) || 0), 0) + 1;
  const actor = input.actor || {};
  const row = {
    _rowNumber: table.rows.length + 2,
    id_movimiento_caja: nextId,
    fecha_registro: text(input.registeredAt) || new Date().toISOString(),
    fecha_operativa: sourceDate(input.sourceType, input.sourceRow),
    tipo: input.tipo,
    importe: fromCents(input.importeCents),
    fuente_tipo: input.sourceType,
    fuente_id: input.sourceId,
    id_cobro: input.sourceType === "cobro" ? input.sourceId : "",
    id_pago: input.sourceType === "pago" ? input.sourceId : "",
    operacion_id: input.operationId,
    referencia: input.reference,
    usuario_id: text(actor.id),
    usuario_nombre: text(actor.displayName || actor.username),
    clave_idempotencia: input.key,
    hash_payload: input.payloadHash
  };
  table.rows.push(row);
  table.rowCount = table.rows.length;
  table.updatedAt = row.fecha_registro;
  return row;
}

function requiredLedger(cache) {
  const table = cache?.tables?.[CASH_LEDGER_TABLE];
  if (!table || !Array.isArray(table.rows)) {
    throw ledgerError("CASH_LEDGER_NOT_INITIALIZED", "La Caja Efectivo no fue inicializada mediante su migración controlada.");
  }
  return table;
}

function sourceIdFor(sourceType, row) {
  if (sourceType === "cobro") return text(row?.id_cobro);
  if (sourceType === "pago") return text(row?.id_pago);
  return "";
}

function sourceDate(sourceType, row) {
  return text(sourceType === "cobro" ? row?.fecha_cobro : row?.fecha_pago);
}

function isSourceAfterCutoff(table, sourceType, sourceId) {
  const openings = (table.rows || []).filter((row) => row.tipo === "apertura");
  if (openings.length !== 1) throw ledgerError("CASH_LEDGER_OPENING_INVALID", "La Caja Efectivo debe tener exactamente un asiento de apertura.");
  const sourceNumber = Number(sourceId);
  const cutoffColumn = sourceType === "cobro" ? "corte_id_cobro" : sourceType === "pago" ? "corte_id_pago" : "";
  const cutoffNumber = Number(openings[0][cutoffColumn] || 0);
  if (!cutoffColumn || !Number.isSafeInteger(sourceNumber) || !Number.isSafeInteger(cutoffNumber)) {
    throw ledgerError("CASH_LEDGER_CUTOFF_INVALID", `No se pudo verificar el corte de ${sourceType} #${sourceId}.`);
  }
  return sourceNumber > cutoffNumber;
}

function rowMap(rows, idColumn) {
  return new Map((rows || []).map((row) => [text(row?.[idColumn]), row]).filter(([id]) => id));
}

function findByKey(rows, key) {
  return (rows || []).find((row) => text(row.clave_idempotencia) === key);
}

function movementHash(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function safeAdd(left, right) {
  const total = BigInt(left) + BigInt(right);
  const result = Number(total);
  if (!Number.isSafeInteger(result) || BigInt(result) !== total) throw new RangeError("El saldo de caja excede el rango seguro.");
  return result;
}

function text(value) {
  return String(value ?? "").trim();
}

function ledgerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  CASH_LEDGER_TABLE,
  appendCashSourceMovement,
  assertCashSourceMovement,
  canonicalCashMethod,
  cashLedgerSnapshot,
  cashSourceEffectCents,
  reconcileCashSourceRows
};
