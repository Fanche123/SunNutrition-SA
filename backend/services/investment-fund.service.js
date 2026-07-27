const crypto = require("crypto");
const { fromCents, toCents } = require("../../shared/money");
const { strictMoneyToCents } = require("../utils/money-input");

const FUND_TYPES = Object.freeze(["deposito", "rescate", "rendimiento"]);
const FUND_TYPE_SET = new Set(FUND_TYPES);
const FUND_TYPE_ORDER = Object.freeze({ deposito: 0, rendimiento: 1, rescate: 2 });
const FUND_OPERATION_PATTERNS = Object.freeze({
  deposito: /\b(?:susc(?:ripcion|rip|r)?|suscripcion|suscribir|compra\s+(?:de\s+)?cuotapartes?)\b/,
  rescate: /\b(?:resc(?:ate)?|rescate|venta\s+(?:de\s+)?cuotapartes?)\b/,
  rendimiento: /\b(?:rend(?:imiento)?|rentabilidad|utilidad|intereses?)\b/
});
const FUND_MARKER_PATTERN = /\b(?:fci|fc|fondo(?:s)?\s+comun(?:es)?(?:\s+de\s+inversion)?|cuotapartes?)\b/;

function createInvestmentFundService(dependencies) {
  const {
    backendId,
    backendNextNumericId,
    expectedBackendColumns,
    loadCache,
    readJsonBody,
    saveBackendCache,
    sendJson
  } = dependencies;

  function handleList(_request, response) {
    try {
      const cache = loadCache();
      return sendJson(response, 200, {
        ok: true,
        ...investmentFundState(cache),
        bankMovements: availableBankMovements(cache),
        tags: availableEconomicTags(cache)
      });
    } catch (error) {
      return sendJson(response, error.statusCode || 500, { ok: false, error: error.message });
    }
  }

  async function handleCreate(request, response) {
    try {
      const body = await readJsonBody(request);
      const cache = clone(loadCache());
      const result = applyInvestmentFundMovement(cache, body, {
        backendId,
        backendNextNumericId,
        expectedBackendColumns
      });
      if (!result.idempotent) saveBackendCache(cache);
      return sendJson(response, result.idempotent ? 200 : 201, {
        ok: true,
        idempotent: result.idempotent,
        movement: result.movement,
        state: investmentFundState(cache)
      });
    } catch (error) {
      return sendJson(response, error.statusCode || 400, {
        ok: false,
        code: error.code || "INVESTMENT_FUND_INVALID",
        error: error.message
      });
    }
  }

  return { handleCreate, handleList };
}

function applyInvestmentFundMovement(cache, source, dependencies) {
  const { backendId, backendNextNumericId, expectedBackendColumns } = dependencies;
  const tables = cache.tables || (cache.tables = {});
  const table = requiredFundTable(tables, expectedBackendColumns);
  const bankTable = requiredRowsTable(tables, "movimientos_bancarios");
  const economicTable = requiredRowsTable(tables, "gastos_economicos");
  const type = text(source.tipo).toLowerCase();
  const date = validIsoDate(source.fecha);
  const amountCents = strictPositiveAmount(source.importe);
  const period = text(source.periodo_rendimiento);
  const bankMovementId = backendId(source.id_movimiento_bancario);
  const tagId = backendId(source.id_etiqueta);
  const operationKey = text(source.clave_idempotencia);

  if (!FUND_TYPE_SET.has(type)) throw fundError("INVESTMENT_FUND_TYPE_INVALID", "El tipo de movimiento del fondo no es valido.");
  if (!date) throw fundError("INVESTMENT_FUND_DATE_INVALID", "La fecha debe ser valida y usar AAAA-MM-DD.");
  if (!operationKey) throw fundError("INVESTMENT_FUND_IDEMPOTENCY_REQUIRED", "La clave idempotente es obligatoria.");
  if (type === "rendimiento" && (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period) || !date.startsWith(`${period}-`))) {
    throw fundError("INVESTMENT_FUND_PERIOD_INVALID", "El rendimiento debe indicar un mes AAAA-MM coincidente con su fecha.");
  }
  if (type !== "rendimiento" && period) {
    throw fundError("INVESTMENT_FUND_PERIOD_NOT_ALLOWED", "Solo los rendimientos pueden indicar un mes.");
  }
  if (type !== "rendimiento" && tagId) {
    throw fundError("INVESTMENT_FUND_TAG_NOT_ALLOWED", "La etiqueta economica corresponde unicamente a rendimientos.");
  }

  const normalizedPayload = {
    fecha: date,
    tipo: type,
    importe: fromCents(amountCents),
    periodo_rendimiento: period,
    id_movimiento_bancario: bankMovementId,
    id_etiqueta: tagId,
    referencia: text(source.referencia),
    observacion: text(source.observacion)
  };
  const payloadHash = hashPayload(normalizedPayload);
  const replay = table.rows.find((row) => text(row.clave_idempotencia) === operationKey);
  if (replay) {
    if (text(replay.hash_payload) !== payloadHash) {
      throw fundError("INVESTMENT_FUND_IDEMPOTENCY_CONFLICT", "La clave idempotente fue reutilizada con otros datos.", 409);
    }
    return { idempotent: true, movement: replay };
  }

  if (type === "rendimiento" && table.rows.some((row) => (
    text(row.tipo) === "rendimiento" && text(row.periodo_rendimiento) === period
  ))) {
    throw fundError("INVESTMENT_FUND_PERIOD_DUPLICATE", "Ya existe un rendimiento registrado para ese mes.", 409);
  }

  const balanceBeforeCents = investmentFundLedger(table.rows).balanceCents;
  if (type === "rescate" && amountCents > balanceBeforeCents) {
    throw fundError("INVESTMENT_FUND_INSUFFICIENT_BALANCE", "El rescate supera el saldo disponible del fondo.", 409);
  }

  const timestamp = new Date().toISOString();
  const movementId = backendNextNumericId(table.rows, "id_movimiento_fondo");
  const bankRow = bankMovementId
    ? validateBankAssociation(bankTable.rows, normalizedPayload, movementId, backendId)
    : null;
  const movement = {
    _rowNumber: table.rows.length + 2,
    id_movimiento_fondo: movementId,
    fecha: date,
    tipo: type,
    importe: fromCents(amountCents),
    periodo_rendimiento: period,
    id_movimiento_bancario: bankMovementId,
    id_gasto_economico: "",
    referencia: normalizedPayload.referencia,
    observacion: normalizedPayload.observacion,
    clave_idempotencia: operationKey,
    hash_payload: payloadHash,
    creado_en: timestamp
  };

  if (type === "rendimiento") {
    movement.id_gasto_economico = createYieldEconomicExpense({
      amountCents,
      backendId,
      backendNextNumericId,
      economicTable,
      movementId,
      operationKey,
      period,
      tagId,
      tables,
      timestamp
    });
  }

  table.rows.push(movement);
  table.headers = [...expectedBackendColumns.fondos_inversion_movimientos];
  table.rowCount = table.rows.length;
  table.updatedAt = timestamp;
  bankTable.headers = unique([...(bankTable.headers || []), "id_movimiento_fondo"]);
  if (bankRow) {
    bankRow.id_movimiento_fondo = movementId;
    bankRow._editedLocallyAt = timestamp;
  }
  bankTable.rowCount = bankTable.rows.length;
  economicTable.headers = [...expectedBackendColumns.gastos_economicos];
  economicTable.rowCount = economicTable.rows.length;
  cache.generatedAt = timestamp;
  return { idempotent: false, movement };
}

function createYieldEconomicExpense({
  amountCents,
  backendId,
  backendNextNumericId,
  economicTable,
  movementId,
  operationKey,
  period,
  tagId,
  tables,
  timestamp
}) {
  if (!tagId || !(tables.etiquetas?.rows || []).some((row) => backendId(row.id_etiqueta) === tagId)) {
    throw fundError("INVESTMENT_FUND_TAG_INVALID", "El rendimiento requiere una etiqueta economica existente.");
  }
  const economicKey = `fondo-rendimiento:${operationKey}`;
  const existing = economicTable.rows.find((row) => text(row.clave_idempotencia) === economicKey);
  if (existing) return backendId(existing.id_gasto_economico);
  const expenseId = backendNextNumericId(economicTable.rows, "id_gasto_economico");
  const economicPayload = {
    periodo_economico: period,
    id_etiqueta: tagId,
    concepto: `Rendimiento fondo de inversion ${period}`,
    tipo_economico: "interes_financiero",
    tipo_movimiento: "original",
    importe: fromCents(-amountCents),
    estado: "confirmado",
    origen_tipo: "fondo_inversion",
    origen_id: backendId(movementId),
    origen_subclave: period,
    id_gasto_precedente: "",
    motivo: "Interes a favor registrado como gasto negativo por criterio funcional.",
    clave_idempotencia: economicKey
  };
  economicTable.rows.push({
    _rowNumber: economicTable.rows.length + 2,
    id_gasto_economico: expenseId,
    ...economicPayload,
    hash_payload: hashPayload(economicPayload),
    creado_en: timestamp,
    actualizado_en: timestamp,
    confirmado_en: timestamp
  });
  return expenseId;
}

function validateBankAssociation(rows, movement, movementId, backendId) {
  const matches = rows.filter((row) => backendId(row.id_movimiento_bancario) === movement.id_movimiento_bancario);
  if (matches.length !== 1) {
    throw fundError("INVESTMENT_FUND_BANK_NOT_UNIQUE", "El movimiento bancario asociado no existe de forma inequivoca.", 409);
  }
  const row = matches[0];
  if (backendId(row.id_pago) || backendId(row.id_cobro) || backendId(row.id_movimiento_fondo)) {
    throw fundError("INVESTMENT_FUND_BANK_ALREADY_LINKED", "El movimiento bancario ya tiene una asociacion financiera.", 409);
  }
  if (text(row.fecha) !== movement.fecha) {
    throw fundError("INVESTMENT_FUND_BANK_DATE_MISMATCH", "La fecha no coincide con el movimiento bancario seleccionado.");
  }
  const expectedCents = movement.tipo === "deposito"
    ? Math.abs(toCents(row.debito || 0))
    : Math.abs(toCents(row.credito || 0));
  if (expectedCents !== toCents(movement.importe)) {
    const direction = movement.tipo === "deposito" ? "debito" : "credito";
    throw fundError("INVESTMENT_FUND_BANK_AMOUNT_MISMATCH", `El ${direction} bancario no coincide exactamente con el importe del fondo.`);
  }
  row.id_movimiento_fondo = movementId;
  return row;
}

function investmentFundCandidates(movements, tables = {}) {
  return (movements || [])
    .map((movement) => classifyInvestmentFundCandidate(movement, tables))
    .filter(Boolean);
}

function classifyInvestmentFundCandidate(movement, tables = {}) {
  const normalizedDetail = normalizeFundText([
    movement?.concept,
    movement?.detail
  ].filter(Boolean).join(" "));
  const operationTypes = Object.entries(FUND_OPERATION_PATTERNS)
    .filter(([, pattern]) => pattern.test(normalizedDetail))
    .map(([type]) => type);
  const hasFundMarker = FUND_MARKER_PATTERN.test(normalizedDetail);
  const mentionsSpecificFundOperation = operationTypes.some((type) => type !== "rendimiento");
  if (!hasFundMarker && !mentionsSpecificFundOperation) return null;

  const movementId = text(movement?.canonicalMovementId || movement?.id_movimiento_bancario);
  const amountCents = toCents(
    movement?.amount ?? (Number(movement?.credit || 0) - Number(movement?.debit || 0))
  );
  const debitCents = Math.abs(toCents(movement?.debit || 0));
  const creditCents = Math.abs(toCents(movement?.credit || 0));
  const date = validIsoDate(movement?.date || movement?.fecha);
  const evidence = text(movement?.detail || movement?.concept);
  const review = (reason, type = operationTypes[0] || "") => ({
    id: movementId || text(movement?.movementKey),
    confidence: "review",
    type,
    reason,
    evidence,
    movement: fundCandidateMovementSummary(movement, amountCents, movementId, date),
    payload: null
  });

  if (!hasFundMarker) {
    return review("La operacion menciona una suscripcion o rescate, pero no identifica de forma explicita un fondo.");
  }
  if (operationTypes.length !== 1) {
    return review(operationTypes.length
      ? "El detalle contiene mas de un tipo de operacion de fondo."
      : "El detalle identifica un fondo, pero no permite determinar la operacion.");
  }

  const type = operationTypes[0];
  const expectsDebit = type === "deposito";
  const directionIsReliable = expectsDebit
    ? debitCents > 0 && creditCents === 0 && amountCents < 0
    : creditCents > 0 && debitCents === 0 && amountCents > 0;
  if (!directionIsReliable) {
    return review(
      type === "deposito"
        ? "La suscripcion no tiene un debito bancario inequivoco."
        : `El ${type} no tiene un credito bancario inequivoco.`,
      type
    );
  }
  if (!movementId || !date || amountCents === 0) {
    return review("Faltan identificador, fecha o importe canonico para asociar el movimiento con seguridad.", type);
  }
  const competingMatchType = normalizeFundText(movement?.match?.type);
  if ((competingMatchType && competingMatchType !== "dato bancario") || movement?.checkMatch || movement?.sourceMatch) {
    return review("El movimiento tambien tiene otra asociacion financiera candidata y requiere revision.", type);
  }
  const fundRows = tables.fondos_inversion_movimientos?.rows || [];
  if (type === "rescate" && Math.abs(amountCents) > investmentFundLedger(fundRows).balanceCents) {
    return review("El rescate supera el saldo disponible del fondo y no puede registrarse automaticamente.", type);
  }
  if (type === "rendimiento" && fundRows.some((row) => (
    text(row.tipo) === "rendimiento" && text(row.periodo_rendimiento) === date.slice(0, 7)
  ))) {
    return review("Ya existe un rendimiento registrado para el mes del movimiento.", type);
  }

  const payload = {
    fecha: date,
    tipo: type,
    importe: fromCents(Math.abs(amountCents)),
    periodo_rendimiento: "",
    id_movimiento_bancario: movementId,
    id_etiqueta: "",
    referencia: evidence.slice(0, 120),
    observacion: "Clasificado desde Conciliacion bancaria por evidencia explicita de fondo.",
    clave_idempotencia: `fondo-banco:${movementId}`
  };
  if (type === "rendimiento") {
    const yieldTags = (tables.etiquetas?.rows || []).filter((row) => (
      normalizeFundText(row.etiqueta) === "rendimiento fondo"
    ));
    if (yieldTags.length !== 1) {
      return review("El rendimiento requiere una unica etiqueta economica 'Rendimiento Fondo'.", type);
    }
    payload.periodo_rendimiento = date.slice(0, 7);
    payload.id_etiqueta = text(yieldTags[0].id_etiqueta);
  }

  return {
    id: movementId,
    confidence: "reliable",
    type,
    reason: type === "deposito"
      ? "Suscripcion de fondo con debito bancario explicito."
      : `${type === "rescate" ? "Rescate" : "Rendimiento"} de fondo con credito bancario explicito.`,
    evidence,
    movement: fundCandidateMovementSummary(movement, amountCents, movementId, date),
    payload
  };
}

function fundCandidateMovementSummary(movement, amountCents, movementId, date) {
  return {
    id_movimiento_bancario: movementId,
    movementKey: text(movement?.movementKey),
    banco: text(movement?.bank || movement?.banco),
    fecha: date || text(movement?.date || movement?.fecha),
    detalle: text(movement?.detail || movement?.concept),
    importe: fromCents(Math.abs(amountCents))
  };
}

function investmentFundState(cache) {
  const rows = cache.tables?.fondos_inversion_movimientos?.rows || [];
  const ledger = investmentFundLedger(rows);
  return {
    balance: fromCents(ledger.balanceCents),
    movements: ledger.rows.map((entry) => ({
      ...entry.row,
      saldo_resultante: fromCents(entry.balanceCents)
    })).reverse()
  };
}

function investmentFundLedger(rows) {
  let balanceCents = 0;
  const ordered = [...(rows || [])].sort((left, right) => (
    text(left.fecha).localeCompare(text(right.fecha))
    || (FUND_TYPE_ORDER[text(left.tipo)] ?? 9) - (FUND_TYPE_ORDER[text(right.tipo)] ?? 9)
    || numericId(left.id_movimiento_fondo) - numericId(right.id_movimiento_fondo)
  ));
  const entries = ordered.map((row) => {
    const cents = Math.abs(toCents(row.importe || 0));
    balanceCents += text(row.tipo) === "rescate" ? -cents : cents;
    return { row, balanceCents };
  });
  return { balanceCents, rows: entries };
}

function availableBankMovements(cache) {
  return (cache.tables?.movimientos_bancarios?.rows || [])
    .filter((row) => !text(row.id_pago) && !text(row.id_cobro) && !text(row.id_movimiento_fondo))
    .map((row) => ({
      id_movimiento_bancario: row.id_movimiento_bancario,
      banco: text(row.banco),
      fecha: text(row.fecha),
      detalle: text(row.detalle || row.concepto),
      debito: fromCents(Math.abs(toCents(row.debito || 0))),
      credito: fromCents(Math.abs(toCents(row.credito || 0)))
    }))
    .filter((row) => toCents(row.debito) || toCents(row.credito))
    .sort((left, right) => right.fecha.localeCompare(left.fecha));
}

function availableEconomicTags(cache) {
  return (cache.tables?.etiquetas?.rows || [])
    .map((row) => ({ id_etiqueta: row.id_etiqueta, etiqueta: text(row.etiqueta) }))
    .filter((row) => row.id_etiqueta && row.etiqueta)
    .sort((left, right) => left.etiqueta.localeCompare(right.etiqueta));
}

function requiredFundTable(tables, expectedBackendColumns) {
  if (!tables.fondos_inversion_movimientos) {
    tables.fondos_inversion_movimientos = {
      headers: [...expectedBackendColumns.fondos_inversion_movimientos],
      rows: [],
      rowCount: 0
    };
  }
  return requiredRowsTable(tables, "fondos_inversion_movimientos");
}

function requiredRowsTable(tables, name) {
  const table = tables[name];
  if (!table || !Array.isArray(table.rows)) {
    throw fundError("INVESTMENT_FUND_SCHEMA_MISSING", `Falta la tabla ${name}.`, 500);
  }
  if (!Array.isArray(table.headers)) table.headers = [];
  return table;
}

function strictPositiveAmount(value) {
  let cents;
  try {
    cents = strictMoneyToCents(value, { allowNegative: false });
  } catch (_error) {
    throw fundError("INVESTMENT_FUND_AMOUNT_INVALID", "El importe debe ser monetario, positivo y tener como maximo dos decimales.");
  }
  if (cents <= 0) throw fundError("INVESTMENT_FUND_AMOUNT_INVALID", "El importe debe ser mayor que cero.");
  return cents;
}

function validIsoDate(value) {
  const candidate = text(value);
  const match = candidate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3])
    ? candidate
    : "";
}

function hashPayload(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function numericId(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function text(value) {
  return String(value ?? "").trim();
}

function normalizeFundText(value) {
  return text(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fundError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

module.exports = {
  FUND_TYPES,
  applyInvestmentFundMovement,
  classifyInvestmentFundCandidate,
  createInvestmentFundService,
  investmentFundCandidates,
  investmentFundLedger,
  investmentFundState
};
