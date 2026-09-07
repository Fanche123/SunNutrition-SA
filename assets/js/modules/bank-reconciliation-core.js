function setupBankReconciliationFileDropZone() {
  setupFileDropZone({
    dropZone: els["bank-reconciliation-drop-zone"],
    input: els["bank-reconciliation-file"],
    onAccepted: () => readBankReconciliationFile()
  });
}

function readBankReconciliationFile() {
  const file = els["bank-reconciliation-file"]?.files?.[0];
  if (!file) {
    clearBankReconciliationFile();
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    bankReconciliationFileText = String(reader.result || "");
    updateBankReconciliationFileChip(file);
    setBankReconciliationStatus("Extracto listo para analizar.", "ok");
  };
  reader.onerror = () => setBankReconciliationStatus("No se pudo leer el archivo del banco.", "warn");
  reader.readAsText(file, "windows-1252");
}

function updateBankReconciliationFileChip(file) {
  els["bank-reconciliation-file-chip"]?.classList.remove("is-empty");
  if (els["bank-reconciliation-file-name"]) els["bank-reconciliation-file-name"].textContent = file.name;
  if (els["bank-reconciliation-file-size"]) els["bank-reconciliation-file-size"].textContent = `${Math.round(file.size / 1024)} KB`;
}

function clearBankReconciliationFile() {
  bankReconciliationFileText = "";
  bankCheckDepositDraft = null;
  if (els["bank-reconciliation-file"]) els["bank-reconciliation-file"].value = "";
  els["bank-reconciliation-file-chip"]?.classList.add("is-empty");
  if (els["bank-reconciliation-file-name"]) els["bank-reconciliation-file-name"].textContent = "Sin archivo";
  if (els["bank-reconciliation-file-size"]) els["bank-reconciliation-file-size"].textContent = "";
  renderBankReconciliation();
}

let bankReconciliationApplyInFlight = false;
let bankReconciliationEditMode = false;
const bankExpenseReviewDrafts = new Map();

function setupBankReconciliationEditFeature() {
  const panel = document.getElementById("bank-movements-stage");
  const applyButton = document.getElementById("bank-reconciliation-apply");
  const body = document.getElementById("bank-reconciliation-body");
  if (!panel || !applyButton || !body || document.getElementById("bank-reconciliation-edit")) return;

  const header = applyButton.closest(".panel-header");
  const actions = document.createElement("div");
  actions.className = "bank-reconciliation-header-actions";
  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.id = "bank-reconciliation-edit";
  editButton.className = "secondary";
  editButton.textContent = "Editar";
  editButton.setAttribute("aria-pressed", "false");
  applyButton.before(actions);
  actions.append(editButton, applyButton);

  const style = document.createElement("style");
  style.textContent = `
    .bank-reconciliation-header-actions { display: flex; align-items: center; gap: 8px; }
    #bank-movements-stage.bank-edit-mode #bank-reconciliation-body > tr { cursor: pointer; }
    #bank-movements-stage.bank-edit-mode #bank-reconciliation-body > tr:hover { outline: 1px solid currentColor; outline-offset: -1px; }
    #bank-movement-edit-dialog { width: min(760px, calc(100vw - 32px)); }
    #bank-movement-edit-dialog .bank-movement-edit-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    #bank-movement-edit-dialog .bank-movement-edit-grid label { display: grid; gap: 6px; }
    #bank-movement-edit-dialog .bank-movement-edit-grid .bank-movement-edit-detail { grid-column: 1 / -1; }
    #bank-movement-edit-dialog .bank-movement-edit-grid input { width: 100%; }
    @media (max-width: 680px) {
      #bank-movement-edit-dialog .bank-movement-edit-grid { grid-template-columns: 1fr; }
      #bank-movement-edit-dialog .bank-movement-edit-grid .bank-movement-edit-detail { grid-column: auto; }
    }
  `;
  document.head.appendChild(style);

  const dialog = document.createElement("dialog");
  dialog.id = "bank-movement-edit-dialog";
  dialog.className = "data-editor-delete-dialog";
  dialog.innerHTML = `
    <form id="bank-movement-edit-form">
      <h3>Editar movimiento bancario</h3>
      <p>Los cambios se guardan en la tabla de movimientos bancarios. La identidad original del extracto se conserva para evitar duplicados.</p>
      <div class="bank-movement-edit-grid">
        <label>Fecha<input id="bank-movement-edit-date" type="date" required></label>
        <label>CUIT<input id="bank-movement-edit-cuit" type="text" inputmode="numeric" maxlength="13" autocomplete="off"></label>
        <label class="bank-movement-edit-detail">Detalle<input id="bank-movement-edit-detail" type="text" autocomplete="off"></label>
        <label>Nro. cheque<input id="bank-movement-edit-check" type="text" autocomplete="off"></label>
        <label>Saldo<input id="bank-movement-edit-balance" type="text" inputmode="decimal" required></label>
        <label>Débito<input id="bank-movement-edit-debit" type="text" inputmode="decimal"></label>
        <label>Crédito<input id="bank-movement-edit-credit" type="text" inputmode="decimal"></label>
      </div>
      <p id="bank-movement-edit-status" class="form-status" role="status" aria-live="polite"></p>
      <div class="data-editor-dialog-actions">
        <button type="button" class="secondary" id="bank-movement-edit-cancel">Cancelar</button>
        <button type="submit" id="bank-movement-edit-save">Guardar cambios</button>
      </div>
    </form>
  `;
  document.body.appendChild(dialog);

  editButton.addEventListener("click", () => {
    if (bankReconciliationApplyInFlight) return;
    bankReconciliationEditMode = !bankReconciliationEditMode;
    panel.classList.toggle("bank-edit-mode", bankReconciliationEditMode);
    editButton.textContent = bankReconciliationEditMode ? "Salir de edición" : "Editar";
    editButton.setAttribute("aria-pressed", String(bankReconciliationEditMode));
    setBankReconciliationStatus(
      bankReconciliationEditMode
        ? "Modo edición activo. Seleccioná una fila para modificarla."
        : "Modo edición finalizado.",
      "ok"
    );
  });

  body.addEventListener("click", (event) => {
    if (!bankReconciliationEditMode || bankReconciliationApplyInFlight) return;
    if (event.target.closest("button, input, select, textarea, a, label")) return;
    const row = event.target.closest("tr");
    if (!row || row.parentElement !== body || row.querySelector("td.empty")) return;
    const rows = [...body.children].filter((candidate) => candidate.matches("tr"));
    const rowIndex = rows.indexOf(row);
    const movement = (bankReconciliationReport?.movements || [])
      .filter((candidate) => candidate.status !== "conciliado")[rowIndex];
    if (!movement) return;
    openBankMovementEditDialog(dialog, movement);
  });

  dialog.querySelector("#bank-movement-edit-cancel")?.addEventListener("click", () => dialog.close());
  dialog.querySelector("#bank-movement-edit-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveBankMovementEdit(dialog);
  });
}

function openBankMovementEditDialog(dialog, movement) {
  dialog.dataset.canonicalMovementId = String(movement.canonicalMovementId || "");
  dialog.dataset.movementKey = String(movement.movementKey || "");
  const setValue = (id, value) => {
    const input = dialog.querySelector(`#${id}`);
    if (input) input.value = value === undefined || value === null ? "" : String(value);
  };
  setValue("bank-movement-edit-date", movement.date || "");
  setValue("bank-movement-edit-detail", movement.detail || movement.concept || "");
  setValue("bank-movement-edit-cuit", movement.cuit || "");
  setValue("bank-movement-edit-check", movement.checkNumber || "");
  setValue("bank-movement-edit-debit", movement.debit || "");
  setValue("bank-movement-edit-credit", movement.credit || "");
  setValue("bank-movement-edit-balance", movement.balance ?? "");
  const status = dialog.querySelector("#bank-movement-edit-status");
  if (status) status.textContent = "";
  dialog.showModal();
}

async function saveBankMovementEdit(dialog) {
  if (bankReconciliationApplyInFlight) return;
  const value = (id) => dialog.querySelector(`#${id}`)?.value ?? "";
  const status = dialog.querySelector("#bank-movement-edit-status");
  const saveButton = dialog.querySelector("#bank-movement-edit-save");
  const canonicalMovementId = dialog.dataset.canonicalMovementId || "";
  const movementKey = dialog.dataset.movementKey || "";
  if (!canonicalMovementId || !movementKey) {
    if (status) status.textContent = "No se pudo identificar el movimiento a editar.";
    return;
  }

  bankReconciliationApplyInFlight = true;
  setBankReconciliationActionButtonsDisabled(true);
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = "Guardando...";
  }
  if (status) status.textContent = "";

  try {
    const response = await fetch(`${API_BASE_URL}/api/bank-reconciliation/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bank: els["bank-reconciliation-bank"]?.value || "ICBC",
        applyMode: "editMovement",
        editRow: {
          canonicalMovementId,
          movementKey,
          date: value("bank-movement-edit-date"),
          detail: value("bank-movement-edit-detail"),
          cuit: value("bank-movement-edit-cuit"),
          checkNumber: value("bank-movement-edit-check"),
          debit: value("bank-movement-edit-debit"),
          credit: value("bank-movement-edit-credit"),
          balance: value("bank-movement-edit-balance")
        }
      })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo actualizar el movimiento bancario.");
    dialog.close();
    const refreshedReport = await refreshBankReconciliationFromBackend({ force: true });
    if (!refreshedReport) {
      throw new Error("El movimiento se guardó, pero no se pudo refrescar la conciliación.");
    }
    setBankReconciliationStatus("Movimiento bancario actualizado.", "ok");
  } catch (error) {
    console.error("No se pudo editar el movimiento bancario.", error);
    if (!dialog.open) dialog.showModal();
    if (status) status.textContent = error.message;
  } finally {
    bankReconciliationApplyInFlight = false;
    setBankReconciliationActionButtonsDisabled(false);
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = "Guardar cambios";
    }
    renderBankReconciliation();
  }
}

function setBankReconciliationActionButtonsDisabled(disabled) {
  [
    "bank-create-expenses",
    "bank-create-egresses",
    "bank-create-payments",
    "bank-reconciliation-apply",
    "bank-reconciliation-bank",
    "bank-reconciliation-file",
    "bank-reconciliation-file-clear",
    "bank-reconciliation-analyze"
  ].forEach((id) => {
    if (els[id]) els[id].disabled = disabled;
  });
  const editButton = document.getElementById("bank-reconciliation-edit");
  if (editButton) editButton.disabled = disabled;
  document.querySelectorAll?.(
    "#bank-expense-stage-body input, #bank-expense-stage-body select, #bank-egress-stage-body input, #bank-payment-stage-body input"
  )?.forEach((control) => { control.disabled = disabled; });
}

async function refreshBankReconciliationFromBackend({ force = false } = {}) {
  if (bankReconciliationRefreshPromise) {
    if (!force) return bankReconciliationRefreshPromise;
    await bankReconciliationRefreshPromise;
  }

  const bank = els["bank-reconciliation-bank"]?.value || "ICBC";
  bankReconciliationRefreshPromise = fetch(
    `${API_BASE_URL}/api/bank-reconciliation/state?bank=${encodeURIComponent(bank)}`
  )
    .then(async (response) => {
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "No se pudieron cargar los movimientos pendientes.");
      }
      bankReconciliationReport = payload.report;
      renderBankReconciliation();
      void refreshBankReconciliationOpenDebtCreditors(bankReconciliationReport);
      return bankReconciliationReport;
    })
    .catch((error) => {
      console.error("No se pudieron cargar los movimientos bancarios pendientes.", error);
      setBankReconciliationStageVisibility("bank-movements-stage", true);
      setBankReconciliationStatus(error.message, "warn");
      return null;
    })
    .finally(() => {
      bankReconciliationRefreshPromise = null;
      if ((els["bank-reconciliation-bank"]?.value || "ICBC") !== bank) {
        refreshBankReconciliationFromBackend();
      }
    });
  return bankReconciliationRefreshPromise;
}

async function analyzeBankReconciliation({ preserveExcludedMovements = false } = {}) {
  if (!bankReconciliationFileText.trim()) {
    setBankReconciliationStatus("Primero carga el CSV del banco.", "warn");
    return;
  }

  const button = els["bank-reconciliation-analyze"];
  if (!preserveExcludedMovements) bankReconciliationExcludedMovementKeys = new Set();
  const originalText = button?.textContent || "Analizar movimientos";
  if (button) {
    button.disabled = true;
    button.textContent = "Analizando...";
  }

  try {
    const response = await fetch(`${API_BASE_URL}/api/bank-reconciliation/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bank: els["bank-reconciliation-bank"]?.value || "ICBC",
        csvText: bankReconciliationFileText
      })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo analizar el extracto.");
    bankReconciliationReport = payload.report;
    renderBankReconciliation();
    void refreshBankReconciliationOpenDebtCreditors(bankReconciliationReport);
  } catch (error) {
    console.error("No se pudo analizar el extracto bancario.", error);
    renderBankReconciliation();
    setBankReconciliationStatus(error.message, "warn");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function applyBankReconciliation(applyMode) {
  if (bankReconciliationApplyInFlight) {
    setBankReconciliationStatus("Ya hay una accion de conciliacion en curso.", "warn");
    return;
  }
  if (!bankReconciliationReport?.movements?.length) {
    setBankReconciliationStatus("No hay movimientos pendientes para procesar.", "warn");
    return;
  }

  const stageConfig = {
    createExpenses: {
      status: "agregar_gasto",
      button: els["bank-create-expenses"],
      progressText: "Agregando gastos..."
    },
    createEgresses: {
      status: "agregar_egreso",
      button: els["bank-create-egresses"],
      progressText: "Agregando egresos..."
    },
    createPayments: {
      status: "agregar_pago",
      button: els["bank-create-payments"],
      progressText: "Agregando pagos..."
    },
    reconcile: {
      status: "listo",
      button: els["bank-reconciliation-apply"],
      progressText: "Conciliando..."
    }
  }[applyMode];
  if (!stageConfig) return;

  const stageMovements = bankReconciliationMovementsByStatus(stageConfig.status);
  if (!stageMovements.length) {
    setBankReconciliationStatus("No hay movimientos disponibles para esta accion.", "warn");
    return;
  }

  const button = stageConfig.button;
  const originalText = button?.textContent || "Ejecutar";
  let finalStatus = null;
  bankReconciliationApplyInFlight = true;
  setBankReconciliationActionButtonsDisabled(true);
  if (button) {
    button.textContent = stageConfig.progressText;
  }

  try {
    const reviewRows = collectBankReconciliationReviewRows(stageConfig.status);
    if (applyMode === "createExpenses") {
      Object.entries(reviewRows).forEach(([movementKey, reviewRow]) => {
        bankExpenseReviewDrafts.set(movementKey, { ...reviewRow });
      });
    }
    const response = await fetch(`${API_BASE_URL}/api/bank-reconciliation/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bank: els["bank-reconciliation-bank"]?.value || "ICBC",
        applyMode,
        movementKeys: stageMovements.map((movement) => movement.movementKey),
        reviewRows
      })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo conciliar el banco.");
    const result = payload.result || {};
    const refreshedReport = await refreshBankReconciliationFromBackend({ force: true });
    if (!refreshedReport) {
      throw new Error("La accion se guardo, pero no se pudo refrescar el estado. Volve a cargar la conciliacion antes de continuar.");
    }
    const stageMessage = {
      createExpenses: `${result.expensesCreated || 0} gasto(s) agregado(s)`,
      createEgresses: `${result.egressesCreated || 0} egreso(s) agregado(s)`,
      createPayments: `${result.paymentsCreated || 0} pago(s) agregado(s)`,
      reconcile: `${result.movementsReconciled || 0} movimiento(s) conciliado(s)`
    }[applyMode];
    const note = Array.isArray(result.notes) && result.notes.length ? ` ${result.notes[0]}` : "";
    finalStatus = {
      message: `${stageMessage}.${result.skipped ? ` ${result.skipped} movimiento(s) requieren revision.` : ""}${note}`,
      type: result.skipped && !result.expensesCreated && !result.egressesCreated
        && !result.paymentsCreated && !result.movementsReconciled ? "warn" : "ok"
    };
    if (window.erpAccessPolicy?.isViewAllowed(window.erpAuthentication?.user?.role, "cashflow")) {
      loadBackendCashflowReport();
    }
  } catch (error) {
    console.error("No se pudo aplicar la accion de conciliacion bancaria.", error);
    finalStatus = { message: error.message, type: "warn" };
  } finally {
    bankReconciliationApplyInFlight = false;
    if (button) {
      button.textContent = originalText;
    }
    renderBankReconciliation();
    if (finalStatus) setBankReconciliationStatus(finalStatus.message, finalStatus.type);
  }
}

setupBankReconciliationEditFeature();
