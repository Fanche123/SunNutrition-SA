(function () {
  let purchases = [];
  let selectedPurchase = null;
  let showingManaged = false;
  let submitting = false;
  let receptionRequestKey = "";
  let invoiceRequestKey = "";
  const DEFAULT_RECEPTION_EMPLOYEE = "Alcarez_Pablo_Nicolas";
  const $ = (selector, root = document) => root.querySelector(selector);
  const escape = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  const api = async (url, options) => {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  };
  const requestKey = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const fileBase64 = (file) => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] || ""); reader.onerror = reject; reader.readAsDataURL(file); });
  const dateClass = (value) => {
    if (!value) return "";
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const date = new Date(`${value}T00:00:00`); const days = Math.round((date - today) / 86400000);
    return days < 0 ? "is-overdue" : days === 0 ? "is-today" : days === 1 ? "is-tomorrow" : "";
  };
  function status(message, kind = "") { const node = $("#purchase-workflow-status"); if (node) { node.textContent = message; node.dataset.status = kind; } }
  async function load() {
    if (!$("#purchase-workflow-body")) return;
    try { const payload = await api("/api/purchases/workflow"); purchases = showingManaged ? payload.managed : payload.pending; render(); status(""); }
    catch (error) { status(error.message, "error"); }
  }
  function render() {
    const body = $("#purchase-workflow-body");
    if (!purchases.length) { body.innerHTML = `<tr><td colspan="7" class="empty">${showingManaged ? "No hay compras gestionadas." : "No hay compras pendientes."}</td></tr>`; return; }
    body.innerHTML = purchases.map((purchase) => {
      const complete = purchase.receptionState === "complete"; const invoiced = Boolean(purchase.invoice); const ready = complete && invoiced;
      const items = purchase.items.map((item) => `${escape(item.name)} (${item.received}/${item.ordered}${item.supplierUnit ? ` ${escape(item.supplierUnit)}` : ""})`).join("<br>");
      const receptionAction = showingManaged ? `<button class="purchase-workflow-action is-complete" data-workflow-reception="${escape(purchase.purchaseId)}">Ver historial</button>` : `<button class="purchase-workflow-action is-${escape(purchase.receptionState)}" data-workflow-reception="${escape(purchase.purchaseId)}">${complete ? "Completa" : purchase.receptionState === "partial" ? "Parcial" : "Pendiente"}</button>`;
      return `<tr class="${dateClass(purchase.expectedDeliveryDate)}">
        <td>#${escape(purchase.purchaseId)}</td><td>${items || "-"}</td><td>${escape(purchase.provider)}</td><td>${escape(purchase.expectedDeliveryDate || "Sin fecha")}</td>
        <td>${receptionAction}</td>
        <td><button class="purchase-workflow-action ${invoiced ? "is-complete" : "is-pending"}" data-workflow-invoice="${escape(purchase.purchaseId)}">${invoiced ? "Ver egreso" : "Cargar factura"}</button></td>
        <td><button class="purchase-workflow-close ${ready ? "is-ready" : ""}" data-workflow-close="${escape(purchase.purchaseId)}" ${ready && !purchase.closedAt ? "" : "disabled"} title="${ready ? "Cerrar compra" : "Requiere recepción completa, egreso y adjunto"}">✓</button></td></tr>`;
    }).join("");
  }
  function openPurchase(itemId = "") {
    const popup = $("#purchase-workflow-purchase-popup"); popup.showModal(); document.body.classList.add("purchase-workflow-popup-open");
    if (itemId) { const select = $("#purchase-item-name", popup); const option = [...select.options].find((row) => row.value === itemId || row.dataset.itemId === itemId); if (option) { select.value = option.value; select.dispatchEvent(new Event("change", { bubbles: true })); } }
    $("#purchase-item-name", popup)?.focus();
  }
  function closePurchase() { const popup = $("#purchase-workflow-purchase-popup"); if (popup?.open) popup.close(); document.body.classList.remove("purchase-workflow-popup-open"); load(); }
  function activeReceptionEmployees(rows) {
    return rows
      .filter((employee) => String(employee.id_empleado ?? "").trim() && !String(employee.fecha_baja ?? "").trim())
      .map((employee) => ({ id: String(employee.id_empleado).trim(), name: String(employee.nombre_empleado || employee.nombre || "").trim() }))
      .filter((employee) => employee.name)
      .sort((left, right) => left.name.localeCompare(right.name, "es"));
  }
  function plannedReceptionDate(purchase) {
    const value = String(purchase?.expectedDeliveryDate || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value : "";
  }
  async function openReception(purchase) {
    selectedPurchase = purchase; const dialog = $("#purchase-workflow-reception-dialog");
    $("[data-purchase-number]", dialog).textContent = `#${purchase.purchaseId}`;
    $("[data-reception-history]", dialog).textContent = purchase.receptions.length ? `Historial: ${purchase.receptions.map((row) => `${row.date} (${row.items.map((item) => item.quantity).join(", ")})`).join(" · ")}` : "Sin recepciones previas.";
    $("[data-reception-items]", dialog).innerHTML = purchase.items.map((item) => `<label>${escape(item.name)} — pedido ${item.ordered}, acumulado ${item.received}, pendiente ${item.pending}<input type="number" min="0" max="${item.pending}" step="any" name="supply-${escape(item.supplyId)}" ${item.pending ? "" : "disabled"}></label>`).join("");
    purchase.items.forEach((item) => {
      const input = dialog.querySelector(`[name="supply-${item.supplyId}"]`);
      if (!input) return;
      input.value = item.pending;
      const unit = document.createElement("span");
      unit.className = "purchase-workflow-unit";
      unit.textContent = item.supplierUnit || "Sin unidad";
      const quantity = document.createElement("span");
      quantity.className = "purchase-workflow-quantity";
      input.parentElement.insertBefore(quantity, input);
      quantity.appendChild(input);
      input.insertAdjacentElement("afterend", unit);
    });
    const employeeSelect = $("[name=employeeId]", dialog);
    const submitButton = $("button[type=submit]", dialog);
    try {
      const employees = activeReceptionEmployees(await backendTableRowsForEntry("empleados"));
      const defaultEmployee = employees.find((employee) => employee.name === DEFAULT_RECEPTION_EMPLOYEE);
      employeeSelect.innerHTML = `<option value="">Elegir empleado</option>${employees.map((employee) => `<option value="${escape(employee.id)}">${escape(employee.name)}</option>`).join("")}`;
      employeeSelect.value = defaultEmployee?.id || "";
      $("[data-dialog-status]", dialog).textContent = defaultEmployee ? "" : `No se encontró un empleado activo llamado ${DEFAULT_RECEPTION_EMPLOYEE}. Seleccioná un empleado válido.`;
      submitButton.disabled = !employees.length || showingManaged;
    } catch (error) {
      employeeSelect.innerHTML = `<option value="">No se pudieron cargar los empleados</option>`;
      employeeSelect.value = "";
      $("[data-dialog-status]", dialog).textContent = `No se pudieron cargar los empleados: ${error.message}`;
      submitButton.disabled = true;
    }
    dialog.querySelector("[name=receptionDate]").value = plannedReceptionDate(purchase); receptionRequestKey = requestKey();
    dialog.querySelector("[name=receptionDate]").disabled = showingManaged; dialog.querySelector("[name=employeeId]").disabled = showingManaged;
    if (showingManaged) [...dialog.querySelectorAll("[data-reception-items] input")].forEach((input) => { input.disabled = true; });
    $("button[type=submit]", dialog).hidden = showingManaged; dialog.showModal();
  }
  function openInvoice(purchase) {
    if (purchase.invoice) { alert(`Egreso #${purchase.invoice.expenseId}\n${purchase.invoice.type} ${purchase.invoice.number}\nFecha: ${purchase.invoice.date}\nSubtotal: ${purchase.invoice.subtotal}\nIVA: ${purchase.invoice.iva}\nTotal: ${purchase.invoice.total}`); window.open(`/${purchase.invoice.attachmentPath}`, "_blank", "noopener"); return; }
    selectedPurchase = purchase; invoiceRequestKey = requestKey(); const dialog = $("#purchase-workflow-invoice-dialog"); $("[data-purchase-number]", dialog).textContent = `#${purchase.purchaseId}`; dialog.showModal();
  }
  async function submitReception(event) {
    event.preventDefault(); if (submitting) return; submitting = true; const form = event.currentTarget; const button = $("button[type=submit]", form); button.disabled = true;
    try {
      const data = new FormData(form); const entries = selectedPurchase.items.map((item) => ({ supplyId: item.supplyId, quantity: Number(data.get(`supply-${item.supplyId}`)) })).filter((item) => item.quantity > 0);
      await api("/api/purchases/workflow/receptions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purchaseId: selectedPurchase.purchaseId, receptionDate: data.get("receptionDate"), employeeId: data.get("employeeId"), entries, requestKey: receptionRequestKey }) });
      form.closest("dialog").close(); await load();
    } catch (error) { $("[data-dialog-status]", form).textContent = error.message; }
    finally { submitting = false; button.disabled = false; }
  }
  async function submitInvoice(event) {
    event.preventDefault(); if (submitting) return; submitting = true; const form = event.currentTarget; const button = $("button[type=submit]", form); button.disabled = true;
    try {
      const data = new FormData(form); const file = data.get("attachment");
      await api("/api/purchases/workflow/invoice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purchaseId: selectedPurchase.purchaseId, requestKey: invoiceRequestKey, expense: Object.fromEntries(["invoiceType", "invoiceNumber", "invoiceDate", "paymentDate", "subtotal", "iva", "vatRetention", "iibbRetention", "internalTaxes", "total"].map((key) => [key, data.get(key)])), attachment: { fileName: file.name, mimeType: file.type, dataBase64: await fileBase64(file) } }) });
      form.closest("dialog").close(); form.reset(); await load();
    } catch (error) { $("[data-dialog-status]", form).textContent = error.message; }
    finally { submitting = false; button.disabled = false; }
  }
  async function readInvoice() {
    const form = $("#purchase-workflow-invoice-form"); const file = form.elements.attachment.files[0]; if (!file) return;
    try {
      const payload = await api("/api/reception-invoice/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileDataUrl: `data:${file.type};base64,${await fileBase64(file)}`, fileName: file.name, mimeType: file.type }) });
      const invoice = payload.invoice || {};
      const aliases = { invoiceType: ["invoiceType", "tipo_factura"], invoiceNumber: ["invoiceNumber", "nro_factura"], invoiceDate: ["invoiceDate", "fecha_factura"], paymentDate: ["paymentDate", "fecha_prevista_pago"], subtotal: ["subtotal"], iva: ["iva"], vatRetention: ["vatRetention", "per_ret_iva"], iibbRetention: ["iibbRetention", "per_ret_iibb"], internalTaxes: ["internalTaxes", "imp_internos"], total: ["total"] };
      Object.entries(aliases).forEach(([field, keys]) => { const key = keys.find((candidate) => invoice[candidate] != null); if (key && form.elements[field]) form.elements[field].value = invoice[key]; });
    }
    catch (error) { $("[data-dialog-status]", form).textContent = `Lectura no disponible: ${error.message}. Puede completar manualmente.`; }
  }
  async function closeWorkflow(purchase) { if (!confirm(`¿Cerrar la compra #${purchase.purchaseId}?`)) return; try { await api("/api/purchases/workflow/close", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purchaseId: purchase.purchaseId }) }); await load(); } catch (error) { status(error.message, "error"); } }
  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-view=purchase-entry]")) setTimeout(load, 0);
    if (event.target.closest("#purchase-workflow-new")) openPurchase();
    const need = event.target.closest("[data-purchase-need-item]"); if (need) openPurchase(need.dataset.purchaseNeedItem);
    if (event.target.closest("[data-purchase-workflow-close]")) closePurchase();
    const reception = event.target.closest("[data-workflow-reception]"); if (reception) openReception(purchases.find((row) => row.purchaseId === reception.dataset.workflowReception));
    const invoice = event.target.closest("[data-workflow-invoice]"); if (invoice) openInvoice(purchases.find((row) => row.purchaseId === invoice.dataset.workflowInvoice));
    const close = event.target.closest("[data-workflow-close]"); if (close) closeWorkflow(purchases.find((row) => row.purchaseId === close.dataset.workflowClose));
    if (event.target.closest("#purchase-workflow-managed")) { showingManaged = !showingManaged; event.target.textContent = showingManaged ? "Ver pendientes" : "Ver gestionadas"; $("#purchase-workflow-title").textContent = showingManaged ? "Compras gestionadas" : "Compras pendientes de recepción"; $("#purchase-workflow-subtitle").textContent = showingManaged ? "Historial cerrado disponible para consulta." : "Las compras permanecen hasta su cierre manual."; load(); }
    if (event.target.closest("[data-read-invoice]")) readInvoice();
    const dialogClose = event.target.closest("[data-dialog-close]"); if (dialogClose) dialogClose.closest("dialog")?.close();
  });
  $("#purchase-workflow-purchase-popup")?.addEventListener("close", () => { document.body.classList.remove("purchase-workflow-popup-open"); load(); });
  $("#purchase-workflow-reception-form")?.addEventListener("submit", submitReception);
  $("#purchase-workflow-invoice-form")?.addEventListener("submit", submitInvoice);
})();
