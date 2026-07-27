const { fromCents, normalize: normalizeMoney, toCents } = require("../../shared/money");

function createBankParserService(dependencies) {
  const { backendIsoDate, backendNormalizeText, backendNumber, bankManualCheckDepositMatch, bankMovementBackendCreditorId, bankSourceDestinationForOriginType, bestBankMatch, bestBankSourceMatch, compactBankText, consumePersistedBankMovement, exactPendingExpenseMatch, extractBankCheckNumber, extractBankCuit, identifyBankCounterparty, normalizeBankCheckNumber, normalizeBankCuit, uniqueExactBankMatch } = dependencies;

  function parseBankMovements(csvText) {
    const rows = parseFlexibleDelimitedRows(csvText);
    if (!rows.length) return [];
    const headerIndex = rows.findIndex((row) => bankHeaderScore(row) >= 3);
    if (headerIndex < 0) {
      const error = new Error("El CSV no contiene encabezados bancarios reconocibles.");
      error.statusCode = 400;
      throw error;
    }
  
    const headers = rows[headerIndex].map((header) => backendNormalizeText(header));
    const indexFor = (...names) => {
      const exact = headers.findIndex((header) => names.some((name) => header === name));
      if (exact >= 0) return exact;
      return headers.findIndex((header) => names.some((name) => header.includes(name)));
    };
    const dateIndex = indexFor("fecha_contable", "fecha_banco", "fecha");
    const codeIndex = indexFor("cod_de_concepto", "codigo_concepto", "cod_concepto");
    const conceptIndex = indexFor("concepto", "detalle_banco", "descripcion", "informacion_complementaria");
    const debitIndex = indexFor("debito_en", "debitos", "debito");
    const creditIndex = indexFor("credito_en", "creditos", "credito");
    const amountIndex = indexFor("movimiento_banco", "importe", "monto");
    const balanceIndex = indexFor("saldo_en", "saldo_banco", "saldo");
    const extraDetailIndex = indexFor("informacion_complementaria", "informacion", "referencia");
    const nameIndex = indexFor("nombre", "razon_social");
    const cbuIndex = indexFor("cbu_alias", "cbu", "alias");
    const channelIndex = indexFor("canal");
    const docTypeIndex = indexFor("tipo_doc", "tipo_documento");
    const docNumberIndex = indexFor("nro_doc", "numero_doc", "documento", "cuit", "cuil");
    const checkIndex = indexFor("nro_de_cheque", "nro_cheque", "numero_cheque", "cheque");
  
    if (dateIndex < 0 || [debitIndex, creditIndex, amountIndex].every((index) => index < 0)) {
      throw bankCsvError("El CSV no contiene las columnas bancarias obligatorias de fecha e importe.");
    }

    return rows.slice(headerIndex + 1)
      .map((cells, index) => {
        const rowNumber = headerIndex + index + 2;
        const debitCents = debitIndex >= 0 ? Math.abs(toCents(backendNumber(cells[debitIndex]))) : 0;
        const creditCents = creditIndex >= 0 ? Math.abs(toCents(backendNumber(cells[creditIndex]))) : 0;
        const directAmountCents = amountIndex >= 0 ? toCents(backendNumber(cells[amountIndex])) : 0;
        const amountCents = creditCents || debitCents ? creditCents - debitCents : directAmountCents;
        const amount = fromCents(amountCents);
        const date = backendIsoDate(cells[dateIndex]);
        const bankConcept = compactBankText(cells[conceptIndex] || "");
        const detail = compactBankText([bankConcept, cells[extraDetailIndex]].filter(Boolean).join(" · "));
        const counterpartyName = compactBankText(cells[nameIndex] || "");
        const cuit = normalizeBankCuit(cells[docNumberIndex] || extractBankCuit(cells.join(" ")));
        const cbuAlias = compactBankText(cells[cbuIndex] || "");
        const concept = compactBankText([detail, counterpartyName, cuit || cbuAlias].filter(Boolean).join(" · "));
        const checkNumber = normalizeBankCheckNumber(checkIndex >= 0 ? cells[checkIndex] : "") || extractBankCheckNumber(cells.join(" "));
        if (!isValidBankCalendarDate(date)) {
          throw bankCsvError(`La fila ${rowNumber} contiene una fecha bancaria invalida.`);
        }
        if (amountCents === 0) {
          throw bankCsvError(`La fila ${rowNumber} no contiene un importe bancario valido.`);
        }
        return {
          rowNumber,
          date,
          code: codeIndex >= 0 ? compactBankText(cells[codeIndex] || "") : "",
          concept,
          bankConcept,
          detail,
          counterpartyName,
          cuit,
          checkNumber,
          cbuAlias,
          docType: docTypeIndex >= 0 ? cells[docTypeIndex] || "" : "",
          amount,
          debit: amountCents < 0 ? fromCents(Math.abs(amountCents)) : 0,
          credit: amountCents > 0 ? amount : 0,
          balance: balanceIndex >= 0 ? normalizeMoney(backendNumber(cells[balanceIndex])) : 0,
          channel: channelIndex >= 0 ? cells[channelIndex] || "" : "",
          raw: cells
        };
      });
  }
  
  function parseFlexibleDelimitedRows(text) {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
    const delimiters = [";", ",", "\t"];
    const delimiter = delimiters
      .map((candidate) => {
        const sampleRows = lines.slice(0, 10).map((line) => splitDelimitedLine(line, candidate));
        const headerScore = Math.max(...sampleRows.map((row) => bankHeaderScore(row)));
        const columnScore = Math.max(...sampleRows.map((row) => row.length));
        return { candidate, score: (headerScore * 100) + columnScore };
      })
      .sort((left, right) => right.score - left.score)[0]?.candidate || ";";
    return lines.map((line) => splitDelimitedLine(line, delimiter));
  }
  
  function splitDelimitedLine(line, delimiter) {
    const cells = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === "\"") {
        if (quoted && line[index + 1] === "\"") {
          cell += "\"";
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (char === delimiter && !quoted) {
        cells.push(cell.trim());
        cell = "";
      } else {
        cell += char;
      }
    }
    if (quoted) {
      throw bankCsvError("El CSV contiene una fila con comillas sin cerrar.");
    }
    cells.push(cell.trim());
    return cells;
  }
  
  function bankHeaderScore(row) {
    const normalized = row.map((cell) => backendNormalizeText(cell)).join("|");
    return ["fecha", "concepto", "debito", "credito", "saldo", "importe", "movimiento"].reduce(
      (score, token) => score + (normalized.includes(token) ? 1 : 0),
      0
    );
  }
  
  function analyzeBankMovement(
    movement,
    paymentCandidates,
    collectionCandidates,
    payableCandidates,
    creditPayableCandidates,
    sourceCandidates,
    persistedMovementCounts,
    identityIndex,
    receivedChecksByNumber = new Map(),
    issuedChecksByNumber = new Map(),
    receivedCheckDepositGroups = [],
    bank = ""
  ) {
    const identified = identifyBankCounterparty(movement, identityIndex);
    const identifiedName = compactBankText(identified?.name || "");
    const checkKey = normalizeBankCheckNumber(movement.checkNumber);
    const checkMatch = checkKey
      ? (toCents(movement.amount) < 0 ? issuedChecksByNumber.get(checkKey) : receivedChecksByNumber.get(checkKey)) || null
      : null;
    const enrichedMovement = {
      ...movement,
      provider: identified ? identifiedName : "",
      tag: identified?.tagLabel || identified?.expenseType || "",
      tagOptions: identified?.tagOptions || [],
      idEtiqueta: identified?.idEtiqueta || "",
      providerMatch: identified || null,
      checkMatch,
      sourceDestination: identified?.sourceDestination || bankSourceDestinationForOriginType(identified?.originType),
      suggestedExpenseType: identified?.expenseType || "",
      suggestedCounterparty: identified ? null : {
        name: movement.counterpartyName || "",
        cuit: movement.cuit || "",
        cbuAlias: movement.cbuAlias || "",
        detail: movement.detail || ""
      }
    };
    const persistedMatch = consumePersistedBankMovement(enrichedMovement, bank, persistedMovementCounts);
    if (persistedMatch) {
      return {
        ...enrichedMovement,
        status: "conciliado",
        action: "Movimiento ya conciliado",
        match: persistedMatch
      };
    }
  
    const manualDepositMatch = bankManualCheckDepositMatch(enrichedMovement, receivedCheckDepositGroups);
    if (manualDepositMatch) {
      return {
        ...enrichedMovement,
        status: "listo",
        action: "Deposito de cheques listo para conciliar",
        checkMatch: {
          type: "cheque_recibido",
          ids: manualDepositMatch.checkIds,
          idCobro: manualDepositMatch.collectionIds[0] || ""
        },
        match: { type: "deposito_cheques", id: manualDepositMatch.id }
      };
    }
  
    if (toCents(movement.amount) < 0) {
      const paymentMatch = bestBankMatch(enrichedMovement, paymentCandidates.filter((candidate) => candidate.direction !== "credito"), absoluteMoney(movement.amount), {
        requireExactDate: true,
        requireIdentity: true
      }) || uniqueExactBankMatch(enrichedMovement, paymentCandidates.filter((candidate) => candidate.direction !== "credito"), absoluteMoney(movement.amount));
      if (paymentMatch) {
        return {
          ...enrichedMovement,
          status: "listo",
          action: "Lista para conciliar",
          match: paymentMatch
        };
      }
  
      if (
        checkMatch?.idPago
        && Math.abs(toCents(backendNumber(checkMatch.amount)) - Math.abs(toCents(movement.amount))) <= 500
      ) {
        return {
          ...enrichedMovement,
          status: "listo",
          action: "Cheque listo para conciliar",
          match: { type: "pago", id: checkMatch.idPago }
        };
      }
  
      const planPaymentMatch = /^PAGO\s+AFIP\b/i.test(String(enrichedMovement.detail || ""))
        ? bestBankMatch(
          enrichedMovement,
          payableCandidates.filter((candidate) => candidate.planPayment),
          absoluteMoney(movement.amount),
          { requireExactDate: true, requireIdentity: false, maxDateDifference: 1 }
        )
        : null;
      if (planPaymentMatch) {
        return {
          ...enrichedMovement,
          status: "agregar_pago",
          action: "Agregar pago",
          match: planPaymentMatch
        };
      }
  
      const payableMatch = bestBankMatch(enrichedMovement, payableCandidates, absoluteMoney(movement.amount), {
        requireExactDate: false,
        requireIdentity: true,
        maxDateDifference: 365
      }) || exactPendingExpenseMatch(enrichedMovement, payableCandidates, absoluteMoney(movement.amount));
      if (payableMatch) {
        return {
          ...enrichedMovement,
          status: "agregar_pago",
          action: "Agregar pago",
          match: payableMatch
        };
      }
  
      const sourceMatch = bestBankSourceMatch(enrichedMovement, sourceCandidates);
      if (sourceMatch) {
        return {
          ...enrichedMovement,
          status: "agregar_egreso",
          action: "Agregar egreso",
          sourceMatch,
          match: null
        };
      }
  
      const hasExpenseIdentity = Boolean(bankMovementBackendCreditorId(enrichedMovement) && enrichedMovement.idEtiqueta);
      return {
        ...enrichedMovement,
        status: hasExpenseIdentity ? "agregar_gasto" : "revisar",
        action: hasExpenseIdentity ? "Agregar gasto" : "Revisar acreedor o etiqueta",
        match: null
      };
    }
  
    const collectionMatch = bestBankMatch(enrichedMovement, collectionCandidates, movement.amount, {
      requireExactDate: true,
      requireIdentity: Boolean(enrichedMovement.cuit || enrichedMovement.counterpartyName)
    });
    if (collectionMatch) {
      return {
        ...enrichedMovement,
        status: "listo",
        action: "Lista para conciliar",
        match: collectionMatch
      };
    }
    const creditPaymentMatch = bestBankMatch(
      enrichedMovement,
      paymentCandidates.filter((candidate) => candidate.direction === "credito"),
      movement.amount,
      { requireExactDate: true, requireIdentity: false }
    ) || uniqueExactBankMatch(
      enrichedMovement,
      paymentCandidates.filter((candidate) => candidate.direction === "credito"),
      movement.amount
    );
    if (creditPaymentMatch) {
      return {
        ...enrichedMovement,
        status: "listo",
        action: "Lista para conciliar",
        match: creditPaymentMatch
      };
    }
    if (
      checkMatch?.idCobro
      && Math.abs(toCents(backendNumber(checkMatch.amount)) - toCents(movement.amount)) <= 500
    ) {
      return {
        ...enrichedMovement,
        status: "listo",
        action: "Cheque listo para conciliar",
        match: { type: "cobro", id: checkMatch.idCobro }
      };
    }
    const creditPayableMatch = bestBankMatch(enrichedMovement, creditPayableCandidates, movement.amount, {
      requireExactDate: true,
      requireIdentity: false
    }) || uniqueExactBankMatch(enrichedMovement, creditPayableCandidates, movement.amount);
    if (creditPayableMatch) {
      return {
        ...enrichedMovement,
        status: "agregar_pago",
        action: "Agregar pago",
        match: creditPayableMatch
      };
    }
    if (identified?.type === "datos_bancarios") {
      return {
        ...enrichedMovement,
        status: "listo",
        action: "Lista para conciliar",
        match: { type: "dato_bancario", id: identified.id }
      };
    }
    return {
      ...enrichedMovement,
      status: "revisar",
      action: "Ingreso a revisar",
      match: null
    };
  }

  return { analyzeBankMovement, parseBankMovements };
}

function bankCsvError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function isValidBankCalendarDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function absoluteMoney(value) {
  return fromCents(Math.abs(toCents(value)));
}

module.exports = { createBankParserService };
