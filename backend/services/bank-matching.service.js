const { fromCents, normalize: normalizeMoney, toCents } = require("../../shared/money");

function createBankMatchingService(dependencies) {
  const { backendBankMatches, backendCreditorDisplayName, backendCreditorTagNames, backendCreditorTagRelationId, backendExpenseCounterpartyInfo, backendGroupRowsById, backendId, backendIsoDate, backendNormalizeText, backendNumber, backendRowsById, backendTagIdForName, backendTagNameForId, backendTagNameMap, bankDateDistance, bankMovementBackendCreditorId, bankSourceDestinationForOriginType, bankTextOverlapScore, cleanBackendText, compactBankText, normalizeBankCheckNumber, normalizeBankCuit } = dependencies;

  function bankMovementKeyFromOperation(row, stage) {
    const operationKey = String(row?._bankOperationKey ?? "").trim();
    const prefix = `${stage}:`;
    if (!operationKey.startsWith(prefix)) return "";
    const fingerprintEnd = operationKey.indexOf(":", prefix.length);
    return fingerprintEnd >= 0 ? operationKey.slice(fingerprintEnd + 1) : "";
  }

  function backendReceivedChecksByNumber(tables) {
    const checksByNumber = new Map();
    (tables.cheques_recibidos?.rows || []).forEach((check) => {
      const checkKey = normalizeBankCheckNumber(check.nro_cheque);
      if (!checkKey || checksByNumber.has(checkKey)) return;
      checksByNumber.set(checkKey, {
        type: "cheque_recibido",
        id: backendId(check.id_cheque_recibido),
        idCobro: backendId(check.id_cobro),
        number: check.nro_cheque,
        amount: normalizeMoney(backendNumber(check.monto)),
        date: backendIsoDate(check.fecha_uso) || backendIsoDate(check.fecha_entregado),
        client: check.cliente || "",
        status: check.estado || ""
      });
    });
    return checksByNumber;
  }
  
  function backendReceivedCheckDepositGroups(tables, bank) {
    const groups = new Map();
    (tables.cheques_recibidos?.rows || []).forEach((check) => {
      if (!backendNormalizeText(check.estado).includes("deposit")) return;
      const depositId = cleanBackendText(check.id_deposito);
      if (!depositId) return;
      const checkBank = cleanBackendText(check.banco);
      if (checkBank && bank && backendNormalizeText(checkBank) !== backendNormalizeText(bank)) return;
      const group = groups.get(depositId) || {
        id: depositId,
        amountCents: 0,
        checkIds: [],
        collectionIds: []
      };
      group.amountCents += Math.abs(toCents(backendNumber(check.monto)));
      group.checkIds.push(backendId(check.id_cheque_recibido));
      if (backendId(check.id_cobro)) group.collectionIds.push(backendId(check.id_cobro));
      groups.set(depositId, group);
    });
    return [...groups.values()].map(({ amountCents, ...group }) => ({
      ...group,
      amount: fromCents(amountCents)
    }));
  }
  
  function bankMovementLooksLikeReceivedCheckDeposit(movement) {
    const detail = backendNormalizeText([movement?.detail, movement?.concept].filter(Boolean).join(" "));
    const amountCents = toCents(backendNumber(movement?.amount ?? movement?.credit));
    return amountCents > 0 && (detail.includes("depos") || detail.includes("dep ch") || detail.includes("echeq"));
  }
  
  function bankManualCheckDepositMatch(movement, depositGroups) {
    if (!bankMovementLooksLikeReceivedCheckDeposit(movement)) return null;
    const amountCents = Math.abs(toCents(backendNumber(movement.amount ?? movement.credit)));
    const matches = depositGroups.filter((group) => (
      Math.abs(toCents(group.amount) - amountCents) <= 1
    ));
    return matches.length === 1 ? matches[0] : null;
  }
  
  function backendIssuedChecksByNumber(tables) {
    const checksByNumber = new Map();
    (tables.cheques_entregados?.rows || []).forEach((check) => {
      const checkKey = normalizeBankCheckNumber(check.nro_cheque);
      if (!checkKey || checksByNumber.has(checkKey)) return;
      checksByNumber.set(checkKey, {
        type: "cheque_entregado",
        id: backendId(check.id_cheque_entregado),
        idPago: backendId(check.id_pago),
        number: check.nro_cheque,
        amount: normalizeMoney(backendNumber(check.monto)),
        date: backendIsoDate(check.fecha_uso) || backendIsoDate(check.fecha_entregado),
        idAcreedor: backendId(check.id_acreedor),
        status: check.estado || ""
      });
    });
    return checksByNumber;
  }
  
  function bestBankMatch(movement, candidates, targetAmount, options = {}) {
    const maxDateDifference = Number.isFinite(options.maxDateDifference)
      ? Math.max(0, options.maxDateDifference)
      : 5;
    const matches = candidates
      .map((candidate) => {
        const amountDifferenceCents = Math.abs(toCents(candidate.amount) - toCents(targetAmount));
        const amountDifference = fromCents(amountDifferenceCents);
        const dateDifference = Math.abs(bankDateDistance(movement.date, candidate.date));
        if (amountDifferenceCents > 500) return null;
        if (options.requireExactDate && dateDifference !== 0) return null;
        if (!options.requireExactDate && dateDifference > maxDateDifference) return null;
  
        const identity = bankIdentityScore(movement, candidate);
        if (options.requireIdentity && identity.score <= 0) return null;
        const score = 100 - amountDifference - (dateDifference * 4) + identity.score;
        return { ...candidate, amountDifference, dateDifference, identity: identity.reason, score };
      })
      .filter(Boolean)
      .sort((left, right) => right.score - left.score);
    if (!matches.length) return null;
    if (options.rejectTies === true && matches.length > 1 && matches[0].score === matches[1].score) {
      return null;
    }
    return matches[0];
  }
  
  function uniqueExactBankMatch(movement, candidates, targetAmount) {
    const matches = candidates.filter((candidate) => (
      Math.abs(toCents(backendNumber(candidate.amount)) - toCents(targetAmount)) <= 500
      && bankDateDistance(movement.date, candidate.date) === 0
    ));
  
    if (matches.length !== 1) return null;
    const candidate = matches[0];
    const identity = bankIdentityScore(movement, candidate);
    return {
      ...candidate,
      amountDifference: fromCents(
        Math.abs(toCents(backendNumber(candidate.amount)) - toCents(targetAmount))
      ),
      dateDifference: 0,
      identity: identity.reason || "fecha y monto exactos",
      score: 100 + identity.score
    };
  }
  
  // Un pago puede llegar mucho despues de la fecha prevista de una factura. Cuando
  // acreedor y saldo pendiente coinciden exactamente, se prioriza completar el pago.
  function exactPendingExpenseMatch(movement, candidates, targetAmount) {
    const creditorId = bankMovementBackendCreditorId(movement);
    const movementCuit = normalizeBankCuit(movement.cuit);
    const movementParty = backendNormalizeText(movement.provider || movement.counterpartyName);
    const matches = (candidates || []).filter((candidate) => {
      if (Math.abs(toCents(backendNumber(candidate.amount)) - toCents(targetAmount)) > 1) return false;
      if (creditorId && backendId(candidate.idAcreedor) === creditorId) return true;
  
      const candidateCuit = normalizeBankCuit(candidate.cuit);
      if (movementCuit && candidateCuit && movementCuit === candidateCuit) return true;
  
      const candidateParty = backendNormalizeText(candidate.party);
      return Boolean(movementParty && candidateParty && (
        movementParty === candidateParty
        || movementParty.includes(candidateParty)
        || candidateParty.includes(movementParty)
      ));
    });
  
    // No se asocia automaticamente si hay dos facturas indistinguibles.
    if (matches.length !== 1) return null;
  
    const candidate = matches[0];
    const sameCreditor = creditorId && backendId(candidate.idAcreedor) === creditorId;
    const sameCuit = movementCuit && normalizeBankCuit(candidate.cuit) === movementCuit;
    return {
      ...candidate,
      amountDifference: fromCents(
        Math.abs(toCents(backendNumber(candidate.amount)) - toCents(targetAmount))
      ),
      dateDifference: candidate.date ? Math.abs(bankDateDistance(movement.date, candidate.date)) : null,
      identity: sameCreditor
        ? "acreedor y monto pendiente exactos"
        : sameCuit
          ? "CUIT y monto pendiente exactos"
          : "acreedor y monto pendiente exactos",
      score: 100
    };
  }
  
  function backendBankPaymentCandidates(tables, bank) {
    const detailsByPayment = backendGroupRowsById(tables.detalle_pagos?.rows, "id_pago");
    const expensesById = backendRowsById(tables.egresos?.rows, "id_egreso");
    return (tables.pagos?.rows || [])
      .map((payment) => {
        const paymentId = backendId(payment.id_pago);
        const details = detailsByPayment.get(paymentId) || [];
        const detailAmountCents = details.reduce(
          (total, detail) => total + toCents(backendNumber(detail.monto_cancelado)),
          0
        );
        const paymentAmountCents = toCents(backendNumber(payment.monto));
        const signedAmountCents = paymentAmountCents || detailAmountCents;
        if (Math.abs(signedAmountCents) <= 1) return null;
        const firstExpense = expensesById.get(backendId(details[0]?.id_egreso));
        const counterparty = firstExpense ? backendExpenseCounterpartyInfo(firstExpense, tables) : null;
        return {
          type: "pago",
          id: paymentId,
          movementKey: bankMovementKeyFromOperation(payment, "createPayments"),
          date: backendIsoDate(payment.fecha_pago),
          amount: fromCents(Math.abs(signedAmountCents)),
          direction: signedAmountCents < 0 ? "credito" : "debito",
          party: counterparty?.name || "",
          cuit: counterparty?.cuit || "",
          bank: payment.banco || "",
          description: compactBankText([
            payment.metodo || "Pago",
            payment.banco || "",
            firstExpense?.tipo_factura || "",
            firstExpense?.nro_factura || "",
            counterparty?.detail || ""
          ].filter(Boolean).join(" "))
        };
      })
      .filter((candidate) => candidate && candidate.date && backendBankMatches(candidate.bank, bank));
  }
  
  function backendBankCollectionCandidates(tables, bank) {
    const clientsById = backendRowsById(tables.clientes?.rows, "id_cliente");
    return (tables.cobros?.rows || [])
      .map((collection) => {
        const amountCents = toCents(backendNumber(collection.monto));
        if (amountCents <= 0) return null;
        const client = clientsById.get(backendId(collection.id_cliente));
        return {
          type: "cobro",
          id: backendId(collection.id_cobro),
          date: backendIsoDate(collection.fecha_cobro),
          amount: fromCents(amountCents),
          party: client?.nombre_cliente || "",
          cuit: normalizeBankCuit(client?.cuit),
          bank: collection.banco || "",
          description: `${collection.metodo || "Cobro"} ${collection.banco || ""}`.trim()
        };
      })
      .filter((candidate) => candidate && candidate.date && backendBankMatches(candidate.bank, bank));
  }
  
  function backendBankPayableCandidates(tables) {
    return backendBankExpenseCandidates(tables, (amount) => toCents(amount) > 1000);
  }
  
  function backendBankCreditPayableCandidates(tables) {
    return backendBankExpenseCandidates(tables, (amount) => toCents(amount) < -1000);
  }
  
  function backendBankExpenseCandidates(tables, isPendingAmount) {
    const paidByExpense = new Map();
    (tables.detalle_pagos?.rows || []).forEach((detail) => {
      const expenseId = backendId(detail.id_egreso);
      if (!expenseId) return;
      paidByExpense.set(
        expenseId,
        (paidByExpense.get(expenseId) || 0) + toCents(backendNumber(detail.monto_cancelado))
      );
    });
  
    const creditorRelationsById = backendRowsById(tables.acreedores_etiquetas?.rows, "id_acreedor_etiqueta");
    const sourceRelationByExpenseId = new Map();
    ["recepciones", "otros_gastos", "sueldos", "entregas", "comisiones"].forEach((tableName) => {
      (tables[tableName]?.rows || []).forEach((row) => {
        const expenseId = backendId(row.id_egreso);
        if (expenseId && !sourceRelationByExpenseId.has(expenseId)) {
          sourceRelationByExpenseId.set(expenseId, backendId(row.id_acreedor_etiqueta));
        }
      });
    });
    const planExpenseIds = new Set(
      (tables.cuotas_planes_pagos?.rows || [])
        .map((row) => backendId(row.id_egreso))
        .filter(Boolean)
    );
    return (tables.egresos?.rows || [])
      .map((expense) => {
        const totalCents = toCents(backendNumber(expense.total));
        const paidCents = paidByExpense.get(backendId(expense.id_egreso)) || 0;
        const pendingAmount = fromCents(totalCents - paidCents);
        if (!isPendingAmount(pendingAmount)) return null;
        const counterparty = backendExpenseCounterpartyInfo(expense, tables);
        const creditorRelation = creditorRelationsById.get(
          backendId(expense.id_acreedor_etiqueta)
          || sourceRelationByExpenseId.get(backendId(expense.id_egreso))
        );
        return {
          type: "egreso",
          id: backendId(expense.id_egreso),
          movementKey: bankMovementKeyFromOperation(expense, "createEgresses"),
          date: backendIsoDate(expense.fecha_prevista_pago) || backendIsoDate(expense.fecha_factura),
          amount: fromCents(Math.abs(toCents(pendingAmount))),
          planPayment: planExpenseIds.has(backendId(expense.id_egreso)),
          idAcreedor: backendId(creditorRelation?.id_acreedor) || backendId(expense._id_acreedor),
          party: counterparty.name,
          cuit: counterparty.cuit,
          description: compactBankText([
            expense.tipo_factura || "",
            expense.nro_factura || "",
            counterparty.detail || ""
          ].filter(Boolean).join(" "))
        };
      })
      .filter((candidate) => candidate && candidate.date);
  }
  
  function backendBankSourceCandidates(tables) {
    const creditorByOrigin = new Map();
    (tables.acreedores?.rows || []).forEach((creditor) => {
      const key = `${backendNormalizeText(creditor.origen_tipo_acreedor)}:${backendId(creditor.origen_id_acreedor)}`;
      if (key !== ":" && !creditorByOrigin.has(key)) creditorByOrigin.set(key, creditor);
    });
    const relationById = backendRowsById(tables.acreedores_etiquetas?.rows, "id_acreedor_etiqueta");
    const candidates = [];
    const pushCandidate = (config, row, details) => {
      if (backendId(row.id_egreso)) return;
      const creditor = creditorByOrigin.get(`${config.originType}:${backendId(details.originId)}`);
      const relation = relationById.get(backendId(row.id_acreedor_etiqueta));
      candidates.push({
        type: "gasto_origen",
        table: config.table,
        label: config.label,
        idColumn: config.idColumn,
        id: backendId(row[config.idColumn]),
        movementKey: bankMovementKeyFromOperation(row, "createExpenses"),
        date: backendIsoDate(details.date),
        invoiceDate: backendIsoDate(row._fecha_factura),
        invoiceType: row._tipo_factura || "",
        invoiceNumber: row._nro_factura || "",
        amount: normalizeMoney(backendNumber(details.amount)),
        idAcreedor: backendId(creditor?.id_acreedor) || backendId(details.idAcreedor),
        idEtiqueta: backendId(relation?.id_etiqueta),
        party: backendCreditorDisplayName(creditor, tables),
        cuit: normalizeBankCuit(creditor?.cuit_cuil),
        description: compactBankText(details.description || row.detalle || config.label)
      });
    };
  
    const purchasesById = backendRowsById(tables.compras?.rows, "id_compra");
    (tables.recepciones?.rows || []).forEach((row) => {
      const purchase = purchasesById.get(backendId(row.id_compra));
      pushCandidate(
        { table: "recepciones", label: "Recepcion", idColumn: "id_recepcion", originType: "proveedor" },
        row,
        {
          originId: purchase?.id_proveedor,
          date: row.fecha_recepcion,
          amount: row._total,
          description: "Recepcion de mercaderia"
        }
      );
    });
  
    (tables.otros_gastos?.rows || []).forEach((row) => {
      const creditor = (tables.acreedores?.rows || []).find((candidate) => backendId(candidate.id_acreedor) === backendId(row.id_acreedor));
      pushCandidate(
        {
          table: "otros_gastos",
          label: "Otro gasto",
          idColumn: "id_otros_gastos",
          originType: backendNormalizeText(creditor?.origen_tipo_acreedor) || "otros acreedores"
        },
        row,
        {
          originId: creditor?.origen_id_acreedor,
          idAcreedor: row.id_acreedor,
          date: row.fecha_otros_gastos,
          amount: row._total,
          description: row.detalle
        }
      );
    });
  
    (tables.sueldos?.rows || []).forEach((row) => pushCandidate(
      { table: "sueldos", label: "Sueldo", idColumn: "id_sueldo", originType: "empleado" },
      row,
      {
        originId: row.id_empleado,
        date: row.fecha,
        amount: row.sueldo_neto,
        description: "Sueldo"
      }
    ));
  
    (tables.entregas?.rows || []).forEach((row) => pushCandidate(
      { table: "entregas", label: "Entrega", idColumn: "id_entrega", originType: "flete" },
      row,
      {
        originId: row.id_flete,
        date: row.fecha,
        amount: row._total,
        description: "Logistica"
      }
    ));
  
    (tables.comisiones?.rows || []).forEach((row) => pushCandidate(
      { table: "comisiones", label: "Comision", idColumn: "id_comision", originType: "canal" },
      row,
      {
        originId: row.id_canal,
        date: row.fecha || row.fecha_comision,
        amount: row.comision,
        description: "Comision"
      }
    ));
  
    return candidates.filter((candidate) => candidate.id && candidate.date);
  }
  
  function bestBankSourceMatch(movement, candidates) {
    const creditorId = bankMovementBackendCreditorId(movement);
    if (!creditorId) return null;
    return (candidates || [])
      .map((candidate) => {
        if (backendId(candidate.idAcreedor) !== creditorId) return null;
        const dateDifference = Math.abs(bankDateDistance(movement.date, candidate.date));
        // Un gasto puede pagarse varios meses despues. Acreedor e importe exactos
        // son los criterios fuertes; la fecha solo ordena las coincidencias validas.
        if (dateDifference > 365) return null;
        const amountDifferenceCents = toCents(candidate.amount) > 0
          ? Math.abs(toCents(candidate.amount) - Math.abs(toCents(movement.amount)))
          : Number.POSITIVE_INFINITY;
        if (Number.isFinite(amountDifferenceCents) && amountDifferenceCents > 500) return null;
        const amountDifference = Number.isFinite(amountDifferenceCents)
          ? fromCents(amountDifferenceCents)
          : Number.POSITIVE_INFINITY;
        const score = 100 - (dateDifference * 2) - (Number.isFinite(amountDifference) ? amountDifference : 60);
        return { ...candidate, dateDifference, amountDifference, score };
      })
      .filter(Boolean)
      .sort((left, right) => right.score - left.score)[0] || null;
  }
  
  function backendBankIdentityIndex(tables) {
    const identities = [];
    const creditorsById = backendRowsById(tables.acreedores?.rows, "id_acreedor");
    const tagNameById = backendTagNameMap(tables);
    const creditorsByName = new Map();
    const creditorsByOrigin = new Map();
    (tables.acreedores?.rows || []).forEach((creditor) => {
      const key = `${backendNormalizeText(creditor.origen_tipo_acreedor)}:${backendId(creditor.origen_id_acreedor)}`;
      if (key !== ":" && !creditorsByOrigin.has(key)) creditorsByOrigin.set(key, creditor);
      const displayName = backendNormalizeText(backendCreditorDisplayName(creditor, tables));
      if (displayName && !creditorsByName.has(displayName)) creditorsByName.set(displayName, creditor);
    });
    const addIdentity = (identity) => {
      const name = compactBankText(identity.name || "");
      const cuit = normalizeBankCuit(identity.cuit || "");
      const detail = compactBankText(identity.detail || "");
      const cbuAlias = compactBankText(identity.cbuAlias || "");
      if (!name && !cuit && !detail && !cbuAlias) return;
      identities.push({
        ...identity,
        name,
        cuit,
        detail,
        cbuAlias,
        normalizedName: backendNormalizeText(name),
        normalizedDetail: backendNormalizeText(detail),
        normalizedCbuAlias: backendNormalizeText(cbuAlias)
      });
    };
  
    (tables.acreedores?.rows || []).forEach((creditor) => {
      const tagNames = backendCreditorTagNames(creditor.id_acreedor, tables);
      const tagOptionDetails = (tables.acreedores_etiquetas?.rows || [])
        .filter((relation) => backendId(relation.id_acreedor) === backendId(creditor.id_acreedor))
        .map((relation) => ({
          idAcreedorEtiqueta: backendId(relation.id_acreedor_etiqueta),
          idEtiqueta: backendId(relation.id_etiqueta),
          name: backendTagNameForId(relation.id_etiqueta, tagNameById)
        }))
        .filter((tag) => tag.idAcreedorEtiqueta && tag.idEtiqueta && tag.name);
      const firstTag = tagNames[0] || "";
      const firstTagId = backendTagIdForName(firstTag, tables);
      addIdentity({
        type: "acreedor",
        id: backendId(creditor.id_acreedor),
        name: backendCreditorDisplayName(creditor, tables),
        cuit: creditor.cuit_cuil,
        cbuAlias: creditor.cbu_alias,
        detail: "",
        tagOptions: tagNames,
        tagOptionDetails,
        idEtiqueta: firstTagId,
        idAcreedorEtiqueta: backendCreditorTagRelationId(creditor.id_acreedor, firstTagId, tables),
        tagLabel: firstTag,
        originType: creditor.origen_tipo_acreedor || "",
        originId: backendId(creditor.origen_id_acreedor),
        sourceDestination: bankSourceDestinationForOriginType(creditor.origen_tipo_acreedor)
      });
    });
  
    // Los ingresos pueden venir informados con el CUIT del cliente. Se indexan
    // aparte de los acreedores para evitar proponer altas duplicadas en cobros.
    (tables.clientes?.rows || []).forEach((client) => {
      addIdentity({
        type: "cliente",
        id: backendId(client.id_cliente),
        name: client.nombre_cliente,
        cuit: client.cuit || "",
        detail: "",
        originType: "cliente",
        originId: backendId(client.id_cliente)
      });
    });
  
    (tables.proveedores?.rows || []).forEach((provider) => {
      const creditor = creditorsByOrigin.get(`proveedor:${backendId(provider.id_proveedor)}`);
      addIdentity({
        type: "proveedor",
        id: backendId(provider.id_proveedor),
        idAcreedor: backendId(creditor?.id_acreedor),
        name: provider.nombre,
        cuit: provider.cuit || "",
        detail: "Proveedor",
        originType: "Proveedor",
        originId: backendId(provider.id_proveedor),
        sourceDestination: bankSourceDestinationForOriginType("Proveedor")
      });
    });
  
    // Datos bancarios guarda reglas explícitas: texto del extracto -> acreedor + etiqueta.
    (tables.datos_bancarios?.rows || []).forEach((bankData) => {
      const creditor = creditorsById.get(backendId(bankData.id_acreedor));
      const tagLabel = backendTagNameForId(bankData.id_etiqueta, tagNameById);
      addIdentity({
        type: "datos_bancarios",
        id: backendId(bankData.id_dato_bancario),
        idAcreedor: backendId(bankData.id_acreedor),
        idEtiqueta: backendId(bankData.id_etiqueta),
        idAcreedorEtiqueta: backendCreditorTagRelationId(
          bankData.id_acreedor,
          bankData.id_etiqueta,
          tables
        ),
        invoiceType: cleanBackendText(bankData.tipo_factura),
        expenseType: tagLabel,
        tagLabel,
        name: backendCreditorDisplayName(creditor, tables),
        cuit: "",
        cbuAlias: "",
        detail: bankData.detalle || "",
        originType: creditor?.origen_tipo_acreedor || "",
        originId: backendId(creditor?.origen_id_acreedor),
        sourceDestination: bankSourceDestinationForOriginType(creditor?.origen_tipo_acreedor)
      });
    });
  
    return identities;
  }
  
  function identifyBankCounterparty(movement, identities) {
    const movementCuit = normalizeBankCuit(movement.cuit);
    const movementDetail = backendNormalizeText(movement.detail || movement.concept);
  
    // Si el banco informa CUIT, ese identificador manda. No usamos el detalle como
    // fallback porque textos genéricos del banco pueden terminar asociados a otro acreedor.
    if (movementCuit) {
      return (identities || [])
        .filter((identity) => identity.cuit && movementCuit === identity.cuit)
        .map((identity) => ({ ...identity, score: 100, reason: "CUIT" }))
        .sort((left, right) => right.score - left.score)[0] || null;
    }
  
    const scored = (identities || [])
      .filter((identity) => identity.type === "datos_bancarios")
      .map((identity) => {
        let score = 0;
        const reasons = [];
        if (identity.normalizedDetail && identity.normalizedDetail.length >= 4 && movementDetail) {
          if (movementDetail.includes(identity.normalizedDetail) || identity.normalizedDetail.includes(movementDetail)) {
            score += 55;
            reasons.push("detalle exacto");
          } else if (bankTextOverlapScore(movementDetail, identity.normalizedDetail) >= 2) {
            score += 20;
            reasons.push("detalle");
          }
        }
        return score ? { ...identity, score, reason: reasons.join(" + ") } : null;
      })
      .filter(Boolean)
      .sort((left, right) => right.score - left.score);
  
    return scored[0] || null;
  }
  
  function bankIdentityScore(movement, candidate) {
    const movementCuit = normalizeBankCuit(movement.cuit);
    const movementName = backendNormalizeText(movement.counterpartyName || movement.provider);
    const movementText = backendNormalizeText([movement.concept, movement.detail, movement.counterpartyName].filter(Boolean).join(" "));
    const candidateParty = backendNormalizeText(candidate.party);
    const candidateDescription = backendNormalizeText(candidate.description);
    const candidateCuit = normalizeBankCuit(candidate.cuit);
  
    let score = 0;
    const reasons = [];
    if (movementCuit && candidateCuit && movementCuit === candidateCuit) {
      score += 70;
      reasons.push("CUIT");
    }
    if (candidateParty && movementText.includes(candidateParty)) {
      score += 42;
      reasons.push("proveedor");
    } else if (movementName && candidateParty && (
      movementName.includes(candidateParty) || candidateParty.includes(movementName)
    )) {
      score += 38;
      reasons.push("nombre");
    }
    if (candidateDescription && bankTextOverlapScore(movementText, candidateDescription) >= 2) {
      score += 24;
      reasons.push("detalle");
    }
    return { score, reason: reasons.join(" + ") };
  }

  return { backendBankCollectionCandidates, backendBankCreditPayableCandidates, backendBankExpenseCandidates, backendBankIdentityIndex, backendBankPayableCandidates, backendBankPaymentCandidates, backendBankSourceCandidates, backendIssuedChecksByNumber, backendReceivedCheckDepositGroups, backendReceivedChecksByNumber, bankIdentityScore, bankManualCheckDepositMatch, bankMovementLooksLikeReceivedCheckDeposit, bestBankMatch, bestBankSourceMatch, exactPendingExpenseMatch, identifyBankCounterparty, uniqueExactBankMatch };
}

module.exports = { createBankMatchingService };
