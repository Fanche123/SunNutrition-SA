async function submitIssuedCheckEntry(event) {
  event.preventDefault();
  const paymentId = String(els["issued-check-payment-id"]?.value || "").trim();
  const creditorId = String(els["issued-check-creditor-id"]?.value || "").trim();
  const checkNumber = String(els["issued-check-number"]?.value || "").trim();
  const deliveredDate = String(els["issued-check-date"]?.value || "").trim();
  const useDate = String(els["issued-check-use-date"]?.value || "").trim();
  const amount = entryMoneyValue("issued-check-amount");
  const bank = String(els["issued-check-bank"]?.value || "").trim();

  if (!paymentId || !creditorId || !checkNumber || !deliveredDate || !useDate || amount <= 0) {
    setEntryStatus("issued-check-message", "Selecciona un pago pendiente y completa numero, fechas y monto del cheque.", "error");
    return;
  }

  const button = els["issued-check-submit"];
  const originalText = button?.textContent || "Enviar cheque entregado";
  if (button) {
    button.disabled = true;
    button.textContent = "Guardando...";
  }
  setEntryStatus("issued-check-message", "Guardando cheque entregado...", "pending");

  try {
    const checkId = await nextBackendPrimaryId("cheques_entregados", "id_cheque_entregado");
    await saveBackendEntryRows("cheques_entregados", [{
      id_cheque_entregado: checkId,
      id_pago: paymentId,
      id_acreedor: creditorId,
      nro_cheque: checkNumber,
      fecha_entregado: deliveredDate,
      fecha_uso: useDate,
      monto: amount,
      banco: bank,
      estado: String(els["issued-check-state"]?.value || "").trim() || "Pendiente"
    }]);

    backendDataMap = null;
    dataEditorSchema = null;
    purchaseBackendOptions = createPurchaseBackendOptions();
    await loadIssuedCheckPendingPayments();
    setEntryStatus("issued-check-message", `Cheque ${checkId} asociado al pago ${paymentId}.`, "success");
  } catch (error) {
    setEntryStatus("issued-check-message", error.message, "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

// Cambia de pantalla sin recargar la pĂˇgina.
