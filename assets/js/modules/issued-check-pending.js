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
      const amountFromDetailsCents = details.reduce(
        (total, detail) => total + moneyToCents(detail.monto_cancelado),
        0
      );
      const paymentAmountCents = moneyToCents(payment.monto || 0);
      const amount = centsToMoney(paymentAmountCents || amountFromDetailsCents);
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
    const paidCents = moneyToCents(paymentDetail.monto_cancelado);
    paidByExpense.set(expenseId, centsToMoney(moneyToCents(paidByExpense.get(expenseId) || 0) + paidCents));
    return paidByExpense;
  }, new Map());
}

function openExpenseAmount(expense, paidByExpenseId) {
  const invoiceType = normalizeCategory(expense.tipo_factura);
  if (!isFinancialInvoiceTypeVisible(invoiceType)) return 0;

  const expenseId = String(expense.id_egreso ?? "").trim();
  const totalCents = moneyToCents(expense.total);
  const paidCents = moneyToCents(paidByExpenseId.get(expenseId) || 0);
  const calculatedOpenCents = totalCents - paidCents;
  const explicitBalanceCents = moneyToCents(expense.saldo || 0);
  const openCents = Math.abs(explicitBalanceCents) > 1 ? explicitBalanceCents : calculatedOpenCents;
  return openCents > 1000 ? centsToMoney(openCents) : 0;
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

    const linkedCommissions = lookups.commissionsByExpenseId?.get(comparableLookupId(expenseId)) || [];
    if (linkedCommissions.length) {
      const commissionCreditorIds = linkedCommissions.map((commission) => {
        const creditorTag = lookups.creditorTagsById
          ?.get(comparableLookupId(commission.id_acreedor_etiqueta));
        const creditorId = comparableLookupId(creditorTag?.id_acreedor);
        return creditorId && lookups.creditors.has(creditorId) ? creditorId : "";
      });
      const uniqueCreditorIds = new Set(commissionCreditorIds);
      if (!commissionCreditorIds.includes("") && uniqueCreditorIds.size === 1) {
        return commissionCreditorIds[0];
      }
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
