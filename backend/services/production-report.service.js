const MAX_PERIOD_DAYS = 93;

function createProductionReportService({ loadCache }) {
  function buildProductionReport(startIso, endIso) {
    validatePeriod(startIso, endIso);
    const tables = loadCache().tables || {};
    const products = tables.productos?.rows || [];
    const productById = indexBy(products, "id_producto");
    const productByItem = indexBy(products, "id_item");
    const detailsByInventory = groupBy(tables.detalle_inventarios?.rows || [], "id_inventario");
    const canonicalSnapshots = selectCanonicalSnapshots(tables.inventarios?.rows || []);
    const deliveriesById = indexBy(tables.entregas?.rows || [], "id_entrega");
    const orderDetails = groupBy(tables.detalle_pedidos?.rows || [], "id_pedido");
    const salesByDateProduct = aggregateDeliveredSales({
      deliveryLinks: tables.entregas_detalle?.rows || [],
      deliveriesById,
      orderDetails,
      productById,
      startIso,
      endIso
    });
    const dates = isoDates(startIso, endIso);
    const previousSnapshotByDate = new Map(dates.map((date) => [
      date,
      latestSnapshotBefore(canonicalSnapshots, date)
    ]));
    const rows = [];
    const daily = [];

    dates.forEach((date) => {
      products.forEach((product) => {
        const productId = id(product.id_producto);
        const itemId = id(product.id_item);
        if (!productId || !itemId) return;
        const dawn = canonicalSnapshots.get(`${date}|dawn`);
        const morning = canonicalSnapshots.get(`${date}|morning`);
        const afternoon = canonicalSnapshots.get(`${date}|afternoon`);
        const previous = previousSnapshotByDate.get(date);
        const initialMorning = quantityFor(previous, itemId, detailsByInventory);
        const finalDawn = quantityFor(dawn, itemId, detailsByInventory);
        const finalMorning = quantityFor(morning, itemId, detailsByInventory);
        const finalAfternoon = quantityFor(afternoon, itemId, detailsByInventory);
        const sales = salesByDateProduct.get(`${date}|${productId}`) || 0;
        const dawnRow = calculationRow({
          date, shift: "Madrugada", product, initial: initialMorning, final: finalDawn, sales: 0,
          missing: missingQuantities([
            [previous, initialMorning, "inventario inicial previo"],
            [dawn, finalDawn, "inventario final de Madrugada"]
          ])
        });
        const morningInitialSnapshot = dawn || previous;
        const morningInitial = dawn ? finalDawn : initialMorning;
        const morningRow = calculationRow({
          date, shift: "Mañana", product, initial: morningInitial, final: finalMorning, sales,
          missing: missingQuantities([
            [morningInitialSnapshot, morningInitial, dawn ? "detalle del producto en Madrugada" : "inventario inicial previo"],
            [morning, finalMorning, "inventario final de Mañana"]
          ])
        });
        const afternoonRow = calculationRow({
          date, shift: "Tarde", product, initial: finalMorning, final: finalAfternoon, sales: 0,
          missing: missingQuantities([
            [morning, finalMorning, "inventario inicial de Tarde (fin de Mañana)"],
            [afternoon, finalAfternoon, "inventario final de Tarde"]
          ])
        });
        if (dawn) rows.push(dawnRow);
        rows.push(morningRow, afternoonRow);
        const missing = missingQuantities([
          [previous, initialMorning, "inventario inicial del día"],
          [afternoon, finalAfternoon, "inventario final del día"]
        ]);
        const production = missing.length ? null : finalAfternoon - initialMorning + sales;
        const shiftRows = [dawn && dawnRow, morningRow, afternoonRow].filter(Boolean);
        const shiftSum = shiftRows.some((row) => row.production === null)
          ? null
          : shiftRows.reduce((sum, row) => sum + row.production, 0);
        const reconciled = production !== null && shiftSum !== null && production === shiftSum;
        const negative = production !== null && production < 0;
        daily.push({
          date,
          productId,
          productName: product.nombre_producto || `Producto ${productId}`,
          unit: "cajas",
          initialInventory: missing.length ? null : initialMorning,
          sales,
          finalInventory: missing.length ? null : finalAfternoon,
          production,
          shiftSum,
          reconciled,
          status: missing.length ? "insufficient" : negative || !reconciled ? "warning" : "ok",
          warning: missing.length
            ? `Datos insuficientes: falta ${missing.join(" y ")}.`
            : negative
              ? "Producción negativa: revisar consistencia de inventarios y salidas."
              : !reconciled ? "Total diario calculable, pero los turnos no se pueden conciliar por datos faltantes." : ""
        });
      });
    });

    return {
      period: { start: startIso, end: endIso },
      formula: "producción = inventario final - inventario inicial + salidas",
      sources: {
        snapshots: "inventarios + detalle_inventarios; mayor id_inventario por fecha/turno",
        sales: "entregas.fecha + entregas_detalle + detalle_pedidos.cantidad_cajas",
        unit: "cajas, unidad persistida para el producto en inventario"
      },
      rows,
      daily
    };
  }

  return { buildProductionReport };
}

function calculationRow({ date, shift, product, initial, final, sales, missing }) {
  const production = missing.length ? null : final - initial + sales;
  return {
    date,
    shift,
    productId: id(product.id_producto),
    productName: product.nombre_producto || `Producto ${id(product.id_producto)}`,
    unit: "cajas",
    initialInventory: missing.length ? null : initial,
    sales,
    finalInventory: missing.length ? null : final,
    production,
    status: missing.length ? "insufficient" : production < 0 ? "warning" : "ok",
    warning: missing.length
      ? `Datos insuficientes: falta ${missing.join(" y ")}.`
      : production < 0 ? "Producción negativa: revisar consistencia de datos." : ""
  };
}

function selectCanonicalSnapshots(inventories) {
  const selected = new Map();
  inventories.forEach((row) => {
    const date = isoDate(row.fecha);
    const shift = shiftKey(row.turno);
    if (!date || !shift) return;
    const key = `${date}|${shift}`;
    const current = selected.get(key);
    if (!current || compareId(row.id_inventario, current.id_inventario) > 0) selected.set(key, row);
  });
  return selected;
}

function latestSnapshotBefore(snapshots, date) {
  return [...snapshots.values()]
    .filter((row) => isoDate(row.fecha) < date)
    .sort((left, right) => (
      isoDate(right.fecha).localeCompare(isoDate(left.fecha))
      || shiftRank(right.turno) - shiftRank(left.turno)
      || compareId(right.id_inventario, left.id_inventario)
    ))[0] || null;
}

function aggregateDeliveredSales({ deliveryLinks, deliveriesById, orderDetails, productById, startIso, endIso }) {
  const result = new Map();
  const seenLinks = new Set();
  deliveryLinks.forEach((link) => {
    const deliveryId = id(link.id_entrega);
    const orderId = id(link.id_pedido);
    const linkKey = `${deliveryId}|${orderId}`;
    if (!deliveryId || !orderId || seenLinks.has(linkKey)) return;
    seenLinks.add(linkKey);
    const date = isoDate(deliveriesById.get(deliveryId)?.fecha);
    if (!date || date < startIso || date > endIso) return;
    (orderDetails.get(orderId) || []).forEach((detail) => {
      const productId = id(detail.id_producto);
      if (!productById.has(productId)) return;
      const key = `${date}|${productId}`;
      result.set(key, (result.get(key) || 0) + number(detail.cantidad_cajas));
    });
  });
  return result;
}

function quantityFor(snapshot, itemId, detailsByInventory) {
  if (!snapshot) return null;
  const matching = (detailsByInventory.get(id(snapshot.id_inventario)) || [])
    .filter((detail) => id(detail.id_item) === itemId);
  if (!matching.length || matching.some((detail) => !isFiniteQuantity(detail.cantidad))) return null;
  return matching.reduce((sum, detail) => sum + number(detail.cantidad), 0);
}

function validatePeriod(startIso, endIso) {
  if (!isoDate(startIso) || !isoDate(endIso) || startIso > endIso) {
    throw reportError("PRODUCTION_PERIOD_INVALID", "Período inválido.", 400);
  }
  const days = Math.round((Date.parse(`${endIso}T00:00:00Z`) - Date.parse(`${startIso}T00:00:00Z`)) / 86400000) + 1;
  if (days > MAX_PERIOD_DAYS) throw reportError("PRODUCTION_PERIOD_TOO_LARGE", `El período máximo es de ${MAX_PERIOD_DAYS} días.`, 400);
}

function isoDates(start, end) {
  const dates = [];
  for (let time = Date.parse(`${start}T00:00:00Z`), last = Date.parse(`${end}T00:00:00Z`); time <= last; time += 86400000) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
}

function indexBy(rows, key) {
  return new Map(rows.map((row) => [id(row[key]), row]).filter(([keyValue]) => keyValue));
}

function groupBy(rows, key) {
  const grouped = new Map();
  rows.forEach((row) => {
    const keyValue = id(row[key]);
    if (!grouped.has(keyValue)) grouped.set(keyValue, []);
    grouped.get(keyValue).push(row);
  });
  return grouped;
}

function shiftKey(value) {
  const normalized = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (normalized.includes("madrug")) return "dawn";
  if (normalized.includes("manan")) return "morning";
  if (normalized.includes("tarde")) return "afternoon";
  return "";
}

function shiftRank(value) {
  return { dawn: 0, morning: 1, afternoon: 2 }[shiftKey(value)] ?? -1;
}

function compareId(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
    ? leftNumber - rightNumber
    : String(left || "").localeCompare(String(right || ""));
}

function isoDate(value) {
  const text = String(value || "");
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const date = new Date(`${text}T00:00:00Z`);
  return date.toISOString().slice(0, 10) === text ? text : "";
}

function id(value) {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isFiniteQuantity(value) {
  const text = String(value ?? "").trim();
  return text !== "" && Number.isFinite(Number(text.replace(",", ".")));
}

function missingQuantities(entries) {
  return entries.flatMap(([snapshot, quantity, label]) => {
    if (!snapshot) return [label];
    return quantity === null ? [`detalle del producto en ${label}`] : [];
  });
}

function reportError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

module.exports = {
  MAX_PERIOD_DAYS,
  createProductionReportService,
  selectCanonicalSnapshots
};
