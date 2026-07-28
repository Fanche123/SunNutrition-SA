const crypto = require("crypto");
const { fromCents, normalize: normalizeMoney, toCents } = require("../../shared/money");

const COMPONENTS = new Set(["base_subtotal", "capital_refinanciado", "interes_financiero", "interes_resarcitorio", "otro"]);

function createEconomicExpenseApplicationsService(dependencies) {
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

  function handleReconciliation(request, response) {
    const cache = loadCache();
    const expenseId = decodeURIComponent(new URL(request.url, "http://localhost").pathname.split("/").pop());
    const applications = activeRows(cache).filter((row) => backendId(row.id_egreso) === backendId(expenseId));
    const economicById = new Map((cache.tables?.gastos_economicos?.rows || []).map((row) => [backendId(row.id_gasto_economico), row]));
    const totalCents = applications.reduce(
      (sum, row) => sum + toCents(row.importe_aplicado || 0),
      0
    );
    const expense = (cache.tables?.egresos?.rows || []).find((row) => backendId(row.id_egreso) === backendId(expenseId));
    const documentAmountCents = toCents(expense?.subtotal || expense?.total || 0);
    const differenceCents = documentAmountCents - totalCents;
    const reconciliationState = !applications.length
      ? "sin_aplicaciones"
      : Math.abs(differenceCents) <= 1
        ? "conciliado"
        : differenceCents < 0
          ? "sobreaplicado"
          : "parcial";
    return sendJson(response, 200, {
      ok: true,
      reconciliation: {
        id_egreso: backendId(expenseId),
        importe_documental: fromCents(documentAmountCents),
        importe_aplicado: fromCents(totalCents),
        diferencia_documental: fromCents(differenceCents),
        estado: reconciliationState,
        applications: applications.map((row) => ({ ...row, gasto: economicById.get(backendId(row.id_gasto_economico)) || null }))
      }
    });
  }

  async function handleCreate(request, response) {
    return mutate(request, response, ({ body, cache, rows, now }) => {
      const input = normalize(body, "original", "vigente");
      validateNew(input, cache);
      const replay = replayFor(rows, input);
      if (replay) return replay;
      validateCapacity(input, cache);
      input.id_gasto_egreso = backendNextNumericId(rows, "id_gasto_egreso");
      input.creado_en = now;
      rows.push(input);
      return { status: 201, payload: { ok: true, idempotent: false, application: input } };
    });
  }

  async function handleReplace(request, response) {
    return derived(request, response, "sustitucion", "sustituida");
  }

  async function handleReverse(request, response) {
    return derived(request, response, "reversion", "revertida");
  }

  async function derived(request, response, type, precedingState) {
    return mutate(request, response, ({ body, cache, rows, now }) => {
      const precedingId = routeApplicationId(request.url);
      const preceding = rows.find((row) => backendId(row.id_gasto_egreso) === backendId(precedingId));
      if (!preceding) return result(404, "Aplicacion precedente no encontrada.");
      const source = type === "reversion" ? { ...preceding, ...body, importe_aplicado: preceding.importe_aplicado } : { ...preceding, ...body };
      const input = normalize({ ...source, id_aplicacion_precedente: preceding.id_gasto_egreso }, type, type === "reversion" ? "revertida" : "vigente");
      const replay = replayFor(rows, input);
      if (replay) return replay;
      if (preceding.estado !== "vigente") return result(409, "La aplicacion precedente ya no esta vigente.");
      if (referencesAncestor(rows, preceding, backendId(body.id_aplicacion_precedente))) return result(409, "La referencia produciria un ciclo.");
      if (!input.motivo) return result(400, "El motivo es obligatorio.");
      validateNew(input, cache);
      if (type === "sustitucion") validateCapacity(input, cache, preceding.id_gasto_egreso);
      preceding.estado = precedingState;
      input.id_gasto_egreso = backendNextNumericId(rows, "id_gasto_egreso");
      input.creado_en = now;
      rows.push(input);
      return { status: 201, payload: { ok: true, idempotent: false, application: input } };
    });
  }

  async function mutate(request, response, operation) {
    try {
      const body = await readJsonBody(request);
      const cache = JSON.parse(JSON.stringify(loadCache()));
      cache.tables ||= {};
      ["gastos_economicos", "gastos_egresos", "egresos"].forEach((name) => ensureBackendTable(cache.tables, name));
      const table = cache.tables.gastos_egresos;
      const outcome = operation({ body, cache, rows: table.rows, now: new Date().toISOString() });
      if (outcome.status && outcome.status >= 400) return sendJson(response, outcome.status, outcome.payload);
      table.headers = expectedBackendColumns.gastos_egresos;
      table.rowCount = table.rows.length;
      table.updatedAt = new Date().toISOString();
      cache.generatedAt = table.updatedAt;
      saveBackendCache(cache);
      return sendJson(response, outcome.status || 200, outcome.payload);
    } catch (error) {
      return sendJson(response, error.status || 400, { ok: false, error: error.message });
    }
  }

  function normalize(source, type, state) {
    const row = {
      id_gasto_egreso: backendId(source.id_gasto_egreso),
      id_gasto_economico: backendId(source.id_gasto_economico),
      id_egreso: backendId(source.id_egreso),
      importe_aplicado: normalizeMoney(source.importe_aplicado),
      componente_egreso: text(source.componente_egreso),
      componente_otro: text(source.componente_otro),
      tipo_aplicacion: type,
      estado: state,
      id_aplicacion_precedente: backendId(source.id_aplicacion_precedente),
      motivo: text(source.motivo),
      clave_idempotencia: text(source.clave_idempotencia),
      hash_payload: text(source.hash_payload),
      creado_en: text(source.creado_en)
    };
    if (row.clave_idempotencia && !row.hash_payload) row.hash_payload = hash(row);
    return row;
  }

  function validateNew(row, cache) {
    const economic = (cache.tables.gastos_economicos.rows || []).find((item) => backendId(item.id_gasto_economico) === row.id_gasto_economico);
    if (!economic || economic.estado !== "confirmado") throw validation("El gasto economico debe existir y estar confirmado.");
    if (!(cache.tables.egresos.rows || []).some((item) => backendId(item.id_egreso) === row.id_egreso)) throw validation("El egreso no existe.");
    if (!COMPONENTS.has(row.componente_egreso)) throw validation("Componente de egreso invalido.");
    if (row.componente_egreso === "otro" && !row.componente_otro) throw validation("El otro componente debe describirse.");
    if (toCents(row.importe_aplicado) === 0) throw validation("El importe aplicado debe ser distinto de cero.");
    if (!row.clave_idempotencia || !row.hash_payload) throw validation("La identidad idempotente es obligatoria.");
    if (row.tipo_aplicacion === "original" && (row.id_aplicacion_precedente || row.motivo)) {
      throw validation("Precedente y motivo corresponden solo a sustituciones o reversiones.");
    }
    if (row.tipo_aplicacion !== "original" && (!row.id_aplicacion_precedente || !row.motivo)) {
      throw validation("Las sustituciones y reversiones requieren precedente y motivo.");
    }
  }

  function validateCapacity(input, cache, ignoredApplicationId = "") {
    const economic = cache.tables.gastos_economicos.rows.find((row) => backendId(row.id_gasto_economico) === input.id_gasto_economico);
    const applications = activeRows(cache).filter((row) => backendId(row.id_gasto_egreso) !== backendId(ignoredApplicationId));
    const appliedToExpenseCents = applications
      .filter((row) => backendId(row.id_gasto_economico) === input.id_gasto_economico)
      .reduce((sum, row) => sum + Math.abs(toCents(row.importe_aplicado || 0)), 0);
    if (
      appliedToExpenseCents + Math.abs(toCents(input.importe_aplicado))
      > Math.abs(toCents(economic.importe))
    ) {
      throw conflict("La aplicacion sobreaplica el gasto economico.");
    }
    const componentLimitCents = componentAmountCents(cache, input.id_egreso, input.componente_egreso);
    const appliedToComponentCents = applications
      .filter((row) => backendId(row.id_egreso) === input.id_egreso && row.componente_egreso === input.componente_egreso)
      .reduce((sum, row) => sum + Math.abs(toCents(row.importe_aplicado || 0)), 0);
    if (
      componentLimitCents !== null
      && appliedToComponentCents + Math.abs(toCents(input.importe_aplicado)) > componentLimitCents
    ) {
      throw conflict("La aplicacion sobreaplica el componente del egreso.");
    }
  }

  function componentAmountCents(cache, expenseId, component) {
    const expense = cache.tables.egresos.rows.find((row) => backendId(row.id_egreso) === backendId(expenseId));
    if (!expense) return null;
    if (component === "base_subtotal") return Math.abs(toCents(expense.subtotal || 0));
    return Math.abs(toCents(expense.total || 0));
  }

  function replayFor(rows, input) {
    const existing = rows.find((row) => row.clave_idempotencia === input.clave_idempotencia);
    if (!existing) return null;
    if (existing.hash_payload !== input.hash_payload) return result(409, "La clave idempotente fue reutilizada con otro payload.");
    return { payload: { ok: true, idempotent: true, application: existing } };
  }

  return { handleCreate, handleReconciliation, handleReplace, handleReverse };
}

function activeRows(cache) {
  return (cache.tables?.gastos_egresos?.rows || []).filter((row) => row.estado === "vigente" && row.tipo_aplicacion !== "reversion");
}

function referencesAncestor(rows, preceding, requestedId) {
  if (!requestedId) return false;
  let current = preceding;
  const seen = new Set();
  while (current) {
    const id = String(current.id_gasto_egreso || "");
    if (!id || seen.has(id)) return true;
    if (id === requestedId) return true;
    seen.add(id);
    current = rows.find((row) => String(row.id_gasto_egreso || "") === String(current.id_aplicacion_precedente || ""));
  }
  return false;
}

function routeApplicationId(url) {
  return decodeURIComponent(new URL(url, "http://localhost").pathname.split("/")[4] || "");
}

function text(value) {
  return String(value ?? "").trim();
}

function hash(value) {
  const copy = { ...value };
  delete copy.hash_payload;
  delete copy.creado_en;
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

module.exports = { createEconomicExpenseApplicationsService };
