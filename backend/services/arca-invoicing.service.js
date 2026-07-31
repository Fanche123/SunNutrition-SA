const {
  calculateInvoice,
  calculateLine,
  calculateMeasuredLine,
  individualUnits
} = require("../../shared/order-pricing");
const { parseStrictMoneyInput } = require("../utils/money-input");
const { isIsoDate } = require("../utils/runtime");
const ARCA_FISCAL = require("../../tools/arca-extension/arca-fiscal-contract");

const AUDIT_STATUSES = new Set(["prepared", "review_reached", "interrupted"]);
const SESSION_TTL_MS = 5 * 60 * 1000;
const INTERRUPTION_REASONS = new Set([
  "extension_unavailable",
  "association_failed",
  "contract_incompatible",
  "invalid_extension_response",
  "manual_abort",
  "network_error",
  "origin_rejected",
  "payload_invalid",
  "screen_unrecognized",
  "selector_changed",
  "session_expired",
  "timeout",
  "unexpected_response"
]);
function createArcaInvoicingService({
  auditFile,
  backendId,
  calendarToday = () => ARCA_FISCAL.argentinaCalendarIso(new Date()),
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
        const productName = ARCA_FISCAL.normalizeDisplayText(product.nombre_producto);
        const arcaUnit = ARCA_FISCAL.classifyProduct(productName);
        const boxes = numeric(detail.cantidad_cajas);
        const unitsPerBox = numeric(product.cantidad_individual);
        const arcaQuantity = arcaUnit === "units"
          ? safeIndividualUnits(boxes, unitsPerBox)
          : (arcaUnit === "kilograms" ? boxes : 0);
        return {
          id_detalle_pedido: backendId(detail.id_detalle_pedido),
          id_producto: backendId(detail.id_producto),
          producto: productName,
          clasificacion_arca: arcaUnit,
          cantidad_cajas: boxes,
          unidades_por_caja: arcaUnit === "units" ? unitsPerBox : null,
          unidades_individuales: arcaUnit === "units" ? arcaQuantity : null,
          cantidad_arca: arcaQuantity,
          unidad_arca: arcaUnit === "units"
            ? ARCA_FISCAL.AUTOMATION.unitsText
            : (arcaUnit === "kilograms" ? ARCA_FISCAL.AUTOMATION.kilogramsText : ""),
          precio_unidad_individual: moneyValue(detail.precio_ud),
          bonificacion: percentageValue(detail.bonificacion)
        };
      });
      const missing = missingSourceFields({ client, details });
      return {
        id_pedido: orderId,
        fecha_pedido: order.fecha_pedido || "",
        fecha_entrega_prevista: order.fecha_entrega || "",
        cliente: client.nombre_cliente || "",
        id_cliente: backendId(order.id_cliente),
        tipo_comprobante_configurado: normalizeReceiptType(client.tipo_comprobante),
        cuit: client.cuit || "",
        domicilio: [client.direccion, client.localidad].filter(Boolean).join(", "),
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

    const receiptType = String(body.receiptType || "").trim();
    const invoiceDate = String(body.invoiceDate || "").trim();
    const receiptRule = ARCA_FISCAL.ruleForReceipt(receiptType);
    if (!receiptRule) throw invoiceError("Seleccioná únicamente Factura A o Factura B.");
    if (!isIsoDate(invoiceDate)) {
      throw invoiceError("Ingresá una fecha válida para el comprobante.");
    }
    const dateValidation = ARCA_FISCAL.validateProductInvoiceDate(invoiceDate, calendarToday());
    if (!dateValidation.ok) {
      throw invoiceError(
        "La fecha del comprobante no es admitida por ARCA para Productos: debe estar dentro de los 5 días "
        + "anteriores o posteriores y una fecha futura no puede pasar al mes siguiente. Corregila antes de abrir ARCA."
      );
    }
    assertFixedFiscalOverrides(body, receiptRule, current.productos);

    const lines = current.productos.map((product) => {
      const isUnits = product.clasificacion_arca === "units";
      const calculation = isUnits
        ? calculateLine({
          boxes: product.cantidad_cajas,
          unitsPerBox: product.unidades_por_caja,
          unitPrice: product.precio_unidad_individual,
          discountPercent: product.bonificacion,
          vatRate: ARCA_FISCAL.CONTRACT.vatRate,
          receiptType
        })
        : calculateMeasuredLine({
          quantity: product.cantidad_arca,
          unitPrice: product.precio_unidad_individual,
          discountPercent: product.bonificacion,
          vatRate: ARCA_FISCAL.CONTRACT.vatRate,
          receiptType
        });
      return {
        id: product.id_detalle_pedido,
        productId: product.id_producto,
        productName: product.producto,
        boxes: product.cantidad_cajas,
        unitsPerBox: isUnits ? product.unidades_por_caja : null,
        quantity: product.cantidad_arca,
        unitValue: isUnits
          ? ARCA_FISCAL.AUTOMATION.unitsValue
          : ARCA_FISCAL.AUTOMATION.kilogramsValue,
        unitText: isUnits
          ? ARCA_FISCAL.AUTOMATION.unitsText
          : ARCA_FISCAL.AUTOMATION.kilogramsText,
        description: ARCA_FISCAL.buildLineDescription(
          product.cantidad_cajas,
          product.producto,
          current.domicilio
        ),
        ...calculation
      };
    });
    const totals = calculateInvoice(lines);

    const prepared = {
      contractVersion: ARCA_FISCAL.CONTRACT.version,
      source: "sunnutrition-erp",
      mode: "review_only",
      finalSubmissionAllowed: false,
      automation: ARCA_FISCAL.AUTOMATION,
      invoice: {
        pointOfSale: ARCA_FISCAL.CONTRACT.pointOfSale,
        receiptType,
        invoiceDate,
        currency: "PES",
        issuerCondition: ARCA_FISCAL.CONTRACT.issuerCondition,
        recipientCondition: receiptRule.recipientCondition,
        recipientConditionLabel: receiptRule.recipientConditionLabel,
        totals
      },
      customer: {
        name: current.cliente,
        cuit: digits(current.cuit),
        fiscalCondition: receiptRule.recipientCondition,
        fiscalConditionLabel: receiptRule.recipientConditionLabel,
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
    if (!ARCA_FISCAL.preparedPayloadIsValid(prepared)) {
      throw invoiceError("El pedido no pudo convertirse al contrato fiscal ARCA vigente.");
    }
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
  if (issuerCondition !== ARCA_FISCAL.CONTRACT.issuerCondition) return "";
  return ARCA_FISCAL.CONTRACT.receiptTypes.find(
    (receiptType) => ARCA_FISCAL.ruleForReceipt(receiptType)?.recipientCondition === recipientCondition
  ) || "";
}

function normalizeReceiptType(value) {
  const match = normalizeText(value).match(/^factura[ _-]*([ab])$/);
  return match ? `Factura_${match[1].toUpperCase()}` : "";
}

function missingSourceFields({ client, details }) {
  const missing = [];
  if (digits(client.cuit).length !== 11) missing.push("CUIT del cliente");
  if (!String(client.direccion || "").trim()) missing.push("domicilio del cliente");
  if (!details.length) missing.push("productos");
  details.forEach((detail, index) => {
    const label = detail.producto || `producto ${index + 1}`;
    if (!detail.producto) missing.push(`nombre de ${label}`);
    if (!detail.clasificacion_arca) missing.push(`clasificación ARCA inequívoca de ${label}`);
    if (!(detail.cantidad_cajas > 0)) missing.push(`cajas de ${label}`);
    if (detail.clasificacion_arca === "units" && !(detail.unidades_por_caja > 0)) {
      missing.push(`unidades por caja de ${label}`);
    }
    if (detail.clasificacion_arca === "kilograms" && !(detail.cantidad_arca > 0)) {
      missing.push(`kilogramos vendidos de ${label}`);
    }
    if (!(detail.precio_unidad_individual > 0)) missing.push(`precio individual de ${label}`);
    if (
      !Number.isFinite(detail.bonificacion)
      || detail.bonificacion < 0
      || detail.bonificacion > 100
    ) missing.push(`bonificación de ${label}`);
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

function moneyValue(value) {
  const parsed = parseStrictMoneyInput(value, { allowNegative: false });
  return parsed.ok && !parsed.empty ? parsed.amount : 0;
}

function percentageValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  const text = String(value ?? "").trim();
  if (!text) return 0;
  const normalized = text.endsWith("%") ? text.slice(0, -1).trim() : text;
  if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(normalized)) return Number.NaN;
  return Number(normalized.replace(",", "."));
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

function assertFixedFiscalOverrides(body, receiptRule, products) {
  assertOptionalFixedValue(body, "pointOfSale", ARCA_FISCAL.CONTRACT.pointOfSale, "punto de venta");
  assertOptionalFixedValue(
    body,
    "issuerCondition",
    ARCA_FISCAL.CONTRACT.issuerCondition,
    "condición fiscal del emisor"
  );
  assertOptionalFixedValue(
    body,
    "recipientCondition",
    receiptRule.recipientCondition,
    "condición fiscal del cliente"
  );
  assertOptionalFixedValue(body, "vatRate", ARCA_FISCAL.CONTRACT.vatRate, "alícuota de IVA");
  if (!Object.prototype.hasOwnProperty.call(body, "vatRates")) return;
  if (!body.vatRates || typeof body.vatRates !== "object" || Array.isArray(body.vatRates)) {
    throw invoiceError("La alícuota de IVA está fijada en 21,00% para todas las líneas.");
  }
  const expectedIds = new Set(products.map((product) => String(product.id_detalle_pedido)));
  const entries = Object.entries(body.vatRates);
  if (entries.some(([id, rate]) => !expectedIds.has(String(id)) || Number(rate) !== ARCA_FISCAL.CONTRACT.vatRate)) {
    throw invoiceError("La alícuota de IVA está fijada en 21,00% para todas las líneas.");
  }
}

function assertOptionalFixedValue(body, key, expected, label) {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return;
  if (String(body[key]) !== String(expected)) {
    throw invoiceError(`No se puede modificar ${label}; el valor fiscal está fijado por el ERP.`);
  }
}

function invoiceError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = {
  ARCA_FISCAL,
  assertFixedFiscalOverrides,
  compareExpectedDelivery,
  createArcaInvoicingService,
  missingSourceFields,
  normalizeReceiptType,
  realDeliveriesByOrder,
  suggestReceiptType
};
