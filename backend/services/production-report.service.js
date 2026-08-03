const MAX_PERIOD_DAYS = 93;
const REQUESTED_PRODUCTS = [
  { name: "Barra_Pop", aliases: ["Barra Pop"] },
  { name: "Barra_Pop_140_Ud", aliases: ["Barra Pop 140 Ud", "Barra Pop 140Ud"] },
  { name: "Granel_Dulce", aliases: ["Granel Dulce"] },
  { name: "Materia_Prima_Pochoclo_Dulce", aliases: ["Materia Prima Pochoclo Dulce"] }
];

function createProductionReportService({ loadCache }) {
  function buildProductionReport(startIso, endIso, selectedItemId = "") {
    validatePeriod(startIso, endIso);
    const tables = loadCache().tables || {};
    const catalog = buildCatalog(tables);
    const itemById = indexBy(tables.items?.rows || [], "id_item");
    const options = requestedOptions(catalog, itemById);
    const selected = options.find((option) => option.itemId === id(selectedItemId)) || options[0] || null;
    if (!selected) throw reportError("PRODUCTION_PRODUCTS_NOT_FOUND", "No se encontraron los productos configurados en el catálogo canónico.", 422);

    const recipesByComponent = groupBy(tables.recetas?.rows || [], "id_item_componente");
    const productsByItem = indexBy(tables.productos?.rows || [], "id_item");
    const productsById = indexBy(tables.productos?.rows || [], "id_producto");
    const detailsByInventory = groupBy(tables.detalle_inventarios?.rows || [], "id_inventario");
    const snapshots = selectCanonicalSnapshots(tables.inventarios?.rows || []);
    const sales = aggregateDeliveredSales({
      deliveryLinks: tables.entregas_detalle?.rows || [],
      deliveriesById: indexBy(tables.entregas?.rows || [], "id_entrega"),
      orderDetails: groupBy(tables.detalle_pedidos?.rows || [], "id_pedido"),
      productsById,
      startIso,
      endIso
    });
    const dates = isoDates(startIso, endIso);
    const rows = [];
    const daily = [];
    const unavailableReasons = new Set();

    dates.forEach((date) => {
      const previous = latestSnapshotBefore(snapshots, date);
      const dawn = snapshots.get(`${date}|dawn`);
      const morning = snapshots.get(`${date}|morning`);
      const afternoon = snapshots.get(`${date}|afternoon`);
      const contexts = [
        { shift: "Madrugada", initial: previous, final: dawn, include: Boolean(dawn), sales: false },
        { shift: "Mañana", initial: dawn || previous, final: morning, include: true, sales: true },
        { shift: "Tarde", initial: morning, final: afternoon, include: true, sales: false }
      ];
      const shiftResults = contexts.map((context) => calculateProduction({
        date, context, itemId: selected.itemId, catalog, itemById, recipesByComponent,
        productsByItem, detailsByInventory, sales
      }));
      shiftResults.forEach((row, index) => {
        if (contexts[index].include && visibleProductionRow(row)) rows.push(row);
      });

      const dayResult = calculateProduction({
        date,
        context: { shift: "Total día", initial: previous, final: afternoon, include: true, sales: true },
        itemId: selected.itemId, catalog, itemById, recipesByComponent,
        productsByItem, detailsByInventory, sales
      });
      dayResult.missing.forEach((reason) => unavailableReasons.add(reason));
      const visibleShifts = shiftResults.filter(visibleProductionRow);
      const shiftTotal = visibleShifts.reduce((sum, row) => sum + row.production, 0);
      dayResult.shiftTotal = shiftTotal;
      dayResult.reconciled = visibleShifts.length > 0 && Math.abs(shiftTotal - dayResult.production) < 0.000001;
      if (visibleProductionRow(dayResult)) daily.push(dayResult);
    });

    daily.sort((left, right) => right.date.localeCompare(left.date));
    rows.sort((left, right) => right.date.localeCompare(left.date) || shiftRank(left.shift) - shiftRank(right.shift));
    const total = daily.reduce((sum, row) => sum + row.production, 0);
    const best = daily.reduce((current, row) => !current || row.production > current.production ? row : current, null);
    return {
      period: { start: startIso, end: endIso },
      options,
      selected,
      formula: "producción = inventario final - inventario inicial + salidas + consumo canónico por recetas",
      metrics: {
        total,
        average: daily.length ? total / daily.length : 0,
        bestDate: best?.date || null,
        bestProduction: best?.production || 0,
        positiveDays: daily.length,
        unit: selected.unit,
        unitsPerContainer: selected.unitsPerContainer
      },
      unavailableReasons: [...unavailableReasons],
      rows,
      daily
    };
  }
  return { buildProductionReport };
}

function calculateProduction({ date, context, itemId, catalog, itemById, recipesByComponent, productsByItem, detailsByInventory, sales }) {
  const memo = new Map();
  const visiting = new Set();
  function calculate(currentItemId) {
    if (memo.has(currentItemId)) return memo.get(currentItemId);
    if (visiting.has(currentItemId)) return { production: null, recipeConsumption: null, missing: ["ciclo en recetas"] };
    visiting.add(currentItemId);
    const currentMeasurement = measurementFor(catalog.get(currentItemId), itemById.get(currentItemId));
    const initialRaw = quantityFor(context.initial, currentItemId, detailsByInventory);
    const finalRaw = quantityFor(context.final, currentItemId, detailsByInventory);
    const initial = initialRaw === null ? null : initialRaw * currentMeasurement.inventoryMultiplier;
    const final = finalRaw === null ? null : finalRaw * currentMeasurement.inventoryMultiplier;
    const missing = [];
    if (!context.initial) missing.push("inventario inicial"); else if (initial === null) missing.push("detalle de inventario inicial");
    if (!context.final) missing.push("inventario final"); else if (final === null) missing.push("detalle de inventario final");
    const product = productsByItem.get(currentItemId);
    const productSales = context.sales && product ? (sales.get(`${date}|${id(product.id_producto)}`) || 0) : 0;
    let recipeConsumption = 0;
    for (const recipe of recipesByComponent.get(currentItemId) || []) {
      const parentId = id(recipe.id_item_resultado);
      const parent = calculate(parentId);
      // Una receta descendiente sólo aporta cuando su resultado tuvo producción positiva real.
      // La ausencia de inventarios/producción del descendiente equivale a aporte cero y no
      // vuelve insuficiente al producto que se está analizando.
      if (!Number.isFinite(parent.production) || parent.production <= 0) continue;
      const quantity = finitePositive(recipe.cantidad_componente);
      if (quantity === null) {
        missing.push(`cantidad inválida en receta ${id(recipe.id_receta) || "sin ID"} de ${catalog.get(parentId)?.name || `item ${parentId}`}`);
        continue;
      }
      if (!compatibleUnits(recipe.unidad_base, currentMeasurement.unit)) {
        missing.push(`conversión canónica ${String(recipe.unidad_base || "unidad de receta")} → ${currentMeasurement.unit} para ${catalog.get(parentId)?.name || `item ${parentId}`}`);
        continue;
      }
      recipeConsumption += parent.production * quantity;
    }
    visiting.delete(currentItemId);
    const production = missing.length ? null : final - initial + productSales + recipeConsumption;
    const result = { initial, final, sales: productSales, recipeConsumption, production, missing: [...new Set(missing)] };
    memo.set(currentItemId, result);
    return result;
  }
  const value = calculate(itemId);
  const item = catalog.get(itemId);
  const measurement = measurementFor(item, itemById.get(itemId));
  return {
    date,
    shift: context.shift,
    productId: itemId,
    productName: item.name,
    ...measurement,
    initialInventory: value.missing.length ? null : value.initial,
    sales: value.sales,
    recipeConsumption: value.recipeConsumption,
    outputs: value.missing.length ? null : value.sales + value.recipeConsumption,
    finalInventory: value.missing.length ? null : value.final,
    production: value.production,
    individualProduction: individualProduction(value.production, measurement),
    secondaryProduction: secondaryProduction(value.production, measurement),
    proportion: null,
    missing: value.missing,
    status: value.missing.length ? "insufficient" : value.production <= 0 ? "not_positive" : "ok",
    warning: value.missing.length ? `Datos insuficientes: falta ${value.missing.join(" y ")}.` : ""
  };
}

function buildCatalog(tables) {
  const catalog = new Map();
  (tables.productos?.rows || []).forEach((row) => catalog.set(id(row.id_item), {
    itemId: id(row.id_item), sourceId: id(row.id_producto), type: "producto", name: String(row.nombre_producto || "").trim(), row
  }));
  (tables.subproductos?.rows || []).forEach((row) => catalog.set(id(row.id_item), {
    itemId: id(row.id_item), sourceId: id(row.id_subproducto), type: "subproducto", name: String(row.nombre_subproducto || "").trim(), row
  }));
  return catalog;
}

function requestedOptions(catalog, itemById) {
  return REQUESTED_PRODUCTS.flatMap((requested) => {
    const names = [requested.name, ...requested.aliases].map(normalizeName);
    const match = [...catalog.values()].find((entry) => names.includes(normalizeName(entry.name)));
    if (!match) return [];
    const measurement = measurementFor(match, itemById.get(match.itemId));
    return [{ itemId: match.itemId, sourceId: match.sourceId, type: match.type, name: requested.name, canonicalName: match.name, ...measurement }];
  });
}

function measurementFor(entry, itemRow) {
  const canonicalUnit = itemUnit(entry, itemRow);
  const entryName = normalizeName(entry?.name);
  const factor = entry?.type === "producto" ? finitePositive(entry.row.cantidad_individual) : null;
  const isBarraPopIntermediate = entryName === "barra pop";
  const isBarraPop140 = entryName === "barra pop 140ud" || entryName === "barra pop 140 ud";
  const unit = isBarraPopIntermediate ? "Ud" : isBarraPop140 ? "cajas" : canonicalUnit;
  const container = isBarraPop140 || /caja|envase/.test(normalizeName(unit));
  return {
    unit,
    inventoryUnit: canonicalUnit,
    inventoryMultiplier: isBarraPopIntermediate ? 2000 : 1,
    unitsPerContainer: container ? factor : null,
    individualConversionStatus: container ? (factor ? "available" : "missing_factor") : "not_applicable",
    secondaryUnit: isBarraPopIntermediate ? "bolsones" : container && factor ? "Ud" : null,
    secondaryFactor: isBarraPopIntermediate ? 1 / 2000 : container && factor ? factor : null
  };
}

function individualProduction(production, measurement) {
  return Number.isFinite(production) && measurement.individualConversionStatus === "available"
    ? production * measurement.unitsPerContainer : null;
}
function secondaryProduction(production, measurement) {
  return Number.isFinite(production) && measurement.secondaryFactor
    ? Number((production * measurement.secondaryFactor).toFixed(12))
    : null;
}

function visibleProductionRow(row) { return Number.isFinite(row.production) && row.production > 0; }

function selectCanonicalSnapshots(inventories) {
  const selected = new Map();
  inventories.forEach((row) => {
    const date = isoDate(row.fecha); const shift = shiftKey(row.turno);
    if (!date || !shift) return;
    const key = `${date}|${shift}`; const current = selected.get(key);
    if (!current || compareId(row.id_inventario, current.id_inventario) > 0) selected.set(key, row);
  });
  return selected;
}

function latestSnapshotBefore(snapshots, date) {
  return [...snapshots.values()].filter((row) => isoDate(row.fecha) < date).sort((left, right) =>
    isoDate(right.fecha).localeCompare(isoDate(left.fecha)) || shiftRank(right.turno) - shiftRank(left.turno) || compareId(right.id_inventario, left.id_inventario)
  )[0] || null;
}

function aggregateDeliveredSales({ deliveryLinks, deliveriesById, orderDetails, productsById, startIso, endIso }) {
  const result = new Map(); const seen = new Set();
  deliveryLinks.forEach((link) => {
    const deliveryId = id(link.id_entrega); const orderId = id(link.id_pedido); const linkKey = `${deliveryId}|${orderId}`;
    if (!deliveryId || !orderId || seen.has(linkKey)) return; seen.add(linkKey);
    const date = isoDate(deliveriesById.get(deliveryId)?.fecha); if (!date || date < startIso || date > endIso) return;
    (orderDetails.get(orderId) || []).forEach((detail) => {
      const product = productsById.get(id(detail.id_producto)); if (!product) return;
      const key = `${date}|${id(product.id_producto)}`;
      result.set(key, (result.get(key) || 0) + number(detail.cantidad_cajas));
    });
  });
  return result;
}

function quantityFor(snapshot, itemId, detailsByInventory) {
  if (!snapshot) return null;
  const rows = (detailsByInventory.get(id(snapshot.id_inventario)) || []).filter((row) => id(row.id_item) === itemId);
  if (!rows.length || rows.some((row) => !isFiniteQuantity(row.cantidad))) return null;
  return rows.reduce((sum, row) => sum + number(row.cantidad), 0);
}

function validatePeriod(start, end) {
  if (!isoDate(start) || !isoDate(end) || start > end) throw reportError("PRODUCTION_PERIOD_INVALID", "Período inválido.", 400);
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
  if (days > MAX_PERIOD_DAYS) throw reportError("PRODUCTION_PERIOD_TOO_LARGE", `El período máximo es de ${MAX_PERIOD_DAYS} días.`, 400);
}
function isoDates(start, end) { const dates = []; for (let t = Date.parse(`${start}T00:00:00Z`), last = Date.parse(`${end}T00:00:00Z`); t <= last; t += 86400000) dates.push(new Date(t).toISOString().slice(0, 10)); return dates; }
function indexBy(rows, key) { return new Map(rows.map((row) => [id(row[key]), row]).filter(([value]) => value)); }
function groupBy(rows, key) { const grouped = new Map(); rows.forEach((row) => { const value = id(row[key]); if (!grouped.has(value)) grouped.set(value, []); grouped.get(value).push(row); }); return grouped; }
function shiftKey(value) { const normalized = normalizeName(value); if (normalized.includes("madrug")) return "dawn"; if (normalized.includes("manan")) return "morning"; if (normalized.includes("tarde")) return "afternoon"; return ""; }
function shiftRank(value) { return { dawn: 0, morning: 1, afternoon: 2 }[shiftKey(value)] ?? (/madrug/i.test(value) ? 0 : /mañ|man/i.test(value) ? 1 : 2); }
function compareId(left, right) { const a = Number(left); const b = Number(right); return Number.isFinite(a) && Number.isFinite(b) ? a - b : String(left || "").localeCompare(String(right || "")); }
function isoDate(value) { const text = String(value || ""); if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return ""; const date = new Date(`${text}T00:00:00Z`); return date.toISOString().slice(0, 10) === text ? text : ""; }
function normalizeName(value) { return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[_\s]+/g, " ").trim().toLowerCase(); }
function id(value) { return String(value ?? "").trim(); }
function number(value) { const parsed = Number(String(value ?? "").replace(",", ".")); return Number.isFinite(parsed) ? parsed : 0; }
function isFiniteQuantity(value) { const text = String(value ?? "").trim(); return text !== "" && Number.isFinite(Number(text.replace(",", "."))); }
function finitePositive(value) { return isFiniteQuantity(value) && number(value) > 0 ? number(value) : null; }
function itemUnit(entry, itemRow) { return String(itemRow?.ud_conteo || entry?.row?.ud_conteo || "unidades").trim() || "unidades"; }
function compatibleUnits(left, right) {
  const unit = (value) => normalizeName(value).replace(/s$/, "");
  return unit(left) === unit(right);
}
function reportError(code, message, status) { const error = new Error(message); error.code = code; error.status = status; return error; }

module.exports = { MAX_PERIOD_DAYS, createProductionReportService, selectCanonicalSnapshots };
