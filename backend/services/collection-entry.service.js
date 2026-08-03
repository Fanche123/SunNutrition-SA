const { fromCents, toCents } = require("../../shared/money");
const { strictMoneyToCents } = require("../utils/money-input");
const { appendCashSourceMovement, assertCashSourceMovement } = require("./cash-ledger.service");

function createCollectionEntryService({
  backendId,
  backendNextNumericId,
  backendNumber,
  ensureBackendTable,
  loadCache,
  readJsonBody,
  saveBackendCache,
  sendJson,
  failureInjector = () => {}
}) {
  async function handleCollectionFullEntry(request, response) {
    try {
      const body = await readJsonBody(request);
      const operationId = String(body.operationId || "").trim();
      const collection = body.collection || {};
      const details = Array.isArray(body.details) ? body.details : [];
      const retentions = body.retentions || {};
      validateCollection(operationId, collection, details, retentions);
      const operationPayload = stableSerialize({ collection, details, retentions });

      const original = loadCache();
      const cache = JSON.parse(JSON.stringify(original));
      cache.tables ||= {};
      ["cobros", "cobros_detalle", "retenciones_ganancias", "retenciones_iibb", "ventas"]
        .forEach((tableName) => ensureBackendTable(cache.tables, tableName));

      const existing = cache.tables.cobros.rows.find((row) => row._operationId === operationId);
      if (existing) {
        assertSameOperation(existing._operationPayload, operationPayload);
        assertCollectionRelations(cache.tables, existing, operationId, details, retentions);
        assertCashSourceMovement(cache, { sourceType: "cobro", sourceRow: existing, operationId });
        return sendJson(response, 200, { ok: true, idempotent: true, collectionId: existing.id_cobro });
      }

      validateSales(cache.tables, details);
      const collectionId = backendNextNumericId(cache.tables.cobros.rows, "id_cobro");
      const firstDetailId = backendNextNumericId(cache.tables.cobros_detalle.rows, "id_cobros_detalle");
      const timestamp = new Date().toISOString();
      cache.tables.cobros.rows.push({
        _rowNumber: cache.tables.cobros.rows.length + 2,
        id_cobro: collectionId,
        fecha_cobro: collection.fecha,
        metodo: collection.metodo,
        id_cliente: collection.idCliente,
        monto: fromCents(strictMoneyToCents(collection.monto)),
        banco: collection.banco || "",
        _operationId: operationId,
        _operationPayload: operationPayload,
        _editedLocallyAt: timestamp
      });
      failureInjector("after-collection");
      details.forEach((detail, index) => {
        cache.tables.cobros_detalle.rows.push({
          _rowNumber: cache.tables.cobros_detalle.rows.length + 2,
          id_cobros_detalle: firstDetailId + index,
          id_cobro: collectionId,
          id_venta: detail.idVenta,
          monto_cancelado: fromCents(strictMoneyToCents(detail.monto)),
          _operationId: operationId,
          _editedLocallyAt: timestamp
        });
      });
      failureInjector("after-details");
      addRetention(cache.tables, "retenciones_ganancias", "id_retencion_ganancias", {
        amount: retentions.ganancias,
        collectionId,
        date: collection.fecha,
        clientId: collection.idCliente,
        operationId,
        timestamp
      });
      addRetention(cache.tables, "retenciones_iibb", "id_retencion_iibb", {
        amount: retentions.iibb,
        collectionId,
        date: collection.fecha,
        clientId: collection.idCliente,
        operationId,
        timestamp
      });
      appendCashSourceMovement(cache, {
        sourceType: "cobro",
        sourceRow: cache.tables.cobros.rows.at(-1),
        operationId,
        actor: request.accessIdentity?.user,
        registeredAt: timestamp
      });
      updateCounts(cache.tables, ["cobros", "cobros_detalle", "retenciones_ganancias", "retenciones_iibb"]);
      cache.generatedAt = timestamp;
      saveBackendCache(cache);
      return sendJson(response, 200, { ok: true, idempotent: false, collectionId });
    } catch (error) {
      return sendJson(response, error.statusCode || 400, { ok: false, error: `No se guardó el cobro completo: ${error.message}` });
    }
  }

  function validateCollection(operationId, collection, details, retentions) {
    if (!operationId) throw new Error("Falta el identificador de operación.");
    if (!collection.fecha || !collection.metodo || !backendId(collection.idCliente)) {
      throw new Error("Fecha, método y cliente son obligatorios.");
    }
    if (!details.length) throw new Error("El cobro no tiene facturas aplicadas.");
    const collectedCents = strictMoneyToCents(collection.monto);
    const appliedCents = details.reduce((sum, row) => sum + strictMoneyToCents(row.monto), 0);
    const retainedCents = strictMoneyToCents(retentions.ganancias, { emptyAsZero: true })
      + strictMoneyToCents(retentions.iibb, { emptyAsZero: true });
    if (collectedCents < 0 || details.some((row) => (
      !backendId(row.idVenta) || strictMoneyToCents(row.monto) <= 0
    ))) {
      throw new Error("Los montos del cobro deben ser válidos.");
    }
    if (collectedCents + retainedCents !== appliedCents) {
      throw new Error("Cobro más retenciones debe coincidir con el total aplicado.");
    }
  }

  function validateSales(tables, details) {
    const sales = new Map((tables.ventas.rows || []).map((row) => [backendId(row.id_venta), row]));
    const appliedBySale = new Map();
    (tables.cobros_detalle.rows || []).forEach((row) => {
      const saleId = backendId(row.id_venta);
      appliedBySale.set(
        saleId,
        (appliedBySale.get(saleId) || 0) + toCents(backendNumber(row.monto_cancelado))
      );
    });
    for (const detail of details) {
      const saleId = backendId(detail.idVenta);
      const sale = sales.get(saleId);
      if (!sale) throw new Error("Una factura aplicada ya no existe.");
      const remainingCents = toCents(backendNumber(sale.total)) - (appliedBySale.get(saleId) || 0);
      if (strictMoneyToCents(detail.monto) > remainingCents) {
        throw new Error(`El monto aplicado supera el saldo de la factura ${saleId}.`);
      }
    }
  }

  function addRetention(tables, tableName, idColumn, values) {
    const amountCents = strictMoneyToCents(values.amount, { emptyAsZero: true });
    if (amountCents <= 0) return;
    const table = tables[tableName];
    table.rows.push({
      _rowNumber: table.rows.length + 2,
      [idColumn]: backendNextNumericId(table.rows, idColumn),
      id_cobro: values.collectionId,
      fecha: values.date,
      id_cliente: values.clientId,
      monto: fromCents(amountCents),
      _operationId: values.operationId,
      _editedLocallyAt: values.timestamp
    });
  }

  function updateCounts(tables, names) {
    names.forEach((name) => {
      tables[name].rowCount = tables[name].rows.length;
    });
  }

  function assertSameOperation(existingPayload, requestedPayload) {
    if (existingPayload === requestedPayload) return;
    const error = new Error("La clave de operación ya fue usada con un contenido diferente.");
    error.statusCode = 409;
    throw error;
  }

  function assertCollectionRelations(tables, collection, operationId, details, retentions) {
    const collectionId = backendId(collection.id_cobro);
    const savedDetails = tables.cobros_detalle.rows.filter((row) => (
      row._operationId === operationId && backendId(row.id_cobro) === collectionId
    ));
    const expectedRetentions = [
      strictMoneyToCents(retentions.ganancias, { emptyAsZero: true }) > 0 ? "retenciones_ganancias" : "",
      strictMoneyToCents(retentions.iibb, { emptyAsZero: true }) > 0 ? "retenciones_iibb" : ""
    ].filter(Boolean);
    const savedRetentionTables = expectedRetentions.filter((tableName) => (
      tables[tableName].rows.some((row) => row._operationId === operationId && backendId(row.id_cobro) === collectionId)
    ));
    if (savedDetails.length !== details.length || savedRetentionTables.length !== expectedRetentions.length) {
      throwConflict("La operación existente tiene asociaciones incompletas o contradictorias.");
    }
  }

  function throwConflict(message) {
    const error = new Error(message);
    error.statusCode = 409;
    throw error;
  }

  function stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value ?? null);
  }

  return { handleCollectionFullEntry };
}

module.exports = { createCollectionEntryService };
