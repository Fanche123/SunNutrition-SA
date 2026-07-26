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
  
  function backendEconomicExpenseRows(tables, startIso, endIso) {
    const tagNameById = backendTagNameMap(tables);
    const creditorTagById = backendRowsById(tables.acreedores_etiquetas?.rows, "id_acreedor_etiqueta");
    const providersById = backendRowsById(tables.proveedores?.rows, "id_proveedor");
    const purchasesById = backendRowsById(tables.compras?.rows, "id_compra");
    const fletesById = backendRowsById(tables.fletes?.rows, "id_flete");
    const employeesById = backendRowsById(tables.empleados?.rows, "id_empleado");
    const creditorsById = backendRowsById(tables.acreedores?.rows, "id_acreedor");
    const channelsById = backendRowsById(tables.canales?.rows, "id_canal");
    const expensesById = backendRowsById(tables.egresos?.rows, "id_egreso");
    const rows = [];
  
    const categoryFor = (row) => {
      return backendTagNameForCreditorTagId(row.id_acreedor_etiqueta, tables, { relationsById: creditorTagById, tagNameById })
        || cleanBackendText(row._etiqueta_gasto)
        || backendTagNameForId(expensesById.get(backendId(row.id_egreso))?.id_etiqueta, tagNameById);
    };
    const amountFor = (row, columns) => {
      for (const column of columns) {
        const amount = backendNumber(row[column]);
        if (amount) return normalizeMoney(amount);
      }
      const linkedExpense = expensesById.get(backendId(row.id_egreso));
      return normalizeMoney(backendNumber(linkedExpense?.subtotal || linkedExpense?.total));
    };
    const add = (entry) => {
      const date = backendIsoDate(entry.date);
      if (date < startIso || date > endIso) return;
      if (!entry.category || !entry.amount) return;
      rows.push({ ...entry, date });
    };
  
    (tables.recepciones?.rows || []).forEach((reception) => {
      const purchase = purchasesById.get(backendId(reception.id_compra));
      const provider = providersById.get(backendId(purchase?.id_proveedor || reception._id_acreedor));
      add({
        id: reception.id_recepcion,
        date: reception.fecha_recepcion || reception._fecha_factura,
        supplier: provider?.nombre || cleanBackendText(reception._nombre_acreedor),
        category: categoryFor(reception) || "Mercaderia",
        amount: amountFor(reception, ["subtotal", "_subtotal", "total", "_total"]),
        source: `recepciones #${reception.id_recepcion || ""}`
      });
    });
  
    (tables.entregas?.rows || []).forEach((delivery) => {
      const carrier = fletesById.get(backendId(delivery.id_flete));
      add({
        id: delivery.id_entrega,
        date: delivery.fecha || delivery._fecha_factura,
        supplier: carrier?.nombre_flete || cleanBackendText(delivery._nombre_acreedor),
        category: categoryFor(delivery) || "Logistica",
        amount: amountFor(delivery, ["subtotal", "_subtotal", "total", "_total"]),
        source: `entregas #${delivery.id_entrega || ""}`
      });
    });
  
    (tables.otros_gastos?.rows || []).forEach((expense) => {
      const creditor = creditorsById.get(backendId(expense.id_acreedor));
      add({
        id: expense.id_otros_gastos,
        date: expense.fecha_otros_gastos || expense._fecha_factura,
        supplier: backendCreditorDisplayName(creditor, tables) || cleanBackendText(expense._nombre_acreedor),
        category: categoryFor(expense),
        amount: amountFor(expense, ["subtotal", "_subtotal", "total", "_total"]),
        source: `otros_gastos #${expense.id_otros_gastos || ""}`
      });
    });
  
    (tables.sueldos?.rows || []).forEach((salary) => {
      const employee = employeesById.get(backendId(salary.id_empleado));
      add({
        id: salary.id_sueldo,
        date: salary.fecha,
        supplier: employee?.nombre_empleado || "",
        category: categoryFor(salary) || "Sueldos",
        amount: amountFor(salary, ["sueldo_bruto", "sueldo_neto"]),
        source: `sueldos #${salary.id_sueldo || ""}`
      });
    });
  
    (tables.comisiones?.rows || []).forEach((commission) => {
      const channel = channelsById.get(backendId(commission.id_canal));
      add({
        id: commission.id_comision,
        date: commission.fecha,
        supplier: channel?.nombre || "",
        category: categoryFor(commission) || "Comisiones",
        amount: amountFor(commission, ["comision", "subtotal"]),
        source: `comisiones #${commission.id_comision || ""}`
      });
    });
  
    return rows;
  }
  
  function backendExpenseCategoryTotals(tables, startIso, endIso) {
    const totalsInCents = {};
    backendEconomicExpenseRows(tables, startIso, endIso).forEach((expense) => {
      totalsInCents[expense.category] = (totalsInCents[expense.category] || 0)
        + toCents(expense.amount);
    });

    return Object.fromEntries(Object.entries(totalsInCents).map(([category, cents]) => [
      category,
      fromCents(cents)
    ]));
  }
  
  function backendUncategorizedExpenseRows(tables, startIso, endIso) {
    const statementCategories = backendStatementExpenseCategories();
  
    return backendEconomicExpenseRows(tables, startIso, endIso)
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
  
  function backendExpenseCounterpartyInfo(expense, tables) {
    const linkedOrigin = backendExpenseLinkedOrigin(expense, tables);
    const originType = backendExpenseSourceTypeKey(linkedOrigin.type);
    const originId = linkedOrigin.id;
    const providersById = backendRowsById(tables.proveedores?.rows, "id_proveedor");
    const creditorsById = backendRowsById(tables.acreedores?.rows, "id_acreedor");
  
    if (originType === "recepciones") {
      const receptionsById = backendRowsById(tables.recepciones?.rows, "id_recepcion");
      const purchasesById = backendRowsById(tables.compras?.rows, "id_compra");
      const reception = linkedOrigin.row || receptionsById.get(originId);
      const purchase = purchasesById.get(backendId(reception?.id_compra));
      const provider = providersById.get(backendId(purchase?.id_proveedor));
      return {
        name: provider?.nombre || "",
        cuit: normalizeBankCuit(provider?.cuit),
        detail: "Recepcion"
      };
    }
  
    if (originType === "otros gastos" || originType === "otros_gastos") {
      const otherExpensesById = backendRowsById(tables.otros_gastos?.rows, "id_otros_gastos");
      const otherExpense = linkedOrigin.row || otherExpensesById.get(originId);
      const creditor = creditorsById.get(backendId(otherExpense?.id_acreedor));
      return {
        name: backendCreditorDisplayName(creditor, tables),
        cuit: normalizeBankCuit(creditor?.cuit_cuil),
        detail: otherExpense?.detalle || backendCreditorTagNames(creditor?.id_acreedor, tables).join(" ")
      };
    }
  
    if (originType === "sueldos") {
      const salariesById = backendRowsById(tables.sueldos?.rows, "id_sueldo");
      const employeesById = backendRowsById(tables.empleados?.rows, "id_empleado");
      const salary = linkedOrigin.row || salariesById.get(originId);
      const employee = employeesById.get(backendId(salary?.id_empleado));
      return {
        name: employee?.nombre_empleado || "",
        cuit: normalizeBankCuit(employee?.cuit_cuil || employee?.dni),
        detail: "Sueldos"
      };
    }
  
    if (originType === "logistica") {
      const deliveriesById = backendRowsById(tables.entregas?.rows, "id_entrega");
      const freightsById = backendRowsById(tables.fletes?.rows, "id_flete");
      const delivery = linkedOrigin.row || deliveriesById.get(originId);
      const freight = freightsById.get(backendId(delivery?.id_flete));
      return {
        name: freight?.nombre_flete || "",
        cuit: normalizeBankCuit(freight?.cuit),
        detail: "Logistica"
      };
    }
  
    // Egresos historicos pueden no tener fila operativa enlazada. En esos casos
    // el import conserva el acreedor original en _id_acreedor.
    const historicalCreditor = creditorsById.get(backendId(expense._id_acreedor));
    if (historicalCreditor) {
      return {
        name: backendCreditorDisplayName(historicalCreditor, tables),
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
  
  function backendCreditorDisplayName(creditor, tables) {
    if (!creditor) return "";
    const originType = backendNormalizeText(creditor.origen_tipo_acreedor);
    const originId = backendId(creditor.origen_id_acreedor);
  
    if (originType === "proveedor") {
      return backendRowsById(tables.proveedores?.rows, "id_proveedor").get(originId)?.nombre || "";
    }
    if (originType === "empleado") {
      return backendRowsById(tables.empleados?.rows, "id_empleado").get(originId)?.nombre_empleado || "";
    }
    if (originType === "flete") {
      return backendRowsById(tables.fletes?.rows, "id_flete").get(originId)?.nombre_flete || "";
    }
    if (originType === "canal") {
      return backendRowsById(tables.canales?.rows, "id_canal").get(originId)?.nombre || "";
    }
    if (originType === "otros acreedores") {
      return backendRowsById(tables.otros_acreedores?.rows, "id_otro_acreedor").get(originId)?.nombre_otro_acreedor || "";
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

  return { backendCreditorDisplayName, backendCreditorTagNames, backendEconomicExpenseRows, backendExpenseCategoryTotals, backendExpenseCounterpartyInfo, backendExpenseLinkedOrigin, backendExpenseSourceConfigs, backendExpenseSourceTypeKey, backendExpenseSupplierName, backendStatementExpenseCategories, backendTagIdForName, backendTagNameForCreditorTagId, backendTagNameForId, backendTagNameMap, backendUncategorizedExpenseRows };
}

module.exports = { createExpenseClassificationService };
