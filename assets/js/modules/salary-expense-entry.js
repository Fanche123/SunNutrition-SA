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
  const recoveredSecondaryState = reconcileSalaryLaborExpenseStateFromBackend();
  if (recoveredSecondaryState) {
    try {
      await persistPayrollSecondaryState();
      setCommercialStatus("salary-expense-status", "Operacion financiera recuperada y app-state secundario actualizado.", "success");
    } catch {
      setCommercialStatus("salary-expense-status", "Operacion financiera completada; la actualizacion secundaria de app-state sigue pendiente.", "warn");
    }
  }
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
  const socialChargesCents = salaryLaborCostUi.periodKey === periodKey
    && Number.isInteger(salaryLaborCostUi.socialOverrideCents)
    ? salaryLaborCostUi.socialOverrideCents
    : summary.socialChargesCents;
  const socialChargesTotal = centsToMoney(socialChargesCents);
  const laborExpenses = state.payrollEntry.laborExpenses || createDefaultPayrollState().laborExpenses;
  const existingExpenseKeys = salaryExpenseExistingKeys(periodKey);
  const laborRows = [];

  if (
    socialChargesCents > 0
    && !laborExpenses.socialChargeExpenseByPeriod?.[periodKey]
    && !existingExpenseKeys.has(salaryExpensePeriodKey("labor-social", periodKey))
    && !existingExpenseKeys.has(salaryExpenseMatchKey("labor-social", salaryDate, socialChargesTotal))
  ) {
    laborRows.push({
      rowType: "labor-social",
      salary: {},
      salaryId: `labor-social-${periodKey}`,
      salaryDate,
      employeeName: "Cargas Sociales",
      employeeCategory: "Cargas sociales",
      netSalary: socialChargesTotal
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
  return `${rowType}|${periodKey}|${moneyToCents(amount)}`;
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
  const selectedTypes = new Set(selectedRows.map((row) => row.rowType));
  const totalCents = selectedRows.reduce((sum, row) => sum + moneyToCents(row.netSalary), 0);
  if (els["salary-expense-selection"]) {
    els["salary-expense-selection"].textContent = `${selectedRows.length} concepto${selectedRows.length === 1 ? "" : "s"} seleccionado${selectedRows.length === 1 ? "" : "s"}`;
  }
  if (els["salary-expense-subtotal"] && !els["salary-expense-subtotal"].dataset.touched) {
    els["salary-expense-subtotal"].value = totalCents ? formatMoneyInput(centsToMoney(totalCents)) : "";
  }
  if (els["salary-expense-iva"] && !els["salary-expense-iva"].dataset.touched) {
    els["salary-expense-iva"].value = "";
  }
  if (els["salary-expense-total"] && !els["salary-expense-total"].dataset.touched) {
    els["salary-expense-total"].value = totalCents ? formatMoneyInput(centsToMoney(totalCents)) : "";
  }
  if (els["salary-expense-invoice-type"]) {
    if (selectedTypes.size === 1 && selectedTypes.has("labor-social")) els["salary-expense-invoice-type"].value = "Cargas_Sociales";
    if (selectedTypes.size === 1 && selectedTypes.has("labor-cooperative")) els["salary-expense-invoice-type"].value = "Cooperativa";
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
  const totalCents = [
    "salary-expense-subtotal",
    "salary-expense-iva",
    "salary-expense-vat-retention",
    "salary-expense-iibb-retention",
    "salary-expense-internal-taxes"
  ].reduce((sum, id) => sum + entryMoneyCents(id), 0);
  if (els["salary-expense-total"] && !els["salary-expense-total"].dataset.touched) {
    els["salary-expense-total"].value = totalCents ? formatMoneyInput(centsToMoney(totalCents)) : "";
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
    if (els[id]) els[id].value = formatMoneyInput(normalizeMoney(value));
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
  const includesSalary = selectedRows.some((row) => row.rowType === "salary");
  const includesLabor = selectedRows.some((row) => row.rowType !== "salary");
  if (includesSalary && includesLabor) {
    setCommercialStatus("salary-expense-status", "Guarda liquidaciones y costos laborales en egresos separados para conservar una asociacion verificable.", "error");
    return;
  }

  const invoiceType = backendId(els["salary-expense-invoice-type"]?.value);
  const invoiceNumber = backendId(els["salary-expense-invoice-number"]?.value);
  const invoiceDate = parseDate(els["salary-expense-invoice-date"]?.value);
  const total = entryMoneyValue("salary-expense-total");
  if (!invoiceType || !invoiceNumber || !invoiceDate || total <= 0) {
    setCommercialStatus("salary-expense-status", "Completa tipo, numero, fecha y total del egreso.", "error");
    return;
  }

  const button = event.submitter || els["salary-expense-submit"];
  setCommercialButtonLoading(button, true, "Guardando...");
  setCommercialStatus("salary-expense-status", "Guardando egreso de sueldos...", "pending");

  try {
    const paymentDate = parseDate(els["salary-expense-payment-date"]?.value) || salaryPaymentDueDate(invoiceDate);
    const expense = {
      fecha_factura: invoiceDate,
      fecha_prevista_pago: paymentDate,
      id_etiqueta: salaryExpenseLabelId(selectedRows),
      tipo_factura: invoiceType,
      nro_factura: invoiceNumber,
      iva: entryMoneyValue("salary-expense-iva"),
      per_ret_iva: entryMoneyValue("salary-expense-vat-retention"),
      per_ret_iibb: entryMoneyValue("salary-expense-iibb-retention"),
      imp_internos: entryMoneyValue("salary-expense-internal-taxes"),
      subtotal: entryMoneyValue("salary-expense-subtotal"),
      total
    };
    const salaryIds = selectedRows.filter((row) => row.rowType === "salary").map((row) => row.salaryId);
    const concepts = selectedRows.map((row) => ({
      type: row.rowType,
      salaryId: row.rowType === "salary" ? row.salaryId : "",
      amount: normalizeMoney(row.netSalary)
    }));
    const response = await fetch(`${API_BASE_URL}/api/payroll/expenses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ salaryIds, concepts, expense })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      const error = new Error(payload.error || `HTTP ${response.status}`);
      error.financialCompleted = Boolean(payload.financialCompleted);
      throw error;
    }
    const expenseId = payload.expenseId;
    const secondaryStateChanged = registerSelectedSalaryLaborExpenses(
      selectedRows,
      state.payrollEntry.selectedPeriod || currentPayrollPeriodKey(),
      expenseId
    );
    let secondaryStatePending = false;
    if (secondaryStateChanged) {
      try {
        await persistPayrollSecondaryState();
      } catch {
        secondaryStatePending = true;
      }
    }

    salaryExpenseEntryData.loaded = false;
    commercialEntryData.loaded = false;
    await loadSalaryExpenseEntryData(true);
    resetSalaryExpenseForm();
    renderSalaryEntry();
    if (secondaryStatePending) {
      setCommercialStatus("salary-expense-status", `Operacion financiera #${expenseId} completada. La actualizacion secundaria de app-state esta pendiente y se reintentara al recargar.`, "warn");
    } else {
      setCommercialStatus("salary-expense-status", `Egreso de sueldos #${expenseId} guardado y asociado a ${selectedRows.length} concepto(s).`, "success");
    }
  } catch (error) {
    const prefix = error.financialCompleted ? "Operacion financiera completada; app-state pendiente:" : "No se pudo guardar el egreso de sueldos:";
    setCommercialStatus("salary-expense-status", `${prefix} ${error.message}`, error.financialCompleted ? "warn" : "error");
  } finally {
    setCommercialButtonLoading(button, false);
  }
}

function registerSelectedSalaryLaborExpenses(selectedRows, periodKey, expenseId) {
  const hasSocialChargeRow = selectedRows.some((row) => row.rowType === "labor-social");
  const hasCooperativeRow = selectedRows.some((row) => row.rowType === "labor-cooperative");
  if (!hasSocialChargeRow && !hasCooperativeRow) return false;

  state.payrollEntry.laborExpenses = state.payrollEntry.laborExpenses || createDefaultPayrollState().laborExpenses;
  if (hasSocialChargeRow) {
    state.payrollEntry.laborExpenses.socialChargeExpenseByPeriod[periodKey] = String(expenseId);
  }
  if (hasCooperativeRow) {
    state.payrollEntry.laborExpenses.cooperativeExpenseByPeriod[periodKey] = String(expenseId);
  }
  return true;
}

function reconcileSalaryLaborExpenseStateFromBackend() {
  const laborExpenses = state.payrollEntry.laborExpenses || createDefaultPayrollState().laborExpenses;
  state.payrollEntry.laborExpenses = laborExpenses;
  let changed = false;
  (salaryExpenseEntryData.expenses || []).forEach((expense) => {
    const periodKey = isoDateFromMixedValue(expense.fecha_factura).slice(0, 7);
    const expenseId = backendId(expense.id_egreso);
    const type = normalizeSearchText(expense.tipo_factura);
    if (!periodKey || !expenseId) return;
    if (type === "cargas sociales" && !laborExpenses.socialChargeExpenseByPeriod[periodKey]) {
      laborExpenses.socialChargeExpenseByPeriod[periodKey] = expenseId;
      changed = true;
    }
    if (["cooperativa", "cargas cooperativa"].includes(type) && !laborExpenses.cooperativeExpenseByPeriod[periodKey]) {
      laborExpenses.cooperativeExpenseByPeriod[periodKey] = expenseId;
      changed = true;
    }
  });
  return changed;
}

async function persistPayrollSecondaryState() {
  saveState({ scheduleRemote: false });
  if (!canUseServerState()) return;
  const response = await fetch(`${API_BASE_URL}/api/app-state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: compactStateForStorage(state) })
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
