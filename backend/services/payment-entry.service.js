const { fromCents, toCents } = require("../../shared/money");
const { strictMoneyToCents } = require("../utils/money-input");

function createPaymentEntryService({
  backendId,
  backendNextNumericId,
  backendNumber,
  ensureBackendTable,
  loadCache,
  readJsonBody,
  saveBackendCache,
  sendJson,
  failureInjector = () => {}
}) {
  async function handlePaymentFullEntry(request, response) {
    try {
      const body = await readJsonBody(request);
      const operationId = String(body.operationId || "").trim();
      const payment = body.payment || {};
      const details = Array.isArray(body.details) ? body.details : [];
      validate(operationId, payment, details);
      const operationPayload = stableSerialize({ payment, details });

      const cache = JSON.parse(JSON.stringify(loadCache()));
      cache.tables ||= {};
      ["pagos", "detalle_pagos", "egresos"].forEach((name) => ensureBackendTable(cache.tables, name));
      const existing = cache.tables.pagos.rows.find((row) => (
        row._operationId === operationId || row._paymentCreationOperationId === operationId
      ));
      if (existing) {
        const existingPayload = existing._operationId === operationId
          ? existing._operationPayload
          : existing._paymentCreationOperationPayload;
        assertSameOperation(existingPayload, operationPayload);
        const savedDetails = cache.tables.detalle_pagos.rows.filter((row) => (
          row._operationId === operationId && backendId(row.id_pago) === backendId(existing.id_pago)
        ));
        if (savedDetails.length !== details.length) {
          throwConflict("La operación existente tiene detalles incompletos o contradictorios.");
        }
        return sendJson(response, 200, { ok: true, idempotent: true, paymentId: existing.id_pago });
      }

      const expenses = new Map(cache.tables.egresos.rows.map((row) => [backendId(row.id_egreso), row]));
      if (details.some((row) => !expenses.has(backendId(row.idEgreso)))) {
        throw new Error("Un egreso seleccionado ya no existe.");
      }
      validateExpenseBalances(cache.tables, expenses, details);
      const paymentId = backendNextNumericId(cache.tables.pagos.rows, "id_pago");
      const firstDetailId = backendNextNumericId(cache.tables.detalle_pagos.rows, "id_detalle_pago");
      const timestamp = new Date().toISOString();
      const total = fromCents(details.reduce(
        (sum, row) => sum + strictMoneyToCents(row.monto),
        0
      ));
      cache.tables.pagos.rows.push({
        _rowNumber: cache.tables.pagos.rows.length + 2,
        id_pago: paymentId,
        fecha_pago: payment.fecha,
        metodo: payment.metodo,
        banco: payment.banco || "",
        monto: total,
        _operationId: operationId,
        _operationPayload: operationPayload,
        _editedLocallyAt: timestamp
      });
      failureInjector("after-payment");
      details.forEach((detail, index) => {
        cache.tables.detalle_pagos.rows.push({
          _rowNumber: cache.tables.detalle_pagos.rows.length + 2,
          id_detalle_pago: firstDetailId + index,
          id_pago: paymentId,
          id_egreso: detail.idEgreso,
          monto_cancelado: fromCents(strictMoneyToCents(detail.monto)),
          _operationId: operationId,
          _editedLocallyAt: timestamp
        });
      });
      cache.tables.pagos.rowCount = cache.tables.pagos.rows.length;
      cache.tables.detalle_pagos.rowCount = cache.tables.detalle_pagos.rows.length;
      cache.generatedAt = timestamp;
      saveBackendCache(cache);
      return sendJson(response, 200, { ok: true, idempotent: false, paymentId });
    } catch (error) {
      return sendJson(response, error.statusCode || 400, { ok: false, error: `No se guardó el pago completo: ${error.message}` });
    }
  }

  function validate(operationId, payment, details) {
    if (!operationId) throw new Error("Falta el identificador de operación.");
    if (!payment.fecha || !payment.metodo) throw new Error("Fecha y método son obligatorios.");
    if (!details.length) throw new Error("El pago no tiene egresos aplicados.");
    if (details.some((row) => (
      !backendId(row.idEgreso) || strictMoneyToCents(row.monto) === 0
    ))) {
      throw new Error("Los detalles del pago son inválidos.");
    }
    const signs = new Set(details.map((row) => Math.sign(strictMoneyToCents(row.monto))));
    if (signs.size > 1) throw new Error("Un pago no puede mezclar montos con signos opuestos.");
  }

  function validateExpenseBalances(tables, expenses, details) {
    const paidByExpense = new Map();
    (tables.detalle_pagos.rows || []).forEach((row) => {
      const expenseId = backendId(row.id_egreso);
      paidByExpense.set(
        expenseId,
        (paidByExpense.get(expenseId) || 0) + toCents(backendNumber(row.monto_cancelado))
      );
    });
    details.forEach((row) => {
      const expenseId = backendId(row.idEgreso);
      const totalCents = toCents(backendNumber(expenses.get(expenseId).total));
      const remainingCents = totalCents - (paidByExpense.get(expenseId) || 0);
      const amountCents = strictMoneyToCents(row.monto);
      if (
        Math.sign(amountCents) !== Math.sign(remainingCents)
        || Math.abs(amountCents) > Math.abs(remainingCents)
      ) {
        throw new Error(`El monto aplicado supera o contradice el saldo del egreso ${expenseId}.`);
      }
      paidByExpense.set(expenseId, (paidByExpense.get(expenseId) || 0) + amountCents);
    });
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

  return { handlePaymentFullEntry };
}

module.exports = { createPaymentEntryService };
