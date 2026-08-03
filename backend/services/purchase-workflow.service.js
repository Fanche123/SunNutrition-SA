const crypto = require("node:crypto");
const { normalize: normalizeMoney, toCents: moneyToCents } = require("../../shared/money");

function createPurchaseWorkflowService(dependencies) {
  const { backendId, backendNextNumericId, ensureBackendTable, enqueueWrite = (operation) => operation(), fs, isIsoDate, loadCache, now = () => new Date(), path, readJsonBody, rootDir, saveBackendCache, sendJson, synchronizeEconomicExpenses = (cache) => cache } = dependencies;

  function rows(table) { return Array.isArray(table?.rows) ? table.rows : []; }
  function text(value) { return String(value ?? "").trim(); }
  function byId(values, key) { return new Map(values.map((row) => [text(row[key]), row]).filter(([id]) => id)); }
  function finish(table) { table.rowCount = table.rows.length; table.updatedAt = new Date().toISOString(); }
  function ensureWorkflow(tables) {
    if (!tables.gestion_compras) tables.gestion_compras = { headers: ["id_gestion_compra", "id_compra", "cerrado_en", "cerrado_por", "claves_recepcion", "clave_factura", "creado_en", "actualizado_en"], rows: [], rowCount: 0 };
    return tables.gestion_compras;
  }

  function buenosAiresDate() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(now());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function purchaseModels(cache) {
    const tables = cache.tables || {};
    const supplierItems = byId(rows(tables.insumos_proveedores), "id_insumos_proveedores");
    const supplies = byId(rows(tables.insumos), "id_insumo");
    const countItems = new Map(rows(tables.items).filter((row) => text(row.origen_tipo).toLowerCase() === "insumo").map((row) => [text(row.id_origen), row]));
    const providers = byId(rows(tables.proveedores), "id_proveedor");
    const receptions = rows(tables.recepciones);
    const receptionDetails = rows(tables.detalle_recepciones);
    const receptionById = byId(receptions, "id_recepcion");
    const detailsByPurchase = new Map();
    rows(tables.detalle_compras).forEach((detail) => {
      const id = text(detail.id_compra);
      if (!detailsByPurchase.has(id)) detailsByPurchase.set(id, []);
      const supplierItem = supplierItems.get(text(detail.id_insumos_proveedores)) || {};
      const supply = supplies.get(text(supplierItem.id_insumo)) || {};
      const supplierQuantity = Number(detail.cantidad) || 0;
      const recipePerSupplierUnit = Number(supplierItem.cantidad_proveedor) || 1;
      const recipePerCountUnit = Number(supply.cantidad_receta) || 1;
      const item = {
        detailId: text(detail.id_detalle_compra), supplyId: text(supplierItem.id_insumo),
        name: text(supply.nombre) || "Insumo sin nombre", ordered: supplierQuantity * recipePerSupplierUnit / recipePerCountUnit,
        supplierUnit: text(countItems.get(text(supplierItem.id_insumo))?.ud_conteo) || text(supply.ud_receta)
      };
      const existing = detailsByPurchase.get(id).find((current) => current.supplyId === item.supplyId);
      if (existing) existing.ordered += item.ordered;
      else detailsByPurchase.get(id).push(item);
    });
    const receivedByPurchaseSupply = new Map();
    receptionDetails.forEach((detail) => {
      const reception = receptionById.get(text(detail.id_recepcion));
      if (!reception) return;
      const key = `${text(reception.id_compra)}:${text(detail.id_insumo)}`;
      receivedByPurchaseSupply.set(key, (receivedByPurchaseSupply.get(key) || 0) + (Number(detail.cantidad_recibida) || 0));
    });
    const workflowByPurchase = new Map(rows(ensureWorkflow(tables)).map((row) => [text(row.id_compra), row]));
    return rows(tables.compras).map((purchase) => {
      const purchaseId = text(purchase.id_compra);
      const purchaseReceptions = receptions.filter((row) => text(row.id_compra) === purchaseId);
      const items = (detailsByPurchase.get(purchaseId) || []).map((item) => {
        const received = receivedByPurchaseSupply.get(`${purchaseId}:${item.supplyId}`) || 0;
        return { ...item, received, pending: Math.max(0, item.ordered - received) };
      });
      const invoiceReception = purchaseReceptions.find((row) => text(row.id_egreso) && text(row.archivo_recepcion));
      const historicalExpenseReception = purchaseReceptions.find((row) => text(row.id_egreso));
      const expense = rows(tables.egresos).find((row) => text(row.id_egreso) === text(invoiceReception?.id_egreso));
      const workflow = workflowByPurchase.get(purchaseId) || {};
      const derivedHistoricalClose = !workflow.id_gestion_compra && items.length && items.every((item) => item.pending <= 1e-9) && historicalExpenseReception
        ? text(historicalExpenseReception.fecha_recepcion) || "histórico_resuelto"
        : "";
      return {
        purchaseId, provider: text(providers.get(text(purchase.id_proveedor))?.nombre) || `Proveedor ${text(purchase.id_proveedor)}`,
        orderDate: text(purchase.fecha_pedido), expectedDeliveryDate: text(purchase.fecha_entrega_prevista), items,
        receptionState: items.length && items.every((item) => item.pending <= 1e-9) ? "complete" : items.some((item) => item.received > 0) ? "partial" : "pending",
        invoice: invoiceReception ? { expenseId: text(invoiceReception.id_egreso), attachmentPath: text(invoiceReception.archivo_recepcion), type: text(expense?.tipo_factura), number: text(expense?.nro_factura), date: text(expense?.fecha_factura), subtotal: Number(expense?.subtotal) || 0, iva: Number(expense?.iva) || 0, total: Number(expense?.total) || 0 } : null,
        receptions: purchaseReceptions.map((reception) => ({ id: text(reception.id_recepcion), date: text(reception.fecha_recepcion), items: receptionDetails.filter((d) => text(d.id_recepcion) === text(reception.id_recepcion)).map((d) => ({ supplyId: text(d.id_insumo), quantity: Number(d.cantidad_recibida) || 0 })) })),
        closedAt: text(workflow.cerrado_en) || derivedHistoricalClose,
        closedBy: text(workflow.cerrado_por), historicalResolved: Boolean(derivedHistoricalClose)
      };
    }).sort((a, b) => (a.expectedDeliveryDate || "9999-12-31").localeCompare(b.expectedDeliveryDate || "9999-12-31") || Number(a.purchaseId) - Number(b.purchaseId));
  }

  function handleList(_request, response) {
    const purchases = purchaseModels(loadCache());
    const today = buenosAiresDate();
    const isOperationalPending = (row) => !row.closedAt && (!isIsoDate(row.expectedDeliveryDate) || row.expectedDeliveryDate >= today);
    sendJson(response, 200, { ok: true, pending: purchases.filter(isOperationalPending), managed: purchases.filter((row) => row.closedAt) });
  }

  async function handleReception(request, response) { return enqueueWrite(() => persistReception(request, response)); }
  async function persistReception(request, response) {
    try {
      const input = await readJsonBody(request);
      const purchaseId = backendId(input.purchaseId);
      const requestKey = text(input.requestKey);
      const entries = Array.isArray(input.entries) ? input.entries : [];
      if (!purchaseId || !requestKey || !isIsoDate(text(input.receptionDate)) || !backendId(input.employeeId)) throw new Error("Faltan datos válidos de la recepción.");
      if (!entries.length || entries.some((entry) => !backendId(entry.supplyId) || !(Number(entry.quantity) > 0))) throw new Error("Las cantidades recibidas deben ser mayores a cero.");
      if (new Set(entries.map((entry) => backendId(entry.supplyId))).size !== entries.length) throw new Error("Cada insumo debe aparecer una sola vez en la recepción.");
      let cache = loadCache(); const tables = cache.tables || (cache.tables = {}); const workflow = ensureWorkflow(tables);
      if (!rows(tables.empleados).some((row) => backendId(row.id_empleado) === backendId(input.employeeId))) throw new Error("El empleado seleccionado no existe.");
      let workflowRow = rows(workflow).find((row) => text(row.id_compra) === purchaseId);
      if ((text(workflowRow?.claves_recepcion).split(",")).includes(requestKey)) return sendJson(response, 200, { ok: true, duplicate: true });
      const model = purchaseModels(cache).find((row) => row.purchaseId === purchaseId);
      if (!model || model.closedAt) throw new Error("La compra no existe o ya está cerrada.");
      const pendingBySupply = new Map(model.items.map((item) => [item.supplyId, item.pending]));
      entries.forEach((entry) => { if (Number(entry.quantity) > (pendingBySupply.get(backendId(entry.supplyId)) || 0) + 1e-9) throw new Error("La cantidad supera lo pendiente de la compra."); });
      ensureBackendTable(tables, "recepciones"); ensureBackendTable(tables, "detalle_recepciones");
      const receptionId = backendNextNumericId(rows(tables.recepciones), "id_recepcion");
      const purchase = rows(tables.compras).find((row) => backendId(row.id_compra) === purchaseId);
      const creditor = rows(tables.acreedores).find((row) => text(row.origen_tipo_acreedor).toLowerCase().includes("proveedor") && backendId(row.origen_id_acreedor) === backendId(purchase?.id_proveedor));
      const creditorTag = rows(tables.acreedores_etiquetas).find((row) => backendId(row.id_acreedor) === backendId(creditor?.id_acreedor));
      if (!creditorTag) throw new Error(`El proveedor de la compra ${purchaseId} no tiene acreedor y etiqueta asociados.`);
      tables.recepciones.rows.push({ id_recepcion: receptionId, fecha_recepcion: text(input.receptionDate), id_empleado: backendId(input.employeeId), id_compra: purchaseId, id_acreedor_etiqueta: backendId(creditorTag?.id_acreedor_etiqueta), id_egreso: "", archivo_recepcion: "" });
      let nextDetail = backendNextNumericId(rows(tables.detalle_recepciones), "id_detalle_recepcion");
      entries.forEach((entry) => tables.detalle_recepciones.rows.push({ id_detalle_recepcion: nextDetail++, id_recepcion: receptionId, id_insumo: backendId(entry.supplyId), cantidad_recibida: Number(entry.quantity) }));
      const now = new Date().toISOString();
      if (!workflowRow) { workflowRow = { id_gestion_compra: backendNextNumericId(rows(workflow), "id_gestion_compra"), id_compra: purchaseId, creado_en: now }; workflow.rows.push(workflowRow); }
      workflowRow.claves_recepcion = [text(workflowRow.claves_recepcion), requestKey].filter(Boolean).join(","); workflowRow.actualizado_en = now;
      [tables.recepciones, tables.detalle_recepciones, workflow].forEach(finish); saveBackendCache(cache);
      sendJson(response, 200, { ok: true, receptionId });
    } catch (error) { sendJson(response, 400, { ok: false, error: error.message }); }
  }

  async function handleInvoice(request, response) { return enqueueWrite(() => persistInvoice(request, response)); }
  async function persistInvoice(request, response) {
    let writtenPath = "";
    let fileCreated = false;
    try {
      const input = await readJsonBody(request); const purchaseId = backendId(input.purchaseId); const requestKey = text(input.requestKey); const expense = input.expense || {}; const attachment = input.attachment || {};
      const amounts = ["iva", "vatRetention", "iibbRetention", "internalTaxes", "subtotal", "total"].map((key) => normalizeMoney(expense[key] || 0));
      if (!purchaseId || !requestKey || !text(expense.invoiceType) || !isIsoDate(text(expense.invoiceDate)) || (text(expense.paymentDate) && !isIsoDate(text(expense.paymentDate))) || amounts.some((value) => !Number.isFinite(value)) || moneyToCents(amounts[5]) <= 0) throw new Error("La factura/egreso está incompleta o contiene fechas/importes inválidos.");
      if (!text(attachment.fileName) || !text(attachment.dataBase64)) throw new Error("La factura requiere un adjunto real.");
      let cache = loadCache(); const tables = cache.tables || (cache.tables = {}); const workflow = ensureWorkflow(tables);
      let workflowRow = rows(workflow).find((row) => text(row.id_compra) === purchaseId);
      if (text(workflowRow?.clave_factura) === requestKey) return sendJson(response, 200, { ok: true, duplicate: true });
      const model = purchaseModels(cache).find((row) => row.purchaseId === purchaseId);
      if (!model || model.closedAt || !model.receptions.length) throw new Error("Primero debe existir una recepción real para esta compra.");
      if (model.invoice) throw new Error("La compra ya tiene una factura/egreso asociado.");
      ensureBackendTable(tables, "egresos"); const expenseId = backendNextNumericId(rows(tables.egresos), "id_egreso");
      const merchandiseLabel = rows(tables.etiquetas).find((row) => text(row.etiqueta).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() === "mercaderia");
      const labelId = backendId(expense.labelId) || backendId(merchandiseLabel?.id_etiqueta);
      if (!labelId) throw new Error("No existe la etiqueta contable Mercadería para crear el egreso.");
      tables.egresos.rows.push({ id_egreso: expenseId, fecha_factura: text(expense.invoiceDate), fecha_prevista_pago: text(expense.paymentDate) || text(expense.invoiceDate), id_etiqueta: labelId, tipo_factura: text(expense.invoiceType), nro_factura: text(expense.invoiceNumber), iva: Number(expense.iva) || 0, per_ret_iva: Number(expense.vatRetention) || 0, per_ret_iibb: Number(expense.iibbRetention) || 0, imp_internos: Number(expense.internalTaxes) || 0, subtotal: Number(expense.subtotal) || 0, total: Number(expense.total) });
      const buffer = Buffer.from(text(attachment.dataBase64), "base64"); if (!buffer.length || buffer.length > 20 * 1024 * 1024) throw new Error("El adjunto está vacío o supera 20 MB.");
      const safeName = text(attachment.fileName).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120); const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
      const relativePath = `backend/attachments/recepciones/compra-${purchaseId}-${hash}-${safeName}`; writtenPath = path.join(rootDir, relativePath); fs.mkdirSync(path.dirname(writtenPath), { recursive: true }); fs.writeFileSync(writtenPath, buffer, { flag: "wx" }); fileCreated = true;
      const reception = rows(tables.recepciones).find((row) => text(row.id_compra) === purchaseId); reception.id_egreso = expenseId; reception.archivo_recepcion = relativePath;
      const now = new Date().toISOString(); if (!workflowRow) { workflowRow = { id_gestion_compra: backendNextNumericId(rows(workflow), "id_gestion_compra"), id_compra: purchaseId, creado_en: now }; workflow.rows.push(workflowRow); }
      workflowRow.clave_factura = requestKey; workflowRow.actualizado_en = now; [tables.egresos, tables.recepciones, workflow].forEach(finish); cache = synchronizeEconomicExpenses(cache, "egresos"); saveBackendCache(cache);
      sendJson(response, 200, { ok: true, expenseId, attachmentPath: relativePath });
    } catch (error) { if (fileCreated && writtenPath && fs.existsSync(writtenPath)) fs.rmSync(writtenPath, { force: true }); sendJson(response, 400, { ok: false, error: error.message }); }
  }

  async function handleClose(request, response) { return enqueueWrite(() => persistClose(request, response)); }
  async function persistClose(request, response) {
    try {
      const input = await readJsonBody(request); const purchaseId = backendId(input.purchaseId); if (!purchaseId) throw new Error("Falta la compra.");
      const cache = loadCache(); const tables = cache.tables || (cache.tables = {}); const workflow = ensureWorkflow(tables); const model = purchaseModels(cache).find((row) => row.purchaseId === purchaseId);
      if (!model) throw new Error("La compra no existe."); if (model.closedAt) return sendJson(response, 200, { ok: true, duplicate: true, closedAt: model.closedAt });
      if (model.receptionState !== "complete" || !model.invoice?.expenseId || !model.invoice?.attachmentPath) throw new Error("El cierre requiere recepción completa, egreso y adjunto reales.");
      const now = new Date().toISOString(); let row = rows(workflow).find((item) => text(item.id_compra) === purchaseId);
      if (!row) { row = { id_gestion_compra: backendNextNumericId(rows(workflow), "id_gestion_compra"), id_compra: purchaseId, creado_en: now }; workflow.rows.push(row); }
      row.cerrado_en = now; row.cerrado_por = actorFromRequest(request); row.actualizado_en = now; finish(workflow); saveBackendCache(cache); sendJson(response, 200, { ok: true, closedAt: now });
    } catch (error) { sendJson(response, 400, { ok: false, error: error.message }); }
  }

  return { handleList, handleReception, handleInvoice, handleClose };
}

function actorFromRequest(request) {
  const user = request.accessIdentity?.user;
  return String(user?.username || user?.id || request.accessIdentity?.mode || "local").trim() || "local";
}

module.exports = { createPurchaseWorkflowService };
