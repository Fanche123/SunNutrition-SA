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
  const subtotalCents = entryMoneyCents("other-expense-subtotal");
  const ivaCents = isInvoiceA
    ? ErpMoney.percentageCents(centsToMoney(subtotalCents), 21)
    : 0;
  ivaInput.value = formatMoneyInput(centsToMoney(ivaCents));
  ivaInput.dataset.autoIva = "true";
}

function updateOtherExpenseTotalFromInputs() {
  const totalInput = els["other-expense-total"];
  if (!totalInput || totalInput.dataset.touched === "true") return;
  const calculatedTotalCents = [
    "other-expense-subtotal",
    "other-expense-iva",
    "other-expense-vat-retention",
    "other-expense-iibb-retention",
    "other-expense-internal-taxes"
  ].reduce((sum, id) => sum + entryMoneyCents(id), 0);
  totalInput.value = calculatedTotalCents ? formatMoneyInput(centsToMoney(calculatedTotalCents)) : "";
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
  if (!entryMoneyCents("other-expense-iva")) updateOtherExpenseIvaFromSubtotal({ force: true });
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
  const total = entryMoneyValue("other-expense-total");
  const isNegativeIncome = Boolean(bankNegativeExpenseDraft) && total < 0;

  if (!expenseDate || !creditorId || !creditorTagId || !invoiceType || !invoiceNumber || !invoiceDate || (!isNegativeIncome && total <= 0)) {
    setCommercialStatus("other-expense-status", "Completa fecha, acreedor, etiqueta, factura y total.", "error");
    return;
  }

  const button = event.submitter || els["other-expense-submit"];
  setCommercialButtonLoading(button, true, "Guardando...");
  setCommercialStatus("other-expense-status", "Guardando otro gasto...", "pending");

  try {
    const response = await fetch(`${API_BASE_URL}/api/other-expenses/full-entry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expenseDate,
        creditorId,
        creditorTagId,
        detail: backendId(els["other-expense-detail"]?.value),
        invoiceType,
        invoiceNumber,
        invoiceDate,
        paymentDate: backendId(els["other-expense-payment-date"]?.value) || invoiceDate,
        iva: entryMoneyValue("other-expense-iva"),
        vatRetention: entryMoneyValue("other-expense-vat-retention"),
        iibbRetention: entryMoneyValue("other-expense-iibb-retention"),
        internalTaxes: entryMoneyValue("other-expense-internal-taxes"),
        subtotal: entryMoneyValue("other-expense-subtotal"),
        total
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);

    event.target.reset();
    if (els["other-expense-total"]) delete els["other-expense-total"].dataset.touched;
    if (els["other-expense-iva"]) {
      delete els["other-expense-iva"].dataset.touched;
      delete els["other-expense-iva"].dataset.autoIva;
    }
    if (els["other-expense-payment-date"]) delete els["other-expense-payment-date"].dataset.autoAgreement;
    clearOtherExpenseFile();
    bankNegativeExpenseDraft = null;
    ["other-expense-subtotal", "other-expense-total"].forEach((id) => {
      els[id]?.setAttribute("min", "0");
      els[id]?.removeAttribute("data-money-allow-negative");
    });
    otherExpenseEntryData.loaded = false;
    backendDataMap = null;
    dataEditorSchema = null;
    await loadOtherExpenseEntryOptions(true);
    setCommercialStatus("other-expense-status", `Otro gasto #${payload.otherExpenseId} guardado con egreso #${payload.expenseId}.`, "success");
  } catch (error) {
    setCommercialStatus("other-expense-status", `No se pudo guardar el otro gasto: ${error.message}`, "error");
  } finally {
    setCommercialButtonLoading(button, false);
  }
}

