const { expectedOrderSubtotal, validDeliveryByOrder } = require("./sales-invoice-entry.service");

const WORKFLOW_TABLE = "gestion_ventas";

function createSalesWorkflowService({
  backendId,
  backendNextNumericId,
  ensureBackendTable,
  loadCache,
  readJsonBody,
  saveBackendCache,
  sendJson,
  crypto,
  fs,
  path,
  rootDir,
  currentDate = buenosAiresIsoDate,
  enqueueSalesWrite = (operation) => operation()
}) {
  const attachmentStorage = { crypto, fs, path, rootDir };

  function handleList(request, response) {
    const url = new URL(request.url, `http://${request.headers?.host || "127.0.0.1"}`);
    const managed = url.searchParams.get("managed") === "1";
    const rows = workflowRows(loadCache(), backendId, attachmentStorage)
      .filter((row) => managed ? row.managed : !row.managed && isEligibleForActiveWorkflow(row, currentDate()));
    return sendJson(response, 200, { ok: true, rows, total: rows.length, managed });
  }

  function handleArcaConfirmation(request, response) {
    return enqueueSalesWrite(() => persistArcaConfirmation(request, response));
  }

  async function persistArcaConfirmation(request, response) {
    try {
      const body = await readJsonBody(request);
      const orderId = backendId(body.orderId);
      if (!orderId) throw httpError(400, "El pedido es obligatorio.");
      const cache = clone(loadCache());
      prepareTables(cache, ensureBackendTable);
      assertOrderExists(cache, orderId, backendId);
      const workflow = ensureWorkflowRow(cache, orderId, {
        backendId,
        backendNextNumericId,
        origin: "historico_incompleto"
      });
      if (workflow.factura_arca_confirmada_en) {
        return sendJson(response, 200, { ok: true, orderId, idempotent: true, confirmedAt: workflow.factura_arca_confirmada_en });
      }
      const timestamp = new Date().toISOString();
      workflow.factura_arca_confirmada_en = timestamp;
      workflow.factura_arca_confirmada_por = actorFromRequest(request);
      workflow.actualizado_en = timestamp;
      finalizeWorkflowTable(cache, timestamp);
      saveBackendCache(cache);
      return sendJson(response, 200, { ok: true, orderId, confirmedAt: timestamp });
    } catch (error) {
      return sendJson(response, error.statusCode || 400, { ok: false, error: `No se confirmó la factura ARCA: ${error.message}` });
    }
  }

  function handleClose(request, response) {
    return enqueueSalesWrite(() => persistClose(request, response));
  }

  async function persistClose(request, response) {
    try {
      const body = await readJsonBody(request);
      const orderId = backendId(body.orderId);
      if (!orderId) throw httpError(400, "El pedido es obligatorio.");
      const cache = clone(loadCache());
      prepareTables(cache, ensureBackendTable);
      assertOrderExists(cache, orderId, backendId);
      const workflow = ensureWorkflowRow(cache, orderId, {
        backendId,
        backendNextNumericId,
        origin: "historico_incompleto"
      });
      if (workflow.cerrado_en) {
        return sendJson(response, 200, { ok: true, orderId, idempotent: true, closedAt: workflow.cerrado_en });
      }
      const completion = completionForOrder(cache, orderId, workflow, backendId, attachmentStorage);
      const missing = Object.entries(completion)
        .filter(([, complete]) => !complete)
        .map(([key]) => ({ arca: "Factura ARCA", delivery: "Entrega", sale: "Venta con adjunto" }[key]));
      if (missing.length) throw httpError(409, `No se puede cerrar: falta ${missing.join(", ")}.`);
      const timestamp = new Date().toISOString();
      workflow.cerrado_en = timestamp;
      workflow.cerrado_por = actorFromRequest(request);
      workflow.actualizado_en = timestamp;
      finalizeWorkflowTable(cache, timestamp);
      saveBackendCache(cache);
      return sendJson(response, 200, { ok: true, orderId, closedAt: timestamp });
    } catch (error) {
      return sendJson(response, error.statusCode || 400, { ok: false, error: `No se cerró la gestión: ${error.message}` });
    }
  }

  return { handleArcaConfirmation, handleClose, handleList };
}

function workflowRows(cache, backendId, attachmentStorage) {
  const tables = cache.tables || {};
  const workflowsByOrder = new Map((tables[WORKFLOW_TABLE]?.rows || [])
    .map((row) => [backendId(row.id_pedido), row])
    .filter(([orderId]) => Boolean(orderId)));
  const clientsById = new Map((tables.clientes?.rows || []).map((row) => [backendId(row.id_cliente), row]));
  const productsById = new Map((tables.productos?.rows || []).map((row) => [backendId(row.id_producto), row]));
  const detailsByOrder = groupBy(tables.detalle_pedidos?.rows || [], "id_pedido", backendId);
  const deliveries = validDeliveryByOrder(cache, backendId);
  const salesByOrder = new Map((tables.ventas?.rows || [])
    .map((row) => [backendId(row.id_pedido), row])
    .filter(([orderId]) => Boolean(orderId)));

  return (tables.pedidos?.rows || []).map((order) => {
    const orderId = backendId(order.id_pedido);
    const workflow = workflowsByOrder.get(orderId) || null;
    const delivery = deliveries.get(orderId) || null;
    const sale = salesByOrder.get(orderId) || null;
    const historicalResolved = !workflow && Boolean(delivery && sale);
    const managed = Boolean(workflow?.cerrado_en || historicalResolved);
    const details = (detailsByOrder.get(orderId) || []).map((detail) => {
      const product = productsById.get(backendId(detail.id_producto)) || {};
      return {
        id_producto: backendId(detail.id_producto),
        producto: product.nombre_producto || "",
        cantidad_cajas: detail.cantidad_cajas,
        unidades_por_caja: product.cantidad_individual,
        precio_unitario: detail.precio_ud,
        bonificacion: detail.bonificacion
      };
    });
    const client = clientsById.get(backendId(order.id_cliente)) || {};
    const completion = historicalResolved
      ? { arca: true, delivery: true, sale: true }
      : completionForOrder(cache, orderId, workflow, backendId, attachmentStorage);
    return {
      id_pedido: orderId,
      fecha_pedido: order.fecha_pedido || "",
      fecha_entrega_prevista: order.fecha_entrega || "",
      id_cliente: backendId(order.id_cliente),
      cliente: client.nombre_cliente || "",
      cuit_cliente: client.cuit || client.CUIT || "",
      productos: details,
      cantidad_cajas: details.reduce((total, detail) => total + numeric(detail.cantidad_cajas), 0),
      detalle_resumido: details.map((detail) => `${detail.producto || `Producto ${detail.id_producto}`} (${detail.cantidad_cajas || 0})`).join(", "),
      comparacion_factura: safeExpectedOrderSubtotal(details),
      completion,
      canClose: completion.arca && completion.delivery && completion.sale && !managed,
      managed,
      historicalResolved,
      workflow: workflow ? publicWorkflow(workflow) : null,
      delivery: delivery ? {
        id_entrega: backendId(delivery.id_entrega),
        fecha: delivery.fecha || "",
        id_flete: backendId(delivery.id_flete)
      } : null,
      sale: sale ? {
        id_venta: backendId(sale.id_venta),
        tipo_factura: sale.tipo_factura || "",
        nro_factura: sale.nro_factura || "",
        fecha_factura: sale.fecha_factura || "",
        subtotal: sale.subtotal,
        iva: sale.iva,
        total: sale.total,
        archivo_factura: completion.sale ? workflow?.archivo_factura || "" : "",
        archivo_factura_nombre: completion.sale ? workflow?.archivo_factura_nombre || "" : ""
      } : null
    };
  }).filter((row) => row.managed || row.workflow || !row.delivery || !row.sale)
    .sort(compareWorkflowRows);
}

function completionForOrder(cache, orderId, workflow, backendId, attachmentStorage) {
  const delivery = validDeliveryByOrder(cache, backendId).has(orderId);
  const sale = (cache.tables?.ventas?.rows || []).some((row) => backendId(row.id_pedido) === orderId);
  return {
    arca: Boolean(workflow?.factura_arca_confirmada_en),
    delivery,
    sale: Boolean(sale && verifiedSalesAttachment(workflow, attachmentStorage))
  };
}

function verifiedSalesAttachment(workflow, { crypto, fs, path, rootDir } = {}) {
  if (!workflow?.archivo_factura || !workflow?.archivo_factura_hash || !crypto || !fs || !path || !rootDir) return false;
  try {
    const attachmentsDir = path.resolve(rootDir, "backend", "attachments", "ventas");
    const absolutePath = path.resolve(rootDir, String(workflow.archivo_factura));
    if (!absolutePath.startsWith(`${attachmentsDir}${path.sep}`)) return false;
    if (!fs.statSync(absolutePath).isFile()) return false;
    const actualHash = crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
    return actualHash === String(workflow.archivo_factura_hash);
  } catch {
    return false;
  }
}

function ensureWorkflowRow(cache, orderId, { backendId, backendNextNumericId, origin = "historico_incompleto" }) {
  const table = cache.tables[WORKFLOW_TABLE];
  const matches = table.rows.filter((row) => backendId(row.id_pedido) === orderId);
  if (matches.length > 1) throw httpError(409, `El pedido ${orderId} tiene estados de gestión duplicados.`);
  if (matches.length === 1) return matches[0];
  const timestamp = new Date().toISOString();
  const row = {
    _rowNumber: table.rows.length + 2,
    id_gestion_venta: backendNextNumericId(table.rows, "id_gestion_venta"),
    id_pedido: orderId,
    origen: origin,
    clave_creacion_pedido: "",
    hash_creacion_pedido: "",
    factura_arca_confirmada_en: "",
    factura_arca_confirmada_por: "",
    archivo_factura: "",
    archivo_factura_nombre: "",
    archivo_factura_hash: "",
    cerrado_en: "",
    cerrado_por: "",
    creado_en: timestamp,
    actualizado_en: timestamp,
    _editedLocallyAt: timestamp
  };
  table.rows.push(row);
  table.rowCount = table.rows.length;
  return row;
}

function prepareTables(cache, ensureBackendTable) {
  cache.tables ||= {};
  ["pedidos", "detalle_pedidos", "clientes", "productos", "entregas", "entregas_detalle", "ventas", WORKFLOW_TABLE]
    .forEach((tableName) => ensureBackendTable(cache.tables, tableName));
}

function finalizeWorkflowTable(cache, timestamp) {
  cache.tables[WORKFLOW_TABLE].rowCount = cache.tables[WORKFLOW_TABLE].rows.length;
  cache.generatedAt = timestamp;
}

function assertOrderExists(cache, orderId, backendId) {
  if (!(cache.tables.pedidos?.rows || []).some((row) => backendId(row.id_pedido) === orderId)) {
    throw httpError(404, "El pedido ya no existe.");
  }
}

function publicWorkflow(row) {
  return {
    origen: row.origen || "",
    factura_arca_confirmada_en: row.factura_arca_confirmada_en || "",
    factura_arca_confirmada_por: row.factura_arca_confirmada_por || "",
    cerrado_en: row.cerrado_en || "",
    cerrado_por: row.cerrado_por || ""
  };
}

function actorFromRequest(request) {
  return String(request.accessIdentity?.user || request.accessIdentity?.mode || "local").trim() || "local";
}

function compareWorkflowRows(left, right) {
  if (left.managed !== right.managed) return left.managed ? 1 : -1;
  const leftDate = /^\d{4}-\d{2}-\d{2}$/.test(left.fecha_entrega_prevista) ? left.fecha_entrega_prevista : "9999-12-31";
  const rightDate = /^\d{4}-\d{2}-\d{2}$/.test(right.fecha_entrega_prevista) ? right.fecha_entrega_prevista : "9999-12-31";
  return leftDate.localeCompare(rightDate) || String(left.id_pedido).localeCompare(String(right.id_pedido), undefined, { numeric: true });
}

function isEligibleForActiveWorkflow(row, today) {
  const deliveryDate = String(row.fecha_entrega_prevista || "");
  return !/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate) || deliveryDate >= today;
}

function buenosAiresIsoDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function groupBy(rows, key, backendId) {
  const result = new Map();
  rows.forEach((row) => {
    const id = backendId(row[key]);
    if (!result.has(id)) result.set(id, []);
    result.get(id).push(row);
  });
  return result;
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function safeExpectedOrderSubtotal(details) {
  try {
    return expectedOrderSubtotal(details);
  } catch {
    return {
      estado: "datos_insuficientes",
      campos_faltantes: ["cantidades compatibles con unidades individuales"],
      subtotal_esperado: null,
      lineas: []
    };
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = {
  WORKFLOW_TABLE,
  completionForOrder,
  createSalesWorkflowService,
  ensureWorkflowRow,
  isEligibleForActiveWorkflow,
  verifiedSalesAttachment,
  workflowRows
};
