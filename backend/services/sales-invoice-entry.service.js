const { normalize: normalizeMoney, toCents } = require("../../shared/money");

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
  failureInjector = () => {}
}) {
  let invoiceWriteQueue = Promise.resolve();

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
    const deliveryByOrder = new Map();
    const deliveriesById = new Map((tables.entregas?.rows || [])
      .map((delivery) => [backendId(delivery.id_entrega), delivery]));
    (tables.entregas_detalle?.rows || []).forEach((relation) => {
      const orderId = backendId(relation.id_pedido);
      const deliveryId = backendId(relation.id_entrega);
      if (orderId && deliveryId && !deliveryByOrder.has(orderId)) {
        deliveryByOrder.set(orderId, deliveriesById.get(deliveryId) || { id_entrega: deliveryId });
      }
    });

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
            cantidad_cajas: Number(detail.cantidad_cajas) || 0
          };
        });
        return {
          id_pedido: orderId,
          fecha_pedido: order.fecha_pedido || "",
          fecha_entrega_pedida: order.fecha_entrega || "",
          id_cliente: backendId(order.id_cliente),
          cliente: client.nombre_cliente || "",
          cuit_cliente: client.cuit || client.CUIT || "",
          id_entrega: delivery ? backendId(delivery.id_entrega) : "",
          fecha_entrega: delivery?.fecha || "",
          cantidad_cajas: details.reduce((total, detail) => total + detail.cantidad_cajas, 0),
          productos: details
        };
      });
  }

  function handleUnbilledOrdersGet(_request, response) {
    return sendJson(response, 200, { ok: true, orders: unbilledOrders() });
  }

  function handleSalesDeliveryFullEntry(request, response) {
    const operation = invoiceWriteQueue.then(() => persistSalesDelivery(request, response));
    invoiceWriteQueue = operation.catch(() => undefined);
    return operation;
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
      const deliveredOrders = new Set(cache.tables.entregas_detalle.rows
        .map((row) => backendId(row.id_pedido)));
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
    const operation = invoiceWriteQueue.then(() => persistSalesInvoice(request, response));
    invoiceWriteQueue = operation.catch(() => undefined);
    return operation;
  }

  async function persistSalesInvoice(request, response) {
    try {
      const body = await readJsonBody(request);
      const orderIds = Array.isArray(body.orderIds) ? body.orderIds.map(backendId).filter(Boolean) : [];
      if (orderIds.length !== 1) {
        throw httpError(400, "Seleccioná un solo pedido por factura; el modelo actual no define reparto de importes entre pedidos.");
      }
      const invoice = normalizeInvoice(body.invoice || {});
      const source = loadCache();
      const cache = JSON.parse(JSON.stringify(source));
      cache.tables ||= {};
      ["pedidos", "clientes", "entregas", "entregas_detalle", "ventas"]
        .forEach((tableName) => ensureBackendTable(cache.tables, tableName));

      const orderId = orderIds[0];
      const order = cache.tables.pedidos.rows.find((row) => backendId(row.id_pedido) === orderId);
      if (!order) throw httpError(404, "El pedido seleccionado ya no existe.");
      const existingOrderSale = cache.tables.ventas.rows
        .find((sale) => backendId(sale.id_pedido) === orderId);
      if (existingOrderSale && sameInvoice(existingOrderSale, invoice, clientIdFromOrder(order))) {
        return sendJson(response, 200, {
          ok: true,
          saleId: existingOrderSale.id_venta,
          orderId,
          idempotent: true
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

      const deliveryRelation = cache.tables.entregas_detalle.rows
        .find((row) => backendId(row.id_pedido) === orderId);
      const deliveryId = backendId(deliveryRelation?.id_entrega);
      if (deliveryId && !cache.tables.entregas.rows.some((row) => backendId(row.id_entrega) === deliveryId)) {
        throw httpError(409, "La entrega asociada al pedido ya no existe.");
      }

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
      cache.generatedAt = timestamp;
      failureInjector("before-economic-sync");
      const synchronizedCache = synchronizeEconomicExpenses(cache, "ventas") || cache;
      failureInjector("before-save");
      saveBackendCache(synchronizedCache);
      return sendJson(response, 200, { ok: true, saleId, orderId });
    } catch (error) {
      return sendJson(response, error.statusCode || 400, {
        ok: false,
        error: `No se guardó la venta: ${error.message}`
      });
    }
  }

  function normalizeInvoice(invoice) {
    const tipoFactura = String(invoice.tipoFactura || "").trim();
    const nroFactura = String(invoice.nroFactura || "").trim();
    const fechaFactura = String(invoice.fechaFactura || "").trim();
    const fechaAcordada = String(invoice.fechaAcordada || "").trim();
    if (!["Factura_A", "Factura_B", "Factura_C"].includes(tipoFactura)) {
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

module.exports = { createSalesInvoiceEntryService };
