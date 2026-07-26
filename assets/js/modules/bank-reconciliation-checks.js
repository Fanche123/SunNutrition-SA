function bankMovementLooksLikeCheckDeposit(movement) {
  const detail = `${movement?.detail || ""} ${movement?.concept || ""}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const isCredit = moneyToCents(movement?.amount || movement?.credit || 0) > 0;
  return isCredit && (detail.includes("dep ch") || detail.includes("deposit") || detail.includes("echeq"));
}

function bankPendingCheckDepositMovements() {
  return (bankReconciliationReport?.movements || [])
    .map((movement, index) => ({ movement, index }))
    .filter(({ movement }) => movement.status !== "conciliado" && !movement.checkMatch && bankMovementLooksLikeCheckDeposit(movement));
}

async function openBankCheckDepositReview(index = bankCheckDepositDraft?.movementIndex ?? null) {
  try {
    const previousDraft = bankCheckDepositDraft;
    const [checks, collections, clients] = await Promise.all([
      backendTableRowsForEntry("cheques_recibidos"),
      backendTableRowsForEntry("cobros").catch(() => []),
      backendTableRowsForEntry("clientes").catch(() => [])
    ]);
    const collectionsById = new Map(collections.map((row) => [String(row.id_cobro || ""), row]));
    const clientsById = new Map(clients.map((row) => [String(row.id_cliente || ""), row]));
    const candidates = checks
      .filter((row) => bankReceivedCheckCanBeDeposited(row))
      .map((row) => {
        const collection = collectionsById.get(String(row.id_cobro || ""));
        const client = clientsById.get(String(row.id_cliente || collection?.id_cliente || ""));
        return {
          id: String(row.id_cheque_recibido || ""),
          checkNumber: String(row.nro_cheque || "-"),
          client: String(row.cliente || client?.nombre_cliente || collection?.cliente || "-"),
          date: String(row.fecha_entregado || collection?.fecha_cobro || row.fecha_uso || ""),
          amount: centsToMoney(Math.abs(moneyToCents(row.monto)))
        };
      })
      .filter((row) => row.id && row.amount > 0);

    const hasRequestedIndex = index !== null && index !== undefined && index !== "";
    const requestedIndex = hasRequestedIndex ? Number(index) : -1;
    const movementIndex = hasRequestedIndex && Number.isInteger(requestedIndex) && bankReconciliationReport?.movements?.[requestedIndex]
      ? requestedIndex
      : previousDraft?.movementKey
        ? bankReconciliationReport?.movements?.findIndex((item) => item.movementKey === previousDraft.movementKey) ?? -1
        : -1;
    const movement = movementIndex >= 0 ? bankReconciliationReport.movements[movementIndex] : null;
    bankCheckDepositDraft = {
      movementIndex: movement ? movementIndex : null,
      movementKey: movement?.movementKey || "",
      candidates,
      selectedIds: new Set(
        [...(previousDraft?.selectedIds || [])].filter((id) => candidates.some((check) => check.id === id))
      ),
      bank: previousDraft?.bank || els["bank-reconciliation-bank"]?.value || "ICBC",
      depositDate: movement
        ? bankCheckDepositDateInput(movement?.date)
        : previousDraft?.depositDate || new Date().toISOString().slice(0, 10)
    };
    renderBankCheckDepositReview();
  } catch (error) {
    setBankReconciliationStatus(`No se pudieron cargar los cheques pendientes: ${error.message}`, "warn");
  }
}

function bankReceivedCheckCanBeDeposited(row) {
  const status = String(row?.estado || "").trim().toLowerCase();
  return (
    status === "pendiente" &&
    !backendId(row?.id_deposito) &&
    !backendId(row?.id_pago_endoso) &&
    !String(row?.fecha_deposito || "").trim() &&
    !String(row?.fecha_endoso || "").trim()
  );
}

function bankCheckDepositNumber(value) {
  return normalizeMoney(value || 0);
}

function bankCheckDepositDateInput(value) {
  return parseDate(value) || "";
}

function bankCheckDepositMovementIndex(draft) {
  const movements = bankReconciliationReport?.movements || [];
  const index = Number(draft?.movementIndex);
  if (Number.isInteger(index) && movements[index]) {
    return index;
  }
  if (draft?.movementKey) return movements.findIndex((movement) => movement.movementKey === draft.movementKey);
  return -1;
}

function renderBankCheckDepositReview() {
  const panel = els["bank-check-deposit-panel"];
  const draft = bankCheckDepositDraft;
  const movementIndex = bankCheckDepositMovementIndex(draft);
  const movement = movementIndex >= 0 ? bankReconciliationReport?.movements?.[movementIndex] : null;
  if (!panel) return;
  const depositMovements = bankPendingCheckDepositMovements();
  const movementSelect = els["bank-check-deposit-movement"];
  const candidates = draft?.candidates || [];
  const selected = candidates.filter((check) => draft?.selectedIds.has(check.id));
  const creditCents = movement ? Math.abs(moneyToCents(movement.amount || movement.credit)) : 0;
  const selectedTotalCents = selected.reduce((total, check) => total + moneyToCents(check.amount), 0);
  const differenceCents = creditCents - selectedTotalCents;
  const credit = centsToMoney(creditCents);
  const selectedTotal = centsToMoney(selectedTotalCents);
  const difference = centsToMoney(differenceCents);
  const matches = Boolean(movement) && selected.length > 0 && differenceCents === 0;
  const canConfirm = selected.length > 0 && (!movement || matches);
  panel.hidden = false;

  if (els["bank-check-deposit-date"]) els["bank-check-deposit-date"].value = draft?.depositDate || "";
  if (els["bank-check-deposit-bank"]) els["bank-check-deposit-bank"].value = draft?.bank || "ICBC";

  if (movementSelect) {
    movementSelect.innerHTML = `<option value="">Seleccionar crédito del extracto</option>${depositMovements.map(({ movement: item, index }) => {
      const amount = Math.abs(bankCheckDepositNumber(item.amount || item.credit));
      return `<option value="${index}">${escapeHtml(formatDate(item.date))} · ${escapeHtml(item.detail || item.concept || "Depósito")} · ${escapeHtml(formatBankMoney(amount))}</option>`;
    }).join("")}`;
    movementSelect.value = movement ? String(movementIndex) : "";
    movementSelect.disabled = !depositMovements.length;
  }
  if (els["bank-check-deposit-title"]) els["bank-check-deposit-title"].textContent = "Cheques pendientes de depositar";
  if (els["bank-check-deposit-credit"]) els["bank-check-deposit-credit"].textContent = movement ? formatBankMoney(credit) : "Sin extracto";
  if (els["bank-check-deposit-total"]) els["bank-check-deposit-total"].textContent = formatBankMoney(selectedTotal);
  const differenceElement = els["bank-check-deposit-difference"];
  if (differenceElement) {
    differenceElement.textContent = movement ? formatBankMoney(Math.abs(difference)) : "-";
    differenceElement.classList.toggle("is-match", matches);
    differenceElement.classList.toggle("is-mismatch", Boolean(movement) && selected.length > 0 && !matches);
  }
  if (els["bank-check-deposit-status-view"]) {
    els["bank-check-deposit-status-view"].textContent = !candidates.length
      ? "No hay cheques recibidos en estado pendiente para depositar."
      : !movement
        ? "Selecciona los cheques y registra el depósito. Se conciliará cuando aparezca el crédito en el extracto."
      : !selected.length
        ? "Selecciona los cheques que integran este depósito."
      : matches
        ? "La suma coincide con el crédito del banco."
        : difference > 0
          ? `Faltan ${formatBankMoney(difference)} para alcanzar el crédito del banco.`
          : `La selección supera el crédito por ${formatBankMoney(Math.abs(difference))}.`;
  }
  if (els["bank-check-deposit-body"]) {
    els["bank-check-deposit-body"].innerHTML = candidates.length
      ? candidates.map((check) => `
        <tr>
          <td><input type="checkbox" data-bank-check-deposit-select="${escapeHtml(check.id)}" ${draft?.selectedIds.has(check.id) ? "checked" : ""}></td>
          <td>${escapeHtml(check.checkNumber)}</td>
          <td>${escapeHtml(check.client)}</td>
          <td>${formatDate(check.date)}</td>
          <td class="num">${formatBankMoney(check.amount)}</td>
        </tr>
      `).join("")
      : emptyRow(5, "No hay cheques recibidos pendientes para depositar.");
  }
  if (els["bank-check-deposit-confirm"]) {
    els["bank-check-deposit-confirm"].disabled = !canConfirm;
    els["bank-check-deposit-confirm"].textContent = movement ? "Confirmar deposito" : "Registrar deposito";
  }
}

async function confirmBankCheckDeposit() {
  const draft = bankCheckDepositDraft;
  const movementIndex = bankCheckDepositMovementIndex(draft);
  const movement = movementIndex >= 0 ? bankReconciliationReport?.movements?.[movementIndex] : null;
  if (!draft) return;
  const selected = draft.candidates.filter((check) => draft.selectedIds.has(check.id));
  if (!selected.length) return;

  const button = els["bank-check-deposit-confirm"];
  const originalText = button?.textContent || "Confirmar deposito";
  if (button) {
    button.disabled = true;
    button.textContent = "Depositando...";
  }
  try {
    const response = await fetch(`${API_BASE_URL}/api/bank-reconciliation/deposit-checks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bank: draft.bank || "ICBC",
        depositDate: draft.depositDate,
        manualDeposit: !movement,
        movement: movement ? {
          date: movement.date,
          code: movement.code,
          concept: movement.concept,
          detail: movement.detail,
          cuit: movement.cuit,
          checkNumber: movement.checkNumber,
          debit: movement.debit,
          credit: movement.credit,
          amount: movement.amount,
          balance: movement.balance
        } : null,
        checkIds: selected.map((check) => check.id)
      })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo registrar el depósito.");
    bankCheckDepositDraft = null;
    if (movement) await analyzeBankReconciliation({ preserveExcludedMovements: true });
    await openBankCheckDepositReview();
    setBankReconciliationStatus(
      movement
        ? `${payload.checkCount} cheque(s) depositado(s) y conciliados por ${formatBankMoney(payload.amount)}.`
        : `${payload.checkCount} cheque(s) depositado(s) por ${formatBankMoney(payload.amount)}. Se conciliarán al aparecer en el extracto.`,
      "ok"
    );
    if (els["bank-check-deposit-status-view"]) {
      els["bank-check-deposit-status-view"].textContent = movement
        ? "Depósito confirmado y conciliado correctamente."
        : "Depósito registrado correctamente. Se conciliará cuando aparezca el crédito en el extracto.";
    }
  } catch (error) {
    setBankReconciliationStatus(`No se pudo conciliar el depósito: ${error.message}`, "warn");
    if (els["bank-check-deposit-status-view"]) {
      els["bank-check-deposit-status-view"].textContent = `No se pudo registrar el depósito: ${error.message}`;
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function bankMovementCreditorId(movement) {
  const match = movement?.providerMatch || {};
  if (match.idAcreedor) return String(match.idAcreedor);
  if (match.type === "acreedor" && match.id) return String(match.id);
  return "";
}

async function refreshBankReconciliationOpenDebtCreditors(report) {
  try {
    const tables = await loadExpenseDebtTables();
    if (bankReconciliationReport !== report) return;
    bankReconciliationOpenDebtCreditorIds = new Set(
      buildExpenseDebtRows(tables)
        .map((row) => String(row.creditorId || "").trim())
        .filter(Boolean)
    );
    renderBankReconciliation();
  } catch {
    // La conciliacion puede seguir funcionando aunque no se pueda cargar el contexto de deudas.
  }
}

function bankMovementPaymentAmount(movement) {
  const debit = parseMoneyInput(movement?.debit || "", { allowEmpty: true, allowNegative: false });
  if (debit.ok && debit.cents > 0) return debit.amount;
  return centsToMoney(Math.abs(moneyToCents(movement?.amount || 0)));
}
