const { normalize: normalizeMoney, toCents } = require("../../shared/money");

function createSalesOrderEntryService({
  backendId,
  backendNextNumericId,
  backendNumber,
  ensureBackendTable,
  isIsoDate,
  loadCache,
  readJsonBody,
  saveBackendCache,
  sendJson,
  failureInjector = () => {}
}) {
  async function handleSalesOrderFullEntry(request, response) {
    try {
      const body = await readJsonBody(request);
      const order = body.order || {};
      const details = Array.isArray(body.details) ? body.details : [];
      validatePayload(order, details);

      const cache = JSON.parse(JSON.stringify(loadCache()));
      cache.tables ||= {};
      ["clientes", "productos", "pedidos", "detalle_pedidos"]
        .forEach((tableName) => ensureBackendTable(cache.tables, tableName));
      validateReferences(cache.tables, order, details);

      const orderId = backendNextNumericId(cache.tables.pedidos.rows, "id_pedido");
      const firstDetailId = backendNextNumericId(cache.tables.detalle_pedidos.rows, "id_detalle_pedido");
      const timestamp = new Date().toISOString();
      cache.tables.pedidos.rows.push({
        _rowNumber: cache.tables.pedidos.rows.length + 2,
        id_pedido: orderId,
        fecha_pedido: order.fechaPedido,
        id_cliente: backendId(order.idCliente),
        fecha_entrega: order.fechaEntrega,
        fecha_original: order.fechaOriginal || order.fechaEntrega,
        _editedLocallyAt: timestamp
      });
      failureInjector("after-order");

      details.forEach((detail, index) => {
        cache.tables.detalle_pedidos.rows.push({
          _rowNumber: cache.tables.detalle_pedidos.rows.length + 2,
          id_detalle_pedido: firstDetailId + index,
          id_pedido: orderId,
          id_producto: backendId(detail.idProducto),
          cantidad_cajas: backendNumber(detail.cantidadCajas),
          impuesto: String(detail.impuesto).trim(),
          precio_ud: normalizeMoney(backendNumber(detail.precioUd)),
          bonificacion: percentagePoints(detail.bonificacion),
          _editedLocallyAt: timestamp
        });
      });
      failureInjector("after-details");

      cache.tables.pedidos.rowCount = cache.tables.pedidos.rows.length;
      cache.tables.detalle_pedidos.rowCount = cache.tables.detalle_pedidos.rows.length;
      cache.generatedAt = timestamp;
      failureInjector("before-save");
      saveBackendCache(cache);
      return sendJson(response, 200, {
        ok: true,
        orderId,
        detailIds: details.map((_, index) => firstDetailId + index)
      });
    } catch (error) {
      return sendJson(response, 400, {
        ok: false,
        error: `No se guardó el pedido completo: ${error.message}`
      });
    }
  }

  function validatePayload(order, details) {
    if (!backendId(order.idCliente)) throw new Error("El cliente es obligatorio.");
    if (!isIsoDate(order.fechaPedido) || !isIsoDate(order.fechaEntrega)) {
      throw new Error("Las fechas de pedido y entrega son inválidas.");
    }
    if (order.fechaOriginal && !isIsoDate(order.fechaOriginal)) {
      throw new Error("La fecha original es inválida.");
    }
    if (!details.length) throw new Error("El pedido debe tener al menos un detalle.");

    details.forEach((detail) => {
      const quantity = Number(detail.cantidadCajas);
      let priceCents;
      let discount;
      try {
        priceCents = toCents(detail.precioUd);
        discount = percentagePoints(detail.bonificacion);
      } catch {
        throw new Error("El precio unitario debe ser un importe y la bonificación un porcentaje válidos.");
      }
      if (!backendId(detail.idProducto)) throw new Error("Todos los detalles deben tener un producto.");
      if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("La cantidad de cajas debe ser mayor que cero.");
      if (priceCents < 0) throw new Error("El precio unitario no puede ser negativo.");
      if (discount < 0) throw new Error("La bonificación no puede ser negativa.");
      if (!["A", "B"].includes(String(detail.impuesto || "").trim())) {
        throw new Error("El impuesto del detalle es inválido.");
      }
    });
  }

  function percentagePoints(value) {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Porcentaje inválido.");
      return value;
    }
    const text = String(value ?? "").trim();
    if (!text) return 0;
    const withoutSymbol = text.endsWith("%") ? text.slice(0, -1).trim() : text;
    if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(withoutSymbol)) {
      throw new Error("Porcentaje inválido.");
    }
    const number = Number(withoutSymbol.replace(",", "."));
    if (!Number.isFinite(number)) throw new Error("Porcentaje inválido.");
    return number;
  }

  function validateReferences(tables, order, details) {
    const clientIds = new Set(tables.clientes.rows.map((row) => backendId(row.id_cliente)));
    if (!clientIds.has(backendId(order.idCliente))) throw new Error("El cliente seleccionado no existe.");

    const productIds = new Set(tables.productos.rows.map((row) => backendId(row.id_producto)));
    if (details.some((detail) => !productIds.has(backendId(detail.idProducto)))) {
      throw new Error("Uno o más productos seleccionados no existen.");
    }
  }

  return { handleSalesOrderFullEntry };
}

module.exports = { createSalesOrderEntryService };
