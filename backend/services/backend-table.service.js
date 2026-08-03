const { fromCents } = require("../../shared/money");
const { isMoneyColumn } = require("../../shared/money-columns");
const { EMPLOYEE_GENERIC_TABLE_MUTATIONS } = require("./access-control.service");
const { strictMoneyToCents } = require("../utils/money-input");
const { reconcileCashSourceRows } = require("./cash-ledger.service");

function createBackendTableService({ backendEditableColumns, backendEditablePrimaryKey, backendId, backendNextNumericId, backendTable, ensureBackendTable, expectedBackendColumns, loadCache, readJsonBody, recordAllRowsRead = () => {}, saveBackendCache, sendJson, synchronizeEconomicExpenses = (cache) => cache }) {
  function handleBackendTableRequest(request, response) {
    const startedAt = Date.now();
    const url = new URL(request.url, `http://${request.headers.host}`);
    const tableName = decodeURIComponent(url.pathname.replace("/api/backend/tables/", "")).trim();
    const table = backendTable(tableName, {
      search: url.searchParams.get("search") || "",
      limit: url.searchParams.get("limit") || "",
      offset: url.searchParams.get("offset") || "",
      all: url.searchParams.get("all") === "true"
    });
  
    if (!table) {
      sendJson(response, 404, { ok: false, error: "Tabla no encontrada." });
      return;
    }
  
    if (url.searchParams.get("all") === "true") recordAllRowsRead(tableName, table, startedAt);
    sendJson(response, 200, { ok: true, table });
  }
  
  async function handleBackendTableSave(request, response) {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const tableName = decodeURIComponent(url.pathname.replace("/api/backend/tables/", "")).trim();
      if (tableName === "gestion_ventas") {
        sendJson(response, 403, { ok: false, error: "La gestión de ventas es una tabla técnica y sólo admite sus endpoints específicos." });
        return;
      }
      if (tableName === "caja_efectivo_movimientos") {
        sendJson(response, 403, { ok: false, code: "CASH_LEDGER_APPEND_ONLY", error: "El libro de Caja Efectivo es de solo lectura y se actualiza únicamente desde Tesorería." });
        return;
      }
      const body = await readJsonBody(request);
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const deletedIds = Array.isArray(body.deletedIds) ? body.deletedIds.map(backendId).filter(Boolean) : [];
      if (!canUseGenericTableMutation(request.accessIdentity, tableName, deletedIds)) {
        sendJson(response, 403, { ok: false, code: "OWNER_REQUIRED", error: "Esta operaciĂłn genĂ©rica estĂˇ reservada al propietario." });
        return;
      }
      if (!rows.length && !deletedIds.length) {
        sendJson(response, 400, { ok: false, error: "No hay filas para guardar." });
        return;
      }
  
      let cache = loadCache();
      cache.tables = cache.tables || {};
      let table = cache.tables[tableName];
      // Algunas tablas internas se crean al registrar su primer movimiento.
      if (!table && Object.prototype.hasOwnProperty.call(expectedBackendColumns, tableName)) {
        ensureBackendTable(cache.tables, tableName);
        table = cache.tables[tableName];
      }
      if (!table) {
        sendJson(response, 404, { ok: false, error: "Tabla no encontrada." });
        return;
      }
  
      const columns = backendEditableColumns(tableName, table);
      const primaryKey = backendEditablePrimaryKey(tableName, table, columns);
      const currentRows = Array.isArray(table.rows) ? table.rows : [];
      const cashSourceRowsBefore = ["cobros", "pagos"].includes(tableName)
        ? JSON.parse(JSON.stringify(currentRows))
        : null;
      const byId = new Map();
      currentRows.forEach((row, index) => {
        const id = backendId(row[primaryKey]);
        if (id) byId.set(id, index);
      });
  
      let nextId = backendNextNumericId(currentRows, primaryKey);
      let updated = 0;
      let inserted = 0;
      let deleted = 0;
  
      if (primaryKey && deletedIds.length) {
        const idsToDelete = new Set(deletedIds);
        for (let index = currentRows.length - 1; index >= 0; index -= 1) {
          if (!idsToDelete.has(backendId(currentRows[index][primaryKey]))) continue;
          currentRows.splice(index, 1);
          deleted += 1;
        }
      }
  
      const rowsToSave = rows.filter((inputRow) => {
        const hasPrimaryKey = primaryKey && backendId(inputRow[primaryKey]);
        const hasEditableValue = columns.some((column) =>
          column !== primaryKey && String(inputRow[column] ?? "").trim() !== ""
        );
        return hasPrimaryKey || hasEditableValue;
      });
  
      rowsToSave.forEach((inputRow) => {
        const cleanRow = {};
        columns.forEach((column) => {
          const value = inputRow[column] ?? "";
          cleanRow[column] = isMoneyColumn(tableName, column) && String(value).trim() !== ""
            ? fromCents(strictMoneyToCents(value))
            : value;
        });
  
        if (primaryKey && !backendId(cleanRow[primaryKey])) {
          cleanRow[primaryKey] = nextId;
          nextId += 1;
        }
  
        const id = primaryKey ? backendId(cleanRow[primaryKey]) : "";
        const existingIndex = id ? byId.get(id) : undefined;
        if (existingIndex !== undefined) {
          currentRows[existingIndex] = {
            ...currentRows[existingIndex],
            ...cleanRow,
            _editedLocallyAt: new Date().toISOString()
          };
          updated += 1;
        } else {
          currentRows.push({
            _rowNumber: currentRows.length + 2,
            ...cleanRow,
            _editedLocallyAt: new Date().toISOString()
          });
          inserted += 1;
        }
      });
  
      table.rows = currentRows;
      table.rowCount = currentRows.length;
      table.headers = columns;
      cache.generatedAt = new Date().toISOString();
      if ((rowsToSave.length || deletedIds.length) && ["ventas", "entregas", "otros_gastos", "egresos", "sueldos", "cuotas_planes_pagos", "pagos", "detalle_pagos"].includes(tableName)) {
        cache = synchronizeEconomicExpenses(cache, tableName);
      }
      if (cashSourceRowsBefore && cache.tables?.caja_efectivo_movimientos) {
        reconcileCashSourceRows(
          cache,
          tableName === "cobros" ? "cobro" : "pago",
          cashSourceRowsBefore,
          cache.tables[tableName].rows,
          { operationId: request.auditRequestId, actor: request.accessIdentity?.user }
        );
      }
      saveBackendCache(cache);
  
      sendJson(response, 200, {
        ok: true,
        table: backendTable(tableName, { limit: body.limit || 300, offset: body.offset || 0, search: body.search || "" }),
        updated,
        inserted,
        deleted
      });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
    }
  }

  return { handleBackendTableRequest, handleBackendTableSave };
}

function canUseGenericTableMutation(identity, tableName, deletedIds = []) {
  const role = identity?.user?.role;
  if (!role || role === "owner") return true;
  return role === "employee_admin"
    && EMPLOYEE_GENERIC_TABLE_MUTATIONS.has(String(tableName || ""))
    && deletedIds.length === 0;
}

module.exports = { canUseGenericTableMutation, createBackendTableService };
