/*
  ERP Simple
  ----------
  Este archivo concentra la lĂłgica de la app estĂˇtica: carga CSV, normaliza datos,
  calcula el Estado de Resultados y pinta las tablas. EstĂˇ organizado por secciones
  para que sea fĂˇcil mover cada bloque a mĂłdulos separados cuando la app crezca.
*/

const STORAGE_KEY = "erp-simple-state-v1";
const ICON_VERSION = "20260701-53";
const CASHFLOW_START_ISO = "2026-07-02";
const API_BASE_URL = window.location.port === "3000" ? "" : "http://127.0.0.1:3000";
let cashflowDragState = null;
let cashflowSuppressNextClick = false;
let inventoryDetailTemplate = null;
let lastInventoryPhotoTranscription = null;
let inventoryPhotoApplied = false;

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
  cacheElements();
  setupPeriodSelectors();
  fillImportUrlInputs();
  bindEvents();
  fillSettingsForm();
  render();
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
    "financial-received-checks-count-label",
    "financial-received-checks-body",
    "financial-issued-checks-count-label",
    "financial-issued-checks-body",
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
    "inventory-entry-form",
    "inventory-date-input",
    "inventory-employee-input",
    "inventory-detail-load",
    "inventory-detail-form",
    "inventory-detail-id-label",
    "inventory-detail-body",
    "inventory-photo-input",
    "inventory-photo-read",
    "inventory-photo-transcription",
    "inventory-detail-submit",
    "inventory-detail-status"
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
  if (!saved) {
    return {
      selectedMonth: new Date().getMonth(),
      selectedYear: new Date().getFullYear(),
      selectedComparison: "none",
      expenses: [],
      sales: [],
      orderDetails: [],
      inventory: [],
      inventoryDetails: [],
      recipes: [],
      payroll: [],
      creditors: [],
      cash: [],
      issuedChecks: [],
      receivedChecks: [],
      cashflowDateOverrides: {},
      importUrls: {},
      importErrors: [],
      settings: DEFAULT_SETTINGS
    };
  }

  try {
    const parsed = JSON.parse(saved);
    return {
      selectedMonth: parsed.selectedMonth ?? new Date().getMonth(),
      selectedYear: parsed.selectedYear ?? new Date().getFullYear(),
      selectedComparison: parsed.selectedComparison || "none",
      expenses: parsed.expenses || [],
      sales: parsed.sales || [],
      orderDetails: parsed.orderDetails || [],
      inventory: parsed.inventory || [],
      inventoryDetails: parsed.inventoryDetails || [],
      recipes: parsed.recipes || [],
      payroll: parsed.payroll || [],
      creditors: parsed.creditors || [],
      cash: parsed.cash || [],
      issuedChecks: parsed.issuedChecks || [],
      receivedChecks: parsed.receivedChecks || [],
      cashflowDateOverrides: parsed.cashflowDateOverrides || {},
      importUrls: parsed.importUrls || {},
      importErrors: cleanImportErrors(parsed.importErrors || []),
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) }
    };
  } catch {
    return {
      selectedMonth: new Date().getMonth(),
      selectedYear: new Date().getFullYear(),
      selectedComparison: "none",
      expenses: [],
      sales: [],
      orderDetails: [],
      inventory: [],
      inventoryDetails: [],
      recipes: [],
      payroll: [],
      creditors: [],
      cash: [],
      issuedChecks: [],
      receivedChecks: [],
      cashflowDateOverrides: {},
      importUrls: {},
      importErrors: [],
      settings: DEFAULT_SETTINGS
    };
  }
}

function cleanImportErrors(errors) {
  return errors.filter((error) => error.source !== "payroll");
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
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

  document.querySelectorAll("[data-load-url]").forEach((button) => {
    button.addEventListener("click", () => loadCsvFromUrl(button.dataset.loadUrl, button, true));
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

  els["refresh-imports"].addEventListener("click", () => refreshAllImports());

  els["inventory-entry-form"].addEventListener("submit", (event) => event.preventDefault());
  els["inventory-date-input"].addEventListener("change", () => loadInventoryDetailTemplate());
  document.querySelectorAll("[data-inventory-shift]").forEach((input) => {
    input.addEventListener("change", () => {
      clearDisabledInventoryShiftInputs();
      updateTheoreticalInventoryStock();
    });
  });
  els["inventory-detail-load"].addEventListener("click", () => loadInventoryDetailTemplate());
  els["inventory-photo-read"].addEventListener("click", () => readInventoryPhoto());
  els["inventory-detail-form"].addEventListener("submit", submitInventoryDetail);

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
  els["inventory-detail-id-label"].textContent = `Id inventario: ${template?.inventoryId || "-"}`;

  if (!template?.rows?.length) {
    els["inventory-detail-body"].innerHTML = emptyRow(8, "Todavia no hay detalle preparado.");
    return;
  }

  els["inventory-detail-body"].innerHTML = template.rows.map((row) => `
    <tr data-item-id="${escapeHtml(row.itemId)}" data-item-name="${escapeHtml(row.itemName)}" data-previous-afternoon="${escapeHtml(row.previousAfternoon || "")}" data-previous-morning="${escapeHtml(row.previousMorning || "")}" data-previous-dawn="${escapeHtml(row.previousDawn || "")}">
      <td>${escapeHtml(template.inventoryId)}</td>
      <td>${escapeHtml(row.itemId)}</td>
      <td>${escapeHtml(row.itemName)}</td>
      <td class="num"><input class="detail-quantity-input" data-detail-field="afternoon" type="number" step="any"></td>
      <td class="num"><input class="detail-quantity-input" data-detail-field="morning" type="number" step="any"></td>
      <td class="num theoretical-stock-cell">-</td>
      <td class="num theoretical-diff-cell">-</td>
      <td class="num"><input class="detail-quantity-input" data-detail-field="dawn" type="number" step="any"></td>
    </tr>
  `).join("");
  els["inventory-detail-body"].querySelectorAll(".detail-quantity-input").forEach((input) => {
    input.addEventListener("input", updateTheoreticalInventoryStock);
  });
  clearDisabledInventoryShiftInputs();
  updateTheoreticalInventoryStock();
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
    updateTheoreticalInventoryStock();
    window.setTimeout(updateTheoreticalInventoryStock, 0);
    const notes = payload.notes?.length ? ` ${payload.notes.join(" ")}` : "";
    const uncertaintyNote = result.uncertain ? ` ${result.uncertain} celda(s) para revisar en naranja.` : "";
    setInventoryDetailStatus(`Foto leída: ${result.applied} valores completados.${uncertaintyNote}${notes}`, "success");
  } catch (error) {
    setInventoryDetailStatus(`No se pudo leer la foto: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function applyPhotoInventoryRows(rows) {
  let applied = 0;
  let uncertain = 0;
  els["inventory-detail-body"].querySelectorAll(".detail-quantity-input").forEach((input) => {
    if (!isInventoryShiftEnabled(input.dataset.detailField)) input.value = "";
    input.classList.remove("is-uncertain");
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
      const uncertaintyReason = photoRow.uncertain?.[field];
      if (uncertaintyReason) {
        input.classList.add("is-uncertain");
        input.title = uncertaintyReason;
        uncertain += 1;
      }
    });
  });

  updateTheoreticalInventoryStock();
  return { applied, uncertain };
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
    input.classList.remove("is-uncertain");
    input.removeAttribute("title");
  });
}

/*
  Stocks teoricos del inventario.
  Se usa el primer turno marcado del dia para no mezclar, por ejemplo, stock de manana con contador de tarde.
  La produccion conocida alimenta las recetas y permite estimar el consumo teorico de insumos/subproductos.
*/
function updateTheoreticalInventoryStock() {
  const body = els["inventory-detail-body"];
  if (!body) return;
  renderTheoreticalStockBreakdown(null);

  body.querySelectorAll("tr[data-item-id]").forEach((row) => {
    const cell = row.querySelector(".theoretical-stock-cell");
    if (cell) {
      cell.textContent = "-";
      cell.title = "";
      cell.classList.remove("missing-theoretical-stock");
    }
    const diffCell = row.querySelector(".theoretical-diff-cell");
    if (diffCell) {
      diffCell.textContent = "-";
      diffCell.title = "";
      diffCell.classList.remove("diff-positive", "diff-negative", "diff-neutral");
    }
  });

  const selectedDate = els["inventory-date-input"]?.value || "";
  const selectedShift = firstSelectedInventoryShift();
  const missingRows = [];
  if (!selectedDate) missingRows.push("fecha");
  if (!selectedShift) missingRows.push("turno realizado");
  if (missingRows.length) {
    renderTheoreticalStockBreakdown({
      missing: missingRows,
      selectedShift
    });
    return;
  }

  const model = buildTheoreticalInventoryModel(selectedDate, selectedShift);
  model.rows.forEach((row) => {
    const cell = row.element.querySelector(".theoretical-stock-cell");
    const diffCell = row.element.querySelector(".theoretical-diff-cell");
    if (!cell) return;
    if (Number.isFinite(row.theoreticalStock)) {
      cell.textContent = formatNumber(row.theoreticalStock);
      cell.classList.remove("missing-theoretical-stock");
      cell.title = `Anterior: ${formatNullableNumber(row.previousStock)} | Produccion: ${formatNullableNumber(row.producedStock)} | Ventas: ${formatNullableNumber(row.sales)} | Consumo recetas: ${formatNullableNumber(row.consumedStock)}`;
      renderTheoreticalStockDifference(diffCell, row);
      return;
    }
    if (row.missing.length) markTheoreticalStockMissing(cell, `Falta: ${row.missing.join(", ")}`);
  });
  renderTheoreticalStockBreakdown(model);
}

function renderTheoreticalStockDifference(cell, row) {
  if (!cell) return;
  const loadedStock = currentDetailStockForSelectedShift(row.element);
  if (!Number.isFinite(loadedStock) || loadedStock === 0) {
    cell.textContent = "-";
    cell.title = "Falta stock cargado para comparar.";
    cell.classList.remove("diff-positive", "diff-negative", "diff-neutral");
    return;
  }

  const differencePercent = ((row.theoreticalStock - loadedStock) / loadedStock) * 100;
  cell.textContent = formatPercentValue(differencePercent);
  cell.title = `Teorico: ${formatNumber(row.theoreticalStock)} | Cargado: ${formatNumber(loadedStock)}`;
  cell.classList.toggle("diff-positive", differencePercent > 0);
  cell.classList.toggle("diff-negative", differencePercent < 0);
  cell.classList.toggle("diff-neutral", differencePercent === 0);
}

function shouldDelayPhotoBasedTheoreticalStock(itemName) {
  return Number.isFinite(granelDulceIngredientCoefficient(itemName)) && !inventoryPhotoApplied;
}

function buildTheoreticalInventoryModel(selectedDate, selectedShift) {
  const detailRows = inventoryDetailTableRows();
  const recipes = recipeRowsForTheoreticalStock();
  const productionByProduct = new Map();
  let consumptionByComponent = new Map();
  const counterUnits = currentCounterUnits();
  const recipeProductKeys = new Set(recipes.map((recipe) => normalizeCategory(recipe.productName)));

  detailRows.forEach((row) => {
    const itemKey = normalizeCategory(row.itemName);
    if (shouldDelayPhotoBasedTheoreticalStock(row.itemName)) return;
    if (isNeutralTheoreticalStockItem(row.itemName)) return;
    if (!recipeProductKeys.has(itemKey) && !isBarraPopName(row.itemName)) return;

    const sales = orderDetailsUnitsForDateAndProduct(selectedDate, row.itemName);
    const previousStock = previousDetailStock(row.element);
    const currentStock = currentDetailStockForSelectedShift(row.element);
    let produced = NaN;

    if (isBarraPopName(row.itemName) && Number.isFinite(counterUnits)) {
      produced = counterUnits;
    } else if (Number.isFinite(previousStock) && Number.isFinite(currentStock)) {
      produced = currentStock - previousStock + sales;
    }

    if (Number.isFinite(produced)) productionByProduct.set(itemKey, produced);
  });

  applyNeutralIntermediateProduction(detailRows, recipes, productionByProduct);

  for (let index = 0; index < 3; index += 1) {
    consumptionByComponent = buildRecipeConsumptionByComponent(recipes, productionByProduct);
    detailRows.forEach((row) => {
      const itemKey = normalizeCategory(row.itemName);
      if (shouldDelayPhotoBasedTheoreticalStock(row.itemName)) return;
      if (isNeutralTheoreticalStockItem(row.itemName)) {
        return;
      }
      if (!recipeProductKeys.has(itemKey) || isBarraPopName(row.itemName)) return;

      const previousStock = previousDetailStock(row.element);
      const currentStock = currentDetailStockForSelectedShift(row.element);
      if (!Number.isFinite(previousStock) || !Number.isFinite(currentStock)) return;

      const factor = theoreticalRecipeUnitFactor(row.itemName);
      const sales = orderDetailsUnitsForDateAndProduct(selectedDate, row.itemName);
      const consumedByParents = (consumptionByComponent.get(itemKey) || 0) / factor;
      productionByProduct.set(itemKey, currentStock - previousStock + sales + consumedByParents);
    });
    applyNeutralIntermediateProduction(detailRows, recipes, productionByProduct);
  }
  consumptionByComponent = buildRecipeConsumptionByComponent(recipes, productionByProduct);

  const rows = detailRows.map((row) => {
    const itemKey = normalizeCategory(row.itemName);
    const previousStock = previousDetailStock(row.element);
    const currentStock = currentDetailStockForSelectedShift(row.element);
    const sales = orderDetailsUnitsForDateAndProduct(selectedDate, row.itemName);
    const factor = theoreticalRecipeUnitFactor(row.itemName);
    const producedRaw = productionByProduct.get(itemKey);
    const consumedRaw = consumptionByComponent.get(itemKey) || 0;
    const producedStock = Number.isFinite(producedRaw) ? producedRaw / factor : 0;
    const consumedStock = consumedRaw / factor;
    const missing = [];
    const specialStock = specialTheoreticalStockForRow(row, detailRows, selectedDate, counterUnits);

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

function applyNeutralIntermediateProduction(detailRows, recipes, productionByProduct) {
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
      const previousStock = previousDetailStock(row.element);
      const currentStock = currentDetailStockForSelectedShift(row.element);
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

function specialTheoreticalStockForRow(row, detailRows, selectedDate, counterUnits) {
  const itemName = normalizeCategory(row.itemName);
  const granelIngredientCoefficient = granelDulceIngredientCoefficient(itemName);
  if (Number.isFinite(granelIngredientCoefficient)) {
    return specialGranelIngredientTheoreticalStock(row, detailRows, counterUnits, granelIngredientCoefficient);
  }
  if (itemName === "bobina barra pop") {
    return specialBobinaBarraPopTheoreticalStock(row, counterUnits);
  }
  if (itemName === "caja 140") {
    return specialCaja140TheoreticalStock(row, detailRows, selectedDate);
  }
  if (itemName === "barra pop") {
    return specialBarraPopTheoreticalStock(row, detailRows, selectedDate, counterUnits);
  }
  if (itemName !== "barra pop 140ud") return null;

  const bagRow = detailRows.find((detailRow) => isBarraPopName(detailRow.itemName));
  const previousStock = previousDetailStock(row.element);
  const previousBagStock = bagRow ? previousDetailStock(bagRow.element) : NaN;
  const currentBagStock = bagRow ? currentDetailStockForSelectedShift(bagRow.element) : NaN;
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

function specialGranelIngredientTheoreticalStock(row, detailRows, counterUnits, coefficient) {
  const granelRow = detailRows.find((detailRow) => isNeutralTheoreticalStockItem(detailRow.itemName));
  const previousStock = previousDetailStock(row.element);
  const previousGranelStock = granelRow ? previousDetailStock(granelRow.element) : NaN;
  const currentGranelStock = granelRow ? currentDetailStockForSelectedShift(granelRow.element) : NaN;
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

function specialBobinaBarraPopTheoreticalStock(row, counterUnits) {
  const previousStock = previousDetailStock(row.element);
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

function specialCaja140TheoreticalStock(row, detailRows, selectedDate) {
  const previousStock = previousDetailStock(row.element);
  const targetBoxesProduced = barraPop140ProducedBoxes(detailRows, selectedDate);
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

function specialBarraPopTheoreticalStock(row, detailRows, selectedDate, counterUnits) {
  const targetRow = detailRows.find((detailRow) => normalizeCategory(detailRow.itemName) === "barra pop 140ud");
  const previousStock = previousDetailStock(row.element);
  const previousTargetStock = targetRow ? previousDetailStock(targetRow.element) : NaN;
  const currentTargetStock = targetRow ? currentDetailStockForSelectedShift(targetRow.element) : NaN;
  const targetSales = orderDetailsUnitsForDateAndProduct(selectedDate, "Barra_Pop_140Ud");
  const missing = [];

  if (!Number.isFinite(previousStock)) missing.push("stock anterior Barra_Pop");
  if (!Number.isFinite(counterUnits)) missing.push("Contador alipack actual");
  if (!Number.isFinite(previousTargetStock)) missing.push("stock anterior Barra_Pop_140Ud");
  if (!Number.isFinite(currentTargetStock)) missing.push("stock actual Barra_Pop_140Ud");

  const targetBoxesProduced = barraPop140ProducedBoxes(detailRows, selectedDate);
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

function barraPop140ProducedBoxes(detailRows, selectedDate) {
  const targetRow = detailRows.find((detailRow) => normalizeCategory(detailRow.itemName) === "barra pop 140ud");
  if (!targetRow) return NaN;

  const previousTargetStock = previousDetailStock(targetRow.element);
  const currentTargetStock = currentDetailStockForSelectedShift(targetRow.element);
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

function currentCounterUnits() {
  const counterRow = findInventoryDetailRowByName("Contador alipack");
  const currentCounter = counterRow ? currentDetailStockForSelectedShift(counterRow) : NaN;
  return Number.isFinite(currentCounter) ? currentCounter : counterFromLastPhotoTranscription();
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
  cell.textContent = "Revisar";
  cell.classList.add("missing-theoretical-stock");
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

function currentDetailStockForSelectedShift(row) {
  const shift = firstSelectedInventoryShift();
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

function counterFromLastPhotoTranscription() {
  if (!lastInventoryPhotoTranscription?.rows?.length) return NaN;
  const shift = firstSelectedInventoryShift();
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
        rows
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);

    els["inventory-date-input"].value = "";
    els["inventory-employee-input"].value = "";
    renderInventoryDetailTemplate(null);
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

function setInventoryDetailStatus(message, status) {
  const element = els["inventory-detail-status"];
  element.textContent = message;
  element.dataset.status = status;
}

function switchView(view) {
  document.body.classList.toggle("view-results-active", view === "results");
  document.body.classList.toggle("view-cashflow-active", view === "cashflow");
  document.body.classList.toggle("view-data-entry-active", view === "data-entry");
  document.body.classList.toggle("view-imports-active", view === "imports");
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("active", section.id === `view-${view}`);
  });

  const titles = {
    dashboard: ["Dashboard", "Resumen de los datos guardados en este navegador."],
    results: ["Estado de Resultados", "Resultado mensual estimado desde egresos, ventas e inventario."],
    cashflow: ["Cashflow", "Flujo de caja proyectado y editable por fecha."],
    "data-entry": ["Carga de datos", "Carga operativa directa hacia las planillas."],
    imports: ["Imports", "Carga y revision de datos operativos y financieros."],
    settings: ["Configuracion", "Categorias usadas para clasificar el Estado de Resultados."]
  };

  els["page-title"].textContent = titles[view][0];
  els["page-subtitle"].textContent = titles[view][1];
}

/*
  ImportaciĂłn CSV:
  Cada importaciĂłn reemplaza el dataset del tipo elegido. Esto evita duplicados al
  volver a cargar un Google Sheet actualizado. Las filas con fecha invĂˇlida se
  ignoran y quedan registradas para revisiĂłn.
*/
function importCsv(kind, text, source) {
  const rows = parseCsv(text);
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

  const headers = rows[0].map(normalizeHeader);
  const parsedRows = [];
  const errors = [];

  rows.slice(1).forEach((cells, index) => {
    if (cells.every((cell) => !cell.trim())) return;
    const raw = Object.fromEntries(headers.map((header, i) => [header, cells[i] || ""]));
    const rowNumber = index + 2;
    const parsed = parseRow(kind, raw);

    if (kind === "inventoryDetails" && !parsed.isProduct) return;

    if (!["orderDetails", "recipes"].includes(kind) && !parsed.date) {
      errors.push({
        source: labelForKind(kind),
        row: rowNumber,
        reason: "Fecha invalida",
        raw: cells.join(" | ")
      });
      return;
    }

    parsed.source = source;
    parsedRows.push(parsed);
  });

  state[kind] = parsedRows;
  state.importErrors = [
    ...state.importErrors.filter((error) => error.source !== labelForKind(kind) && error.source !== kind),
    ...errors
  ];

  saveState();
  setupPeriodSelectors();
  render();
}

/*
  Importa desde una URL pĂşblica. Si el usuario pega un link normal de Google Sheets,
  se transforma al endpoint CSV para evitar exigir una URL tĂ©cnica.
*/
async function loadCsvFromUrl(kind, button = null, forceReload = false) {
  const input = document.querySelector(`[data-url="${kind}"]`);
  const rawUrl = input?.value.trim();
  if (!rawUrl || (!forceReload && input.dataset.loadedUrl === rawUrl)) return;

  const originalButtonText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "Cargando...";
  }

  try {
    const csvUrl = googleSheetCsvUrl(rawUrl);
    const response = await fetchWithTimeout(csvUrl, 15000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    input.dataset.loadedUrl = rawUrl;
    saveImportUrl(input);
    setImportUrlEditing(input, false);
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
  const filledInputs = [...document.querySelectorAll("[data-url]")]
    .filter((input) => input.value.trim());
  if (!filledInputs.length) return;

  const button = els["refresh-imports"];
  const originalText = button.textContent;
  button.disabled = true;

  try {
    for (const [index, input] of filledInputs.entries()) {
      button.textContent = `Refrescando ${index + 1}/${filledInputs.length}...`;
      await loadCsvFromUrl(input.dataset.url, null, true);
    }
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal })
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
  saveState();
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

function googleSheetCsvUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.hostname !== "docs.google.com") return rawUrl;

  if (url.pathname.includes("/pub")) {
    url.pathname = url.pathname.replace("/pubhtml", "/pub");
    url.searchParams.set("output", "csv");
    return url.toString();
  }

  const sheetMatch = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!sheetMatch) return rawUrl;

  const spreadsheetId = sheetMatch[1];
  const hashGid = url.hash.match(/gid=(\d+)/)?.[1];
  const gid = url.searchParams.get("gid") || hashGid || "0";
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
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
  const headers = rows[0].map(normalizeHeader);
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

  if (kind === "inventory") {
    return {
      date,
      value: parseMoney(pick(raw, ["monetario", "valor monetizado total del inventario", "valor monetizado", "valor", "inventario"]))
    };
  }

  if (kind === "inventoryDetails") {
    const itemName = pick(raw, ["nombre_item", "nombre item", "producto", "item"]);
    const recipeQuantity = parseQuantity(pick(raw, ["cantidad_receta_basica", "cantidad receta basica", "cantidad_rb", "cantidad rb"]));
    const isProduct = isInventoryProduct(itemName);
    return {
      date: parseDate(pick(raw, ["fecha", "date"])),
      itemName,
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
  renderCounts();
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
  - Inventario inicial: Ăşltimo registro disponible del mes anterior.
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

  const previousMonthStartIso = toIsoDate(new Date(year, month - 1, 1));
  const previousMonthEndIso = toIsoDate(new Date(year, month, 0));
  const initialInventory = lastInventoryBetween(previousMonthStartIso, previousMonthEndIso);
  const finalInventory = lastInventoryBetween(startIso, endIso);
  const salesBuckets = {
    schools: sumSalesByCategories(monthlySales, ["Escuelas"]),
    other: sum(monthlySales.filter((sale) => !matchesAnyCategory(sale.category, ["Escuelas"])), "subtotal")
  };
  const salesNet = salesBuckets.schools + salesBuckets.other;
  const unitsSold = sum(monthlyOrderDetails, "individualQuantity");
  const customerCount = countCustomers(monthlySales, monthlyOrderDetails);
  const averagePrice = unitsSold ? salesNet / unitsSold : 0;
  const production = buildProductionSummary(previousMonthStartIso, previousMonthEndIso, startIso, endIso, unitsSold);
  const payroll = buildPayrollSummary(monthlyPayroll);
  production.unitsPerHour = payroll.totalHours ? production.calculatedUnits / payroll.totalHours : 0;

  const expenseSubtotal = (categories) => sumExpensesByCategories(monthlyExpenses, categories, "subtotal");
  const merchandiseCost = (initialInventory?.value || 0) + expenseSubtotal(["Mercaderia"]) - (finalInventory?.value || 0);

  const costOfSales = {
    merchandise: merchandiseCost,
    commissions: expenseSubtotal(["Comisiones"]),
    grossRevenueTax: sumSalesByInvoiceType(monthlySales, ["Factura_A"]) * 0.015,
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

function buildProductionSummary(previousStartIso, previousEndIso, startIso, endIso, unitsSold) {
  const initial = lastInventoryDetailUnitsBetween(previousStartIso, previousEndIso);
  const final = lastInventoryDetailUnitsBetween(startIso, endIso);
  const initialUnits = initial?.units || 0;
  const finalUnits = final?.units || 0;

  /*
    Criterio pedido por el negocio:
    producciĂłn mensual = ventas individuales + inventario final individual - inventario inicial individual.
    El inventario inicial/final usa el Ăşltimo dĂ­a cargado dentro del mes correspondiente.
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
    warnings.push("Falta inventario inicial: no hay valor monetizado cargado en el mes anterior.");
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
  const groups = buildCashflowGroups();
  const visibleGroups = groups.filter((group) => group.week.number <= 4);
  const searchTerm = normalizeSearchText(els["cashflow-search"]?.value || "");
  const tableGroups = searchTerm
    ? visibleGroups.filter((group) => cashflowGroupMatchesSearch(group, searchTerm))
    : visibleGroups;
  const initialCash = cashAmountFor("Banco ICBC") + cashAmountFor("Banco GAL") + cashAmountFor("Efectivo");
  const income = visibleGroups.filter((group) => group.amount > 0).reduce((total, group) => total + group.amount, 0);
  const outcome = visibleGroups.filter((group) => group.amount < 0).reduce((total, group) => total + Math.abs(group.amount), 0);
  const weeklyTimeline = buildCashflowWeeklyTimeline(tableGroups, initialCash)
    .filter((week) => !searchTerm || tableGroups.some((group) => group.week.number === week.number));

  els["cashflow-timeline"].innerHTML = tableGroups.length
    ? cashflowWeeklyRows(weeklyTimeline, tableGroups, Boolean(searchTerm))
    : emptyRow(4, searchTerm ? "No hay movimientos que coincidan con la busqueda." : "No hay movimientos para proyectar.");
}

function buildCashflowGroups() {
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
    return b.date.localeCompare(a.date);
  });
  const colspans = {
    expenses: 11,
    sales: 10,
    orderDetails: 3,
    inventory: 2,
    inventoryDetails: 4,
    payroll: 3
  };
  els[tableBodyIdForKind(kind)].innerHTML = sorted.length
    ? sorted.slice(0, 200).map(rowRenderer).join("")
    : emptyRow(colspans[kind], "Todavia no hay datos cargados.");
  els[countLabelIdForKind(kind)].textContent = ["sales", "orderDetails", "payroll"].includes(kind)
    ? `${displayRows.length} registros del periodo`
    : `${rows.length} registros`;
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
      <td>${formatDate(row.date)}</td>
      <td class="num">${formatMoney(row.value)}</td>
    </tr>
  `;
}

function inventoryDetailRow(row) {
  return `
    <tr>
      <td>${formatDate(row.date)}</td>
      <td>${escapeHtml(row.itemName)}</td>
      <td class="num">${formatNumber(row.recipeQuantity)}</td>
      <td class="num">${formatNumber(row.individualQuantity)}</td>
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

function renderCounts() {
  els["count-sales"].textContent = state.sales.length;
  els["count-expenses"].textContent = state.expenses.length;
  els["count-inventory"].textContent = state.inventory.length;
  els["count-inventory-details"].textContent = state.inventoryDetails.length;
  els["count-order-details"].textContent = state.orderDetails.length;
  els["count-payroll"].textContent = state.payroll.length;
  els["count-errors"].textContent = state.importErrors.length;
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

function percentValue(value, base) {
  return base ? value / base : 0;
}

function formatNumber(value) {
  return new Intl.NumberFormat("es-AR", {
    maximumFractionDigits: 2
  }).format(value || 0);
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
    recipes: "Recetas"
  }[kind] || kind;
}

