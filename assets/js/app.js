/*
  ERP Simple
  ----------
  Este archivo concentra la lĂłgica de la app estĂˇtica: carga CSV, normaliza datos,
  calcula el Estado de Resultados y pinta las tablas. EstĂˇ organizado por secciones
  para que sea fĂˇcil mover cada bloque a mĂłdulos separados cuando la app crezca.
*/

const STORAGE_KEY = "erp-simple-state-v1";
const IMPORT_URLS_STORAGE_KEY = "erp-simple-import-urls-v1";
const ICON_VERSION = "20260701-53";
const CASHFLOW_START_ISO = toIsoDate(new Date());
const API_BASE_URL = window.location.port === "3000" ? "" : "http://127.0.0.1:3000";
const LEGACY_IMPORTS_ENABLED = false;
const LEGACY_IMPORT_DATA_KEYS = [
  "expenses",
  "sales",
  "orderDetails",
  "inventory",
  "inventoryDetails",
  "recipes",
  "itemInfo",
  "supplyInfo",
  "purchases",
  "purchaseDetails",
  "providers",
  "payroll",
  "creditors",
  "cash",
  "issuedChecks",
  "receivedChecks"
];
const DEFAULT_IMPORT_URLS = {
  cash: "https://docs.google.com/spreadsheets/d/1BAusksHyttro_QxZtAUWTs9EHdzNUIQ6wqVABMsWRgQ/edit?gid=568298913#gid=568298913",
  issuedChecks: "https://docs.google.com/spreadsheets/d/1BAusksHyttro_QxZtAUWTs9EHdzNUIQ6wqVABMsWRgQ/edit?gid=1926469270#gid=1926469270",
  receivedChecks: "https://docs.google.com/spreadsheets/d/1BAusksHyttro_QxZtAUWTs9EHdzNUIQ6wqVABMsWRgQ/edit?gid=2100467762#gid=2100467762",
  purchases: "https://docs.google.com/spreadsheets/d/1jq1-GDpWODoZyvzx2M1nM_AC1pBarfGJG5-R91CNdZ0/edit?gid=0#gid=0",
  purchaseDetails: "https://docs.google.com/spreadsheets/d/1jq1-GDpWODoZyvzx2M1nM_AC1pBarfGJG5-R91CNdZ0/edit?gid=1393896756#gid=1393896756",
  providers: "https://docs.google.com/spreadsheets/d/1J6byHbqScKH96vvVmQJdnQfTIMWDSt_bGNxfils850A/edit?gid=0#gid=0",
  itemInfo: "https://docs.google.com/spreadsheets/d/1J6byHbqScKH96vvVmQJdnQfTIMWDSt_bGNxfils850A/edit?gid=661125391#gid=661125391",
  supplyInfo: "https://docs.google.com/spreadsheets/d/1J6byHbqScKH96vvVmQJdnQfTIMWDSt_bGNxfils850A/edit?gid=1133562292#gid=1133562292",
  expenses: "https://docs.google.com/spreadsheets/d/1qUXEafy7wUoLm_S-axOk2ZOE2w-ArvQPzKIUIV56Bek/edit?gid=0#gid=0",
  sales: "https://docs.google.com/spreadsheets/d/1O_RUJno7jZDfTv3LHzLJM7ooiXh4DLohxOFfJq1mVyY/edit?gid=0#gid=0",
  inventory: "https://docs.google.com/spreadsheets/d/1G4lIvbfH2JFpEKVoFd7Hn0tOyCERtYYs7T7-8agtmbI/edit?gid=0#gid=0",
  inventoryDetails: "https://docs.google.com/spreadsheets/d/1G4lIvbfH2JFpEKVoFd7Hn0tOyCERtYYs7T7-8agtmbI/edit?gid=744998364#gid=744998364",
  payroll: "https://docs.google.com/spreadsheets/d/1qQza5fHg7ZIhBbpz9M-o0ZhDUXVWoxEHForxpoSNMq0/edit?gid=1312570023#gid=1312570023"
};
const ARGENTINA_NON_WORKING_DAYS = new Set([
  "2026-01-01",
  "2026-02-16",
  "2026-02-17",
  "2026-03-23",
  "2026-03-24",
  "2026-04-02",
  "2026-04-03",
  "2026-05-01",
  "2026-05-25",
  "2026-06-15",
  "2026-06-20",
  "2026-07-09",
  "2026-07-10",
  "2026-08-17",
  "2026-10-12",
  "2026-11-23",
  "2026-12-07",
  "2026-12-08",
  "2026-12-25"
]);
let cashflowDragState = null;
let cashflowSuppressNextClick = false;
let inventoryDetailTemplate = null;
let lastInventoryPhotoTranscription = null;
let inventoryPhotoApplied = false;
let remoteSaveTimer = null;
let backendDataMap = null;
let backendSqlSchema = null;
let dataEditorSchema = null;
let dataEditorViews = {
  primary: createDataEditorViewState(),
  secondary: createDataEditorViewState()
};
let pendingDataEditorDraft = null;
let backendStatementRequestId = 0;
let backendCashflowReport = null;
let backendCashflowRequestId = 0;
let bankReconciliationFileText = "";
let bankReconciliationReport = null;
let bankNegativeExpenseDraft = null;
let bankCheckDepositDraft = null;
let bankPartnerContributionDraft = null;
let creditorEntryDraft = null;
let creditorEntryLabels = [];
let creditorEntrySupplies = [];
let creditorEntrySupplierItems = [];
let bankReconciliationExcludedMovementKeys = new Set();
let bankReconciliationRefreshPromise = null;
let bankReconciliationOpenDebtCreditorIds = new Set();
let bankPaymentDraft = null;
let legacyInventoryImportRows = null;
let legacyInventoryDetailImportRows = null;
let issuedCheckPaymentOptions = new Map();
let receptionPendingPurchases = new Map();
let selectedReceptionPurchaseIds = new Set();
let selectedCommissionCollectionIds = new Set();
let dashboardWidgetData = {
  checks: [],
  missingInventoryDays: [],
  pendingPurchases: [],
  pendingOrders: []
};
let dashboardExpandedWidget = "";
let receptionInvoiceReadRequestId = 0;
let logisticsInvoiceReadRequestId = 0;
let otherExpenseInvoiceReadRequestId = 0;
let salaryExpenseInvoiceReadRequestId = 0;
let purchaseBackendOptions = createPurchaseBackendOptions();
let commercialEntryData = createCommercialEntryData();
let otherExpenseEntryData = createOtherExpenseEntryData();
let salaryExpenseEntryData = createSalaryExpenseEntryData();
let salaryEntryEmployees = [];
let salaryEntryScale = { categories: {}, sourceName: "" };
const DEFAULT_COOPERATIVE_EMPLOYEE_COST = 259506.74;
const DEFAULT_EMPLOYEE_CONTRIBUTION_RATE = 17;
// Referencia inicial tomada del F.931 06/2026 de SunNutrition: contribuciones + ART/LRT + SCVO.
const DEFAULT_EMPLOYER_CONTRIBUTION_RATE = 28.39;
let paymentPendingExpenses = [];

const MONTHS = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre"
];

function createPurchaseBackendOptions() {
  return {
    loaded: false,
    supplies: [],
    supplierLinks: [],
    providers: [],
    items: [],
    suppliesById: new Map(),
    supplierLinksById: new Map(),
    providersById: new Map(),
    itemsBySupplyId: new Map()
  };
}

function createCommercialEntryData() {
  return {
    loaded: false,
    clientes: [],
    productos: [],
    pedidos: [],
    detalle_pedidos: [],
    entregas: [],
    entregas_detalle: [],
    ventas: [],
    cobros: [],
    cobros_detalle: [],
    cheques_recibidos: [],
    fletes: [],
    canales: [],
    acreedores: [],
    acreedores_etiquetas: [],
    comisiones: [],
    etiquetas: []
  };
}

function createOtherExpenseEntryData() {
  return {
    loaded: false,
    otherCreditors: [],
    creditors: [],
    providers: [],
    employees: [],
    fleets: [],
    channels: [],
    creditorTags: [],
    labels: [],
    otherExpenses: [],
    expenses: []
  };
}

function createSalaryExpenseEntryData() {
  return {
    loaded: false,
    salaries: [],
    employees: [],
    expenses: [],
    creditorTags: [],
    labels: []
  };
}

function createDefaultPayrollState() {
  return {
    selectedPeriod: currentPayrollPeriodKey(),
    scale: { categories: {}, sourceName: "" },
    exceptions: [],
    laborCosts: {
      cooperativeCostByPeriod: {},
      socialChargeTotalByPeriod: {},
      cooperativeTotalByPeriod: {},
      employeeContributionRateByPeriod: {},
      employerContributionRateByPeriod: {}
    },
    laborExpenses: {
      socialChargeExpenseByPeriod: {},
      cooperativeExpenseByPeriod: {}
    }
  };
}

/*
  ConfiguraciĂłn histĂłrica editable desde la pantalla ConfiguraciĂłn.
  El Estado de Resultados actual usa reglas fijas mĂˇs abajo, pero se mantiene esta
  estructura porque la pantalla todavĂ­a permite revisar y guardar categorĂ­as base.
*/
const DEFAULT_SETTINGS = {
  productive: ["Mercaderia", "compra productiva", "insumos productivos", "producto"],
  commercial: ["Comisiones", "ComisionesFactura", "Incentivos_Personal", "ventas"],
  admin: ["Administrativos", "Caja_Chica", "oficina", "honorarios"],
  salary: ["Sueldos", "Sueldos_Extras", "salarios", "cargas sociales"],
  rent: ["Alquiler", "expensas"],
  service: ["Servicios", "ServiciosFactura", "Limpieza", "luz", "gas", "internet", "telefono"],
  logistics: ["Logistica", "Cadeteria", "flete", "envios", "transporte"],
  maintenance: ["Mantenimiento", "Herramientas_De_Trabajo", "Maquinaria", "reparaciones"],
  marketing: ["Marketing", "publicidad", "diseno"],
  tax: ["Iva", "Impuesto Deb", "Impuesto Cred", "Ingresos Brutos", "Impuesto Sello", "impuestos", "tasas", "afip"],
  finance: ["Gastos Bancarios", "Intereses", "Descuento_Cheque", "Prestamo", "PagoTarjetaCredito", "banco", "comisiones bancarias"],
  other: ["Varios", "Varios Miguel", "Inversion General", "Transferencia_Interna", "Rescate Fondo", "Subscripcion Fondo", "Subscripcion_Fondo_GAL", "Rendimiento Fondo", "otros"]
};

/*
  ClasificaciĂłn de ventas entregada por el negocio.
  Se aplica por cliente al importar ventas para separar facturaciĂłn en Escuelas,
  Otros o Sin Clasificar.
*/
const SALES_CLASSIFICATION_BY_CUSTOMER = {
  Dassault_SA: "Escuelas",
  Lamerich_SRL: "Escuelas",
  Arkino_SA: "Escuelas",
  Miguel: "Sin Clasificar",
  Facundo: "Sin Clasificar",
  Friends_Food_SA: "Escuelas",
  Mima_Group: "Otros",
  Devolucion: "Sin Clasificar",
  Ofidirect_SRL: "Otros",
  GNN: "Otros",
  Distribuidora_Vegana: "Otros",
  FJ_Organico: "Otros",
  Spartaro_SRL: "Escuelas",
  Serpa_Food_SRL: "Escuelas",
  Galletitas_Individuales_SRL: "Escuelas",
  D_Inzeo: "Escuelas",
  Carmelo_Antonio_Orrico_SRL: "Escuelas",
  Servir_C_SA: "Escuelas",
  "CompaĂ±Ă­a_Alimentaria_Nacional_CAN": "Escuelas",
  "Vivet SRL": "Otros",
  Caterind_SA: "Escuelas",
  Evencoop: "Escuelas",
  Tavolaro: "Escuelas",
  Pereyra: "Escuelas",
  Espinola: "Escuelas",
  Alfredo_Grasso: "Escuelas",
  Diaz_Velez_SRL: "Escuelas",
  Santana_Jose_Luis: "Escuelas",
  Carlos_Sergio_Borgonovo: "Escuelas",
  "CompaĂ±ia_Integral": "Escuelas",
  Tavolaro_D: "Escuelas",
  Ramiro_Garnil: "Otros",
  Pablo_Gonzalez: "Escuelas",
  Caitano_Guillermo_Adrian: "Escuelas",
  Rodolfo_Ferrarotti: "Escuelas",
  Banda_del_rio_sali: "Otros"
};

// Estado Ăşnico de la aplicaciĂłn. Se guarda completo en localStorage.
const state = loadState();

// Cache de nodos del DOM usados varias veces durante renderizados.
const els = {};

document.addEventListener("DOMContentLoaded", () => {
  document.body.classList.toggle("legacy-imports-disabled", !LEGACY_IMPORTS_ENABLED);
  cacheElements();
  persistBackendOnlyCacheCleanup();
  setupPeriodSelectors();
  fillImportUrlInputs();
  loadBackendSources();
  bindEvents();
  fillSettingsForm();
  reconcilePurchaseDetailSuppliers();
  render();
  loadDashboardWidgets();
  initializeInventoryEntryDefaults();
  initializeOperationalEntryDefaults();
  initializeSalaryEntry();
  loadOperationalEntryOptions();
  loadPurchaseBackendOptions();
  refreshInventoryDefaultDateFromSheets();
  syncStateFromServer();
});

function cacheElements() {
  [
    "page-title",
    "page-subtitle",
    "period-select",
    "comparison-select",
    "metric-units",
    "metric-units-customers",
    "metric-production",
    "metric-production-hour",
    "metric-sales",
    "metric-cogs",
    "metric-operating-expenses",
    "metric-margin",
    "metric-net",
    "metric-sales-rate",
    "metric-cogs-rate",
    "metric-operating-expenses-rate",
    "metric-margin-rate",
    "metric-net-rate",
    "metric-sales-unit",
    "metric-cogs-unit",
    "metric-operating-expenses-unit",
    "metric-operating-expenses-produced-unit",
    "metric-margin-unit",
    "metric-net-unit",
    "metric-net-produced-unit",
    "dashboard-checks-widget",
    "dashboard-checks-count",
    "dashboard-next-check",
    "dashboard-week-checks",
    "dashboard-inventory-widget",
    "dashboard-inventory-count",
    "dashboard-inventory-summary",
    "dashboard-inventory-list",
    "dashboard-purchases-widget",
    "dashboard-purchases-count",
    "dashboard-purchases-summary",
    "dashboard-purchases-list",
    "dashboard-orders-widget",
    "dashboard-orders-count",
    "dashboard-orders-summary",
    "dashboard-orders-list",
    "period-label",
    "warnings",
    "statement-body",
    "uncategorized-body",
    "review-count",
    "financial-overdue-balance",
    "financial-month-balance",
    "financial-cash-banks",
    "financial-count-label",
    "financial-payments-body",
    "financial-receivables-count-label",
    "financial-receivables-body",
    "financial-cash-cash",
    "financial-checks-on-hand",
    "financial-checks-to-cover",
    "bank-reconciliation-bank",
    "bank-reconciliation-drop-zone",
    "bank-reconciliation-file",
    "bank-reconciliation-file-chip",
    "bank-reconciliation-file-name",
    "bank-reconciliation-file-size",
    "bank-reconciliation-file-clear",
    "bank-reconciliation-analyze",
    "bank-reconciliation-apply",
    "bank-create-expenses",
    "bank-create-egresses",
    "bank-create-payments",
    "bank-expense-stage-count",
    "bank-egress-stage-count",
    "bank-payment-stage-count",
    "bank-expense-stage-body",
    "bank-egress-stage-body",
    "bank-payment-stage-body",
    "bank-reconciliation-real-balance",
    "bank-reconciliation-reconciled",
    "bank-reconciliation-pending",
    "bank-reconciliation-net-pending",
    "bank-reconciliation-status",
    "bank-reconciliation-body",
    "bank-check-deposit-panel",
    "bank-check-deposit-title",
    "bank-check-deposit-status-view",
    "bank-check-deposit-credit",
    "bank-check-deposit-total",
    "bank-check-deposit-difference",
    "bank-check-deposit-body",
    "bank-check-deposit-confirm",
    "bank-check-deposit-movement",
    "bank-check-deposit-date",
    "bank-check-deposit-bank",
    "financial-received-checks-count-label",
    "financial-received-checks-body",
    "financial-issued-checks-count-label",
    "financial-issued-checks-body",
    "expense-debt-summary",
    "expense-debt-body",
    "cashflow-search",
    "cashflow-timeline",
    "count-sales",
    "count-expenses",
    "count-inventory",
    "count-inventory-details",
    "count-order-details",
    "count-payroll",
    "count-errors",
    "expenses-body",
    "sales-body",
    "order-details-body",
    "customer-units-body",
    "inventory-body",
    "inventory-details-body",
    "payroll-body",
    "production-body",
    "expenses-count-label",
    "sales-count-label",
    "order-details-count-label",
    "customer-units-count-label",
    "inventory-count-label",
    "inventory-details-count-label",
    "payroll-count-label",
    "payroll-summary-label",
    "payroll-employee-count",
    "payroll-hours-total",
    "production-count-label",
    "creditor-employee-options",
    "expense-categories-body",
    "expense-categories-count",
    "unclassified-categories-body",
    "unclassified-categories-count",
    "save-settings",
    "reset-settings",
    "clear-data",
    "refresh-imports",
    "save-backend-sources",
    "refresh-backend-cache",
    "backend-sources-status",
    "data-map-summary",
    "data-map-module",
    "data-map-only-issues",
    "refresh-data-map",
    "data-map-body",
    "creditor-entry-form",
    "creditor-entry-description",
    "creditor-entry-type",
    "creditor-entry-name",
    "creditor-entry-cuit",
    "creditor-entry-cbu-alias",
    "creditor-entry-payment-terms",
    "creditor-entry-tag",
    "creditor-entry-specific-fields",
    "creditor-entry-supplier-items",
    "creditor-entry-supplier-items-rows",
    "creditor-entry-add-supplier-item",
    "creditor-entry-detail",
    "creditor-entry-save-bank-detail",
    "creditor-entry-status",
    "creditor-entry-submit",
    "data-editor-status",
    "data-editor-table",
    "data-editor-table-secondary",
    "data-editor-row-start",
    "data-editor-row-start-secondary",
    "data-editor-row-end",
    "data-editor-row-end-secondary",
    "data-editor-load",
    "data-editor-load-secondary",
    "data-editor-add-row",
    "data-editor-add-row-secondary",
    "data-editor-delete-row",
    "data-editor-delete-row-secondary",
    "data-editor-save",
    "data-editor-save-secondary",
    "data-editor-body",
    "data-editor-body-secondary",
    "sql-table-count",
    "sql-table-list",
    "sql-query",
    "sql-run",
    "sql-status",
    "sql-results",
    "inventory-date-input",
    "inventory-employee-input",
    "inventory-detail-load",
    "inventory-detail-form",
    "inventory-detail-id-label",
    "inventory-detail-body",
    "purchase-threshold-body",
    "inventory-counter-manual-morning",
    "inventory-counter-manual-afternoon",
    "inventory-counter-manual-dawn",
    "inventory-counter-theoretical-morning",
    "inventory-counter-theoretical-afternoon",
    "inventory-counter-theoretical-dawn",
    "inventory-counter-diff-morning",
    "inventory-counter-diff-afternoon",
    "inventory-counter-diff-dawn",
    "inventory-photo-drop-zone",
    "inventory-photo-input",
    "inventory-photo-file-chip",
    "inventory-photo-file-name",
    "inventory-photo-file-size",
    "inventory-photo-clear",
    "inventory-photo-read",
    "inventory-photo-transcription",
    "inventory-detail-submit",
    "inventory-detail-status",
    "purchase-form",
    "purchase-item-id",
    "purchase-item-name",
    "purchase-provider",
    "purchase-supplier-id",
    "purchase-order-date",
    "purchase-expected-date",
    "purchase-invoice-type",
    "purchase-subtotal",
    "purchase-iva",
    "purchase-iva-rate",
    "purchase-total",
    "purchase-quantity",
    "purchase-quantity-unit",
    "purchase-recipe-quantity",
    "purchase-recipe-unit",
    "purchase-supplier-quantity",
    "purchase-unit",
    "purchase-order-body",
    "purchase-download-png",
    "purchase-status",
    "purchase-submit",
    "orders-form",
    "order-client",
    "order-date",
    "order-delivery-date",
    "order-original-date",
    "order-product",
    "order-boxes",
    "order-tax",
    "order-unit-price",
    "order-discount",
    "orders-status",
    "logistics-pending-body",
    "logistics-order-selection",
    "logistics-delivery-fleet",
    "logistics-delivery-date",
    "logistics-delivery-create",
    "logistics-status",
    "logistics-expense-form",
    "logistics-expense-delivery-body",
    "logistics-expense-selection",
    "logistics-file-drop-zone",
    "logistics-file",
    "logistics-file-chip",
    "logistics-file-name",
    "logistics-file-size",
    "logistics-file-clear",
    "logistics-invoice-read",
    "logistics-without-file",
    "logistics-expense-invoice-type",
    "logistics-expense-invoice-number",
    "logistics-expense-invoice-date",
    "logistics-expense-payment-date",
    "logistics-expense-subtotal",
    "logistics-expense-subtotal-ref",
    "logistics-expense-iva",
    "logistics-expense-iva-ref",
    "logistics-expense-vat-retention",
    "logistics-expense-iibb-retention",
    "logistics-expense-internal-taxes",
    "logistics-expense-total",
    "logistics-expense-total-ref",
    "logistics-expense-status",
    "logistics-expense-submit",
    "other-expense-form",
    "other-expense-date",
    "other-expense-creditor-search",
    "other-expense-creditor-suggestions",
    "other-expense-creditor",
    "other-expense-creditor-tag",
    "other-expense-detail",
    "other-expense-file-drop-zone",
    "other-expense-file",
    "other-expense-file-chip",
    "other-expense-file-name",
    "other-expense-file-size",
    "other-expense-file-clear",
    "other-expense-invoice-read",
    "other-expense-invoice-type",
    "other-expense-invoice-number",
    "other-expense-invoice-date",
    "other-expense-payment-date",
    "other-expense-subtotal",
    "other-expense-iva",
    "other-expense-vat-retention",
    "other-expense-iibb-retention",
    "other-expense-internal-taxes",
    "other-expense-total",
    "partner-contribution-form",
    "partner-contribution-date",
    "partner-contribution-name",
    "partner-contribution-type",
    "partner-contribution-amount",
    "partner-contribution-status",
    "partner-contributions-history-body",
    "other-expense-submit",
    "other-expense-status",
    "sales-client-filter",
    "sales-client-debt-total",
    "sales-client-debt-count",
    "sales-debt-download",
    "sales-pending-body",
    "collections-form",
    "collection-client",
    "collection-date",
    "collection-method",
    "collection-bank",
    "collection-received-total",
    "collection-income-tax-retention",
    "collection-iibb-retention",
    "collection-total",
    "collection-retentions-total",
    "collection-invoices-total",
    "collection-difference",
    "collections-invoice-body",
    "collections-status",
    "commissions-month-filter",
    "commissions-channel-filter",
    "commissions-summary-collections",
    "commissions-summary-subtotal",
    "commissions-summary-commission",
    "commissions-collection-body",
    "commissions-status",
    "commissions-expense-selection",
    "commissions-expense-form",
    "commissions-expense-invoice-type",
    "commissions-expense-invoice-number",
    "commissions-expense-invoice-date",
    "commissions-expense-payment-date",
    "commissions-expense-subtotal",
    "commissions-expense-iva",
    "commissions-expense-vat-retention",
    "commissions-expense-iibb-retention",
    "commissions-expense-internal-taxes",
    "commissions-expense-total",
    "commissions-expense-submit",
    "commissions-expense-status",
    "received-check-count",
    "received-check-pending-body",
    "received-check-form",
    "received-check-collection-id",
    "received-check-client-id",
    "received-check-collection-label",
    "received-check-client-name",
    "received-check-amount",
    "received-check-number",
    "received-check-received-date",
    "received-check-use-date",
    "received-check-bank",
    "received-check-state",
    "received-check-submit",
    "received-check-status",
    "reception-form",
    "reception-pending-body",
    "reception-purchase-id",
    "reception-date",
    "reception-provider",
    "reception-employee-id",
    "reception-employee-options",
    "reception-supply-name",
    "reception-supply-id",
    "reception-supplier-quantity",
    "reception-supplier-unit",
    "reception-quantity",
    "reception-count-unit",
    "reception-recipe-quantity",
    "reception-recipe-unit",
    "reception-file-drop-zone",
    "reception-file",
    "reception-file-chip",
    "reception-file-name",
    "reception-file-size",
    "reception-file-clear",
    "reception-invoice-read",
    "reception-without-file",
    "reception-expense-invoice-type",
    "reception-expense-invoice-number",
    "reception-expense-invoice-date",
    "reception-expense-payment-date",
    "reception-expense-subtotal",
    "reception-expense-subtotal-ref",
    "reception-expense-iva",
    "reception-expense-iva-ref",
    "reception-expense-vat-retention",
    "reception-expense-iibb-retention",
    "reception-expense-internal-taxes",
    "reception-expense-total",
    "reception-expense-total-ref",
    "reception-status",
    "reception-submit",
    "issued-check-form",
    "issued-check-pending-count",
    "issued-check-pending-body",
    "issued-check-payment-id",
    "issued-check-payment-label",
    "issued-check-expense-label",
    "issued-check-creditor-id",
    "issued-check-creditor-name",
    "issued-check-number",
    "issued-check-date",
    "issued-check-use-date",
    "issued-check-amount",
    "issued-check-bank",
    "issued-check-state",
    "issued-check-message",
    "issued-check-submit",
    "payment-form",
    "payment-date",
    "payment-method",
    "payment-bank",
    "payment-bank-amount",
    "payment-creditor-filter",
    "payment-search",
    "payment-summary",
    "payment-selected-total",
    "payment-movement-comparison",
    "payment-pending-body",
    "payment-submit",
    "payment-status",
    "salary-period-select",
    "salary-scale-file",
    "salary-scale-file-name",
    "salary-scale-read",
    "salary-period-summary",
    "salary-table-caption",
    "salary-entry-body",
    "salary-labor-costs",
    "salary-entry-status",
    "salary-add-exception",
    "salary-save-backend",
    "salary-exceptions-body",
    "salary-expense-form",
    "salary-expense-selection",
    "salary-expense-salary-body",
    "salary-expense-file-drop-zone",
    "salary-expense-file",
    "salary-expense-file-chip",
    "salary-expense-file-name",
    "salary-expense-file-size",
    "salary-expense-file-clear",
    "salary-expense-invoice-read",
    "salary-expense-without-file",
    "salary-expense-invoice-type",
    "salary-expense-invoice-number",
    "salary-expense-invoice-date",
    "salary-expense-payment-date",
    "salary-expense-subtotal",
    "salary-expense-iva",
    "salary-expense-vat-retention",
    "salary-expense-iibb-retention",
    "salary-expense-internal-taxes",
    "salary-expense-total",
    "salary-expense-status",
    "salary-expense-submit"
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });
}

/*
  Persistencia local:
  - localStorage permite trabajar sin backend en esta etapa.
  - Si el JSON guardado estĂˇ corrupto, la app vuelve a un estado vacĂ­o seguro.
*/
function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  const savedImportUrls = loadSavedImportUrls();
  const defaultedImportUrls = { ...DEFAULT_IMPORT_URLS, ...savedImportUrls };
  if (!saved) {
    return stripLegacyImportDataForBackendOnly({
      selectedMonth: new Date().getMonth(),
      selectedYear: new Date().getFullYear(),
      selectedComparison: "none",
      expenses: [],
      sales: [],
      orderDetails: [],
      inventory: [],
      inventoryDetails: [],
      recipes: [],
      itemInfo: [],
      supplyInfo: [],
      purchases: [],
      purchaseDetails: [],
      providers: [],
      payroll: [],
      creditors: [],
      cash: [],
      issuedChecks: [],
      receivedChecks: [],
      payrollEntry: createDefaultPayrollState(),
      cashflowDateOverrides: {},
      importUrls: defaultedImportUrls,
      importErrors: [],
      settings: DEFAULT_SETTINGS
    });
  }

  try {
    const parsed = JSON.parse(saved);
    return stripLegacyImportDataForBackendOnly({
      selectedMonth: parsed.selectedMonth ?? new Date().getMonth(),
      selectedYear: parsed.selectedYear ?? new Date().getFullYear(),
      selectedComparison: parsed.selectedComparison || "none",
      expenses: parsed.expenses || [],
      sales: parsed.sales || [],
      orderDetails: parsed.orderDetails || [],
      inventory: parsed.inventory || [],
      inventoryDetails: parsed.inventoryDetails || [],
      recipes: parsed.recipes || [],
      itemInfo: parsed.itemInfo || [],
      supplyInfo: parsed.supplyInfo || [],
      purchases: parsed.purchases || [],
      purchaseDetails: parsed.purchaseDetails || [],
      providers: parsed.providers || [],
      payroll: parsed.payroll || [],
      creditors: parsed.creditors || [],
      cash: parsed.cash || [],
      issuedChecks: parsed.issuedChecks || [],
      receivedChecks: parsed.receivedChecks || [],
      payrollEntry: normalizePayrollEntryState(parsed.payrollEntry),
      cashflowDateOverrides: parsed.cashflowDateOverrides || {},
      importUrls: { ...DEFAULT_IMPORT_URLS, ...(parsed.importUrls || {}), ...savedImportUrls },
      importErrors: cleanImportErrors(parsed.importErrors || []),
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) }
    });
  } catch {
    return stripLegacyImportDataForBackendOnly({
      selectedMonth: new Date().getMonth(),
      selectedYear: new Date().getFullYear(),
      selectedComparison: "none",
      expenses: [],
      sales: [],
      orderDetails: [],
      inventory: [],
      inventoryDetails: [],
      recipes: [],
      itemInfo: [],
      supplyInfo: [],
      purchases: [],
      purchaseDetails: [],
      providers: [],
      payroll: [],
      creditors: [],
      cash: [],
      issuedChecks: [],
      receivedChecks: [],
      payrollEntry: createDefaultPayrollState(),
      cashflowDateOverrides: {},
      importUrls: defaultedImportUrls,
      importErrors: [],
      settings: DEFAULT_SETTINGS
    });
  }
}

function cleanImportErrors(errors) {
  return errors.filter((error) => error.source !== "payroll");
}

function saveState() {
  const compactState = compactStateForStorage(state);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(compactState));
    localStorage.setItem(IMPORT_URLS_STORAGE_KEY, JSON.stringify(state.importUrls || {}));
  } catch (error) {
    const fallbackState = { ...compactState, importErrors: [] };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fallbackState));
    localStorage.setItem(IMPORT_URLS_STORAGE_KEY, JSON.stringify(state.importUrls || {}));
  }
  scheduleRemoteStateSave(compactState);
}

async function syncStateFromServer() {
  if (!canUseServerState()) return;

  try {
    const response = await fetch(`${API_BASE_URL}/api/app-state`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.state) {
      Object.assign(state, normalizeStoredState(payload.state));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(compactStateForStorage(state)));
      localStorage.setItem(IMPORT_URLS_STORAGE_KEY, JSON.stringify(state.importUrls || {}));
      setupPeriodSelectors();
      fillImportUrlInputs();
      fillSettingsForm();
      reconcilePurchaseDetailSuppliers();
      render();
      initializeInventoryEntryDefaults();
      refreshInventoryDefaultDateFromSheets();
    } else if (hasMeaningfulAppState(state)) {
      scheduleRemoteStateSave(compactStateForStorage(state), 0);
    }
  } catch (error) {
    console.warn("No se pudo sincronizar el estado central de la app.", error);
  }
}

function normalizeStoredState(storedState) {
  const parsed = storedState || {};
  return stripLegacyImportDataForBackendOnly({
    selectedMonth: parsed.selectedMonth ?? new Date().getMonth(),
    selectedYear: parsed.selectedYear ?? new Date().getFullYear(),
    selectedComparison: parsed.selectedComparison || "none",
    expenses: parsed.expenses || [],
    sales: parsed.sales || [],
    orderDetails: parsed.orderDetails || [],
    inventory: parsed.inventory || [],
    inventoryDetails: parsed.inventoryDetails || [],
    recipes: parsed.recipes || [],
    itemInfo: parsed.itemInfo || [],
    supplyInfo: parsed.supplyInfo || [],
    purchases: parsed.purchases || [],
    purchaseDetails: parsed.purchaseDetails || [],
    providers: parsed.providers || [],
    payroll: parsed.payroll || [],
    creditors: parsed.creditors || [],
    cash: parsed.cash || [],
    issuedChecks: parsed.issuedChecks || [],
    receivedChecks: parsed.receivedChecks || [],
    payrollEntry: normalizePayrollEntryState(parsed.payrollEntry),
    cashflowDateOverrides: parsed.cashflowDateOverrides || {},
    importUrls: { ...DEFAULT_IMPORT_URLS, ...(parsed.importUrls || {}) },
    importErrors: cleanImportErrors(parsed.importErrors || []),
    settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) }
  });
}

function scheduleRemoteStateSave(compactState, delayMs = 350) {
  if (!canUseServerState()) return;
  if (!hasMeaningfulAppState(compactState)) return;
  window.clearTimeout(remoteSaveTimer);
  remoteSaveTimer = window.setTimeout(() => {
    saveStateToServer(compactState);
  }, delayMs);
}

async function saveStateToServer(compactState) {
  try {
    await fetch(`${API_BASE_URL}/api/app-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: compactState })
    });
  } catch (error) {
    console.warn("No se pudo guardar el estado central de la app.", error);
  }
}

function canUseServerState() {
  return location.protocol.startsWith("http");
}

function hasMeaningfulAppState(appState) {
  const savedScale = appState.payrollEntry?.scale?.categories || {};
  return LEGACY_IMPORT_DATA_KEYS.some((key) => Array.isArray(appState[key]) && appState[key].length > 0)
    || Boolean(appState.payrollEntry?.exceptions?.length)
    || Boolean(Object.keys(savedScale).length)
    || Boolean(appState.payrollEntry?.selectedPeriod);
}

function normalizePayrollEntryState(value) {
  const fallback = createDefaultPayrollState();
  const parsed = value || {};
  const parsedScale = parsed.scale && typeof parsed.scale === "object" ? parsed.scale : {};
  const parsedLaborCosts = parsed.laborCosts && typeof parsed.laborCosts === "object" ? parsed.laborCosts : {};
  return {
    selectedPeriod: parsed.selectedPeriod || fallback.selectedPeriod,
    scale: {
      categories: parsedScale.categories && typeof parsedScale.categories === "object" ? parsedScale.categories : {},
      sourceName: parsedScale.sourceName || ""
    },
    exceptions: Array.isArray(parsed.exceptions) ? parsed.exceptions : [],
    laborCosts: {
      cooperativeCostByPeriod: parsedLaborCosts.cooperativeCostByPeriod && typeof parsedLaborCosts.cooperativeCostByPeriod === "object"
        ? parsedLaborCosts.cooperativeCostByPeriod
        : {},
      socialChargeTotalByPeriod: parsedLaborCosts.socialChargeTotalByPeriod && typeof parsedLaborCosts.socialChargeTotalByPeriod === "object"
        ? parsedLaborCosts.socialChargeTotalByPeriod
        : {},
      cooperativeTotalByPeriod: parsedLaborCosts.cooperativeTotalByPeriod && typeof parsedLaborCosts.cooperativeTotalByPeriod === "object"
        ? parsedLaborCosts.cooperativeTotalByPeriod
        : {},
      employeeContributionRateByPeriod: parsedLaborCosts.employeeContributionRateByPeriod && typeof parsedLaborCosts.employeeContributionRateByPeriod === "object"
        ? parsedLaborCosts.employeeContributionRateByPeriod
        : {},
      employerContributionRateByPeriod: parsedLaborCosts.employerContributionRateByPeriod && typeof parsedLaborCosts.employerContributionRateByPeriod === "object"
        ? parsedLaborCosts.employerContributionRateByPeriod
        : parsedLaborCosts.socialChargeRateByPeriod && typeof parsedLaborCosts.socialChargeRateByPeriod === "object"
          ? parsedLaborCosts.socialChargeRateByPeriod
          : {}
    },
    laborExpenses: {
      socialChargeExpenseByPeriod: parsed.laborExpenses?.socialChargeExpenseByPeriod && typeof parsed.laborExpenses.socialChargeExpenseByPeriod === "object"
        ? parsed.laborExpenses.socialChargeExpenseByPeriod
        : {},
      cooperativeExpenseByPeriod: parsed.laborExpenses?.cooperativeExpenseByPeriod && typeof parsed.laborExpenses.cooperativeExpenseByPeriod === "object"
        ? parsed.laborExpenses.cooperativeExpenseByPeriod
        : {}
    }
  };
}

function loadSavedImportUrls() {
  try {
    return JSON.parse(localStorage.getItem(IMPORT_URLS_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function compactStateForStorage(currentState) {
  const compact = { ...currentState };
  LEGACY_IMPORT_DATA_KEYS.forEach((key) => {
    compact[key] = stripRowSource(currentState[key] || []);
  });
  compact.importErrors = cleanImportErrors(currentState.importErrors || [])
    .slice(-100)
    .map((error) => ({
      ...error,
      raw: String(error.raw || "").slice(0, 500)
    }));
  return stripLegacyImportDataForBackendOnly(compact);
}

function stripLegacyImportDataForBackendOnly(appState) {
  if (LEGACY_IMPORTS_ENABLED) return appState;
  LEGACY_IMPORT_DATA_KEYS.forEach((key) => {
    appState[key] = [];
  });
  appState.importErrors = [];
  return appState;
}

function persistBackendOnlyCacheCleanup() {
  if (LEGACY_IMPORTS_ENABLED) return;
  const compactState = compactStateForStorage(state);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(compactState));
    localStorage.setItem(IMPORT_URLS_STORAGE_KEY, JSON.stringify(state.importUrls || {}));
  } catch (error) {
    console.warn("No se pudo limpiar el cache local viejo.", error);
  }
  if (canUseServerState()) saveStateToServer(compactState);
}

function stripRowSource(rows) {
  return rows.map((row) => {
    const { source, ...rest } = row;
    return rest;
  });
}

// Reconstruye los selectores de perĂ­odo usando aĂ±os presentes en datos importados.
function setupPeriodSelectors() {
  const years = new Set([
    new Date().getFullYear() - 1,
    new Date().getFullYear(),
    new Date().getFullYear() + 1,
    ...state.expenses.map((row) => new Date(row.date).getFullYear()),
    ...state.sales.map((row) => new Date(row.date).getFullYear()),
    ...state.orderDetails.filter((row) => row.date).map((row) => new Date(row.date).getFullYear()),
    ...state.inventory.map((row) => new Date(row.date).getFullYear()),
    ...state.inventoryDetails.map((row) => new Date(row.date).getFullYear()),
    ...state.payroll.map((row) => new Date(row.date).getFullYear())
  ]);

  const periodYears = [...years]
    .filter((year) => Number.isFinite(year))
    .sort((a, b) => a - b);

  els["period-select"].innerHTML = periodYears
    .flatMap((year) => MONTHS.map((month, index) => (
      `<option value="${year}-${index}">${month} ${year}</option>`
    )))
    .join("");

  els["period-select"].value = `${state.selectedYear}-${state.selectedMonth}`;
  els["comparison-select"].value = state.selectedComparison || "none";
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  document.querySelectorAll("[data-nav-toggle]").forEach((button) => {
    button.addEventListener("click", () => toggleNavGroup(button));
  });

  els["period-select"].addEventListener("change", () => {
    const [year, month] = els["period-select"].value.split("-").map(Number);
    state.selectedYear = year;
    state.selectedMonth = month;
    saveState();
    render();
  });

  els["comparison-select"].addEventListener("change", () => {
    state.selectedComparison = els["comparison-select"].value;
    saveState();
    render();
  });

  els["dashboard-checks-widget"]?.addEventListener("click", () => toggleDashboardWidget("checks"));
  els["dashboard-checks-widget"]?.addEventListener("keydown", (event) => activateDashboardWidgetFromKeyboard(event, "checks"));
  els["dashboard-inventory-widget"]?.addEventListener("click", () => toggleDashboardWidget("inventory"));
  els["dashboard-inventory-widget"]?.addEventListener("keydown", (event) => activateDashboardWidgetFromKeyboard(event, "inventory"));
  els["dashboard-purchases-widget"]?.addEventListener("click", () => toggleDashboardWidget("purchases"));
  els["dashboard-purchases-widget"]?.addEventListener("keydown", (event) => activateDashboardWidgetFromKeyboard(event, "purchases"));
  els["dashboard-orders-widget"]?.addEventListener("click", () => toggleDashboardWidget("orders"));
  els["dashboard-orders-widget"]?.addEventListener("keydown", (event) => activateDashboardWidgetFromKeyboard(event, "orders"));

  document.querySelectorAll("[data-load-url]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!LEGACY_IMPORTS_ENABLED) return;
      const input = document.querySelector(`[data-url="${button.dataset.loadUrl}"]`);
      if (input) saveImportUrl(input);
      loadCsvFromUrl(button.dataset.loadUrl, button, true);
    });
  });

  document.querySelectorAll("[data-edit-url]").forEach((button) => {
    button.addEventListener("click", () => editImportUrl(button.dataset.editUrl));
  });

  document.querySelectorAll("[data-url]").forEach((input) => {
    input.addEventListener("input", () => saveImportUrl(input));
    input.addEventListener("change", () => {
      saveImportUrl(input);
      loadCsvFromUrl(input.dataset.url);
      setImportUrlEditing(input, false);
    });
    input.addEventListener("paste", () => {
      window.setTimeout(() => {
        saveImportUrl(input);
        loadCsvFromUrl(input.dataset.url);
      }, 120);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveImportUrl(input);
        loadCsvFromUrl(input.dataset.url);
        setImportUrlEditing(input, false);
      }
    });
    input.addEventListener("blur", () => {
      saveImportUrl(input);
      setImportUrlEditing(input, false);
    });
  });

  els["refresh-imports"].addEventListener("click", () => {
    if (!LEGACY_IMPORTS_ENABLED) return;
    refreshAllImports();
  });
  els["save-backend-sources"]?.addEventListener("click", () => saveBackendSourcesFromInputs());
  els["refresh-backend-cache"]?.addEventListener("click", () => refreshBackendCache());
  els["refresh-data-map"]?.addEventListener("click", () => loadDataMap(true));
  els["data-map-module"]?.addEventListener("change", () => renderDataMap());
  els["data-map-only-issues"]?.addEventListener("change", () => renderDataMap());
  els["creditor-entry-type"]?.addEventListener("change", renderCreditorEntrySpecificFields);
  els["creditor-entry-add-supplier-item"]?.addEventListener("click", () => {
    cacheCreditorEntrySupplierItems();
    creditorEntrySupplierItems.push({ idInsumo: "", udProveedor: "", cantidadProveedor: "", precio: "", iva: "21" });
    renderCreditorEntrySupplierItems();
  });
  els["creditor-entry-supplier-items-rows"]?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-supplier-item]");
    if (!button) return;
    cacheCreditorEntrySupplierItems();
    creditorEntrySupplierItems.splice(Number(button.dataset.removeSupplierItem), 1);
    renderCreditorEntrySupplierItems();
  });
  els["creditor-entry-form"]?.addEventListener("submit", submitCreditorEntry);
  els["data-editor-table"]?.addEventListener("change", () => loadDataEditorTable("primary"));
  els["data-editor-table-secondary"]?.addEventListener("change", () => loadDataEditorTable("secondary"));
  els["data-editor-load"]?.addEventListener("click", () => loadDataEditorTable("primary"));
  els["data-editor-load-secondary"]?.addEventListener("click", () => loadDataEditorTable("secondary"));
  els["data-editor-add-row"]?.addEventListener("click", () => addDataEditorRow("primary"));
  els["data-editor-add-row-secondary"]?.addEventListener("click", () => addDataEditorRow("secondary"));
  els["data-editor-delete-row"]?.addEventListener("click", () => deleteSelectedDataEditorRow("primary"));
  els["data-editor-delete-row-secondary"]?.addEventListener("click", () => deleteSelectedDataEditorRow("secondary"));
  els["data-editor-save"]?.addEventListener("click", () => saveDataEditorChanges("primary"));
  els["data-editor-save-secondary"]?.addEventListener("click", () => saveDataEditorChanges("secondary"));
  els["data-editor-body"]?.addEventListener("input", (event) => {
    const filterInput = event.target.closest("[data-editor-filter-input]");
    if (filterInput) {
      updateDataEditorColumnFilter(filterInput, "primary");
      return;
    }
    const input = event.target.closest("[data-editor-input]");
    if (!input) return;
    markDataEditorRowChanged(input, "primary");
  });
  els["data-editor-body"]?.addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-editor-column-checkbox]");
    if (checkbox) updateDataEditorVisibleColumns("primary");
  });
  els["data-editor-body"]?.addEventListener("click", (event) => {
    const columnAction = event.target.closest("[data-editor-column-action]");
    if (columnAction) {
      applyDataEditorColumnAction(columnAction.dataset.editorColumnAction, "primary");
      return;
    }
    const filterButton = event.target.closest("[data-editor-filter-toggle]");
    if (filterButton) {
      toggleDataEditorColumnFilter(filterButton.dataset.column || "", "primary");
      return;
    }
    const rowElement = event.target.closest("[data-editor-row]");
    if (!rowElement) return;
    selectDataEditorRow(rowElement.dataset.editorRow || "", "primary");
  });
  els["data-editor-body-secondary"]?.addEventListener("input", (event) => {
    const filterInput = event.target.closest("[data-editor-filter-input]");
    if (filterInput) {
      updateDataEditorColumnFilter(filterInput, "secondary");
      return;
    }
    const input = event.target.closest("[data-editor-input]");
    if (!input) return;
    markDataEditorRowChanged(input, "secondary");
  });
  els["data-editor-body-secondary"]?.addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-editor-column-checkbox]");
    if (checkbox) updateDataEditorVisibleColumns("secondary");
  });
  els["data-editor-body-secondary"]?.addEventListener("click", (event) => {
    const columnAction = event.target.closest("[data-editor-column-action]");
    if (columnAction) {
      applyDataEditorColumnAction(columnAction.dataset.editorColumnAction, "secondary");
      return;
    }
    const filterButton = event.target.closest("[data-editor-filter-toggle]");
    if (filterButton) {
      toggleDataEditorColumnFilter(filterButton.dataset.column || "", "secondary");
      return;
    }
    const rowElement = event.target.closest("[data-editor-row]");
    if (!rowElement) return;
    selectDataEditorRow(rowElement.dataset.editorRow || "", "secondary");
  });
  els["sql-run"]?.addEventListener("click", () => runSqlQuery());
  els["sql-query"]?.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      runSqlQuery();
    }
  });
  document.querySelectorAll("[data-sql-example]").forEach((button) => {
    button.addEventListener("click", () => {
      if (els["sql-query"]) els["sql-query"].value = button.dataset.sqlExample;
      runSqlQuery();
    });
  });
  document.querySelectorAll("[data-edit-backend-url]").forEach((button) => {
    button.addEventListener("click", () => editBackendSourceUrl(button.dataset.editBackendUrl));
  });
  document.querySelectorAll("[data-refresh-backend-url]").forEach((button) => {
    button.addEventListener("click", () => refreshBackendCache([button.dataset.refreshBackendUrl], button));
  });
  document.querySelectorAll("[data-backend-url]").forEach((input) => {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveBackendSourcesFromInputs();
        setBackendSourceEditing(input, false);
      }
    });
    input.addEventListener("blur", () => setBackendSourceEditing(input, false));
  });

  setupBankReconciliationFileDropZone();
  els["bank-reconciliation-file"]?.addEventListener("change", () => readBankReconciliationFile());
  els["bank-reconciliation-file-clear"]?.addEventListener("click", () => clearBankReconciliationFile());
  els["bank-reconciliation-analyze"]?.addEventListener("click", () => analyzeBankReconciliation());
  els["bank-reconciliation-apply"]?.addEventListener("click", () => applyBankReconciliation("reconcile"));
  els["bank-create-expenses"]?.addEventListener("click", () => applyBankReconciliation("createExpenses"));
  els["bank-create-egresses"]?.addEventListener("click", () => applyBankReconciliation("createEgresses"));
  els["bank-create-payments"]?.addEventListener("click", () => applyBankReconciliation("createPayments"));
  els["bank-check-deposit-body"]?.addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-bank-check-deposit-select]");
    if (!checkbox || !bankCheckDepositDraft) return;
    const checkId = String(checkbox.dataset.bankCheckDepositSelect || "");
    if (checkbox.checked) bankCheckDepositDraft.selectedIds.add(checkId);
    else bankCheckDepositDraft.selectedIds.delete(checkId);
    renderBankCheckDepositReview();
  });
  els["bank-check-deposit-confirm"]?.addEventListener("click", () => confirmBankCheckDeposit());
  els["bank-check-deposit-movement"]?.addEventListener("change", () => {
    if (!bankCheckDepositDraft) return;
    const value = els["bank-check-deposit-movement"].value;
    bankCheckDepositDraft.movementIndex = value === "" ? null : Number(value);
    const movement = bankReconciliationReport?.movements?.[bankCheckDepositDraft.movementIndex];
    bankCheckDepositDraft.movementKey = movement?.movementKey || "";
    if (movement?.date) bankCheckDepositDraft.depositDate = bankCheckDepositDateInput(movement.date);
    bankCheckDepositDraft.selectedIds.clear();
    renderBankCheckDepositReview();
  });
  els["bank-check-deposit-date"]?.addEventListener("change", () => {
    if (bankCheckDepositDraft) bankCheckDepositDraft.depositDate = els["bank-check-deposit-date"].value;
  });
  els["bank-check-deposit-bank"]?.addEventListener("change", () => {
    if (bankCheckDepositDraft) bankCheckDepositDraft.bank = els["bank-check-deposit-bank"].value;
  });
  els["bank-expense-stage-body"]?.addEventListener("click", (event) => {
    const removeButton = event.target.closest("[data-bank-stage-remove]");
    if (!removeButton) return;
    bankReconciliationExcludedMovementKeys.add(removeButton.dataset.bankStageRemove || "");
    renderBankReconciliationStages();
  });
  els["bank-reconciliation-body"]?.addEventListener("click", (event) => {
    const depositReviewButton = event.target.closest("[data-bank-review-check-deposit]");
    if (depositReviewButton) {
      const movementIndex = Number(depositReviewButton.dataset.bankReviewCheckDeposit);
      const movement = bankReconciliationReport?.movements?.[movementIndex];
      bankCheckDepositDraft = {
        movementIndex,
        movementKey: movement?.movementKey || "",
        candidates: [],
        selectedIds: new Set()
      };
      switchView("deposited-checks-entry");
      return;
    }

    const debtReviewButton = event.target.closest("[data-bank-review-debt]");
    if (debtReviewButton) {
      openBankPaymentDebtReview(Number(debtReviewButton.dataset.bankReviewDebt));
      return;
    }

    const creditorButton = event.target.closest("[data-bank-add-creditor]");
    if (creditorButton) {
      openBankCreditorDraft(Number(creditorButton.dataset.bankAddCreditor));
      return;
    }

    const clientButton = event.target.closest("[data-bank-add-client]");
    if (clientButton) {
      openBankClientDraft(Number(clientButton.dataset.bankAddClient));
      return;
    }

    const bankDataButton = event.target.closest("[data-bank-add-data]");
    if (bankDataButton) {
      openBankDataDraft(Number(bankDataButton.dataset.bankAddData));
      return;
    }

    const collectionButton = event.target.closest("[data-bank-add-collection]");
    if (collectionButton) {
      openBankCollectionDraft(Number(collectionButton.dataset.bankAddCollection));
      return;
    }

    const negativeExpenseButton = event.target.closest("[data-bank-add-negative-expense]");
    if (negativeExpenseButton) {
      openBankNegativeExpenseDraft(Number(negativeExpenseButton.dataset.bankAddNegativeExpense));
      return;
    }

    const partnerContributionButton = event.target.closest("[data-bank-partner-contribution]");
    if (partnerContributionButton) {
      openBankPartnerContributionDraft(Number(partnerContributionButton.dataset.bankPartnerContribution));
      return;
    }

    const checkButton = event.target.closest("[data-bank-add-check]");
    if (checkButton) {
      openBankCheckDraft(Number(checkButton.dataset.bankAddCheck));
      return;
    }

    const purchaseButton = event.target.closest("[data-bank-add-purchase]");
    if (purchaseButton) {
      openBankPurchaseDraft(Number(purchaseButton.dataset.bankAddPurchase));
      return;
    }

    const receptionButton = event.target.closest("[data-bank-add-reception]");
    if (receptionButton) {
      openBankReceptionDraft(Number(receptionButton.dataset.bankAddReception));
      return;
    }

    const issuedCheckButton = event.target.closest("[data-bank-add-issued-check]");
    if (issuedCheckButton) {
      openBankIssuedCheckDraft(Number(issuedCheckButton.dataset.bankAddIssuedCheck));
    }
  });

  els["inventory-date-input"].addEventListener("change", () => loadInventoryDetailTemplate());
  document.querySelectorAll("[data-inventory-shift]").forEach((input) => {
    input.addEventListener("change", () => {
      clearDisabledInventoryShiftInputs();
      updateInventoryCounterReview();
      updateTheoreticalInventoryStock();
    });
  });
  els["inventory-detail-load"].addEventListener("click", () => loadInventoryDetailTemplate());
  setupInventoryPhotoDropZone();
  els["inventory-photo-input"].addEventListener("change", () => updateInventoryPhotoFileChip());
  els["inventory-photo-clear"].addEventListener("click", () => clearInventoryPhotoFile());
  els["inventory-photo-read"].addEventListener("click", () => readInventoryPhoto());
  els["inventory-detail-body"]?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-purchase-item]");
    if (!button) return;
    openPurchaseEntryForItem(button.dataset.purchaseItem, button.dataset.purchaseItemId);
  });
  els["inventory-detail-form"].addEventListener("submit", submitInventoryDetail);
  els["purchase-provider"]?.addEventListener("change", () => {
    syncSelectedPurchaseSupplier();
    updatePurchaseExpectedDate();
    updatePurchaseUnitsAfterSelection();
  });
  els["purchase-item-name"]?.addEventListener("change", () => {
    syncSelectedPurchaseSupply();
    updatePurchaseProviderOptions();
    updatePurchaseExpectedDate();
    updatePurchaseUnitsAfterSelection();
  });
  els["purchase-order-date"]?.addEventListener("change", updatePurchaseExpectedDate);
  els["purchase-expected-date"]?.addEventListener("change", updatePurchaseSummary);
  els["purchase-quantity"]?.addEventListener("input", () => updatePurchaseUnitsFromField("count"));
  els["purchase-recipe-quantity"]?.addEventListener("input", () => updatePurchaseUnitsFromField("recipe"));
  els["purchase-supplier-quantity"]?.addEventListener("input", () => updatePurchaseUnitsFromField("supplier"));
  els["purchase-invoice-type"]?.addEventListener("change", () => updatePurchasePricing("invoiceType"));
  els["purchase-subtotal"]?.addEventListener("input", () => updatePurchasePricing("subtotal"));
  els["purchase-iva"]?.addEventListener("input", () => updatePurchasePricing("iva"));
  document.querySelectorAll("[data-purchase-order-toggle]").forEach((input) => {
    input.addEventListener("change", updatePurchaseSummary);
  });
  els["purchase-download-png"]?.addEventListener("click", downloadPurchaseOrderPng);
  els["purchase-form"]?.addEventListener("submit", submitPurchase);
  els["reception-pending-body"]?.addEventListener("click", (event) => {
    const checkbox = event.target.closest("[data-reception-purchase-select]");
    if (checkbox) {
      event.stopPropagation();
      toggleReceptionPurchaseSelection(checkbox.dataset.receptionPurchaseSelect, checkbox.checked);
      return;
    }
    const row = event.target.closest("[data-reception-purchase-id]");
    if (!row) return;
    selectReceptionPendingPurchase(row.dataset.receptionPurchaseId);
  });
  els["reception-purchase-id"]?.addEventListener("change", fillReceptionFromSelectedPurchase);
  els["reception-supplier-quantity"]?.addEventListener("input", () => updateReceptionQuantitiesFromField("supplier"));
  els["reception-quantity"]?.addEventListener("input", () => updateReceptionQuantitiesFromField("count"));
  els["reception-recipe-quantity"]?.addEventListener("input", () => updateReceptionQuantitiesFromField("recipe"));
  setupReceptionFileDropZone();
  els["reception-file"]?.addEventListener("change", () => {
    updateReceptionFileName();
  });
  els["reception-file-clear"]?.addEventListener("click", clearReceptionFile);
  els["reception-invoice-read"]?.addEventListener("click", autofillReceptionExpenseFromAttachment);
  els["reception-without-file"]?.addEventListener("change", updateReceptionWithoutFile);
  ["reception-expense-subtotal", "reception-expense-iva", "reception-expense-vat-retention", "reception-expense-iibb-retention", "reception-expense-internal-taxes"]
    .forEach((id) => els[id]?.addEventListener("input", updateReceptionExpenseTotalFromInputs));
  els["reception-expense-total"]?.addEventListener("input", () => {
    els["reception-expense-total"].dataset.touched = "true";
    validateReceptionExpenseAgainstReference();
  });
  els["reception-expense-invoice-type"]?.addEventListener("change", () => {
    if (els["reception-without-file"]?.checked) autofillReceptionExpenseFromPurchase({ keepInvoiceNumber: true });
    else validateReceptionExpenseAgainstReference();
  });
  els["reception-form"]?.addEventListener("submit", submitReceptionEntry);

  els["orders-form"]?.addEventListener("submit", submitOrderEntry);
  els["logistics-pending-body"]?.addEventListener("change", updateLogisticsOrderSelectionSummary);
  els["logistics-delivery-create"]?.addEventListener("click", createDeliveryForSelectedOrders);
  els["logistics-expense-delivery-body"]?.addEventListener("change", updateLogisticsExpenseSelectionSummary);
  setupLogisticsFileDropZone();
  els["logistics-file"]?.addEventListener("change", updateLogisticsFileName);
  els["logistics-file-clear"]?.addEventListener("click", clearLogisticsFile);
  els["logistics-invoice-read"]?.addEventListener("click", autofillLogisticsExpenseFromAttachment);
  els["logistics-without-file"]?.addEventListener("change", updateLogisticsWithoutFile);
  ["logistics-expense-subtotal", "logistics-expense-iva", "logistics-expense-vat-retention", "logistics-expense-iibb-retention", "logistics-expense-internal-taxes"]
    .forEach((id) => els[id]?.addEventListener("input", updateLogisticsExpenseTotalFromInputs));
  els["logistics-expense-total"]?.addEventListener("input", () => {
    els["logistics-expense-total"].dataset.touched = "true";
  });
  els["logistics-expense-invoice-type"]?.addEventListener("change", () => {
    if (els["logistics-without-file"]?.checked) autofillLogisticsExpenseWithoutFile({ keepInvoiceNumber: true });
  });
  els["logistics-expense-invoice-date"]?.addEventListener("change", autofillLogisticsPaymentDateFromAgreement);
  els["logistics-expense-payment-date"]?.addEventListener("input", () => {
    delete els["logistics-expense-payment-date"].dataset.autoAgreement;
  });
  els["logistics-expense-form"]?.addEventListener("submit", submitLogisticsExpenseEntry);
  setupOtherExpenseFileDropZone();
  els["other-expense-file"]?.addEventListener("change", updateOtherExpenseFileName);
  els["other-expense-file-clear"]?.addEventListener("click", clearOtherExpenseFile);
  els["other-expense-invoice-read"]?.addEventListener("click", autofillOtherExpenseFromAttachment);
  els["other-expense-creditor-search"]?.addEventListener("input", () => {
    const typedName = normalizeSearchText(els["other-expense-creditor-search"].value);
    const match = otherExpenseCreditorOptions().find((creditor) => (
      normalizeSearchText(otherExpenseCreditorLabel(creditor)) === typedName
    ));
    els["other-expense-creditor"].value = match ? backendId(match.id_acreedor) : "";
    updateOtherExpenseCreditorTags();
    autofillOtherExpensePaymentDateFromAgreement({ force: true });
    renderOtherExpenseCreditorSuggestions(typedName);
  });
  els["other-expense-creditor-search"]?.addEventListener("focus", () => renderOtherExpenseCreditorSuggestions());
  els["other-expense-creditor-search"]?.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (!els["other-expense-creditor-suggestions"]?.contains(document.activeElement)) {
        els["other-expense-creditor-suggestions"].hidden = true;
      }
    }, 120);
  });
  els["other-expense-creditor-suggestions"]?.addEventListener("click", (event) => {
    const option = event.target.closest("[data-creditor-id]");
    if (!option) return;
    const creditor = otherExpenseEntryData.creditors.find((row) => (
      backendId(row.id_acreedor) === backendId(option.dataset.creditorId)
    ));
    if (creditor) selectOtherExpenseCreditor(creditor);
  });
  els["other-expense-invoice-date"]?.addEventListener("change", () => autofillOtherExpensePaymentDateFromAgreement());
  els["other-expense-payment-date"]?.addEventListener("input", () => {
    delete els["other-expense-payment-date"].dataset.autoAgreement;
  });
  els["other-expense-invoice-type"]?.addEventListener("change", () => {
    setAutomaticOtherExpenseInvoiceNumber();
    updateOtherExpenseIvaFromSubtotal({ force: true });
    updateOtherExpenseTotalFromInputs();
  });
  els["other-expense-invoice-number"]?.addEventListener("input", () => {
    delete els["other-expense-invoice-number"].dataset.autoOtherExpenseId;
  });
  els["other-expense-subtotal"]?.addEventListener("input", () => {
    updateOtherExpenseIvaFromSubtotal();
    updateOtherExpenseTotalFromInputs();
  });
  els["other-expense-iva"]?.addEventListener("input", () => {
    els["other-expense-iva"].dataset.touched = "true";
    updateOtherExpenseTotalFromInputs();
  });
  ["other-expense-vat-retention", "other-expense-iibb-retention", "other-expense-internal-taxes"]
    .forEach((id) => els[id]?.addEventListener("input", updateOtherExpenseTotalFromInputs));
  els["other-expense-total"]?.addEventListener("input", () => {
    els["other-expense-total"].dataset.touched = "true";
  });
  els["other-expense-form"]?.addEventListener("submit", submitOtherExpenseEntry);
  els["partner-contribution-form"]?.addEventListener("submit", submitPartnerContribution);
  els["sales-client-filter"]?.addEventListener("change", renderSalesEntry);
  els["sales-debt-download"]?.addEventListener("click", downloadSalesDebtSummaryPng);
  els["collection-client"]?.addEventListener("change", renderCollectionsEntry);
  els["collections-invoice-body"]?.addEventListener("change", updateCollectionTotal);
  els["collections-invoice-body"]?.addEventListener("input", updateCollectionTotal);
  els["collection-received-total"]?.addEventListener("input", () => {
    els["collection-received-total"].dataset.touched = "true";
    updateCollectionTotal();
  });
  els["collection-income-tax-retention"]?.addEventListener("input", updateCollectionTotal);
  els["collection-iibb-retention"]?.addEventListener("input", updateCollectionTotal);
  els["collections-form"]?.addEventListener("submit", submitCollectionEntry);
  els["commissions-month-filter"]?.addEventListener("change", renderCommissionsEntry);
  els["commissions-channel-filter"]?.addEventListener("change", renderCommissionsEntry);
  els["commissions-collection-body"]?.addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-commission-collection-select]");
    if (!checkbox) return;
    const collectionId = backendId(checkbox.dataset.commissionCollectionSelect);
    if (checkbox.checked) selectedCommissionCollectionIds.add(collectionId);
    else selectedCommissionCollectionIds.delete(collectionId);
    updateCommissionExpenseDraft();
  });
  [
    "commissions-expense-subtotal",
    "commissions-expense-iva",
    "commissions-expense-vat-retention",
    "commissions-expense-iibb-retention",
    "commissions-expense-internal-taxes"
  ].forEach((id) => els[id]?.addEventListener("input", () => {
    if (els[id]) els[id].dataset.touched = "true";
    updateCommissionExpenseTotal();
  }));
  els["commissions-expense-invoice-type"]?.addEventListener("change", updateCommissionExpenseDraft);
  els["commissions-expense-form"]?.addEventListener("submit", submitCommissionExpenseEntry);
  els["received-check-pending-body"]?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-create-received-check]");
    if (button) openReceivedCheckDraft(button.dataset.createReceivedCheck);
  });
  els["received-check-form"]?.addEventListener("submit", submitReceivedCheckEntry);
  els["issued-check-pending-body"]?.addEventListener("click", (event) => {
    const row = event.target.closest("[data-issued-check-payment-id]");
    if (row) fillIssuedCheckFromSelectedPayment(row.dataset.issuedCheckPaymentId);
  });
  els["issued-check-form"]?.addEventListener("submit", submitIssuedCheckEntry);
  els["payment-search"]?.addEventListener("input", renderPaymentPendingExpenses);
  els["payment-creditor-filter"]?.addEventListener("change", renderPaymentPendingExpenses);
  els["payment-pending-body"]?.addEventListener("change", (event) => {
    if (event.target.closest("[data-payment-select]") || event.target.closest("[data-payment-amount]")) {
      updatePaymentSelectedTotal();
    }
  });
  els["payment-pending-body"]?.addEventListener("input", (event) => {
    if (event.target.closest("[data-payment-amount]")) updatePaymentSelectedTotal();
  });
  els["payment-bank-amount"]?.addEventListener("input", updatePaymentSelectedTotal);
  els["payment-form"]?.addEventListener("submit", submitPaymentEntry);
  els["salary-period-select"]?.addEventListener("change", () => {
    state.payrollEntry.selectedPeriod = els["salary-period-select"].value;
    saveState();
    renderSalaryEntry();
  });
  els["salary-scale-file"]?.addEventListener("change", updateSalaryScaleFileName);
  els["salary-scale-read"]?.addEventListener("click", readSalaryScaleFile);
  els["salary-add-exception"]?.addEventListener("click", addSalaryExceptionRow);
  els["salary-save-backend"]?.addEventListener("click", saveSalaryEntryToBackend);
  els["salary-labor-costs"]?.addEventListener("input", updateSalaryLaborCostSetting);
  els["salary-labor-costs"]?.addEventListener("change", updateSalaryLaborCostSetting);
  els["salary-exceptions-body"]?.addEventListener("input", (event) => {
    const input = event.target.closest("[data-salary-exception]");
    if (input) updateSalaryException(input);
  });
  els["salary-exceptions-body"]?.addEventListener("change", (event) => {
    const input = event.target.closest("[data-salary-exception]");
    if (input) updateSalaryException(input);
  });
  els["salary-exceptions-body"]?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-salary-exception-delete]");
    if (button) deleteSalaryException(button.dataset.salaryExceptionDelete);
  });
  els["salary-expense-salary-body"]?.addEventListener("change", updateSalaryExpenseSelectionSummary);
  setupSalaryExpenseFileDropZone();
  els["salary-expense-file"]?.addEventListener("change", updateSalaryExpenseFileName);
  els["salary-expense-file-clear"]?.addEventListener("click", clearSalaryExpenseFile);
  els["salary-expense-invoice-read"]?.addEventListener("click", autofillSalaryExpenseFromAttachment);
  els["salary-expense-without-file"]?.addEventListener("change", updateSalaryExpenseWithoutFile);
  ["salary-expense-subtotal", "salary-expense-iva", "salary-expense-vat-retention", "salary-expense-iibb-retention", "salary-expense-internal-taxes"]
    .forEach((id) => els[id]?.addEventListener("input", () => {
      els[id].dataset.touched = "true";
      updateSalaryExpenseTotalFromInputs();
    }));
  els["salary-expense-total"]?.addEventListener("input", () => {
    els["salary-expense-total"].dataset.touched = "true";
  });
  els["salary-expense-invoice-type"]?.addEventListener("change", () => {
    if (els["salary-expense-without-file"]?.checked) autofillSalaryExpenseWithoutFile({ keepInvoiceNumber: true });
  });
  els["salary-expense-invoice-date"]?.addEventListener("change", autofillSalaryExpensePaymentDate);
  els["salary-expense-payment-date"]?.addEventListener("input", () => {
    delete els["salary-expense-payment-date"].dataset.autoSalaryDueDate;
  });
  els["salary-expense-form"]?.addEventListener("submit", submitSalaryExpenseEntry);

  els["save-settings"].addEventListener("click", () => {
    state.settings = readSettingsForm();
    saveState();
    render();
  });

  els["reset-settings"].addEventListener("click", () => {
    state.settings = structuredClone(DEFAULT_SETTINGS);
    fillSettingsForm();
    saveState();
    render();
  });

  els["clear-data"].addEventListener("click", () => {
    if (!confirm("Borrar ventas, egresos, inventario, sueldos y errores importados?")) return;
    state.expenses = [];
    state.sales = [];
    state.orderDetails = [];
    state.inventory = [];
    state.inventoryDetails = [];
    state.recipes = [];
    state.itemInfo = [];
    state.supplyInfo = [];
    state.purchases = [];
    state.purchaseDetails = [];
    state.providers = [];
    state.payroll = [];
    state.creditors = [];
    state.cash = [];
    state.issuedChecks = [];
    state.receivedChecks = [];
    state.cashflowDateOverrides = {};
    state.importErrors = [];
    saveState();
    setupPeriodSelectors();
    render();
  });

  els["statement-body"].addEventListener("click", (event) => {
    const button = event.target.closest("[data-toggle-group]");
    if (!button) return;
    const group = button.dataset.toggleGroup;
    const isOpen = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", String(!isOpen));
    document.querySelectorAll(`[data-group="${group}"]`).forEach((row) => {
      row.hidden = isOpen;
    });
  });

  els["cashflow-timeline"].addEventListener("click", (event) => {
    if (cashflowSuppressNextClick) {
      cashflowSuppressNextClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const partyButton = event.target.closest("[data-toggle-cashflow-party]");
    if (partyButton) {
      const partyKey = partyButton.dataset.toggleCashflowParty;
      const isPartyOpen = partyButton.getAttribute("aria-expanded") === "true";
      partyButton.setAttribute("aria-expanded", String(!isPartyOpen));
      document.querySelectorAll("[data-cashflow-party]").forEach((row) => {
        if (row.dataset.cashflowParty === partyKey) row.hidden = isPartyOpen;
      });
      return;
    }

    const typeButton = event.target.closest("[data-toggle-cashflow-type]");
    if (typeButton) {
      const typeKey = typeButton.dataset.toggleCashflowType;
      const isTypeOpen = typeButton.getAttribute("aria-expanded") === "true";
      typeButton.setAttribute("aria-expanded", String(!isTypeOpen));
      document.querySelectorAll(".cashflow-party-row[data-cashflow-type]").forEach((row) => {
        if (row.dataset.cashflowType === typeKey) row.hidden = isTypeOpen;
      });
      if (isTypeOpen) {
        document.querySelectorAll(".cashflow-week-detail[data-cashflow-type]").forEach((row) => {
          if (row.dataset.cashflowType === typeKey) row.hidden = true;
        });
        document.querySelectorAll("[data-toggle-cashflow-party]").forEach((partyToggle) => {
          if (partyToggle.dataset.cashflowType === typeKey) partyToggle.setAttribute("aria-expanded", "false");
        });
      }
      return;
    }

    const button = event.target.closest("[data-toggle-cashflow-week]");
    if (!button) return;
    const week = button.dataset.toggleCashflowWeek;
    const isOpen = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", String(!isOpen));
    document.querySelectorAll(`.cashflow-type-row[data-cashflow-week="${week}"], .cashflow-party-row[data-cashflow-week="${week}"]:not([data-cashflow-type])`).forEach((row) => {
      row.hidden = isOpen;
    });
    if (isOpen) {
      document.querySelectorAll(`.cashflow-party-row[data-cashflow-week="${week}"], .cashflow-week-detail[data-cashflow-week="${week}"]`).forEach((row) => {
        row.hidden = true;
      });
      document.querySelectorAll(`[data-toggle-cashflow-type][data-cashflow-week="${week}"]`).forEach((typeToggle) => {
        typeToggle.setAttribute("aria-expanded", "false");
      });
      document.querySelectorAll(`[data-toggle-cashflow-party][data-cashflow-week="${week}"]`).forEach((partyToggle) => {
        partyToggle.setAttribute("aria-expanded", "false");
      });
    }
  });

  els["cashflow-timeline"].addEventListener("change", (event) => {
    const input = event.target.closest("[data-cashflow-key]");
    if (!input) return;
    state.cashflowDateOverrides[input.dataset.cashflowKey] = input.value;
    saveState();
    render();
  });

  els["cashflow-timeline"].addEventListener("mousedown", startCashflowRowDrag);

  els["cashflow-search"].addEventListener("input", () => {
    renderCashflow();
  });
}

function setupInventoryPhotoDropZone() {
  setupFileDropZone({
    dropZone: els["inventory-photo-drop-zone"],
    input: els["inventory-photo-input"],
    acceptFile: (candidate) => candidate.type.startsWith("image/"),
    onAccepted: (file) => {
      updateInventoryPhotoFileChip();
      setInventoryDetailStatus(`Foto lista: ${file.name}`, "success");
    },
    onRejected: () => setInventoryDetailStatus("Arrastra una imagen valida para leer el inventario.", "error")
  });
}

function updateInventoryPhotoFileChip() {
  const file = els["inventory-photo-input"]?.files?.[0];
  if (!els["inventory-photo-file-chip"]) return;

  els["inventory-photo-file-chip"].classList.toggle("is-empty", !file);
  els["inventory-photo-file-name"].textContent = file ? file.name : "Sin archivo";
  els["inventory-photo-file-size"].textContent = file ? formatFileSize(file.size) : "-";
}

function clearInventoryPhotoFile() {
  if (!els["inventory-photo-input"]) return;
  els["inventory-photo-input"].value = "";
  updateInventoryPhotoFileChip();
  setInventoryDetailStatus("", "");
}

function initializeInventoryEntryDefaults({ force = false } = {}) {
  setInventoryDefaultDateFromLatestStock({ force });

  if (els["inventory-employee-input"] && (force || !els["inventory-employee-input"].value.trim())) {
    els["inventory-employee-input"].value = "Alcaraz_Pablo_Nicolas";
  }

  const dawn = document.querySelector('[data-inventory-shift="dawn"]');
  const morning = document.querySelector('[data-inventory-shift="morning"]');
  const afternoon = document.querySelector('[data-inventory-shift="afternoon"]');
  if (dawn && (force || !dawn.checked)) dawn.checked = false;
  if (morning && (force || !morning.checked)) morning.checked = true;
  if (afternoon && (force || !afternoon.checked)) afternoon.checked = true;
}

function setInventoryDefaultDateFromLatestStock({ force = false } = {}) {
  if (!els["inventory-date-input"]) return false;
  const nextDate = nextBusinessDayAfterLastInventory();
  if (!force && els["inventory-date-input"].value) return false;
  const changed = els["inventory-date-input"].value !== nextDate;
  els["inventory-date-input"].value = nextDate;
  return changed;
}

async function refreshInventoryDefaultDateFromSheets({ force = true } = {}) {
  if (!els["inventory-date-input"]) return false;
  if (!force && els["inventory-date-input"].value) return false;

  try {
    const response = await fetch(`${API_BASE_URL}/api/inventory/latest-date`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.nextDate) return false;

    const changed = els["inventory-date-input"].value !== payload.nextDate;
    els["inventory-date-input"].value = payload.nextDate;
    return changed;
  } catch {
    return false;
  }
}

function nextBusinessDayAfterLastInventory() {
  const lastIso = state.inventory
    .map((row) => row.date)
    .filter(Boolean)
    .sort()
    .at(-1);

  const date = lastIso ? dateFromIso(lastIso) : new Date();
  if (lastIso) date.setDate(date.getDate() + 1);
  while ([0, 6].includes(date.getDay())) {
    date.setDate(date.getDate() + 1);
  }
  return toIsoDate(date);
}

function initializeOperationalEntryDefaults() {
  const today = toIsoDate(new Date());
  if (els["reception-date"] && !els["reception-date"].value) els["reception-date"].value = today;
  if (els["reception-employee-id"] && !els["reception-employee-id"].value) els["reception-employee-id"].value = "Alcaraz_Pablo_Nicolas";
  if (els["issued-check-date"] && !els["issued-check-date"].value) els["issued-check-date"].value = today;
  if (els["issued-check-use-date"] && !els["issued-check-use-date"].value) els["issued-check-use-date"].value = today;
  if (els["issued-check-bank"] && !els["issued-check-bank"].value) els["issued-check-bank"].value = "ICBC";
  if (els["issued-check-state"] && !els["issued-check-state"].value) els["issued-check-state"].value = "Pendiente";
}

function initializeSalaryEntry() {
  if (!els["salary-period-select"]) return;
  salaryEntryScale = state.payrollEntry.scale || { categories: {}, sourceName: "" };
  renderSalaryPeriodOptions();
  Promise.all([
    loadSalaryEmployees(),
    loadSalaryExpenseEntryData(true)
  ]).then(renderSalaryEntry);
}

function currentPayrollPeriodKey() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
}

function previousPayrollPeriodKey() {
  const today = new Date();
  const previous = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  return `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, "0")}`;
}

function renderSalaryPeriodOptions() {
  const options = [previousPayrollPeriodKey(), currentPayrollPeriodKey()];
  if (!options.includes(state.payrollEntry.selectedPeriod)) {
    state.payrollEntry.selectedPeriod = currentPayrollPeriodKey();
  }
  els["salary-period-select"].innerHTML = options.map((periodKey) => {
    const [year, month] = periodKey.split("-").map(Number);
    const label = `${MONTHS[month - 1]} ${year}${periodKey === currentPayrollPeriodKey() ? " (vigente)" : " (ultimo cerrado)"}`;
    return `<option value="${periodKey}">${label}</option>`;
  }).join("");
  els["salary-period-select"].value = state.payrollEntry.selectedPeriod;
}

async function loadSalaryEmployees() {
  try {
    const rows = await backendTableRowsForEntry("empleados");
    salaryEntryEmployees = rows
      .filter((employee) => employeeHasActivePayrollStatus(employee))
      .map((employee) => ({
        id: String(employee.id_empleado || "").trim(),
        name: String(employee.nombre_empleado || employee.nombre || "").trim(),
        category: String(employee.categoria_empleado || employee.categoria || "OPERARIO").trim(),
        contractType: normalizeEmployeeContractType(employee.contratacion, employee.nombre_empleado || employee.nombre)
      }))
      .filter((employee) => employee.id && employee.name);
  } catch {
    salaryEntryEmployees = [];
  }
}

function employeeHasActivePayrollStatus(employee) {
  const startDate = String(employee.fecha_alta || "").trim();
  const endDate = String(employee.fecha_baja || "").trim();
  return Boolean(startDate) && !endDate;
}

function normalizeEmployeeContractType(value, employeeName = "") {
  const explicitType = String(value || "").trim();
  if (explicitType) return explicitType;

  const normalizedName = normalizeSearchText(employeeName);
  if (normalizedName.includes("alcaraz pablo") || normalizedName.includes("alcarez pablo") || normalizedName.includes("milciades ayala")) {
    return "Relacion de dependencia";
  }
  if (normalizedName.includes("alexis kolln")) return "Blue";
  return "Cooperativa";
}

function selectedSalaryPeriodBounds() {
  const [year, month] = (state.payrollEntry.selectedPeriod || currentPayrollPeriodKey()).split("-").map(Number);
  const start = new Date(year, month - 1, 1);
  const naturalEnd = new Date(year, month, 0);
  const today = new Date();
  const isCurrentMonth = year === today.getFullYear() && month === today.getMonth() + 1;
  const end = isCurrentMonth && today < naturalEnd ? today : naturalEnd;
  return { year, month, startIso: toIsoDate(start), endIso: toIsoDate(end), naturalEndIso: toIsoDate(naturalEnd), isCurrentMonth };
}

function buildSalaryBaseHours(period) {
  let workedDays = 0;
  let holidayDays = 0;
  for (let cursor = dateFromIso(period.startIso); cursor <= dateFromIso(period.endIso); cursor = addDays(cursor, 1)) {
    const iso = toIsoDate(cursor);
    const weekday = cursor.getDay() !== 0 && cursor.getDay() !== 6;
    if (!weekday) continue;
    if (ARGENTINA_NON_WORKING_DAYS.has(iso)) holidayDays += 1;
    else workedDays += 1;
  }
  return {
    workedHours: workedDays * 8,
    holidayHours: holidayDays * 8,
    workedDays,
    holidayDays
  };
}

function salaryExceptionsForPeriod(periodKey) {
  return (state.payrollEntry.exceptions || []).filter((entry) => entry.period === periodKey);
}

function buildSalaryRows() {
  const period = selectedSalaryPeriodBounds();
  const base = buildSalaryBaseHours(period);
  const exceptions = salaryExceptionsForPeriod(state.payrollEntry.selectedPeriod);
  return salaryEntryEmployees.map((employee) => {
    const row = {
      employee,
      valorRemunerativo: 0,
      valorNoRemunerativo: 0,
      workedHours: base.workedHours,
      justifiedHours: 0,
      holidayHours: base.holidayHours,
      extraHours: 0,
      awards: 0
    };

    exceptions
      .filter((entry) => entry.employeeId === employee.id)
      .forEach((entry) => applySalaryException(row, entry));

    const scale = salaryScaleForCategory(employee.category);
    const paidBaseHours = row.workedHours + row.justifiedHours + row.holidayHours;
    if (scale.type === "hourly") {
      row.valorRemunerativo = paidBaseHours * scale.remunerative + row.extraHours * scale.remunerative * 1.5;
      row.valorNoRemunerativo = scale.nonRemunerative;
    } else {
      row.valorRemunerativo = scale.remunerative;
      row.valorNoRemunerativo = scale.nonRemunerative;
    }
    row.sueldoBruto = row.valorRemunerativo + row.valorNoRemunerativo + row.awards;
    // Estimacion conservadora: hasta modelar aportes reales, se expone un neto aproximado para control operativo.
    row.sueldoNeto = row.sueldoBruto * 0.83;
    return row;
  });
}

function applySalaryException(row, entry) {
  const amount = salaryExceptionAmount(entry);
  if (!Number.isFinite(amount) || amount <= 0) return;
  if (["absence_unjustified", "late_arrival", "early_leave"].includes(entry.type)) {
    row.workedHours = Math.max(0, row.workedHours - amount);
  }
  if (entry.type === "absence_justified") {
    row.workedHours = Math.max(0, row.workedHours - amount);
    row.justifiedHours += amount;
  }
  if (entry.type === "extra_hours") row.extraHours += amount;
  if (entry.type === "award") row.awards += amount;
}

function salaryExceptionAmount(entry) {
  if (entry.type === "award") return parseMoney(entry.hours);
  return parseMoney(entry.hours);
}

function salaryExceptionRangeHours(entry) {
  const period = selectedSalaryPeriodBounds();
  const startIso = entry.startDate || entry.date || period.endIso;
  const endIso = entry.endDate || entry.date || startIso;
  const start = dateFromIso(startIso);
  const end = dateFromIso(endIso);
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return 0;

  let businessDays = 0;
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    const iso = toIsoDate(cursor);
    if (iso < period.startIso || iso > period.endIso) continue;
    if (isBusinessDay(cursor)) businessDays += 1;
  }
  return businessDays * 8;
}

function salaryExceptionShouldAutofillHours(type) {
  return ["absence_unjustified", "absence_justified"].includes(type);
}

function salaryScaleForCategory(category) {
  const normalized = normalizeCategory(category);
  const scale = salaryEntryScale.categories[normalized] || { type: "hourly", remunerative: 0, nonRemunerative: 0 };
  const periodScale = scale.periods?.[state.payrollEntry.selectedPeriod];
  if (!periodScale) return scale;
  return {
    ...scale,
    remunerative: periodScale.remunerative,
    nonRemunerative: periodScale.nonRemunerative
  };
}

function renderSalaryEntry() {
  if (!els["salary-entry-body"]) return;
  renderSalaryPeriodOptions();
  const period = selectedSalaryPeriodBounds();
  const base = buildSalaryBaseHours(period);
  els["salary-period-summary"].textContent = `${formatDate(period.startIso)} al ${formatDate(period.endIso)}: ${base.workedHours} hs trabajadas base y ${base.holidayHours} hs feriado.`;
  els["salary-table-caption"].textContent = salaryEntryScale.sourceName
    ? `Escala cargada: ${salaryEntryScale.sourceName}. Los importes se recalculan con las novedades.`
    : "Carga una escala salarial para calcular importes. Las horas ya se calculan automaticamente.";

  const rows = buildSalaryRows();
  els["salary-entry-body"].innerHTML = rows.length ? rows.map(salaryEntryRow).join("") : emptyRow(11, "No hay empleados activos en el backend.");
  renderSalaryLaborCosts(rows);
  renderSalaryExceptions();
  renderSalaryExpenseEntry();
  setSalaryEntryStatus("", "");
}

function salaryEntryRow(row) {
  return `
    <tr>
      <td>${escapeHtml(row.employee.name)}</td>
      <td>${escapeHtml(row.employee.category)}</td>
      <td class="num">${formatMoney(row.valorRemunerativo)}</td>
      <td class="num">${formatMoney(row.valorNoRemunerativo)}</td>
      <td class="num">${formatNumber(row.workedHours)}</td>
      <td class="num">${formatNumber(row.justifiedHours)}</td>
      <td class="num">${formatNumber(row.holidayHours)}</td>
      <td class="num">${formatNumber(row.extraHours)}</td>
      <td class="num">${formatMoney(row.awards)}</td>
      <td class="num">${formatMoney(row.sueldoBruto)}</td>
      <td class="num">${formatMoney(row.sueldoNeto)}</td>
    </tr>
  `;
}

function renderSalaryLaborCosts(salaryRows) {
  if (!els["salary-labor-costs"]) return;
  const settings = salaryLaborCostSettingsForCurrentPeriod();
  const summary = salaryLaborCostSummary(salaryRows, settings);

  els["salary-labor-costs"].innerHTML = `
    <div class="salary-labor-cost-row">
      <div>
        <strong>Cargas sociales</strong>
        <span>${summary.dependencyCount} empleado(s) en relacion de dependencia · base ${formatMoney(summary.dependencyGross)}</span>
      </div>
      <label>
        Aportes empleado
        <input id="salary-employee-contribution-rate" type="number" min="0" step="0.01" value="${escapeHtml(settings.employeeContributionRate)}">
      </label>
      <label>
        Empleador + ART
        <input id="salary-employer-contribution-rate" type="number" min="0" step="0.01" value="${escapeHtml(settings.employerContributionRate)}">
      </label>
      <label>
        Costo total editable
        <input id="salary-social-charge-total-input" type="number" min="0" step="0.01" value="${escapeHtml(!settings.socialChargeTotal ? summary.socialChargesTotal.toFixed(2) : settings.socialChargeTotal)}">
      </label>
    </div>
    <div class="salary-labor-cost-row">
      <div>
        <strong>Cooperativa</strong>
        <span>${summary.cooperativeCount} empleado(s) · costo por persona editable</span>
      </div>
      <label>
        Costo por empleado
        <input id="salary-cooperative-cost-per-employee" type="number" min="0" step="0.01" value="${escapeHtml(settings.cooperativeEmployeeCost)}">
      </label>
      <label>
        Costo total editable
        <input id="salary-cooperative-total-input" type="number" min="0" step="0.01" value="${escapeHtml(!settings.cooperativeTotal ? summary.cooperativeTotal.toFixed(2) : settings.cooperativeTotal)}">
      </label>
    </div>
  `;
}

function salaryLaborCostSettingsForCurrentPeriod() {
  const periodKey = state.payrollEntry.selectedPeriod || currentPayrollPeriodKey();
  const laborCosts = state.payrollEntry.laborCosts || createDefaultPayrollState().laborCosts;
  const cooperativeCost = periodMapValueWithPreviousFallback(
    laborCosts.cooperativeCostByPeriod,
    periodKey,
    DEFAULT_COOPERATIVE_EMPLOYEE_COST
  );
  const employeeContributionRate = periodMapValueWithPreviousFallback(
    laborCosts.employeeContributionRateByPeriod,
    periodKey,
    DEFAULT_EMPLOYEE_CONTRIBUTION_RATE
  );
  const employerContributionRate = periodMapValueWithPreviousFallback(
    laborCosts.employerContributionRateByPeriod,
    periodKey,
    DEFAULT_EMPLOYER_CONTRIBUTION_RATE
  );
  return {
    cooperativeEmployeeCost: roundToDecimals(cooperativeCost, 2),
    socialChargeTotal: roundToDecimals(periodMapValueWithPreviousFallback(
      laborCosts.socialChargeTotalByPeriod,
      periodKey,
      ""
    ), 2),
    cooperativeTotal: roundToDecimals(periodMapValueWithPreviousFallback(
      laborCosts.cooperativeTotalByPeriod,
      periodKey,
      ""
    ), 2),
    employeeContributionRate: roundToDecimals(employeeContributionRate, 2),
    employerContributionRate: roundToDecimals(employerContributionRate, 2)
  };
}

function periodMapValueWithPreviousFallback(map, periodKey, fallbackValue) {
  if (map && map[periodKey] !== undefined && map[periodKey] !== "") return parseMoney(map[periodKey]);
  const [year, month] = periodKey.split("-").map(Number);
  if (!year || !month) return fallbackValue;
  const previousDate = new Date(year, month - 2, 1);
  const previousKey = `${previousDate.getFullYear()}-${String(previousDate.getMonth() + 1).padStart(2, "0")}`;
  if (map && map[previousKey] !== undefined && map[previousKey] !== "") return parseMoney(map[previousKey]);
  return fallbackValue;
}

function salaryLaborCostSummary(salaryRows, settings) {
  const dependencyRows = salaryRows.filter((row) => normalizeSearchText(row.employee.contractType) === "relacion de dependencia");
  const cooperativeRows = salaryRows.filter((row) => normalizeSearchText(row.employee.contractType) === "cooperativa");
  const dependencyGross = dependencyRows.reduce((total, row) => total + row.sueldoBruto, 0);
  const employeeContributionsTotal = dependencyGross * (settings.employeeContributionRate / 100);
  const employerContributionsTotal = dependencyGross * (settings.employerContributionRate / 100);
  const socialChargesTotal = settings.socialChargeTotal !== "" && settings.socialChargeTotal > 0
    ? settings.socialChargeTotal
    : employeeContributionsTotal + employerContributionsTotal;
  const cooperativeTotal = settings.cooperativeTotal !== "" && settings.cooperativeTotal > 0
    ? settings.cooperativeTotal
    : cooperativeRows.length * settings.cooperativeEmployeeCost;
  return {
    dependencyCount: dependencyRows.length,
    dependencyGross,
    employeeContributionsTotal,
    employerContributionsTotal,
    socialChargesTotal,
    cooperativeCount: cooperativeRows.length,
    cooperativeTotal
  };
}

function updateSalaryLaborCostSetting(event) {
  const input = event.target;
  if (!input || !["salary-cooperative-cost-per-employee", "salary-social-charge-total-input", "salary-cooperative-total-input", "salary-employee-contribution-rate", "salary-employer-contribution-rate"].includes(input.id)) return;

  state.payrollEntry.laborCosts = state.payrollEntry.laborCosts || createDefaultPayrollState().laborCosts;
  const periodKey = state.payrollEntry.selectedPeriod || currentPayrollPeriodKey();
  const value = parseMoney(input.value);

  if (input.id === "salary-cooperative-cost-per-employee") {
    state.payrollEntry.laborCosts.cooperativeCostByPeriod[periodKey] = value;
  } else if (input.id === "salary-social-charge-total-input") {
    state.payrollEntry.laborCosts.socialChargeTotalByPeriod[periodKey] = value;
  } else if (input.id === "salary-cooperative-total-input") {
    state.payrollEntry.laborCosts.cooperativeTotalByPeriod[periodKey] = value;
  } else if (input.id === "salary-employee-contribution-rate") {
    state.payrollEntry.laborCosts.employeeContributionRateByPeriod[periodKey] = value;
  } else {
    state.payrollEntry.laborCosts.employerContributionRateByPeriod[periodKey] = value;
  }

  saveState();
  updateSalaryLaborCostTotals();
}

function updateSalaryLaborCostTotals() {
  const summary = salaryLaborCostSummary(buildSalaryRows(), salaryLaborCostSettingsForCurrentPeriod());
  const socialInput = els["salary-labor-costs"]?.querySelector("#salary-social-charge-total-input");
  const cooperativeInput = els["salary-labor-costs"]?.querySelector("#salary-cooperative-total-input");
  if (socialInput && document.activeElement !== socialInput) socialInput.value = summary.socialChargesTotal.toFixed(2);
  if (cooperativeInput && document.activeElement !== cooperativeInput) cooperativeInput.value = summary.cooperativeTotal.toFixed(2);
}

function addSalaryExceptionRow() {
  const period = selectedSalaryPeriodBounds();
  const firstEmployee = salaryEntryEmployees[0];
  const exception = {
    id: createClientId("salary-exception"),
    period: state.payrollEntry.selectedPeriod,
    startDate: period.endIso,
    endDate: period.endIso,
    employeeId: firstEmployee?.id || "",
    type: "absence_unjustified",
    hours: 0,
    note: ""
  };
  exception.hours = salaryExceptionRangeHours(exception);
  state.payrollEntry.exceptions.push(exception);
  saveState();
  renderSalaryEntry();
}

function createClientId(prefix) {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function renderSalaryExceptions() {
  const rows = salaryExceptionsForPeriod(state.payrollEntry.selectedPeriod);
  els["salary-exceptions-body"].innerHTML = rows.length
    ? rows.map(salaryExceptionRow).join("")
    : emptyRow(7, "Todavia no hay novedades cargadas.");
}

function salaryExceptionRow(entry) {
  const employeeOptions = salaryEntryEmployees.map((employee) => (
    `<option value="${escapeHtml(employee.id)}"${entry.employeeId === employee.id ? " selected" : ""}>${escapeHtml(employee.name)}</option>`
  )).join("");
  const typeOptions = [
    ["absence_unjustified", "Falta injustificada"],
    ["absence_justified", "Falta justificada"],
    ["late_arrival", "Llega tarde"],
    ["early_leave", "Se va temprano"],
    ["extra_hours", "Horas extra"],
    ["award", "Premio"]
  ].map(([value, label]) => `<option value="${value}"${entry.type === value ? " selected" : ""}>${label}</option>`).join("");
  const startDate = entry.startDate || entry.date || "";
  const endDate = entry.endDate || entry.date || startDate;
  return `
    <tr>
      <td><input type="date" value="${escapeHtml(startDate)}" data-salary-exception="${escapeHtml(entry.id)}" data-field="startDate"></td>
      <td><input type="date" value="${escapeHtml(endDate)}" data-salary-exception="${escapeHtml(entry.id)}" data-field="endDate"></td>
      <td><select data-salary-exception="${escapeHtml(entry.id)}" data-field="employeeId">${employeeOptions}</select></td>
      <td><select data-salary-exception="${escapeHtml(entry.id)}" data-field="type">${typeOptions}</select></td>
      <td class="num"><input type="number" step="0.5" value="${escapeHtml(entry.hours || "")}" data-salary-exception="${escapeHtml(entry.id)}" data-field="hours"></td>
      <td><input type="text" value="${escapeHtml(entry.note || "")}" placeholder="Detalle opcional" data-salary-exception="${escapeHtml(entry.id)}" data-field="note"></td>
      <td class="num"><button type="button" data-salary-exception-delete="${escapeHtml(entry.id)}">Eliminar</button></td>
    </tr>
  `;
}

function updateSalaryException(input) {
  const entry = state.payrollEntry.exceptions.find((row) => row.id === input.dataset.salaryException);
  if (!entry) return;
  entry[input.dataset.field] = input.value;
  normalizeSalaryExceptionRange(entry, input.dataset.field);
  saveState();
  renderSalaryEntry();
}

function normalizeSalaryExceptionRange(entry, changedField) {
  if (!entry.startDate && entry.date) entry.startDate = entry.date;
  if (!entry.endDate) entry.endDate = entry.startDate || entry.date || "";
  if (changedField === "startDate" && (!entry.endDate || entry.endDate < entry.startDate)) entry.endDate = entry.startDate;
  if (salaryExceptionShouldAutofillHours(entry.type) && ["startDate", "endDate", "type"].includes(changedField)) {
    entry.hours = salaryExceptionRangeHours(entry);
  }
}

function deleteSalaryException(id) {
  state.payrollEntry.exceptions = state.payrollEntry.exceptions.filter((entry) => entry.id !== id);
  saveState();
  renderSalaryEntry();
}

async function saveSalaryEntryToBackend() {
  if (!salaryEntryEmployees.length) {
    setSalaryEntryStatus("No hay empleados activos para guardar.", "warn");
    return;
  }

  try {
    setSalaryEntryStatus("Guardando sueldos en backend.", "pending");
    const [existingSalaries, creditorTagsByEmployeeId] = await Promise.all([
      backendTableRowsForEntry("sueldos"),
      loadPayrollCreditorTagsByEmployeeId()
    ]);
    const salaryRows = buildSalaryRows();
    const periodKey = state.payrollEntry.selectedPeriod;
    const salaryDate = `${periodKey}-01`;
    const existingSalaryByPeriodEmployee = new Map();

    existingSalaries.forEach((salary) => {
      const key = salaryPeriodEmployeeKey(salary);
      if (key && !existingSalaryByPeriodEmployee.has(key)) existingSalaryByPeriodEmployee.set(key, salary);
    });

    let nextSalaryId = existingSalaries.reduce((maxId, salary) => {
      const id = Number(salary.id_sueldo);
      return Number.isFinite(id) ? Math.max(maxId, id) : maxId;
    }, 0) + 1;

    const rowsToSave = salaryRows.map((salary) => {
      const key = `${periodKey}|${salary.employee.id}`;
      const existingSalary = existingSalaryByPeriodEmployee.get(key) || {};
      const idSueldo = String(existingSalary.id_sueldo || nextSalaryId++);
      return {
        id_sueldo: idSueldo,
        fecha: salaryDate,
        id_empleado: salary.employee.id,
        id_acreedor_etiqueta: existingSalary.id_acreedor_etiqueta || creditorTagsByEmployeeId.get(salary.employee.id) || "",
        id_egreso: existingSalary.id_egreso || "",
        valor_remunerativo: roundToDecimals(salary.valorRemunerativo, 2),
        valor_no_remunerativo: roundToDecimals(salary.valorNoRemunerativo, 2),
        hs_trabajadas: roundToDecimals(salary.workedHours, 2),
        hs_con_justificacion_medica: roundToDecimals(salary.justifiedHours, 2),
        hs_feriado: roundToDecimals(salary.holidayHours, 2),
        hs_extra: roundToDecimals(salary.extraHours, 2),
        premios: roundToDecimals(salary.awards, 2),
        sueldo_bruto: roundToDecimals(salary.sueldoBruto, 2),
        sueldo_neto: roundToDecimals(salary.sueldoNeto, 2)
      };
    });

    await saveBackendEntryRows("sueldos", rowsToSave);
    await loadSalaryEmployees();
    await loadSalaryExpenseEntryData(true);
    renderSalaryEntry();
    setSalaryEntryStatus(`${rowsToSave.length} sueldo(s) guardados en la tabla sueldos.`, "success");
  } catch (error) {
    setSalaryEntryStatus(`No se pudieron guardar los sueldos: ${error.message}`, "error");
  }
}

function salaryPeriodEmployeeKey(salary) {
  const date = isoDateFromMixedValue(salary.fecha);
  const employeeId = String(salary.id_empleado || "").trim();
  if (!date || !employeeId) return "";
  return `${date.slice(0, 7)}|${employeeId}`;
}

async function loadPayrollCreditorTagsByEmployeeId() {
  const [creditors, creditorTags] = await Promise.all([
    backendTableRowsForEntry("acreedores"),
    backendTableRowsForEntry("acreedores_etiquetas")
  ]);
  const creditorIdByEmployeeId = new Map();
  creditors.forEach((creditor) => {
    if (!normalizeSearchText(creditor.origen_tipo_acreedor).includes("empleado")) return;
    const employeeId = String(creditor.origen_id_acreedor || "").trim();
    const creditorId = String(creditor.id_acreedor || "").trim();
    if (employeeId && creditorId && !creditorIdByEmployeeId.has(employeeId)) {
      creditorIdByEmployeeId.set(employeeId, creditorId);
    }
  });

  const firstTagByCreditorId = new Map();
  creditorTags.forEach((relation) => {
    const creditorId = String(relation.id_acreedor || "").trim();
    const creditorTagId = String(relation.id_acreedor_etiqueta || "").trim();
    if (creditorId && creditorTagId && !firstTagByCreditorId.has(creditorId)) {
      firstTagByCreditorId.set(creditorId, creditorTagId);
    }
  });

  const tagByEmployeeId = new Map();
  creditorIdByEmployeeId.forEach((creditorId, employeeId) => {
    const creditorTagId = firstTagByCreditorId.get(creditorId);
    if (creditorTagId) tagByEmployeeId.set(employeeId, creditorTagId);
  });
  return tagByEmployeeId;
}

function isoDateFromMixedValue(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const local = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (local) {
    const day = local[1].padStart(2, "0");
    const month = local[2].padStart(2, "0");
    const year = local[3].length === 2 ? `20${local[3]}` : local[3];
    return `${year}-${month}-${day}`;
  }
  return "";
}

function updateSalaryScaleFileName() {
  const file = els["salary-scale-file"]?.files?.[0];
  els["salary-scale-file-name"].textContent = file ? `${file.name} (${formatFileSize(file.size)})` : "Sin escala cargada";
}

async function readSalaryScaleFile() {
  const file = els["salary-scale-file"]?.files?.[0];
  if (!file) {
    setSalaryEntryStatus("Adjunta primero el PDF de escala salarial.", "warn");
    return;
  }
  try {
    setSalaryEntryStatus("Leyendo escala salarial.", "pending");
    const fileDataUrl = await readFileAsDataUrl(file);
    const response = await fetch(`${API_BASE_URL}/api/payroll-scale/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: file.name, fileDataUrl })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo leer la escala.");
    salaryEntryScale = {
      categories: payload.scale?.categories || {},
      sourceName: file.name
    };
    state.payrollEntry.scale = salaryEntryScale;
    saveState();
    renderSalaryEntry();
    setSalaryEntryStatus(`Escala leida: ${Object.keys(salaryEntryScale.categories).length} categorias encontradas.`, "success");
  } catch (error) {
    setSalaryEntryStatus(`No se pudo leer la escala: ${error.message}`, "error");
  }
}

function setSalaryEntryStatus(message, status) {
  if (!els["salary-entry-status"]) return;
  els["salary-entry-status"].textContent = message;
  els["salary-entry-status"].dataset.status = status || "";
}

async function loadSalaryExpenseEntryData(force = false) {
  if (salaryExpenseEntryData.loaded && !force) return;
  const [salaries, employees, expenses, creditorTags, labels] = await Promise.all([
    backendTableRowsForEntry("sueldos").catch(() => []),
    backendTableRowsForEntry("empleados").catch(() => []),
    backendTableRowsForEntry("egresos").catch(() => []),
    backendTableRowsForEntry("acreedores_etiquetas").catch(() => []),
    backendTableRowsForEntry("etiquetas").catch(() => [])
  ]);
  salaryExpenseEntryData = {
    loaded: true,
    salaries,
    employees,
    expenses,
    creditorTags,
    labels
  };
}

function renderSalaryExpenseEntry() {
  const body = els["salary-expense-salary-body"];
  if (!body) return;

  const rows = salaryExpenseSelectableRows();
  if (!rows.length) {
    body.innerHTML = `<tr><td class="empty" colspan="5">No hay liquidaciones del periodo pendientes de asociar a un egreso.</td></tr>`;
  } else {
    body.innerHTML = rows.map((row) => `
      <tr>
        <td><input type="checkbox" data-salary-expense-salary="${escapeHtml(row.salaryId)}"></td>
        <td>${escapeHtml(displayNameLabel(row.employeeName))}</td>
        <td>${escapeHtml(displayNameLabel(row.employeeCategory || "-"))}</td>
        <td>${escapeHtml(formatDate(row.salaryDate))}</td>
        <td class="num">${formatMoney(row.netSalary)}</td>
      </tr>
    `).join("");
  }

  if (els["salary-expense-invoice-date"] && !els["salary-expense-invoice-date"].value) {
    els["salary-expense-invoice-date"].value = toIsoDate(new Date());
  }
  autofillSalaryExpensePaymentDate();
  updateSalaryExpenseFileName();
  updateSalaryExpenseSelectionSummary();
}

function salaryExpenseSelectableRows() {
  const periodKey = state.payrollEntry.selectedPeriod || currentPayrollPeriodKey();
  const employeesById = rowsByKey(salaryExpenseEntryData.employees, "id_empleado");
  const payrollRows = salaryExpenseEntryData.salaries
    .map((salary) => {
      const salaryId = backendId(salary.id_sueldo);
      const salaryDate = isoDateFromMixedValue(salary.fecha);
      const employee = employeesById.get(comparableLookupId(salary.id_empleado)) || {};
      return {
        rowType: "salary",
        salary,
        salaryId,
        salaryDate,
        employeeName: employee.nombre_empleado || employee.nombre || salary.id_empleado || "Sin empleado",
        employeeCategory: employee.categoria_empleado || employee.categoria || "",
        netSalary: parseMoney(salary.sueldo_neto)
      };
    })
    .filter((row) => {
      if (!row.salaryId || !row.salaryDate?.startsWith(periodKey) || row.netSalary <= 0) return false;
      if (backendId(row.salary.id_egreso)) return false;
      if (isSalaryLaborConceptName(row.employeeName)) return false;
      return true;
    })
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName) || a.salaryId.localeCompare(b.salaryId, undefined, { numeric: true }));
  return [...payrollRows, ...salaryExpenseLaborRows(periodKey)];
}

function salaryExpenseLaborRows(periodKey) {
  const rows = buildSalaryRows();
  const summary = salaryLaborCostSummary(rows, salaryLaborCostSettingsForCurrentPeriod());
  const salaryDate = `${periodKey}-01`;
  const laborExpenses = state.payrollEntry.laborExpenses || createDefaultPayrollState().laborExpenses;
  const existingExpenseKeys = salaryExpenseExistingKeys(periodKey);
  const laborRows = [];

  if (
    summary.socialChargesTotal > 0
    && !laborExpenses.socialChargeExpenseByPeriod?.[periodKey]
    && !existingExpenseKeys.has(salaryExpensePeriodKey("labor-social", periodKey))
    && !existingExpenseKeys.has(salaryExpenseMatchKey("labor-social", salaryDate, summary.socialChargesTotal))
  ) {
    laborRows.push({
      rowType: "labor-social",
      salary: {},
      salaryId: `labor-social-${periodKey}`,
      salaryDate,
      employeeName: "Cargas Sociales",
      employeeCategory: "Cargas sociales",
      netSalary: summary.socialChargesTotal
    });
  }

  if (
    summary.cooperativeTotal > 0
    && !laborExpenses.cooperativeExpenseByPeriod?.[periodKey]
    && !existingExpenseKeys.has(salaryExpensePeriodKey("labor-cooperative", periodKey))
    && !existingExpenseKeys.has(salaryExpenseMatchKey("labor-cooperative", salaryDate, summary.cooperativeTotal))
  ) {
    laborRows.push({
      rowType: "labor-cooperative",
      salary: {},
      salaryId: `labor-cooperative-${periodKey}`,
      salaryDate,
      employeeName: "Cooperativa_Nuevos_Lazos",
      employeeCategory: "Cooperativa",
      netSalary: summary.cooperativeTotal
    });
  }

  return laborRows;
}

function salaryExpenseExistingKeys(periodKey) {
  const groupedSalaryExpenseTypes = new Set(["sueldo"]);
  const individualSalaryExpenseTypes = new Set(["recibo sueldo", "recibo de sueldo", "factura c"]);
  const socialExpenseTypes = new Set(["cargas sociales"]);
  const cooperativeExpenseTypes = new Set(["cooperativa", "cargas cooperativa"]);

  return new Set((salaryExpenseEntryData.expenses || []).flatMap((expense) => {
    const invoiceDate = isoDateFromMixedValue(expense.fecha_factura);
    if (!invoiceDate?.startsWith(periodKey)) return [];

    const normalizedType = normalizeSearchText(expense.tipo_factura);
    const total = parseMoney(expense.total || expense.subtotal);
    if (!total) return [];

    if (socialExpenseTypes.has(normalizedType)) {
      return [
        salaryExpensePeriodKey("labor-social", periodKey),
        salaryExpenseMatchKey("labor-social", invoiceDate, total)
      ];
    }
    if (cooperativeExpenseTypes.has(normalizedType)) {
      return [
        salaryExpensePeriodKey("labor-cooperative", periodKey),
        salaryExpenseMatchKey("labor-cooperative", invoiceDate, total)
      ];
    }
    if (groupedSalaryExpenseTypes.has(normalizedType)) {
      // Los egresos historicos de sueldos pueden estar agrupados por mes,
      // por eso bloquean todo el periodo aunque no coincidan 1 a 1 por monto.
      return [salaryExpensePeriodKey("salary", periodKey)];
    }
    if (individualSalaryExpenseTypes.has(normalizedType)) {
      return [salaryExpenseMatchKey("salary", invoiceDate, total)];
    }
    return [];
  }));
}

function salaryExpensePeriodKey(rowType, periodKey) {
  return `${rowType}|${periodKey}`;
}

function salaryExpenseMatchKey(rowType, dateValue, amount) {
  const periodKey = String(dateValue || "").slice(0, 7);
  return `${rowType}|${periodKey}|${Math.round(parseMoney(amount))}`;
}

function isSalaryLaborConceptName(name) {
  const normalizedName = normalizeSearchText(name);
  return normalizedName === "cargas sociales" || normalizedName === "cooperativa nuevos lazos";
}

function selectedSalaryExpenseRows() {
  const selectableById = new Map(salaryExpenseSelectableRows().map((row) => [row.salaryId, row]));
  return [...document.querySelectorAll("[data-salary-expense-salary]:checked")]
    .map((input) => selectableById.get(input.dataset.salaryExpenseSalary))
    .filter(Boolean);
}

function updateSalaryExpenseSelectionSummary() {
  const selectedRows = selectedSalaryExpenseRows();
  const total = selectedRows.reduce((sum, row) => sum + row.netSalary, 0);
  if (els["salary-expense-selection"]) {
    els["salary-expense-selection"].textContent = `${selectedRows.length} concepto${selectedRows.length === 1 ? "" : "s"} seleccionado${selectedRows.length === 1 ? "" : "s"}`;
  }
  if (els["salary-expense-subtotal"] && !els["salary-expense-subtotal"].dataset.touched) {
    els["salary-expense-subtotal"].value = total ? roundToDecimals(total, 2) : "";
  }
  if (els["salary-expense-iva"] && !els["salary-expense-iva"].dataset.touched) {
    els["salary-expense-iva"].value = "";
  }
  if (els["salary-expense-total"] && !els["salary-expense-total"].dataset.touched) {
    els["salary-expense-total"].value = total ? roundToDecimals(total, 2) : "";
  }
}

function setupSalaryExpenseFileDropZone() {
  setupFileDropZone({
    dropZone: els["salary-expense-file-drop-zone"],
    input: els["salary-expense-file"],
    acceptFile: isReceptionReadableAttachment,
    respectDisabled: true,
    onAccepted: (file) => {
      updateSalaryExpenseFileName();
      setCommercialStatus("salary-expense-status", `Factura/remito listo: ${file.name}. Para completar el egreso, presiona Leer factura.`, "success");
    },
    onRejected: () => setCommercialStatus("salary-expense-status", "Arrastra una imagen o PDF valido de factura/remito.", "error")
  });
}

function updateSalaryExpenseFileName() {
  const file = els["salary-expense-file"]?.files?.[0];
  els["salary-expense-file-chip"]?.classList.toggle("is-empty", !file);
  if (els["salary-expense-file-name"]) els["salary-expense-file-name"].textContent = file ? file.name : "Sin archivo";
  if (els["salary-expense-file-size"]) els["salary-expense-file-size"].textContent = file ? formatFileSize(file.size) : "";
}

function clearSalaryExpenseFile() {
  if (els["salary-expense-file"]) els["salary-expense-file"].value = "";
  updateSalaryExpenseFileName();
  setCommercialStatus("salary-expense-status", "", "");
}

function updateSalaryExpenseWithoutFile() {
  const withoutFile = Boolean(els["salary-expense-without-file"]?.checked);
  if (els["salary-expense-file"]) {
    els["salary-expense-file"].disabled = withoutFile;
    if (withoutFile) els["salary-expense-file"].value = "";
  }
  updateSalaryExpenseFileName();
  if (withoutFile) {
    autofillSalaryExpenseWithoutFile();
    setCommercialStatus("salary-expense-status", "Sin remito ni factura: se completo como Remito X. Revisa antes de guardar.", "pending");
  } else {
    setCommercialStatus("salary-expense-status", "", "");
  }
}

async function autofillSalaryExpenseWithoutFile({ keepInvoiceNumber = false } = {}) {
  const today = toIsoDate(new Date());
  if (els["salary-expense-invoice-type"]) els["salary-expense-invoice-type"].value = "Remito_X";
  if (els["salary-expense-invoice-date"] && !els["salary-expense-invoice-date"].value) els["salary-expense-invoice-date"].value = today;
  if (!keepInvoiceNumber && els["salary-expense-invoice-number"]) {
    const nextExpenseId = await nextBackendPrimaryIdOrOne("egresos", "id_egreso");
    els["salary-expense-invoice-number"].value = String(nextExpenseId);
  }
  ["salary-expense-iva", "salary-expense-vat-retention", "salary-expense-iibb-retention", "salary-expense-internal-taxes"].forEach((id) => {
    if (els[id] && !els[id].dataset.touched) els[id].value = "";
  });
  updateSalaryExpenseSelectionSummary();
  autofillSalaryExpensePaymentDate();
  updateSalaryExpenseTotalFromInputs();
}

function autofillSalaryExpensePaymentDate() {
  const input = els["salary-expense-payment-date"];
  const invoiceDate = parseDate(els["salary-expense-invoice-date"]?.value);
  if (!input || !invoiceDate) return;
  if (input.value && !input.dataset.autoSalaryDueDate) return;
  input.value = salaryPaymentDueDate(invoiceDate);
  input.dataset.autoSalaryDueDate = "true";
}

function salaryPaymentDueDate(invoiceDateIso) {
  const invoiceDate = dateFromIso(invoiceDateIso);
  const dueDate = new Date(invoiceDate.getFullYear(), invoiceDate.getMonth() + 1, 5);
  return toIsoDate(dueDate);
}

function updateSalaryExpenseTotalFromInputs() {
  const total = [
    "salary-expense-subtotal",
    "salary-expense-iva",
    "salary-expense-vat-retention",
    "salary-expense-iibb-retention",
    "salary-expense-internal-taxes"
  ].reduce((sum, id) => sum + entryNumberValue(id), 0);
  if (els["salary-expense-total"] && !els["salary-expense-total"].dataset.touched) {
    els["salary-expense-total"].value = total ? roundToDecimals(total, 2) : "";
  }
}

async function autofillSalaryExpenseFromAttachment() {
  const file = els["salary-expense-file"]?.files?.[0];
  if (els["salary-expense-without-file"]?.checked) {
    setCommercialStatus("salary-expense-status", "Desmarca Sin remito ni factura para leer un archivo.", "error");
    return;
  }
  if (!file) {
    setCommercialStatus("salary-expense-status", "Adjunta una factura o remito antes de leer.", "error");
    return;
  }
  if (!isReceptionReadableAttachment(file)) {
    setCommercialStatus("salary-expense-status", "Adjunta una imagen o PDF valido de factura/remito.", "error");
    return;
  }

  const requestId = ++salaryExpenseInvoiceReadRequestId;
  setCommercialButtonLoading(els["salary-expense-invoice-read"], true, "Leyendo...");
  setCommercialStatus("salary-expense-status", "Leyendo factura/remito para precargar egreso de sueldos...", "pending");

  try {
    const response = await fetch(`${API_BASE_URL}/api/reception-invoice/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileDataUrl: await receptionAttachmentToDataUrl(file),
        fileName: file.name,
        mimeType: file.type
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (requestId !== salaryExpenseInvoiceReadRequestId) return;
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    applySalaryExpenseInvoiceRead(payload.invoice || {});
    setCommercialStatus("salary-expense-status", "Factura/remito leido. Revisa y corrige los datos antes de guardar.", "success");
  } catch (error) {
    setCommercialStatus("salary-expense-status", `No se pudo leer automaticamente: ${error.message}. Completa o corrige los datos manualmente.`, "error");
  } finally {
    setCommercialButtonLoading(els["salary-expense-invoice-read"], false);
  }
}

function applySalaryExpenseInvoiceRead(invoice) {
  const type = normalizeReceptionInvoiceType(invoice.tipo_factura || invoice.invoiceType);
  if (type && els["salary-expense-invoice-type"]) {
    const allowedSalaryInvoiceTypes = new Set(["Factura_C", "Recibo_Sueldo", "Remito_X"]);
    els["salary-expense-invoice-type"].value = allowedSalaryInvoiceTypes.has(type) ? type : "Factura_C";
  }
  if (invoice.nro_factura || invoice.invoiceNumber) els["salary-expense-invoice-number"].value = String(invoice.nro_factura || invoice.invoiceNumber).trim();
  if (invoice.fecha_factura || invoice.invoiceDate) {
    els["salary-expense-invoice-date"].value = parseDate(invoice.fecha_factura || invoice.invoiceDate) || els["salary-expense-invoice-date"].value;
    autofillSalaryExpensePaymentDate();
  }
  [
    ["salary-expense-subtotal", invoice.subtotal],
    ["salary-expense-iva", invoice.iva],
    ["salary-expense-vat-retention", invoice.per_ret_iva],
    ["salary-expense-iibb-retention", invoice.per_ret_iibb],
    ["salary-expense-internal-taxes", invoice.imp_internos],
    ["salary-expense-total", invoice.total]
  ].forEach(([id, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (els[id]) els[id].value = roundToDecimals(parseMoney(value), 2);
    if (id === "salary-expense-total") els[id].dataset.touched = "true";
  });
  updateSalaryExpenseTotalFromInputs();
}

function salaryExpenseLabelId(selectedRows) {
  const firstCreditorTagId = selectedRows.map((row) => backendId(row.salary.id_acreedor_etiqueta)).find(Boolean);
  const creditorTag = salaryExpenseEntryData.creditorTags.find((row) => comparableLookupId(row.id_acreedor_etiqueta) === comparableLookupId(firstCreditorTagId));
  if (creditorTag?.id_etiqueta) return backendId(creditorTag.id_etiqueta);
  const salaryLabel = salaryExpenseEntryData.labels.find((label) => normalizeCategory(label.etiqueta).includes("sueldo"));
  return backendId(salaryLabel?.id_etiqueta);
}

async function submitSalaryExpenseEntry(event) {
  event.preventDefault();
  const selectedRows = selectedSalaryExpenseRows();
  if (!selectedRows.length) {
    setCommercialStatus("salary-expense-status", "Selecciona al menos un concepto para asociar al egreso.", "error");
    return;
  }

  const invoiceType = backendId(els["salary-expense-invoice-type"]?.value);
  const invoiceNumber = backendId(els["salary-expense-invoice-number"]?.value);
  const invoiceDate = parseDate(els["salary-expense-invoice-date"]?.value);
  const total = entryNumberValue("salary-expense-total");
  if (!invoiceType || !invoiceNumber || !invoiceDate || total <= 0) {
    setCommercialStatus("salary-expense-status", "Completa tipo, numero, fecha y total del egreso.", "error");
    return;
  }

  const button = event.submitter || els["salary-expense-submit"];
  setCommercialButtonLoading(button, true, "Guardando...");
  setCommercialStatus("salary-expense-status", "Guardando egreso de sueldos...", "pending");

  try {
    const [expenseId, existingExpenses, existingSalaries] = await Promise.all([
      nextBackendPrimaryId("egresos", "id_egreso"),
      backendTableRowsForEntry("egresos").catch(() => []),
      backendTableRowsForEntry("sueldos").catch(() => [])
    ]);
    const selectedSalaryIds = new Set(selectedRows.filter((row) => row.rowType === "salary").map((row) => comparableLookupId(row.salaryId)));
    const paymentDate = parseDate(els["salary-expense-payment-date"]?.value) || salaryPaymentDueDate(invoiceDate);
    const expenseRow = {
      id_egreso: String(expenseId),
      fecha_factura: invoiceDate,
      fecha_prevista_pago: paymentDate,
      id_etiqueta: salaryExpenseLabelId(selectedRows),
      tipo_factura: invoiceType,
      nro_factura: invoiceNumber,
      iva: entryNumberValue("salary-expense-iva"),
      per_ret_iva: entryNumberValue("salary-expense-vat-retention"),
      per_ret_iibb: entryNumberValue("salary-expense-iibb-retention"),
      imp_internos: entryNumberValue("salary-expense-internal-taxes"),
      subtotal: entryNumberValue("salary-expense-subtotal"),
      total
    };
    const updatedSalaries = existingSalaries.map((salary) => (
      selectedSalaryIds.has(comparableLookupId(salary.id_sueldo))
        ? { ...salary, id_egreso: String(expenseId) }
        : salary
    ));
    registerSelectedSalaryLaborExpenses(selectedRows, state.payrollEntry.selectedPeriod || currentPayrollPeriodKey(), expenseId);

    await saveBackendEntryRows("egresos", [...existingExpenses, expenseRow]);
    await saveBackendEntryRows("sueldos", updatedSalaries);
    saveState();

    salaryExpenseEntryData.loaded = false;
    commercialEntryData.loaded = false;
    await loadSalaryExpenseEntryData(true);
    resetSalaryExpenseForm();
    renderSalaryEntry();
    setCommercialStatus("salary-expense-status", `Egreso de sueldos #${expenseId} guardado y asociado a ${selectedRows.length} concepto(s).`, "success");
  } catch (error) {
    setCommercialStatus("salary-expense-status", `No se pudo guardar el egreso de sueldos: ${error.message}`, "error");
  } finally {
    setCommercialButtonLoading(button, false);
  }
}

function registerSelectedSalaryLaborExpenses(selectedRows, periodKey, expenseId) {
  const hasSocialChargeRow = selectedRows.some((row) => row.rowType === "labor-social");
  const hasCooperativeRow = selectedRows.some((row) => row.rowType === "labor-cooperative");
  if (!hasSocialChargeRow && !hasCooperativeRow) return;

  state.payrollEntry.laborExpenses = state.payrollEntry.laborExpenses || createDefaultPayrollState().laborExpenses;
  if (hasSocialChargeRow) {
    state.payrollEntry.laborExpenses.socialChargeExpenseByPeriod[periodKey] = String(expenseId);
  }
  if (hasCooperativeRow) {
    state.payrollEntry.laborExpenses.cooperativeExpenseByPeriod[periodKey] = String(expenseId);
  }
}

function resetSalaryExpenseForm() {
  [
    "salary-expense-invoice-number",
    "salary-expense-subtotal",
    "salary-expense-iva",
    "salary-expense-vat-retention",
    "salary-expense-iibb-retention",
    "salary-expense-internal-taxes",
    "salary-expense-total"
  ].forEach((id) => {
    if (!els[id]) return;
    els[id].value = "";
    delete els[id].dataset.touched;
  });
  if (els["salary-expense-invoice-type"]) els["salary-expense-invoice-type"].value = "Factura_C";
  if (els["salary-expense-invoice-date"]) els["salary-expense-invoice-date"].value = toIsoDate(new Date());
  if (els["salary-expense-payment-date"]) {
    els["salary-expense-payment-date"].value = "";
    delete els["salary-expense-payment-date"].dataset.autoSalaryDueDate;
  }
  if (els["salary-expense-without-file"]) els["salary-expense-without-file"].checked = false;
  if (els["salary-expense-file"]) {
    els["salary-expense-file"].disabled = false;
    els["salary-expense-file"].value = "";
  }
  updateSalaryExpenseFileName();
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function loadOperationalEntryOptions() {
  const optionRequests = [
    ["empleados", "reception-employee-options", "id_empleado", ["nombre_empleado"]]
  ];

  await Promise.all(optionRequests.map(async ([tableName, datalistId, valueColumn, labelColumns]) => {
    const rows = await backendTableRowsForEntry(tableName).catch(() => []);
    renderEntryDatalistOptions(datalistId, rows, valueColumn, labelColumns);
  }));
  await Promise.all([
    loadReceptionPurchaseOptions(),
    loadIssuedCheckPendingPayments()
  ]);
}

async function loadReceptionPurchaseOptions() {
  const select = els["reception-purchase-id"];
  if (!select) return;

  const currentValue = select.value;
  const [purchases, receptions, purchaseDetails, suppliers, supplies, providers, items, labels] = await Promise.all([
    backendTableRowsForEntry("compras").catch(() => []),
    backendTableRowsForEntry("recepciones").catch(() => []),
    backendTableRowsForEntry("detalle_compras").catch(() => []),
    backendTableRowsForEntry("insumos_proveedores").catch(() => []),
    backendTableRowsForEntry("insumos").catch(() => []),
    backendTableRowsForEntry("proveedores").catch(() => []),
    backendTableRowsForEntry("items").catch(() => []),
    backendTableRowsForEntry("etiquetas").catch(() => [])
  ]);

  const receivedPurchaseIds = new Set(receptions.map((row) => String(row.id_compra ?? "").trim()).filter(Boolean));
  const detailsByPurchaseId = groupRowsByKey(purchaseDetails, "id_compra");
  const suppliersById = rowsByKey(suppliers, "id_insumos_proveedores");
  const suppliesById = rowsByKey(supplies, "id_insumo");
  const providersById = rowsByKey(providers, "id_proveedor");
  const itemsBySupplyId = rowsByKey(
    items.filter((row) => normalizeCategory(row.origen_tipo) === "insumo"),
    "id_origen"
  );
  const labelsByName = rowsByNormalizedValue(labels, "etiqueta");
  const pendingPurchases = purchases.filter((purchase) => {
    const purchaseId = String(purchase.id_compra ?? "").trim();
    return purchaseId && !receivedPurchaseIds.has(purchaseId);
  }).sort((a, b) => {
    const dateA = String(a.fecha_entrega_prevista || "9999-12-31");
    const dateB = String(b.fecha_entrega_prevista || "9999-12-31");
    return dateA.localeCompare(dateB);
  });

  receptionPendingPurchases = new Map();
  selectedReceptionPurchaseIds = new Set();

  select.innerHTML = `<option value="">Elegir compra pendiente</option>` + pendingPurchases.map((purchase) => {
    const purchaseId = String(purchase.id_compra ?? "").trim();
    const firstDetail = (detailsByPurchaseId.get(purchaseId) || [])[0] || {};
    const supplier = suppliersById.get(String(firstDetail.id_insumos_proveedores ?? "").trim()) || {};
    const supply = suppliesById.get(String(supplier.id_insumo ?? "").trim()) || {};
    const provider = providersById.get(String(purchase.id_proveedor ?? "").trim()) || {};
    const option = buildReceptionPendingOption(purchase, firstDetail, supplier, supply, provider, itemsBySupplyId, labelsByName);
    if (option) receptionPendingPurchases.set(purchaseId, option);
    const labelParts = [
      `#${purchaseId}`,
      displayNameLabel(provider.nombre || `Proveedor ${purchase.id_proveedor || "-"}`),
      displayNameLabel(supply.nombre || "Sin insumo"),
      purchase.fecha_entrega_prevista ? `Entrega ${formatDate(purchase.fecha_entrega_prevista)}` : ""
    ].filter(Boolean);
    return `<option value="${escapeHtml(purchaseId)}">${escapeHtml(labelParts.join(" - "))}</option>`;
  }).join("");

  if (pendingPurchases.some((purchase) => String(purchase.id_compra ?? "").trim() === currentValue)) {
    select.value = currentValue;
  }
  renderReceptionPendingPurchases();
  fillReceptionFromSelectedPurchase();
}

function buildReceptionPendingOption(purchase, detail, supplier, supply, provider, itemsBySupplyId, labelsByName) {
  const purchaseId = String(purchase.id_compra ?? "").trim();
  if (!purchaseId || !String(detail.id_detalle_compra ?? "").trim()) return null;
  const supplierQuantity = parseMoney(detail.cantidad);
  const recipePerSupplierUnit = parseMoney(supplier.cantidad_proveedor) || 1;
  const recipePerCountUnit = parseMoney(supply.cantidad_receta) || 1;
  const recipeQuantity = supplierQuantity * recipePerSupplierUnit;
  const countQuantity = recipePerCountUnit ? recipeQuantity / recipePerCountUnit : recipeQuantity;
  const item = itemsBySupplyId.get(String(supply.id_insumo ?? "").trim()) || {};
  return {
    purchase,
    detail,
    supplier,
    supply,
    provider,
    purchaseId,
    supplierQuantity,
    recipeQuantity,
    countQuantity,
    recipePerSupplierUnit,
    recipePerCountUnit,
    unitPrice: parseMoney(supplier.precio),
    ivaRate: parseRate(supplier.iva),
    expenseLabelId: String(labelsByName.get(normalizeCategory("Mercaderia"))?.id_etiqueta ?? "").trim(),
    supplierUnit: supplier.ud_proveedor || "",
    recipeUnit: supply.ud_receta || "",
    countUnit: item.ud_conteo || supply.ud_conteo || supply.ud_receta || ""
  };
}

function renderReceptionPendingPurchases() {
  const body = els["reception-pending-body"];
  if (!body) return;
  const options = [...receptionPendingPurchases.values()];
  if (!options.length) {
    body.innerHTML = `<tr><td class="empty" colspan="5">No hay compras pendientes de recibir.</td></tr>`;
    return;
  }
  const selectedId = String(els["reception-purchase-id"]?.value || "").trim();
  body.innerHTML = options.map((option) => `
    <tr data-reception-purchase-id="${escapeHtml(option.purchaseId)}" class="${selectedReceptionPurchaseIds.has(option.purchaseId) || option.purchaseId === selectedId ? "is-selected" : ""}">
      <td><input type="checkbox" data-reception-purchase-select="${escapeHtml(option.purchaseId)}" ${selectedReceptionPurchaseIds.has(option.purchaseId) ? "checked" : ""} aria-label="Seleccionar compra ${escapeHtml(option.purchaseId)}"> ${formatDate(option.purchase.fecha_entrega_prevista)}</td>
      <td>${escapeHtml(displayNameLabel(option.supply.nombre || "Sin insumo"))}</td>
      <td>${escapeHtml(displayNameLabel(option.provider.nombre || `Proveedor ${option.purchase.id_proveedor || "-"}`))}</td>
      <td class="num">${escapeHtml(purchasePresentationLabel(option.supplierQuantity, option.supplierUnit))}</td>
      <td class="num">${escapeHtml(purchaseQuantityLabel(option.countQuantity, option.countUnit))}</td>
    </tr>
  `).join("");
}

function selectReceptionPendingPurchase(purchaseId) {
  if (!els["reception-purchase-id"]) return;
  const id = String(purchaseId || "").trim();
  selectedReceptionPurchaseIds = id ? new Set([id]) : new Set();
  els["reception-purchase-id"].value = id;
  renderReceptionPendingPurchases();
  fillReceptionFromSelectedPurchase();
}

function toggleReceptionPurchaseSelection(purchaseId, checked) {
  const id = String(purchaseId || "").trim();
  if (!id) return;
  if (checked) {
    if (selectedReceptionPurchaseIds.size >= 2 && !selectedReceptionPurchaseIds.has(id)) {
      setEntryStatus("reception-status", "Podes asociar como maximo dos recepciones a una misma factura.", "error");
      renderReceptionPendingPurchases();
      return;
    }
    selectedReceptionPurchaseIds.add(id);
  } else {
    selectedReceptionPurchaseIds.delete(id);
  }
  const firstId = [...selectedReceptionPurchaseIds][0] || "";
  if (els["reception-purchase-id"]) els["reception-purchase-id"].value = firstId;
  renderReceptionPendingPurchases();
  fillReceptionFromSelectedPurchase();
}


async function loadIssuedCheckPendingPayments() {
  const body = els["issued-check-pending-body"];
  if (!body) return;
  body.innerHTML = `<tr><td class="empty" colspan="5">Cargando pagos con cheque pendientes...</td></tr>`;

  try {
    const [debtTables, payments, issuedChecks] = await Promise.all([
      loadExpenseDebtTables(),
      backendTableRowsForEntry("pagos").catch(() => []),
      backendTableRowsForEntry("cheques_entregados").catch(() => [])
    ]);
    const pendingPayments = buildIssuedCheckPendingPayments(debtTables, payments, issuedChecks);
    issuedCheckPaymentOptions = new Map(pendingPayments.map((payment) => [payment.paymentId, payment]));
    renderIssuedCheckPendingPayments(pendingPayments);
    clearIssuedCheckDetail();
  } catch (error) {
    body.innerHTML = emptyRow(5, error.message || "No se pudieron leer los pagos con cheque.");
  }
}

function buildIssuedCheckPendingPayments(tables, payments, issuedChecks) {
  const paymentDetails = tables.detalle_pagos?.rows || [];
  const detailsByPaymentId = groupRowsByKey(paymentDetails, "id_pago");
  const expensesById = rowsByKey(tables.egresos?.rows || [], "id_egreso");
  const lookups = expenseDebtLookups(tables);
  const paymentsWithIssuedCheck = new Set(issuedChecks.map((check) => comparableLookupId(check.id_pago)).filter(Boolean));

  return payments
    .filter((payment) => {
      const paymentId = comparableLookupId(payment.id_pago);
      return paymentId && !paymentsWithIssuedCheck.has(paymentId) && isIssuedCheckPaymentMethod(payment.metodo);
    })
    .map((payment) => {
      const paymentId = String(payment.id_pago ?? "").trim();
      const details = detailsByPaymentId.get(paymentId) || [];
      const expenses = details.map((detail) => expensesById.get(String(detail.id_egreso ?? "").trim())).filter(Boolean);
      const mainExpense = expenses[0] || {};
      const creditorId = resolveExpenseCreditorId(mainExpense, lookups);
      const amountFromDetails = details.reduce((total, detail) => total + parseMoney(detail.monto_cancelado), 0);
      const amount = parseMoney(payment.monto) || amountFromDetails;
      return {
        paymentId,
        paymentDate: parseDate(payment.fecha_pago) || "",
        bank: String(payment.banco || "ICBC").trim() || "ICBC",
        amount,
        creditorId,
        creditorName: creditorId ? expenseDebtCreditorName(mainExpense, creditorId, lookups) : "Sin acreedor",
        expenseLabel: issuedCheckExpenseSummary(expenses, details)
      };
    })
    .filter((payment) => payment.amount > 0)
    .sort((left, right) => String(left.paymentDate || "").localeCompare(String(right.paymentDate || "")) || Number(left.paymentId) - Number(right.paymentId));
}

function isIssuedCheckPaymentMethod(method) {
  const normalizedMethod = normalizeCategory(method);
  return normalizedMethod === "cheque" || normalizedMethod === "echeq" || normalizedMethod === "e cheque";
}

function issuedCheckExpenseSummary(expenses, details) {
  if (!details.length) return "Sin egreso asociado";
  return details.map((detail, index) => {
    const expense = expenses[index] || {};
    const expenseId = String(detail.id_egreso || expense.id_egreso || "").trim();
    const invoiceNumber = String(expense.nro_factura || "").trim();
    return [`Egreso ${expenseId || "-"}`, invoiceNumber ? `Factura ${invoiceNumber}` : ""].filter(Boolean).join(" - ");
  }).join(", ");
}

function renderIssuedCheckPendingPayments(payments) {
  const body = els["issued-check-pending-body"];
  if (!body) return;
  if (els["issued-check-pending-count"]) {
    els["issued-check-pending-count"].textContent = `${payments.length} pago${payments.length === 1 ? "" : "s"}`;
  }
  if (!payments.length) {
    body.innerHTML = `<tr><td class="empty" colspan="5">No hay pagos con cheque pendientes.</td></tr>`;
    return;
  }
  const selectedPaymentId = String(els["issued-check-payment-id"]?.value || "").trim();
  body.innerHTML = payments.map((payment) => `
    <tr data-issued-check-payment-id="${escapeHtml(payment.paymentId)}" class="${payment.paymentId === selectedPaymentId ? "is-selected" : ""}">
      <td>${formatDate(payment.paymentDate)}</td>
      <td>${escapeHtml(displayNameLabel(payment.creditorName))}</td>
      <td>${escapeHtml(payment.expenseLabel)}</td>
      <td>${escapeHtml(payment.bank || "-")}</td>
      <td class="num">${formatMoney(payment.amount)}</td>
    </tr>
  `).join("");
}

function paidAmountsByExpenseId(paymentDetails) {
  return paymentDetails.reduce((paidByExpense, paymentDetail) => {
    const expenseId = String(paymentDetail.id_egreso ?? "").trim();
    if (!expenseId) return paidByExpense;
    paidByExpense.set(expenseId, (paidByExpense.get(expenseId) || 0) + parseMoney(paymentDetail.monto_cancelado));
    return paidByExpense;
  }, new Map());
}

function openExpenseAmount(expense, paidByExpenseId) {
  const invoiceType = normalizeCategory(expense.tipo_factura);
  if (!isFinancialInvoiceTypeVisible(invoiceType)) return 0;

  const expenseId = String(expense.id_egreso ?? "").trim();
  const total = parseMoney(expense.total);
  const paid = paidByExpenseId.get(expenseId) || 0;
  const calculatedOpenAmount = total - paid;
  const explicitBalance = parseMoney(expense.saldo);
  const openAmount = Math.abs(explicitBalance) > 0.01 ? explicitBalance : calculatedOpenAmount;
  return openAmount > 10 ? openAmount : 0;
}

function resolveExpenseCreditorId(expense, lookups) {
  const directCreditorId = String(expense.id_acreedor ?? "").trim();
  if (directCreditorId) return directCreditorId;

  // Respaldo para egresos historicos que no tienen origen enlazado en las
  // tablas operativas, pero conservan el acreedor importado.
  const historicalCreditorId = String(expense._id_acreedor ?? "").trim();
  if (historicalCreditorId) return historicalCreditorId;

  const expenseId = String(expense.id_egreso ?? "").trim();
  if (expenseId) {
    const linkedOtherExpense = lookups.otherExpensesByExpenseId?.get(expenseId);
    if (linkedOtherExpense?.id_acreedor) return String(linkedOtherExpense.id_acreedor).trim();

    const linkedReception = lookups.receptionsByExpenseId?.get(expenseId);
    if (linkedReception?._id_acreedor) return String(linkedReception._id_acreedor).trim();
    if (linkedReception) {
      const purchase = lookups.purchases.get(String(linkedReception.id_compra ?? "").trim()) || {};
      const providerCreditorId = creditorIdFromOrigin("proveedor", purchase.id_proveedor, lookups);
      if (providerCreditorId) return providerCreditorId;
    }

    const linkedDelivery = lookups.deliveriesByExpenseId?.get(expenseId);
    if (linkedDelivery) {
      const freightCreditorId = creditorIdFromOrigin("flete", linkedDelivery.id_flete, lookups);
      if (freightCreditorId) return freightCreditorId;
    }

    const linkedSalaries = lookups.payrollByExpenseId?.get(comparableLookupId(expenseId)) || [];
    if (linkedSalaries.length) {
      const linkedEmployees = linkedSalaries
        .map((salary) => lookups.employees.get(comparableLookupId(salary.id_empleado)))
        .filter(Boolean);
      const allCooperative = linkedEmployees.length === linkedSalaries.length
        && linkedEmployees.every((employee) => normalizeSearchText(normalizeEmployeeContractType(
          employee.contratacion,
          employee.nombre_empleado || employee.nombre
        )) === "cooperativa");
      if (allCooperative) {
        const cooperativeCreditorId = creditorIdByDisplayName("Cooperativa_Nuevos_Lazos", lookups);
        if (cooperativeCreditorId) return cooperativeCreditorId;
      }

      const employeeCreditorId = creditorIdFromOrigin("empleado", linkedSalaries[0].id_empleado, lookups);
      if (employeeCreditorId) return employeeCreditorId;
    }
  }

  const originType = normalizeSearchText(expense.origen_tipo);
  const originId = String(expense.origen_id ?? "").trim();
  if (!originId) return "";

  if (originType.includes("otros")) {
    return String(lookups.otherExpenses.get(originId)?.id_acreedor ?? "").trim();
  }

  if (originType.includes("recepcion")) {
    const reception = lookups.receptions.get(originId) || {};
    const purchase = lookups.purchases.get(String(reception.id_compra ?? "").trim()) || {};
    return creditorIdFromOrigin("proveedor", purchase.id_proveedor, lookups);
  }

  if (originType.includes("logistica") || originType.includes("entrega")) {
    const delivery = lookups.deliveries.get(originId) || {};
    return creditorIdFromOrigin("flete", delivery.id_flete, lookups);
  }

  if (originType.includes("sueldo")) {
    const salary = lookups.payroll.get(originId) || {};
    return creditorIdFromOrigin("empleado", salary.id_empleado, lookups);
  }

  return "";
}

function creditorIdFromOrigin(originType, originId, lookups) {
  const normalizedOriginType = normalizeSearchText(originType);
  const normalizedOriginId = comparableLookupId(originId);
  if (!normalizedOriginId) return "";
  for (const creditor of lookups.creditors.values()) {
    const creditorType = normalizeSearchText(creditor.origen_tipo_acreedor);
    const creditorOriginId = comparableLookupId(creditor.origen_id_acreedor);
    if (creditorOriginId === normalizedOriginId && creditorType.includes(normalizedOriginType)) {
      return String(creditor.id_acreedor ?? "").trim();
    }
  }
  return "";
}

function creditorIdByDisplayName(name, lookups) {
  const normalizedName = normalizeSearchText(name);
  for (const [creditorId] of lookups.creditors) {
    if (normalizeSearchText(creditorDisplayName(creditorId, lookups)) === normalizedName) {
      return creditorId;
    }
  }
  return "";
}

function creditorDisplayName(creditorId, lookups) {
  const creditor = lookups.creditors.get(String(creditorId ?? "").trim());
  if (!creditor) return creditorId ? `Acreedor ${creditorId}` : "Sin acreedor";
  const originType = normalizeSearchText(creditor.origen_tipo_acreedor);
  const originId = String(creditor.origen_id_acreedor ?? "").trim();
  if (originType.includes("proveedor")) return displayNameLabel(lookups.providers.get(originId)?.nombre || `Proveedor ${originId}`);
  if (originType.includes("empleado")) return displayNameLabel(lookups.employees.get(originId)?.nombre_empleado || `Empleado ${originId}`);
  if (originType.includes("flete")) return displayNameLabel(lookups.freights.get(originId)?.nombre_flete || `Flete ${originId}`);
  if (originType.includes("canal")) return displayNameLabel(lookups.channels.get(originId)?.nombre || `Canal ${originId}`);
  if (originType.includes("otro")) {
    const other = lookups.otherCreditors.get(originId) || {};
    return displayNameLabel(other.nombre_otro_acreedor || other.nombre || `Otro acreedor ${originId}`);
  }
  return `Acreedor ${creditorId}`;
}

// La solapa Egresos usa el mismo criterio de deuda abierta que cashflow:
// total del egreso menos pagos aplicados, ignorando saldos insignificantes.
async function loadExpenseDebtView() {
  if (!els["expense-debt-body"]) return;

  els["expense-debt-summary"].textContent = "Cargando deudas desde backend.";
  els["expense-debt-body"].innerHTML = emptyRow(8, "Cargando deudas desde backend.");

  try {
    const tables = await loadExpenseDebtTables();
    const rows = buildExpenseDebtRows(tables);
    renderExpenseDebtRows(rows);
  } catch (error) {
    els["expense-debt-summary"].textContent = "No se pudieron leer las deudas.";
    els["expense-debt-body"].innerHTML = emptyRow(8, error.message || "Error al cargar egresos.");
  }
}

async function loadExpenseDebtTables() {
  const tableNames = [
    "egresos",
    "detalle_pagos",
    "etiquetas",
    "acreedores",
    "acreedores_etiquetas",
    "otros_gastos",
    "recepciones",
    "compras",
    "entregas",
    "sueldos",
    "proveedores",
    "empleados",
    "fletes",
    "canales",
    "otros_acreedores"
  ];

  const entries = await Promise.all(tableNames.map(async (tableName) => {
    const rows = await backendTableRowsForEntry(tableName).catch(() => []);
    return [tableName, rows];
  }));

  return Object.fromEntries(entries.map(([tableName, rows]) => [tableName, { rows }]));
}

function buildExpenseDebtRows(tables) {
  const expenses = tables.egresos?.rows || [];
  const paymentDetails = tables.detalle_pagos?.rows || [];
  const paidByExpenseId = paidAmountsByExpenseId(paymentDetails);
  const lookups = expenseDebtLookups(tables);

  return expenses
    .map((expense) => {
      const expenseId = String(expense.id_egreso ?? "").trim();
      const paidAmount = paidByExpenseId.get(expenseId) || 0;
      const openAmount = openExpenseAmount(expense, paidByExpenseId);
      if (!expenseId || openAmount <= 10) return null;

      const paymentDate = parseDate(expense.fecha_prevista_pago) || parseDate(expense.fecha_factura) || "";
      const invoiceDate = parseDate(expense.fecha_factura) || "";
      const creditorId = resolveExpenseCreditorId(expense, lookups);
      return {
        id: expenseId,
        tag: expenseDebtTagName(expense, tables, lookups) || "Sin etiqueta",
        paymentDate,
        invoiceDate,
        creditorId,
        creditor: expenseDebtCreditorName(expense, creditorId, lookups),
        invoiceType: String(expense.tipo_factura || "Sin tipo").trim(),
        invoiceNumber: String(expense.nro_factura || "Sin numero").trim(),
        total: parseMoney(expense.total),
        paid: paidAmount,
        balance: openAmount
      };
    })
    .filter(Boolean)
    .sort((left, right) => compareExpenseDebtRows(left, right));
}

function expenseDebtLookups(tables) {
  const rows = (tableName) => tables[tableName]?.rows || [];
  const otherExpenses = rows("otros_gastos");
  const receptions = rows("recepciones");
  const deliveries = rows("entregas");
  const payroll = rows("sueldos");

  return {
    creditors: rowsByKey(rows("acreedores"), "id_acreedor"),
    otherExpenses: rowsByKey(otherExpenses, "id_otros_gastos"),
    otherExpensesByExpenseId: rowsByKey(otherExpenses, "id_egreso"),
    receptions: rowsByKey(receptions, "id_recepcion"),
    receptionsByExpenseId: rowsByKey(receptions, "id_egreso"),
    purchases: rowsByKey(rows("compras"), "id_compra"),
    deliveries: rowsByKey(deliveries, "id_entrega"),
    deliveriesByExpenseId: rowsByKey(deliveries, "id_egreso"),
    payroll: rowsByKey(payroll, "id_sueldo"),
    payrollByExpenseId: groupRowsByComparableKey(payroll, "id_egreso"),
    creditorTags: rows("acreedores_etiquetas"),
    creditorTagsById: rowsByKey(rows("acreedores_etiquetas"), "id_acreedor_etiqueta"),
    providers: rowsByKey(rows("proveedores"), "id_proveedor"),
    employees: rowsByKey(rows("empleados"), "id_empleado"),
    freights: rowsByKey(rows("fletes"), "id_flete"),
    channels: rowsByKey(rows("canales"), "id_canal"),
    otherCreditors: rowsByKey(rows("otros_acreedores"), "id_otro_acreedor")
  };
}

function expenseDebtTagName(expense, tables, lookups) {
  const tagById = rowsByKey(tables.etiquetas?.rows || [], "id_etiqueta");
  const directTag = tagById.get(String(expense.id_etiqueta ?? "").trim())?.etiqueta;
  if (directTag) return displayNameLabel(directTag);

  // Respaldo para egresos historicos que todavia no tienen id_etiqueta.
  const historicalTag = displayNameLabel(expense._etiqueta_gasto || "");
  if (historicalTag) return historicalTag;

  const directCreditorTag = lookups.creditorTagsById?.get(String(expense.id_acreedor_etiqueta ?? "").trim());
  const directCreditorTagName = tagById.get(String(directCreditorTag?.id_etiqueta ?? "").trim())?.etiqueta;
  if (directCreditorTagName) return displayNameLabel(directCreditorTagName);

  const originType = normalizeSearchText(expense.origen_tipo);
  if (originType.includes("recepcion")) return "Mercaderia";

  if (originType.includes("otros")) {
    const originId = String(expense.origen_id ?? "").trim();
    const otherExpense = rowsByKey(tables.otros_gastos?.rows || [], "id_otros_gastos").get(originId);
    const originCreditorTag = lookups.creditorTagsById?.get(String(otherExpense?.id_acreedor_etiqueta ?? "").trim());
    const originTag = tagById.get(String(otherExpense?.id_etiqueta ?? originCreditorTag?.id_etiqueta ?? "").trim())?.etiqueta;
    if (originTag) return displayNameLabel(originTag);
  }

  return firstExpenseDebtTagNameForCreditor(resolveExpenseCreditorId(expense, lookups), tagById, lookups);
}

function firstExpenseDebtTagNameForCreditor(creditorId, tagById, lookups) {
  const normalizedCreditorId = comparableLookupId(creditorId);
  if (!normalizedCreditorId) return "";

  const firstCreditorTag = (lookups.creditorTags || [])
    .filter((relation) => comparableLookupId(relation.id_acreedor) === normalizedCreditorId)
    .sort((left, right) => Number(left.id_acreedor_etiqueta || 0) - Number(right.id_acreedor_etiqueta || 0))[0];
  const tagName = tagById.get(String(firstCreditorTag?.id_etiqueta ?? "").trim())?.etiqueta;
  return tagName ? displayNameLabel(tagName) : "";
}

function expenseDebtCreditorName(expense, creditorId, lookups) {
  const name = creditorDisplayName(creditorId, lookups);
  if (name && name !== "Sin acreedor") return name;
  return displayNameLabel(expense.nombre_acreedor || expense.acreedor || "") || "Sin acreedor";
}

function compareExpenseDebtRows(left, right) {
  const leftDate = left.paymentDate || "9999-12-31";
  const rightDate = right.paymentDate || "9999-12-31";
  return left.tag.localeCompare(right.tag)
    || leftDate.localeCompare(rightDate)
    || left.creditor.localeCompare(right.creditor)
    || Number(left.id) - Number(right.id);
}

function renderExpenseDebtRows(rows) {
  if (!rows.length) {
    els["expense-debt-summary"].textContent = "No hay deudas pendientes.";
    els["expense-debt-body"].innerHTML = emptyRow(8, "No hay facturas pendientes de pago.");
    return;
  }

  const groups = expenseDebtGroups(rows);
  const totalDebt = rows.reduce((total, row) => total + row.balance, 0);
  els["expense-debt-summary"].textContent = `${rows.length} factura(s) pendientes · ${formatMoney(totalDebt)}`;
  els["expense-debt-body"].innerHTML = groups.map(expenseDebtGroupHtml).join("");
}

async function loadPaymentEntryView() {
  if (!els["payment-pending-body"]) return;

  if (els["payment-date"] && !els["payment-date"].value) {
    els["payment-date"].value = toIsoDate(new Date());
  }
  setEntryStatus("payment-status", "", "");
  els["payment-summary"].textContent = "Cargando deudas desde backend.";
  els["payment-pending-body"].innerHTML = emptyRow(7, "Cargando deudas desde backend.");
  els["payment-selected-total"].textContent = paymentMoneyLabel(0);
  if (els["payment-bank-amount"] && !bankPaymentDraft) els["payment-bank-amount"].value = "";
  if (els["payment-movement-comparison"]) els["payment-movement-comparison"].textContent = "";

  try {
    const tables = await loadExpenseDebtTables();
    paymentPendingExpenses = buildExpenseDebtRows(tables);
    renderPaymentCreditorFilter();
    applyBankPaymentDraft();
    renderPaymentPendingExpenses();
  } catch (error) {
    paymentPendingExpenses = [];
    renderPaymentCreditorFilter();
    els["payment-summary"].textContent = "No se pudieron cargar las deudas.";
    els["payment-pending-body"].innerHTML = emptyRow(7, error.message || "Error al cargar pagos.");
  }
}

function renderPaymentCreditorFilter() {
  const select = els["payment-creditor-filter"];
  if (!select) return;

  const currentValue = select.value;
  const creditorNames = [...new Set(paymentPendingExpenses
    .map((row) => String(row.creditor || "").trim())
    .filter((creditor) => creditor && normalizeSearchText(creditor) !== "sin acreedor"))]
    .sort((left, right) => displayNameLabel(left).localeCompare(displayNameLabel(right), "es"));

  select.innerHTML = [
    `<option value="">Todos los acreedores</option>`,
    ...creditorNames.map((creditor) => `<option value="${escapeHtml(creditor)}">${escapeHtml(displayNameLabel(creditor))}</option>`)
  ].join("");
  select.value = creditorNames.includes(currentValue) ? currentValue : "";
}

function renderPaymentPendingExpenses() {
  if (!els["payment-pending-body"]) return;
  const previousSelection = currentPaymentSelection();
  const search = normalizeSearchText(els["payment-search"]?.value || "");
  const creditorFilter = normalizeSearchText(els["payment-creditor-filter"]?.value || "");
  const visibleRows = paymentPendingExpenses.filter((row) => {
    if (creditorFilter && normalizeSearchText(row.creditor) !== creditorFilter) return false;
    if (!search) return true;
    return normalizeSearchText([
      row.creditor,
      row.tag,
      row.invoiceType,
      row.invoiceNumber,
      row.id
    ].join(" ")).includes(search);
  });

  const totalDebt = paymentPendingExpenses.reduce((total, row) => total + row.balance, 0);
  els["payment-summary"].textContent = paymentPendingExpenses.length
    ? `${paymentPendingExpenses.length} factura(s) pendientes · ${paymentMoneyLabel(totalDebt)}`
    : "No hay facturas pendientes de pago.";

  if (!visibleRows.length) {
    els["payment-pending-body"].innerHTML = emptyRow(7, search || creditorFilter ? "No hay deudas que coincidan con el filtro." : "No hay facturas pendientes de pago.");
    updatePaymentSelectedTotal();
    return;
  }

  els["payment-pending-body"].innerHTML = visibleRows.map((row) => {
    const selected = previousSelection.get(row.id);
    const amount = selected?.amount ?? roundToDecimals(row.balance, 2);
    const checked = selected?.checked ? " checked" : "";
    const invoiceLabel = `${displayNameLabel(row.invoiceType)} ${row.invoiceNumber}`;
    return `
      <tr>
        <td><input type="checkbox" data-payment-select="${escapeHtml(row.id)}"${checked}></td>
        <td>${formatDate(row.paymentDate) || "-"}</td>
        <td>${escapeHtml(row.creditor)}</td>
        <td>${escapeHtml(row.tag)}</td>
        <td>${escapeHtml(invoiceLabel)}</td>
        <td class="num debt-balance">${paymentMoneyLabel(row.balance)}</td>
        <td class="num">
          <input class="payment-amount-input" type="number" min="0" step="any" value="${escapeHtml(amount)}" data-payment-amount="${escapeHtml(row.id)}">
        </td>
      </tr>
    `;
  }).join("");
  updatePaymentSelectedTotal();
}

function currentPaymentSelection() {
  const selection = new Map();
  document.querySelectorAll("[data-payment-amount]").forEach((input) => {
    const expenseId = String(input.dataset.paymentAmount || "").trim();
    if (!expenseId) return;
    const checkbox = document.querySelector(`[data-payment-select="${CSS.escape(expenseId)}"]`);
    selection.set(expenseId, {
      checked: Boolean(checkbox?.checked),
      amount: Number(String(input.value || "").replace(",", "."))
    });
  });
  return selection;
}

function selectedPaymentRows() {
  return [...document.querySelectorAll("[data-payment-select]:checked")]
    .map((checkbox) => {
      const expenseId = String(checkbox.dataset.paymentSelect || "").trim();
      const expense = paymentPendingExpenses.find((row) => row.id === expenseId);
      const amountInput = document.querySelector(`[data-payment-amount="${CSS.escape(expenseId)}"]`);
      const amount = Number(String(amountInput?.value || "").replace(",", "."));
      return expense && Number.isFinite(amount) && amount > 0
        ? { expense, amount: Math.min(amount, expense.balance) }
        : null;
    })
    .filter(Boolean);
}

function updatePaymentSelectedTotal() {
  if (!els["payment-selected-total"]) return;
  const total = selectedPaymentRows().reduce((sum, row) => sum + row.amount, 0);
  els["payment-selected-total"].textContent = paymentMoneyLabel(total);

  const comparison = els["payment-movement-comparison"];
  if (!comparison) return;
  const movementAmount = paymentBankMovementAmount();
  comparison.classList.remove("is-balanced", "is-pending");
  if (!movementAmount) {
    comparison.textContent = "";
    return;
  }

  const difference = roundToDecimals(movementAmount - total, 2);
  if (Math.abs(difference) < 0.01) {
    comparison.textContent = "El pago coincide con el movimiento.";
    comparison.classList.add("is-balanced");
    return;
  }

  comparison.textContent = `Diferencia: ${paymentMoneyLabel(Math.abs(difference))} ${difference > 0 ? "sin asignar" : "por corregir"}.`;
  comparison.classList.add("is-pending");
}

function paymentBankMovementAmount() {
  const amount = Number(String(els["payment-bank-amount"]?.value || "").replace(",", "."));
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function applyBankPaymentDraft() {
  if (!bankPaymentDraft) return;
  const draft = bankPaymentDraft;
  const creditor = paymentPendingExpenses.find((row) => String(row.creditorId || "") === String(draft.creditorId || ""))?.creditor || "";

  if (els["payment-date"] && draft.date) els["payment-date"].value = draft.date;
  if (els["payment-bank"] && draft.bank) els["payment-bank"].value = draft.bank;
  if (els["payment-method"] && draft.method) els["payment-method"].value = draft.method;
  if (els["payment-bank-amount"]) els["payment-bank-amount"].value = roundToDecimals(draft.amount, 2);
  if (els["payment-creditor-filter"] && creditor) els["payment-creditor-filter"].value = creditor;

  bankPaymentDraft = null;
}

function paymentMoneyLabel(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(number);
}

async function submitPaymentEntry(event) {
  event.preventDefault();
  const selectedRows = selectedPaymentRows();
  const paymentDate = String(els["payment-date"]?.value || "").trim();
  const method = String(els["payment-method"]?.value || "").trim();
  const bank = String(els["payment-bank"]?.value || "").trim();

  if (!paymentDate || !method) {
    setEntryStatus("payment-status", "Completa fecha y metodo de pago.", "error");
    return;
  }
  if (!selectedRows.length) {
    setEntryStatus("payment-status", "Selecciona al menos una factura pendiente.", "error");
    return;
  }

  const total = selectedRows.reduce((sum, row) => sum + row.amount, 0);
  const button = els["payment-submit"];
  const originalText = button?.textContent || "Guardar pago";
  if (button) {
    button.disabled = true;
    button.textContent = "Guardando...";
  }
  setEntryStatus("payment-status", "Guardando pago...", "pending");

  try {
    const [paymentId, detailStartId] = await Promise.all([
      nextBackendPrimaryId("pagos", "id_pago"),
      nextBackendPrimaryId("detalle_pagos", "id_detalle_pago")
    ]);
    await saveBackendEntryRows("pagos", [{
      id_pago: paymentId,
      fecha_pago: paymentDate,
      metodo: method,
      banco: bank,
      monto: total
    }]);
    await saveBackendEntryRows("detalle_pagos", selectedRows.map((row, index) => ({
      id_detalle_pago: detailStartId + index,
      id_pago: paymentId,
      id_egreso: row.expense.id,
      monto_cancelado: row.amount
    })));

    backendDataMap = null;
    dataEditorSchema = null;
    await loadPaymentEntryView();
    setEntryStatus("payment-status", `Pago ${paymentId} guardado por ${formatMoney(total)}.`, "success");
  } catch (error) {
    setEntryStatus("payment-status", error.message || "No se pudo guardar el pago.", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function expenseDebtGroups(rows) {
  const groupsByTag = new Map();
  rows.forEach((row) => {
    if (!groupsByTag.has(row.tag)) groupsByTag.set(row.tag, []);
    groupsByTag.get(row.tag).push(row);
  });

  return [...groupsByTag.entries()]
    .map(([tag, groupRows]) => ({
      tag,
      rows: groupRows.sort((left, right) => compareExpenseDebtRows(left, right)),
      total: groupRows.reduce((total, row) => total + row.balance, 0),
      firstDate: groupRows.reduce((date, row) => {
        const rowDate = row.paymentDate || "9999-12-31";
        return rowDate < date ? rowDate : date;
      }, "9999-12-31")
    }))
    .sort((left, right) => left.firstDate.localeCompare(right.firstDate) || left.tag.localeCompare(right.tag));
}

function expenseDebtGroupHtml(group) {
  const rowsHtml = group.rows.map((row) => `
    <tr>
      <td>${formatDate(row.paymentDate) || "-"}</td>
      <td>${formatDate(row.invoiceDate) || "-"}</td>
      <td>${escapeHtml(row.creditor)}</td>
      <td>${escapeHtml(displayNameLabel(row.invoiceType))}</td>
      <td>${escapeHtml(row.invoiceNumber)}</td>
      <td class="num">${formatMoney(row.total)}</td>
      <td class="num muted-cell">${formatMoney(row.paid)}</td>
      <td class="num debt-balance">${formatMoney(row.balance)}</td>
    </tr>
  `).join("");

  return `
    <tr class="expense-debt-group-row">
      <td colspan="5">
        <strong>${escapeHtml(group.tag)}</strong>
        <span>${group.rows.length} factura(s)</span>
      </td>
      <td colspan="3" class="num">${formatMoney(group.total)}</td>
    </tr>
    ${rowsHtml}
  `;
}

function fillIssuedCheckFromSelectedPayment(paymentId) {
  const option = issuedCheckPaymentOptions.get(String(paymentId || "").trim());
  if (!option) {
    clearIssuedCheckDetail();
    return;
  }

  const deliveredDate = option.paymentDate || toIsoDate(new Date());
  if (els["issued-check-payment-id"]) els["issued-check-payment-id"].value = option.paymentId;
  if (els["issued-check-payment-label"]) els["issued-check-payment-label"].value = `Pago ${option.paymentId} - ${formatDate(deliveredDate)}`;
  if (els["issued-check-creditor-id"]) els["issued-check-creditor-id"].value = option.creditorId || "";
  if (els["issued-check-creditor-name"]) els["issued-check-creditor-name"].value = displayNameLabel(option.creditorName || "Sin acreedor");
  if (els["issued-check-expense-label"]) els["issued-check-expense-label"].value = option.expenseLabel || "-";
  if (els["issued-check-amount"]) els["issued-check-amount"].value = roundToDecimals(option.amount, 2);
  if (els["issued-check-date"]) els["issued-check-date"].value = deliveredDate;
  if (els["issued-check-use-date"]) els["issued-check-use-date"].value = addMonthsIso(deliveredDate, 1);
  if (els["issued-check-bank"]) els["issued-check-bank"].value = option.bank || "ICBC";
  if (els["issued-check-state"]) els["issued-check-state"].value = "Pendiente";
  renderIssuedCheckPendingPayments([...issuedCheckPaymentOptions.values()]);
  els["issued-check-number"]?.focus();
}

function clearIssuedCheckDetail() {
  [
    "issued-check-payment-id",
    "issued-check-payment-label",
    "issued-check-creditor-id",
    "issued-check-creditor-name",
    "issued-check-expense-label",
    "issued-check-number",
    "issued-check-amount"
  ].forEach((id) => {
    if (els[id]) els[id].value = "";
  });
  const today = toIsoDate(new Date());
  if (els["issued-check-date"]) els["issued-check-date"].value = today;
  if (els["issued-check-use-date"]) els["issued-check-use-date"].value = addMonthsIso(today, 1);
  if (els["issued-check-bank"]) els["issued-check-bank"].value = "ICBC";
  if (els["issued-check-state"]) els["issued-check-state"].value = "Pendiente";
}

function addMonthsIso(isoDate, months) {
  const parsedDate = parseDate(isoDate) || toIsoDate(new Date());
  const date = new Date(`${parsedDate}T00:00:00`);
  date.setMonth(date.getMonth() + months);
  return toIsoDate(date);
}

async function backendTableRowsForEntry(tableName) {
  const response = await fetch(`${API_BASE_URL}/api/backend/tables/${encodeURIComponent(tableName)}?all=true`, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return Array.isArray(payload.table?.rows) ? payload.table.rows : [];
}

async function saveBackendEntryRows(tableName, rows) {
  const response = await fetch(`${API_BASE_URL}/api/backend/tables/${encodeURIComponent(tableName)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows, search: "", limit: 300 })
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function nextBackendPrimaryId(tableName, primaryColumn) {
  const rows = await backendTableRowsForEntry(tableName);
  return rows.reduce((maxId, row) => {
    const id = Number(row[primaryColumn]);
    return Number.isFinite(id) ? Math.max(maxId, id) : maxId;
  }, 0) + 1;
}

async function nextBackendPrimaryIdOrOne(tableName, primaryColumn) {
  try {
    return await nextBackendPrimaryId(tableName, primaryColumn);
  } catch {
    return 1;
  }
}

async function loadCommercialEntryData(force = false) {
  if (commercialEntryData.loaded && !force) {
    renderCommercialEntryViews();
    return;
  }

  try {
    const [
      clientes,
      productos,
      pedidos,
      detallePedidos,
      entregas,
      entregasDetalle,
      ventas,
      cobros,
      cobrosDetalle,
      chequesRecibidos,
      fletes,
      canales,
      acreedores,
      acreedoresEtiquetas,
      comisiones,
      etiquetas
    ] = await Promise.all([
      backendTableRowsForEntry("clientes").catch(() => []),
      backendTableRowsForEntry("productos").catch(() => []),
      backendTableRowsForEntry("pedidos").catch(() => []),
      backendTableRowsForEntry("detalle_pedidos").catch(() => []),
      backendTableRowsForEntry("entregas").catch(() => []),
      backendTableRowsForEntry("entregas_detalle").catch(() => []),
      backendTableRowsForEntry("ventas").catch(() => []),
      backendTableRowsForEntry("cobros").catch(() => []),
      backendTableRowsForEntry("cobros_detalle").catch(() => []),
      backendTableRowsForEntry("cheques_recibidos").catch(() => []),
      backendTableRowsForEntry("fletes").catch(() => []),
      backendTableRowsForEntry("canales").catch(() => []),
      backendTableRowsForEntry("acreedores").catch(() => []),
      backendTableRowsForEntry("acreedores_etiquetas").catch(() => []),
      backendTableRowsForEntry("comisiones").catch(() => []),
      backendTableRowsForEntry("etiquetas").catch(() => [])
    ]);

    commercialEntryData = {
      loaded: true,
      clientes,
      productos,
      pedidos,
      detalle_pedidos: detallePedidos,
      entregas,
      entregas_detalle: entregasDetalle,
      ventas,
      cobros,
      cobros_detalle: cobrosDetalle,
      cheques_recibidos: chequesRecibidos,
      fletes,
      canales,
      acreedores,
      acreedores_etiquetas: acreedoresEtiquetas,
      comisiones,
      etiquetas
    };
    renderCommercialEntryViews();
  } catch (error) {
    setCommercialStatus("orders-status", `No se pudieron cargar los datos comerciales: ${error.message}`, "error");
  }
}

function renderCommercialEntryViews() {
  renderOrderEntry();
  renderLogisticsEntry();
  renderSalesEntry();
  renderCollectionsEntry();
  renderCommissionsEntry();
  renderReceivedCheckEntry();
}

function renderOrderEntry() {
  fillSelectOptions(els["order-client"], commercialEntryData.clientes, "id_cliente", "nombre_cliente", "Cliente");
  fillSelectOptions(els["order-product"], commercialEntryData.productos, "id_producto", "nombre_producto", "Producto");
  if (els["order-date"] && !els["order-date"].value) els["order-date"].value = toIsoDate(new Date());
  if (els["order-delivery-date"] && !els["order-delivery-date"].value) els["order-delivery-date"].value = toIsoDate(new Date());
}

function renderLogisticsEntry() {
  const body = els["logistics-pending-body"];
  if (!body) return;

  const deliveriesById = mapRowsById(commercialEntryData.entregas, "id_entrega");
  const deliveredOrderIds = new Set(
    commercialEntryData.entregas_detalle
      .filter((row) => {
        const delivery = deliveriesById.get(backendId(row.id_entrega));
        return backendId(delivery?.id_flete);
      })
      .map((row) => backendId(row.id_pedido))
  );
  const clientsById = mapRowsById(commercialEntryData.clientes, "id_cliente");
  const orderDetailsByOrder = groupRowsById(commercialEntryData.detalle_pedidos, "id_pedido");
  const productsById = mapRowsById(commercialEntryData.productos, "id_producto");
  const pendingOrders = commercialEntryData.pedidos
    .filter((order) => !deliveredOrderIds.has(backendId(order.id_pedido)))
    .sort((a, b) => String(a.fecha_entrega || "").localeCompare(String(b.fecha_entrega || "")));

  fillSelectOptions(els["logistics-delivery-fleet"], commercialEntryData.fletes, "id_flete", "nombre_flete", "Flete");
  if (els["logistics-delivery-fleet"]) els["logistics-delivery-fleet"].value = logisticsDefaultFleetId();
  if (els["logistics-delivery-date"] && !els["logistics-delivery-date"].value) {
    els["logistics-delivery-date"].value = pendingOrders[0]?.fecha_entrega || toIsoDate(new Date());
  }

  if (!pendingOrders.length) {
    body.innerHTML = `<tr><td class="empty" colspan="5">No hay pedidos pendientes.</td></tr>`;
    updateLogisticsOrderSelectionSummary();
    renderLogisticsExpenseEntry();
    return;
  }

  body.innerHTML = pendingOrders.map((order) => {
    const orderId = backendId(order.id_pedido);
    const detail = (orderDetailsByOrder.get(orderId) || [])
      .map((row) => {
        const product = productsById.get(backendId(row.id_producto));
        const productName = product?.nombre_producto || product?.nombre || row.id_producto;
        return `${displayNameLabel(productName)} (${formatNumber(parseMoney(row.cantidad_cajas))})`;
      })
      .join(", ");
    return `
      <tr>
        <td><input type="checkbox" data-logistics-order="${escapeHtml(orderId)}"></td>
        <td>${formatDate(order.fecha_entrega)}</td>
        <td>${escapeHtml(clientName(order.id_cliente))}</td>
        <td>#${escapeHtml(orderId)}</td>
        <td>${escapeHtml(detail || "-")}</td>
      </tr>
    `;
  }).join("");
  updateLogisticsOrderSelectionSummary();
  renderLogisticsExpenseEntry();
}

function logisticsDefaultFleetId() {
  const defaultFleet = commercialEntryData.fletes.find((fleet) => normalizeCategory(fleet.nombre_flete || fleet.nombre).includes("transporte vision"));
  return backendId(defaultFleet?.id_flete);
}

function selectedLogisticsOrderIds() {
  return [...document.querySelectorAll("[data-logistics-order]:checked")]
    .map((input) => backendId(input.dataset.logisticsOrder))
    .filter(Boolean);
}

function updateLogisticsOrderSelectionSummary() {
  const selectedCount = selectedLogisticsOrderIds().length;
  if (els["logistics-order-selection"]) {
    els["logistics-order-selection"].textContent = `${selectedCount} pedido${selectedCount === 1 ? "" : "s"} seleccionado${selectedCount === 1 ? "" : "s"}`;
  }
}

function renderLogisticsExpenseEntry() {
  const body = els["logistics-expense-delivery-body"];
  if (!body) return;

  const rows = logisticsExpenseDeliveryRows();
  body.innerHTML = rows.length ? rows.map((row) => `
    <tr>
      <td><input type="checkbox" data-logistics-expense-delivery="${escapeHtml(row.deliveryId)}"></td>
      <td>${formatDate(row.delivery.fecha)}</td>
      <td>${escapeHtml(row.fleetName)}</td>
      <td>${escapeHtml(row.orderSummary || "-")}</td>
    </tr>
  `).join("") : `<tr><td class="empty" colspan="4">No hay entregas sin egreso asociado.</td></tr>`;

  if (els["logistics-expense-invoice-date"] && !els["logistics-expense-invoice-date"].value) {
    els["logistics-expense-invoice-date"].value = toIsoDate(new Date());
  }
  updateLogisticsExpenseSelectionSummary();
}

function logisticsExpenseDeliveryRows() {
  const fleetsById = mapRowsById(commercialEntryData.fletes, "id_flete");
  const deliveryDetailsByDelivery = groupRowsById(commercialEntryData.entregas_detalle, "id_entrega");
  const clientsById = mapRowsById(commercialEntryData.clientes, "id_cliente");
  const ordersById = mapRowsById(commercialEntryData.pedidos, "id_pedido");

  return commercialEntryData.entregas
    .filter((delivery) => backendId(delivery.id_flete) && !backendId(delivery.id_egreso))
    .map((delivery) => {
      const deliveryId = backendId(delivery.id_entrega);
      const fleet = fleetsById.get(backendId(delivery.id_flete));
      const orderSummary = (deliveryDetailsByDelivery.get(deliveryId) || [])
        .map((detail) => {
          const order = ordersById.get(backendId(detail.id_pedido));
          return `#${backendId(detail.id_pedido)} ${clientNameFromMap(order?.id_cliente, clientsById)}`;
        })
        .join(", ");
      return {
        delivery,
        deliveryId,
        fleetName: displayNameLabel(fleet?.nombre_flete || fleet?.nombre || delivery.id_flete),
        orderSummary
      };
    })
    .sort((a, b) => String(a.delivery.fecha || "").localeCompare(String(b.delivery.fecha || "")));
}

function updateLogisticsExpenseSelectionSummary() {
  const selectedCount = selectedLogisticsExpenseDeliveryIds().length;
  if (els["logistics-expense-selection"]) {
    els["logistics-expense-selection"].textContent = `${selectedCount} entrega${selectedCount === 1 ? "" : "s"} seleccionada${selectedCount === 1 ? "" : "s"}`;
  }
  autofillLogisticsPaymentDateFromAgreement();
}

function selectedLogisticsExpenseDeliveryIds() {
  return [...document.querySelectorAll("[data-logistics-expense-delivery]:checked")]
    .map((input) => backendId(input.dataset.logisticsExpenseDelivery))
    .filter(Boolean);
}

function logisticsSelectedExpenseDeliveries() {
  const selectedDeliveryIds = new Set(selectedLogisticsExpenseDeliveryIds());
  return commercialEntryData.entregas.filter((delivery) => selectedDeliveryIds.has(backendId(delivery.id_entrega)));
}

function logisticsSelectedExpenseCreditor() {
  const selectedDelivery = logisticsSelectedExpenseDeliveries()[0];
  const selectedFleetId = backendId(selectedDelivery?.id_flete);
  if (!selectedFleetId) return null;

  return commercialEntryData.acreedores.find((creditor) => {
    const creditorOriginType = normalizeCategory(creditor.origen_tipo_acreedor || creditor.origen_tipo || "");
    return creditorOriginType.includes("flete") && backendId(creditor.origen_id_acreedor || creditor.origen_id) === selectedFleetId;
  }) || null;
}

function paymentDaysFromAgreement(value) {
  const agreementText = String(value || "").trim();
  if (!agreementText) return null;
  if (normalizeCategory(agreementText).includes("contado")) return 0;

  const directDays = Number(agreementText.replace(",", "."));
  if (Number.isFinite(directDays)) return Math.max(0, Math.trunc(directDays));

  const daysMatch = agreementText.match(/-?\d+(?:[,.]\d+)?/);
  if (!daysMatch) return null;
  const parsedDays = Number(daysMatch[0].replace(",", "."));
  return Number.isFinite(parsedDays) ? Math.max(0, Math.trunc(parsedDays)) : null;
}

function autofillLogisticsPaymentDateFromAgreement({ force = false } = {}) {
  const paymentInput = els["logistics-expense-payment-date"];
  const invoiceDateIso = parseDate(els["logistics-expense-invoice-date"]?.value);
  if (!paymentInput || !invoiceDateIso) return;

  const creditor = logisticsSelectedExpenseCreditor();
  const paymentDays = paymentDaysFromAgreement(creditor?.acuerdo_de_pago || creditor?.acuerda_de_pago || creditor?.acuerdo_pago);
  if (paymentDays === null) return;

  const canUpdate = force || !paymentInput.value || paymentInput.dataset.autoAgreement === "true";
  if (!canUpdate) return;

  paymentInput.value = toIsoDate(addDays(new Date(`${invoiceDateIso}T00:00:00`), paymentDays));
  paymentInput.dataset.autoAgreement = "true";
}

function updateLogisticsExpenseTotalFromInputs() {
  [
    "logistics-expense-subtotal",
    "logistics-expense-iva",
    "logistics-expense-vat-retention",
    "logistics-expense-iibb-retention",
    "logistics-expense-internal-taxes"
  ].forEach((id) => {
    const input = els[id];
    if (input && document.activeElement === input) input.dataset.touched = "true";
  });

  const total = [
    "logistics-expense-subtotal",
    "logistics-expense-iva",
    "logistics-expense-vat-retention",
    "logistics-expense-iibb-retention",
    "logistics-expense-internal-taxes"
  ].reduce((sum, id) => sum + entryNumberValue(id), 0);
  if (els["logistics-expense-total"]) els["logistics-expense-total"].value = roundToDecimals(total, 2);
}

function updateLogisticsFileName() {
  const file = els["logistics-file"]?.files?.[0];
  if (els["logistics-file-chip"]) els["logistics-file-chip"].classList.toggle("is-empty", !file);
  if (els["logistics-file-name"]) els["logistics-file-name"].textContent = file ? file.name : "Sin archivo";
  if (els["logistics-file-size"]) els["logistics-file-size"].textContent = file ? formatFileSize(file.size) : "-";
}

function setupLogisticsFileDropZone() {
  setupFileDropZone({
    dropZone: els["logistics-file-drop-zone"],
    input: els["logistics-file"],
    acceptFile: isReceptionReadableAttachment,
    respectDisabled: true,
    onAccepted: (file) => {
      updateLogisticsFileName();
      setCommercialStatus("logistics-expense-status", `Factura/remito listo: ${file.name}. Para completar el egreso, presiona Leer factura.`, "success");
    },
    onRejected: () => setCommercialStatus("logistics-expense-status", "Arrastra una imagen o PDF valido de factura/remito.", "error")
  });
}

function clearLogisticsFile() {
  if (els["logistics-file"]) els["logistics-file"].value = "";
  updateLogisticsFileName();
  setCommercialStatus("logistics-expense-status", "", "");
}

function updateLogisticsWithoutFile() {
  const withoutFile = Boolean(els["logistics-without-file"]?.checked);
  if (els["logistics-file"]) {
    els["logistics-file"].disabled = withoutFile;
    if (withoutFile) els["logistics-file"].value = "";
  }
  updateLogisticsFileName();
  if (withoutFile) {
    autofillLogisticsExpenseWithoutFile();
    setCommercialStatus("logistics-expense-status", "Sin remito ni factura: se completo como Remito X. Revisa los importes antes de guardar.", "pending");
  }
}

async function autofillLogisticsExpenseWithoutFile({ keepInvoiceNumber = false } = {}) {
  if (els["logistics-expense-invoice-type"]) els["logistics-expense-invoice-type"].value = "Remito_X";
  if (!keepInvoiceNumber && els["logistics-expense-invoice-number"]) {
    await setAutomaticLogisticsInvoiceNumber();
  }
  const today = toIsoDate(new Date());
  if (els["logistics-expense-invoice-date"] && !els["logistics-expense-invoice-date"].value) els["logistics-expense-invoice-date"].value = today;
  autofillLogisticsPaymentDateFromAgreement();
  if (els["logistics-expense-payment-date"] && !els["logistics-expense-payment-date"].value) els["logistics-expense-payment-date"].value = today;
  setLogisticsExpenseReferenceLabels("-", "-", "-");
}

async function setAutomaticLogisticsInvoiceNumber() {
  const input = els["logistics-expense-invoice-number"];
  if (!input) return;
  input.value = "Calculando nro...";
  try {
    input.value = await nextBackendPrimaryId("egresos", "id_egreso");
  } catch {
    input.value = "";
    setCommercialStatus("logistics-expense-status", "No se pudo calcular el nro automatico del remito. Completalo manualmente.", "error");
  }
}

function setLogisticsExpenseReferenceLabels(subtotal = "-", iva = "-", total = "-") {
  if (els["logistics-expense-subtotal-ref"]) els["logistics-expense-subtotal-ref"].textContent = subtotal;
  if (els["logistics-expense-iva-ref"]) els["logistics-expense-iva-ref"].textContent = iva;
  if (els["logistics-expense-total-ref"]) els["logistics-expense-total-ref"].textContent = total;
}

async function autofillLogisticsExpenseFromAttachment() {
  const selectedDeliveryIds = selectedLogisticsExpenseDeliveryIds();
  const file = els["logistics-file"]?.files?.[0];
  if (!selectedDeliveryIds.length) {
    setCommercialStatus("logistics-expense-status", "Primero selecciona al menos una entrega.", "error");
    return;
  }
  if (els["logistics-without-file"]?.checked) {
    setCommercialStatus("logistics-expense-status", "Desmarca Sin remito ni factura para leer un archivo.", "error");
    return;
  }
  if (!file) {
    setCommercialStatus("logistics-expense-status", "Adjunta una factura o remito antes de leer.", "error");
    return;
  }
  if (!isReceptionReadableAttachment(file)) {
    setCommercialStatus("logistics-expense-status", "Adjunta una imagen o PDF valido de factura/remito.", "error");
    return;
  }

  const requestId = logisticsInvoiceReadRequestId + 1;
  logisticsInvoiceReadRequestId = requestId;
  setCommercialStatus("logistics-expense-status", "Leyendo factura/remito para precargar egreso logistico...", "pending");
  try {
    const fileDataUrl = await receptionAttachmentToDataUrl(file);
    const response = await fetch(`${API_BASE_URL}/api/reception-invoice/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileDataUrl,
        fileName: file.name,
        mimeType: file.type
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (requestId !== logisticsInvoiceReadRequestId) return;
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    applyLogisticsInvoiceRead(payload.invoice || {});
    setCommercialStatus("logistics-expense-status", "Factura/remito leido. Revisa y corrige los datos antes de guardar.", "success");
  } catch (error) {
    setCommercialStatus("logistics-expense-status", `No se pudo leer automaticamente: ${error.message}. Completa o corrige los datos manualmente.`, "error");
  }
}

function applyLogisticsInvoiceRead(invoice) {
  const type = normalizeReceptionInvoiceType(invoice.tipo_factura || invoice.invoiceType);
  if (type && els["logistics-expense-invoice-type"]) els["logistics-expense-invoice-type"].value = type;
  if (invoice.nro_factura || invoice.invoiceNumber) els["logistics-expense-invoice-number"].value = String(invoice.nro_factura || invoice.invoiceNumber).trim();
  if (invoice.fecha_factura || invoice.invoiceDate) {
    els["logistics-expense-invoice-date"].value = parseDate(invoice.fecha_factura || invoice.invoiceDate) || els["logistics-expense-invoice-date"].value;
  }
  [
    ["logistics-expense-subtotal", invoice.subtotal],
    ["logistics-expense-iva", invoice.iva],
    ["logistics-expense-vat-retention", invoice.per_ret_iva],
    ["logistics-expense-iibb-retention", invoice.per_ret_iibb],
    ["logistics-expense-internal-taxes", invoice.imp_internos],
    ["logistics-expense-total", invoice.total]
  ].forEach(([id, value]) => {
    const number = parseMoney(value);
    if (els[id] && Number.isFinite(number) && number > 0) {
      els[id].value = decimalPurchaseDisplay(number);
      els[id].dataset.touched = "true";
    }
  });
  setLogisticsExpenseReferenceLabels("-", "-", "-");
  autofillLogisticsPaymentDateFromAgreement();
  updateLogisticsExpenseTotalFromInputs();
}

function renderSalesEntry() {
  const allPendingRows = pendingSalesRows();
  fillPendingSalesClientOptions(allPendingRows);
  const selectedClientId = els["sales-client-filter"]?.value || "";
  const rows = (selectedClientId ? pendingSalesRows(selectedClientId) : [...allPendingRows])
    .sort((a, b) => selectedClientId
      ? String(a.sale.fecha_factura || "").localeCompare(String(b.sale.fecha_factura || ""))
      : clientName(a.sale.id_cliente).localeCompare(clientName(b.sale.id_cliente)) || String(a.sale.fecha_factura || "").localeCompare(String(b.sale.fecha_factura || "")));
  const body = els["sales-pending-body"];
  const total = rows.reduce((acc, row) => acc + row.balance, 0);

  if (els["sales-client-debt-total"]) els["sales-client-debt-total"].textContent = formatMoney(total);
  if (els["sales-client-debt-count"]) els["sales-client-debt-count"].textContent = String(rows.length);
  if (!body) return;

  body.innerHTML = rows.length ? rows.map((row) => `
    <tr>
      <td>${escapeHtml(clientName(row.sale.id_cliente))}</td>
      <td>${escapeHtml(row.sale.nro_factura || row.sale.id_venta || "-")}</td>
      <td>${formatDate(row.sale.fecha_factura)}</td>
      <td class="num">${formatMoney(row.total)}</td>
      <td class="num muted-cell">${formatMoney(row.paid)}</td>
      <td class="num debt-balance">${formatMoney(row.balance)}</td>
    </tr>
  `).join("") : `<tr><td class="empty" colspan="6">No hay ventas pendientes.</td></tr>`;
}

function fillPendingSalesClientOptions(pendingRows) {
  const select = els["sales-client-filter"];
  if (!select) return;
  const current = select.value;
  const clientIdsWithDebt = new Set(pendingRows.map((row) => backendId(row.sale.id_cliente)));
  const debtClients = commercialEntryData.clientes
    .filter((client) => clientIdsWithDebt.has(backendId(client.id_cliente)))
    .sort((a, b) => displayNameLabel(a.nombre_cliente || a.nombre).localeCompare(displayNameLabel(b.nombre_cliente || b.nombre)));
  const options = debtClients.map((client) => {
    const value = backendId(client.id_cliente);
    return `<option value="${escapeHtml(value)}">${escapeHtml(displayNameLabel(client.nombre_cliente || client.nombre || value))}</option>`;
  }).join("");
  select.innerHTML = `<option value="">Todos los clientes</option>${options}`;
  select.value = clientIdsWithDebt.has(backendId(current)) ? current : "";
}

function renderCollectionsEntry() {
  fillCollectionClientOptions(pendingSalesRows());
  if (els["collection-date"] && !els["collection-date"].value) els["collection-date"].value = toIsoDate(new Date());

  const clientId = els["collection-client"]?.value || "";
  const rows = clientId ? pendingSalesRows(clientId) : [];
  const body = els["collections-invoice-body"];
  if (!body) return;

  body.innerHTML = rows.length ? rows.map((row) => `
    <tr data-collection-sale="${escapeHtml(row.sale.id_venta)}">
      <td><input type="checkbox" data-collection-select></td>
      <td>${escapeHtml(row.sale.nro_factura || row.sale.id_venta || "-")}</td>
      <td>${formatDate(row.sale.fecha_factura)}</td>
      <td class="num">${formatBankMoney(row.balance)}</td>
      <td><input type="checkbox" data-collection-full checked></td>
      <td><input type="number" min="0" step="0.01" data-collection-amount value="${roundToDecimals(row.balance, 2).toFixed(2)}"></td>
    </tr>
  `).join("") : `<tr><td class="empty" colspan="6">Este cliente no tiene facturas pendientes.</td></tr>`;
  updateCollectionTotal();
}

function fillCollectionClientOptions(pendingRows) {
  const select = els["collection-client"];
  if (!select) return;

  const current = select.value;
  const clientIdsWithDebt = new Set(pendingRows.map((row) => backendId(row.sale.id_cliente)));
  const debtClients = commercialEntryData.clientes
    .filter((client) => clientIdsWithDebt.has(backendId(client.id_cliente)))
    .sort((left, right) => {
      return displayNameLabel(left.nombre_cliente || left.nombre)
        .localeCompare(displayNameLabel(right.nombre_cliente || right.nombre));
    });

  const options = debtClients.map((client) => {
    const value = backendId(client.id_cliente);
    const label = displayNameLabel(client.nombre_cliente || client.nombre || value);
    return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
  }).join("");

  select.innerHTML = `<option value="">Elegir cliente con saldo</option>${options}`;
  select.value = clientIdsWithDebt.has(backendId(current)) ? current : "";
}

function renderCommissionsEntry() {
  fillCommissionChannelOptions();
  ensureCommissionMonthFilter();

  const body = els["commissions-collection-body"];
  if (!body) return;

  const rows = commissionRowsForSelectedPeriod();
  const visibleCollectionIds = new Set(rows.map((row) => backendId(row.collection.id_cobro)));
  selectedCommissionCollectionIds = new Set(
    [...selectedCommissionCollectionIds].filter((collectionId) => visibleCollectionIds.has(collectionId))
  );
  const summary = rows.reduce((totals, row) => {
    totals.collections += 1;
    totals.commissionableSubtotal += row.commissionableSubtotal;
    totals.commission += row.commission;
    return totals;
  }, { collections: 0, commissionableSubtotal: 0, commission: 0 });

  if (els["commissions-summary-collections"]) els["commissions-summary-collections"].textContent = String(summary.collections);
  if (els["commissions-summary-subtotal"]) els["commissions-summary-subtotal"].textContent = formatMoney(summary.commissionableSubtotal);
  if (els["commissions-summary-commission"]) els["commissions-summary-commission"].textContent = formatMoney(summary.commission);
  setEntryStatus("commissions-status", rows.length ? "" : "No hay cobros comisionables para el mes y canal seleccionados.", rows.length ? "" : "pending");

  body.innerHTML = rows.length ? rows.map((row) => `
    <tr>
      <td><input type="checkbox" data-commission-collection-select="${escapeHtml(row.collection.id_cobro)}"${selectedCommissionCollectionIds.has(backendId(row.collection.id_cobro)) ? " checked" : ""} aria-label="Seleccionar cobro"></td>
      <td>${formatDate(row.collection.fecha_cobro)}</td>
      <td>${escapeHtml(row.clientName)}</td>
      <td>${escapeHtml(row.channelName)}</td>
      <td>${escapeHtml(row.invoiceLabels.join(", ") || "-")}</td>
      <td>${escapeHtml(displayNameLabel(row.collection.metodo || "-"))}</td>
      <td class="num">${formatMoney(row.collectedAmount)}</td>
      <td class="num">${formatMoney(row.commissionableSubtotal)}</td>
      <td class="num">${formatCommissionRate(row.commissionRate)}</td>
      <td class="num">${formatMoney(row.commission)}</td>
    </tr>
  `).join("") : `<tr><td class="empty" colspan="10">No hay cobros comisionables para el mes y canal seleccionados.</td></tr>`;
  updateCommissionExpenseDraft();
}

function fillCommissionChannelOptions() {
  const select = els["commissions-channel-filter"];
  if (!select) return;

  const current = select.value;
  const channels = [...commercialEntryData.canales]
    .sort((left, right) => displayNameLabel(left.nombre).localeCompare(displayNameLabel(right.nombre)));
  select.innerHTML = `<option value="">Todos los canales</option>${channels.map((channel) => {
    const value = backendId(channel.id_canal);
    const rate = parseCommissionRate(channel.comision);
    const label = `${displayNameLabel(channel.nombre || value)} (${formatCommissionRate(rate)})`;
    return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
  }).join("")}`;
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function commissionRowsForSelectedPeriod() {
  const selectedChannelId = backendId(els["commissions-channel-filter"]?.value);
  const selectedMonth = selectedCommissionMonthKey();
  const clientsById = mapRowsById(commercialEntryData.clientes, "id_cliente");
  const salesById = mapRowsById(commercialEntryData.ventas, "id_venta");
  const channelsById = mapRowsById(commercialEntryData.canales, "id_canal");
  const detailsByCollectionId = groupRowsById(commercialEntryData.cobros_detalle, "id_cobro");

  return commercialEntryData.cobros
    .filter((collection) => {
      const date = parseDate(collection.fecha_cobro);
      return Boolean(date) && date.slice(0, 7) === selectedMonth;
    })
    .map((collection) => {
      const detailRows = detailsByCollectionId.get(backendId(collection.id_cobro)) || [];
      const saleCalculations = detailRows.map((detail) => {
        const sale = salesById.get(backendId(detail.id_venta));
        if (!sale) return null;
        const client = clientsById.get(backendId(sale.id_cliente || collection.id_cliente));
        const channel = channelsById.get(backendId(client?.id_canal));
        const channelId = backendId(channel?.id_canal);
        if (selectedChannelId && channelId !== selectedChannelId) return null;
        const total = parseMoney(sale.total);
        const subtotal = parseMoney(sale.subtotal);
        const paidAmount = parseMoney(detail.monto_cancelado);
        const paidRatio = total > 0 ? Math.max(0, Math.min(1, paidAmount / total)) : 0;
        const commissionRate = parseCommissionRate(channel?.comision);

        /*
          Comision economica:
          se paga sobre el subtotal proporcionalmente cobrado. Si el cliente paga
          una parte de una factura con IVA, esa misma proporcion aplica al subtotal.
        */
        const commissionableSubtotal = subtotal * paidRatio;
        return {
          sale,
          client,
          channel,
          paidAmount,
          commissionRate,
          commissionableSubtotal,
          commission: commissionableSubtotal * commissionRate
        };
      }).filter(Boolean);

      if (!saleCalculations.length) return null;
      const firstSale = saleCalculations[0];
      const mixedChannels = new Set(saleCalculations.map((row) => backendId(row.channel?.id_canal))).size > 1;
      const invoiceLabels = saleCalculations.map((row) => row.sale.nro_factura || row.sale.id_venta || "-");
      const commissionableSubtotal = sum(saleCalculations, "commissionableSubtotal");
      const commission = sum(saleCalculations, "commission");
      const collectedAmount = sum(saleCalculations, "paidAmount");
      const weightedRate = commissionableSubtotal ? commission / commissionableSubtotal : 0;

      return {
        collection,
        clientName: clientNameFromMap(collection.id_cliente || firstSale.sale.id_cliente, clientsById),
        channelName: mixedChannels ? "Varios canales" : displayNameLabel(firstSale.channel?.nombre || "Sin canal"),
        invoiceLabels,
        collectedAmount,
        commissionableSubtotal,
        commissionRate: weightedRate,
        commission,
        saleCalculations
      };
    })
    .filter(Boolean)
    .sort((left, right) => String(left.collection.fecha_cobro || "").localeCompare(String(right.collection.fecha_cobro || "")));
}

function ensureCommissionMonthFilter() {
  const input = els["commissions-month-filter"];
  if (!input || input.value) return;
  input.value = `${state.selectedYear}-${String(state.selectedMonth + 1).padStart(2, "0")}`;
}

function selectedCommissionMonthKey() {
  ensureCommissionMonthFilter();
  return String(els["commissions-month-filter"]?.value || "");
}

function selectedCommissionExpenseRows() {
  const selectedIds = new Set([...selectedCommissionCollectionIds].map(comparableLookupId));
  return commissionRowsForSelectedPeriod().filter((row) => selectedIds.has(comparableLookupId(row.collection.id_cobro)));
}

function commissionSelectedChannelId(rows) {
  const channelIds = new Set();
  rows.forEach((row) => row.saleCalculations.forEach((saleRow) => {
    const channelId = backendId(saleRow.channel?.id_canal);
    if (channelId) channelIds.add(channelId);
  }));
  return channelIds.size === 1 ? [...channelIds][0] : "";
}

function commissionCreditorTagForChannel(channelId) {
  const creditor = commercialEntryData.acreedores.find((row) => (
    normalizeCategory(row.origen_tipo_acreedor || row.origen_tipo || "").includes("canal")
    && comparableLookupId(row.origen_id_acreedor || row.origen_id) === comparableLookupId(channelId)
  ));
  if (!creditor) return null;

  const creditorTag = commercialEntryData.acreedores_etiquetas
    .filter((row) => comparableLookupId(row.id_acreedor) === comparableLookupId(creditor.id_acreedor))
    .sort((left, right) => Number(left.id_acreedor_etiqueta || 0) - Number(right.id_acreedor_etiqueta || 0))[0];
  return creditorTag ? { creditor, creditorTag } : null;
}

function updateCommissionExpenseDraft() {
  const rows = selectedCommissionExpenseRows();
  const selection = els["commissions-expense-selection"];
  if (selection) selection.textContent = `${rows.length} cobro${rows.length === 1 ? "" : "s"} seleccionado${rows.length === 1 ? "" : "s"}`;

  if (!rows.length) {
    updateCommissionExpenseTotal();
    return;
  }

  const subtotal = sum(rows, "commission");
  const subtotalInput = els["commissions-expense-subtotal"];
  if (subtotalInput && subtotalInput.dataset.touched !== "true") {
    subtotalInput.value = roundToDecimals(subtotal, 2);
  }

  const latestCollectionDate = rows.reduce((latest, row) => (
    String(row.collection.fecha_cobro || "") > latest ? String(row.collection.fecha_cobro || "") : latest
  ), "");
  if (els["commissions-expense-invoice-date"] && !els["commissions-expense-invoice-date"].value) {
    els["commissions-expense-invoice-date"].value = latestCollectionDate || toIsoDate(new Date());
  }

  const invoiceType = backendId(els["commissions-expense-invoice-type"]?.value);
  const ivaInput = els["commissions-expense-iva"];
  if (ivaInput && ivaInput.dataset.touched !== "true") {
    ivaInput.value = invoiceType === "Factura_A" ? roundToDecimals(entryNumberValue("commissions-expense-subtotal") * 0.21, 2) : "0";
  }
  updateCommissionExpenseTotal();
}

function updateCommissionExpenseTotal() {
  const totalInput = els["commissions-expense-total"];
  if (!totalInput || totalInput.dataset.touched === "true") return;
  const total = [
    "commissions-expense-subtotal",
    "commissions-expense-iva",
    "commissions-expense-vat-retention",
    "commissions-expense-iibb-retention",
    "commissions-expense-internal-taxes"
  ].reduce((sum, id) => sum + entryNumberValue(id), 0);
  totalInput.value = total ? roundToDecimals(total, 2) : "";
}

async function submitCommissionExpenseEntry(event) {
  event.preventDefault();
  const rows = selectedCommissionExpenseRows();
  const channelId = commissionSelectedChannelId(rows);
  const relation = commissionCreditorTagForChannel(channelId);
  const invoiceType = backendId(els["commissions-expense-invoice-type"]?.value);
  const invoiceNumber = backendId(els["commissions-expense-invoice-number"]?.value);
  const invoiceDate = parseDate(els["commissions-expense-invoice-date"]?.value);
  const total = entryNumberValue("commissions-expense-total");

  if (!rows.length || !channelId) {
    setCommercialStatus("commissions-expense-status", "Selecciona cobros de un unico canal para generar el egreso.", "error");
    return;
  }
  if (!relation) {
    setCommercialStatus("commissions-expense-status", "El canal seleccionado no tiene acreedor y etiqueta configurados.", "error");
    return;
  }
  if (!invoiceType || !invoiceNumber || !invoiceDate || total <= 0) {
    setCommercialStatus("commissions-expense-status", "Completa tipo, numero, fecha y total del egreso.", "error");
    return;
  }

  const button = event.submitter || els["commissions-expense-submit"];
  setCommercialButtonLoading(button, true, "Guardando...");
  setCommercialStatus("commissions-expense-status", "Guardando comisiones y egreso...", "pending");

  try {
    const [expenseId, commissionStartId] = await Promise.all([
      nextBackendPrimaryId("egresos", "id_egreso"),
      nextBackendPrimaryIdOrOne("comisiones", "id_comision")
    ]);
    const labelId = await tagIdFromCreditorTagId(relation.creditorTag.id_acreedor_etiqueta);
    const commissionRows = rows.flatMap((row) => row.saleCalculations.map((saleRow) => ({
      fecha: row.collection.fecha_cobro,
      id_canal: channelId,
      id_acreedor_etiqueta: relation.creditorTag.id_acreedor_etiqueta,
      id_egreso: String(expenseId),
      id_venta: saleRow.sale.id_venta,
      subtotal: roundToDecimals(saleRow.commissionableSubtotal, 2),
      comision: roundToDecimals(saleRow.commission, 2)
    }))).map((row, index) => ({ ...row, id_comision: String(Number(commissionStartId) + index) }));

    await saveBackendEntryRows("egresos", [{
      id_egreso: String(expenseId),
      fecha_factura: invoiceDate,
      fecha_prevista_pago: parseDate(els["commissions-expense-payment-date"]?.value) || invoiceDate,
      id_etiqueta: labelId,
      tipo_factura: invoiceType,
      nro_factura: invoiceNumber,
      iva: entryNumberValue("commissions-expense-iva"),
      per_ret_iva: entryNumberValue("commissions-expense-vat-retention"),
      per_ret_iibb: entryNumberValue("commissions-expense-iibb-retention"),
      imp_internos: entryNumberValue("commissions-expense-internal-taxes"),
      subtotal: entryNumberValue("commissions-expense-subtotal"),
      total
    }]);
    await saveBackendEntryRows("comisiones", commissionRows);

    selectedCommissionCollectionIds = new Set();
    event.target.reset();
    [
      "commissions-expense-subtotal",
      "commissions-expense-iva",
      "commissions-expense-vat-retention",
      "commissions-expense-iibb-retention",
      "commissions-expense-internal-taxes",
      "commissions-expense-total"
    ].forEach((id) => {
      delete els[id]?.dataset.touched;
    });
    if (els["commissions-expense-invoice-type"]) els["commissions-expense-invoice-type"].value = "Factura_C";
    commercialEntryData.loaded = false;
    await loadCommercialEntryData(true);
    setCommercialStatus("commissions-expense-status", `Egreso de comisiones #${expenseId} guardado y asociado a ${rows.length} cobro(s).`, "success");
  } catch (error) {
    setCommercialStatus("commissions-expense-status", `No se pudo guardar el egreso de comisiones: ${error.message}`, "error");
  } finally {
    setCommercialButtonLoading(button, false);
  }
}

function parseCommissionRate(value) {
  const rate = parseMoney(value);
  return rate > 1 ? rate / 100 : rate;
}

function formatCommissionRate(value) {
  return new Intl.NumberFormat("es-AR", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(value || 0);
}

function renderReceivedCheckEntry() {
  const body = els["received-check-pending-body"];
  if (!body) return;

  const existingCheckCollectionIds = new Set(commercialEntryData.cheques_recibidos.map((check) => backendId(check.id_cobro)).filter(Boolean));
  const pendingChecks = commercialEntryData.cobros
    .filter((collection) => isCheckCollectionMethod(collection.metodo) && !existingCheckCollectionIds.has(backendId(collection.id_cobro)))
    .sort((a, b) => String(a.fecha_cobro || "").localeCompare(String(b.fecha_cobro || "")));

  if (els["received-check-count"]) els["received-check-count"].textContent = `${pendingChecks.length} cobro${pendingChecks.length === 1 ? "" : "s"}`;
  body.innerHTML = pendingChecks.length ? pendingChecks.map((collection) => `
    <tr>
      <td>${formatDate(collection.fecha_cobro)}</td>
      <td>${escapeHtml(clientName(collection.id_cliente))}</td>
      <td>${escapeHtml(displayNameLabel(collection.metodo || "Cheque"))}</td>
      <td class="num">${formatMoney(parseMoney(collection.monto))}</td>
      <td>${escapeHtml(collection.banco || "-")}</td>
      <td><button type="button" data-create-received-check="${escapeHtml(collection.id_cobro)}">Cargar cheque</button></td>
    </tr>
  `).join("") : `<tr><td class="empty" colspan="6">No hay cobros con cheque pendientes.</td></tr>`;
}

function isCheckCollectionMethod(value) {
  const method = normalizeCategory(value);
  return method.includes("cheque") || method.includes("echeq") || method.includes("e cheque");
}

function openReceivedCheckDraft(collectionId) {
  const collection = commercialEntryData.cobros.find((row) => backendId(row.id_cobro) === backendId(collectionId));
  if (!collection) return;
  const receivedDate = collection.fecha_cobro || toIsoDate(new Date());
  if (els["received-check-collection-id"]) els["received-check-collection-id"].value = collection.id_cobro || "";
  if (els["received-check-client-id"]) els["received-check-client-id"].value = collection.id_cliente || "";
  if (els["received-check-collection-label"]) els["received-check-collection-label"].value = `Cobro ${collection.id_cobro} - ${formatDate(receivedDate)}`;
  if (els["received-check-client-name"]) els["received-check-client-name"].value = displayNameLabel(clientName(collection.id_cliente));
  if (els["received-check-amount"]) els["received-check-amount"].value = roundToDecimals(parseMoney(collection.monto), 2);
  if (els["received-check-number"]) els["received-check-number"].value = "";
  if (els["received-check-received-date"]) els["received-check-received-date"].value = receivedDate;
  if (els["received-check-use-date"]) els["received-check-use-date"].value = receivedDate;
  if (els["received-check-bank"]) els["received-check-bank"].value = collection.banco || "";
  if (els["received-check-state"]) els["received-check-state"].value = "Pendiente";
  setCommercialStatus("received-check-status", "Completa el numero y la fecha de uso del cheque.", "pending");
  els["received-check-number"]?.focus();
}

async function submitReceivedCheckEntry(event) {
  event.preventDefault();
  const collectionId = String(els["received-check-collection-id"]?.value || "").trim();
  const clientId = String(els["received-check-client-id"]?.value || "").trim();
  const checkNumber = String(els["received-check-number"]?.value || "").trim();
  const receivedDate = String(els["received-check-received-date"]?.value || "").trim();
  const useDate = String(els["received-check-use-date"]?.value || "").trim();
  const amount = entryNumberValue("received-check-amount");

  if (!collectionId || !checkNumber || !receivedDate || !useDate || amount <= 0) {
    setCommercialStatus("received-check-status", "Selecciona un cobro pendiente y completa numero, fechas y monto del cheque.", "error");
    return;
  }

  const button = els["received-check-submit"];
  const originalText = button?.textContent || "Guardar cheque recibido";
  if (button) {
    button.disabled = true;
    button.textContent = "Guardando...";
  }
  setCommercialStatus("received-check-status", "Guardando cheque recibido...", "pending");

  try {
    const checkId = await nextBackendPrimaryId("cheques_recibidos", "id_cheque_recibido");
    await saveBackendEntryRows("cheques_recibidos", [{
      id_cheque_recibido: checkId,
      id_cobro: collectionId,
      fecha_entregado: receivedDate,
      monto: amount,
      cliente: clientName(clientId),
      id_cliente: clientId,
      nro_cheque: checkNumber,
      fecha_uso: useDate,
      estado: "Pendiente",
      banco: String(els["received-check-bank"]?.value || "").trim()
    }]);

    commercialEntryData.loaded = false;
    await loadCommercialEntryData(true);
    els["received-check-form"]?.reset();
    setCommercialStatus("received-check-status", `Cheque ${checkId} asociado al cobro ${collectionId}.`, "success");
  } catch (error) {
    setCommercialStatus("received-check-status", error.message || "No se pudo guardar el cheque recibido.", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function fillSelectOptions(select, rows, valueColumn, labelColumn, emptyLabel) {
  if (!select) return;
  const current = select.value;
  const options = rows.map((row) => {
    const value = String(row[valueColumn] ?? "").trim();
    const label = displayNameLabel(row[labelColumn] || row.nombre || value);
    return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
  }).join("");
  select.innerHTML = emptyLabel ? `<option value="">${escapeHtml(emptyLabel)}</option>${options}` : options;
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function mapRowsById(rows, idColumn) {
  return new Map(rows.map((row) => [backendId(row[idColumn]), row]));
}

function groupRowsById(rows, idColumn) {
  return rows.reduce((groups, row) => {
    const id = backendId(row[idColumn]);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
    return groups;
  }, new Map());
}

function backendId(value) {
  return String(value ?? "").trim();
}

function clientName(clientId) {
  const client = mapRowsById(commercialEntryData.clientes, "id_cliente").get(backendId(clientId));
  return displayNameLabel(client?.nombre_cliente || client?.nombre || clientId || "Sin cliente");
}

function clientNameFromMap(clientId, clientsById) {
  const client = clientsById.get(backendId(clientId));
  return displayNameLabel(client?.nombre_cliente || client?.nombre || clientId || "Sin cliente");
}

function salePaidAmounts() {
  return commercialEntryData.cobros_detalle.reduce((amounts, row) => {
    const saleId = backendId(row.id_venta);
    amounts.set(saleId, (amounts.get(saleId) || 0) + parseMoney(row.monto_cancelado));
    return amounts;
  }, new Map());
}

function pendingSalesRows(clientId = "") {
  const paidAmounts = salePaidAmounts();
  const selectedClient = backendId(clientId);
  return commercialEntryData.ventas
    .map((sale) => {
      const total = parseMoney(sale.total);
      const paid = paidAmounts.get(backendId(sale.id_venta)) || 0;
      return { sale, total, paid, balance: Math.max(0, total - paid) };
    })
    .filter((row) => row.balance > 0.01 && (!selectedClient || backendId(row.sale.id_cliente) === selectedClient))
    .sort((a, b) => String(a.sale.fecha_factura || "").localeCompare(String(b.sale.fecha_factura || "")));
}

async function submitOrderEntry(event) {
  event.preventDefault();
  const button = event.submitter;
  setCommercialButtonLoading(button, true, "Guardando...");
  setCommercialStatus("orders-status", "Guardando pedido...", "pending");

  try {
    const [orderId, detailId] = await Promise.all([
      nextBackendPrimaryId("pedidos", "id_pedido"),
      nextBackendPrimaryId("detalle_pedidos", "id_detalle_pedido")
    ]);
    const deliveryDate = els["order-delivery-date"]?.value || "";
    await saveBackendEntryRows("pedidos", [{
      id_pedido: orderId,
      fecha_pedido: els["order-date"]?.value || "",
      id_cliente: els["order-client"]?.value || "",
      fecha_entrega: deliveryDate,
      fecha_original: els["order-original-date"]?.value || deliveryDate
    }]);
    await saveBackendEntryRows("detalle_pedidos", [{
      id_detalle_pedido: detailId,
      id_pedido: orderId,
      id_producto: els["order-product"]?.value || "",
      cantidad_cajas: parseMoney(els["order-boxes"]?.value),
      impuesto: els["order-tax"]?.value || "A",
      precio_ud: parseMoney(els["order-unit-price"]?.value),
      bonificacion: parseMoney(els["order-discount"]?.value)
    }]);
    setCommercialStatus("orders-status", `Pedido #${orderId} guardado.`, "success");
    event.target.reset();
    resetLogisticsExpenseFormState();
    commercialEntryData.loaded = false;
    await loadCommercialEntryData(true);
  } catch (error) {
    setCommercialStatus("orders-status", `No se pudo guardar el pedido: ${error.message}`, "error");
  } finally {
    setCommercialButtonLoading(button, false);
  }
}

async function createDeliveryForSelectedOrders() {
  const selectedOrderIds = selectedLogisticsOrderIds();
  const fleetId = els["logistics-delivery-fleet"]?.value || "";
  const deliveryDate = els["logistics-delivery-date"]?.value || toIsoDate(new Date());
  if (!selectedOrderIds.length) {
    setCommercialStatus("logistics-status", "Selecciona al menos un pedido para crear la entrega.", "error");
    return;
  }
  if (!fleetId) {
    setCommercialStatus("logistics-status", "Selecciona el flete de la entrega.", "error");
    return;
  }
  const button = els["logistics-delivery-create"];
  setCommercialButtonLoading(button, true, "Creando...");
  setCommercialStatus("logistics-status", "Creando entrega...", "pending");

  try {
    const deliveryId = await nextBackendPrimaryId("entregas", "id_entrega");
    const firstDetailId = await nextBackendPrimaryId("entregas_detalle", "id_entregas_detalle");
    const deliveryDetails = selectedOrderIds.map((orderId, index) => ({
      id_entregas_detalle: Number(firstDetailId) + index,
      id_entrega: deliveryId,
      id_pedido: orderId
    }));
    await saveBackendEntryRows("entregas", [{ id_entrega: deliveryId, fecha: deliveryDate, id_flete: fleetId }]);
    await saveBackendEntryRows("entregas_detalle", deliveryDetails);
    setCommercialStatus("logistics-status", `Entrega #${deliveryId} creada con ${selectedOrderIds.length} pedido(s).`, "success");
    commercialEntryData.loaded = false;
    await loadCommercialEntryData(true);
  } catch (error) {
    setCommercialStatus("logistics-status", `No se pudo crear la entrega: ${error.message}`, "error");
  } finally {
    setCommercialButtonLoading(button, false);
  }
}

async function submitLogisticsExpenseEntry(event) {
  event.preventDefault();
  const selectedDeliveryIds = selectedLogisticsExpenseDeliveryIds();
  if (!selectedDeliveryIds.length) {
    setCommercialStatus("logistics-expense-status", "Selecciona al menos una entrega para asociar al egreso.", "error");
    return;
  }

  const invoiceType = backendId(els["logistics-expense-invoice-type"]?.value);
  const invoiceNumber = backendId(els["logistics-expense-invoice-number"]?.value);
  const invoiceDate = backendId(els["logistics-expense-invoice-date"]?.value);
  const total = entryNumberValue("logistics-expense-total");
  if (!invoiceType || !invoiceNumber || !invoiceDate || total <= 0) {
    setCommercialStatus("logistics-expense-status", "Completa tipo, numero, fecha y total del egreso.", "error");
    return;
  }

  const button = event.submitter || els["logistics-expense-submit"];
  setCommercialButtonLoading(button, true, "Guardando...");
  setCommercialStatus("logistics-expense-status", "Guardando egreso logistico...", "pending");

  try {
    const expenseId = await nextBackendPrimaryId("egresos", "id_egreso");
    const logisticsLabelId = logisticsExpenseLabelId();
    const selectedDeliveries = commercialEntryData.entregas.filter((delivery) => selectedDeliveryIds.includes(backendId(delivery.id_entrega)));

    await saveBackendEntryRows("egresos", [{
      id_egreso: expenseId,
      fecha_factura: invoiceDate,
      fecha_prevista_pago: backendId(els["logistics-expense-payment-date"]?.value) || invoiceDate,
      id_etiqueta: logisticsLabelId,
      tipo_factura: invoiceType,
      nro_factura: invoiceNumber,
      iva: entryNumberValue("logistics-expense-iva"),
      per_ret_iva: entryNumberValue("logistics-expense-vat-retention"),
      per_ret_iibb: entryNumberValue("logistics-expense-iibb-retention"),
      imp_internos: entryNumberValue("logistics-expense-internal-taxes"),
      subtotal: entryNumberValue("logistics-expense-subtotal"),
      total
    }]);

    await saveBackendEntryRows("entregas", selectedDeliveries.map((delivery) => ({
      ...delivery,
      id_egreso: expenseId
    })));

    event.target.reset();
    commercialEntryData.loaded = false;
    await loadCommercialEntryData(true);
    setCommercialStatus("logistics-expense-status", `Egreso logistico #${expenseId} guardado y asociado a ${selectedDeliveryIds.length} entrega(s).`, "success");
  } catch (error) {
    setCommercialStatus("logistics-expense-status", `No se pudo guardar el egreso logistico: ${error.message}`, "error");
  } finally {
    setCommercialButtonLoading(button, false);
  }
}

function resetLogisticsExpenseFormState() {
  if (els["logistics-file"]) els["logistics-file"].disabled = false;
  if (els["logistics-expense-payment-date"]) delete els["logistics-expense-payment-date"].dataset.autoAgreement;
  [
    "logistics-expense-subtotal",
    "logistics-expense-iva",
    "logistics-expense-vat-retention",
    "logistics-expense-iibb-retention",
    "logistics-expense-internal-taxes",
    "logistics-expense-total"
  ].forEach((id) => {
    if (els[id]) delete els[id].dataset.touched;
  });
  updateLogisticsFileName();
  setLogisticsExpenseReferenceLabels("-", "-", "-");
}

function logisticsExpenseLabelId() {
  const label = commercialEntryData.etiquetas.find((row) => normalizeCategory(row.etiqueta || row.nombre).includes("logistica"));
  return backendId(label?.id_etiqueta);
}

async function loadOtherExpenseEntryOptions(force = false) {
  if (otherExpenseEntryData.loaded && !force) {
    renderOtherExpenseEntryOptions();
    return;
  }

  try {
    const [otherCreditors, creditors, providers, employees, fleets, channels, creditorTags, labels, otherExpenses, expenses] = await Promise.all([
      backendTableRowsForEntry("otros_acreedores").catch(() => []),
      backendTableRowsForEntry("acreedores").catch(() => []),
      backendTableRowsForEntry("proveedores").catch(() => []),
      backendTableRowsForEntry("empleados").catch(() => []),
      backendTableRowsForEntry("fletes").catch(() => []),
      backendTableRowsForEntry("canales").catch(() => []),
      backendTableRowsForEntry("acreedores_etiquetas").catch(() => []),
      backendTableRowsForEntry("etiquetas").catch(() => []),
      backendTableRowsForEntry("otros_gastos").catch(() => []),
      backendTableRowsForEntry("egresos").catch(() => [])
    ]);
    otherExpenseEntryData = {
      loaded: true,
      otherCreditors,
      creditors,
      providers,
      employees,
      fleets,
      channels,
      creditorTags,
      labels,
      otherExpenses,
      expenses
    };
    renderOtherExpenseEntryOptions();
  } catch (error) {
    setCommercialStatus("other-expense-status", `No se pudieron cargar acreedores y etiquetas: ${error.message}`, "error");
  }
}

function renderOtherExpenseEntryOptions() {
  const search = els["other-expense-creditor-search"];
  const hidden = els["other-expense-creditor"];
  if (!search || !hidden) return;
  const currentCreditor = otherExpenseEntryData.creditors.find((creditor) => backendId(creditor.id_acreedor) === hidden.value);
  if (currentCreditor) search.value = otherExpenseCreditorLabel(currentCreditor);

  const today = toIsoDate(new Date());
  if (els["other-expense-date"] && !els["other-expense-date"].value) els["other-expense-date"].value = today;
  if (els["other-expense-invoice-date"] && !els["other-expense-invoice-date"].value) els["other-expense-invoice-date"].value = today;
  renderOtherExpenseInvoiceTypes();
  setAutomaticOtherExpenseInvoiceNumber();
  updateOtherExpenseCreditorTags();
  autofillOtherExpensePaymentDateFromAgreement();
}

function renderOtherExpenseInvoiceTypes() {
  const select = els["other-expense-invoice-type"];
  if (!select) return;

  const currentType = select.value;
  const expenseById = rowsByKey(otherExpenseEntryData.expenses, "id_egreso");
  const invoiceTypes = new Set(["Factura_A", "Factura_B", "Factura_C", "Remito_X"]);

  otherExpenseEntryData.otherExpenses.forEach((otherExpense) => {
    const directType = backendId(otherExpense.tipo_factura || otherExpense.tipo_de_factura);
    const linkedExpense = expenseById.get(backendId(otherExpense.id_egreso));
    const linkedType = backendId(linkedExpense?.tipo_factura);
    if (directType) invoiceTypes.add(directType);
    if (linkedType) invoiceTypes.add(linkedType);
  });

  select.innerHTML = [...invoiceTypes]
    .sort((left, right) => left.localeCompare(right, "es"))
    .map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(String(type).replace(/_/g, " "))}</option>`)
    .join("");
  select.value = invoiceTypes.has(currentType) ? currentType : "Factura_A";
}

function otherExpenseCreditorOptions() {
  const uniqueCreditors = new Map();
  otherExpenseEntryData.creditors.forEach((creditor) => {
    const creditorLabel = otherExpenseCreditorLabel(creditor);
    const creditorKey = normalizeSearchText(creditorLabel);
    if (creditorKey && !uniqueCreditors.has(creditorKey)) uniqueCreditors.set(creditorKey, creditor);
  });
  return [...uniqueCreditors.values()]
    .sort((left, right) => otherExpenseCreditorLabel(left).localeCompare(otherExpenseCreditorLabel(right)));
}

function renderOtherExpenseCreditorSuggestions(query = els["other-expense-creditor-search"]?.value || "") {
  const suggestions = els["other-expense-creditor-suggestions"];
  if (!suggestions) return;
  const normalizedQuery = normalizeSearchText(query);
  const matches = otherExpenseCreditorOptions()
    .filter((creditor) => normalizeSearchText(otherExpenseCreditorLabel(creditor)).includes(normalizedQuery))
    .slice(0, 50);
  suggestions.innerHTML = matches.map((creditor) => `
    <button type="button" role="option" data-creditor-id="${escapeHtml(backendId(creditor.id_acreedor))}">
      ${escapeHtml(otherExpenseCreditorLabel(creditor))}
    </button>
  `).join("");
  suggestions.hidden = matches.length === 0;
}

function selectOtherExpenseCreditor(creditor) {
  const search = els["other-expense-creditor-search"];
  const hidden = els["other-expense-creditor"];
  if (!search || !hidden) return;
  search.value = otherExpenseCreditorLabel(creditor);
  hidden.value = backendId(creditor.id_acreedor);
  els["other-expense-creditor-suggestions"].hidden = true;
  updateOtherExpenseCreditorTags();
  autofillOtherExpensePaymentDateFromAgreement({ force: true });
}

function otherExpenseCreditorLabel(creditor) {
  const originId = backendId(creditor?.origen_id_acreedor);
  const originType = normalizeSearchText(creditor?.origen_tipo_acreedor);
  const sourceRows = originType.includes("proveedor")
    ? otherExpenseEntryData.providers
    : originType.includes("empleado")
      ? otherExpenseEntryData.employees
      : originType.includes("flete")
        ? otherExpenseEntryData.fleets
        : originType.includes("canal")
          ? otherExpenseEntryData.channels
          : otherExpenseEntryData.otherCreditors;
  const source = sourceRows.find((row) => comparableLookupId(
    row.id_proveedor ?? row.id_empleado ?? row.id_flete ?? row.id_canal ?? row.id_otro_acreedor
  ) === comparableLookupId(originId));
  const otherCreditor = otherExpenseEntryData.otherCreditors.find((row) => (
    comparableLookupId(row.id_otro_acreedor) === comparableLookupId(originId)
  ));
  return displayNameLabel(
    source?.nombre_proveedor || source?.nombre_empleado || source?.nombre_flete || source?.nombre_canal || source?.nombre_otro_acreedor || source?.nombre
    || creditor?.nombre
    || otherCreditor?.nombre_otro_acreedor
    || otherCreditor?.nombre
    || `Acreedor ${creditor?.id_acreedor || ""}`
  );
}

function updateOtherExpenseCreditorTags() {
  const select = els["other-expense-creditor-tag"];
  if (!select) return;
  const creditorId = backendId(els["other-expense-creditor"]?.value);
  const labelById = rowsByKey(otherExpenseEntryData.labels, "id_etiqueta");
  const currentValue = select.value;
  const tags = otherExpenseEntryData.creditorTags
    .filter((relation) => comparableLookupId(relation.id_acreedor) === comparableLookupId(creditorId))
    .sort((left, right) => Number(left.id_acreedor_etiqueta || 0) - Number(right.id_acreedor_etiqueta || 0));

  select.innerHTML = `<option value="">Elegir etiqueta</option>${tags.map((relation) => {
    const label = labelById.get(backendId(relation.id_etiqueta));
    return `<option value="${escapeHtml(backendId(relation.id_acreedor_etiqueta))}">${escapeHtml(displayNameLabel(label?.etiqueta || label?.nombre || relation.id_etiqueta))}</option>`;
  }).join("")}`;
  if ([...select.options].some((option) => option.value === currentValue)) {
    select.value = currentValue;
  } else if (tags[0]) {
    select.value = backendId(tags[0].id_acreedor_etiqueta);
  }
}

function selectedOtherExpenseCreditor() {
  const creditorId = backendId(els["other-expense-creditor"]?.value);
  return otherExpenseEntryData.creditors.find((creditor) => (
    comparableLookupId(creditor.id_acreedor) === comparableLookupId(creditorId)
  )) || null;
}

function autofillOtherExpensePaymentDateFromAgreement({ force = false } = {}) {
  const paymentInput = els["other-expense-payment-date"];
  const invoiceDateIso = parseDate(els["other-expense-invoice-date"]?.value);
  if (!paymentInput || !invoiceDateIso) return;

  const creditor = selectedOtherExpenseCreditor();
  const paymentDays = paymentDaysFromAgreement(creditor?.acuerdo_de_pago || creditor?.acuerda_de_pago || creditor?.acuerdo_pago);
  if (paymentDays === null) return;

  const canUpdate = force || !paymentInput.value || paymentInput.dataset.autoAgreement === "true";
  if (!canUpdate) return;

  paymentInput.value = toIsoDate(addDays(new Date(`${invoiceDateIso}T00:00:00`), paymentDays));
  paymentInput.dataset.autoAgreement = "true";
}

async function setAutomaticOtherExpenseInvoiceNumber() {
  const input = els["other-expense-invoice-number"];
  if (!input) return;
  if (input.value && input.dataset.autoOtherExpenseId !== "true") return;
  input.value = "Calculando nro...";
  try {
    input.value = await nextBackendPrimaryId("otros_gastos", "id_otros_gastos");
    input.dataset.autoOtherExpenseId = "true";
  } catch {
    input.value = "";
    delete input.dataset.autoOtherExpenseId;
    setCommercialStatus("other-expense-status", "No se pudo calcular el nro automatico. Completalo manualmente.", "error");
  }
}

function updateOtherExpenseIvaFromSubtotal({ force = false } = {}) {
  const ivaInput = els["other-expense-iva"];
  if (!ivaInput) return;
  const shouldAutofill = force || ivaInput.dataset.touched !== "true";
  if (!shouldAutofill) return;

  const isInvoiceA = String(els["other-expense-invoice-type"]?.value || "") === "Factura_A";
  const subtotal = entryNumberValue("other-expense-subtotal");
  ivaInput.value = isInvoiceA && subtotal ? roundToDecimals(subtotal * 0.21, 2) : "0";
  ivaInput.dataset.autoIva = "true";
}

function updateOtherExpenseTotalFromInputs() {
  const totalInput = els["other-expense-total"];
  if (!totalInput || totalInput.dataset.touched === "true") return;
  const calculatedTotal = [
    "other-expense-subtotal",
    "other-expense-iva",
    "other-expense-vat-retention",
    "other-expense-iibb-retention",
    "other-expense-internal-taxes"
  ].reduce((sum, id) => sum + entryNumberValue(id), 0);
  totalInput.value = calculatedTotal ? roundToDecimals(calculatedTotal, 2) : "";
}

function updateOtherExpenseFileName() {
  const file = els["other-expense-file"]?.files?.[0];
  if (els["other-expense-file-chip"]) els["other-expense-file-chip"].classList.toggle("is-empty", !file);
  if (els["other-expense-file-name"]) els["other-expense-file-name"].textContent = file ? file.name : "Sin archivo";
  if (els["other-expense-file-size"]) els["other-expense-file-size"].textContent = file ? formatFileSize(file.size) : "-";
}

function setupOtherExpenseFileDropZone() {
  setupFileDropZone({
    dropZone: els["other-expense-file-drop-zone"],
    input: els["other-expense-file"],
    acceptFile: isReceptionReadableAttachment,
    onAccepted: (file) => {
      updateOtherExpenseFileName();
      setCommercialStatus("other-expense-status", `Factura/remito listo: ${file.name}. Para completar el egreso, presiona Leer factura.`, "success");
    },
    onRejected: () => setCommercialStatus("other-expense-status", "Arrastra una imagen o PDF valido de factura/remito.", "error")
  });
}

function clearOtherExpenseFile() {
  if (els["other-expense-file"]) els["other-expense-file"].value = "";
  updateOtherExpenseFileName();
  setCommercialStatus("other-expense-status", "", "");
}

async function autofillOtherExpenseFromAttachment() {
  const file = els["other-expense-file"]?.files?.[0];
  if (!file) {
    setCommercialStatus("other-expense-status", "Adjunta una factura o remito antes de leer.", "error");
    return;
  }
  if (!isReceptionReadableAttachment(file)) {
    setCommercialStatus("other-expense-status", "Adjunta una imagen o PDF valido de factura/remito.", "error");
    return;
  }

  const requestId = otherExpenseInvoiceReadRequestId + 1;
  otherExpenseInvoiceReadRequestId = requestId;
  setCommercialStatus("other-expense-status", "Leyendo factura/remito para precargar el egreso...", "pending");
  try {
    const fileDataUrl = await receptionAttachmentToDataUrl(file);
    const response = await fetch(`${API_BASE_URL}/api/reception-invoice/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileDataUrl,
        fileName: file.name,
        mimeType: file.type
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (requestId !== otherExpenseInvoiceReadRequestId) return;
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    applyOtherExpenseInvoiceRead(payload.invoice || {});
    setCommercialStatus("other-expense-status", "Factura/remito leido. Revisa y corrige los datos antes de guardar.", "success");
  } catch (error) {
    setCommercialStatus("other-expense-status", `No se pudo leer automaticamente: ${error.message}. Completa o corrige los datos manualmente.`, "error");
  }
}

function applyOtherExpenseInvoiceRead(invoice) {
  const type = normalizeReceptionInvoiceType(invoice.tipo_factura || invoice.invoiceType);
  if (type && els["other-expense-invoice-type"]) els["other-expense-invoice-type"].value = type;
  if (invoice.nro_factura || invoice.invoiceNumber) {
    els["other-expense-invoice-number"].value = String(invoice.nro_factura || invoice.invoiceNumber).trim();
    delete els["other-expense-invoice-number"].dataset.autoOtherExpenseId;
  }
  if (invoice.fecha_factura || invoice.invoiceDate) {
    els["other-expense-invoice-date"].value = parseDate(invoice.fecha_factura || invoice.invoiceDate) || els["other-expense-invoice-date"].value;
    autofillOtherExpensePaymentDateFromAgreement({ force: true });
  }
  [
    ["other-expense-subtotal", invoice.subtotal],
    ["other-expense-iva", invoice.iva],
    ["other-expense-vat-retention", invoice.per_ret_iva],
    ["other-expense-iibb-retention", invoice.per_ret_iibb],
    ["other-expense-internal-taxes", invoice.imp_internos],
    ["other-expense-total", invoice.total]
  ].forEach(([id, value]) => {
    const number = parseMoney(value);
    if (els[id] && Number.isFinite(number) && number > 0) {
      els[id].value = decimalPurchaseDisplay(number);
      els[id].dataset.touched = "true";
    }
  });
  if (!entryNumberValue("other-expense-iva")) updateOtherExpenseIvaFromSubtotal({ force: true });
  updateOtherExpenseTotalFromInputs();
}

async function submitOtherExpenseEntry(event) {
  event.preventDefault();
  const expenseDate = backendId(els["other-expense-date"]?.value);
  const creditorId = backendId(els["other-expense-creditor"]?.value);
  const creditorTagId = backendId(els["other-expense-creditor-tag"]?.value);
  const invoiceType = backendId(els["other-expense-invoice-type"]?.value);
  const invoiceNumber = backendId(els["other-expense-invoice-number"]?.value);
  const invoiceDate = backendId(els["other-expense-invoice-date"]?.value);
  const total = entryNumberValue("other-expense-total");
  const isNegativeIncome = Boolean(bankNegativeExpenseDraft) && total < 0;

  if (!expenseDate || !creditorId || !creditorTagId || !invoiceType || !invoiceNumber || !invoiceDate || (!isNegativeIncome && total <= 0)) {
    setCommercialStatus("other-expense-status", "Completa fecha, acreedor, etiqueta, factura y total.", "error");
    return;
  }

  const button = event.submitter || els["other-expense-submit"];
  setCommercialButtonLoading(button, true, "Guardando...");
  setCommercialStatus("other-expense-status", "Guardando otro gasto...", "pending");

  try {
    const [otherExpenseId, expenseId] = await Promise.all([
      nextBackendPrimaryId("otros_gastos", "id_otros_gastos"),
      nextBackendPrimaryId("egresos", "id_egreso")
    ]);
    const labelId = await tagIdFromCreditorTagId(creditorTagId);
    const effectiveInvoiceNumber = normalizeCategory(invoiceType).includes("remito") ? String(otherExpenseId) : invoiceNumber;

    await saveBackendEntryRows("egresos", [{
      id_egreso: expenseId,
      fecha_factura: invoiceDate,
      fecha_prevista_pago: backendId(els["other-expense-payment-date"]?.value) || invoiceDate,
      id_etiqueta: labelId,
      tipo_factura: invoiceType,
      nro_factura: effectiveInvoiceNumber,
      iva: entryNumberValue("other-expense-iva"),
      per_ret_iva: entryNumberValue("other-expense-vat-retention"),
      per_ret_iibb: entryNumberValue("other-expense-iibb-retention"),
      imp_internos: entryNumberValue("other-expense-internal-taxes"),
      subtotal: entryNumberValue("other-expense-subtotal"),
      total
    }]);

    await saveBackendEntryRows("otros_gastos", [{
      id_otros_gastos: otherExpenseId,
      fecha_otros_gastos: expenseDate,
      id_acreedor: creditorId,
      id_acreedor_etiqueta: creditorTagId,
      id_egreso: expenseId,
      detalle: backendId(els["other-expense-detail"]?.value)
    }]);

    event.target.reset();
    if (els["other-expense-total"]) delete els["other-expense-total"].dataset.touched;
    if (els["other-expense-iva"]) {
      delete els["other-expense-iva"].dataset.touched;
      delete els["other-expense-iva"].dataset.autoIva;
    }
    if (els["other-expense-payment-date"]) delete els["other-expense-payment-date"].dataset.autoAgreement;
    clearOtherExpenseFile();
    bankNegativeExpenseDraft = null;
    ["other-expense-subtotal", "other-expense-total"].forEach((id) => els[id]?.setAttribute("min", "0"));
    otherExpenseEntryData.loaded = false;
    backendDataMap = null;
    dataEditorSchema = null;
    await loadOtherExpenseEntryOptions(true);
    setCommercialStatus("other-expense-status", `Otro gasto #${otherExpenseId} guardado con egreso #${expenseId}.`, "success");
  } catch (error) {
    setCommercialStatus("other-expense-status", `No se pudo guardar el otro gasto: ${error.message}`, "error");
  } finally {
    setCommercialButtonLoading(button, false);
  }
}

async function loadPartnerContributions() {
  try {
    const rows = await backendTableRowsForEntry("aportes_socios");
    const body = els["partner-contributions-history-body"];
    if (body) {
      body.innerHTML = rows
        .slice()
        .sort((left, right) => Number(right.id_aporte_socio) - Number(left.id_aporte_socio))
        .map((row) => `<tr>
          <td>${escapeHtml(formatDate(row.fecha) || "-")}</td>
          <td>${escapeHtml(row.nombre || "-")}</td>
          <td>${escapeHtml(row.tipo || "-")}</td>
          <td>${formatMoney(parseMoney(row.monto))}</td>
          <td>${row.id_egreso ? `#${escapeHtml(row.id_egreso)}` : "-"}</td>
        </tr>`)
        .join("") || emptyRow(5, "Todavia no hay aportes o retiros registrados.");
    }
    if (els["partner-contribution-date"] && !els["partner-contribution-date"].value) {
      els["partner-contribution-date"].value = toIsoDate(new Date());
    }
  } catch (error) {
    setCommercialStatus("partner-contribution-status", `No se pudieron cargar los aportes: ${error.message}`, "error");
  }
}

async function submitPartnerContribution(event) {
  event.preventDefault();
  const date = backendId(els["partner-contribution-date"]?.value);
  const name = backendId(els["partner-contribution-name"]?.value);
  const type = backendId(els["partner-contribution-type"]?.value);
  const amount = Math.abs(entryNumberValue("partner-contribution-amount"));
  const validNames = new Set(["Bautista de Mayo", "Benjamin de Mayo", "Miguel de Mayo", "Alejandro Ganzabal", "Facundo Aragon"]);

  if (!date || !validNames.has(name) || !["Aporte", "Retiro"].includes(type) || amount <= 0) {
    setCommercialStatus("partner-contribution-status", "Completa fecha, socio, movimiento y monto.", "error");
    return;
  }

  const button = event.submitter;
  setCommercialButtonLoading(button, true, "Guardando...");
  try {
    const [contributionId, expenseId] = await Promise.all([
      nextBackendPrimaryId("aportes_socios", "id_aporte_socio"),
      nextBackendPrimaryId("egresos", "id_egreso")
    ]);
    const signedAmount = type === "Aporte" ? -amount : amount;
    await saveBackendEntryRows("egresos", [{
      id_egreso: expenseId,
      fecha_factura: date,
      fecha_prevista_pago: date,
      id_etiqueta: "",
      tipo_factura: "Aporte_Retiro_Socio",
      nro_factura: `${type === "Aporte" ? "AP" : "RT"}-${String(contributionId).padStart(6, "0")}`,
      iva: 0,
      per_ret_iva: 0,
      per_ret_iibb: 0,
      imp_internos: 0,
      subtotal: signedAmount,
      total: signedAmount
    }]);
    await saveBackendEntryRows("aportes_socios", [{
      id_aporte_socio: contributionId,
      fecha: date,
      nombre: name,
      tipo: type,
      monto: amount,
      id_egreso: expenseId
    }]);
    event.target.reset();
    bankPartnerContributionDraft = null;
    setCommercialStatus("partner-contribution-status", `${type} #${contributionId} guardado con egreso #${expenseId}.`, "success");
    await loadPartnerContributions();
    if (bankReconciliationFileText.trim()) await analyzeBankReconciliation();
  } catch (error) {
    setCommercialStatus("partner-contribution-status", `No se pudo guardar el movimiento: ${error.message}`, "error");
  } finally {
    setCommercialButtonLoading(button, false);
  }
}

function updateCollectionTotal() {
  const invoiceTotal = roundToDecimals(collectionSelectedRows().reduce((acc, row) => acc + row.amount, 0), 2);
  const retentions = collectionRetentionAmounts();
  const expectedReceived = roundToDecimals(Math.max(0, invoiceTotal - retentions.total), 2);
  const receivedInput = els["collection-received-total"];
  if (receivedInput && !receivedInput.dataset.touched) receivedInput.value = expectedReceived.toFixed(2);

  const received = roundToDecimals(Math.max(0, entryNumberValue("collection-received-total")), 2);
  const difference = roundToDecimals(received + retentions.total - invoiceTotal, 2);
  if (els["collection-total"]) els["collection-total"].textContent = formatBankMoney(received);
  if (els["collection-retentions-total"]) els["collection-retentions-total"].textContent = formatBankMoney(retentions.total);
  if (els["collection-invoices-total"]) els["collection-invoices-total"].textContent = formatBankMoney(invoiceTotal);
  if (els["collection-difference"]) {
    els["collection-difference"].textContent = formatBankMoney(difference);
    els["collection-difference"].classList.toggle("is-unbalanced", Math.abs(difference) > 0.0001);
  }
}

function collectionRetentionAmounts() {
  const incomeTax = roundToDecimals(Math.max(0, entryNumberValue("collection-income-tax-retention")), 2);
  const grossRevenue = roundToDecimals(Math.max(0, entryNumberValue("collection-iibb-retention")), 2);
  return {
    incomeTax,
    grossRevenue,
    total: roundToDecimals(incomeTax + grossRevenue, 2)
  };
}

function collectionSelectedRows() {
  return [...document.querySelectorAll("[data-collection-sale]")].map((row) => {
    const selected = row.querySelector("[data-collection-select]")?.checked;
    const amountInput = row.querySelector("[data-collection-amount]");
    const fullInput = row.querySelector("[data-collection-full]");
    const saleId = row.dataset.collectionSale;
    const pending = pendingSalesRows(els["collection-client"]?.value).find((saleRow) => backendId(saleRow.sale.id_venta) === backendId(saleId));
    const amount = fullInput?.checked ? pending?.balance || 0 : parseMoney(amountInput?.value);
    return { selected, saleId, amount: roundToDecimals(amount, 2) };
  }).filter((row) => row.selected && row.amount > 0);
}

async function submitCollectionEntry(event) {
  event.preventDefault();
  const rows = collectionSelectedRows();
  if (!rows.length) {
    setCommercialStatus("collections-status", "Selecciona al menos una factura para saldar.", "error");
    return;
  }
  const retentions = collectionRetentionAmounts();
  const invoiceTotal = roundToDecimals(rows.reduce((acc, row) => acc + row.amount, 0), 2);
  const collectedAmount = roundToDecimals(Math.max(0, entryNumberValue("collection-received-total")), 2);
  if (retentions.total > invoiceTotal + 0.01) {
    setCommercialStatus("collections-status", "Las retenciones no pueden superar el total aplicado a facturas.", "error");
    return;
  }
  if (Math.abs(roundToDecimals(collectedAmount + retentions.total - invoiceTotal, 2)) > 0.0001) {
    setCommercialStatus("collections-status", "El cobro recibido mas las retenciones debe coincidir con el total aplicado a facturas.", "error");
    return;
  }

  const button = event.submitter;
  setCommercialButtonLoading(button, true, "Guardando...");
  setCommercialStatus("collections-status", "Guardando cobro...", "pending");

  try {
    const collectionId = await nextBackendPrimaryId("cobros", "id_cobro");
    const firstDetailId = await nextBackendPrimaryId("cobros_detalle", "id_cobros_detalle");
    await saveBackendEntryRows("cobros", [{
      id_cobro: collectionId,
      fecha_cobro: els["collection-date"]?.value || "",
      metodo: els["collection-method"]?.value || "",
      id_cliente: els["collection-client"]?.value || "",
      monto: collectedAmount,
      banco: els["collection-bank"]?.value || ""
    }]);
    await saveBackendEntryRows("cobros_detalle", rows.map((row, index) => ({
      id_cobros_detalle: firstDetailId + index,
      id_cobro: collectionId,
      id_venta: row.saleId,
      monto_cancelado: row.amount
    })));
    await saveCollectionRetentions(collectionId, retentions);
    setCommercialStatus("collections-status", `Cobro #${collectionId} guardado.`, "success");
    commercialEntryData.loaded = false;
    await loadCommercialEntryData(true);
    // Mantiene sincronizado el extracto ya analizado con el cobro recién guardado.
    if (bankReconciliationFileText.trim()) await analyzeBankReconciliation();
  } catch (error) {
    setCommercialStatus("collections-status", `No se pudo guardar el cobro: ${error.message}`, "error");
  } finally {
    setCommercialButtonLoading(button, false);
  }
}

async function saveCollectionRetentions(collectionId, retentions) {
  const retentionDate = els["collection-date"]?.value || "";
  const clientId = els["collection-client"]?.value || "";
  const saves = [];

  if (retentions.incomeTax > 0) {
    saves.push(nextBackendPrimaryIdOrOne("retenciones_ganancias", "id_retencion_ganancias").then((retentionId) => (
      saveBackendEntryRows("retenciones_ganancias", [{
        id_retencion_ganancias: retentionId,
        id_cobro: collectionId,
        fecha: retentionDate,
        id_cliente: clientId,
        monto: retentions.incomeTax
      }])
    )));
  }

  if (retentions.grossRevenue > 0) {
    saves.push(nextBackendPrimaryIdOrOne("retenciones_iibb", "id_retencion_iibb").then((retentionId) => (
      saveBackendEntryRows("retenciones_iibb", [{
        id_retencion_iibb: retentionId,
        id_cobro: collectionId,
        fecha: retentionDate,
        id_cliente: clientId,
        monto: retentions.grossRevenue
      }])
    )));
  }

  await Promise.all(saves);
}

function downloadSalesDebtSummaryPng() {
  const selectedClientId = els["sales-client-filter"]?.value || "";
  const rows = pendingSalesRows(selectedClientId);
  if (!rows.length) return;

  const clientLabel = selectedClientId ? clientName(selectedClientId) : "Todos los clientes";
  const total = rows.reduce((acc, row) => acc + row.balance, 0);
  const scale = 2;
  const width = 760;
  const rowHeight = 42;
  const height = 170 + rows.length * rowHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d");
  context.scale(scale, scale);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#e8f4f2";
  context.fillRect(32, 28, width - 64, 70);
  context.fillStyle = "#005f5b";
  context.font = "800 26px Arial, sans-serif";
  context.fillText("Resumen de deuda", 54, 72);
  context.fillStyle = "#0d1f33";
  context.font = "700 18px Arial, sans-serif";
  context.fillText(clientLabel, 32, 130);
  context.textAlign = "right";
  context.fillText(formatMoney(total), width - 32, 130);
  context.textAlign = "left";

  let y = 170;
  rows.forEach((row) => {
    context.fillStyle = "#eef3f7";
    context.fillRect(32, y - 28, width - 64, 1);
    context.fillStyle = "#465463";
    context.font = "400 16px Arial, sans-serif";
    context.fillText(`${row.sale.nro_factura || row.sale.id_venta} · ${formatDate(row.sale.fecha_factura)}`, 32, y);
    context.textAlign = "right";
    context.fillStyle = "#0d1f33";
    context.font = "800 16px Arial, sans-serif";
    context.fillText(formatMoney(row.balance), width - 32, y);
    context.textAlign = "left";
    y += rowHeight;
  });

  const link = document.createElement("a");
  link.download = `resumen-deuda-${clientLabel.replace(/\s+/g, "-").toLowerCase()}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

function setCommercialStatus(id, message, status) {
  const element = els[id];
  if (!element) return;
  element.textContent = message;
  element.dataset.status = status || "";
}

function setCommercialButtonLoading(button, loading, text) {
  if (!button) return;
  if (loading) {
    button.dataset.originalText = button.textContent;
    button.textContent = text || "Procesando...";
    button.disabled = true;
    return;
  }
  button.textContent = button.dataset.originalText || button.textContent;
  button.disabled = false;
}

function renderEntryDatalistOptions(datalistId, rows, valueColumn, labelColumns) {
  const datalist = els[datalistId];
  if (!datalist) return;
  datalist.innerHTML = rows
    .map((row) => {
      const value = String(row[valueColumn] ?? "").trim();
      if (!value) return "";
      const label = labelColumns
        .map((column) => String(row[column] ?? "").trim())
        .filter(Boolean)
        .join(" - ");
      return `<option value="${escapeHtml(value)}"${label ? ` label="${escapeHtml(label)}"` : ""}></option>`;
    })
    .join("");
}

function entryNumberValue(inputId) {
  const value = Number(String(els[inputId]?.value || "").replace(",", "."));
  return Number.isFinite(value) ? value : 0;
}

function roundToDecimals(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function setEntryStatus(elementId, message, status) {
  const element = els[elementId];
  if (!element) return;
  element.textContent = message || "";
  element.dataset.status = status || "";
}

function rowsByKey(rows, key) {
  return (rows || []).reduce((map, row) => {
    const rawId = String(row[key] ?? "").trim();
    if (!rawId) return map;

    map.set(rawId, row);

    // Los datos del backend pueden llegar desde CSV/SQLite como "32", 32 o 32.0.
    // Guardamos una clave numérica estable para que los cruces entre tablas no fallen
    // por diferencias de formato en IDs importados.
    const normalizedId = normalizedLookupId(rawId);
    if (normalizedId && !map.has(normalizedId)) map.set(normalizedId, row);

    return map;
  }, new Map());
}

function normalizedLookupId(value) {
  const text = String(value ?? "").trim();
  if (!text || !/^-?\d+(?:\.0+)?$/.test(text)) return "";
  return String(Number(text));
}

function comparableLookupId(value) {
  return normalizedLookupId(value) || String(value ?? "").trim();
}

function rowsByNormalizedValue(rows, key) {
  return new Map((rows || [])
    .map((row) => [normalizeCategory(row[key]), row])
    .filter(([value]) => value));
}

function groupRowsByKey(rows, key) {
  return (rows || []).reduce((groups, row) => {
    const id = String(row[key] ?? "").trim();
    if (!id) return groups;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
    return groups;
  }, new Map());
}

function groupRowsByComparableKey(rows, key) {
  return (rows || []).reduce((groups, row) => {
    const id = comparableLookupId(row[key]);
    if (!id) return groups;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
    return groups;
  }, new Map());
}

async function fillReceptionFromSelectedPurchase() {
  const purchaseId = String(els["reception-purchase-id"]?.value || "").trim();
  clearReceptionDetailFields();
  if (!purchaseId) return;

  try {
    const option = receptionPendingPurchases.get(purchaseId);
    if (!option) {
      setEntryStatus("reception-status", "No encontre el detalle de esa compra.", "error");
      return;
    }

    if (els["reception-date"] && option.purchase.fecha_entrega_prevista) els["reception-date"].value = option.purchase.fecha_entrega_prevista;
    if (els["reception-provider"]) els["reception-provider"].value = displayNameLabel(option.provider.nombre || `Proveedor ${option.purchase.id_proveedor || ""}`);
    if (els["reception-supply-id"]) els["reception-supply-id"].value = option.supply.id_insumo || "";
    if (els["reception-supply-name"]) els["reception-supply-name"].value = displayNameLabel(option.supply.nombre || "");
    setReceptionUnitLabel(els["reception-supplier-unit"], option.supplierUnit);
    setReceptionUnitLabel(els["reception-count-unit"], option.countUnit);
    setReceptionUnitLabel(els["reception-recipe-unit"], option.recipeUnit);
    setReceptionQuantityInputs(option);
    prepareReceptionExpenseReferenceDisplay(option);
    if (els["reception-without-file"]?.checked) autofillReceptionExpenseFromPurchase();
    renderReceptionPendingPurchases();
    setEntryStatus("reception-status", "Compra pendiente cargada. Revisa cantidad recibida y adjunta remito o factura si corresponde.", "pending");
  } catch (error) {
    setEntryStatus("reception-status", error.message, "error");
  }
}

function clearReceptionDetailFields() {
  [
    "reception-provider",
    "reception-supply-name",
    "reception-supply-id",
    "reception-supplier-quantity",
    "reception-quantity",
    "reception-recipe-quantity",
    "reception-expense-invoice-number",
    "reception-expense-subtotal",
    "reception-expense-iva",
    "reception-expense-vat-retention",
    "reception-expense-iibb-retention",
    "reception-expense-internal-taxes",
    "reception-expense-total"
  ].forEach((id) => {
    if (els[id]) {
      els[id].value = "";
      delete els[id].dataset.touched;
    }
  });
  setReceptionUnitLabel(els["reception-supplier-unit"], "");
  setReceptionUnitLabel(els["reception-count-unit"], "");
  setReceptionUnitLabel(els["reception-recipe-unit"], "");
  setReceptionReferenceLabel("reception-expense-subtotal-ref", "");
  setReceptionReferenceLabel("reception-expense-iva-ref", "");
  setReceptionReferenceLabel("reception-expense-total-ref", "");
  clearReceptionExpenseMismatchFlags();
}

function setReceptionQuantityInputs(option) {
  if (els["reception-supplier-quantity"]) els["reception-supplier-quantity"].value = Number.isFinite(option.supplierQuantity) ? integerPurchaseDisplay(option.supplierQuantity) : "";
  if (els["reception-quantity"]) els["reception-quantity"].value = Number.isFinite(option.countQuantity) ? integerPurchaseDisplay(option.countQuantity) : "";
  if (els["reception-recipe-quantity"]) els["reception-recipe-quantity"].value = Number.isFinite(option.recipeQuantity) ? integerPurchaseDisplay(option.recipeQuantity) : "";
}

function setReceptionUnitLabel(element, rawUnit) {
  if (!element) return;
  const value = String(rawUnit || "").trim();
  element.dataset.rawUnit = value;
  element.textContent = value ? displayUnitLabel(value) : "-";
}

function updateReceptionQuantitiesFromField(source) {
  const purchaseId = String(els["reception-purchase-id"]?.value || "").trim();
  const option = receptionPendingPurchases.get(purchaseId);
  if (!option) return;

  const normalized = normalizedPurchaseQuantities(source, {
    supplier: entryNumberValue("reception-supplier-quantity"),
    count: entryNumberValue("reception-quantity"),
    recipe: entryNumberValue("reception-recipe-quantity")
  }, {
    recipePerCountUnit: option.recipePerCountUnit || 1,
    recipePerSupplierUnit: option.recipePerSupplierUnit || 1,
    minimumSupplierUnits: 1
  });
  if (!normalized) return;

  if (els["reception-supplier-quantity"]) els["reception-supplier-quantity"].value = integerPurchaseDisplay(normalized.supplier);
  if (els["reception-quantity"]) els["reception-quantity"].value = integerPurchaseDisplay(normalized.count);
  if (els["reception-recipe-quantity"]) els["reception-recipe-quantity"].value = integerPurchaseDisplay(normalized.recipe);
  if (els["reception-without-file"]?.checked) autofillReceptionExpenseFromPurchase({ keepInvoiceNumber: true });
  else {
    prepareReceptionExpenseReferenceDisplay(option);
    validateReceptionExpenseAgainstReference();
  }
}

function updateReceptionFileName() {
  const file = els["reception-file"]?.files?.[0];
  if (els["reception-file-chip"]) els["reception-file-chip"].classList.toggle("is-empty", !file);
  if (els["reception-file-name"]) els["reception-file-name"].textContent = file ? file.name : "Sin archivo";
  if (els["reception-file-size"]) els["reception-file-size"].textContent = file ? formatFileSize(file.size) : "-";
}

function setupReceptionFileDropZone() {
  setupFileDropZone({
    dropZone: els["reception-file-drop-zone"],
    input: els["reception-file"],
    acceptFile: isReceptionReadableAttachment,
    respectDisabled: true,
    onAccepted: (file) => {
      updateReceptionFileName();
      setEntryStatus("reception-status", `Factura/remito listo: ${file.name}. Para completar el egreso, presiona Leer factura.`, "success");
    },
    onRejected: () => setEntryStatus("reception-status", "Arrastra una imagen o PDF valido de factura/remito.", "error")
  });
}

function clearReceptionFile() {
  if (els["reception-file"]) els["reception-file"].value = "";
  updateReceptionFileName();
  setEntryStatus("reception-status", "", "");
}

function updateReceptionWithoutFile() {
  const withoutFile = Boolean(els["reception-without-file"]?.checked);
  if (els["reception-file"]) {
    els["reception-file"].disabled = withoutFile;
    if (withoutFile) els["reception-file"].value = "";
  }
  updateReceptionFileName();
  if (withoutFile) {
    autofillReceptionExpenseFromPurchase();
    setEntryStatus("reception-status", "Sin remito ni factura: se completo el egreso como Remito X con precios de la compra.", "pending");
  } else {
    clearReceptionExpenseMismatchFlags();
  }
}

function currentReceptionOption() {
  const purchaseId = String(els["reception-purchase-id"]?.value || "").trim();
  return receptionPendingPurchases.get(purchaseId) || null;
}

function receptionExpenseReference(option) {
  const selectedOptions = [...selectedReceptionPurchaseIds]
    .map((purchaseId) => receptionPendingPurchases.get(purchaseId))
    .filter(Boolean);
  const options = selectedOptions.length ? selectedOptions : (option ? [option] : []);
  const subtotal = options.reduce((total, currentOption, index) => {
    const quantity = index === 0 && options.length > 0
      ? entryNumberValue("reception-supplier-quantity")
      : Number(currentOption.supplierQuantity) || 0;
    return total + quantity * (Number(currentOption.unitPrice) || 0);
  }, 0);
  const iva = options.reduce((total, currentOption, index) => {
    const quantity = index === 0 && options.length > 0
      ? entryNumberValue("reception-supplier-quantity")
      : Number(currentOption.supplierQuantity) || 0;
    const currentSubtotal = quantity * (Number(currentOption.unitPrice) || 0);
    return total + currentSubtotal * (Number(currentOption.ivaRate) || 0);
  }, 0);
  const ivaRate = subtotal ? iva / subtotal : 0;
  return {
    subtotal,
    ivaRate,
    iva,
    total: subtotal + iva
  };
}

function autofillReceptionExpenseFromPurchase({ keepInvoiceNumber = false } = {}) {
  const option = currentReceptionOption();
  if (!option) return;

  const withoutFile = Boolean(els["reception-without-file"]?.checked);
  const invoiceType = withoutFile ? "Remito_X" : (els["reception-expense-invoice-type"]?.value || "Factura_A");
  const reference = receptionExpenseReference(option);

  if (els["reception-expense-invoice-type"]) els["reception-expense-invoice-type"].value = invoiceType;
  if (!keepInvoiceNumber && els["reception-expense-invoice-number"]) {
    if (withoutFile) setAutomaticReceptionInvoiceNumber();
    else els["reception-expense-invoice-number"].value = "";
  }
  if (els["reception-expense-invoice-date"] && !els["reception-expense-invoice-date"].value) {
    els["reception-expense-invoice-date"].value = els["reception-date"]?.value || option.purchase.fecha_entrega_prevista || toIsoDate(new Date());
  }
  if (els["reception-expense-payment-date"] && !els["reception-expense-payment-date"].value) {
    els["reception-expense-payment-date"].value = option.purchase.fecha_entrega_prevista || els["reception-date"]?.value || "";
  }

  setReceptionExpenseMoneyInput("reception-expense-subtotal", reference.subtotal);
  setReceptionExpenseMoneyInput("reception-expense-iva", invoiceType === "Factura_A" || invoiceType === "Factura_B" ? reference.iva : 0);
  setReceptionExpenseMoneyInput("reception-expense-vat-retention", 0);
  setReceptionExpenseMoneyInput("reception-expense-iibb-retention", 0);
  setReceptionExpenseMoneyInput("reception-expense-internal-taxes", 0);
  updateReceptionExpenseTotalFromInputs();
  setReceptionExpenseReferences(reference, option);
  clearReceptionExpenseMismatchFlags();
}

async function setAutomaticReceptionInvoiceNumber() {
  const input = els["reception-expense-invoice-number"];
  if (!input) return;
  input.value = "Calculando nro...";
  try {
    input.value = await nextBackendPrimaryId("recepciones", "id_recepcion");
  } catch {
    input.value = "";
    setEntryStatus("reception-status", "No se pudo calcular el nro automatico del remito. Completalo manualmente.", "error");
  }
}

function setReceptionExpenseMoneyInput(id, value) {
  const input = els[id];
  if (!input || input.dataset.touched === "true") return;
  input.value = Number.isFinite(value) ? decimalPurchaseDisplay(value) : "";
}

function setReceptionExpenseReferences(reference, option) {
  const multipleReceptions = selectedReceptionPurchaseIds.size > 1;
  const unitPriceLabel = !multipleReceptions && option?.unitPrice
    ? `${formatMoney(option.unitPrice)} / ${displayUnitLabel(option.supplierUnit)}`
    : "";
  setReceptionReferenceLabel("reception-expense-subtotal-ref", unitPriceLabel || purchaseMoneyLabel(reference.subtotal));
  setReceptionReferenceLabel("reception-expense-iva-ref", `${purchaseMoneyLabel(reference.iva)} · ${formatRateLabel(reference.ivaRate)}`);
  setReceptionReferenceLabel("reception-expense-total-ref", purchaseMoneyLabel(reference.total));
}

function setReceptionReferenceLabel(id, value) {
  if (!els[id]) return;
  els[id].textContent = value || "-";
}

function prepareReceptionExpenseReferenceDisplay(option = currentReceptionOption()) {
  if (!option) return;
  setReceptionExpenseReferences(receptionExpenseReference(option), option);
}

function clearReceptionExpenseMismatchFlags() {
  [
    "reception-expense-subtotal",
    "reception-expense-iva",
    "reception-expense-total"
  ].forEach((id) => els[id]?.classList.remove("is-reference-mismatch"));
}

function validateReceptionExpenseAgainstReference() {
  const option = currentReceptionOption();
  if (!option) return;
  const reference = receptionExpenseReference(option);
  const invoiceType = String(els["reception-expense-invoice-type"]?.value || "").trim();
  const expectedIva = invoiceType === "Factura_A" || invoiceType === "Factura_B" ? reference.iva : 0;
  const expectedTotal = reference.subtotal + expectedIva;
  [
    ["reception-expense-subtotal", reference.subtotal],
    ["reception-expense-iva", expectedIva],
    ["reception-expense-total", expectedTotal]
  ].forEach(([id, expected]) => {
    const input = els[id];
    if (!input) return;
    const rawValue = String(input.value || "").trim();
    const current = entryNumberValue(id);
    const hasValue = rawValue !== "";
    const tolerance = Math.max(1, Math.abs(expected) * 0.005);
    input.classList.toggle("is-reference-mismatch", hasValue && Math.abs(current - expected) > tolerance);
  });
}

function updateReceptionExpenseTotalFromInputs() {
  [
    "reception-expense-subtotal",
    "reception-expense-iva",
    "reception-expense-vat-retention",
    "reception-expense-iibb-retention",
    "reception-expense-internal-taxes"
  ].forEach((id) => {
    const input = els[id];
    if (input && document.activeElement === input) input.dataset.touched = "true";
  });

  const subtotal = entryNumberValue("reception-expense-subtotal");
  const iva = entryNumberValue("reception-expense-iva");
  const vatRetention = entryNumberValue("reception-expense-vat-retention");
  const iibbRetention = entryNumberValue("reception-expense-iibb-retention");
  const internalTaxes = entryNumberValue("reception-expense-internal-taxes");
  if (els["reception-expense-total"]) {
    els["reception-expense-total"].value = decimalPurchaseDisplay(subtotal + iva + vatRetention + iibbRetention + internalTaxes);
  }
  validateReceptionExpenseAgainstReference();
}

async function autofillReceptionExpenseFromAttachment() {
  const option = currentReceptionOption();
  const file = els["reception-file"]?.files?.[0];
  if (!option) {
    setEntryStatus("reception-status", "Primero elegi una compra pendiente.", "error");
    return;
  }
  if (els["reception-without-file"]?.checked) {
    setEntryStatus("reception-status", "Desmarca Sin remito ni factura para leer un archivo.", "error");
    return;
  }
  if (!file) {
    setEntryStatus("reception-status", "Adjunta una factura o remito antes de leer.", "error");
    return;
  }
  if (!isReceptionReadableAttachment(file)) {
    setEntryStatus("reception-status", "Adjunta una imagen o PDF valido de factura/remito.", "error");
    return;
  }

  const requestId = receptionInvoiceReadRequestId + 1;
  receptionInvoiceReadRequestId = requestId;
  setEntryStatus("reception-status", "Leyendo factura/remito para precargar egreso...", "pending");
  try {
    const fileDataUrl = await receptionAttachmentToDataUrl(file);
    const response = await fetch(`${API_BASE_URL}/api/reception-invoice/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileDataUrl,
        fileName: file.name,
        mimeType: file.type
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (requestId !== receptionInvoiceReadRequestId) return;
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    applyReceptionInvoiceRead(payload.invoice || {});
    setEntryStatus("reception-status", "Factura/remito leido. Revisa y corrige los datos antes de enviar.", "success");
  } catch (error) {
    setEntryStatus("reception-status", `No se pudo leer automaticamente: ${error.message}. Completa o corrige los datos manualmente.`, "error");
  }
}

function isReceptionReadableAttachment(file) {
  const fileName = String(file?.name || "").toLowerCase();
  return Boolean(file && (file.type.startsWith("image/") || file.type === "application/pdf" || fileName.endsWith(".pdf")));
}

// Las imagenes se reducen antes de enviarlas para acelerar la lectura; los PDF se
// mandan completos porque la IA necesita acceder al documento y no solo a una vista previa.
async function receptionAttachmentToDataUrl(file) {
  if (file.type.startsWith("image/")) return imageFileToDataUrl(file);
  const dataUrl = await fileToDataUrl(file);
  if (String(file.name || "").toLowerCase().endsWith(".pdf") && !String(dataUrl).startsWith("data:application/pdf")) {
    return String(dataUrl).replace(/^data:[^;,]*([;,])/, "data:application/pdf$1");
  }
  return dataUrl;
}

function applyReceptionInvoiceRead(invoice) {
  const option = currentReceptionOption();
  if (!option) return;
  prepareReceptionExpenseReferenceDisplay(option);
  const type = normalizeReceptionInvoiceType(invoice.tipo_factura || invoice.invoiceType);
  if (type && els["reception-expense-invoice-type"]) els["reception-expense-invoice-type"].value = type;
  if (invoice.nro_factura || invoice.invoiceNumber) els["reception-expense-invoice-number"].value = String(invoice.nro_factura || invoice.invoiceNumber).trim();
  if (invoice.fecha_factura || invoice.invoiceDate) els["reception-expense-invoice-date"].value = parseDate(invoice.fecha_factura || invoice.invoiceDate) || els["reception-expense-invoice-date"].value;
  const fields = [
    ["reception-expense-subtotal", invoice.subtotal],
    ["reception-expense-iva", invoice.iva],
    ["reception-expense-vat-retention", invoice.per_ret_iva],
    ["reception-expense-iibb-retention", invoice.per_ret_iibb],
    ["reception-expense-internal-taxes", invoice.imp_internos],
    ["reception-expense-total", invoice.total]
  ];
  fields.forEach(([id, value]) => {
    const number = parseMoney(value);
    if (els[id] && Number.isFinite(number) && number > 0) {
      els[id].value = decimalPurchaseDisplay(number);
      els[id].dataset.touched = "true";
    }
  });
  updateReceptionExpenseTotalFromInputs();
  validateReceptionExpenseAgainstReference();
}

function normalizeReceptionInvoiceType(value) {
  const text = normalizeCategory(value);
  if (!text) return "";
  if (text.includes("remito")) return "Remito_X";
  if (text.includes("factura a") || text === "a" || text.includes("factura_a")) return "Factura_A";
  if (text.includes("factura b") || text === "b" || text.includes("factura_b")) return "Factura_B";
  if (text.includes("factura c") || text === "c" || text.includes("factura_c")) return "Factura_C";
  return "";
}

async function submitReceptionEntry(event) {
  event.preventDefault();
  const purchaseIds = [...selectedReceptionPurchaseIds];
  const purchaseId = purchaseIds[0] || String(els["reception-purchase-id"]?.value || "").trim();
  if (purchaseId && !purchaseIds.includes(purchaseId)) purchaseIds.push(purchaseId);
  const receptionDate = String(els["reception-date"]?.value || "").trim();
  const supplyId = String(els["reception-supply-id"]?.value || "").trim();
  const quantity = entryNumberValue("reception-quantity");
  const invoiceType = String(els["reception-expense-invoice-type"]?.value || "").trim();
  const invoiceDate = String(els["reception-expense-invoice-date"]?.value || receptionDate).trim();

  let employeeId = "";
  try {
    employeeId = await resolveReceptionEmployeeId();
  } catch (error) {
    setEntryStatus("reception-status", error.message, "error");
    return;
  }

  if (!purchaseIds.length || !receptionDate || !employeeId || !supplyId || quantity <= 0) {
    setEntryStatus("reception-status", "Completa compra, fecha, empleado, insumo y cantidad recibida.", "error");
    return;
  }
  if (!invoiceType || !invoiceDate) {
    setEntryStatus("reception-status", "Completa tipo de factura/remito y fecha de factura.", "error");
    return;
  }

  const button = els["reception-submit"];
  const originalText = button?.textContent || "Enviar recepcion";
  if (button) {
    button.disabled = true;
    button.textContent = "Guardando...";
  }
  setEntryStatus("reception-status", "Guardando recepcion...", "pending");

  try {
    const [firstReceptionId, firstDetailId] = await Promise.all([
      nextBackendPrimaryId("recepciones", "id_recepcion"),
      nextBackendPrimaryId("detalle_recepciones", "id_detalle_recepcion")
    ]);
    const expenseId = await nextBackendPrimaryId("egresos", "id_egreso");
    const option = receptionPendingPurchases.get(purchaseId) || {};
    const invoiceNumber = receptionInvoiceNumberForSave(firstReceptionId);
    const attachmentPath = await uploadReceptionAttachmentIfNeeded(firstReceptionId);
    const receptionRows = [];
    const detailRows = [];
    let firstCreditorTagId = "";
    for (let index = 0; index < purchaseIds.length; index += 1) {
      const currentPurchaseId = purchaseIds[index];
      const currentOption = receptionPendingPurchases.get(currentPurchaseId) || option;
      const receptionId = Number(firstReceptionId) + index;
      const detailId = Number(firstDetailId) + index;
      const creditorTagId = await receptionCreditorTagId(currentOption);
      if (!firstCreditorTagId) firstCreditorTagId = creditorTagId;
      receptionRows.push({ id_recepcion: receptionId, fecha_recepcion: receptionDate, id_empleado: employeeId, id_compra: currentPurchaseId, id_acreedor_etiqueta: creditorTagId, id_egreso: expenseId, archivo_recepcion: attachmentPath });
      detailRows.push({ id_detalle_recepcion: detailId, id_recepcion: receptionId, id_insumo: index === 0 ? supplyId : currentOption.supply?.id_insumo || "", cantidad_recibida: index === 0 ? quantity : currentOption.countQuantity });
    }
    await saveBackendEntryRows("recepciones", receptionRows);
    await saveBackendEntryRows("detalle_recepciones", detailRows);
    await saveBackendEntryRows("egresos", [{
      id_egreso: expenseId,
      origen_tipo: "Recepciones",
      origen_id: purchaseIds.map((_, index) => Number(firstReceptionId) + index).join(","),
      fecha_factura: invoiceDate,
      fecha_prevista_pago: String(els["reception-expense-payment-date"]?.value || invoiceDate).trim(),
      id_etiqueta: option.expenseLabelId || await tagIdFromCreditorTagId(firstCreditorTagId),
      tipo_factura: invoiceType,
      nro_factura: invoiceNumber,
      iva: entryNumberValue("reception-expense-iva"),
      per_ret_iva: entryNumberValue("reception-expense-vat-retention"),
      per_ret_iibb: entryNumberValue("reception-expense-iibb-retention"),
      imp_internos: entryNumberValue("reception-expense-internal-taxes"),
      subtotal: entryNumberValue("reception-expense-subtotal"),
      total: entryNumberValue("reception-expense-total")
    }]);

    backendDataMap = null;
    dataEditorSchema = null;
    purchaseBackendOptions = createPurchaseBackendOptions();
    await loadReceptionPurchaseOptions();
    setEntryStatus("reception-status", `${purchaseIds.length} recepcion(es) guardada(s) con egreso ${expenseId}.`, "success");
  } catch (error) {
    setEntryStatus("reception-status", error.message, "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function receptionInvoiceNumberForSave(receptionId) {
  const value = String(els["reception-expense-invoice-number"]?.value || "").trim();
  const normalizedValue = normalizeSearchText(value);
  if (value && !normalizedValue.includes("automatico") && !normalizedValue.includes("calculando")) return value;
  return String(receptionId);
}

async function uploadReceptionAttachmentIfNeeded(receptionId) {
  if (els["reception-without-file"]?.checked) return "";
  const file = els["reception-file"]?.files?.[0];
  if (!file) return "";
  const dataBase64 = await fileToBase64(file);
  const response = await fetch(`${API_BASE_URL}/api/reception-attachments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      receptionId,
      fileName: file.name,
      mimeType: file.type,
      dataBase64
    })
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload.path || payload.fileName || file.name;
}

async function resolveReceptionEmployeeId() {
  const value = String(els["reception-employee-id"]?.value || "").trim();
  if (!value) return "";
  const employees = await backendTableRowsForEntry("empleados").catch(() => []);
  const directMatch = employees.find((employee) => String(employee.id_empleado ?? "").trim() === value);
  if (directMatch) return String(directMatch.id_empleado ?? "").trim();
  const nameKey = normalizeCategory(value);
  const nameMatch = employees.find((employee) => (
    normalizeCategory(employee.nombre_empleado) === nameKey
    || employeeNameTokensMatch(value, employee.nombre_empleado)
  ));
  if (nameMatch?.id_empleado) return String(nameMatch.id_empleado).trim();
  throw new Error(`No encontre el empleado "${value}" en la tabla Empleados.`);
}

function employeeNameTokensMatch(inputName, employeeName) {
  const inputTokens = normalizeSearchText(inputName).split(/\s+/).filter((token) => token.length > 2);
  const employeeTokens = new Set(normalizeSearchText(employeeName).split(/\s+/).filter((token) => token.length > 2));
  if (inputTokens.length < 2 || employeeTokens.size < 2) return false;
  const matchingTokens = inputTokens.filter((token) => employeeTokens.has(token)).length;
  return matchingTokens >= Math.min(2, inputTokens.length);
}

async function receptionCreditorTagId(option = currentReceptionOption()) {
  const providerId = String(option?.purchase?.id_proveedor ?? "").trim();
  if (!providerId) return "";

  const [creditors, creditorTags] = await Promise.all([
    backendTableRowsForEntry("acreedores").catch(() => []),
    backendTableRowsForEntry("acreedores_etiquetas").catch(() => [])
  ]);
  const providerCreditor = creditors.find((creditor) => (
    normalizeSearchText(creditor.origen_tipo_acreedor).includes("proveedor")
    && comparableLookupId(creditor.origen_id_acreedor) === comparableLookupId(providerId)
  ));
  const creditorId = String(providerCreditor?.id_acreedor ?? "").trim();
  if (!creditorId) return "";

  return creditorTags
    .filter((relation) => comparableLookupId(relation.id_acreedor) === comparableLookupId(creditorId))
    .sort((left, right) => Number(left.id_acreedor_etiqueta || 0) - Number(right.id_acreedor_etiqueta || 0))[0]?.id_acreedor_etiqueta || "";
}

async function tagIdFromCreditorTagId(creditorTagId) {
  const normalizedCreditorTagId = comparableLookupId(creditorTagId);
  if (!normalizedCreditorTagId) return "";
  const creditorTags = await backendTableRowsForEntry("acreedores_etiquetas").catch(() => []);
  return String(creditorTags.find((relation) => (
    comparableLookupId(relation.id_acreedor_etiqueta) === normalizedCreditorTagId
  ))?.id_etiqueta ?? "").trim();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const encoded = String(reader.result || "").split(",")[1] || "";
      resolve(encoded);
    };
    reader.onerror = () => reject(new Error("No se pudo leer el archivo adjunto."));
    reader.readAsDataURL(file);
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
    reader.readAsDataURL(file);
  });
}

async function submitIssuedCheckEntry(event) {
  event.preventDefault();
  const paymentId = String(els["issued-check-payment-id"]?.value || "").trim();
  const creditorId = String(els["issued-check-creditor-id"]?.value || "").trim();
  const checkNumber = String(els["issued-check-number"]?.value || "").trim();
  const deliveredDate = String(els["issued-check-date"]?.value || "").trim();
  const useDate = String(els["issued-check-use-date"]?.value || "").trim();
  const amount = entryNumberValue("issued-check-amount");
  const bank = String(els["issued-check-bank"]?.value || "").trim();

  if (!paymentId || !creditorId || !checkNumber || !deliveredDate || !useDate || amount <= 0) {
    setEntryStatus("issued-check-message", "Selecciona un pago pendiente y completa numero, fechas y monto del cheque.", "error");
    return;
  }

  const button = els["issued-check-submit"];
  const originalText = button?.textContent || "Enviar cheque entregado";
  if (button) {
    button.disabled = true;
    button.textContent = "Guardando...";
  }
  setEntryStatus("issued-check-message", "Guardando cheque entregado...", "pending");

  try {
    const checkId = await nextBackendPrimaryId("cheques_entregados", "id_cheque_entregado");
    await saveBackendEntryRows("cheques_entregados", [{
      id_cheque_entregado: checkId,
      id_pago: paymentId,
      id_acreedor: creditorId,
      nro_cheque: checkNumber,
      fecha_entregado: deliveredDate,
      fecha_uso: useDate,
      monto: amount,
      banco: bank,
      estado: String(els["issued-check-state"]?.value || "").trim() || "Pendiente"
    }]);

    backendDataMap = null;
    dataEditorSchema = null;
    purchaseBackendOptions = createPurchaseBackendOptions();
    await loadIssuedCheckPendingPayments();
    setEntryStatus("issued-check-message", `Cheque ${checkId} asociado al pago ${paymentId}.`, "success");
  } catch (error) {
    setEntryStatus("issued-check-message", error.message, "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

// Cambia de pantalla sin recargar la pĂˇgina.
async function loadInventoryDetailTemplate() {
  const date = els["inventory-date-input"].value;
  if (!date) {
    renderInventoryDetailTemplate(null);
    setInventoryDetailStatus("ElegĂ­ una fecha para preparar el detalle.", "pending");
    return;
  }

  const button = els["inventory-detail-load"];
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Preparando...";
  setInventoryDetailStatus("Leyendo el Ăşltimo detalle cargado...", "pending");

  try {
    const response = await fetch(`${API_BASE_URL}/api/inventory-detail/template`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);

    inventoryDetailTemplate = payload;
    renderInventoryDetailTemplate(payload);
    setInventoryDetailStatus(`Detalle preparado con ${payload.rows.length} items.`, "success");
  } catch (error) {
    renderInventoryDetailTemplate(null);
    setInventoryDetailStatus(`No se pudo preparar el detalle: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function renderInventoryDetailTemplate(template) {
  inventoryDetailTemplate = template;
  lastInventoryPhotoTranscription = null;
  inventoryPhotoApplied = false;
  renderInventoryPhotoTranscription(null);
  if (els["inventory-detail-id-label"]) {
    els["inventory-detail-id-label"].textContent = `Id inventario: ${template?.inventoryId || "-"}`;
  }

  if (!template?.rows?.length) {
    els["inventory-detail-body"].innerHTML = emptyRow(12, "Todavia no hay detalle preparado.");
    return;
  }

  els["inventory-detail-body"].innerHTML = template.rows.map((row) => `
    <tr data-item-id="${escapeHtml(row.itemId)}" data-item-name="${escapeHtml(row.itemName)}" data-previous-afternoon="${escapeHtml(row.previousAfternoon || "")}" data-previous-morning="${escapeHtml(row.previousMorning || "")}" data-previous-dawn="${escapeHtml(row.previousDawn || "")}">
      <td>${escapeHtml(template.inventoryId)}</td>
      <td>${escapeHtml(row.itemId)}</td>
      <td>
        <span class="inventory-item-name">${escapeHtml(row.itemName)}</span>
        <span class="inventory-purchase-alert" data-purchase-alert hidden>
          <span class="inventory-alert-icon">!</span>
          <button type="button" data-purchase-item="${escapeHtml(row.itemName)}" data-purchase-item-id="${escapeHtml(row.itemId)}">Comprar</button>
        </span>
      </td>
      <td class="num dawn-stock-cell"><input class="detail-quantity-input" data-detail-field="dawn" type="number" step="any"></td>
      <td class="num theoretical-stock-cell dawn-theoretical-stock-cell" data-theoretical-shift="dawn">-</td>
      <td class="num theoretical-diff-cell dawn-theoretical-diff-cell" data-theoretical-shift="dawn">-</td>
      <td class="num morning-stock-cell"><input class="detail-quantity-input" data-detail-field="morning" type="number" step="any"></td>
      <td class="num theoretical-stock-cell morning-theoretical-stock-cell" data-theoretical-shift="morning">-</td>
      <td class="num theoretical-diff-cell morning-theoretical-diff-cell" data-theoretical-shift="morning">-</td>
      <td class="num afternoon-stock-cell"><input class="detail-quantity-input" data-detail-field="afternoon" type="number" step="any"></td>
      <td class="num theoretical-stock-cell afternoon-theoretical-stock-cell" data-theoretical-shift="afternoon">-</td>
      <td class="num theoretical-diff-cell afternoon-theoretical-diff-cell" data-theoretical-shift="afternoon">-</td>
    </tr>
  `).join("") + renderCounterAlipackRow();
  els["inventory-detail-body"].querySelectorAll(".detail-quantity-input").forEach((input) => {
    input.addEventListener("input", () => {
      updateInventoryCounterReview();
      updateTheoreticalInventoryStock();
    });
  });
  cacheInventoryCounterInputs();
  bindInventoryCounterInputs();
  clearDisabledInventoryShiftInputs();
  clearManualCounterCorrections();
  updateInventoryCounterReview();
  updateTheoreticalInventoryStock();
}

function cacheInventoryCounterInputs() {
  [
    "inventory-counter-manual-morning",
    "inventory-counter-manual-afternoon",
    "inventory-counter-manual-dawn",
    "inventory-counter-theoretical-morning",
    "inventory-counter-theoretical-afternoon",
    "inventory-counter-theoretical-dawn",
    "inventory-counter-diff-morning",
    "inventory-counter-diff-afternoon",
    "inventory-counter-diff-dawn"
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });
}

function bindInventoryCounterInputs() {
  ["inventory-counter-manual-morning", "inventory-counter-manual-afternoon", "inventory-counter-manual-dawn"].forEach((id) => {
    els[id]?.addEventListener("input", () => {
      syncManualCounterCorrection(id);
      updateInventoryCounterReview();
      updateTheoreticalInventoryStock();
    });
  });
}

function renderCounterAlipackRow() {
  return `
    <tr class="inventory-counter-row">
      <td></td>
      <td></td>
      <td>
        <strong>Contador Alipack</strong>
      </td>
      <td class="num dawn-stock-cell">
        <input id="inventory-counter-manual-dawn" type="number" step="any" placeholder="-">
      </td>
      <td class="num theoretical-stock-cell" id="inventory-counter-theoretical-dawn">-</td>
      <td class="num theoretical-diff-cell" id="inventory-counter-diff-dawn">-</td>
      <td class="num morning-stock-cell">
        <input id="inventory-counter-manual-morning" type="number" step="any" placeholder="-">
      </td>
      <td class="num theoretical-stock-cell" id="inventory-counter-theoretical-morning">-</td>
      <td class="num theoretical-diff-cell" id="inventory-counter-diff-morning">-</td>
      <td class="num afternoon-stock-cell">
        <input id="inventory-counter-manual-afternoon" type="number" step="any" placeholder="-">
      </td>
      <td class="num theoretical-stock-cell" id="inventory-counter-theoretical-afternoon">-</td>
      <td class="num theoretical-diff-cell" id="inventory-counter-diff-afternoon">-</td>
    </tr>
  `;
}

async function readInventoryPhoto() {
  const file = els["inventory-photo-input"].files[0];
  const date = els["inventory-date-input"].value;
  const selectedShifts = selectedInventoryShifts();

  if (!date) {
    setInventoryDetailStatus("Elegí la fecha antes de leer la foto.", "error");
    return;
  }

  if (!selectedShifts.length) {
    setInventoryDetailStatus("Marcá al menos un turno realizado antes de leer la foto.", "error");
    return;
  }

  if (!inventoryDetailTemplate?.rows?.length) {
    setInventoryDetailStatus("Primero prepará el detalle.", "error");
    return;
  }

  if (!file) {
    setInventoryDetailStatus("Seleccioná una foto del inventario.", "error");
    return;
  }

  const button = els["inventory-photo-read"];
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Leyendo...";
  lastInventoryPhotoTranscription = null;
  inventoryPhotoApplied = false;
  setInventoryDetailStatus("Leyendo foto y buscando cantidades...", "pending");
  renderInventoryPhotoTranscription(null);

  try {
    const imageDataUrl = await imageFileToDataUrl(file);
    const response = await fetch(`${API_BASE_URL}/api/inventory-detail/photo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date,
        imageDataUrl,
        selectedShifts,
        rows: inventoryDetailTemplate.rows
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);

    lastInventoryPhotoTranscription = filterInventoryTranscriptionBySelectedShifts(payload.transcription);
    inventoryPhotoApplied = true;
    const result = applyPhotoInventoryRows(payload.rows || []);
    renderInventoryPhotoTranscription(lastInventoryPhotoTranscription);
    clearManualCounterCorrections();
    updateInventoryCounterReview();
    updateTheoreticalInventoryStock();
    window.setTimeout(updateTheoreticalInventoryStock, 0);
    setInventoryDetailStatus("Foto leida", "success");
  } catch (error) {
    setInventoryDetailStatus(`No se pudo leer la foto: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function applyPhotoInventoryRows(rows) {
  let applied = 0;
  els["inventory-detail-body"].querySelectorAll(".detail-quantity-input").forEach((input) => {
    if (!isInventoryShiftEnabled(input.dataset.detailField)) input.value = "";
    input.removeAttribute("title");
  });

  rows.forEach((photoRow) => {
    const target = findDetailTableRow(photoRow);
    if (!target) return;

    ["afternoon", "morning", "dawn"].forEach((field) => {
      const value = normalizePhotoQuantity(photoRow[field]);
      const input = target.querySelector(`[data-detail-field="${field}"]`);
      if (!input) return;
      if (!isInventoryShiftEnabled(field)) {
        input.value = "";
        return;
      }
      if (value !== "") {
        input.value = value;
        applied += 1;
      }
    });
  });

  updateTheoreticalInventoryStock();
  return { applied };
}

function selectedInventoryShifts() {
  return [...document.querySelectorAll("[data-inventory-shift]")]
    .filter((input) => input.checked)
    .map((input) => input.dataset.inventoryShift);
}

function firstSelectedInventoryShift() {
  const selected = new Set(selectedInventoryShifts());
  return ["dawn", "morning", "afternoon"].find((field) => selected.has(field)) || "";
}

function isInventoryShiftEnabled(field) {
  return selectedInventoryShifts().includes(field);
}

function filterInventoryTranscriptionBySelectedShifts(transcription) {
  if (!transcription?.rows?.length) return transcription || null;
  const selected = new Set(selectedInventoryShifts());
  return {
    ...transcription,
    rows: transcription.rows.map((row) => ({
      ...row,
      shiftValues: [
        selected.has("dawn") ? inventoryTranscriptionShiftValue(row, "dawn") : "",
        selected.has("morning") ? inventoryTranscriptionShiftValue(row, "morning") : "",
        selected.has("afternoon") ? inventoryTranscriptionShiftValue(row, "afternoon") : ""
      ],
      dawn: selected.has("dawn") ? row.dawn : "",
      morning: selected.has("morning") ? row.morning : "",
      afternoon: selected.has("afternoon") ? row.afternoon : "",
      turnoMadrugada: selected.has("dawn") ? row.turnoMadrugada : "",
      turnoManana: selected.has("morning") ? row.turnoManana : "",
      turnoMañana: selected.has("morning") ? row.turnoMañana : "",
      turnoTarde: selected.has("afternoon") ? row.turnoTarde : ""
    }))
  };
}

function clearDisabledInventoryShiftInputs() {
  els["inventory-detail-body"]?.querySelectorAll(".detail-quantity-input").forEach((input) => {
    if (isInventoryShiftEnabled(input.dataset.detailField)) {
      input.disabled = false;
      return;
    }
    input.disabled = true;
    input.value = "";
    input.removeAttribute("title");
  });
}

/*
  Stocks teoricos del inventario.
  Cada turno toma como inicial el ultimo turno trabajado anterior; si no hay, usa el ultimo stock guardado.
  La produccion conocida alimenta las recetas y permite estimar el consumo teorico de insumos/subproductos.
*/
function updateTheoreticalInventoryStock() {
  const body = els["inventory-detail-body"];
  if (!body) return;
  renderTheoreticalStockBreakdown(null);

  body.querySelectorAll("tr[data-item-id]").forEach((row) => {
    row.querySelectorAll(".theoretical-stock-cell").forEach((cell) => {
      cell.textContent = "-";
      cell.title = "";
      cell.classList.remove("missing-theoretical-stock", "stock-diff-yellow", "stock-diff-orange", "stock-diff-red");
    });
    row.querySelectorAll(".theoretical-diff-cell").forEach((diffCell) => {
      diffCell.textContent = "-";
      diffCell.title = "";
      diffCell.classList.remove("diff-positive", "diff-negative", "diff-neutral", "stock-diff-yellow", "stock-diff-orange", "stock-diff-red");
    });
    row.querySelectorAll(".detail-quantity-input").forEach((input) => {
      input.classList.remove("stock-diff-yellow", "stock-diff-orange", "stock-diff-red");
    });
  });

  const selectedDate = els["inventory-date-input"]?.value || "";
  const theoreticalShifts = selectedInventoryShifts().filter((shift) => ["dawn", "morning", "afternoon"].includes(shift));
  const missingRows = [];
  if (!selectedDate) missingRows.push("fecha");
  if (!theoreticalShifts.length) missingRows.push("turno realizado");
  if (missingRows.length) {
    renderTheoreticalStockBreakdown({
      missing: missingRows,
      selectedShift: theoreticalShifts[0] || ""
    });
    updateInventoryPurchaseAlerts();
    return;
  }

  const models = theoreticalShifts.map((shift) => buildTheoreticalInventoryModel(selectedDate, shift));
  models.forEach((model) => {
    model.rows.forEach((row) => {
      const cell = row.element.querySelector(`.theoretical-stock-cell[data-theoretical-shift="${model.selectedShift}"]`);
      const diffCell = row.element.querySelector(`.theoretical-diff-cell[data-theoretical-shift="${model.selectedShift}"]`);
      if (!cell) return;
      if (Number.isFinite(row.theoreticalStock)) {
        cell.textContent = formatRoundedNumber(row.theoreticalStock);
        cell.classList.remove("missing-theoretical-stock", "stock-diff-yellow", "stock-diff-orange", "stock-diff-red");
        cell.title = `Inicial: ${formatNullableNumber(row.previousStock)} | Produccion: ${formatNullableNumber(row.producedStock)} | Ventas: ${formatNullableNumber(row.sales)} | Consumo recetas: ${formatNullableNumber(row.consumedStock)}`;
        renderTheoreticalStockDifference(diffCell, row, model.selectedShift);
        return;
      }
      if (row.missing.length) markTheoreticalStockMissing(cell, `Falta: ${row.missing.join(", ")}`);
    });
  });
  renderTheoreticalStockBreakdown(models[0]);
  updateInventoryPurchaseAlerts();
}

function renderTheoreticalStockDifference(cell, row, shift) {
  if (!cell) return;
  const loadedStock = currentDetailStockForShift(row.element, shift);
  const roundedTheoreticalStock = roundedNumberValue(row.theoreticalStock);
  const stockCell = row.element.querySelector(`.theoretical-stock-cell[data-theoretical-shift="${shift}"]`);
  const loadedInput = row.element.querySelector(`[data-detail-field="${shift}"]`);
  [stockCell, loadedInput, cell].forEach((element) => {
    element?.classList.remove("stock-diff-yellow", "stock-diff-orange", "stock-diff-red");
  });
  if (!Number.isFinite(loadedStock) || !Number.isFinite(roundedTheoreticalStock) || roundedTheoreticalStock === 0) {
    cell.textContent = "-";
    cell.title = "Falta stock cargado para comparar.";
    cell.classList.remove("diff-positive", "diff-negative", "diff-neutral", "stock-diff-yellow", "stock-diff-orange", "stock-diff-red");
    return;
  }

  const differencePercent = ((loadedStock - roundedTheoreticalStock) / roundedTheoreticalStock) * 100;
  cell.textContent = formatRoundedPercentValue(differencePercent);
  cell.title = `Teorico redondeado: ${formatRoundedNumber(row.theoreticalStock)} | Teorico real: ${formatNumber(row.theoreticalStock)} | Cargado: ${formatNumber(loadedStock)}`;
  cell.classList.toggle("diff-positive", differencePercent > 0);
  cell.classList.toggle("diff-negative", differencePercent < 0);
  cell.classList.toggle("diff-neutral", differencePercent === 0);
  markTheoreticalStockDifferenceLevel([loadedInput, stockCell, cell], differencePercent);
}

function markTheoreticalStockDifferenceLevel(elements, differencePercent) {
  const absoluteDifference = Math.abs(differencePercent);
  elements.filter(Boolean).forEach((element) => {
    element.classList.toggle("stock-diff-red", absoluteDifference > 50);
    element.classList.toggle("stock-diff-orange", absoluteDifference > 25 && absoluteDifference <= 50);
    element.classList.toggle("stock-diff-yellow", absoluteDifference > 10 && absoluteDifference <= 25);
  });
}

function shouldDelayPhotoBasedTheoreticalStock(itemName) {
  return Number.isFinite(granelDulceIngredientCoefficient(itemName)) && !inventoryPhotoApplied;
}

function buildTheoreticalInventoryModel(selectedDate, selectedShift) {
  const detailRows = inventoryDetailTableRows();
  const recipes = recipeRowsForTheoreticalStock();
  const productionByProduct = new Map();
  let consumptionByComponent = new Map();
  const counterUnits = currentCounterUnits(selectedShift);
  const recipeProductKeys = new Set(recipes.map((recipe) => normalizeCategory(recipe.productName)));

  detailRows.forEach((row) => {
    const itemKey = normalizeCategory(row.itemName);
    if (shouldDelayPhotoBasedTheoreticalStock(row.itemName)) return;
    if (isNeutralTheoreticalStockItem(row.itemName)) return;
    if (!recipeProductKeys.has(itemKey) && !isBarraPopName(row.itemName)) return;

    const sales = orderDetailsUnitsForDateAndProduct(selectedDate, row.itemName);
    const previousStock = initialDetailStockForShift(row.element, selectedShift);
    const currentStock = currentDetailStockForShift(row.element, selectedShift);
    let produced = NaN;

    if (isBarraPopName(row.itemName) && Number.isFinite(counterUnits)) {
      produced = counterUnits;
    } else if (Number.isFinite(previousStock) && Number.isFinite(currentStock)) {
      produced = currentStock - previousStock + sales;
    }

    if (Number.isFinite(produced)) productionByProduct.set(itemKey, produced);
  });

  applyNeutralIntermediateProduction(detailRows, recipes, productionByProduct, selectedShift);

  for (let index = 0; index < 3; index += 1) {
    consumptionByComponent = buildRecipeConsumptionByComponent(recipes, productionByProduct);
    detailRows.forEach((row) => {
      const itemKey = normalizeCategory(row.itemName);
      if (shouldDelayPhotoBasedTheoreticalStock(row.itemName)) return;
      if (isNeutralTheoreticalStockItem(row.itemName)) {
        return;
      }
      if (!recipeProductKeys.has(itemKey) || isBarraPopName(row.itemName)) return;

      const previousStock = initialDetailStockForShift(row.element, selectedShift);
      const currentStock = currentDetailStockForShift(row.element, selectedShift);
      if (!Number.isFinite(previousStock) || !Number.isFinite(currentStock)) return;

      const factor = theoreticalRecipeUnitFactor(row.itemName);
      const sales = orderDetailsUnitsForDateAndProduct(selectedDate, row.itemName);
      const consumedByParents = (consumptionByComponent.get(itemKey) || 0) / factor;
      productionByProduct.set(itemKey, currentStock - previousStock + sales + consumedByParents);
    });
    applyNeutralIntermediateProduction(detailRows, recipes, productionByProduct, selectedShift);
  }
  consumptionByComponent = buildRecipeConsumptionByComponent(recipes, productionByProduct);

  const rows = detailRows.map((row) => {
    const itemKey = normalizeCategory(row.itemName);
    const previousStock = initialDetailStockForShift(row.element, selectedShift);
    const currentStock = currentDetailStockForShift(row.element, selectedShift);
    const sales = orderDetailsUnitsForDateAndProduct(selectedDate, row.itemName);
    const factor = theoreticalRecipeUnitFactor(row.itemName);
    const producedRaw = productionByProduct.get(itemKey);
    const consumedRaw = consumptionByComponent.get(itemKey) || 0;
    const producedStock = Number.isFinite(producedRaw) ? producedRaw / factor : 0;
    const consumedStock = consumedRaw / factor;
    const missing = [];
    const specialStock = specialTheoreticalStockForRow(row, detailRows, selectedDate, counterUnits, selectedShift);

    if (specialStock) {
      return {
        ...row,
        selectedShift,
        previousStock: specialStock.previousStock,
        producedStock: specialStock.producedStock,
        consumedStock: specialStock.consumedStock,
        sales: specialStock.sales,
        theoreticalStock: specialStock.theoreticalStock,
        missing: specialStock.missing
      };
    }

    if (isNeutralTheoreticalStockItem(row.itemName)) {
      return {
        ...row,
        selectedShift,
        previousStock,
        producedStock: 0,
        consumedStock: 0,
        sales,
        theoreticalStock: currentStock,
        missing: Number.isFinite(currentStock) ? [] : [`stock actual ${row.itemName}`]
      };
    }

    if (!Number.isFinite(previousStock)) missing.push(`stock anterior ${row.itemName}`);
    const needsCounterDrivenConsumption = requiresCounterDrivenConsumption(row.itemName, recipes);
    if (needsCounterDrivenConsumption && !Number.isFinite(counterUnits)) {
      missing.push("Contador alipack actual");
    }
    const theoreticalStock = Number.isFinite(previousStock)
      && !(needsCounterDrivenConsumption && !Number.isFinite(counterUnits))
      ? previousStock + producedStock - sales - consumedStock
      : NaN;

    return {
      ...row,
      selectedShift,
      previousStock,
      producedStock,
      consumedStock,
      sales,
      theoreticalStock,
      missing
    };
  });

  return {
    selectedShift,
    counterUnits,
    recipesApplied: recipes.length,
    rows,
    highlightedRows: rows
      .filter((row) => Number.isFinite(row.theoreticalStock) && (row.consumedStock || row.producedStock || row.sales))
      .slice(0, 12)
  };
}

function requiresCounterDrivenConsumption(itemName, recipes) {
  const itemKey = normalizeCategory(itemName);
  return recipes.some((recipe) =>
    normalizeCategory(recipe.productName) === "granel dulce"
    && normalizeCategory(recipe.componentName) === itemKey
  );
}

function applyNeutralIntermediateProduction(detailRows, recipes, productionByProduct, selectedShift) {
  detailRows
    .filter((row) => isNeutralTheoreticalStockItem(row.itemName))
    .forEach((row) => {
      const itemKey = normalizeCategory(row.itemName);
      const consumedByParents = recipes
        .filter((recipe) => normalizeCategory(recipe.componentName) === itemKey)
        .reduce((total, recipe) => {
          const parentProduced = productionByProduct.get(normalizeCategory(recipe.productName));
          return Number.isFinite(parentProduced) ? total + (parentProduced * recipe.quantity) : total;
        }, 0);
      const previousStock = initialDetailStockForShift(row.element, selectedShift);
      const currentStock = currentDetailStockForShift(row.element, selectedShift);
      const stockDelta = Number.isFinite(previousStock) && Number.isFinite(currentStock)
        ? currentStock - previousStock
        : 0;

      if (consumedByParents > 0 || stockDelta !== 0) {
        productionByProduct.set(itemKey, consumedByParents + stockDelta);
      }
    });
}

function buildRecipeConsumptionByComponent(recipes, productionByProduct) {
  const consumptionByComponent = new Map();
  recipes.forEach((recipe) => {
    const produced = productionByProduct.get(normalizeCategory(recipe.productName));
    if (!Number.isFinite(produced)) return;
    const componentKey = normalizeCategory(recipe.componentName);
    consumptionByComponent.set(componentKey, (consumptionByComponent.get(componentKey) || 0) + (produced * recipe.quantity));
  });
  return consumptionByComponent;
}

function specialTheoreticalStockForRow(row, detailRows, selectedDate, counterUnits, selectedShift) {
  const itemName = normalizeCategory(row.itemName);
  const granelIngredientCoefficient = granelDulceIngredientCoefficient(itemName);
  if (Number.isFinite(granelIngredientCoefficient)) {
    return specialGranelIngredientTheoreticalStock(row, detailRows, counterUnits, granelIngredientCoefficient, selectedShift);
  }
  if (itemName === "bobina barra pop") {
    return specialBobinaBarraPopTheoreticalStock(row, counterUnits, selectedShift);
  }
  if (itemName === "caja 140") {
    return specialCaja140TheoreticalStock(row, detailRows, selectedDate, selectedShift);
  }
  if (itemName === "barra pop") {
    return specialBarraPopTheoreticalStock(row, detailRows, selectedDate, counterUnits, selectedShift);
  }
  if (itemName !== "barra pop 140ud") return null;

  const bagRow = detailRows.find((detailRow) => isBarraPopName(detailRow.itemName));
  const previousStock = initialDetailStockForShift(row.element, selectedShift);
  const previousBagStock = bagRow ? initialDetailStockForShift(bagRow.element, selectedShift) : NaN;
  const currentBagStock = bagRow ? currentDetailStockForShift(bagRow.element, selectedShift) : NaN;
  const sales = orderDetailsUnitsForDateAndProduct(selectedDate, row.itemName);
  const missing = [];

  if (!Number.isFinite(previousStock)) missing.push("stock anterior Barra_Pop_140Ud");
  if (!Number.isFinite(previousBagStock)) missing.push("stock anterior Barra_Pop");
  if (!Number.isFinite(currentBagStock)) missing.push("stock actual Barra_Pop");
  if (!Number.isFinite(counterUnits)) missing.push("Contador alipack actual");

  const theoreticalStock = missing.length
    ? NaN
    : previousStock - sales + ((previousBagStock * 2000) - (currentBagStock * 2000) + counterUnits) / 140;

  return {
    previousStock,
    producedStock: Number.isFinite(previousBagStock) && Number.isFinite(currentBagStock) && Number.isFinite(counterUnits)
      ? ((previousBagStock - currentBagStock) * 2000 + counterUnits) / 140
      : NaN,
    consumedStock: 0,
    sales,
    theoreticalStock,
    missing
  };
}

function specialGranelIngredientTheoreticalStock(row, detailRows, counterUnits, coefficient, selectedShift) {
  const granelRow = detailRows.find((detailRow) => isNeutralTheoreticalStockItem(detailRow.itemName));
  const previousStock = initialDetailStockForShift(row.element, selectedShift);
  const previousGranelStock = granelRow ? initialDetailStockForShift(granelRow.element, selectedShift) : NaN;
  const currentGranelStock = granelRow ? currentDetailStockForShift(granelRow.element, selectedShift) : NaN;
  const missing = [];

  if (!inventoryPhotoApplied) missing.push("foto de inventario aplicada");
  if (!Number.isFinite(previousStock)) missing.push(`stock anterior ${row.itemName}`);
  if (!Number.isFinite(counterUnits)) missing.push("Contador alipack actual");
  if (!Number.isFinite(previousGranelStock)) missing.push("stock anterior Granel Dulce");
  if (!Number.isFinite(currentGranelStock)) missing.push("stock actual Granel Dulce");

  const granelProduced = Number.isFinite(counterUnits)
    && Number.isFinite(previousGranelStock)
    && Number.isFinite(currentGranelStock)
    ? (counterUnits * 0.0165) + (currentGranelStock - previousGranelStock)
    : NaN;
  const consumedStock = Number.isFinite(granelProduced) ? granelProduced * coefficient : NaN;

  return {
    previousStock,
    producedStock: 0,
    consumedStock,
    sales: 0,
    theoreticalStock: missing.length ? NaN : previousStock - consumedStock,
    missing
  };
}

function specialBobinaBarraPopTheoreticalStock(row, counterUnits, selectedShift) {
  const previousStock = initialDetailStockForShift(row.element, selectedShift);
  const missing = [];

  if (!Number.isFinite(previousStock)) missing.push("stock anterior Bobina_Barra_Pop");
  if (!Number.isFinite(counterUnits)) missing.push("Contador alipack actual");

  const consumedStock = Number.isFinite(counterUnits) ? counterUnits / 5212 : NaN;
  return {
    previousStock,
    producedStock: 0,
    consumedStock,
    sales: 0,
    theoreticalStock: missing.length ? NaN : previousStock - consumedStock,
    missing
  };
}

function specialCaja140TheoreticalStock(row, detailRows, selectedDate, selectedShift) {
  const previousStock = initialDetailStockForShift(row.element, selectedShift);
  const targetBoxesProduced = barraPop140ProducedBoxes(detailRows, selectedDate, selectedShift);
  const missing = [];

  if (!Number.isFinite(previousStock)) missing.push("stock anterior Caja_140");
  if (!Number.isFinite(targetBoxesProduced)) missing.push("produccion Barra_Pop_140Ud");

  const consumedStock = Number.isFinite(targetBoxesProduced) ? targetBoxesProduced / 25 : NaN;
  return {
    previousStock,
    producedStock: 0,
    consumedStock,
    sales: 0,
    theoreticalStock: missing.length ? NaN : previousStock - consumedStock,
    missing
  };
}

function specialBarraPopTheoreticalStock(row, detailRows, selectedDate, counterUnits, selectedShift) {
  const targetRow = detailRows.find((detailRow) => normalizeCategory(detailRow.itemName) === "barra pop 140ud");
  const previousStock = initialDetailStockForShift(row.element, selectedShift);
  const previousTargetStock = targetRow ? initialDetailStockForShift(targetRow.element, selectedShift) : NaN;
  const currentTargetStock = targetRow ? currentDetailStockForShift(targetRow.element, selectedShift) : NaN;
  const targetSales = orderDetailsUnitsForDateAndProduct(selectedDate, "Barra_Pop_140Ud");
  const missing = [];

  if (!Number.isFinite(previousStock)) missing.push("stock anterior Barra_Pop");
  if (!Number.isFinite(counterUnits)) missing.push("Contador alipack actual");
  if (!Number.isFinite(previousTargetStock)) missing.push("stock anterior Barra_Pop_140Ud");
  if (!Number.isFinite(currentTargetStock)) missing.push("stock actual Barra_Pop_140Ud");

  const targetBoxesProduced = barraPop140ProducedBoxes(detailRows, selectedDate, selectedShift);
  const theoreticalStock = missing.length
    ? NaN
    : previousStock + ((counterUnits - (targetBoxesProduced * 140)) / 2000);

  return {
    previousStock,
    producedStock: Number.isFinite(counterUnits) ? counterUnits / 2000 : NaN,
    consumedStock: Number.isFinite(targetBoxesProduced) ? (targetBoxesProduced * 140) / 2000 : NaN,
    sales: 0,
    theoreticalStock,
    missing
  };
}

function barraPop140ProducedBoxes(detailRows, selectedDate, selectedShift) {
  const targetRow = detailRows.find((detailRow) => normalizeCategory(detailRow.itemName) === "barra pop 140ud");
  if (!targetRow) return NaN;

  const previousTargetStock = initialDetailStockForShift(targetRow.element, selectedShift);
  const currentTargetStock = currentDetailStockForShift(targetRow.element, selectedShift);
  const targetSales = orderDetailsUnitsForDateAndProduct(selectedDate, "Barra_Pop_140Ud");
  return Number.isFinite(previousTargetStock) && Number.isFinite(currentTargetStock)
    ? currentTargetStock - previousTargetStock + targetSales
    : NaN;
}

function inventoryDetailTableRows() {
  return [...els["inventory-detail-body"].querySelectorAll("tr[data-item-id]")].map((element) => ({
    element,
    itemId: element.dataset.itemId || "",
    itemName: element.dataset.itemName || element.children[2]?.textContent?.trim() || ""
  }));
}

function recipeRowsForTheoreticalStock() {
  return (state.recipes || []).filter((recipe) =>
    recipe.productName
    && recipe.componentName
    && Number.isFinite(recipe.quantity)
    && recipe.quantity > 0
  );
}

function currentCounterUnits(shift = firstSelectedInventoryShift()) {
  const manualCounter = manualCounterUnitsForShift(shift);
  if (Number.isFinite(manualCounter)) return manualCounter;

  const counterRow = findInventoryDetailRowByName("Contador alipack");
  const currentCounter = counterRow ? currentDetailStockForShift(counterRow, shift) : NaN;
  return Number.isFinite(currentCounter) ? currentCounter : counterFromLastPhotoTranscription(shift);
}

function manualCounterUnitsForShift(shift) {
  const inputId = {
    morning: "inventory-counter-manual-morning",
    afternoon: "inventory-counter-manual-afternoon",
    dawn: "inventory-counter-manual-dawn"
  }[shift];
  if (!inputId) return NaN;
  const value = els[inputId]?.value || "";
  return String(value).trim() ? parseQuantity(value) : NaN;
}

function clearManualCounterCorrections() {
  ["inventory-counter-manual-morning", "inventory-counter-manual-afternoon", "inventory-counter-manual-dawn"].forEach((id) => {
    if (els[id]) els[id].value = "";
  });
}

function updateInventoryCounterReview() {
  const hasDetailRows = Boolean(els["inventory-detail-body"]?.querySelector("tr[data-item-id]"));
  if (!hasDetailRows) return;

  updateCounterReviewField("afternoon");
  updateCounterReviewField("morning");
  updateCounterReviewField("dawn");
  renderCounterTheoreticalComparison("afternoon");
  renderCounterTheoreticalComparison("morning");
  renderCounterTheoreticalComparison("dawn");
}

function updateCounterReviewField(shift) {
  const manualId = {
    morning: "inventory-counter-manual-morning",
    afternoon: "inventory-counter-manual-afternoon",
    dawn: "inventory-counter-manual-dawn"
  }[shift];
  const manualInput = els[manualId];
  const aiCounter = counterFromLastPhotoTranscription(shift);
  const rowCounter = currentCounterFromDetailRow(shift);
  const visibleCounter = Number.isFinite(aiCounter) ? aiCounter : rowCounter;
  const shiftEnabled = isInventoryShiftEnabled(shift);

  if (manualInput) {
    manualInput.disabled = !shiftEnabled;
    manualInput.placeholder = Number.isFinite(visibleCounter) ? formatRoundedNumber(visibleCounter) : "-";
    if (!shiftEnabled) {
      manualInput.value = "";
      manualInput.dataset.autoValue = "";
      return;
    }
    const autoValue = Number.isFinite(visibleCounter) ? String(visibleCounter) : "";
    if (!manualInput.value || manualInput.value === manualInput.dataset.autoValue) {
      manualInput.value = autoValue;
    }
    manualInput.dataset.autoValue = autoValue;
  }
}

function currentCounterFromDetailRow(shift) {
  const counterRow = findInventoryDetailRowByName("Contador alipack");
  return counterRow ? currentDetailStockForShift(counterRow, shift) : NaN;
}

function syncManualCounterCorrection(inputId) {
  const shift = {
    "inventory-counter-manual-morning": "morning",
    "inventory-counter-manual-afternoon": "afternoon",
    "inventory-counter-manual-dawn": "dawn"
  }[inputId];
  const counterRow = findInventoryDetailRowByName("Contador alipack");
  const input = shift && counterRow ? counterRow.querySelector(`[data-detail-field="${shift}"]`) : null;
  const manualValue = els[inputId]?.value || "";
  if (!input || !String(manualValue).trim()) return;
  input.value = manualValue;
}

function renderCounterTheoreticalComparison(shift) {
  const theoreticalCell = els[`inventory-counter-theoretical-${shift}`];
  const diffCell = els[`inventory-counter-diff-${shift}`];
  const input = els[`inventory-counter-manual-${shift}`];
  [theoreticalCell, diffCell, input].forEach((element) => {
    element?.classList.remove("stock-diff-yellow", "stock-diff-orange", "stock-diff-red");
  });
  if (!theoreticalCell || !diffCell || !input) return;

  const theoreticalCounter = theoreticalCounterUnitsForShift(shift);
  const roundedTheoreticalCounter = roundedNumberValue(theoreticalCounter);
  const loadedCounter = manualCounterUnitsForShift(shift);
  if (!Number.isFinite(theoreticalCounter)) {
    theoreticalCell.textContent = "-";
    diffCell.textContent = "-";
    theoreticalCell.title = "Faltan stocks para calcular el contador teorico.";
    diffCell.title = "";
    return;
  }

  theoreticalCell.textContent = formatRoundedNumber(theoreticalCounter);
  theoreticalCell.title = "Ventas + diferencia Barra_Pop_140Ud x 140 + diferencia Barra_Pop x 2000";
  if (!Number.isFinite(loadedCounter) || !Number.isFinite(roundedTheoreticalCounter) || roundedTheoreticalCounter === 0) {
    diffCell.textContent = "-";
    diffCell.title = "Falta contador cargado para comparar.";
    return;
  }

  const differencePercent = ((loadedCounter - roundedTheoreticalCounter) / roundedTheoreticalCounter) * 100;
  diffCell.textContent = formatRoundedPercentValue(differencePercent);
  diffCell.title = `Teorico redondeado: ${formatRoundedNumber(theoreticalCounter)} | Teorico real: ${formatNumber(theoreticalCounter)} | Cargado: ${formatNumber(loadedCounter)}`;
  markTheoreticalStockDifferenceLevel([input, theoreticalCell, diffCell], differencePercent);
}

function theoreticalCounterUnitsForShift(shift) {
  const targetRow = findInventoryDetailRowByName("Barra_Pop_140Ud");
  const bagRow = findInventoryDetailRowByName("Barra_Pop");
  if (!targetRow || !bagRow) return NaN;

  const previousTargetStock = initialDetailStockForShift(targetRow, shift);
  const currentTargetStock = currentDetailStockForShift(targetRow, shift);
  const previousBagStock = initialDetailStockForShift(bagRow, shift);
  const currentBagStock = currentDetailStockForShift(bagRow, shift);
  if (![previousTargetStock, currentTargetStock, previousBagStock, currentBagStock].every(Number.isFinite)) {
    return NaN;
  }

  const sales = orderDetailsUnitsForDateAndProduct(els["inventory-date-input"]?.value || "", "Barra_Pop_140Ud");
  return sales
    + ((currentTargetStock - previousTargetStock) * 140)
    + ((currentBagStock - previousBagStock) * 2000);
}

function isBarraPopName(itemName) {
  return normalizeCategory(itemName) === "barra pop";
}

function isNeutralTheoreticalStockItem(itemName) {
  return normalizeCategory(itemName) === "granel dulce";
}

function theoreticalRecipeUnitFactor(itemName) {
  return isBarraPopName(itemName) ? 2000 : 1;
}

function granelDulceIngredientCoefficient(itemName) {
  return {
    "maiz pisingallo": 1.285,
    azucar: 0.143,
    aceite: 0.186,
    "escencia de vainilla": 0.007,
    "esencia de vainilla": 0.007
  }[normalizeCategory(itemName)] ?? NaN;
}

function markTheoreticalStockMissing(cell, message) {
  if (!cell) return;
  cell.textContent = "-";
  cell.classList.remove("missing-theoretical-stock");
  cell.title = message;
}

function findInventoryDetailRowByName(itemName) {
  const targetName = normalizeCategory(itemName);
  return [...els["inventory-detail-body"].querySelectorAll("tr[data-item-id]")]
    .find((row) => normalizeCategory(row.dataset.itemName || "") === targetName) || null;
}

function previousDetailStock(row) {
  return firstFiniteQuantity([
    row.dataset.previousAfternoon,
    row.dataset.previousMorning,
    row.dataset.previousDawn
  ]);
}

function initialDetailStockForShift(row, shift) {
  const previousWorkedShift = previousWorkedInventoryShift(shift);
  if (previousWorkedShift) return currentDetailStockForShift(row, previousWorkedShift);
  return previousDetailStock(row);
}

function previousWorkedInventoryShift(shift) {
  const shiftOrder = ["dawn", "morning", "afternoon"];
  const selected = new Set(selectedInventoryShifts());
  const shiftIndex = shiftOrder.indexOf(shift);
  if (shiftIndex <= 0) return "";

  for (let index = shiftIndex - 1; index >= 0; index -= 1) {
    if (selected.has(shiftOrder[index])) return shiftOrder[index];
  }
  return "";
}

function currentDetailStockForShift(row, shift) {
  if (!shift) return NaN;
  const value = detailInputValue(row, shift);
  if (!String(value).trim()) return NaN;
  return parseQuantity(value);
}

function firstFiniteQuantity(values) {
  for (const value of values) {
    const quantity = parseQuantity(value);
    if (Number.isFinite(quantity) && String(value ?? "").trim() !== "") return quantity;
  }
  return NaN;
}

function orderDetailsUnitsForDateAndProduct(dateIso, productName) {
  const targetProduct = normalizeCategory(productName);
  return state.orderDetails
    .filter((detail) => detail.date === dateIso && normalizeCategory(detail.product) === targetProduct)
    .reduce((total, detail) => total + detail.individualQuantity, 0);
}

function counterFromLastPhotoTranscription(shift = firstSelectedInventoryShift()) {
  if (!lastInventoryPhotoTranscription?.rows?.length) return NaN;
  if (!shift) return NaN;
  const counterRow = lastInventoryPhotoTranscription.rows.find((row) =>
    isCounterAlipackName(row.itemName || row.name || row.product || "")
  );
  if (!counterRow) return NaN;

  return firstFiniteQuantity([
    inventoryTranscriptionShiftValue(counterRow, shift),
    counterRow[shift],
    shift === "afternoon" ? counterRow.turnoTarde : "",
    shift === "morning" ? counterRow.turnoManana : "",
    shift === "dawn" ? counterRow.turnoMadrugada : ""
  ]);
}

function isCounterAlipackName(value) {
  const normalized = normalizeCategory(value);
  return normalized.includes("contador") && normalized.includes("alipack");
}

function renderTheoreticalStockBreakdown(data) {
  const panel = document.getElementById("theoretical-stock-breakdown");
  if (!panel) return;

  if (!data) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }

  panel.hidden = false;
  const selectedShiftLabel = inventoryShiftLabel(data.selectedShift);
  const rows = Array.isArray(data.highlightedRows) ? data.highlightedRows : [];
  panel.innerHTML = `
    <div class="theoretical-stock-title">Stock teorico</div>
    <div class="theoretical-stock-grid">
      <span>Turno usado</span><strong>${escapeHtml(selectedShiftLabel || "-")}</strong>
      <span>Contador alipack</span><strong>${formatNullableNumber(data.counterUnits)}</strong>
      <span>Recetas aplicadas</span><strong>${formatNumber(data.recipesApplied || 0)}</strong>
    </div>
    ${rows.length ? `
      <div class="table-wrap theoretical-stock-table-wrap">
        <table class="data-entry-table theoretical-stock-table">
          <thead>
            <tr>
              <th>Item</th>
              <th class="num">Anterior</th>
              <th class="num">Produccion</th>
              <th class="num">Ventas</th>
              <th class="num">Consumo recetas</th>
              <th class="num">Teorico</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => `
              <tr>
                <td>${escapeHtml(row.itemName)}</td>
                <td class="num">${formatNullableNumber(row.previousStock)}</td>
                <td class="num">${formatNullableNumber(row.producedStock)}</td>
                <td class="num">${formatNullableNumber(row.sales)}</td>
                <td class="num">${formatNullableNumber(row.consumedStock)}</td>
                <td class="num">${formatNullableNumber(row.theoreticalStock)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    ` : ""}
    ${data.missing?.length ? `<div class="theoretical-stock-missing">Falta: ${escapeHtml(data.missing.join(", "))}</div>` : ""}
  `;
}

function inventoryShiftLabel(field) {
  return {
    dawn: "Madrugada",
    morning: "Mañana",
    afternoon: "Tarde"
  }[field] || "";
}

function formatNullableNumber(value) {
  return Number.isFinite(value) ? formatNumber(value) : "-";
}

function renderInventoryPhotoTranscription(transcription) {
  const panel = els["inventory-photo-transcription"];
  if (!panel) return;

  if (!transcription) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }

  const columns = inventoryTranscriptionColumns(transcription);
  const rows = Array.isArray(transcription.rows) ? transcription.rows : [];

  panel.hidden = false;
  panel.innerHTML = `
    <div class="photo-transcription-header">
      <div>
        <h3>Tabla transcripta desde la foto</h3>
        <span>Valores leídos antes de aplicar la fecha seleccionada</span>
      </div>
      <span>${rows.length} filas · ${columns.length} columnas físicas</span>
    </div>
    <div class="table-wrap">
      <table class="data-entry-table photo-transcription-table">
        <thead>
          <tr>
            <th>Id Item</th>
            <th>Nombre Item</th>
            ${columns.map((column) => `
              <th class="num">
                ${escapeHtml(column.dateLabel)}
                <span>${column.shift ? "" : column.physical ? escapeHtml(column.key) : `${column.subcolumnCount} col.`}</span>
              </th>
            `).join("")}
          </tr>
        </thead>
        <tbody>
          ${rows.length && columns.length
            ? rows.map((row) => inventoryTranscriptionRow(row, columns)).join("")
            : emptyRow(Math.max(columns.length + 2, 3), "La foto no devolvió filas transcritas.")}
        </tbody>
      </table>
    </div>
  `;
}

function inventoryTranscriptionColumns(transcription) {
  if (transcription.format === "single_date_shifts" || Array.isArray(transcription.shiftColumns)) {
    return [
      { key: "dawn", dateLabel: "Turno Madrugada", shift: true },
      { key: "morning", dateLabel: "Turno Mañana", shift: true },
      { key: "afternoon", dateLabel: "Turno Tarde", shift: true }
    ];
  }

  if (Array.isArray(transcription.physicalColumns) && transcription.physicalColumns.length) {
    return transcription.physicalColumns.map((column, index) => ({
      key: column.key || `c${index + 1}`,
      dateLabel: column.dateLabel || `Col. ${index + 1}`,
      subcolumnCount: 1,
      physical: true
    }));
  }

  const byLabel = new Map();
  (Array.isArray(transcription.columns) ? transcription.columns : []).forEach((column) => {
    const label = String(column.dateLabel || "").trim();
    if (!label) return;
    byLabel.set(label, {
      dateLabel: label,
      subcolumnCount: Number(column.subcolumnCount) || 1
    });
  });

  (Array.isArray(transcription.rows) ? transcription.rows : []).forEach((row) => {
    Object.entries(row.valuesByDate || {}).forEach(([label, values]) => {
      const cleanLabel = String(label || "").trim();
      if (!cleanLabel || byLabel.has(cleanLabel)) return;
      byLabel.set(cleanLabel, {
        dateLabel: cleanLabel,
        subcolumnCount: Array.isArray(values) ? values.length : 1
      });
    });
  });

  return [...byLabel.values()];
}

function inventoryTranscriptionRow(row, columns) {
  return `
    <tr>
      <td>${escapeHtml(row.itemId || "")}</td>
      <td>${escapeHtml(row.itemName || row.name || "")}</td>
      ${columns.map((column) => {
        const values = column.shift
          ? [inventoryTranscriptionShiftValue(row, column.key)]
          : column.physical
          ? [inventoryTranscriptionColumnValue(row, column.key)]
          : inventoryTranscriptionValues(row, column.dateLabel);
        return `<td class="num">${escapeHtml(values.join(" | "))}</td>`;
      }).join("")}
    </tr>
  `;
}

function inventoryTranscriptionShiftValue(row, shiftKey) {
  const indexByShift = { dawn: 0, morning: 1, afternoon: 2 };
  if (Array.isArray(row?.shiftValues)) {
    return String(row.shiftValues[indexByShift[shiftKey]] ?? "");
  }
  return String(row?.[shiftKey] ?? "");
}

function inventoryTranscriptionColumnValue(row, columnKey) {
  if (!row?.valuesByColumn || typeof row.valuesByColumn !== "object") return "";
  return String(row.valuesByColumn[columnKey] ?? "");
}

function inventoryTranscriptionValues(row, dateLabel) {
  const valuesByDate = row.valuesByDate || {};
  const entry = Object.entries(valuesByDate)
    .find(([label]) => normalizeSearchText(label) === normalizeSearchText(dateLabel));
  return Array.isArray(entry?.[1]) ? entry[1].map((value) => String(value ?? "")) : [];
}

function findDetailTableRow(photoRow) {
  const itemId = String(photoRow.itemId || "").trim();
  if (itemId) {
    const byId = els["inventory-detail-body"].querySelector(`tr[data-item-id="${CSS.escape(itemId)}"]`);
    if (byId) return byId;
  }

  const photoName = normalizeSearchText(photoRow.itemName || photoRow.name || "");
  if (!photoName) return null;

  return [...els["inventory-detail-body"].querySelectorAll("tr[data-item-id]")]
    .find((row) => normalizeSearchText(row.children[2]?.textContent || "") === photoName) || null;
}

function normalizePhotoQuantity(value) {
  const text = String(value ?? "").trim().replace(",", ".");
  if (!text || text === "-" || text === "—") return "";
  return text;
}

async function imageFileToDataUrl(file) {
  const dataUrl = await fileToDataUrl(file);
  const image = await loadImage(dataUrl);
  const maxSide = 2400;
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.92);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

async function submitInventoryDetail(event) {
  event.preventDefault();

  const date = els["inventory-date-input"].value;
  const employee = els["inventory-employee-input"].value.trim();
  if (!date) {
    setInventoryDetailStatus("Ingresa la fecha del inventario.", "error");
    return;
  }

  if (!employee) {
    setInventoryDetailStatus("Ingresa un empleado responsable.", "error");
    return;
  }

  if (!inventoryDetailTemplate?.rows?.length) {
    setInventoryDetailStatus("Primero preparĂˇ el detalle.", "error");
    return;
  }

  if (!selectedInventoryShifts().length) {
    setInventoryDetailStatus("Marcá al menos un turno realizado antes de enviar.", "error");
    return;
  }

  const rows = collectEditableInventoryDetailRows();

  const button = els["inventory-detail-submit"];
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Enviando...";
  setInventoryDetailStatus("Enviando inventario y detalle a Google Sheets...", "pending");

  try {
    const response = await fetch(`${API_BASE_URL}/api/inventory/full-entry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date,
        employee,
        inventoryId: inventoryDetailTemplate.inventoryId,
        selectedShifts: selectedInventoryShifts(),
        rows
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);

    renderInventoryDetailTemplate(null);
    initializeInventoryEntryDefaults({ force: true });
    setInventoryDetailStatus(`Inventario completo enviado: ${payload.rowsWritten} filas de detalle.`, "success");
  } catch (error) {
    setInventoryDetailStatus(`No se pudo enviar el inventario completo: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function collectEditableInventoryDetailRows() {
  return [...els["inventory-detail-body"].querySelectorAll(":scope > tr[data-item-id]")].map((row) => ({
    itemId: row.dataset.itemId,
    afternoon: isInventoryShiftEnabled("afternoon") ? detailInputValue(row, "afternoon") : "",
    morning: isInventoryShiftEnabled("morning") ? detailInputValue(row, "morning") : "",
    dawn: isInventoryShiftEnabled("dawn") ? detailInputValue(row, "dawn") : ""
  }));
}

function detailInputValue(row, field) {
  return row.querySelector(`[data-detail-field="${field}"]`)?.value.trim() || "";
}

function updateInventoryPurchaseAlerts() {
  const rows = els["inventory-detail-body"]?.querySelectorAll("tr[data-item-id]") || [];
  const thresholdRows = [];
  rows.forEach((row) => {
    const itemName = row.dataset.itemName || "";
    const alert = row.querySelector("[data-purchase-alert]");
    if (!alert) return;

    const data = purchaseAlertDataForItem(row, itemName);
    if (isPurchasableInventoryItem(itemName)) thresholdRows.push({ itemName, data, row });
    alert.hidden = !data;
    alert.classList.toggle("is-visible", Boolean(data));
    if (data) {
      alert.title = `Stock: ${formatNumber(data.stock)} | Minimo: ${formatNumber(data.required)} | Proveedor: ${data.provider} | Entrega: ${data.leadDays} dias corridos / ${data.businessDays} dias habiles`;
      const button = alert.querySelector("button");
      if (button) {
        button.dataset.purchaseItem = itemName;
        button.dataset.purchaseItemId = row.dataset.itemId || "";
      }
    }
  });
  renderPurchaseThresholdTable(thresholdRows);
}

function purchaseAlertDataForItem(row, itemName) {
  const dailyConsumption = purchaseDailyConsumption(itemName);
  if (!isPurchasableInventoryItem(itemName) || !dailyConsumption) return null;

  const provider = lastPurchaseProviderForItem(itemName);
  const leadDays = providerLeadDays(provider);
  if (!provider || !leadDays) return null;

  const stock = currentInventoryRowStock(row);
  if (!Number.isFinite(stock)) return null;

  const businessDays = purchaseBusinessDaysWithinLeadTime(leadDays);
  const required = dailyConsumption * businessDays;
  if (stock >= required) return null;
  return { stock, required, provider, leadDays, businessDays, dailyConsumption };
}

function purchaseThresholdInfoForItem(row, itemName) {
  if (!isPurchasableInventoryItem(itemName)) return null;
  const dailyConsumption = purchaseDailyConsumption(itemName);
  const provider = lastPurchaseProviderForItem(itemName);
  const leadDays = providerLeadDays(provider);
  const businessDays = leadDays ? purchaseBusinessDaysWithinLeadTime(leadDays) : 0;
  const stock = currentInventoryRowStock(row);
  const required = provider && leadDays ? dailyConsumption * businessDays : NaN;
  return {
    itemName,
    stock,
    provider,
    leadDays,
    businessDays,
    dailyConsumption,
    required,
    shouldBuy: Number.isFinite(stock) && Number.isFinite(required) && stock < required
  };
}

function renderPurchaseThresholdTable(rows) {
  if (!els["purchase-threshold-body"]) return;
  const infos = rows
    .map(({ itemName, row }) => purchaseThresholdInfoForItem(row, itemName))
    .filter(Boolean);

  els["purchase-threshold-body"].innerHTML = infos.length
    ? infos.map((info) => `
      <tr>
        <td>${escapeHtml(info.itemName)}</td>
        <td class="num">${formatNullableNumber(info.stock)}</td>
        <td>${escapeHtml(info.provider || missingPurchaseProviderLabel())}</td>
        <td class="num">${formatLeadAndConsumptionDays(info)}</td>
        <td class="num">${formatNumber(info.dailyConsumption)}</td>
        <td class="num" title="${escapeHtml(formatStockMinimumFormula(info))}">${formatNullableNumber(info.required)}</td>
        <td><span class="purchase-threshold-state ${info.shouldBuy ? "is-low" : "is-ok"}">${info.shouldBuy ? "Comprar" : "OK"}</span></td>
      </tr>
    `).join("")
    : emptyRow(7, "No hay insumos comprables en el detalle preparado.");
}

function formatLeadAndConsumptionDays(info) {
  if (!info.leadDays) return "-";
  return `${formatNumber(info.leadDays)} corr. / ${formatNumber(info.businessDays)} hab.`;
}

function formatStockMinimumFormula(info) {
  if (!Number.isFinite(info.required)) return "";
  return `Stock minimo = ${formatNumber(info.dailyConsumption)} consumo diario x ${formatNumber(info.businessDays)} dias habiles`;
}

function purchaseBusinessDaysWithinLeadTime(leadDays) {
  const stockDate = els["inventory-date-input"]?.value || toIsoDate(new Date());
  return countInventoryConsumptionDays(stockDate, leadDays);
}

function countInventoryConsumptionDays(startIso, totalDays) {
  const start = dateFromIso(startIso);
  if (!start || Number.isNaN(start.getTime()) || !Number.isFinite(totalDays) || totalDays <= 0) return 0;

  let count = 0;
  for (let offset = 1; offset <= totalDays; offset += 1) {
    const date = addDays(start, offset);
    if (isInventoryConsumptionDate(date)) count += 1;
  }
  return count;
}

function isInventoryConsumptionDate(date) {
  return isBusinessDay(date);
}

function isBusinessDay(date) {
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  return !ARGENTINA_NON_WORKING_DAYS.has(toIsoDate(date));
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function currentInventoryRowStock(row) {
  const enabled = selectedInventoryShifts();
  const priority = ["afternoon", "morning", "dawn"].filter((shift) => enabled.includes(shift));
  for (const shift of priority) {
    const value = parseQuantity(row.querySelector(`[data-detail-field="${shift}"]`)?.value);
    if (Number.isFinite(value) && row.querySelector(`[data-detail-field="${shift}"]`)?.value.trim() !== "") return value;
  }
  return latestPreviousStockFromRow(row);
}

function latestPreviousStockFromRow(row) {
  for (const key of ["previousAfternoon", "previousMorning", "previousDawn"]) {
    const value = parseQuantity(row.dataset[key]);
    if (Number.isFinite(value) && String(row.dataset[key] || "").trim() !== "") return value;
  }
  return NaN;
}

function isPurchasableInventoryItem(itemName) {
  const key = normalizeInventoryToken(itemName);
  return Boolean(purchaseDailyConsumptionByKey()[key]);
}

function purchaseDailyConsumption(itemName) {
  return purchaseDailyConsumptionByKey()[normalizeInventoryToken(itemName)] || 0;
}

function purchaseDailyConsumptionByKey() {
  return {
    maizpisingallo: 496.65 * 1.285,
    azucar: 496.65 * 0.143,
    aceite: 496.65 * 0.186,
    escenciadevainilla: 496.65 * 0.007,
    esenciadevainilla: 496.65 * 0.007,
    bobinabarrapop: 30100 / 5212,
    caja140: 215 / 25
  };
}

function lastPurchaseProviderForItem(itemName) {
  const key = normalizeCategory(itemName);
  const details = [...(state.purchaseDetails || [])]
    .filter((row) => purchaseDetailMatchesItem(row, key))
    .sort((a, b) => purchaseDetailSortValue(b) - purchaseDetailSortValue(a));
  const detail = details.find((row) => row.supplier || row.id);
  if (!detail) return "";
  if (detail.supplier) return detail.supplier;
  return purchaseSupplierById(detail.id);
}

function purchaseDetailMatchesItem(row, itemKey) {
  const detailKey = normalizeCategory(row.itemName);
  if (!detailKey || !itemKey) return false;
  return detailKey === itemKey || detailKey.includes(itemKey) || itemKey.includes(detailKey);
}

function missingPurchaseProviderLabel() {
  if (!(state.purchaseDetails || []).length) return "Falta Detalle_Compras";
  if (!(state.purchases || []).length) return "Falta Compras";
  if (!(state.providers || []).length) return "Falta Proveedores";
  return "Sin proveedor";
}

function reconcilePurchaseDetailSuppliers() {
  if (!Array.isArray(state.purchaseDetails) || !state.purchaseDetails.length) return;
  state.purchaseDetails = state.purchaseDetails.map((row) => ({
    ...row,
    supplier: row.supplier || purchaseSupplierById(row.id)
  }));
}

function purchaseDetailSortValue(row) {
  const dateValue = row.date ? new Date(`${row.date}T00:00:00`).getTime() : 0;
  const idValue = Number(row.id) || 0;
  return dateValue + idValue;
}

function purchaseSupplierById(id) {
  const purchase = (state.purchases || []).find((row) => String(row.id) === String(id));
  return purchase?.supplier || "";
}

function lastPurchaseUnitForItem(itemName) {
  const key = normalizeCategory(itemName);
  const detail = [...(state.purchaseDetails || [])]
    .sort((a, b) => purchaseDetailSortValue(b) - purchaseDetailSortValue(a))
    .find((row) => normalizeCategory(row.itemName) === key && row.supplierUnit);
  return detail?.supplierUnit || "";
}

function inventoryUnitForItem(itemName) {
  const backendSupply = purchaseBackendOptions.supplies.find((row) => normalizeCategory(row.nombre) === normalizeCategory(itemName));
  if (backendSupply?.ud_receta) return backendSupply.ud_receta;
  const item = itemInfoForInventoryItem(itemName);
  if (item?.countUnit) return item.countUnit;
  const key = normalizeInventoryToken(itemName);
  return {
    maizpisingallo: "Kg",
    azucar: "Kg",
    aceite: "Lt",
    escenciadevainilla: "Kg",
    esenciadevainilla: "Kg",
    bobinabarrapop: "Rollo",
    caja140: "Pack_25_Ud"
  }[key] || "";
}

function itemInfoForInventoryItem(itemName) {
  const key = normalizeCategory(itemName);
  const backendSupply = purchaseBackendOptions.supplies.find((row) => normalizeCategory(row.nombre) === key);
  if (backendSupply) {
    return {
      itemId: String(backendSupply.id_insumo ?? "").trim(),
      itemName: backendSupply.nombre || "",
      countUnit: purchaseCountUnitForSupply(backendSupply),
      recipeUnitFactor: parseMoney(backendSupply.cantidad_receta) || 1
    };
  }
  return (state.itemInfo || []).find((row) => (
    normalizeCategory(row.itemName) === key
  )) || null;
}

function purchaseCountUnitForSupply(supply) {
  const supplyId = String(supply?.id_insumo ?? "").trim();
  const backendItem = purchaseBackendOptions.itemsBySupplyId.get(supplyId) || {};
  return backendItem.ud_conteo || supply?.ud_conteo || supply?.ud_receta || "";
}

function supplyInfoForPurchase(itemName, provider, supplierUnit = "") {
  const backendInfo = purchaseBackendSupplierInfo();
  if (backendInfo) return backendInfo;
  const itemKey = normalizeCategory(itemName);
  const providerKey = normalizeCategory(provider);
  const unitKey = normalizeCategory(supplierUnit);
  const rows = (state.supplyInfo || []).filter((row) => normalizeCategory(row.itemName) === itemKey);
  return rows.find((row) => providerNameMatches(row.supplier, providerKey))
    || rows.find((row) => normalizeCategory(row.supplierUnit) === unitKey)
    || rows[0]
    || null;
}

function recipeUnitsFromCountUnits(itemName, countQuantity) {
  const factor = itemInfoForInventoryItem(itemName)?.recipeUnitFactor;
  if (Number.isFinite(factor) && factor > 0) return countQuantity * factor;
  return countQuantity;
}

function roundedPurchaseOrder(itemName, missingStock, stockUnit, supplierUnit, provider) {
  if (!Number.isFinite(missingStock)) return { stockQuantity: "", supplierQuantity: "" };
  const supplyInfo = supplyInfoForPurchase(itemName, provider, supplierUnit);
  const recipeUnitFactor = itemInfoForInventoryItem(itemName)?.recipeUnitFactor || 1;
  const supplierRecipeQuantity = Number(supplyInfo?.recipeQuantity) || supplierUnitPackSize(supplierUnit);
  if (!supplierRecipeQuantity || !recipeUnitFactor) {
    const fallbackQuantity = Math.max(Math.ceil(missingStock), providerMinimumOrder(provider));
    return { stockQuantity: fallbackQuantity, supplierQuantity: "" };
  }

  const minimumSupplierQuantity = providerMinimumOrder(provider);
  const missingRecipeUnits = recipeUnitsFromCountUnits(itemName, missingStock);
  const baseSupplierQuantity = Math.max(
    Math.ceil(missingRecipeUnits / supplierRecipeQuantity),
    minimumSupplierQuantity
  );
  if (shouldPrettifyDirectSupplierUnit(supplierUnit)) {
    const prettySupplierQuantity = prettifyPurchaseQuantity(baseSupplierQuantity, supplierUnit);
    return {
      stockQuantity: (prettySupplierQuantity * supplierRecipeQuantity) / recipeUnitFactor,
      supplierQuantity: prettySupplierQuantity
    };
  }

  const baseStockQuantity = (baseSupplierQuantity * supplierRecipeQuantity) / recipeUnitFactor;
  const prettyStockQuantity = prettifyPurchaseQuantity(baseStockQuantity, stockUnit);
  const supplierQuantityFromStock = Math.ceil(recipeUnitsFromCountUnits(itemName, prettyStockQuantity) / supplierRecipeQuantity);
  return {
    stockQuantity: (supplierQuantityFromStock * supplierRecipeQuantity) / recipeUnitFactor,
    supplierQuantity: supplierQuantityFromStock
  };
}

function providerMinimumOrder(providerName) {
  const selectedMinimum = parseMoney(selectedPurchaseProvider()?.pedido_minimo);
  if (selectedMinimum) return selectedMinimum;
  const key = normalizeCategory(providerName);
  const provider = (state.providers || []).find((row) => providerNameMatches(row.name, key));
  return Number(provider?.minimumOrder) || 0;
}

function prettifyPurchaseQuantity(value, unit) {
  if (!Number.isFinite(value)) return "";
  const normalizedUnit = normalizeInventoryToken(unit);
  const maxValue = value * 1.15;
  const steps = ["kg", "lt"].includes(normalizedUnit)
    ? [1000, 500, 100, 50, 10, 5, 1]
    : [100, 50, 10, 5, 1];
  for (const step of steps) {
    const rounded = Math.ceil(value / step) * step;
    if (rounded <= maxValue) return rounded;
  }
  return Math.ceil(value);
}

function shouldPrettifyDirectSupplierUnit(unit) {
  return ["kg", "lt"].includes(normalizeInventoryToken(unit));
}

function supplierUnitPackSize(supplierUnit) {
  const text = String(supplierUnit || "");
  const match = text.match(/(?:^|_)(\d+(?:[.,]\d+)?)(?=kg|lt|ud|rollo|rollos|$)/i);
  if (!match) return 1;
  return parseQuantity(match[1]);
}

function providerLeadDays(providerName) {
  const selectedDays = Number(selectedPurchaseProvider()?.tiempo_estimado_entrega);
  if (selectedDays) return selectedDays;
  const key = normalizeCategory(providerName);
  const provider = (state.providers || []).find((row) => providerNameMatches(row.name, key));
  const configuredDays = Number(provider?.leadDays) || 0;
  if (configuredDays) return configuredDays;
  return purchaseLeadDaysFromHistory(providerName);
}

function providerNameMatches(candidateName, providerKey) {
  const candidateKey = normalizeCategory(candidateName);
  if (!candidateKey || !providerKey) return false;
  if (candidateKey === providerKey) return true;
  if (candidateKey.includes(providerKey) || providerKey.includes(candidateKey)) return true;
  return normalizedEditDistance(candidateKey, providerKey) <= 2;
}

function normalizedEditDistance(a, b) {
  const left = normalizeInventoryToken(a);
  const right = normalizeInventoryToken(b);
  if (!left || !right) return Infinity;
  const matrix = Array.from({ length: left.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= right.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
    }
  }
  return matrix[left.length][right.length];
}

function purchaseLeadDaysFromHistory(providerName) {
  const key = normalizeCategory(providerName);
  const purchase = [...(state.purchases || [])]
    .filter((row) => providerNameMatches(row.supplier, key) && row.date && row.expectedDeliveryDate)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];
  if (!purchase) return 0;

  const start = dateFromIso(purchase.date);
  const end = dateFromIso(purchase.expectedDeliveryDate);
  if (!start || !end) return 0;
  return Math.max(0, Math.round((end - start) / 86400000));
}

async function loadPurchaseBackendOptions({ force = false } = {}) {
  if (purchaseBackendOptions.loaded && !force) {
    updatePurchaseItemOptions();
    updatePurchaseProviderOptions();
    return purchaseBackendOptions;
  }

  const [supplies, supplierLinks, providers, items] = await Promise.all([
    backendTableRowsForEntry("insumos").catch(() => []),
    backendTableRowsForEntry("insumos_proveedores").catch(() => []),
    backendTableRowsForEntry("proveedores").catch(() => []),
    backendTableRowsForEntry("items").catch(() => [])
  ]);

  purchaseBackendOptions = {
    loaded: true,
    supplies,
    supplierLinks,
    providers,
    items,
    suppliesById: rowsByKey(supplies, "id_insumo"),
    supplierLinksById: rowsByKey(supplierLinks, "id_insumos_proveedores"),
    providersById: rowsByKey(providers, "id_proveedor"),
    itemsBySupplyId: rowsByKey(
      items.filter((row) => normalizeCategory(row.origen_tipo) === "insumo"),
      "id_origen"
    )
  };
  updatePurchaseItemOptions();
  updatePurchaseProviderOptions();
  return purchaseBackendOptions;
}

function updatePurchaseProviderOptions() {
  const select = els["purchase-provider"];
  if (!select) return;

  const currentValue = select.value;
  const supplyId = selectedPurchaseSupplyId();
  const supplierLinks = purchaseBackendOptions.supplierLinks
    .filter((row) => String(row.id_insumo ?? "").trim() === supplyId)
    .sort((a, b) => {
      const providerA = purchaseBackendOptions.providersById.get(String(a.id_proveedor ?? "").trim()) || {};
      const providerB = purchaseBackendOptions.providersById.get(String(b.id_proveedor ?? "").trim()) || {};
      return displayNameLabel(providerA.nombre || "").localeCompare(displayNameLabel(providerB.nombre || ""));
    });

  select.innerHTML = `<option value="">Elegir proveedor</option>` + supplierLinks.map((link) => {
    const provider = purchaseBackendOptions.providersById.get(String(link.id_proveedor ?? "").trim()) || {};
    const providerName = provider.nombre || `Proveedor ${link.id_proveedor || ""}`;
    const unitLabel = displayUnitLabel(link.ud_proveedor || "");
    const label = unitLabel ? `${displayNameLabel(providerName)} - ${unitLabel}` : displayNameLabel(providerName);
    return `
      <option
        value="${escapeHtml(String(link.id_insumos_proveedores ?? "").trim())}"
        data-provider-id="${escapeHtml(String(link.id_proveedor ?? "").trim())}"
        data-raw-value="${escapeHtml(providerName)}"
      >${escapeHtml(label)}</option>
    `;
  }).join("");

  if (supplierLinks.some((row) => String(row.id_insumos_proveedores ?? "").trim() === currentValue)) {
    select.value = currentValue;
  } else if (supplierLinks.length === 1) {
    select.value = String(supplierLinks[0].id_insumos_proveedores ?? "").trim();
  }
  syncSelectedPurchaseSupplier();
}

function updatePurchaseItemOptions() {
  const select = els["purchase-item-name"];
  if (!select) return;
  const currentValue = select.value;
  const sortedSupplies = [...purchaseBackendOptions.supplies]
    .filter((row) => String(row.id_insumo ?? "").trim())
    .sort((a, b) => displayNameLabel(a.nombre || "").localeCompare(displayNameLabel(b.nombre || "")));
  select.innerHTML = `<option value="">Elegir insumo</option>` + sortedSupplies.map((row) => `
    <option value="${escapeHtml(String(row.id_insumo ?? "").trim())}" data-raw-value="${escapeHtml(row.nombre || "")}">
      ${escapeHtml(displayNameLabel(row.nombre || `Insumo ${row.id_insumo}`))}
    </option>
  `).join("");
  if (sortedSupplies.some((row) => String(row.id_insumo ?? "").trim() === currentValue)) {
    select.value = currentValue;
  }
  syncSelectedPurchaseSupply();
}

function canonicalPurchaseItemName(value) {
  const key = normalizeCategory(value);
  const backendSupply = purchaseBackendOptions.supplies.find((row) => normalizeCategory(row.nombre) === key);
  if (backendSupply?.nombre) return backendSupply.nombre;
  return [
    ...(state.itemInfo || []).map((row) => row.itemName),
    ...(state.supplyInfo || []).map((row) => row.itemName),
    ...(state.purchaseDetails || []).map((row) => row.itemName)
  ].find((name) => normalizeCategory(name) === key) || value;
}

function selectedPurchaseSupplyId() {
  return String(els["purchase-item-name"]?.value || els["purchase-item-id"]?.value || "").trim();
}

function selectedPurchaseSupply() {
  return purchaseBackendOptions.suppliesById.get(selectedPurchaseSupplyId()) || null;
}

function selectedPurchaseSupplierLink() {
  return purchaseBackendOptions.supplierLinksById.get(String(els["purchase-provider"]?.value || "").trim()) || null;
}

function selectedPurchaseProvider() {
  const link = selectedPurchaseSupplierLink();
  return purchaseBackendOptions.providersById.get(String(link?.id_proveedor ?? "").trim()) || null;
}

function syncSelectedPurchaseSupply() {
  if (els["purchase-item-id"]) els["purchase-item-id"].value = selectedPurchaseSupplyId();
  const supply = selectedPurchaseSupply();
  setPurchaseUnitLabel(els["purchase-quantity-unit"], purchaseCountUnitForSupply(supply) || inventoryUnitForItem(supply?.nombre));
  setPurchaseUnitLabel(els["purchase-recipe-unit"], supply?.ud_receta || inventoryUnitForItem(supply?.nombre));
}

function syncSelectedPurchaseSupplier() {
  const link = selectedPurchaseSupplierLink();
  if (els["purchase-supplier-id"]) els["purchase-supplier-id"].value = String(link?.id_insumos_proveedores ?? "").trim();
  setPurchaseUnitLabel(els["purchase-unit"], link?.ud_proveedor || "");
  const invoiceType = els["purchase-invoice-type"]?.value || "Factura_A";
  if (els["purchase-iva-rate"]) els["purchase-iva-rate"].textContent = invoiceType === "Factura_A" ? formatRateLabel(parseRate(link?.iva)) : "0%";
  updatePurchaseSummary();
}

function purchaseBackendSupplierInfo() {
  const supply = selectedPurchaseSupply();
  const link = selectedPurchaseSupplierLink();
  if (!supply || !link) return null;
  return {
    itemName: supply.nombre || "",
    providerName: selectedPurchaseProvider()?.nombre || "",
    recipeUnit: supply.ud_receta || "",
    countUnit: purchaseCountUnitForSupply(supply) || supply.ud_receta || "",
    recipeUnitFactor: parseMoney(supply.cantidad_receta) || 1,
    supplierUnit: link.ud_proveedor || "",
    recipeQuantity: parseMoney(link.cantidad_proveedor) || 1,
    price: parseMoney(link.precio),
    ivaRate: parseRate(link.iva),
    minimumOrder: parseMoney(selectedPurchaseProvider()?.pedido_minimo)
  };
}

async function openPurchaseEntryForItem(itemName, itemId = "") {
  switchView("purchase-entry");
  await loadPurchaseBackendOptions();
  const supply = findPurchaseSupply(itemName, itemId);
  if (supply && els["purchase-item-name"]) {
    els["purchase-item-name"].value = String(supply.id_insumo ?? "").trim();
  }
  syncSelectedPurchaseSupply();
  updatePurchaseProviderOptions();
  const preferredProvider = lastPurchaseProviderForItem(supply?.nombre || itemName);
  selectPreferredPurchaseSupplier(preferredProvider);
  const today = toIsoDate(new Date());
  els["purchase-order-date"].value = today;
  const currentItemName = rawInputValue(els["purchase-item-name"]) || itemName;
  const supplierInfo = purchaseBackendSupplierInfo() || supplyInfoForPurchase(currentItemName, rawInputValue(els["purchase-provider"]), lastPurchaseUnitForItem(currentItemName));
  const supplierUnit = supplierInfo?.supplierUnit || lastPurchaseUnitForItem(itemName);
  const stockUnit = supplierInfo?.countUnit || inventoryUnitForItem(currentItemName);
  setPurchaseUnitLabel(els["purchase-quantity-unit"], stockUnit);
  const row = [...(els["inventory-detail-body"]?.querySelectorAll("tr[data-item-id]") || [])]
    .find((candidate) => candidate.dataset.itemName === itemName || String(candidate.dataset.itemId || "") === String(itemId || ""));
  const alertData = row ? purchaseAlertDataForItem(row, currentItemName) : null;
  const missingStock = alertData ? Math.max(0, alertData.required - alertData.stock) : NaN;
  const roundedOrder = roundedPurchaseOrder(currentItemName, missingStock, stockUnit, supplierUnit, rawInputValue(els["purchase-provider"]));
  const recipeQuantity = recipeUnitsFromCountUnits(currentItemName, Number(roundedOrder.stockQuantity));
  els["purchase-quantity"].value = integerPurchaseDisplay(roundedOrder.stockQuantity);
  if (els["purchase-recipe-quantity"]) els["purchase-recipe-quantity"].value = integerPurchaseDisplay(recipeQuantity);
  if (els["purchase-recipe-quantity"]) els["purchase-recipe-quantity"].dataset.requiredValue = integerPurchaseDisplay(recipeQuantity);
  setPurchaseUnitLabel(els["purchase-recipe-unit"], supplierInfo?.recipeUnit || stockUnit);
  if (els["purchase-supplier-quantity"]) els["purchase-supplier-quantity"].value = integerPurchaseDisplay(roundedOrder.supplierQuantity);
  setPurchaseUnitLabel(els["purchase-unit"], supplierUnit);
  if (els["purchase-invoice-type"]) els["purchase-invoice-type"].value = "Factura_A";
  updatePurchasePricing("quantity");
  updatePurchaseExpectedDate();
  updatePurchaseSummary();
  setPurchaseStatus("", "");
}

function findPurchaseSupply(itemName, itemId = "") {
  const id = String(itemId || "").trim();
  if (id && purchaseBackendOptions.suppliesById.has(id)) return purchaseBackendOptions.suppliesById.get(id);
  const key = normalizeCategory(itemName);
  return purchaseBackendOptions.supplies.find((row) => normalizeCategory(row.nombre) === key) || null;
}

function selectPreferredPurchaseSupplier(providerName) {
  const select = els["purchase-provider"];
  if (!select) return;
  const providerKey = normalizeCategory(providerName);
  const matchingOption = [...select.options].find((option) => {
    const providerId = option.dataset.providerId;
    const provider = purchaseBackendOptions.providersById.get(String(providerId || "").trim()) || {};
    return providerKey && providerNameMatches(provider.nombre, providerKey);
  });
  if (matchingOption) select.value = matchingOption.value;
  else if (!select.value && select.options.length > 1) select.selectedIndex = 1;
  syncSelectedPurchaseSupplier();
}

function updatePurchaseUnitsAfterSelection() {
  if (Number.isFinite(parseOptionalPurchaseNumber(els["purchase-supplier-quantity"]?.value))) {
    updatePurchaseUnitsFromField("supplier");
    return;
  }
  if (Number.isFinite(parseOptionalPurchaseNumber(els["purchase-quantity"]?.value))) {
    updatePurchaseUnitsFromField("count");
    return;
  }
  updatePurchasePricing("quantity");
  updatePurchaseSummary();
}

function updatePurchaseUnitsFromField(source) {
  const itemName = rawInputValue(els["purchase-item-name"]);
  const provider = rawInputValue(els["purchase-provider"]);
  const supplierUnit = purchaseUnitValue(els["purchase-unit"]) || lastPurchaseUnitForItem(itemName);
  const supplierInfo = supplyInfoForPurchase(itemName, provider, supplierUnit);
  const conversion = purchaseQuantityConversion(itemName, provider, supplierUnit, supplierInfo);
  setPurchaseUnitLabel(els["purchase-recipe-unit"], supplierInfo?.recipeUnit || inventoryUnitForItem(itemName));
  setPurchaseUnitLabel(els["purchase-unit"], supplierInfo?.supplierUnit || supplierUnit);

  const countInput = els["purchase-quantity"];
  const recipeInput = els["purchase-recipe-quantity"];
  const supplierInput = els["purchase-supplier-quantity"];
  const count = parseOptionalPurchaseNumber(countInput?.value);
  const recipe = parseOptionalPurchaseNumber(recipeInput?.value);
  const supplier = parseOptionalPurchaseNumber(supplierInput?.value);
  const normalized = normalizedPurchaseQuantities(source, { count, recipe, supplier }, conversion);
  if (!normalized) {
    updatePurchasePricing("quantity");
    updatePurchaseSummary();
    return;
  }

  recipeInput.value = integerPurchaseDisplay(normalized.recipe);
  recipeInput.dataset.requiredValue = integerPurchaseDisplay(normalized.recipe);
  countInput.value = integerPurchaseDisplay(normalized.count);
  supplierInput.value = integerPurchaseDisplay(normalized.supplier);
  updatePurchasePricing("quantity");
  updatePurchaseSummary();
}

function purchaseQuantityConversion(itemName, provider, supplierUnit, supplierInfo) {
  const recipePerCountUnit = itemInfoForInventoryItem(itemName)?.recipeUnitFactor || 1;
  const recipePerSupplierUnit = Number(supplierInfo?.recipeQuantity) || supplierUnitPackSize(supplierUnit) || 1;
  return {
    recipePerCountUnit,
    recipePerSupplierUnit,
    minimumSupplierUnits: Math.max(1, providerMinimumOrder(provider) || 0)
  };
}

function normalizedPurchaseQuantities(source, quantities, conversion) {
  const recipePerCountUnit = conversion.recipePerCountUnit || 1;
  const recipePerSupplierUnit = conversion.recipePerSupplierUnit || 1;
  let desiredRecipeQuantity = NaN;
  let desiredSupplierUnits = NaN;

  if (source === "recipe" && Number.isFinite(quantities.recipe)) {
    desiredRecipeQuantity = quantities.recipe;
  } else if (source === "count" && Number.isFinite(quantities.count)) {
    desiredRecipeQuantity = quantities.count * recipePerCountUnit;
  } else if (source === "supplier" && Number.isFinite(quantities.supplier)) {
    desiredSupplierUnits = quantities.supplier;
    desiredRecipeQuantity = desiredSupplierUnits * recipePerSupplierUnit;
  } else {
    return null;
  }

  if (!Number.isFinite(desiredRecipeQuantity) || desiredRecipeQuantity <= 0) {
    return { recipe: 0, count: 0, supplier: 0 };
  }

  /*
    La compra real solo puede hacerse por unidades completas de proveedor.
    Por eso una necesidad menor a un tanque, bolsa o caja se eleva a 1 unidad
    y se recalculan la unidad de receta y la unidad de conteo.
  */
  const supplierUnits = Math.max(
    Math.ceil(desiredRecipeQuantity / recipePerSupplierUnit),
    conversion.minimumSupplierUnits
  );
  const recipe = supplierUnits * recipePerSupplierUnit;
  return {
    recipe,
    count: recipe / recipePerCountUnit,
    supplier: supplierUnits
  };
}

function updatePurchasePricing(source = "quantity") {
  const subtotalInput = els["purchase-subtotal"];
  const ivaInput = els["purchase-iva"];
  const totalInput = els["purchase-total"];
  if (!subtotalInput || !ivaInput || !totalInput) return;

  const itemName = rawInputValue(els["purchase-item-name"]);
  const provider = rawInputValue(els["purchase-provider"]);
  const supplierUnit = purchaseUnitValue(els["purchase-unit"]) || lastPurchaseUnitForItem(itemName);
  const supplierInfo = supplyInfoForPurchase(itemName, provider, supplierUnit);
  const invoiceType = els["purchase-invoice-type"]?.value || "Factura_A";
  const ivaRate = invoiceType === "Factura_A" ? Number(supplierInfo?.ivaRate) || 0 : 0;

  if (source === "quantity") {
    const supplierQuantity = parseOptionalPurchaseNumber(els["purchase-supplier-quantity"]?.value);
    const unitPrice = Number(supplierInfo?.price) || 0;
    subtotalInput.value = Number.isFinite(supplierQuantity) && unitPrice ? decimalPurchaseDisplay(supplierQuantity * unitPrice) : "";
  }

  const subtotal = parseOptionalPurchaseNumber(subtotalInput.value) || 0;
  if (source !== "iva") {
    ivaInput.value = invoiceType === "Factura_A" ? decimalPurchaseDisplay(subtotal * ivaRate) : "0.00";
  }

  const iva = parseOptionalPurchaseNumber(ivaInput.value) || 0;
  totalInput.value = decimalPurchaseDisplay(subtotal + iva);
  els["purchase-iva-rate"].textContent = invoiceType === "Factura_A" ? formatRateLabel(ivaRate) : "0%";
  updatePurchaseSummary();
}

function updatePurchaseSummary() {
  const body = els["purchase-order-body"];
  if (!body) return;

  const rows = new Map(purchaseOrderRows()
    .filter((row) => purchaseOrderFieldSelected(row.key))
    .map((row) => [row.key, row]));
  const hasRows = rows.size > 0;
  body.innerHTML = hasRows
    ? [
      purchaseSummaryLines(rows, ["provider", "item", "orderDate", "delivery"]),
      purchaseSummarySection("Cantidades", rows, ["recipeQuantity", "buyQuantity", "presentation", "difference"]),
      purchaseSummarySection("Facturacion", rows, ["invoiceType", "subtotal", "iva", "total"])
    ].filter(Boolean).join("")
    : `<div class="purchase-order-empty">Selecciona datos para armar la orden.</div>`;
}

function purchaseSummaryLines(rows, keys) {
  return keys.map((key) => purchaseSummaryRow(rows.get(key))).filter(Boolean).join("");
}

function purchaseSummarySection(title, rows, keys) {
  const content = purchaseSummaryLines(rows, keys);
  if (!content) return "";
  return `
    <div class="purchase-summary-section">
      <h4>
        ${purchaseSummarySectionIcon(title)}
        <span>${escapeHtml(title)}</span>
      </h4>
      ${content}
    </div>
  `;
}

function purchaseSummarySectionIcon(title) {
  const icon = {
    Cantidades: "purchase-quantities",
    Facturacion: "purchase-invoice"
  }[title];
  return icon ? `<img src="assets/icons/${icon}.svg" alt="">` : "";
}

function purchaseSummaryRow(row) {
  if (!row) return "";
  return `
    <div class="purchase-order-line ${row.key === "difference" || row.key === "total" ? "is-highlight" : ""}">
      <span>${escapeHtml(row.label)}</span>
      <strong>
        ${escapeHtml(row.value || "-")}
        ${row.detail ? `<small>${escapeHtml(row.detail)}</small>` : ""}
      </strong>
    </div>
  `;
}

function purchaseSummaryData() {
  const rows = new Map(purchaseOrderRows()
    .filter((row) => purchaseOrderFieldSelected(row.key))
    .map((row) => [row.key, row]));
  return [
    { type: "line", row: rows.get("provider") },
    { type: "line", row: rows.get("item") },
    { type: "line", row: rows.get("orderDate") },
    { type: "line", row: rows.get("delivery") },
    { type: "section", title: "Cantidades" },
    { type: "line", row: rows.get("recipeQuantity") },
    { type: "line", row: rows.get("buyQuantity") },
    { type: "line", row: rows.get("presentation") },
    { type: "line", row: rows.get("difference"), highlight: true },
    { type: "section", title: "Facturacion" },
    { type: "line", row: rows.get("invoiceType") },
    { type: "line", row: rows.get("subtotal") },
    { type: "line", row: rows.get("iva") },
    { type: "line", row: rows.get("total"), highlight: true }
  ].filter((entry) => entry.type === "section" || entry.row);
}

function downloadPurchaseOrderPng() {
  const entries = purchaseSummaryData();
  if (!entries.length) return;

  const scale = 2;
  const width = 760;
  const padding = 44;
  const lineHeight = 54;
  const sectionHeight = 48;
  const headerHeight = 96;
  const footer = 36;
  const height = headerHeight + footer + entries.reduce((total, entry) => (
    total + (entry.type === "section" ? sectionHeight : lineHeight)
  ), 0);

  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d");
  context.scale(scale, scale);

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "#d7e1ea";
  context.lineWidth = 1;
  roundedCanvasRect(context, 12, 12, width - 24, height - 24, 14);
  context.stroke();

  context.fillStyle = "rgba(15, 118, 110, 0.09)";
  roundedCanvasRect(context, padding, 34, width - padding * 2, 62, 8);
  context.fill();
  context.fillStyle = "#005f5b";
  context.font = "800 26px Arial, sans-serif";
  context.fillText("Orden de Compra", padding + 20, 74);

  let y = headerHeight + 18;
  entries.forEach((entry) => {
    if (entry.type === "section") {
      context.fillStyle = "#006c68";
      context.font = "800 22px Arial, sans-serif";
      context.fillText(entry.title, padding, y + 28);
      y += sectionHeight;
      return;
    }

    const row = entry.row;
    if (entry.highlight) {
      context.fillStyle = "rgba(15, 118, 110, 0.075)";
      context.fillRect(padding - 10, y + 4, width - padding * 2 + 20, lineHeight - 8);
    }
    context.fillStyle = "#465463";
    context.font = "400 18px Arial, sans-serif";
    context.fillText(row.label, padding, y + 32);
    context.fillStyle = entry.highlight ? "#005f5b" : "#0d1f33";
    context.font = "800 18px Arial, sans-serif";
    context.textAlign = "right";
    context.fillText(row.value || "-", width - padding, y + 32);
    context.textAlign = "left";
    context.strokeStyle = "#e2e8f0";
    context.beginPath();
    context.moveTo(padding, y + lineHeight - 2);
    context.lineTo(width - padding, y + lineHeight - 2);
    context.stroke();
    y += lineHeight;
  });

  const link = document.createElement("a");
  const supplier = displayNameLabel(rawInputValue(els["purchase-provider"])) || "proveedor";
  const date = els["purchase-order-date"]?.value || toIsoDate(new Date());
  link.download = `orden-compra-${supplier.replace(/\s+/g, "-").toLowerCase()}-${date}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

function roundedCanvasRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function purchaseOrderRows() {
  return [
    {
      key: "provider",
      label: "Proveedor",
      value: displayNameLabel(rawInputValue(els["purchase-provider"]))
    },
    {
      key: "item",
      label: "Insumo",
      value: displayNameLabel(rawInputValue(els["purchase-item-name"]))
    },
    {
      key: "orderDate",
      label: "Fecha del pedido",
      value: formatDate(els["purchase-order-date"]?.value)
    },
    {
      key: "delivery",
      label: "Fecha de Entrega",
      value: formatDate(els["purchase-expected-date"]?.value)
    },
    {
      key: "recipeQuantity",
      label: "Unidad de receta",
      value: purchaseQuantityLabel(els["purchase-recipe-quantity"]?.value, purchaseUnitValue(els["purchase-recipe-unit"]))
    },
    {
      key: "buyQuantity",
      label: "Unidad de conteo",
      value: purchaseQuantityLabel(els["purchase-quantity"]?.value, purchaseUnitValue(els["purchase-quantity-unit"]))
    },
    {
      key: "difference",
      label: "Diferencia",
      value: purchaseQuantityDifferenceLabel()
    },
    {
      key: "presentation",
      label: "Unidad del proveedor",
      value: purchasePresentationLabel(els["purchase-supplier-quantity"]?.value, purchaseUnitValue(els["purchase-unit"]))
    },
    {
      key: "invoiceType",
      label: "Tipo de Factura",
      value: displayNameLabel(els["purchase-invoice-type"]?.value || "Factura_A"),
      group: "pricing"
    },
    {
      key: "subtotal",
      label: "Subtotal",
      value: purchaseOrderMoneyLabel(els["purchase-subtotal"]?.value),
      group: "pricing"
    },
    {
      key: "iva",
      label: `IVA (${els["purchase-iva-rate"]?.textContent || "0%"})`,
      value: purchaseOrderMoneyLabel(els["purchase-iva"]?.value),
      group: "pricing"
    },
    {
      key: "total",
      label: "Total",
      value: purchaseOrderMoneyLabel(els["purchase-total"]?.value),
      group: "pricing"
    }
  ];
}

function purchaseOrderFieldSelected(key) {
  return Boolean(document.querySelector(`[data-purchase-order-toggle="${key}"]`)?.checked);
}

function purchaseQuantityLabel(quantity, unit) {
  const number = parseOptionalPurchaseNumber(quantity);
  const quantityLabel = Number.isFinite(number) ? formatNumber(number) : "";
  const unitLabel = displayUnitLabel(unit || "");
  return [quantityLabel, unitLabel].filter(Boolean).join(" ");
}

function purchasePresentationLabel(quantity, unit) {
  const number = parseOptionalPurchaseNumber(quantity);
  const quantityLabel = Number.isFinite(number) ? formatNumber(number) : "";
  const unitLabel = displayUnitLabel(unit || "");
  if (unitLabel && quantityLabel) return `${unitLabel} (${quantityLabel})`;
  return unitLabel || quantityLabel;
}

function purchaseQuantityDifferenceLabel() {
  const required = parseOptionalPurchaseNumber(els["purchase-recipe-quantity"]?.value);
  const bought = parseOptionalPurchaseNumber(els["purchase-quantity"]?.value);
  if (!Number.isFinite(required) || !Number.isFinite(bought)) return "";
  const recipeUnit = purchaseUnitValue(els["purchase-recipe-unit"]);
  const countUnit = purchaseUnitValue(els["purchase-quantity-unit"]);
  const itemName = rawInputValue(els["purchase-item-name"]);
  const boughtRecipeUnits = recipeUnitsFromCountUnits(itemName, bought);
  const diff = boughtRecipeUnits - required;
  const unit = recipeUnit || countUnit;
  return `${formatNumber(diff)} ${displayUnitLabel(unit)}`.trim();
}

function purchaseMoneyLabel(value) {
  const number = parseOptionalPurchaseNumber(value);
  return Number.isFinite(number) ? formatMoney(number) : "";
}

function purchaseOrderMoneyLabel(value) {
  const number = parseOptionalPurchaseNumber(value);
  if (!Number.isFinite(number)) return "";
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(number);
}

function formatRateLabel(rate) {
  return new Intl.NumberFormat("es-AR", {
    style: "percent",
    minimumFractionDigits: 0,
    maximumFractionDigits: 1
  }).format(rate || 0);
}

function parseOptionalPurchaseNumber(value) {
  const text = String(value ?? "").trim();
  if (!text) return NaN;
  return parseQuantity(text);
}

function setPurchaseUnitLabel(element, rawUnit) {
  if (!element) return;
  const value = String(rawUnit || "").trim();
  element.dataset.rawUnit = value;
  element.textContent = value ? displayUnitLabel(value) : "-";
}

function purchaseUnitValue(element) {
  return String(element?.dataset?.rawUnit || element?.textContent || "").trim();
}

function displayUnitLabel(value) {
  return String(value || "").replace(/_/g, " ");
}

function displayNameLabel(value) {
  return String(value || "").replace(/_/g, " ");
}

function setDisplayInputValue(input, rawValue) {
  if (!input) return;
  const value = String(rawValue || "").trim();
  input.dataset.rawValue = value;
  input.value = displayNameLabel(value);
}

function rawInputValue(input) {
  if (!input) return "";
  if (input.tagName === "SELECT") {
    const option = input.selectedOptions?.[0];
    const rawOptionValue = String(option?.dataset?.rawValue || "").trim();
    return rawOptionValue || String(option?.textContent || input.value || "").trim();
  }
  const displayed = String(input.value || "").trim();
  const raw = String(input.dataset.rawValue || "").trim();
  return raw && displayNameLabel(raw) === displayed ? raw : displayed;
}

function updatePurchaseExpectedDate() {
  if (!els["purchase-order-date"] || !els["purchase-expected-date"]) return;
  const orderDate = els["purchase-order-date"].value || toIsoDate(new Date());
  const leadDays = providerLeadDays(rawInputValue(els["purchase-provider"]));
  const date = dateFromIso(orderDate);
  date.setDate(date.getDate() + leadDays);
  els["purchase-expected-date"].value = toIsoDate(date);
}

function roundForInput(value) {
  if (!Number.isFinite(value)) return "";
  return String(Math.ceil(value * 100) / 100);
}

function integerPurchaseDisplay(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return String(Math.ceil(number));
}

function decimalPurchaseDisplay(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return number.toFixed(2);
}

async function submitPurchase(event) {
  event.preventDefault();
  const supplierLink = selectedPurchaseSupplierLink();
  const supply = selectedPurchaseSupply();
  const supplierQuantity = parseOptionalPurchaseNumber(els["purchase-supplier-quantity"]?.value);
  const orderDate = els["purchase-order-date"]?.value || "";
  const expectedDeliveryDate = els["purchase-expected-date"]?.value || "";

  if (!supply || !supplierLink || !orderDate || !expectedDeliveryDate || !Number.isFinite(supplierQuantity) || supplierQuantity <= 0) {
    setPurchaseStatus("Completa insumo, proveedor, fechas y cantidad proveedor.", "error");
    return;
  }

  const button = els["purchase-submit"];
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Enviando...";
  setPurchaseStatus("Guardando compra en backend...", "pending");

  try {
    const [purchaseId, detailId] = await Promise.all([
      nextBackendPrimaryId("compras", "id_compra"),
      nextBackendPrimaryId("detalle_compras", "id_detalle_compra")
    ]);

    await saveBackendEntryRows("compras", [{
      id_compra: purchaseId,
      id_proveedor: String(supplierLink.id_proveedor ?? "").trim(),
      fecha_pedido: orderDate,
      fecha_entrega_prevista: expectedDeliveryDate
    }]);
    await saveBackendEntryRows("detalle_compras", [{
      id_detalle_compra: detailId,
      id_compra: purchaseId,
      id_insumos_proveedores: String(supplierLink.id_insumos_proveedores ?? "").trim(),
      cantidad: supplierQuantity
    }]);

    backendDataMap = null;
    dataEditorSchema = null;
    setPurchaseStatus(`Compra #${purchaseId} guardada en backend.`, "success");
  } catch (error) {
    setPurchaseStatus(`No se pudo guardar la compra: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function parseSupplierUnitEntry(value) {
  const match = String(value || "").trim().match(/^(\d+(?:[.,]\d+)?)\s+(.+)$/);
  if (!match) return { quantity: "", unit: value };
  return {
    quantity: String(parseQuantity(match[1])),
    unit: match[2].trim()
  };
}

function setPurchaseStatus(message, status) {
  if (!els["purchase-status"]) return;
  els["purchase-status"].textContent = message;
  els["purchase-status"].dataset.status = status;
}

function setInventoryDetailStatus(message, status) {
  const element = els["inventory-detail-status"];
  element.textContent = message;
  element.dataset.status = status;
}

function toggleNavGroup(button) {
  const group = button.closest(".nav-group");
  if (!group) return;
  const isCollapsed = group.classList.toggle("is-collapsed");
  button.setAttribute("aria-expanded", String(!isCollapsed));
}

function renderPaymentPlans() {
  const summary = document.getElementById("payment-plans-summary");
  const list = document.getElementById("payment-plans-list");
  if (!summary || !list) return;

  const createInstallments = (capitals, interests, startDate, lateInterest, paidCount) => capitals.map((capital, index) => {
    const dueDate = new Date(`${startDate}T12:00:00`);
    dueDate.setMonth(dueDate.getMonth() + index);
    const secondDue = new Date(dueDate);
    secondDue.setDate(secondDue.getDate() + 10);
    const financialInterest = interests[index];
    const firstAmount = capital + financialInterest;
    return {
      number: index + 1,
      dueDate: dueDate.toISOString().slice(0, 10),
      secondDueDate: secondDue.toISOString().slice(0, 10),
      capital,
      financialInterest,
      lateInterest,
      firstAmount,
      secondAmount: firstAmount + lateInterest,
      paid: index < paidCount
    };
  });

  const plans = [
    {
      name: "Plan ARCA 1",
      description: "Plan con cuotas mensuales y segundo vencimiento.",
      installments: createInstallments(
        [737285.75, 757561.11, 778394.04, 799799.88, 821794.37, 844393.72, 867614.55, 891473.95, 915989.48, 941117.19],
        [283695.60, 263420.24, 242587.31, 221181.47, 199186.98, 176587.63, 153366.80, 129507.40, 104991.87, 79802.16],
        "2026-03-16", 9359, 4
      )
    },
    {
      name: "Plan ARCA 2",
      description: "Plan con cuotas mensuales y segundo vencimiento.",
      installments: createInstallments(
        [275632.87, 283212.77, 291001.12, 299003.65, 307226.25, 315674.87, 324356.04, 333275.83, 342440.91, 351858.04],
        [106059.05, 98479.15, 90690.80, 82688.27, 74465.67, 66016.95, 57335.88, 48416.09, 39251.01, 29833.88],
        "2026-03-16", 3498.84, 4
      )
    },
    {
      name: "Plan ARCA 3",
      description: "Plan vigente, sin cuotas canceladas.",
      installments: createInstallments(
        [768958.32, 788049.67, 809721.04, 831988.37, 854868.05, 878376.92, 902532.29, 927351.89],
        [185895.78, 164804.43, 143133.06, 120865.73, 97886.05, 74477.18, 50321.81, 25502.21],
        "2026-07-16", 8734.50, 0
      )
    }
  ];
  const currency = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 });
  const date = new Intl.DateTimeFormat("es-AR");
  const pending = plans.flatMap((plan) => plan.installments.filter((item) => !item.paid).map((item) => ({ ...item, plan: plan.name })))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const next = pending[0];
  const paidCount = plans.flatMap((plan) => plan.installments).filter((item) => item.paid).length;

  summary.innerHTML = `
    <article class="payment-plan-metric"><span>Planes activos</span><strong>${plans.length}</strong></article>
    <article class="payment-plan-metric"><span>Cuotas pendientes</span><strong>${pending.length}</strong></article>
    <article class="payment-plan-metric"><span>Proximo vencimiento</span><strong>${next ? `${date.format(new Date(`${next.dueDate}T12:00:00`))}` : "Sin pendientes"}</strong><small>${next ? `${next.plan} · ${currency.format(next.firstAmount)}` : ""}</small></article>
  `;
  list.innerHTML = plans.map((plan, index) => {
    const paid = plan.installments.filter((item) => item.paid).length;
    const outstanding = plan.installments.filter((item) => !item.paid).reduce((total, item) => total + item.firstAmount, 0);
    return `
      <details class="payment-plan-card" ${index === 2 ? "open" : ""}>
        <summary>
          <span><strong>${plan.name}</strong><small>${plan.description}</small></span>
          <span class="payment-plan-summary-values"><b>${paid}/${plan.installments.length} pagadas</b><em>${currency.format(outstanding)} pendiente</em></span>
        </summary>
        <div class="table-wrap payment-plan-table-wrap">
          <table class="payment-plan-table">
            <thead><tr><th>Cuota</th><th>Capital</th><th>Interes financiero</th><th>Interes resarcitorio</th><th>Total</th><th>Vencimiento</th><th>Estado</th></tr></thead>
            <tbody>${plan.installments.map((item) => `<tr><td>${item.number}</td><td>${currency.format(item.capital)}</td><td>${currency.format(item.financialInterest)}</td><td>${currency.format(item.lateInterest)}</td><td>${currency.format(item.secondAmount)}</td><td>${date.format(new Date(`${item.dueDate}T12:00:00`))}<small>2do: ${date.format(new Date(`${item.secondDueDate}T12:00:00`))}</small></td><td><span class="payment-plan-status ${item.paid ? "is-paid" : "is-pending"}">${item.paid ? "Cancelada" : "Pendiente"}</span></td></tr>`).join("")}</tbody>
          </table>
        </div>
      </details>`;
  }).join("");
}

function switchView(view) {
  const dataEntryViews = [
    "expense-entry",
    "reception-entry",
    "purchase-entry",
    "data-entry",
    "salary-entry",
    "logistics-entry",
    "other-expenses-entry",
    "commissions-entry",
    "payment-plans",
    "partner-contributions-entry",
    "payments-entry",
    "issued-check-entry",
    "sales-entry",
    "orders-entry",
    "collections-entry",
    "received-check-entry",
    "deposited-checks-entry",
    "bank-reconciliation",
    "creditor-entry"
  ];
  document.body.classList.toggle("view-results-active", view === "results");
  document.body.classList.toggle("view-cashflow-active", view === "cashflow");
  document.body.classList.toggle("view-cashbox-active", view === "cashbox");
  document.body.classList.toggle("view-operational-active", dataEntryViews.includes(view));
  document.body.classList.toggle("view-bank-reconciliation-active", view === "bank-reconciliation");
  document.body.classList.toggle("view-creditor-entry-active", view === "creditor-entry");
  document.body.classList.toggle("view-data-entry-active", view === "data-entry");
  document.body.classList.toggle("view-purchase-entry-active", view === "purchase-entry");
  document.body.classList.toggle("view-reception-entry-active", view === "reception-entry");
  document.body.classList.toggle("view-issued-check-entry-active", view === "issued-check-entry");
  document.body.classList.toggle("view-payments-entry-active", view === "payments-entry");
  document.body.classList.toggle("view-imports-active", view === "imports");
  document.body.classList.toggle("view-data-editor-active", view === "data-editor");
  document.body.classList.toggle("view-data-map-active", view === "data-map");
  document.body.classList.toggle("view-sql-active", view === "sql");
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("active", section.id === `view-${view}`);
  });

  const navGroupViews = {
    "data-entry": dataEntryViews,
    data: ["imports", "data-editor", "data-map", "sql"]
  };
  document.querySelectorAll("[data-nav-toggle]").forEach((button) => {
    const groupViews = navGroupViews[button.dataset.navToggle] || [button.dataset.navToggle];
    if (!groupViews.includes(view)) return;
    button.closest(".nav-group")?.classList.remove("is-collapsed");
    button.setAttribute("aria-expanded", "true");
  });

  const titles = {
    dashboard: ["Dashboard", "Resumen de los datos guardados en este navegador."],
    results: ["Estado de Resultados", "Resultado mensual estimado desde egresos, ventas e inventario."],
    cashflow: ["Cashflow", "Flujo de caja proyectado y editable por fecha."],
    cashbox: ["Caja", "Visualizacion de caja y saldos reales."],
    "bank-reconciliation": ["Conciliacion bancaria", "Comparacion del extracto bancario contra pagos, cobros y egresos del backend."],
    "creditor-entry": ["Acreedores", "Alta de acreedores, origenes y etiquetas."],
    "expense-entry": ["Egresos", "Carga agrupada de recepciones, sueldos, logistica, otros gastos y comisiones."],
    "data-entry": ["Inventario", "Carga operativa directa hacia la planilla de inventario."],
    "purchase-entry": ["Compras", "Carga de pedidos a proveedores y detalle de insumos."],
    "reception-entry": ["Recepcion de mercaderia", "Carga de mercaderia recibida asociada a compras."],
    "salary-entry": ["Sueldos", "Carga de liquidaciones y egresos laborales."],
    "logistics-entry": ["Logistica", "Carga de entregas, fletes y gastos logisticos."],
    "other-expenses-entry": ["Otros gastos", "Carga de gastos no vinculados directamente a compras de mercaderia."],
    "partner-contributions-entry": ["Aportes de socios", "Registro de aportes y retiros sin impacto en el Estado de Resultados."],
    "commissions-entry": ["Comisiones", "Carga y control de comisiones por ventas y cobros."],
    "payment-plans": ["Planes de pago", "Seguimiento de cuotas, vencimientos y pagos de ARCA."],
    "payments-entry": ["Pagos", "Carga agrupada de pagos y medios de cancelacion."],
    "issued-check-entry": ["Cheques entregados", "Carga y control de cheques propios entregados."],
    "sales-entry": ["Ventas", "Carga agrupada de ventas, pedidos y entregas."],
    "orders-entry": ["Pedidos", "Carga y seguimiento de pedidos de clientes."],
    "collections-entry": ["Cobros", "Carga agrupada de cobros y cheques recibidos."],
    "received-check-entry": ["Cheques recibidos", "Carga y control de cheques recibidos."],
    "deposited-checks-entry": ["Cheques depositados", "Seleccion de cheques pendientes y conciliacion de depositos."],
    imports: ["Imports", "Carga y revision de datos operativos y financieros."],
    "data-editor": ["Editor de datos", "Edicion puntual de tablas limpias del backend."],
    "data-map": ["Mapa de datos", "Auditoria de tablas y columnas importadas al backend."],
    sql: ["Consultas SQL", "Consulta las tablas limpias del backend con SQL de solo lectura."]
  };

  const title = titles[view] || ["SunNutrition", ""];
  els["page-title"].textContent = title[0];
  els["page-subtitle"].textContent = title[1];
  if (view === "data-editor") loadDataEditorSchema();
  if (view === "creditor-entry") loadCreditorEntryForm();
  if (view === "data-map") loadDataMap();
  if (view === "sql") loadSqlSchema();
  if (view === "dashboard") loadDashboardWidgets();
  if (view === "purchase-entry") loadPurchaseBackendOptions();
  if (["orders-entry", "logistics-entry", "sales-entry", "collections-entry", "commissions-entry", "received-check-entry"].includes(view)) loadCommercialEntryData(true);
  if (view === "deposited-checks-entry") openBankCheckDepositReview();
  if (view === "expense-entry") loadExpenseDebtView();
  if (view === "payments-entry") loadPaymentEntryView();
  if (view === "other-expenses-entry") loadOtherExpenseEntryOptions();
  if (view === "partner-contributions-entry") loadPartnerContributions();
  if (view === "payment-plans") renderPaymentPlans();
  if (view === "salary-entry") initializeSalaryEntry();
  if (view === "reception-entry") {
    initializeOperationalEntryDefaults();
    loadOperationalEntryOptions();
  }
  if (view === "issued-check-entry") {
    initializeOperationalEntryDefaults();
    loadIssuedCheckPendingPayments();
  }
  if (view === "bank-reconciliation") refreshBankReconciliationFromBackend();
}

/*
  ImportaciĂłn CSV:
  Cada importaciĂłn reemplaza el dataset del tipo elegido. Esto evita duplicados al
  volver a cargar un Google Sheet actualizado. Las filas con fecha invĂˇlida se
  ignoran y quedan registradas para revisiĂłn.
*/
function importCsv(kind, text, source) {
  saveAllImportUrlsFromInputs();
  const rows = parseCsv(text);
  const sheetCellErrors = findSpreadsheetCellErrors(rows, kind);
  if (rows.length < 2) {
    state.importErrors.push({
      source: labelForKind(kind),
      row: "-",
      reason: "El CSV no tiene datos para importar",
      raw: source
    });
    saveState();
    render();
    return;
  }

  if (sheetCellErrors.length) {
    state.importErrors = [
      ...state.importErrors.filter((error) => error.source !== labelForKind(kind) && error.source !== kind),
      {
        source: labelForKind(kind),
        row: sheetCellErrors[0].row,
        reason: `Hay un error en una celda (${sheetCellErrors[0].cell}). Se conservaron los datos anteriores.`,
        raw: sheetCellErrors[0].raw || source
      },
      ...sheetCellErrors.slice(1, 20).map((error) => ({
        source: labelForKind(kind),
        row: error.row,
        reason: `Celda con error (${error.cell})`,
        raw: error.raw
      }))
    ];
    saveState();
    render();
    return;
  }

  if (kind === "cash") {
    state.cash = parseCashRows(rows, source);
    state.importErrors = state.importErrors.filter((error) => error.source !== labelForKind(kind) && error.source !== kind);
    saveState();
    render();
    return;
  }

  if (kind === "creditors") {
    state.creditors = parseCreditorRows(rows, source);
    state.importErrors = state.importErrors.filter((error) => error.source !== labelForKind(kind) && error.source !== kind);
    saveState();
    render();
    return;
  }

  if (kind === "providers") {
    state.providers = parseProviderRows(rows, source);
    state.importErrors = state.importErrors.filter((error) => error.source !== labelForKind(kind) && error.source !== kind);
    saveState();
    render();
    return;
  }

  const headers = normalizedHeadersWithFallback(rows[0]);
  const rawRows = rows.slice(1)
    .filter((cells) => cells.some((cell) => String(cell || "").trim()))
    .map((cells) => Object.fromEntries(headers.map((header, i) => [header, cells[i] || ""])));

  if (kind === "inventory" && (isLegacyInventoryImport(headers) || isBlankTurnInventoryImport(headers, rawRows))) {
    legacyInventoryImportRows = rawRows;
    rebuildInventoryFromLegacyImports();
    state.importErrors = state.importErrors.filter((error) => error.source !== labelForKind(kind) && error.source !== kind);
    saveState();
    setupPeriodSelectors();
    render();
    return;
  }

  if (kind === "inventoryDetails" && isLegacyInventoryDetailImport(headers)) {
    if (!legacyInventoryImportRows?.length) legacyInventoryImportRows = legacyInventoryRowsFromCurrentState();
    legacyInventoryDetailImportRows = rawRows;
    rebuildInventoryFromLegacyImports();
    state.importErrors = state.importErrors.filter((error) => error.source !== labelForKind(kind) && error.source !== kind);
    saveState();
    setupPeriodSelectors();
    render();
    return;
  }

  const parsedRows = [];
  const errors = [];

  rows.slice(1).forEach((cells, index) => {
    if (cells.every((cell) => !cell.trim())) return;
    const raw = Object.fromEntries(headers.map((header, i) => [header, cells[i] || ""]));
    if (kind === "purchaseDetails") {
      const detectedSupplier = pick(raw, ["proveedor", "nombre_proveedor", "nombre proveedor", "columna_8"]);
      if (!detectedSupplier) raw.proveedor = cells[cells.length - 1] || "";
    }
    const rowNumber = index + 2;
    const parsed = parseRow(kind, raw);

    if (requiresValidDateForImport(kind) && !parsed.date) {
      errors.push({
        source: labelForKind(kind),
        row: rowNumber,
        reason: "Fecha invalida",
        raw: cells.join(" | ")
      });
      return;
    }

    parsedRows.push(parsed);
  });

  const finalRows = kind === "inventoryDetails" ? enrichInventoryDetailsWithInventory(parsedRows) : parsedRows;

  if (!finalRows.length && rows.length > 1 && state[kind]?.length) {
    state.importErrors = [
      ...state.importErrors.filter((error) => error.source !== labelForKind(kind) && error.source !== kind),
      {
        source: labelForKind(kind),
        row: "-",
        reason: "No se importaron filas nuevas; se conservaron los datos anteriores",
        raw: source
      },
      ...errors
    ];
    saveState();
    render();
    return;
  }

  state[kind] = finalRows;
  reconcilePurchaseDetailSuppliers();
  state.importErrors = [
    ...state.importErrors.filter((error) => error.source !== labelForKind(kind) && error.source !== kind),
    ...errors
  ];

  saveState();
  setupPeriodSelectors();
  render();
}

function findSpreadsheetCellErrors(rows, kind) {
  const errors = [];
  const headers = normalizedHeadersWithFallback(rows[0] || []);
  rows.forEach((cells, rowIndex) => {
    cells.forEach((cell, columnIndex) => {
      const value = String(cell || "").trim();
      if (!isSpreadsheetErrorValue(value)) return;
      errors.push({
        source: labelForKind(kind),
        row: rowIndex + 1,
        cell: headers[columnIndex] || `Columna ${columnIndex + 1}`,
        raw: value
      });
    });
  });
  return errors;
}

function isSpreadsheetErrorValue(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) return false;
  return (
    [
      "#N/A",
      "#VALUE!",
      "#REF!",
      "#DIV/0!",
      "#ERROR!",
      "#NAME?",
      "#NUM!",
      "#NULL!",
      "#¡VALOR!",
      "#¡REF!",
      "#¡DIV/0!",
      "#¿NOMBRE?",
      "#¡NUM!",
      "#¡NULO!"
    ].includes(normalized) ||
    /^#[A-ZÁÉÍÓÚÑ¿?¡!0-9/]+$/.test(normalized)
  );
}

function requiresValidDateForImport(kind) {
  return !["orderDetails", "inventoryDetails", "recipes", "itemInfo", "supplyInfo", "purchases", "purchaseDetails"].includes(kind);
}

/*
  Importa desde una URL pĂşblica. Si el usuario pega un link normal de Google Sheets,
  se transforma al endpoint CSV para evitar exigir una URL tĂ©cnica.
*/
async function loadCsvFromUrl(kind, button = null, forceReload = false, urlOverride = "") {
  const input = document.querySelector(`[data-url="${kind}"]`);
  const rawUrl = urlOverride || input?.value.trim() || state.importUrls?.[kind] || "";
  if (!rawUrl || (!forceReload && input?.dataset.loadedUrl === rawUrl)) return;
  if (input && !input.value.trim()) input.value = rawUrl;

  const originalButtonText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "Cargando...";
  }

  try {
    const csvUrl = googleSheetCsvUrl(rawUrl, forceReload);
    const response = await fetchWithTimeout(csvUrl, 15000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (input) {
      input.dataset.loadedUrl = rawUrl;
      saveImportUrl(input);
      setImportUrlEditing(input, false);
    } else {
      state.importUrls = state.importUrls || {};
      state.importUrls[kind] = rawUrl;
      saveState();
    }
    importCsv(kind, text, rawUrl);
  } catch (error) {
    state.importErrors.push({
      source: labelForKind(kind),
      row: "-",
      reason: `No se pudo cargar la URL: ${error.message}`,
      raw: rawUrl
    });
    saveState();
    render();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalButtonText || "Cargar ahora";
    }
  }
}

async function refreshAllImports() {
  saveAllImportUrlsFromInputs();
  const imports = importUrlEntries();
  const shouldRefreshInventoryTemplate = Boolean(els["inventory-date-input"]?.value);
  if (!imports.length && !shouldRefreshInventoryTemplate) return;

  const button = els["refresh-imports"];
  const originalText = button.textContent;
  button.disabled = true;

  try {
    let refreshedImports = [];
    let refreshErrors = [];

    if (imports.length) {
      button.textContent = `Refrescando 1/${imports.length}...`;
      const payload = await refreshImportsThroughBackend(imports);
      refreshedImports = Array.isArray(payload.imports) ? payload.imports : [];
      refreshErrors = Array.isArray(payload.errors) ? payload.errors : [];
    }

    for (const [index, entry] of refreshedImports.entries()) {
      button.textContent = `Procesando ${index + 1}/${refreshedImports.length}...`;
      if (entry?.kind && entry?.text) importCsv(entry.kind, entry.text, entry.source || "");
    }

    if (refreshErrors.length) {
      const sourcesWithErrors = new Set(refreshErrors.map((error) => error.source));
      state.importErrors = [
        ...state.importErrors.filter((error) => !sourcesWithErrors.has(error.source)),
        ...refreshErrors
      ];
    }

    reconcilePurchaseDetailSuppliers();
    saveState();
    button.textContent = "Actualizando fecha inventario...";
    const updatedFromSheets = await refreshInventoryDefaultDateFromSheets({ force: true });
    if (!updatedFromSheets) setInventoryDefaultDateFromLatestStock({ force: true });
    if (shouldRefreshInventoryTemplate) {
      button.textContent = "Refrescando detalle inventario...";
      await loadInventoryDetailTemplate();
    }
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function refreshImportsThroughBackend(imports) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/imports/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: imports })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    const fallbackImports = [];
    const fallbackErrors = [];
    for (const entry of imports) {
      try {
        const csvUrl = googleSheetCsvUrl(entry.url, true);
        const response = await fetchWithTimeout(csvUrl, 15000);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        fallbackImports.push({ ...entry, source: entry.url, text: await response.text() });
      } catch (fallbackError) {
        fallbackErrors.push({
          source: labelForKind(entry.kind),
          row: "-",
          reason: `No se pudo cargar la URL: ${fallbackError.message}. Se conservaron los datos anteriores.`,
          raw: entry.url
        });
      }
    }
    return { ok: true, imports: fallbackImports, errors: fallbackErrors };
  }
}

async function loadBackendSources() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/backend/sources`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    (payload.sources || []).forEach((source) => {
      const input = document.querySelector(`[data-backend-url="${cssEscape(source.workbook)}"]`);
      if (input) input.value = source.url || "";
    });
    document.querySelectorAll("[data-backend-url]").forEach((input) => setBackendSourceEditing(input, false));
    setBackendSourceStatus("", "");
  } catch (error) {
    setBackendSourceStatus(`No se pudieron leer las fuentes backend: ${error.message}`, "warn");
  }
}

async function saveBackendSourcesFromInputs(options = {}) {
  const button = els["save-backend-sources"];
  const originalText = button?.textContent;
  if (button && !options.silent) {
    button.disabled = true;
    button.textContent = "Guardando...";
  }

  try {
    const response = await fetch(`${API_BASE_URL}/api/backend/sources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources: collectBackendSourceUrls() })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    (payload.sources || []).forEach((source) => {
      const input = document.querySelector(`[data-backend-url="${cssEscape(source.workbook)}"]`);
      if (input) {
        input.value = source.url || "";
        setBackendSourceEditing(input, false);
      }
    });
    if (!options.silent) setBackendSourceStatus("URLs backend guardadas.", "ok");
    return payload;
  } catch (error) {
    setBackendSourceStatus(`No se pudieron guardar las URLs backend: ${error.message}`, "warn");
    throw error;
  } finally {
    if (button && !options.silent) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function refreshBackendCache(workbooks = [], triggerButton = null) {
  const button = triggerButton || els["refresh-backend-cache"];
  const originalText = button?.textContent || "Refrescar backend";
  if (button) {
    button.disabled = true;
    button.textContent = "Guardando URLs...";
  }

  try {
    await saveBackendSourcesFromInputs({ silent: true });
    if (button) button.textContent = "Refrescando backend...";

    const response = await fetch(`${API_BASE_URL}/api/backend/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workbooks })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    backendDataMap = null;
    dataEditorSchema = null;
    purchaseBackendOptions = createPurchaseBackendOptions();
    if (document.getElementById("view-data-map")?.classList.contains("active")) loadDataMap(true);
    const warningCount = Array.isArray(payload.errors) ? payload.errors.length : 0;
    setBackendSourceStatus(
      warningCount
        ? `${backendRefreshLabel(workbooks)} refrescado con ${warningCount} aviso(s). Las tablas con problemas conservaron datos anteriores.`
        : `${backendRefreshLabel(workbooks)} refrescado correctamente.`,
      warningCount ? "warn" : "ok",
      payload.errors || []
    );
  } catch (error) {
    setBackendSourceStatus(`No se pudo refrescar el backend: ${error.message}`, "warn");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function backendRefreshLabel(workbooks) {
  return Array.isArray(workbooks) && workbooks.length === 1 ? workbooks[0].replace(/\.xlsx$/i, "") : "Backend";
}

async function loadDataMap(force = false) {
  if (backendDataMap && !force) {
    renderDataMap();
    return;
  }

  if (els["data-map-summary"]) els["data-map-summary"].textContent = "Leyendo estructura del backend...";
  try {
    const response = await fetch(`${API_BASE_URL}/api/backend/map`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    backendDataMap = payload.map || null;
    syncDataMapModuleOptions();
    renderDataMap();
  } catch (error) {
    if (els["data-map-summary"]) {
      els["data-map-summary"].textContent = `No se pudo cargar el mapa: ${error.message}`;
    }
    if (els["data-map-body"]) {
      els["data-map-body"].innerHTML = `<div class="data-map-empty">No se pudo leer el mapa de datos.</div>`;
    }
  }
}

function syncDataMapModuleOptions() {
  if (!els["data-map-module"] || !backendDataMap) return;
  const current = els["data-map-module"].value || "all";
  const modules = backendDataMap.modules || [];
  els["data-map-module"].innerHTML = [
    `<option value="all">Todos</option>`,
    ...modules.map((module) => `<option value="${escapeHtml(module)}">${escapeHtml(dataMapModuleLabel(module))}</option>`)
  ].join("");
  els["data-map-module"].value = modules.includes(current) ? current : "all";
}

function renderDataMap() {
  if (!els["data-map-body"] || !backendDataMap) return;

  const selectedModule = els["data-map-module"]?.value || "all";
  const onlyIssues = Boolean(els["data-map-only-issues"]?.checked);
  const tables = (backendDataMap.tables || []).filter((table) => {
    if (selectedModule !== "all" && table.module !== selectedModule) return false;
    if (onlyIssues && !table.issueCount) return false;
    return true;
  });
  const issueTables = (backendDataMap.tables || []).filter((table) => table.issueCount > 0).length;
  const updatedLabel = backendDataMap.generatedAt ? ` Ultima lectura: ${formatDateTime(backendDataMap.generatedAt)}.` : "";

  els["data-map-summary"].textContent =
    `${backendDataMap.tableCount} tablas, ${issueTables} con diferencias, ${backendDataMap.issueCount} columnas a revisar.${updatedLabel}`;

  if (!tables.length) {
    els["data-map-body"].innerHTML = `<div class="data-map-empty">No hay tablas para mostrar con este filtro.</div>`;
    return;
  }

  const byModule = groupBy(tables, "module");
  els["data-map-body"].innerHTML = Object.entries(byModule)
    .map(([module, moduleTables]) => dataMapModuleSection(module, moduleTables))
    .join("");
}

function dataMapModuleSection(module, tables) {
  const issueCount = tables.reduce((total, table) => total + table.issueCount, 0);
  return `
    <section class="data-map-module data-map-module-${escapeHtml(module)}">
      <header>
        <div>
          <h3>${escapeHtml(dataMapModuleLabel(module))}</h3>
          <span>${tables.length} tablas</span>
        </div>
        <strong class="${issueCount ? "has-issues" : "is-ok"}">${issueCount ? `${issueCount} diferencias` : "Sin diferencias"}</strong>
      </header>
      <div class="data-map-grid">
        ${tables.map(dataMapTableCard).join("")}
      </div>
    </section>
  `;
}

function dataMapTableCard(table) {
  const extraCount = table.extraColumns?.length || 0;
  const missingCount = table.missingColumns?.length || 0;
  return `
    <article class="data-map-card ${table.issueCount ? "has-issues" : "is-ok"}">
      <div class="data-map-card-head">
        <div>
          <h4>${escapeHtml(table.label || table.name)}</h4>
          <span>${escapeHtml(table.workbook)} · ${escapeHtml(table.sheet)}</span>
        </div>
        <strong>${formatNumber(table.rowCount)} filas</strong>
      </div>
      <div class="data-map-status-row">
        <span class="data-map-pill is-ok">${(table.matchedColumns || []).length} OK</span>
        <span class="data-map-pill ${extraCount ? "is-extra" : "is-muted"}">${extraCount} sobran</span>
        <span class="data-map-pill ${missingCount ? "is-missing" : "is-muted"}">${missingCount} faltan</span>
      </div>
      ${dataMapColumnGroup("Columnas importadas", table.actualColumns || [], table.expectedColumns || [], "actual")}
      ${missingCount ? dataMapMissingGroup(table.missingColumns) : ""}
    </article>
  `;
}

function dataMapColumnGroup(title, columns, expectedColumns, mode) {
  const expectedSet = new Set((expectedColumns || []).map(normalizeColumnName));
  return `
    <div class="data-map-columns">
      <span>${escapeHtml(title)}</span>
      <div>
        ${columns.length ? columns.map((column) => {
          const status = mode === "actual" && !expectedSet.has(normalizeColumnName(column)) ? "is-extra" : "is-ok";
          return `<mark class="data-map-column ${status}">${escapeHtml(column)}</mark>`;
        }).join("") : `<em>Sin columnas</em>`}
      </div>
    </div>
  `;
}

function dataMapMissingGroup(columns) {
  return `
    <div class="data-map-columns">
      <span>Faltantes del modelo</span>
      <div>${columns.map((column) => `<mark class="data-map-column is-missing">${escapeHtml(column)}</mark>`).join("")}</div>
    </div>
  `;
}

async function loadDataEditorSchema(force = false) {
  if (dataEditorSchema && !force) {
    renderDataEditorTableOptions();
    if (!dataEditorViews.primary.table && els["data-editor-table"]?.value) loadDataEditorTable("primary");
    return;
  }

  setDataEditorStatus("Leyendo tablas del backend...", "loading");
  try {
    const response = await fetch(`${API_BASE_URL}/api/backend/tables`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    dataEditorSchema = payload || null;
    renderDataEditorTableOptions();
    if (els["data-editor-table"]?.value) await loadDataEditorTable("primary");
  } catch (error) {
    setDataEditorStatus(`No se pudo cargar el editor: ${error.message}`, "warn");
  }
}

function createDataEditorViewState() {
  return {
    table: null,
    changedRows: new Map(),
    deletedRowIds: new Set(),
    selectedRowKey: "",
    columnFilters: {},
    openFilterColumn: "",
    visibleColumns: []
  };
}

function dataEditorViewState(viewId = "primary") {
  return dataEditorViews[viewId] || dataEditorViews.primary;
}

function dataEditorElementIds(viewId = "primary") {
  return viewId === "secondary"
    ? {
        table: "data-editor-table-secondary",
        rowStart: "data-editor-row-start-secondary",
        rowEnd: "data-editor-row-end-secondary",
        body: "data-editor-body-secondary",
        save: "data-editor-save-secondary"
      }
    : {
        table: "data-editor-table",
        rowStart: "data-editor-row-start",
        rowEnd: "data-editor-row-end",
        body: "data-editor-body",
        save: "data-editor-save"
      };
}

function renderDataEditorTableOptions() {
  if (!dataEditorSchema) return;
  const tables = dataEditorSchema.tables || [];
  const optionsHtml = tables.map((table) => (
    `<option value="${escapeHtml(table.name)}">${escapeHtml(table.label || table.name)}</option>`
  )).join("");
  ["data-editor-table", "data-editor-table-secondary"].forEach((id, index) => {
    if (!els[id]) return;
    const current = els[id].value;
    els[id].innerHTML = optionsHtml;
    const fallback = tables[index]?.name || tables[0]?.name || "";
    const selected = tables.some((table) => table.name === current) ? current : fallback;
    els[id].value = selected;
  });
}

function dataEditorTableName(viewId = "primary") {
  return els[dataEditorElementIds(viewId).table]?.value || "";
}

function dataEditorRowRange(viewId = "primary") {
  const ids = dataEditorElementIds(viewId);
  const rawStart = Number(els[ids.rowStart]?.value || 1);
  const rawEnd = Number(els[ids.rowEnd]?.value || 300);
  const start = Math.max(1, Number.isFinite(rawStart) ? Math.floor(rawStart) : 1);
  const end = Math.max(start, Number.isFinite(rawEnd) ? Math.floor(rawEnd) : start + 299);
  return {
    start,
    end,
    offset: start - 1,
    limit: end - start + 1
  };
}

async function loadDataEditorTable(viewId = "primary") {
  const tableName = dataEditorTableName(viewId);
  if (!tableName) return;
  const view = dataEditorViewState(viewId);
  const rowRange = dataEditorRowRange(viewId);
  view.changedRows = new Map();
  view.deletedRowIds = new Set();
  view.selectedRowKey = "";
  view.columnFilters = {};
  view.openFilterColumn = "";
  view.visibleColumns = [];
  setDataEditorStatus("Cargando tabla...", "loading");
  setDataEditorBodyHtml(viewId, `<div class="data-editor-empty">Cargando datos...</div>`);

  try {
    const params = new URLSearchParams({
      limit: String(rowRange.limit),
      offset: String(rowRange.offset),
      search: ""
    });
    const response = await fetch(`${API_BASE_URL}/api/backend/tables/${encodeURIComponent(tableName)}?${params}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    view.table = payload.table;
    renderDataEditorTable(viewId);
    if (viewId === "primary" && pendingDataEditorDraft?.tableName === tableName) {
      applyDataEditorDraft();
      return;
    }
    const lastVisibleRow = view.table.rows.length ? rowRange.start + view.table.rows.length - 1 : rowRange.start;
    setDataEditorStatus(`${view.table.totalRows} fila(s) en ${view.table.name}. Mostrando ${rowRange.start}-${lastVisibleRow}.`, "ok");
  } catch (error) {
    setDataEditorStatus(error.message, "warn");
    setDataEditorBodyHtml(viewId, `<div class="data-editor-empty">No se pudo cargar la tabla.</div>`);
  }
}

async function openDataEditorDraft(tableName, draftRow, message) {
  pendingDataEditorDraft = { tableName, row: draftRow, message };
  switchView("data-editor");
  await loadDataEditorSchema();
  if (els["data-editor-table"]) els["data-editor-table"].value = tableName;
  await loadDataEditorTable("primary");
}

function applyDataEditorDraft() {
  const view = dataEditorViewState("primary");
  if (!view.table || !pendingDataEditorDraft) return;
  const columns = dataEditorAllColumns("primary");
  const row = Object.fromEntries(columns.map((column) => [column, pendingDataEditorDraft.row[column] ?? ""]));
  view.table.rows = [...(view.table.rows || []), row];
  renderDataEditorTable("primary");

  const lastRow = els["data-editor-body"]?.querySelector("tbody tr:last-child");
  if (lastRow) {
    markDataEditorRowNew(lastRow.dataset.editorRow || "", "primary");
    selectDataEditorRow(lastRow.dataset.editorRow || "", "primary");
    const preparedRow = {};
    lastRow.querySelectorAll("[data-editor-input]").forEach((field) => {
      preparedRow[field.dataset.column] = field.value;
    });
    view.changedRows.set(lastRow.dataset.editorRow, preparedRow);
    lastRow.querySelector("input:not([readonly])")?.focus();
  }

  setDataEditorStatus(pendingDataEditorDraft.message || "Fila nueva precargada. Revisala y guardá.", "warn");
  pendingDataEditorDraft = null;
}

function renderDataEditorTable(viewId = "primary") {
  const view = dataEditorViewState(viewId);
  const bodyId = dataEditorElementIds(viewId).body;
  if (!els[bodyId] || !view.table) return;
  const allColumns = dataEditorAllColumns(viewId);
  initializeDataEditorVisibleColumns(viewId, allColumns);
  const columns = dataEditorColumns(viewId);
  const rows = dataEditorFilteredRows(viewId, columns);
  if (!columns.length) {
    setDataEditorBodyHtml(viewId, `<div class="data-editor-empty">Esta tabla no tiene columnas editables.</div>`);
    return;
  }

  setDataEditorBodyHtml(viewId, `
    ${dataEditorColumnSelectorHtml(viewId, allColumns)}
    <div class="table-wrap data-editor-table-wrap">
      <table class="data-editor-table">
        <thead>
          <tr>
            ${columns.map((column) => dataEditorHeaderCellHtml(column, viewId)).join("")}
          </tr>
          ${view.openFilterColumn ? `
            <tr class="data-editor-filter-row">
              ${columns.map((column) => dataEditorFilterCellHtml(column, viewId)).join("")}
            </tr>
          ` : ""}
        </thead>
        <tbody>
          ${rows.length ? rows.map((row, index) => dataEditorRowHtml(row, index, columns, viewId)).join("") : emptyRow(columns.length, "No hay filas para mostrar.")}
        </tbody>
      </table>
    </div>
  `);
}

function dataEditorFilteredRows(viewId = "primary", columns = dataEditorColumns(viewId)) {
  const view = dataEditorViewState(viewId);
  const filters = Object.entries(view.columnFilters || {})
    .filter(([, value]) => String(value ?? "").trim() !== "");
  const rows = view.table?.rows || [];
  if (!filters.length) return rows;

  return rows.filter((row) => filters.every(([column, filterValue]) => {
    const cellText = normalizeSearchText(row[column] ?? "");
    return cellText.includes(normalizeSearchText(filterValue));
  }));
}

function dataEditorHeaderCellHtml(column, viewId = "primary") {
  const view = dataEditorViewState(viewId);
  const hasFilter = String(view.columnFilters?.[column] ?? "").trim() !== "";
  const openClass = view.openFilterColumn === column ? " is-open" : "";
  const activeClass = hasFilter ? " is-active" : "";
  return `
    <th>
      <span class="data-editor-column-head">
        <span>${escapeHtml(column)}</span>
        <button
          type="button"
          class="data-editor-filter-button${openClass}${activeClass}"
          data-editor-filter-toggle
          data-column="${escapeHtml(column)}"
          title="Filtrar columna"
        >F</button>
      </span>
    </th>
  `;
}

function dataEditorFilterCellHtml(column, viewId = "primary") {
  const view = dataEditorViewState(viewId);
  if (view.openFilterColumn !== column) return `<th></th>`;
  return `
    <th>
      <input
        class="data-editor-filter-input"
        data-editor-filter-input
        data-column="${escapeHtml(column)}"
        value="${escapeHtml(view.columnFilters?.[column] ?? "")}"
        placeholder="Filtrar ${escapeHtml(column)}"
      >
    </th>
  `;
}

function setDataEditorBodyHtml(viewId, html) {
  const bodyId = dataEditorElementIds(viewId).body;
  if (els[bodyId]) els[bodyId].innerHTML = html;
}

function initializeDataEditorVisibleColumns(viewId, allColumns = dataEditorAllColumns(viewId)) {
  const view = dataEditorViewState(viewId);
  const current = Array.isArray(view.visibleColumns) ? view.visibleColumns : [];
  const primaryKey = dataEditorPrimaryKey(allColumns, viewId);
  const currentValidColumns = current.filter((column) => allColumns.includes(column));
  view.visibleColumns = currentValidColumns.length ? currentValidColumns : allColumns.slice();
  if (primaryKey && !view.visibleColumns.includes(primaryKey)) view.visibleColumns.unshift(primaryKey);
}

function dataEditorColumnSelectorHtml(viewId, allColumns) {
  const view = dataEditorViewState(viewId);
  const visibleSet = new Set(view.visibleColumns || []);
  const primaryKey = dataEditorPrimaryKey(allColumns, viewId);
  const selectedCount = allColumns.filter((column) => visibleSet.has(column)).length;
  return `
    <div class="data-editor-column-selector">
      <div class="data-editor-column-selector-head">
        <strong>Columnas visibles</strong>
        <span>${selectedCount} de ${allColumns.length}</span>
        <button type="button" class="secondary" data-editor-column-action="all">Ver todas</button>
        <button type="button" class="secondary" data-editor-column-action="base">Solo principales</button>
      </div>
      <div class="data-editor-column-options">
        ${allColumns.map((column) => {
          const isPrimary = column === primaryKey;
          return `
            <label>
              <input
                type="checkbox"
                data-editor-column-checkbox
                value="${escapeHtml(column)}"
                ${visibleSet.has(column) ? "checked" : ""}
                ${isPrimary ? "disabled" : ""}
              >
              <span>${escapeHtml(column)}</span>
            </label>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

function updateDataEditorVisibleColumns(viewId = "primary") {
  const view = dataEditorViewState(viewId);
  const bodyId = dataEditorElementIds(viewId).body;
  const allColumns = dataEditorAllColumns(viewId);
  const primaryKey = dataEditorPrimaryKey(allColumns, viewId);
  const checkedColumns = Array.from(els[bodyId]?.querySelectorAll("[data-editor-column-checkbox]:checked") || [])
    .map((input) => input.value)
    .filter((column) => allColumns.includes(column));

  view.visibleColumns = checkedColumns.length ? checkedColumns : [primaryKey].filter(Boolean);
  if (primaryKey && !view.visibleColumns.includes(primaryKey)) view.visibleColumns.unshift(primaryKey);
  view.openFilterColumn = view.visibleColumns.includes(view.openFilterColumn) ? view.openFilterColumn : "";
  renderDataEditorTable(viewId);
}

function applyDataEditorColumnAction(action, viewId = "primary") {
  const view = dataEditorViewState(viewId);
  const allColumns = dataEditorAllColumns(viewId);
  const primaryKey = dataEditorPrimaryKey(allColumns, viewId);
  if (action === "base") {
    const baseColumns = allColumns.filter((column) => {
      const normalized = normalizeColumnName(column);
      return column === primaryKey
        || normalized.startsWith("id")
        || normalized.includes("fecha")
        || normalized.includes("nombre")
        || normalized.includes("acreedor")
        || normalized.includes("proveedor")
        || normalized.includes("cliente")
        || normalized.includes("total")
        || normalized.includes("monto")
        || normalized.includes("cantidad");
    });
    view.visibleColumns = baseColumns.length ? baseColumns : allColumns.slice(0, Math.min(8, allColumns.length));
  } else {
    view.visibleColumns = allColumns.slice();
  }
  if (primaryKey && !view.visibleColumns.includes(primaryKey)) view.visibleColumns.unshift(primaryKey);
  view.openFilterColumn = "";
  renderDataEditorTable(viewId);
}

function dataEditorAllColumns(viewId = "primary") {
  const table = dataEditorViewState(viewId).table;
  const definitionColumns = (table?.definition?.columns || []).map((column) =>
    typeof column === "string" ? column : column.key || column.label || ""
  ).filter(Boolean);
  return definitionColumns.length
    ? definitionColumns
    : (table?.headers || [])
      .map((column) => typeof column === "string" ? column : column.key || column.label || "")
      .filter((column) => column && !String(column || "").startsWith("_"));
}

function dataEditorColumns(viewId = "primary") {
  const allColumns = dataEditorAllColumns(viewId);
  initializeDataEditorVisibleColumns(viewId, allColumns);
  const visibleSet = new Set(dataEditorViewState(viewId).visibleColumns || []);
  return allColumns.filter((column) => visibleSet.has(column));
}

function dataEditorRowHtml(row, index, columns, viewId = "primary") {
  const primaryKey = dataEditorPrimaryKey(columns, viewId);
  const rowKey = dataEditorRowKey(row, index, primaryKey);
  const selectedClass = rowKey === dataEditorViewState(viewId).selectedRowKey ? " is-selected" : "";
  return `
    <tr class="${selectedClass.trim()}" data-editor-row="${escapeHtml(rowKey)}">
      ${columns.map((column) => {
        const readonly = column === primaryKey && row[primaryKey];
        return `
          <td>
            ${dataEditorCellInputHtml(row, column, readonly)}
          </td>
        `;
      }).join("")}
    </tr>
  `;
}

function dataEditorCellInputHtml(row, column, readonly) {
  const value = String(row[column] ?? "");
  const input = `
    <input
      data-editor-input
      data-column="${escapeHtml(column)}"
      value="${escapeHtml(value)}"
      ${readonly ? "readonly" : ""}
    >
  `;
  if (column !== "archivo_recepcion" || !value.trim()) return input;
  const href = value.startsWith("http") || value.startsWith("/")
    ? value
    : `/${value.replace(/^\/+/, "")}`;
  return `
    <div class="data-editor-file-cell">
      ${input}
      <a href="${escapeHtml(href)}" target="_blank" rel="noopener">Abrir</a>
    </div>
  `;
}

function dataEditorRowKey(row, index, primaryKey) {
  if (row?.[primaryKey]) return String(row[primaryKey]);
  if (!row._editorRowKey) row._editorRowKey = `new-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`;
  return row._editorRowKey;
}

function dataEditorOriginalRowForKey(rowKey, viewId = "primary") {
  if (!rowKey) return null;
  const view = dataEditorViewState(viewId);
  const columns = dataEditorAllColumns(viewId);
  const primaryKey = dataEditorPrimaryKey(columns, viewId);
  return (view.table?.rows || []).find((row, index) => dataEditorRowKey(row, index, primaryKey) === rowKey) || null;
}

function dataEditorPrimaryKey(columns = dataEditorColumns(), viewId = "primary") {
  const table = dataEditorViewState(viewId).table;
  const rawPrimary = table?.definition?.primaryKey || "";
  const normalizedPrimary = normalizeColumnName(rawPrimary);
  return columns.find((column) => normalizeColumnName(column) === normalizedPrimary)
    || columns.find((column) => normalizeColumnName(column).startsWith("id"))
    || columns[0]
    || "";
}

function addDataEditorRow(viewId = "primary") {
  const view = dataEditorViewState(viewId);
  if (!view.table) {
    setDataEditorStatus("Primero elegi una tabla.", "warn");
    return;
  }
  const columns = dataEditorAllColumns(viewId);
  const newRow = Object.fromEntries(columns.map((column) => [column, ""]));
  newRow._editorRowKey = `new-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  view.table.rows = [
    ...(view.table.rows || []),
    newRow
  ];
  renderDataEditorTable(viewId);
  const lastRow = els[dataEditorElementIds(viewId).body]?.querySelector("tbody tr:last-child");
  const rowKey = lastRow?.dataset.editorRow || "";
  markDataEditorRowNew(rowKey, viewId);
  selectDataEditorRow(rowKey, viewId);
  lastRow?.querySelector("input:not([readonly])")?.focus();
  setDataEditorStatus("Fila nueva agregada al final. Completala y guardá.", "warn");
}

function markDataEditorRowChanged(input, viewId = "primary") {
  const rowElement = input.closest("[data-editor-row]");
  if (!rowElement) return;
  const view = dataEditorViewState(viewId);
  selectDataEditorRow(rowElement.dataset.editorRow || "", viewId);
  rowElement.classList.add("is-edited");
  const row = dataEditorOriginalRowForKey(rowElement.dataset.editorRow || "", viewId) || {};
  rowElement.querySelectorAll("[data-editor-input]").forEach((field) => {
    row[field.dataset.column] = field.value;
  });
  view.changedRows.set(rowElement.dataset.editorRow, row);
}

function toggleDataEditorColumnFilter(column, viewId = "primary") {
  if (!column) return;
  const view = dataEditorViewState(viewId);
  view.openFilterColumn = view.openFilterColumn === column ? "" : column;
  renderDataEditorTable(viewId);
  window.setTimeout(() => {
    const bodyId = dataEditorElementIds(viewId).body;
    els[bodyId]?.querySelector("[data-editor-filter-input]")?.focus();
  }, 0);
}

function updateDataEditorColumnFilter(input, viewId = "primary") {
  const column = input.dataset.column || "";
  if (!column) return;
  const view = dataEditorViewState(viewId);
  const value = input.value;
  if (String(value).trim()) {
    view.columnFilters[column] = value;
  } else {
    delete view.columnFilters[column];
  }
  renderDataEditorTable(viewId);
  window.setTimeout(() => {
    const bodyId = dataEditorElementIds(viewId).body;
    const reopenedInput = els[bodyId]?.querySelector(`[data-editor-filter-input][data-column="${CSS.escape(column)}"]`);
    if (reopenedInput) {
      reopenedInput.focus();
      reopenedInput.setSelectionRange(reopenedInput.value.length, reopenedInput.value.length);
    }
  }, 0);
}

function selectDataEditorRow(rowKey, viewId = "primary") {
  const view = dataEditorViewState(viewId);
  view.selectedRowKey = rowKey || "";
  const bodyId = dataEditorElementIds(viewId).body;
  els[bodyId]?.querySelectorAll("[data-editor-row]").forEach((rowElement) => {
    rowElement.classList.toggle("is-selected", rowElement.dataset.editorRow === view.selectedRowKey);
  });
}

function markDataEditorRowNew(rowKey, viewId = "primary") {
  if (!rowKey) return;
  const bodyId = dataEditorElementIds(viewId).body;
  els[bodyId]?.querySelectorAll(`[data-editor-row="${CSS.escape(rowKey)}"]`).forEach((rowElement) => {
    rowElement.classList.add("is-new");
  });
}

function deleteSelectedDataEditorRow(viewId = "primary") {
  const view = dataEditorViewState(viewId);
  if (!view.table) return;
  const rowKey = view.selectedRowKey;
  if (!rowKey) {
    setDataEditorStatus("Seleccioná una fila para eliminar.", "warn");
    return;
  }
  const bodyId = dataEditorElementIds(viewId).body;
  const rowElement = els[bodyId]?.querySelector(`[data-editor-row="${CSS.escape(rowKey)}"]`);
  if (!rowElement) {
    setDataEditorStatus("La fila seleccionada no esta visible con los filtros actuales.", "warn");
    return;
  }
  const columns = dataEditorAllColumns(viewId);
  const primaryKey = dataEditorPrimaryKey(columns, viewId);
  const row = {
    ...(dataEditorOriginalRowForKey(rowKey, viewId) || {}),
    ...dataEditorRowFromElement(rowElement)
  };
  const primaryValue = String(row?.[primaryKey] ?? "").trim();

  view.table.rows = (view.table.rows || []).filter((tableRow, index) => {
    const candidateKey = dataEditorRowKey(tableRow, index, primaryKey);
    return candidateKey !== rowKey;
  });

  view.changedRows.delete(rowKey);
  if (primaryValue) view.deletedRowIds.add(primaryValue);
  view.selectedRowKey = "";
  renderDataEditorTable(viewId);
  setDataEditorStatus(primaryValue ? "Fila marcada para eliminar. Guardá los cambios para confirmar." : "Fila nueva eliminada.", "warn");
}

function dataEditorRowFromElement(rowElement) {
  const row = {};
  rowElement?.querySelectorAll("[data-editor-input]").forEach((field) => {
    row[field.dataset.column] = field.value;
  });
  return row;
}

async function saveDataEditorChanges(viewId = "primary") {
  const view = dataEditorViewState(viewId);
  if (!view.table) {
    setDataEditorStatus("Primero elegi una tabla.", "warn");
    return;
  }

  const rows = Array.from(view.changedRows.values())
    .filter((row) => Object.values(row).some((value) => String(value ?? "").trim() !== ""));
  const deletedIds = Array.from(view.deletedRowIds);
  if (!rows.length && !deletedIds.length) {
    setDataEditorStatus("No hay cambios para guardar.", "warn");
    return;
  }

  const button = els[dataEditorElementIds(viewId).save];
  const originalText = button?.textContent || "Guardar cambios";
  const rowRange = dataEditorRowRange(viewId);
  if (button) {
    button.disabled = true;
    button.textContent = "Guardando...";
  }
  setDataEditorStatus("Guardando cambios...", "loading");

  try {
    const response = await fetch(`${API_BASE_URL}/api/backend/tables/${encodeURIComponent(view.table.name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rows,
        deletedIds,
        search: "",
        limit: rowRange.limit,
        offset: rowRange.offset
      })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    view.table = payload.table;
    view.changedRows = new Map();
    view.deletedRowIds = new Set();
    view.selectedRowKey = "";
    renderDataEditorTable(viewId);
    setDataEditorStatus(`Guardado: ${payload.updated || 0} modificada(s), ${payload.inserted || 0} nueva(s), ${payload.deleted || 0} eliminada(s).`, "ok");

    if (view.table.name === "datos_bancarios" && bankReconciliationFileText.trim()) {
      switchView("bank-reconciliation");
      await refreshBankReconciliationFromBackend();
      setBankReconciliationStatus("Detalle bancario guardado y asociacion actualizada.", "ok");
    }
  } catch (error) {
    setDataEditorStatus(error.message, "warn");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function setDataEditorStatus(message, status) {
  if (!els["data-editor-status"]) return;
  els["data-editor-status"].textContent = message || "";
  els["data-editor-status"].dataset.status = status || "";
}

async function loadSqlSchema(force = false) {
  if (backendSqlSchema && !force) {
    renderSqlTables();
    return;
  }

  if (els["sql-table-list"]) els["sql-table-list"].innerHTML = `<div class="sql-empty">Leyendo tablas...</div>`;
  try {
    const response = await fetch(`${API_BASE_URL}/api/backend/tables`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    backendSqlSchema = payload || null;
    renderSqlTables();
  } catch (error) {
    if (els["sql-table-list"]) els["sql-table-list"].innerHTML = `<div class="sql-empty">No se pudieron leer las tablas.</div>`;
    setSqlStatus(`No se pudo cargar el esquema: ${error.message}`, "warn");
  }
}

function renderSqlTables() {
  if (!els["sql-table-list"] || !backendSqlSchema) return;
  const tables = backendSqlSchema.tables || [];
  if (els["sql-table-count"]) els["sql-table-count"].textContent = `${tables.length} tablas`;

  const byModule = groupBy(tables, "module");
  els["sql-table-list"].innerHTML = Object.entries(byModule).map(([module, moduleTables]) => `
    <section class="sql-table-module">
      <h3>${escapeHtml(dataMapModuleLabel(module))}</h3>
      ${moduleTables.map((table) => `
        <button type="button" class="sql-table-button" data-sql-table="${escapeHtml(table.name)}">
          <strong>${escapeHtml(table.name)}</strong>
          <span>${escapeHtml(sqlTableColumnLabels(table).join(", "))}</span>
        </button>
      `).join("")}
    </section>
  `).join("");

  els["sql-table-list"].querySelectorAll("[data-sql-table]").forEach((button) => {
    button.addEventListener("click", () => {
      els["sql-query"].value = `SELECT * FROM ${button.dataset.sqlTable} LIMIT 20`;
      runSqlQuery();
    });
  });
}

function sqlTableColumnLabels(table) {
  return (table.headers || table.columns || []).map((header) => {
    if (typeof header === "string") return header;
    return header.key || header.label || "";
  }).filter(Boolean);
}

async function runSqlQuery() {
  const sql = els["sql-query"]?.value || "";
  if (!sql.trim()) {
    setSqlStatus("Escribi una consulta SQL.", "warn");
    return;
  }

  const originalText = els["sql-run"]?.textContent;
  if (els["sql-run"]) {
    els["sql-run"].disabled = true;
    els["sql-run"].textContent = "Ejecutando...";
  }
  setSqlStatus("Ejecutando consulta...", "loading");

  try {
    const response = await fetch(`${API_BASE_URL}/api/backend/sql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    renderSqlResults(payload);
    const limitedLabel = payload.limited ? " Se muestran las primeras filas por limite." : "";
    setSqlStatus(`${payload.rowCount} fila(s) devueltas.${limitedLabel}`, "ok");
  } catch (error) {
    if (els["sql-results"]) els["sql-results"].innerHTML = "";
    setSqlStatus(error.message, "warn");
  } finally {
    if (els["sql-run"]) {
      els["sql-run"].disabled = false;
      els["sql-run"].textContent = originalText;
    }
  }
}

function renderSqlResults(payload) {
  if (!els["sql-results"]) return;
  const columns = payload.columns || [];
  const rows = payload.rows || [];
  if (!columns.length) {
    els["sql-results"].innerHTML = `<div class="sql-empty">La consulta no devolvio columnas.</div>`;
    return;
  }

  els["sql-results"].innerHTML = `
    <div class="sql-result-head">
      <strong>${escapeHtml(payload.table || "Resultado")}</strong>
      <span>${payload.rowCount} fila(s) devueltas</span>
    </div>
    <div class="table-wrap sql-table-wrap">
      <table>
        <thead>
          <tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${rows.length ? rows.map((row) => `
            <tr>${columns.map((column) => `<td>${escapeHtml(formatSqlCell(row[column]))}</td>`).join("")}</tr>
          `).join("") : emptyRow(columns.length, "La consulta no devolvio filas.")}
        </tbody>
      </table>
    </div>
  `;
}

function formatSqlCell(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toLocaleString("es-AR", { maximumFractionDigits: 4 });
  return value;
}

function setSqlStatus(message, status) {
  if (!els["sql-status"]) return;
  els["sql-status"].textContent = message;
  els["sql-status"].dataset.status = status;
}

function dataMapModuleLabel(module) {
  return {
    maestros: "Tablas maestras",
    compras: "Compras / Egresos / Pagos",
    inventario: "Inventario / Produccion",
    ventas: "Ventas / Cobros",
    sueldos: "Sueldos"
  }[module] || module;
}

function groupBy(rows, key) {
  return rows.reduce((groups, row) => {
    const groupKey = row[key] || "otros";
    groups[groupKey] = groups[groupKey] || [];
    groups[groupKey].push(row);
    return groups;
  }, {});
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function normalizeColumnName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function collectBackendSourceUrls() {
  const sources = {};
  document.querySelectorAll("[data-backend-url]").forEach((input) => {
    const value = input.value.trim();
    if (value) sources[input.dataset.backendUrl] = value;
  });
  return sources;
}

function editBackendSourceUrl(workbook) {
  const input = document.querySelector(`[data-backend-url="${cssEscape(workbook)}"]`);
  if (!input) return;
  setBackendSourceEditing(input, true);
  input.focus();
  input.select();
}

function setBackendSourceEditing(input, isEditing) {
  input.readOnly = !isEditing;
  input.classList.toggle("url-editing", isEditing);
}

function setBackendSourceStatus(message, status, errors = []) {
  const element = els["backend-sources-status"];
  if (!element) return;
  element.innerHTML = "";
  if (message) {
    const summary = document.createElement("div");
    summary.textContent = message;
    element.appendChild(summary);
  }

  if (errors.length) {
    const list = document.createElement("div");
    list.className = "backend-source-error-list";
    groupedBackendErrors(errors).forEach((error) => {
      const item = document.createElement("div");
      item.className = "backend-source-error-item";
      item.innerHTML = `
        <strong>${escapeHtml(error.workbook)} · ${escapeHtml(error.sheet)}</strong>
        <span>${escapeHtml(error.message)}</span>
      `;
      list.appendChild(item);
    });
    element.appendChild(list);
  }

  element.classList.toggle("ok", status === "ok");
  element.classList.toggle("warn", status === "warn");
}

function groupedBackendErrors(errors) {
  const grouped = new Map();
  errors.forEach((error) => {
    const workbook = error.workbook || "Planilla sin identificar";
    const sheet = error.sheet || "Solapa sin identificar";
    const key = `${workbook}|||${sheet}|||${error.error || "Problema sin detalle"}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        workbook,
        sheet,
        message: error.error || "Problema sin detalle",
        count: 0
      });
    }
    grouped.get(key).count += 1;
  });

  return [...grouped.values()].slice(0, 60).map((entry) => ({
    ...entry,
    message: entry.count > 1 ? `${entry.message} (${entry.count} casos)` : entry.message
  }));
}

function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal, cache: "no-store" })
    .catch((error) => {
      if (error.name === "AbortError") throw new Error("tiempo de espera agotado");
      throw error;
    })
    .finally(() => window.clearTimeout(timeoutId));
}

function fillImportUrlInputs() {
  document.querySelectorAll("[data-url]").forEach((input) => {
    const savedUrl = state.importUrls?.[input.dataset.url];
    if (savedUrl && !input.value.trim()) input.value = savedUrl;
    setImportUrlEditing(input, false);
  });
}

function saveImportUrl(input) {
  state.importUrls = state.importUrls || {};
  state.importUrls[input.dataset.url] = input.value.trim();
  localStorage.setItem(IMPORT_URLS_STORAGE_KEY, JSON.stringify(state.importUrls));
  saveState();
}

function saveAllImportUrlsFromInputs() {
  state.importUrls = state.importUrls || {};
  document.querySelectorAll("[data-url]").forEach((input) => {
    const value = input.value.trim();
    if (value) state.importUrls[input.dataset.url] = value;
  });
  localStorage.setItem(IMPORT_URLS_STORAGE_KEY, JSON.stringify(state.importUrls));
  saveState();
}

function importUrlEntries() {
  saveAllImportUrlsFromInputs();
  const entries = new Map();
  Object.entries({ ...DEFAULT_IMPORT_URLS, ...loadSavedImportUrls(), ...(state.importUrls || {}) }).forEach(([kind, url]) => {
    if (String(url || "").trim()) entries.set(kind, String(url).trim());
  });
  document.querySelectorAll("[data-url]").forEach((input) => {
    const value = input.value.trim();
    if (value) entries.set(input.dataset.url, value);
  });
  return [...entries.entries()].map(([kind, url]) => ({ kind, url }));
}

// Las URLs quedan protegidas por defecto para no modificar imports por accidente.
function editImportUrl(kind) {
  const input = document.querySelector(`[data-url="${kind}"]`);
  if (!input) return;

  setImportUrlEditing(input, true);
  input.focus();
  input.select();
}

function setImportUrlEditing(input, isEditing) {
  input.readOnly = !isEditing;
  input.classList.toggle("url-editing", isEditing);
}

function googleSheetCsvUrl(rawUrl, cacheBust = false) {
  const url = new URL(rawUrl);
  if (url.hostname !== "docs.google.com") {
    if (cacheBust) url.searchParams.set("_", String(Date.now()));
    return url.toString();
  }

  if (url.pathname.includes("/pub")) {
    url.pathname = url.pathname.replace("/pubhtml", "/pub");
    url.searchParams.set("output", "csv");
    if (cacheBust) url.searchParams.set("_", String(Date.now()));
    return url.toString();
  }

  const sheetMatch = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!sheetMatch) return rawUrl;

  const spreadsheetId = sheetMatch[1];
  const hashGid = url.hash.match(/gid=(\d+)/)?.[1];
  const gid = url.searchParams.get("gid") || hashGid || "0";
  const csvUrl = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export`);
  csvUrl.searchParams.set("format", "csv");
  csvUrl.searchParams.set("gid", gid);
  if (cacheBust) csvUrl.searchParams.set("_", String(Date.now()));
  return csvUrl.toString();
}

// Parser CSV propio para mantener la app liviana y soportar comillas con comas internas.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function parseCashRows(rows, source) {
  const manualSectionIndex = rows.findIndex((row) => normalizeHeader(row[0]) === "carga manual");
  const headerIndex = rows.findIndex((row, index) => (
    index > manualSectionIndex && normalizeHeader(row[0]) === "formato" && normalizeHeader(row[1]) === "monto"
  ));
  if (headerIndex === -1) return [];

  return rows.slice(headerIndex + 1)
    .filter((row) => row.some((cell) => String(cell || "").trim()))
    .map((row) => ({
      account: row[0] || "",
      amount: parseMoney(row[1] || ""),
      source
    }))
    .filter((row) => row.account && !row.account.toLowerCase().includes("tenencia"));
}

function parseCreditorRows(rows, source) {
  const headers = normalizedHeadersWithFallback(rows[0]);
  return rows.slice(1)
    .filter((cells) => cells.some((cell) => String(cell || "").trim()))
    .map((cells) => {
      const raw = Object.fromEntries(headers.map((header, i) => [header, cells[i] || ""]));
      return {
        id: pick(raw, ["id_acreedor", "id acreedor", "id"]),
        name: pick(raw, ["nombre", "acreedor", "proveedor"]),
        type: pick(raw, ["tipo", "categoria"]),
        taxId: pick(raw, ["cuit_cuil", "cuit cuil", "cuit", "cuil"]),
        bankAccount: pick(raw, ["cbu_alias", "cbu alias", "cbu", "alias"]),
        paymentAgreement: pick(raw, ["acuerdo_de_pago", "acuerdo de pago"]),
        source
      };
    })
    .filter((row) => row.name);
}

function parseProviderRows(rows, source) {
  const headers = normalizedHeadersWithFallback(rows[0]);
  return rows.slice(1)
    .map((cells) => {
      const raw = Object.fromEntries(headers.map((header, i) => [header, cells[i] || ""]));
      return {
        id: pick(raw, ["id_proveedor", "id proveedor", "id"]),
        name: pick(raw, ["nombre", "proveedor"]),
        type: pick(raw, ["tipo"]),
        creditorId: pick(raw, ["id_acreedor", "id acreedor"]),
        leadDays: parseQuantity(pick(raw, ["tiempo_estimado_entrega", "tiempo estimado entrega", "dias_entrega", "dias entrega"])),
        minimumOrder: parseQuantity(pick(raw, ["minimo de pedido", "minimo_pedido", "pedido minimo", "pedido_minimo", "minimo"])),
        phone: pick(raw, ["telefono"]),
        email: pick(raw, ["email"]),
        taxId: pick(raw, ["cuit"]),
        source
      };
    })
    .filter((row) => row.name);
}

function enrichInventoryDetailsWithInventory(rows) {
  const inventoryById = new Map((state.inventory || [])
    .filter((row) => row.id)
    .map((row) => [String(row.id), row]));
  const itemNames = inventoryItemNamesById();

  return rows.map((row) => {
    const inventory = inventoryById.get(String(row.inventoryId || ""));
    const itemName = row.itemName || itemNames.get(String(row.itemId || "")) || "";
    return {
      ...row,
      date: row.date || inventory?.date || "",
      turn: row.turn || inventory?.turn || "",
      itemName
    };
  });
}

function inventoryItemNamesById() {
  const names = new Map([
    ["0", "Contador Alipack"],
    ["3", "Barra_Pop"],
    ["4", "Granel Dulce"]
  ]);

  (state.itemInfo || []).forEach((row) => {
    if (row.itemId && row.itemName) names.set(String(row.itemId), row.itemName);
  });
  (state.supplyInfo || []).forEach((row) => {
    if (row.itemId && row.itemName) names.set(String(row.itemId), row.itemName);
  });

  return names;
}

function isLegacyInventoryImport(headers) {
  return headers.includes("id_inventario") && headers.includes("fecha") && !headers.includes("turno");
}

function isBlankTurnInventoryImport(headers, rawRows) {
  if (!headers.includes("id_inventario") || !headers.includes("fecha") || !headers.includes("turno")) return false;
  return rawRows.length > 0 && rawRows.every((row) => !pick(row, ["turno"]));
}

function isLegacyInventoryDetailImport(headers) {
  return headers.includes("id_inventario")
    && headers.includes("id_item")
    && (
      headers.includes("cantidad_formulario")
      || headers.includes("turno_mananacf")
      || headers.includes("turno_manana_cf")
      || headers.includes("turno_madrugadacf")
      || headers.includes("turno_madrugada_cf")
    );
}

function legacyInventoryRowsFromCurrentState() {
  return (state.inventory || [])
    .filter((row) => row.id && row.date && !row.turn)
    .map((row) => ({
      id_inventario: row.id,
      fecha: row.date,
      empleado: row.employeeId || "",
      id_empleado: row.employeeId || ""
    }));
}

function rebuildInventoryFromLegacyImports() {
  if (!legacyInventoryImportRows?.length || !legacyInventoryDetailImportRows?.length) return;

  const inventoryByOldId = new Map();
  legacyInventoryImportRows.forEach((raw) => {
    const oldId = pick(raw, ["id_inventario", "id inventario", "id"]);
    if (!oldId) return;
    inventoryByOldId.set(String(oldId), {
      oldId: String(oldId),
      date: parseDate(pick(raw, ["fecha", "date"])),
      employeeId: pick(raw, ["id_empleado", "id empleado", "empleado"])
    });
  });

  const detailByOldInventory = new Map();
  legacyInventoryDetailImportRows.forEach((raw) => {
    const oldId = pick(raw, ["id_inventario", "id inventario"]);
    if (!oldId) return;
    if (!detailByOldInventory.has(String(oldId))) detailByOldInventory.set(String(oldId), []);
    detailByOldInventory.get(String(oldId)).push(raw);
  });

  const newInventory = [];
  const newDetails = [];
  let nextInventoryId = 1;
  let nextDetailId = 1;
  const itemNames = inventoryItemNamesById();

  [...inventoryByOldId.values()]
    .sort((a, b) => numericId(a.oldId) - numericId(b.oldId))
    .forEach((legacyInventory) => {
      const detailRows = detailByOldInventory.get(legacyInventory.oldId) || [];
      if (!detailRows.length) return;

      legacyInventoryTurnDefinitions().forEach((turn) => {
        const detailsForTurn = detailRows
          .map((raw) => {
            const itemId = pick(raw, ["id_item", "id item"]);
            const quantity = cleanInventoryQuantity(pick(raw, turn.aliases));
            return {
              itemId,
              itemName: pick(raw, ["nombre_item", "nombre item", "producto", "item"]) || itemNames.get(String(itemId)) || "",
              quantity
            };
          })
          .filter((row) => row.itemId && row.quantity !== "");

        if (!detailsForTurn.length) return;

        newInventory.push({
          id: String(nextInventoryId),
          oldId: legacyInventory.oldId,
          date: legacyInventory.date,
          turn: turn.label,
          employeeId: legacyInventory.employeeId,
          value: 0
        });

        detailsForTurn.forEach((detail) => {
          newDetails.push({
            id: String(nextDetailId),
            inventoryId: String(nextInventoryId),
            oldInventoryId: legacyInventory.oldId,
            itemId: detail.itemId,
            date: legacyInventory.date,
            turn: turn.label,
            itemName: detail.itemName,
            quantity: parseQuantity(detail.quantity),
            recipeQuantity: parseQuantity(detail.quantity),
            individualQuantity: isInventoryProduct(detail.itemName) ? inventoryProductUnits(detail.itemName, parseQuantity(detail.quantity)) : 0,
            isProduct: isInventoryProduct(detail.itemName)
          });
          nextDetailId += 1;
        });

        nextInventoryId += 1;
      });
    });

  state.inventory = newInventory;
  state.inventoryDetails = newDetails;
}

function legacyInventoryTurnDefinitions() {
  return [
    {
      key: "dawn",
      label: "Madrugada",
      aliases: ["turno_madrugadacf", "turno madrugada cf", "turno_madrugada_cf", "turno madrugada"]
    },
    {
      key: "morning",
      label: "Mañana",
      aliases: ["turno_mananacf", "turno mañana cf", "turno_manana_cf", "turno_mañana_cf", "turno mañana"]
    },
    {
      key: "afternoon",
      label: "Tarde",
      aliases: ["cantidad_formulario", "cantidad formulario", "turno_tarde", "turno tarde", "tarde"]
    }
  ];
}

function cleanInventoryQuantity(value) {
  const text = String(value ?? "").trim();
  if (!text || /^[-—–_]+$/.test(text)) return "";
  return text;
}

/*
  NormalizaciĂłn por tipo de archivo.
  Las fuentes reales no comparten nombres exactos de columnas, por eso se buscan
  alias posibles y se devuelve una estructura uniforme para cĂˇlculos y tablas.
*/
function parseRow(kind, raw) {
  const date = parseDate(pick(raw, kind === "sales"
    ? ["fecha_entregado", "fecha entregado", "fecha", "date", "fecha_factura"]
    : ["fecha_efectiva", "fecha efectiva", "fecha", "date", "fecha_factura"]));

  if (kind === "orderDetails") {
    return {
      date: parseDate(pick(raw, ["fecha_entrega", "fecha entrega", "fecha_entregado", "fecha entregado", "fecha", "date", "fecha_factura"])),
      saleId: pick(raw, ["id_venta", "id venta"]),
      orderId: pick(raw, ["id_pedido", "id pedido", "pedido"]),
      product: pick(raw, ["producto", "producto_nombre", "nombre_producto"]),
      customer: pick(raw, ["cliente", "nombre_cliente"]),
      individualQuantity: parseQuantity(pick(raw, ["cantidad_individual", "cantidad individual", "cantidad", "unidades"]))
    };
  }

  if (kind === "recipes") {
    return {
      productId: pick(raw, ["id_producto", "id producto"]),
      productName: pick(raw, ["nombre", "producto"]),
      componentName: pick(raw, ["item", "insumo", "subproducto"]),
      componentId: pick(raw, ["id_item", "id item"]),
      unit: pick(raw, ["ud_receta", "ud receta", "unidad"]),
      quantity: parseQuantity(pick(raw, ["cantidad"])),
      type: pick(raw, ["tipo"]),
      cost: parseMoney(pick(raw, ["costo"]))
    };
  }

  if (kind === "itemInfo") {
    return {
      itemId: pick(raw, ["id_item", "id item", "id"]),
      itemName: pick(raw, ["nombre", "item", "nombre_item", "nombre item"]),
      type: pick(raw, ["tipo"]),
      countUnit: pick(raw, ["ud_conteo", "ud conteo"]),
      recipeUnitFactor: parseQuantity(pick(raw, ["traduccion_ud_receta", "traduccion ud receta", "traduccion"]))
    };
  }

  if (kind === "supplyInfo") {
    return {
      supplyId: pick(raw, ["id_insumo", "id insumo", "id"]),
      itemId: pick(raw, ["id_item", "id item"]),
      itemName: pick(raw, ["nombre", "insumo", "nombre_item", "nombre item"]),
      supplierUnit: pick(raw, ["ud_proveedor", "ud proveedor"]),
      recipeUnit: pick(raw, ["ud_receta", "ud receta"]),
      recipeQuantity: parseQuantity(pick(raw, ["cantidad_receta", "cantidad receta"])),
      price: parseMoney(pick(raw, ["subtotal", "precio", "precio_unitario", "precio unitario", "precio_proveedor", "precio proveedor"])),
      ivaRate: parseRate(pick(raw, ["iva", "iva_%", "iva %", "porcentaje_iva", "porcentaje iva"])),
      supplier: pick(raw, ["nombre_proveedor", "nombre proveedor", "proveedor"]),
      supplierId: pick(raw, ["id_proveedor", "id proveedor"]),
      type: pick(raw, ["tipo"])
    };
  }

  if (kind === "inventory") {
    return {
      id: pick(raw, ["id_inventario", "id inventario", "id"]),
      date,
      turn: pick(raw, ["turno"]),
      employeeId: pick(raw, ["id_empleado", "id empleado", "empleado"]),
      value: parseMoney(pick(raw, ["monetario", "valor monetizado total del inventario", "valor monetizado", "valor", "inventario"]))
    };
  }

  if (kind === "inventoryDetails") {
    const inventoryId = pick(raw, ["id_inventario", "id inventario"]);
    const itemId = pick(raw, ["id_item", "id item"]);
    const itemName = pick(raw, ["nombre_item", "nombre item", "producto", "item"]);
    const recipeQuantity = parseQuantity(pick(raw, ["cantidad_receta_basica", "cantidad receta basica", "cantidad_rb", "cantidad rb"]));
    const quantity = parseQuantity(pick(raw, ["cantidad", "cantidad_formulario", "cantidad formulario"]));
    const isProduct = isInventoryProduct(itemName);
    return {
      id: pick(raw, ["id_detalle_inventario", "id detalle inventario", "id"]),
      inventoryId,
      itemId,
      date: parseDate(pick(raw, ["fecha", "date"])),
      turn: pick(raw, ["turno"]),
      itemName,
      quantity,
      recipeQuantity,
      individualQuantity: isProduct ? inventoryProductUnits(itemName, recipeQuantity) : 0,
      isProduct
    };
  }

  if (kind === "payroll") {
    const monthValue = pick(raw, ["mes", "periodo"]);
    const workedHours = parseQuantity(pick(raw, ["hs_trabajadas", "hs trabajadas", "horas trabajadas"]));
    const extraHours = parseQuantity(pick(raw, ["hs_extra", "hs extra", "horas extra"]));
    return {
      date: parsePayrollMonth(monthValue),
      monthCode: String(monthValue || "").trim(),
      employee: pick(raw, ["empleado", "nombre"]),
      workedHours,
      extraHours,
      totalHours: workedHours + extraHours
    };
  }

  if (kind === "purchases") {
    return {
      id: pick(raw, ["id_compra", "id compra", "id"]),
      date: parseDate(pick(raw, ["fecha_pedido", "fecha pedido", "fecha"])),
      supplier: pick(raw, ["proveedor"]),
      supplierId: pick(raw, ["id_proveedor", "id proveedor"]),
      expectedDeliveryDate: parseDate(pick(raw, ["fecha_entrega_prevista", "fecha entrega prevista"]))
    };
  }

  if (kind === "purchaseDetails") {
    return {
      id: pick(raw, ["id_compra", "id compra"]),
      date: parseDate(pick(raw, ["fecha", "fecha_entrega", "fecha entrega"])),
      itemId: pick(raw, ["id_insumo", "id insumo"]),
      itemName: pick(raw, ["insumo", "item", "nombre_item", "nombre item"]),
      supplierUnit: pick(raw, ["ud_proveedor", "ud proveedor", "unidad"]),
      quantity: parseQuantity(pick(raw, ["cantidad"])),
      supplier: pick(raw, ["proveedor", "nombre_proveedor", "nombre proveedor", "columna_8"])
    };
  }

  if (kind === "issuedChecks") {
    return {
      date: parseDate(pick(raw, ["fecha_entregado", "fecha entregado", "fecha"])),
      amount: parseMoney(pick(raw, ["monto"])),
      supplier: pick(raw, ["acreedor", "proveedor"]),
      checkNumber: pick(raw, ["nro_cheque", "nro cheque", "cheque"]),
      useDate: parseDate(pick(raw, ["fecha_de_uso", "fecha de uso"])),
      status: pick(raw, ["estado"])
    };
  }

  if (kind === "receivedChecks") {
    return {
      date: parseDate(pick(raw, ["fecha_entregado", "fecha entregado", "fecha"])),
      amount: parseMoney(pick(raw, ["monto"])),
      customer: pick(raw, ["cliente"]),
      checkNumber: pick(raw, ["nro_cheque", "nro cheque", "cheque"]),
      useDate: parseDate(pick(raw, ["fecha_de_uso", "fecha de uso"])),
      status: pick(raw, ["estado"]),
      bank: pick(raw, ["banco"])
    };
  }

  const common = {
    id: pick(raw, ["id_egreso", "id_venta", "id", "id venta"]),
    orderId: pick(raw, ["id_pedido", "id pedido", "pedido"]),
    date,
    invoiceType: pick(raw, ["tipo_factura", "tipo de factura", "factura", "tipo factura"]),
    invoiceNumber: pick(raw, ["nro_factura", "nro factura", "numero_factura", "numero factura", "n factura"]),
    subtotal: parseMoney(pick(raw, ["subtotal", "sub_total", "neto", "importe neto"])),
    vat: parseMoney(pick(raw, ["iva"])),
    vatRetention: parseMoney(pick(raw, ["per_ret_iva", "retenciones/percepciones", "retenciones", "percepciones", "retenciones percepciones"])),
    iibbRetention: parseMoney(pick(raw, ["per_ret_iibb"])),
    incomeTaxRetention: parseMoney(pick(raw, ["ret_ganancias", "ret_gan"])),
    internalTaxes: parseMoney(pick(raw, ["i. internos", "i internos", "impuestos internos"])),
    total: parseMoney(pick(raw, ["monto total", "total", "importe total"])),
    amountCancelled: parseMoney(pick(raw, ["monto_cancelado", "monto cancelado", "cancelado"])),
    balance: parseMoney(pick(raw, ["saldo"]))
  };
  common.withholdings = common.vatRetention + common.iibbRetention + common.incomeTaxRetention;

  if (kind === "expenses") {
    const total = common.total || common.subtotal + common.vat + common.vatRetention + common.iibbRetention + common.incomeTaxRetention + common.internalTaxes;
    return {
      ...common,
      total,
      supplier: pick(raw, ["nombre_acreedor", "acreedor", "proveedor"]),
      category: pick(raw, ["tipo", "categoria de gasto", "categoria", "rubro"]),
      invoiceType: pick(raw, ["tipo_factura", "tipo de factura", "factura", "tipo factura"]),
      expectedPaymentDate: parseDate(pick(raw, ["fecha_prevista_pago", "fecha prevista pago", "fecha prevista de pago"]))
    };
  }

  const customer = pick(raw, ["cliente"]);
  return {
    ...common,
    customer,
    category: classifySaleCustomer(customer),
    productCategory: pick(raw, ["categoria o producto", "categoria", "producto"]),
    balance: common.balance || common.total - common.amountCancelled,
    expectedCollectionDate: parseDate(pick(raw, ["fecha_acordada", "fecha acordada"]))
  };
}

function classifySaleCustomer(customer) {
  const normalizedCustomer = normalizeCategory(customer);
  const entry = Object.entries(SALES_CLASSIFICATION_BY_CUSTOMER)
    .find(([name]) => normalizeCategory(name) === normalizedCustomer);
  return entry ? entry[1] : "Sin Clasificar";
}

// Normaliza encabezados de Google Sheets/CSV para tolerar tildes y diferencias menores.
function normalizedHeadersWithFallback(headers) {
  return headers.map((header, index) => normalizeHeader(header) || `columna_${index + 1}`);
}

function normalizeHeader(value) {
  return removeAccents(value).trim().toLowerCase().replace(/\s+/g, " ");
}

function removeAccents(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function pick(raw, names) {
  for (const name of names) {
    const value = raw[normalizeHeader(name)];
    if (value !== undefined && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

// Devuelve fechas ISO yyyy-mm-dd o null; null permite registrar errores de importaciĂłn.
function parseDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return makeDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const slash = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (slash) {
    const year = Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]);
    return makeDate(year, Number(slash[2]), Number(slash[1]));
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return toIsoDate(parsed);
}

function parsePayrollMonth(value) {
  const text = String(value || "").trim();
  const compact = text.replace(/\D/g, "");

  if (compact.length === 6) {
    const year = Number(compact.slice(0, 4));
    const month = Number(compact.slice(4, 6));
    if (year >= 2000 && month >= 1 && month <= 12) {
      return toIsoDate(new Date(year, month - 1, 1));
    }
  }

  return parseDate(text);
}

function makeDate(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return toIsoDate(date);
}

function toIsoDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

/*
  Normaliza importes argentinos y CSV exportados en formato US.
  Soporta "$1,476.94", "$1.476,94", "$1476,94" y valores vacĂ­os.
*/
function parseMoney(value) {
  const text = String(value || "")
    .replace(/\$/g, "")
    .replace(/\s/g, "")
    .trim();

  if (!text) return 0;

  const hasComma = text.includes(",");
  const hasDot = text.includes(".");
  let normalized = text;

  if (hasComma && hasDot) {
    normalized = text.lastIndexOf(",") > text.lastIndexOf(".")
      ? text.replace(/\./g, "").replace(",", ".")
      : text.replace(/,/g, "");
  } else if (hasComma) {
    normalized = text.replace(",", ".");
  }

  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function parseQuantity(value) {
  const text = String(value || "")
    .replace(/\s/g, "")
    .trim();

  if (!text) return 0;

  const normalized = text.includes(",") && !text.includes(".")
    ? text.replace(",", ".")
    : text.replace(/,/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function parseRate(value) {
  const text = String(value || "").replace("%", "").trim();
  if (!text) return 0;
  const number = parseQuantity(text);
  if (!Number.isFinite(number)) return 0;
  return number > 1 ? number / 100 : number;
}

// Render principal: calcula una vez el reporte mensual y reutiliza ese resultado.
function render() {
  const report = buildReport(state.selectedYear, state.selectedMonth);
  const comparisonReport = buildComparisonReport();
  renderStatement(report, comparisonReport);
  renderWarnings(report);
  renderTables(report);
  renderFinancialStatement();
  renderCashflow();
  renderCreditors();
  updatePurchaseProviderOptions();
  updateInventoryPurchaseAlerts();
  renderCounts();
  loadBackendStatementReport();
  loadBackendCashflowReport();
}

async function loadBackendStatementReport() {
  const requestId = backendStatementRequestId + 1;
  backendStatementRequestId = requestId;

  try {
    const params = new URLSearchParams({
      year: String(state.selectedYear),
      month: String(state.selectedMonth),
      comparison: state.selectedComparison || "none"
    });
    const response = await fetch(`${API_BASE_URL}/api/reports/income-statement?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo leer el Estado de Resultados desde backend.");
    if (requestId !== backendStatementRequestId) return;

    renderStatement(payload.report, payload.comparisonReport || null);
    renderWarnings(payload.report);
    renderTables(payload.report);
  } catch (error) {
    // El calculo local queda como respaldo si el backend todavia no esta disponible.
  }
}

async function loadBackendCashflowReport() {
  const requestId = backendCashflowRequestId + 1;
  backendCashflowRequestId = requestId;

  try {
    const response = await fetch(`${API_BASE_URL}/api/reports/cashflow`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo leer el cashflow desde backend.");
    if (requestId !== backendCashflowRequestId) return;
    backendCashflowReport = payload.report;
    renderCashflow();
  } catch (error) {
    // Si el backend no responde, la pantalla conserva el ultimo cashflow disponible.
  }
}

function setupBankReconciliationFileDropZone() {
  setupFileDropZone({
    dropZone: els["bank-reconciliation-drop-zone"],
    input: els["bank-reconciliation-file"],
    onAccepted: () => readBankReconciliationFile()
  });
}

function readBankReconciliationFile() {
  const file = els["bank-reconciliation-file"]?.files?.[0];
  if (!file) {
    clearBankReconciliationFile();
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    bankReconciliationFileText = String(reader.result || "");
    updateBankReconciliationFileChip(file);
    setBankReconciliationStatus("Extracto listo para analizar.", "ok");
  };
  reader.onerror = () => setBankReconciliationStatus("No se pudo leer el archivo del banco.", "warn");
  reader.readAsText(file, "windows-1252");
}

function updateBankReconciliationFileChip(file) {
  els["bank-reconciliation-file-chip"]?.classList.remove("is-empty");
  if (els["bank-reconciliation-file-name"]) els["bank-reconciliation-file-name"].textContent = file.name;
  if (els["bank-reconciliation-file-size"]) els["bank-reconciliation-file-size"].textContent = `${Math.round(file.size / 1024)} KB`;
}

function clearBankReconciliationFile() {
  bankReconciliationFileText = "";
  bankReconciliationReport = null;
  bankCheckDepositDraft = null;
  if (els["bank-reconciliation-file"]) els["bank-reconciliation-file"].value = "";
  els["bank-reconciliation-file-chip"]?.classList.add("is-empty");
  if (els["bank-reconciliation-file-name"]) els["bank-reconciliation-file-name"].textContent = "Sin archivo";
  if (els["bank-reconciliation-file-size"]) els["bank-reconciliation-file-size"].textContent = "";
  renderBankReconciliation();
}

function refreshBankReconciliationFromBackend() {
  if (!bankReconciliationFileText.trim() || bankReconciliationRefreshPromise) {
    return bankReconciliationRefreshPromise;
  }

  bankReconciliationRefreshPromise = analyzeBankReconciliation({ preserveExcludedMovements: true })
    .finally(() => {
      bankReconciliationRefreshPromise = null;
    });
  return bankReconciliationRefreshPromise;
}

async function analyzeBankReconciliation({ preserveExcludedMovements = false } = {}) {
  if (!bankReconciliationFileText.trim()) {
    setBankReconciliationStatus("Primero carga el CSV del banco.", "warn");
    return;
  }

  const button = els["bank-reconciliation-analyze"];
  if (!preserveExcludedMovements) bankReconciliationExcludedMovementKeys = new Set();
  const originalText = button?.textContent || "Analizar movimientos";
  if (button) {
    button.disabled = true;
    button.textContent = "Analizando...";
  }

  try {
    const response = await fetch(`${API_BASE_URL}/api/bank-reconciliation/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bank: els["bank-reconciliation-bank"]?.value || "ICBC",
        csvText: bankReconciliationFileText
      })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo analizar el extracto.");
    bankReconciliationReport = payload.report;
    renderBankReconciliation();
    void refreshBankReconciliationOpenDebtCreditors(bankReconciliationReport);
  } catch (error) {
    setBankReconciliationStatus(error.message, "warn");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function applyBankReconciliation(applyMode) {
  if (!bankReconciliationFileText.trim() || !bankReconciliationReport?.movements?.length) {
    setBankReconciliationStatus("Primero analiza el extracto antes de conciliar.", "warn");
    return;
  }

  const stageConfig = {
    createExpenses: {
      status: "agregar_gasto",
      button: els["bank-create-expenses"],
      progressText: "Agregando gastos..."
    },
    createEgresses: {
      status: "agregar_egreso",
      button: els["bank-create-egresses"],
      progressText: "Agregando egresos..."
    },
    createPayments: {
      status: "agregar_pago",
      button: els["bank-create-payments"],
      progressText: "Agregando pagos..."
    },
    reconcile: {
      status: "listo",
      button: els["bank-reconciliation-apply"],
      progressText: "Conciliando..."
    }
  }[applyMode];
  if (!stageConfig) return;

  const stageMovements = bankReconciliationMovementsByStatus(stageConfig.status);
  if (!stageMovements.length) {
    setBankReconciliationStatus("No hay movimientos disponibles para esta accion.", "warn");
    return;
  }

  const button = stageConfig.button;
  const originalText = button?.textContent || "Ejecutar";
  if (button) {
    button.disabled = true;
    button.textContent = stageConfig.progressText;
  }

  try {
    const response = await fetch(`${API_BASE_URL}/api/bank-reconciliation/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bank: els["bank-reconciliation-bank"]?.value || "ICBC",
        csvText: bankReconciliationFileText,
        applyMode,
        movementKeys: stageMovements.map((movement) => movement.movementKey),
        reviewRows: collectBankReconciliationReviewRows(stageConfig.status)
      })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo conciliar el banco.");
    const result = payload.result || {};
    await analyzeBankReconciliation();
    const stageMessage = {
      createExpenses: `${result.expensesCreated || 0} gasto(s) agregado(s)`,
      createEgresses: `${result.egressesCreated || 0} egreso(s) agregado(s)`,
      createPayments: `${result.paymentsCreated || 0} pago(s) agregado(s)`,
      reconcile: `${result.movementsReconciled || 0} movimiento(s) conciliado(s)`
    }[applyMode];
    const note = Array.isArray(result.notes) && result.notes.length ? ` ${result.notes[0]}` : "";
    setBankReconciliationStatus(
      `${stageMessage}.${result.skipped ? ` ${result.skipped} movimiento(s) requieren revision.` : ""}${note}`,
      result.skipped && !result.expensesCreated && !result.egressesCreated && !result.paymentsCreated && !result.movementsReconciled ? "warn" : "ok"
    );
    loadBackendCashflowReport();
  } catch (error) {
    setBankReconciliationStatus(error.message, "warn");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function bankReconciliationMovementsByStatus(status) {
  const movements = (bankReconciliationReport?.movements || []).filter((movement) => (
    movement.status === status
    && !bankReconciliationExcludedMovementKeys.has(String(movement.movementKey || ""))
  ));

  const pendingMappedMovements = (bankReconciliationReport?.movements || []).filter((movement) => (
    ["agregar_gasto", "agregar_egreso", "agregar_pago"].includes(movement.status)
    && !bankReconciliationExcludedMovementKeys.has(String(movement.movementKey || ""))
    && movement.providerMatch?.type === "datos_bancarios"
  ));

  // First resolve movements with an explicit bank-detail mapping. Once there are
  // none left, the remaining unmatched movements become available for review.
  return pendingMappedMovements.length
    ? movements.filter((movement) => movement.providerMatch?.type === "datos_bancarios")
    : movements;
}

function collectBankReconciliationReviewRows(status) {
  const bodyByStatus = {
    agregar_gasto: els["bank-expense-stage-body"],
    agregar_egreso: els["bank-egress-stage-body"],
    agregar_pago: els["bank-payment-stage-body"]
  };
  const reviewRows = {};
  bodyByStatus[status]?.querySelectorAll("[data-bank-movement-key]").forEach((row) => {
    const movementKey = row.dataset.bankMovementKey;
    reviewRows[movementKey] = {};
    row.querySelectorAll("[data-bank-review-field]").forEach((input) => {
      reviewRows[movementKey][input.dataset.bankReviewField] = input.value;
    });
  });
  return reviewRows;
}

function renderBankReconciliation() {
  const summary = bankReconciliationReport?.summary || {};
  if (els["bank-reconciliation-real-balance"]) els["bank-reconciliation-real-balance"].textContent = formatBankMoney(summary.realBalance || 0);
  if (els["bank-reconciliation-reconciled"]) els["bank-reconciliation-reconciled"].textContent = String(summary.reconciledCount || 0);
  if (els["bank-reconciliation-pending"]) els["bank-reconciliation-pending"].textContent = String(summary.pendingCount || 0);
  if (els["bank-reconciliation-net-pending"]) els["bank-reconciliation-net-pending"].textContent = formatBankMoney(summary.netPending || 0);

  const movements = bankReconciliationReport?.movements || [];
  const visibleMovements = movements
    .map((movement, index) => ({ movement, index }))
    .filter(({ movement }) => movement.status !== "conciliado");
  const readyMovements = movements.filter((movement) => movement.status === "listo");
  if (els["bank-reconciliation-apply"]) els["bank-reconciliation-apply"].disabled = !readyMovements.length;
  renderBankReconciliationStages();
  renderBankCheckDepositReview();
  if (!movements.length) {
    if (els["bank-reconciliation-body"]) els["bank-reconciliation-body"].innerHTML = emptyRow(11, "Todavia no hay extracto analizado.");
    return;
  }

  setBankReconciliationStatus(
    `${visibleMovements.length} movimiento(s) pendientes de este extracto. ${readyMovements.length} listo(s) para conciliar.`,
    visibleMovements.length ? "ok" : ""
  );
  els["bank-reconciliation-body"].innerHTML = visibleMovements.length
    ? visibleMovements.map(({ movement, index }) => bankReconciliationRow(movement, index)).join("")
    : emptyRow(11, "Todos los movimientos de este extracto ya estan conciliados.");
}

function renderBankReconciliationStages() {
  renderBankReconciliationOptionLists();
  renderBankExpenseStage(bankReconciliationMovementsByStatus("agregar_gasto"));
  renderBankEgressStage(bankReconciliationMovementsByStatus("agregar_egreso"));
  renderBankPaymentStage(bankReconciliationMovementsByStatus("agregar_pago"));
}

function renderBankReconciliationOptionLists() {
  const options = bankReconciliationReport?.lookupOptions || {};
  const renderOptions = (id, values) => {
    const list = document.getElementById(id);
    if (!list) return;
    list.innerHTML = (values || [])
      .filter(Boolean)
      .map((value) => `<option value="${escapeHtml(value)}"></option>`)
      .join("");
  };
  renderOptions("bank-invoice-type-options", options.invoiceTypes);
  renderOptions("bank-payment-method-options", options.paymentMethods);
}

function renderBankExpenseStage(movements) {
  if (els["bank-expense-stage-count"]) els["bank-expense-stage-count"].textContent = String(movements.length);
  if (els["bank-create-expenses"]) els["bank-create-expenses"].disabled = !movements.length;
  if (!els["bank-expense-stage-body"]) return;
  els["bank-expense-stage-body"].innerHTML = movements.length
    ? movements.map((movement) => `
      <tr data-bank-movement-key="${escapeHtml(movement.movementKey || "")}">
        <td><input class="bank-stage-input" type="date" value="${escapeHtml(movement.date || "")}" data-bank-review-field="date"></td>
        <td>${escapeHtml(bankReconciliationCreditorLabel(movement))}</td>
        <td>${escapeHtml(bankReconciliationTagLabel(movement))}</td>
        <td>${escapeHtml(movement.sourceDestination?.label || "Otros gastos")}</td>
        <td><input class="bank-stage-input bank-stage-detail-input" value="${escapeHtml(movement.detail || movement.concept || "")}" data-bank-review-field="detail"></td>
        <td class="num">${formatBankMoney(Math.abs(movement.amount || 0))}</td>
        <td><button type="button" class="bank-stage-remove" data-bank-stage-remove="${escapeHtml(movement.movementKey || "")}">Quitar</button></td>
      </tr>
    `).join("")
    : emptyRow(7, "No hay gastos para agregar.");
}

function renderBankEgressStage(movements) {
  if (els["bank-egress-stage-count"]) els["bank-egress-stage-count"].textContent = String(movements.length);
  if (els["bank-create-egresses"]) els["bank-create-egresses"].disabled = !movements.length;
  if (!els["bank-egress-stage-body"]) return;
  els["bank-egress-stage-body"].innerHTML = movements.length
    ? movements.map((movement) => `
      <tr data-bank-movement-key="${escapeHtml(movement.movementKey || "")}">
        <td><input class="bank-stage-input" type="date" value="${escapeHtml(movement.sourceMatch?.date || movement.date || "")}" data-bank-review-field="date"></td>
        <td>${escapeHtml(bankReconciliationCreditorLabel(movement))}</td>
        <td>${escapeHtml(`${movement.sourceMatch?.label || "Gasto"} #${movement.sourceMatch?.id || "-"}`)}</td>
        <td>${escapeHtml(bankReconciliationTagLabel(movement))}</td>
        <td><input class="bank-stage-input" list="bank-invoice-type-options" value="${escapeHtml(movement.providerMatch?.invoiceType || movement.sourceMatch?.invoiceType || "")}" placeholder="Tipo de factura" data-bank-review-field="tipo_factura"></td>
        <td class="num">${formatBankMoney(Math.abs(movement.amount || 0))}</td>
      </tr>
    `).join("")
    : emptyRow(6, "No hay egresos para agregar.");
}

function renderBankPaymentStage(movements) {
  if (els["bank-payment-stage-count"]) els["bank-payment-stage-count"].textContent = String(movements.length);
  if (els["bank-create-payments"]) els["bank-create-payments"].disabled = !movements.length;
  if (!els["bank-payment-stage-body"]) return;
  els["bank-payment-stage-body"].innerHTML = movements.length
    ? movements.map((movement) => `
      <tr data-bank-movement-key="${escapeHtml(movement.movementKey || "")}">
        <td><input class="bank-stage-input" type="date" value="${escapeHtml(movement.date || "")}" data-bank-review-field="date"></td>
        <td>${escapeHtml(bankReconciliationCreditorLabel(movement))}</td>
        <td>${escapeHtml(`Egreso #${movement.match?.id || "-"}${movement.match?.description ? ` · ${movement.match.description}` : ""}`)}</td>
        <td>${escapeHtml(els["bank-reconciliation-bank"]?.value || "-")}</td>
        <td><input class="bank-stage-input" list="bank-payment-method-options" value="${escapeHtml(bankPaymentMethodSuggestion(movement))}" placeholder="Metodo de pago" data-bank-review-field="metodo"></td>
        <td class="num">${formatBankMoney(Math.abs(movement.amount || 0))}</td>
      </tr>
    `).join("")
    : emptyRow(6, "No hay pagos para agregar.");
}

function bankPaymentMethodSuggestion(movement) {
  const detail = String([movement?.detail, movement?.concept].filter(Boolean).join(" ")).toLowerCase();
  if (movement?.checkNumber || detail.includes("cheque") || detail.includes("echeq") || detail.includes("ch camara")) return "Cheque";
  if (detail.includes("transfer") || detail.includes("tr.")) return "Transferencia";
  if (detail.includes("debito")) return "Debito";
  return "Movimiento bancario";
}

function bankReconciliationRow(movement, index) {
  const statusLabel = {
    conciliado: "Conciliada",
    listo: "Lista para conciliar",
    agregar_pago: "Agregar pago",
    agregar_egreso: "Agregar egreso",
    agregar_gasto: "Agregar gasto",
    revisar: "Revisar"
  }[movement.status] || "Revisar";
  const match = movement.match
    ? `${movement.match.type || ""} #${movement.match.id || ""} · ${formatDate(movement.match.date)} · ${formatBankMoney(movement.match.amount || 0)}${movement.match.identity ? ` · ${movement.match.identity}` : ""}`
    : "-";
  const checkCell = bankReconciliationCheckCell(movement, index);
  const amountCell = bankReconciliationAmountCell(movement);
  const actionCell = bankReconciliationActionCell(movement, index);

  return `
    <tr class="bank-row-${escapeHtml(movement.status || "pending")}">
      <td>${formatDate(movement.date)}</td>
      <td>${escapeHtml(movement.detail || movement.concept || "-")}</td>
      <td>${escapeHtml(movement.cuit || "-")}</td>
      <td>${checkCell}</td>
      <td>${escapeHtml(bankReconciliationCreditorLabel(movement))}</td>
      <td>${escapeHtml(bankReconciliationTagLabel(movement))}</td>
      <td class="num">${amountCell}</td>
      <td class="num">${formatBankMoney(movement.balance || 0)}</td>
      <td><span class="bank-status-pill bank-status-${escapeHtml(movement.status || "pending")}">${statusLabel}</span></td>
      <td>${actionCell}</td>
      <td>${escapeHtml(match)}</td>
    </tr>
  `;
}

function bankReconciliationCheckCell(movement, index) {
  const checkNumber = String(movement.checkNumber || "").trim();
  if (!checkNumber) return "-";
  if (movement.checkMatch) {
    const label = movement.checkMatch.type === "cheque_entregado" ? "Cheque entregado encontrado" : "Cheque encontrado";
    return `<span class="bank-check-found">${escapeHtml(checkNumber)} · ${escapeHtml(label)}</span>`;
  }
  return `<span class="bank-check-number">${escapeHtml(checkNumber)}</span>`;
}

function bankReconciliationCreditorLabel(movement) {
  if (movement.provider) return movement.provider;
  return "-";
}

function bankReconciliationTagLabel(movement) {
  if (movement.tag) return movement.tag;
  if (Array.isArray(movement.tagOptions) && movement.tagOptions.length) return movement.tagOptions.join(" / ");
  if (movement.suggestedExpenseType) return movement.suggestedExpenseType;
  return "-";
}

function bankReconciliationAmountCell(movement) {
  if (movement.debit) return `<span class="bank-amount-debit">-${formatBankMoney(movement.debit)}</span>`;
  if (movement.credit) return `<span class="bank-amount-credit">${formatBankMoney(movement.credit)}</span>`;
  return "-";
}

function bankReconciliationActionCell(movement, index) {
  const baseAction = escapeHtml(movement.action || "-");
  if (["listo", "conciliado"].includes(movement.status)) return baseAction;
  const creditorId = bankMovementCreditorId(movement);
  const hasCuit = Boolean(String(movement.cuit || "").trim());
  const hasBankDetailRule = movement.providerMatch?.type === "datos_bancarios";
  const isCredit = Number(movement.amount) > 0;
  const hasKnownClient = isCredit && movement.providerMatch?.type === "cliente";
  const checkNumber = String(movement.checkNumber || "").trim();
  const buttons = [];

  if (isCredit && !movement.checkMatch && bankMovementLooksLikeCheckDeposit(movement)) {
    buttons.push(`<button type="button" class="bank-add-provider" data-bank-review-check-deposit="${index}">Revisar deposito</button>`);
  }

  if (!isCredit && creditorId && bankReconciliationOpenDebtCreditorIds.has(String(creditorId))) {
    buttons.push(`<button type="button" class="bank-add-provider" data-bank-review-debt="${index}">Revisar deuda</button>`);
  }

  if (hasKnownClient && !movement.match && !checkNumber) {
    buttons.push(`<button type="button" class="bank-add-provider" data-bank-add-collection="${index}">Agregar cobro</button>`);
  }

  if (!creditorId && !hasKnownClient && (movement.suggestedCounterparty?.name || movement.suggestedCounterparty?.cuit || movement.cuit || movement.cbuAlias)) {
    if (isCredit) {
      buttons.push(`<button type="button" class="bank-add-provider" data-bank-add-client="${index}">Agregar cliente</button>`);
      buttons.push(`<button type="button" class="bank-add-provider" data-bank-add-creditor="${index}">Agregar Acreedor</button>`);
      buttons.push(`<button type="button" class="bank-add-provider" data-bank-partner-contribution="${index}">Registrar aporte o retiro</button>`);
    } else {
      buttons.push(`<button type="button" class="bank-add-provider" data-bank-add-creditor="${index}">Agregar Acreedor</button>`);
    }
  }

  if (!checkNumber && !hasCuit && !hasBankDetailRule) {
    buttons.push(`<button type="button" class="bank-add-provider" data-bank-add-data="${index}">${creditorId ? "Agregar detalle bancario" : "Asociar detalle bancario"}</button>`);
  }

  if (checkNumber && !movement.checkMatch && movement.debit) {
    buttons.push(`<button type="button" class="bank-add-provider" data-bank-add-purchase="${index}">Agregar compra</button>`);
    buttons.push(`<button type="button" class="bank-add-provider" data-bank-add-reception="${index}">Agregar recepcion</button>`);
    buttons.push(`<button type="button" class="bank-add-provider" data-bank-add-issued-check="${index}">Agregar cheque entregado</button>`);
  } else if (checkNumber && !movement.checkMatch) {
    buttons.push(`<button type="button" class="bank-add-provider" data-bank-add-collection="${index}">Agregar cobro</button>`);
    buttons.push(`<button type="button" class="bank-add-provider" data-bank-add-check="${index}">Agregar cheque</button>`);
  }

  if (!buttons.length) return baseAction;
  return `
    <span>${baseAction}</span>
    <div class="bank-row-actions">
      ${buttons.join("")}
    </div>
  `;
}

function bankMovementLooksLikeCheckDeposit(movement) {
  const detail = `${movement?.detail || ""} ${movement?.concept || ""}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const isCredit = Number(movement?.amount || movement?.credit || 0) > 0;
  return isCredit && (detail.includes("dep ch") || detail.includes("deposit") || detail.includes("echeq"));
}

function bankPendingCheckDepositMovements() {
  return (bankReconciliationReport?.movements || [])
    .map((movement, index) => ({ movement, index }))
    .filter(({ movement }) => movement.status !== "conciliado" && !movement.checkMatch && bankMovementLooksLikeCheckDeposit(movement));
}

async function openBankCheckDepositReview(index = bankCheckDepositDraft?.movementIndex ?? null) {
  try {
    const previousDraft = bankCheckDepositDraft;
    const [checks, collections, clients] = await Promise.all([
      backendTableRowsForEntry("cheques_recibidos"),
      backendTableRowsForEntry("cobros").catch(() => []),
      backendTableRowsForEntry("clientes").catch(() => [])
    ]);
    const collectionsById = new Map(collections.map((row) => [String(row.id_cobro || ""), row]));
    const clientsById = new Map(clients.map((row) => [String(row.id_cliente || ""), row]));
    const candidates = checks
      .filter((row) => bankReceivedCheckCanBeDeposited(row))
      .map((row) => {
        const collection = collectionsById.get(String(row.id_cobro || ""));
        const client = clientsById.get(String(row.id_cliente || collection?.id_cliente || ""));
        return {
          id: String(row.id_cheque_recibido || ""),
          checkNumber: String(row.nro_cheque || "-"),
          client: String(row.cliente || client?.nombre_cliente || collection?.cliente || "-"),
          date: String(row.fecha_entregado || collection?.fecha_cobro || row.fecha_uso || ""),
          amount: Math.abs(bankCheckDepositNumber(row.monto))
        };
      })
      .filter((row) => row.id && row.amount > 0);

    const hasRequestedIndex = index !== null && index !== undefined && index !== "";
    const requestedIndex = hasRequestedIndex ? Number(index) : -1;
    const movementIndex = hasRequestedIndex && Number.isInteger(requestedIndex) && bankReconciliationReport?.movements?.[requestedIndex]
      ? requestedIndex
      : previousDraft?.movementKey
        ? bankReconciliationReport?.movements?.findIndex((item) => item.movementKey === previousDraft.movementKey) ?? -1
        : -1;
    const movement = movementIndex >= 0 ? bankReconciliationReport.movements[movementIndex] : null;
    bankCheckDepositDraft = {
      movementIndex: movement ? movementIndex : null,
      movementKey: movement?.movementKey || "",
      candidates,
      selectedIds: new Set(
        [...(previousDraft?.selectedIds || [])].filter((id) => candidates.some((check) => check.id === id))
      ),
      bank: previousDraft?.bank || els["bank-reconciliation-bank"]?.value || "ICBC",
      depositDate: movement
        ? bankCheckDepositDateInput(movement?.date)
        : previousDraft?.depositDate || new Date().toISOString().slice(0, 10)
    };
    renderBankCheckDepositReview();
  } catch (error) {
    setBankReconciliationStatus(`No se pudieron cargar los cheques pendientes: ${error.message}`, "warn");
  }
}

function bankReceivedCheckCanBeDeposited(row) {
  const status = String(row?.estado || "").trim().toLowerCase();
  return status === "pendiente";
}

function bankCheckDepositNumber(value) {
  return parseMoney(value);
}

function bankCheckDepositDateInput(value) {
  return parseDate(value) || "";
}

function bankCheckDepositMovementIndex(draft) {
  const movements = bankReconciliationReport?.movements || [];
  const index = Number(draft?.movementIndex);
  if (Number.isInteger(index) && movements[index]) {
    return index;
  }
  if (draft?.movementKey) return movements.findIndex((movement) => movement.movementKey === draft.movementKey);
  return -1;
}

function renderBankCheckDepositReview() {
  const panel = els["bank-check-deposit-panel"];
  const draft = bankCheckDepositDraft;
  const movementIndex = bankCheckDepositMovementIndex(draft);
  const movement = movementIndex >= 0 ? bankReconciliationReport?.movements?.[movementIndex] : null;
  if (!panel) return;
  const depositMovements = bankPendingCheckDepositMovements();
  const movementSelect = els["bank-check-deposit-movement"];
  const candidates = draft?.candidates || [];
  const selected = candidates.filter((check) => draft?.selectedIds.has(check.id));
  const credit = movement ? Math.abs(bankCheckDepositNumber(movement.amount || movement.credit)) : 0;
  const selectedTotal = selected.reduce((total, check) => total + check.amount, 0);
  const difference = credit - selectedTotal;
  const matches = Boolean(movement) && selected.length > 0 && Math.abs(difference) <= 0.01;
  const canConfirm = selected.length > 0 && (!movement || matches);
  panel.hidden = false;

  if (els["bank-check-deposit-date"]) els["bank-check-deposit-date"].value = draft?.depositDate || "";
  if (els["bank-check-deposit-bank"]) els["bank-check-deposit-bank"].value = draft?.bank || "ICBC";

  if (movementSelect) {
    movementSelect.innerHTML = `<option value="">Seleccionar crédito del extracto</option>${depositMovements.map(({ movement: item, index }) => {
      const amount = Math.abs(bankCheckDepositNumber(item.amount || item.credit));
      return `<option value="${index}">${escapeHtml(formatDate(item.date))} · ${escapeHtml(item.detail || item.concept || "Depósito")} · ${escapeHtml(formatBankMoney(amount))}</option>`;
    }).join("")}`;
    movementSelect.value = movement ? String(movementIndex) : "";
    movementSelect.disabled = !depositMovements.length;
  }
  if (els["bank-check-deposit-title"]) els["bank-check-deposit-title"].textContent = "Cheques pendientes de depositar";
  if (els["bank-check-deposit-credit"]) els["bank-check-deposit-credit"].textContent = movement ? formatBankMoney(credit) : "Sin extracto";
  if (els["bank-check-deposit-total"]) els["bank-check-deposit-total"].textContent = formatBankMoney(selectedTotal);
  const differenceElement = els["bank-check-deposit-difference"];
  if (differenceElement) {
    differenceElement.textContent = movement ? formatBankMoney(Math.abs(difference)) : "-";
    differenceElement.classList.toggle("is-match", matches);
    differenceElement.classList.toggle("is-mismatch", Boolean(movement) && selected.length > 0 && !matches);
  }
  if (els["bank-check-deposit-status-view"]) {
    els["bank-check-deposit-status-view"].textContent = !candidates.length
      ? "No hay cheques recibidos en estado pendiente para depositar."
      : !movement
        ? "Selecciona los cheques y registra el depósito. Se conciliará cuando aparezca el crédito en el extracto."
      : !selected.length
        ? "Selecciona los cheques que integran este depósito."
      : matches
        ? "La suma coincide con el crédito del banco."
        : difference > 0
          ? `Faltan ${formatBankMoney(difference)} para alcanzar el crédito del banco.`
          : `La selección supera el crédito por ${formatBankMoney(Math.abs(difference))}.`;
  }
  if (els["bank-check-deposit-body"]) {
    els["bank-check-deposit-body"].innerHTML = candidates.length
      ? candidates.map((check) => `
        <tr>
          <td><input type="checkbox" data-bank-check-deposit-select="${escapeHtml(check.id)}" ${draft?.selectedIds.has(check.id) ? "checked" : ""}></td>
          <td>${escapeHtml(check.checkNumber)}</td>
          <td>${escapeHtml(check.client)}</td>
          <td>${formatDate(check.date)}</td>
          <td class="num">${formatBankMoney(check.amount)}</td>
        </tr>
      `).join("")
      : emptyRow(5, "No hay cheques recibidos pendientes para depositar.");
  }
  if (els["bank-check-deposit-confirm"]) {
    els["bank-check-deposit-confirm"].disabled = !canConfirm;
    els["bank-check-deposit-confirm"].textContent = movement ? "Confirmar deposito" : "Registrar deposito";
  }
}

async function confirmBankCheckDeposit() {
  const draft = bankCheckDepositDraft;
  const movementIndex = bankCheckDepositMovementIndex(draft);
  const movement = movementIndex >= 0 ? bankReconciliationReport?.movements?.[movementIndex] : null;
  if (!draft) return;
  const selected = draft.candidates.filter((check) => draft.selectedIds.has(check.id));
  if (!selected.length) return;

  const button = els["bank-check-deposit-confirm"];
  const originalText = button?.textContent || "Confirmar deposito";
  if (button) {
    button.disabled = true;
    button.textContent = "Depositando...";
  }
  try {
    const response = await fetch(`${API_BASE_URL}/api/bank-reconciliation/deposit-checks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bank: draft.bank || "ICBC",
        depositDate: draft.depositDate,
        manualDeposit: !movement,
        movement: movement ? {
          date: movement.date,
          code: movement.code,
          concept: movement.concept,
          detail: movement.detail,
          cuit: movement.cuit,
          checkNumber: movement.checkNumber,
          debit: movement.debit,
          credit: movement.credit,
          amount: movement.amount,
          balance: movement.balance
        } : null,
        checkIds: selected.map((check) => check.id)
      })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo registrar el depósito.");
    bankCheckDepositDraft = null;
    if (movement) await analyzeBankReconciliation({ preserveExcludedMovements: true });
    await openBankCheckDepositReview();
    setBankReconciliationStatus(
      movement
        ? `${payload.checkCount} cheque(s) depositado(s) y conciliados por ${formatBankMoney(payload.amount)}.`
        : `${payload.checkCount} cheque(s) depositado(s) por ${formatBankMoney(payload.amount)}. Se conciliarán al aparecer en el extracto.`,
      "ok"
    );
    if (els["bank-check-deposit-status-view"]) {
      els["bank-check-deposit-status-view"].textContent = movement
        ? "Depósito confirmado y conciliado correctamente."
        : "Depósito registrado correctamente. Se conciliará cuando aparezca el crédito en el extracto.";
    }
  } catch (error) {
    setBankReconciliationStatus(`No se pudo conciliar el depósito: ${error.message}`, "warn");
    if (els["bank-check-deposit-status-view"]) {
      els["bank-check-deposit-status-view"].textContent = `No se pudo registrar el depósito: ${error.message}`;
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function bankMovementCreditorId(movement) {
  const match = movement?.providerMatch || {};
  if (match.idAcreedor) return String(match.idAcreedor);
  if (match.type === "acreedor" && match.id) return String(match.id);
  return "";
}

async function refreshBankReconciliationOpenDebtCreditors(report) {
  try {
    const tables = await loadExpenseDebtTables();
    if (bankReconciliationReport !== report) return;
    bankReconciliationOpenDebtCreditorIds = new Set(
      buildExpenseDebtRows(tables)
        .map((row) => String(row.creditorId || "").trim())
        .filter(Boolean)
    );
    renderBankReconciliation();
  } catch {
    // La conciliacion puede seguir funcionando aunque no se pueda cargar el contexto de deudas.
  }
}

function bankMovementPaymentAmount(movement) {
  const debit = Number(movement?.debit);
  if (Number.isFinite(debit) && debit > 0) return debit;
  return Math.abs(Number(movement?.amount || 0));
}

function openBankPaymentDebtReview(index) {
  const movement = bankReconciliationReport?.movements?.[index];
  const creditorId = bankMovementCreditorId(movement);
  if (!movement || !creditorId) return;

  bankPaymentDraft = {
    creditorId: String(creditorId),
    date: String(movement.date || ""),
    bank: String(els["bank-reconciliation-bank"]?.value || "ICBC"),
    method: movement.checkNumber ? "Cheque" : "Transferencia",
    amount: roundToDecimals(bankMovementPaymentAmount(movement), 2)
  };
  switchView("payments-entry");
}

async function openBankCreditorDraft(index) {
  const movement = bankReconciliationReport?.movements?.[index];
  if (!movement) return;
  const suggested = movement.suggestedCounterparty || {};
  creditorEntryDraft = {
    type: "otros acreedores",
    name: suggested.name || movement.counterpartyName || "",
    cuit: suggested.cuit || movement.cuit || "",
    cbuAlias: suggested.cbuAlias || movement.cbuAlias || "",
    detail: suggested.detail || movement.detail || "",
    idEtiqueta: movement.idEtiqueta || suggested.idEtiqueta || ""
  };
  switchView("creditor-entry");
}

async function openBankClientDraft(index) {
  const movement = bankReconciliationReport?.movements?.[index];
  if (!movement) return;
  const suggested = movement.suggestedCounterparty || {};
  await openDataEditorDraft("clientes", {
    nombre_cliente: suggested.name || movement.counterpartyName || "",
    cuit: suggested.cuit || movement.cuit || ""
  }, "Cliente precargado con los datos disponibles del movimiento. Completá el nombre si falta y guardá.");
}

function creditorEntrySpecificFieldMarkup(type, values = {}) {
  const value = (key) => escapeHtml(values[key] ?? "");
  if (type === "proveedor") {
    return `
      <label>Telefono<input data-creditor-extra="telefono" type="text" value="${value("telefono")}"></label>
      <label>Email<input data-creditor-extra="email" type="email" value="${value("email")}"></label>
      <label>Tiempo estimado de entrega (dias)<input data-creditor-extra="tiempo_estimado_entrega" type="number" min="0" step="1" value="${value("tiempo_estimado_entrega")}"></label>
      <label>Pedido minimo<input data-creditor-extra="pedido_minimo" type="number" min="0" step="0.01" value="${value("pedido_minimo")}"></label>`;
  }
  if (type === "flete") {
    return `<label>Telefono<input data-creditor-extra="telefono_flete" type="text" value="${value("telefono_flete")}"></label><label>Email<input data-creditor-extra="email_flete" type="email" value="${value("email_flete")}"></label>`;
  }
  if (type === "empleado") {
    return `
      <label>Categoria<input data-creditor-extra="categoria_empleado" type="text" value="${value("categoria_empleado")}"></label>
      <label>Fecha de alta<input data-creditor-extra="fecha_alta" type="date" value="${value("fecha_alta")}"></label>
      <label>DNI<input data-creditor-extra="dni" type="text" inputmode="numeric" value="${value("dni")}"></label>
      <label>Direccion<input data-creditor-extra="direccion_empleado" type="text" value="${value("direccion_empleado")}"></label>
      <label>Localidad<input data-creditor-extra="localidad_empleado" type="text" value="${value("localidad_empleado")}"></label>`;
  }
  if (type === "canal") {
    return `<label>Comision (%)<input data-creditor-extra="comision" type="number" min="0" step="0.01" value="${value("comision")}"></label>`;
  }
  return `<span class="creditor-entry-specific-help">No se requieren datos adicionales para otros acreedores.</span>`;
}

function renderCreditorEntrySpecificFields() {
  cacheCreditorEntrySupplierItems();
  const type = els["creditor-entry-type"]?.value || "otros acreedores";
  const values = creditorEntryDraft?.extra || {};
  if (els["creditor-entry-specific-fields"]) {
    els["creditor-entry-specific-fields"].innerHTML = creditorEntrySpecificFieldMarkup(type, values);
  }
  renderCreditorEntrySupplierItems();
}

function cacheCreditorEntrySupplierItems() {
  const rows = els["creditor-entry-supplier-items-rows"];
  if (!rows?.querySelector("[data-supplier-item-index]")) return;
  creditorEntrySupplierItems = [...rows.querySelectorAll("[data-supplier-item-index]")].map((row) => ({
    idInsumo: row.querySelector('[data-supplier-item="idInsumo"]')?.value || "",
    udProveedor: row.querySelector('[data-supplier-item="udProveedor"]')?.value.trim() || "",
    cantidadProveedor: row.querySelector('[data-supplier-item="cantidadProveedor"]')?.value.trim() || "",
    precio: row.querySelector('[data-supplier-item="precio"]')?.value.trim() || "",
    iva: row.querySelector('[data-supplier-item="iva"]')?.value.trim() || ""
  }));
}

function renderCreditorEntrySupplierItems() {
  const section = els["creditor-entry-supplier-items"];
  const rows = els["creditor-entry-supplier-items-rows"];
  const isSupplier = (els["creditor-entry-type"]?.value || "") === "proveedor";
  if (!section || !rows) return;
  section.hidden = !isSupplier;
  if (!isSupplier) return;
  if (!creditorEntrySupplierItems.length) {
    creditorEntrySupplierItems.push({ idInsumo: "", udProveedor: "", cantidadProveedor: "", precio: "", iva: "21" });
  }
  const supplyOptions = creditorEntrySupplies.map((supply) =>
    `<option value="${escapeHtml(supply.id)}">${escapeHtml(supply.name)}</option>`
  ).join("");
  rows.innerHTML = creditorEntrySupplierItems.map((item, index) => `
    <div class="creditor-supplier-item-row" data-supplier-item-index="${index}">
      <label>Insumo
        <select data-supplier-item="idInsumo">
          <option value="">Elegir insumo</option>
          ${supplyOptions}
        </select>
      </label>
      <label>Presentación
        <input data-supplier-item="udProveedor" type="text" value="${escapeHtml(item.udProveedor || "")}" placeholder="Bolsa 25 Kg">
      </label>
      <label>Cantidad por presentación
        <input data-supplier-item="cantidadProveedor" type="number" min="0" step="0.01" value="${escapeHtml(item.cantidadProveedor || "")}">
      </label>
      <label>Precio sin IVA
        <input data-supplier-item="precio" type="number" min="0" step="0.01" value="${escapeHtml(item.precio || "")}">
      </label>
      <label>IVA (%)
        <input data-supplier-item="iva" type="number" min="0" step="0.01" value="${escapeHtml(item.iva || "")}">
      </label>
      <button class="secondary creditor-supplier-item-remove" type="button" data-remove-supplier-item="${index}">Quitar</button>
    </div>
  `).join("");
  creditorEntrySupplierItems.forEach((item, index) => {
    const select = rows.querySelector(`[data-supplier-item-index="${index}"] [data-supplier-item="idInsumo"]`);
    if (select) select.value = String(item.idInsumo || "");
  });
}

async function loadCreditorEntryForm() {
  const draft = creditorEntryDraft || { type: "otros acreedores", name: "", cuit: "", cbuAlias: "", detail: "", idEtiqueta: "", extra: {} };
  try {
    const [labelRows, supplyRows] = await Promise.all([
      backendTableRowsForEntry("etiquetas"),
      backendTableRowsForEntry("insumos")
    ]);
    creditorEntryLabels = labelRows
      .map((row) => ({ id: String(row.id_etiqueta || ""), name: row.etiqueta || "" }))
      .filter((label) => label.id && label.name)
      .sort((left, right) => left.name.localeCompare(right.name, "es"));
    creditorEntrySupplies = supplyRows
      .map((row) => ({ id: String(row.id_insumo || ""), name: row.nombre || "" }))
      .filter((supply) => supply.id && supply.name)
      .sort((left, right) => left.name.localeCompare(right.name, "es"));
  } catch (_) {
    creditorEntryLabels = [];
    creditorEntrySupplies = [];
  }
  creditorEntrySupplierItems = Array.isArray(draft.supplierItems) ? draft.supplierItems : [];

  if (els["creditor-entry-type"]) els["creditor-entry-type"].value = draft.type || "otros acreedores";
  if (els["creditor-entry-name"]) els["creditor-entry-name"].value = draft.name || "";
  if (els["creditor-entry-cuit"]) els["creditor-entry-cuit"].value = draft.cuit || "";
  if (els["creditor-entry-cbu-alias"]) els["creditor-entry-cbu-alias"].value = draft.cbuAlias || "";
  if (els["creditor-entry-payment-terms"]) els["creditor-entry-payment-terms"].value = draft.paymentTerms || "";
  if (els["creditor-entry-detail"]) els["creditor-entry-detail"].value = draft.detail || "";
  if (els["creditor-entry-save-bank-detail"]) els["creditor-entry-save-bank-detail"].checked = Boolean(draft.detail);
  if (els["creditor-entry-tag"]) {
    els["creditor-entry-tag"].innerHTML = `<option value="">Elegir etiqueta</option>${creditorEntryLabels
      .map((label) => `<option value="${escapeHtml(label.id)}">${escapeHtml(label.name)}</option>`)
      .join("")}`;
    els["creditor-entry-tag"].value = String(draft.idEtiqueta || "");
  }
  if (els["creditor-entry-description"]) {
    els["creditor-entry-description"].textContent = draft.detail
      ? "Datos precargados desde el movimiento bancario. Completa o corrige antes de guardar."
      : "Crea el acreedor, su registro de origen y la etiqueta con la que se utilizara.";
  }
  if (els["creditor-entry-status"]) els["creditor-entry-status"].textContent = "";
  renderCreditorEntrySpecificFields();
}

async function submitCreditorEntry(event) {
  event.preventDefault();
  const type = els["creditor-entry-type"]?.value || "";
  const name = els["creditor-entry-name"]?.value.trim() || "";
  const idEtiqueta = els["creditor-entry-tag"]?.value || "";
  if (!type || !name || !idEtiqueta) {
    if (els["creditor-entry-status"]) els["creditor-entry-status"].textContent = "Completa tipo, nombre y etiqueta.";
    return;
  }
  const extra = {};
  document.querySelectorAll("[data-creditor-extra]").forEach((input) => {
    extra[input.dataset.creditorExtra] = input.value.trim();
  });
  cacheCreditorEntrySupplierItems();
  const supplierItems = type === "proveedor"
    ? creditorEntrySupplierItems.filter((item) => item.idInsumo)
    : [];
  if (supplierItems.some((item) => !item.udProveedor || !item.cantidadProveedor)) {
    if (els["creditor-entry-status"]) els["creditor-entry-status"].textContent = "Completa la presentación y cantidad de cada insumo seleccionado.";
    return;
  }
  const button = els["creditor-entry-submit"];
  if (button) button.disabled = true;
  if (els["creditor-entry-status"]) els["creditor-entry-status"].textContent = "Guardando acreedor...";
  try {
    const response = await fetch(`${API_BASE_URL}/api/creditors/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        originType: type,
        name,
        cuit: els["creditor-entry-cuit"]?.value.trim() || "",
        cbuAlias: els["creditor-entry-cbu-alias"]?.value.trim() || "",
        paymentTerms: els["creditor-entry-payment-terms"]?.value.trim() || "",
        idEtiqueta,
        bankDetail: els["creditor-entry-save-bank-detail"]?.checked ? (els["creditor-entry-detail"]?.value.trim() || "") : "",
        extra,
        supplierItems
      })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo guardar el acreedor.");
    creditorEntryDraft = null;
    if (els["creditor-entry-status"]) els["creditor-entry-status"].textContent = payload.message || "Acreedor guardado correctamente.";
    if (bankReconciliationReport) await analyzeBankReconciliation();
  } catch (error) {
    if (els["creditor-entry-status"]) els["creditor-entry-status"].textContent = error.message || "No se pudo guardar el acreedor.";
  } finally {
    if (button) button.disabled = false;
  }
}

async function openBankDataDraft(index) {
  const movement = bankReconciliationReport?.movements?.[index];
  const creditorId = bankMovementCreditorId(movement);
  if (!movement) return;
  await openDataEditorDraft("datos_bancarios", {
    detalle: movement.detail || "",
    id_acreedor: creditorId,
    id_etiqueta: movement.idEtiqueta || ""
  }, "Detalle bancario precargado para este acreedor. Revisalo y guardá.");
}

async function openBankCollectionDraft(index) {
  const movement = bankReconciliationReport?.movements?.[index];
  if (!movement) return;
  await loadCommercialEntryData(true);
  switchView("collections-entry");
  const clientId = movement.providerMatch?.type === "cliente" ? backendId(movement.providerMatch.id) : "";
  if (els["collection-client"]) els["collection-client"].value = clientId;
  if (els["collection-date"]) els["collection-date"].value = movement.date || "";
  if (els["collection-method"]) els["collection-method"].value = movement.checkNumber ? "Cheque" : "Transferencia";
  if (els["collection-bank"]) els["collection-bank"].value = els["bank-reconciliation-bank"]?.value || "";
  if (els["collection-received-total"]) {
    els["collection-received-total"].value = roundToDecimals(movement.credit || Math.abs(movement.amount || 0), 2);
    els["collection-received-total"].dataset.touched = "true";
  }
  renderCollectionsEntry();
  setCommercialStatus("collections-status", "Cobro precargado desde conciliacion bancaria. Selecciona las facturas y registra las retenciones si corresponde.", "pending");
}

async function openBankNegativeExpenseDraft(index) {
  const movement = bankReconciliationReport?.movements?.[index];
  if (!movement) return;

  bankNegativeExpenseDraft = movement;
  await loadOtherExpenseEntryOptions(true);
  switchView("other-expenses-entry");

  const amount = -Math.abs(Number(movement.credit || movement.amount || 0));
  if (els["other-expense-date"]) els["other-expense-date"].value = movement.date || "";
  if (els["other-expense-detail"]) els["other-expense-detail"].value = movement.detail || "Ingreso no comercial";
  if (els["other-expense-invoice-type"]) els["other-expense-invoice-type"].value = "Remito_X";
  if (els["other-expense-invoice-date"]) els["other-expense-invoice-date"].value = movement.date || "";
  if (els["other-expense-payment-date"]) els["other-expense-payment-date"].value = movement.date || "";
  ["other-expense-subtotal", "other-expense-total"].forEach((id) => {
    const input = els[id];
    if (!input) return;
    input.removeAttribute("min");
    input.value = roundToDecimals(amount, 2);
    input.dataset.touched = "true";
  });
  ["other-expense-iva", "other-expense-vat-retention", "other-expense-iibb-retention", "other-expense-internal-taxes"].forEach((id) => {
    if (els[id]) els[id].value = "0";
  });
  setAutomaticOtherExpenseInvoiceNumber();
  setCommercialStatus("other-expense-status", "Ingreso no comercial: selecciona o crea el acreedor y su etiqueta. Se guardara como egreso negativo.", "pending");
}

async function openBankPartnerContributionDraft(index) {
  const movement = bankReconciliationReport?.movements?.[index];
  if (!movement) return;

  bankPartnerContributionDraft = movement;
  switchView("partner-contributions-entry");
  if (els["partner-contribution-date"]) els["partner-contribution-date"].value = movement.date || "";
  if (els["partner-contribution-type"]) els["partner-contribution-type"].value = "Aporte";
  if (els["partner-contribution-amount"]) {
    els["partner-contribution-amount"].value = roundToDecimals(Math.abs(Number(movement.credit || movement.amount || 0)), 2);
  }
  setCommercialStatus("partner-contribution-status", "Ingreso no comercial precargado. Selecciona el socio y confirma el aporte o retiro.", "pending");
}

async function openBankCheckDraft(index) {
  const movement = bankReconciliationReport?.movements?.[index];
  if (!movement) return;
  await openDataEditorDraft("cheques_recibidos", {
    id_cobro: "",
    fecha_entregado: movement.date || "",
    monto: movement.credit || Math.abs(movement.amount || 0),
    cliente: movement.counterpartyName || "",
    id_cliente: "",
    nro_cheque: movement.checkNumber || "",
    fecha_uso: movement.date || "",
    estado: "A revisar",
    banco: els["bank-reconciliation-bank"]?.value || ""
  }, "Cheque precargado desde el extracto. Asociá el cobro si corresponde y guardá.");
}

function openBankPurchaseDraft(index) {
  const movement = bankReconciliationReport?.movements?.[index];
  if (!movement) return;
  switchView("purchase-entry");
  if (els["purchase-order-date"]) els["purchase-order-date"].value = movement.date || "";
  if (els["purchase-expected-date"]) els["purchase-expected-date"].value = movement.date || "";
  if (els["purchase-total"]) els["purchase-total"].value = decimalPurchaseDisplay(Math.abs(movement.amount || movement.debit || 0));
  if (els["purchase-provider"]) els["purchase-provider"].value = movement.provider || movement.counterpartyName || "";
  setPurchaseStatus("Compra abierta desde conciliacion bancaria. Completa insumo, proveedor y cantidades antes de enviar.", "pending");
  updatePurchaseSummary();
}

function openBankReceptionDraft(index) {
  const movement = bankReconciliationReport?.movements?.[index];
  if (!movement) return;
  switchView("reception-entry");
  if (els["reception-date"]) els["reception-date"].value = movement.date || toIsoDate(new Date());
  if (els["reception-status"]) {
    setEntryStatus("reception-status", "Recepcion abierta desde conciliacion bancaria. Completa compra, insumo y cantidad antes de enviar.", "pending");
  }
}

function openBankIssuedCheckDraft(index) {
  const movement = bankReconciliationReport?.movements?.[index];
  if (!movement) return;
  switchView("issued-check-entry");
  loadIssuedCheckPendingPayments();
  if (els["issued-check-number"]) els["issued-check-number"].value = movement.checkNumber || "";
  if (els["issued-check-date"]) els["issued-check-date"].value = movement.date || toIsoDate(new Date());
  if (els["issued-check-use-date"]) els["issued-check-use-date"].value = addMonthsIso(movement.date || toIsoDate(new Date()), 1);
  if (els["issued-check-amount"]) els["issued-check-amount"].value = String(Math.abs(movement.amount || movement.debit || 0) || "");
  if (els["issued-check-bank"]) els["issued-check-bank"].value = els["bank-reconciliation-bank"]?.value || "ICBC";
  if (els["issued-check-state"]) els["issued-check-state"].value = "Debitado";
  setEntryStatus("issued-check-message", "Cheque abierto desde conciliacion bancaria. Selecciona el pago con cheque pendiente antes de enviarlo.", "pending");
}

function setBankReconciliationStatus(message, status) {
  const element = els["bank-reconciliation-status"];
  if (!element) return;
  element.textContent = message || "";
  element.dataset.status = status || "";
}

function buildComparisonReport() {
  const comparisonPeriod = getComparisonPeriod(state.selectedYear, state.selectedMonth, state.selectedComparison);
  return comparisonPeriod
    ? buildReport(comparisonPeriod.year, comparisonPeriod.month)
    : null;
}

function getComparisonPeriod(year, month, mode) {
  if (mode === "previousMonth") {
    const date = new Date(year, month - 1, 1);
    return { year: date.getFullYear(), month: date.getMonth() };
  }

  if (mode === "previousYear") {
    return { year: year - 1, month };
  }

  return null;
}

function comparisonLabel(report) {
  return report ? `${MONTHS[report.month]} ${report.year}` : "";
}

/*
  CĂˇlculo del Estado de Resultados.
  Criterios vigentes:
  - Ventas: siempre por Subtotal, sin IVA ni retenciones.
  - MercaderĂ­a: inventario inicial + egresos Mercaderia - inventario final.
  - Inventario inicial: Ăşltimo registro disponible anterior al mes seleccionado.
  - Inventario final: Ăşltimo registro disponible del mes seleccionado.
  - Ingresos Brutos: 1,5% del Subtotal de ventas con Factura_A.
  - Uds Vendidas: suma Cantidad_Individual del detalle de pedidos del perĂ­odo.
  - Precio Promedio: facturaciĂłn neta / unidades vendidas.
  - ProducciĂłn: unidades vendidas + inventario final individual - inventario inicial individual.
*/
function buildReport(year, month) {
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 0);
  const startIso = toIsoDate(start);
  const endIso = toIsoDate(end);

  const monthlySales = state.sales.filter((row) => row.date >= startIso && row.date <= endIso);
  const monthlyExpenses = state.expenses.filter((row) => row.date >= startIso && row.date <= endIso);
  const monthlyOrderDetails = filterOrderDetailsForReport(state.orderDetails, monthlySales, startIso, endIso);
  const monthlyPayroll = state.payroll.filter((row) => row.date >= startIso && row.date <= endIso);
  const uncategorized = [];

  monthlyExpenses.forEach((expense) => {
    if (!expense.category.trim()) {
      uncategorized.push(expense);
    }
  });

  const dayBeforeStartIso = toIsoDate(new Date(year, month, 0));
  const initialInventory = lastInventoryBetween("", dayBeforeStartIso);
  const finalInventory = lastInventoryBetween(startIso, endIso);
  const salesBuckets = {
    schools: sumSalesByCategories(monthlySales, ["Escuelas"]),
    other: sum(monthlySales.filter((sale) => !matchesAnyCategory(sale.category, ["Escuelas"])), "subtotal")
  };
  const salesNet = salesBuckets.schools + salesBuckets.other;
  const unitsSold = sum(monthlyOrderDetails, "individualQuantity");
  const customerCount = countCustomers(monthlySales, monthlyOrderDetails);
  const averagePrice = unitsSold ? salesNet / unitsSold : 0;
  const production = buildProductionSummary("", dayBeforeStartIso, startIso, endIso, unitsSold);
  const payroll = buildPayrollSummary(monthlyPayroll);
  production.unitsPerHour = payroll.totalHours ? production.calculatedUnits / payroll.totalHours : 0;

  const expenseSubtotal = (categories) => sumExpensesByCategories(monthlyExpenses, categories, "subtotal");
  const merchandiseCost = (initialInventory?.value || 0) + expenseSubtotal(["Mercaderia"]) - (finalInventory?.value || 0);

  const costOfSales = {
    merchandise: merchandiseCost,
    commissions: expenseSubtotal(["Comisiones"]),
    grossRevenueTax: sumSalesByInvoiceType(monthlySales, ["Factura_A", "Factura_B"]) * 0.015,
    logistics: expenseSubtotal(["Logistica"])
  };
  const totalCostOfSales = Object.values(costOfSales).reduce((total, value) => total + value, 0);
  const grossMargin = salesNet - totalCostOfSales;

  const operatingExpenses = {
    salaries: expenseSubtotal(["Sueldos"]),
    extraSalaries: expenseSubtotal(["Sueldos_Extras"]),
    admin: expenseSubtotal(["Administrativos"]),
    services: expenseSubtotal(["Servicios", "Herramientas_De_Trabajo"]),
    rent: expenseSubtotal(["Alquiler"]),
    maintenanceAndMisc: expenseSubtotal(["Cadeteria", "Limpieza", "Varios", "Otros", "Incentivos_Personal"])
  };
  const totalOperatingExpenses = Object.values(operatingExpenses).reduce((total, value) => total + value, 0);
  const operatingResult = grossMargin - totalOperatingExpenses;

  const nonOperatingExpenses = {
    otherTaxes: expenseSubtotal(["Impuesto Cred", "Impuesto Deb", "Impuesto Sello"]),
    bankFees: expenseSubtotal(["Gastos Bancarios"]),
    interest: expenseSubtotal(["Intereses", "Rendimiento Fondo"]),
    generalInvestment: expenseSubtotal(["Inversion General", "Maquinaria"])
  };
  const totalNonOperatingExpenses = Object.values(nonOperatingExpenses).reduce((total, value) => total + value, 0);
  const netResult = operatingResult - totalNonOperatingExpenses;

  return {
    year,
    month,
    startIso,
    endIso,
    monthlyOrderDetails,
    monthlyPayroll,
    unitsSold,
    customerCount,
    averagePrice,
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

function sumSalesByCategories(rows, categories) {
  return sum(rows.filter((row) => matchesAnyCategory(row.category, categories)), "subtotal");
}

function sumSalesByInvoiceType(rows, invoiceTypes) {
  return sum(rows.filter((row) => matchesAnyCategory(row.invoiceType, invoiceTypes)), "subtotal");
}

function sumExpensesByCategories(rows, categories, field) {
  return sum(rows.filter((row) => matchesAnyCategory(row.category, categories)), field);
}

function buildProductionSummary(initialStartIso, initialEndIso, startIso, endIso, unitsSold) {
  const initial = lastInventoryDetailUnitsBetween(initialStartIso, initialEndIso);
  const final = lastInventoryDetailUnitsBetween(startIso, endIso);
  const initialUnits = initial?.units || 0;
  const finalUnits = final?.units || 0;

  /*
    Criterio pedido por el negocio:
    producciĂłn mensual = ventas individuales + inventario final individual - inventario inicial individual.
    El inventario inicial usa el Ăşltimo registro previo; el final, el Ăşltimo del mes.
  */
  return {
    initial,
    final,
    unitsSold,
    calculatedUnits: unitsSold + finalUnits - initialUnits
  };
}

function buildPayrollSummary(monthlyPayroll) {
  const employees = new Map();

  monthlyPayroll.forEach((row) => {
    const employee = row.employee || "Sin empleado";
    if (!employees.has(employee)) {
      employees.set(employee, {
        employee,
        date: row.date,
        workedHours: 0,
        extraHours: 0,
        totalHours: 0
      });
    }

    const summary = employees.get(employee);
    summary.workedHours += row.workedHours;
    summary.extraHours += row.extraHours;
    summary.totalHours += row.totalHours;
  });

  const rows = [...employees.values()]
    .filter((row) => row.totalHours > 0)
    .sort((a, b) => b.totalHours - a.totalHours || a.employee.localeCompare(b.employee));

  return {
    rows,
    employeeCount: rows.length,
    totalHours: rows.reduce((total, row) => total + row.totalHours, 0)
  };
}

function countCustomers(monthlySales, monthlyOrderDetails) {
  const customers = new Set();

  monthlyOrderDetails.forEach((detail) => {
    if (detail.customer) customers.add(normalizeCategory(detail.customer));
  });

  monthlySales.forEach((sale) => {
    if (sale.customer) customers.add(normalizeCategory(sale.customer));
  });

  return customers.size;
}

function lastInventoryDetailUnitsBetween(startIso, endIso) {
  const rows = state.inventoryDetails.filter((row) => row.date >= startIso && row.date <= endIso);
  const lastDate = rows.map((row) => row.date).sort((a, b) => b.localeCompare(a))[0];
  if (!lastDate) return null;

  return {
    date: lastDate,
    units: sum(rows.filter((row) => row.date === lastDate), "individualQuantity")
  };
}

function isInventoryProduct(itemName) {
  return /^Barra/i.test(String(itemName || "").trim());
}

function inventoryProductUnits(itemName, recipeQuantity) {
  const multiplier = String(itemName || "").match(/_(\d+)Ud$/i)?.[1];
  return recipeQuantity * (multiplier ? Number(multiplier) : 1);
}

/*
  Detalle de pedidos:
  - Con Fecha_Entrega se filtra directo por mes.
  - Con Id_Venta o Id_Pedido se puede cruzar contra ventas del mes.
  - Sin fecha ni IDs no se asigna a un mes para no duplicar unidades por cliente.
*/
function filterOrderDetailsForReport(orderDetails, monthlySales, startIso, endIso) {
  const monthlySaleIds = new Set(monthlySales.map((sale) => String(sale.id || "")).filter(Boolean));
  const monthlyOrderIds = new Set(monthlySales.map((sale) => String(sale.orderId || "")).filter(Boolean));

  return orderDetails.filter((detail) => {
    if (detail.date) return detail.date >= startIso && detail.date <= endIso;
    if (detail.saleId) return monthlySaleIds.has(String(detail.saleId));
    if (detail.orderId) return monthlyOrderIds.has(String(detail.orderId));
    return false;
  });
}

function matchesAnyCategory(value, categories) {
  const normalized = normalizeCategory(value);
  return categories.some((category) => normalizeCategory(category) === normalized);
}

function normalizeCategory(value) {
  return removeAccents(value).trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
}

function normalizeInventoryToken(value) {
  return normalizeCategory(value).replace(/\s+/g, "");
}

function normalizeSearchText(value) {
  return removeAccents(String(value || "")).trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
}

// Busca el Ăşltimo inventario cargado dentro de un rango mensual.
function lastInventoryBetween(startIso, endIso) {
  return [...state.inventory]
    .filter((row) => row.date >= startIso && row.date <= endIso)
    .sort((a, b) => b.date.localeCompare(a.date))[0] || null;
}

// Renderiza el Estado de Resultados con grupos desplegables y porcentajes sobre ventas.
function renderStatement(report, comparisonReport = null) {
  els["period-label"].textContent = "";
  const base = report.salesNet;
  const comparisonBase = comparisonReport?.salesNet || 0;
  const comparison = comparisonReport
    ? { report: comparisonReport, label: comparisonLabel(comparisonReport), base: comparisonBase }
    : null;

  const rows = [
    statementHeader(report, comparison),
    groupTotal("ventas", "Facturacion", report.salesNet, comparison?.report.salesNet, base, comparison, "ventas-netas"),
    childLine("ventas", "Escuelas", report.salesBuckets.schools, comparison?.report.salesBuckets.schools, base, comparison),
    childLine("ventas", "Otros", report.salesBuckets.other, comparison?.report.salesBuckets.other, base, comparison),
    groupTotal("costo-ventas", "Costo de ventas", report.totalCostOfSales, comparison?.report.totalCostOfSales, base, comparison, "costo-de-ventas"),
    childLine("costo-ventas", "Mercaderia", report.costOfSales.merchandise, comparison?.report.costOfSales.merchandise, base, comparison),
    childLine("costo-ventas", "Comisiones", report.costOfSales.commissions, comparison?.report.costOfSales.commissions, base, comparison),
    childLine("costo-ventas", "Ingresos Brutos", report.costOfSales.grossRevenueTax, comparison?.report.costOfSales.grossRevenueTax, base, comparison),
    childLine("costo-ventas", "Logistica", report.costOfSales.logistics, comparison?.report.costOfSales.logistics, base, comparison),
    utilityTotal("Utilidad bruta", report.grossMargin, comparison?.report.grossMargin, base, comparison),
    groupTotal("gastos-operativos", "Gastos operativos", report.totalOperatingExpenses, comparison?.report.totalOperatingExpenses, base, comparison, "gastos-operativos"),
    childLine("gastos-operativos", "Sueldos", report.operatingExpenses.salaries, comparison?.report.operatingExpenses.salaries, base, comparison),
    childLine("gastos-operativos", "Sueldos_Extras", report.operatingExpenses.extraSalaries, comparison?.report.operatingExpenses.extraSalaries, base, comparison),
    childLine("gastos-operativos", "Administrativos", report.operatingExpenses.admin, comparison?.report.operatingExpenses.admin, base, comparison),
    childLine("gastos-operativos", "Servicios", report.operatingExpenses.services, comparison?.report.operatingExpenses.services, base, comparison),
    childLine("gastos-operativos", "Alquiler", report.operatingExpenses.rent, comparison?.report.operatingExpenses.rent, base, comparison),
    childLine("gastos-operativos", "Mantenimiento y Varios", report.operatingExpenses.maintenanceAndMisc, comparison?.report.operatingExpenses.maintenanceAndMisc, base, comparison),
    utilityTotal("Utilidad operativa", report.operatingResult, comparison?.report.operatingResult, base, comparison),
    groupTotal("gastos-no-operativos", "Gastos no operativos", report.totalNonOperatingExpenses, comparison?.report.totalNonOperatingExpenses, base, comparison, "gastos-no-operativos"),
    childLine("gastos-no-operativos", "Otros Impuestos", report.nonOperatingExpenses.otherTaxes, comparison?.report.nonOperatingExpenses.otherTaxes, base, comparison),
    childLine("gastos-no-operativos", "Gastos Bancarios", report.nonOperatingExpenses.bankFees, comparison?.report.nonOperatingExpenses.bankFees, base, comparison),
    childLine("gastos-no-operativos", "Intereses", report.nonOperatingExpenses.interest, comparison?.report.nonOperatingExpenses.interest, base, comparison),
    childLine("gastos-no-operativos", "Inversion General", report.nonOperatingExpenses.generalInvestment, comparison?.report.nonOperatingExpenses.generalInvestment, base, comparison),
    grand("Utilidad", report.netResult, comparison?.report.netResult, base, comparison, "utilidad")
  ];

  els["statement-body"].innerHTML = rows.join("");

  setPlainMetric("metric-units", formatNumber(report.unitsSold));
  els["metric-units-customers"].textContent = `Clientes: ${formatNumber(report.customerCount)}`;
  setPlainMetric("metric-production", formatNumber(report.production.calculatedUnits));
  els["metric-production-hour"].textContent = report.payroll.totalHours
    ? `Barritas/Hora: ${formatNumber(report.production.unitsPerHour)}`
    : "Barritas/Hora: -";
  setMetric("metric-sales", report.salesNet);
  setMetric("metric-cogs", report.totalCostOfSales);
  setMetric("metric-operating-expenses", report.totalOperatingExpenses);
  setMetric("metric-margin", report.totalNonOperatingExpenses);
  setMetric("metric-net", report.netResult);
  setMetricRate("metric-sales-rate", report.salesNet, base);
  setMetricRate("metric-cogs-rate", report.totalCostOfSales, base);
  setMetricRate("metric-operating-expenses-rate", report.totalOperatingExpenses, base);
  setMetricRate("metric-margin-rate", report.totalNonOperatingExpenses, base);
  setMetricRate("metric-net-rate", report.netResult, base);
  setUnitMetric("metric-sales-unit", "Por Ud", report.salesNet, report.unitsSold);
  setUnitMetric("metric-cogs-unit", "Por Ud", report.totalCostOfSales, report.unitsSold);
  setUnitMetric("metric-operating-expenses-unit", "Por Ud", report.totalOperatingExpenses, report.unitsSold);
  setUnitMetric("metric-operating-expenses-produced-unit", "Por Ud Producida", report.totalOperatingExpenses, report.production.calculatedUnits);
  setUnitMetric("metric-margin-unit", "Por Ud", report.totalNonOperatingExpenses, report.unitsSold);
  setUnitMetric("metric-net-unit", "Por Ud", report.netResult, report.unitsSold);
  setUtilityProducedMetric(report);
}

function statementHeader(report, comparison) {
  const currentLabel = `${MONTHS[report.month]} ${report.year}`;

  if (comparison) {
    return `
      <tr>
        <th>Concepto</th>
        <th class="num current-amount-heading">${currentLabel}</th>
        <th class="num comparison-heading">${comparison.label}</th>
        <th class="num current-percent-heading">${currentLabel}</th>
        <th class="num comparison-heading">${comparison.label}</th>
      </tr>
    `;
  }

  return `
    <tr>
      <th>Concepto</th>
      <th class="num">Monto</th>
      <th class="num">% facturacion</th>
    </tr>
  `;
}

function statLine(label, value, comparisonValue, format = "number", comparison = null) {
  const formattedValue = format === "money" ? formatMoney(value) : formatNumber(value);
  const formattedComparison = format === "money" ? formatMoney(comparisonValue || 0) : formatNumber(comparisonValue || 0);

  if (comparison) {
    return `
      <tr class="stat-row">
        <td>${label}</td>
        <td class="num current-cell">${formattedValue}</td>
        <td class="num comparison-cell">${formattedComparison}</td>
        <td class="num">-</td>
        <td class="num comparison-cell">-</td>
      </tr>
    `;
  }

  return `
    <tr class="stat-row">
      <td>${label}</td>
      <td class="num">${formattedValue}</td>
      <td class="num">-</td>
    </tr>
  `;
}

function childLine(group, label, value, comparisonValue, base = 0, comparison = null) {
  return `
    <tr class="detail-row statement-row-${group}" data-group="${group}" hidden>
      <td>${label}</td>
      ${statementValueCells(value || 0, comparisonValue || 0, base, comparison)}
    </tr>
  `;
}

// Fila resumida desplegable: abre/cierra las filas hijas con el mismo data-group.
function groupTotal(group, label, value, comparisonValue, base = 0, comparison = null, icon = "") {
  return `
    <tr class="group-row statement-row-${group}">
      <td>
        <button class="toggle-row" type="button" data-toggle-group="${group}" aria-expanded="false">
          ${statementIcon(icon)}
          <span class="chevron" aria-hidden="true"></span>
          ${label}
        </button>
      </td>
      ${statementValueCells(value, comparisonValue || 0, base, comparison)}
    </tr>
  `;
}

function utilityTotal(label, value, comparisonValue, base = 0, comparison = null, icon = "") {
  const signClass = value < 0 ? "negative-row" : "positive-row";
  return `
    <tr class="total-row utility-row ${signClass}">
      <td>${statementIcon(icon)}${label}</td>
      ${statementValueCells(value, comparisonValue || 0, base, comparison, true)}
    </tr>
  `;
}

function grand(label, value, comparisonValue, base = 0, comparison = null, icon = "") {
  const signClass = value < 0 ? "negative-row" : "positive-row";
  return `
    <tr class="grand-row ${signClass}">
      <td>${statementIcon(icon)}${label}</td>
      ${statementValueCells(value, comparisonValue || 0, base, comparison, true)}
    </tr>
  `;
}

function statementValueCells(value, comparisonValue, base, comparison, colorBySign = false) {
  const valueClass = value < 0 ? "negative" : colorBySign ? "positive" : "";
  if (!comparison) {
    return `
      <td class="num ${valueClass}">${formatMoney(value)}</td>
      <td class="num ${valueClass}">${formatPercentOfSales(value, base)}</td>
    `;
  }

  return `
    <td class="num current-cell current-amount-cell ${valueClass}">${formatMoney(value)}</td>
    <td class="num comparison-cell">${formatMoney(comparisonValue)}</td>
    <td class="num current-cell current-percent-cell ${valueClass}">${formatPercentOfSales(value, base)}</td>
    <td class="num comparison-cell">${formatPercentOfSales(comparisonValue, comparison.base)}</td>
  `;
}

function statementIcon(name) {
  if (!name) return "";
  return `<img src="assets/icons/${name}.svg?v=${ICON_VERSION}" alt="" class="statement-icon statement-icon-${name}">`;
}

// Advertencias visibles para datos faltantes o importaciones con errores.
function renderWarnings(report) {
  const warnings = [];

  if (!report.initialInventory) {
    warnings.push("Falta inventario inicial: no hay un valor monetizado anterior al mes seleccionado.");
  }

  if (!report.finalInventory) {
    warnings.push("Falta inventario final: no hay valor monetizado cargado en el mes seleccionado.");
  }

  if (report.uncategorized.length) {
    warnings.push(`Hay ${report.uncategorized.length} egreso(s) sin categoria para revisar.`);
  }

  els.warnings.innerHTML = warnings.map((warning) => (
    `<div class="notice warn">${warning}</div>`
  )).join("");
}

// Renderiza tablas auxiliares usando el reporte calculado y los datos crudos.
function renderTables(report) {
  renderDataTable("expenses", state.expenses, expenseRow);
  renderDataTable("sales", state.sales, saleRow);
  renderDataTable("orderDetails", state.orderDetails, orderDetailRow);
  renderDataTable("inventory", state.inventory, inventoryRow);
  renderDataTable("inventoryDetails", state.inventoryDetails, inventoryDetailRow);
  renderDataTable("payroll", state.payroll, payrollRow);
  renderProductionSummary(report);
  renderPayrollSummary(report);
  renderCustomerUnits(report);
  renderExpenseCategories();

  els["uncategorized-body"].innerHTML = report.uncategorized.length
    ? report.uncategorized.map((row) => `
      <tr>
        <td>${formatDate(row.date)}</td>
        <td>${escapeHtml(row.supplier)}</td>
        <td>${escapeHtml(row.category || "Sin categoria")}</td>
        <td class="num">${formatMoney(row.subtotal)}</td>
        <td>${escapeHtml(row.source || "")}</td>
      </tr>
    `).join("")
    : emptyRow(5, "No hay egresos sin categoria en el periodo.");

  els["review-count"].textContent = `${report.uncategorized.length} registros`;

}

// Ventas se filtra por perĂ­odo; egresos e inventario muestran histĂłrico operativo.
/*
  Estado Financiero:
  - Saldo es la deuda pendiente de cada egreso.
  - Fecha_Prevista_Pago ubica ese saldo en el calendario financiero.
  - En ventas, Saldo y Fecha_Acordada forman las facturas por cobrar.
  La pantalla no usa el filtro mensual: muestra todas las deudas pendientes.
*/
function renderFinancialStatement() {
  const pendingExpenses = state.expenses.filter((expense) => (
    Math.abs(expense.balance) > 10 && isFinancialInvoiceTypeVisible(expense.invoiceType)
  ));
  const pendingSales = state.sales.filter((sale) => sale.balance > 10);
  const pendingIssuedChecks = state.issuedChecks.filter(isPendingFinancialCheck);
  const pendingReceivedChecks = state.receivedChecks.filter(isPendingFinancialCheck);

  els["financial-overdue-balance"].textContent = formatMoney(sum(pendingExpenses, "balance"));
  els["financial-month-balance"].textContent = formatMoney(sum(pendingSales, "balance"));
  els["financial-cash-banks"].textContent = formatMoney(cashAmountFor("Banco ICBC") + cashAmountFor("Banco GAL"));
  els["financial-cash-cash"].textContent = formatMoney(cashAmountFor("Efectivo"));
  els["financial-checks-on-hand"].textContent = formatMoney(sum(pendingReceivedChecks, "amount"));
  els["financial-checks-to-cover"].textContent = formatMoney(sum(pendingIssuedChecks, "amount"));

  const payableRows = [...pendingExpenses]
    .sort((a, b) => {
      if (!a.expectedPaymentDate && b.expectedPaymentDate) return 1;
      if (a.expectedPaymentDate && !b.expectedPaymentDate) return -1;
      return (a.expectedPaymentDate || "").localeCompare(b.expectedPaymentDate || "") || numericId(a.id) - numericId(b.id);
    });
  const receivableRows = [...pendingSales]
    .sort((a, b) => {
      if (!a.expectedCollectionDate && b.expectedCollectionDate) return 1;
      if (a.expectedCollectionDate && !b.expectedCollectionDate) return -1;
      return (a.expectedCollectionDate || "").localeCompare(b.expectedCollectionDate || "") || numericId(a.id) - numericId(b.id);
    });

  els["financial-payments-body"].innerHTML = payableRows.length
    ? payableRows.slice(0, 250).map(financialPaymentRow).join("")
    : emptyRow(6, "No hay deudas pendientes cargadas.");
  els["financial-count-label"].textContent = `${payableRows.length} registros`;

  els["financial-receivables-body"].innerHTML = receivableRows.length
    ? receivableRows.slice(0, 250).map(financialReceivableRow).join("")
    : emptyRow(6, "No hay facturas por cobrar. Si las ventas se importaron antes de este cambio, volve a importar el CSV.");
  els["financial-receivables-count-label"].textContent = `${receivableRows.length} registros`;

  els["financial-received-checks-body"].innerHTML = pendingReceivedChecks.length
    ? pendingReceivedChecks.slice(0, 250).map(financialReceivedCheckRow).join("")
    : emptyRow(6, "No hay cheques recibidos pendientes.");
  els["financial-received-checks-count-label"].textContent = `${pendingReceivedChecks.length} registros`;

  els["financial-issued-checks-body"].innerHTML = pendingIssuedChecks.length
    ? pendingIssuedChecks.slice(0, 250).map(financialIssuedCheckRow).join("")
    : emptyRow(5, "No hay cheques entregados pendientes.");
  els["financial-issued-checks-count-label"].textContent = `${pendingIssuedChecks.length} registros`;
}

function financialPaymentRow(expense) {
  return `
    <tr>
      <td>${formatDate(expense.date)}</td>
      <td>${escapeHtml(expense.supplier)}</td>
      <td>${escapeHtml(expense.invoiceType)}</td>
      <td>${escapeHtml(expense.invoiceNumber)}</td>
      <td class="num">${formatMoney(expense.balance)}</td>
      <td>${formatDate(expense.expectedPaymentDate)}</td>
    </tr>
  `;
}

function isFinancialInvoiceTypeVisible(invoiceType) {
  return !["asiento", "remito a"].includes(normalizeCategory(invoiceType));
}

function financialReceivableRow(sale) {
  return `
    <tr>
      <td>${formatDate(sale.date)}</td>
      <td>${escapeHtml(sale.customer)}</td>
      <td>${escapeHtml(sale.invoiceType)}</td>
      <td>${escapeHtml(sale.invoiceNumber)}</td>
      <td class="num">${formatMoney(sale.balance)}</td>
      <td>${formatDate(sale.expectedCollectionDate)}</td>
    </tr>
  `;
}

function financialReceivedCheckRow(check) {
  return `
    <tr>
      <td>${formatDate(check.date)}</td>
      <td>${escapeHtml(check.customer)}</td>
      <td>${escapeHtml(check.checkNumber)}</td>
      <td>${formatDate(check.useDate)}</td>
      <td>${escapeHtml(check.bank)}</td>
      <td class="num">${formatMoney(check.amount)}</td>
    </tr>
  `;
}

function financialIssuedCheckRow(check) {
  return `
    <tr>
      <td>${formatDate(check.date)}</td>
      <td>${escapeHtml(check.supplier)}</td>
      <td>${escapeHtml(check.checkNumber)}</td>
      <td>${formatDate(check.useDate)}</td>
      <td class="num">${formatMoney(check.amount)}</td>
    </tr>
  `;
}

function isPendingFinancialCheck(check) {
  return normalizeCategory(check.status) === "pendiente" && Math.abs(check.amount) > 10;
}

function cashAmountFor(account) {
  const found = state.cash.find((row) => normalizeCategory(row.account) === normalizeCategory(account));
  return found?.amount || 0;
}

/*
  Cashflow proyectado.
  Cada movimiento conserva su fecha original, pero la pantalla permite moverlo mediante
  overrides guardados en localStorage. Los grupos se unifican por tipo + fecha + contraparte.
*/
function renderCashflow() {
  if (!backendCashflowReport) {
    renderBackendCashflowCards({ cards: {} });
    if (els["cashflow-timeline"]) {
      els["cashflow-timeline"].innerHTML = emptyRow(4, "Cargando cashflow desde backend.");
    }
    return;
  }

  const groups = buildCashflowGroups();
  const visibleGroups = groups.filter((group) => group.week.number <= 4);
  const searchTerm = normalizeSearchText(els["cashflow-search"]?.value || "");
  const tableGroups = searchTerm
    ? visibleGroups.filter((group) => cashflowGroupMatchesSearch(group, searchTerm))
    : visibleGroups;
  const initialCash = (Number(backendCashflowReport.cards?.banks) || 0) + (Number(backendCashflowReport.cards?.cash) || 0);
  const weeklyTimeline = buildCashflowWeeklyTimeline(tableGroups, initialCash)
    .filter((week) => !searchTerm || tableGroups.some((group) => group.week.number === week.number));

  renderBackendCashflowCards(backendCashflowReport);

  els["cashflow-timeline"].innerHTML = tableGroups.length
    ? cashflowWeeklyRows(weeklyTimeline, tableGroups, Boolean(searchTerm))
    : emptyRow(4, searchTerm ? "No hay movimientos que coincidan con la busqueda." : "No hay movimientos para proyectar desde backend.");
}

function buildCashflowGroups() {
  if (!backendCashflowReport) return [];
  return buildBackendCashflowGroupsForUi(backendCashflowReport);
}

function buildLegacyCashflowGroups() {
  const events = [
    ...cashflowPayableEvents(),
    ...cashflowReceivableEvents(),
    ...cashflowIssuedCheckEvents(),
    ...cashflowReceivedCheckEvents()
  ];
  const groups = new Map();

  events.forEach((event) => {
    const originalDate = event.date || "";
    const overrideKey = cashflowOverrideKey(event.type, event.party, originalDate, event.documentType, event.documentNumber, event.effectiveDate);
    const date = state.cashflowDateOverrides[overrideKey] || originalDate;
    if (!date) return;
    const groupKey = [
      event.type,
      date,
      normalizeCategory(event.party),
      normalizeCategory(event.documentType),
      normalizeCategory(event.documentNumber),
      event.effectiveDate || "",
      event.amount
    ].join("|");
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        type: event.type,
        label: event.label,
        date,
        party: event.party,
        documentType: event.documentType,
        documentNumber: event.documentNumber,
        effectiveDate: event.effectiveDate,
        amount: 0,
        count: 0,
        overrideKey
      });
    }
    const group = groups.get(groupKey);
    group.amount += event.amount;
    group.count += 1;
  });

  return [...groups.values()]
    .map((group) => ({ ...group, week: cashflowWeekForDate(group.date) }))
    .sort((a, b) => a.week.number - b.week.number || a.date.localeCompare(b.date) || a.party.localeCompare(b.party));
}

function renderBackendCashflowCards(report) {
  const cards = report.cards || {};
  els["financial-overdue-balance"].textContent = formatMoney(cards.debts || 0);
  els["financial-month-balance"].textContent = formatMoney(cards.receivable || 0);
  els["financial-cash-banks"].textContent = formatMoney(cards.banks || 0);
  els["financial-cash-cash"].textContent = formatMoney(cards.cash || 0);
  els["financial-checks-on-hand"].textContent = formatMoney(cards.checksOnHand || 0);
  els["financial-checks-to-cover"].textContent = formatMoney(cards.checksToCover || 0);
}

function buildBackendCashflowGroupsForUi(report) {
  return (report.groups || [])
    .map((group) => {
      const overrideKey = group.overrideKey || cashflowOverrideKey(
        group.type,
        group.party,
        group.date,
        group.documentType,
        group.documentNumber,
        group.effectiveDate
      );
      const date = state.cashflowDateOverrides[overrideKey] || group.date || "";
      return {
        type: group.type,
        label: group.label,
        date,
        party: group.party,
        documentType: group.documentType,
        documentNumber: group.documentNumber,
        effectiveDate: group.effectiveDate,
        amount: Number(group.amount) || 0,
        count: Number(group.count) || 1,
        overrideKey,
        week: cashflowWeekForDate(date)
      };
    })
    .filter((group) => group.date && Math.abs(group.amount) > 10)
    .sort((a, b) => a.week.number - b.week.number || a.date.localeCompare(b.date) || a.party.localeCompare(b.party));
}

function cashflowGroupMatchesSearch(group, searchTerm) {
  const typeLabel = cashflowTypeGroupLabel(group.type);
  const searchable = [
    group.label,
    typeLabel,
    group.party,
    group.documentType,
    group.documentNumber,
    formatDate(group.effectiveDate),
    `Semana ${group.week.number}`,
    formatDate(group.date),
    formatMoney(group.amount),
    String(group.count)
  ].join(" ");

  return normalizeSearchText(searchable).includes(searchTerm);
}

function captureCashflowExpandedState() {
  const expanded = {
    weeks: [],
    types: [],
    parties: []
  };

  document.querySelectorAll("[data-toggle-cashflow-week][aria-expanded='true']").forEach((button) => {
    expanded.weeks.push(button.dataset.toggleCashflowWeek);
  });
  document.querySelectorAll("[data-toggle-cashflow-type][aria-expanded='true']").forEach((button) => {
    expanded.types.push(button.dataset.toggleCashflowType);
  });
  document.querySelectorAll("[data-toggle-cashflow-party][aria-expanded='true']").forEach((button) => {
    expanded.parties.push(button.dataset.toggleCashflowParty);
  });

  return expanded;
}

function restoreCashflowExpandedState(expanded) {
  (expanded.weeks || []).forEach((week) => {
    const button = document.querySelector(`[data-toggle-cashflow-week="${cssEscape(week)}"]`);
    if (!button) return;
    button.setAttribute("aria-expanded", "true");
    document.querySelectorAll(`.cashflow-type-row[data-cashflow-week="${cssEscape(week)}"]`).forEach((row) => {
      row.hidden = false;
    });
  });

  (expanded.types || []).forEach((typeKey) => {
    const button = document.querySelector(`[data-toggle-cashflow-type="${cssEscape(typeKey)}"]`);
    if (!button) return;
    button.setAttribute("aria-expanded", "true");
    document.querySelectorAll(`.cashflow-party-row[data-cashflow-type="${cssEscape(typeKey)}"]`).forEach((row) => {
      row.hidden = false;
    });
  });

  (expanded.parties || []).forEach((partyKey) => {
    const button = document.querySelector(`[data-toggle-cashflow-party="${cssEscape(partyKey)}"]`);
    if (!button) return;
    button.setAttribute("aria-expanded", "true");
    document.querySelectorAll(`.cashflow-week-detail[data-cashflow-party="${cssEscape(partyKey)}"]`).forEach((row) => {
      row.hidden = false;
    });
  });
}

function cssEscape(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function startCashflowRowDrag(event) {
  const row = event.target.closest("[data-cashflow-drag-keys]");
  if (!row || event.button !== 0 || event.target.closest("input, select")) return;

  const table = row.closest("table");
  const rowRect = row.getBoundingClientRect();
  const tableRect = table.getBoundingClientRect();

  cashflowDragState = {
    row,
    table,
    keys: JSON.parse(row.dataset.cashflowDragKeys || "[]"),
    expandedState: captureCashflowExpandedState(),
    startX: event.clientX,
    startY: event.clientY,
    offsetY: event.clientY - rowRect.top,
    left: tableRect.left,
    width: tableRect.width,
    preview: null,
    dropRow: null,
    active: false
  };

  document.addEventListener("mousemove", moveCashflowRowDrag);
  document.addEventListener("mouseup", endCashflowRowDrag);
}

function moveCashflowRowDrag(event) {
  if (!cashflowDragState) return;
  const distance = Math.max(
    Math.abs(event.clientX - cashflowDragState.startX),
    Math.abs(event.clientY - cashflowDragState.startY)
  );

  if (!cashflowDragState.active && distance < 5) return;

  event.preventDefault();
  if (!cashflowDragState.active) {
    cashflowDragState.preview = createCashflowDragPreview(cashflowDragState.row);
    cashflowDragState.active = true;
    cashflowSuppressNextClick = true;
    collapseCashflowToWeekRows();
  }

  cashflowDragState.preview.style.left = `${cashflowDragState.left}px`;
  cashflowDragState.preview.style.top = `${event.clientY - cashflowDragState.offsetY}px`;
  updateCashflowDropTarget(event.clientY);
}

function endCashflowRowDrag(event) {
  document.removeEventListener("mousemove", moveCashflowRowDrag);
  document.removeEventListener("mouseup", endCashflowRowDrag);
  if (!cashflowDragState) return;

  if (cashflowDragState.active) {
    event.preventDefault();
    const dropRow = cashflowDropRowAt(event.clientY);
    if (dropRow) {
      const expandedState = cashflowDragState.expandedState;
      cashflowDragState.keys.forEach((key) => {
        state.cashflowDateOverrides[key] = dropRow.dataset.cashflowWeekStart;
      });
      saveState();
      cleanupCashflowDrag();
      renderCashflow();
      restoreCashflowExpandedState(expandedState);
      return;
    }
  }

  const expandedState = cashflowDragState.expandedState;
  cleanupCashflowDrag();
  restoreCashflowExpandedState(expandedState);
}

function updateCashflowDropTarget(clientY) {
  const dropRow = cashflowDropRowAt(clientY);
  if (cashflowDragState.dropRow === dropRow) return;
  if (cashflowDragState.dropRow) cashflowDragState.dropRow.classList.remove("cashflow-drop-target");
  cashflowDragState.dropRow = dropRow;
  if (dropRow) dropRow.classList.add("cashflow-drop-target");
}

function cashflowDropRowAt(clientY) {
  const x = cashflowDragState.left + 24;
  return document.elementFromPoint(x, clientY)?.closest("[data-cashflow-drop-week]") || null;
}

function cleanupCashflowDrag() {
  document.querySelectorAll(".cashflow-drag-source-hidden").forEach((row) => {
    row.classList.remove("cashflow-drag-source-hidden");
  });
  document.querySelectorAll(".cashflow-drag-preview").forEach((preview) => {
    preview.remove();
  });
  document.querySelectorAll(".cashflow-drop-target").forEach((row) => {
    row.classList.remove("cashflow-drop-target");
  });
  cashflowDragState = null;
}

function collapseCashflowToWeekRows() {
  document.querySelectorAll("[data-toggle-cashflow-week], [data-toggle-cashflow-type], [data-toggle-cashflow-party]").forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });
  document.querySelectorAll(".cashflow-type-row, .cashflow-party-row, .cashflow-week-detail").forEach((row) => {
    row.hidden = true;
  });
}

function createCashflowDragPreview(row) {
  document.querySelectorAll(".cashflow-drag-preview").forEach((preview) => {
    preview.remove();
  });

  const table = document.createElement("table");
  const tbody = document.createElement("tbody");
  const clone = row.cloneNode(true);

  table.className = "cashflow-week-table cashflow-drag-preview";
  table.style.width = `${row.closest("table").offsetWidth}px`;
  [...row.children].forEach((cell, index) => {
    if (clone.children[index]) clone.children[index].style.width = `${cell.offsetWidth}px`;
  });

  tbody.appendChild(clone);
  table.appendChild(tbody);
  document.body.appendChild(table);
  return table;
}

function cashflowPayableEvents() {
  return state.expenses
    .filter((expense) => Math.abs(expense.balance) > 10 && isFinancialInvoiceTypeVisible(expense.invoiceType))
    .map((expense) => ({
      type: "payable",
      label: "Pago",
      date: expense.expectedPaymentDate,
      party: expense.supplier || "Sin acreedor",
      documentType: expense.invoiceType || "Sin tipo",
      documentNumber: expense.invoiceNumber || "Sin numero",
      effectiveDate: expense.date,
      amount: -expense.balance
    }));
}

function cashflowReceivableEvents() {
  return state.sales
    .filter((sale) => sale.balance > 10)
    .map((sale) => ({
      type: "receivable",
      label: "Cobro",
      date: sale.expectedCollectionDate,
      party: sale.customer || "Sin cliente",
      documentType: sale.invoiceType || "Sin tipo",
      documentNumber: sale.invoiceNumber || "Sin numero",
      effectiveDate: sale.date,
      amount: sale.balance
    }));
}

function cashflowIssuedCheckEvents() {
  return state.issuedChecks
    .filter(isPendingFinancialCheck)
    .map((check) => ({
      type: "issued-check",
      label: "Cheque a cubrir",
      date: check.useDate,
      party: check.supplier || "Sin acreedor",
      documentType: "Cheque",
      documentNumber: check.checkNumber || "Sin numero",
      effectiveDate: check.date,
      amount: -Math.abs(check.amount)
    }));
}

function cashflowReceivedCheckEvents() {
  return state.receivedChecks
    .filter(isPendingFinancialCheck)
    .map((check) => ({
      type: "received-check",
      label: "Cheque en mano",
      date: check.useDate,
      party: check.customer || "Sin cliente",
      documentType: "Cheque",
      documentNumber: check.checkNumber || "Sin numero",
      effectiveDate: check.date,
      amount: check.amount
    }));
}

function buildCashflowWeeklyTimeline(groups, initialCash) {
  let balance = initialCash;
  const byWeek = new Map();

  for (let weekNumber = 1; weekNumber <= 4; weekNumber += 1) {
    byWeek.set(weekNumber, { ...cashflowWeekForNumber(weekNumber), income: 0, outcome: 0, net: 0, balance: 0 });
  }

  groups.forEach((group) => {
    const week = group.week || cashflowWeekForDate(group.date);
    if (week.number > 4) return;
    const row = byWeek.get(week.number);
    if (group.amount >= 0) row.income += group.amount;
    else row.outcome += Math.abs(group.amount);
    row.net += group.amount;
  });

  return [...byWeek.values()].sort((a, b) => a.number - b.number).map((week) => {
    balance += week.net;
    return { ...week, balance };
  });
}

function cashflowWeeklyRows(weeks, groups, forceOpen = false) {
  const typeGroupsByWeek = cashflowTypeGroupsByWeek(groups);

  return weeks.map((week) => (
    `${cashflowWeekRow(week, forceOpen)}${(typeGroupsByWeek.get(week.number) || []).map((typeGroup) => cashflowTypeRow(typeGroup, forceOpen)).join("")}`
  )).join("");
}

function cashflowTypeGroupsByWeek(groups) {
  const typeGroups = new Map();

  groups.forEach((group) => {
    const typeKey = `${group.week.number}|${group.type}`;
    if (!typeGroups.has(typeKey)) {
      typeGroups.set(typeKey, {
        key: typeKey,
        week: group.week,
        type: group.type,
        label: cashflowTypeGroupLabel(group.type),
        amount: 0,
        count: 0,
        partyGroups: new Map()
      });
    }

    const typeGroup = typeGroups.get(typeKey);
    typeGroup.amount += group.amount;
    typeGroup.count += group.count;

    const partyKey = `${typeKey}|${normalizeCategory(group.party)}`;
    if (!typeGroup.partyGroups.has(partyKey)) {
      typeGroup.partyGroups.set(partyKey, {
        key: partyKey,
        week: group.week,
        type: group.type,
        label: group.label,
        party: group.party,
        amount: 0,
        count: 0,
        details: []
      });
    }
    const partyGroup = typeGroup.partyGroups.get(partyKey);
    partyGroup.amount += group.amount;
    partyGroup.count += group.count;
    partyGroup.details.push(group);
  });

  const byWeek = new Map();
  [...typeGroups.values()]
    .sort((a, b) => a.week.number - b.week.number || cashflowTypeSort(a.type) - cashflowTypeSort(b.type))
    .forEach((typeGroup) => {
      typeGroup.partyGroups = [...typeGroup.partyGroups.values()]
        .sort((a, b) => a.party.localeCompare(b.party) || a.label.localeCompare(b.label));
      if (!byWeek.has(typeGroup.week.number)) byWeek.set(typeGroup.week.number, []);
      byWeek.get(typeGroup.week.number).push(typeGroup);
    });

  return byWeek;
}

function cashflowTypeGroupLabel(type) {
  return {
    payable: "Pagos",
    receivable: "Cobros",
    "received-check": "Cheques",
    "issued-check": "Cheques Entregados"
  }[type] || type;
}

function cashflowTypeSort(type) {
  return {
    payable: 1,
    "issued-check": 2,
    receivable: 3,
    "received-check": 4
  }[type] || 99;
}

function cashflowWeekRow(week, forceOpen = false) {
  return `
    <tr class="cashflow-week-summary" data-cashflow-drop-week="${week.number}" data-cashflow-week-start="${week.startIso}">
      <td>
        <button class="toggle-row" type="button" data-toggle-cashflow-week="${week.number}" aria-expanded="${forceOpen ? "true" : "false"}">
          <span class="chevron" aria-hidden="true"></span>
          Semana ${week.number}
        </button>
      </td>
      <td class="num positive">${formatMoney(week.income)}</td>
      <td class="num negative">${formatMoney(week.outcome)}</td>
      <td class="num ${week.balance < 0 ? "negative" : "positive"}">${formatMoney(week.balance)}</td>
    </tr>
  `;
}

function cashflowTypeRow(typeGroup, forceOpen = false) {
  return `
    <tr class="cashflow-type-row" data-cashflow-week="${typeGroup.week.number}"${forceOpen ? "" : " hidden"}>
      <td>
        <button class="toggle-row cashflow-indent-1" type="button" data-toggle-cashflow-type="${escapeHtml(typeGroup.key)}" data-cashflow-week="${typeGroup.week.number}" aria-expanded="${forceOpen ? "true" : "false"}">
          <span class="chevron" aria-hidden="true"></span>
          ${escapeHtml(typeGroup.label)}
          <span class="muted-inline">(${typeGroup.count})</span>
        </button>
      </td>
      <td class="num ${typeGroup.amount > 0 ? "positive" : ""}">${typeGroup.amount > 0 ? formatMoney(typeGroup.amount) : "-"}</td>
      <td class="num ${typeGroup.amount < 0 ? "negative" : ""}">${typeGroup.amount < 0 ? formatMoney(Math.abs(typeGroup.amount)) : "-"}</td>
      <td></td>
    </tr>
    ${typeGroup.partyGroups.map((partyGroup) => cashflowPartyRow(partyGroup, typeGroup.key, forceOpen)).join("")}
  `;
}

function cashflowPartyRow(partyGroup, typeKey = partyGroup.key.split("|").slice(0, 2).join("|"), forceOpen = false) {
  const hasTypeParent = Boolean(typeKey);
  const typeAttribute = hasTypeParent ? ` data-cashflow-type="${escapeHtml(typeKey)}"` : "";
  const indentClass = hasTypeParent ? "cashflow-indent-2" : "cashflow-indent-1";
  const dragKeys = escapeHtml(JSON.stringify(partyGroup.details.map((group) => group.overrideKey)));
  const label = `${partyGroup.label} Â· ${partyGroup.party}`;
  const firstCell = true
    ? `
        <button class="toggle-row ${indentClass}" type="button" data-toggle-cashflow-party="${escapeHtml(partyGroup.key)}"${typeAttribute} data-cashflow-week="${partyGroup.week.number}" aria-expanded="${forceOpen ? "true" : "false"}">
          <span class="drag-handle" aria-hidden="true">â ż</span>
          <span class="chevron" aria-hidden="true"></span>
          ${escapeHtml(partyGroup.party)}
          <span class="muted-inline">(${partyGroup.count})</span>
        </button>
      `
    : `
        <div class="${indentClass}">
          ${escapeHtml(partyGroup.party)}
          <span class="muted-inline">(${partyGroup.count})</span>
          <br><span class="muted-inline">${formatDate(detail.date)}</span>
        </div>
      `;

  return `
    <tr class="cashflow-party-row" data-cashflow-drag-keys="${dragKeys}" data-cashflow-week="${partyGroup.week.number}"${typeAttribute}${forceOpen ? "" : " hidden"}>
      <td>${firstCell}</td>
      <td class="num ${partyGroup.amount > 0 ? "positive" : ""}">${partyGroup.amount > 0 ? formatMoney(partyGroup.amount) : "-"}</td>
      <td class="num ${partyGroup.amount < 0 ? "negative" : ""}">${partyGroup.amount < 0 ? formatMoney(Math.abs(partyGroup.amount)) : "-"}</td>
      <td></td>
    </tr>
    ${partyGroup.details.map((group) => cashflowWeekDetailRow(group, partyGroup.key, forceOpen)).join("")}
  `;
}

function cashflowWeekDetailRow(group, partyKey, forceOpen = false) {
  const typeKey = partyKey.split("|").slice(0, 2).join("|");
  const dateLabel = {
    payable: "Fecha de gasto",
    receivable: "Fecha de Entrega",
    "received-check": "Fecha de uso",
    "issued-check": "Fecha de uso"
  }[group.type] || "Fecha efectiva";
  const dragKeys = escapeHtml(JSON.stringify([group.overrideKey]));
  return `
    <tr class="cashflow-week-detail" data-cashflow-drag-keys="${dragKeys}" data-cashflow-week="${group.week.number}" data-cashflow-type="${escapeHtml(typeKey)}" data-cashflow-party="${escapeHtml(partyKey)}"${forceOpen ? "" : " hidden"}>
      <td>
        <div class="cashflow-indent-3">
          <span class="drag-handle" aria-hidden="true">â ż</span>
          ${escapeHtml(group.documentType || "Sin tipo")} - ${escapeHtml(group.documentNumber || "Sin numero")}<br>
          <span class="muted-inline">${dateLabel}: ${formatDate(group.effectiveDate)}</span>
        </div>
      </td>
      <td class="num ${group.amount > 0 ? "positive" : ""}">${group.amount > 0 ? formatMoney(group.amount) : "-"}</td>
      <td class="num ${group.amount < 0 ? "negative" : ""}">${group.amount < 0 ? formatMoney(Math.abs(group.amount)) : "-"}</td>
      <td></td>
    </tr>
  `;
}

function cashflowWeekSelect(dateIso, overrideKey) {
  const currentWeek = cashflowWeekForDate(dateIso).number;
  const options = [1, 2, 3, 4].map((weekNumber) => {
    const week = cashflowWeekForNumber(weekNumber);
    const selected = weekNumber === currentWeek ? " selected" : "";
    return `<option value="${week.startIso}"${selected}>Semana ${weekNumber}</option>`;
  }).join("");

  return `
    <select class="cashflow-week-select" aria-label="Cambio de semana" data-cashflow-key="${escapeHtml(overrideKey)}">
      ${options}
    </select>
  `;
}

function cashflowOverrideKey(type, party, date, documentType = "", documentNumber = "", effectiveDate = "") {
  return `${type}|${normalizeCategory(party)}|${date}|${normalizeCategory(documentType)}|${normalizeCategory(documentNumber)}|${effectiveDate}`;
}

function cashflowWeekForDate(dateIso) {
  if (!dateIso || dateIso < CASHFLOW_START_ISO) {
    return cashflowWeekForNumber(1);
  }

  const days = daysBetweenIso(CASHFLOW_START_ISO, dateIso);
  const number = Math.floor(days / 7) + 1;
  return cashflowWeekForNumber(number);
}

function cashflowWeekForNumber(number) {
  const startIso = addDaysIso(CASHFLOW_START_ISO, (number - 1) * 7);
  const endIso = addDaysIso(startIso, 6);
  return {
    number,
    startIso,
    endIso,
    rangeLabel: number === 1
      ? `hasta ${formatDate(endIso)}`
      : `${formatDate(startIso)} al ${formatDate(endIso)}`
  };
}

function daysBetweenIso(startIso, endIso) {
  return Math.floor((dateFromIso(endIso) - dateFromIso(startIso)) / 86400000);
}

function addDaysIso(startIso, days) {
  const date = dateFromIso(startIso);
  date.setDate(date.getDate() + days);
  return toIsoDate(date);
}

function dateFromIso(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function renderDataTable(kind, rows, rowRenderer) {
  const displayRows = filteredRowsForTable(kind, rows);
  const sorted = [...displayRows].sort((a, b) => {
    if (kind === "sales") return numericId(a.id) - numericId(b.id);
    if (kind === "orderDetails") return a.customer.localeCompare(b.customer) || a.product.localeCompare(b.product);
    if (kind === "payroll") return a.employee.localeCompare(b.employee);
    if (kind === "inventory") return b.date.localeCompare(a.date) || inventoryTurnOrder(a.turn) - inventoryTurnOrder(b.turn);
    if (kind === "inventoryDetails") {
      return b.date.localeCompare(a.date)
        || inventoryTurnOrder(a.turn) - inventoryTurnOrder(b.turn)
        || numericId(a.inventoryId) - numericId(b.inventoryId)
        || numericId(a.itemId) - numericId(b.itemId);
    }
    return b.date.localeCompare(a.date);
  });
  const colspans = {
    expenses: 11,
    sales: 10,
    orderDetails: 3,
    inventory: 4,
    inventoryDetails: 7,
    payroll: 3
  };
  els[tableBodyIdForKind(kind)].innerHTML = sorted.length
    ? sorted.slice(0, 200).map(rowRenderer).join("")
    : emptyRow(colspans[kind], "Todavia no hay datos cargados.");
  els[countLabelIdForKind(kind)].textContent = ["sales", "orderDetails", "payroll"].includes(kind)
    ? `${displayRows.length} registros del periodo`
    : `${rows.length} registros`;
}

function inventoryTurnOrder(value) {
  const normalized = normalizeCategory(value);
  if (normalized === "madrugada" || normalized === "turno madrugada") return 0;
  if (normalized === "manana" || normalized === "mañana" || normalized === "turno manana" || normalized === "turno mañana") return 1;
  if (normalized === "tarde" || normalized === "turno tarde") return 2;
  return 3;
}

function tableBodyIdForKind(kind) {
  return {
    expenses: "expenses-body",
    sales: "sales-body",
    orderDetails: "order-details-body",
    inventory: "inventory-body",
    inventoryDetails: "inventory-details-body",
    payroll: "payroll-body"
  }[kind];
}

function countLabelIdForKind(kind) {
  return {
    expenses: "expenses-count-label",
    sales: "sales-count-label",
    orderDetails: "order-details-count-label",
    inventory: "inventory-count-label",
    inventoryDetails: "inventory-details-count-label",
    payroll: "payroll-count-label"
  }[kind];
}

function filteredRowsForTable(kind, rows) {
  if (kind === "sales" || kind === "payroll") return filterRowsBySelectedPeriod(rows);
  if (kind === "orderDetails") {
    const start = new Date(state.selectedYear, state.selectedMonth, 1);
    const end = new Date(state.selectedYear, state.selectedMonth + 1, 0);
    const startIso = toIsoDate(start);
    const endIso = toIsoDate(end);
    const monthlySales = state.sales.filter((row) => row.date >= startIso && row.date <= endIso);
    return filterOrderDetailsForReport(rows, monthlySales, startIso, endIso);
  }
  return rows;
}

function numericId(value) {
  const number = Number(String(value || "").replace(/\D/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function filterRowsBySelectedPeriod(rows) {
  const start = new Date(state.selectedYear, state.selectedMonth, 1);
  const end = new Date(state.selectedYear, state.selectedMonth + 1, 0);
  const startIso = toIsoDate(start);
  const endIso = toIsoDate(end);
  return rows.filter((row) => row.date >= startIso && row.date <= endIso);
}

function expenseRow(row) {
  return `
    <tr>
      <td>${escapeHtml(row.id)}</td>
      <td>${formatDate(row.date)}</td>
      <td>${escapeHtml(row.supplier)}</td>
      <td>${escapeHtml(row.category)}</td>
      <td>${escapeHtml(row.invoiceType)}</td>
      <td class="num">${formatMoney(row.subtotal)}</td>
      <td class="num">${formatMoney(row.vat)}</td>
      <td class="num">${formatMoney(row.vatRetention)}</td>
      <td class="num">${formatMoney(row.iibbRetention)}</td>
      <td class="num">${formatMoney(row.internalTaxes)}</td>
      <td class="num">${formatMoney(row.total)}</td>
    </tr>
  `;
}

// Separa categorĂ­as de egresos entre las que entran al reporte y las pendientes.
function renderExpenseCategories() {
  const categories = new Map();

  state.expenses.forEach((expense) => {
    const name = expense.category || "Sin categoria";
    if (!categories.has(name)) {
      categories.set(name, { name, count: 0, subtotal: 0 });
    }
    const category = categories.get(name);
    category.count += 1;
    category.subtotal += expense.subtotal;
  });

  const rows = [...categories.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const classified = [];
  const unclassified = [];

  rows.forEach((row) => {
    const classification = reportClassificationForCategory(row.name);
    if (classification) {
      classified.push({ ...row, classification });
    } else {
      unclassified.push(row);
    }
  });

  els["expense-categories-body"].innerHTML = classified.length
    ? classified.map((row) => {
      return `
        <tr>
          <td>${escapeHtml(row.name)}</td>
          <td class="num">${row.count}</td>
          <td class="num">${formatMoney(row.subtotal)}</td>
          <td>${escapeHtml(row.classification)}</td>
        </tr>
      `;
    }).join("")
    : emptyRow(4, "Todavia no hay categorias clasificadas.");

  els["expense-categories-count"].textContent = `${classified.length} categorias`;

  els["unclassified-categories-body"].innerHTML = unclassified.length
    ? unclassified.map((row) => `
      <tr>
        <td>${escapeHtml(row.name)}</td>
        <td class="num">${row.count}</td>
        <td class="num">${formatMoney(row.subtotal)}</td>
      </tr>
    `).join("")
    : emptyRow(3, "No hay categorias sin clasificar.");

  els["unclassified-categories-count"].textContent = `${unclassified.length} categorias`;
}

// Mapeo fijo de categorĂ­as de egresos hacia la estructura actual del reporte.
function reportClassificationForCategory(category) {
  const groups = [
    ["Costo de ventas / Mercaderia", ["Mercaderia"]],
    ["Costo de ventas / Comisiones", ["Comisiones"]],
    ["Costo de ventas / Logistica", ["Logistica"]],
    ["Gastos operativos / Sueldos", ["Sueldos"]],
    ["Gastos operativos / Sueldos_Extras", ["Sueldos_Extras"]],
    ["Gastos operativos / Administrativos", ["Administrativos"]],
    ["Gastos operativos / Servicios", ["Servicios", "Herramientas_De_Trabajo"]],
    ["Gastos operativos / Alquiler", ["Alquiler"]],
    ["Gastos operativos / Mantenimiento y Varios", ["Cadeteria", "Limpieza", "Varios", "Otros", "Incentivos_Personal"]],
    ["Gastos no operativos / Otros Impuestos", ["Impuesto Cred", "Impuesto Deb", "Impuesto Sello"]],
    ["Gastos no operativos / Gastos Bancarios", ["Gastos Bancarios"]],
    ["Gastos no operativos / Intereses", ["Intereses", "Rendimiento Fondo"]],
    ["Gastos no operativos / Inversion General", ["Inversion General", "Maquinaria"]]
  ];

  const match = groups.find(([, categories]) => matchesAnyCategory(category, categories));
  return match ? match[0] : "";
}

function saleRow(row) {
  return `
    <tr>
      <td>${escapeHtml(row.id)}</td>
      <td>${escapeHtml(row.customer)}</td>
      <td>${formatDate(row.date)}</td>
      <td>${escapeHtml(row.invoiceType)}</td>
      <td class="num">${formatMoney(row.vat)}</td>
      <td class="num">${formatMoney(row.vatRetention)}</td>
      <td class="num">${formatMoney(row.iibbRetention)}</td>
      <td class="num">${formatMoney(row.incomeTaxRetention)}</td>
      <td class="num">${formatMoney(row.subtotal)}</td>
      <td class="num">${formatMoney(row.total)}</td>
    </tr>
  `;
}

function orderDetailRow(row) {
  return `
    <tr>
      <td>${escapeHtml(row.product)}</td>
      <td>${escapeHtml(row.customer)}</td>
      <td class="num">${formatNumber(row.individualQuantity)}</td>
    </tr>
  `;
}

function payrollRow(row) {
  return `
    <tr>
      <td>${escapeHtml(row.employee)}</td>
      <td>${formatMonthYear(row.date)}</td>
      <td class="num">${formatNumber(row.totalHours)}</td>
    </tr>
  `;
}

function renderPayrollSummary(report) {
  els["payroll-body"].innerHTML = report.payroll.rows.length
    ? report.payroll.rows.map(payrollRow).join("")
    : emptyRow(3, "No hay horas cargadas para el periodo.");

  els["payroll-count-label"].textContent = `${report.payroll.rows.length} empleados del periodo`;
  els["payroll-summary-label"].textContent = `${MONTHS[report.month]} ${report.year}`;
  els["payroll-employee-count"].textContent = formatNumber(report.payroll.employeeCount);
  els["payroll-hours-total"].textContent = formatNumber(report.payroll.totalHours);
}

function renderCustomerUnits(report) {
  const unitsByCustomer = new Map();

  report.monthlyOrderDetails.forEach((detail) => {
    const customer = detail.customer || "Sin cliente";
    unitsByCustomer.set(customer, (unitsByCustomer.get(customer) || 0) + detail.individualQuantity);
  });

  const rows = [...unitsByCustomer.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  els["customer-units-body"].innerHTML = rows.length
    ? rows.map(([customer, units]) => `
      <tr>
        <td>${escapeHtml(customer)}</td>
        <td class="num">${formatNumber(units)}</td>
      </tr>
    `).join("")
    : emptyRow(2, "No hay unidades cargadas para el periodo.");

  els["customer-units-count-label"].textContent = `${rows.length} clientes`;
}

function inventoryRow(row) {
  return `
    <tr>
      <td>${escapeHtml(row.id || "")}</td>
      <td>${formatDate(row.date)}</td>
      <td>${escapeHtml(row.turn || "-")}</td>
      <td>${escapeHtml(row.employeeId || "-")}</td>
    </tr>
  `;
}

function inventoryDetailRow(row) {
  return `
    <tr>
      <td>${escapeHtml(row.id || "")}</td>
      <td>${escapeHtml(row.inventoryId || "")}</td>
      <td>${formatDate(row.date)}</td>
      <td>${escapeHtml(row.turn || "-")}</td>
      <td>${escapeHtml(row.itemId || "")}</td>
      <td>${escapeHtml(row.itemName)}</td>
      <td class="num">${formatNumber(row.quantity)}</td>
    </tr>
  `;
}

function renderProductionSummary(report) {
  const initialLabel = report.production.initial
    ? `${formatNumber(report.production.initial.units)} (${formatDate(report.production.initial.date)})`
    : "-";
  const finalLabel = report.production.final
    ? `${formatNumber(report.production.final.units)} (${formatDate(report.production.final.date)})`
    : "-";

  els["production-body"].innerHTML = `
    <tr>
      <td>${formatNumber(report.production.unitsSold)}</td>
      <td>${finalLabel}</td>
      <td>${initialLabel}</td>
      <td class="num">${formatNumber(report.production.calculatedUnits)}</td>
    </tr>
  `;
  els["production-count-label"].textContent = `${MONTHS[report.month]} ${report.year}`;
}

function renderCreditors() {
  if (!els["creditor-employee-options"]) return;

  const rows = [...(state.creditors || [])]
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

  const employeeOptions = rows
    .filter((row) => normalizeCategory(row.type) === "empleado")
    .map((row) => `<option value="${escapeHtml(row.name)}"></option>`)
    .join("");
  els["creditor-employee-options"].innerHTML = employeeOptions;
}

async function loadDashboardWidgets() {
  if (!els["dashboard-checks-widget"]) return;
  renderDashboardLoading();

  try {
    const [
      issuedChecks,
      creditors,
      inventories,
      purchases,
      receptions,
      purchaseDetails,
      supplierLinks,
      supplies,
      providers,
      items,
      labels,
      orders,
      orderDetails,
      clients,
      products,
      deliveries,
      deliveryDetails,
      expenseDebtTables
    ] = await Promise.all([
      backendTableRowsForEntry("cheques_entregados").catch(() => []),
      backendTableRowsForEntry("acreedores").catch(() => []),
      backendTableRowsForEntry("inventarios").catch(() => []),
      backendTableRowsForEntry("compras").catch(() => []),
      backendTableRowsForEntry("recepciones").catch(() => []),
      backendTableRowsForEntry("detalle_compras").catch(() => []),
      backendTableRowsForEntry("insumos_proveedores").catch(() => []),
      backendTableRowsForEntry("insumos").catch(() => []),
      backendTableRowsForEntry("proveedores").catch(() => []),
      backendTableRowsForEntry("items").catch(() => []),
      backendTableRowsForEntry("etiquetas").catch(() => []),
      backendTableRowsForEntry("pedidos").catch(() => []),
      backendTableRowsForEntry("detalle_pedidos").catch(() => []),
      backendTableRowsForEntry("clientes").catch(() => []),
      backendTableRowsForEntry("productos").catch(() => []),
      backendTableRowsForEntry("entregas").catch(() => []),
      backendTableRowsForEntry("entregas_detalle").catch(() => []),
      loadExpenseDebtTables().catch(() => ({}))
    ]);

    dashboardWidgetData = {
      checks: buildDashboardChecks(issuedChecks, creditors, expenseDebtTables),
      missingInventoryDays: buildDashboardMissingInventoryDays(inventories),
      pendingPurchases: buildDashboardPendingPurchases({
        purchases,
        receptions,
        purchaseDetails,
        supplierLinks,
        supplies,
        providers,
        items,
        labels
      }),
      pendingOrders: buildDashboardPendingOrders({
        orders,
        orderDetails,
        clients,
        products,
        deliveries,
        deliveryDetails
      })
    };
    renderDashboardWidgets();
  } catch (error) {
    renderDashboardError(error.message || "No se pudo leer el dashboard.");
  }
}

function renderDashboardLoading() {
  els["dashboard-checks-count"].textContent = "-";
  els["dashboard-next-check"].textContent = "Cargando cheques pendientes...";
  els["dashboard-week-checks"].innerHTML = "";
  els["dashboard-inventory-count"].textContent = "-";
  els["dashboard-inventory-summary"].textContent = "Cargando calendario de inventario...";
  els["dashboard-inventory-list"].innerHTML = "";
  els["dashboard-purchases-count"].textContent = "-";
  els["dashboard-purchases-summary"].textContent = "Cargando compras pendientes...";
  els["dashboard-purchases-list"].innerHTML = "";
  els["dashboard-orders-count"].textContent = "-";
  els["dashboard-orders-summary"].textContent = "Cargando pedidos pendientes...";
  els["dashboard-orders-list"].innerHTML = "";
}

function renderDashboardError(message) {
  ["dashboard-checks-widget", "dashboard-inventory-widget", "dashboard-purchases-widget", "dashboard-orders-widget"].forEach((id) => {
    els[id]?.classList.remove("is-warning", "is-danger");
  });
  els["dashboard-next-check"].textContent = message;
  els["dashboard-inventory-summary"].textContent = message;
  els["dashboard-purchases-summary"].textContent = message;
  els["dashboard-orders-summary"].textContent = message;
}

function buildDashboardChecks(checks, creditors, expenseTables = {}) {
  const fallbackCreditorsById = rowsByKey(creditors, "id_acreedor");
  const lookups = expenseDebtLookups(expenseTables);
  const expensesById = rowsByKey(expenseTables.egresos?.rows || [], "id_egreso");
  const paymentDetailsByPaymentId = groupRowsByComparableKey(expenseTables.detalle_pagos?.rows || [], "id_pago");

  return (checks || [])
    .map((check) => {
      const directCreditorId = backendId(check.id_acreedor);
      const paymentDetails = paymentDetailsByPaymentId.get(comparableLookupId(check.id_pago)) || [];
      const linkedExpense = paymentDetails
        .map((detail) => expensesById.get(comparableLookupId(detail.id_egreso)))
        .find(Boolean);
      const linkedCreditorId = linkedExpense ? resolveExpenseCreditorId(linkedExpense, lookups) : "";
      const creditorId = directCreditorId || linkedCreditorId;
      const fallbackCreditor = fallbackCreditorsById.get(comparableLookupId(creditorId)) || {};
      const creditorName = creditorId
        ? creditorDisplayName(creditorId, lookups)
        : displayNameLabel(fallbackCreditor.nombre || check.acreedor || "");

      return {
        id: String(check.id_cheque_entregado ?? "").trim(),
        paymentId: String(check.id_pago ?? "").trim(),
        creditor: creditorName && creditorName !== `Acreedor ${creditorId}` ? creditorName : displayNameLabel(fallbackCreditor.nombre || check.acreedor || "Sin acreedor"),
        number: String(check.nro_cheque ?? "").trim(),
        date: parseDate(check.fecha_entregado),
        dueDate: parseDate(check.fecha_uso),
        amount: parseMoney(check.monto),
        bank: check.banco || "",
        status: check.estado || ""
      };
    })
    .filter((check) => isDashboardPendingCheck(check))
    .sort((a, b) => (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31") || a.id.localeCompare(b.id));
}

function isDashboardPendingCheck(check) {
  const status = normalizeCategory(check.status);
  const isClosed = ["pagado", "cubierto", "debitado", "cobrado", "anulado", "rechazado"].includes(status);
  return !isClosed && Math.abs(check.amount) > 10;
}

function dashboardCheckUrgency(check) {
  if (!check.dueDate) return "";
  const today = toIsoDate(new Date());
  const tomorrow = toIsoDate(addDays(new Date(), 1));
  if (check.dueDate <= tomorrow) return "danger";
  if (check.dueDate <= dashboardWeekEndIso()) return "warning";
  return "";
}

function dashboardWeekEndIso() {
  const today = new Date();
  const daysUntilSunday = 7 - today.getDay();
  return toIsoDate(addDays(today, daysUntilSunday === 7 ? 0 : daysUntilSunday));
}

function buildDashboardMissingInventoryDays(inventories) {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  const loadedDates = new Set((inventories || []).map((row) => parseDate(row.fecha)).filter(Boolean));
  const missingDays = [];

  // El control se mide por dia habil: si hubo al menos un turno cargado, ese dia queda cubierto.
  for (let cursor = new Date(start); cursor <= today; cursor = addDays(cursor, 1)) {
    if (!isBusinessDay(cursor)) continue;
    const iso = toIsoDate(cursor);
    if (!loadedDates.has(iso)) missingDays.push(iso);
  }

  return missingDays;
}

function buildDashboardPendingPurchases(tables) {
  const receivedPurchaseIds = new Set((tables.receptions || [])
    .map((row) => String(row.id_compra ?? "").trim())
    .filter(Boolean));
  const detailsByPurchaseId = groupRowsByKey(tables.purchaseDetails, "id_compra");
  const suppliersById = rowsByKey(tables.supplierLinks, "id_insumos_proveedores");
  const suppliesById = rowsByKey(tables.supplies, "id_insumo");
  const providersById = rowsByKey(tables.providers, "id_proveedor");
  const itemsBySupplyId = rowsByKey(
    (tables.items || []).filter((row) => normalizeCategory(row.origen_tipo) === "insumo"),
    "id_origen"
  );
  const labelsByName = rowsByNormalizedValue(tables.labels, "etiqueta");

  return (tables.purchases || [])
    .map((purchase) => {
      const purchaseId = String(purchase.id_compra ?? "").trim();
      if (!purchaseId || receivedPurchaseIds.has(purchaseId)) return null;
      const firstDetail = (detailsByPurchaseId.get(purchaseId) || [])[0] || {};
      const supplier = suppliersById.get(comparableLookupId(firstDetail.id_insumos_proveedores)) || {};
      const supply = suppliesById.get(comparableLookupId(supplier.id_insumo)) || {};
      const provider = providersById.get(comparableLookupId(purchase.id_proveedor)) || {};
      const option = buildReceptionPendingOption(purchase, firstDetail, supplier, supply, provider, itemsBySupplyId, labelsByName);
      if (!option) return null;
      return {
        ...option,
        expectedDate: parseDate(purchase.fecha_entrega_prevista)
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.expectedDate || "9999-12-31").localeCompare(b.expectedDate || "9999-12-31") || a.purchaseId.localeCompare(b.purchaseId));
}

function buildDashboardPendingOrders(tables) {
  const deliveriesById = mapRowsById(tables.deliveries || [], "id_entrega");
  const deliveredOrderIds = new Set(
    (tables.deliveryDetails || [])
      .filter((row) => backendId(deliveriesById.get(backendId(row.id_entrega))?.id_flete))
      .map((row) => backendId(row.id_pedido))
      .filter(Boolean)
  );
  const clientsById = mapRowsById(tables.clients || [], "id_cliente");
  const productsById = mapRowsById(tables.products || [], "id_producto");
  const orderDetailsByOrder = groupRowsById(tables.orderDetails || [], "id_pedido");

  return (tables.orders || [])
    .filter((order) => {
      const orderId = backendId(order.id_pedido);
      return orderId && !deliveredOrderIds.has(orderId);
    })
    .map((order) => {
      const orderId = backendId(order.id_pedido);
      const client = clientsById.get(backendId(order.id_cliente)) || {};
      const details = (orderDetailsByOrder.get(orderId) || [])
        .map((detail) => {
          const product = productsById.get(backendId(detail.id_producto)) || {};
          const productName = product.nombre_producto || product.nombre || detail.id_producto || "Producto";
          return `${displayNameLabel(productName)} (${formatNumber(parseMoney(detail.cantidad_cajas))})`;
        })
        .join(", ");
      return {
        id: orderId,
        deliveryDate: parseDate(order.fecha_entrega),
        orderDate: parseDate(order.fecha_pedido),
        originalDate: parseDate(order.fecha_original),
        clientName: displayNameLabel(client.nombre_cliente || client.nombre || order.id_cliente || "Sin cliente"),
        details
      };
    })
    .sort((a, b) => (a.deliveryDate || "9999-12-31").localeCompare(b.deliveryDate || "9999-12-31") || a.id.localeCompare(b.id));
}

function dashboardOrderUrgency(order) {
  if (!order.deliveryDate) return "";
  const today = toIsoDate(new Date());
  const tomorrow = toIsoDate(addDays(new Date(), 1));
  if (order.deliveryDate <= tomorrow) return "danger";
  if (order.deliveryDate <= dashboardWeekEndIso()) return "warning";
  return "";
}

function renderDashboardWidgets() {
  renderDashboardChecksWidget();
  renderDashboardInventoryWidget();
  renderDashboardPurchasesWidget();
  renderDashboardOrdersWidget();
}

function renderDashboardChecksWidget() {
  const checks = dashboardWidgetData.checks;
  const weekChecks = checks.filter((check) => check.dueDate && check.dueDate <= dashboardWeekEndIso());
  const nextCheck = checks[0];
  const hasDanger = checks.some((check) => dashboardCheckUrgency(check) === "danger");
  const hasWarning = checks.some((check) => dashboardCheckUrgency(check) === "warning");
  const isExpanded = dashboardExpandedWidget === "checks";

  els["dashboard-checks-count"].textContent = formatNumber(checks.length);
  els["dashboard-next-check"].textContent = nextCheck
    ? `Proximo: ${formatDate(nextCheck.dueDate)} - ${nextCheck.creditor} - ${formatMoney(nextCheck.amount)}`
    : "No hay cheques pendientes de cubrir.";
  els["dashboard-week-checks"].innerHTML = isExpanded
    ? dashboardChecksTable(checks)
    : weekChecks.length
    ? weekChecks.slice(0, 4).map(dashboardCheckMiniRow).join("")
    : `<div class="dashboard-empty">Sin cheques a cubrir esta semana.</div>`;
  els["dashboard-checks-widget"].classList.toggle("is-danger", hasDanger);
  els["dashboard-checks-widget"].classList.toggle("is-warning", !hasDanger && hasWarning);
  els["dashboard-checks-widget"].classList.toggle("is-expanded", isExpanded);
}

function dashboardCheckMiniRow(check) {
  const urgency = dashboardCheckUrgency(check);
  return `
    <div class="dashboard-mini-row ${urgency ? `is-${urgency}` : ""}">
      <span>${formatDate(check.dueDate)} · ${escapeHtml(check.creditor)}</span>
      <strong>${formatMoney(check.amount)}</strong>
    </div>
  `;
}

function renderDashboardInventoryWidget() {
  const missingDays = dashboardWidgetData.missingInventoryDays;
  const isExpanded = dashboardExpandedWidget === "inventory";
  els["dashboard-inventory-count"].textContent = formatNumber(missingDays.length);
  els["dashboard-inventory-summary"].textContent = missingDays.length
    ? `${missingDays.length} dia(s) habiles del mes sin inventario.`
    : "Inventario al dia en el mes actual.";
  els["dashboard-inventory-list"].innerHTML = isExpanded
    ? dashboardInventoryTable(missingDays)
    : missingDays.length
    ? missingDays.slice(0, 5).map((date) => `<div class="dashboard-mini-row"><span>${formatDate(date)}</span><strong>Ir a cargar</strong></div>`).join("")
    : `<div class="dashboard-empty">Click para abrir la carga de inventario.</div>`;
  els["dashboard-inventory-widget"].classList.toggle("is-expanded", isExpanded);
}

function renderDashboardPurchasesWidget() {
  const purchases = dashboardWidgetData.pendingPurchases;
  const nextPurchase = purchases[0];
  const isExpanded = dashboardExpandedWidget === "purchases";
  els["dashboard-purchases-count"].textContent = formatNumber(purchases.length);
  els["dashboard-purchases-summary"].textContent = nextPurchase
    ? `Proxima: ${formatDate(nextPurchase.expectedDate)} - ${displayNameLabel(nextPurchase.supply.nombre || "Sin insumo")}`
    : "No hay compras pendientes de recepcion.";
  els["dashboard-purchases-list"].innerHTML = isExpanded
    ? dashboardPurchasesTable(purchases)
    : purchases.length
    ? purchases.slice(0, 4).map(dashboardPurchaseMiniRow).join("")
    : `<div class="dashboard-empty">Sin compras pendientes.</div>`;
  els["dashboard-purchases-widget"].classList.toggle("is-expanded", isExpanded);
}

function dashboardPurchaseMiniRow(purchase) {
  return `
    <div class="dashboard-mini-row">
      <span>${formatDate(purchase.expectedDate)} · ${escapeHtml(displayNameLabel(purchase.provider.nombre || "Sin proveedor"))}</span>
      <strong>${escapeHtml(purchasePresentationLabel(purchase.supplierQuantity, purchase.supplierUnit))}</strong>
    </div>
  `;
}

function renderDashboardOrdersWidget() {
  const orders = dashboardWidgetData.pendingOrders;
  const weekOrders = orders.filter((order) => order.deliveryDate && order.deliveryDate <= dashboardWeekEndIso());
  const nextOrder = orders[0];
  const hasDanger = orders.some((order) => dashboardOrderUrgency(order) === "danger");
  const hasWarning = orders.some((order) => dashboardOrderUrgency(order) === "warning");
  const isExpanded = dashboardExpandedWidget === "orders";

  els["dashboard-orders-count"].textContent = formatNumber(orders.length);
  els["dashboard-orders-summary"].textContent = nextOrder
    ? `Proximo: ${formatDate(nextOrder.deliveryDate)} - ${nextOrder.clientName}`
    : "No hay pedidos pendientes de entrega.";
  els["dashboard-orders-list"].innerHTML = isExpanded
    ? dashboardOrdersTable(orders)
    : weekOrders.length
    ? weekOrders.slice(0, 4).map(dashboardOrderMiniRow).join("")
    : `<div class="dashboard-empty">Sin pedidos pendientes esta semana.</div>`;
  els["dashboard-orders-widget"].classList.toggle("is-danger", hasDanger);
  els["dashboard-orders-widget"].classList.toggle("is-warning", !hasDanger && hasWarning);
  els["dashboard-orders-widget"].classList.toggle("is-expanded", isExpanded);
}

function dashboardOrderMiniRow(order) {
  const urgency = dashboardOrderUrgency(order);
  return `
    <div class="dashboard-mini-row ${urgency ? `is-${urgency}` : ""}">
      <span>${formatDate(order.deliveryDate)} · ${escapeHtml(order.clientName)}</span>
      <strong>#${escapeHtml(order.id)}</strong>
    </div>
  `;
}

function activateDashboardWidgetFromKeyboard(event, target) {
  if (!["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  toggleDashboardWidget(target);
}

function toggleDashboardWidget(target) {
  dashboardExpandedWidget = dashboardExpandedWidget === target ? "" : target;
  renderDashboardWidgets();
}

function dashboardInventoryTable(missingDays) {
  if (!missingDays.length) {
    return `<div class="dashboard-empty dashboard-expanded-empty">No hay dias habiles pendientes de inventario.</div>`;
  }
  return `
    <div class="table-wrap dashboard-expanded-table">
      <table>
        <thead>
          <tr>
            <th>Fecha pendiente</th>
            <th>Accion sugerida</th>
          </tr>
        </thead>
        <tbody>
          ${missingDays.map((date) => `
            <tr>
              <td>${formatDate(date)}</td>
              <td>Cargar inventario</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function dashboardChecksTable(checks) {
  if (!checks.length) return `<div class="dashboard-empty dashboard-expanded-empty">No hay cheques pendientes.</div>`;
  return `
    <div class="table-wrap dashboard-expanded-table">
      <table>
        <thead>
          <tr>
            <th>Fecha uso</th>
            <th>Acreedor</th>
            <th>Nro cheque</th>
            <th>Banco</th>
            <th class="num">Monto</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          ${checks.map((check) => `
            <tr class="${dashboardCheckUrgency(check) ? `dashboard-row-${dashboardCheckUrgency(check)}` : ""}">
              <td>${formatDate(check.dueDate)}</td>
              <td>${escapeHtml(check.creditor)}</td>
              <td>${escapeHtml(check.number || "-")}</td>
              <td>${escapeHtml(check.bank || "-")}</td>
              <td class="num">${formatMoney(check.amount)}</td>
              <td>${escapeHtml(check.status || "Pendiente")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function dashboardPurchasesTable(purchases) {
  if (!purchases.length) return `<div class="dashboard-empty dashboard-expanded-empty">No hay compras pendientes.</div>`;
  return `
    <div class="table-wrap dashboard-expanded-table">
      <table>
        <thead>
          <tr>
            <th>Entrega prevista</th>
            <th>Compra</th>
            <th>Proveedor</th>
            <th>Insumo</th>
            <th class="num">Unidad proveedor</th>
            <th class="num">Unidad conteo</th>
          </tr>
        </thead>
        <tbody>
          ${purchases.map((purchase) => `
            <tr>
              <td>${formatDate(purchase.expectedDate)}</td>
              <td>#${escapeHtml(purchase.purchaseId)}</td>
              <td>${escapeHtml(displayNameLabel(purchase.provider.nombre || "Sin proveedor"))}</td>
              <td>${escapeHtml(displayNameLabel(purchase.supply.nombre || "Sin insumo"))}</td>
              <td class="num">${escapeHtml(purchasePresentationLabel(purchase.supplierQuantity, purchase.supplierUnit))}</td>
              <td class="num">${escapeHtml(purchaseQuantityLabel(purchase.countQuantity, purchase.countUnit))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function dashboardOrdersTable(orders) {
  if (!orders.length) return `<div class="dashboard-empty dashboard-expanded-empty">No hay pedidos pendientes de entrega.</div>`;
  return `
    <div class="table-wrap dashboard-expanded-table">
      <table>
        <thead>
          <tr>
            <th>Fecha entrega</th>
            <th>Pedido</th>
            <th>Cliente</th>
            <th>Detalle</th>
            <th>Fecha pedido</th>
          </tr>
        </thead>
        <tbody>
          ${orders.map((order) => `
            <tr class="${dashboardOrderUrgency(order) ? `dashboard-row-${dashboardOrderUrgency(order)}` : ""}">
              <td>${formatDate(order.deliveryDate)}</td>
              <td>#${escapeHtml(order.id)}</td>
              <td>${escapeHtml(order.clientName)}</td>
              <td>${escapeHtml(order.details || "-")}</td>
              <td>${formatDate(order.orderDate)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderCounts() {
  if (els["count-sales"]) els["count-sales"].textContent = state.sales.length;
  if (els["count-expenses"]) els["count-expenses"].textContent = state.expenses.length;
  if (els["count-inventory"]) els["count-inventory"].textContent = state.inventory.length;
  if (els["count-inventory-details"]) els["count-inventory-details"].textContent = state.inventoryDetails.length;
  if (els["count-order-details"]) els["count-order-details"].textContent = state.orderDetails.length;
  if (els["count-payroll"]) els["count-payroll"].textContent = state.payroll.length;
  if (els["count-errors"]) els["count-errors"].textContent = state.importErrors.length;
}

// Colorea las tarjetas resumen segĂşn signo.
function setMetric(id, value) {
  const el = els[id];
  const metric = el.closest(".metric");
  el.textContent = formatMoney(value);
  metric.classList.toggle("negative", value < 0);
  metric.classList.toggle("positive", value > 0);
}

function setPlainMetric(id, value) {
  els[id].textContent = value;
}

function setMetricRate(id, value, base) {
  els[id].textContent = formatPercentOfSales(value, base);
}

function setUnitMetric(id, label, amount, units) {
  els[id].textContent = units ? `${label}: ${formatMoney(amount / units)}` : `${label}: -`;
}

function setUtilityProducedMetric(report) {
  const soldUnits = report.unitsSold;
  const producedUnits = report.production.calculatedUnits;

  if (!soldUnits || !producedUnits) {
    els["metric-net-produced-unit"].textContent = "Por Ud Producida: -";
    return;
  }

  // Formula solicitada: facturacion por unidad vendida menos costos por unidad
  // vendida, menos gastos operativos por unidad producida y no operativos por unidad vendida.
  const resultPerProducedUnit =
    report.salesNet / soldUnits -
    report.totalCostOfSales / soldUnits -
    report.totalOperatingExpenses / producedUnits -
    report.totalNonOperatingExpenses / soldUnits;

  els["metric-net-produced-unit"].textContent = `Por Ud Producida: ${formatMoney(resultPerProducedUnit)}`;
}

// La pantalla ConfiguraciĂłn conserva listas editables para futuras reglas configurables.
function fillSettingsForm() {
  Object.entries(settingFieldMap()).forEach(([key, fieldId]) => {
    document.getElementById(fieldId).value = (state.settings[key] || []).join(", ");
  });
}

function readSettingsForm() {
  return Object.fromEntries(
    Object.entries(settingFieldMap()).map(([key, fieldId]) => [
      key,
      document.getElementById(fieldId).value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    ])
  );
}

function settingFieldMap() {
  return {
    productive: "productive-categories",
    commercial: "commercial-categories",
    admin: "admin-categories",
    salary: "salary-categories",
    rent: "rent-categories",
    service: "service-categories",
    logistics: "logistics-categories",
    maintenance: "maintenance-categories",
    marketing: "marketing-categories",
    tax: "tax-categories",
    finance: "finance-categories",
    other: "other-categories"
  };
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

// Formato ARS sin decimales para mantener tablas compactas.
function formatMoney(value) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0
  }).format(value || 0);
}

// La conciliacion necesita contrastar importes exactos contra el extracto bancario.
function formatBankMoney(value) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value) || 0);
}

function formatCompactMoney(value) {
  const abs = Math.abs(value || 0);
  if (abs >= 1000000) return `$${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1 }).format((value || 0) / 1000000)}M`;
  if (abs >= 1000) return `$${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format((value || 0) / 1000)}K`;
  return formatMoney(value);
}

function formatPercentOfSales(value, base) {
  if (!base) return "-";
  return new Intl.NumberFormat("es-AR", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(value / base);
}

function formatPercentValue(value) {
  return `${value > 0 ? "+" : ""}${new Intl.NumberFormat("es-AR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(value)}%`;
}

function formatRoundedPercentValue(value) {
  return `${value > 0 ? "+" : ""}${Math.round(value)}%`;
}

function percentValue(value, base) {
  return base ? value / base : 0;
}

function formatNumber(value) {
  return new Intl.NumberFormat("es-AR", {
    maximumFractionDigits: 2
  }).format(value || 0);
}

function formatRoundedNumber(value) {
  return String(roundedNumberValue(value));
}

function roundedNumberValue(value) {
  return Math.round(value || 0);
}

function formatDate(value) {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function formatMonthYear(value) {
  if (!value) return "";
  const [year, month] = value.split("-");
  return `${MONTHS[Number(month) - 1]} ${year}`;
}

// Escape defensivo para datos importados antes de insertarlos como HTML.
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function emptyRow(colspan, message) {
  return `<tr><td class="empty" colspan="${colspan}">${message}</td></tr>`;
}

function labelForKind(kind) {
  return {
    expenses: "Egresos",
    sales: "Ventas",
    orderDetails: "Detalle pedidos",
    inventory: "Inventario",
    inventoryDetails: "Detalle inventario",
    payroll: "Sueldos",
    cash: "Caja",
    issuedChecks: "Cheques entregados",
    receivedChecks: "Cheques recibidos",
    creditors: "Acreedores",
    purchases: "Compras",
    purchaseDetails: "Detalle compras",
    providers: "Proveedores",
    recipes: "Recetas",
    itemInfo: "Items",
    supplyInfo: "Insumos"
  }[kind] || kind;
}

