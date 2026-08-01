const crypto = require("crypto");
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const {
  backendOverview,
  backendSchema,
  backendTable,
  appendAdminAudit,
  ensureAdminSessionBackup,
  loadCache,
  loadRegistry,
  saveBackendCache
} = require("./backend/data-store");
const { DEFAULT_BANK_DETAIL_RULES } = require("./backend/bank-rules");
const {
  APP_STATE_FILE,
  BACKEND_CACHE_FILE,
  BACKEND_SQL_SCRIPT,
  PYTHON_EXECUTABLE,
  ROOT_DIR
} = require("./backend/config/paths");
const { MIME_TYPES } = require("./backend/http-config");
const { createAccessConfig } = require("./backend/config/access");
const { ADMIN_TABLE_POLICY } = require("./backend/config/admin-table-policy");
const { createQueryLimits } = require("./backend/config/query-limits");
const { backfillHistoricalEconomicExpenses } = require("./backend/migrations/20260727-economic-expenses-history");
const { readAppState, writeAppState } = require("./backend/repositories/app-state.repository");
const { createRequestHandler } = require("./backend/routes/router");
const { createAccessControl } = require("./backend/services/access-control.service");
const { createAdminTableService } = require("./backend/services/admin-table.service");
const { createPartnerContributionsService } = require("./backend/services/partner-contributions.service");
const { createPaymentPlansService } = require("./backend/services/payment-plans.service");
const { createCollectionEntryService } = require("./backend/services/collection-entry.service");
const { createPaymentEntryService } = require("./backend/services/payment-entry.service");
const { createCashBoxesService } = require("./backend/services/cash-boxes.service");
const { createReceivedChecksService } = require("./backend/services/received-checks.service");
const { createInvestmentFundService } = require("./backend/services/investment-fund.service");
const { createSalesOrderEntryService } = require("./backend/services/sales-order-entry.service");
const { createSalesInvoiceEntryService } = require("./backend/services/sales-invoice-entry.service");
const { createArcaInvoicingService } = require("./backend/services/arca-invoicing.service");
const { createSalesWorkflowService } = require("./backend/services/sales-workflow.service");
const { createAttachmentsService } = require("./backend/services/attachments.service");
const { createOtherExpenseEntryService } = require("./backend/services/other-expense-entry.service");
const { createReceptionEntryService } = require("./backend/services/reception-entry.service");
const { createCashflowService } = require("./backend/services/cashflow.service");
const { createBackendTableService } = require("./backend/services/backend-table.service");
const { createBankReconciliationService } = require("./backend/services/bank-reconciliation.service");
const { createBankPersistenceService } = require("./backend/services/bank-persistence.service");
const { createBankParserService } = require("./backend/services/bank-parser.service");
const { createBankMatchingService } = require("./backend/services/bank-matching.service");
const { createBankReferenceService } = require("./backend/services/bank-reference.service");
const { createInventoryEntryService } = require("./backend/services/inventory-entry.service");
const { createInventoryPurchaseSnapshotService } = require("./backend/services/inventory-purchase-snapshot.service");
const { payrollCalendarForYear } = require("./assets/js/config/payroll-calendars");
const {
  filterInventoryRowsBySelectedShifts,
  inventoryPhotoReviewPrompt,
  inventoryPhotoTranscriptionPrompt,
  mapTranscriptionToInventoryRows,
  mergeInventoryPhotoRows,
  normalizeInventoryPhotoTranscription,
  normalizeInventoryToken
} = require("./backend/services/inventory-photo-mapping.service");
const { createInventoryPhotoService } = require("./backend/services/inventory-photo.service");
const { createExpenseClassificationService } = require("./backend/services/expense-classification.service");
const { createPayrollSummaryService } = require("./backend/services/payroll-summary.service");
const { createPayrollNormalizationService } = require("./backend/services/payroll-normalization.service");
const { createPayrollExpenseEntryService } = require("./backend/services/payroll-expense-entry.service");
const { createIncomeCalculationService } = require("./backend/services/income-calculation.service");
const { createIncomeStatementService } = require("./backend/services/income-statement.service");
const { createProductionReportService } = require("./backend/services/production-report.service");
const { createInventoryValuationService } = require("./backend/services/inventory-valuation.service");
const { createSqlService } = require("./backend/services/sql.service");
const { createCreditorEntryService } = require("./backend/services/creditor-entry.service");
const { createPurchaseEntryService } = require("./backend/services/purchase-entry.service");
const { createEconomicExpensesService } = require("./backend/services/economic-expenses.service");
const { createEconomicExpenseApplicationsService } = require("./backend/services/economic-expense-applications.service");
const { createEconomicExpenseComparisonService } = require("./backend/services/economic-expense-comparison.service");
const { createCoreHandlers } = require("./backend/services/core-handlers.service");
const { createBackendMapService } = require("./backend/services/backend-map.service");
const { createTableReadMetrics } = require("./backend/services/table-read-metrics.service");
const { serveStaticFile: serveStaticFileFromRoot } = require("./backend/utils/files");
const { readJsonBody, sendJson, setCorsHeaders } = require("./backend/utils/http");
const { backendGroupRowsById, backendId, backendRowsById } = require("./backend/utils/ids");
const { backendInventoryQuantity } = require("./backend/utils/inventory-numbers");
const {
  backendEditableColumns,
  backendEditablePrimaryKey,
  backendNextNumericId,
  cleanBackendInput,
  cleanBackendText,
  creditorOriginTypeKey,
  ensureBackendTable,
  isIsoDate,
  nextBusinessDayIso,
  normalizeHeader,
  normalizeLookupText,
  normalizePartnerName
} = require("./backend/utils/runtime");
const {
  createRuntimeSession,
  loadEnvFile,
  removeRuntimeLockIfOwned,
  safeTokenEquals,
  writeRuntimeLock
} = require("./backend/utils/server-runtime");
const {
  backendBankMatches: matchBackendBank,
  bankDateDistance,
  bankTextOverlapScore,
  compactBankText,
  extractBankCheckNumber,
  extractBankCuit,
  normalizeBankCheckNumber,
  normalizeBankCuit
} = require("./backend/utils/bank");

loadEnvFile(ROOT_DIR);

const accessConfig = createAccessConfig(process.env);
const runtimeSession = createRuntimeSession({
  rootDir: ROOT_DIR,
  host: accessConfig.host,
  port: accessConfig.port
});
const queryLimits = createQueryLimits(process.env);
const recordAllRowsRead = createTableReadMetrics({ config: queryLimits.allRows });
const runBackendSqlQuery = createSqlService({
  cacheFile: BACKEND_CACHE_FILE,
  limits: queryLimits.sql,
  pythonExecutable: PYTHON_EXECUTABLE,
  rootDir: ROOT_DIR,
  scriptFile: BACKEND_SQL_SCRIPT
});

const { EXPECTED_BACKEND_COLUMNS } = require('./backend/config/backend-columns');

const incomeCalculations = createIncomeCalculationService({
  backendGroupRowsById,
  backendId,
  backendInventoryQuantity,
  backendRowsById
});
const {
  backendComparisonPeriod,
  backendCurrentDateIso,
  backendIsGrossRevenueTaxInvoice,
  backendIsoDate,
  backendIsSchoolClient,
  backendLastInventorySummary,
  backendLatestSupplyCostMap,
  backendMonthEndIso,
  backendMonthStartIso,
  backendNormalizeText,
  backendNumber,
  backendObjectSum,
  backendOffsetIsoDate,
  backendRate,
  backendReceptionRecipeUnitCost,
  backendRecipeQuantity,
  backendTurnRank,
  normalizeBackendNumberText
} = incomeCalculations;
const backendBankMatches = (value, bank) => matchBackendBank(value, bank, backendNormalizeText);
const { backendInventoryItemCostMap, valueBackendInventories } = createInventoryValuationService({
  backendGroupRowsById,
  backendId,
  backendInventoryQuantity,
  backendIsoDate,
  backendLatestSupplyCostMap,
  backendNormalizeText,
  backendNumber,
  backendRecipeQuantity,
  backendRowsById,
  backendTurnRank,
  expectedBackendColumns: EXPECTED_BACKEND_COLUMNS
});
const expenseClassification = createExpenseClassificationService({
  backendId,
  backendIsoDate,
  backendNormalizeText,
  backendNumber,
  backendRowsById,
  cleanBackendText,
  normalizeBankCuit,
  normalizeLookupText
});
const {
  backendCreditorDisplayName,
  backendCreditorTagNames,
  backendExpenseCategoryTotals,
  backendExpenseCounterpartyInfo,
  backendExpenseCounterpartyMaps,
  backendExpenseLinkedOrigin,
  backendExpenseSourceConfigs,
  backendExpenseSourceTypeKey,
  backendExpenseSupplierName,
  backendStatementExpenseCategories,
  backendStatementExpenseRows,
  backendTagIdForName,
  backendTagNameForCreditorTagId,
  backendTagNameForId,
  backendTagNameMap,
  backendUncategorizedExpenseRows
} = expenseClassification;
const { normalizeBackendBankDetails, seedDefaultBankDetails } = createBankReferenceService({
  DEFAULT_BANK_DETAIL_RULES,
  EXPECTED_BACKEND_COLUMNS,
  backendCreditorDisplayName,
  backendId,
  backendNextNumericId,
  backendNormalizeText,
  cleanBackendText,
  ensureBackendTable,
  normalizeLookupText
});
const backendPayrollSummary = createPayrollSummaryService({ backendId, backendIsoDate, backendNumber });
const payrollNormalization = createPayrollNormalizationService({
  backendId,
  backendIsoDate,
  backendNextNumericId,
  creditorOriginTypeKey,
  ensureBackendTable,
  expectedBackendColumns: EXPECTED_BACKEND_COLUMNS
});
const {
  assignPayrollCreditorTags,
  ensureUniqueBackendSalaryIds,
  mergePayrollCalculationRowsIntoSalaries,
  sortBackendSalaryRows
} = payrollNormalization;
const buildBackendIncomeStatementReport = createIncomeStatementService({
  backendExpenseCategoryTotals,
  backendExpenseCounterpartyInfo,
  backendExpenseCounterpartyMaps,
  backendGroupRowsById,
  backendId,
  backendIsoDate,
  backendIsSchoolClient,
  backendLastInventorySummary,
  backendMonthEndIso,
  backendMonthStartIso,
  backendNormalizeText,
  backendNumber,
  backendObjectSum,
  backendOffsetIsoDate,
  backendPayrollSummary,
  backendRowsById,
  backendStatementExpenseRows,
  backendUncategorizedExpenseRows,
  loadCache
});
const buildBackendIncomeStatementDetail = buildBackendIncomeStatementReport.buildDetail;
const { buildProductionReport } = createProductionReportService({ loadCache });

const {
  handleInvoiceProviderHealth,
  handlePayrollScaleRead,
  handleReceptionAttachmentSave,
  handleReceptionInvoiceRead,
  handleSalesInvoiceRead
} = createAttachmentsService({
  childProcess,
  fs,
  path,
  pythonExecutable: PYTHON_EXECUTABLE,
  readJsonBody,
  rootDir: ROOT_DIR,
  sendJson
});
const buildBackendCashflowReport = createCashflowService({
  backendCreditorDisplayName,
  backendCurrentDateIso,
  backendExpenseSupplierName,
  backendId,
  backendIsoDate,
  backendNormalizeText,
  backendNumber,
  backendObjectSum,
  backendRowsById,
  loadCache
});
const {
  handleAppStateGet,
  handleAppStateSave,
  handleBackendSqlQuery,
  handleCashflowReport,
  handleIncomeStatementDetail,
  handleIncomeStatementReport,
  handleProductionReport
} = createCoreHandlers({
  APP_STATE_FILE,
  backendComparisonPeriod,
  buildBackendCashflowReport,
  buildBackendIncomeStatementDetail,
  buildBackendIncomeStatementReport,
  buildProductionReport,
  readAppState,
  readJsonBody,
  runBackendSqlQuery,
  sendJson,
  writeAppState
});
const backendColumnsMap = createBackendMapService({
  EXPECTED_BACKEND_COLUMNS,
  loadCache,
  loadRegistry,
  normalizeHeader
});
const {
  handleAdminTableCellUpdate,
  handleAdminTableDeletePreview,
  handleAdminTableRequest,
  handleAdminTableSave,
  handleAdminTablesOverview
} = createAdminTableService({
  appendAdminAudit,
  adminTablePolicy: ADMIN_TABLE_POLICY,
  backendEditableColumns,
  backendEditablePrimaryKey,
  backendId,
  backendNextNumericId,
  backendOverview,
  backendTable,
  loadCache,
  loadRegistry,
  readJsonBody,
  recordAllRowsRead,
  ensureAdminSessionBackup,
  saveBackendCache,
  sendJson,
  synchronizeEconomicExpenses: (cache) => backfillHistoricalEconomicExpenses(cache).cache
});
const { handleBackendTableRequest, handleBackendTableSave } = createBackendTableService({
  backendEditableColumns,
  backendEditablePrimaryKey,
  backendId,
  backendNextNumericId,
  backendTable,
  ensureBackendTable,
  expectedBackendColumns: EXPECTED_BACKEND_COLUMNS,
  loadCache,
  readJsonBody,
  recordAllRowsRead,
  saveBackendCache,
  sendJson,
  synchronizeEconomicExpenses: (cache) => backfillHistoricalEconomicExpenses(cache).cache
});
const bankPersistence = createBankPersistenceService({
  backendBankMatches,
  backendId,
  backendIsoDate,
  backendNextNumericId,
  backendNormalizeText,
  backendNumber,
  backendTagIdForName,
  cleanBackendText,
  compactBankText,
  crypto,
  ensureBackendTable,
  loadCache,
  normalizeBankCheckNumber,
  normalizeBankCuit,
  saveBackendCache
});
const {
  backendCreditorTagRelationId,
  backendPersistedBankMovementCounts,
  bankMovementAssociation,
  bankMovementBackendCreditorId,
  bankMovementFingerprint,
  bankSourceDestinationForOriginType,
  canonicalPendingBankMovements,
  consumePersistedBankMovement,
  createBankEgressForSource,
  createBankPaymentForExpense,
  createBankSourceExpense,
  importBankMovements,
  persistBankMovement,
  updateIssuedCheckFromBankMovement,
  updateReceivedCheckFromBankMovement
} = bankPersistence;
const bankMatching = createBankMatchingService({
  backendBankMatches,
  backendCreditorDisplayName,
  backendCreditorTagNames,
  backendCreditorTagRelationId,
  backendExpenseCounterpartyInfo,
  backendGroupRowsById,
  backendId,
  backendIsoDate,
  backendNormalizeText,
  backendNumber,
  backendRowsById,
  backendTagIdForName,
  backendTagNameForId,
  backendTagNameMap,
  bankDateDistance,
  bankMovementBackendCreditorId,
  bankSourceDestinationForOriginType,
  bankTextOverlapScore,
  cleanBackendText,
  compactBankText,
  normalizeBankCheckNumber,
  normalizeBankCuit
});
const {
  backendBankCollectionCandidates,
  backendBankCreditPayableCandidates,
  backendBankIdentityIndex,
  backendBankPayableCandidates,
  backendBankPaymentCandidates,
  backendBankSourceCandidates,
  backendIssuedChecksByNumber,
  backendReceivedCheckDepositGroups,
  backendReceivedChecksByNumber,
  bankManualCheckDepositMatch,
  bestBankMatch,
  bestBankSourceMatch,
  exactPendingExpenseMatch,
  identifyBankCounterparty,
  uniqueExactBankMatch
} = bankMatching;
const { analyzeBankMovement, parseBankMovements } = createBankParserService({
  backendIsoDate,
  backendNormalizeText,
  backendNumber,
  bankManualCheckDepositMatch,
  bankMovementBackendCreditorId,
  bankSourceDestinationForOriginType,
  bestBankMatch,
  bestBankSourceMatch,
  compactBankText,
  consumePersistedBankMovement,
  exactPendingExpenseMatch,
  extractBankCheckNumber,
  extractBankCuit,
  identifyBankCounterparty,
  normalizeBankCheckNumber,
  normalizeBankCuit,
  uniqueExactBankMatch
});
const inventoryPhoto = createInventoryPhotoService({
  cleanBackendInput,
  filterInventoryRowsBySelectedShifts,
  inventoryPhotoReviewPrompt,
  inventoryPhotoTranscriptionPrompt,
  isIsoDate,
  loadCache,
  mapTranscriptionToInventoryRows,
  mergeInventoryPhotoRows,
  normalizeInventoryPhotoTranscription,
  normalizeInventoryToken,
  readJsonBody,
  sendJson
});
const {
  defaultInventoryItemName,
  handleInventoryDetailPhoto,
  inventoryItemNameMap,
  normalizeInventoryDetailRows,
  normalizeSelectedInventoryShifts,
  resolveInventoryEmployeeId
} = inventoryPhoto;
const {
  buildInventoryPurchaseSnapshot,
  clearInventoryPurchaseSnapshot,
  readInventoryPurchaseSnapshot,
  storeInventoryPurchaseSnapshot,
  updateInventoryPurchaseConfig
} = createInventoryPurchaseSnapshotService({
  backendId,
  backendIsoDate,
  defaultInventoryItemName,
  payrollCalendarForYear
});
const {
  handleInventoryAppend,
  handleInventoryDetailAppend,
  handleInventoryDetailTemplate,
  handleInventoryFullEntry,
  handleInventoryLatestDate,
  handleInventoryPurchaseProductionRate,
  handleInventoryPurchaseSnapshot
} = createInventoryEntryService({
  backendId,
  backendIsoDate,
  backendNextNumericId,
  defaultInventoryItemName,
  ensureBackendTable,
  inventoryItemNameMap,
  isIsoDate,
  loadCache,
  nextBusinessDayIso,
  normalizeInventoryDetailRows,
  normalizeSelectedInventoryShifts,
  readJsonBody,
  readInventoryPurchaseSnapshot,
  resolveInventoryEmployeeId,
  saveBackendCache,
  sendJson,
  storeInventoryPurchaseSnapshot,
  buildInventoryPurchaseSnapshot,
  clearInventoryPurchaseSnapshot,
  updateInventoryPurchaseConfig,
  valueBackendInventories
});
const {
  handleBankReconciliationAnalyze,
  handleBankReconciliationApply,
  handleBankReconciliationDepositChecks,
  handleBankReconciliationState,
  handleBankReconciliationSummary
} = createBankReconciliationService({
  analyzeBankMovement,
  backendBankCollectionCandidates,
  backendBankCreditPayableCandidates,
  backendBankIdentityIndex,
  backendBankPayableCandidates,
  backendBankPaymentCandidates,
  backendBankSourceCandidates,
  backendCreditorDisplayName,
  backendId,
  backendIssuedChecksByNumber,
  backendNormalizeText,
  backendNumber,
  backendReceivedCheckDepositGroups,
  backendReceivedChecksByNumber,
  backendTagNameForId,
  bankMovementAssociation,
  bankMovementFingerprint,
  canonicalPendingBankMovements,
  cleanBackendText,
  createBankEgressForSource,
  createBankPaymentForExpense,
  createBankSourceExpense,
  ensureBackendTable,
  importBankMovements,
  loadCache,
  normalizeBackendBankDetails,
  parseBankMovements,
  persistBankMovement,
  readJsonBody,
  saveBackendCache,
  seedDefaultBankDetails,
  sendJson,
  updateIssuedCheckFromBankMovement,
  updateReceivedCheckFromBankMovement
});
const { handleCreditorCreate } = createCreditorEntryService({
  EXPECTED_BACKEND_COLUMNS,
  backendId,
  backendNextNumericId,
  backendNormalizeText,
  cleanBackendText,
  ensureBackendTable,
  loadCache,
  readJsonBody,
  saveBackendCache,
  sendJson
});
const applyRequestAccess = createAccessControl({
  accessConfig,
  sendJson,
  setCorsHeaders
});
const { handleCollectionFullEntry } = createCollectionEntryService({
  backendId,
  backendNextNumericId,
  backendNumber,
  ensureBackendTable,
  loadCache,
  readJsonBody,
  saveBackendCache,
  sendJson
});
const { handlePaymentFullEntry } = createPaymentEntryService({
  backendId,
  backendNextNumericId,
  backendNumber,
  ensureBackendTable,
  loadCache,
  readJsonBody,
  saveBackendCache,
  sendJson,
  synchronizeEconomicExpenses: (cache) => backfillHistoricalEconomicExpenses(cache).cache
});
const { handleCashBoxesGet } = createCashBoxesService({
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
});
const {
  handleCreate: handleInvestmentFundCreate,
  handleList: handleInvestmentFundList
} = createInvestmentFundService({
  backendId,
  backendNextNumericId,
  expectedBackendColumns: EXPECTED_BACKEND_COLUMNS,
  loadCache,
  readJsonBody,
  saveBackendCache,
  sendJson
});
const {
  handlePendingEndorsementPaymentsList,
  handleReceivedChecksEndorse
} = createReceivedChecksService({
  backendId,
  ensureBackendTable,
  loadCache,
  readJsonBody,
  saveBackendCache,
  sendJson
});
const { handlePayrollExpenseEntry } = createPayrollExpenseEntryService({
  backendId,
  backendNextNumericId,
  backendNumber,
  ensureBackendTable,
  loadCache,
  readJsonBody,
  saveBackendCache,
  sendJson
});
const { handlePartnerContributionFullEntry } = createPartnerContributionsService({
  backendId,
  backendNextNumericId,
  backendNumber,
  ensureBackendTable,
  loadCache,
  normalizePartnerName,
  readJsonBody,
  saveBackendCache,
  sendJson
});
const {
  handlePaymentPlanCreate,
  handlePaymentPlanGet,
  handlePaymentPlanQuotaAdd,
  handlePaymentPlanQuotaDelete,
  handlePaymentPlanQuotaUpdate,
  handlePaymentPlanUpdate,
  handlePaymentPlansList
} = createPaymentPlansService({
  backendId,
  backendIsoDate,
  backendNextNumericId,
  backendNumber,
  ensureBackendTable,
  isIsoDate,
  loadCache,
  normalizePartnerName,
  readJsonBody,
  saveBackendCache,
  sendJson,
  synchronizeEconomicExpenses: (cache) => backfillHistoricalEconomicExpenses(cache).cache
});
let salesWriteQueue = Promise.resolve();
function enqueueSalesWrite(operation) {
  const result = salesWriteQueue.then(operation);
  salesWriteQueue = result.catch(() => undefined);
  return result;
}

const { handleSalesOrderFullEntry } = createSalesOrderEntryService({
  backendId,
  backendNextNumericId,
  backendNumber,
  ensureBackendTable,
  isIsoDate,
  loadCache,
  readJsonBody,
  saveBackendCache,
  sendJson,
  enqueueSalesWrite
});
const {
  handleSalesDeliveryFullEntry,
  handleSalesInvoiceFullEntry,
  handleUnbilledOrdersGet
} = createSalesInvoiceEntryService({
  backendId,
  backendNextNumericId,
  ensureBackendTable,
  isIsoDate,
  loadCache,
  readJsonBody,
  saveBackendCache,
  sendJson,
  synchronizeEconomicExpenses: (cache) => backfillHistoricalEconomicExpenses(cache).cache,
  enqueueSalesWrite,
  crypto,
  fs,
  path,
  rootDir: ROOT_DIR
});
const {
  handleArcaConfirmation: handleSalesWorkflowArcaConfirmation,
  handleClose: handleSalesWorkflowClose,
  handleList: handleSalesWorkflowList
} = createSalesWorkflowService({
  backendId,
  backendNextNumericId,
  ensureBackendTable,
  loadCache,
  readJsonBody,
  saveBackendCache,
  sendJson,
  crypto,
  fs,
  path,
  rootDir: ROOT_DIR,
  enqueueSalesWrite
});
const {
  handleAuditGet: handleArcaAuditGet,
  handleAuditPost: handleArcaAuditPost,
  handleOrdersGet: handleArcaOrdersGet,
  handlePreparePost: handleArcaPreparePost
} = createArcaInvoicingService({
  auditFile: path.join(ROOT_DIR, "tmp", "arca-invoicing-audit.jsonl"),
  backendId,
  crypto,
  fs,
  loadCache,
  path,
  readJsonBody,
  sendJson
});
const { handlePurchaseFullEntry } = createPurchaseEntryService({
  backendId,
  backendNextNumericId,
  backendRowsById,
  cleanBackendInput,
  ensureBackendTable,
  isIsoDate,
  loadCache,
  normalizeLookupText,
  readJsonBody,
  saveBackendCache,
  sendJson
});
const { handleOtherExpenseFullEntry } = createOtherExpenseEntryService({
  EXPECTED_BACKEND_COLUMNS,
  backendId,
  backendNextNumericId,
  cleanBackendInput,
  ensureBackendTable,
  isIsoDate,
  loadCache,
  readJsonBody,
  saveBackendCache,
  sendJson,
  synchronizeEconomicExpenses: (cache) => backfillHistoricalEconomicExpenses(cache).cache
});
const { handleReceptionFullEntry } = createReceptionEntryService({
  EXPECTED_BACKEND_COLUMNS,
  backendId,
  backendNextNumericId,
  cleanBackendInput,
  ensureBackendTable,
  fs,
  isIsoDate,
  loadCache,
  path,
  readJsonBody,
  rootDir: ROOT_DIR,
  saveBackendCache,
  sendJson,
  synchronizeEconomicExpenses: (cache) => backfillHistoricalEconomicExpenses(cache).cache
});
const {
  handleAdjustment: handleEconomicExpenseAdjustment,
  handleConfirm: handleEconomicExpenseConfirm,
  handleDiscard: handleEconomicExpenseDiscard,
  handleDraftCreate: handleEconomicExpenseDraftCreate,
  handleDraftUpdate: handleEconomicExpenseDraftUpdate,
  handleGet: handleEconomicExpenseGet,
  handleList: handleEconomicExpensesList,
  handleReversal: handleEconomicExpenseReversal
} = createEconomicExpensesService({
  backendId,
  backendNextNumericId,
  ensureBackendTable,
  expectedBackendColumns: EXPECTED_BACKEND_COLUMNS,
  loadCache,
  readJsonBody,
  saveBackendCache,
  sendJson
});
const {
  handleCreate: handleEconomicExpenseApplicationCreate,
  handleReconciliation: handleEconomicExpenseReconciliation,
  handleReplace: handleEconomicExpenseApplicationReplace,
  handleReverse: handleEconomicExpenseApplicationReverse
} = createEconomicExpenseApplicationsService({
  backendId,
  backendNextNumericId,
  ensureBackendTable,
  expectedBackendColumns: EXPECTED_BACKEND_COLUMNS,
  loadCache,
  readJsonBody,
  saveBackendCache,
  sendJson
});
const { handleComparison: handleEconomicExpenseComparison } = createEconomicExpenseComparisonService({
  backendId,
  backendNumber,
  buildLegacyReport: buildBackendIncomeStatementReport,
  loadCache,
  sendJson
});

let shutdownStarted = false;

const server = http.createServer(createRequestHandler({
  applyRequestAccess,
  backendColumnsMap,
  backendOverview,
  backendSchema,
  runtimeIdentity: runtimeSession.publicIdentity,
  handlers: {
    handleAppStateGet,
    handleAppStateSave,
    handleBackendSqlQuery,
    handleAdminTableCellUpdate,
    handleAdminTableDeletePreview,
    handleAdminTableRequest,
    handleAdminTableSave,
    handleAdminTablesOverview,
    handleBackendTableRequest,
    handleBackendTableSave,
    handleBankReconciliationAnalyze,
    handleBankReconciliationApply,
    handleBankReconciliationDepositChecks,
    handleBankReconciliationState,
    handleBankReconciliationSummary,
    handleArcaAuditGet,
    handleArcaAuditPost,
    handleArcaOrdersGet,
    handleArcaPreparePost,
    handleCashBoxesGet,
    handleCashflowReport,
    handleCollectionFullEntry,
    handleCreditorCreate,
    handleEconomicExpenseAdjustment,
    handleEconomicExpenseApplicationCreate,
    handleEconomicExpenseApplicationReplace,
    handleEconomicExpenseApplicationReverse,
    handleEconomicExpenseComparison,
    handleEconomicExpenseConfirm,
    handleEconomicExpenseDiscard,
    handleEconomicExpenseDraftCreate,
    handleEconomicExpenseDraftUpdate,
    handleEconomicExpenseGet,
    handleEconomicExpenseReconciliation,
    handleEconomicExpenseReversal,
    handleEconomicExpensesList,
    handleIncomeStatementDetail,
    handleIncomeStatementReport,
    handleProductionReport,
    handleInvestmentFundCreate,
    handleInvestmentFundList,
    handleInventoryAppend,
    handleInventoryDetailAppend,
    handleInventoryDetailPhoto,
    handleInventoryDetailTemplate,
    handleInventoryFullEntry,
    handleInventoryLatestDate,
    handleInventoryPurchaseProductionRate,
    handleInventoryPurchaseSnapshot,
    handleOtherExpenseFullEntry,
    handlePayrollScaleRead,
    handlePayrollExpenseEntry,
    handlePartnerContributionFullEntry,
    handlePaymentPlanCreate,
    handlePaymentPlanGet,
    handlePaymentPlanQuotaAdd,
    handlePaymentPlanQuotaDelete,
    handlePaymentPlanQuotaUpdate,
    handlePaymentPlanUpdate,
    handlePaymentPlansList,
    handlePaymentFullEntry,
    handlePendingEndorsementPaymentsList,
    handleInvoiceProviderHealth,
    handleReceivedChecksEndorse,
    handlePurchaseFullEntry,
    handleReceptionFullEntry,
    handleReceptionAttachmentSave,
    handleReceptionInvoiceRead,
    handleSalesInvoiceRead,
    handleRuntimeShutdown,
    handleSalesDeliveryFullEntry,
    handleSalesInvoiceFullEntry,
    handleSalesOrderFullEntry,
    handleSalesWorkflowArcaConfirmation,
    handleSalesWorkflowClose,
    handleSalesWorkflowList,
    handleUnbilledOrdersGet
  },
  sendJson,
  serveStaticFile
}));

if (typeof server.on === "function") {
  server.on("error", handleServerError);
}

server.listen(accessConfig.port, accessConfig.host, () => {
  try {
    writeRuntimeLock(ROOT_DIR, runtimeSession);
  } catch (error) {
    console.error(`[ERP_SERVER_LOCK_ERROR] No se pudo registrar ownership: ${error.message}`);
    console.error("El servidor se cerrara para no quedar como una instancia no administrada.");
    shutdownServer("lock-error", 1);
    return;
  }

  console.log(`SunNutrition ERP escuchando en http://${accessConfig.host}:${accessConfig.port} (${accessConfig.mode})`);
  console.log(`Runtime ${runtimeSession.publicIdentity.instanceId}; PID ${runtimeSession.publicIdentity.pid}; inicio ${runtimeSession.publicIdentity.startedAt}`);
  console.log(`Codigo ${runtimeSession.publicIdentity.projectRoot}`);
  console.log(`Huella ${runtimeSession.publicIdentity.sourceFingerprint}`);
});

if (typeof server.close === "function") {
  process.once("SIGINT", () => shutdownServer("SIGINT"));
  process.once("SIGTERM", () => shutdownServer("SIGTERM"));
  process.once("exit", () => {
    removeRuntimeLockIfOwned(ROOT_DIR, runtimeSession);
  });
}

function serveStaticFile(request, response) {
  return serveStaticFileFromRoot(request, response, ROOT_DIR, MIME_TYPES);
}

function handleRuntimeShutdown(request, response) {
  const providedToken = request.headers["x-erp-runtime-token"];
  if (!safeTokenEquals(providedToken, runtimeSession.controlToken)) {
    return sendJson(response, 403, {
      ok: false,
      code: "RUNTIME_CONTROL_FORBIDDEN",
      error: "Token de control de runtime invalido."
    });
  }

  sendJson(response, 202, {
    ok: true,
    instanceId: runtimeSession.publicIdentity.instanceId
  });
  setImmediate(() => shutdownServer("runtime-control"));
}

function handleServerError(error) {
  if (error?.code === "EADDRINUSE") {
    console.error(
      `[ERP_SERVER_PORT_IN_USE] ${accessConfig.host}:${accessConfig.port} ya esta ocupado.`
    );
    console.error('Ejecute "npm.cmd run server:status" para identificar el runtime antes de validar.');
    console.error("No se detuvo ningun proceso.");
  } else {
    console.error(`[ERP_SERVER_ERROR] ${error?.message || error}`);
  }
  removeRuntimeLockIfOwned(ROOT_DIR, runtimeSession);
  process.exitCode = 1;
}

function shutdownServer(reason, exitCode = 0) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`Cerrando SunNutrition ERP (${reason})...`);

  const forceConnectionsTimer = setTimeout(() => {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  }, 2000);
  forceConnectionsTimer.unref();

  const forceExitTimer = setTimeout(() => {
    removeRuntimeLockIfOwned(ROOT_DIR, runtimeSession);
    process.exit(exitCode || 1);
  }, 5000);
  forceExitTimer.unref();

  server.close((error) => {
    clearTimeout(forceConnectionsTimer);
    clearTimeout(forceExitTimer);
    removeRuntimeLockIfOwned(ROOT_DIR, runtimeSession);
    if (error) {
      console.error(`[ERP_SERVER_CLOSE_ERROR] ${error.message}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = exitCode;
  });
}

