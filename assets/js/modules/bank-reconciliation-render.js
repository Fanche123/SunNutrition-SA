function bankReconciliationMovementsByStatus(status) {
  const movements = (bankReconciliationReport?.movements || []).filter((movement) => (
    movement.status === status
    && !bankReconciliationExcludedMovementKeys.has(String(movement.movementKey || ""))
  ));

  const pendingMappedMovements = (bankReconciliationReport?.movements || []).filter((movement) => (
    ["agregar_gasto", "agregar_egreso", "agregar_pago"].includes(movement.status)
    && !bankReconciliationExcludedMovementKeys.has(String(movement.movementKey || ""))
    && movement.providerMatch?.type === "datos_bancarios"
  ));

  // First resolve movements with an explicit bank-detail mapping. Once there are
  // none left, the remaining unmatched movements become available for review.
  return pendingMappedMovements.length
    ? movements.filter((movement) => movement.providerMatch?.type === "datos_bancarios")
    : movements;
}

function collectBankReconciliationReviewRows(status) {
  const bodyByStatus = {
    agregar_gasto: els["bank-expense-stage-body"],
    agregar_egreso: els["bank-egress-stage-body"],
    agregar_pago: els["bank-payment-stage-body"]
  };
  const reviewRows = {};
  bodyByStatus[status]?.querySelectorAll("[data-bank-movement-key]").forEach((row) => {
    const movementKey = row.dataset.bankMovementKey;
    reviewRows[movementKey] = {};
    row.querySelectorAll("[data-bank-review-field]").forEach((input) => {
      reviewRows[movementKey][input.dataset.bankReviewField] = input.value;
    });
  });
  return reviewRows;
}

function renderBankReconciliation() {
  const summary = bankReconciliationReport?.summary || {};
  const reconciliation = bankReconciliationReport?.reconciliation || {};
  if (els["bank-reconciliation-real-balance"]) els["bank-reconciliation-real-balance"].textContent = formatBankMoney(summary.realBalance || 0);
  if (els["bank-reconciliation-reconciled"]) els["bank-reconciliation-reconciled"].textContent = String(reconciliation.reconciledCount || 0);
  if (els["bank-reconciliation-pending"]) els["bank-reconciliation-pending"].textContent = String(summary.totalPendingCount || 0);
  if (els["bank-reconciliation-net-pending"]) els["bank-reconciliation-net-pending"].textContent = formatBankMoney(summary.netPending || 0);
  renderBankReconciliationLatestDate(reconciliation);

  const movements = bankReconciliationReport?.movements || [];
  const visibleMovements = movements
    .map((movement, index) => ({ movement, index }))
    .filter(({ movement }) => movement.status !== "conciliado");
  const readyMovements = movements.filter((movement) => movement.status === "listo");
  if (els["bank-reconciliation-apply"]) els["bank-reconciliation-apply"].disabled = !readyMovements.length;
  renderBankReconciliationStages();
  renderBankCheckDepositReview();
  if (!movements.length) {
    const emptyMessage = bankReconciliationReport
      ? "No hay movimientos bancarios pendientes guardados."
      : "Cargando movimientos bancarios pendientes.";
    if (els["bank-reconciliation-body"]) els["bank-reconciliation-body"].innerHTML = emptyRow(11, emptyMessage);
    if (bankReconciliationReport) setBankReconciliationStatus(emptyMessage, "ok");
    return;
  }

  setBankReconciliationStatus(
    bankReconciliationReport?.merge
      ? `${bankReconciliationReport.merge.newCount || 0} nuevo(s), ${bankReconciliationReport.merge.duplicateCount || 0} repetido(s). ${visibleMovements.length} pendiente(s) guardado(s).`
      : `${visibleMovements.length} movimiento(s) pendiente(s) guardado(s). ${readyMovements.length} listo(s) para conciliar.`,
    visibleMovements.length ? "ok" : ""
  );
  els["bank-reconciliation-body"].innerHTML = visibleMovements.length
    ? visibleMovements.map(({ movement, index }) => bankReconciliationRow(movement, index)).join("")
    : emptyRow(11, "Todos los movimientos de este extracto ya estan conciliados.");
}

function renderBankReconciliationLatestDate(reconciliation) {
  const date = reconciliation?.latestDate || "";
  if (els["bank-reconciliation-last-date"]) {
    els["bank-reconciliation-last-date"].textContent = date
      ? `Último movimiento conciliado: ${formatDate(date)}`
      : "Sin conciliaciones registradas";
  }
  if (els["bank-reconciliation-last-days"]) {
    els["bank-reconciliation-last-days"].textContent = date
      ? `Hace ${Number(reconciliation.daysElapsed) || 0} ${Number(reconciliation.daysElapsed) === 1 ? "día" : "días"}`
      : "";
  }
}

function renderBankReconciliationStages() {
  renderBankReconciliationOptionLists();
  renderBankExpenseStage(bankReconciliationMovementsByStatus("agregar_gasto"));
  renderBankEgressStage(bankReconciliationMovementsByStatus("agregar_egreso"));
  renderBankPaymentStage(bankReconciliationMovementsByStatus("agregar_pago"));
}

function renderBankReconciliationOptionLists() {
  const options = bankReconciliationReport?.lookupOptions || {};
  const renderOptions = (id, values) => {
    const list = document.getElementById(id);
    if (!list) return;
    list.innerHTML = (values || [])
      .filter(Boolean)
      .map((value) => `<option value="${escapeHtml(value)}"></option>`)
      .join("");
  };
  renderOptions("bank-invoice-type-options", options.invoiceTypes);
  renderOptions("bank-payment-method-options", options.paymentMethods);
}

function renderBankExpenseStage(movements) {
  if (els["bank-expense-stage-count"]) els["bank-expense-stage-count"].textContent = String(movements.length);
  if (els["bank-create-expenses"]) els["bank-create-expenses"].disabled = !movements.length;
  if (!els["bank-expense-stage-body"]) return;
  els["bank-expense-stage-body"].innerHTML = movements.length
    ? movements.map((movement) => `
      <tr data-bank-movement-key="${escapeHtml(movement.movementKey || "")}">
        <td><input class="bank-stage-input" type="date" value="${escapeHtml(movement.date || "")}" data-bank-review-field="date"></td>
        <td>${escapeHtml(bankReconciliationCreditorLabel(movement))}</td>
        <td>${escapeHtml(bankReconciliationTagLabel(movement))}</td>
        <td>${escapeHtml(movement.sourceDestination?.label || "Otros gastos")}</td>
        <td><input class="bank-stage-input bank-stage-detail-input" value="${escapeHtml(movement.detail || movement.concept || "")}" data-bank-review-field="detail"></td>
        <td class="num">${formatBankMoney(Math.abs(movement.amount || 0))}</td>
        <td><button type="button" class="bank-stage-remove" data-bank-stage-remove="${escapeHtml(movement.movementKey || "")}">Quitar</button></td>
      </tr>
    `).join("")
    : emptyRow(7, "No hay gastos para agregar.");
}

function renderBankEgressStage(movements) {
  if (els["bank-egress-stage-count"]) els["bank-egress-stage-count"].textContent = String(movements.length);
  if (els["bank-create-egresses"]) els["bank-create-egresses"].disabled = !movements.length;
  if (!els["bank-egress-stage-body"]) return;
  els["bank-egress-stage-body"].innerHTML = movements.length
    ? movements.map((movement) => `
      <tr data-bank-movement-key="${escapeHtml(movement.movementKey || "")}">
        <td><input class="bank-stage-input" type="date" value="${escapeHtml(movement.sourceMatch?.date || movement.date || "")}" data-bank-review-field="date"></td>
        <td>${escapeHtml(bankReconciliationCreditorLabel(movement))}</td>
        <td>${escapeHtml(`${movement.sourceMatch?.label || "Gasto"} #${movement.sourceMatch?.id || "-"}`)}</td>
        <td>${escapeHtml(bankReconciliationTagLabel(movement))}</td>
        <td><input class="bank-stage-input" list="bank-invoice-type-options" value="${escapeHtml(movement.providerMatch?.invoiceType || movement.sourceMatch?.invoiceType || "")}" placeholder="Tipo de factura" data-bank-review-field="tipo_factura"></td>
        <td class="num">${formatBankMoney(Math.abs(movement.amount || 0))}</td>
      </tr>
    `).join("")
    : emptyRow(6, "No hay egresos para agregar.");
}

function renderBankPaymentStage(movements) {
  if (els["bank-payment-stage-count"]) els["bank-payment-stage-count"].textContent = String(movements.length);
  if (els["bank-create-payments"]) els["bank-create-payments"].disabled = !movements.length;
  if (!els["bank-payment-stage-body"]) return;
  els["bank-payment-stage-body"].innerHTML = movements.length
    ? movements.map((movement) => `
      <tr data-bank-movement-key="${escapeHtml(movement.movementKey || "")}">
        <td><input class="bank-stage-input" type="date" value="${escapeHtml(movement.date || "")}" data-bank-review-field="date"></td>
        <td>${escapeHtml(bankReconciliationCreditorLabel(movement))}</td>
        <td>${escapeHtml(`Egreso #${movement.match?.id || "-"}${movement.match?.description ? ` · ${movement.match.description}` : ""}`)}</td>
        <td>${escapeHtml(els["bank-reconciliation-bank"]?.value || "-")}</td>
        <td><input class="bank-stage-input" list="bank-payment-method-options" value="${escapeHtml(bankPaymentMethodSuggestion(movement))}" placeholder="Metodo de pago" data-bank-review-field="metodo"></td>
        <td class="num">${formatBankMoney(Math.abs(movement.amount || 0))}</td>
      </tr>
    `).join("")
    : emptyRow(6, "No hay pagos para agregar.");
}

function bankPaymentMethodSuggestion(movement) {
  const detail = String([movement?.detail, movement?.concept].filter(Boolean).join(" ")).toLowerCase();
  if (movement?.checkNumber || detail.includes("cheque") || detail.includes("echeq") || detail.includes("ch camara")) return "Cheque";
  if (detail.includes("transfer") || detail.includes("tr.")) return "Transferencia";
  if (detail.includes("debito")) return "Debito";
  return "Movimiento bancario";
}

function bankReconciliationRow(movement, index) {
  const statusLabel = {
    conciliado: "Conciliada",
    listo: "Lista para conciliar",
    agregar_pago: "Agregar pago",
    agregar_egreso: "Agregar egreso",
    agregar_gasto: "Agregar gasto",
    revisar: "Revisar"
  }[movement.status] || "Revisar";
  const match = movement.match
    ? `${movement.match.type || ""} #${movement.match.id || ""} · ${formatDate(movement.match.date)} · ${formatBankMoney(movement.match.amount || 0)}${movement.match.identity ? ` · ${movement.match.identity}` : ""}`
    : "-";
  const checkCell = bankReconciliationCheckCell(movement, index);
  const amountCell = bankReconciliationAmountCell(movement);
  const actionCell = bankReconciliationActionCell(movement, index);

  return `
    <tr class="bank-row-${escapeHtml(movement.status || "pending")}">
      <td>${formatDate(movement.date)}</td>
      <td>${escapeHtml(movement.detail || movement.concept || "-")}</td>
      <td>${escapeHtml(movement.cuit || "-")}</td>
      <td>${checkCell}</td>
      <td>${escapeHtml(bankReconciliationCreditorLabel(movement))}</td>
      <td>${escapeHtml(bankReconciliationTagLabel(movement))}</td>
      <td class="num">${amountCell}</td>
      <td class="num">${formatBankMoney(movement.balance || 0)}</td>
      <td><span class="bank-status-pill bank-status-${escapeHtml(movement.status || "pending")}">${statusLabel}</span></td>
      <td>${actionCell}</td>
      <td>${escapeHtml(match)}</td>
    </tr>
  `;
}

function bankReconciliationCheckCell(movement, index) {
  const checkNumber = String(movement.checkNumber || "").trim();
  if (!checkNumber) return "-";
  if (movement.checkMatch) {
    const label = movement.checkMatch.type === "cheque_entregado" ? "Cheque entregado encontrado" : "Cheque encontrado";
    return `<span class="bank-check-found">${escapeHtml(checkNumber)} · ${escapeHtml(label)}</span>`;
  }
  return `<span class="bank-check-number">${escapeHtml(checkNumber)}</span>`;
}

function bankReconciliationCreditorLabel(movement) {
  if (movement.provider) return movement.provider;
  return "-";
}

function bankReconciliationTagLabel(movement) {
  if (movement.tag) return movement.tag;
  if (Array.isArray(movement.tagOptions) && movement.tagOptions.length) return movement.tagOptions.join(" / ");
  if (movement.suggestedExpenseType) return movement.suggestedExpenseType;
  return "-";
}

function bankReconciliationAmountCell(movement) {
  if (movement.debit) return `<span class="bank-amount-debit">-${formatBankMoney(movement.debit)}</span>`;
  if (movement.credit) return `<span class="bank-amount-credit">${formatBankMoney(movement.credit)}</span>`;
  return "-";
}

function bankReconciliationActionCell(movement, index) {
  const baseAction = escapeHtml(movement.action || "-");
  if (["listo", "conciliado"].includes(movement.status)) return baseAction;
  const creditorId = bankMovementCreditorId(movement);
  const hasCuit = Boolean(String(movement.cuit || "").trim());
  const hasBankDetailRule = movement.providerMatch?.type === "datos_bancarios";
  const isCredit = moneyToCents(movement.amount || 0) > 0;
  const hasKnownClient = isCredit && movement.providerMatch?.type === "cliente";
  const checkNumber = String(movement.checkNumber || "").trim();
  const buttons = [];

  if (isCredit && !movement.checkMatch && bankMovementLooksLikeCheckDeposit(movement)) {
    buttons.push(`<button type="button" class="bank-add-provider" data-bank-review-check-deposit="${index}">Revisar deposito</button>`);
  }

  if (!isCredit && creditorId && bankReconciliationOpenDebtCreditorIds.has(String(creditorId))) {
    buttons.push(`<button type="button" class="bank-add-provider" data-bank-review-debt="${index}">Revisar deuda</button>`);
  }

  if (hasKnownClient && !movement.match && !checkNumber) {
    buttons.push(`<button type="button" class="bank-add-provider" data-bank-add-collection="${index}">Agregar cobro</button>`);
  }

  if (!creditorId && !hasKnownClient && (movement.suggestedCounterparty?.name || movement.suggestedCounterparty?.cuit || movement.cuit || movement.cbuAlias)) {
    if (isCredit) {
      buttons.push(`<button type="button" class="bank-add-provider" data-bank-add-client="${index}">Agregar cliente</button>`);
      buttons.push(`<button type="button" class="bank-add-provider" data-bank-add-creditor="${index}">Agregar Acreedor</button>`);
      buttons.push(`<button type="button" class="bank-add-provider" data-bank-partner-contribution="${index}">Registrar aporte o retiro</button>`);
    } else {
      buttons.push(`<button type="button" class="bank-add-provider" data-bank-add-creditor="${index}">Agregar Acreedor</button>`);
    }
  }

  if (!checkNumber && !hasCuit && !hasBankDetailRule) {
    buttons.push(`<button type="button" class="bank-add-provider" data-bank-add-data="${index}">${creditorId ? "Agregar detalle bancario" : "Asociar detalle bancario"}</button>`);
  }

  if (checkNumber && !movement.checkMatch && movement.debit) {
    buttons.push(`<button type="button" class="bank-add-provider" data-bank-add-purchase="${index}">Agregar compra</button>`);
    buttons.push(`<button type="button" class="bank-add-provider" data-bank-add-reception="${index}">Agregar recepcion</button>`);
    buttons.push(`<button type="button" class="bank-add-provider" data-bank-add-issued-check="${index}">Agregar cheque entregado</button>`);
  } else if (checkNumber && !movement.checkMatch) {
    buttons.push(`<button type="button" class="bank-add-provider" data-bank-add-collection="${index}">Agregar cobro</button>`);
    buttons.push(`<button type="button" class="bank-add-provider" data-bank-add-check="${index}">Agregar cheque</button>`);
  }

  if (!buttons.length) return baseAction;
  return `
    <span>${baseAction}</span>
    <div class="bank-row-actions">
      ${buttons.join("")}
    </div>
  `;
}
