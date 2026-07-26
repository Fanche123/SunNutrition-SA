const { normalize: normalizeMoney, toCents: moneyToCents } = require("../../shared/money");

function createOtherExpenseEntryService(dependencies) {
  const {
    EXPECTED_BACKEND_COLUMNS,
    backendId,
    backendNextNumericId,
    cleanBackendInput,
    ensureBackendTable,
    isIsoDate,
    loadCache,
    readJsonBody,
    saveBackendCache,
    sendJson
  } = dependencies;

  async function handleOtherExpenseFullEntry(request, response) {
    try {
      const body = await readJsonBody(request);
      const input = normalizeOtherExpensePayload(body);
      const validationError = validateOtherExpensePayload(input);
      if (validationError) {
        sendJson(response, 400, { ok: false, error: validationError });
        return;
      }

      const cache = loadCache();
      const tables = cache.tables || (cache.tables = {});
      ["egresos", "otros_gastos", "acreedores", "acreedores_etiquetas", "etiquetas"]
        .forEach((tableName) => ensureBackendTable(tables, tableName));

      const creditor = tables.acreedores.rows.find((row) => backendId(row.id_acreedor) === input.creditorId);
      const creditorTag = tables.acreedores_etiquetas.rows.find((row) =>
        backendId(row.id_acreedor_etiqueta) === input.creditorTagId
        && backendId(row.id_acreedor) === input.creditorId
      );
      const labelId = backendId(creditorTag?.id_etiqueta);
      const labelExists = tables.etiquetas.rows.some((row) => backendId(row.id_etiqueta) === labelId);
      if (!creditor || !creditorTag || !labelExists) {
        sendJson(response, 400, { ok: false, error: "El acreedor o su etiqueta ya no existe." });
        return;
      }

      const expenseId = backendNextNumericId(tables.egresos.rows, "id_egreso");
      const otherExpenseId = backendNextNumericId(tables.otros_gastos.rows, "id_otros_gastos");
      const invoiceNumber = input.invoiceType.toLowerCase().includes("remito")
        ? String(otherExpenseId)
        : input.invoiceNumber;

      tables.egresos.rows.push({
        _rowNumber: tables.egresos.rows.length + 2,
        id_egreso: expenseId,
        fecha_factura: input.invoiceDate,
        fecha_prevista_pago: input.paymentDate || input.invoiceDate,
        id_etiqueta: labelId,
        tipo_factura: input.invoiceType,
        nro_factura: invoiceNumber,
        iva: input.iva,
        per_ret_iva: input.vatRetention,
        per_ret_iibb: input.iibbRetention,
        imp_internos: input.internalTaxes,
        subtotal: input.subtotal,
        total: input.total
      });
      tables.otros_gastos.rows.push({
        _rowNumber: tables.otros_gastos.rows.length + 2,
        id_otros_gastos: otherExpenseId,
        fecha_otros_gastos: input.expenseDate,
        id_acreedor: input.creditorId,
        id_acreedor_etiqueta: input.creditorTagId,
        id_egreso: expenseId,
        detalle: input.detail
      });
      finalizeTables(tables, ["egresos", "otros_gastos"]);
      cache.generatedAt = new Date().toISOString();
      saveBackendCache(cache);
      sendJson(response, 200, { ok: true, otherExpenseId, expenseId });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message || "No se pudo guardar el otro gasto." });
    }
  }

  function normalizeOtherExpensePayload(body) {
    const money = (value) => normalizeMoney(cleanBackendInput(value) || 0);
    return {
      expenseDate: cleanBackendInput(body.expenseDate),
      creditorId: backendId(body.creditorId),
      creditorTagId: backendId(body.creditorTagId),
      detail: cleanBackendInput(body.detail),
      invoiceType: cleanBackendInput(body.invoiceType),
      invoiceNumber: cleanBackendInput(body.invoiceNumber),
      invoiceDate: cleanBackendInput(body.invoiceDate),
      paymentDate: cleanBackendInput(body.paymentDate),
      iva: money(body.iva),
      vatRetention: money(body.vatRetention),
      iibbRetention: money(body.iibbRetention),
      internalTaxes: money(body.internalTaxes),
      subtotal: money(body.subtotal),
      total: money(body.total)
    };
  }

  function validateOtherExpensePayload(input) {
    if (!isIsoDate(input.expenseDate) || !isIsoDate(input.invoiceDate)) return "Las fechas del gasto no son validas.";
    if (input.paymentDate && !isIsoDate(input.paymentDate)) return "La fecha prevista de pago no es valida.";
    if (!input.creditorId || !input.creditorTagId || !input.invoiceType || !input.invoiceNumber) {
      return "Completa acreedor, etiqueta y comprobante.";
    }
    const amounts = [input.iva, input.vatRetention, input.iibbRetention, input.internalTaxes, input.subtotal, input.total];
    if (amounts.some((value) => !Number.isFinite(value)) || moneyToCents(input.total) === 0) {
      return "Los importes del gasto no son validos.";
    }
    return "";
  }

  function finalizeTables(tables, names) {
    names.forEach((name) => {
      tables[name].headers = EXPECTED_BACKEND_COLUMNS[name];
      tables[name].rowCount = tables[name].rows.length;
      tables[name].updatedAt = new Date().toISOString();
    });
  }

  return { handleOtherExpenseFullEntry };
}

module.exports = { createOtherExpenseEntryService };
