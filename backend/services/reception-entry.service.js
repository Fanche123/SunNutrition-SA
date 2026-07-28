const { normalize: normalizeMoney, toCents: moneyToCents } = require("../../shared/money");

function createReceptionEntryService(dependencies) {
  const {
    EXPECTED_BACKEND_COLUMNS,
    backendId,
    backendNextNumericId,
    cleanBackendInput,
    ensureBackendTable,
    fs,
    isIsoDate,
    loadCache,
    path,
    readJsonBody,
    rootDir,
    saveBackendCache,
    sendJson,
    synchronizeEconomicExpenses = (cache) => cache
  } = dependencies;

  async function handleReceptionFullEntry(request, response) {
    let temporaryPath = "";
    let finalPath = "";
    let snapshot = null;
    let cacheWasSaved = false;
    try {
      const body = await readJsonBody(request);
      const input = normalizeReceptionPayload(body);
      const validationError = validateReceptionPayload(input);
      if (validationError) {
        sendJson(response, 400, { ok: false, error: validationError });
        return;
      }

      let cache = loadCache();
      snapshot = JSON.parse(JSON.stringify(cache));
      const tables = cache.tables || (cache.tables = {});
      requiredReceptionTables().forEach((tableName) => ensureBackendTable(tables, tableName));
      const prepared = prepareReceptionRows(tables, input);

      if (input.attachment) {
        const attachment = prepareTemporaryAttachment(input.attachment, prepared.firstReceptionId);
        temporaryPath = attachment.temporaryPath;
        finalPath = attachment.finalPath;
        prepared.receptionRows.forEach((row) => {
          row.archivo_recepcion = attachment.relativeFinalPath;
        });
      }

      tables.recepciones.rows.push(...prepared.receptionRows);
      tables.detalle_recepciones.rows.push(...prepared.detailRows);
      tables.egresos.rows.push(prepared.expenseRow);
      finalizeTables(tables, ["recepciones", "detalle_recepciones", "egresos"]);
      cache.generatedAt = new Date().toISOString();
      cache = synchronizeEconomicExpenses(cache, "egresos");
      saveBackendCache(cache);
      cacheWasSaved = true;

      if (temporaryPath) {
        fs.mkdirSync(path.dirname(finalPath), { recursive: true });
        fs.renameSync(temporaryPath, finalPath);
        temporaryPath = "";
      }

      sendJson(response, 200, {
        ok: true,
        receptionIds: prepared.receptionRows.map((row) => row.id_recepcion),
        expenseId: prepared.expenseRow.id_egreso,
        attachmentPath: prepared.receptionRows[0].archivo_recepcion || ""
      });
    } catch (error) {
      let rollbackError = null;
      if (cacheWasSaved && snapshot) {
        try {
          saveBackendCache(snapshot);
        } catch (currentRollbackError) {
          rollbackError = currentRollbackError;
        }
      }
      cleanupCreatedFile(temporaryPath);
      cleanupCreatedFile(finalPath);
      const suffix = rollbackError ? ` No se pudo restaurar el snapshot: ${rollbackError.message}` : "";
      sendJson(response, 400, { ok: false, error: `${error.message || "No se pudo guardar la recepcion."}${suffix}` });
    }
  }

  function normalizeReceptionPayload(body) {
    const entries = Array.isArray(body.entries) ? body.entries : [];
    const expense = body.expense && typeof body.expense === "object" ? body.expense : {};
    const attachment = body.attachment && typeof body.attachment === "object" ? body.attachment : null;
    const number = (value) => Number(cleanBackendInput(value) || 0);
    const money = (value) => normalizeMoney(cleanBackendInput(value) || 0);
    return {
      receptionDate: cleanBackendInput(body.receptionDate),
      employeeId: backendId(body.employeeId),
      entries: entries.map((entry) => ({
        purchaseId: backendId(entry.purchaseId),
        supplyId: backendId(entry.supplyId),
        quantity: number(entry.quantity)
      })),
      expense: {
        invoiceType: cleanBackendInput(expense.invoiceType),
        invoiceNumber: cleanBackendInput(expense.invoiceNumber),
        invoiceDate: cleanBackendInput(expense.invoiceDate),
        paymentDate: cleanBackendInput(expense.paymentDate),
        iva: money(expense.iva),
        vatRetention: money(expense.vatRetention),
        iibbRetention: money(expense.iibbRetention),
        internalTaxes: money(expense.internalTaxes),
        subtotal: money(expense.subtotal),
        total: money(expense.total)
      },
      attachment: attachment ? {
        fileName: sanitizeFileName(attachment.fileName),
        mimeType: cleanBackendInput(attachment.mimeType),
        dataBase64: cleanBackendInput(attachment.dataBase64)
      } : null
    };
  }

  function validateReceptionPayload(input) {
    if (!isIsoDate(input.receptionDate) || !input.employeeId) return "Completa fecha y empleado de la recepcion.";
    if (!input.entries.length || input.entries.length > 2) return "La recepcion debe incluir una o dos compras.";
    if (input.entries.some((entry) => !entry.purchaseId || !entry.supplyId || !Number.isFinite(entry.quantity) || entry.quantity <= 0)) {
      return "Las compras y cantidades recibidas no son validas.";
    }
    if (new Set(input.entries.map((entry) => entry.purchaseId)).size !== input.entries.length) return "No se puede recibir dos veces la misma compra.";
    if (!input.expense.invoiceType || !isIsoDate(input.expense.invoiceDate)) return "El comprobante de la recepcion no es valido.";
    if (input.expense.paymentDate && !isIsoDate(input.expense.paymentDate)) return "La fecha prevista de pago no es valida.";
    const amounts = ["iva", "vatRetention", "iibbRetention", "internalTaxes", "subtotal", "total"];
    if (amounts.some((key) => !Number.isFinite(input.expense[key])) || moneyToCents(input.expense.total) <= 0) {
      return "Los importes del egreso no son validos.";
    }
    if (input.attachment && (!input.attachment.fileName || !input.attachment.dataBase64)) return "El adjunto de la recepcion esta incompleto.";
    return "";
  }

  function prepareReceptionRows(tables, input) {
    if (!tables.empleados.rows.some((row) => backendId(row.id_empleado) === input.employeeId)) {
      throw new Error("El empleado seleccionado ya no existe.");
    }
    const receivedPurchaseIds = new Set(tables.recepciones.rows.map((row) => backendId(row.id_compra)).filter(Boolean));
    const purchasesById = rowsById(tables.compras.rows, "id_compra");
    const suppliesById = rowsById(tables.insumos.rows, "id_insumo");
    const creditors = tables.acreedores.rows;
    const creditorTags = tables.acreedores_etiquetas.rows;
    const merchandiseLabel = tables.etiquetas.rows.find((row) => normalizeText(row.etiqueta) === "mercaderia");
    let nextReceptionId = backendNextNumericId(tables.recepciones.rows, "id_recepcion");
    let nextDetailId = backendNextNumericId(tables.detalle_recepciones.rows, "id_detalle_recepcion");
    const expenseId = backendNextNumericId(tables.egresos.rows, "id_egreso");
    const receptionRows = [];
    const detailRows = [];
    let expenseLabelId = "";

    input.entries.forEach((entry) => {
      const purchase = purchasesById.get(entry.purchaseId);
      if (!purchase || receivedPurchaseIds.has(entry.purchaseId)) throw new Error(`La compra ${entry.purchaseId} no esta pendiente de recepcion.`);
      if (!suppliesById.has(entry.supplyId)) throw new Error(`El insumo ${entry.supplyId} ya no existe.`);
      const creditor = creditors.find((row) =>
        normalizeText(row.origen_tipo_acreedor).includes("proveedor")
        && backendId(row.origen_id_acreedor) === backendId(purchase.id_proveedor)
      );
      const creditorTag = creditorTags
        .filter((row) => backendId(row.id_acreedor) === backendId(creditor?.id_acreedor))
        .sort((left, right) => Number(left.id_acreedor_etiqueta || 0) - Number(right.id_acreedor_etiqueta || 0))[0];
      if (!creditorTag) throw new Error(`El proveedor de la compra ${entry.purchaseId} no tiene acreedor y etiqueta asociados.`);
      if (!expenseLabelId) expenseLabelId = backendId(merchandiseLabel?.id_etiqueta) || backendId(creditorTag.id_etiqueta);
      receptionRows.push({
        _rowNumber: tables.recepciones.rows.length + receptionRows.length + 2,
        id_recepcion: nextReceptionId,
        fecha_recepcion: input.receptionDate,
        id_empleado: input.employeeId,
        id_compra: entry.purchaseId,
        id_acreedor_etiqueta: backendId(creditorTag.id_acreedor_etiqueta),
        id_egreso: expenseId,
        archivo_recepcion: ""
      });
      detailRows.push({
        _rowNumber: tables.detalle_recepciones.rows.length + detailRows.length + 2,
        id_detalle_recepcion: nextDetailId,
        id_recepcion: nextReceptionId,
        id_insumo: entry.supplyId,
        cantidad_recibida: entry.quantity
      });
      nextReceptionId += 1;
      nextDetailId += 1;
    });

    const invoiceNumber = input.expense.invoiceNumber || String(receptionRows[0].id_recepcion);
    return {
      firstReceptionId: receptionRows[0].id_recepcion,
      receptionRows,
      detailRows,
      expenseRow: {
        _rowNumber: tables.egresos.rows.length + 2,
        id_egreso: expenseId,
        fecha_factura: input.expense.invoiceDate,
        fecha_prevista_pago: input.expense.paymentDate || input.expense.invoiceDate,
        id_etiqueta: expenseLabelId,
        tipo_factura: input.expense.invoiceType,
        nro_factura: invoiceNumber,
        iva: input.expense.iva,
        per_ret_iva: input.expense.vatRetention,
        per_ret_iibb: input.expense.iibbRetention,
        imp_internos: input.expense.internalTaxes,
        subtotal: input.expense.subtotal,
        total: input.expense.total
      }
    };
  }

  function prepareTemporaryAttachment(attachment, receptionId) {
    const buffer = Buffer.from(attachment.dataBase64, "base64");
    if (!buffer.length || buffer.length > 20 * 1024 * 1024) throw new Error("El archivo de recepcion esta vacio o supera 20 MB.");
    const temporaryDir = path.join(rootDir, "tmp", "reception-attachments-pending");
    const finalDir = path.join(rootDir, "backend", "attachments", "recepciones");
    fs.mkdirSync(temporaryDir, { recursive: true });
    const storedName = `${sanitizeFileName(receptionId)}-${Date.now()}-${attachment.fileName}`;
    const temporaryPath = path.join(temporaryDir, `${storedName}.pending`);
    const finalPath = path.join(finalDir, storedName);
    fs.writeFileSync(temporaryPath, buffer);
    return {
      temporaryPath,
      finalPath,
      relativeFinalPath: path.relative(rootDir, finalPath).replace(/\\/g, "/")
    };
  }

  function cleanupCreatedFile(filePath) {
    if (!filePath) return;
    try {
      if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    } catch {
      // La respuesta conserva el error principal; solo se intenta limpiar rutas creadas por esta operacion.
    }
  }

  function requiredReceptionTables() {
    return ["recepciones", "detalle_recepciones", "egresos", "compras", "insumos", "empleados", "acreedores", "acreedores_etiquetas", "etiquetas"];
  }

  function rowsById(rows, key) {
    return new Map(rows.map((row) => [backendId(row[key]), row]).filter(([id]) => id));
  }

  function normalizeText(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  }

  function sanitizeFileName(value) {
    return String(value || "archivo")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 120) || "archivo";
  }

  function finalizeTables(tables, names) {
    names.forEach((name) => {
      tables[name].headers = EXPECTED_BACKEND_COLUMNS[name];
      tables[name].rowCount = tables[name].rows.length;
      tables[name].updatedAt = new Date().toISOString();
    });
  }

  return { handleReceptionFullEntry };
}

module.exports = { createReceptionEntryService };
