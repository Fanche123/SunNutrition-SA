function inventoryPhotoTranscriptionPrompt(items, targetDate, selectedShifts = []) {
  const targetDateHints = inventoryPhotoDateHints(targetDate).join(", ");
  const activeShiftLabels = selectedShifts.map(inventoryShiftServerLabel).join(", ") || "ninguno";
  return `
Transcribi la tabla completa de una foto de inventario y devolve SOLO JSON valido.

Items esperados, para ayudarte a matchear filas:
${JSON.stringify(items, null, 2)}

Fecha objetivo que despues se va a completar en la app:
${targetDate} (${targetDateHints})

Turnos marcados por el usuario:
${activeShiftLabels}

Objetivo:
- La foto usa el formato nuevo: una sola fecha y tres columnas fijas de turno.
- Las columnas de cantidad se llaman exactamente: Turno Madrugada, Turno Mañana y Turno Tarde.
- Transcribi cada fila con su Id, Nombre y los tres turnos.
- Devolve cada cantidad en el campo que corresponde al encabezado impreso de la columna:
  "turnoMadrugada", "turnoManana" y "turnoTarde".
- Si un turno NO esta marcado por el usuario, devolve ese turno siempre como "" aunque veas algo escrito.

Reglas:
- Matchea nombres aunque haya guiones bajos, espacios o pequenas diferencias.
- La fecha suele estar escrita arriba como d/m/aaaa. Transcribila en "dateLabel".
- La columna "Turno Madrugada" del papel va en "turnoMadrugada".
- La columna "Turno Mañana" del papel va en "turnoManana".
- La columna "Turno Tarde" del papel va en "turnoTarde".
- No corras valores hacia la izquierda: si "Turno Madrugada" esta vacio, "Turno Mañana" sigue siendo "turnoManana" y "Turno Tarde" sigue siendo "turnoTarde".
- Si en una fila la primera columna de turno esta vacia y las dos columnas de la derecha tienen datos, devolve:
  "turnoMadrugada": "", "turnoManana": valor de la columna del medio, "turnoTarde": valor de la columna derecha.
- Si la columna Turno Madrugada esta vacia, NO pongas el valor de Turno Mañana en turnoMadrugada.
- Si la columna Turno Tarde tiene datos, NO la dejes vacia ni la pongas en turnoManana.
- Si un valor es raya, vacio, ilegible o no hay nada escrito, usa string vacio.
- Una raya horizontal, guion o "----" NO ES CERO y NO ES UN NUMERO: siempre debe ser "".
- Lee cada celda de forma independiente, respetando las columnas del papel.
- No copies un dato de Mañana a Tarde ni de Tarde a Mañana.
- El numero 0 escrito a mano si es un valor valido y debe devolverse como "0".
- Transcribi fracciones como decimal, por ejemplo "5 1/2" => "5.5".
- No sumes, no promedies y no completes valores que no se ven.

Formato exacto:
{
  "format": "single_date_shifts",
  "dateLabel": "22/6/2026",
  "shiftColumns": [
    { "key": "dawn", "label": "Turno Madrugada" },
    { "key": "morning", "label": "Turno Mañana" },
    { "key": "afternoon", "label": "Turno Tarde" }
  ],
  "rows": [
    {
      "itemId": "118",
      "itemName": "Barra_Pop_140Ud",
      "turnoMadrugada": "",
      "turnoManana": "55",
      "turnoTarde": "0"
    }
  ],
  "notes": []
}
`;
}

function inventoryPhotoReviewPrompt(items, targetDate, transcription, selectedShifts = []) {
  const activeShiftLabels = selectedShifts.map(inventoryShiftServerLabel).join(", ") || "ninguno";
  return `
Revisa una transcripcion de inventario contra la foto original y devolve SOLO JSON valido corregido.

Fecha objetivo:
${targetDate}

Turnos marcados por el usuario:
${activeShiftLabels}

Items esperados:
${JSON.stringify(items, null, 2)}

Transcripcion inicial:
${JSON.stringify(transcription, null, 2)}

Formato esperado de salida:
{
  "format": "single_date_shifts",
  "dateLabel": "22/6/2026",
  "shiftColumns": [
    { "key": "dawn", "label": "Turno Madrugada" },
    { "key": "morning", "label": "Turno Mañana" },
    { "key": "afternoon", "label": "Turno Tarde" }
  ],
  "rows": [
    {
      "itemId": "118",
      "itemName": "Barra_Pop_140Ud",
      "turnoMadrugada": "",
      "turnoManana": "55",
      "turnoTarde": "0"
    }
  ],
  "uncertainCells": [
    { "itemId": "6", "field": "turnoTarde", "reason": "El numero se ve tenue o parcialmente inclinado." }
  ],
  "notes": ["Repaso automatico realizado."]
}

Reglas de revision:
- No cambies la estructura del JSON.
- Compara celda por celda contra la foto.
- Las columnas del papel son fijas y van en este orden: Turno Madrugada, Turno Mañana, Turno Tarde.
- Si un turno NO esta marcado por el usuario, dejalo siempre como "".
- Si Turno Madrugada esta vacio, dejalo vacio. No corras Turno Mañana hacia Madrugada.
- Si hay un numero visible en Turno Mañana o Turno Tarde, no lo omitas.
- El numero 0 escrito a mano es un dato valido, no es vacio.
- Si una celda esta vacia, devolve "".
- Si una celda tiene una raya, guion o marca de ausencia, devolve "".
- Revisa especialmente filas donde una columna quedo vacia pero en la foto se ve un dato manuscrito.
- Si no estas seguro de una celda, igual devolve el mejor valor posible y agregala a "uncertainCells".
- En "uncertainCells", usa field exactamente como "turnoMadrugada", "turnoManana" o "turnoTarde".
- Marca como dudosa una celda si el numero es tenue, se cruza con una linea, parece corregido, esta cortado o podria confundirse con otro valor.
- No inventes valores que no esten visibles.
`;
}

function mapTranscriptionToInventoryRows(date, items, transcription, selectedShifts = []) {
  if (transcription.format === "single_date_shifts" || Array.isArray(transcription.shiftColumns)) {
    return mapShiftTranscriptionToInventoryRows(items, transcription, selectedShifts);
  }

  if (Array.isArray(transcription.physicalColumns) && transcription.physicalColumns.length) {
    return mapPhysicalTranscriptionToInventoryRows(date, items, transcription);
  }

  const columns = Array.isArray(transcription.columns) ? transcription.columns : [];
  const transcribedRows = Array.isArray(transcription.rows) ? transcription.rows : [];
  const targetDate = inventoryTargetDateParts(date);
  const targetColumn = findTranscribedInventoryDate(targetDate, columns, transcribedRows);

  if (!targetColumn) {
    return {
      rows: [],
      notes: [`No se encontro la fecha ${date} en la transcripcion.`]
    };
  }

  const targetDateLabel = targetColumn.dateLabel;
  const subcolumnCount = Number(targetColumn.subcolumnCount) || 1;
  const mappedRows = items.map((item) => {
    const transcribedRow = findTranscribedInventoryRow(item, transcribedRows);
    const values = valuesForTranscribedDate(transcribedRow, targetDateLabel, targetDate);
    const byShift = quantitiesByShift(values, subcolumnCount);
    return {
      itemId: item.itemId,
      itemName: item.itemName,
      ...byShift
    };
  });

  return {
    rows: mappedRows,
    notes: [`Fecha detectada: ${targetDateLabel}. Subcolumnas usadas: ${subcolumnCount}.`]
  };
}

function mergeInventoryPhotoRows(firstRows, reviewedRows) {
  const reviewedByItem = new Map(reviewedRows.map((row) => [String(row.itemId), row]));
  const firstByItem = new Map(firstRows.map((row) => [String(row.itemId), row]));
  const itemIds = new Set([...firstByItem.keys(), ...reviewedByItem.keys()]);

  return [...itemIds].map((itemId) => {
    const first = firstByItem.get(itemId) || {};
    const reviewed = reviewedByItem.get(itemId) || {};
    const merged = {
      ...first,
      ...reviewed,
      itemId: reviewed.itemId || first.itemId || itemId,
      itemName: reviewed.itemName || first.itemName || "",
      uncertain: { ...(first.uncertain || {}), ...(reviewed.uncertain || {}) }
    };

    ["dawn", "morning", "afternoon"].forEach((field) => {
      const firstValue = normalizeInventoryQuantity(first[field]);
      const reviewedValue = normalizeInventoryQuantity(reviewed[field]);

      if (firstValue && !reviewedValue) {
        merged[field] = firstValue;
        merged.uncertain[field] = "El repaso dejo esta celda vacia, pero la primera lectura vio un dato.";
      } else if (!firstValue && reviewedValue) {
        merged[field] = reviewedValue;
        merged.uncertain[field] = "El dato aparecio solo en el repaso automatico.";
      } else if (firstValue && reviewedValue && firstValue !== reviewedValue) {
        merged[field] = firstValue;
        merged.uncertain[field] = `Primera lectura: ${firstValue}. Repaso: ${reviewedValue}.`;
      } else {
        merged[field] = reviewedValue || firstValue || "";
      }
    });

    return merged;
  });
}

function filterInventoryRowsBySelectedShifts(rows, selectedShifts = []) {
  return rows.map((row) => {
    const values = filterShiftValuesBySelectedShifts([row.dawn, row.morning, row.afternoon], selectedShifts);
    return {
      ...row,
      dawn: values[0],
      morning: values[1],
      afternoon: values[2],
      uncertain: filterInventoryUncertaintyBySelectedShifts(row.uncertain || {}, selectedShifts)
    };
  });
}

function filterInventoryUncertaintyBySelectedShifts(uncertain, selectedShifts = []) {
  const selected = new Set(selectedShifts);
  return Object.fromEntries(Object.entries(uncertain).filter(([field]) => selected.has(field)));
}

function findTranscribedInventoryRow(item, rows) {
  const targetId = String(item.itemId || "");
  const targetName = normalizeInventoryToken(item.itemName);
  return rows.find((row) => String(row.itemId || "") === targetId)
    || rows.find((row) => normalizeInventoryToken(row.itemName || row.name) === targetName)
    || null;
}

function normalizeInventoryPhotoTranscription(transcription, selectedShifts = []) {
  const normalized = transcription && typeof transcription === "object" ? transcription : {};
  const physicalColumns = Array.isArray(normalized.physicalColumns) ? normalized.physicalColumns : [];
  const rows = Array.isArray(normalized.rows) ? normalized.rows : [];

  normalized.rows = rows.map((row) => {
    const valuesByColumn = { ...(row.valuesByColumn || {}) };
    const shiftValues = filterShiftValuesBySelectedShifts(normalizeSingleDateShiftValues(row), selectedShifts);
    physicalColumns.forEach((column) => {
      const key = column.key;
      if (!key) return;
      valuesByColumn[key] = normalizeInventoryQuantity(valuesByColumn[key]);
    });

    return {
      ...row,
      shiftValues,
      dawn: shiftValues[0],
      morning: shiftValues[1],
      afternoon: shiftValues[2],
      valuesByColumn
    };
  });

  return normalized;
}

function mapShiftTranscriptionToInventoryRows(items, transcription, selectedShifts = []) {
  const transcribedRows = Array.isArray(transcription.rows) ? transcription.rows : [];
  const shiftCorrection = detectNewInventoryShiftCorrection(transcribedRows, selectedShifts);
  const uncertainByItem = inventoryUncertaintyByItem(transcription.uncertainCells || [], shiftCorrection);
  const mappedRows = items.map((item) => {
    const transcribedRow = findTranscribedInventoryRow(item, transcribedRows);
    const rawShiftValues = inventoryShiftValues(transcribedRow);
    const shiftValues = filterShiftValuesBySelectedShifts(applyNewInventoryShiftCorrection(rawShiftValues, shiftCorrection), selectedShifts);
    const values = {
      dawn: shiftValues[0],
      morning: shiftValues[1],
      afternoon: shiftValues[2]
    };

    return {
      itemId: item.itemId,
      itemName: item.itemName,
      uncertain: uncertainByItem.get(String(item.itemId)) || {},
      ...values
    };
  });

  return {
    rows: mappedRows,
    notes: [
      shiftCorrection === "dawn_is_morning"
        ? "Chequeo automatico: se detecto que Mañana fue leida como Madrugada. Se reacomodo como Madrugada vacia, Mañana y Tarde."
        : "Turnos leidos por encabezado y respetados."
    ]
  };
}

function inventoryUncertaintyByItem(cells, shiftCorrection) {
  const byItem = new Map();
  if (!Array.isArray(cells)) return byItem;

  cells.forEach((cell) => {
    const itemId = String(cell.itemId || "").trim();
    const field = correctedInventoryUncertaintyField(cell.field, shiftCorrection);
    if (!itemId || !field) return;
    const current = byItem.get(itemId) || {};
    current[field] = String(cell.reason || "Dato a revisar.");
    byItem.set(itemId, current);
  });

  return byItem;
}

function correctedInventoryUncertaintyField(field, shiftCorrection) {
  const normalized = normalizeInventoryToken(field);
  const mapped = {
    turnomadrugada: "dawn",
    madrugada: "dawn",
    dawn: "dawn",
    turnomanana: "morning",
    turnomananã: "morning",
    manana: "morning",
    mananã: "morning",
    mañana: "morning",
    morning: "morning",
    turnotarde: "afternoon",
    tarde: "afternoon",
    afternoon: "afternoon"
  }[normalized];

  if (shiftCorrection !== "dawn_is_morning") return mapped || "";
  if (mapped === "dawn") return "morning";
  if (mapped === "morning" || mapped === "afternoon") return "afternoon";
  return "";
}

function detectNewInventoryShiftCorrection(rows, selectedShifts = []) {
  if (selectedShifts.length) return "";
  const usableRows = rows
    .map(inventoryShiftValues)
    .filter((values) => values.some((value) => value !== ""));

  if (!usableRows.length) return "";

  const dawnUsedRows = usableRows.filter((values) => values[0] !== "").length;
  const morningUsedRows = usableRows.filter((values) => values[1] !== "").length;
  const afternoonUsedRows = usableRows.filter((values) => values[2] !== "").length;
  const likelyMorningAndAfternoonRows = usableRows.filter((values) =>
    values[0] !== "" && (values[1] !== "" || values[2] !== "")
  ).length;

  if (
    dawnUsedRows >= Math.max(3, usableRows.length * 0.6)
    && likelyMorningAndAfternoonRows >= Math.max(3, usableRows.length * 0.6)
    && morningUsedRows + afternoonUsedRows >= dawnUsedRows
  ) {
    return "dawn_is_morning";
  }

  return "";
}

function applyNewInventoryShiftCorrection(values, correction) {
  if (correction !== "dawn_is_morning") return values;
  return [
    "",
    values[0] || "",
    values[2] || values[1] || ""
  ];
}

function filterShiftValuesBySelectedShifts(values, selectedShifts = []) {
  const selected = new Set(selectedShifts);
  const cleanValues = [0, 1, 2].map((index) => normalizeInventoryQuantity(values?.[index]));
  const corrected = [...cleanValues];

  if (!selected.has("dawn") && selected.has("morning") && selected.has("afternoon") && corrected[0]) {
    corrected[2] = corrected[2] || corrected[1];
    corrected[1] = corrected[0];
  } else if (!selected.has("dawn") && selected.has("morning") && corrected[0] && !corrected[1]) {
    corrected[1] = corrected[0];
  }

  if (!selected.has("morning") && selected.has("afternoon") && corrected[1] && !corrected[2]) {
    corrected[2] = corrected[1];
  }

  return [
    selected.has("dawn") ? corrected[0] : "",
    selected.has("morning") ? corrected[1] : "",
    selected.has("afternoon") ? corrected[2] : ""
  ];
}

function normalizeSingleDateShiftValues(row) {
  const explicitValues = [
    normalizeInventoryQuantity(row?.turnoMadrugada ?? row?.madrugada ?? row?.dawn),
    normalizeInventoryQuantity(row?.turnoManana ?? row?.turnoMañana ?? row?.manana ?? row?.mañana ?? row?.morning),
    normalizeInventoryQuantity(row?.turnoTarde ?? row?.tarde ?? row?.afternoon)
  ];

  if (explicitValues.some((value) => value !== "")) {
    return explicitValues;
  }

  if (Array.isArray(row?.shiftValues) && row.shiftValues.length >= 3) {
    return [0, 1, 2].map((index) => normalizeInventoryQuantity(row.shiftValues[index]));
  }

  return ["", "", ""];
}

function inventoryShiftValues(row) {
  if (!row) return ["", "", ""];
  if (Array.isArray(row.shiftValues)) {
    return [0, 1, 2].map((index) => normalizeInventoryQuantity(row.shiftValues[index]));
  }
  return [
    normalizeInventoryQuantity(row.dawn),
    normalizeInventoryQuantity(row.morning),
    normalizeInventoryQuantity(row.afternoon)
  ];
}

function mapPhysicalTranscriptionToInventoryRows(date, items, transcription) {
  const targetDate = inventoryTargetDateParts(date);
  const physicalColumns = transcription.physicalColumns
    .filter((column) => inventoryDateLabelMatches(column.dateLabel, targetDate));

  if (!physicalColumns.length) {
    return {
      rows: [],
      notes: [`No se encontro la fecha ${date} en la transcripcion por columnas.`]
    };
  }

  const transcribedRows = Array.isArray(transcription.rows) ? transcription.rows : [];
  const mappedRows = items.map((item) => {
    const transcribedRow = findTranscribedInventoryRow(item, transcribedRows);
    const values = physicalColumns.map((column) => valueForPhysicalColumn(transcribedRow, column.key));
    const byShift = quantitiesByShift(values, physicalColumns.length);
    return {
      itemId: item.itemId,
      itemName: item.itemName,
      ...byShift
    };
  });

  return {
    rows: mappedRows,
    notes: [`Fecha detectada: ${physicalColumns[0].dateLabel}. Columnas fisicas usadas: ${physicalColumns.length}.`]
  };
}

function valueForPhysicalColumn(row, columnKey) {
  if (!row?.valuesByColumn || typeof row.valuesByColumn !== "object") return "";
  return row.valuesByColumn[columnKey] ?? "";
}

function valuesForTranscribedDate(row, targetDateLabel, targetDate) {
  if (!row?.valuesByDate || typeof row.valuesByDate !== "object") return [];
  const entry = Object.entries(row.valuesByDate)
    .find(([label]) => normalizeInventoryToken(label) === normalizeInventoryToken(targetDateLabel)
      || inventoryDateLabelMatches(label, targetDate));
  return Array.isArray(entry?.[1]) ? entry[1] : [];
}

function quantitiesByShift(values, subcolumnCount) {
  const cleanValues = values.map(normalizeInventoryQuantity);
  if (subcolumnCount >= 3) {
    return {
      dawn: cleanValues[0] || "",
      morning: cleanValues[1] || "",
      afternoon: cleanValues[2] || ""
    };
  }
  if (subcolumnCount === 2) {
    return {
      dawn: "",
      morning: cleanValues[0] || "",
      afternoon: cleanValues[1] || ""
    };
  }
  return {
    dawn: "",
    morning: "",
    afternoon: cleanValues[0] || ""
  };
}

function normalizeInventoryQuantity(value) {
  const text = String(value ?? "").trim().replace(",", ".");
  if (!text || /^[-—–_]+$/.test(text)) return "";
  return text;
}

function normalizeInventoryToken(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_\s-]+/g, "")
    .replace(/[^a-z0-9/]/g, "");
}

function findTranscribedInventoryDate(targetDate, columns, rows) {
  const columnMatch = columns.find((column) => inventoryDateLabelMatches(column.dateLabel, targetDate));
  if (columnMatch) return columnMatch;

  for (const row of rows) {
    if (!row?.valuesByDate || typeof row.valuesByDate !== "object") continue;
    const match = Object.entries(row.valuesByDate)
      .find(([label]) => inventoryDateLabelMatches(label, targetDate));
    if (match) {
      const values = Array.isArray(match[1]) ? match[1] : [];
      return {
        dateLabel: match[0],
        subcolumnCount: values.length || 1
      };
    }
  }

  return null;
}

function inventoryTargetDateParts(date) {
  const [year, month, day] = String(date || "").split("-").map(Number);
  return {
    day,
    month,
    year
  };
}

function inventoryDateLabelMatches(label, targetDate) {
  const parts = parseInventoryDateLabel(label, targetDate.year);
  if (!parts) return false;
  if (parts.day !== targetDate.day || parts.month !== targetDate.month) return false;
  return !parts.year || parts.year === targetDate.year;
}

function parseInventoryDateLabel(label, fallbackYear) {
  const text = String(label || "").trim();
  const numbers = text.match(/\d+/g) || [];
  if (numbers.length >= 2) {
    return {
      day: Number(numbers[0]),
      month: Number(numbers[1]),
      year: normalizeInventoryYear(numbers[2], fallbackYear)
    };
  }

  const compact = text.replace(/\D/g, "");
  if (compact.length === 6) {
    return {
      day: Number(compact.slice(0, 2)),
      month: Number(compact.slice(2, 4)),
      year: normalizeInventoryYear(compact.slice(4, 6), fallbackYear)
    };
  }
  if (compact.length === 8) {
    return {
      day: Number(compact.slice(0, 2)),
      month: Number(compact.slice(2, 4)),
      year: normalizeInventoryYear(compact.slice(4, 8), fallbackYear)
    };
  }

  return null;
}

function normalizeInventoryYear(value, fallbackYear) {
  if (value === undefined || value === null || value === "") return fallbackYear;
  const year = Number(value);
  if (!Number.isFinite(year)) return fallbackYear;
  return year < 100 ? 2000 + year : year;
}

function inventoryPhotoDateHints(date) {
  const [year, month, day] = date.split("-");
  const shortYear = year.slice(2);
  return [
    `${Number(day)}/${Number(month)}/${shortYear}`,
    `${Number(day)}/${Number(month)}/${year}`,
    `${day}/${month}/${shortYear}`,
    `${day}/${month}/${year}`
  ];
}

module.exports = { filterInventoryRowsBySelectedShifts, inventoryPhotoReviewPrompt, inventoryPhotoTranscriptionPrompt, mapTranscriptionToInventoryRows, mergeInventoryPhotoRows, normalizeInventoryPhotoTranscription, normalizeInventoryToken };
