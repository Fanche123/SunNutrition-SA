const { fromCents, toCents } = require("../../shared/money");
const { validateReceivedCheckEndorsementOperation } = require("../utils/received-check-endorsement");

function createReceivedChecksService({
  backendId,
  ensureBackendTable,
  loadCache,
  readJsonBody,
  saveBackendCache,
  sendJson,
  failureInjector = () => {}
}) {
  function handlePendingEndorsementPaymentsList(_request, response) {
    try {
      const payments = buildPendingEndorsementPayments(loadCache(), backendId);
      return sendJson(response, 200, { ok: true, payments });
    } catch (error) {
      return sendJson(response, 400, {
        ok: false,
        error: `No se pudieron cargar los pagos de endoso pendientes: ${error.message}`
      });
    }
  }

  async function handleReceivedChecksEndorse(request, response) {
    try {
      const body = await readJsonBody(request);
      const operationId = clean(body.operationId);
      const paymentId = backendId(body.paymentId);
      const endorsementDate = clean(body.endorsementDate);
      const rawCheckIds = Array.isArray(body.checkIds) ? body.checkIds.map(backendId) : [];
      if (!operationId) throw httpError(400, "Falta una clave durable de operación.");
      if (!paymentId) throw httpError(400, "Falta el pago de endoso.");
      if (!isIsoDate(endorsementDate)) throw httpError(400, "La fecha de endoso debe ser válida.");
      if (!rawCheckIds.length || rawCheckIds.some((id) => !id)) {
        throw httpError(400, "Seleccioná al menos un cheque válido.");
      }
      if (new Set(rawCheckIds).size !== rawCheckIds.length) {
        throw httpError(400, "Los IDs de cheques no pueden repetirse.");
      }

      const checkIds = rawCheckIds.slice().sort(compareIds);
      const operationPayload = stableSerialize({ paymentId, checkIds, endorsementDate });
      const current = loadCache();
      const currentPayments = current.tables?.pagos?.rows || [];
      const currentChecks = current.tables?.cheques_recibidos?.rows || [];
      const replay = findOperation(currentPayments, currentChecks, operationId);
      if (replay) {
        assertSameOperation(replay.payment._operationPayload, operationPayload);
        return sendJson(response, 200, {
          ok: true,
          idempotent: true,
          paymentId: backendId(replay.payment.id_pago),
          checkIds: replay.checkIds
        });
      }

      const cache = JSON.parse(JSON.stringify(current));
      cache.tables ||= {};
      ensureBackendTable(cache.tables, "pagos");
      ensureBackendTable(cache.tables, "cheques_recibidos");
      const payments = cache.tables.pagos.rows || [];
      const checks = cache.tables.cheques_recibidos.rows || [];
      const payment = payments.find((row) => backendId(row.id_pago) === paymentId);
      if (!payment) throw httpError(404, "El pago seleccionado no existe.");
      if (clean(payment.metodo) !== "Endoso") {
        throw httpError(409, "El método del pago seleccionado debe ser exactamente Endoso.");
      }

      const selectedChecks = checkIds.map((id) => (
        checks.find((row) => backendId(row.id_cheque_recibido) === id)
      ));
      if (selectedChecks.some((row) => !row)) {
        throw httpError(404, "Uno de los cheques seleccionados no existe.");
      }

      const timestamp = new Date().toISOString();
      const endorsedRows = selectedChecks.map((row) => ({
        ...row,
        estado: "Endosado",
        id_pago_endoso: paymentId,
        fecha_endoso: endorsementDate,
        _editedLocallyAt: timestamp
      }));
      try {
        validateReceivedCheckEndorsementOperation({
          previousRows: checks,
          endorsedRows,
          payment,
          payments
        });
      } catch (error) {
        throw httpError(endorsementStatus(error.code), error.message);
      }

      endorsedRows.forEach((endorsed) => {
        const row = checks.find((candidate) => (
          backendId(candidate.id_cheque_recibido) === backendId(endorsed.id_cheque_recibido)
        ));
        row.estado = endorsed.estado;
        row.id_pago_endoso = endorsed.id_pago_endoso;
        row.fecha_endoso = endorsed.fecha_endoso;
        row._editedLocallyAt = timestamp;
      });
      if (payment._operationId && payment._operationId !== operationId) {
        payment._paymentCreationOperationId = payment._operationId;
        payment._paymentCreationOperationPayload = payment._operationPayload;
      }
      payment._operationId = operationId;
      payment._operationPayload = operationPayload;
      failureInjector("after-check-updates");
      cache.generatedAt = timestamp;
      saveBackendCache(cache);
      return sendJson(response, 201, {
        ok: true,
        idempotent: false,
        paymentId,
        checkIds
      });
    } catch (error) {
      return sendJson(response, error.statusCode || 400, {
        ok: false,
        error: `No se pudo endosar los cheques: ${error.message}`
      });
    }
  }

  function findOperation(payments, checks, operationId) {
    const payment = payments.find((row) => row._operationId === operationId);
    if (!payment) return null;
    const paymentId = backendId(payment.id_pago);
    return {
      payment,
      checkIds: checks
        .filter((row) => backendId(row.id_pago_endoso) === paymentId)
        .map((row) => backendId(row.id_cheque_recibido))
        .sort(compareIds)
    };
  }

  function assertSameOperation(existing, requested) {
    if (existing === requested) return;
    throw httpError(409, "La clave de operación ya fue usada con un contenido diferente.");
  }

  function stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value ?? null);
  }

  return { handlePendingEndorsementPaymentsList, handleReceivedChecksEndorse };
}

function buildPendingEndorsementPayments(cache, backendId) {
  const payments = cache.tables?.pagos?.rows || [];
  const paymentDetails = cache.tables?.detalle_pagos?.rows || [];
  const checks = cache.tables?.cheques_recibidos?.rows || [];
  const currentPayments = payments
    .map((payment) => ({
      payment,
      creation: currentPaymentCreation(payment, paymentDetails, backendId)
    }))
    .filter((item) => item.creation);
  const currentPaymentIds = new Set(
    currentPayments.map((item) => backendId(item.payment.id_pago))
  );
  const assignedByPayment = new Map();
  const checksById = new Map();

  checks.forEach((check) => {
    const checkId = backendId(check.id_cheque_recibido);
    if (!checkId) return;
    const rows = checksById.get(checkId) || [];
    rows.push(check);
    checksById.set(checkId, rows);
  });

  checksById.forEach((rows) => {
    if (rows.length !== 1) return;
    const check = rows[0];
    const paymentId = backendId(check.id_pago_endoso);
    if (!validCurrentEndorsementCheck(check, paymentId, currentPaymentIds)) return;
    const checkCents = safeCents(check.monto);
    if (checkCents === null) return;
    assignedByPayment.set(paymentId, (assignedByPayment.get(paymentId) || 0) + checkCents);
  });

  return currentPayments
    .map(({ payment, creation }) => {
      const paymentId = backendId(payment.id_pago);
      const assignedCents = assignedByPayment.get(paymentId) || 0;
      const differenceCents = creation.paymentCents - assignedCents;
      return {
        payment: {
          id_pago: payment.id_pago,
          fecha_pago: payment.fecha_pago,
          referencia: payment.referencia || "",
          monto: fromCents(creation.paymentCents)
        },
        paymentCents: creation.paymentCents,
        assignedCents,
        differenceCents
      };
    })
    .filter((item) => item.differenceCents !== 0);
}

function currentPaymentCreation(payment, paymentDetails, backendId) {
  if (
    !backendId(payment.id_pago)
    || clean(payment.metodo) !== "Endoso"
    || !clean(payment.fecha_pago)
  ) return null;

  const preserved = clean(payment._paymentCreationOperationId)
    && clean(payment._paymentCreationOperationPayload)
    ? {
      operationId: clean(payment._paymentCreationOperationId),
      payload: clean(payment._paymentCreationOperationPayload)
    }
    : null;
  const creation = preserved || (
    clean(payment._operationId) && clean(payment._operationPayload)
      ? {
        operationId: clean(payment._operationId),
        payload: clean(payment._operationPayload)
      }
      : null
  );
  if (!creation) return null;

  let payload;
  try {
    payload = JSON.parse(creation.payload);
  } catch (_error) {
    return null;
  }
  if (
    !payload
    || typeof payload !== "object"
    || !payload.payment
    || clean(payload.payment.metodo) !== "Endoso"
    || clean(payload.payment.fecha) !== clean(payment.fecha_pago)
    || !Array.isArray(payload.details)
    || !payload.details.length
  ) return null;

  const paymentId = backendId(payment.id_pago);
  const savedDetails = paymentDetails.filter((detail) => (
    backendId(detail.id_pago) === paymentId
    && clean(detail._operationId) === creation.operationId
  ));
  if (savedDetails.length !== payload.details.length) return null;

  const requestedDetails = detailSignatures(
    payload.details,
    (detail) => backendId(detail.idEgreso),
    (detail) => detail.monto
  );
  const persistedDetails = detailSignatures(
    savedDetails,
    (detail) => backendId(detail.id_egreso),
    (detail) => detail.monto_cancelado
  );
  if (!requestedDetails || !persistedDetails) return null;
  if (requestedDetails.join("|") !== persistedDetails.join("|")) return null;

  const paymentCents = safeCents(payment.monto);
  const detailTotalCents = savedDetails.reduce((total, detail) => {
    const cents = safeCents(detail.monto_cancelado);
    return cents === null ? Number.NaN : total + cents;
  }, 0);
  if (paymentCents === null || !Number.isSafeInteger(detailTotalCents) || paymentCents !== detailTotalCents) {
    return null;
  }
  return { operationId: creation.operationId, paymentCents };
}

function detailSignatures(details, idFor, amountFor) {
  const signatures = [];
  for (const detail of details) {
    const id = idFor(detail);
    const cents = safeCents(amountFor(detail));
    if (!id || cents === null || cents === 0) return null;
    signatures.push(`${id}:${cents}`);
  }
  return signatures.sort();
}

function validCurrentEndorsementCheck(check, paymentId, currentPaymentIds) {
  return Boolean(
    paymentId
    && currentPaymentIds.has(paymentId)
    && clean(check.estado) === "Endosado"
    && isIsoDate(clean(check.fecha_endoso))
    && !clean(check.id_deposito)
    && !clean(check.fecha_deposito)
  );
}

function safeCents(value) {
  try {
    return toCents(value);
  } catch (_error) {
    return null;
  }
}

function endorsementStatus(code) {
  if (code === "RECEIVED_CHECK_ENDORSEMENT_CHECK_NOT_FOUND") return 404;
  if ([
    "RECEIVED_CHECK_ENDORSEMENT_TOTAL_MISMATCH",
    "RECEIVED_CHECK_ENDORSEMENT_NOT_PENDING",
    "RECEIVED_CHECK_ENDORSEMENT_ALREADY_USED",
    "RECEIVED_CHECK_ENDORSEMENT_METHOD_INVALID"
  ].includes(code)) return 409;
  return 400;
}

function compareIds(left, right) {
  return String(left).localeCompare(String(right), "es", { numeric: true });
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function clean(value) {
  return String(value ?? "").trim();
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = { buildPendingEndorsementPayments, createReceivedChecksService };
