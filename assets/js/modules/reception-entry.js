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
  const subtotalCents = options.reduce((total, currentOption, index) => {
    const quantity = index === 0 && options.length > 0
      ? entryNumberValue("reception-supplier-quantity")
      : Number(currentOption.supplierQuantity) || 0;
    const unitPrice = parseMoneyInput(currentOption.unitPrice, { allowNegative: false });
    return total + (
      unitPrice.ok && !unitPrice.empty
        ? ErpMoney.multiplyCents(centsToMoney(unitPrice.cents), quantity)
        : 0
    );
  }, 0);
  const ivaCents = options.reduce((total, currentOption, index) => {
    const quantity = index === 0 && options.length > 0
      ? entryNumberValue("reception-supplier-quantity")
      : Number(currentOption.supplierQuantity) || 0;
    const unitPrice = parseMoneyInput(currentOption.unitPrice, { allowNegative: false });
    const currentSubtotalCents = unitPrice.ok && !unitPrice.empty
      ? ErpMoney.multiplyCents(centsToMoney(unitPrice.cents), quantity)
      : 0;
    return total + ErpMoney.multiplyCents(
      centsToMoney(currentSubtotalCents),
      Number(currentOption.ivaRate) || 0
    );
  }, 0);
  const ivaRate = subtotalCents ? ivaCents / subtotalCents : 0;
  return {
    subtotal: centsToMoney(subtotalCents),
    ivaRate,
    iva: centsToMoney(ivaCents),
    total: centsToMoney(subtotalCents + ivaCents)
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
  setReceptionReferenceLabel("reception-expense-iva-ref", `${purchaseMoneyLabel(reference.iva)} Ä‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąÄľĂ„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚â€ąĂ‚ÂĂ„â€šĂ‹ÂÄ‚ËĂ˘â€šÂ¬ÄąË‡Ä‚â€šĂ‚Â¬Ä‚â€žĂ„â€¦Ä‚â€ąĂ˘â‚¬Ë‡Ă„â€šĂ˘â‚¬ĹľÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ‹ÂÄ‚ËĂ˘â‚¬ĹˇĂ‚Â¬Ă„Ä…Ă‹â€ˇÄ‚â€žĂ˘â‚¬ĹˇÄ‚ËĂ˘â€šÂ¬ÄąË‡Ă„â€šĂ˘â‚¬ĹˇÄ‚â€šĂ‚Â· ${formatRateLabel(reference.ivaRate)}`);
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
  const expectedTotal = centsToMoney(moneyToCents(reference.subtotal) + moneyToCents(expectedIva));
  [
    ["reception-expense-subtotal", reference.subtotal],
    ["reception-expense-iva", expectedIva],
    ["reception-expense-total", expectedTotal]
  ].forEach(([id, expected]) => {
    const input = els[id];
    if (!input) return;
    const rawValue = String(input.value || "").trim();
    const currentCents = entryMoneyCents(id, { allowNegative: false });
    const expectedCents = moneyToCents(expected);
    const hasValue = rawValue !== "";
    const toleranceCents = Math.max(
      100,
      ErpMoney.percentageCents(centsToMoney(Math.abs(expectedCents)), 0.5)
    );
    input.classList.toggle("is-reference-mismatch", hasValue && Math.abs(currentCents - expectedCents) > toleranceCents);
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

  const totalCents = [
    "reception-expense-subtotal",
    "reception-expense-iva",
    "reception-expense-vat-retention",
    "reception-expense-iibb-retention",
    "reception-expense-internal-taxes"
  ].reduce((sum, id) => sum + entryMoneyCents(id), 0);
  if (els["reception-expense-total"]) {
    els["reception-expense-total"].value = formatMoneyInput(centsToMoney(totalCents));
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
    const option = receptionPendingPurchases.get(purchaseId) || {};
    const file = els["reception-without-file"]?.checked ? null : els["reception-file"]?.files?.[0];
    const attachment = file ? {
      fileName: file.name,
      mimeType: file.type,
      dataBase64: await fileToBase64(file)
    } : null;
    const entries = purchaseIds.map((currentPurchaseId, index) => {
      const currentOption = receptionPendingPurchases.get(currentPurchaseId) || option;
      return {
        purchaseId: currentPurchaseId,
        supplyId: index === 0 ? supplyId : currentOption.supply?.id_insumo || "",
        quantity: index === 0 ? quantity : currentOption.countQuantity
      };
    });
    const response = await fetch(`${API_BASE_URL}/api/receptions/full-entry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        receptionDate,
        employeeId,
        entries,
        expense: {
          invoiceType,
          invoiceNumber: String(els["reception-expense-invoice-number"]?.value || "").trim(),
          invoiceDate,
          paymentDate: String(els["reception-expense-payment-date"]?.value || invoiceDate).trim(),
          iva: entryMoneyValue("reception-expense-iva"),
          vatRetention: entryMoneyValue("reception-expense-vat-retention"),
          iibbRetention: entryMoneyValue("reception-expense-iibb-retention"),
          internalTaxes: entryMoneyValue("reception-expense-internal-taxes"),
          subtotal: entryMoneyValue("reception-expense-subtotal"),
          total: entryMoneyValue("reception-expense-total")
        },
        attachment
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);

    backendDataMap = null;
    dataEditorSchema = null;
    purchaseBackendOptions = createPurchaseBackendOptions();
    await loadReceptionPurchaseOptions();
    setEntryStatus("reception-status", `${payload.receptionIds.length} recepcion(es) guardada(s) con egreso ${payload.expenseId}.`, "success");
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

