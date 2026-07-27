async function initializeSalaryEntry() {
  if (!els["salary-period-select"]) return;
  resetSalaryLaborCostUi();
  salaryEntryScale = state.payrollEntry.scale || { categories: {}, sourceName: "" };
  renderSalaryPeriodOptions();
  if (els["salary-scale-period"]) els["salary-scale-period"].value = state.payrollEntry.selectedPeriod;
  await Promise.all([
    loadSalaryEmployees(),
    loadSalaryExpenseEntryData(true)
  ]);
  renderSalaryEntry();
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
  if (els["salary-scale-period"] && !els["salary-scale-period"].value) {
    els["salary-scale-period"].value = state.payrollEntry.selectedPeriod;
  }
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
  } catch (error) {
    salaryEntryEmployees = [];
    throw error;
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
  const calendar = payrollCalendarForYear(period.year);
  let workedDays = 0;
  let holidayDays = 0;
  for (let cursor = dateFromIso(period.startIso); cursor <= dateFromIso(period.endIso); cursor = addDays(cursor, 1)) {
    const iso = toIsoDate(cursor);
    const weekday = cursor.getDay() !== 0 && cursor.getDay() !== 6;
    if (!weekday) continue;
    if (calendar.dates.has(iso)) holidayDays += 1;
    else workedDays += 1;
  }
  return {
    workedHours: workedDays * 8,
    holidayHours: holidayDays * 8,
    workedDays,
    holidayDays,
    calendarConfigured: calendar.configured
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
      awardsCents: 0,
      awards: 0
    };

    exceptions
      .filter((entry) => entry.employeeId === employee.id)
      .forEach((entry) => applySalaryException(row, entry));

    const scale = salaryScaleForCategory(employee.category);
    const paidBaseHours = row.workedHours + row.justifiedHours + row.holidayHours;
    if (scale.type === "hourly") {
      const paidHoursFactor = paidBaseHours + row.extraHours * 1.5;
      row.valorRemunerativo = centsToMoney(ErpMoney.multiplyCents(scale.remunerative, paidHoursFactor));
      row.valorNoRemunerativo = centsToMoney(moneyToCents(scale.nonRemunerative));
    } else {
      row.valorRemunerativo = centsToMoney(moneyToCents(scale.remunerative));
      row.valorNoRemunerativo = centsToMoney(moneyToCents(scale.nonRemunerative));
    }
    row.scaleConfigured = scale.configured;
    const grossCents = ErpMoney.sumCents(row.valorRemunerativo, row.valorNoRemunerativo, row.awards);
    row.sueldoBruto = centsToMoney(grossCents);
    // Estimacion conservadora: hasta modelar aportes reales, se expone un neto aproximado para control operativo.
    row.sueldoNeto = centsToMoney(ErpMoney.percentageCents(row.sueldoBruto, 83));
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
  if (entry.type === "award") {
    row.awardsCents = (row.awardsCents || 0) + moneyToCents(amount);
    row.awards = centsToMoney(row.awardsCents);
  }
}

function salaryExceptionAmount(entry) {
  if (entry.type === "award") return parseMoney(entry.hours);
  return parseQuantity(entry.hours);
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
  const scale = salaryEntryScale.categories[normalized];
  if (!scale) return { type: "hourly", remunerative: 0, nonRemunerative: 0, configured: false };
  const periodScale = scale.periods?.[state.payrollEntry.selectedPeriod];
  if (!periodScale) return { ...scale, remunerative: 0, nonRemunerative: 0, configured: false };
  return {
    ...scale,
    remunerative: periodScale.remunerative,
    nonRemunerative: periodScale.nonRemunerative,
    configured: true
  };
}

function renderSalaryEntry() {
  if (!els["salary-entry-body"]) return;
  renderSalaryPeriodOptions();
  const period = selectedSalaryPeriodBounds();
  const base = buildSalaryBaseHours(period);
  const calendarWarning = base.calendarConfigured ? "" : " Calendario laboral no configurado para este año: cálculo preliminar, guardado bloqueado.";
  els["salary-period-summary"].textContent = `${formatDate(period.startIso)} al ${formatDate(period.endIso)}: ${base.workedHours} hs trabajadas base y ${base.holidayHours} hs feriado.${calendarWarning}`;
  const hasPeriodScale = Object.values(salaryEntryScale.categories || {}).some((scale) => scale.periods?.[state.payrollEntry.selectedPeriod]);
  els["salary-table-caption"].textContent = hasPeriodScale
    ? `Escala cargada: ${salaryEntryScale.sourceName}. Estimacion: 83 % del sueldo bruto.`
    : "Sin escala configurada para este periodo. El calculo es incompleto y no puede guardarse.";

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
  const periodKey = state.payrollEntry.selectedPeriod || currentPayrollPeriodKey();
  if (salaryLaborCostUi.periodKey !== periodKey) resetSalaryLaborCostUi();
  const displayedSocialTotalCents = salaryLaborCostUi.socialOverrideCents ?? summary.socialChargesCents;

  els["salary-labor-costs"].innerHTML = `
    <div class="salary-labor-cost-row">
      <div class="salary-labor-cost-summary">
        <span class="salary-labor-cost-heading">Cargas sociales</span>
        <span>${summary.dependencyCount} empleado(s) en relacion de dependencia</span>
        <span>Base bruta: ${formatMoney(summary.dependencyGross)}</span>
      </div>
      ${salaryLaborCostReadOnlyValue("Aportes del empleado", summary.employeeContributionsCents)}
      ${salaryLaborCostReadOnlyValue("Empleador + ART (25,8 %)", summary.employerContributionsCents)}
      <div class="salary-labor-cost-value salary-labor-cost-total">
        <span class="salary-labor-cost-title">Total cargas sociales</span>
        ${salaryLaborCostUi.socialEditing
          ? salaryLaborCostMoneyInput(
              "salary-social-charge-total-input",
              salaryLaborCostUi.socialDraft,
              salaryLaborCostUi.socialError
            )
          : `<span class="salary-labor-cost-display">${formatMoney(centsToMoney(displayedSocialTotalCents))}</span>`}
        ${salaryLaborCostUi.socialOverrideCents !== null ? `
          <small>Valor manual temporal</small>
          <small>Automático: ${formatMoney(summary.socialChargesTotal)}</small>
        ` : ""}
      </div>
      ${salaryLaborCostActions("social", salaryLaborCostUi.socialEditing)}
    </div>
    <div class="salary-labor-cost-row">
      <div class="salary-labor-cost-summary">
        <span class="salary-labor-cost-heading">Cooperativa</span>
        <span>${summary.cooperativeCount} persona(s)</span>
      </div>
      <div class="salary-labor-cost-value salary-labor-cost-spacer" aria-hidden="true"></div>
      <div class="salary-labor-cost-value salary-labor-cost-cooperative-value">
        <span class="salary-labor-cost-title">Costo por persona</span>
        ${salaryLaborCostUi.cooperativeEditing
          ? salaryLaborCostMoneyInput(
              "salary-cooperative-cost-per-employee",
              salaryLaborCostUi.cooperativeDraft,
              salaryLaborCostUi.cooperativeError
            )
          : `<span class="salary-labor-cost-display">${formatMoney(settings.cooperativeEmployeeCost)}</span>`}
      </div>
      <div class="salary-labor-cost-value salary-labor-cost-total">
        <span class="salary-labor-cost-title">Total Cooperativa</span>
        <span id="salary-cooperative-total-value" class="salary-labor-cost-display">${formatMoney(summary.cooperativeTotal)}</span>
      </div>
      ${salaryLaborCostActions("cooperative", salaryLaborCostUi.cooperativeEditing)}
    </div>
  `;
}

function salaryLaborCostReadOnlyValue(label, valueCents) {
  return `
    <div class="salary-labor-cost-value">
      <span class="salary-labor-cost-title">${label}</span>
      <span class="salary-labor-cost-display">${formatMoney(centsToMoney(valueCents))}</span>
    </div>
  `;
}

function salaryLaborCostMoneyInput(id, draft, errorCode) {
  const errorMessage = salaryLaborCostInputErrorMessage(errorCode);
  const errorId = `${id}-error`;
  return `
    <input
      id="${id}"
      type="text"
      inputmode="decimal"
      data-money-input
      autocomplete="off"
      value="${escapeHtml(draft)}"
      aria-invalid="${errorMessage ? "true" : "false"}"
      aria-describedby="${errorId}"
    >
    <small id="${errorId}" class="salary-labor-cost-error"${errorMessage ? "" : " hidden"}>${escapeHtml(errorMessage)}</small>
  `;
}

function salaryLaborCostInputErrorMessage(errorCode) {
  if (!errorCode) return "";
  if (errorCode === "EMPTY_NOT_ALLOWED") return "Ingresá un importe.";
  if (errorCode === "TOO_MANY_DECIMALS") return "Ingresá como máximo dos decimales.";
  if (errorCode === "NEGATIVE_NOT_ALLOWED") return "El importe no puede ser negativo.";
  return "Ingresá un importe válido.";
}

function salaryLaborCostActions(section, editing) {
  return `
    <div class="salary-labor-cost-actions">
      ${editing
        ? `
          <button type="button" data-salary-labor-action="save-${section}">Guardar</button>
          <button type="button" class="secondary" data-salary-labor-action="cancel-${section}">Cancelar</button>
        `
        : `<button type="button" class="secondary" data-salary-labor-action="edit-${section}">Editar</button>`}
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
  const cooperativeEmployeeCostCents = moneyToCents(cooperativeCost);
  return {
    cooperativeEmployeeCostCents,
    cooperativeEmployeeCost: centsToMoney(cooperativeEmployeeCostCents)
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
  const dependencyGrossCents = dependencyRows.reduce((total, row) => total + moneyToCents(row.sueldoBruto), 0);
  const employeeContributionsCents = dependencyRows.reduce(
    (total, row) => total + moneyToCents(row.sueldoBruto) - moneyToCents(row.sueldoNeto),
    0
  );
  const employerContributionsCents = ErpMoney.percentageCents(centsToMoney(dependencyGrossCents), 25.8);
  const socialChargesCents = employeeContributionsCents + employerContributionsCents;
  const cooperativeEmployeeCostCents = Number.isInteger(settings.cooperativeEmployeeCostCents)
    ? settings.cooperativeEmployeeCostCents
    : moneyToCents(settings.cooperativeEmployeeCost);
  const cooperativeTotalCents = cooperativeRows.length * cooperativeEmployeeCostCents;
  return {
    dependencyCount: dependencyRows.length,
    dependencyGrossCents,
    dependencyGross: centsToMoney(dependencyGrossCents),
    employeeContributionsCents,
    employeeContributionsTotal: centsToMoney(employeeContributionsCents),
    employerContributionsCents,
    employerContributionsTotal: centsToMoney(employerContributionsCents),
    socialChargesCents,
    socialChargesTotal: centsToMoney(socialChargesCents),
    cooperativeCount: cooperativeRows.length,
    cooperativeTotalCents,
    cooperativeTotal: centsToMoney(cooperativeTotalCents)
  };
}

function resetSalaryLaborCostUi() {
  const periodKey = state.payrollEntry.selectedPeriod || currentPayrollPeriodKey();
  salaryLaborCostUi = {
    periodKey,
    socialEditing: false,
    socialDraft: "",
    socialError: "",
    socialOverrideCents: null,
    cooperativeEditing: false,
    cooperativeDraft: "",
    cooperativeError: ""
  };
}

function handleSalaryLaborCostAction(event) {
  const action = event.target.closest("[data-salary-labor-action]")?.dataset.salaryLaborAction;
  if (!action) return;
  const settings = salaryLaborCostSettingsForCurrentPeriod();
  const summary = salaryLaborCostSummary(buildSalaryRows(), settings);

  if (action === "edit-social") {
    salaryLaborCostUi.socialEditing = true;
    salaryLaborCostUi.socialError = "";
    salaryLaborCostUi.socialDraft = formatMoneyInput(
      centsToMoney(salaryLaborCostUi.socialOverrideCents ?? summary.socialChargesCents)
    );
  } else if (action === "cancel-social") {
    salaryLaborCostUi.socialEditing = false;
    salaryLaborCostUi.socialDraft = "";
    salaryLaborCostUi.socialError = "";
    salaryLaborCostUi.socialOverrideCents = null;
  } else if (action === "save-social") {
    const input = els["salary-labor-costs"].querySelector("#salary-social-charge-total-input");
    const parsed = parseMoneyInput(input?.value, { allowEmpty: false, allowNegative: false });
    if (!parsed.ok) {
      salaryLaborCostUi.socialDraft = input?.value || "";
      salaryLaborCostUi.socialError = parsed.error;
      renderSalaryLaborCosts(buildSalaryRows());
      return;
    }
    salaryLaborCostUi.socialOverrideCents = parsed.cents;
    salaryLaborCostUi.socialDraft = formatMoneyInput(parsed.amount);
    salaryLaborCostUi.socialError = "";
    salaryLaborCostUi.socialEditing = false;
  } else if (action === "edit-cooperative") {
    salaryLaborCostUi.cooperativeEditing = true;
    salaryLaborCostUi.cooperativeError = "";
    salaryLaborCostUi.cooperativeDraft = formatMoneyInput(settings.cooperativeEmployeeCost);
  } else if (action === "cancel-cooperative") {
    salaryLaborCostUi.cooperativeEditing = false;
    salaryLaborCostUi.cooperativeDraft = "";
    salaryLaborCostUi.cooperativeError = "";
  } else if (action === "save-cooperative") {
    const input = els["salary-labor-costs"].querySelector("#salary-cooperative-cost-per-employee");
    const parsed = parseMoneyInput(input?.value, { allowEmpty: false, allowNegative: false });
    if (!parsed.ok) {
      salaryLaborCostUi.cooperativeDraft = input?.value || "";
      salaryLaborCostUi.cooperativeError = parsed.error;
      renderSalaryLaborCosts(buildSalaryRows());
      return;
    }
    state.payrollEntry.laborCosts = state.payrollEntry.laborCosts || createDefaultPayrollState().laborCosts;
    const periodKey = state.payrollEntry.selectedPeriod || currentPayrollPeriodKey();
    state.payrollEntry.laborCosts.cooperativeCostByPeriod[periodKey] = centsToMoney(parsed.cents);
    salaryLaborCostUi.cooperativeEditing = false;
    salaryLaborCostUi.cooperativeDraft = formatMoneyInput(parsed.amount);
    salaryLaborCostUi.cooperativeError = "";
    saveState();
  }
  renderSalaryLaborCosts(buildSalaryRows());
  renderSalaryExpenseEntry();
}

function previewSalaryCooperativeTotal(event) {
  const input = event.target;
  const isSocialInput = input.id === "salary-social-charge-total-input";
  const isCooperativeInput = input.id === "salary-cooperative-cost-per-employee";
  if (!isSocialInput && !isCooperativeInput) return;

  const parsed = parseMoneyInput(input.value, { allowEmpty: false, allowNegative: false });
  const errorElement = els["salary-labor-costs"]?.querySelector(`#${input.id}-error`);
  input.setAttribute("aria-invalid", parsed.ok ? "false" : "true");
  if (errorElement) {
    errorElement.textContent = salaryLaborCostInputErrorMessage(parsed.error);
    errorElement.hidden = parsed.ok;
  }

  if (isSocialInput) {
    salaryLaborCostUi.socialDraft = input.value;
    salaryLaborCostUi.socialError = parsed.ok ? "" : parsed.error;
    return;
  }

  salaryLaborCostUi.cooperativeDraft = input.value;
  salaryLaborCostUi.cooperativeError = parsed.ok ? "" : parsed.error;
  if (!parsed.ok) return;
  const cooperativeCount = buildSalaryRows().filter(
    (row) => normalizeSearchText(row.employee.contractType) === "cooperativa"
  ).length;
  const totalCents = cooperativeCount * parsed.cents;
  const totalElement = els["salary-labor-costs"]?.querySelector("#salary-cooperative-total-value");
  if (totalElement) totalElement.textContent = formatMoney(centsToMoney(totalCents));
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
  const amountInput = entry.type === "award"
    ? `<input type="text" inputmode="decimal" data-money-input data-salary-exception-money
        value="${escapeHtml(formatMoneyInput(entry.hours || 0))}"
        data-salary-exception="${escapeHtml(entry.id)}" data-field="hours">`
    : `<input type="number" step="0.5" value="${escapeHtml(entry.hours || "")}"
        data-salary-exception="${escapeHtml(entry.id)}" data-field="hours">`;
  return `
    <tr>
      <td><input type="date" value="${escapeHtml(startDate)}" data-salary-exception="${escapeHtml(entry.id)}" data-field="startDate"></td>
      <td><input type="date" value="${escapeHtml(endDate)}" data-salary-exception="${escapeHtml(entry.id)}" data-field="endDate"></td>
      <td><select data-salary-exception="${escapeHtml(entry.id)}" data-field="employeeId">${employeeOptions}</select></td>
      <td><select data-salary-exception="${escapeHtml(entry.id)}" data-field="type">${typeOptions}</select></td>
      <td class="num">${amountInput}</td>
      <td><input type="text" value="${escapeHtml(entry.note || "")}" placeholder="Detalle opcional" data-salary-exception="${escapeHtml(entry.id)}" data-field="note"></td>
      <td class="num"><button type="button" data-salary-exception-delete="${escapeHtml(entry.id)}">Eliminar</button></td>
    </tr>
  `;
}

function updateSalaryException(input) {
  const entry = state.payrollEntry.exceptions.find((row) => row.id === input.dataset.salaryException);
  if (!entry) return;
  if (input.dataset.field === "hours" && entry.type === "award") {
    const parsed = parseMoneyInput(input.value, { allowEmpty: true, allowNegative: false });
    input.setCustomValidity(parsed.ok ? "" : salaryLaborCostInputErrorMessage(parsed.error));
    if (!parsed.ok) return;
    entry.hours = parsed.empty ? "" : centsToMoney(parsed.cents);
  } else {
    entry[input.dataset.field] = input.value;
  }
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
  const period = selectedSalaryPeriodBounds();
  if (!buildSalaryBaseHours(period).calendarConfigured) {
    setSalaryEntryStatus(`No se puede guardar: falta configurar el calendario laboral de ${period.year}.`, "error");
    return;
  }
  const incompleteRows = buildSalaryRows().filter((row) => !row.scaleConfigured);
  if (incompleteRows.length) {
    setSalaryEntryStatus("No se puede guardar: falta una escala aplicable al periodo para uno o mas empleados.", "error");
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
        valor_remunerativo: centsToMoney(moneyToCents(salary.valorRemunerativo)),
        valor_no_remunerativo: centsToMoney(moneyToCents(salary.valorNoRemunerativo)),
        hs_trabajadas: roundToDecimals(salary.workedHours, 2),
        hs_con_justificacion_medica: roundToDecimals(salary.justifiedHours, 2),
        hs_feriado: roundToDecimals(salary.holidayHours, 2),
        hs_extra: roundToDecimals(salary.extraHours, 2),
        premios: centsToMoney(moneyToCents(salary.awards)),
        sueldo_bruto: centsToMoney(moneyToCents(salary.sueldoBruto)),
        sueldo_neto: centsToMoney(moneyToCents(salary.sueldoNeto))
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
    const periodKey = els["salary-scale-period"]?.value || state.payrollEntry.selectedPeriod;
    const response = await fetch(`${API_BASE_URL}/api/payroll-scale/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: file.name, fileDataUrl, periodKey })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo leer la escala.");
    salaryEntryScale = {
      categories: payload.scale?.categories || {},
      sourceName: file.name,
      periods: payload.scale?.periods || [],
      periodSource: payload.scale?.periodSource || "unknown"
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
