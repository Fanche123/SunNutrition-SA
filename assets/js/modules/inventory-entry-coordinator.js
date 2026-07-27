function setupInventoryPhotoDropZone() {
  setupFileDropZone({
    dropZone: els["inventory-photo-drop-zone"],
    input: els["inventory-photo-input"],
    acceptFile: (candidate) => candidate.type.startsWith("image/"),
    onAccepted: (file) => {
      updateInventoryPhotoFileChip();
      setInventoryDetailStatus(`Foto lista: ${file.name}`, "success");
    },
    onRejected: () => setInventoryDetailStatus("Arrastra una imagen valida para leer el inventario.", "error")
  });
}

function updateInventoryPhotoFileChip() {
  const file = els["inventory-photo-input"]?.files?.[0];
  if (!els["inventory-photo-file-chip"]) return;

  els["inventory-photo-file-chip"].classList.toggle("is-empty", !file);
  els["inventory-photo-file-name"].textContent = file ? file.name : "Sin archivo";
  els["inventory-photo-file-size"].textContent = file ? formatFileSize(file.size) : "-";
}

function clearInventoryPhotoFile() {
  if (!els["inventory-photo-input"]) return;
  els["inventory-photo-input"].value = "";
  updateInventoryPhotoFileChip();
  setInventoryDetailStatus("", "");
}

function initializeInventoryEntryDefaults({ force = false } = {}) {
  setInventoryDefaultDateFromLatestStock({ force });

  if (els["inventory-employee-input"] && (force || !els["inventory-employee-input"].value.trim())) {
    els["inventory-employee-input"].value = "Alcaraz_Pablo_Nicolas";
  }

  const dawn = document.querySelector('[data-inventory-shift="dawn"]');
  const morning = document.querySelector('[data-inventory-shift="morning"]');
  const afternoon = document.querySelector('[data-inventory-shift="afternoon"]');
  if (dawn && (force || !dawn.checked)) dawn.checked = false;
  if (morning && (force || !morning.checked)) morning.checked = true;
  if (afternoon && (force || !afternoon.checked)) afternoon.checked = true;
}

function setInventoryDefaultDateFromLatestStock({ force = false } = {}) {
  if (!els["inventory-date-input"]) return false;
  const nextDate = nextBusinessDayAfterLastInventory();
  if (!force && els["inventory-date-input"].value) return false;
  const changed = els["inventory-date-input"].value !== nextDate;
  els["inventory-date-input"].value = nextDate;
  return changed;
}

async function refreshInventoryDefaultDateFromBackend({ force = true } = {}) {
  if (!els["inventory-date-input"]) return false;
  if (!force && els["inventory-date-input"].value) return false;

  const response = await fetch(`${API_BASE_URL}/api/inventory/latest-date`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.nextDate) {
    throw new Error(payload.error || "No se pudo obtener la proxima fecha de inventario.");
  }

  const changed = els["inventory-date-input"].value !== payload.nextDate;
  els["inventory-date-input"].value = payload.nextDate;
  return changed;
}

function nextBusinessDayAfterLastInventory() {
  const lastIso = state.inventory
    .map((row) => row.date)
    .filter(Boolean)
    .sort()
    .at(-1);

  const date = lastIso ? dateFromIso(lastIso) : new Date();
  if (lastIso) date.setDate(date.getDate() + 1);
  while ([0, 6].includes(date.getDay())) {
    date.setDate(date.getDate() + 1);
  }
  return toIsoDate(date);
}

function setInventoryDetailStatus(message, status) {
  const element = els["inventory-detail-status"];
  element.textContent = message;
  element.dataset.status = status;
}
