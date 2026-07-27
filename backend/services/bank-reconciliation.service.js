const { fromCents, normalize: normalizeMoney, toCents } = require("../../shared/money");

const { investmentFundCandidates } = require("./investment-fund.service");

function createBankReconciliationService(dependencies) {
  const { analyzeBankMovement, backendBankCollectionCandidates, backendBankCreditPayableCandidates, backendBankIdentityIndex, backendBankPayableCandidates, backendBankPaymentCandidates, backendBankSourceCandidates, backendId, backendIssuedChecksByNumber, backendNormalizeText, backendNumber, backendReceivedCheckDepositGroups, backendReceivedChecksByNumber, bankMovementAssociation, bankMovementFingerprint, canonicalPendingBankMovements, cleanBackendText, createBankEgressForSource, createBankPaymentForExpense, createBankSourceExpense, ensureBackendTable, importBankMovements, loadCache, normalizeBackendBankDetails, parseBankMovements, persistBankMovement, readJsonBody, saveBackendCache, seedDefaultBankDetails, sendJson, updateIssuedCheckFromBankMovement, updateReceivedCheckFromBankMovement } = dependencies;
  const failureInjector = dependencies.failureInjector || (() => {});
  const now = dependencies.now || (() => new Date());

  async function handleBankReconciliationAnalyze(request, response) {
    try {
      const body = await readJsonBody(request);
      const bank = cleanBackendText(body.bank) || "ICBC";
      const csvText = String(body.csvText || "");
      if (!csvText.trim()) {
        const error = new Error("El archivo bancario esta vacio.");
        error.statusCode = 400;
        throw error;
      }
      const parsedMovements = parseBankMovements(csvText);
      if (!parsedMovements.length) {
        const error = new Error("El archivo no contiene movimientos bancarios validos.");
        error.statusCode = 400;
        throw error;
      }
      const sourceCache = JSON.parse(JSON.stringify(loadCache()));
      if (!sourceCache.tables) sourceCache.tables = {};
      const merge = importBankMovements(sourceCache.tables, parsedMovements, bank);
      const report = buildBankReconciliationReport({ bank }, sourceCache);
      report.rowsRead = parsedMovements.length;
      report.merge = {
        newCount: merge.newCount,
        duplicateCount: merge.duplicateCount,
        totalPending: report.movements.length
      };
      sourceCache.generatedAt = new Date().toISOString();
      failureInjector("before-bank-reconciliation-save");
      saveBackendCache(sourceCache);
      sendJson(response, 200, { ok: true, report });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error("No se pudo analizar el extracto bancario.", error);
      const message = statusCode < 500
        ? error.message
        : "No se pudo analizar el extracto bancario. Revisa el archivo e intentalo nuevamente.";
      sendJson(response, statusCode, { ok: false, error: message });
    }
  }
  
  async function handleBankReconciliationApply(request, response) {
    try {
      const body = await readJsonBody(request);
      const sourceCache = JSON.parse(JSON.stringify(loadCache()));
      const report = buildBankReconciliationReport(body, sourceCache);
      const result = applyBankReconciliationReport(report);
      sendJson(response, 200, { ok: true, result });
    } catch (error) {
      sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
    }
  }
  
  async function handleBankReconciliationDepositChecks(request, response) {
    try {
      const body = await readJsonBody(request);
      const bank = cleanBackendText(body.bank) || "ICBC";
      const movement = body.movement || null;
      const manualDeposit = Boolean(body.manualDeposit || !movement);
      const depositDate = cleanBackendText(body.depositDate || movement?.date);
      const rawCheckIds = (body.checkIds || []).map((id) => backendId(id)).filter(Boolean);
      if (new Set(rawCheckIds).size !== rawCheckIds.length) {
        throwConflict("Los IDs de cheques no pueden repetirse.");
      }
      const checkIds = [...new Set(rawCheckIds)];
      if (!checkIds.length) throw new Error("Selecciona al menos un cheque para depositar.");
  
      const cache = JSON.parse(JSON.stringify(loadCache()));
      if (!cache.tables) cache.tables = {};
      const tables = cache.tables;
      ensureBackendTable(tables, "cheques_recibidos");
      ensureBackendTable(tables, "movimientos_bancarios");
  
      const selectedChecks = checkIds.map((id) => (
        tables.cheques_recibidos.rows.find((row) => backendId(row.id_cheque_recibido) === id)
      ));
      if (selectedChecks.some((row) => !row)) throw new Error("Uno de los cheques seleccionados ya no existe.");
      const anticipatedDepositKey = manualDeposit
        ? `${bank}|${depositDate}|${checkIds.slice().sort().join(",")}`
        : bankMovementFingerprint(movement, bank);
      const anticipatedDepositId = `deposito-${anticipatedDepositKey}`;
      if (!selectedChecks.every((row) => row.id_deposito === anticipatedDepositId) && selectedChecks.some((row) => (
        backendNormalizeText(row.estado) !== "pendiente"
        || backendId(row.id_deposito)
        || backendId(row.id_pago_endoso)
        || cleanBackendText(row.fecha_deposito)
        || cleanBackendText(row.fecha_endoso)
      ))) {
        throwConflict("Solo pueden depositarse cheques pendientes y sin utilización previa.");
      }
      const selectedAmountCents = selectedChecks.reduce(
        (total, row) => total + Math.abs(toCents(backendNumber(row.monto))),
        0
      );
      const depositedAmountCents = manualDeposit
        ? selectedAmountCents
        : Math.abs(toCents(backendNumber(movement.amount ?? movement.credit)));
      const selectedAmount = fromCents(selectedAmountCents);
      const depositedAmount = fromCents(depositedAmountCents);
      if (!depositDate) throw new Error("Indica la fecha del depósito.");
      if (depositedAmountCents === 0 || (
        !manualDeposit && depositedAmountCents !== selectedAmountCents
      )) {
        throw new Error("La suma de los cheques seleccionados no coincide con el crédito del banco.");
      }
  
      const depositKey = anticipatedDepositKey;
      const depositId = anticipatedDepositId;
      const depositPayload = stableSerialize({ bank, depositDate, checkIds: checkIds.slice().sort(), manualDeposit, movement });
      if (selectedChecks.every((row) => row.id_deposito === depositId)) {
        assertSameOperation(selectedChecks[0]._bankOperationPayload, depositPayload);
        if (!manualDeposit) {
          const savedMovement = tables.movimientos_bancarios.rows.find((row) => row._bankOperationKey === depositId);
          if (!savedMovement) throwConflict("El depósito existente no conserva su movimiento bancario.");
          assertSameOperation(savedMovement._bankOperationPayload, depositPayload);
        }
        return sendJson(response, 200, {
          ok: true,
          idempotent: true,
          checkCount: selectedChecks.length,
          amount: selectedAmount,
          manualDeposit
        });
      }
      if (!manualDeposit) {
        const canonicalRow = findCanonicalBankMovementRow(tables, movement, bank);
        if (!canonicalRow) throwConflict("El movimiento bancario pendiente ya no existe.");
        if (backendId(canonicalRow.id_pago) || backendId(canonicalRow.id_cobro) || backendId(canonicalRow.id_movimiento_fondo)) {
          throwConflict("Este depósito ya fue conciliado en otra operación.");
        }
      }
      if (selectedChecks.some((row) => backendNormalizeText(row.estado).includes("deposit"))) {
        throw new Error("Uno de los cheques seleccionados ya fue depositado en otra operación.");
      }
  
      const timestamp = new Date().toISOString();
      selectedChecks.forEach((row) => {
        row.estado = "Depositado";
        row.banco = bank;
        row.fecha_deposito = depositDate;
        row.id_deposito = depositId;
        row._bankOperationPayload = depositPayload;
        row.fecha_uso = row.fecha_uso || depositDate;
        row._editedLocallyAt = timestamp;
      });
      failureInjector("after-check-updates");
      if (!manualDeposit) {
        const canonicalRow = findCanonicalBankMovementRow(tables, movement, bank);
        persistBankMovement(tables, {
          ...movement,
          canonicalMovementId: backendId(canonicalRow?.id_movimiento_bancario),
          movementKey: cleanBackendText(canonicalRow?._bankMovementKey)
            || cleanBackendText(movement?.movementKey),
          debit: 0,
          credit: depositedAmount,
          amount: depositedAmount,
          checkMatch: {
            type: "cheque_recibido",
            ids: selectedChecks.map((row) => row.id_cheque_recibido),
            idCobro: selectedChecks[0].id_cobro
          }
        }, bank, depositId, depositPayload);
      }
  
      cache.generatedAt = timestamp;
      saveBackendCache(cache);
      sendJson(response, 200, { ok: true, idempotent: false, checkCount: selectedChecks.length, amount: selectedAmount, manualDeposit });
    } catch (error) {
      sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
    }
  }
  
  function buildBankReconciliationReport(body = {}, sourceCache = JSON.parse(JSON.stringify(loadCache()))) {
    const bank = String(body.bank || "ICBC").trim() || "ICBC";
    const cache = JSON.parse(JSON.stringify(sourceCache));
    if (!cache.tables) cache.tables = {};
    ensureBackendTable(cache.tables, "datos_bancarios");
    ensureBackendTable(cache.tables, "movimientos_bancarios");
    seedDefaultBankDetails(cache);
    normalizeBackendBankDetails(cache);
    const tables = cache.tables || {};
    const storedMovements = canonicalPendingBankMovements(tables, bank);
  
    const paymentCandidates = backendBankPaymentCandidates(tables, bank);
    const collectionCandidates = backendBankCollectionCandidates(tables, bank);
    const payableCandidates = backendBankPayableCandidates(tables);
    const creditPayableCandidates = backendBankCreditPayableCandidates(tables);
    const sourceCandidates = backendBankSourceCandidates(tables);
    const identityIndex = backendBankIdentityIndex(tables);
    const receivedChecksByNumber = backendReceivedChecksByNumber(tables);
    const issuedChecksByNumber = backendIssuedChecksByNumber(tables);
    const receivedCheckDepositGroups = backendReceivedCheckDepositGroups(tables, bank);
    const analyzedMovements = storedMovements.map((movement) => (
      normalizePendingAnalysis(analyzeBankMovement(
        movement,
        paymentCandidates,
        collectionCandidates,
        payableCandidates,
        creditPayableCandidates,
        sourceCandidates,
        new Map(),
        identityIndex,
        receivedChecksByNumber,
        issuedChecksByNumber,
        receivedCheckDepositGroups,
        bank
      ), tables)
    ));
  
    const ready = analyzedMovements.filter((movement) => movement.status === "listo");
    const pending = analyzedMovements;
    const lastBalance = normalizeMoney(
      [...analyzedMovements].reverse().find((movement) => Number.isFinite(movement.balance))?.balance || 0
    );
    const pendingDebitCents = pending
      .filter((movement) => toCents(movement.amount) < 0)
      .reduce((total, movement) => total + Math.abs(toCents(movement.amount)), 0);
    const pendingCreditCents = pending
      .filter((movement) => toCents(movement.amount) > 0)
      .reduce((total, movement) => total + toCents(movement.amount), 0);
    const pendingDebits = fromCents(pendingDebitCents);
    const pendingCredits = fromCents(pendingCreditCents);
  
    return {
      bank,
      source: "backend",
      rowsRead: 0,
      summary: {
        realBalance: lastBalance,
        reconciledCount: 0,
        readyCount: ready.length,
        pendingCount: pending.length,
        totalPendingCount: analyzedMovements.length,
        pendingDebits,
        pendingCredits,
        netPending: fromCents(pendingCreditCents - pendingDebitCents)
      },
      reconciliation: bankReconciliationDateSummary(sourceCache, bank),
      applyMode: body.applyMode || "all",
      movementKeys: Array.isArray(body.movementKeys) ? body.movementKeys.map(String) : [],
      reviewRows: body.reviewRows && typeof body.reviewRows === "object" ? body.reviewRows : {},
      lookupOptions: {
        invoiceTypes: backendBankLookupValues(tables.egresos?.rows, "tipo_factura", ["Factura A", "Factura B", "Factura C", "Remito X"]),
        paymentMethods: backendBankLookupValues(tables.pagos?.rows, "metodo", ["Transferencia", "Cheque", "Debito", "Movimiento bancario"])
      },
      investmentFundCandidates: investmentFundCandidates(
        analyzedMovements.map((movement) => ({ ...movement, bank })),
        tables
      ),
      movements: analyzedMovements
    };
  }

  function normalizePendingAnalysis(movement, tables) {
    if (movement.status !== "listo") return movement;
    const { idPago, idCobro } = bankMovementAssociation(movement);
    const validPayment = idPago && (tables.pagos?.rows || []).some((row) => backendId(row.id_pago) === idPago);
    const validCollection = idCobro && (tables.cobros?.rows || []).some((row) => backendId(row.id_cobro) === idCobro);
    if ((validPayment && !idCobro) || (validCollection && !idPago)) return movement;
    return {
      ...movement,
      status: "revisar",
      action: "Requiere asociar un pago o un cobro"
    };
  }
  
  function backendBankLookupValues(rows, column, defaults = []) {
    return [...new Set([
      ...defaults,
      ...(rows || []).map((row) => cleanBackendText(row[column]))
    ].filter(Boolean))].sort((left, right) => left.localeCompare(right, "es"));
  }

  function bankReconciliationDateSummary(cache, bank = "") {
    const normalizedBank = backendNormalizeText(bank);
    const bankMovements = cache.tables?.movimientos_bancarios?.rows || [];
    const rows = bankMovements
      .map((row) => ({
        bank: cleanBackendText(row.banco) || "Banco sin identificar",
        date: normalizedBankDate(row.fecha)
      }))
      .filter((row) => row.date);
    const byBank = new Map();
    rows.forEach((row) => {
      const key = backendNormalizeText(row.bank);
      const current = byBank.get(key);
      if (!current || row.date > current.date) byBank.set(key, row);
    });
    const details = [...byBank.values()]
      .sort((left, right) => right.date.localeCompare(left.date))
      .map((row) => ({
        bank: row.bank,
        account: "",
        latestDate: row.date,
        daysElapsed: bankCalendarDaysSince(row.date, now())
      }));
    const latest = details[0] || null;
    return {
      bank: latest?.bank || "",
      account: "",
      latestDate: latest?.latestDate || "",
      daysElapsed: latest?.daysElapsed ?? null,
      reconciledCount: bankMovements.filter((row) => (
        (backendId(row.id_pago) || backendId(row.id_cobro) || backendId(row.id_movimiento_fondo))
        && normalizedBankDate(row.fecha)
        && (!normalizedBank || backendNormalizeText(row.banco) === normalizedBank)
      )).length,
      details
    };
  }

  function normalizedBankDate(value) {
    const text = cleanBackendText(value);
    const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) return validCalendarDate(isoMatch[1], isoMatch[2], isoMatch[3]);
    const localMatch = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (!localMatch) return "";
    return validCalendarDate(localMatch[3], localMatch[2], localMatch[1]);
  }

  function validCalendarDate(yearText, monthText, dayText) {
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year
      || date.getUTCMonth() !== month - 1
      || date.getUTCDate() !== day
    ) return "";
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function bankCalendarDaysSince(dateIso, now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(now);
    const today = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const todayUtc = Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day));
    const [year, month, day] = dateIso.split("-").map(Number);
    const movementUtc = Date.UTC(year, month - 1, day);
    return Math.max(0, Math.floor((todayUtc - movementUtc) / 86400000));
  }
  
  function applyBankReconciliationReport(report) {
    const cache = JSON.parse(JSON.stringify(loadCache()));
    if (!cache.tables) cache.tables = {};
    const tables = cache.tables;
    ensureBackendTable(tables, "acreedores");
    ensureBackendTable(tables, "otros_gastos");
    ensureBackendTable(tables, "egresos");
    ensureBackendTable(tables, "pagos");
    ensureBackendTable(tables, "detalle_pagos");
    ensureBackendTable(tables, "cheques_recibidos");
    ensureBackendTable(tables, "cheques_entregados");
    ensureBackendTable(tables, "movimientos_bancarios");
  
    const counters = {
      paymentsCreated: 0,
      egressesCreated: 0,
      expensesCreated: 0,
      paymentDetailsCreated: 0,
      checksUpdated: 0,
      movementsReconciled: 0,
      skipped: 0
    };
    const notes = [];
    const selectedKeys = new Set(report.movementKeys || []);
    const fundCandidateKeys = new Set(
      (report.investmentFundCandidates || [])
        .map((candidate) => cleanBackendText(candidate.movement?.movementKey))
        .filter(Boolean)
    );
    const fundCandidateIds = new Set(
      (report.investmentFundCandidates || [])
        .map((candidate) => backendId(candidate.movement?.id_movimiento_bancario))
        .filter(Boolean)
    );
    const selectedMovements = (report.movements || []).filter((movement) => (
      !selectedKeys.size || selectedKeys.has(String(movement.movementKey || ""))
    ));
    if (!selectedMovements.length) {
      return {
        ...counters,
        notes,
        reconciliation: bankReconciliationDateSummary(cache, report.bank)
      };
    }
  
    selectedMovements.forEach((movement) => {
      const isFundCandidate = fundCandidateKeys.has(cleanBackendText(movement.movementKey))
        || fundCandidateIds.has(backendId(movement.canonicalMovementId));
      if (isFundCandidate) {
        counters.skipped += 1;
        notes.push(`${movement.date} · ${movement.detail || movement.concept}: debe resolverse en Movimientos de fondo para agregar.`);
        return;
      }
      const operationKey = `${report.applyMode}:${bankMovementFingerprint(movement, report.bank)}:${movement.movementKey || ""}`;
      const operationPayload = stableSerialize({
        applyMode: report.applyMode,
        bank: report.bank,
        movement,
        reviewRow: report.reviewRows?.[movement.movementKey] || {}
      });
      const existingOperation = bankOperationRow(tables, operationKey);
      if (existingOperation) {
        assertSameOperation(existingOperation._bankOperationPayload, operationPayload);
        assertBankOperationRelations(tables, report.applyMode, operationKey);
        return skipBankMovement(counters);
      }
      if (report.applyMode === "createExpenses") {
        if (movement.status !== "agregar_gasto") return skipBankMovement(counters);
        const created = createBankSourceExpense(tables, movement, report.reviewRows?.[movement.movementKey], operationKey, operationPayload);
        if (!created) {
          counters.skipped += 1;
          notes.push(`${movement.date} · ${movement.detail || movement.concept}: debe completarse en ${movement.sourceDestination?.label || "su modulo operativo"}.`);
          return;
        }
        counters.expensesCreated += 1;
        notes.push(`${created.label} #${created.sourceId} creado desde el movimiento bancario.`);
        return;
      }
  
      if (report.applyMode === "createEgresses") {
        if (movement.status !== "agregar_egreso" || !movement.sourceMatch) return skipBankMovement(counters);
        const created = createBankEgressForSource(tables, movement, report.reviewRows?.[movement.movementKey], operationKey, operationPayload);
        if (!created) return skipBankMovement(counters);
        counters.egressesCreated += 1;
        notes.push(`Egreso #${created.expenseId} asociado a ${created.sourceLabel} #${created.sourceId}.`);
        return;
      }
  
      if (report.applyMode === "createPayments") {
        if (movement.status !== "agregar_pago" || movement.match?.type !== "egreso" || !movement.match.id) {
          return skipBankMovement(counters);
        }
        createBankPaymentForExpense(
          tables,
          movement,
          report.bank,
          movement.match.id,
          fromCents(Math.abs(toCents(movement.amount))),
          report.reviewRows?.[movement.movementKey],
          operationKey,
          operationPayload
        );
        counters.paymentsCreated += 1;
        counters.paymentDetailsCreated += 1;
        return;
      }
  
      if (report.applyMode === "reconcile") {
        if (movement.status !== "listo") return skipBankMovement(counters);
        if (movement.checkMatch) {
          const updated = movement.checkMatch.type === "cheque_entregado"
            ? updateIssuedCheckFromBankMovement(tables, movement, report.bank)
            : updateReceivedCheckFromBankMovement(tables, movement, report.bank);
          if (updated) counters.checksUpdated += 1;
        }
        persistBankMovement(tables, movement, report.bank, operationKey, operationPayload);
        counters.movementsReconciled += 1;
        return;
      }
  
      counters.skipped += 1;
    });
  
    cache.generatedAt = new Date().toISOString();
    failureInjector("before-bank-reconciliation-save");
    saveBackendCache(cache);
    return {
      ...counters,
      notes,
      reconciliation: bankReconciliationDateSummary(cache, report.bank)
    };
  }
  
  function skipBankMovement(counters) {
    counters.skipped += 1;
  }

  async function handleBankReconciliationState(request, response) {
    try {
      const url = new URL(request.url || "/api/bank-reconciliation/state", "http://127.0.0.1");
      const bank = cleanBackendText(url.searchParams.get("bank")) || "ICBC";
      const report = buildBankReconciliationReport({ bank }, JSON.parse(JSON.stringify(loadCache())));
      sendJson(response, 200, { ok: true, report });
    } catch (error) {
      sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
    }
  }

  async function handleBankReconciliationSummary(_request, response) {
    try {
      sendJson(response, 200, {
        ok: true,
        summary: bankReconciliationDateSummary(loadCache())
      });
    } catch (error) {
      sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
    }
  }

  function bankOperationRow(tables, operationKey) {
    for (const table of Object.values(tables)) {
      const row = (table?.rows || []).find((candidate) => candidate._bankOperationKey === operationKey);
      if (row) return row;
    }
    return null;
  }

  function assertSameOperation(existingPayload, requestedPayload) {
    if (existingPayload === requestedPayload) return;
    const error = new Error("La clave de operación ya fue usada con un contenido diferente.");
    error.statusCode = 409;
    throw error;
  }

  function assertBankOperationRelations(tables, applyMode, operationKey) {
    if (applyMode === "createPayments") {
      const payment = (tables.pagos?.rows || []).find((row) => row._bankOperationKey === operationKey);
      const detail = (tables.detalle_pagos?.rows || []).find((row) => row._bankOperationKey === operationKey);
      if (!payment || !detail || backendId(payment.id_pago) !== backendId(detail.id_pago)) {
        throwConflict("La conciliación existente tiene pago o detalle incompleto.");
      }
    }
    if (applyMode === "createEgresses" && !(tables.egresos?.rows || []).some((row) => row._bankOperationKey === operationKey)) {
      throwConflict("La conciliación existente no conserva el egreso creado.");
    }
    if (applyMode === "reconcile" && !(tables.movimientos_bancarios?.rows || []).some((row) => row._bankOperationKey === operationKey)) {
      throwConflict("La conciliación existente no conserva el movimiento bancario.");
    }
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

  function findCanonicalBankMovementRow(tables, movement, bank) {
    const movementId = backendId(movement?.canonicalMovementId);
    const movementKey = cleanBackendText(movement?.movementKey);
    const rows = tables.movimientos_bancarios?.rows || [];
    return rows.find((row) => (
      (movementId && backendId(row.id_movimiento_bancario) === movementId)
      || (movementKey && cleanBackendText(row._bankMovementKey) === movementKey)
    )) || rows.find((row) => (
      backendNormalizeText(row.banco) === backendNormalizeText(bank)
      && bankMovementFingerprint(row, row.banco || bank) === bankMovementFingerprint(movement, bank)
      && !backendId(row.id_pago)
      && !backendId(row.id_cobro)
    ));
  }

  return {
    handleBankReconciliationAnalyze,
    handleBankReconciliationApply,
    handleBankReconciliationDepositChecks,
    handleBankReconciliationState,
    handleBankReconciliationSummary
  };
}

module.exports = { createBankReconciliationService };
