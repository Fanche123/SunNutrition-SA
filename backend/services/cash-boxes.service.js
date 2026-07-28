const { toCents } = require("../../shared/money");

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
    const collections = financialRowsFromDate(
      tables.cobros?.rows,
      {
        dateColumn: "fecha_cobro",
        idColumn: "id_cobro",
        label: "cobro",
        amountColumn: "monto"
      },
      definition,
      warnings
    );
    const payments = financialRowsFromDate(
      tables.pagos?.rows,
      {
        dateColumn: "fecha_pago",
        idColumn: "id_pago",
        label: "pago",
        amountColumn: "monto"
      },
      definition,
      warnings
    );

    const bankRows = (tables.movimientos_bancarios?.rows || [])
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => isMovementForBank(row, definition.bank));
    const latestBankMovement = latestObservedBankMovement(bankRows, definition, warnings);
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

    const bankAssociations = buildBankAssociationIndexes(
      tables.movimientos_bancarios?.rows || [],
      definition
    );
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
    const bankToErp = buildBankToErpSummary(tables, bankRows, definition);
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
        collectionSource: "cobros.monto",
        paymentSource: "pagos.monto",
        includedStates: "Todas las filas persistidas; cobros y pagos no tienen columna canónica de estado.",
        formula: "saldo inicial + cobros - pagos",
        differenceConvention: "saldo bancario final - saldo calculado del ERP",
        latestBankBalanceSource: "movimientos_bancarios.saldo",
        latestBankOrder: "fecha, marca de importación y orden persistido"
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
            ? "reconciled"
            : "difference"
      },
      erpToBank: {
        pendingCollectionCount: pendingCollections.length,
        pendingCollectionTotalCents: sumSafeCents(pendingCollections.map((item) => item.amountCents)),
        pendingPaymentCount: pendingPayments.length,
        pendingPaymentTotalCents: sumSafeCents(pendingPayments.map((item) => item.amountCents)),
        collections: pendingCollections,
        payments: pendingPayments
      },
      bankToErp,
      instrumentScope,
      warnings: uniqueStrings(warnings)
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

  function financialRowsFromDate(rows, config, definition, warnings) {
    return (rows || []).reduce((result, row) => {
      const id = backendId(row?.[config.idColumn]);
      const date = backendIsoDate(row?.[config.dateColumn]);
      if (!date) {
        warnings.push(`${capitalize(config.label)} ${id || "sin ID"} excluido: fecha canónica inválida.`);
        return result;
      }
      if (date < definition.initialDate) return result;

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
        importedAt: String(item.row._bankImportedAt || "")
      });
      return result;
    }, []);

    datedRows.sort((left, right) => (
      left.date.localeCompare(right.date)
      || left.importedAt.localeCompare(right.importedAt)
      || left.index - right.index
    ));
    const latest = datedRows.at(-1);
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
      .filter((item) => !(associations.collectionsForBox.get(item.id) || []).length)
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

  function buildBankToErpSummary(tables, bankRows, definition) {
    const filteredTables = {
      ...tables,
      movimientos_bancarios: {
        ...(tables.movimientos_bancarios || {}),
        rows: bankRows.map((item) => item.row)
      }
    };
    const pending = canonicalPendingBankMovements(filteredTables, definition.bank);
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
    const pendingNetCents = sumSafeCents(pending.map((movement) => toCents(movement.amount)));
    const pendingGrossCents = sumSafeCents(pending.map((movement) => Math.abs(toCents(movement.amount))));
    const pendingSinceInitial = pending.filter((movement) => (
      movement.date && movement.date >= definition.initialDate
    ));
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
      reconciliationPath: `/api/bank-reconciliation/state?bank=${encodeURIComponent(definition.bank)}`,
      classifications: Array.from(classifications.values()),
      gapFactors
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

  return { buildCashBoxSnapshot, handleCashBoxesGet };
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
