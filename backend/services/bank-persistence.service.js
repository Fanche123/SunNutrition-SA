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
      bankMoneyKey(movement.saldo ?? movement.balance)
    ].join("|");
    return crypto.createHash("sha1").update(normalized).digest("hex");
  }
  
  function bankMoneyKey(value) {
    return toCents(backendNumber(value));
  }
  
  function backendPersistedBankMovementCounts(tables, bank) {
    const counts = new Map();
    (tables.movimientos_bancarios?.rows || []).forEach((row) => {
      if (!backendBankMatches(row.banco, bank)) return;
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
  
  function persistBankMovement(tables, movement, bank, operationKey = "", operationPayload = "") {
    const table = tables.movimientos_bancarios;
    const existing = operationKey && table.rows.find((row) => row._bankOperationKey === operationKey);
    if (existing) return existing;
    const match = movement.match || {};
    const timestamp = new Date().toISOString();
    table.rows.push({
      _rowNumber: table.rows.length + 2,
      id_movimiento_bancario: backendNextNumericId(table.rows, "id_movimiento_bancario"),
      banco: bank,
      fecha: movement.date,
      cod_concepto: movement.code || "",
      concepto: movement.concept || "",
      detalle: movement.detail || "",
      cuit: movement.cuit || "",
      nro_cheque: movement.checkNumber || "",
      debito: normalizeMoney(backendNumber(movement.debit || 0)),
      credito: normalizeMoney(backendNumber(movement.credit || 0)),
      importe: normalizeMoney(backendNumber(movement.amount || 0)),
      saldo: normalizeMoney(backendNumber(movement.balance || 0)),
      id_pago: match.type === "pago" ? match.id : (movement.checkMatch?.idPago || ""),
      id_cobro: match.type === "cobro" ? match.id : (movement.checkMatch?.idCobro || ""),
      _bankOperationKey: operationKey,
      _bankOperationPayload: operationPayload,
      _editedLocallyAt: timestamp
    });
    table.rowCount = table.rows.length;
    return table.rows[table.rows.length - 1];
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
  
    const creditorId = bankMovementBackendCreditorId(movement);
    if (!creditorId) return null;
    const relationId = backendCreditorTagRelationId(creditorId, movement.idEtiqueta, tables);
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
    const invoiceDate = backendIsoDate(reviewRow.date) || sourceMatch.invoiceDate || sourceMatch.date || movement.date;
    const timestamp = new Date().toISOString();
  
    expenseTable.rows.push({
      _rowNumber: expenseTable.rows.length + 2,
      id_egreso: expenseId,
      fecha_factura: invoiceDate,
      fecha_prevista_pago: movement.date,
      id_etiqueta: tagId,
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

  return { backendCreditorTagRelationId, backendPersistedBankMovementCounts, backendValueIsBlank, bankMoneyKey, bankMovementBackendCreditorId, bankMovementFingerprint, bankPaymentMethodFromMovement, bankSourceDestinationForOriginType, consumePersistedBankMovement, createBankEgressForSource, createBankPaymentForExpense, createBankSourceExpense, ensureBankDetailsSchema, persistBankMovement, updateIssuedCheckFromBankMovement, updateReceivedCheckFromBankMovement };
}

module.exports = { createBankPersistenceService };
