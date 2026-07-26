const { toCents } = require("../../shared/money");

const ENDORSEMENT_METHOD = "Endoso";
const ENDORSED_STATUS = "Endosado";

function validateReceivedCheckEndorsementRow(row, payments) {
  const status = clean(row?.estado);
  const depositId = clean(row?.id_deposito);
  const depositDate = clean(row?.fecha_deposito);
  const paymentId = clean(row?.id_pago_endoso);
  const endorsementDate = clean(row?.fecha_endoso);

  if (status === "Pendiente") {
    if (depositId || depositDate || paymentId || endorsementDate) {
      throw validationError("RECEIVED_CHECK_PENDING_REFERENCES", "Un cheque pendiente no puede tener depósito ni endoso.");
    }
    return;
  }

  if (status === "Depositado") {
    if (!depositId) {
      throw validationError("RECEIVED_CHECK_DEPOSIT_REQUIRED", "Un cheque depositado debe tener id_deposito.");
    }
    if (paymentId || endorsementDate) {
      throw validationError("RECEIVED_CHECK_DEPOSIT_ENDORSEMENT_CONFLICT", "Un cheque depositado no puede estar endosado.");
    }
    return;
  }

  if (status !== ENDORSED_STATUS) {
    throw validationError("RECEIVED_CHECK_STATUS_INVALID", `Estado de cheque no admitido para una operación nueva: ${status || "(vacío)"}.`);
  }
  if (!paymentId) {
    throw validationError("RECEIVED_CHECK_ENDORSEMENT_PAYMENT_REQUIRED", "Un cheque endosado debe tener id_pago_endoso.");
  }
  if (!isIsoDate(endorsementDate)) {
    throw validationError("RECEIVED_CHECK_ENDORSEMENT_DATE_REQUIRED", "Un cheque endosado debe tener fecha_endoso válida en formato AAAA-MM-DD.");
  }
  if (depositId || depositDate) {
    throw validationError("RECEIVED_CHECK_ENDORSEMENT_DEPOSIT_CONFLICT", "Un cheque endosado no puede estar depositado.");
  }

  const payment = paymentById(payments).get(paymentId);
  if (!payment) {
    throw validationError("RECEIVED_CHECK_ENDORSEMENT_PAYMENT_NOT_FOUND", "El pago de endoso no existe.");
  }
  if (normalize(payment.metodo) !== normalize(ENDORSEMENT_METHOD)) {
    throw validationError("RECEIVED_CHECK_ENDORSEMENT_METHOD_INVALID", "El método del pago vinculado debe ser Endoso.");
  }
}

function validateReceivedCheckEndorsementOperation({ previousRows, endorsedRows, payment, payments }) {
  const rows = Array.isArray(endorsedRows) ? endorsedRows : [];
  if (!rows.length) {
    throw validationError("RECEIVED_CHECK_ENDORSEMENT_EMPTY", "El endoso debe incluir al menos un cheque.");
  }

  const paymentId = clean(payment?.id_pago);
  if (!paymentId) {
    throw validationError("RECEIVED_CHECK_ENDORSEMENT_PAYMENT_REQUIRED", "El pago de endoso debe tener id_pago.");
  }
  const paymentRows = [...(Array.isArray(payments) ? payments : []), payment];
  const previousById = new Map((previousRows || []).map((row) => [clean(row.id_cheque_recibido), row]));
  const seenChecks = new Set();

  rows.forEach((row) => {
    const checkId = clean(row.id_cheque_recibido);
    if (!checkId || seenChecks.has(checkId)) {
      throw validationError("RECEIVED_CHECK_ENDORSEMENT_DUPLICATE", "Cada cheque puede aparecer una sola vez en el endoso.");
    }
    seenChecks.add(checkId);

    const previous = previousById.get(checkId);
    if (!previous) {
      throw validationError("RECEIVED_CHECK_ENDORSEMENT_CHECK_NOT_FOUND", "Uno de los cheques seleccionados no existe.");
    }
    validateReusablePendingCheck(previous);
    if (clean(row.id_pago_endoso) !== paymentId) {
      throw validationError("RECEIVED_CHECK_ENDORSEMENT_PAYMENT_MISMATCH", "Todos los cheques deben vincularse con el mismo pago.");
    }
    validateReceivedCheckEndorsementRow(row, paymentRows);
  });

  const checkTotal = rows.reduce((total, row) => total + toCents(row.monto), 0);
  const paymentTotal = toCents(payment.monto);
  if (checkTotal !== paymentTotal) {
    throw validationError("RECEIVED_CHECK_ENDORSEMENT_TOTAL_MISMATCH", "La suma de los cheques debe coincidir exactamente con el importe del pago.");
  }
}

function validateReusablePendingCheck(row) {
  if (clean(row.estado) !== "Pendiente") {
    throw validationError("RECEIVED_CHECK_ENDORSEMENT_NOT_PENDING", "Solo pueden endosarse cheques pendientes.");
  }
  if (clean(row.id_deposito) || clean(row.fecha_deposito) || clean(row.id_pago_endoso) || clean(row.fecha_endoso)) {
    throw validationError("RECEIVED_CHECK_ENDORSEMENT_ALREADY_USED", "El cheque ya fue depositado, endosado o marcado como utilizado.");
  }
}

function paymentById(payments) {
  return new Map((payments || []).map((payment) => [clean(payment.id_pago), payment]));
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function clean(value) {
  return String(value ?? "").trim();
}

function normalize(value) {
  return clean(value).toLowerCase();
}

function validationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  ENDORSED_STATUS,
  ENDORSEMENT_METHOD,
  validateReceivedCheckEndorsementOperation,
  validateReceivedCheckEndorsementRow,
  validateReusablePendingCheck
};
