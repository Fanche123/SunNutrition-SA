const crypto = require("node:crypto");
const { individualUnits } = require("../../shared/order-pricing");

const INVENTORY_ENTRY_OPERATIONS_KEY = "_inventoryFullEntryOperations";
const MAX_INVENTORY_ENTRY_OPERATIONS = 500;
const INVENTORY_ALIPACK_COUNTERS_TABLE = "contadores_alipack";

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
    evaluateInventoryPurchaseSnapshot,
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
      valor_total: 0
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
    try {
      const body = await readJsonBody(request);
      const date = String(body.date || "").trim();
      const employee = String(body.employee || "").trim();
      const employeeId = resolveInventoryEmployeeId(body.employeeId || employee);
      const selectedShifts = normalizeSelectedInventoryShifts(body.selectedShifts);
      const itemNames = inventoryItemNameMap();
      const cleanRows = normalizeInventoryDetailRows(Array.isArray(body.rows) ? body.rows : [])
        .filter((row) => !isAlipackCounterName(itemNames.get(backendId(row.itemId))));
      if (!isIsoDate(date)) return sendJson(response, 400, { error: "Falta una fecha valida para el inventario." });
      if (!employee) return sendJson(response, 400, { error: "Falta el empleado responsable." });
      if (!selectedShifts.length) return sendJson(response, 400, { error: "Falta indicar al menos un turno realizado." });
      if (!cleanRows.length) return sendJson(response, 400, { error: "No hay items para cargar." });
      const normalizedCounters = normalizeInventoryAlipackCounters(body.counters, selectedShifts);
      if (normalizedCounters.error) {
        return sendJson(response, 400, {
          ok: false,
          code: "INVALID_ALIPACK_COUNTER",
          error: normalizedCounters.error
        });
      }
      const counters = normalizedCounters.values;

      // La transaccion trabaja sobre una copia. Valuacion, snapshot y metadatos deben
      // completarse antes del unico reemplazo atomico del cache persistido.
      const cache = cloneInventoryTransactionCache(loadCache());
      const operationKey = inventoryFullEntryOperationKey({ date, employeeId, selectedShifts, cleanRows, counters });
      const previousOperation = inventoryFullEntryOperation(cache, operationKey);
      if (previousOperation) {
        return sendJson(response, 200, {
          ...previousOperation.result,
          ok: true,
          idempotent: true
        });
      }

      ensureBackendTable(cache.tables, "inventarios");
      ensureBackendTable(cache.tables, "detalle_inventarios");
      const inventories = cache.tables.inventarios;
      const details = cache.tables.detalle_inventarios;
      const alipackCounters = cache.tables[INVENTORY_ALIPACK_COUNTERS_TABLE];
      if (!alipackCounters || !Array.isArray(alipackCounters.rows)) {
        throw inventoryAlipackMigrationRequiredError();
      }
      assertInventoryAlipackCounterIntegrity(cache);
      let nextInventoryId = backendNextNumericId(inventories.rows, "id_inventario");
      let nextDetailId = backendNextNumericId(details.rows, "id_detalle_inventario");
      let nextCounterId = backendNextNumericId(alipackCounters.rows, "id_contador_alipack");
      const inventoryIds = {};
      let rowsWritten = 0;
      let countersWritten = 0;

      orderedShifts(selectedShifts).forEach((shift) => {
        const inventoryId = nextInventoryId++;
        inventoryIds[shift] = inventoryId;
        inventories.rows.push({ id_inventario: inventoryId, fecha: date, turno: shiftLabel(shift), id_empleado: employeeId, valor_total: "" });
        if (counters[shift] !== "") {
          alipackCounters.rows.push({
            id_contador_alipack: nextCounterId++,
            id_inventario: inventoryId,
            valor_contador: counters[shift]
          });
          countersWritten += 1;
        }
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

      const valuation = valueBackendInventories(cache, Object.values(inventoryIds), {
        allowStoredDetailCostFallback: false
      });
      assertCompleteInventoryValuation(valuation);
      storeInventoryPurchaseSnapshot(cache, buildInventoryPurchaseSnapshot(cache, {
        date,
        inventoryIds,
        selectedShifts,
        cleanRows
      }));
      finalizeTable(inventories);
      finalizeTable(details);
      finalizeTable(alipackCounters);
      assertInventoryAlipackCounterIntegrity(cache);
      const result = {
        date,
        employee,
        inventoryIds,
        rowsWritten,
        countersWritten,
        backendTables: ["inventarios", "detalle_inventarios", INVENTORY_ALIPACK_COUNTERS_TABLE]
      };
      storeInventoryFullEntryOperation(cache, operationKey, result);
      saveBackendCache(cache);
      return sendJson(response, 200, { ok: true, idempotent: false, ...result });
    } catch (error) {
      const requestId = String(request?.auditRequestId || "untracked").trim();
      logError(`[INVENTORY_FULL_ENTRY_FAILED] requestId=${requestId}\n${error?.stack || error}`);
      const valuationRejected = ["INVENTORY_COST_UNAVAILABLE", "INVENTORY_NEGATIVE_QUANTITY"].includes(error?.code);
      const migrationRequired = error?.code === "INVENTORY_ALIPACK_MIGRATION_REQUIRED";
      return sendJson(response, migrationRequired ? 503 : valuationRejected ? 422 : 500, {
        ok: false,
        code: migrationRequired ? error.code : valuationRejected ? error.code : "INVENTORY_FULL_ENTRY_FAILED",
        requestId,
        error: migrationRequired
          ? error.message
          : valuationRejected
          ? `${error.message} No se realizo ningun cambio; revisa costos, unidades y cantidades antes de reintentar.`
          : "No se pudo guardar el inventario. No se realizo ningun cambio y las cantidades del formulario se conservaron."
      });
    }
  }

  async function handleInventoryDetailTemplate(response) {
    const cache = cloneInventoryTransactionCache(loadCache());
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
    const rows = [...valuesByItem.entries()]
      .map(([itemId, values]) => ({
        itemId,
        itemName: itemNames.get(itemId) || defaultInventoryItemName(itemId),
        previousAfternoon: values.afternoon ?? "",
        previousMorning: values.morning ?? "",
        previousDawn: values.dawn ?? ""
      }))
      .filter((row) => !isAlipackCounterName(row.itemName));
    const lastInventoryId = Math.max(...latestInventories.map((row) => Number(row.id_inventario)).filter(Number.isFinite));
    return sendJson(response, 200, {
      lastInventoryId,
      inventoryId: backendNextNumericId(inventories, "id_inventario"),
      rows,
      salesExits: inventoryDeliveryExits(cache),
      receptionEntries: inventoryReceptionEntries(cache)
    });
  }

  async function handleInventoryPurchaseSnapshot(response) {
    const cache = loadCache();
    return sendJson(response, 200, {
      ok: true,
      snapshot: readInventoryPurchaseSnapshot(cache)
    });
  }

  async function handleInventoryPurchaseDraft(request, response) {
    const body = await readJsonBody(request);
    const date = String(body.date || "").trim();
    const selectedShifts = normalizeSelectedInventoryShifts(body.selectedShifts);
    const cleanRows = normalizeInventoryDetailRows(Array.isArray(body.rows) ? body.rows : []);
    if (!isIsoDate(date)) return sendJson(response, 400, { error: "Falta una fecha valida para evaluar el borrador." });
    if (!selectedShifts.length) return sendJson(response, 400, { error: "Falta indicar el turno final del borrador." });
    if (!cleanRows.length) return sendJson(response, 400, { error: "No hay items preparados para evaluar." });

    const finalShift = orderedShifts(selectedShifts).at(-1);
    const snapshot = evaluateInventoryPurchaseSnapshot(loadCache(), {
      date,
      inventoryIds: {},
      selectedShifts: [finalShift],
      cleanRows
    }, {
      source: "draft",
      tolerateCalendarErrors: false,
      allowPreviousStockFallback: false
    });
    return sendJson(response, 200, { ok: true, snapshot });
  }

  async function handleInventoryPurchaseProductionRate(request, response) {
    const body = await readJsonBody(request);
    const cache = loadCache();
    try {
      const result = updateInventoryPurchaseConfig(cache, body?.barsPerDay);
      saveBackendCache(cache);
      request.auditSummary = {
        action: "update",
        module: "inventory",
        entity: "inventoryPurchaseConfig",
        recordId: "barsPerDay",
        fields: ["barsPerDay"]
      };
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
    const valuation = valueBackendInventories(cache, [inventoryId], {
      allowStoredDetailCostFallback: false
    });
    assertCompleteInventoryValuation(valuation);
    finalizeTable(inventories);
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
    handleInventoryPurchaseDraft,
    handleInventoryPurchaseProductionRate,
    handleInventoryPurchaseSnapshot
  };
}

function cloneInventoryTransactionCache(cache) {
  return JSON.parse(JSON.stringify(cache));
}

function assertCompleteInventoryValuation(result) {
  const missingCosts = (result?.issues || []).filter((issue) => issue.code === "MISSING_COST");
  const invalidQuantities = (result?.issues || []).filter((issue) => (
    issue.code === "NEGATIVE_QUANTITY" || issue.code === "INVALID_QUANTITY"
  ));
  if (!missingCosts.length && !invalidQuantities.length) return;
  const error = new Error(
    invalidQuantities.length
      ? `La valuacion detecto ${invalidQuantities.length} cantidades invalidas o negativas.`
      : `La valuacion no encontro costo para ${missingCosts.length} items con cantidad positiva.`
  );
  error.code = invalidQuantities.length
    ? "INVENTORY_NEGATIVE_QUANTITY"
    : "INVENTORY_COST_UNAVAILABLE";
  error.issues = [...invalidQuantities, ...missingCosts];
  throw error;
}

function inventoryFullEntryOperationKey({ date, employeeId, selectedShifts, cleanRows, counters = {} }) {
  const canonicalRows = cleanRows
    .map((row) => ({
      itemId: String(row.itemId || "").trim(),
      dawn: String(row.dawn ?? "").trim(),
      morning: String(row.morning ?? "").trim(),
      afternoon: String(row.afternoon ?? "").trim()
    }))
    .sort((left, right) => left.itemId.localeCompare(right.itemId, "en", { numeric: true }));
  const canonicalPayload = {
    date,
    employeeId: String(employeeId || "").trim(),
    selectedShifts: orderedInventoryShifts(selectedShifts),
    rows: canonicalRows
  };
  const canonicalCounters = Object.fromEntries(orderedInventoryShifts(selectedShifts).map((shift) => [shift, counters[shift] ?? ""]));
  if (Object.values(canonicalCounters).some((value) => value !== "")) canonicalPayload.counters = canonicalCounters;
  const canonical = JSON.stringify(canonicalPayload);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function normalizeInventoryAlipackCounters(input, selectedShifts) {
  if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input))) {
    return { values: {}, error: "Los contadores Alipack deben enviarse por turno." };
  }
  const source = input || {};
  const values = {};
  for (const shift of orderedInventoryShifts(selectedShifts)) {
    const raw = source[shift];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      values[shift] = "";
      continue;
    }
    if (!["string", "number"].includes(typeof raw)) {
      return { values: {}, error: `El Contador Alipack de ${shiftLabelForError(shift)} debe ser un numero finito y no negativo.` };
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      return { values: {}, error: `El Contador Alipack de ${shiftLabelForError(shift)} debe ser un numero finito y no negativo.` };
    }
    values[shift] = value;
  }
  return { values, error: "" };
}

function assertInventoryAlipackCounterIntegrity(cache) {
  const inventoryIds = new Set((cache.tables?.inventarios?.rows || []).map((row) => String(row.id_inventario ?? "").trim()));
  const counterIds = new Set();
  const linkedInventoryIds = new Set();
  for (const row of cache.tables?.[INVENTORY_ALIPACK_COUNTERS_TABLE]?.rows || []) {
    const counterId = String(row.id_contador_alipack ?? "").trim();
    const inventoryId = String(row.id_inventario ?? "").trim();
    const value = Number(row.valor_contador);
    if (!counterId || counterIds.has(counterId)) {
      throw inventoryCounterIntegrityError("El registro de contadores Alipack contiene una clave primaria vacia o duplicada.");
    }
    if (!inventoryId || linkedInventoryIds.has(inventoryId)) {
      throw inventoryCounterIntegrityError("Cada inventario puede tener como maximo un Contador Alipack.");
    }
    if (!inventoryIds.has(inventoryId)) {
      throw inventoryCounterIntegrityError(`El Contador Alipack referencia un inventario inexistente (${inventoryId || "sin id"}).`);
    }
    if (!Number.isFinite(value) || value < 0 || String(row.valor_contador ?? "").trim() === "") {
      throw inventoryCounterIntegrityError(`El Contador Alipack del inventario ${inventoryId} no es valido.`);
    }
    counterIds.add(counterId);
    linkedInventoryIds.add(inventoryId);
  }
  return true;
}

function inventoryCounterIntegrityError(message) {
  const error = new Error(message);
  error.code = "INVENTORY_ALIPACK_COUNTER_INTEGRITY";
  return error;
}

function inventoryAlipackMigrationRequiredError() {
  const error = new Error(
    "Falta aplicar la migracion de Contadores Alipack. No se realizo ningun cambio; aplica la migracion autorizada y reintenta."
  );
  error.code = "INVENTORY_ALIPACK_MIGRATION_REQUIRED";
  return error;
}

function shiftLabelForError(shift) {
  return { dawn: "Madrugada", morning: "Manana", afternoon: "Tarde" }[shift] || shift;
}

function isAlipackCounterName(value) {
  const normalized = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
  return normalized.includes("contador") && normalized.includes("alipack");
}

function orderedInventoryShifts(shifts) {
  const enabled = new Set(Array.isArray(shifts) ? shifts : []);
  return ["dawn", "morning", "afternoon"].filter((shift) => enabled.has(shift));
}

function inventoryFullEntryOperation(cache, operationKey) {
  return (Array.isArray(cache?.[INVENTORY_ENTRY_OPERATIONS_KEY])
    ? cache[INVENTORY_ENTRY_OPERATIONS_KEY]
    : []
  ).find((operation) => operation?.key === operationKey && operation?.result);
}

function storeInventoryFullEntryOperation(cache, operationKey, result) {
  const operations = Array.isArray(cache[INVENTORY_ENTRY_OPERATIONS_KEY])
    ? cache[INVENTORY_ENTRY_OPERATIONS_KEY].filter((operation) => operation?.key !== operationKey)
    : [];
  operations.push({ key: operationKey, completedAt: new Date().toISOString(), result });
  cache[INVENTORY_ENTRY_OPERATIONS_KEY] = operations.slice(-MAX_INVENTORY_ENTRY_OPERATIONS);
}

function inventoryDeliveryExits(cache) {
  const tables = cache?.tables || {};
  const deliveriesById = new Map((tables.entregas?.rows || []).map((row) => [
    String(row.id_entrega ?? "").trim(),
    row
  ]));
  const productsById = new Map((tables.productos?.rows || []).map((row) => [
    String(row.id_producto ?? "").trim(),
    row
  ]));
  const detailsByOrder = new Map();
  (tables.detalle_pedidos?.rows || []).forEach((detail) => {
    const orderId = String(detail.id_pedido ?? "").trim();
    if (!orderId) return;
    if (!detailsByOrder.has(orderId)) detailsByOrder.set(orderId, []);
    detailsByOrder.get(orderId).push(detail);
  });

  const seenLinks = new Set();
  const exits = [];
  (tables.entregas_detalle?.rows || []).forEach((link) => {
    const deliveryId = String(link.id_entrega ?? "").trim();
    const orderId = String(link.id_pedido ?? "").trim();
    const linkKey = `${deliveryId}:${orderId}`;
    if (!deliveryId || !orderId || seenLinks.has(linkKey)) return;
    seenLinks.add(linkKey);

    const delivery = deliveriesById.get(deliveryId);
    const date = String(delivery?.fecha || "").trim();
    if (!delivery || !date) return;
    (detailsByOrder.get(orderId) || []).forEach((detail) => {
      const product = productsById.get(String(detail.id_producto ?? "").trim());
      const quantity = Number(detail.cantidad_cajas);
      const itemId = String(product?.id_item ?? "").trim();
      if (!product || !itemId || !Number.isFinite(quantity)) return;
      const individualQuantity = deliveredIndividualUnits(quantity, product.cantidad_individual);
      exits.push({
        deliveryId,
        orderId,
        orderDetailId: String(detail.id_detalle_pedido ?? "").trim(),
        date,
        shift: "morning",
        itemId,
        productName: String(product.nombre_producto || "").trim(),
        quantity,
        unitsPerBox: individualQuantity === null ? null : Number(product.cantidad_individual),
        individualQuantity
      });
    });
  });
  return exits;
}

function deliveredIndividualUnits(boxes, unitsPerBox) {
  try {
    return individualUnits(boxes, unitsPerBox);
  } catch {
    return null;
  }
}

function inventoryReceptionEntries(cache) {
  const tables = cache?.tables || {};
  const receptionsById = new Map((tables.recepciones?.rows || []).map((row) => [
    String(row.id_recepcion ?? "").trim(),
    row
  ]).filter(([id]) => id));
  const suppliesById = new Map((tables.insumos?.rows || []).map((row) => [
    String(row.id_insumo ?? "").trim(),
    row
  ]).filter(([id]) => id));
  const itemsBySupplyId = new Map();
  (tables.items?.rows || []).forEach((item) => {
    const originType = String(item.origen_tipo || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
    const supplyId = String(item.id_origen ?? "").trim();
    if (originType !== "insumo" || !supplyId || itemsBySupplyId.has(supplyId)) return;
    itemsBySupplyId.set(supplyId, item);
  });

  const seenDetails = new Set();
  const entries = [];
  (tables.detalle_recepciones?.rows || []).forEach((detail) => {
    const detailId = String(detail.id_detalle_recepcion ?? "").trim();
    const receptionId = String(detail.id_recepcion ?? "").trim();
    const supplyId = String(detail.id_insumo ?? "").trim();
    if (!detailId || seenDetails.has(detailId) || !receptionId || !supplyId) return;
    seenDetails.add(detailId);

    const reception = receptionsById.get(receptionId);
    const supply = suppliesById.get(supplyId);
    const item = itemsBySupplyId.get(supplyId);
    const date = String(reception?.fecha_recepcion || "").trim();
    const itemId = String(item?.id_item ?? "").trim();
    const unit = String(item?.ud_conteo || "").trim();
    const quantity = Number(detail.cantidad_recibida);
    if (!reception || !supply || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !itemId || !unit || !Number.isFinite(quantity) || quantity <= 0) return;

    // cantidad_recibida is persisted by the reception flow in the item's count unit.
    // The canonical reception schema has date but no time/shift, so it enters once in Mañana.
    entries.push({
      receptionId,
      receptionDetailId: detailId,
      date,
      shift: "morning",
      itemId,
      quantity,
      unit
    });
  });
  return entries;
}

module.exports = {
  INVENTORY_ALIPACK_COUNTERS_TABLE,
  assertCompleteInventoryValuation,
  assertInventoryAlipackCounterIntegrity,
  createInventoryEntryService,
  deliveredIndividualUnits,
  inventoryDeliveryExits,
  inventoryReceptionEntries,
  normalizeInventoryAlipackCounters
};
