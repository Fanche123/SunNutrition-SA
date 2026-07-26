const { fromCents, normalize: normalizeMoney } = require("../../shared/money");
const { strictMoneyToCents } = require("../utils/money-input");

function createCreditorEntryService(dependencies) {
  const { EXPECTED_BACKEND_COLUMNS, backendId, backendNextNumericId, backendNormalizeText, cleanBackendText, ensureBackendTable, loadCache, readJsonBody, saveBackendCache, sendJson } = dependencies;

function normalizeCreditorOriginType(value) {
  const normalized = backendNormalizeText(value);
  if (normalized === "proveedor") return "proveedor";
  if (normalized === "flete") return "flete";
  if (normalized === "empleado") return "empleado";
  if (normalized === "canal") return "canal";
  if (["otros", "otro acreedor", "otros acreedores"].includes(normalized)) return "otros acreedores";
  return "";
}

function creditorOriginDefinition(originType) {
  const definitions = {
    proveedor: {
      tableName: "proveedores",
      idColumn: "id_proveedor",
      nameColumn: "nombre",
      createRow: (id, name, extra) => ({
        id_proveedor: id,
        nombre: name,
        telefono: cleanBackendText(extra.telefono),
        email: cleanBackendText(extra.email),
        tiempo_estimado_entrega: cleanBackendText(extra.tiempo_estimado_entrega),
        pedido_minimo: normalizeOptionalPayloadMoney(extra.pedido_minimo)
      })
    },
    flete: {
      tableName: "fletes",
      idColumn: "id_flete",
      nameColumn: "nombre_flete",
      createRow: (id, name, extra) => ({
        id_flete: id,
        nombre_flete: name,
        telefono_flete: cleanBackendText(extra.telefono_flete),
        email_flete: cleanBackendText(extra.email_flete)
      })
    },
    empleado: {
      tableName: "empleados",
      idColumn: "id_empleado",
      nameColumn: "nombre_empleado",
      createRow: (id, name, extra) => ({
        id_empleado: id,
        nombre_empleado: name,
        categoria_empleado: cleanBackendText(extra.categoria_empleado),
        fecha_alta: cleanBackendText(extra.fecha_alta),
        fecha_baja: "",
        dni: cleanBackendText(extra.dni),
        fecha_nacimiento: "",
        direccion_empleado: cleanBackendText(extra.direccion_empleado),
        localidad_empleado: cleanBackendText(extra.localidad_empleado)
      })
    },
    canal: {
      tableName: "canales",
      idColumn: "id_canal",
      nameColumn: "nombre",
      createRow: (id, name, extra) => ({
        id_canal: id,
        nombre: name,
        comision: cleanBackendText(extra.comision)
      })
    },
    "otros acreedores": {
      tableName: "otros_acreedores",
      idColumn: "id_otro_acreedor",
      nameColumn: "nombre_otro_acreedor",
      createRow: (id, name) => ({
        id_otro_acreedor: id,
        nombre_otro_acreedor: name
      })
    }
  };
  return definitions[originType] || null;
}

function normalizeOptionalPayloadMoney(value) {
  if (String(value ?? "").trim() === "") return "";
  return fromCents(strictMoneyToCents(value, { allowNegative: false }));
}

function fillBlankOriginFields(target, source) {
  Object.entries(source).forEach(([key, value]) => {
    if (key.startsWith("id_") || value === "" || value === null || value === undefined) return;
    if (target[key] === "" || target[key] === null || target[key] === undefined) target[key] = value;
  });
}

async function handleCreditorCreate(request, response) {
  try {
    const body = await readJsonBody(request);
    const originType = normalizeCreditorOriginType(body.originType);
    const name = cleanBackendText(body.name);
    const tagId = backendId(body.idEtiqueta);
    const extra = body.extra && typeof body.extra === "object" ? body.extra : {};
    const supplierItems = Array.isArray(body.supplierItems) ? body.supplierItems : [];
    const originDefinition = creditorOriginDefinition(originType);

    if (!originDefinition || !name || !tagId) {
      sendJson(response, 400, { ok: false, error: "Completa tipo, nombre y etiqueta del acreedor." });
      return;
    }

    const cache = loadCache();
    const tables = cache.tables || (cache.tables = {});
    const requiredTables = [originDefinition.tableName, "acreedores", "acreedores_etiquetas", "datos_bancarios", "etiquetas"];
    if (originType === "proveedor") requiredTables.push("insumos", "insumos_proveedores");
    requiredTables.forEach((tableName) => ensureBackendTable(tables, tableName));
    const tagExists = tables.etiquetas.rows.some((row) => backendId(row.id_etiqueta) === tagId);
    if (!tagExists) {
      sendJson(response, 400, { ok: false, error: "La etiqueta seleccionada no existe." });
      return;
    }

    const originRows = tables[originDefinition.tableName].rows;
    const normalizedName = backendNormalizeText(name);
    let originRow = originRows.find((row) => backendNormalizeText(row[originDefinition.nameColumn]) === normalizedName);
    if (!originRow) {
      const originId = backendNextNumericId(originRows, originDefinition.idColumn);
      originRow = originDefinition.createRow(originId, name, extra);
      originRows.push({ _rowNumber: originRows.length + 2, ...originRow });
    } else {
      fillBlankOriginFields(originRow, originDefinition.createRow(originRow[originDefinition.idColumn], name, extra));
    }
    const originId = backendId(originRow[originDefinition.idColumn]);

    const creditors = tables.acreedores.rows;
    let creditor = creditors.find((row) =>
      normalizeCreditorOriginType(row.origen_tipo_acreedor) === originType &&
      backendId(row.origen_id_acreedor) === originId
    );
    if (!creditor) {
      creditor = {
        _rowNumber: creditors.length + 2,
        id_acreedor: backendNextNumericId(creditors, "id_acreedor"),
        origen_tipo_acreedor: originType,
        origen_id_acreedor: originId,
        cuit_cuil: cleanBackendText(body.cuit),
        cbu_alias: cleanBackendText(body.cbuAlias),
        acuerdo_de_pago: cleanBackendText(body.paymentTerms)
      };
      creditors.push(creditor);
    } else {
      if (!cleanBackendText(creditor.cuit_cuil) && cleanBackendText(body.cuit)) creditor.cuit_cuil = cleanBackendText(body.cuit);
      if (!cleanBackendText(creditor.cbu_alias) && cleanBackendText(body.cbuAlias)) creditor.cbu_alias = cleanBackendText(body.cbuAlias);
      if (!cleanBackendText(creditor.acuerdo_de_pago) && cleanBackendText(body.paymentTerms)) creditor.acuerdo_de_pago = cleanBackendText(body.paymentTerms);
    }
    const creditorId = backendId(creditor.id_acreedor);

    let savedSupplierItemCount = 0;
    if (originType === "proveedor") {
      const supplierRows = tables.insumos_proveedores.rows;
      const supplyIds = new Set(tables.insumos.rows.map((row) => backendId(row.id_insumo)));
      supplierItems
        .filter((item) => backendId(item?.idInsumo))
        .forEach((item) => {
          const supplyId = backendId(item.idInsumo);
          const presentation = cleanBackendText(item.udProveedor);
          const quantity = cleanBackendText(item.cantidadProveedor);
          const rawPrice = cleanBackendText(item.precio);
          const price = rawPrice ? normalizeMoney(rawPrice, { allowNegative: false }) : "";
          if (!supplyIds.has(supplyId)) {
            throw new Error("Uno de los insumos seleccionados ya no existe.");
          }
          if (!presentation || !quantity) {
            throw new Error("Cada insumo debe tener presentaciÄ‚Ĺ‚n y cantidad por presentaciÄ‚Ĺ‚n.");
          }
          const existing = supplierRows.find((row) =>
            backendId(row.id_proveedor) === originId &&
            backendId(row.id_insumo) === supplyId &&
            backendNormalizeText(row.ud_proveedor) === backendNormalizeText(presentation) &&
            String(row.cantidad_proveedor ?? "").trim() === quantity
          );
          if (existing) {
            if (price !== "") existing.precio = price;
            if (cleanBackendText(item.iva)) existing.iva = cleanBackendText(item.iva);
          } else {
            supplierRows.push({
              _rowNumber: supplierRows.length + 2,
              id_insumos_proveedores: backendNextNumericId(supplierRows, "id_insumos_proveedores"),
              id_insumo: supplyId,
              id_proveedor: originId,
              ud_proveedor: presentation,
              cantidad_proveedor: quantity,
              precio: price,
              iva: cleanBackendText(item.iva)
            });
          }
          savedSupplierItemCount += 1;
        });
    }

    const tagRows = tables.acreedores_etiquetas.rows;
    let creditorTag = tagRows.find((row) => backendId(row.id_acreedor) === creditorId && backendId(row.id_etiqueta) === tagId);
    if (!creditorTag) {
      creditorTag = {
        _rowNumber: tagRows.length + 2,
        id_acreedor_etiqueta: backendNextNumericId(tagRows, "id_acreedor_etiqueta"),
        id_acreedor: creditorId,
        id_etiqueta: tagId
      };
      tagRows.push(creditorTag);
    }

    const bankDetail = cleanBackendText(body.bankDetail);
    if (bankDetail) {
      const bankRows = tables.datos_bancarios.rows;
      const normalizedDetail = backendNormalizeText(bankDetail);
      const existingDetail = bankRows.find((row) => backendNormalizeText(row.detalle) === normalizedDetail);
      if (existingDetail && backendId(existingDetail.id_acreedor) && backendId(existingDetail.id_acreedor) !== creditorId) {
        sendJson(response, 409, { ok: false, error: "Ese detalle bancario ya esta asociado a otro acreedor." });
        return;
      }
      if (existingDetail) {
        existingDetail.id_acreedor = creditorId;
        existingDetail.id_etiqueta = tagId;
      } else {
        bankRows.push({
          _rowNumber: bankRows.length + 2,
          id_dato_bancario: backendNextNumericId(bankRows, "id_dato_bancario"),
          detalle: bankDetail,
          id_acreedor: creditorId,
          id_etiqueta: tagId
        });
      }
    }

    [...requiredTables].forEach((tableName) => {
      tables[tableName].headers = EXPECTED_BACKEND_COLUMNS[tableName];
      tables[tableName].rowCount = tables[tableName].rows.length;
    });
    cache.generatedAt = new Date().toISOString();
    saveBackendCache(cache);
    sendJson(response, 200, {
      ok: true,
      creditorId,
      creditorTagId: creditorTag.id_acreedor_etiqueta,
      message: savedSupplierItemCount
        ? `Acreedor, etiqueta y ${savedSupplierItemCount} insumo(s) proveedor guardados correctamente.`
        : "Acreedor y etiqueta guardados correctamente."
    });
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message || "No se pudo guardar el acreedor." });
  }
}

  return { handleCreditorCreate };
}

module.exports = { createCreditorEntryService };
