async function submitInventoryDetail(event) {
  event.preventDefault();

  const date = els["inventory-date-input"].value;
  const employee = els["inventory-employee-input"].value.trim();
  if (!date) {
    setInventoryDetailStatus("Ingresa la fecha del inventario.", "error");
    return;
  }

  if (!employee) {
    setInventoryDetailStatus("Ingresa un empleado responsable.", "error");
    return;
  }

  if (!inventoryDetailTemplate?.rows?.length) {
    setInventoryDetailStatus("Primero preparĂˇ el detalle.", "error");
    return;
  }

  if (!selectedInventoryShifts().length) {
    setInventoryDetailStatus("Marcá al menos un turno realizado antes de enviar.", "error");
    return;
  }

  const rows = collectEditableInventoryDetailRows();

  const button = els["inventory-detail-submit"];
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Enviando...";
  setInventoryDetailStatus("Guardando inventario y detalle en el backend...", "pending");

  try {
    const response = await fetch(`${API_BASE_URL}/api/inventory/full-entry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date,
        employee,
        selectedShifts: selectedInventoryShifts(),
        rows
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);

    renderInventoryDetailTemplate(null);
    initializeInventoryEntryDefaults({ force: true });
    setInventoryDetailStatus(`Inventario completo enviado: ${payload.rowsWritten} filas de detalle.`, "success");
  } catch (error) {
    setInventoryDetailStatus(`No se pudo enviar el inventario completo: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function collectEditableInventoryDetailRows() {
  return [...els["inventory-detail-body"].querySelectorAll(":scope > tr[data-item-id]")].map((row) => ({
    itemId: row.dataset.itemId,
    afternoon: isInventoryShiftEnabled("afternoon") ? detailInputValue(row, "afternoon") : "",
    morning: isInventoryShiftEnabled("morning") ? detailInputValue(row, "morning") : "",
    dawn: isInventoryShiftEnabled("dawn") ? detailInputValue(row, "dawn") : ""
  }));
}

function detailInputValue(row, field) {
  return row.querySelector(`[data-detail-field="${field}"]`)?.value.trim() || "";
}
