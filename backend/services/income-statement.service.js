const {
  divide: divideMoney,
  fromCents,
  normalize: normalizeMoney,
  toCents
} = require("../../shared/money");

const INCOME_STATEMENT_DETAIL_LIMIT = 200;
const INCOME_STATEMENT_EXPENSE_CONCEPTS = Object.freeze({
  "cost.merchandise": { label: "Mercaderia", categories: ["Mercaderia"], composition: "merchandise" },
  "cost.commissions": { label: "Comisiones", categories: ["Comisiones"] },
  "cost.grossRevenueTax": { label: "Ingresos Brutos", categories: ["Ingresos Brutos"] },
  "cost.logistics": { label: "Logistica", categories: ["Logistica"] },
  "operating.salaries": { label: "Sueldos", categories: ["Sueldos"] },
  "operating.extraSalaries": { label: "Sueldos Extras", categories: ["Sueldos_Extras"] },
  "operating.admin": { label: "Administrativos", categories: ["Administrativos"] },
  "operating.services": { label: "Servicios", categories: ["Servicios", "Herramientas_De_Trabajo"] },
  "operating.rent": { label: "Alquiler", categories: ["Alquiler"] },
  "operating.maintenanceAndMisc": {
    label: "Mantenimiento y Varios",
    categories: ["Cadeteria", "Limpieza", "Varios", "Otros", "Incentivos_Personal"]
  },
  "nonOperating.otherTaxes": {
    label: "Otros Impuestos",
    categories: ["Impuesto Cred", "Impuesto Deb", "Impuesto Sello", "Impuestos Internos", "Otros Impuestos"]
  },
  "nonOperating.bankFees": { label: "Gastos Bancarios", categories: ["Gastos Bancarios"] },
  "nonOperating.interest": { label: "Intereses", categories: ["Intereses", "Rendimiento Fondo"] },
  "nonOperating.generalInvestment": {
    label: "Inversion General",
    categories: ["Inversion General", "Maquinaria"]
  }
});
const INCOME_STATEMENT_SALES_CONCEPTS = Object.freeze({
  "sales.schools": { label: "Escuelas", school: true },
  "sales.other": { label: "Otros", school: false }
});
const INCOME_STATEMENT_DETAIL_CONCEPTS = Object.freeze({
  ...INCOME_STATEMENT_SALES_CONCEPTS,
  ...INCOME_STATEMENT_EXPENSE_CONCEPTS
});

function createIncomeStatementService(dependencies) {
  const { backendExpenseCounterpartyInfo, backendExpenseCounterpartyMaps, backendGroupRowsById, backendId, backendIsoDate, backendIsSchoolClient, backendLastInventorySummary, backendMonthEndIso, backendMonthStartIso, backendNormalizeText, backendNumber, backendOffsetIsoDate, backendPayrollSummary, backendRowsById, backendStatementExpenseRows, backendUncategorizedExpenseRows, loadCache } = dependencies;

  function buildBackendIncomeStatementReport(year, month) {
    const cache = loadCache();
    const tables = cache.tables || {};
    const startIso = backendMonthStartIso(year, month);
    const endIso = backendMonthEndIso(year, month);
    const dayBeforeStartIso = backendOffsetIsoDate(startIso, -1);
  
    const clientsById = backendRowsById(tables.clientes?.rows, "id_cliente");
    const deliveriesById = backendRowsById(tables.entregas?.rows, "id_entrega");
    const productsById = backendRowsById(tables.productos?.rows, "id_producto");
    const productByItemId = backendRowsById(tables.productos?.rows, "id_item");
    const itemsById = backendRowsById(tables.items?.rows, "id_item");
    const ordersById = backendRowsById(tables.pedidos?.rows, "id_pedido");
    const detailsByOrder = backendGroupRowsById(tables.detalle_pedidos?.rows, "id_pedido");
    const inventoryById = backendRowsById(tables.inventarios?.rows, "id_inventario");
    const inventoryDetailsByInventory = backendGroupRowsById(tables.detalle_inventarios?.rows, "id_inventario");
  
    const { monthlySales, salesDateIssues } = selectMonthlySalesByDeliveryDate({
      sales: tables.ventas?.rows || [],
      deliveriesById,
      startIso,
      endIso,
      backendId,
      backendIsoDate
    });
  
    const salesBucketCents = { schools: 0, other: 0 };
    let salesNetCents = 0;
    const customers = new Set();
    const orderIds = new Set();
  
    monthlySales.forEach((sale) => {
      const amountCents = toCents(backendNumber(sale.subtotal));
      salesNetCents += amountCents;
      const client = clientsById.get(backendId(sale.id_cliente));
      if (client?.id_cliente !== undefined) customers.add(backendId(client.id_cliente));
      if (backendIsSchoolClient(client)) salesBucketCents.schools += amountCents;
      else salesBucketCents.other += amountCents;
      if (sale.id_pedido !== undefined && sale.id_pedido !== "") orderIds.add(backendId(sale.id_pedido));
    });
    const salesNet = fromCents(salesNetCents);
    const salesBuckets = {
      schools: fromCents(salesBucketCents.schools),
      other: fromCents(salesBucketCents.other)
    };
    const detailCounts = {
      "sales.schools": monthlySales.filter((sale) => {
        return backendIsSchoolClient(clientsById.get(backendId(sale.id_cliente)));
      }).length,
      "sales.other": monthlySales.filter((sale) => {
        return !backendIsSchoolClient(clientsById.get(backendId(sale.id_cliente)));
      }).length
    };
  
    let unitsSold = 0;
    const monthlyOrderDetails = [];
    orderIds.forEach((orderId) => {
      (detailsByOrder.get(orderId) || []).forEach((detail) => {
        const product = productsById.get(backendId(detail.id_producto));
        const order = ordersById.get(orderId);
        const quantity = backendNumber(detail.cantidad_cajas) * backendNumber(product?.cantidad_individual || 1);
        unitsSold += quantity;
        monthlyOrderDetails.push({
          date: backendIsoDate(order?.fecha_entrega || order?.fecha_pedido),
          orderId,
          productId: detail.id_producto,
          individualQuantity: quantity,
          customer: clientsById.get(backendId(order?.id_cliente))?.nombre_cliente || ""
        });
      });
    });
  
    const statementExpenseRows = backendStatementExpenseRows(tables, startIso, endIso);
    const uncategorized = backendUncategorizedExpenseRows(tables, startIso, endIso);
    const expenseSubtotal = (categories) => {
      const normalized = new Set(categories.map(backendNormalizeText));
      const cents = statementExpenseRows.reduce((total, expense) => {
        return normalized.has(backendNormalizeText(expense.category))
          ? total + toCents(expense.amount)
          : total;
      }, 0);
      return fromCents(cents);
    };
    Object.entries(INCOME_STATEMENT_EXPENSE_CONCEPTS).forEach(([key, concept]) => {
      const normalized = new Set(concept.categories.map(backendNormalizeText));
      detailCounts[key] = statementExpenseRows.filter((expense) => (
        normalized.has(backendNormalizeText(expense.category))
      )).length;
    });
  
    const initialInventory = normalizeInventoryValue(backendLastInventorySummary(
      tables,
      "",
      dayBeforeStartIso,
      inventoryById,
      inventoryDetailsByInventory,
      productByItemId,
      itemsById
    ), backendNumber);
    const finalInventory = normalizeInventoryValue(backendLastInventorySummary(
      tables,
      startIso,
      endIso,
      inventoryById,
      inventoryDetailsByInventory,
      productByItemId,
      itemsById
    ), backendNumber);
    detailCounts["cost.merchandise"] += Number(Boolean(initialInventory)) + Number(Boolean(finalInventory));
    const payrollRowsForHours = tables.sueldos?.rows || [];
    const payroll = backendPayrollSummary(payrollRowsForHours, startIso, endIso);
    const production = {
      initial: initialInventory,
      final: finalInventory,
      unitsSold,
      calculatedUnits: unitsSold + (finalInventory?.units || 0) - (initialInventory?.units || 0),
      unitsPerHour: 0
    };
    production.unitsPerHour = payroll.totalHours ? production.calculatedUnits / payroll.totalHours : 0;
  
    const merchandisePurchases = expenseSubtotal(["Mercaderia"]);
    const merchandiseCost = fromCents(
      toCents(initialInventory?.value || 0)
      + toCents(merchandisePurchases)
      - toCents(finalInventory?.value || 0)
    );
    const costOfSales = {
      merchandise: merchandiseCost,
      merchandiseInitialInventory: initialInventory?.value || 0,
      merchandisePurchases,
      merchandiseFinalInventory: finalInventory?.value || 0,
      commissions: expenseSubtotal(["Comisiones"]),
      grossRevenueTax: expenseSubtotal(["Ingresos Brutos"]),
      logistics: expenseSubtotal(["Logistica"])
    };
    const totalCostOfSales = sumMoney([
      merchandiseCost,
      costOfSales.commissions,
      costOfSales.grossRevenueTax,
      costOfSales.logistics
    ]);
    const grossMargin = subtractMoney(salesNet, totalCostOfSales);
  
    const operatingExpenses = {
      salaries: normalizeMoney(expenseSubtotal(["Sueldos"])),
      extraSalaries: expenseSubtotal(["Sueldos_Extras"]),
      admin: expenseSubtotal(["Administrativos"]),
      services: expenseSubtotal(["Servicios", "Herramientas_De_Trabajo"]),
      rent: expenseSubtotal(["Alquiler"]),
      maintenanceAndMisc: expenseSubtotal(["Cadeteria", "Limpieza", "Varios", "Otros", "Incentivos_Personal"])
    };
    const totalOperatingExpenses = sumMoney(Object.values(operatingExpenses));
    const operatingResult = subtractMoney(grossMargin, totalOperatingExpenses);
  
    const nonOperatingExpenses = {
      otherTaxes: expenseSubtotal(["Impuesto Cred", "Impuesto Deb", "Impuesto Sello", "Impuestos Internos"]),
      bankFees: expenseSubtotal(["Gastos Bancarios"]),
      interest: expenseSubtotal(["Intereses", "Rendimiento Fondo"]),
      generalInvestment: expenseSubtotal(["Inversion General", "Maquinaria"])
    };
    const totalNonOperatingExpenses = sumMoney(Object.values(nonOperatingExpenses));
    const netResult = subtractMoney(operatingResult, totalNonOperatingExpenses);
  
    return {
      source: "backend",
      year,
      month,
      startIso,
      endIso,
      monthlyOrderDetails,
      monthlyPayroll: payroll.rows,
      unitsSold,
      customerCount: customers.size,
      averagePrice: unitsSold ? divideMoney(salesNet, unitsSold) : 0,
      payroll,
      production,
      salesNet,
      salesBuckets,
      costOfSales,
      totalCostOfSales,
      operatingExpenses,
      totalOperatingExpenses,
      nonOperatingExpenses,
      totalNonOperatingExpenses,
      initialInventory,
      finalInventory,
      grossMargin,
      operatingResult,
      netResult,
      uncategorized,
      salesDateIssues,
      detailCounts
    };
  }

  buildBackendIncomeStatementReport.buildDetail = buildBackendIncomeStatementDetail;
  return buildBackendIncomeStatementReport;

  function buildBackendIncomeStatementDetail(year, month, conceptKey, pagination = {}) {
    const concept = INCOME_STATEMENT_DETAIL_CONCEPTS[conceptKey];
    if (!concept) throw statementDetailError("INCOME_STATEMENT_CONCEPT_INVALID", "Concepto invalido.", 400);

    const offset = normalizedPaginationInteger(pagination.offset, 0);
    const requestedLimit = normalizedPaginationInteger(pagination.limit, INCOME_STATEMENT_DETAIL_LIMIT);
    const limit = Math.min(requestedLimit || INCOME_STATEMENT_DETAIL_LIMIT, INCOME_STATEMENT_DETAIL_LIMIT);
    const cache = loadCache();
    const tables = cache.tables || {};
    const startIso = backendMonthStartIso(year, month);
    const endIso = backendMonthEndIso(year, month);
    const detailRows = concept.composition === "merchandise"
      ? buildMerchandiseDetailRows(tables, startIso, endIso, concept)
      : concept.categories
        ? buildExpenseDetailRows(tables, startIso, endIso, concept)
        : buildSalesDetailRows(tables, startIso, endIso, concept);
    const sortedRows = detailRows.sort((left, right) => {
      return left.date.localeCompare(right.date)
        || String(left.reference).localeCompare(String(right.reference))
        || String(left.id).localeCompare(String(right.id));
    });
    const total = fromCents(sortedRows.reduce((sum, row) => sum + toCents(row.amount), 0));
    const rows = sortedRows.slice(offset, offset + limit).map(({ id: _id, ...row }) => row);

    return {
      concept: conceptKey,
      label: concept.label,
      period: { year, month, startIso, endIso },
      count: sortedRows.length,
      total,
      offset,
      limit,
      pageTotal: fromCents(rows.reduce((sum, row) => sum + toCents(row.amount), 0)),
      hasMore: offset + rows.length < sortedRows.length,
      reconciled: true,
      rows
    };
  }

  function buildExpenseDetailRows(tables, startIso, endIso, concept) {
    const normalizedCategories = new Set(concept.categories.map(backendNormalizeText));
    const counterpartyMaps = backendExpenseCounterpartyMaps(tables);
    return backendStatementExpenseRows(tables, startIso, endIso)
      .filter((expense) => normalizedCategories.has(backendNormalizeText(expense.category)))
      .map((expense) => {
        const rawExpense = expense.raw || expense;
        const counterparty = backendExpenseCounterpartyInfo(rawExpense, tables, { maps: counterpartyMaps });
        const movement = backendNormalizeText(expense.movementType);
        const movementLabel = movement === "reversion"
          ? "Reversion"
          : movement === "ajuste"
            ? "Ajuste"
            : "";
        const referenceParts = [
          expense.concept || counterparty.detail || expense.source,
          movementLabel,
          expense.reason
        ].filter(Boolean);
        return {
          id: backendId(expense.id),
          date: expense.date,
          counterparty: counterparty.name || "",
          reference: referenceParts.join(" · "),
          amount: normalizeMoney(expense.amount)
        };
      });
  }

  function buildMerchandiseDetailRows(tables, startIso, endIso, concept) {
    const inventoryById = backendRowsById(tables.inventarios?.rows, "id_inventario");
    const inventoryDetailsByInventory = backendGroupRowsById(tables.detalle_inventarios?.rows, "id_inventario");
    const productByItemId = backendRowsById(tables.productos?.rows, "id_item");
    const itemsById = backendRowsById(tables.items?.rows, "id_item");
    const initialInventory = normalizeInventoryValue(backendLastInventorySummary(
      tables,
      "",
      backendOffsetIsoDate(startIso, -1),
      inventoryById,
      inventoryDetailsByInventory,
      productByItemId,
      itemsById
    ), backendNumber);
    const finalInventory = normalizeInventoryValue(backendLastInventorySummary(
      tables,
      startIso,
      endIso,
      inventoryById,
      inventoryDetailsByInventory,
      productByItemId,
      itemsById
    ), backendNumber);
    const rows = buildExpenseDetailRows(tables, startIso, endIso, concept);

    if (initialInventory) {
      rows.push({
        id: "inventory-initial",
        date: initialInventory.date || startIso,
        counterparty: "",
        reference: "Componente de valuacion · Inventario inicial",
        amount: normalizeMoney(initialInventory.value)
      });
    }
    if (finalInventory) {
      rows.push({
        id: "inventory-final",
        date: finalInventory.date || endIso,
        counterparty: "",
        reference: "Componente de valuacion · Inventario final (resta)",
        amount: fromCents(-toCents(finalInventory.value))
      });
    }

    return rows;
  }

  function buildSalesDetailRows(tables, startIso, endIso, concept) {
    const clientsById = backendRowsById(tables.clientes?.rows, "id_cliente");
    const deliveriesById = backendRowsById(tables.entregas?.rows, "id_entrega");
    const { monthlySales } = selectMonthlySalesByDeliveryDate({
      sales: tables.ventas?.rows || [],
      deliveriesById,
      startIso,
      endIso,
      backendId,
      backendIsoDate
    });

    return monthlySales
      .filter((sale) => {
        const client = clientsById.get(backendId(sale.id_cliente));
        return backendIsSchoolClient(client) === concept.school;
      })
      .map((sale) => {
        const client = clientsById.get(backendId(sale.id_cliente));
        const delivery = deliveriesById.get(backendId(sale.id_entrega));
        const document = [sale.tipo_factura, sale.nro_factura].filter(Boolean).join(" ");
        return {
          id: backendId(sale.id_venta),
          date: backendIsoDate(delivery?.fecha),
          counterparty: client?.nombre_cliente || "",
          reference: [document, `Venta #${backendId(sale.id_venta)}`].filter(Boolean).join(" · "),
          amount: normalizeMoney(backendNumber(sale.subtotal))
        };
      });
  }
}

function sumMoney(values) {
  return fromCents(values.reduce((total, value) => total + toCents(value), 0));
}

function subtractMoney(minuend, ...subtrahends) {
  return fromCents(
    toCents(minuend) - subtrahends.reduce((total, value) => total + toCents(value), 0)
  );
}

function normalizeInventoryValue(inventory, backendNumber) {
  if (!inventory) return inventory;
  return { ...inventory, value: normalizeMoney(backendNumber(inventory.value)) };
}

function normalizedPaginationInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw statementDetailError("INCOME_STATEMENT_PAGINATION_INVALID", "Paginacion invalida.", 400);
  }
  return number;
}

function statementDetailError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function selectMonthlySalesByDeliveryDate({
  sales,
  deliveriesById,
  startIso,
  endIso,
  backendId,
  backendIsoDate
}) {
  const monthlySales = [];
  const salesDateIssues = [];
  const seenSaleIds = new Set();

  sales.forEach((sale) => {
    const saleId = backendId(sale.id_venta);
    if (saleId && seenSaleIds.has(saleId)) return;
    if (saleId) seenSaleIds.add(saleId);

    const deliveryId = backendId(sale.id_entrega);
    const delivery = deliveryId ? deliveriesById.get(deliveryId) : undefined;
    const deliveryDate = backendIsoDate(delivery?.fecha);

    let reason = "";
    if (!deliveryId) reason = "missing_delivery_id";
    else if (!delivery) reason = "delivery_not_found";
    else if (!isValidIsoCalendarDate(deliveryDate)) reason = "invalid_delivery_date";

    if (reason) {
      salesDateIssues.push({
        id_venta: saleId,
        id_entrega: deliveryId,
        reason
      });
      return;
    }

    if (deliveryDate >= startIso && deliveryDate <= endIso) monthlySales.push(sale);
  });

  return { monthlySales, salesDateIssues };
}

function isValidIsoCalendarDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

module.exports = { createIncomeStatementService };
