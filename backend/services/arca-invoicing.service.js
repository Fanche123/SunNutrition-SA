const {
  calculateInvoice,
  calculateLine,
  individualUnits,
  RECEIPT_TYPES,
  VAT_RATES
} = require("../../shared/order-pricing");
const { isIsoDate } = require("../utils/runtime");

const AUDIT_STATUSES = new Set(["prepared", "review_reached", "interrupted"]);
const SESSION_TTL_MS = 5 * 60 * 1000;
const INTERRUPTION_REASONS = new Set([
  "extension_unavailable",
  "invalid_extension_response",
  "manual_abort",
  "network_error",
  "screen_unrecognized",
  "selector_changed",
  "session_expired",
  "timeout",
  "unexpected_response"
]);
const RECIPIENT_CONDITIONS = new Set([
  "responsable_inscripto",
  "monotributista",
  "exento",
  "consumidor_final",
  "no_alcanzado",
  "no_categorizado"
]);
const ISSUER_CONDITIONS = new Set(["responsable_inscripto", "monotributista", "exento"]);

function createArcaInvoicingService({
  auditFile,
  backendId,
  crypto,
  fs,
  loadCache,
  path,
  readJsonBody,
  sendJson
}) {
  function orders(cache = loadCache(), options = {}) {
    const tables = cache.tables || {};
    const salesByOrder = new Map((tables.ventas?.rows || [])
      .map((sale) => [backendId(sale.id_pedido), sale])
      .filter(([orderId]) => Boolean(orderId)));
    const clientsById = new Map((tables.clientes?.rows || [])
      .map((client) => [backendId(client.id_cliente), client]));
    const productsById = new Map((tables.productos?.rows || [])
      .map((product) => [backendId(product.id_producto), product]));
    const detailsByOrder = groupBy(tables.detalle_pedidos?.rows || [], "id_pedido", backendId);
    const deliveriesByOrder = realDeliveriesByOrder(tables, backendId);
    const query = normalizeText(options.query);
    const exactOrderId = backendId(options.orderId);
    const statusFilter = String(options.status || "unbilled");
    const includeIneligible = options.includeIneligible === true;

    const eligibleOrders = (tables.pedidos?.rows || []).filter((order) => {
      const orderId = backendId(order.id_pedido);
      if (exactOrderId && orderId !== exactOrderId) return false;
      return includeIneligible || (!deliveriesByOrder.has(orderId) && !salesByOrder.has(orderId));
    });

    const allRows = eligibleOrders.map((order) => {
      const orderId = backendId(order.id_pedido);
      const client = clientsById.get(backendId(order.id_cliente)) || {};
      const sale = salesByOrder.get(orderId);
      const delivery = deliveriesByOrder.get(orderId);
      const details = (detailsByOrder.get(orderId) || []).map((detail) => {
        const product = productsById.get(backendId(detail.id_producto)) || {};
        return {
          id_detalle_pedido: backendId(detail.id_detalle_pedido),
          id_producto: backendId(detail.id_producto),
          producto: product.nombre_producto || "",
          cantidad_cajas: numeric(detail.cantidad_cajas),
          unidades_por_caja: numeric(product.cantidad_individual),
          unidades_individuales: safeIndividualUnits(
            numeric(detail.cantidad_cajas),
            numeric(product.cantidad_individual)
          ),
          precio_unidad_individual: numeric(detail.precio_ud),
          bonificacion: numeric(detail.bonificacion)
        };
      });
      const missing = missingSourceFields({ client, details });
      return {
        id_pedido: orderId,
        fecha_pedido: order.fecha_pedido || "",
        fecha_entrega_prevista: order.fecha_entrega || "",
        cliente: client.nombre_cliente || "",
        id_cliente: backendId(order.id_cliente),
        cuit: client.cuit || "",
        condicion_fiscal: client.tipo || "",
        domicilio: [client.direccion, client.localidad].filter(Boolean).join(", "),
        tipo_comprobante_configurado: client.tipo_comprobante || "",
        entrega: delivery ? {
          estado: "entregado_sin_factura",
          id_entrega: backendId(delivery.id_entrega),
          fecha: delivery.fecha || ""
        } : {
          estado: "entrega_pendiente",
          id_entrega: "",
          fecha: ""
        },
        facturacion_estado: sale ? "ya_facturado" : (missing.length ? "datos_incompletos" : "listo"),
        faltantes: missing,
        venta: sale ? {
          id_venta: backendId(sale.id_venta),
          tipo_factura: sale.tipo_factura || "",
          nro_factura: sale.nro_factura || ""
        } : null,
        productos: details
      };
    }).filter((row) => {
      if (statusFilter === "ready" && row.facturacion_estado !== "listo") return false;
      if (statusFilter === "incomplete" && row.facturacion_estado !== "datos_incompletos") return false;
      if (statusFilter === "billed" && row.facturacion_estado !== "ya_facturado") return false;
      if (!query) return true;
      return normalizeText([
        row.id_pedido,
        row.cliente,
        row.cuit,
        row.productos.map((product) => product.producto).join(" ")
      ].join(" ")).includes(query);
    }).sort(compareExpectedDelivery);

    const limit = boundedInteger(options.limit, 25, 1, 100);
    const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    return {
      rows: allRows.slice(offset, offset + limit),
      total: allRows.length,
      limit,
      offset
    };
  }

  function handleOrdersGet(request, response) {
    const url = new URL(request.url, `http://${request.headers?.host || "127.0.0.1"}`);
    const result = orders(loadCache(), {
      query: url.searchParams.get("query") || "",
      status: url.searchParams.get("status") || "unbilled",
      limit: url.searchParams.get("limit"),
      offset: url.searchParams.get("offset")
    });
    return sendJson(response, 200, { ok: true, ...result });
  }

  async function handlePreparePost(request, response) {
    try {
      const body = await readJsonBody(request);
      const prepared = prepare(body, loadCache());
      appendAudit({
        orderId: prepared.order.id,
        status: "prepared",
        reason: ""
      });
      return sendJson(response, 200, {
        ok: true,
        sessionId: crypto.randomUUID(),
        payload: prepared
      });
    } catch (error) {
      return sendJson(response, error.statusCode || 400, {
        ok: false,
        error: error.message
      });
    }
  }

  function prepare(body, cache) {
    const orderId = backendId(body.orderId);
    if (!orderId) throw invoiceError("El pedido es obligatorio.");
    const current = orders(cache, {
      status: "all",
      orderId,
      limit: 1,
      offset: 0,
      includeIneligible: true
    }).rows[0];
    if (!current) throw invoiceError("El pedido ya no existe.", 404);
    if (current.facturacion_estado === "ya_facturado") {
      throw invoiceError("El pedido ya fue facturado. Actualizá la lista.", 409);
    }
    if (current.entrega.id_entrega) {
      throw invoiceError("El pedido ya tiene una entrega real. Actualizá la lista.", 409);
    }
    if (current.faltantes.length) {
      throw invoiceError(`Faltan datos del pedido: ${current.faltantes.join(", ")}.`);
    }

    const pointOfSale = String(body.pointOfSale || "").trim();
    const receiptType = String(body.receiptType || "").trim();
    const issuerCondition = String(body.issuerCondition || "").trim();
    const recipientCondition = String(body.recipientCondition || "").trim();
    const invoiceDate = String(body.invoiceDate || "").trim();
    if (!/^\d{4,5}$/.test(pointOfSale)) throw invoiceError("El punto de venta debe tener 4 o 5 dígitos.");
    if (!RECEIPT_TYPES.includes(receiptType)) throw invoiceError("Seleccioná el tipo de comprobante A, B o C.");
    if (!ISSUER_CONDITIONS.has(issuerCondition)) throw invoiceError("La condición fiscal del emisor es obligatoria.");
    if (!RECIPIENT_CONDITIONS.has(recipientCondition)) throw invoiceError("La condición fiscal del cliente es obligatoria.");
    if (!isIsoDate(invoiceDate)) throw invoiceError("La fecha del comprobante no es válida.");

    const suggestedType = suggestReceiptType(issuerCondition, recipientCondition);
    if (!suggestedType) throw invoiceError("No hay una regla fiscal inequívoca para las condiciones seleccionadas.");
    if (suggestedType !== receiptType) {
      throw invoiceError(`Las condiciones seleccionadas requieren revisar ${displayReceiptType(suggestedType)}.`);
    }

    const vatRates = body.vatRates && typeof body.vatRates === "object" ? body.vatRates : {};
    const lines = current.productos.map((product) => {
      const rate = Number(vatRates[product.id_detalle_pedido]);
      if (!VAT_RATES.includes(rate)) {
        throw invoiceError(`Seleccioná la alícuota de IVA de ${product.producto}.`);
      }
      if (receiptType === "Factura_C" && rate !== 0) {
        throw invoiceError(`Factura C requiere IVA 0% para ${product.producto}.`);
      }
      const calculation = calculateLine({
        boxes: product.cantidad_cajas,
        unitsPerBox: product.unidades_por_caja,
        unitPrice: product.precio_unidad_individual,
        discountPercent: product.bonificacion,
        vatRate: rate,
        receiptType
      });
      return {
        id: product.id_detalle_pedido,
        productId: product.id_producto,
        description: product.producto,
        ...calculation
      };
    });
    const totals = calculateInvoice(lines);

    const prepared = {
      contractVersion: 1,
      source: "sunnutrition-erp",
      mode: "review_only",
      finalSubmissionAllowed: false,
      invoice: {
        pointOfSale,
        receiptType,
        invoiceDate,
        currency: "PES",
        issuerCondition,
        recipientCondition,
        totals
      },
      customer: {
        name: current.cliente,
        cuit: digits(current.cuit),
        fiscalCondition: recipientCondition,
        address: current.domicilio
      },
      order: {
        id: current.id_pedido,
        date: current.fecha_pedido,
        expectedDeliveryDate: current.fecha_entrega_prevista,
        deliveryStatus: current.entrega.estado,
        actualDeliveryDate: current.entrega.fecha
      },
      lines
    };
    prepared.revision = crypto.createHash("sha256")
      .update(JSON.stringify(prepared))
      .digest("hex");
    prepared.expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    return prepared;
  }

  async function handleAuditPost(request, response) {
    try {
      const body = await readJsonBody(request);
      const status = String(body.status || "");
      const reason = String(body.reason || "");
      if (!AUDIT_STATUSES.has(status) || status === "prepared") {
        throw invoiceError("El estado de auditoría es inválido.");
      }
      if (status === "interrupted" && !INTERRUPTION_REASONS.has(reason)) {
        throw invoiceError("El motivo de interrupción es inválido.");
      }
      appendAudit({
        orderId: backendId(body.orderId),
        status,
        reason: status === "interrupted" ? reason : ""
      });
      return sendJson(response, 200, { ok: true });
    } catch (error) {
      return sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
    }
  }

  function handleAuditGet(_request, response) {
    return sendJson(response, 200, { ok: true, entries: readAudit().slice(-30).reverse() });
  }

  function appendAudit({ orderId, status, reason }) {
    if (!backendId(orderId)) throw invoiceError("El pedido de auditoría es obligatorio.");
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.appendFileSync(auditFile, `${JSON.stringify({
      at: new Date().toISOString(),
      orderId: backendId(orderId),
      status,
      reason
    })}\n`, "utf8");
  }

  function readAudit() {
    if (!fs.existsSync(auditFile)) return [];
    return fs.readFileSync(auditFile, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        return [{
          at: String(entry.at || ""),
          orderId: backendId(entry.orderId),
          status: AUDIT_STATUSES.has(entry.status) ? entry.status : "interrupted",
          reason: INTERRUPTION_REASONS.has(entry.reason) ? entry.reason : ""
        }];
      } catch {
        return [];
      }
    });
  }

  return {
    handleAuditGet,
    handleAuditPost,
    handleOrdersGet,
    handlePreparePost,
    orders,
    prepare,
    readAudit
  };
}

function suggestReceiptType(issuerCondition, recipientCondition) {
  if (issuerCondition === "responsable_inscripto") {
    return ["responsable_inscripto", "monotributista"].includes(recipientCondition)
      ? "Factura_A"
      : "Factura_B";
  }
  if (["monotributista", "exento"].includes(issuerCondition)) return "Factura_C";
  return "";
}

function missingSourceFields({ client, details }) {
  const missing = [];
  if (digits(client.cuit).length !== 11) missing.push("CUIT del cliente");
  if (!String(client.tipo || "").trim()) missing.push("condición fiscal del cliente");
  if (!String(client.direccion || "").trim()) missing.push("domicilio del cliente");
  if (!details.length) missing.push("productos");
  details.forEach((detail, index) => {
    const label = detail.producto || `producto ${index + 1}`;
    if (!detail.producto) missing.push(`nombre de ${label}`);
    if (!(detail.cantidad_cajas > 0)) missing.push(`cajas de ${label}`);
    if (!(detail.unidades_por_caja > 0)) missing.push(`unidades por caja de ${label}`);
    if (!(detail.precio_unidad_individual > 0)) missing.push(`precio individual de ${label}`);
  });
  return [...new Set(missing)];
}

function realDeliveriesByOrder(tables, backendId) {
  const deliveriesById = new Map((tables.entregas?.rows || [])
    .map((delivery) => [backendId(delivery.id_entrega), delivery])
    .filter(([deliveryId]) => Boolean(deliveryId)));
  const result = new Map();
  (tables.entregas_detalle?.rows || []).forEach((relation) => {
    const delivery = deliveriesById.get(backendId(relation.id_entrega));
    const orderId = backendId(relation.id_pedido);
    if (delivery && orderId && !result.has(orderId)) result.set(orderId, delivery);
  });
  return result;
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

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function normalizeText(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function compareExpectedDelivery(left, right) {
  const leftDate = isIsoDate(String(left.fecha_entrega_prevista || ""))
    ? String(left.fecha_entrega_prevista)
    : "";
  const rightDate = isIsoDate(String(right.fecha_entrega_prevista || ""))
    ? String(right.fecha_entrega_prevista)
    : "";
  if (leftDate && rightDate && leftDate !== rightDate) return leftDate.localeCompare(rightDate);
  if (leftDate !== rightDate) return leftDate ? -1 : 1;
  return String(left.id_pedido).localeCompare(String(right.id_pedido), undefined, { numeric: true });
}

function numeric(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function safeIndividualUnits(boxes, unitsPerBox) {
  try {
    return individualUnits(boxes, unitsPerBox);
  } catch {
    return 0;
  }
}

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

function displayReceiptType(value) {
  return value.replace("_", " ");
}

function invoiceError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = {
  compareExpectedDelivery,
  createArcaInvoicingService,
  missingSourceFields,
  realDeliveriesByOrder,
  suggestReceiptType
};
