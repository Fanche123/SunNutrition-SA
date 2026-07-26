async function readInventoryPhoto() {
  const file = els["inventory-photo-input"].files[0];
  const date = els["inventory-date-input"].value;
  const selectedShifts = selectedInventoryShifts();

  if (!date) {
    setInventoryDetailStatus("Elegí la fecha antes de leer la foto.", "error");
    return;
  }

  if (!selectedShifts.length) {
    setInventoryDetailStatus("Marcá al menos un turno realizado antes de leer la foto.", "error");
    return;
  }

  if (!inventoryDetailTemplate?.rows?.length) {
    setInventoryDetailStatus("Primero prepará el detalle.", "error");
    return;
  }

  if (!file) {
    setInventoryDetailStatus("Seleccioná una foto del inventario.", "error");
    return;
  }

  const button = els["inventory-photo-read"];
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Leyendo...";
  lastInventoryPhotoTranscription = null;
  inventoryPhotoApplied = false;
  setInventoryDetailStatus("Leyendo foto y buscando cantidades...", "pending");
  renderInventoryPhotoTranscription(null);

  try {
    const imageDataUrl = await imageFileToDataUrl(file);
    const response = await fetch(`${API_BASE_URL}/api/inventory-detail/photo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date,
        imageDataUrl,
        selectedShifts,
        rows: inventoryDetailTemplate.rows
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);

    lastInventoryPhotoTranscription = filterInventoryTranscriptionBySelectedShifts(payload.transcription);
    inventoryPhotoApplied = true;
    const result = applyPhotoInventoryRows(payload.rows || []);
    renderInventoryPhotoTranscription(lastInventoryPhotoTranscription);
    clearManualCounterCorrections();
    updateInventoryCounterReview();
    updateTheoreticalInventoryStock();
    window.setTimeout(updateTheoreticalInventoryStock, 0);
    setInventoryDetailStatus("Foto leida", "success");
  } catch (error) {
    setInventoryDetailStatus(`No se pudo leer la foto: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function applyPhotoInventoryRows(rows) {
  let applied = 0;
  els["inventory-detail-body"].querySelectorAll(".detail-quantity-input").forEach((input) => {
    if (!isInventoryShiftEnabled(input.dataset.detailField)) input.value = "";
    input.removeAttribute("title");
  });

  rows.forEach((photoRow) => {
    const target = findDetailTableRow(photoRow);
    if (!target) return;

    ["afternoon", "morning", "dawn"].forEach((field) => {
      const value = normalizePhotoQuantity(photoRow[field]);
      const input = target.querySelector(`[data-detail-field="${field}"]`);
      if (!input) return;
      if (!isInventoryShiftEnabled(field)) {
        input.value = "";
        return;
      }
      if (value !== "") {
        input.value = value;
        applied += 1;
      }
    });
  });

  updateTheoreticalInventoryStock();
  return { applied };
}

function selectedInventoryShifts() {
  return [...document.querySelectorAll("[data-inventory-shift]")]
    .filter((input) => input.checked)
    .map((input) => input.dataset.inventoryShift);
}

function firstSelectedInventoryShift() {
  const selected = new Set(selectedInventoryShifts());
  return ["dawn", "morning", "afternoon"].find((field) => selected.has(field)) || "";
}

function isInventoryShiftEnabled(field) {
  return selectedInventoryShifts().includes(field);
}

function filterInventoryTranscriptionBySelectedShifts(transcription) {
  if (!transcription?.rows?.length) return transcription || null;
  const selected = new Set(selectedInventoryShifts());
  return {
    ...transcription,
    rows: transcription.rows.map((row) => ({
      ...row,
      shiftValues: [
        selected.has("dawn") ? inventoryTranscriptionShiftValue(row, "dawn") : "",
        selected.has("morning") ? inventoryTranscriptionShiftValue(row, "morning") : "",
        selected.has("afternoon") ? inventoryTranscriptionShiftValue(row, "afternoon") : ""
      ],
      dawn: selected.has("dawn") ? row.dawn : "",
      morning: selected.has("morning") ? row.morning : "",
      afternoon: selected.has("afternoon") ? row.afternoon : "",
      turnoMadrugada: selected.has("dawn") ? row.turnoMadrugada : "",
      turnoManana: selected.has("morning") ? row.turnoManana : "",
      turnoMañana: selected.has("morning") ? row.turnoMañana : "",
      turnoTarde: selected.has("afternoon") ? row.turnoTarde : ""
    }))
  };
}

function clearDisabledInventoryShiftInputs() {
  els["inventory-detail-body"]?.querySelectorAll(".detail-quantity-input").forEach((input) => {
    if (isInventoryShiftEnabled(input.dataset.detailField)) {
      input.disabled = false;
      return;
    }
    input.disabled = true;
    input.value = "";
    input.removeAttribute("title");
  });
}

/*
  Stocks teoricos del inventario.
  Cada turno toma como inicial el ultimo turno trabajado anterior; si no hay, usa el ultimo stock guardado.
  La produccion conocida alimenta las recetas y permite estimar el consumo teorico de insumos/subproductos.
*/
