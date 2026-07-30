async function requestBackendApi(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = payload.code || "";
    error.details = payload.details || null;
    throw error;
  }
  return payload;
}

async function backendTableRowsForEntry(tableName) {
  const payload = await requestBackendApi(`/api/backend/tables/${encodeURIComponent(tableName)}?all=true`);
  return Array.isArray(payload.table?.rows) ? payload.table.rows : [];
}

async function saveBackendEntryRows(tableName, rows) {
  return requestBackendApi(`/api/backend/tables/${encodeURIComponent(tableName)}`, {
    method: "POST",
    body: JSON.stringify({ rows, search: "", limit: 300 })
  });
}

async function saveSalesOrder(order, details) {
  return requestBackendApi("/api/sales/orders/full-entry", {
    method: "POST",
    body: JSON.stringify({ order, details })
  });
}

async function saveTreasuryOperation(path, body) {
  return requestBackendApi(path, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

function newTreasuryOperationId(prefix) {
  const randomPart = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${randomPart}`;
}
