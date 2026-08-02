const {
  fromCents,
  normalize: normalizeMoney,
  toCents
} = require("../../shared/money");
const {
  discountedSubtotalCents,
  individualUnits
} = require("../../shared/order-pricing");

function expectedOrderSubtotal(details = []) {
  const missingFields = new Set();
  const lines = details.map((detail) => {
    const boxes = finitePositiveNumber(detail.cantidad_cajas);
    const unitsPerBox = finitePositiveNumber(detail.unidades_por_caja);
    const unitPriceCents = moneyCentsOrNull(detail.precio_unitario);
    const discount = percentageOrNull(detail.bonificacion);
    if (boxes === null) missingFields.add("cantidad de cajas");
    if (unitsPerBox === null) missingFields.add("unidades por caja");
    if (unitPriceCents === null) missingFields.add("precio unitario");
    if (discount === null) missingFields.add("bonificación");

    const units = boxes === null || unitsPerBox === null ? null : individualUnits(boxes, unitsPerBox);
    let subtotalCents = null;
    if (units !== null && unitPriceCents !== null && discount !== null) {
      subtotalCents = discountedSubtotalCents(fromCents(unitPriceCents), units, discount);
    }
    return {
      id_producto: detail.id_producto,
      producto: String(detail.producto || ""),
      cantidad_cajas: boxes,
      unidades_por_caja: unitsPerBox,
      unidades_individuales: units,
      precio_unitario: unitPriceCents === null ? null : fromCents(unitPriceCents),
      bonificacion: discount,
      subtotal_esperado: subtotalCents === null ? null : fromCents(subtotalCents)
    };
  });
  if (!lines.length) missingFields.add("detalle del pedido");
  const complete = missingFields.size === 0;
  const subtotalCents = complete
    ? lines.reduce((total, line) => total + toCents(line.subtotal_esperado), 0)
    : null;
  return {
    estado: complete ? "calculable" : "datos_insuficientes",
    campos_faltantes: [...missingFields],
    subtotal_esperado: subtotalCents === null ? null : fromCents(subtotalCents),
    lineas: lines
  };
}

function finitePositiveNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function moneyCentsOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  try {
    const cents = toCents(value);
    return cents >= 0 ? cents : null;
  } catch {
    return null;
  }
}

function percentageOrNull(value) {
  if (value === "" || value === null || value === undefined) return 0;
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function createSalesInvoiceEntryService({
  backendId,
  backendNextNumericId,
  ensureBackendTable,
  isIsoDate,
  loadCache,
  readJsonBody,
  saveBackendCache,
  sendJson,
  synchronizeEconomicExpenses = (cache) => cache,
  failureInjector = () => {},
  enqueueSalesWrite = (operation) => operation(),
  crypto,
  fs,
  path,
  rootDir
}) {
  function unbilledOrders(cache = loadCache()) {
    const tables = cache.tables || {};
    const billedOrderIds = new Set((tables.ventas?.rows || [])
      .map((sale) => backendId(sale.id_pedido))
      .filter(Boolean));
    const clientsById = new Map((tables.clientes?.rows || [])
      .map((client) => [backendId(client.id_cliente), client]));
    const productsById = new Map((tables.productos?.rows || [])
      .map((product) => [backendId(product.id_producto), product]));
    const detailsByOrder = new Map();
    (tables.detalle_pedidos?.rows || []).forEach((detail) => {
      const orderId = backendId(detail.id_pedido);
      if (!detailsByOrder.has(orderId)) detailsByOrder.set(orderId, []);
      detailsByOrder.get(orderId).push(detail);
    });
    const deliveryByOrder = validDeliveryByOrder(cache, backendId);

    return (tables.pedidos?.rows || [])
      .filter((order) => !billedOrderIds.has(backendId(order.id_pedido)))
      .map((order) => {
        const orderId = backendId(order.id_pedido);
        const client = clientsById.get(backendId(order.id_cliente)) || {};
        const delivery = deliveryByOrder.get(orderId) || null;
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
        const expectedSubtotal = expectedOrderSubtotal(details);
        return {
          id_pedido: orderId,
          fecha_pedido: order.fecha_pedido || "",
          fecha_entrega_pedida: order.fecha_entrega || "",
          id_cliente: backendId(order.id_cliente),
          cliente: client.nombre_cliente || "",
          cuit_cliente: client.cuit || client.CUIT || "",
          plazo_cobro: client.plazo_cobro ?? "",
          id_entrega: delivery ? backendId(delivery.id_entrega) : "",
          fecha_entrega: delivery?.fecha || "",
          cantidad_cajas: details.reduce((total, detail) => total + detail.cantidad_cajas, 0),
          productos: details,
          comparacion_factura: expectedSubtotal
        };
      });
  }

  function handleUnbilledOrdersGet(_request, response) {
    return sendJson(response, 200, { ok: true, orders: unbilledOrders() });
  }

  function handleSalesDeliveryFullEntry(request, response) {
    return enqueueSalesWrite(() => persistSalesDelivery(request, response));
  }

  async function persistSalesDelivery(request, response) {
    try {
      const body = await readJsonBody(request);
      const orderIds = [...new Set((Array.isArray(body.orderIds) ? body.orderIds : [])
        .map(backendId)
        .filter(Boolean))];
      const fleetId = backendId(body.fleetId);
      const deliveryDate = String(body.deliveryDate || "").trim();
      if (!orderIds.length) throw httpError(400, "Seleccioná al menos un pedido.");
      if (!fleetId) throw httpError(400, "El flete es obligatorio.");
      if (!isIsoDate(deliveryDate)) throw httpError(400, "La fecha de entrega es inválida.");

      const cache = JSON.parse(JSON.stringify(loadCache()));
      cache.tables ||= {};
      ["pedidos", "fletes", "entregas", "entregas_detalle", "ventas"]
        .forEach((tableName) => ensureBackendTable(cache.tables, tableName));
      const knownOrders = new Set(cache.tables.pedidos.rows.map((row) => backendId(row.id_pedido)));
      if (orderIds.some((orderId) => !knownOrders.has(orderId))) {
        throw httpError(404, "Uno o más pedidos ya no existen.");
      }
      if (!cache.tables.fletes.rows.some((row) => backendId(row.id_flete) === fleetId)) {
        throw httpError(400, "El flete seleccionado no existe.");
      }
      const deliveredOrders = deliveryAssociationOrderIds(cache, backendId);
      if (orderIds.some((orderId) => deliveredOrders.has(orderId))) {
        throw httpError(409, "Uno o más pedidos ya tienen una entrega asociada.");
      }

      const deliveryId = backendNextNumericId(cache.tables.entregas.rows, "id_entrega");
      const firstDetailId = backendNextNumericId(cache.tables.entregas_detalle.rows, "id_entregas_detalle");
      const timestamp = new Date().toISOString();
      cache.tables.entregas.rows.push({
        _rowNumber: cache.tables.entregas.rows.length + 2,
        id_entrega: deliveryId,
        fecha: deliveryDate,
        id_flete: fleetId,
        _editedLocallyAt: timestamp
      });
      orderIds.forEach((orderId, index) => {
        cache.tables.entregas_detalle.rows.push({
          _rowNumber: cache.tables.entregas_detalle.rows.length + 2,
          id_entregas_detalle: firstDetailId + index,
          id_entrega: deliveryId,
          id_pedido: orderId,
          _editedLocallyAt: timestamp
        });
      });
      cache.tables.ventas.rows.forEach((sale) => {
        if (orderIds.includes(backendId(sale.id_pedido))) sale.id_entrega = deliveryId;
      });
      cache.tables.entregas.rowCount = cache.tables.entregas.rows.length;
      cache.tables.entregas_detalle.rowCount = cache.tables.entregas_detalle.rows.length;
      cache.generatedAt = timestamp;
      const synchronizedCache = synchronizeEconomicExpenses(cache, "entregas") || cache;
      saveBackendCache(synchronizedCache);
      return sendJson(response, 200, { ok: true, deliveryId, orderIds });
    } catch (error) {
      return sendJson(response, error.statusCode || 400, {
        ok: false,
        error: `No se guardó la entrega: ${error.message}`
      });
    }
  }

  function handleSalesInvoiceFullEntry(request, response) {
    return enqueueSalesWrite(() => persistSalesInvoice(request, response));
  }

  async function persistSalesInvoice(request, response) {
    let storedAttachment = null;
    let committed = false;
    try {
      const body = await readJsonBody(request);
      const orderIds = Array.isArray(body.orderIds) ? body.orderIds.map(backendId).filter(Boolean) : [];
      if (orderIds.length !== 1) {
        throw httpError(400, "Seleccioná un solo pedido por factura; el modelo actual no define reparto de importes entre pedidos.");
      }
      const invoice = normalizeInvoice(body.invoice || {});
      const workflowMode = body.workflow === true;
      const attachment = normalizeSalesAttachment(body.attachment, workflowMode);
      const source = loadCache();
      const cache = JSON.parse(JSON.stringify(source));
      cache.tables ||= {};
      ["pedidos", "clientes", "entregas", "entregas_detalle", "ventas", "gestion_ventas"]
        .forEach((tableName) => ensureBackendTable(cache.tables, tableName));

      const orderId = orderIds[0];
      const order = cache.tables.pedidos.rows.find((row) => backendId(row.id_pedido) === orderId);
      if (!order) throw httpError(404, "El pedido seleccionado ya no existe.");
      const existingOrderSale = cache.tables.ventas.rows
        .find((sale) => backendId(sale.id_pedido) === orderId);
      if (existingOrderSale && sameInvoice(existingOrderSale, invoice, clientIdFromOrder(order))) {
        if (attachment) {
          storedAttachment = storeSalesAttachment(cache, orderId, attachment, new Date().toISOString());
          cache.tables.gestion_ventas.rowCount = cache.tables.gestion_ventas.rows.length;
          cache.generatedAt = new Date().toISOString();
          saveBackendCache(cache);
          committed = true;
        }
        return sendJson(response, 200, {
          ok: true,
          saleId: existingOrderSale.id_venta,
          orderId,
          idempotent: true,
          ...(storedAttachment ? { attachmentPath: storedAttachment.relativePath } : {})
        });
      }
      if (existingOrderSale) {
        throw httpError(409, "El pedido fue facturado por otra operación. Actualizá la lista.");
      }
      const clientId = backendId(order.id_cliente);
      if (!cache.tables.clientes.rows.some((client) => backendId(client.id_cliente) === clientId)) {
        throw httpError(400, "El cliente del pedido no existe.");
      }
      if (cache.tables.ventas.rows.some((sale) => (
        backendId(sale.id_cliente) === clientId
        && normalizeFiscalText(sale.tipo_factura) === normalizeFiscalText(invoice.tipoFactura)
        && normalizeFiscalText(sale.nro_factura) === normalizeFiscalText(invoice.nroFactura)
      ))) {
        throw httpError(409, "La factura ya está registrada para este cliente.");
      }

      const deliveryId = backendId(validDeliveryByOrder(cache, backendId).get(orderId)?.id_entrega);

      const saleId = backendNextNumericId(cache.tables.ventas.rows, "id_venta");
      const timestamp = new Date().toISOString();
      cache.tables.ventas.rows.push({
        _rowNumber: cache.tables.ventas.rows.length + 2,
        id_venta: saleId,
        id_pedido: orderId,
        id_cliente: clientId,
        id_entrega: deliveryId,
        tipo_factura: invoice.tipoFactura,
        nro_factura: invoice.nroFactura,
        fecha_factura: invoice.fechaFactura,
        fecha_acordada: invoice.fechaAcordada,
        iva: invoice.iva,
        subtotal: invoice.subtotal,
        total: invoice.total,
        _editedLocallyAt: timestamp
      });
      cache.tables.ventas.rowCount = cache.tables.ventas.rows.length;
      if (attachment) storedAttachment = storeSalesAttachment(cache, orderId, attachment, timestamp);
      cache.tables.gestion_ventas.rowCount = cache.tables.gestion_ventas.rows.length;
      cache.generatedAt = timestamp;
      failureInjector("before-economic-sync");
      const synchronizedCache = synchronizeEconomicExpenses(cache, "ventas") || cache;
      failureInjector("before-save");
      saveBackendCache(synchronizedCache);
      committed = true;
      return sendJson(response, 200, {
        ok: true,
        saleId,
        orderId,
        ...(storedAttachment ? { attachmentPath: storedAttachment.relativePath } : {})
      });
    } catch (error) {
      if (storedAttachment?.created && !committed) {
        try { fs?.unlinkSync(storedAttachment.absolutePath); } catch {}
      }
      return sendJson(response, error.statusCode || 400, {
        ok: false,
        error: `No se guardó la venta: ${error.message}`
      });
    }
  }

  function normalizeSalesAttachment(value, required) {
    if (!value && !required) return null;
    if (!value || typeof value !== "object") throw httpError(400, "Adjuntá la factura en PDF o imagen.");
    const fileName = sanitizeFileName(value.fileName);
    const dataUrl = String(value.fileDataUrl || "");
    const match = dataUrl.match(/^data:(application\/pdf|image\/(?:png|jpeg|jpg|webp));base64,([a-zA-Z0-9+/=\r\n]+)$/);
    if (!fileName || !match) throw httpError(400, "El adjunto debe ser un PDF o imagen válido.");
    const buffer = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
    if (!buffer.length || buffer.length > 20 * 1024 * 1024) {
      throw httpError(400, "El adjunto está vacío o supera 20 MB.");
    }
    const mimeType = match[1] === "image/jpg" ? "image/jpeg" : match[1];
    const extension = attachmentExtension(mimeType, buffer);
    return {
      buffer,
      fileName,
      mimeType,
      extension,
      hash: crypto.createHash("sha256").update(buffer).digest("hex")
    };
  }

  function attachmentExtension(mimeType, buffer) {
    const signatures = {
      "application/pdf": () => buffer.subarray(0, 5).toString("ascii") === "%PDF-",
      "image/png": () => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      "image/jpeg": () => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
      "image/webp": () => buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP"
    };
    const extensions = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
    if (!signatures[mimeType]?.()) throw httpError(400, "El contenido del adjunto no coincide con un PDF o imagen válido.");
    return extensions[mimeType];
  }

  function storeSalesAttachment(cache, orderId, attachment, timestamp) {
    if (!fs || !path || !rootDir || !crypto) throw httpError(500, "El almacenamiento de adjuntos no está configurado.");
    const workflow = ensureInvoiceWorkflowRow(cache, orderId, timestamp);
    if (workflow.archivo_factura_hash) {
      if (workflow.archivo_factura_hash !== attachment.hash) {
        throw httpError(409, "El pedido ya tiene otro adjunto de factura registrado.");
      }
      return {
        absolutePath: path.join(rootDir, workflow.archivo_factura),
        relativePath: workflow.archivo_factura,
        created: false
      };
    }
    const directory = path.join(rootDir, "backend", "attachments", "ventas");
    fs.mkdirSync(directory, { recursive: true });
    const storedName = `${sanitizeFileName(orderId)}-${attachment.hash.slice(0, 16)}.${attachment.extension}`;
    const absolutePath = path.join(directory, storedName);
    const relativePath = path.relative(rootDir, absolutePath).replace(/\\/g, "/");
    let created = false;
    if (!fs.existsSync(absolutePath)) {
      fs.writeFileSync(absolutePath, attachment.buffer, { flag: "wx" });
      created = true;
    }
    workflow.archivo_factura = relativePath;
    workflow.archivo_factura_nombre = attachment.fileName;
    workflow.archivo_factura_hash = attachment.hash;
    workflow.actualizado_en = timestamp;
    return { absolutePath, relativePath, created };
  }

  function ensureInvoiceWorkflowRow(cache, orderId, timestamp) {
    const table = cache.tables.gestion_ventas;
    const matches = table.rows.filter((row) => backendId(row.id_pedido) === orderId);
    if (matches.length > 1) throw httpError(409, `El pedido ${orderId} tiene estados de gestión duplicados.`);
    if (matches.length === 1) return matches[0];
    const row = {
      _rowNumber: table.rows.length + 2,
      id_gestion_venta: backendNextNumericId(table.rows, "id_gestion_venta"),
      id_pedido: orderId,
      origen: "historico_incompleto",
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
    return row;
  }

  function sanitizeFileName(value) {
    return String(value || "factura")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 120) || "factura";
  }

  function normalizeInvoice(invoice) {
    const tipoFactura = String(invoice.tipoFactura || "").trim();
    const nroFactura = String(invoice.nroFactura || "").trim();
    const fechaFactura = String(invoice.fechaFactura || "").trim();
    const fechaAcordada = String(invoice.fechaAcordada || "").trim();
    if (!["Factura_A", "Factura_B", "Factura_C", "Remito_X"].includes(tipoFactura)) {
      throw httpError(400, "El tipo de factura es inválido.");
    }
    if (!nroFactura || nroFactura.length > 120) throw httpError(400, "El número de factura es obligatorio.");
    if (!isIsoDate(fechaFactura)) throw httpError(400, "La fecha de factura es inválida.");
    if (fechaAcordada && !isIsoDate(fechaAcordada)) throw httpError(400, "La fecha acordada es inválida.");
    const subtotalCents = validMoneyCents(invoice.subtotal, "subtotal");
    const ivaCents = validMoneyCents(invoice.iva, "IVA");
    const totalCents = validMoneyCents(invoice.total, "total");
    if (subtotalCents + ivaCents !== totalCents) {
      throw httpError(400, "Subtotal más IVA debe coincidir con el total.");
    }
    return {
      tipoFactura,
      nroFactura,
      fechaFactura,
      fechaAcordada,
      subtotal: normalizeMoney(invoice.subtotal),
      iva: normalizeMoney(invoice.iva),
      total: normalizeMoney(invoice.total)
    };
  }

  function validMoneyCents(value, label) {
    let cents;
    try {
      cents = toCents(value);
    } catch {
      throw httpError(400, `El ${label} es inválido.`);
    }
    if (cents < 0) throw httpError(400, `El ${label} no puede ser negativo.`);
    return cents;
  }

  function normalizeFiscalText(value) {
    return String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  }

  function clientIdFromOrder(order) {
    return backendId(order?.id_cliente);
  }

  function sameInvoice(sale, invoice, clientId) {
    return backendId(sale.id_cliente) === backendId(clientId)
      && normalizeFiscalText(sale.tipo_factura) === normalizeFiscalText(invoice.tipoFactura)
      && normalizeFiscalText(sale.nro_factura) === normalizeFiscalText(invoice.nroFactura)
      && String(sale.fecha_factura || "") === invoice.fechaFactura
      && String(sale.fecha_acordada || "") === invoice.fechaAcordada
      && toCents(sale.subtotal) === toCents(invoice.subtotal)
      && toCents(sale.iva) === toCents(invoice.iva)
      && toCents(sale.total) === toCents(invoice.total);
  }

  function httpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
  }

  return {
    handleSalesDeliveryFullEntry,
    handleSalesInvoiceFullEntry,
    handleUnbilledOrdersGet,
    unbilledOrders
  };
}

function deliveryAssociationOrderIds(cache, backendId) {
  return new Set(validDeliveryByOrder(cache, backendId).keys());
}

function validDeliveryByOrder(cache, backendId) {
  const deliveriesById = new Map((cache?.tables?.entregas?.rows || [])
    .map((delivery) => [backendId(delivery.id_entrega), delivery])
    .filter(([deliveryId]) => Boolean(deliveryId)));
  const result = new Map();
  (cache?.tables?.entregas_detalle?.rows || []).forEach((relation) => {
    const orderId = backendId(relation.id_pedido);
    const delivery = deliveriesById.get(backendId(relation.id_entrega));
    if (orderId && delivery && !result.has(orderId)) result.set(orderId, delivery);
  });
  return result;
}

module.exports = {
  createSalesInvoiceEntryService,
  deliveryAssociationOrderIds,
  expectedOrderSubtotal,
  validDeliveryByOrder
};
