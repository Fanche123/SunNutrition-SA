const DATA_EDITOR_ROW_HEIGHT = 32;
const DATA_EDITOR_OVERSCAN = 10;
const DATA_EDITOR_SEARCH_DELAY = 280;
const DATA_EDITOR_SAVED_INDICATOR_MS = 1400;

let dataEditorGridBound = false;
let dataEditorLoadSequence = 0;
let dataEditorDeletePreviewSequence = 0;

function createDataEditorViewState() {
  return {
    table: null,
    loadedTableName: "",
    draftRows: [],
    selectedRowKeys: new Set(),
    cellStates: new Map(),
    rowStates: new Map(),
    activeCell: null,
    editingCell: null,
    columnWidths: {},
    search: "",
    columnFilters: {},
    orderDir: "desc",
    virtualStart: -1,
    virtualEnd: -1,
    virtualFrame: 0,
    searchTimer: 0,
    filterTimer: 0,
    saveQueue: Promise.resolve()
  };
}

function dataEditorViewState() {
  return dataEditorViews.primary;
}

function dataEditorElement(id) {
  return document.getElementById(id);
}

function setupDataEditorGrid() {
  if (dataEditorGridBound) return;
  dataEditorGridBound = true;

  dataEditorElement("data-editor-table")?.addEventListener("change", handleDataEditorTableChange);
  dataEditorElement("data-editor-search")?.addEventListener("input", scheduleDataEditorSearch);
  dataEditorElement("data-editor-search")?.addEventListener("search", scheduleDataEditorSearch);
  dataEditorElement("data-editor-search")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    applyDataEditorSearchNow();
  });
  dataEditorElement("data-editor-reload")?.addEventListener("click", refreshDataEditorTable);
  dataEditorElement("data-editor-delete-selected")?.addEventListener("click", openDataEditorDeleteDialog);
  dataEditorElement("data-editor-delete-confirm")?.addEventListener("click", confirmDataEditorDelete);
  dataEditorElement("data-editor-delete-dialog")?.addEventListener("close", () => {
    dataEditorDeletePreviewSequence += 1;
  });

  const grid = dataEditorElement("data-editor-body");
  grid?.addEventListener("click", handleDataEditorGridClick);
  grid?.addEventListener("dblclick", handleDataEditorGridDoubleClick);
  grid?.addEventListener("keydown", handleDataEditorGridKeyDown);
  grid?.addEventListener("input", handleDataEditorGridInput);
  grid?.addEventListener("change", handleDataEditorGridChange);
  grid?.addEventListener("paste", handleDataEditorGridPaste);
  grid?.addEventListener("pointerdown", handleDataEditorResizeStart);
  grid?.addEventListener("scroll", scheduleDataEditorVirtualRender, true);

  window.addEventListener("beforeunload", (event) => {
    if (!dataEditorHasPendingChanges()) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

async function loadDataEditorSchema(force = false) {
  if (dataEditorSchema && !force) {
    renderDataEditorTableOptions();
    if (!dataEditorViewState().table && dataEditorElement("data-editor-table")?.value) {
      await loadDataEditorTable();
    }
    return;
  }

  setDataEditorStatus("Leyendo tablas…", "loading");
  try {
    const response = await fetch(`${API_BASE_URL}/api/admin/tables`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    dataEditorSchema = payload;
    renderDataEditorTableOptions();
    if (dataEditorElement("data-editor-table")?.value) await loadDataEditorTable();
  } catch (error) {
    setDataEditorStatus(`No se pudo cargar el Editor: ${error.message}`, "error");
    setDataEditorGridHtml('<div class="data-editor-empty">No se pudieron leer las tablas disponibles.</div>');
  }
}

function renderDataEditorTableOptions() {
  const select = dataEditorElement("data-editor-table");
  if (!select || !dataEditorSchema) return;
  const tables = dataEditorSchema.tables || [];
  const current = dataEditorViewState().loadedTableName || select.value;
  select.innerHTML = tables.map((table) => (
    `<option value="${escapeHtml(table.name)}">${escapeHtml(table.label || table.name)}</option>`
  )).join("");
  select.value = tables.some((table) => table.name === current)
    ? current
    : (tables[0]?.name || "");
}

async function handleDataEditorTableChange() {
  const view = dataEditorViewState();
  const select = dataEditorElement("data-editor-table");
  if (!select) return;
  await view.saveQueue.catch(() => {});
  const nextTable = select.value;
  if (dataEditorHasPendingChanges() && !confirmDataEditorAbandon("cambiar de tabla")) {
    select.value = view.loadedTableName;
    return;
  }
  discardDataEditorLocalChanges();
  resetDataEditorQuery();
  await loadDataEditorTable("primary", { tableName: nextTable, resetScroll: true });
}

async function refreshDataEditorTable() {
  const view = dataEditorViewState();
  await view.saveQueue.catch(() => {});
  if (dataEditorHasPendingChanges() && !confirmDataEditorAbandon("recargar")) return;
  discardDataEditorLocalChanges();
  await loadDataEditorTable("primary", { resetScroll: true });
}

async function loadDataEditorTable(_viewId = "primary", options = {}) {
  const view = dataEditorViewState();
  const tableName = options.tableName || dataEditorElement("data-editor-table")?.value || "";
  if (!tableName) return;
  await view.saveQueue.catch(() => {});
  const requestId = ++dataEditorLoadSequence;
  const orderColumn = dataEditorRequestedOrderColumn(tableName);

  setDataEditorStatus("Cargando todas las filas…", "loading");
  try {
    const params = new URLSearchParams({ all: "true", orderDir: view.orderDir });
    if (orderColumn) params.set("orderBy", orderColumn);
    if (view.search) params.set("search", view.search);
    const filters = dataEditorActiveFilters();
    if (Object.keys(filters).length) params.set("filters", JSON.stringify(filters));

    const response = await fetch(
      `${API_BASE_URL}/api/admin/tables/${encodeURIComponent(tableName)}?${params}`,
      { cache: "no-store" }
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    if (requestId !== dataEditorLoadSequence) return;

    view.table = payload.table;
    view.loadedTableName = tableName;
    hydrateDataEditorRows();
    sortDataEditorRows();
    renderDataEditorGridStructure();
    syncDataEditorCapabilities();
    if (options.resetScroll !== false) resetDataEditorScroll();
    renderDataEditorVirtualRows(true);
    setDataEditorSummary();

    if (pendingDataEditorDraft?.tableName === tableName) applyDataEditorDraft();
  } catch (error) {
    if (requestId !== dataEditorLoadSequence) return;
    setDataEditorStatus(error.message, "error");
    setDataEditorGridHtml('<div class="data-editor-empty">No se pudo cargar la tabla.</div>');
  }
}

function dataEditorRequestedOrderColumn(tableName) {
  if (dataEditorViewState().loadedTableName === tableName) return dataEditorOrderColumn();
  const overview = (dataEditorSchema?.tables || []).find((table) => table.name === tableName);
  return overview?.primaryKey || overview?.definition?.primaryKey || "";
}

function hydrateDataEditorRows() {
  const view = dataEditorViewState();
  const primaryKey = dataEditorPrimaryKey();
  (view.table?.rows || []).forEach((row, index) => {
    const primaryValue = primaryKey ? row?.[primaryKey] : "";
    row._editorRowKey = primaryValue !== undefined && primaryValue !== null && String(primaryValue) !== ""
      ? `pk:${String(primaryValue)}`
      : `row:${index}`;
    row._editorOriginalPrimaryKey = primaryValue;
    row._editorKind = "persisted";
  });
}

function renderDataEditorGridStructure() {
  const view = dataEditorViewState();
  const columns = dataEditorColumns();
  if (!view.table || !columns.length) {
    setDataEditorGridHtml('<div class="data-editor-empty">La tabla no expone columnas persistentes.</div>');
    return;
  }
  const tableReason = dataEditorTableEditingReason();
  setDataEditorGridHtml(`
    ${tableReason ? `<div class="data-editor-grid-notice">${escapeHtml(tableReason)}</div>` : ""}
    <div class="data-editor-table-wrap" data-editor-viewport role="region" aria-label="Grilla editable de ${escapeHtml(view.table.name || "")}" tabindex="0">
      <table class="data-editor-table" role="grid" aria-rowcount="${escapeHtml((view.table.totalRows || 0) + 1)}">
        <colgroup>
          <col class="data-editor-select-col">
          ${columns.map((column) => `<col data-editor-col="${escapeHtml(column)}" style="${dataEditorColumnWidthStyle(column)}">`).join("")}
        </colgroup>
        <thead>
          <tr>
            <th class="data-editor-select-cell" scope="col">
              <input type="checkbox" data-editor-select-all aria-label="Seleccionar todas las filas">
            </th>
            ${columns.map(dataEditorHeaderCellHtml).join("")}
          </tr>
          <tr class="data-editor-filter-row">
            <th class="data-editor-select-cell">
              <button type="button" data-editor-clear-filters title="Limpiar todos los filtros">×</button>
            </th>
            ${columns.map(dataEditorFilterCellHtml).join("")}
          </tr>
        </thead>
        <tbody data-editor-virtual-body></tbody>
      </table>
      ${dataEditorRelationListsHtml(columns)}
    </div>
  `);
  view.virtualStart = -1;
  view.virtualEnd = -1;
}

function dataEditorHeaderCellHtml(column) {
  const view = dataEditorViewState();
  const meta = dataEditorColumnMeta(column);
  const isOrderColumn = column === dataEditorOrderColumn();
  const arrow = view.orderDir === "asc" ? "↑" : "↓";
  const badges = [
    meta.primaryKey ? '<span class="data-editor-column-badge">PK</span>' : "",
    meta.required && !meta.primaryKey ? '<span class="data-editor-required-mark" title="Campo obligatorio">*</span>' : "",
    dataEditorRelation(column) ? '<span class="data-editor-relation-mark" title="Relación configurada">↗</span>' : "",
    meta.derived || meta.readOnly ? '<span class="data-editor-derived-mark" title="Columna no editable">ƒ</span>' : ""
  ].join("");
  const label = `<span>${escapeHtml(column)}</span>${badges}`;
  return `
    <th scope="col" data-column="${escapeHtml(column)}" style="${dataEditorColumnWidthStyle(column)}">
      ${isOrderColumn
        ? `<button type="button" class="data-editor-sort-button" data-editor-sort-primary title="Alternar orden por ${escapeHtml(column)}">${label}<span class="data-editor-sort-direction">${arrow}</span></button>`
        : `<span class="data-editor-column-label">${label}</span>`}
      <span class="data-editor-resize-handle" data-editor-resize="${escapeHtml(column)}" title="Redimensionar columna"></span>
    </th>
  `;
}

function dataEditorFilterCellHtml(column) {
  return `
    <th style="${dataEditorColumnWidthStyle(column)}">
      <input
        type="search"
        class="data-editor-filter-input"
        data-editor-column-filter="${escapeHtml(column)}"
        value="${escapeHtml(dataEditorViewState().columnFilters[column] || "")}"
        placeholder="Filtrar…"
        aria-label="Filtrar ${escapeHtml(column)}"
        autocomplete="off"
      >
    </th>
  `;
}

function scheduleDataEditorVirtualRender() {
  const view = dataEditorViewState();
  if (view.virtualFrame) return;
  view.virtualFrame = window.requestAnimationFrame(() => {
    view.virtualFrame = 0;
    if (!view.editingCell) renderDataEditorVirtualRows();
  });
}

function renderDataEditorVirtualRows(force = false) {
  const view = dataEditorViewState();
  if (view.editingCell?.isConnected) return;
  const viewport = dataEditorElement("data-editor-body")?.querySelector("[data-editor-viewport]");
  const body = viewport?.querySelector("[data-editor-virtual-body]");
  if (!viewport || !body || !view.table) return;

  const rows = dataEditorGridRows();
  const headerHeight = 62;
  const contentScroll = Math.max(0, viewport.scrollTop - headerHeight);
  const visibleCount = Math.max(1, Math.ceil(viewport.clientHeight / DATA_EDITOR_ROW_HEIGHT));
  const start = Math.max(0, Math.floor(contentScroll / DATA_EDITOR_ROW_HEIGHT) - DATA_EDITOR_OVERSCAN);
  const end = Math.min(rows.length, start + visibleCount + (DATA_EDITOR_OVERSCAN * 2));
  if (!force && start === view.virtualStart && end === view.virtualEnd) return;
  view.virtualStart = start;
  view.virtualEnd = end;

  const columns = dataEditorColumns();
  const topHeight = start * DATA_EDITOR_ROW_HEIGHT;
  const bottomHeight = Math.max(0, (rows.length - end) * DATA_EDITOR_ROW_HEIGHT);
  body.innerHTML = `
    ${topHeight ? dataEditorSpacerRowHtml(topHeight, columns.length + 1) : ""}
    ${rows.slice(start, end).map((row, offset) => dataEditorRowHtml(row, start + offset, columns)).join("")}
    ${bottomHeight ? dataEditorSpacerRowHtml(bottomHeight, columns.length + 1) : ""}
  `;
  syncDataEditorSelectionUi();
}

function dataEditorSpacerRowHtml(height, colspan) {
  return `<tr class="data-editor-spacer-row" aria-hidden="true"><td colspan="${colspan}" style="height:${height}px"></td></tr>`;
}

function dataEditorGridRows() {
  const view = dataEditorViewState();
  const rows = [...(view.table?.rows || []), ...view.draftRows];
  if (view.table?.capabilities?.insert && dataEditorColumns().length) rows.push(dataEditorBlankRow());
  return rows;
}

function dataEditorBlankRow() {
  return {
    _editorRowKey: "blank:new-row",
    _editorKind: "blank"
  };
}

function dataEditorRowHtml(row, virtualIndex, columns) {
  const view = dataEditorViewState();
  const rowKey = row._editorRowKey;
  const isBlank = row._editorKind === "blank";
  const isDraft = row._editorKind === "draft";
  const selected = view.selectedRowKeys.has(rowKey);
  const rowState = view.rowStates.get(rowKey);
  const rowClasses = [
    selected ? "is-selected" : "",
    isBlank ? "is-blank-row" : "",
    isDraft ? "is-draft-row" : "",
    rowState?.status === "saving" ? "is-saving" : "",
    rowState?.status === "error" ? "has-error" : ""
  ].filter(Boolean).join(" ");
  const checkbox = isBlank
    ? '<span class="data-editor-new-row-mark" title="Fila vacía para agregar">＋</span>'
    : `<input type="checkbox" data-editor-row-select aria-label="Seleccionar fila" ${selected ? "checked" : ""}>`;
  const kindAttribute = isBlank
    ? 'data-editor-kind="blank"'
    : `data-editor-kind="${escapeHtml(row._editorKind || "persisted")}"`;
  return `
    <tr data-editor-row="${escapeHtml(rowKey)}" ${kindAttribute} class="${rowClasses}">
      <td class="data-editor-select-cell">
        ${checkbox}
        ${dataEditorRowStateHtml(rowState)}
      </td>
      ${columns.map((column, columnIndex) => dataEditorCellHtml(row, virtualIndex, column, columnIndex)).join("")}
    </tr>
  `;
}

function dataEditorRowStateHtml(state) {
  if (!state) return "";
  if (state.status === "saving") return '<span class="data-editor-row-state is-saving" title="Guardando fila">●</span>';
  if (state.status === "error") return `<span class="data-editor-row-state is-error" title="${escapeHtml(state.error || "Error")}">!</span>`;
  if (state.status === "incomplete") return `<span class="data-editor-row-state is-incomplete" title="${escapeHtml(state.error || "Fila incompleta")}">…</span>`;
  return "";
}

function dataEditorCellHtml(row, virtualIndex, column, columnIndex) {
  const view = dataEditorViewState();
  const rowKey = row._editorRowKey;
  const meta = dataEditorColumnMeta(column);
  const state = view.cellStates.get(dataEditorCellKey(rowKey, column));
  const value = dataEditorEffectiveValue(row, column);
  const writable = dataEditorCellIsWritable(row, column);
  const active = view.activeCell?.rowKey === rowKey && view.activeCell?.column === column;
  const classes = [
    "data-editor-cell",
    `is-${escapeHtml(meta.type || "text")}`,
    writable ? "is-writable" : "is-readonly",
    active ? "is-active" : "",
    state?.status === "saving" ? "is-saving" : "",
    state?.status === "saved" ? "is-saved" : "",
    state?.status === "error" || state?.status === "incomplete" ? "has-error" : ""
  ].filter(Boolean).join(" ");
  const reason = dataEditorCellReadOnlyReason(row, column);
  return `
    <td
      class="${classes}"
      data-editor-cell
      data-row-key="${escapeHtml(rowKey)}"
      data-column="${escapeHtml(column)}"
      data-virtual-index="${virtualIndex}"
      data-column-index="${columnIndex}"
      tabindex="${active || (!view.activeCell && virtualIndex === 0 && columnIndex === 0) ? "0" : "-1"}"
      aria-readonly="${writable ? "false" : "true"}"
      aria-invalid="${state?.status === "error" || state?.status === "incomplete" ? "true" : "false"}"
      title="${escapeHtml(state?.error || reason || dataEditorCellTitle(column, value))}"
      style="${dataEditorColumnWidthStyle(column)}"
    >
      <span class="data-editor-cell-value">${dataEditorDisplayValue(column, value)}</span>
      ${dataEditorCellStateHtml(state)}
    </td>
  `;
}

function dataEditorCellStateHtml(state) {
  if (!state) return "";
  if (state.status === "saving") return '<span class="data-editor-cell-state is-saving" title="Guardando">●</span>';
  if (state.status === "saved") return '<span class="data-editor-cell-state is-saved" title="Guardado">✓</span>';
  if (state.status === "error" || state.status === "incomplete") {
    return `<span class="data-editor-cell-state is-error" title="${escapeHtml(state.error || "Error")}">!</span>`;
  }
  return "";
}

function dataEditorEffectiveValue(row, column) {
  const state = dataEditorViewState().cellStates.get(dataEditorCellKey(row._editorRowKey, column));
  if (state && Object.prototype.hasOwnProperty.call(state, "value")) return state.value;
  return row[column] ?? "";
}

function dataEditorDisplayValue(column, rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return '<span class="data-editor-null">—</span>';
  }
  const meta = dataEditorColumnMeta(column);
  const relation = dataEditorRelation(column);
  if (relation) {
    const option = (relation.options || []).find((item) => String(item.value) === String(rawValue));
    if (option?.label) {
      return `<span class="data-editor-related-value"><b>${escapeHtml(rawValue)}</b><span>·</span>${escapeHtml(option.label)}</span>`;
    }
  }
  if (meta.type === "money") {
    try {
      return `<span class="data-editor-money-value">${escapeHtml(ErpMoney.format(rawValue))}</span>`;
    } catch (_error) {
      return escapeHtml(rawValue);
    }
  }
  if (meta.type === "boolean") {
    return `<span class="data-editor-boolean-value">${dataEditorBooleanValue(rawValue) ? "Sí" : "No"}</span>`;
  }
  if (meta.type === "date" && /^\d{4}-\d{2}-\d{2}/.test(String(rawValue))) {
    return escapeHtml(formatDate(String(rawValue).slice(0, 10)));
  }
  return escapeHtml(rawValue);
}

function dataEditorCellTitle(column, rawValue) {
  const value = rawValue === null || rawValue === undefined ? "" : String(rawValue);
  const relation = dataEditorRelation(column);
  const related = relation?.options?.find((option) => String(option.value) === value);
  return related?.label ? `${value} · ${related.label}` : value;
}

function dataEditorColumns() {
  const table = dataEditorViewState().table;
  const schemaColumns = (table?.schema?.columns || []).map((column) =>
    typeof column === "string" ? column : column.name || column.key
  ).filter(Boolean);
  if (schemaColumns.length) return schemaColumns;
  return (table?.headers || []).map((column) =>
    typeof column === "string" ? column : column.name || column.key
  ).filter((column) => column && !String(column).startsWith("_"));
}

function dataEditorPrimaryKey() {
  const view = dataEditorViewState();
  const candidate = view.table?.schema?.primaryKey || view.table?.definition?.primaryKey || "";
  return dataEditorColumns().find((column) => normalizeDataEditorColumnName(column) === normalizeDataEditorColumnName(candidate))
    || "";
}

function dataEditorOrderColumn() {
  const primaryKey = dataEditorPrimaryKey();
  if (primaryKey) return primaryKey;
  const configured = dataEditorViewState().table?.definition?.orderBy || "";
  return dataEditorColumns().find((column) => normalizeDataEditorColumnName(column) === normalizeDataEditorColumnName(configured))
    || dataEditorColumns()[0]
    || "";
}

function normalizeDataEditorColumnName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function dataEditorColumnMeta(column) {
  const table = dataEditorViewState().table;
  return (table?.schema?.columns || []).find((item) => (item.name || item.key) === column)
    || {
      name: column,
      type: isDataEditorMoneyColumn(table?.name || "", column) ? "money" : "text",
      primaryKey: column === table?.schema?.primaryKey,
      required: false
    };
}

function dataEditorRelation(column) {
  const table = dataEditorViewState().table;
  const tableRelation = table?.relations?.[column];
  const schemaRelation = dataEditorColumnMeta(column)?.relation;
  if (!tableRelation && !schemaRelation) return null;
  return {
    ...(schemaRelation || {}),
    ...(tableRelation || {}),
    options: tableRelation?.options || schemaRelation?.options || []
  };
}

function dataEditorRelationListsHtml(columns) {
  return columns.map((column) => {
    const relation = dataEditorRelation(column);
    if (!relation?.options?.length) return "";
    return `
      <datalist id="${dataEditorRelationListId(column)}">
        ${relation.options.map((option) => (
          `<option value="${escapeHtml(option.value)}">${escapeHtml(`${option.value} · ${option.label || ""}`)}</option>`
        )).join("")}
      </datalist>
    `;
  }).join("");
}

function dataEditorRelationListId(column) {
  return `data-editor-relation-${String(column).replace(/[^a-z0-9_-]/gi, "-")}`;
}

function isDataEditorMoneyColumn(tableName, column) {
  return Boolean(globalThis.ErpMoneyColumns?.isMoneyColumn(tableName, column));
}

function dataEditorColumnWidthStyle(column) {
  const view = dataEditorViewState();
  const width = view.columnWidths[`${view.loadedTableName}:${column}`];
  return width ? `width:${width}px;min-width:${width}px;max-width:${width}px` : "";
}

function dataEditorTableEditingReason() {
  const view = dataEditorViewState();
  if (!dataEditorPrimaryKey()) {
    const orderColumn = dataEditorOrderColumn();
    return orderColumn
      ? `La tabla no declara una clave primaria válida. Se muestra ordenada por ${orderColumn}; la persistencia localizada está deshabilitada.`
      : "La tabla no declara una clave primaria válida y no puede editarse.";
  }
  const capabilities = view.table?.capabilities || {};
  if (!capabilities.insert && !capabilities.update && !capabilities.delete) {
    return capabilities.reason || "La tabla no expone operaciones administrativas.";
  }
  return "";
}

function dataEditorCellReadOnlyReason(row, column) {
  const meta = dataEditorColumnMeta(column);
  if (!dataEditorPrimaryKey()) return "No se puede identificar la fila porque la tabla no tiene una PK válida.";
  if (meta.derived) return meta.reason || "Columna derivada: su valor se calcula y no se persiste directamente.";
  if (meta.readOnly) return meta.reason || "El backend identifica esta columna como no persistente.";
  if ((row._editorKind === "draft" || row._editorKind === "blank") && meta.primaryKey && meta.generated) {
    return "La clave se genera automáticamente al crear la fila.";
  }
  const capability = row._editorKind === "persisted"
    ? dataEditorViewState().table?.capabilities?.update
    : dataEditorViewState().table?.capabilities?.insert;
  if (!capability) return dataEditorViewState().table?.capabilities?.reason || "La operación no está habilitada.";
  return "";
}

function dataEditorCellIsWritable(row, column) {
  return !dataEditorCellReadOnlyReason(row, column);
}

function handleDataEditorGridClick(event) {
  if (event.target.closest("[data-editor-sort-primary]")) {
    toggleDataEditorPrimaryOrder();
    return;
  }
  if (event.target.closest("[data-editor-clear-filters]")) {
    clearDataEditorSearchAndFilters();
    return;
  }
  const cell = event.target.closest("[data-editor-cell]");
  if (!cell || event.target.closest("input, select, button")) return;
  const active = dataEditorViewState().activeCell;
  const wasActive = active?.rowKey === cell.dataset.rowKey && active?.column === cell.dataset.column;
  window.getSelection?.()?.removeAllRanges();
  activateDataEditorCell(cell);
  if (wasActive) startDataEditorCellEdit(cell);
}

function handleDataEditorGridDoubleClick(event) {
  const cell = event.target.closest("[data-editor-cell]");
  if (!cell || event.target.closest("input, select, button")) return;
  event.preventDefault();
  window.getSelection?.()?.removeAllRanges();
  activateDataEditorCell(cell);
  startDataEditorCellEdit(cell);
}

function handleDataEditorGridInput(event) {
  const filter = event.target.closest("[data-editor-column-filter]");
  if (!filter) return;
  scheduleDataEditorColumnFilters();
}

function handleDataEditorGridChange(event) {
  if (event.target.matches("[data-editor-select-all]")) {
    toggleAllDataEditorRows(event.target.checked);
    return;
  }
  const rowSelect = event.target.closest("[data-editor-row-select]");
  if (rowSelect) {
    toggleDataEditorRowSelection(rowSelect.closest("[data-editor-row]")?.dataset.editorRow, rowSelect.checked);
    return;
  }
  const editor = event.target.closest("[data-editor-cell-editor]");
  if (editor?.type === "checkbox") finishDataEditorCellEdit(editor, { commit: true, focus: true });
}

function handleDataEditorGridKeyDown(event) {
  const editor = event.target.closest("[data-editor-cell-editor]");
  if (editor) {
    handleDataEditorCellEditorKeyDown(event, editor);
    return;
  }
  const filter = event.target.closest("[data-editor-column-filter]");
  if (filter && event.key === "Enter") {
    event.preventDefault();
    applyDataEditorColumnFiltersNow();
    return;
  }
  const cell = event.target.closest("[data-editor-cell]");
  if (!cell) {
    if (event.key === "Delete") openDataEditorDeleteDialog();
    return;
  }
  if (event.key === "Delete" && dataEditorViewState().selectedRowKeys.size) {
    event.preventDefault();
    openDataEditorDeleteDialog();
    return;
  }
  if (event.key === "Enter" || event.key === "F2") {
    event.preventDefault();
    startDataEditorCellEdit(cell);
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    moveDataEditorCellFocus(cell, event.shiftKey ? -1 : 1);
    return;
  }
  const arrows = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1]
  };
  if (arrows[event.key]) {
    event.preventDefault();
    moveDataEditorCellFocusByGrid(cell, arrows[event.key][0], arrows[event.key][1]);
    return;
  }
  if (
    event.key.length === 1
    && !event.ctrlKey
    && !event.metaKey
    && !event.altKey
    && cell.getAttribute("aria-readonly") === "false"
  ) {
    event.preventDefault();
    startDataEditorCellEdit(cell);
    appendDataEditorTypedCharacter(event.key);
  }
}

function handleDataEditorGridPaste(event) {
  if (event.target.closest("[data-editor-cell-editor]")) return;
  const cell = event.target.closest("[data-editor-cell]")
    || dataEditorActiveCellElement();
  if (!cell || cell.getAttribute("aria-readonly") === "true") return;
  const text = event.clipboardData?.getData("text/plain");
  if (text === undefined) return;
  event.preventDefault();
  startDataEditorCellEdit(cell, text.replace(/\r?\n$/, ""));
}

function activateDataEditorCell(cell) {
  if (!cell) return;
  const view = dataEditorViewState();
  view.activeCell = { rowKey: cell.dataset.rowKey, column: cell.dataset.column };
  dataEditorElement("data-editor-body")?.querySelectorAll("[data-editor-cell]").forEach((candidate) => {
    candidate.tabIndex = candidate === cell ? 0 : -1;
    candidate.classList.toggle("is-active", candidate === cell);
  });
  cell.focus();
}

function dataEditorActiveCellElement() {
  const active = dataEditorViewState().activeCell;
  if (!active) return null;
  return dataEditorElement("data-editor-body")?.querySelector(
    `[data-editor-cell][data-row-key="${CSS.escape(active.rowKey)}"][data-column="${CSS.escape(active.column)}"]`
  );
}

function startDataEditorCellEdit(cell, initialText) {
  if (!cell) return;
  const view = dataEditorViewState();
  let rowKey = cell.dataset.rowKey;
  const column = cell.dataset.column;
  if (cell.getAttribute("aria-readonly") === "true") {
    const row = rowKey === "blank:new-row" ? dataEditorBlankRow() : dataEditorRowByKey(rowKey);
    setDataEditorStatus(dataEditorCellReadOnlyReason(row || {}, column), "error");
    return;
  }
  if (rowKey === "blank:new-row") {
    rowKey = promoteDataEditorBlankRow();
    cell = dataEditorElement("data-editor-body")?.querySelector(
      `[data-editor-cell][data-row-key="${CSS.escape(rowKey)}"][data-column="${CSS.escape(column)}"]`
    );
  }
  if (!cell || cell.getAttribute("aria-readonly") === "true") {
    const row = dataEditorRowByKey(rowKey);
    setDataEditorStatus(dataEditorCellReadOnlyReason(row || {}, column), "error");
    return;
  }
  if (view.editingCell?.dataset.rowKey === rowKey && view.editingCell?.dataset.column === column) {
    view.editingCell.focus();
    return;
  }
  if (view.editingCell) {
    finishDataEditorCellEdit(view.editingCell, {
      commit: true,
      focus: false,
      finalizeRow: view.editingCell.dataset.rowKey !== rowKey
    });
  }
  const row = dataEditorRowByKey(rowKey);
  if (!row) return;

  activateDataEditorCell(cell);
  const meta = dataEditorColumnMeta(column);
  const relation = dataEditorRelation(column);
  const rawValue = dataEditorEffectiveValue(row, column);
  const editor = createDataEditorCellControl(meta, relation, rawValue, column);
  editor.dataset.editorCellEditor = "";
  editor.dataset.rowKey = rowKey;
  editor.dataset.column = column;
  cell.replaceChildren(editor);
  cell.classList.add("is-editing");
  view.editingCell = editor;

  if (initialText !== undefined && editor.type !== "checkbox") editor.value = initialText;
  editor.focus();
  if (initialText === undefined && editor.type !== "checkbox") {
    try {
      const end = String(editor.value ?? "").length;
      editor.setSelectionRange(end, end);
    } catch {
      // Algunos controles nativos (fecha y número) no exponen selección de texto.
    }
  }
  editor.addEventListener("blur", (blurEvent) => {
    window.setTimeout(() => {
      if (view.editingCell !== editor) return;
      const nextRow = blurEvent.relatedTarget?.closest?.("[data-editor-row]")?.dataset.editorRow || "";
      finishDataEditorCellEdit(editor, {
        commit: true,
        focus: false,
        finalizeRow: nextRow !== rowKey
      });
    }, 0);
  }, { once: true });
}

function createDataEditorCellControl(meta, relation, rawValue, column) {
  if (meta.type === "boolean") {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = dataEditorBooleanValue(rawValue);
    checkbox.className = "data-editor-boolean-editor";
    return checkbox;
  }
  if (Array.isArray(meta.options)) {
    const select = document.createElement("select");
    meta.options.forEach((option) => {
      const node = document.createElement("option");
      node.value = String(option.value ?? option);
      node.textContent = String(option.label ?? option.value ?? option);
      select.append(node);
    });
    select.value = String(rawValue ?? "");
    return select;
  }
  const input = document.createElement("input");
  if (meta.type === "date") input.type = "date";
  else if (meta.type === "number") {
    input.type = "number";
    input.step = "any";
  } else {
    input.type = "text";
  }
  if (meta.type === "money") {
    input.inputMode = "decimal";
    const parsed = parseMoneyInput(rawValue, { allowEmpty: true });
    input.value = parsed.ok && !parsed.empty
      ? formatMoneyInput(parsed.amount)
      : String(rawValue ?? "");
  } else {
    input.value = rawValue === null || rawValue === undefined ? "" : String(rawValue);
  }
  if (relation?.options?.length) input.setAttribute("list", dataEditorRelationListId(column));
  if (meta.required) input.required = true;
  return input;
}

function appendDataEditorTypedCharacter(character) {
  const editor = dataEditorViewState().editingCell;
  if (
    !editor
    || editor.type === "checkbox"
    || editor.type === "date"
    || editor.tagName === "SELECT"
  ) return;
  const value = String(editor.value ?? "");
  const start = Number.isInteger(editor.selectionStart) ? editor.selectionStart : value.length;
  const end = Number.isInteger(editor.selectionEnd) ? editor.selectionEnd : start;
  const nextCaret = start + character.length;
  editor.value = `${value.slice(0, start)}${character}${value.slice(end)}`;
  try {
    editor.setSelectionRange(nextCaret, nextCaret);
  } catch {
    // Los controles numéricos no exponen selección, pero conservan el valor agregado.
  }
}

function dataEditorBooleanValue(rawValue) {
  return rawValue === true || rawValue === 1 || /^(1|true|si|sí)$/i.test(String(rawValue));
}

function handleDataEditorCellEditorKeyDown(event, editor) {
  const row = dataEditorRowByKey(editor.dataset.rowKey);
  const isLast = row ? dataEditorIsLastEditableColumn(row, editor.dataset.column) : false;
  if (event.key === "Escape") {
    event.preventDefault();
    finishDataEditorCellEdit(editor, { commit: false, focus: true });
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    finishDataEditorCellEdit(editor, { commit: true, focus: true, finalizeRow: isLast });
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    const cell = editor.closest("[data-editor-cell]");
    const direction = event.shiftKey ? -1 : 1;
    const next = dataEditorAdjacentEditableTarget(cell, direction);
    const nextRowKey = next?.rowKey || "";
    const rowKey = editor.dataset.rowKey;
    finishDataEditorCellEdit(editor, {
      commit: true,
      focus: false,
      finalizeRow: Boolean(nextRowKey && nextRowKey !== rowKey)
    });
    window.setTimeout(() => {
      if (!next) return;
      ensureDataEditorRowVisible(next.rowIndex);
      window.setTimeout(() => {
        const target = dataEditorElement("data-editor-body")?.querySelector(
          `[data-editor-cell][data-row-key="${CSS.escape(next.rowKey)}"][data-column="${CSS.escape(next.column)}"]`
        );
        if (target) {
          activateDataEditorCell(target);
          startDataEditorCellEdit(target);
        }
      }, 0);
    }, 0);
  }
}

function finishDataEditorCellEdit(editor, options = {}) {
  const view = dataEditorViewState();
  if (!editor || view.editingCell !== editor) return;
  const rowKey = editor.dataset.rowKey;
  const column = editor.dataset.column;
  const row = dataEditorRowByKey(rowKey);
  const rawValue = editor.type === "checkbox" ? editor.checked : editor.value;
  view.editingCell = null;

  if (options.commit && row) {
    const meta = dataEditorColumnMeta(column);
    const parsed = normalizeDataEditorCellValue(meta, rawValue);
    if (!parsed.ok) {
      setDataEditorCellState(rowKey, column, {
        status: "error",
        value: rawValue,
        error: parsed.error
      });
      setDataEditorStatus(parsed.error, "error");
    } else if (row._editorKind === "persisted") {
      if (dataEditorValuesEquivalent(meta, parsed.value, row[column])) {
        clearDataEditorCellState(rowKey, column);
        setDataEditorSummary();
      } else {
        queueDataEditorCellSave(row, column, parsed.value);
      }
    } else {
      row[column] = parsed.value;
      clearDataEditorCellState(rowKey, column);
      if (options.finalizeRow) persistDataEditorDraftRow(rowKey);
      else markDataEditorDraftIncomplete(rowKey);
    }
  } else if (row?._editorKind === "draft" && dataEditorDraftIsEmpty(row)) {
    view.draftRows = view.draftRows.filter((candidate) => candidate._editorRowKey !== rowKey);
    clearDataEditorStatesForRow(rowKey);
    view.activeCell = { rowKey: "blank:new-row", column };
  }
  renderDataEditorVirtualRows(true);
  const focusRowKey = dataEditorRowByKey(rowKey) ? rowKey : "blank:new-row";
  if (options.focus !== false) window.setTimeout(() => focusDataEditorCell(focusRowKey, column), 0);
}

function normalizeDataEditorCellValue(meta, rawValue) {
  if (meta.type === "boolean") return { ok: true, value: Boolean(rawValue) };
  const text = String(rawValue ?? "").trim();
  if (!text) {
    return meta.required
      ? { ok: false, error: "Este campo es obligatorio." }
      : { ok: true, value: "" };
  }
  if (meta.type === "money") {
    const parsed = parseMoneyInput(rawValue, { allowEmpty: true });
    return parsed.ok
      ? { ok: true, value: parsed.empty ? "" : Number(parsed.amount).toFixed(2) }
      : { ok: false, error: "Ingresá un importe válido con hasta dos decimales." };
  }
  if (meta.type === "number") {
    return Number.isFinite(Number(text))
      ? { ok: true, value: Number(text) }
      : { ok: false, error: "Ingresá un número válido." };
  }
  if (meta.type === "date") {
    return /^\d{4}-\d{2}-\d{2}$/.test(text)
      ? { ok: true, value: text }
      : { ok: false, error: "Ingresá una fecha válida." };
  }
  return { ok: true, value: String(rawValue ?? "") };
}

function dataEditorValuesEquivalent(meta, left, right) {
  const leftEmpty = left === null || left === undefined || left === "";
  const rightEmpty = right === null || right === undefined || right === "";
  if (leftEmpty || rightEmpty) return leftEmpty && rightEmpty;
  if (meta.type === "boolean") return dataEditorBooleanValue(left) === dataEditorBooleanValue(right);
  if (meta.type === "number" || meta.type === "money") {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber === rightNumber;
  }
  return String(left) === String(right);
}

function dataEditorDraftIsEmpty(row) {
  return dataEditorColumns().every((column) => {
    const meta = dataEditorColumnMeta(column);
    if (meta.primaryKey && meta.generated) return true;
    return row[column] === null
      || row[column] === undefined
      || String(row[column]).trim() === "";
  });
}

function promoteDataEditorBlankRow(initialValues = {}) {
  const view = dataEditorViewState();
  const row = Object.fromEntries(dataEditorColumns().map((column) => [column, initialValues[column] ?? ""]));
  row._editorRowKey = `draft:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  row._editorKind = "draft";
  view.draftRows.push(row);
  view.virtualStart = -1;
  view.virtualEnd = -1;
  renderDataEditorVirtualRows(true);
  return row._editorRowKey;
}

function addDataEditorRow(_viewId = "primary", initialValues = {}) {
  const rowKey = promoteDataEditorBlankRow(initialValues);
  markDataEditorDraftIncomplete(rowKey);
  scrollDataEditorToBottom();
  return rowKey;
}

function markDataEditorDraftIncomplete(rowKey) {
  const row = dataEditorRowByKey(rowKey);
  if (!row || row._editorKind !== "draft") return;
  const errors = validateDataEditorDraftRow(row, { mark: false });
  if (!errors.length) {
    dataEditorViewState().rowStates.delete(rowKey);
    return;
  }
  dataEditorViewState().rowStates.set(rowKey, {
    status: "incomplete",
    error: `Faltan o son inválidos: ${errors.map((item) => item.column).join(", ")}`
  });
}

async function persistDataEditorDraftRow(rowKey) {
  const view = dataEditorViewState();
  const row = dataEditorRowByKey(rowKey);
  if (!row || row._editorKind !== "draft" || view.rowStates.get(rowKey)?.status === "saving") return;
  const errors = validateDataEditorDraftRow(row, { mark: true });
  if (errors.length) {
    view.rowStates.set(rowKey, {
      status: "incomplete",
      error: `Completá: ${errors.map((item) => item.column).join(", ")}`
    });
    renderDataEditorVirtualRows(true);
    return;
  }

  view.rowStates.set(rowKey, { status: "saving" });
  renderDataEditorVirtualRows(true);
  const cleanRow = dataEditorSerializableRow(row);
  view.saveQueue = view.saveQueue.then(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/admin/tables/${encodeURIComponent(view.table.name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: [],
          newRows: [cleanRow],
          deletedIds: [],
          all: true,
          search: view.search,
          filters: dataEditorActiveFilters(),
          orderBy: dataEditorOrderColumn(),
          orderDir: view.orderDir,
          tableVersion: view.table.version
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw dataEditorRequestError(payload, response.status);
      applyDataEditorMutationTable(payload);
      view.draftRows = view.draftRows.filter((candidate) => candidate._editorRowKey !== rowKey);
      clearDataEditorStatesForRow(rowKey);
      sortDataEditorRows();
      renderDataEditorGridStructure();
      resetDataEditorScroll();
      renderDataEditorVirtualRows(true);
      setDataEditorSummary();
    } catch (error) {
      view.rowStates.set(rowKey, { status: "error", error: error.message });
      if (error.field) {
        setDataEditorCellState(rowKey, error.field, {
          status: "error",
          value: row[error.field] ?? "",
          error: error.message
        });
      }
      renderDataEditorVirtualRows(true);
    }
  });
  return view.saveQueue;
}

function validateDataEditorDraftRow(row, options = {}) {
  const errors = [];
  for (const column of dataEditorColumns()) {
    const meta = dataEditorColumnMeta(column);
    if (meta.primaryKey && meta.generated) continue;
    const parsed = normalizeDataEditorCellValue(meta, row[column]);
    const relation = dataEditorRelation(column);
    let error = parsed.ok ? "" : parsed.error;
    if (
      !error
      && relation
      && String(parsed.value ?? "").trim()
      && !relation.truncated
      && !(relation.options || []).some((option) => String(option.value) === String(parsed.value))
    ) {
      error = `La referencia no existe en ${relation.table}.`;
    }
    if (!error) {
      if (options.mark) clearDataEditorCellState(row._editorRowKey, column);
      continue;
    }
    errors.push({ column, error });
    if (options.mark) {
      setDataEditorCellState(row._editorRowKey, column, {
        status: "incomplete",
        value: row[column] ?? "",
        error
      });
    }
  }
  return errors;
}

function queueDataEditorCellSave(row, column, value) {
  const view = dataEditorViewState();
  const rowKey = row._editorRowKey;
  const key = dataEditorCellKey(rowKey, column);
  const previous = view.cellStates.get(key);
  const revision = (previous?.revision || 0) + 1;
  setDataEditorCellState(rowKey, column, { status: "saving", value, error: "", revision });
  renderDataEditorVirtualRows(true);

  view.saveQueue = view.saveQueue.then(() => persistDataEditorCell(row, column, value, revision));
  return view.saveQueue;
}

async function persistDataEditorCell(row, column, value, revision) {
  const view = dataEditorViewState();
  if (!row || row._editorKind !== "persisted") return;
  const rowKey = row._editorRowKey;
  const primaryKeyColumn = dataEditorPrimaryKey();
  const identifyingPrimaryKey = row._editorOriginalPrimaryKey;
  const originalValue = row[column] ?? "";

  try {
    const response = await fetch(
      `${API_BASE_URL}/api/admin/tables/${encodeURIComponent(view.table.name)}/cell`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          primaryKey: identifyingPrimaryKey,
          column,
          value,
          originalValue,
          tableVersion: view.table.version
        })
      }
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw dataEditorRequestError(payload, response.status);
    const savedRowKey = applyDataEditorSavedRow(row, payload.row || {}, primaryKeyColumn);
    const currentState = view.cellStates.get(dataEditorCellKey(savedRowKey, column));
    if (payload.tableVersion) view.table.version = payload.tableVersion;
    if (currentState?.revision === revision) {
      setDataEditorCellState(savedRowKey, column, { status: "saved", revision });
      window.setTimeout(
        () => clearDataEditorSavedState(savedRowKey, column, revision),
        DATA_EDITOR_SAVED_INDICATOR_MS
      );
    }
    if (column === primaryKeyColumn) sortDataEditorRows();
    renderDataEditorVirtualRows(true);
    setDataEditorSummary();
  } catch (error) {
    const currentRowKey = row._editorRowKey;
    const currentState = view.cellStates.get(dataEditorCellKey(currentRowKey, column));
    if (currentState?.revision === revision) {
      setDataEditorCellState(currentRowKey, column, {
        status: "error",
        value,
        error: error.message,
        revision
      });
      renderDataEditorVirtualRows(true);
      setDataEditorStatus(error.message, "error");
    }
  }
}

function applyDataEditorSavedRow(target, savedRow, primaryKeyColumn) {
  const previousRowKey = target._editorRowKey;
  for (const column of dataEditorColumns()) {
    if (Object.prototype.hasOwnProperty.call(savedRow, column)) target[column] = savedRow[column];
  }
  target._editorKind = "persisted";
  target._editorOriginalPrimaryKey = target[primaryKeyColumn];
  const primaryValue = target[primaryKeyColumn];
  const nextRowKey = primaryValue !== undefined && primaryValue !== null && String(primaryValue) !== ""
    ? `pk:${String(primaryValue)}`
    : previousRowKey;
  if (nextRowKey !== previousRowKey) {
    target._editorRowKey = nextRowKey;
    rekeyDataEditorRowState(previousRowKey, nextRowKey);
  }
  return target._editorRowKey;
}

function rekeyDataEditorRowState(previousRowKey, nextRowKey) {
  const view = dataEditorViewState();
  const previousPrefix = `${previousRowKey}\u001f`;
  for (const [key, state] of [...view.cellStates.entries()]) {
    if (!key.startsWith(previousPrefix)) continue;
    view.cellStates.delete(key);
    view.cellStates.set(`${nextRowKey}\u001f${key.slice(previousPrefix.length)}`, state);
  }
  if (view.rowStates.has(previousRowKey)) {
    const rowState = view.rowStates.get(previousRowKey);
    view.rowStates.delete(previousRowKey);
    view.rowStates.set(nextRowKey, rowState);
  }
  if (view.selectedRowKeys.delete(previousRowKey)) view.selectedRowKeys.add(nextRowKey);
  if (view.activeCell?.rowKey === previousRowKey) view.activeCell.rowKey = nextRowKey;

  const grid = dataEditorElement("data-editor-body");
  grid?.querySelectorAll(`[data-row-key="${CSS.escape(previousRowKey)}"]`).forEach((element) => {
    element.dataset.rowKey = nextRowKey;
  });
  const renderedRow = grid?.querySelector(`[data-editor-row="${CSS.escape(previousRowKey)}"]`);
  if (renderedRow) renderedRow.dataset.editorRow = nextRowKey;
}

function dataEditorRequestError(payload, status) {
  const error = new Error(payload.error || `HTTP ${status}`);
  error.code = payload.code || "";
  error.field = payload.field || "";
  error.payload = payload;
  return error;
}

function applyDataEditorMutationTable(payload) {
  const view = dataEditorViewState();
  if (payload.table) {
    view.table = payload.table;
    hydrateDataEditorRows();
  }
  if (payload.tableVersion) view.table.version = payload.tableVersion;
}

function setDataEditorCellState(rowKey, column, state) {
  dataEditorViewState().cellStates.set(dataEditorCellKey(rowKey, column), state);
}

function clearDataEditorCellState(rowKey, column) {
  dataEditorViewState().cellStates.delete(dataEditorCellKey(rowKey, column));
}

function clearDataEditorSavedState(rowKey, column, revision) {
  const view = dataEditorViewState();
  const key = dataEditorCellKey(rowKey, column);
  const state = view.cellStates.get(key);
  if (state?.status !== "saved" || state.revision !== revision) return;
  view.cellStates.delete(key);
  renderDataEditorVirtualRows(true);
}

function clearDataEditorStatesForRow(rowKey) {
  const view = dataEditorViewState();
  for (const key of view.cellStates.keys()) {
    if (key.startsWith(`${rowKey}\u001f`)) view.cellStates.delete(key);
  }
  view.rowStates.delete(rowKey);
  view.selectedRowKeys.delete(rowKey);
}

function dataEditorCellKey(rowKey, column) {
  return `${rowKey}\u001f${column}`;
}

function dataEditorRowByKey(rowKey) {
  const view = dataEditorViewState();
  return [...(view.table?.rows || []), ...view.draftRows].find((row) => row._editorRowKey === rowKey);
}

function dataEditorSerializableRow(row) {
  return Object.fromEntries(dataEditorColumns().map((column) => [column, row?.[column] ?? ""]));
}

function dataEditorIsLastEditableColumn(row, column) {
  const editable = dataEditorColumns().filter((candidate) => dataEditorCellIsWritable(row, candidate));
  return editable[editable.length - 1] === column;
}

function dataEditorAdjacentEditableTarget(cell, direction) {
  const rows = dataEditorGridRows();
  const columns = dataEditorColumns();
  if (!rows.length || !columns.length) return null;
  let linearIndex = (Number(cell.dataset.virtualIndex) * columns.length) + Number(cell.dataset.columnIndex);
  const lastIndex = (rows.length * columns.length) - 1;
  while (true) {
    linearIndex += direction;
    if (linearIndex < 0 || linearIndex > lastIndex) return null;
    const rowIndex = Math.floor(linearIndex / columns.length);
    const columnIndex = linearIndex % columns.length;
    const row = rows[rowIndex];
    const column = columns[columnIndex];
    if (!dataEditorCellIsWritable(row, column)) continue;
    return {
      rowKey: row._editorRowKey,
      column,
      rowIndex,
      columnIndex
    };
  }
}

function moveDataEditorCellFocus(cell, direction) {
  const next = dataEditorAdjacentEditableTarget(cell, direction);
  if (!next) return;
  ensureDataEditorRowVisible(next.rowIndex);
  window.setTimeout(() => {
    const target = dataEditorElement("data-editor-body")?.querySelector(
      `[data-editor-cell][data-row-key="${CSS.escape(next.rowKey)}"][data-column="${CSS.escape(next.column)}"]`
    );
    if (target) {
      activateDataEditorCell(target);
      startDataEditorCellEdit(target);
    }
  }, 0);
}

function moveDataEditorCellFocusByGrid(cell, rowDelta, columnDelta) {
  const rowIndex = Number(cell.dataset.virtualIndex) + rowDelta;
  const columnIndex = Number(cell.dataset.columnIndex) + columnDelta;
  const rows = dataEditorGridRows();
  if (rowIndex < 0 || rowIndex >= rows.length || columnIndex < 0 || columnIndex >= dataEditorColumns().length) return;
  ensureDataEditorRowVisible(rowIndex);
  window.setTimeout(() => {
    const target = dataEditorElement("data-editor-body")?.querySelector(
      `[data-editor-cell][data-virtual-index="${rowIndex}"][data-column-index="${columnIndex}"]`
    );
    if (target) activateDataEditorCell(target);
  }, 0);
}

function focusDataEditorCell(rowKey, column) {
  const cell = dataEditorElement("data-editor-body")?.querySelector(
    `[data-editor-cell][data-row-key="${CSS.escape(rowKey)}"][data-column="${CSS.escape(column)}"]`
  );
  if (cell) activateDataEditorCell(cell);
}

function ensureDataEditorRowVisible(index) {
  const viewport = dataEditorElement("data-editor-body")?.querySelector("[data-editor-viewport]");
  if (!viewport) return;
  const top = 62 + (index * DATA_EDITOR_ROW_HEIGHT);
  const bottom = top + DATA_EDITOR_ROW_HEIGHT;
  if (top < viewport.scrollTop + 62) viewport.scrollTop = Math.max(0, top - 62);
  else if (bottom > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = bottom - viewport.clientHeight;
  renderDataEditorVirtualRows(true);
}

function resetDataEditorScroll() {
  const viewport = dataEditorElement("data-editor-body")?.querySelector("[data-editor-viewport]");
  if (viewport) viewport.scrollTop = 0;
}

function scrollDataEditorToBottom() {
  const viewport = dataEditorElement("data-editor-body")?.querySelector("[data-editor-viewport]");
  if (!viewport) return;
  window.requestAnimationFrame(() => {
    viewport.scrollTop = viewport.scrollHeight;
    renderDataEditorVirtualRows(true);
  });
}

function toggleDataEditorPrimaryOrder() {
  const view = dataEditorViewState();
  view.orderDir = view.orderDir === "desc" ? "asc" : "desc";
  sortDataEditorRows();
  resetDataEditorScroll();
  renderDataEditorGridStructure();
  renderDataEditorVirtualRows(true);
  setDataEditorSummary();
  loadDataEditorTable("primary", { resetScroll: true });
}

function sortDataEditorRows() {
  const view = dataEditorViewState();
  const column = dataEditorOrderColumn();
  if (!column || !view.table?.rows) return;
  const direction = view.orderDir === "asc" ? 1 : -1;
  const numeric = view.table.rows.every((row) => {
    const value = String(row?.[column] ?? "").trim();
    return !value || Number.isFinite(Number(value));
  });
  view.table.rows.sort((left, right) => {
    const leftValue = left?.[column] ?? "";
    const rightValue = right?.[column] ?? "";
    if (numeric) return (Number(leftValue) - Number(rightValue)) * direction;
    return String(leftValue).localeCompare(String(rightValue), "es", { numeric: true }) * direction;
  });
}

function scheduleDataEditorSearch() {
  const view = dataEditorViewState();
  window.clearTimeout(view.searchTimer);
  view.searchTimer = window.setTimeout(applyDataEditorSearchNow, DATA_EDITOR_SEARCH_DELAY);
}

function applyDataEditorSearchNow() {
  const view = dataEditorViewState();
  window.clearTimeout(view.searchTimer);
  view.search = String(dataEditorElement("data-editor-search")?.value || "").trim();
  loadDataEditorTable("primary", { resetScroll: true });
}

function scheduleDataEditorColumnFilters() {
  const view = dataEditorViewState();
  window.clearTimeout(view.filterTimer);
  view.filterTimer = window.setTimeout(applyDataEditorColumnFiltersNow, DATA_EDITOR_SEARCH_DELAY);
}

function applyDataEditorColumnFiltersNow() {
  const view = dataEditorViewState();
  window.clearTimeout(view.filterTimer);
  const filters = {};
  dataEditorElement("data-editor-body")?.querySelectorAll("[data-editor-column-filter]").forEach((input) => {
    const value = String(input.value || "").trim();
    if (value) filters[input.dataset.editorColumnFilter] = value;
  });
  view.columnFilters = filters;
  loadDataEditorTable("primary", { resetScroll: true });
}

function dataEditorActiveFilters() {
  return Object.fromEntries(
    Object.entries(dataEditorViewState().columnFilters).filter(([, value]) => String(value ?? "").trim())
  );
}

function clearDataEditorSearchAndFilters() {
  const view = dataEditorViewState();
  view.search = "";
  view.columnFilters = {};
  view.orderDir = "desc";
  const search = dataEditorElement("data-editor-search");
  if (search) search.value = "";
  loadDataEditorTable("primary", { resetScroll: true });
}

function resetDataEditorQuery() {
  const view = dataEditorViewState();
  view.search = "";
  view.columnFilters = {};
  view.orderDir = "desc";
  const search = dataEditorElement("data-editor-search");
  if (search) search.value = "";
}

function toggleDataEditorRowSelection(rowKey, checked) {
  if (!rowKey || rowKey === "blank:new-row") return;
  const selected = dataEditorViewState().selectedRowKeys;
  if (checked) selected.add(rowKey);
  else selected.delete(rowKey);
  syncDataEditorSelectionUi();
}

function toggleAllDataEditorRows(checked) {
  const view = dataEditorViewState();
  const persistedKeys = (view.table?.rows || []).map((row) => row._editorRowKey);
  persistedKeys.forEach((key) => checked ? view.selectedRowKeys.add(key) : view.selectedRowKeys.delete(key));
  renderDataEditorVirtualRows(true);
}

function syncDataEditorSelectionUi() {
  const view = dataEditorViewState();
  const body = dataEditorElement("data-editor-body");
  body?.querySelectorAll("[data-editor-row]").forEach((row) => {
    const selected = view.selectedRowKeys.has(row.dataset.editorRow);
    row.classList.toggle("is-selected", selected);
    const checkbox = row.querySelector("[data-editor-row-select]");
    if (checkbox) checkbox.checked = selected;
  });
  const persistedKeys = (view.table?.rows || []).map((row) => row._editorRowKey);
  const selectedPersisted = persistedKeys.filter((key) => view.selectedRowKeys.has(key)).length;
  const selectAll = body?.querySelector("[data-editor-select-all]");
  if (selectAll) {
    selectAll.checked = persistedKeys.length > 0 && selectedPersisted === persistedKeys.length;
    selectAll.indeterminate = selectedPersisted > 0 && selectedPersisted < persistedKeys.length;
  }
  const selection = dataEditorElement("data-editor-selection");
  const count = dataEditorElement("data-editor-selection-count");
  if (selection) selection.hidden = view.selectedRowKeys.size === 0;
  if (count) count.textContent = `${view.selectedRowKeys.size} seleccionada(s)`;
}

async function openDataEditorDeleteDialog() {
  const view = dataEditorViewState();
  const rows = [...view.selectedRowKeys].map(dataEditorRowByKey).filter(Boolean);
  if (!rows.length) return;
  const primaryKey = dataEditorPrimaryKey();
  const persistedRows = rows.filter((row) => row._editorKind === "persisted");
  const keys = persistedRows.map((row) => String(row[primaryKey] ?? ""));
  dataEditorElement("data-editor-delete-table").textContent = view.table?.name || "";
  dataEditorElement("data-editor-delete-count").textContent = String(rows.length);
  dataEditorElement("data-editor-delete-primary").textContent = keys.length ? keys.join(", ") : "(solo borradores locales)";
  dataEditorElement("data-editor-delete-summary").textContent =
    "El backend verificará referencias antes de eliminar y no ejecutará cascadas implícitas.";
  dataEditorElement("data-editor-delete-details")?.replaceChildren();
  const dialog = dataEditorElement("data-editor-delete-dialog");
  const previewSequence = ++dataEditorDeletePreviewSequence;
  const requestedRowKeys = JSON.stringify(rows.map((row) => row._editorRowKey));
  dialog.dataset.rowKeys = requestedRowKeys;
  delete dialog.dataset.planToken;
  dialog.dataset.planApplicable = "false";
  const confirmButton = dataEditorElement("data-editor-delete-confirm");
  if (confirmButton) confirmButton.disabled = view.table?.name === "egresos" && keys.length > 0;
  dialog.showModal();
  if (view.table?.name !== "egresos" || !keys.length) return;
  dataEditorElement("data-editor-delete-summary").textContent = "Calculando las conexiones persistidas actuales…";
  try {
    const response = await fetch(`${API_BASE_URL}/api/admin/tables/egresos/delete-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deletedIds: keys })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw dataEditorRequestError(payload, response.status);
    if (
      previewSequence !== dataEditorDeletePreviewSequence
      || !dialog.open
      || dialog.dataset.rowKeys !== requestedRowKeys
    ) return;
    renderDataEditorDeletionPlan(payload.plan);
    dialog.dataset.planApplicable = String(Boolean(payload.plan.canApply));
    if (payload.plan.canApply) dialog.dataset.planToken = payload.plan.token;
    else delete dialog.dataset.planToken;
    if (confirmButton) confirmButton.disabled = !payload.plan.canApply;
  } catch (error) {
    if (previewSequence !== dataEditorDeletePreviewSequence || !dialog.open) return;
    dataEditorElement("data-editor-delete-summary").textContent = error.message;
    dialog.dataset.planApplicable = "false";
    delete dialog.dataset.planToken;
    if (confirmButton) confirmButton.disabled = true;
  }
}

function renderDataEditorDeletionPlan(plan) {
  const summary = dataEditorElement("data-editor-delete-summary");
  const details = dataEditorElement("data-editor-delete-details");
  if (!summary || !details) return;
  details.replaceChildren();
  summary.textContent = plan.canApply
    ? "También se eliminarán o desvincularán estas conexiones financieras:"
    : "No se puede eliminar porque existen conexiones sin una regla segura:";
  const list = document.createElement("ul");
  const addItem = (text) => {
    const item = document.createElement("li");
    item.textContent = text;
    list.appendChild(item);
  };
  (plan.deleted || []).forEach((item) => addItem(`${item.table}: ${item.count} conexión(es) se eliminarán.`));
  (plan.unlinked || []).forEach((item) => addItem(
    `${item.table}.${item.column}: ${item.count} campo(s) se pondrán en blanco.`
  ));
  (plan.updated || []).forEach((item) => addItem(`${item.table}: ${item.count} registro(s) recalcularán sus totales.`));
  (plan.preserved || []).forEach((item) => addItem(
    `${item.table}: ${item.count} registro(s) se conservarán. ${item.reason}`
  ));
  (plan.blocked || []).forEach((item) => addItem(
    `${item.table}.${item.column}: ${item.count} referencia(s) bloquean la operación. ${item.reason}`
  ));
  if (!list.children.length) addItem("No hay conexiones adicionales.");
  details.appendChild(list);
}

async function confirmDataEditorDelete() {
  const view = dataEditorViewState();
  const dialog = dataEditorElement("data-editor-delete-dialog");
  let rowKeys = [];
  try {
    rowKeys = JSON.parse(dialog?.dataset.rowKeys || "[]");
  } catch (_error) {
    rowKeys = [];
  }
  const rows = rowKeys.map(dataEditorRowByKey).filter(Boolean);
  const primaryKey = dataEditorPrimaryKey();
  const deletedIds = rows
    .filter((row) => row._editorKind === "persisted")
    .map((row) => String(row[primaryKey] ?? ""))
    .filter(Boolean);
  const localKeys = new Set(rows.filter((row) => row._editorKind === "draft").map((row) => row._editorRowKey));
  if (!deletedIds.length) {
    view.draftRows = view.draftRows.filter((row) => !localKeys.has(row._editorRowKey));
    rowKeys.forEach(clearDataEditorStatesForRow);
    dialog?.close();
    renderDataEditorVirtualRows(true);
    return;
  }

  const confirmButton = dataEditorElement("data-editor-delete-confirm");
  if (confirmButton) {
    confirmButton.disabled = true;
    confirmButton.textContent = "Eliminando…";
  }
  try {
    const response = await fetch(`${API_BASE_URL}/api/admin/tables/${encodeURIComponent(view.table.name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rows: [],
        newRows: [],
        deletedIds,
        all: true,
        search: view.search,
        filters: dataEditorActiveFilters(),
        orderBy: dataEditorOrderColumn(),
        orderDir: view.orderDir,
        tableVersion: view.table.version,
        ...(view.table.name === "egresos" ? { deletePlanToken: dialog?.dataset.planToken || "" } : {})
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw dataEditorRequestError(payload, response.status);
    applyDataEditorMutationTable(payload);
    view.draftRows = view.draftRows.filter((row) => !localKeys.has(row._editorRowKey));
    rowKeys.forEach(clearDataEditorStatesForRow);
    sortDataEditorRows();
    dialog?.close();
    renderDataEditorGridStructure();
    renderDataEditorVirtualRows(true);
    setDataEditorSummary();
  } catch (error) {
    dataEditorElement("data-editor-delete-summary").textContent = error.message;
    if (error.payload?.plan) {
      renderDataEditorDeletionPlan(error.payload.plan);
      if (dialog) {
        dialog.dataset.planApplicable = String(Boolean(error.payload.plan.canApply));
        if (error.payload.plan.canApply) dialog.dataset.planToken = error.payload.plan.token || "";
        else delete dialog.dataset.planToken;
      }
    }
  } finally {
    if (confirmButton) {
      confirmButton.disabled = view.table?.name === "egresos"
        && (dialog?.dataset.planApplicable !== "true" || !dialog?.dataset.planToken);
      confirmButton.textContent = "Eliminar filas";
    }
  }
}

function dataEditorHasPendingChanges() {
  const view = dataEditorViewState();
  const localDrafts = view.draftRows.some((row) =>
    dataEditorColumns().some((column) => String(row[column] ?? "").trim())
  );
  const pendingCells = [...view.cellStates.values()].some((state) =>
    state.status === "saving" || state.status === "error" || state.status === "incomplete"
  );
  return localDrafts || pendingCells || [...view.rowStates.values()].some((state) => state.status !== "saved");
}

function confirmDataEditorAbandon(action) {
  return window.confirm(`Hay valores sin persistir en ${dataEditorViewState().loadedTableName}. ¿Querés descartarlos y ${action}?`);
}

function discardDataEditorLocalChanges() {
  const view = dataEditorViewState();
  view.draftRows = [];
  view.selectedRowKeys = new Set();
  view.cellStates = new Map();
  view.rowStates = new Map();
  view.activeCell = null;
  view.editingCell = null;
}

async function openDataEditorDraft(tableName, draftRow, message) {
  pendingDataEditorDraft = { tableName, row: draftRow || {}, message };
  switchView("data-editor");
  await loadDataEditorSchema();
  const select = dataEditorElement("data-editor-table");
  if (select) select.value = tableName;
  resetDataEditorQuery();
  await loadDataEditorTable("primary", { tableName, resetScroll: false });
}

function applyDataEditorDraft() {
  const draft = pendingDataEditorDraft;
  if (!draft || dataEditorViewState().loadedTableName !== draft.tableName) return;
  pendingDataEditorDraft = null;
  const rowKey = addDataEditorRow("primary", draft.row);
  setDataEditorStatus(draft.message || "Fila precargada al final de la grilla.", "info");
  window.setTimeout(() => {
    scrollDataEditorToBottom();
    const firstEditable = dataEditorColumns().find((column) => {
      const row = dataEditorRowByKey(rowKey);
      return row && dataEditorCellIsWritable(row, column);
    });
    if (firstEditable) focusDataEditorCell(rowKey, firstEditable);
  }, 0);
}

function syncDataEditorCapabilities() {
  const view = dataEditorViewState();
  const canDelete = Boolean(view.table?.capabilities?.delete && dataEditorPrimaryKey());
  const deleteButton = dataEditorElement("data-editor-delete-selected");
  if (deleteButton) deleteButton.disabled = !canDelete;
  syncDataEditorSelectionUi();
}

function setDataEditorSummary() {
  const view = dataEditorViewState();
  const count = Number(view.table?.totalRows ?? view.table?.rows?.length ?? 0);
  const column = dataEditorOrderColumn();
  const direction = view.orderDir === "asc" ? "ascendente" : "descendente";
  const missingPrimary = !dataEditorPrimaryKey();
  const label = missingPrimary
    ? `${count} filas · sin PK declarada · orden ${column || "no disponible"} ${direction}`
    : `${count} filas · orden ${column} ${direction}`;
  setDataEditorStatus(label, missingPrimary ? "info" : "ok");
}

function setDataEditorGridHtml(html) {
  const body = dataEditorElement("data-editor-body");
  if (body) body.innerHTML = html;
}

function setDataEditorStatus(message, status = "") {
  const element = dataEditorElement("data-editor-status");
  if (!element) return;
  element.textContent = message || "";
  element.dataset.status = status;
}

function handleDataEditorResizeStart(event) {
  const handle = event.target.closest("[data-editor-resize]");
  if (!handle) return;
  event.preventDefault();
  const column = handle.dataset.editorResize;
  const header = handle.closest("th");
  const startX = event.clientX;
  const startWidth = header.getBoundingClientRect().width;
  document.body.classList.add("is-resizing-data-editor");

  const move = (moveEvent) => {
    const width = Math.max(90, Math.min(640, Math.round(startWidth + moveEvent.clientX - startX)));
    const view = dataEditorViewState();
    view.columnWidths[`${view.loadedTableName}:${column}`] = width;
    dataEditorElement("data-editor-body")?.querySelectorAll(
      `[data-editor-col="${CSS.escape(column)}"], th[data-column="${CSS.escape(column)}"], [data-editor-cell][data-column="${CSS.escape(column)}"]`
    ).forEach((element) => {
      element.style.width = `${width}px`;
      element.style.minWidth = `${width}px`;
      element.style.maxWidth = `${width}px`;
    });
  };
  const stop = () => {
    document.body.classList.remove("is-resizing-data-editor");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop, { once: true });
}
