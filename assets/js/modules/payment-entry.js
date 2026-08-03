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
    "comisiones",
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
        total: normalizeMoney(expense.total),
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
  const commissions = rows("comisiones");

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
    commissionsByExpenseId: groupRowsByComparableKey(commissions, "id_egreso"),
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
  const totalDebt = centsToMoney(rows.reduce((totalCents, row) => totalCents + moneyToCents(row.balance), 0));
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

  const totalDebt = centsToMoney(paymentPendingExpenses.reduce(
    (totalCents, row) => totalCents + moneyToCents(row.balance),
    0
  ));
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
    const amount = selected?.amount ?? normalizeMoney(row.balance);
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
          <input class="payment-amount-input" type="text" inputmode="decimal" data-money-input value="${escapeHtml(formatMoneyInput(amount))}" data-payment-amount="${escapeHtml(row.id)}">
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
      amount: centsToMoney(parseMoneyInput(input.value, { allowEmpty: true, allowNegative: false }).cents || 0)
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
      const amount = parseMoneyInput(amountInput?.value || "", { allowEmpty: true, allowNegative: false });
      const amountCents = amount.ok ? amount.cents : 0;
      const balanceCents = expense ? moneyToCents(expense.balance) : 0;
      return expense && amountCents > 0
        ? { expense, amount: centsToMoney(Math.min(amountCents, balanceCents)) }
        : null;
    })
    .filter(Boolean);
}

function updatePaymentSelectedTotal() {
  if (!els["payment-selected-total"]) return;
  const totalCents = selectedPaymentRows().reduce((sum, row) => sum + moneyToCents(row.amount), 0);
  els["payment-selected-total"].textContent = paymentMoneyLabel(centsToMoney(totalCents));

  const comparison = els["payment-movement-comparison"];
  if (!comparison) return;
  const movementAmountCents = moneyToCents(paymentBankMovementAmount());
  comparison.classList.remove("is-balanced", "is-pending");
  if (!movementAmountCents) {
    comparison.textContent = "";
    return;
  }

  const differenceCents = movementAmountCents - totalCents;
  if (differenceCents === 0) {
    comparison.textContent = "El pago coincide con el movimiento.";
    comparison.classList.add("is-balanced");
    return;
  }

  comparison.textContent = `Diferencia: ${paymentMoneyLabel(centsToMoney(Math.abs(differenceCents)))} ${differenceCents > 0 ? "sin asignar" : "por corregir"}.`;
  comparison.classList.add("is-pending");
}

function paymentBankMovementAmount() {
  const amount = entryMoneyState("payment-bank-amount", { allowNegative: false });
  return amount.ok && amount.cents > 0 ? amount.amount : 0;
}

function applyBankPaymentDraft() {
  if (!bankPaymentDraft) return;
  const draft = bankPaymentDraft;
  const creditor = paymentPendingExpenses.find((row) => String(row.creditorId || "") === String(draft.creditorId || ""))?.creditor || "";

  if (els["payment-date"] && draft.date) els["payment-date"].value = draft.date;
  if (els["payment-bank"] && draft.bank) els["payment-bank"].value = draft.bank;
  if (els["payment-method"] && draft.method) els["payment-method"].value = draft.method;
  if (els["payment-bank-amount"]) els["payment-bank-amount"].value = formatMoneyInput(normalizeMoney(draft.amount));
  if (els["payment-creditor-filter"] && creditor) els["payment-creditor-filter"].value = creditor;

  bankPaymentDraft = null;
}

function paymentMoneyLabel(value) {
  return formatMoney(value);
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

  const total = centsToMoney(selectedRows.reduce((sum, row) => sum + moneyToCents(row.amount), 0));
  const button = els["payment-submit"];
  const originalText = button?.textContent || "Guardar pago";
  if (button) {
    button.disabled = true;
    button.textContent = "Guardando...";
  }
  setEntryStatus("payment-status", "Guardando pago...", "pending");

  try {
    pendingPaymentOperationId ||= newTreasuryOperationId("pago");
    const result = await saveTreasuryOperation("/api/treasury/payments", {
      operationId: pendingPaymentOperationId,
      payment: { fecha: paymentDate, metodo: method, banco: bank },
      details: selectedRows.map((row) => ({ idEgreso: row.expense.id, monto: row.amount }))
    });
    const paymentId = result.paymentId;
    pendingPaymentOperationId = "";

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
      total: centsToMoney(groupRows.reduce((totalCents, row) => totalCents + moneyToCents(row.balance), 0)),
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
  if (els["issued-check-amount"]) els["issued-check-amount"].value = formatMoneyInput(normalizeMoney(option.amount));
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
let pendingPaymentOperationId = "";
