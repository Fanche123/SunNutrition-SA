const { adminRelationsForTable } = require("../config/admin-table-relations");
const { applyDeliveryDeletion, previewDeliveryDeletion } = require("./delivery-deletion.service");
const { applyExpenseDeletion, previewExpenseDeletion } = require("./expense-deletion.service");

const RELATION_OPTION_LIMIT = 500;

function createAdminTableService(dependencies) {
  const {
    appendAdminAudit = () => {},
    adminTablePolicy,
    backendEditableColumns,
    backendEditablePrimaryKey,
    backendNextNumericId,
    backendOverview,
    backendTable,
    ensureAdminSessionBackup = () => null,
    loadCache,
    loadRegistry,
    readJsonBody,
    recordAllRowsRead,
    saveBackendCache,
    sendJson,
    synchronizeEconomicExpenses = (cache) => cache
  } = dependencies;

  function handleAdminTablesOverview(_request, response) {
    const overview = backendOverview();
    const tables = (overview.tables || []).map((table) => ({
      ...table,
      capabilities: publicCapability(adminTablePolicy[table.name])
    }));
    sendJson(response, 200, { ok: true, ...overview, tables });
  }

  function handleAdminTableRequest(request, response) {
    try {
      const startedAt = Date.now();
      const { tableName, url } = requestTable(request);
      const definition = visibleDefinition(tableName);
      const policy = adminTablePolicy[tableName];
      if (!definition || !policy?.read) return forbidden(response);

      const table = backendTable(tableName, tableOptions(url.searchParams));
      if (!table) {
        sendJson(response, 404, { ok: false, code: "ADMIN_TABLE_NOT_FOUND", error: "Tabla no encontrada." });
        return;
      }
      decorateAdminTable(tableName, table, policy, loadCache());
      table.version = currentTableVersion(tableName);
      recordAllRowsRead(tableName, table, startedAt);
      sendJson(response, 200, { ok: true, table });
    } catch (error) {
      sendJson(response, 400, { ok: false, code: error.code || "ADMIN_QUERY_INVALID", error: error.message });
    }
  }

  async function handleAdminTableDeletePreview(request, response) {
    try {
      const { tableName } = requestDeletePreviewTable(request);
      const body = await readJsonBody(request);
      const preview = tableName === "egresos"
        ? previewExpenseDeletion
        : tableName === "entregas"
          ? previewDeliveryDeletion
          : null;
      if (!preview) {
        throw adminError("ADMIN_DELETE_PREVIEW_UNAVAILABLE", "La vista previa especial no está disponible para esta tabla.");
      }
      const plan = preview(loadCache(), body.deletedIds);
      sendJson(response, 200, { ok: true, plan });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        code: error.code || "ADMIN_VALIDATION_ERROR",
        error: error.message,
        plan: error.plan || null
      });
    }
  }

  async function handleAdminTableCellUpdate(request, response) {
    try {
      const { tableName } = requestCellTable(request);
      const definition = visibleDefinition(tableName);
      const policy = adminTablePolicy[tableName];
      if (!definition || !policy?.read) return forbidden(response);
      if (!policy.update) return forbidden(response, policy.reason);

      const body = await readJsonBody(request);
      const originalPrimaryValue = stringId(body.primaryKey);
      if (!originalPrimaryValue) {
        throw fieldError("ADMIN_PRIMARY_KEY_INVALID", "primaryKey", "La clave original de la fila es obligatoria.");
      }
      if (!Object.prototype.hasOwnProperty.call(body, "originalValue")) {
        throw fieldError("ADMIN_ORIGINAL_VALUE_REQUIRED", "originalValue", "El valor original de la celda es obligatorio.");
      }
      if (!String(body.tableVersion || "").trim()) {
        throw adminError("ADMIN_VERSION_REQUIRED", "La version de la tabla es obligatoria.");
      }

      const original = loadCache();
      const cache = clone(original);
      const table = cache.tables?.[tableName];
      if (!table) throw adminError("ADMIN_TABLE_NOT_FOUND", "Tabla no encontrada.");
      const columns = backendEditableColumns(tableName, table);
      const primaryKey = backendEditablePrimaryKey(tableName, table, columns);
      if (!primaryKey || !columns.includes(primaryKey)) {
        throw adminError("ADMIN_PRIMARY_KEY_INVALID", `La tabla ${tableName} no tiene una clave primaria valida.`);
      }
      const column = actualColumn(columns, body.column);
      if (!column) {
        throw fieldError("ADMIN_COLUMN_FORBIDDEN", String(body.column || ""), "La columna indicada no existe o no es persistente.");
      }
      if (body.tableVersion !== tableVersion(table)) {
        throw adminError("ADMIN_CONFLICT", "La tabla cambio desde que fue abierta. Recargala antes de guardar.");
      }

      const rows = Array.isArray(table.rows) ? table.rows : [];
      const byId = rowIndex(rows, primaryKey);
      const existingIndex = byId.get(originalPrimaryValue);
      if (existingIndex === undefined) {
        throw fieldError("ADMIN_PRIMARY_KEY_INVALID", primaryKey, "La clave no corresponde a una fila existente.");
      }
      const existing = rows[existingIndex];
      if (!sameCellValue(existing[column], body.originalValue)) {
        throw fieldError(
          "ADMIN_VALUE_CONFLICT",
          column,
          `La celda ${column} cambio desde que fue leida. Recarga la fila antes de volver a guardar.`
        );
      }

      const cleanRow = mergeRow(existing, { [column]: body.value }, columns);
      const nextPrimaryValue = stringId(cleanRow[primaryKey]);
      if (column === primaryKey && nextPrimaryValue !== originalPrimaryValue) {
        if (!nextPrimaryValue) {
          throw fieldError("ADMIN_PRIMARY_KEY_INVALID", primaryKey, "La clave primaria es obligatoria.");
        }
        if (byId.has(nextPrimaryValue)) {
          throw fieldError("ADMIN_PRIMARY_KEY_DUPLICATE", primaryKey, `La clave ${nextPrimaryValue} ya existe.`);
        }
        const dependencies = findDependencies(
          cache,
          loadRegistry(),
          tableName,
          primaryKey,
          originalPrimaryValue,
          adminTablePolicy
        );
        if (dependencies.length) {
          const summary = dependencies.map((item) => `${item.table}.${item.column} (${item.count})`).join(", ");
          const error = fieldError(
            "ADMIN_PRIMARY_KEY_REFERENCED",
            primaryKey,
            `No se puede cambiar la clave ${originalPrimaryValue}: existen referencias en ${summary}.`
          );
          error.dependencies = dependencies;
          throw error;
        }
      }

      validateRow(tableName, cleanRow, policy, cache, columns, primaryKey, false);
      rows[existingIndex] = { ...existing, ...markEdited(cleanRow) };
      table.rows = rows;
      table.rowCount = rows.length;
      table.headers = columns;
      table.updatedAt = nextUpdatedAt(table.updatedAt);
      cache.generatedAt = table.updatedAt;

      ensureAdminSessionBackup();
      const cacheToSave = tableName === "egresos"
        ? synchronizeEconomicExpenses(cache, tableName)
        : cache;
      saveBackendCache(cacheToSave);
      appendAdminAudit([{
        table: tableName,
        operation: "update",
        primaryKey: nextPrimaryValue,
        previousPrimaryKey: nextPrimaryValue === originalPrimaryValue ? undefined : originalPrimaryValue,
        column
      }]);

      const persistedTable = loadCache().tables?.[tableName];
      const persistedRows = Array.isArray(persistedTable?.rows) ? persistedTable.rows : [];
      const persisted = persistedRows.find((row) => stringId(row?.[primaryKey]) === nextPrimaryValue);
      if (!persisted) throw adminError("ADMIN_REREAD_FAILED", "El cambio se guardo, pero no se pudo releer la fila.");
      sendJson(response, 200, {
        ok: true,
        row: mergeRow({}, persisted, columns),
        tableVersion: tableVersion(persistedTable)
      });
    } catch (error) {
      const conflict = error.code === "ADMIN_CONFLICT" || error.code === "ADMIN_VALUE_CONFLICT";
      sendJson(response, conflict ? 409 : 400, {
        ok: false,
        code: error.code || "ADMIN_VALIDATION_ERROR",
        error: error.message,
        field: error.field || "",
        dependencies: error.dependencies || []
      });
    }
  }

  async function handleAdminTableSave(request, response) {
    try {
      const { tableName } = requestTable(request);
      const definition = visibleDefinition(tableName);
      const policy = adminTablePolicy[tableName];
      if (!definition || !policy?.read) return forbidden(response);

      const body = await readJsonBody(request);
      let updatedRows = Array.isArray(body.rows) ? body.rows : [];
      let insertedRows = Array.isArray(body.newRows) ? body.newRows : [];
      const deletedIds = Array.isArray(body.deletedIds) ? body.deletedIds.map(stringId).filter(Boolean) : [];
      if (updatedRows.length && !policy.update) return forbidden(response, policy.reason);
      if (insertedRows.length && !policy.insert) return forbidden(response, policy.reason);
      if (deletedIds.length && !policy.delete) return forbidden(response, policy.reason);
      if (!updatedRows.length && !insertedRows.length && !deletedIds.length) {
        sendJson(response, 400, { ok: false, code: "ADMIN_NO_CHANGES", error: "No hay filas para guardar." });
        return;
      }

      const original = loadCache();
      const cache = clone(original);
      const table = cache.tables?.[tableName];
      if (!table) throw adminError("ADMIN_TABLE_NOT_FOUND", "Tabla no encontrada.");
      const columns = backendEditableColumns(tableName, table);
      const primaryKey = backendEditablePrimaryKey(tableName, table, columns);
      if (!primaryKey || !columns.includes(primaryKey)) {
        throw adminError("ADMIN_PRIMARY_KEY_INVALID", `La tabla ${tableName} no tiene una clave primaria editable valida.`);
      }
      const resultOptions = adminMutationResultOptions(body, columns, primaryKey);
      const pureExpenseDelete = tableName === "egresos"
        && deletedIds.length > 0
        && updatedRows.length === 0
        && insertedRows.length === 0;
      let expenseDeletionResult = null;
      const pureDeliveryDelete = tableName === "entregas"
        && deletedIds.length > 0
        && updatedRows.length === 0
        && insertedRows.length === 0;
      let deliveryDeletionResult = null;
      if (pureExpenseDelete) {
        expenseDeletionResult = applyExpenseDeletion(cache, deletedIds, body.deletePlanToken);
        if (expenseDeletionResult.idempotent) {
          sendJson(response, 200, {
            ok: true,
            idempotent: true,
            deleted: 0,
            deletedIds: [],
            deletionSummary: expenseDeletionResult.plan
          });
          return;
        }
      } else if (pureDeliveryDelete) {
        deliveryDeletionResult = applyDeliveryDeletion(cache, deletedIds, body.deletePlanToken);
        if (deliveryDeletionResult.idempotent) {
          sendJson(response, 200, {
            ok: true,
            idempotent: true,
            deleted: 0,
            deletedIds: [],
            deletionSummary: deliveryDeletionResult.plan
          });
          return;
        }
      } else if (body.tableVersion && body.tableVersion !== tableVersion(table)) {
        throw adminError("ADMIN_CONFLICT", "La tabla cambio desde que fue abierta. Recargala antes de guardar.");
      }
      const legacyInserts = updatedRows.filter((row) => !stringId(row?.[primaryKey]));
      updatedRows = updatedRows.filter((row) => stringId(row?.[primaryKey]));
      insertedRows = [...insertedRows, ...legacyInserts];

      const currentRows = Array.isArray(table.rows) ? table.rows : [];
      const byId = rowIndex(currentRows, primaryKey);
      let nextId = backendNextNumericId(currentRows, primaryKey);
      const operations = [];
      const insertedPrimaryValues = [];

      for (const [inputIndex, inputRow] of updatedRows.entries()) {
        const suppliedId = stringId(inputRow?.[primaryKey]);
        try {
          validateColumns(inputRow, columns);
          if (!suppliedId || !byId.has(suppliedId)) {
            throw fieldError("ADMIN_PRIMARY_KEY_INVALID", primaryKey, "La clave no corresponde a una fila existente.");
          }
          const existingIndex = byId.get(suppliedId);
          const existing = currentRows[existingIndex];
          if (stringId(existing[primaryKey]) !== suppliedId) {
            throw fieldError("ADMIN_PRIMARY_KEY_IMMUTABLE", primaryKey, "La clave primaria no puede modificarse.");
          }
          const cleanRow = mergeRow(existing, inputRow, columns);
          validateRow(tableName, cleanRow, policy, cache, columns, primaryKey, false);
          currentRows[existingIndex] = markEdited(cleanRow);
          operations.push({ table: tableName, operation: "update", primaryKey: suppliedId });
        } catch (error) {
          throw rowError(error, inputIndex, suppliedId);
        }
      }

      const generatedPrimaryKey = isGeneratedPrimaryKey(primaryKey, currentRows);
      for (const [inputIndex, inputRow] of insertedRows.entries()) {
        let suppliedId = stringId(inputRow?.[primaryKey]);
        try {
          validateColumns(inputRow, columns);
          const cleanRow = mergeRow({}, inputRow, columns);
          suppliedId = stringId(cleanRow[primaryKey]);
          if (!suppliedId && generatedPrimaryKey) {
            cleanRow[primaryKey] = nextId;
            suppliedId = stringId(nextId);
            nextId += 1;
          } else if (!suppliedId) {
            throw fieldError("ADMIN_REQUIRED_FIELD", primaryKey, `El campo ${primaryKey} es obligatorio.`);
          }
          if (byId.has(suppliedId)) {
            throw fieldError("ADMIN_PRIMARY_KEY_DUPLICATE", primaryKey, `La clave ${suppliedId} ya existe.`);
          }
          validateRow(tableName, cleanRow, policy, cache, columns, primaryKey, true);
          currentRows.push({ _rowNumber: currentRows.length + 2, ...markEdited(cleanRow) });
          byId.set(suppliedId, currentRows.length - 1);
          insertedPrimaryValues.push(suppliedId);
          operations.push({ table: tableName, operation: "insert", primaryKey: suppliedId });
        } catch (error) {
          throw rowError(error, inputIndex, suppliedId);
        }
      }

      if (tableName === "egresos" && deletedIds.length) {
        if (!expenseDeletionResult) applyExpenseDeletion(cache, deletedIds, body.deletePlanToken);
        operations.push(...deletedIds.map((primaryKeyValue) => ({
          table: tableName,
          operation: "delete",
          primaryKey: primaryKeyValue
        })));
      } else if (!deliveryDeletionResult) for (const [inputIndex, deletedId] of deletedIds.entries()) {
        try {
          const existingIndex = byId.get(deletedId);
          if (existingIndex === undefined) {
            throw fieldError("ADMIN_PRIMARY_KEY_INVALID", primaryKey, `La clave ${deletedId} no corresponde a una fila existente.`);
          }
          const dependencies = findDependencies(
            cache,
            loadRegistry(),
            tableName,
            primaryKey,
            deletedId,
            adminTablePolicy
          );
          if (dependencies.length) {
            const summary = dependencies.map((item) => `${item.table}.${item.column} (${item.count})`).join(", ");
            throw fieldError("ADMIN_DELETE_REFERENCED", primaryKey, `No se puede eliminar: existen referencias en ${summary}.`);
          }
        } catch (error) {
          throw rowError(error, inputIndex, deletedId);
        }
      }
      if (deliveryDeletionResult) {
        operations.push(...deletedIds.map((primaryKeyValue) => ({
          table: tableName,
          operation: "delete",
          primaryKey: primaryKeyValue
        })));
      } else if (deletedIds.length && tableName !== "egresos") {
        const deletedSet = new Set(deletedIds);
        table.rows = currentRows.filter((row) => !deletedSet.has(stringId(row[primaryKey])));
        deletedIds.forEach((id) => operations.push({ table: tableName, operation: "delete", primaryKey: id }));
      } else if (tableName !== "egresos") {
        table.rows = currentRows;
      }

      table.rowCount = table.rows.length;
      table.headers = columns;
      table.updatedAt = nextUpdatedAt(table.updatedAt);
      cache.generatedAt = table.updatedAt;
      ensureAdminSessionBackup();
      const cacheToSave = tableName === "egresos" && !deletedIds.length
        ? synchronizeEconomicExpenses(cache, tableName)
        : cache;
      saveBackendCache(cacheToSave);
      appendAdminAudit(operations);

      const resultTable = backendTable(tableName, {
        adminContinuous: true,
        ...resultOptions
      });
      const persistedCache = loadCache();
      decorateAdminTable(tableName, resultTable, policy, persistedCache);
      resultTable.version = currentTableVersion(tableName);
      const persistedRows = persistedCache.tables?.[tableName]?.rows || [];
      const rereadInsertedRows = insertedPrimaryValues.map((primaryValue) => {
        const row = persistedRows.find((candidate) => stringId(candidate?.[primaryKey]) === primaryValue);
        return row ? mergeRow({}, row, columns) : null;
      }).filter(Boolean);
      sendJson(response, 200, {
        ok: true,
        table: resultTable,
        tableVersion: resultTable.version,
        insertedRows: rereadInsertedRows,
        updated: updatedRows.length,
        inserted: insertedRows.length,
        deleted: deletedIds.length,
        deletedIds,
        ...((tableName === "egresos" || tableName === "entregas") && deletedIds.length
          ? { deletionSummary: tableName === "egresos"
            ? previewExpenseDeletion(original, deletedIds)
            : deliveryDeletionResult.plan }
          : {})
      });
    } catch (error) {
      const conflict = error.code === "ADMIN_CONFLICT" || error.code === "ADMIN_DELETE_PLAN_CONFLICT";
      sendJson(response, conflict ? 409 : 400, {
        ok: false,
        code: error.code || "ADMIN_VALIDATION_ERROR",
        error: error.message,
        field: error.field || "",
        rowIndex: Number.isInteger(error.rowIndex) ? error.rowIndex : null,
        rowKey: error.rowKey || "",
        plan: error.plan || null
      });
    }
  }

  function visibleDefinition(tableName) {
    return (loadRegistry().tables || []).find((definition) => definition.name === tableName && !definition.hidden);
  }

  function currentTableVersion(tableName) {
    const table = loadCache().tables?.[tableName];
    return table ? tableVersion(table) : "";
  }

  return {
    handleAdminTableCellUpdate,
    handleAdminTableDeletePreview,
    handleAdminTableRequest,
    handleAdminTableSave,
    handleAdminTablesOverview
  };
}

function requestTable(request) {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  const tableName = decodeURIComponent(url.pathname.replace("/api/admin/tables/", "")).trim();
  return { tableName, url };
}

function requestCellTable(request) {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  const match = url.pathname.match(/^\/api\/admin\/tables\/([^/]+)\/cell$/);
  if (!match) throw adminError("ADMIN_ENDPOINT_INVALID", "Ruta administrativa invalida.");
  return { tableName: decodeURIComponent(match[1]).trim(), url };
}

function requestDeletePreviewTable(request) {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  const match = url.pathname.match(/^\/api\/admin\/tables\/([^/]+)\/delete-preview$/);
  if (!match) throw adminError("ADMIN_ENDPOINT_INVALID", "Ruta administrativa inválida.");
  return { tableName: decodeURIComponent(match[1]).trim(), url };
}

function tableOptions(searchParams) {
  const orderDir = String(searchParams.get("orderDir") || "desc").trim().toLowerCase();
  if (!["asc", "desc"].includes(orderDir)) {
    throw adminError("ADMIN_ORDER_INVALID", "orderDir debe ser asc o desc.");
  }
  return {
    adminContinuous: true,
    search: searchParams.get("search") || "",
    filters: columnFiltersFromSearchParams(searchParams),
    orderBy: searchParams.get("orderBy") || "",
    orderDir
  };
}

function adminMutationResultOptions(body, columns, primaryKey) {
  const requestedOrder = String(body.orderBy || "").trim();
  if (requestedOrder && normalizeName(requestedOrder) !== normalizeName(primaryKey)) {
    throw adminError("ADMIN_ORDER_COLUMN_INVALID", `El Editor administrativo solo permite ordenar por ${primaryKey}.`);
  }
  const orderDir = String(body.orderDir || "desc").trim().toLowerCase();
  if (!["asc", "desc"].includes(orderDir)) {
    throw adminError("ADMIN_ORDER_INVALID", "orderDir debe ser asc o desc.");
  }
  const filters = body.filters || body.filter || {};
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
    throw adminError("ADMIN_FILTER_INVALID", "Los filtros por columna deben enviarse como un objeto.");
  }
  for (const column of Object.keys(filters)) {
    if (!actualColumn(columns, column)) {
      throw adminError("ADMIN_FILTER_COLUMN_INVALID", `La columna ${column} no existe en la tabla.`);
    }
  }
  return {
    search: body.search || "",
    filters,
    orderBy: requestedOrder ? primaryKey : "",
    orderDir
  };
}

function columnFiltersFromSearchParams(searchParams) {
  const result = {};
  for (const parameter of ["filters", "filter"]) {
    const raw = searchParams.get(parameter);
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw adminError("ADMIN_FILTER_INVALID", `El parametro ${parameter} debe contener JSON valido.`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw adminError("ADMIN_FILTER_INVALID", `El parametro ${parameter} debe contener un objeto JSON.`);
    }
    Object.assign(result, parsed);
  }
  searchParams.forEach((value, key) => {
    if (key.startsWith("filter.") && key.length > "filter.".length) {
      result[key.slice("filter.".length)] = value;
    }
  });
  return result;
}

function validateColumns(row, columns) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw adminError("ADMIN_ROW_INVALID", "La fila enviada no es valida.");
  }
  const allowed = new Set(columns);
  const extras = Object.keys(row).filter((column) => !allowed.has(column));
  if (extras.length) throw adminError("ADMIN_COLUMN_FORBIDDEN", `Columnas no permitidas: ${extras.join(", ")}.`);
}

function validateRow(tableName, row, policy, cache, columns, primaryKey, inserting) {
  const validation = policy.validation || {};
  for (const column of new Set([primaryKey, ...(validation.required || [])])) {
    if (!String(row[column] ?? "").trim()) throw fieldError("ADMIN_REQUIRED_FIELD", column, `El campo ${column} es obligatorio.`);
  }
  const sampleRows = cache.tables?.[tableName]?.rows || [];
  for (const column of columns) {
    row[column] = normalizeTypedValue(column, row[column], sampleRows);
  }
  for (const reference of knownReferences(tableName, columns, cache, validation.references || [])) {
    const value = String(row[reference.column] ?? "").trim();
    if (!value && reference.optional) continue;
    if (!value) continue;
    const targetRows = cache.tables?.[reference.table]?.rows || [];
    if (!targetRows.some((target) => stringId(target[reference.target]) === value)) {
      throw fieldError("ADMIN_REFERENCE_INVALID", reference.column, `La referencia ${reference.column} no existe en ${reference.table}.`);
    }
  }
  if (!inserting && !stringId(row[primaryKey])) {
    throw fieldError("ADMIN_PRIMARY_KEY_INVALID", primaryKey, "La clave primaria es obligatoria.");
  }
}

function normalizeTypedValue(column, rawValue, sampleRows) {
  const value = String(rawValue ?? "").trim();
  if (!value) return "";
  if (isDateColumn(column) && !isValidDateValue(value, column)) {
    throw fieldError("ADMIN_INVALID_DATE", column, `El campo ${column} tiene una fecha invalida.`);
  }
  if (isMoneyColumn(column)) {
    if (!isCanonicalMoney(value)) {
      throw fieldError("ADMIN_INVALID_MONEY", column, `El campo ${column} debe ser un importe valido con hasta dos decimales.`);
    }
    return canonicalMoney(rawValue);
  }
  const type = columnType(column, sampleRows);
  const sample = sampleRows.map((row) => row?.[column]).find((item) => String(item ?? "").trim());
  if (type === "number" && !Number.isFinite(Number(value))) {
    throw fieldError("ADMIN_INVALID_NUMBER", column, `El campo ${column} debe ser numerico.`);
  }
  if (type === "boolean") {
    if (typeof rawValue === "boolean") return rawValue;
    if (!/^(true|false|1|0)$/i.test(value)) {
      throw fieldError("ADMIN_INVALID_BOOLEAN", column, `El campo ${column} debe ser verdadero o falso.`);
    }
    return /^(true|1)$/i.test(value);
  }
  if (type === "number" && typeof sample === "number") return Number(value);
  if (type === "number" && sample === undefined) return Number(value);
  return rawValue ?? "";
}

function knownReferences(tableName, columns, cache, configured) {
  const references = [...configured];
  for (const relation of adminRelationsForTable(tableName)) {
    const sourceColumn = actualColumn(columns, relation.column);
    const target = cache.tables?.[relation.table];
    const targetColumns = tableColumns(target);
    const targetColumn = actualColumn(targetColumns, relation.target);
    if (sourceColumn && targetColumn) {
      references.push({
        column: sourceColumn,
        table: relation.table,
        target: targetColumn,
        optional: true
      });
    }
  }
  const configuredColumns = new Set(references.map((reference) => normalizeName(reference.column)));
  const registryTargets = [];
  for (const [targetTable, target] of Object.entries(cache.tables || {})) {
    if (targetTable === tableName) continue;
    const targetColumns = tableColumns(target);
    const targetPrimary = target.definition?.primaryKey || targetColumns[0] || "";
    const actualPrimary = targetColumns.find((column) => normalizeName(column) === normalizeName(targetPrimary)) || targetColumns[0];
    if (actualPrimary) registryTargets.push({ table: targetTable, target: actualPrimary });
  }
  for (const column of columns) {
    if (configuredColumns.has(normalizeName(column)) || !/^id_/i.test(column)) continue;
    const target = registryTargets.find((candidate) => normalizeName(candidate.target) === normalizeName(column));
    if (target) references.push({ column, ...target, optional: true });
  }
  return references;
}

function findDependencies(cache, registry, tableName, primaryKey, primaryValue, policies = {}) {
  const registered = new Set((registry.tables || []).map((table) => table.name));
  const dependencies = [];
  for (const [candidateName, candidate] of Object.entries(cache.tables || {})) {
    if (!registered.has(candidateName)) continue;
    const headers = tableColumns(candidate);
    const referenceColumns = new Set(
      headers.filter((header) => candidateName !== tableName && normalizeName(header) === normalizeName(primaryKey))
    );
    for (const relation of adminRelationsForTable(candidateName)) {
      if (
        relation.table === tableName
        && normalizeName(relation.target) === normalizeName(primaryKey)
      ) {
        const sourceColumn = actualColumn(headers, relation.column);
        if (sourceColumn) referenceColumns.add(sourceColumn);
      }
    }
    for (const reference of policies[candidateName]?.validation?.references || []) {
      if (
        reference.table === tableName
        && normalizeName(reference.target) === normalizeName(primaryKey)
      ) {
        const sourceColumn = actualColumn(headers, reference.column);
        if (sourceColumn) referenceColumns.add(sourceColumn);
      }
    }
    for (const column of referenceColumns) {
      const count = (candidate.rows || []).filter((row) => stringId(row[column]) === primaryValue).length;
      if (count) dependencies.push({ table: candidateName, column, count });
    }
  }
  return dependencies;
}

function decorateAdminTable(tableName, table, policy, cache) {
  const relations = publicRelations(tableName, table, cache);
  table.capabilities = publicCapability(policy);
  table.relations = relations;
  table.schema = publicSchema(tableName, table, policy, cache, relations);
  return table;
}

function publicSchema(tableName, table, policy, cache, relations = {}) {
  const configuredPrimary = table.definition?.primaryKey || "";
  const configuredPrimaryColumn = actualColumn(table.headers || [], configuredPrimary);
  const primaryKey = configuredPrimaryColumn || table.order?.column || table.headers?.[0] || "";
  const required = new Set([primaryKey, ...(policy.validation?.required || [])].filter(Boolean).map(normalizeName));
  const sourceRows = cache.tables?.[tableName]?.rows || table.rows || [];
  const generatedPrimaryKey = isGeneratedPrimaryKey(primaryKey, sourceRows);
  return {
    primaryKey,
    primaryKeyValid: Boolean(configuredPrimaryColumn),
    ...(configuredPrimaryColumn
      ? {}
      : { primaryKeyNotice: `La clave configurada ${configuredPrimary || "(sin definir)"} no existe; se utiliza ${primaryKey || "ninguna columna"}.` }),
    columns: (table.headers || []).map((column) => ({
      name: column,
      primaryKey: column === primaryKey,
      required: required.has(normalizeName(column)),
      generated: column === primaryKey && generatedPrimaryKey,
      type: columnType(column, sourceRows),
      ...(relations[column] ? { relation: relationMetadata(relations[column]) } : {})
    }))
  };
}

function publicRelations(tableName, table, cache) {
  const result = {};
  const sourceColumns = table.headers || [];
  for (const configured of adminRelationsForTable(tableName)) {
    const column = actualColumn(sourceColumns, configured.column);
    const targetTable = cache.tables?.[configured.table];
    const targetColumns = tableColumns(targetTable);
    const target = actualColumn(targetColumns, configured.target);
    const displayColumn = actualColumn(targetColumns, configured.displayColumn);
    if (!column || !targetTable || !target || !displayColumn) continue;
    const allOptions = relationOptions(targetTable.rows || [], target, displayColumn);
    const currentValues = new Set((table.rows || []).map((row) => stringId(row?.[column])).filter(Boolean));
    const selected = allOptions.slice(0, RELATION_OPTION_LIMIT);
    const selectedValues = new Set(selected.map((option) => option.value));
    for (const option of allOptions) {
      if (currentValues.has(option.value) && !selectedValues.has(option.value)) {
        selected.push(option);
        selectedValues.add(option.value);
      }
    }
    result[column] = {
      column,
      table: configured.table,
      target,
      displayColumn,
      label: configured.label,
      options: selected,
      totalOptions: allOptions.length,
      truncated: selected.length < allOptions.length
    };
  }
  return result;
}

function relationMetadata(relation) {
  const { options, ...metadata } = relation;
  return metadata;
}

function relationOptions(rows, target, displayColumn) {
  const byValue = new Map();
  for (const row of rows) {
    const value = stringId(row?.[target]);
    if (!value || byValue.has(value)) continue;
    byValue.set(value, {
      value,
      label: String(row?.[displayColumn] ?? "").trim()
    });
  }
  return [...byValue.values()].sort((left, right) => (
    left.label.localeCompare(right.label, "es", { numeric: true })
    || left.value.localeCompare(right.value, "es", { numeric: true })
  ));
}

function isGeneratedPrimaryKey(primaryKey, rows) {
  if (!/^id_/i.test(primaryKey || "")) return false;
  const values = (rows || []).map((row) => stringId(row?.[primaryKey])).filter(Boolean);
  if (!values.length) return true;
  if (!values.every((value) => /^\d+$/.test(value))) return false;
  const numericValues = values.map((value) => BigInt(value));
  return numericValues.every((value, index) => index === 0 || value > numericValues[index - 1]);
}

function columnType(column, sampleRows = []) {
  if (isDateColumn(column)) return "date";
  if (isMoneyColumn(column)) return "money";
  const sample = sampleRows.map((row) => row?.[column]).find((value) => String(value ?? "").trim());
  if (typeof sample === "boolean") return "boolean";
  if (typeof sample === "number") return "number";
  if (sample === undefined && /^id_/i.test(column)) return "number";
  if (/^(activo|habilitado|confirmado)$/i.test(column)) return "boolean";
  return "text";
}

function isDateColumn(column) {
  return /(^fecha(?:_|$)|_fecha$|_en$)/i.test(column);
}

function isValidDateValue(value, column) {
  if (/_en$/i.test(column)) return !Number.isNaN(Date.parse(value));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isMoneyColumn(column) {
  return /(^|_)(monto|importe|subtotal|total|precio|costo|capital|interes|comision|iva|bonificacion|premios|valor_remunerativo|valor_no_remunerativo|sueldo_bruto|sueldo_neto|debito|credito|saldo)(_|$)/i.test(column);
}

function isCanonicalMoney(value) {
  const normalized = String(value).trim().replace(/\s/g, "").replace(/\$/g, "");
  if (/^-?\d+(?:[.,]\d{1,2})?$/.test(normalized)) return true;
  if (/^-?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?$/.test(normalized)) return true;
  return /^-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$/.test(normalized);
}

function canonicalMoney(value) {
  let normalized = String(value).trim().replace(/\s/g, "").replace(/\$/g, "");
  if (normalized.includes(",") && normalized.includes(".")) {
    normalized = normalized.lastIndexOf(",") > normalized.lastIndexOf(".")
      ? normalized.replace(/\./g, "").replace(",", ".")
      : normalized.replace(/,/g, "");
  } else if (normalized.includes(",")) {
    normalized = /^-?\d{1,3}(?:,\d{3})+$/.test(normalized)
      ? normalized.replace(/,/g, "")
      : normalized.replace(",", ".");
  } else if (/^-?\d{1,3}(?:\.\d{3})+$/.test(normalized)) {
    normalized = normalized.replace(/\./g, "");
  }
  return Math.round(Number(normalized) * 100) / 100;
}

function mergeRow(existing, input, columns) {
  return Object.fromEntries(columns.map((column) => [
    column,
    Object.prototype.hasOwnProperty.call(input, column) ? input[column] ?? "" : existing[column] ?? ""
  ]));
}

function markEdited(row) {
  return { ...row, _editedLocallyAt: new Date().toISOString() };
}

function rowIndex(rows, primaryKey) {
  const result = new Map();
  rows.forEach((row, index) => {
    const id = stringId(row?.[primaryKey]);
    if (id) result.set(id, index);
  });
  return result;
}

function rowError(error, rowIndexValue, rowKey) {
  if (!Number.isInteger(error.rowIndex)) error.rowIndex = rowIndexValue;
  if (!error.rowKey) error.rowKey = rowKey;
  return error;
}

function tableColumns(table) {
  if (!table) return [];
  if (Array.isArray(table.headers) && table.headers.length) return table.headers;
  const firstRow = (table.rows || []).find((row) => row && typeof row === "object");
  return firstRow ? Object.keys(firstRow).filter((column) => !column.startsWith("_")) : [];
}

function actualColumn(columns, requested) {
  const normalized = normalizeName(requested);
  return (columns || []).find((column) => normalizeName(column) === normalized) || "";
}

function tableVersion(table) {
  return `${table.updatedAt || ""}:${table.rowCount ?? table.rows?.length ?? 0}`;
}

function nextUpdatedAt(previousValue) {
  const previousTime = Date.parse(previousValue || "");
  const nextTime = Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0);
  return new Date(nextTime).toISOString();
}

function sameCellValue(currentValue, originalValue) {
  if (currentValue && typeof currentValue === "object") {
    return JSON.stringify(currentValue) === JSON.stringify(originalValue);
  }
  return Object.is(currentValue, originalValue);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stringId(value) {
  return String(value ?? "").trim();
}

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function publicCapability(policy) {
  if (!policy) return { read: false, insert: false, update: false, delete: false, category: "denied", reason: "Tabla no habilitada para Administracion." };
  const { validation, ...capability } = policy;
  return capability;
}

function forbidden(response, reason = "Operacion no autorizada para el editor administrativo.") {
  response.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ ok: false, code: "ADMIN_OPERATION_FORBIDDEN", error: reason }));
}

function fieldError(code, field, message) {
  const error = adminError(code, message);
  error.field = field;
  return error;
}

function adminError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  columnFiltersFromSearchParams,
  createAdminTableService,
  isGeneratedPrimaryKey,
  publicRelations,
  relationOptions
};
