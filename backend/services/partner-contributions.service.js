const { fromCents, toCents } = require("../../shared/money");
const { strictMoneyToCents } = require("../utils/money-input");

function createPartnerContributionsService({
  backendId,
  backendNextNumericId,
  backendNumber,
  ensureBackendTable,
  loadCache,
  normalizePartnerName,
  readJsonBody,
  sendJson,
  failureInjector = () => {},
  saveBackendCache
}) {
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
        && Math.abs(toCents(backendNumber(row.monto))) === toCents(contribution.monto)
      ));
      if (exists) return;
      const matchedExpense = cache.tables.egresos.rows.find((expense) => (
        !linkedExpenseIds.has(String(expense.id_egreso || "").trim())
        && toCents(backendNumber(expense.total)) < 0
        && Math.abs(toCents(backendNumber(expense.total))) === toCents(contribution.monto)
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

  async function handlePartnerContributionFullEntry(request, response) {
    try {
      const body = await readJsonBody(request);
      const operationId = String(body.operationId || "").trim();
      const contribution = body.contribution || {};
      const amountCents = strictMoneyToCents(contribution.monto);
      if (!operationId) throw new Error("Falta el identificador de operación.");
      if (!contribution.fecha || !normalizePartnerName(contribution.nombre) || !["Aporte", "Retiro"].includes(contribution.tipo) || amountCents <= 0) {
        throw new Error("Fecha, socio, tipo y monto positivo son obligatorios.");
      }
      const operationPayload = stableSerialize({ contribution });

      const cache = JSON.parse(JSON.stringify(loadCache()));
      cache.tables ||= {};
      ensureBackendTable(cache.tables, "aportes_socios");
      ensureBackendTable(cache.tables, "egresos");
      const existing = cache.tables.aportes_socios.rows.find((row) => row._operationId === operationId);
      if (existing) {
        assertSameOperation(existing._operationPayload, operationPayload);
        const expense = cache.tables.egresos.rows.find((row) => (
          row._operationId === operationId && backendId(row.id_egreso) === backendId(existing.id_egreso)
        ));
        if (!expense) throwConflict("La operación existente no conserva el egreso relacionado.");
        return sendJson(response, 200, {
          ok: true,
          idempotent: true,
          contributionId: existing.id_aporte_socio,
          expenseId: existing.id_egreso
        });
      }

      const contributionId = backendNextNumericId(cache.tables.aportes_socios.rows, "id_aporte_socio");
      const expenseId = backendNextNumericId(cache.tables.egresos.rows, "id_egreso");
      const signedAmount = fromCents(contribution.tipo === "Aporte" ? -amountCents : amountCents);
      const timestamp = new Date().toISOString();
      cache.tables.egresos.rows.push({
        _rowNumber: cache.tables.egresos.rows.length + 2,
        id_egreso: expenseId,
        fecha_factura: contribution.fecha,
        fecha_prevista_pago: contribution.fecha,
        id_etiqueta: "",
        tipo_factura: "Aporte_Retiro_Socio",
        nro_factura: `${contribution.tipo === "Aporte" ? "AP" : "RT"}-${String(contributionId).padStart(6, "0")}`,
        iva: 0,
        per_ret_iva: 0,
        per_ret_iibb: 0,
        imp_internos: 0,
        subtotal: signedAmount,
        total: signedAmount,
        _operationId: operationId,
        _editedLocallyAt: timestamp
      });
      failureInjector("after-expense");
      cache.tables.aportes_socios.rows.push({
        _rowNumber: cache.tables.aportes_socios.rows.length + 2,
        id_aporte_socio: contributionId,
        fecha: contribution.fecha,
        nombre: contribution.nombre,
        tipo: contribution.tipo,
        monto: fromCents(amountCents),
        id_egreso: expenseId,
        _operationId: operationId,
        _operationPayload: operationPayload,
        _editedLocallyAt: timestamp
      });
      cache.tables.egresos.rowCount = cache.tables.egresos.rows.length;
      cache.tables.aportes_socios.rowCount = cache.tables.aportes_socios.rows.length;
      cache.generatedAt = timestamp;
      saveBackendCache(cache);
      return sendJson(response, 200, { ok: true, idempotent: false, contributionId, expenseId });
    } catch (error) {
      return sendJson(response, error.statusCode || 400, { ok: false, error: `No se guardó el aporte/retiro completo: ${error.message}` });
    }
  }

  function assertSameOperation(existingPayload, requestedPayload) {
    if (existingPayload === requestedPayload) return;
    const error = new Error("La clave de operación ya fue usada con un contenido diferente.");
    error.statusCode = 409;
    throw error;
  }

  function throwConflict(message) {
    const error = new Error(message);
    error.statusCode = 409;
    throw error;
  }

  function stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value ?? null);
  }

  return { ensurePartnerContributionsHistory, handlePartnerContributionFullEntry };
}

module.exports = { createPartnerContributionsService };
