function createRequestHandler(dependencies) {
  const {
    applyRequestAccess,
    backendColumnsMap,
    backendOverview,
    backendSchema,
    handlers,
    sendJson,
    serveStaticFile,
  } = dependencies;

  const exactRoutes = [
    ["POST", "/api/bank-reconciliation/analyze", handlers.handleBankReconciliationAnalyze],
    ["POST", "/api/bank-reconciliation/apply", handlers.handleBankReconciliationApply],
    ["POST", "/api/bank-reconciliation/deposit-checks", handlers.handleBankReconciliationDepositChecks],
    ["GET", "/api/bank-reconciliation/summary", handlers.handleBankReconciliationSummary],
    ["POST", "/api/treasury/collections", handlers.handleCollectionFullEntry],
    ["POST", "/api/treasury/payments", handlers.handlePaymentFullEntry],
    ["GET", "/api/treasury/investment-fund", handlers.handleInvestmentFundList],
    ["POST", "/api/treasury/investment-fund", handlers.handleInvestmentFundCreate],
    ["POST", "/api/treasury/partner-contributions", handlers.handlePartnerContributionFullEntry],
    ["GET", "/api/treasury/received-checks/pending-endorsement-payments", handlers.handlePendingEndorsementPaymentsList],
    ["POST", "/api/treasury/received-checks/endorse", handlers.handleReceivedChecksEndorse],
    ["GET", "/api/treasury/payment-plans", handlers.handlePaymentPlansList],
    ["POST", "/api/treasury/payment-plans", handlers.handlePaymentPlanCreate],
    ["POST", "/api/sales/orders/full-entry", handlers.handleSalesOrderFullEntry],
    ["POST", "/api/backend/sql", handlers.handleBackendSqlQuery],
    ["POST", "/api/reception-attachments", handlers.handleReceptionAttachmentSave],
    ["POST", "/api/reception-invoice/read", handlers.handleReceptionInvoiceRead],
    ["POST", "/api/receptions/full-entry", handlers.handleReceptionFullEntry],
    ["POST", "/api/other-expenses/full-entry", handlers.handleOtherExpenseFullEntry],
    ["POST", "/api/payroll-scale/read", handlers.handlePayrollScaleRead],
    ["POST", "/api/payroll/expenses", handlers.handlePayrollExpenseEntry],
    ["POST", "/api/creditors/create", handlers.handleCreditorCreate],
    ["POST", "/api/app-state", handlers.handleAppStateSave],
    ["POST", "/api/inventory/append", handlers.handleInventoryAppend],
    ["GET", "/api/inventory/latest-date", handlers.handleInventoryLatestDate],
    ["POST", "/api/inventory/full-entry", handlers.handleInventoryFullEntry],
    ["GET", "/api/inventory/purchase-snapshot", handlers.handleInventoryPurchaseSnapshot],
    ["POST", "/api/inventory/purchase-snapshot/production-rate", handlers.handleInventoryPurchaseProductionRate],
    ["GET", "/api/inventory-detail/template", handlers.handleInventoryDetailTemplate],
    ["POST", "/api/inventory-detail/append", handlers.handleInventoryDetailAppend],
    ["POST", "/api/inventory-detail/photo", handlers.handleInventoryDetailPhoto],
    ["POST", "/api/purchases/full-entry", handlers.handlePurchaseFullEntry]
  ];

  return async function handleRequest(request, response) {
    try {
      if (!await applyRequestAccess(request, response)) return;

      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }

      if (request.url === "/api/health") return sendJson(response, 200, { ok: true });
      if (request.url === "/api/backend/schema" && request.method === "GET") {
        return sendJson(response, 200, { ok: true, schema: backendSchema() });
      }
      if (request.url === "/api/backend/tables" && request.method === "GET") {
        return sendJson(response, 200, { ok: true, ...backendOverview() });
      }
      if (request.url === "/api/backend/map" && request.method === "GET") {
        return sendJson(response, 200, { ok: true, map: backendColumnsMap() });
      }
      if (request.url === "/api/admin/tables" && request.method === "GET") {
        return handlers.handleAdminTablesOverview(request, response);
      }
      const adminPath = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`).pathname;
      if (/^\/api\/admin\/tables\/[^/]+\/cell$/.test(adminPath) && request.method === "PATCH") {
        return await handlers.handleAdminTableCellUpdate(request, response);
      }
      if (request.url.startsWith("/api/admin/tables/") && request.method === "POST") {
        return await handlers.handleAdminTableSave(request, response);
      }
      if (request.url.startsWith("/api/admin/tables/") && request.method === "GET") {
        return handlers.handleAdminTableRequest(request, response);
      }
      if (request.url.startsWith("/api/reports/income-statement/economic-comparison") && request.method === "GET") {
        return handlers.handleEconomicExpenseComparison(request, response);
      }
      if (request.url.startsWith("/api/reports/income-statement") && request.method === "GET") {
        return await handlers.handleIncomeStatementReport(request, response);
      }
      if (request.url.startsWith("/api/reports/cashflow") && request.method === "GET") {
        return await handlers.handleCashflowReport(request, response);
      }
      const bankReconciliationPath = new URL(
        request.url,
        `http://${request.headers.host || "127.0.0.1"}`
      ).pathname;
      if (bankReconciliationPath === "/api/bank-reconciliation/state" && request.method === "GET") {
        return await handlers.handleBankReconciliationState(request, response);
      }
      const paymentPlanRoute = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`).pathname
        .match(/^\/api\/treasury\/payment-plans\/[^/]+(?:\/quotas(?:\/[^/]+(?:\/delete)?)?)?$/);
      if (paymentPlanRoute) {
        const hasQuotaId = /\/quotas\/[^/]+(?:\/delete)?$/.test(paymentPlanRoute[0]);
        const isQuotaCollection = /\/quotas$/.test(paymentPlanRoute[0]);
        if (request.method === "GET" && !hasQuotaId && !isQuotaCollection) {
          return handlers.handlePaymentPlanGet(request, response);
        }
        if (request.method === "POST" && isQuotaCollection) {
          return await handlers.handlePaymentPlanQuotaAdd(request, response);
        }
        if (request.method === "POST" && hasQuotaId && request.url.endsWith("/delete")) {
          return await handlers.handlePaymentPlanQuotaDelete(request, response);
        }
        if (request.method === "POST" && hasQuotaId) {
          return await handlers.handlePaymentPlanQuotaUpdate(request, response);
        }
        if (request.method === "POST") return await handlers.handlePaymentPlanUpdate(request, response);
      }
      const economicPath = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`).pathname;
      if (economicPath === "/api/economic-expenses" && request.method === "GET") {
        return handlers.handleEconomicExpensesList(request, response);
      }
      if (economicPath === "/api/economic-expenses/drafts" && request.method === "POST") {
        return handlers.handleEconomicExpenseDraftCreate(request, response);
      }
      if (economicPath === "/api/economic-expenses/applications" && request.method === "POST") {
        return handlers.handleEconomicExpenseApplicationCreate(request, response);
      }
      if (/^\/api\/economic-expenses\/reconciliation\/expenses\/[^/]+$/.test(economicPath) && request.method === "GET") {
        return handlers.handleEconomicExpenseReconciliation(request, response);
      }
      const applicationAction = economicPath.match(/^\/api\/economic-expenses\/applications\/[^/]+\/(replace|reverse)$/);
      if (applicationAction && request.method === "POST") {
        return applicationAction[1] === "replace"
          ? handlers.handleEconomicExpenseApplicationReplace(request, response)
          : handlers.handleEconomicExpenseApplicationReverse(request, response);
      }
      const economicAction = economicPath.match(/^\/api\/economic-expenses\/[^/]+\/(draft|confirm|discard|adjustments|reversals)$/);
      if (economicAction && request.method === "POST") {
        const actionHandlers = {
          draft: handlers.handleEconomicExpenseDraftUpdate,
          confirm: handlers.handleEconomicExpenseConfirm,
          discard: handlers.handleEconomicExpenseDiscard,
          adjustments: handlers.handleEconomicExpenseAdjustment,
          reversals: handlers.handleEconomicExpenseReversal
        };
        return actionHandlers[economicAction[1]](request, response);
      }
      if (/^\/api\/economic-expenses\/[^/]+$/.test(economicPath) && request.method === "GET") {
        return handlers.handleEconomicExpenseGet(request, response);
      }
      if (request.url.startsWith("/api/backend/tables/") && request.method === "POST") {
        return await handlers.handleBackendTableSave(request, response);
      }
      if (request.url.startsWith("/api/backend/tables/") && request.method === "GET") {
        return await handlers.handleBackendTableRequest(request, response);
      }
      if (request.url === "/api/app-state" && request.method === "GET") {
        return await handlers.handleAppStateGet(response);
      }

      const route = exactRoutes.find(([method, pathname]) => method === request.method && pathname === request.url);
      if (route) {
        const handler = route[2];
        if (request.method === "GET" && [
          "/api/inventory/latest-date",
          "/api/inventory/purchase-snapshot",
          "/api/inventory-detail/template"
        ].includes(request.url)) return await handler(response);
        return await handler(request, response);
      }

      if (request.url.startsWith("/api/")) {
        return sendJson(response, 404, { error: "Endpoint no encontrado." });
      }
      return serveStaticFile(request, response);
    } catch (error) {
      console.error(error);
      return sendJson(response, 500, { error: "Error interno del servidor." });
    }
  };
}

module.exports = { createRequestHandler };
