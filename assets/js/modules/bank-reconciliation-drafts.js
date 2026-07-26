function openBankPaymentDebtReview(index) {
  const movement = bankReconciliationReport?.movements?.[index];
  const creditorId = bankMovementCreditorId(movement);
  if (!movement || !creditorId) return;

  bankPaymentDraft = {
    creditorId: String(creditorId),
    date: String(movement.date || ""),
    bank: String(els["bank-reconciliation-bank"]?.value || "ICBC"),
    method: movement.checkNumber ? "Cheque" : "Transferencia",
    amount: normalizeMoney(bankMovementPaymentAmount(movement))
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
      <label>Pedido minimo<input data-creditor-extra="pedido_minimo" type="text" inputmode="decimal" data-money-input
        value="${escapeHtml(creditorSupplierMoneyInputValue(values.pedido_minimo))}"></label>`;
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

function creditorSupplierMoneyInputValue(value) {
  const parsed = parseMoneyInput(value, { allowEmpty: true, allowNegative: false });
  return parsed.ok && !parsed.empty ? formatMoneyInput(parsed.amount) : "";
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
        <input data-supplier-item="precio" type="text" inputmode="decimal" data-money-input value="${escapeHtml(
          creditorSupplierMoneyInputValue(item.precio)
        )}">
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
  const rawSupplierItems = type === "proveedor"
    ? creditorEntrySupplierItems.filter((item) => item.idInsumo)
    : [];
  if (rawSupplierItems.some((item) => !item.udProveedor || !item.cantidadProveedor)) {
    if (els["creditor-entry-status"]) els["creditor-entry-status"].textContent = "Completa la presentación y cantidad de cada insumo seleccionado.";
    return;
  }
  const invalidPrice = rawSupplierItems.find((item) => (
    !parseMoneyInput(item.precio, { allowEmpty: true, allowNegative: false }).ok
  ));
  if (invalidPrice) {
    if (els["creditor-entry-status"]) {
      els["creditor-entry-status"].textContent = "Revisá el precio: debe ser un importe con hasta dos decimales.";
    }
    return;
  }
  const supplierItems = rawSupplierItems.map((item) => {
    const parsed = parseMoneyInput(item.precio, { allowEmpty: true, allowNegative: false });
    return {
      ...item,
      precio: parsed.empty ? "" : parsed.amount
    };
  });
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
    els["collection-received-total"].value = formatMoneyInput(normalizeMoney(
      movement.credit || Math.abs(movement.amount || 0)
    ));
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

  const amount = centsToMoney(-Math.abs(moneyToCents(movement.credit || movement.amount || 0)));
  if (els["other-expense-date"]) els["other-expense-date"].value = movement.date || "";
  if (els["other-expense-detail"]) els["other-expense-detail"].value = movement.detail || "Ingreso no comercial";
  if (els["other-expense-invoice-type"]) els["other-expense-invoice-type"].value = "Remito_X";
  if (els["other-expense-invoice-date"]) els["other-expense-invoice-date"].value = movement.date || "";
  if (els["other-expense-payment-date"]) els["other-expense-payment-date"].value = movement.date || "";
  ["other-expense-subtotal", "other-expense-total"].forEach((id) => {
    const input = els[id];
    if (!input) return;
    input.removeAttribute("min");
    input.setAttribute("data-money-allow-negative", "true");
    input.value = formatMoneyInput(normalizeMoney(amount));
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
    els["partner-contribution-amount"].value = formatMoneyInput(normalizeMoney(
      centsToMoney(Math.abs(moneyToCents(movement.credit || movement.amount || 0)))
    ));
  }
  setCommercialStatus("partner-contribution-status", "Ingreso no comercial precargado. Selecciona el socio y confirma el aporte o retiro.", "pending");
}

async function openBankCheckDraft(index) {
  const movement = bankReconciliationReport?.movements?.[index];
  if (!movement) return;
  await openDataEditorDraft("cheques_recibidos", {
    id_cobro: "",
    fecha_entregado: movement.date || "",
    monto: centsToMoney(Math.abs(moneyToCents(movement.credit || movement.amount || 0))),
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
  if (els["purchase-total"]) {
    els["purchase-total"].value = formatMoneyInput(centsToMoney(
      Math.abs(moneyToCents(movement.amount || movement.debit || 0))
    ));
  }
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
  if (els["issued-check-amount"]) {
    els["issued-check-amount"].value = formatMoneyInput(centsToMoney(
      Math.abs(moneyToCents(movement.amount || movement.debit || 0))
    ));
  }
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
