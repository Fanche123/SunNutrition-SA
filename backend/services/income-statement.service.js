const {
  divide: divideMoney,
  fromCents,
  multiplyCents,
  normalize: normalizeMoney,
  percentageCents,
  toCents
} = require("../../shared/money");

function createIncomeStatementService(dependencies) {
  const { backendExpenseCategoryTotals, backendGroupRowsById, backendId, backendIsGrossRevenueTaxInvoice, backendIsoDate, backendIsSchoolClient, backendLastInventorySummary, backendMonthEndIso, backendMonthStartIso, backendNormalizeText, backendNumber, backendOffsetIsoDate, backendPayrollSummary, backendRate, backendRowsById, backendUncategorizedExpenseRows, loadCache } = dependencies;

  function buildBackendIncomeStatementReport(year, month) {
    const cache = loadCache();
    const tables = cache.tables || {};
    const startIso = backendMonthStartIso(year, month);
    const endIso = backendMonthEndIso(year, month);
    const dayBeforeStartIso = backendOffsetIsoDate(startIso, -1);
  
    const clientsById = backendRowsById(tables.clientes?.rows, "id_cliente");
    const channelsById = backendRowsById(tables.canales?.rows, "id_canal");
    const productsById = backendRowsById(tables.productos?.rows, "id_producto");
    const productByItemId = backendRowsById(tables.productos?.rows, "id_item");
    const itemsById = backendRowsById(tables.items?.rows, "id_item");
    const ordersById = backendRowsById(tables.pedidos?.rows, "id_pedido");
    const detailsByOrder = backendGroupRowsById(tables.detalle_pedidos?.rows, "id_pedido");
    const inventoryById = backendRowsById(tables.inventarios?.rows, "id_inventario");
    const inventoryDetailsByInventory = backendGroupRowsById(tables.detalle_inventarios?.rows, "id_inventario");
  
    const monthlySales = (tables.ventas?.rows || []).filter((sale) => {
      const date = backendIsoDate(sale.fecha_factura);
      return date >= startIso && date <= endIso;
    });
  
    const salesBucketCents = { schools: 0, other: 0 };
    let salesNetCents = 0;
    let grossRevenueTaxBaseCents = 0;
    let channelCommissionCents = 0;
    const customers = new Set();
    const orderIds = new Set();
  
    monthlySales.forEach((sale) => {
      const amountCents = toCents(backendNumber(sale.subtotal));
      salesNetCents += amountCents;
      const client = clientsById.get(backendId(sale.id_cliente));
      if (backendIsGrossRevenueTaxInvoice(sale.tipo_factura)) grossRevenueTaxBaseCents += amountCents;
      const channel = channelsById.get(backendId(client?.id_canal));
      channelCommissionCents += multiplyCents(
        fromCents(amountCents),
        backendRate(channel?.comision)
      );
      if (client?.id_cliente !== undefined) customers.add(backendId(client.id_cliente));
      if (backendIsSchoolClient(client)) salesBucketCents.schools += amountCents;
      else salesBucketCents.other += amountCents;
      if (sale.id_pedido !== undefined && sale.id_pedido !== "") orderIds.add(backendId(sale.id_pedido));
    });
    const salesNet = fromCents(salesNetCents);
    const grossRevenueTaxBase = fromCents(grossRevenueTaxBaseCents);
    const channelCommissionCost = fromCents(channelCommissionCents);
    const salesBuckets = {
      schools: fromCents(salesBucketCents.schools),
      other: fromCents(salesBucketCents.other)
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
  
    const expenseCategories = backendExpenseCategoryTotals(tables, startIso, endIso);
    const uncategorized = backendUncategorizedExpenseRows(tables, startIso, endIso);
    const expenseSubtotal = (categories) => {
      const normalized = new Set(categories.map(backendNormalizeText));
      const cents = Object.entries(expenseCategories).reduce((total, [category, value]) => {
        return normalized.has(backendNormalizeText(category))
          ? total + toCents(backendNumber(value))
          : total;
      }, 0);
      return fromCents(cents);
    };
  
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
      commissions: expenseSubtotal(["Comisiones"]) || channelCommissionCost,
      grossRevenueTax: fromCents(percentageCents(grossRevenueTaxBase, 1.5)),
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
      salaries: normalizeMoney(payroll.totalGross || expenseSubtotal(["Sueldos"])),
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
      uncategorized
    };
  }

  return buildBackendIncomeStatementReport;
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

module.exports = { createIncomeStatementService };
