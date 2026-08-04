function createInventoryPhotoService(dependencies) {
  const { cleanBackendInput, filterInventoryRowsBySelectedShifts, inventoryPhotoReviewPrompt, inventoryPhotoTranscriptionPrompt, isIsoDate, loadCache, mapTranscriptionToInventoryRows, mergeInventoryPhotoRows, normalizeInventoryPhotoTranscription, normalizeInventoryToken, readJsonBody, sendJson } = dependencies;

  async function handleInventoryDetailPhoto(request, response) {
    const body = await readJsonBody(request);
    const date = String(body.date || "").trim();
    const imageDataUrl = String(body.imageDataUrl || "");
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const selectedShifts = normalizeSelectedInventoryShifts(body.selectedShifts);
  
    if (!isIsoDate(date)) {
      sendJson(response, 400, { error: "Falta una fecha valida para leer la foto." });
      return;
    }
  
    if (!imageDataUrl.startsWith("data:image/")) {
      sendJson(response, 400, { error: "Falta una imagen valida." });
      return;
    }
  
    if (!rows.length) {
      sendJson(response, 400, { error: "Primero hay que preparar el detalle." });
      return;
    }
  
    try {
      const extracted = await extractInventoryFromPhoto({ date, imageDataUrl, rows, selectedShifts });
      sendJson(response, 200, extracted);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
  }
  
  function inventoryItemNameMap() {
    const cache = loadCache();
    const names = new Map([
      ["0", "Contador Alipack"],
      ["3", "Barra_Pop"],
      ["4", "Granel Dulce"]
    ]);
  
    (cache.tables?.productos?.rows || []).forEach((row) => {
      const itemId = cleanBackendInput(row.id_item);
      const name = cleanBackendInput(row.nombre_producto);
      if (itemId && name) names.set(itemId, name);
    });
  
    const items = new Map((cache.tables?.items?.rows || []).map((row) => [
      cleanBackendInput(row.id_item),
      {
        originType: cleanBackendInput(row.origen_tipo).toLowerCase(),
        originId: cleanBackendInput(row.id_origen)
      }
    ]));
    const insumos = new Map((cache.tables?.insumos?.rows || []).map((row) => [
      cleanBackendInput(row.id_insumo),
      cleanBackendInput(row.nombre)
    ]));
  
    items.forEach((item, itemId) => {
      if (!itemId || names.has(itemId)) return;
      if (item.originType === "insumo" && insumos.has(item.originId)) {
        names.set(itemId, insumos.get(item.originId));
      }
    });
  
    return names;
  }
  
  function defaultInventoryItemName(itemId) {
    return itemId ? `Item ${itemId}` : "";
  }
  
  function resolveInventoryEmployeeId(value) {
    const text = cleanBackendInput(value);
    if (!text) return "";
    if (/^\d+$/.test(text)) return text;
  
    const target = normalizeInventoryToken(text);
    const employee = (loadCache().tables?.empleados?.rows || []).find((row) =>
      normalizeInventoryToken(row.nombre_empleado || row.nombre || "") === target
    );
    return cleanBackendInput(employee?.id_empleado) || text;
  }
  
  function normalizeInventoryDetailRows(rows) {
    return rows
      .map((row) => ({
        itemId: String(row.itemId || "").trim(),
        afternoon: cleanBackendInput(row.afternoon),
        morning: cleanBackendInput(row.morning),
        dawn: cleanBackendInput(row.dawn)
      }))
      .filter((row) => row.itemId);
  }
  
  function normalizeSelectedInventoryShifts(value) {
    const allowed = new Set(["dawn", "morning", "afternoon"]);
    return (Array.isArray(value) ? value : [])
      .map((shift) => String(shift || "").trim())
      .filter((shift, index, shifts) => allowed.has(shift) && shifts.indexOf(shift) === index);
  }
  
  function inventoryShiftServerLabel(shift) {
    return {
      dawn: "Turno Madrugada",
      morning: "Turno Mañana",
      afternoon: "Turno Tarde"
    }[shift] || shift;
  }
  
  async function extractInventoryFromPhoto({ date, imageDataUrl, rows, selectedShifts = [] }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("Falta configurar OPENAI_API_KEY en el backend para leer fotos.");
    }
  
    const items = rows.map((row) => ({
      itemId: String(row.itemId || ""),
      itemName: String(row.itemName || "")
    }));
    const firstPassTranscription = await transcribeInventoryPhoto(apiKey, imageDataUrl, items, date, selectedShifts);
    const reviewedTranscription = await reviewInventoryPhotoTranscription(apiKey, imageDataUrl, items, date, firstPassTranscription, selectedShifts);
    const firstTranscription = normalizeInventoryPhotoTranscription(firstPassTranscription, selectedShifts);
    const transcription = normalizeInventoryPhotoTranscription(reviewedTranscription, selectedShifts);
    const firstMappedRows = mapTranscriptionToInventoryRows(date, items, firstTranscription, selectedShifts).rows;
    const reviewedMapped = mapTranscriptionToInventoryRows(date, items, transcription, selectedShifts);
    const mappedRows = {
      ...reviewedMapped,
      rows: filterInventoryRowsBySelectedShifts(mergeInventoryPhotoRows(firstMappedRows, reviewedMapped.rows), selectedShifts)
    };
  
    return {
      rows: mappedRows.rows,
      notes: [
        ...(Array.isArray(transcription.notes) ? transcription.notes : []),
        "Comparado contra primera lectura; diferencias marcadas en naranja.",
        ...mappedRows.notes
      ],
      transcription
    };
  }
  
  async function transcribeInventoryPhoto(apiKey, imageDataUrl, items, date, selectedShifts = []) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: inventoryPhotoTranscriptionPrompt(items, date, selectedShifts)
              },
              {
                type: "image_url",
                image_url: { url: imageDataUrl, detail: "high" }
              }
            ]
          }
        ]
      })
    });
    const payload = await response.json().catch(() => ({}));
  
    if (!response.ok) {
      throw new Error(payload.error?.message || "OpenAI no pudo leer la foto.");
    }
  
    const content = payload.choices?.[0]?.message?.content || "{}";
    return JSON.parse(content);
  }
  
  async function reviewInventoryPhotoTranscription(apiKey, imageDataUrl, items, date, transcription, selectedShifts = []) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: inventoryPhotoReviewPrompt(items, date, transcription, selectedShifts)
              },
              {
                type: "image_url",
                image_url: { url: imageDataUrl, detail: "high" }
              }
            ]
          }
        ]
      })
    });
    const payload = await response.json().catch(() => ({}));
  
    if (!response.ok) {
      throw new Error(payload.error?.message || "OpenAI no pudo repasar la lectura de la foto.");
    }
  
    const content = payload.choices?.[0]?.message?.content || "{}";
    return JSON.parse(content);
  }

  return { defaultInventoryItemName, handleInventoryDetailPhoto, inventoryItemNameMap, normalizeInventoryDetailRows, normalizeSelectedInventoryShifts, resolveInventoryEmployeeId };
}

module.exports = { createInventoryPhotoService };
