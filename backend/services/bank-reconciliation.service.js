const { fromCents, normalize: normalizeMoney, toCents } = require("../../shared/money");

function createBankReconciliationService(dependencies) {
  const { analyzeBankMovement, backendBankCollectionCandidates, backendBankCreditPayableCandidates, backendBankIdentityIndex, backendBankPayableCandidates, backendBankPaymentCandidates, backendBankSourceCandidates, backendId, backendIssuedChecksByNumber, backendNormalizeText, backendNumber, backendPersistedBankMovementCounts, backendReceivedCheckDepositGroups, backendReceivedChecksByNumber, bankMovementFingerprint, cleanBackendText, createBankEgressForSource, createBankPaymentForExpense, createBankSourceExpense, ensureBackendTable, loadCache, normalizeBackendBankDetails, parseBankMovements, persistBankMovement, readJsonBody, saveBackendCache, seedDefaultBankDetails, sendJson, updateIssuedCheckFromBankMovement, updateReceivedCheckFromBankMovement } = dependencies;
  const failureInjector = dependencies.failureInjector || (() => {});
  const now = dependencies.now || (() => new Date());

  async function handleBankReconciliationAnalyze(request, response) {
    try {
      const body = await readJsonBody(request);
      const sourceCache = JSON.parse(JSON.stringify(loadCache()));
      const existingKeys = new Set(pendingBankMovements(sourceCache, body.bank).map((movement) => movement.movementKey));
      const report = buildBankReconciliationReport(body, sourceCache);
      const resultingKeys = new Set(report.movements.map((movement) => movement.movementKey));
      const newCount = [...resultingKeys].filter((key) => !existingKeys.has(key)).length;
      report.merge = {
        newCount,
        duplicateCount: Math.max(0, report.rowsRead - newCount),
        totalPending: report.movements.length
      };
      storePendingBankMovements(sourceCache, report.bank, report.movements);
      sourceCache.generatedAt = new Date().toISOString();
      failureInjector("before-bank-reconciliation-save");
      saveBackendCache(sourceCache);
      sendJson(response, 200, { ok: true, report });
    } catch (error) {
      console.error("No se pudo analizar el extracto bancario.", error);
      const statusCode = error.statusCode || 500;
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
      const hasStoredPending = pendingBankMovements(sourceCache, body.bank || "ICBC").length > 0;
      const report = buildBankReconciliationReport(
        hasStoredPending ? { ...body, csvText: "" } : body,
        sourceCache
      );
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
        const alreadyRegistered = (tables.movimientos_bancarios.rows || []).some((row) => (
          bankMovementFingerprint(row, row.banco || bank) === depositKey
        ));
        if (alreadyRegistered) throw new Error("Este depósito ya fue conciliado en otra operación.");
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
        persistBankMovement(tables, {
          ...movement,
          debit: 0,
          credit: depositedAmount,
          amount: depositedAmount,
          checkMatch: {
            type: "cheque_recibido",
            ids: selectedChecks.map((row) => row.id_cheque_recibido),
            idCobro: selectedChecks[0].id_cobro
          }
        }, bank, depositId, depositPayload);
        removePendingBankMovements(cache, bank, [movement?.movementKey].filter(Boolean));
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
    const csvText = String(body.csvText || "");
    const cache = JSON.parse(JSON.stringify(sourceCache));
    if (!cache.tables) cache.tables = {};
    ensureBackendTable(cache.tables, "datos_bancarios");
    seedDefaultBankDetails(cache);
    normalizeBackendBankDetails(cache);
    const tables = cache.tables || {};
    const incomingMovements = csvText.trim() ? parseBankMovements(csvText) : [];
    const storedMovements = pendingBankMovements(sourceCache, bank);
  
    const paymentCandidates = backendBankPaymentCandidates(tables, bank);
    const collectionCandidates = backendBankCollectionCandidates(tables, bank);
    const payableCandidates = backendBankPayableCandidates(tables);
    const creditPayableCandidates = backendBankCreditPayableCandidates(tables);
    const sourceCandidates = backendBankSourceCandidates(tables);
    const identityIndex = backendBankIdentityIndex(tables);
    const receivedChecksByNumber = backendReceivedChecksByNumber(tables);
    const issuedChecksByNumber = backendIssuedChecksByNumber(tables);
    const receivedCheckDepositGroups = backendReceivedCheckDepositGroups(tables, bank);
    const analyzeMovements = (movements, persistedMovementCounts) => movements.map((movement) => (
      analyzeBankMovement(
        movement,
        paymentCandidates,
        collectionCandidates,
        payableCandidates,
        creditPayableCandidates,
        sourceCandidates,
        persistedMovementCounts,
        identityIndex,
        receivedChecksByNumber,
        issuedChecksByNumber,
        receivedCheckDepositGroups,
        bank
      )
    ));
    const storedAnalyzed = analyzeMovements(storedMovements, new Map());
    const reconciledMovementKeys = new Set(
      (tables.movimientos_bancarios?.rows || [])
        .filter((row) => backendNormalizeText(row.banco) === backendNormalizeText(bank))
        .map((row) => cleanBackendText(row._bankMovementKey))
        .filter(Boolean)
    );
    const incomingWithKeys = assignBankMovementKeys(incomingMovements, bank);
    const incomingAnalyzed = analyzeMovements(
      incomingWithKeys.filter((movement) => !reconciledMovementKeys.has(cleanBackendText(movement.movementKey))),
      backendPersistedBankMovementCounts(tables, bank, { legacyOnly: true })
    ).filter((movement) => movement.status !== "conciliado");
    const mergedMovements = new Map(storedAnalyzed.map((movement) => [movement.movementKey, movement]));
    incomingAnalyzed.forEach((movement) => mergedMovements.set(movement.movementKey, movement));
    const analyzedMovements = [...mergedMovements.values()];
  
    const reconciled = analyzedMovements.filter((movement) => movement.status === "conciliado");
    const ready = analyzedMovements.filter((movement) => movement.status === "listo");
    const pending = analyzedMovements.filter((movement) => movement.status !== "conciliado");
    const lastBalance = normalizeMoney(
      analyzedMovements.find((movement) => Number.isFinite(movement.balance))?.balance || 0
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
      rowsRead: incomingMovements.length,
      summary: {
        realBalance: lastBalance,
        reconciledCount: reconciled.length,
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
      movements: analyzedMovements
    };
  }
  
  function backendBankLookupValues(rows, column, defaults = []) {
    return [...new Set([
      ...defaults,
      ...(rows || []).map((row) => cleanBackendText(row[column]))
    ].filter(Boolean))].sort((left, right) => left.localeCompare(right, "es"));
  }

  function bankReconciliationState(cache) {
    const current = cache.bankReconciliation;
    if (current && !Array.isArray(current) && Array.isArray(current.pendingMovements)) return current;
    return { version: 1, pendingMovements: [], updatedAt: "" };
  }

  function pendingBankMovements(cache, bank) {
    const normalizedBank = backendNormalizeText(bank);
    return bankReconciliationState(cache).pendingMovements
      .filter((movement) => backendNormalizeText(movement.bank) === normalizedBank)
      .map((movement) => ({ ...movement }));
  }

  function storePendingBankMovements(cache, bank, movements) {
    const state = bankReconciliationState(cache);
    const normalizedBank = backendNormalizeText(bank);
    const otherBanks = state.pendingMovements.filter((movement) => (
      backendNormalizeText(movement.bank) !== normalizedBank
    ));
    cache.bankReconciliation = {
      version: 1,
      pendingMovements: [
        ...otherBanks,
        ...movements.map((movement) => persistedPendingBankMovement(movement, bank))
      ],
      updatedAt: new Date().toISOString()
    };
  }

  function removePendingBankMovements(cache, bank, movementKeys) {
    const state = bankReconciliationState(cache);
    const normalizedBank = backendNormalizeText(bank);
    const selected = new Set((movementKeys || []).map(String));
    const remaining = state.pendingMovements.filter((movement) => (
      backendNormalizeText(movement.bank) !== normalizedBank
      || !selected.has(String(movement.movementKey || ""))
    ));
    if (remaining.length === state.pendingMovements.length) return false;
    cache.bankReconciliation = {
      version: 1,
      pendingMovements: remaining,
      updatedAt: new Date().toISOString()
    };
    return true;
  }

  function persistedPendingBankMovement(movement, bank) {
    const fields = [
      "movementKey", "rowNumber", "date", "code", "concept", "bankConcept", "detail",
      "counterpartyName", "cuit", "checkNumber", "cbuAlias", "docType", "amount",
      "debit", "credit", "balance", "channel"
    ];
    return fields.reduce((stored, field) => {
      if (movement[field] !== undefined) stored[field] = movement[field];
      return stored;
    }, { bank });
  }

  function assignBankMovementKeys(movements, bank) {
    const occurrences = new Map();
    return (movements || []).map((movement) => {
      const fingerprint = bankMovementFingerprint(movement, bank);
      const occurrence = (occurrences.get(fingerprint) || 0) + 1;
      occurrences.set(fingerprint, occurrence);
      return { ...movement, movementKey: `${fingerprint}:${occurrence}` };
    });
  }

  function bankReconciliationDateSummary(cache, bank = "") {
    const normalizedBank = backendNormalizeText(bank);
    const rows = (cache.tables?.movimientos_bancarios?.rows || [])
      .map((row) => ({
        bank: cleanBackendText(row.banco) || "Banco sin identificar",
        date: normalizedBankDate(row.fecha)
      }))
      .filter((row) => row.date && (!normalizedBank || backendNormalizeText(row.bank) === normalizedBank));
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
      bank: normalizedBank ? bank : (latest?.bank || ""),
      account: "",
      latestDate: latest?.latestDate || "",
      daysElapsed: latest?.daysElapsed ?? null,
      reconciledCount: rows.length,
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
    const reconciledMovementKeys = new Set();
    const selectedKeys = new Set(report.movementKeys || []);
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
        if (report.applyMode === "reconcile") {
          reconciledMovementKeys.add(String(movement.movementKey || ""));
        }
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
        reconciledMovementKeys.add(String(movement.movementKey || ""));
        counters.movementsReconciled += 1;
        return;
      }
  
      counters.skipped += 1;
    });
  
    if (report.applyMode === "reconcile" && reconciledMovementKeys.size) {
      removePendingBankMovements(cache, report.bank, [...reconciledMovementKeys]);
    }
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

  return {
    handleBankReconciliationAnalyze,
    handleBankReconciliationApply,
    handleBankReconciliationDepositChecks,
    handleBankReconciliationState,
    handleBankReconciliationSummary
  };
}

module.exports = { createBankReconciliationService };
