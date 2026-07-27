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

function refreshBankReconciliationFromBackend() {
  if (bankReconciliationRefreshPromise) return bankReconciliationRefreshPromise;

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
  if (button) {
    button.disabled = true;
    button.textContent = stageConfig.progressText;
  }

  try {
    const response = await fetch(`${API_BASE_URL}/api/bank-reconciliation/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bank: els["bank-reconciliation-bank"]?.value || "ICBC",
        applyMode,
        movementKeys: stageMovements.map((movement) => movement.movementKey),
        reviewRows: collectBankReconciliationReviewRows(stageConfig.status)
      })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "No se pudo conciliar el banco.");
    const result = payload.result || {};
    await refreshBankReconciliationFromBackend();
    const stageMessage = {
      createExpenses: `${result.expensesCreated || 0} gasto(s) agregado(s)`,
      createEgresses: `${result.egressesCreated || 0} egreso(s) agregado(s)`,
      createPayments: `${result.paymentsCreated || 0} pago(s) agregado(s)`,
      reconcile: `${result.movementsReconciled || 0} movimiento(s) conciliado(s)`
    }[applyMode];
    const note = Array.isArray(result.notes) && result.notes.length ? ` ${result.notes[0]}` : "";
    setBankReconciliationStatus(
      `${stageMessage}.${result.skipped ? ` ${result.skipped} movimiento(s) requieren revision.` : ""}${note}`,
      result.skipped && !result.expensesCreated && !result.egressesCreated && !result.paymentsCreated && !result.movementsReconciled ? "warn" : "ok"
    );
    loadBackendCashflowReport();
  } catch (error) {
    setBankReconciliationStatus(error.message, "warn");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}
