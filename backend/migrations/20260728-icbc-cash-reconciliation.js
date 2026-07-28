const crypto = require("crypto");
const { EXPECTED_BACKEND_COLUMNS } = require("../config/backend-columns");
const { backendNextNumericId } = require("../utils/runtime");
const { fromCents, toCents } = require("../../shared/money");

const MIGRATION_ID = "20260728-icbc-cash-reconciliation";
const INITIAL_DATE = "2026-06-09";
const FUND_PAYMENT_COLUMN = "id_pago";
const BANK = "ICBC";

function migrateIcBcCashReconciliation(cache, options = {}) {
  const migrated = clone(cache);
  const tables = migrated.tables || (migrated.tables = {});
  const payments = requiredTable(tables, "pagos");
  const paymentDetails = requiredTable(tables, "detalle_pagos");
  const bankMovements = requiredTable(tables, "movimientos_bancarios");
  const fundMovements = requiredTable(tables, "fondos_inversion_movimientos");
  const issuedChecks = requiredTable(tables, "cheques_entregados");
  const timestamp = validTimestamp(options.timestamp) || new Date().toISOString();
  const report = {
    migrationId: MIGRATION_ID,
    action: "migrate",
    fundColumnAdded: !fundMovements.headers.includes(FUND_PAYMENT_COLUMN),
    fundPaymentsCreated: 0,
    fundPaymentsReused: 0,
    issuedCheckPaymentsCreated: 0,
    issuedCheckPaymentsReused: 0,
    bankDebitPaymentsCreated: 0,
    bankDebitPaymentsReused: 0,
    bankLinksReassigned: 0,
    exclusions: []
  };

  if (report.fundColumnAdded) {
    fundMovements.headers = [...EXPECTED_BACKEND_COLUMNS.fondos_inversion_movimientos];
    fundMovements._icbcCashBackfillColumnAdded = true;
  }

  backfillFundPayments({
    bankMovements,
    fundMovements,
    payments,
    report,
    timestamp
  });
  backfillIssuedCheckPayments({
    bankMovements,
    issuedChecks,
    paymentDetails,
    payments,
    report,
    timestamp
  });
  backfillBankDebitPayments({
    bankMovements,
    paymentDetails,
    payments,
    report,
    timestamp
  });

  const changed = report.fundColumnAdded
    || report.fundPaymentsCreated > 0
    || report.fundPaymentsReused > 0
    || report.issuedCheckPaymentsCreated > 0
    || report.issuedCheckPaymentsReused > 0
    || report.bankDebitPaymentsCreated > 0
    || report.bankDebitPaymentsReused > 0
    || report.bankLinksReassigned > 0;
  [payments, bankMovements, fundMovements, issuedChecks].forEach((table) => {
    table.rowCount = table.rows.length;
    if (changed) table.updatedAt = timestamp;
  });
  if (changed) migrated.generatedAt = timestamp;
  report.idempotent = !changed;
  return { cache: migrated, report };
}

function backfillFundPayments({
  bankMovements,
  fundMovements,
  payments,
  report,
  timestamp
}) {
  fundMovements.rows.forEach((fund) => {
    const fundId = id(fund.id_movimiento_fondo);
    const type = normalize(fund.tipo);
    if (!fundId || !["deposito", "rescate", "rendimiento"].includes(type)) {
      throw migrationError(
        "ICBC_FUND_ROW_INVALID",
        `El movimiento de fondo ${fundId || "sin ID"} no tiene tipo canónico.`
      );
    }
    if (type === "rendimiento") {
      if (id(fund.id_pago)) {
        throw migrationError(
          "ICBC_FUND_YIELD_HAS_PAYMENT",
          `El rendimiento de fondo ${fundId} no puede tener pago ni impacto bancario propio.`
        );
      }
      return;
    }

    const bankRow = uniqueFundBankMovement(bankMovements.rows, fund);
    const amountCents = Math.abs(toCents(fund.importe));
    const expectedCents = type === "rescate" ? -amountCents : amountCents;
    validateFundBankMovement(bankRow, fund, expectedCents);

    const linkedPaymentId = id(fund.id_pago) || id(bankRow.id_pago);
    let payment = linkedPaymentId
      ? uniqueRowById(payments.rows, "id_pago", linkedPaymentId, "ICBC_FUND_PAYMENT_NOT_UNIQUE")
      : null;
    if (payment) {
      validateFundPayment(payment, fund, bankRow, expectedCents);
      if (id(fund.id_pago) === id(payment.id_pago) && id(bankRow.id_pago) === id(payment.id_pago)) return;
    } else {
      const candidates = payments.rows.filter((row) => (
        isBank(row.banco)
        && isoDate(row.fecha_pago) === isoDate(bankRow.fecha)
        && toCents(row.monto) === expectedCents
        && !/efectivo|endoso|compens|cheq/.test(normalize(row.metodo))
        && compatibleFundMarker(row, fundId)
      ));
      if (candidates.length > 1) {
        throw migrationError(
          "ICBC_FUND_PAYMENT_AMBIGUOUS",
          `El movimiento de fondo ${fundId} tiene ${candidates.length} pagos ICBC candidatos exactos.`
        );
      }
      payment = candidates[0] || createFundPayment(payments, fund, bankRow, expectedCents, timestamp);
      if (candidates.length) report.fundPaymentsReused += 1;
      else report.fundPaymentsCreated += 1;
    }

    const paymentId = id(payment.id_pago);
    markFundPayment(payment, fundId, bankRow, timestamp);
    if (id(fund.id_pago) !== paymentId) {
      rememberEditedAt(fund);
      fund._icbcCashBackfillPreviousPaymentId = id(fund.id_pago);
      fund.id_pago = paymentId;
      fund._editedLocallyAt = timestamp;
    }
    if (id(bankRow.id_pago) !== paymentId) {
      rememberEditedAt(bankRow);
      bankRow._icbcCashBackfillFundPreviousPaymentId = id(bankRow.id_pago);
      bankRow.id_pago = paymentId;
      bankRow._editedLocallyAt = timestamp;
    }
  });
}

function uniqueFundBankMovement(rows, fund) {
  const fundId = id(fund.id_movimiento_fondo);
  const bankId = id(fund.id_movimiento_bancario);
  const matches = rows.filter((row) => (
    (bankId && id(row.id_movimiento_bancario) === bankId)
    || id(row.id_movimiento_fondo) === fundId
  ));
  const unique = uniqueBy(matches, (row) => id(row.id_movimiento_bancario));
  if (unique.length !== 1) {
    throw migrationError(
      "ICBC_FUND_BANK_NOT_UNIQUE",
      `El movimiento de fondo ${fundId} requiere una única contrapartida bancaria y se encontraron ${unique.length}.`
    );
  }
  return unique[0];
}

function validateFundBankMovement(bankRow, fund, expectedPaymentCents) {
  const fundId = id(fund.id_movimiento_fondo);
  if (!isBank(bankRow.banco)) {
    throw migrationError("ICBC_FUND_BANK_MISMATCH", `El movimiento de fondo ${fundId} no está vinculado a ICBC.`);
  }
  if (id(bankRow.id_cobro)) {
    throw migrationError("ICBC_FUND_BANK_HAS_COLLECTION", `El movimiento de fondo ${fundId} no puede vincularse a un cobro.`);
  }
  if (id(bankRow.id_movimiento_fondo) && id(bankRow.id_movimiento_fondo) !== fundId) {
    throw migrationError("ICBC_FUND_BANK_CONFLICT", `La fila bancaria del fondo ${fundId} pertenece a otro movimiento.`);
  }
  const bankImpactCents = expectedPaymentCents < 0
    ? -Math.abs(toCents(bankRow.credito || 0))
    : Math.abs(toCents(bankRow.debito || 0));
  if (bankImpactCents !== expectedPaymentCents) {
    throw migrationError(
      "ICBC_FUND_BANK_AMOUNT_MISMATCH",
      `La contrapartida bancaria del fondo ${fundId} no coincide exactamente en importe y signo.`
    );
  }
}

function validateFundPayment(payment, fund, bankRow, expectedCents) {
  if (
    !isBank(payment.banco)
    || isoDate(payment.fecha_pago) !== isoDate(bankRow.fecha)
    || toCents(payment.monto) !== expectedCents
    || !compatibleFundMarker(payment, id(fund.id_movimiento_fondo))
  ) {
    throw migrationError(
      "ICBC_FUND_PAYMENT_MISMATCH",
      `El pago ${id(payment.id_pago) || "sin ID"} no es la contrapartida exacta del fondo ${id(fund.id_movimiento_fondo)}.`
    );
  }
}

function createFundPayment(payments, fund, bankRow, expectedCents, timestamp) {
  const paymentId = backendNextNumericId(payments.rows, "id_pago");
  payments.rows.push({
    _rowNumber: payments.rows.length + 2,
    id_pago: paymentId,
    fecha_pago: isoDate(bankRow.fecha),
    metodo: normalize(fund.tipo) === "rescate"
      ? "Fondo de inversion - Rescate"
      : "Fondo de inversion - Deposito",
    banco: BANK,
    monto: fromCents(expectedCents),
    _editedLocallyAt: timestamp,
    _icbcCashBackfillCreated: true
  });
  return payments.rows.at(-1);
}

function markFundPayment(payment, fundId, bankRow, timestamp) {
  const existingFundId = id(payment._fundMovementId);
  if (existingFundId && existingFundId !== fundId) {
    throw migrationError(
      "ICBC_FUND_PAYMENT_CONFLICT",
      `El pago ${id(payment.id_pago)} ya está vinculado al fondo ${existingFundId}.`
    );
  }
  rememberEditedAt(payment);
  payment._fundMovementId = fundId;
  payment._bankMovementId = id(bankRow.id_movimiento_bancario);
  payment._icbcCashBackfillMigration = MIGRATION_ID;
  payment._icbcCashBackfillKind = "fund";
  payment._editedLocallyAt = timestamp;
}

function backfillIssuedCheckPayments({
  bankMovements,
  issuedChecks,
  paymentDetails,
  payments,
  report,
  timestamp
}) {
  bankMovements.rows
    .filter((row) => isIssuedCheckDebit(row))
    .forEach((bankRow) => {
      const currentPaymentId = id(bankRow.id_pago);
      const sourcePaymentId = id(bankRow._icbcCashBackfillPreviousPaymentId) || currentPaymentId;
      if (!sourcePaymentId) {
        report.exclusions.push(`Movimiento bancario ${id(bankRow.id_movimiento_bancario)}: cheque sin id_pago de origen.`);
        return;
      }
      const sourcePayment = uniqueRowById(
        payments.rows,
        "id_pago",
        sourcePaymentId,
        "ICBC_CHECK_SOURCE_PAYMENT_NOT_UNIQUE"
      );
      const checkMatches = issuedChecks.rows.filter((check) => (
        id(check.id_pago) === sourcePaymentId
        && isBank(check.banco)
        && /debit/.test(normalize(check.estado))
        && sameCheckNumber(check.nro_cheque, bankRow.nro_cheque)
        && Math.abs(toCents(check.monto)) === Math.abs(toCents(bankRow.debito || 0))
      ));
      if (checkMatches.length > 1) {
        throw migrationError(
          "ICBC_ISSUED_CHECK_AMBIGUOUS",
          `El movimiento bancario ${id(bankRow.id_movimiento_bancario)} coincide con ${checkMatches.length} cheques emitidos.`
        );
      }
      if (!checkMatches.length) {
        report.exclusions.push(
          `Movimiento bancario ${id(bankRow.id_movimiento_bancario)}: sin cheque emitido exacto por número, pago e importe.`
        );
        return;
      }
      const check = checkMatches[0];
      if (qualifiedIcBcCheckPayment(sourcePayment, bankRow)) return;

      let payment = currentPaymentId !== sourcePaymentId
        ? uniqueRowById(payments.rows, "id_pago", currentPaymentId, "ICBC_CHECK_PAYMENT_NOT_UNIQUE")
        : null;
      if (!payment) {
        const candidates = payments.rows.filter((row) => (
          id(row.id_pago) !== sourcePaymentId
          && isBank(row.banco)
          && isoDate(row.fecha_pago) === isoDate(bankRow.fecha)
          && toCents(row.monto) === Math.abs(toCents(bankRow.debito || 0))
          && /cheq/.test(normalize(row.metodo))
          && /debit/.test(normalize(row.metodo))
          && compatibleCheckMarker(row, id(check.id_cheque_entregado))
          && paymentHasNoEconomicApplication(paymentDetails.rows, row)
        ));
        if (candidates.length > 1) {
          throw migrationError(
            "ICBC_CHECK_PAYMENT_AMBIGUOUS",
            `El cheque ${id(check.id_cheque_entregado)} tiene ${candidates.length} pagos ICBC de débito candidatos.`
          );
        }
        payment = candidates[0] || createIssuedCheckPayment(payments, check, bankRow, sourcePaymentId, timestamp);
        if (candidates.length) report.issuedCheckPaymentsReused += 1;
        else report.issuedCheckPaymentsCreated += 1;
      }

      const paymentId = id(payment.id_pago);
      const alreadyLinked = currentPaymentId === paymentId
        && id(payment._issuedCheckId) === id(check.id_cheque_entregado)
        && id(payment._sourcePaymentId) === sourcePaymentId
        && id(payment._bankMovementId) === id(bankRow.id_movimiento_bancario)
        && payment._icbcCashBackfillMigration === MIGRATION_ID
        && id(check._bankDebitPaymentId) === paymentId;
      if (alreadyLinked) return;
      markIssuedCheckPayment(payment, check, bankRow, sourcePaymentId, timestamp);
      if (currentPaymentId !== paymentId) {
        rememberEditedAt(bankRow);
        bankRow._icbcCashBackfillPreviousPaymentId = sourcePaymentId;
        bankRow.id_pago = paymentId;
        bankRow._editedLocallyAt = timestamp;
        report.bankLinksReassigned += 1;
      }
      rememberEditedAt(check);
      check._bankDebitPaymentId = paymentId;
      check._editedLocallyAt = timestamp;
    });
}

function isIssuedCheckDebit(row) {
  if (!isBank(row.banco) || isoDate(row.fecha) < INITIAL_DATE || Math.abs(toCents(row.debito || 0)) === 0) {
    return false;
  }
  return Boolean(normalizeCheckNumber(row.nro_cheque))
    || /cheq|cheque|ch camara/.test(normalize(`${row.concepto || ""} ${row.detalle || ""}`));
}

function qualifiedIcBcCheckPayment(payment, bankRow) {
  return isBank(payment.banco)
    && isoDate(payment.fecha_pago) >= INITIAL_DATE
    && /cheq/.test(normalize(payment.metodo))
    && toCents(payment.monto) === Math.abs(toCents(bankRow.debito || 0));
}

function createIssuedCheckPayment(payments, check, bankRow, sourcePaymentId, timestamp) {
  const paymentId = backendNextNumericId(payments.rows, "id_pago");
  payments.rows.push({
    _rowNumber: payments.rows.length + 2,
    id_pago: paymentId,
    fecha_pago: isoDate(bankRow.fecha),
    metodo: "Cheque debitado",
    banco: BANK,
    monto: fromCents(Math.abs(toCents(bankRow.debito || 0))),
    _issuedCheckId: id(check.id_cheque_entregado),
    _sourcePaymentId: sourcePaymentId,
    _bankMovementId: id(bankRow.id_movimiento_bancario),
    _editedLocallyAt: timestamp,
    _icbcCashBackfillCreated: true
  });
  return payments.rows.at(-1);
}

function markIssuedCheckPayment(payment, check, bankRow, sourcePaymentId, timestamp) {
  const checkId = id(check.id_cheque_entregado);
  if (!compatibleCheckMarker(payment, checkId)) {
    throw migrationError(
      "ICBC_CHECK_PAYMENT_CONFLICT",
      `El pago ${id(payment.id_pago)} ya está vinculado a otro cheque emitido.`
    );
  }
  rememberEditedAt(payment);
  payment._issuedCheckId = checkId;
  payment._sourcePaymentId = sourcePaymentId;
  payment._bankMovementId = id(bankRow.id_movimiento_bancario);
  payment._icbcCashBackfillMigration = MIGRATION_ID;
  payment._icbcCashBackfillKind = "issued_check";
  payment._editedLocallyAt = timestamp;
}

function backfillBankDebitPayments({
  bankMovements,
  paymentDetails,
  payments,
  report,
  timestamp
}) {
  bankMovements.rows
    .filter((row) => isNonCheckBankDebit(row))
    .forEach((bankRow) => {
      const currentPaymentId = id(bankRow.id_pago);
      const sourcePaymentId = id(bankRow._icbcCashBackfillPreviousPaymentId) || currentPaymentId;
      if (!sourcePaymentId) {
        report.exclusions.push(`Movimiento bancario ${id(bankRow.id_movimiento_bancario)}: débito sin id_pago de origen.`);
        return;
      }
      const sourcePayment = uniqueRowById(
        payments.rows,
        "id_pago",
        sourcePaymentId,
        "ICBC_BANK_DEBIT_SOURCE_PAYMENT_NOT_UNIQUE"
      );
      const debitCents = Math.abs(toCents(bankRow.debito || 0));
      if (toCents(sourcePayment.monto) !== debitCents) {
        report.exclusions.push(
          `Movimiento bancario ${id(bankRow.id_movimiento_bancario)}: el pago ${sourcePaymentId} no coincide exactamente en importe.`
        );
        return;
      }
      if (qualifiedIcBcBankDebitPayment(sourcePayment, bankRow)) return;

      let payment = currentPaymentId !== sourcePaymentId
        ? uniqueRowById(payments.rows, "id_pago", currentPaymentId, "ICBC_BANK_DEBIT_PAYMENT_NOT_UNIQUE")
        : null;
      if (!payment) {
        const candidates = payments.rows.filter((row) => (
          id(row.id_pago) !== sourcePaymentId
          && isBank(row.banco)
          && isoDate(row.fecha_pago) === isoDate(bankRow.fecha)
          && toCents(row.monto) === debitCents
          && !/efectivo|endoso|compens|cheq/.test(normalize(row.metodo))
          && compatibleBankDebitMarker(row, id(bankRow.id_movimiento_bancario))
          && paymentHasNoEconomicApplication(paymentDetails.rows, row)
        ));
        if (candidates.length > 1) {
          throw migrationError(
            "ICBC_BANK_DEBIT_PAYMENT_AMBIGUOUS",
            `El débito bancario ${id(bankRow.id_movimiento_bancario)} tiene ${candidates.length} pagos ICBC candidatos.`
          );
        }
        payment = candidates[0] || createBankDebitPayment(payments, bankRow, sourcePaymentId, timestamp);
        if (candidates.length) report.bankDebitPaymentsReused += 1;
        else report.bankDebitPaymentsCreated += 1;
      }

      const paymentId = id(payment.id_pago);
      const alreadyLinked = currentPaymentId === paymentId
        && id(payment._sourcePaymentId) === sourcePaymentId
        && id(payment._bankMovementId) === id(bankRow.id_movimiento_bancario)
        && payment._icbcCashBackfillMigration === MIGRATION_ID;
      if (alreadyLinked) return;
      markBankDebitPayment(payment, bankRow, sourcePaymentId, timestamp);
      if (currentPaymentId !== paymentId) {
        rememberEditedAt(bankRow);
        bankRow._icbcCashBackfillPreviousPaymentId = sourcePaymentId;
        bankRow.id_pago = paymentId;
        bankRow._editedLocallyAt = timestamp;
        report.bankLinksReassigned += 1;
      }
    });
}

function isNonCheckBankDebit(row) {
  if (
    !isBank(row.banco)
    || isoDate(row.fecha) < INITIAL_DATE
    || Math.abs(toCents(row.debito || 0)) === 0
    || id(row.id_movimiento_fondo)
  ) {
    return false;
  }
  return !normalizeCheckNumber(row.nro_cheque)
    && !/cheq|cheque|ch camara/.test(normalize(`${row.concepto || ""} ${row.detalle || ""}`));
}

function qualifiedIcBcBankDebitPayment(payment, bankRow) {
  return isBank(payment.banco)
    && isoDate(payment.fecha_pago) >= INITIAL_DATE
    && toCents(payment.monto) === Math.abs(toCents(bankRow.debito || 0))
    && !/efectivo|endoso|compens|cheq/.test(normalize(payment.metodo));
}

function createBankDebitPayment(payments, bankRow, sourcePaymentId, timestamp) {
  const paymentId = backendNextNumericId(payments.rows, "id_pago");
  const normalizedDetail = normalize(`${bankRow.concepto || ""} ${bankRow.detalle || ""}`);
  const method = /transfer|trf/.test(normalizedDetail)
    ? "Transferencia"
    : /debito/.test(normalizedDetail)
      ? "Debito"
      : "Movimiento bancario";
  payments.rows.push({
    _rowNumber: payments.rows.length + 2,
    id_pago: paymentId,
    fecha_pago: isoDate(bankRow.fecha),
    metodo: method,
    banco: BANK,
    monto: fromCents(Math.abs(toCents(bankRow.debito || 0))),
    _sourcePaymentId: sourcePaymentId,
    _bankMovementId: id(bankRow.id_movimiento_bancario),
    _editedLocallyAt: timestamp,
    _icbcCashBackfillCreated: true
  });
  return payments.rows.at(-1);
}

function markBankDebitPayment(payment, bankRow, sourcePaymentId, timestamp) {
  const bankMovementId = id(bankRow.id_movimiento_bancario);
  if (!compatibleBankDebitMarker(payment, bankMovementId)) {
    throw migrationError(
      "ICBC_BANK_DEBIT_PAYMENT_CONFLICT",
      `El pago ${id(payment.id_pago)} ya está vinculado a otro movimiento bancario.`
    );
  }
  rememberEditedAt(payment);
  payment._sourcePaymentId = sourcePaymentId;
  payment._bankMovementId = bankMovementId;
  payment._icbcCashBackfillMigration = MIGRATION_ID;
  payment._icbcCashBackfillKind = "bank_debit";
  payment._editedLocallyAt = timestamp;
}

function rollbackIcBcCashReconciliation(cache) {
  const rolledBack = clone(cache);
  const tables = rolledBack.tables || {};
  const payments = requiredTable(tables, "pagos");
  const bankMovements = requiredTable(tables, "movimientos_bancarios");
  const fundMovements = requiredTable(tables, "fondos_inversion_movimientos");
  const issuedChecks = requiredTable(tables, "cheques_entregados");
  const createdIds = new Set(payments.rows.filter((row) => (
    row._icbcCashBackfillMigration === MIGRATION_ID && row._icbcCashBackfillCreated === true
  )).map((row) => id(row.id_pago)));

  bankMovements.rows.forEach((row) => {
    if (Object.prototype.hasOwnProperty.call(row, "_icbcCashBackfillPreviousPaymentId")) {
      row.id_pago = row._icbcCashBackfillPreviousPaymentId;
      delete row._icbcCashBackfillPreviousPaymentId;
    }
    if (Object.prototype.hasOwnProperty.call(row, "_icbcCashBackfillFundPreviousPaymentId")) {
      row.id_pago = row._icbcCashBackfillFundPreviousPaymentId;
      delete row._icbcCashBackfillFundPreviousPaymentId;
    }
  });
  fundMovements.rows.forEach((row) => {
    if (Object.prototype.hasOwnProperty.call(row, "_icbcCashBackfillPreviousPaymentId")) {
      row.id_pago = row._icbcCashBackfillPreviousPaymentId;
      delete row._icbcCashBackfillPreviousPaymentId;
    }
  });
  issuedChecks.rows.forEach((row) => {
    if (createdIds.has(id(row._bankDebitPaymentId))
      || payments.rows.some((payment) => (
        id(payment.id_pago) === id(row._bankDebitPaymentId)
        && payment._icbcCashBackfillMigration === MIGRATION_ID
      ))) {
      delete row._bankDebitPaymentId;
    }
  });
  payments.rows = payments.rows.filter((row) => !createdIds.has(id(row.id_pago)));
  payments.rows.forEach((row) => {
    if (row._icbcCashBackfillMigration !== MIGRATION_ID) return;
    [
      "_bankMovementId",
      "_fundMovementId",
      "_issuedCheckId",
      "_sourcePaymentId",
      "_icbcCashBackfillCreated",
      "_icbcCashBackfillKind",
      "_icbcCashBackfillMigration"
    ].forEach((key) => delete row[key]);
    restoreEditedAt(row);
  });
  bankMovements.rows.forEach(restoreEditedAt);
  fundMovements.rows.forEach(restoreEditedAt);
  issuedChecks.rows.forEach(restoreEditedAt);
  if (fundMovements._icbcCashBackfillColumnAdded) {
    fundMovements.headers = fundMovements.headers.filter((column) => column !== FUND_PAYMENT_COLUMN);
    delete fundMovements._icbcCashBackfillColumnAdded;
  }
  [payments, bankMovements, fundMovements, issuedChecks].forEach((table) => {
    table.rowCount = table.rows.length;
  });
  return {
    cache: rolledBack,
    report: {
      migrationId: MIGRATION_ID,
      action: "rollback",
      paymentsRemoved: createdIds.size
    }
  };
}

function createBackupManifest(serializedCache) {
  const source = Buffer.isBuffer(serializedCache)
    ? serializedCache
    : Buffer.from(String(serializedCache), "utf8");
  const parsed = JSON.parse(source.toString("utf8"));
  return {
    migrationId: MIGRATION_ID,
    sha256: crypto.createHash("sha256").update(source).digest("hex"),
    bytes: source.length,
    tableCounts: Object.fromEntries(Object.entries(parsed.tables || {}).map(([name, table]) => [
      name,
      Array.isArray(table?.rows) ? table.rows.length : 0
    ]))
  };
}

function verifyBackup(serializedCache, manifest) {
  const current = createBackupManifest(serializedCache);
  if (
    current.sha256 !== manifest.sha256
    || current.bytes !== manifest.bytes
    || JSON.stringify(current.tableCounts) !== JSON.stringify(manifest.tableCounts)
  ) {
    throw migrationError("ICBC_BACKUP_MISMATCH", "El backup no coincide con su manifiesto verificable.");
  }
  return true;
}

function paymentHasNoEconomicApplication(rows, payment) {
  return rows
    .filter((row) => id(row.id_pago) === id(payment.id_pago))
    .every((row) => !id(row.id_egreso));
}

function rememberEditedAt(row) {
  if (Object.prototype.hasOwnProperty.call(row, "_icbcCashBackfillPreviousEditedAt")) return;
  row._icbcCashBackfillPreviousEditedAt = Object.prototype.hasOwnProperty.call(row, "_editedLocallyAt")
    ? row._editedLocallyAt
    : null;
}

function restoreEditedAt(row) {
  if (!Object.prototype.hasOwnProperty.call(row, "_icbcCashBackfillPreviousEditedAt")) return;
  if (row._icbcCashBackfillPreviousEditedAt === null) delete row._editedLocallyAt;
  else row._editedLocallyAt = row._icbcCashBackfillPreviousEditedAt;
  delete row._icbcCashBackfillPreviousEditedAt;
}

function compatibleFundMarker(payment, fundId) {
  return !id(payment._fundMovementId) || id(payment._fundMovementId) === fundId;
}

function compatibleCheckMarker(payment, checkId) {
  return !id(payment._issuedCheckId) || id(payment._issuedCheckId) === checkId;
}

function compatibleBankDebitMarker(payment, bankMovementId) {
  return !id(payment._bankMovementId) || id(payment._bankMovementId) === bankMovementId;
}

function uniqueRowById(rows, column, value, code) {
  const matches = rows.filter((row) => id(row[column]) === id(value));
  if (matches.length !== 1) {
    throw migrationError(code, `La relación ${column}=${value} no es única.`);
  }
  return matches[0];
}

function sameCheckNumber(left, right) {
  const leftNumber = normalizeCheckNumber(left);
  const rightNumber = normalizeCheckNumber(right);
  return Boolean(leftNumber && rightNumber && leftNumber === rightNumber);
}

function normalizeCheckNumber(value) {
  return String(value ?? "").replace(/\D/g, "").replace(/^0+/, "");
}

function isBank(value) {
  return normalize(value) === "icbc";
}

function isoDate(value) {
  const candidate = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : "";
}

function validTimestamp(value) {
  const candidate = String(value || "").trim();
  return Number.isFinite(Date.parse(candidate)) ? candidate : "";
}

function requiredTable(tables, name) {
  const table = tables[name];
  if (!table || !Array.isArray(table.rows)) {
    throw migrationError("ICBC_TABLE_MISSING", `Falta la tabla ${name}.`);
  }
  if (!Array.isArray(table.headers)) table.headers = [];
  return table;
}

function uniqueBy(values, selector) {
  const result = [];
  const seen = new Set();
  values.forEach((value) => {
    const key = selector(value);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(value);
  });
  return result;
}

function id(value) {
  return String(value ?? "").trim();
}

function normalize(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function migrationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  BANK,
  FUND_PAYMENT_COLUMN,
  INITIAL_DATE,
  MIGRATION_ID,
  createBackupManifest,
  migrateIcBcCashReconciliation,
  rollbackIcBcCashReconciliation,
  verifyBackup
};
