function createInventoryEntryService(dependencies) {
  const {
    backendId,
    backendIsoDate,
    backendNextNumericId,
    defaultInventoryItemName,
    ensureBackendTable,
    inventoryItemNameMap,
    isIsoDate,
    loadCache,
    logError = console.error,
    nextBusinessDayIso,
    normalizeInventoryDetailRows,
    normalizeSelectedInventoryShifts,
    readJsonBody,
    readInventoryPurchaseSnapshot,
    resolveInventoryEmployeeId,
    saveBackendCache,
    sendJson,
    storeInventoryPurchaseSnapshot,
    buildInventoryPurchaseSnapshot,
    clearInventoryPurchaseSnapshot,
    updateInventoryPurchaseConfig,
    valueBackendInventories
  } = dependencies;

  async function handleInventoryAppend(request, response) {
    const body = await readJsonBody(request);
    const date = String(body.date || "").trim();
    const employee = String(body.employee || "").trim();
    if (!isIsoDate(date)) return sendJson(response, 400, { error: "Falta una fecha valida para el inventario." });
    if (!employee) return sendJson(response, 400, { error: "Falta el empleado responsable." });

    const cache = loadCache();
    ensureBackendTable(cache.tables, "inventarios");
    const inventories = cache.tables.inventarios;
    const inventoryId = backendNextNumericId(inventories.rows, "id_inventario");
    inventories.rows.push({
      id_inventario: inventoryId,
      fecha: date,
      turno: String(body.shift || body.turno || "Tarde").trim(),
      id_empleado: resolveInventoryEmployeeId(body.employeeId || employee),
      valor_total: ""
    });
    clearInventoryPurchaseSnapshot(cache, date, [inventoryId]);
    finalizeTable(inventories);
    saveBackendCache(cache);
    return sendJson(response, 200, { ok: true, date, employee, inventoryId, backendTable: "inventarios" });
  }

  async function handleInventoryLatestDate(response) {
    const cache = loadCache();
    const lastDate = (cache.tables?.inventarios?.rows || [])
      .map((row) => backendIsoDate(row.fecha))
      .filter(Boolean)
      .sort()
      .at(-1) || "";
    return sendJson(response, 200, { lastDate, nextDate: nextBusinessDayIso(lastDate) });
  }

  async function handleInventoryFullEntry(request, response) {
    const body = await readJsonBody(request);
    const date = String(body.date || "").trim();
    const employee = String(body.employee || "").trim();
    const employeeId = resolveInventoryEmployeeId(body.employeeId || employee);
    const selectedShifts = normalizeSelectedInventoryShifts(body.selectedShifts);
    const cleanRows = normalizeInventoryDetailRows(Array.isArray(body.rows) ? body.rows : []);
    if (!isIsoDate(date)) return sendJson(response, 400, { error: "Falta una fecha valida para el inventario." });
    if (!employee) return sendJson(response, 400, { error: "Falta el empleado responsable." });
    if (!selectedShifts.length) return sendJson(response, 400, { error: "Falta indicar al menos un turno realizado." });
    if (!cleanRows.length) return sendJson(response, 400, { error: "No hay items para cargar." });

    const cache = loadCache();
    ensureBackendTable(cache.tables, "inventarios");
    ensureBackendTable(cache.tables, "detalle_inventarios");
    const inventories = cache.tables.inventarios;
    const details = cache.tables.detalle_inventarios;
    let nextInventoryId = backendNextNumericId(inventories.rows, "id_inventario");
    let nextDetailId = backendNextNumericId(details.rows, "id_detalle_inventario");
    const inventoryIds = {};
    let rowsWritten = 0;

    orderedShifts(selectedShifts).forEach((shift) => {
      const inventoryId = nextInventoryId++;
      inventoryIds[shift] = inventoryId;
      inventories.rows.push({ id_inventario: inventoryId, fecha: date, turno: shiftLabel(shift), id_empleado: employeeId, valor_total: "" });
      cleanRows.forEach((row) => {
        if (row[shift] === "") return;
        details.rows.push({
          id_detalle_inventario: nextDetailId++,
          id_inventario: inventoryId,
          id_item: row.itemId,
          cantidad: row[shift],
          costo_unitario_usado: "",
          valor_total: ""
        });
        rowsWritten += 1;
      });
    });

    valueBackendInventories(cache, Object.values(inventoryIds));
    storeInventoryPurchaseSnapshot(cache, buildInventoryPurchaseSnapshot(cache, {
      date,
      inventoryIds,
      selectedShifts,
      cleanRows
    }));
    finalizeTable(inventories);
    finalizeTable(details);
    saveBackendCache(cache);
    return sendJson(response, 200, { ok: true, date, employee, inventoryIds, rowsWritten, backendTables: ["inventarios", "detalle_inventarios"] });
  }

  async function handleInventoryDetailTemplate(response) {
    const cache = loadCache();
    const inventories = cache.tables?.inventarios?.rows || [];
    const details = cache.tables?.detalle_inventarios?.rows || [];
    const latestDate = inventories.map((row) => backendIsoDate(row.fecha)).filter(Boolean).sort().at(-1);
    if (!latestDate) return sendJson(response, 404, { error: "No hay detalle anterior para usar como plantilla." });

    const latestInventories = inventories.filter((row) => backendIsoDate(row.fecha) === latestDate);
    const shiftByInventoryId = new Map(latestInventories.map((row) => [backendId(row.id_inventario), shiftKey(row.turno)]));
    const valuesByItem = new Map();
    details.forEach((detail) => {
      const shift = shiftByInventoryId.get(backendId(detail.id_inventario));
      if (!shift) return;
      const itemId = backendId(detail.id_item);
      if (!valuesByItem.has(itemId)) valuesByItem.set(itemId, {});
      valuesByItem.get(itemId)[shift] = detail.cantidad ?? "";
    });
    const itemNames = inventoryItemNameMap();
    const rows = [...valuesByItem.entries()].map(([itemId, values]) => ({
      itemId,
      itemName: itemNames.get(itemId) || defaultInventoryItemName(itemId),
      previousAfternoon: values.afternoon ?? "",
      previousMorning: values.morning ?? "",
      previousDawn: values.dawn ?? ""
    }));
    const lastInventoryId = Math.max(...latestInventories.map((row) => Number(row.id_inventario)).filter(Number.isFinite));
    return sendJson(response, 200, { lastInventoryId, inventoryId: backendNextNumericId(inventories, "id_inventario"), rows });
  }

  async function handleInventoryPurchaseSnapshot(response) {
    const cache = loadCache();
    return sendJson(response, 200, {
      ok: true,
      snapshot: readInventoryPurchaseSnapshot(cache)
    });
  }

  async function handleInventoryPurchaseProductionRate(request, response) {
    const body = await readJsonBody(request);
    const cache = loadCache();
    try {
      const result = updateInventoryPurchaseConfig(cache, body?.barsPerDay);
      saveBackendCache(cache);
      return sendJson(response, 200, {
        ok: true,
        config: result.config,
        snapshot: result.snapshot
      });
    } catch (error) {
      if (error?.code === "INVALID_BARS_PER_DAY") {
        return sendJson(response, 400, { ok: false, error: error.message });
      }
      logError(error);
      return sendJson(response, 500, {
        ok: false,
        error: "No se pudo guardar la producción diaria. Se conserva el último valor válido."
      });
    }
  }

  async function handleInventoryDetailAppend(request, response) {
    const body = await readJsonBody(request);
    const inventoryId = Number(body.inventoryId);
    const cleanRows = normalizeInventoryDetailRows(Array.isArray(body.rows) ? body.rows : []);
    if (!Number.isInteger(inventoryId) || inventoryId <= 0) return sendJson(response, 400, { error: "Falta un Id_Inventario valido." });
    if (!cleanRows.length) return sendJson(response, 400, { error: "No hay items para cargar." });

    const cache = loadCache();
    ensureBackendTable(cache.tables, "inventarios");
    const inventories = cache.tables.inventarios;
    if (!inventories.rows.some((row) => Number(row.id_inventario) === inventoryId)) {
      return sendJson(response, 404, { error: "El inventario indicado no existe en el backend." });
    }
    ensureBackendTable(cache.tables, "detalle_inventarios");
    const details = cache.tables.detalle_inventarios;
    let nextDetailId = backendNextNumericId(details.rows, "id_detalle_inventario");
    const rowsToWrite = cleanRows.filter((row) => row.afternoon !== "");
    rowsToWrite.forEach((row) => details.rows.push({
      id_detalle_inventario: nextDetailId++,
      id_inventario: inventoryId,
      id_item: row.itemId,
      cantidad: row.afternoon,
      costo_unitario_usado: "",
      valor_total: ""
    }));
    finalizeTable(details);
    saveBackendCache(cache);
    return sendJson(response, 200, { ok: true, inventoryId, rowsWritten: rowsToWrite.length, backendTable: "detalle_inventarios" });
  }

  function finalizeTable(table) {
    table.rowCount = table.rows.length;
    table.updatedAt = new Date().toISOString();
  }

  function orderedShifts(shifts) {
    return ["dawn", "morning", "afternoon"].filter((shift) => shifts.includes(shift));
  }

  function shiftLabel(shift) {
    return { dawn: "Madrugada", morning: "Manana", afternoon: "Tarde" }[shift] || shift;
  }

  function shiftKey(value) {
    const normalized = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (normalized.includes("madrug")) return "dawn";
    if (normalized.includes("manan")) return "morning";
    if (normalized.includes("tarde")) return "afternoon";
    return "";
  }

  return {
    handleInventoryAppend,
    handleInventoryDetailAppend,
    handleInventoryDetailTemplate,
    handleInventoryFullEntry,
    handleInventoryLatestDate,
    handleInventoryPurchaseProductionRate,
    handleInventoryPurchaseSnapshot
  };
}

module.exports = { createInventoryEntryService };
