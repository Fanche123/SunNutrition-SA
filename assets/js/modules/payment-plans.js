(function exposePaymentPlansModule(global) {
  const state = {
    plans: [],
    expenses: [],
    selected: null,
    draft: null,
    mode: "view",
    quotaEditor: null,
    confirmRemoveIndex: null,
    previousSelectedId: "",
    saveErrorQuotaIndex: null,
    saveErrorMessage: "",
    bound: false,
    loading: false
  };

  const quotaMoneyFields = new Set([
    "capital",
    "interes_financiero",
    "interes_resarcitorio",
    "total_primer_vencimiento",
    "total_segundo_vencimiento"
  ]);

  async function renderPaymentPlans() {
    const elements = getElements();
    if (!elements.summary || !elements.list) return;
    bindEvents(elements);
    setLoading(elements, true);
    try {
      const payload = await request("/api/treasury/payment-plans");
      state.plans = payload.plans || [];
      state.expenses = payload.expenses || [];
      renderSummary(elements);
      renderList(elements);
      const selectedPlan = state.plans.find((plan) => (
        String(plan.id_plan_pago) === String(state.selected?.id_plan_pago)
      )) || state.plans[0];
      if (selectedPlan) {
        setLoading(elements, false);
        await openPlan(selectedPlan.id_plan_pago, elements);
      } else {
        resetSelection();
        renderDetail(elements);
      }
    } catch (error) {
      elements.list.innerHTML = `<div class="empty-state is-error">${escapeHtml(error.message)}</div>`;
      setStatus(elements, error.message, "error");
    } finally {
      setLoading(elements, false);
    }
  }

  function hasUnsavedChanges() {
    return ["edit", "create"].includes(state.mode) && Boolean(state.draft);
  }

  function bindEvents(elements) {
    if (state.bound) return;
    state.bound = true;
    elements.newButton?.addEventListener("click", () => startNew(elements));
    elements.editButton?.addEventListener("click", () => startEdit(elements));
    elements.cancelButton?.addEventListener("click", () => cancelPlanEditing(elements));
    elements.addQuotaButton?.addEventListener("click", () => openQuotaEditor(null, elements));
    elements.form?.addEventListener("submit", (event) => savePlan(event, elements));
    elements.list?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-payment-plan-open]");
      if (button) openPlan(button.dataset.paymentPlanOpen, elements);
    });
    elements.empty?.addEventListener("click", (event) => {
      if (event.target.closest("[data-payment-plan-create]")) startNew(elements);
    });
    elements.editQuotas?.addEventListener("click", (event) => {
      if (event.target.closest("[data-quota-apply-inline]")) {
        applyQuotaEditor(elements);
        return;
      }
      if (event.target.closest("[data-quota-cancel-inline]")) {
        closeQuotaEditor(elements);
        return;
      }
      const editButton = event.target.closest("[data-quota-edit]");
      if (editButton) {
        openQuotaEditor(Number(editButton.dataset.quotaEdit), elements);
        return;
      }
      const removeButton = event.target.closest("[data-quota-remove]");
      if (removeButton) requestQuotaRemoval(Number(removeButton.dataset.quotaRemove), elements);
      const confirmButton = event.target.closest("[data-quota-remove-confirm]");
      if (confirmButton) confirmQuotaRemoval(Number(confirmButton.dataset.quotaRemoveConfirm), elements);
      if (event.target.closest("[data-quota-remove-cancel]")) {
        state.confirmRemoveIndex = null;
        renderEditQuotas(elements);
      }
    });
    elements.editQuotas?.addEventListener("input", () => updateQuotaEditorTotals(elements));
    elements.quotaEditorFields?.addEventListener("input", () => updateQuotaEditorTotals(elements));
    elements.quotaApplyButton?.addEventListener("click", () => applyQuotaEditor(elements));
    elements.quotaCancelButton?.addEventListener("click", () => closeQuotaEditor(elements));
    global.addEventListener("beforeunload", (event) => {
      if (!hasUnsavedChanges()) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  async function openPlan(planId, elements) {
    if (state.loading) return;
    setLoading(elements, true);
    try {
      const payload = await request(`/api/treasury/payment-plans/${encodeURIComponent(planId)}`);
      state.selected = payload.plan;
      state.expenses = payload.expenses || state.expenses;
      state.draft = null;
      state.mode = "view";
      state.quotaEditor = null;
      state.confirmRemoveIndex = null;
      renderList(elements);
      renderDetail(elements);
      setStatus(elements, "", "");
    } catch (error) {
      setStatus(elements, error.message, "error");
    } finally {
      setLoading(elements, false);
    }
  }

  function startEdit(elements) {
    if (!state.selected) return;
    state.mode = "edit";
    state.draft = clone(state.selected);
    state.quotaEditor = null;
    state.confirmRemoveIndex = null;
    state.saveErrorQuotaIndex = null;
    state.saveErrorMessage = "";
    renderDetail(elements);
    elements.name?.focus();
  }

  function startNew(elements) {
    state.previousSelectedId = state.selected?.id_plan_pago || state.plans[0]?.id_plan_pago || "";
    state.mode = "create";
    state.draft = {
      id_plan_pago: "",
      nombre: "",
      organismo: "",
      cuotas: [],
      totales: emptyTotals()
    };
    state.quotaEditor = null;
    state.confirmRemoveIndex = null;
    state.saveErrorQuotaIndex = null;
    state.saveErrorMessage = "";
    renderList(elements);
    renderDetail(elements);
    elements.name?.focus();
  }

  async function cancelPlanEditing(elements) {
    const returnPlanId = state.mode === "create"
      ? state.previousSelectedId
      : state.selected?.id_plan_pago;
    state.quotaEditor = null;
    state.confirmRemoveIndex = null;
    if (returnPlanId) {
      state.mode = "view";
      state.draft = null;
      await openPlan(returnPlanId, elements);
      setStatus(elements, "Cambios cancelados.", "success");
      return;
    }
    resetSelection();
    renderList(elements);
    renderDetail(elements);
  }

  function openQuotaEditor(index, elements) {
    if (!state.draft || !["edit", "create"].includes(state.mode)) return;
    const isNew = index === null;
    const nextNumber = state.draft.cuotas.reduce(
      (highest, quota) => Math.max(highest, Number(quota.nro_cuota) || 0),
      0
    ) + 1;
    const today = new Date().toISOString().slice(0, 10);
    state.quotaEditor = {
      index,
      isNew,
      quota: isNew ? {
        nro_cuota: nextNumber,
        capital: 0,
        interes_financiero: 0,
        interes_resarcitorio: 0,
        total_primer_vencimiento: 0,
        fecha_primer_vencimiento: today,
        total_segundo_vencimiento: 0,
        fecha_segundo_vencimiento: today,
        id_egreso: "",
        estado: "Pendiente",
        eliminable: true
      } : clone(state.draft.cuotas[index])
    };
    state.confirmRemoveIndex = null;
    state.saveErrorQuotaIndex = null;
    state.saveErrorMessage = "";
    renderEditQuotas(elements);
    renderQuotaEditor(elements);
    elements.editQuotas?.querySelector("[data-quota-editor-field]")?.focus();
  }

  function closeQuotaEditor(elements) {
    state.quotaEditor = null;
    renderEditQuotas(elements);
    renderQuotaEditor(elements);
    setQuotaStatus(elements, "", "");
  }

  function applyQuotaEditor(elements, options = {}) {
    if (!state.quotaEditor || !state.draft) return false;
    const inputs = [...elements.editQuotas.querySelectorAll("[data-quota-editor-field]")];
    inputs.forEach((input) => {
      if (!quotaMoneyFields.has(input.dataset.quotaEditorField) || input.readOnly) return;
      const parsed = parseMoneyInput(input.value, { allowEmpty: false, allowNegative: false });
      input.setCustomValidity(
        parsed.ok && !parsed.empty
          ? ""
          : "Ingresá un importe válido con hasta dos decimales."
      );
    });
    if (!inputs.every((input) => input.reportValidity())) {
      setQuotaStatus(elements, "Revisá los campos obligatorios de la cuota.", "error");
      return false;
    }
    const quota = state.quotaEditor.quota;
    inputs.forEach((input) => {
      const field = input.dataset.quotaEditorField;
      if (field === "id_egreso") {
        quota[field] = input.value.trim();
      } else if (quotaMoneyFields.has(field)) {
        quota[field] = centsToMoney(parseMoneyInput(input.value, {
          allowEmpty: false,
          allowNegative: false
        }).cents);
      } else {
        quota[field] = input.type === "number" ? asNumber(input.value) : input.value;
      }
    });
    recalculateQuota(quota);
    if (state.quotaEditor.isNew) state.draft.cuotas.push(quota);
    else state.draft.cuotas[state.quotaEditor.index] = quota;
    state.quotaEditor = null;
    state.saveErrorQuotaIndex = null;
    state.saveErrorMessage = "";
    renderEditQuotas(elements);
    renderQuotaEditor(elements);
    renderEditSummary(elements);
    if (!options.forSave) {
      setStatus(elements, "Cuota aplicada al borrador. Guardá el plan para persistir los cambios.", "success");
    }
    return true;
  }

  function updateQuotaEditorTotals(elements) {
    if (!state.quotaEditor) return;
    const getValue = (field) => (
      elements.editQuotas.querySelector(`[data-quota-editor-field="${field}"]`)?.value
    );
    ["capital", "interes_financiero", "interes_resarcitorio"].forEach((field) => {
      const parsed = parseMoneyInput(getValue(field) || "", { allowEmpty: true, allowNegative: false });
      state.quotaEditor.quota[field] = parsed.ok ? parsed.amount : 0;
    });
    recalculateQuota(state.quotaEditor.quota);
    const firstTotal = elements.editQuotas.querySelector('[data-quota-editor-field="total_primer_vencimiento"]');
    const secondTotal = elements.editQuotas.querySelector('[data-quota-editor-field="total_segundo_vencimiento"]');
    if (firstTotal) firstTotal.value = formatMoneyInput(state.quotaEditor.quota.total_primer_vencimiento);
    if (secondTotal) secondTotal.value = formatMoneyInput(state.quotaEditor.quota.total_segundo_vencimiento);
  }

  function requestQuotaRemoval(index, elements) {
    const quota = state.draft?.cuotas?.[index];
    if (!quota) return;
    if (quota.id_egreso || quota.eliminable === false) {
      setStatus(elements, `La cuota ${quota.nro_cuota} está vinculada a un egreso y no puede quitarse.`, "error");
      return;
    }
    state.confirmRemoveIndex = index;
    state.quotaEditor = null;
    renderEditQuotas(elements);
    renderQuotaEditor(elements);
  }

  function confirmQuotaRemoval(index, elements) {
    const quota = state.draft?.cuotas?.[index];
    if (!quota || quota.id_egreso || quota.eliminable === false) return;
    state.draft.cuotas.splice(index, 1);
    state.confirmRemoveIndex = null;
    renderEditQuotas(elements);
    renderEditSummary(elements);
    setStatus(elements, `Cuota ${quota.nro_cuota} quitada del borrador. Guardá para confirmar.`, "success");
  }

  async function savePlan(event, elements) {
    event.preventDefault();
    if (!state.draft || state.loading) return;
    if (state.quotaEditor && !applyQuotaEditor(elements, { forSave: true })) return;
    if (!elements.form.reportValidity()) return;
    state.draft.nombre = elements.name.value.trim();
    state.draft.organismo = elements.agency.value.trim();
    const body = {
      operationId: newOperationId(),
      plan: {
        ...(state.draft.id_plan_pago ? { id_plan_pago: state.draft.id_plan_pago } : {}),
        nombre: state.draft.nombre,
        organismo: state.draft.organismo
      },
      quotas: state.draft.cuotas.map(quotaPayload)
    };
    const path = state.mode === "create"
      ? "/api/treasury/payment-plans"
      : `/api/treasury/payment-plans/${encodeURIComponent(state.draft.id_plan_pago)}`;
    setLoading(elements, true);
    setStatus(elements, "Guardando cambios…", "");
    try {
      const payload = await request(path, { method: "POST", body: JSON.stringify(body) });
      const savedPlanId = payload.plan?.id_plan_pago;
      if (!savedPlanId) throw new Error("El backend no confirmó la clave del plan guardado.");
      const detailPayload = await request(`/api/treasury/payment-plans/${encodeURIComponent(savedPlanId)}`);
      await refreshList(elements);
      state.selected = detailPayload.plan;
      state.expenses = detailPayload.expenses || state.expenses;
      state.mode = "view";
      state.draft = null;
      state.quotaEditor = null;
      state.saveErrorQuotaIndex = null;
      state.saveErrorMessage = "";
      setStatus(elements, "Plan guardado y verificado correctamente.", "success");
      renderList(elements);
      renderDetail(elements);
    } catch (error) {
      const affectedIndex = findQuotaIndexForError(error.message);
      state.saveErrorQuotaIndex = affectedIndex;
      state.saveErrorMessage = affectedIndex === null ? "" : error.message;
      renderEditQuotas(elements);
      setStatus(elements, error.message, "error");
    } finally {
      setLoading(elements, false);
    }
  }

  async function refreshList(elements) {
    const payload = await request("/api/treasury/payment-plans");
    state.plans = payload.plans || [];
    state.expenses = payload.expenses || state.expenses;
    renderSummary(elements);
  }

  function renderSummary(elements) {
    const totals = state.plans.reduce((result, plan) => {
      result.quotas += Number(plan.cantidad_cuotas) || 0;
      result.overdue += Number(plan.totales?.vencidas) || 0;
      result.upcoming += Number(plan.totales?.proximas) || 0;
      return result;
    }, { quotas: 0, overdue: 0, upcoming: 0 });
    elements.summary.innerHTML = `
      <article class="payment-plan-metric"><span>Planes</span><strong>${state.plans.length}</strong></article>
      <article class="payment-plan-metric"><span>Cuotas registradas</span><strong>${totals.quotas}</strong></article>
      <article class="payment-plan-metric"><span>Vencidas</span><strong>${totals.overdue}</strong></article>
      <article class="payment-plan-metric"><span>Próximas</span><strong>${totals.upcoming}</strong></article>
    `;
  }

  function renderList(elements) {
    if (!state.plans.length) {
      elements.list.innerHTML = '<div class="empty-state">No hay planes de pago guardados.</div>';
      return;
    }
    elements.list.innerHTML = state.plans.map((plan) => {
      const isSelected = state.mode !== "create"
        && String(state.selected?.id_plan_pago) === String(plan.id_plan_pago);
      const paid = Number(plan.totales?.pagadas) || 0;
      const pending = Math.max(0, (Number(plan.cantidad_cuotas) || 0) - paid);
      return `
        <button class="payment-plan-list-item ${isSelected ? "is-active" : ""}"
          type="button"
          data-payment-plan-open="${escapeHtml(plan.id_plan_pago)}"
          aria-pressed="${isSelected}">
          <span class="payment-plan-list-header">
            <strong>${escapeHtml(plan.nombre)}</strong>
            <small>${escapeHtml(plan.organismo)} · ${plan.cantidad_cuotas} cuotas</small>
          </span>
          <span class="payment-plan-list-total">
            <small>Total del plan</small><strong>${formatMoney(plan.totales.total_general)}</strong>
          </span>
          <span class="payment-plan-list-statuses">
            <span>Canceladas <strong>${paid}</strong></span>
            <span>Pendientes <strong>${pending}</strong></span>
            <span>Vencidas <strong>${plan.totales.vencidas}</strong></span>
            <span>Próximas <strong>${plan.totales.proximas}</strong></span>
          </span>
        </button>
      `;
    }).join("");
  }

  function renderDetail(elements) {
    const editing = ["edit", "create"].includes(state.mode) && Boolean(state.draft);
    const viewing = state.mode === "view" && Boolean(state.selected);
    elements.view.hidden = !viewing;
    elements.form.hidden = !editing;
    elements.empty.hidden = viewing || editing;
    elements.editButton.hidden = !viewing;

    if (!viewing && !editing) {
      elements.detailTitle.textContent = "Detalle del plan";
      elements.help.textContent = "Todavía no hay planes de pago guardados.";
      elements.detailMeta.innerHTML = "";
      elements.empty.innerHTML = '<div><p>Creá el primer plan para comenzar a administrar sus cuotas.</p><button class="primary-button" type="button" data-payment-plan-create>Crear primer plan</button></div>';
      return;
    }

    const plan = editing ? state.draft : state.selected;
    elements.detailTitle.textContent = state.mode === "create" ? "Nuevo plan" : (plan.nombre || "Plan sin nombre");
    elements.help.textContent = state.mode === "view"
      ? `${plan.organismo || "Sin organismo"} · Modo consulta`
      : `${state.mode === "create" ? "Creación guiada" : "Modo edición"} · Los cambios se guardan juntos.`;
    elements.detailMeta.innerHTML = detailMeta(plan, state.mode);

    if (viewing) {
      renderFinancialSummary(elements, plan);
      renderViewQuotas(elements, plan.cuotas || []);
      return;
    }

    elements.name.value = state.draft.nombre || "";
    elements.agency.value = state.draft.organismo || "";
    renderEditSummary(elements);
    renderEditQuotas(elements);
    renderQuotaEditor(elements);
  }

  function renderFinancialSummary(elements, plan) {
    const totals = calculateFinancialTotals(plan);
    elements.financialSummary.innerHTML = [
      financialMetric("Total del plan", totals.total),
      financialMetric("Cancelado", totals.paid),
      financialMetric("Saldo pendiente", totals.pending)
    ].join("");
  }

  function renderViewQuotas(elements, quotas) {
    if (!quotas.length) {
      elements.viewQuotas.innerHTML = '<div class="empty-state">Este plan todavía no tiene cuotas.</div>';
      return;
    }
    elements.viewQuotas.innerHTML = quotaTable(quotas);
  }

  function renderEditSummary(elements) {
    const totals = calculateFinancialTotals({ cuotas: state.draft?.cuotas || [] });
    elements.totals.innerHTML = `
      <span><small>Total del plan</small><strong>${formatMoney(totals.total)}</strong></span>
      <span><small>Cancelado</small><strong>${formatMoney(totals.paid)}</strong></span>
      <span><small>Saldo pendiente</small><strong>${formatMoney(totals.pending)}</strong></span>
    `;
  }

  function renderEditQuotas(elements) {
    const quotas = state.draft?.cuotas || [];
    if (!quotas.length && !state.quotaEditor) {
      elements.editQuotas.innerHTML = '<div class="empty-state">No hay cuotas en el borrador. Usá “Agregar cuota” para comenzar.</div>';
      return;
    }
    elements.editQuotas.innerHTML = quotaTable(quotas, { editing: true });
  }

  function renderQuotaEditor(elements) {
    elements.quotaEditor.hidden = true;
    elements.quotaEditorFields.innerHTML = "";
    setQuotaStatus(elements, "", "");
  }

  function quotaTable(quotas, options = {}) {
    const editing = Boolean(options.editing);
    const rows = quotas.map((quota, index) => (
      editing && state.quotaEditor?.index === index
        ? editableQuotaRow(state.quotaEditor.quota)
        : quotaRow(quota, index, editing)
    ));
    if (editing && state.quotaEditor?.isNew) rows.push(editableQuotaRow(state.quotaEditor.quota));
    const totals = calculateFinancialTotals({ cuotas: quotas });
    const secondTotal = centsToMoney(quotas.reduce(
      (sum, quota) => sum + moneyToCents(quota.total_segundo_vencimiento),
      0
    ));
    return `
      <div class="payment-plan-quota-table-wrap" tabindex="0" aria-label="Cuotas del plan">
        <table class="payment-plan-quota-table ${editing ? "is-editing" : ""}">
          <thead>
            <tr>
              <th scope="col">Cuota</th>
              <th scope="col">Estado</th>
              <th scope="col">1.er vencimiento</th>
              <th scope="col">ID egreso</th>
              <th scope="col">Capital</th>
              <th scope="col">Interés financiero</th>
              <th scope="col">Interés resarcitorio</th>
              <th scope="col">1.er total</th>
              <th scope="col">2.º total</th>
              <th scope="col">2.º vencimiento</th>
              ${editing ? '<th scope="col">Acciones</th>' : ""}
            </tr>
          </thead>
          <tbody>${rows.join("")}</tbody>
          <tfoot>
            <tr>
              <th scope="row" colspan="4">Totales</th>
              <td>${formatMoney(totals.capital)}</td>
              <td>${formatMoney(totals.financial)}</td>
              <td>${formatMoney(totals.late)}</td>
              <td>${formatMoney(totals.total)}</td>
              <td>${formatMoney(secondTotal)}</td>
              <td>—</td>
              ${editing ? "<td>—</td>" : ""}
            </tr>
          </tfoot>
        </table>
      </div>
    `;
  }

  function quotaRow(quota, index, editing) {
    const locked = Boolean(quota.id_egreso || quota.eliminable === false);
    const confirming = state.confirmRemoveIndex === index;
    return `
      <tr>
        <th scope="row">${escapeHtml(quota.nro_cuota)}</th>
        <td><span class="payment-plan-status ${statusClass(quota.estado)}">${escapeHtml(quota.estado || "Pendiente")}</span></td>
        <td><strong>${formatMoney(quota.total_primer_vencimiento)}</strong><small>${formatDate(quota.fecha_primer_vencimiento)}</small></td>
        <td>${quota.id_egreso ? `<strong>${escapeHtml(quota.id_egreso)}</strong>` : '<span class="is-muted">Sin vínculo</span>'}</td>
        <td>${formatMoney(quota.capital)}</td>
        <td>${formatMoney(quota.interes_financiero)}</td>
        <td>${formatMoney(quota.interes_resarcitorio)}</td>
        <td>${formatMoney(quota.total_primer_vencimiento)}</td>
        <td>${formatMoney(quota.total_segundo_vencimiento)}</td>
        <td>${formatDate(quota.fecha_segundo_vencimiento)}</td>
        ${editing ? `
          <td class="payment-plan-quota-actions">
            <button class="text-button" type="button" data-quota-edit="${index}">Editar</button>
            <button class="text-button is-danger" type="button" data-quota-remove="${index}"
              ${locked ? 'disabled title="No puede quitarse porque tiene un egreso vinculado" aria-label="Quitar cuota: no disponible por egreso vinculado"' : ""}>Quitar</button>
          </td>
        ` : ""}
      </tr>
      ${editing && state.saveErrorQuotaIndex === index ? `
        <tr class="payment-plan-quota-field-error">
          <td colspan="11">${escapeHtml(state.saveErrorMessage)}</td>
        </tr>
      ` : ""}
      ${confirming ? `
        <tr class="payment-plan-remove-confirmation">
          <td colspan="${editing ? 11 : 10}">
            <span>¿Quitar la cuota ${escapeHtml(quota.nro_cuota)} del borrador?</span>
            <button class="text-button" type="button" data-quota-remove-cancel>Cancelar</button>
            <button class="text-button is-danger" type="button" data-quota-remove-confirm="${index}">Confirmar</button>
          </td>
        </tr>
      ` : ""}
    `;
  }

  function editableQuotaRow(quota) {
    return `
      <tr class="payment-plan-quota-edit-row">
        <td>${compactEditorInput("Cuota", "nro_cuota", quota.nro_cuota, "number", { min: 1, step: 1 })}</td>
        <td><span class="payment-plan-status ${statusClass(quota.estado)}">${escapeHtml(quota.estado || "Pendiente")}</span></td>
        <td>${compactEditorInput("Fecha del primer vencimiento", "fecha_primer_vencimiento", quota.fecha_primer_vencimiento, "date")}</td>
        <td>${expenseIdInput(quota)}</td>
        <td>${compactEditorInput("Capital", "capital", quota.capital, "money")}</td>
        <td>${compactEditorInput("Interés financiero", "interes_financiero", quota.interes_financiero, "money")}</td>
        <td>${compactEditorInput("Interés resarcitorio", "interes_resarcitorio", quota.interes_resarcitorio, "money")}</td>
        <td>${compactEditorInput("Primer total calculado", "total_primer_vencimiento", quota.total_primer_vencimiento, "money", { readonly: true })}</td>
        <td>${compactEditorInput("Segundo total calculado", "total_segundo_vencimiento", quota.total_segundo_vencimiento, "money", { readonly: true })}</td>
        <td>${compactEditorInput("Fecha del segundo vencimiento", "fecha_segundo_vencimiento", quota.fecha_segundo_vencimiento, "date")}</td>
        <td class="payment-plan-quota-actions">
          <button class="text-button" type="button" data-quota-apply-inline>Aplicar</button>
          <button class="text-button" type="button" data-quota-cancel-inline>Cancelar</button>
        </td>
      </tr>
    `;
  }

  function compactEditorInput(label, field, value, type, options = {}) {
    const isMoney = type === "money";
    const inputValue = isMoney ? formatMoneyInput(value) : value;
    return `
      <label class="visually-hidden" for="payment-plan-quota-${field}">${label}</label>
      <input class="payment-plan-quota-input" id="payment-plan-quota-${field}" type="${isMoney ? "text" : type}"
        ${isMoney ? 'inputmode="decimal" data-money-input' : ""}
        value="${escapeHtml(inputValue)}" data-quota-editor-field="${field}"
        aria-describedby="payment-plan-quota-status"
        ${options.min !== undefined ? `min="${options.min}"` : ""}
        ${options.step !== undefined ? `step="${options.step}"` : ""}
        ${options.readonly ? "readonly" : ""}
        required>
    `;
  }

  function expenseIdInput(quota) {
    return `
      <label class="visually-hidden" for="payment-plan-quota-id_egreso">ID egreso</label>
      <input class="payment-plan-expense-id-input" id="payment-plan-quota-id_egreso"
        type="number" inputmode="numeric" min="1" step="1"
        value="${escapeHtml(quota.id_egreso || "")}" data-quota-editor-field="id_egreso"
        aria-describedby="payment-plan-quota-status">
    `;
  }

  function findQuotaIndexForError(message) {
    const quotaNumber = String(message || "").match(/cuota\s+(\d+)/i)?.[1];
    if (quotaNumber) {
      const index = state.draft?.cuotas?.findIndex((quota) => String(quota.nro_cuota) === quotaNumber);
      if (index >= 0) return index;
    }
    const expenseId = String(message || "").match(/egreso\s+(\d+)/i)?.[1];
    if (expenseId) {
      const index = state.draft?.cuotas?.findIndex((quota) => String(quota.id_egreso) === expenseId);
      if (index >= 0) return index;
    }
    return null;
  }

  function calculateFinancialTotals(plan) {
    const totals = (plan.cuotas || []).reduce((result, quota) => {
      result.capital += moneyToCents(quota.capital);
      result.financial += moneyToCents(quota.interes_financiero);
      result.late += moneyToCents(quota.interes_resarcitorio);
      result.total += moneyToCents(quota.total_primer_vencimiento);
      const quotaTotal = Math.abs(moneyToCents(quota.total_primer_vencimiento));
      result.paid += Math.min(quotaTotal, Math.abs(moneyToCents(quota.monto_pagado || 0)));
      return result;
    }, { capital: 0, financial: 0, late: 0, total: 0, paid: 0, pending: 0 });
    totals.pending = Math.max(0, totals.total - totals.paid);
    return Object.fromEntries(
      Object.entries(totals).map(([key, cents]) => [key, centsToMoney(cents)])
    );
  }

  function detailMeta(plan, mode) {
    const quotas = plan.cuotas || [];
    const paid = quotas.filter((quota) => quota.estado === "Pagada").length;
    const overdue = quotas.filter((quota) => quota.estado === "Vencida").length;
    const upcoming = quotas.filter((quota) => quota.estado === "Próxima").length;
    let status = "En curso";
    if (quotas.length && paid === quotas.length) status = "Cancelado";
    else if (overdue) status = "Con cuotas vencidas";
    else if (upcoming) status = "Próximos vencimientos";
    if (mode === "create") status = "Nuevo";
    return `
      <span>${quotas.length} cuotas</span>
      <span class="payment-plan-general-status">${status}</span>
    `;
  }

  function financialMetric(label, value) {
    return `<article><small>${label}</small><strong>${formatMoney(value)}</strong></article>`;
  }

  function recalculateQuota(quota) {
    const capitalCents = moneyToCents(quota.capital);
    const financialInterestCents = moneyToCents(quota.interes_financiero);
    const firstTotalCents = capitalCents + financialInterestCents;
    quota.total_primer_vencimiento = centsToMoney(firstTotalCents);
    quota.total_segundo_vencimiento = centsToMoney(
      firstTotalCents + moneyToCents(quota.interes_resarcitorio)
    );
  }

  function quotaPayload(quota) {
    return {
      ...(quota.id_cuota_plan_pago ? { id_cuota_plan_pago: quota.id_cuota_plan_pago } : {}),
      nro_cuota: Number(quota.nro_cuota),
      capital: centsToMoney(moneyToCents(quota.capital)),
      interes_financiero: centsToMoney(moneyToCents(quota.interes_financiero)),
      interes_resarcitorio: centsToMoney(moneyToCents(quota.interes_resarcitorio)),
      total_primer_vencimiento: centsToMoney(moneyToCents(quota.total_primer_vencimiento)),
      fecha_primer_vencimiento: quota.fecha_primer_vencimiento,
      total_segundo_vencimiento: centsToMoney(moneyToCents(quota.total_segundo_vencimiento)),
      fecha_segundo_vencimiento: quota.fecha_segundo_vencimiento,
      id_egreso: String(quota.id_egreso || "")
    };
  }

  function request(path, options = {}) {
    return requestBackendApi(path, options);
  }

  function getElements() {
    return {
      summary: document.getElementById("payment-plans-summary"),
      list: document.getElementById("payment-plans-list"),
      newButton: document.getElementById("payment-plan-new"),
      editButton: document.getElementById("payment-plan-edit"),
      view: document.getElementById("payment-plan-view"),
      financialSummary: document.getElementById("payment-plan-financial-summary"),
      viewQuotas: document.getElementById("payment-plan-quota-list"),
      form: document.getElementById("payment-plan-form"),
      name: document.getElementById("payment-plan-name"),
      agency: document.getElementById("payment-plan-agency"),
      detailTitle: document.getElementById("payment-plan-detail-title"),
      help: document.getElementById("payment-plan-detail-help"),
      detailMeta: document.getElementById("payment-plan-detail-meta"),
      addQuotaButton: document.getElementById("payment-plan-add-quota"),
      cancelButton: document.getElementById("payment-plan-cancel"),
      saveButton: document.getElementById("payment-plan-save"),
      status: document.getElementById("payment-plan-status"),
      editQuotas: document.getElementById("payment-plan-quotas"),
      totals: document.getElementById("payment-plan-totals"),
      quotaEditor: document.getElementById("payment-plan-quota-editor"),
      quotaEditorTitle: document.getElementById("payment-plan-quota-editor-title"),
      quotaEditorFields: document.getElementById("payment-plan-quota-editor-fields"),
      quotaApplyButton: document.getElementById("payment-plan-quota-apply"),
      quotaCancelButton: document.getElementById("payment-plan-quota-cancel"),
      quotaStatus: document.getElementById("payment-plan-quota-status"),
      empty: document.getElementById("payment-plan-empty")
    };
  }

  function setLoading(elements, loading) {
    state.loading = loading;
    [
      elements.newButton,
      elements.editButton,
      elements.addQuotaButton,
      elements.cancelButton,
      elements.saveButton,
      elements.quotaApplyButton,
      elements.quotaCancelButton
    ].filter(Boolean).forEach((button) => { button.disabled = loading; });
  }

  function setStatus(elements, message, type) {
    if (!elements.status) return;
    elements.status.textContent = message;
    elements.status.className = `form-status${type ? ` is-${type}` : ""}`;
  }

  function setQuotaStatus(elements, message, type) {
    if (!elements.quotaStatus) return;
    elements.quotaStatus.textContent = message;
    elements.quotaStatus.className = `form-status${type ? ` is-${type}` : ""}`;
  }

  function resetSelection() {
    state.selected = null;
    state.draft = null;
    state.mode = "view";
    state.quotaEditor = null;
    state.confirmRemoveIndex = null;
  }

  function statusClass(status) {
    if (status === "Pagada") return "is-paid";
    if (status === "Vencida") return "is-overdue";
    if (status === "Próxima") return "is-upcoming";
    return "is-pending";
  }

  function formatDate(value) {
    const text = String(value || "");
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : (text || "Sin fecha");
  }

  function newOperationId() {
    return global.crypto?.randomUUID?.() || `payment-plan-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function emptyTotals() {
    return {
      capital: 0,
      interes_financiero: 0,
      interes_resarcitorio: 0,
      total_general: 0,
      vencidas: 0,
      proximas: 0,
      vinculadas: 0
    };
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function asNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[character]));
  }

  global.PaymentPlansModule = { renderPaymentPlans, hasUnsavedChanges };
})(window);
