const { toCents } = require("../../shared/money");
const { investmentFundLedger } = require("./investment-fund.service");
const { cashLedgerSnapshot } = require("./cash-ledger.service");

const CASH_BOX_DEFINITIONS = Object.freeze({
  icbc: Object.freeze({
    id: "icbc",
    label: "Saldo del ICBC",
    bank: "ICBC",
    initialDate: "2026-06-09",
    initialBalanceCents: 380113005
  })
});

function createCashBoxesService({
  backendBankMatches,
  backendExpenseCounterpartyInfo,
  backendGroupRowsById,
  backendId,
  backendIsoDate,
  backendNormalizeText,
  backendRowsById,
  canonicalPendingBankMovements,
  loadCache,
  sendJson
}) {
  function buildCashBoxSnapshot(sourceCache, boxId) {
    const definition = CASH_BOX_DEFINITIONS[normalizeBoxId(boxId)];
    if (!definition) {
      const error = new Error("La caja solicitada no existe.");
      error.statusCode = 400;
      throw error;
    }

    const tables = sourceCache?.tables || {};
    const warnings = [];
    const bankRows = (tables.movimientos_bancarios?.rows || [])
      .map((row) => ({ row }))
      .filter(({ row }) => isMovementForBank(row, definition.bank));
    const latestBankMovement = latestObservedBankMovement(bankRows, definition, warnings);
    const cutoffDate = latestBankMovement?.date || null;
    const collectionHeaders = financialRowsFromDate(
      tables.cobros?.rows,
      {
        dateColumn: "fecha_cobro",
        idColumn: "id_cobro",
        label: "cobro",
        amountColumn: "monto"
      },
      definition,
      warnings,
      cutoffDate
    );
    const paymentHeaders = financialRowsFromDate(
      tables.pagos?.rows,
      {
        dateColumn: "fecha_pago",
        idColumn: "id_pago",
        label: "pago",
        amountColumn: "monto"
      },
      definition,
      warnings,
      cutoffDate
    );

    const bankAssociations = buildBankAssociationIndexes(
      tables.movimientos_bancarios?.rows || [],
      definition
    );
    const collections = buildCollectionEntries(
      collectionHeaders,
      tables,
      bankAssociations,
      definition,
      warnings,
      cutoffDate
    );
    const payments = buildPaymentEntries(
      paymentHeaders,
      tables,
      bankRows,
      definition,
      warnings,
      cutoffDate
    );
    const collectionTotalCents = sumSafeCents(collections.map((item) => item.amountCents));
    const paymentTotalCents = sumSafeCents(payments.map((item) => item.amountCents));
    const calculatedBalanceCents = sumSafeCents([
      definition.initialBalanceCents,
      collectionTotalCents,
      -paymentTotalCents
    ]);
    const differenceCents = latestBankMovement?.balanceCents === null
      || latestBankMovement?.balanceCents === undefined
      ? null
      : sumSafeCents([latestBankMovement.balanceCents, -calculatedBalanceCents]);

    const pendingCollections = buildPendingCollections(
      collections,
      tables,
      bankAssociations,
      definition
    );
    const pendingPayments = buildPendingPayments(
      payments,
      tables,
      bankAssociations,
      definition
    );
    const bankToErp = buildBankToErpSummary(tables, bankRows, definition, cutoffDate);
    const pendingCollectionTotalCents = sumSafeCents(pendingCollections.map((item) => item.amountCents));
    const pendingPaymentTotalCents = sumSafeCents(pendingPayments.map((item) => item.amountCents));
    const erpPendingNetCents = sumSafeCents([pendingCollectionTotalCents, -pendingPaymentTotalCents]);
    const pendingNetGapCents = sumSafeCents([bankToErp.pendingNetCents, -erpPendingNetCents]);
    const hasPendingAssociations = pendingCollections.length > 0
      || pendingPayments.length > 0
      || bankToErp.pendingCount > 0;
    const instrumentScope = summarizeInstrumentScope(collections, payments, definition);

    warnings.push(...instrumentScope.warnings);

    return {
      box: {
        id: definition.id,
        label: definition.label,
        bank: definition.bank
      },
      rule: {
        initialDate: definition.initialDate,
        initialDateInclusive: true,
        initialBalanceCents: definition.initialBalanceCents,
        collectionSource: "porción no cheque de cobros atribuible a ICBC + depósitos canónicos de cheques_recibidos",
        paymentSource: "pagos con banco ICBC; cheques emitidos sólo cuando existe evidencia de débito efectivo",
        includedStates: "Ingresos y salidas ICBC hasta el cierre bancario común; efectivo, endosos y otros bancos quedan excluidos.",
        formula: "saldo inicial + ingresos ICBC - salidas ICBC",
        differenceConvention: "saldo bancario final - saldo calculado del ERP",
        latestBankBalanceSource: "movimientos_bancarios.saldo",
        latestBankOrder: "fecha y orden fuente estable del extracto (descendente)"
      },
      summary: {
        collectionCount: collections.length,
        collectionTotalCents,
        paymentCount: payments.length,
        paymentTotalCents,
        calculatedBalanceCents,
        latestBankMovement,
        differenceCents,
        status: differenceCents === null
          ? "unavailable"
          : differenceCents === 0
            ? hasPendingAssociations
              ? "balanced_with_pending_associations"
              : "reconciled"
            : "difference"
      },
      erpToBank: {
        pendingCollectionCount: pendingCollections.length,
        pendingCollectionTotalCents,
        pendingPaymentCount: pendingPayments.length,
        pendingPaymentTotalCents,
        pendingNetCents: erpPendingNetCents,
        collections: pendingCollections,
        payments: pendingPayments
      },
      bankToErp: {
        ...bankToErp,
        pendingNetGapCents
      },
      instrumentScope,
      warnings: uniqueStrings(warnings)
    };
  }

  function buildTreasuryManagementSnapshot(sourceCache, boxId) {
    const cashBox = buildCashBoxSnapshot(sourceCache, boxId);
    const tables = sourceCache?.tables || {};
    const warnings = [...(cashBox.warnings || [])];
    const cash = cashPositionSummary(tables, warnings);
    const receivedChecks = receivedChecksSummary(tables.cheques_recibidos?.rows, warnings);
    const issuedChecks = issuedChecksSummary(tables.cheques_entregados?.rows, warnings);
    const fund = investmentFundSummary(tables.fondos_inversion_movimientos?.rows, warnings);
    const bankBalanceCents = cashBox.summary.calculatedBalanceCents;
    const liquidityTotalCents = cash.available && fund.available
      ? sumSafeCents([
        bankBalanceCents,
        cash.balanceCents,
        receivedChecks.availableTotalCents,
        fund.balanceCents
      ])
      : null;

    return {
      generatedAt: new Date().toISOString(),
      formula: {
        liquidity: "bancos + efectivo + cheques recibidos disponibles + fondo de inversión",
        issuedChecksTreatment: "Los cheques entregados pendientes se informan como compromiso y no se descuentan nuevamente."
      },
      position: {
        banksTotalCents: bankBalanceCents,
        bankAccounts: [{
          id: cashBox.box.id,
          label: cashBox.box.bank,
          erpBalanceCents: bankBalanceCents,
          latestBankMovement: cashBox.summary.latestBankMovement,
          differenceCents: cashBox.summary.differenceCents
        }],
        cash,
        receivedChecks,
        issuedChecks,
        fund,
        liquidityTotalCents,
        liquidityAvailable: Number.isSafeInteger(liquidityTotalCents)
      },
      operations: {
        collections: financialOperationSummary(tables.cobros?.rows, "id_cobro", "fecha_cobro", warnings, "cobro"),
        payments: financialOperationSummary(tables.pagos?.rows, "id_pago", "fecha_pago", warnings, "pago")
      },
      bankControl: [{
        id: cashBox.box.id,
        label: cashBox.box.bank,
        erpBalanceCents: bankBalanceCents,
        latestBankMovement: cashBox.summary.latestBankMovement,
        lastReconciliationDate: latestReconciliationDate(tables.movimientos_bancarios?.rows, cashBox.box.bank),
        differenceCents: cashBox.summary.differenceCents,
        pendingBankCount: cashBox.bankToErp.pendingCount,
        pendingCollectionCount: cashBox.erpToBank.pendingCollectionCount,
        pendingPaymentCount: cashBox.erpToBank.pendingPaymentCount
      }],
      warnings: uniqueStrings(warnings)
    };
  }

  function buildTreasuryManagementDetail(sourceCache, boxId, detailId) {
    const tables = sourceCache?.tables || {};
    const warnings = [];
    if (detailId === "bank") return { id: detailId, bank: limitedBankDetail(sourceCache, boxId) };
    if (detailId === "cash") return { id: detailId, ...cashPositionDetail(tables, warnings), warnings: uniqueStrings(warnings) };
    if (detailId === "received-checks") {
      return { id: detailId, ...receivedChecksDetail(tables.cheques_recibidos?.rows, warnings), warnings: uniqueStrings(warnings) };
    }
    if (detailId === "issued-checks") {
      return {
        id: detailId,
        ...issuedChecksDetail(tables.cheques_entregados?.rows, warnings),
        warnings: uniqueStrings(warnings)
      };
    }
    if (detailId === "fund") return { id: detailId, ...investmentFundDetail(tables.fondos_inversion_movimientos?.rows, warnings), warnings: uniqueStrings(warnings) };
    if (detailId === "other") return { id: detailId, ...otherFinancialMovementsDetail(tables, warnings), warnings: uniqueStrings(warnings) };
    const error = new Error("El detalle de Tesorería solicitado no existe.");
    error.statusCode = 400;
    throw error;
  }

  function limitedBankDetail(sourceCache, boxId, limit = 8) {
    const snapshot = buildCashBoxSnapshot(sourceCache, boxId);
    const bankMovements = snapshot.bankToErp.credits.concat(snapshot.bankToErp.debits);
    const internalTransfers = snapshot.erpToBank.payments.filter((row) => row.classification === "Transferencia interna");
    return {
      ...snapshot,
      bankToErp: {
        ...snapshot.bankToErp,
        credits: [],
        debits: [],
        movements: newestRows(bankMovements, "date", "id", limit),
        movementsLimited: bankMovements.length > limit
      },
      erpToBank: {
        ...snapshot.erpToBank,
        collections: newestRows(snapshot.erpToBank.collections, "date", "id", limit),
        collectionsLimited: snapshot.erpToBank.collections.length > limit,
        payments: newestRows(snapshot.erpToBank.payments, "date", "id", limit),
        paymentsLimited: snapshot.erpToBank.payments.length > limit,
        internalTransfers: newestRows(internalTransfers, "date", "id", limit),
        internalTransfersLimited: internalTransfers.length > limit
      }
    };
  }

  async function handleCashBoxesGet(request, response) {
    try {
      const url = new URL(request.url || "/api/treasury/cash-boxes", "http://127.0.0.1");
      const boxId = normalizeBoxId(url.searchParams.get("box"));
      if (!boxId) {
        const error = new Error("El parámetro box es obligatorio.");
        error.statusCode = 400;
        throw error;
      }
      if (url.searchParams.get("view") === "management") {
        const detailId = String(url.searchParams.get("detail") || "").trim();
        const cache = loadCache();
        return sendJson(response, 200, {
          ok: true,
          management: buildTreasuryManagementSnapshot(cache, boxId),
          ...(detailId ? { detail: buildTreasuryManagementDetail(cache, boxId, detailId) } : {})
        });
      }
      return sendJson(response, 200, {
        ok: true,
        snapshot: buildCashBoxSnapshot(loadCache(), boxId)
      });
    } catch (error) {
      return sendJson(response, error.statusCode || 500, {
        ok: false,
        error: `No se pudo calcular la caja: ${error.message}`
      });
    }
  }

  function cashPositionSummary(tables, warnings) {
    try {
      const ledger = cashLedgerSnapshot({ tables });
      return {
        available: true,
        balanceCents: ledger.balanceCents,
        openingCents: ledger.openingCents,
        cutoff: ledger.cutoff,
        source: "caja_efectivo_movimientos append-only"
      };
    } catch (error) {
      warnings.push(`Efectivo no disponible: ${error.message}`);
      return { available: false, balanceCents: null, source: "caja_efectivo_movimientos" };
    }
  }

  function cashPositionDetail(tables, warnings) {
    const summary = cashPositionSummary(tables, warnings);
    if (!summary.available) return { summary, movements: [] };
    return { summary, movements: cashLedgerSnapshot({ tables }).movements };
  }

  function receivedChecksSummary(rows, warnings) {
    const available = availableReceivedChecks(rows, warnings);
    return {
      availableCount: available.length,
      availableTotalCents: sumSafeCents(available.map((row) => row.amountCents))
    };
  }

  function receivedChecksDetail(rows, warnings) {
    const checks = chronologicalPendingChecks(availableReceivedChecks(rows, warnings));
    return {
      summary: {
        availableCount: checks.length,
        availableTotalCents: sumSafeCents(checks.map((row) => row.amountCents)),
        next: checks.find((row) => row.date) || null
      },
      checks
    };
  }

  function availableReceivedChecks(rows, warnings) {
    return (rows || []).reduce((result, row) => {
      if (backendNormalizeText(row?.estado) !== "pendiente"
        || backendId(row?.id_deposito)
        || backendId(row?.id_pago_endoso)
        || String(row?.fecha_deposito || "").trim()
        || String(row?.fecha_endoso || "").trim()) return result;
      const check = checkPresentation(row, "id_cheque_recibido", warnings);
      if (check) result.push({
        ...check,
        date: backendIsoDate(row.fecha_uso) || backendIsoDate(row.fecha_entregado),
        counterparty: String(row.cliente || "").trim()
      });
      return result;
    }, []);
  }

  function issuedChecksSummary(rows, warnings) {
    const pending = pendingIssuedChecks(rows, warnings);
    return {
      pendingCount: pending.length,
      pendingTotalCents: sumSafeCents(pending.map((row) => row.amountCents))
    };
  }

  function issuedChecksDetail(issuedRows, warnings) {
    const checks = chronologicalPendingChecks(pendingIssuedChecks(issuedRows, warnings));
    return {
      summary: {
        pendingCount: checks.length,
        pendingTotalCents: sumSafeCents(checks.map((row) => row.amountCents)),
        next: checks.find((row) => row.date) || null
      },
      checks
    };
  }

  function pendingIssuedChecks(rows, warnings) {
    return (rows || []).reduce((result, row) => {
      if (backendNormalizeText(row?.estado) !== "pendiente") return result;
      const check = checkPresentation(row, "id_cheque_entregado", warnings);
      if (check) result.push({
        ...check,
        date: backendIsoDate(row.fecha_uso) || backendIsoDate(row.fecha_entregado),
        instrument: "Cheque/eCheq propio",
        paymentId: backendId(row.id_pago)
      });
      return result;
    }, []);
  }

  function chronologicalPendingChecks(rows) {
    return [...(rows || [])].sort((left, right) => (
      String(left.date || "9999-12-31").localeCompare(String(right.date || "9999-12-31"))
      || Number(left.id || 0) - Number(right.id || 0)
    ));
  }

  function checkPresentation(row, idColumn, warnings) {
    const id = backendId(row?.[idColumn]);
    try {
      return {
        id,
        number: String(row?.nro_cheque || "").trim(),
        bank: String(row?.banco || "").trim(),
        status: String(row?.estado || "Sin estado").trim(),
        amountCents: Math.abs(toCents(row?.monto, { allowEmpty: false }))
      };
    } catch (_error) {
      warnings.push(`Cheque ${id || "sin ID"} excluido por importe inválido.`);
      return null;
    }
  }

  function investmentFundSummary(rows, warnings) {
    try {
      const ledger = investmentFundLedger(rows || []);
      return {
        available: true,
        balanceCents: ledger.balanceCents,
        subscriptionCount: countByState(rows, /^deposito$/, "tipo"),
        redemptionCount: countByState(rows, /^rescate$/, "tipo"),
        yieldCount: countByState(rows, /^rendimiento$/, "tipo")
      };
    } catch (_error) {
      warnings.push("Fondo no disponible: el libro mayor contiene un importe inválido y no se calculó un saldo parcial.");
      return { available: false, balanceCents: null, subscriptionCount: 0, redemptionCount: 0, yieldCount: 0 };
    }
  }

  function investmentFundDetail(rows, warnings) {
    const summary = investmentFundSummary(rows, warnings);
    if (!summary.available) return { summary, movements: [] };
    const ledger = investmentFundLedger(rows || []);
    const movements = newestRows(ledger.rows.map((entry) => ({
      id: backendId(entry.row.id_movimiento_fondo),
      date: backendIsoDate(entry.row.fecha),
      type: String(entry.row.tipo || "").trim(),
      amountCents: Math.abs(toCents(entry.row.importe || 0)),
      balanceCents: entry.balanceCents,
      reference: String(entry.row.referencia || entry.row.observacion || "").trim()
    })), "date", "id");
    return { summary, movements };
  }

  function otherFinancialMovementsDetail(tables, warnings) {
    const contributions = newestRows((tables.aportes_socios?.rows || []).reduce((result, row) => {
      const id = backendId(row.id_aporte_socio);
      const date = backendIsoDate(row.fecha);
      if (!date) return result;
      try {
        result.push({
          id,
          date,
          type: String(row.tipo || "Aporte/retiro").trim(),
          counterparty: String(row.nombre || "Socio sin identificar").trim(),
          amountCents: toCents(row.monto, { allowEmpty: false }),
          expenseId: backendId(row.id_egreso)
        });
      } catch (_error) {
        warnings.push(`Movimiento de socio ${id || "sin ID"} excluido por importe inválido.`);
      }
      return result;
    }, []), "date", "id");
    const transfers = buildPaymentEntries(
      financialRowsFromDate(tables.pagos?.rows, {
        dateColumn: "fecha_pago",
        idColumn: "id_pago",
        label: "pago",
        amountColumn: "monto"
      }, CASH_BOX_DEFINITIONS.icbc, warnings),
      tables,
      [],
      CASH_BOX_DEFINITIONS.icbc,
      warnings,
      null
    ).filter((row) => row.classification === "Transferencia interna")
      .map((row) => ({ id: row.id, date: row.date, amountCents: row.amountCents }));
    return { contributions, internalTransfers: newestRows(transfers, "date", "id") };
  }

  function financialOperationSummary(rows, idColumn, dateColumn, warnings, label) {
    let totalCents = 0;
    let latestDate = "";
    let validCount = 0;
    (rows || []).forEach((row) => {
      const date = backendIsoDate(row?.[dateColumn]);
      if (date > latestDate) latestDate = date;
      try {
        totalCents = sumSafeCents([totalCents, Math.abs(toCents(row?.monto, { allowEmpty: false }))]);
        validCount += 1;
      } catch (_error) {
        warnings.push(`${capitalize(label)} ${backendId(row?.[idColumn]) || "sin ID"} excluido del resumen por importe inválido.`);
      }
    });
    return { count: validCount, totalCents, latestDate };
  }

  function latestReconciliationDate(rows, bank) {
    return (rows || []).reduce((latest, row) => {
      if (!isMovementForBank(row, bank)) return latest;
      if (!backendId(row.id_pago) && !backendId(row.id_cobro) && !backendId(row.id_movimiento_fondo)) return latest;
      const date = backendIsoDate(row.fecha);
      return date > latest ? date : latest;
    }, "");
  }

  function countByState(rows, pattern, column = "estado") {
    return (rows || []).filter((row) => pattern.test(backendNormalizeText(row?.[column]))).length;
  }

  function newestRows(rows, dateColumn, idColumn, limit = 8) {
    return [...(rows || [])].sort((left, right) => (
      String(right?.[dateColumn] || "").localeCompare(String(left?.[dateColumn] || ""))
      || Number(right?.[idColumn] || 0) - Number(left?.[idColumn] || 0)
    )).slice(0, limit);
  }

  function financialRowsFromDate(rows, config, definition, warnings, cutoffDate = null) {
    return (rows || []).reduce((result, row) => {
      const id = backendId(row?.[config.idColumn]);
      const date = backendIsoDate(row?.[config.dateColumn]);
      if (!date) {
        warnings.push(`${capitalize(config.label)} ${id || "sin ID"} excluido: fecha canónica inválida.`);
        return result;
      }
      if (date < definition.initialDate) return result;
      if (cutoffDate && date > cutoffDate) return result;

      try {
        result.push({
          row,
          id,
          date,
          amountCents: toCents(row?.[config.amountColumn], { allowEmpty: false })
        });
      } catch (_error) {
        warnings.push(`${capitalize(config.label)} ${id || "sin ID"} excluido: importe canónico inválido.`);
      }
      return result;
    }, []);
  }

  function latestObservedBankMovement(bankRows, definition, warnings) {
    const datedRows = bankRows.reduce((result, item) => {
      const date = backendIsoDate(item.row.fecha);
      if (!date) {
        warnings.push(
          `Movimiento bancario ${backendId(item.row.id_movimiento_bancario) || "sin ID"} excluido del último saldo: fecha inválida.`
        );
        return result;
      }
      result.push({
        ...item,
        date,
        sourceOrder: stableBankSourceOrder(item.row)
      });
      return result;
    }, []);

    const latestDate = datedRows.reduce(
      (result, item) => item.date > result ? item.date : result,
      ""
    );
    const latest = datedRows
      .filter((item) => item.date === latestDate)
      .sort((left, right) => left.sourceOrder - right.sourceOrder)[0];
    if (!latest) return null;

    let balanceCents = null;
    try {
      balanceCents = toCents(latest.row.saldo, { allowEmpty: false });
    } catch (_error) {
      warnings.push(
        `El último movimiento ${backendId(latest.row.id_movimiento_bancario) || "sin ID"} de ${definition.bank} no tiene saldo válido.`
      );
    }

    return {
      id: backendId(latest.row.id_movimiento_bancario),
      date: latest.date,
      balanceCents
    };
  }

  function stableBankSourceOrder(row) {
    const explicit = Number(row?._bankSourceOrder);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const persisted = Number(row?._rowNumber);
    if (Number.isFinite(persisted) && persisted > 0) return persisted;
    const id = Number(row?.id_movimiento_bancario);
    return Number.isFinite(id) ? id : Number.MAX_SAFE_INTEGER;
  }

  function buildPaymentEntries(headers, tables, bankRows, definition, warnings, cutoffDate) {
    const issuedChecksByPayment = backendGroupRowsById(
      tables.cheques_entregados?.rows || [],
      "id_pago"
    );
    const bankRowsByPayment = backendGroupRowsById(
      bankRows.map(({ row }) => row),
      "id_pago"
    );
    return headers.filter((item) => {
      const impact = instrumentImpact(item.row.metodo, item.row.banco, definition);
      if (impact.status !== "declared_icbc") return false;
      if (!/cheq/.test(backendNormalizeText(item.row.metodo))) return true;

      const bankEvidence = (bankRowsByPayment.get(item.id) || []).some((row) => {
        const date = backendIsoDate(row.fecha);
        return date
          && date >= definition.initialDate
          && (!cutoffDate || date <= cutoffDate)
          && Math.abs(toCents(row.debito || 0)) > 0;
      });
      const issuedCheckEvidence = (issuedChecksByPayment.get(item.id) || []).some((row) => (
        isMovementForBank(row, definition.bank)
        && /debit/.test(backendNormalizeText(row.estado))
      ));
      const explicitDebitRow = /debit/.test(backendNormalizeText(item.row.metodo));
      if (bankEvidence || issuedCheckEvidence || explicitDebitRow) return true;

      warnings.push(
        `Pago ${item.id || "sin ID"} excluido: el cheque emitido todavía no tiene débito ICBC efectivo.`
      );
      return false;
    }).map((item) => ({
      ...item,
      classification: paymentFinancialClassification(item.id, tables)
    }));
  }

  function paymentFinancialClassification(paymentId, tables) {
    const expenseIds = new Set((tables.detalle_pagos?.rows || [])
      .filter((row) => backendId(row.id_pago) === backendId(paymentId))
      .map((row) => backendId(row.id_egreso))
      .filter(Boolean));
    const transfer = (tables.egresos?.rows || []).find((row) => (
      expenseIds.has(backendId(row.id_egreso))
      && String(row._financialClassification || "") === "transferencia_interna"
    ));
    return transfer ? "Transferencia interna" : "Pago";
  }

  function buildCollectionEntries(headers, tables, associations, definition, warnings, cutoffDate) {
    const checksByCollection = backendGroupRowsById(
      tables.cheques_recibidos?.rows || [],
      "id_cobro"
    );
    const directCollections = headers.reduce((result, item) => {
      const checks = checksByCollection.get(item.id) || [];
      const methodIsCheck = /cheq/.test(backendNormalizeText(item.row.metodo));
      const impact = instrumentImpact(item.row.metodo, item.row.banco, definition);
      if (impact.status === "cash" || impact.status === "non_bank") return result;
      const declaredForBox = isMovementForBank(item.row, definition.bank);
      const associatedForBox = (associations.collectionsForBox.get(item.id) || []).length > 0;
      if (!declaredForBox && !associatedForBox) return result;

      const checkCents = sumCheckCents(checks, item.id, warnings);
      if (methodIsCheck && !checks.length) return result;
      const directAmountCents = item.amountCents - checkCents;
      if (directAmountCents < 0) {
        warnings.push(`Cobro ${item.id || "sin ID"} excluido: los cheques asociados superan el importe del encabezado.`);
        return result;
      }
      if (directAmountCents > 0) result.push({ ...item, amountCents: directAmountCents });
      return result;
    }, []);

    return directCollections.concat(buildDepositedCheckEntries(
      tables.cheques_recibidos?.rows || [],
      definition,
      warnings,
      cutoffDate
    ));
  }

  function sumCheckCents(checks, collectionId, warnings) {
    const seen = new Set();
    return sumSafeCents((checks || []).reduce((result, check) => {
      const checkId = backendId(check.id_cheque_recibido);
      if (checkId && seen.has(checkId)) {
        warnings.push(`Cheque ${checkId} duplicado en el cobro ${collectionId || "sin ID"}; se computó una sola vez.`);
        return result;
      }
      if (checkId) seen.add(checkId);
      try {
        result.push(Math.abs(toCents(check.monto, { allowEmpty: false })));
      } catch (_error) {
        warnings.push(`Cheque ${checkId || "sin ID"} excluido: importe canónico inválido.`);
      }
      return result;
    }, []));
  }

  function buildDepositedCheckEntries(checks, definition, warnings, cutoffDate = null) {
    const deposits = new Map();
    const seenChecks = new Set();
    (checks || []).forEach((check) => {
      const checkId = backendId(check.id_cheque_recibido);
      const depositId = backendId(check.id_deposito);
      const date = backendIsoDate(check.fecha_deposito);
      const isDeposited = /deposit|acredit/.test(backendNormalizeText(check.estado));
      if (!depositId || !date || !isDeposited || !isMovementForBank(check, definition.bank)) return;
      if (date < definition.initialDate) return;
      if (cutoffDate && date > cutoffDate) return;
      if (checkId && seenChecks.has(checkId)) {
        warnings.push(`Cheque depositado ${checkId} duplicado; se computó una sola vez.`);
        return;
      }
      if (checkId) seenChecks.add(checkId);

      let amountCents;
      try {
        amountCents = Math.abs(toCents(check.monto, { allowEmpty: false }));
      } catch (_error) {
        warnings.push(`Cheque depositado ${checkId || "sin ID"} excluido: importe canónico inválido.`);
        return;
      }
      const key = `${depositId}|${date}|${definition.bank}`;
      const current = deposits.get(key) || {
        row: {
          id_cliente: check.id_cliente,
          metodo: "Depósito de cheque/eCheq",
          banco: definition.bank
        },
        id: depositId,
        date,
        amountCents: 0,
        collectionIds: []
      };
      current.amountCents = sumSafeCents([current.amountCents, amountCents]);
      const collectionId = backendId(check.id_cobro);
      if (collectionId && !current.collectionIds.includes(collectionId)) {
        current.collectionIds.push(collectionId);
      }
      deposits.set(key, current);
    });
    return Array.from(deposits.values());
  }

  function buildBankAssociationIndexes(rows, definition) {
    const result = {
      collectionsForBox: new Map(),
      paymentsForBox: new Map(),
      collectionsOtherBanks: new Map(),
      paymentsOtherBanks: new Map()
    };

    (rows || []).forEach((row) => {
      const forBox = isMovementForBank(row, definition.bank);
      const bankLabel = String(row.banco || "Banco sin identificar").trim();
      addAssociation(
        result,
        backendId(row.id_cobro),
        forBox ? "collectionsForBox" : "collectionsOtherBanks",
        row,
        bankLabel
      );
      addAssociation(
        result,
        backendId(row.id_pago),
        forBox ? "paymentsForBox" : "paymentsOtherBanks",
        row,
        bankLabel
      );
    });
    return result;
  }

  function addAssociation(indexes, id, indexName, row, bankLabel) {
    if (!id) return;
    if (!indexes[indexName].has(id)) indexes[indexName].set(id, []);
    indexes[indexName].get(id).push({
      id: backendId(row.id_movimiento_bancario),
      bank: bankLabel
    });
  }

  function buildPendingCollections(collections, tables, associations, definition) {
    const clientsById = backendRowsById(tables.clientes?.rows || [], "id_cliente");
    return collections
      .filter((item) => !item.canonicalBankLinked)
      .filter((item) => {
        const collectionIds = item.collectionIds?.length ? item.collectionIds : [item.id];
        return !collectionIds.some((id) => (associations.collectionsForBox.get(id) || []).length);
      })
      .map((item) => {
        const client = clientsById.get(backendId(item.row.id_cliente));
        return pendingFinancialRow({
          item,
          definition,
          type: "cobro",
          counterparty: client?.nombre_cliente || "Cliente sin identificar",
          reference: `Cobro #${item.id || "sin ID"}`,
          method: item.row.metodo,
          bank: item.row.banco,
          otherAssociations: associations.collectionsOtherBanks.get(item.id) || []
        });
      });
  }

  function buildPendingPayments(payments, tables, associations, definition) {
    const detailsByPayment = backendGroupRowsById(tables.detalle_pagos?.rows || [], "id_pago");
    const expensesById = backendRowsById(tables.egresos?.rows || [], "id_egreso");
    return payments
      .filter((item) => !(associations.paymentsForBox.get(item.id) || []).length)
      .filter((item) => {
        const status = instrumentImpact(item.row.metodo, item.row.banco, definition).status;
        return status !== "cash" && status !== "non_bank" && status !== "other_bank";
      })
      .map((item) => {
        const details = detailsByPayment.get(item.id) || [];
        const expenseIds = uniqueStrings(details.map((detail) => backendId(detail.id_egreso)).filter(Boolean));
        const counterparties = uniqueStrings(expenseIds.map((expenseId) => {
          const expense = expensesById.get(expenseId);
          return expense ? backendExpenseCounterpartyInfo(expense, tables).name : "";
        }).filter(Boolean));
        const referenceSuffix = expenseIds.length ? ` · Egresos ${expenseIds.map((id) => `#${id}`).join(", ")}` : "";
        return pendingFinancialRow({
          item,
          definition,
          type: "pago",
          counterparty: counterparties.join(" / ") || "Acreedor sin identificar",
          reference: `Pago #${item.id || "sin ID"}${referenceSuffix}`,
          method: item.row.metodo,
          bank: item.row.banco,
          classification: item.classification,
          otherAssociations: associations.paymentsOtherBanks.get(item.id) || []
        });
      });
  }

  function pendingFinancialRow({
    item,
    definition,
    type,
    counterparty,
    reference,
    method,
    bank,
    classification = "",
    otherAssociations
  }) {
    const impact = instrumentImpact(method, bank, definition);
    const associationReason = otherAssociations.length
      ? `Sin contrapartida ${definition.bank}; asociado a ${uniqueStrings(otherAssociations.map((row) => row.bank)).join(", ")}.`
      : `Sin movimiento bancario ${definition.bank} asociado.`;
    return {
      id: item.id,
      type,
      date: item.date,
      counterparty,
      reference,
      method: String(method || "Sin método").trim(),
      bank: String(bank || "").trim(),
      classification: classification || (type === "pago" ? "Pago" : "Cobro"),
      instrument: [method, bank].filter((value) => String(value || "").trim()).join(" · ") || "Sin instrumento",
      amountCents: item.amountCents,
      status: impact.status,
      reason: `${associationReason} ${impact.reason}`,
      otherBankMovementIds: otherAssociations.map((row) => row.id).filter(Boolean)
    };
  }

  function summarizeInstrumentScope(collections, payments, definition) {
    const categories = new Map();
    [...collections.map((item) => ({ ...item, type: "cobro" })),
      ...payments.map((item) => ({ ...item, type: "pago" }))]
      .forEach((item) => {
        const impact = instrumentImpact(item.row.metodo, item.row.banco, definition);
        const current = categories.get(impact.status) || {
          status: impact.status,
          label: impact.label,
          count: 0,
          netCents: 0
        };
        current.count += 1;
        current.netCents = sumSafeCents([
          current.netCents,
          item.type === "cobro" ? item.amountCents : -item.amountCents
        ]);
        categories.set(impact.status, current);
      });

    const items = Array.from(categories.values());
    const warnings = items
      .filter((item) => item.status !== "declared_icbc")
      .map((item) => (
        `${item.count} movimiento(s) ${item.label.toLowerCase()} se incluyen en la fórmula por el criterio inicial, aunque su impacto directo en ${definition.bank} requiere revisión.`
      ));
    return { categories: items, warnings };
  }

  function instrumentImpact(method, bank, definition) {
    const normalizedMethod = backendNormalizeText(method);
    const normalizedBank = backendNormalizeText(bank);
    const declaredForBox = normalizedBank && backendBankMatches(bank, definition.bank);

    if (/efectivo/.test(normalizedMethod)) {
      return {
        status: "cash",
        label: "Efectivo",
        reason: `El efectivo no identifica impacto directo en ${definition.bank}.`
      };
    }
    if (/endoso|compens/.test(normalizedMethod)) {
      return {
        status: "non_bank",
        label: "Instrumento no bancario",
        reason: `El método ${String(method).trim()} no implica por sí solo un movimiento en ${definition.bank}.`
      };
    }
    if (declaredForBox) {
      return {
        status: "declared_icbc",
        label: `${definition.bank} declarado`,
        reason: `El registro declara ${definition.bank}.`
      };
    }
    if (normalizedBank) {
      return {
        status: "other_bank",
        label: "Otro banco declarado",
        reason: `El registro declara ${String(bank).trim()}, no ${definition.bank}.`
      };
    }
    if (/cheq/.test(normalizedMethod)) {
      return {
        status: "check",
        label: "Cheque",
        reason: `El cheque impacta ${definition.bank} sólo al depositarse o debitarse.`
      };
    }
    return {
      status: "bank_unspecified",
      label: "Banco no informado",
      reason: `El registro no identifica qué cuenta bancaria impacta.`
    };
  }

  function buildBankToErpSummary(tables, bankRows, definition, cutoffDate) {
    const filteredTables = {
      ...tables,
      movimientos_bancarios: {
        ...(tables.movimientos_bancarios || {}),
        rows: bankRows
          .map((item) => item.row)
          .filter((row) => {
            const date = backendIsoDate(row.fecha);
            return date
              && date >= definition.initialDate
              && (!cutoffDate || date <= cutoffDate);
          })
      }
    };
    const pending = canonicalPendingBankMovements(filteredTables, definition.bank);
    const pendingRows = pending.map((movement) => pendingBankRow(movement));
    const credits = pendingRows.filter((movement) => movement.type === "credit");
    const debits = pendingRows.filter((movement) => movement.type === "debit");
    const classifications = new Map();
    pending.forEach((movement) => {
      const classification = classifyPendingBankMovement(movement);
      const current = classifications.get(classification) || {
        classification,
        count: 0,
        netCents: 0,
        grossCents: 0
      };
      const amountCents = toCents(movement.amount);
      current.count += 1;
      current.netCents = sumSafeCents([current.netCents, amountCents]);
      current.grossCents = sumSafeCents([current.grossCents, Math.abs(amountCents)]);
      classifications.set(classification, current);
    });

    const fundMovements = bankRows.filter(({ row }) => (
      backendId(row.id_movimiento_fondo)
      && !backendId(row.id_pago)
      && !backendId(row.id_cobro)
      && backendIsoDate(row.fecha) >= definition.initialDate
    ));
    const fundNetCents = sumSafeCents(fundMovements.map(({ row }) => bankMovementAmountCents(row)));
    const pendingNetCents = sumSafeCents(pendingRows.map((movement) => movement.signedAmountCents));
    const pendingGrossCents = sumSafeCents(pendingRows.map((movement) => movement.amountCents));
    const pendingSinceInitial = pending;
    const gapClassifications = new Map();
    pendingSinceInitial.forEach((movement) => {
      const classification = classifyPendingBankMovement(movement);
      const current = gapClassifications.get(classification) || {
        classification,
        count: 0,
        netCents: 0,
        grossCents: 0
      };
      const amountCents = toCents(movement.amount);
      current.count += 1;
      current.netCents = sumSafeCents([current.netCents, amountCents]);
      current.grossCents = sumSafeCents([current.grossCents, Math.abs(amountCents)]);
      gapClassifications.set(classification, current);
    });
    const gapFactors = Array.from(gapClassifications.values());
    if (fundMovements.length) {
      gapFactors.push({
        classification: "Fondo de inversión asociado",
        count: fundMovements.length,
        netCents: fundNetCents,
        grossCents: sumSafeCents(fundMovements.map(({ row }) => Math.abs(bankMovementAmountCents(row))))
      });
    }

    return {
      pendingCount: pending.length,
      pendingNetCents,
      pendingGrossCents,
      pendingCreditCount: credits.length,
      pendingCreditTotalCents: sumSafeCents(credits.map((movement) => movement.amountCents)),
      pendingDebitCount: debits.length,
      pendingDebitTotalCents: sumSafeCents(debits.map((movement) => movement.amountCents)),
      credits,
      debits,
      reconciliationPath: `/api/bank-reconciliation/state?bank=${encodeURIComponent(definition.bank)}`,
      classifications: Array.from(classifications.values()),
      gapFactors
    };
  }

  function pendingBankRow(movement) {
    const signedAmountCents = toCents(movement.amount);
    const type = signedAmountCents < 0 ? "debit" : "credit";
    const detail = [
      movement.concept || movement.bankConcept,
      movement.detail
    ].filter(Boolean).join(" · ") || "Sin detalle bancario";
    const missingLinks = type === "credit"
      ? "Sin id_cobro, depósito de cheque/eCheq ni id_movimiento_fondo canónico asociado."
      : "Sin id_pago ni id_movimiento_fondo canónico asociado.";
    return {
      id: movement.canonicalMovementId,
      date: movement.date,
      detail,
      reference: movement.movementKey || `Movimiento #${movement.canonicalMovementId || "sin ID"}`,
      type,
      amountCents: Math.abs(signedAmountCents),
      signedAmountCents,
      status: "unassociated",
      reason: missingLinks
    };
  }

  function classifyPendingBankMovement(movement) {
    const text = backendNormalizeText([
      movement.concept,
      movement.bankConcept,
      movement.detail,
      movement.channel
    ].filter(Boolean).join(" "));
    if (/fci|fondo|rescate|suscrip/.test(text)) return "Fondo de inversión sin vínculo";
    if (/cheq|cheque|camara/.test(text)) return "Cheque sin vínculo";
    if (/comision|gasto|impuesto|sellado|iva|retenc/.test(text)) return "Gasto bancario sin vínculo";
    if (/transfer/.test(text) && /interna|propia|mismo titular/.test(text)) {
      return "Transferencia interna sin vínculo";
    }
    return "Movimiento bancario sin clasificar";
  }

  function bankMovementAmountCents(row) {
    if (row.importe !== null && row.importe !== undefined && String(row.importe).trim() !== "") {
      return toCents(row.importe);
    }
    return sumSafeCents([toCents(row.credito), -toCents(row.debito)]);
  }

  function isMovementForBank(row, bank) {
    const value = String(row?.banco || "").trim();
    return Boolean(value) && backendBankMatches(value, bank);
  }

  function normalizeBoxId(value) {
    return String(value || "").trim().toLowerCase();
  }

  return {
    buildCashBoxSnapshot,
    buildTreasuryManagementDetail,
    buildTreasuryManagementSnapshot,
    handleCashBoxesGet
  };
}

function sumSafeCents(values) {
  const total = (values || []).reduce((sum, value) => sum + BigInt(value), 0n);
  const number = Number(total);
  if (!Number.isSafeInteger(number) || BigInt(number) !== total) {
    throw new RangeError("El total monetario excede el rango seguro.");
  }
  return number;
}

function uniqueStrings(values) {
  return Array.from(new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean)));
}

function capitalize(value) {
  const text = String(value || "");
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "";
}

module.exports = { CASH_BOX_DEFINITIONS, createCashBoxesService };
