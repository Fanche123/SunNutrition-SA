const crypto = require("crypto");
const { normalize: normalizeMoney, toCents } = require("../../shared/money");

const ECONOMIC_TYPES = new Set(["operativo", "mercaderia", "interes_financiero", "interes_resarcitorio", "otro_definido"]);
const MOVEMENT_TYPES = new Set(["original", "ajuste", "reversion"]);
const STATES = new Set(["borrador", "confirmado", "descartado"]);

function createEconomicExpensesService(dependencies) {
  const {
    backendId,
    backendNextNumericId,
    ensureBackendTable,
    expectedBackendColumns,
    loadCache,
    readJsonBody,
    saveBackendCache,
    sendJson
  } = dependencies;

  function handleList(request, response) {
    const cache = loadCache();
    const rows = cache.tables?.gastos_economicos?.rows || [];
    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
    const state = text(url.searchParams.get("estado"));
    const period = text(url.searchParams.get("periodo"));
    const filtered = rows.filter((row) => (!state || row.estado === state) && (!period || row.periodo_economico === period));
    return sendJson(response, 200, { ok: true, rows: filtered });
  }

  function handleGet(request, response) {
    const id = routeId(request.url);
    const row = findExpense(loadCache(), id);
    if (!row) return sendJson(response, 404, { ok: false, error: "Gasto economico no encontrado." });
    return sendJson(response, 200, { ok: true, expense: row });
  }

  async function handleDraftCreate(request, response) {
    return mutate(request, response, ({ body, cache, rows, now }) => {
      const input = normalizeExpense(body, "borrador");
      validateDraft(input);
      const replay = idempotentReplay(rows, input.clave_idempotencia, input.hash_payload);
      if (replay) return replay;
      input.id_gasto_economico = backendNextNumericId(rows, "id_gasto_economico");
      input.creado_en = now;
      input.actualizado_en = now;
      rows.push(input);
      return { status: 201, payload: { ok: true, idempotent: false, expense: input } };
    });
  }

  async function handleDraftUpdate(request, response) {
    return mutate(request, response, ({ body, cache, rows, now }) => {
      const current = findExpense(cache, routeId(request.url));
      if (!current) return result(404, "Gasto economico no encontrado.");
      if (current.estado !== "borrador") return result(409, "Solo puede editarse un borrador.");
      const input = normalizeExpense({
        ...current,
        ...body,
        id_gasto_economico: current.id_gasto_economico,
        hash_payload: body.clave_idempotencia ? text(body.hash_payload) : current.hash_payload
      }, "borrador");
      validateDraft(input);
      const replay = idempotentReplay(rows, input.clave_idempotencia, input.hash_payload, current.id_gasto_economico);
      if (replay) return replay;
      Object.assign(current, input, { actualizado_en: now });
      return { payload: { ok: true, idempotent: false, expense: current } };
    });
  }

  async function handleConfirm(request, response) {
    return mutate(request, response, ({ body, cache, rows, now }) => {
      const current = findExpense(cache, routeId(request.url));
      if (!current) return result(404, "Gasto economico no encontrado.");
      if (current.estado === "confirmado") return replayOrConflict(current, body);
      if (current.estado !== "borrador") return result(409, "El gasto descartado no puede confirmarse.");
      const candidate = normalizeExpense({ ...current, ...body, estado: "confirmado" }, "confirmado");
      validateConfirmed(candidate, rows, backendId(current.id_gasto_economico), cache);
      applyOperationIdentity(candidate, body);
      Object.assign(current, candidate, { confirmado_en: now, actualizado_en: now });
      return { payload: { ok: true, idempotent: false, expense: current } };
    });
  }

  async function handleDiscard(request, response) {
    return mutate(request, response, ({ body, cache, now }) => {
      const current = findExpense(cache, routeId(request.url));
      if (!current) return result(404, "Gasto economico no encontrado.");
      if (current.estado === "descartado") return replayOrConflict(current, body);
      if (current.estado !== "borrador") return result(409, "Un gasto confirmado no puede descartarse.");
      const motivo = text(body.motivo);
      if (!motivo) return result(400, "El motivo de descarte es obligatorio.");
      applyOperationIdentity(current, body);
      Object.assign(current, { estado: "descartado", motivo, actualizado_en: now });
      return { payload: { ok: true, idempotent: false, expense: current } };
    });
  }

  async function handleAdjustment(request, response) {
    return createDerived(request, response, "ajuste");
  }

  async function handleReversal(request, response) {
    return createDerived(request, response, "reversion");
  }

  async function createDerived(request, response, movementType) {
    return mutate(request, response, ({ body, cache, rows, now }) => {
      const precedent = findExpense(cache, routeId(request.url));
      if (!precedent) return result(404, "Gasto economico precedente no encontrado.");
      if (precedent.estado !== "confirmado") return result(409, "El precedente debe estar confirmado.");
      const input = normalizeExpense({
        ...body,
        tipo_movimiento: movementType,
        id_gasto_precedente: precedent.id_gasto_economico,
        estado: "confirmado"
      }, "confirmado");
      if (!input.motivo) return result(400, "El motivo es obligatorio.");
      if (movementType === "reversion" && (
        toCents(input.importe) + toCents(precedent.importe) !== 0
      )) {
        return result(400, "La reversion total debe tener el importe contrario al gasto precedente.");
      }
      validateConfirmed(input, rows, "", cache);
      const replay = idempotentReplay(rows, input.clave_idempotencia, input.hash_payload);
      if (replay) return replay;
      input.id_gasto_economico = backendNextNumericId(rows, "id_gasto_economico");
      input.creado_en = now;
      input.actualizado_en = now;
      input.confirmado_en = now;
      rows.push(input);
      return { status: 201, payload: { ok: true, idempotent: false, expense: input } };
    });
  }

  async function mutate(request, response, operation) {
    try {
      const body = await readJsonBody(request);
      const cache = JSON.parse(JSON.stringify(loadCache()));
      cache.tables ||= {};
      ["gastos_economicos", "etiquetas"].forEach((name) => ensureBackendTable(cache.tables, name));
      const table = cache.tables.gastos_economicos;
      const outcome = operation({ body, cache, rows: table.rows, now: new Date().toISOString() });
      if (outcome.status && outcome.status >= 400) return sendJson(response, outcome.status, outcome.payload);
      table.headers = expectedBackendColumns.gastos_economicos;
      table.rowCount = table.rows.length;
      table.updatedAt = new Date().toISOString();
      cache.generatedAt = table.updatedAt;
      saveBackendCache(cache);
      return sendJson(response, outcome.status || 200, outcome.payload);
    } catch (error) {
      return sendJson(response, error.status || 400, { ok: false, error: error.message });
    }
  }

  function normalizeExpense(source, defaultState) {
    const row = {
      id_gasto_economico: backendId(source.id_gasto_economico),
      periodo_economico: text(source.periodo_economico),
      id_etiqueta: backendId(source.id_etiqueta),
      concepto: text(source.concepto),
      tipo_economico: text(source.tipo_economico),
      tipo_movimiento: text(source.tipo_movimiento || "original"),
      importe: normalizeMoney(source.importe),
      estado: text(source.estado || defaultState),
      origen_tipo: text(source.origen_tipo),
      origen_id: backendId(source.origen_id),
      origen_subclave: text(source.origen_subclave),
      id_gasto_precedente: backendId(source.id_gasto_precedente),
      motivo: text(source.motivo),
      clave_idempotencia: text(source.clave_idempotencia),
      hash_payload: text(source.hash_payload),
      creado_en: text(source.creado_en),
      actualizado_en: text(source.actualizado_en),
      confirmado_en: text(source.confirmado_en)
    };
    if (row.clave_idempotencia && !row.hash_payload) row.hash_payload = payloadHash(row);
    return row;
  }

  function validateDraft(row) {
    if (!STATES.has(row.estado) || row.estado !== "borrador") throw validation("Estado de borrador invalido.");
    if (!MOVEMENT_TYPES.has(row.tipo_movimiento)) throw validation("Tipo de movimiento invalido.");
    if (row.tipo_economico && !ECONOMIC_TYPES.has(row.tipo_economico)) throw validation("Tipo economico invalido.");
    if (!row.clave_idempotencia) throw validation("La clave idempotente es obligatoria.");
  }

  function validateConfirmed(row, rows, currentId = "", cache = {}) {
    if (row.estado !== "confirmado") throw validation("Estado confirmado invalido.");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(row.periodo_economico)) throw validation("El periodo economico es obligatorio y debe usar AAAA-MM.");
    if (!row.id_etiqueta || !row.concepto || !row.origen_tipo || !row.origen_id || !row.origen_subclave) {
      throw validation("Periodo, etiqueta, concepto, origen y origen_subclave son obligatorios.");
    }
    if (!(cache.tables?.etiquetas?.rows || []).some((tag) => backendId(tag.id_etiqueta) === row.id_etiqueta)) {
      throw validation("La etiqueta economica no existe.");
    }
    if (!ECONOMIC_TYPES.has(row.tipo_economico) || !MOVEMENT_TYPES.has(row.tipo_movimiento)) throw validation("Tipo economico o movimiento invalido.");
    if (toCents(row.importe) === 0) throw validation("El importe debe ser distinto de cero.");
    if (!row.clave_idempotencia || !row.hash_payload) throw validation("La identidad idempotente es obligatoria.");
    const duplicate = rows.find((candidate) =>
      backendId(candidate.id_gasto_economico) !== backendId(currentId)
      && candidate.estado !== "descartado"
      && candidate.origen_tipo === row.origen_tipo
      && backendId(candidate.origen_id) === backendId(row.origen_id)
      && candidate.origen_subclave === row.origen_subclave
      && candidate.tipo_economico === row.tipo_economico
      && candidate.tipo_movimiento === row.tipo_movimiento
    );
    if (duplicate) throw conflict("Ya existe un gasto con la misma identidad funcional.");
  }

  function idempotentReplay(rows, key, hash, ignoredId = "") {
    if (!key) throw validation("La clave idempotente es obligatoria.");
    const existing = rows.find((row) => row.clave_idempotencia === key && backendId(row.id_gasto_economico) !== backendId(ignoredId));
    if (!existing) return null;
    if (existing.hash_payload !== hash) return result(409, "La clave idempotente fue reutilizada con otro payload.");
    return { payload: { ok: true, idempotent: true, expense: existing } };
  }

  function replayOrConflict(current, body) {
    const key = text(body.clave_idempotencia);
    const hash = text(body.hash_payload);
    if (key && key === current.clave_idempotencia && (!hash || hash === current.hash_payload)) {
      return { payload: { ok: true, idempotent: true, expense: current } };
    }
    return result(409, "La operacion ya fue aplicada con otro payload.");
  }

  function applyOperationIdentity(target, body) {
    const key = text(body.clave_idempotencia || target.clave_idempotencia);
    const hash = text(body.hash_payload) || payloadHash({ ...target, ...body });
    if (!key) throw validation("La clave idempotente es obligatoria.");
    target.clave_idempotencia = key;
    target.hash_payload = hash;
  }

  function findExpense(cache, id) {
    return (cache.tables?.gastos_economicos?.rows || []).find((row) => backendId(row.id_gasto_economico) === backendId(id));
  }

  return {
    handleAdjustment,
    handleConfirm,
    handleDiscard,
    handleDraftCreate,
    handleDraftUpdate,
    handleGet,
    handleList,
    handleReversal
  };
}

function routeId(url) {
  return decodeURIComponent(new URL(url, "http://localhost").pathname.split("/")[3] || "");
}

function text(value) {
  return String(value ?? "").trim();
}

function payloadHash(value) {
  const copy = { ...value };
  delete copy.hash_payload;
  delete copy.creado_en;
  delete copy.actualizado_en;
  delete copy.confirmado_en;
  return crypto.createHash("sha256").update(JSON.stringify(copy)).digest("hex");
}

function result(status, error) {
  return { status, payload: { ok: false, error } };
}

function validation(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function conflict(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}

module.exports = { createEconomicExpensesService };
