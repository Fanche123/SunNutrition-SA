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
const { readAppState, writeAppState } = require("./backend/repositories/app-state.repository");
const { createRequestHandler } = require("./backend/routes/router");
const { createAccessControl } = require("./backend/services/access-control.service");
const { createAdminTableService } = require("./backend/services/admin-table.service");
const { createPartnerContributionsService } = require("./backend/services/partner-contributions.service");
const { createPaymentPlansService } = require("./backend/services/payment-plans.service");
const { createCollectionEntryService } = require("./backend/services/collection-entry.service");
const { createPaymentEntryService } = require("./backend/services/payment-entry.service");
const { createReceivedChecksService } = require("./backend/services/received-checks.service");
const { createSalesOrderEntryService } = require("./backend/services/sales-order-entry.service");
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
  backendBankMatches,
  bankDateDistance,
  bankTextOverlapScore,
  compactBankText,
  extractBankCheckNumber,
  extractBankCuit,
  normalizeBankCheckNumber,
  normalizeBankCuit
} = require("./backend/utils/bank");

loadEnvFile();

const accessConfig = createAccessConfig(process.env);
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
  backendEconomicExpenseRows,
  backendExpenseCategoryTotals,
  backendExpenseCounterpartyInfo,
  backendExpenseLinkedOrigin,
  backendExpenseSourceConfigs,
  backendExpenseSourceTypeKey,
  backendExpenseSupplierName,
  backendStatementExpenseCategories,
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
  backendGroupRowsById,
  backendId,
  backendIsGrossRevenueTaxInvoice,
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
  backendRate,
  backendRowsById,
  backendUncategorizedExpenseRows,
  loadCache
});

const {
  handlePayrollScaleRead,
  handleReceptionAttachmentSave,
  handleReceptionInvoiceRead
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
  handleIncomeStatementReport
} = createCoreHandlers({
  APP_STATE_FILE,
  backendComparisonPeriod,
  buildBackendCashflowReport,
  buildBackendIncomeStatementReport,
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
  sendJson
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
  sendJson
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
  bankMovementBackendCreditorId,
  bankMovementFingerprint,
  bankSourceDestinationForOriginType,
  consumePersistedBankMovement,
  createBankEgressForSource,
  createBankPaymentForExpense,
  createBankSourceExpense,
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
  handleInventoryAppend,
  handleInventoryDetailAppend,
  handleInventoryDetailTemplate,
  handleInventoryFullEntry,
  handleInventoryLatestDate
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
  resolveInventoryEmployeeId,
  saveBackendCache,
  sendJson,
  valueBackendInventories
});
const {
  handleBankReconciliationAnalyze,
  handleBankReconciliationApply,
  handleBankReconciliationDepositChecks
} = createBankReconciliationService({
  analyzeBankMovement,
  backendBankCollectionCandidates,
  backendBankCreditPayableCandidates,
  backendBankIdentityIndex,
  backendBankPayableCandidates,
  backendBankPaymentCandidates,
  backendBankSourceCandidates,
  backendId,
  backendIssuedChecksByNumber,
  backendNormalizeText,
  backendNumber,
  backendPersistedBankMovementCounts,
  backendReceivedCheckDepositGroups,
  backendReceivedChecksByNumber,
  bankMovementFingerprint,
  cleanBackendText,
  createBankEgressForSource,
  createBankPaymentForExpense,
  createBankSourceExpense,
  ensureBackendTable,
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
  sendJson
});
const { handleReceivedChecksEndorse } = createReceivedChecksService({
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
  sendJson
});
const { handleSalesOrderFullEntry } = createSalesOrderEntryService({
  backendId,
  backendNextNumericId,
  backendNumber,
  ensureBackendTable,
  isIsoDate,
  loadCache,
  readJsonBody,
  saveBackendCache,
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
  sendJson
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
  sendJson
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

const server = http.createServer(createRequestHandler({
  applyRequestAccess,
  backendColumnsMap,
  backendOverview,
  backendSchema,
  handlers: {
    handleAppStateGet,
    handleAppStateSave,
    handleBackendSqlQuery,
    handleAdminTableCellUpdate,
    handleAdminTableRequest,
    handleAdminTableSave,
    handleAdminTablesOverview,
    handleBackendTableRequest,
    handleBackendTableSave,
    handleBankReconciliationAnalyze,
    handleBankReconciliationApply,
    handleBankReconciliationDepositChecks,
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
    handleIncomeStatementReport,
    handleInventoryAppend,
    handleInventoryDetailAppend,
    handleInventoryDetailPhoto,
    handleInventoryDetailTemplate,
    handleInventoryFullEntry,
    handleInventoryLatestDate,
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
    handleReceivedChecksEndorse,
    handlePurchaseFullEntry,
    handleReceptionFullEntry,
    handleReceptionAttachmentSave,
    handleReceptionInvoiceRead,
    handleSalesOrderFullEntry
  },
  sendJson,
  serveStaticFile
}));

server.listen(accessConfig.port, accessConfig.host, () => {
  console.log(`SunNutrition ERP escuchando en http://${accessConfig.host}:${accessConfig.port} (${accessConfig.mode})`);
});

function serveStaticFile(request, response) {
  return serveStaticFileFromRoot(request, response, ROOT_DIR, MIME_TYPES);
}

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) return;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  });
}

