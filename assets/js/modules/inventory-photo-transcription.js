function renderInventoryPhotoTranscription(transcription) {
  const panel = els["inventory-photo-transcription"];
  if (!panel) return;

  if (!transcription) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }

  const columns = inventoryTranscriptionColumns(transcription);
  const rows = Array.isArray(transcription.rows) ? transcription.rows : [];

  panel.hidden = false;
  panel.innerHTML = `
    <div class="photo-transcription-header">
      <div>
        <h3>Tabla transcripta desde la foto</h3>
        <span>Valores leídos antes de aplicar la fecha seleccionada</span>
      </div>
      <span>${rows.length} filas · ${columns.length} columnas físicas</span>
    </div>
    <div class="table-wrap">
      <table class="data-entry-table photo-transcription-table">
        <thead>
          <tr>
            <th>Id Item</th>
            <th>Nombre Item</th>
            ${columns.map((column) => `
              <th class="num">
                ${escapeHtml(column.dateLabel)}
                <span>${column.shift ? "" : column.physical ? escapeHtml(column.key) : `${column.subcolumnCount} col.`}</span>
              </th>
            `).join("")}
          </tr>
        </thead>
        <tbody>
          ${rows.length && columns.length
            ? rows.map((row) => inventoryTranscriptionRow(row, columns)).join("")
            : emptyRow(Math.max(columns.length + 2, 3), "La foto no devolvió filas transcritas.")}
        </tbody>
      </table>
    </div>
  `;
}

function inventoryTranscriptionColumns(transcription) {
  if (transcription.format === "single_date_shifts" || Array.isArray(transcription.shiftColumns)) {
    return [
      { key: "dawn", dateLabel: "Turno Madrugada", shift: true },
      { key: "morning", dateLabel: "Turno Mañana", shift: true },
      { key: "afternoon", dateLabel: "Turno Tarde", shift: true }
    ];
  }

  if (Array.isArray(transcription.physicalColumns) && transcription.physicalColumns.length) {
    return transcription.physicalColumns.map((column, index) => ({
      key: column.key || `c${index + 1}`,
      dateLabel: column.dateLabel || `Col. ${index + 1}`,
      subcolumnCount: 1,
      physical: true
    }));
  }

  const byLabel = new Map();
  (Array.isArray(transcription.columns) ? transcription.columns : []).forEach((column) => {
    const label = String(column.dateLabel || "").trim();
    if (!label) return;
    byLabel.set(label, {
      dateLabel: label,
      subcolumnCount: Number(column.subcolumnCount) || 1
    });
  });

  (Array.isArray(transcription.rows) ? transcription.rows : []).forEach((row) => {
    Object.entries(row.valuesByDate || {}).forEach(([label, values]) => {
      const cleanLabel = String(label || "").trim();
      if (!cleanLabel || byLabel.has(cleanLabel)) return;
      byLabel.set(cleanLabel, {
        dateLabel: cleanLabel,
        subcolumnCount: Array.isArray(values) ? values.length : 1
      });
    });
  });

  return [...byLabel.values()];
}

function inventoryTranscriptionRow(row, columns) {
  return `
    <tr>
      <td>${escapeHtml(row.itemId || "")}</td>
      <td>${escapeHtml(row.itemName || row.name || "")}</td>
      ${columns.map((column) => {
        const values = column.shift
          ? [inventoryTranscriptionShiftValue(row, column.key)]
          : column.physical
          ? [inventoryTranscriptionColumnValue(row, column.key)]
          : inventoryTranscriptionValues(row, column.dateLabel);
        return `<td class="num">${escapeHtml(values.join(" | "))}</td>`;
      }).join("")}
    </tr>
  `;
}

function inventoryTranscriptionShiftValue(row, shiftKey) {
  const indexByShift = { dawn: 0, morning: 1, afternoon: 2 };
  if (Array.isArray(row?.shiftValues)) {
    return String(row.shiftValues[indexByShift[shiftKey]] ?? "");
  }
  return String(row?.[shiftKey] ?? "");
}

function inventoryTranscriptionColumnValue(row, columnKey) {
  if (!row?.valuesByColumn || typeof row.valuesByColumn !== "object") return "";
  return String(row.valuesByColumn[columnKey] ?? "");
}

function inventoryTranscriptionValues(row, dateLabel) {
  const valuesByDate = row.valuesByDate || {};
  const entry = Object.entries(valuesByDate)
    .find(([label]) => normalizeSearchText(label) === normalizeSearchText(dateLabel));
  return Array.isArray(entry?.[1]) ? entry[1].map((value) => String(value ?? "")) : [];
}

function findDetailTableRow(photoRow) {
  const itemId = String(photoRow.itemId || "").trim();
  if (itemId) {
    const byId = els["inventory-detail-body"].querySelector(`tr[data-item-id="${CSS.escape(itemId)}"]`);
    if (byId) return byId;
  }

  const photoName = normalizeSearchText(photoRow.itemName || photoRow.name || "");
  if (!photoName) return null;

  return [...els["inventory-detail-body"].querySelectorAll("tr[data-item-id]")]
    .find((row) => normalizeSearchText(row.children[2]?.textContent || "") === photoName) || null;
}

function normalizePhotoQuantity(value) {
  const text = String(value ?? "").trim().replace(",", ".");
  if (!text || text === "-" || text === "—") return "";
  return text;
}

async function imageFileToDataUrl(file) {
  const dataUrl = await fileToDataUrl(file);
  const image = await loadImage(dataUrl);
  const maxSide = 2400;
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.92);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

