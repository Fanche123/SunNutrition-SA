const { fromCents, normalize: normalizeMoney, toCents } = require("../../shared/money");

function createBankPersistenceService(dependencies) {
  const { backendBankMatches, backendId, backendIsoDate, backendNextNumericId, backendNormalizeText, backendNumber, backendTagIdForName, cleanBackendText, compactBankText, crypto, ensureBackendTable, loadCache, normalizeBankCheckNumber, normalizeBankCuit, saveBackendCache } = dependencies;

  function ensureBankDetailsSchema() {
    const cache = loadCache();
    if (!cache.tables) return;
  
    const hasInvoiceType = (cache.tables.datos_bancarios?.headers || []).includes("tipo_factura");
    ensureBackendTable(cache.tables, "datos_bancarios");
    if (!hasInvoiceType) saveBackendCache(cache);
  }

  function backendValueIsBlank(value) {
    return value === undefined || value === null || String(value).trim() === "";
  }
  
  function bankMovementBackendCreditorId(movement) {
    const match = movement?.providerMatch || {};
    if (match.idAcreedor) return backendId(match.idAcreedor);
    if (match.type === "acreedor" && match.id) return backendId(match.id);
    return "";
  }
  
  function bankMovementFingerprint(movement, bank) {
    const normalized = [
      backendNormalizeText(bank),
      backendIsoDate(movement.fecha || movement.date),
      backendNormalizeText(movement.cod_concepto || movement.code),
      backendNormalizeText(movement.concepto || movement.concept),
      backendNormalizeText(movement.detalle || movement.detail),
      normalizeBankCuit(movement.cuit),
      normalizeBankCheckNumber(movement.nro_cheque || movement.checkNumber),
      bankMoneyKey(movement.debito ?? movement.debit),
      bankMoneyKey(movement.credito ?? movement.credit),
      bankMoneyKey(movement.importe ?? movement.amount),
      bankMoneyKey(movement.saldo ?? movement.balance)
    ].join("|");
    return crypto.createHash("sha1").update(normalized).digest("hex");
  }
  
  function bankMoneyKey(value) {
    return toCents(backendNumber(value));
  }
  
  function backendPersistedBankMovementCounts(tables, bank, { legacyOnly = false } = {}) {
    const counts = new Map();
    (tables.movimientos_bancarios?.rows || []).forEach((row) => {
      if (!backendBankMatches(row.banco, bank)) return;
      if (legacyOnly && cleanBackendText(row._bankMovementKey)) return;
      const key = bankMovementFingerprint(row, row.banco || bank);
      if (!counts.has(key)) counts.set(key, []);
      counts.get(key).push({
        type: "movimiento_bancario",
        id: backendId(row.id_movimiento_bancario),
        idPago: backendId(row.id_pago),
        idCobro: backendId(row.id_cobro)
      });
    });
    return counts;
  }
  
  function consumePersistedBankMovement(movement, bank, persistedCounts) {
    const key = bankMovementFingerprint(movement, bank);
    const candidates = persistedCounts.get(key) || [];
    return candidates.shift() || null;
  }

  function canonicalPendingBankMovements(tables, bank) {
    ensureBackendTable(tables, "movimientos_bancarios");
    const occurrences = new Map();
    return (tables.movimientos_bancarios.rows || [])
      .filter((row) => backendBankMatches(row.banco, bank))
      .map((row) => {
        const fingerprint = bankMovementFingerprint(row, row.banco || bank);
        const occurrence = (occurrences.get(fingerprint) || 0) + 1;
        occurrences.set(fingerprint, occurrence);
        return { row, fingerprint, occurrence };
      })
      .filter(({ row }) => (
        backendValueIsBlank(row.id_pago)
        && backendValueIsBlank(row.id_cobro)
        && backendValueIsBlank(row.id_movimiento_fondo)
      ))
      .map(({ row, fingerprint, occurrence }) => {
        const debit = normalizeMoney(Math.abs(backendNumber(row.debito)));
        const credit = normalizeMoney(Math.abs(backendNumber(row.credito)));
        const amount = backendValueIsBlank(row.importe)
          ? normalizeMoney(credit - debit)
          : normalizeMoney(backendNumber(row.importe));
        return {
          canonicalMovementId: backendId(row.id_movimiento_bancario),
          movementKey: cleanBackendText(row._bankMovementKey) || `${fingerprint}:${occurrence}`,
          rowNumber: row._rowNumber || "",
          date: backendIsoDate(row.fecha),
          code: cleanBackendText(row.cod_concepto),
          concept: cleanBackendText(row.concepto),
          bankConcept: cleanBackendText(row._bankConcept || row.concepto),
          detail: cleanBackendText(row.detalle),
          counterpartyName: cleanBackendText(row._bankCounterpartyName),
          cuit: normalizeBankCuit(row.cuit),
          checkNumber: normalizeBankCheckNumber(row.nro_cheque),
          cbuAlias: cleanBackendText(row._bankCbuAlias),
          docType: cleanBackendText(row._bankDocType),
          amount,
          debit,
          credit,
          balance: normalizeMoney(backendNumber(row.saldo)),
          channel: cleanBackendText(row._bankChannel),
          manualClassification: cleanBackendText(row._bankManualClassificationSource) ? {
            idAcreedor: backendId(row._bankManualCreditorId),
            idEtiqueta: backendId(row._bankManualTagId),
            idAcreedorEtiqueta: backendId(row._bankManualCreditorTagRelationId),
            source: cleanBackendText(row._bankManualClassificationSource)
          } : null
        };
      })
      .sort((left, right) => (
        String(left.date).localeCompare(String(right.date))
        || numericIdForSort(left.canonicalMovementId) - numericIdForSort(right.canonicalMovementId)
        || String(left.movementKey).localeCompare(String(right.movementKey))
      ));
  }

  function importBankMovements(tables, movements, bank) {
    ensureBackendTable(tables, "movimientos_bancarios");
    const table = tables.movimientos_bancarios;
    const existingCounts = new Map();
    (table.rows || []).forEach((row) => {
      if (!backendBankMatches(row.banco, bank)) return;
      const fingerprint = bankMovementFingerprint(row, row.banco || bank);
      existingCounts.set(fingerprint, (existingCounts.get(fingerprint) || 0) + 1);
    });

    const incomingCounts = new Map();
    let newCount = 0;
    (movements || []).forEach((movement) => {
      const fingerprint = bankMovementFingerprint(movement, bank);
      const occurrence = (incomingCounts.get(fingerprint) || 0) + 1;
      incomingCounts.set(fingerprint, occurrence);
      if (occurrence <= (existingCounts.get(fingerprint) || 0)) return;

      const movementKey = `${fingerprint}:${occurrence}`;
      table.rows.push(newBankMovementRow(table.rows, movement, bank, movementKey));
      newCount += 1;
    });
    table.rowCount = table.rows.length;
    return {
      rowsRead: (movements || []).length,
      newCount,
      duplicateCount: Math.max(0, (movements || []).length - newCount)
    };
  }

  function newBankMovementRow(rows, movement, bank, movementKey) {
    const timestamp = new Date().toISOString();
    return {
      _rowNumber: rows.length + 2,
      id_movimiento_bancario: backendNextNumericId(rows, "id_movimiento_bancario"),
      banco: bank,
      fecha: backendIsoDate(movement.fecha || movement.date),
      cod_concepto: cleanBackendText(movement.cod_concepto || movement.code),
      concepto: cleanBackendText(movement.concepto || movement.concept),
      detalle: cleanBackendText(movement.detalle || movement.detail),
      cuit: normalizeBankCuit(movement.cuit),
      nro_cheque: normalizeBankCheckNumber(movement.nro_cheque || movement.checkNumber),
      debito: normalizeMoney(Math.abs(backendNumber(movement.debito ?? movement.debit))),
      credito: normalizeMoney(Math.abs(backendNumber(movement.credito ?? movement.credit))),
      importe: normalizeMoney(backendNumber(movement.importe ?? movement.amount)),
      saldo: normalizeMoney(backendNumber(movement.saldo ?? movement.balance)),
      id_pago: "",
      id_cobro: "",
      _bankConcept: cleanBackendText(movement.bankConcept),
      _bankCounterpartyName: cleanBackendText(movement.counterpartyName),
      _bankCbuAlias: cleanBackendText(movement.cbuAlias),
      _bankDocType: cleanBackendText(movement.docType),
      _bankChannel: cleanBackendText(movement.channel),
      _bankSourceOrder: Number.isFinite(Number(movement.rowNumber)) ? Number(movement.rowNumber) : "",
      _bankMovementKey: movementKey,
      _bankImportedAt: timestamp,
      _editedLocallyAt: timestamp
    };
  }

  function numericIdForSort(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : Number.MAX_SAFE_INTEGER;
  }

  function persistBankMovement(tables, movement, bank, operationKey = "", operationPayload = "") {
    ensureBackendTable(tables, "movimientos_bancarios");
    const table = tables.movimientos_bancarios;
    const canonicalMovementId = backendId(movement.canonicalMovementId);
    const existing = table.rows.find((row) => (
      (canonicalMovementId && backendId(row.id_movimiento_bancario) === canonicalMovementId)
      || (
        cleanBackendText(movement.movementKey)
        && cleanBackendText(row._bankMovementKey) === cleanBackendText(movement.movementKey)
      )
      || (operationKey && row._bankOperationKey === operationKey)
    ));
    if (!existing) {
      const error = new Error("El movimiento bancario pendiente ya no existe.");
      error.statusCode = 409;
      throw error;
    }

    const { idPago, idCobro } = bankMovementAssociation(movement);
    if ((!idPago && !idCobro) || (idPago && idCobro)) {
      const error = new Error("La conciliacion debe asociar exactamente un pago o un cobro.");
      error.statusCode = 400;
      throw error;
    }
    assertBankAssociationExists(tables, idPago, idCobro);
    if (idPago) {
      const conflictingMovement = table.rows.find((row) => (
        row !== existing && backendId(row.id_pago) === idPago
      ));
      if (conflictingMovement) {
        const error = new Error(
          `El pago ${idPago} ya esta asociado al movimiento bancario ${backendId(conflictingMovement.id_movimiento_bancario)}.`
        );
        error.statusCode = 409;
        throw error;
      }
    }

    const existingPaymentId = backendId(existing.id_pago);
    const existingCollectionId = backendId(existing.id_cobro);
    if (existingPaymentId || existingCollectionId) {
      if (existingPaymentId === idPago && existingCollectionId === idCobro) return existing;
      const error = new Error("El movimiento bancario ya fue conciliado con otra asociacion.");
      error.statusCode = 409;
      throw error;
    }

    const timestamp = new Date().toISOString();
    existing.id_pago = idPago;
    existing.id_cobro = idCobro;
    existing._bankOperationKey = operationKey;
    existing._bankOperationPayload = operationPayload;
    existing._bankMovementKey = cleanBackendText(existing._bankMovementKey)
      || cleanBackendText(movement.movementKey);
    existing._editedLocallyAt = timestamp;
    return existing;
  }

  function bankMovementAssociation(movement) {
    const match = movement?.match || {};
    const idPago = backendId(
      match.type === "pago" ? match.id : movement?.checkMatch?.idPago
    );
    const idCobro = backendId(
      match.type === "cobro" ? match.id : movement?.checkMatch?.idCobro
    );
    return { idPago, idCobro };
  }

  function assertBankAssociationExists(tables, idPago, idCobro) {
    if (idPago && !(tables.pagos?.rows || []).some((row) => backendId(row.id_pago) === idPago)) {
      const error = new Error("El pago asociado ya no existe.");
      error.statusCode = 409;
      throw error;
    }
    if (idCobro && !(tables.cobros?.rows || []).some((row) => backendId(row.id_cobro) === idCobro)) {
      const error = new Error("El cobro asociado ya no existe.");
      error.statusCode = 409;
      throw error;
    }
  }
  
  function bankSourceDestinationForOriginType(value) {
    const originType = backendNormalizeText(value);
    if (originType === "proveedor") return { table: "recepciones", label: "Recepciones" };
    if (originType === "flete") return { table: "entregas", label: "Logistica" };
    if (originType === "empleado") return { table: "sueldos", label: "Sueldos" };
    if (originType === "canal") return { table: "comisiones", label: "Comisiones" };
    return { table: "otros_gastos", label: "Otros gastos" };
  }
  
  function createBankSourceExpense(tables, movement, reviewRow = {}, operationKey = "", operationPayload = "") {
    const destination = movement.sourceDestination || bankSourceDestinationForOriginType("");
    if (destination.table !== "otros_gastos") return null;
  
    const creditorId = backendId(reviewRow.idAcreedor) || bankMovementBackendCreditorId(movement);
    const relationId = backendId(reviewRow.idAcreedorEtiqueta)
      || backendCreditorTagRelationId(creditorId, movement.idEtiqueta, tables);
    const relation = (tables.acreedores_etiquetas?.rows || []).find((row) => (
      backendId(row.id_acreedor_etiqueta) === relationId
      && backendId(row.id_acreedor) === creditorId
    ));
    if (!creditorId || !relation) return null;
    const movementRows = (tables.movimientos_bancarios?.rows || []).filter((row) => (
      cleanBackendText(row._bankMovementKey) === cleanBackendText(movement.movementKey)
    ));
    if (movementRows.length !== 1) {
      const error = new Error("La clave bancaria no identifica un unico movimiento pendiente.");
      error.statusCode = 409;
      throw error;
    }
    const bankRow = movementRows[0];
    if (
      backendId(bankRow.id_movimiento_bancario) !== backendId(reviewRow.canonicalMovementId)
      || backendIsoDate(bankRow.fecha) !== backendIsoDate(reviewRow.expectedDate)
      || toCents(backendNumber(bankRow.importe)) !== toCents(backendNumber(reviewRow.expectedAmount))
    ) {
      const error = new Error("El movimiento bancario cambio desde el analisis. Actualiza la conciliacion y reintenta.");
      error.statusCode = 409;
      throw error;
    }
    if (backendId(bankRow.id_pago) || backendId(bankRow.id_cobro) || backendId(bankRow.id_movimiento_fondo)) {
      const error = new Error("El movimiento bancario ya no esta pendiente.");
      error.statusCode = 409;
      throw error;
    }
    const table = tables.otros_gastos;
    const sourceId = backendNextNumericId(table.rows, "id_otros_gastos");
    table.rows.push({
      _rowNumber: table.rows.length + 2,
      id_otros_gastos: sourceId,
      fecha_otros_gastos: backendIsoDate(reviewRow.date) || movement.date,
      id_acreedor: creditorId,
      id_acreedor_etiqueta: relationId || movement.idAcreedorEtiqueta || "",
      id_egreso: "",
      detalle: compactBankText(reviewRow.detail || movement.detail || movement.concept),
      _total: fromCents(Math.abs(toCents(movement.amount))),
      _bankOperationKey: operationKey,
      _bankOperationPayload: operationPayload,
      _editedLocallyAt: new Date().toISOString()
    });
    table.rowCount = table.rows.length;
    bankRow._bankManualCreditorId = creditorId;
    bankRow._bankManualTagId = backendId(relation.id_etiqueta);
    bankRow._bankManualCreditorTagRelationId = relationId;
    bankRow._bankManualClassificationSource = "bank-reconciliation:createExpenses";
    bankRow._bankManualClassificationAt = new Date().toISOString();
    bankRow._editedLocallyAt = new Date().toISOString();
    return { sourceId, label: destination.label };
  }
  
  function createBankEgressForSource(tables, movement, reviewRow = {}, operationKey = "", operationPayload = "") {
    const sourceMatch = movement.sourceMatch;
    const sourceTable = tables[sourceMatch?.table];
    const sourceRow = sourceTable?.rows?.find((row) => backendId(row[sourceMatch.idColumn]) === backendId(sourceMatch.id));
    if (!sourceRow || backendId(sourceRow.id_egreso)) return null;
  
    const expenseTable = tables.egresos;
    const expenseId = backendNextNumericId(expenseTable.rows, "id_egreso");
    const total = fromCents(Math.abs(toCents(movement.amount)));
    const tagId = backendId(sourceMatch.idEtiqueta || movement.idEtiqueta)
      || backendTagIdForName(movement.tag || movement.suggestedExpenseType, tables);
    const creditorTagRelationId = backendId(sourceRow.id_acreedor_etiqueta)
      || backendCreditorTagRelationId(
        sourceMatch.idAcreedor || bankMovementBackendCreditorId(movement),
        tagId,
        tables
      )
      || backendId(movement.idAcreedorEtiqueta);
    const invoiceDate = backendIsoDate(reviewRow.date) || sourceMatch.invoiceDate || sourceMatch.date || movement.date;
    const timestamp = new Date().toISOString();
  
    expenseTable.rows.push({
      _rowNumber: expenseTable.rows.length + 2,
      id_egreso: expenseId,
      fecha_factura: invoiceDate,
      fecha_prevista_pago: movement.date,
      id_etiqueta: tagId,
      id_acreedor_etiqueta: creditorTagRelationId,
      tipo_factura: cleanBackendText(reviewRow.tipo_factura)
        || sourceMatch.invoiceType
        || movement.providerMatch?.invoiceType
        || "",
      nro_factura: sourceMatch.invoiceNumber || movement.checkNumber || movement.rowNumber || "",
      iva: 0,
      per_ret_iva: 0,
      per_ret_iibb: 0,
      imp_internos: 0,
      subtotal: total,
      total,
      _bankOperationKey: operationKey,
      _bankOperationPayload: operationPayload,
      _editedLocallyAt: timestamp
    });
    sourceRow.id_egreso = expenseId;
    sourceRow._editedLocallyAt = timestamp;
    expenseTable.rowCount = expenseTable.rows.length;
    return {
      expenseId,
      sourceId: backendId(sourceMatch.id),
      sourceLabel: sourceMatch.label || sourceMatch.table
    };
  }
  
  function backendCreditorTagRelationId(creditorId, tagId, tables) {
    const normalizedCreditorId = backendId(creditorId);
    const normalizedTagId = backendId(tagId);
    const relations = (tables.acreedores_etiquetas?.rows || []).filter((relation) => (
      backendId(relation.id_acreedor) === normalizedCreditorId
    ));
    const exact = normalizedTagId
      ? relations.find((relation) => backendId(relation.id_etiqueta) === normalizedTagId)
      : null;
    return backendId((exact || relations[0])?.id_acreedor_etiqueta);
  }
  
  function createBankPaymentForExpense(tables, movement, bank, expenseId, amount, reviewRow = {}, operationKey = "", operationPayload = "") {
    const paymentTable = tables.pagos;
    const detailTable = tables.detalle_pagos;
    const expense = (tables.egresos?.rows || []).find((row) => backendId(row.id_egreso) === backendId(expenseId));
    const amountCents = Math.abs(toCents(backendNumber(amount)));
    const signedAmount = fromCents(
      toCents(backendNumber(expense?.total)) < 0 ? -amountCents : amountCents
    );
    const paymentId = backendNextNumericId(paymentTable.rows, "id_pago");
    const detailId = backendNextNumericId(detailTable.rows, "id_detalle_pago");
    const timestamp = new Date().toISOString();
  
    paymentTable.rows.push({
      _rowNumber: paymentTable.rows.length + 2,
      id_pago: paymentId,
      fecha_pago: backendIsoDate(reviewRow.date) || movement.date,
      metodo: cleanBackendText(reviewRow.metodo) || bankPaymentMethodFromMovement(movement),
      banco: cleanBackendText(reviewRow.banco) || bank,
      monto: signedAmount,
      _bankOperationKey: operationKey,
      _bankOperationPayload: operationPayload,
      _editedLocallyAt: timestamp
    });
    detailTable.rows.push({
      _rowNumber: detailTable.rows.length + 2,
      id_detalle_pago: detailId,
      id_pago: paymentId,
      id_egreso: expenseId,
      monto_cancelado: signedAmount,
      _bankOperationKey: operationKey,
      _editedLocallyAt: timestamp
    });
    paymentTable.rowCount = paymentTable.rows.length;
    detailTable.rowCount = detailTable.rows.length;
    return { paymentId, detailId };
  }
  
  function updateReceivedCheckFromBankMovement(tables, movement, bank) {
    const checkRows = tables.cheques_recibidos?.rows || [];
    const checkIds = new Set([
      movement.checkMatch?.id,
      ...(Array.isArray(movement.checkMatch?.ids) ? movement.checkMatch.ids : [])
    ].map(backendId).filter(Boolean));
    const rows = checkRows.filter((check) => checkIds.has(backendId(check.id_cheque_recibido)));
    if (!rows.length) {
      const byNumber = checkRows.find((check) => normalizeBankCheckNumber(check.nro_cheque) === normalizeBankCheckNumber(movement.checkNumber));
      if (byNumber) rows.push(byNumber);
    }
    if (!rows.length) return false;
    const timestamp = new Date().toISOString();
    rows.forEach((row) => {
      row.estado = "Depositado";
      row.banco = bank;
      row.fecha_deposito = row.fecha_deposito || movement.date;
      row.fecha_uso = row.fecha_uso || movement.date;
      row._editedLocallyAt = timestamp;
    });
    return true;
  }
  
  function updateIssuedCheckFromBankMovement(tables, movement, bank) {
    const checkId = backendId(movement.checkMatch?.id);
    const checkRows = tables.cheques_entregados?.rows || [];
    const row = checkRows.find((check) => backendId(check.id_cheque_entregado) === checkId)
      || checkRows.find((check) => normalizeBankCheckNumber(check.nro_cheque) === normalizeBankCheckNumber(movement.checkNumber));
    if (!row) return false;
    row.estado = "Debitado";
    row.banco = bank;
    row.fecha_uso = row.fecha_uso || movement.date;
    row._editedLocallyAt = new Date().toISOString();
    return true;
  }
  
  function bankPaymentMethodFromMovement(movement) {
    const detail = backendNormalizeText([movement.detail, movement.concept].filter(Boolean).join(" "));
    if (movement.checkNumber || detail.includes("cheque") || detail.includes("echeq") || detail.includes("ch camara")) return "Cheque";
    if (detail.includes("transfer") || detail.includes("tr.")) return "Transferencia";
    if (detail.includes("debito")) return "Debito";
    return "Movimiento bancario";
  }

  return {
    backendCreditorTagRelationId,
    backendPersistedBankMovementCounts,
    backendValueIsBlank,
    bankMoneyKey,
    bankMovementAssociation,
    bankMovementBackendCreditorId,
    bankMovementFingerprint,
    bankPaymentMethodFromMovement,
    bankSourceDestinationForOriginType,
    canonicalPendingBankMovements,
    consumePersistedBankMovement,
    createBankEgressForSource,
    createBankPaymentForExpense,
    createBankSourceExpense,
    ensureBankDetailsSchema,
    importBankMovements,
    persistBankMovement,
    updateIssuedCheckFromBankMovement,
    updateReceivedCheckFromBankMovement
  };
}

module.exports = { createBankPersistenceService };
