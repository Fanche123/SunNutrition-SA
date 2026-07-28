const { fromCents, normalize: normalizeMoney, toCents } = require("../../shared/money");

function createExpenseClassificationService(dependencies) {
  const { backendId, backendIsoDate, backendNormalizeText, backendNumber, backendRowsById, cleanBackendText, normalizeBankCuit, normalizeLookupText } = dependencies;

  function backendStatementExpenseCategories() {
    return new Set([
      "mercaderia",
      "comisiones",
      "ingresos brutos",
      "logistica",
      "sueldos",
      "sueldos extras",
      "administrativos",
      "servicios",
      "herramientas de trabajo",
      "alquiler",
      "cadeteria",
      "limpieza",
      "varios",
      "otros",
      "incentivos personal",
      "impuesto cred",
      "impuesto deb",
      "impuesto sello",
      "impuestos internos",
      "gastos bancarios",
      "intereses",
      "rendimiento fondo",
      "inversion general",
      "maquinaria"
    ]);
  }
  
  function backendTagNameMap(tables) {
    const result = new Map();
    (tables.etiquetas?.rows || []).forEach((tag) => {
      const id = backendId(tag.id_etiqueta);
      const name = cleanBackendText(tag.etiqueta);
      if (id && name) result.set(id, name);
    });
    return result;
  }
  
  function backendTagNameForId(id, tagNameById) {
    return tagNameById.get(backendId(id)) || "";
  }
  
  function backendTagNameForCreditorTagId(creditorTagId, tables, helpers = {}) {
    const relationId = backendId(creditorTagId);
    if (!relationId) return "";
    const relationsById = helpers.relationsById || backendRowsById(tables.acreedores_etiquetas?.rows, "id_acreedor_etiqueta");
    const tagNameById = helpers.tagNameById || backendTagNameMap(tables);
    const relation = relationsById.get(relationId);
    return backendTagNameForId(relation?.id_etiqueta, tagNameById);
  }
  
  function backendTagIdForName(name, tables) {
    const normalized = normalizeLookupText(name);
    if (!normalized) return "";
    const tag = (tables.etiquetas?.rows || []).find((row) => normalizeLookupText(row.etiqueta) === normalized);
    return backendId(tag?.id_etiqueta);
  }
  
  function backendExpenseCategoryTotals(tables, startIso, endIso) {
    const totalsInCents = {};
    backendStatementExpenseRows(tables, startIso, endIso).forEach((expense) => {
      totalsInCents[expense.category] = (totalsInCents[expense.category] || 0)
        + toCents(expense.amount);
    });

    return Object.fromEntries(Object.entries(totalsInCents).map(([category, cents]) => [
      category,
      fromCents(cents)
    ]));
  }

  function backendPersistedEconomicExpenseRows(tables, startIso, endIso) {
    const tagNameById = backendTagNameMap(tables);
    return (tables.gastos_economicos?.rows || [])
      .filter((expense) => {
        const date = backendIsoDate(expense.fecha_economica);
        return expense.estado === "confirmado" && date >= startIso && date <= endIso;
      })
      .map((expense) => ({
        id: expense.id_gasto_economico,
        date: backendIsoDate(expense.fecha_economica),
        supplier: "",
        category: backendTagNameForId(expense.id_etiqueta, tagNameById),
        amount: normalizeMoney(backendNumber(expense.importe)),
        concept: cleanBackendText(expense.concepto),
        movementType: cleanBackendText(expense.tipo_movimiento),
        reason: cleanBackendText(expense.motivo),
        originType: cleanBackendText(expense.origen_tipo),
        originId: backendId(expense.origen_id),
        originSubkey: cleanBackendText(expense.origen_subclave),
        source: `gastos_economicos #${expense.id_gasto_economico || ""}`,
        raw: expense
      }))
      .filter((expense) => expense.category && expense.amount);
  }

  function backendStatementExpenseRows(tables, startIso, endIso) {
    return backendPersistedEconomicExpenseRows(tables, startIso, endIso);
  }
  
  function backendUncategorizedExpenseRows(tables, startIso, endIso) {
    const statementCategories = backendStatementExpenseCategories();
  
    return backendStatementExpenseRows(tables, startIso, endIso)
      .filter((expense) => {
        return !statementCategories.has(backendNormalizeText(expense.category));
      })
      .map((expense) => {
        return {
          id: expense.id || "",
          date: expense.date,
          supplier: expense.supplier || "",
          category: expense.category || "Sin categoria",
          subtotal: expense.amount,
          source: expense.source || ""
        };
      })
      .sort((left, right) => left.date.localeCompare(right.date) || String(left.supplier).localeCompare(String(right.supplier)));
  }
  
  function backendExpenseSupplierName(expense, tables) {
    return backendExpenseCounterpartyInfo(expense, tables).name;
  }
  
  function backendExpenseCounterpartyMaps(tables) {
    const creditorsByOrigin = new Map();
    (tables.acreedores?.rows || []).forEach((creditor) => {
      const key = `${backendExpenseSourceTypeKey(creditor.origen_tipo_acreedor)}:${backendId(creditor.origen_id_acreedor)}`;
      if (!creditorsByOrigin.has(key)) creditorsByOrigin.set(key, creditor);
    });

    return {
      bankMovementsById: backendRowsById(tables.movimientos_bancarios?.rows, "id_movimiento_bancario"),
      channelsById: backendRowsById(tables.canales?.rows, "id_canal"),
      clientsById: backendRowsById(tables.clientes?.rows, "id_cliente"),
      commissionsById: backendRowsById(tables.comisiones?.rows, "id_comision"),
      creditorsById: backendRowsById(tables.acreedores?.rows, "id_acreedor"),
      creditorsByOrigin,
      deliveriesById: backendRowsById(tables.entregas?.rows, "id_entrega"),
      employeesById: backendRowsById(tables.empleados?.rows, "id_empleado"),
      freightsById: backendRowsById(tables.fletes?.rows, "id_flete"),
      fundMovementsById: backendRowsById(tables.fondos_inversion_movimientos?.rows, "id_movimiento_fondo"),
      otherExpensesById: backendRowsById(tables.otros_gastos?.rows, "id_otros_gastos"),
      otherCreditorsById: backendRowsById(tables.otros_acreedores?.rows, "id_otro_acreedor"),
      paymentPlansById: backendRowsById(tables.planes_pagos?.rows, "id_plan_pago"),
      providersById: backendRowsById(tables.proveedores?.rows, "id_proveedor"),
      purchasesById: backendRowsById(tables.compras?.rows, "id_compra"),
      quotasById: backendRowsById(tables.cuotas_planes_pagos?.rows, "id_cuota_plan_pago"),
      receptionsById: backendRowsById(tables.recepciones?.rows, "id_recepcion"),
      salariesById: backendRowsById(tables.sueldos?.rows, "id_sueldo"),
      salesById: backendRowsById(tables.ventas?.rows, "id_venta")
    };
  }

  function backendExpenseCounterpartyInfo(expense, tables, helpers = {}) {
    const linkedOrigin = backendExpenseLinkedOrigin(expense, tables);
    const originType = backendExpenseSourceTypeKey(linkedOrigin.type);
    const originId = linkedOrigin.id;
    const maps = helpers.maps || backendExpenseCounterpartyMaps(tables);

    if (originType === "egreso") {
      return backendExpenseCounterpartyInfo({ id_egreso: originId }, tables, { maps });
    }
  
    if (originType === "recepcion" || originType === "recepciones") {
      const reception = linkedOrigin.row || maps.receptionsById.get(originId);
      const purchase = maps.purchasesById.get(backendId(reception?.id_compra));
      const provider = maps.providersById.get(backendId(purchase?.id_proveedor));
      return {
        name: provider?.nombre || "",
        cuit: normalizeBankCuit(provider?.cuit),
        detail: `Recepcion #${originId}`
      };
    }
  
    if (originType === "otro gasto" || originType === "otros gastos") {
      const otherExpense = linkedOrigin.row || maps.otherExpensesById.get(originId);
      const creditor = maps.creditorsById.get(backendId(otherExpense?.id_acreedor));
      return {
        name: backendCreditorDisplayName(creditor, tables, maps),
        cuit: normalizeBankCuit(creditor?.cuit_cuil),
        detail: otherExpense?.detalle || `Otro gasto #${originId}`
      };
    }
  
    if (originType === "sueldo" || originType === "sueldos") {
      const salary = linkedOrigin.row || maps.salariesById.get(originId);
      const employee = maps.employeesById.get(backendId(salary?.id_empleado));
      return {
        name: employee?.nombre_empleado || "",
        cuit: normalizeBankCuit(employee?.cuit_cuil || employee?.dni),
        detail: `Sueldo #${originId}`
      };
    }
  
    if (originType === "logistica") {
      const delivery = linkedOrigin.row || maps.deliveriesById.get(originId);
      const freight = maps.freightsById.get(backendId(delivery?.id_flete));
      return {
        name: freight?.nombre_flete || "",
        cuit: normalizeBankCuit(freight?.cuit),
        detail: `Entrega #${originId}`
      };
    }

    if (originType === "comision venta" || originType === "ingresos brutos" || originType === "venta") {
      const sale = maps.salesById.get(originId);
      const client = maps.clientsById.get(backendId(sale?.id_cliente));
      const channel = maps.channelsById.get(backendId(client?.id_canal));
      const isCommission = originType === "comision venta";
      return {
        name: isCommission ? channel?.nombre || "" : client?.nombre_cliente || "",
        cuit: normalizeBankCuit(client?.cuit),
        detail: `Venta #${originId}`
      };
    }

    if (originType === "comisiones") {
      const commission = linkedOrigin.row || maps.commissionsById.get(originId);
      const channel = maps.channelsById.get(backendId(commission?.id_canal));
      return {
        name: channel?.nombre || "",
        cuit: "",
        detail: `Comision #${originId}`
      };
    }

    if (originType === "plan pago") {
      const quota = maps.quotasById.get(originId);
      const plan = maps.paymentPlansById.get(backendId(quota?.id_plan_pago));
      return {
        name: cleanBackendText(plan?.organismo || plan?.nombre),
        cuit: "",
        detail: `Cuota ${cleanBackendText(quota?.nro_cuota) || `#${originId}`}`
      };
    }

    if (originType === "fondo inversion") {
      const movement = maps.fundMovementsById.get(originId);
      return {
        name: "",
        cuit: "",
        detail: cleanBackendText(movement?.referencia || movement?.observacion) || `Movimiento de fondo #${originId}`
      };
    }

    if (originType === "movimiento bancario") {
      const movement = maps.bankMovementsById.get(originId);
      return {
        name: "",
        cuit: normalizeBankCuit(movement?.cuit),
        detail: cleanBackendText(movement?.detalle || movement?.concepto) || `Movimiento bancario #${originId}`
      };
    }

    const canonicalCreditor = maps.creditorsByOrigin.get(`${originType}:${originId}`);
    if (canonicalCreditor) {
      return {
        name: backendCreditorDisplayName(canonicalCreditor, tables, maps),
        cuit: normalizeBankCuit(canonicalCreditor.cuit_cuil),
        detail: backendCreditorTagNames(canonicalCreditor.id_acreedor, tables).join(" ")
      };
    }
  
    // Egresos historicos pueden no tener fila operativa enlazada. En esos casos
    // el import conserva el acreedor original en _id_acreedor.
    const historicalCreditor = maps.creditorsById.get(backendId(expense._id_acreedor));
    if (historicalCreditor) {
      return {
        name: backendCreditorDisplayName(historicalCreditor, tables, maps),
        cuit: normalizeBankCuit(historicalCreditor.cuit_cuil),
        detail: cleanBackendText(expense._etiqueta_gasto) || backendCreditorTagNames(historicalCreditor.id_acreedor, tables).join(" ")
      };
    }
  
    return { name: "", cuit: "", detail: "" };
  }
  
  function backendExpenseLinkedOrigin(expense, tables) {
    const expenseId = backendId(expense.id_egreso);
    if (expenseId) {
      for (const config of backendExpenseSourceConfigs()) {
        const row = (tables[config.table]?.rows || []).find((sourceRow) => backendId(sourceRow.id_egreso) === expenseId);
        if (row) return { type: config.type, id: backendId(row[config.idColumn]), row };
      }
    }
  
    // Compatibilidad con caches/imports viejos: el origen ya no pertenece al modelo de egresos.
    return {
      type: expense.origen_tipo || "",
      id: backendId(expense.origen_id),
      row: null
    };
  }
  
  function backendExpenseSourceConfigs() {
    return [
      { table: "recepciones", type: "recepciones", idColumn: "id_recepcion" },
      { table: "otros_gastos", type: "otros_gastos", idColumn: "id_otros_gastos" },
      { table: "sueldos", type: "sueldos", idColumn: "id_sueldo" },
      { table: "entregas", type: "logistica", idColumn: "id_entrega" },
      { table: "comisiones", type: "comisiones", idColumn: "id_comision" }
    ];
  }
  
  function backendExpenseSourceTypeKey(value) {
    const text = backendNormalizeText(value);
    if (text === "entregas" || text === "logistica") return "logistica";
    if (text === "otros gastos" || text === "otros_gastos") return "otros_gastos";
    return text;
  }
  
  function backendCreditorDisplayName(creditor, tables, maps = {}) {
    if (!creditor) return "";
    const originType = backendNormalizeText(creditor.origen_tipo_acreedor);
    const originId = backendId(creditor.origen_id_acreedor);
  
    if (originType === "proveedor") {
      return (maps.providersById || backendRowsById(tables.proveedores?.rows, "id_proveedor")).get(originId)?.nombre || "";
    }
    if (originType === "empleado") {
      return (maps.employeesById || backendRowsById(tables.empleados?.rows, "id_empleado")).get(originId)?.nombre_empleado || "";
    }
    if (originType === "flete") {
      return (maps.freightsById || backendRowsById(tables.fletes?.rows, "id_flete")).get(originId)?.nombre_flete || "";
    }
    if (originType === "canal") {
      return (maps.channelsById || backendRowsById(tables.canales?.rows, "id_canal")).get(originId)?.nombre || "";
    }
    if (originType === "otros acreedores") {
      return (maps.otherCreditorsById || backendRowsById(tables.otros_acreedores?.rows, "id_otro_acreedor")).get(originId)?.nombre_otro_acreedor || "";
    }
  
    return creditor.acuerdo_de_pago || "";
  }
  
  function backendCreditorTagNames(creditorId, tables) {
    const normalizedCreditorId = backendId(creditorId);
    if (!normalizedCreditorId) return [];
    const tagNameById = backendTagNameMap(tables);
    const names = [];
    (tables.acreedores_etiquetas?.rows || []).forEach((relation) => {
      if (backendId(relation.id_acreedor) !== normalizedCreditorId) return;
      const tagName = backendTagNameForId(relation.id_etiqueta, tagNameById);
      if (tagName && !names.includes(tagName)) names.push(tagName);
    });
    return names;
  }

  return { backendCreditorDisplayName, backendCreditorTagNames, backendExpenseCategoryTotals, backendExpenseCounterpartyInfo, backendExpenseCounterpartyMaps, backendExpenseLinkedOrigin, backendExpenseSourceConfigs, backendExpenseSourceTypeKey, backendExpenseSupplierName, backendPersistedEconomicExpenseRows, backendStatementExpenseCategories, backendStatementExpenseRows, backendTagIdForName, backendTagNameForCreditorTagId, backendTagNameForId, backendTagNameMap, backendUncategorizedExpenseRows };
}

module.exports = { createExpenseClassificationService };
