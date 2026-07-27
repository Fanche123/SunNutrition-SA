let commercialEntryLoadPromise = null;

function initializeOperationalEntryDefaults() {
  const today = toIsoDate(new Date());
  if (els["reception-date"] && !els["reception-date"].value) els["reception-date"].value = today;
  if (els["reception-employee-id"] && !els["reception-employee-id"].value) els["reception-employee-id"].value = "Alcaraz_Pablo_Nicolas";
  if (els["issued-check-date"] && !els["issued-check-date"].value) els["issued-check-date"].value = today;
  if (els["issued-check-use-date"] && !els["issued-check-use-date"].value) els["issued-check-use-date"].value = today;
  if (els["issued-check-bank"] && !els["issued-check-bank"].value) els["issued-check-bank"].value = "ICBC";
  if (els["issued-check-state"] && !els["issued-check-state"].value) els["issued-check-state"].value = "Pendiente";
}

async function nextBackendPrimaryId(tableName, primaryColumn) {
  const rows = await backendTableRowsForEntry(tableName);
  return rows.reduce((maxId, row) => {
    const id = Number(row[primaryColumn]);
    return Number.isFinite(id) ? Math.max(maxId, id) : maxId;
  }, 0) + 1;
}

async function nextBackendPrimaryIdOrOne(tableName, primaryColumn) {
  try {
    return await nextBackendPrimaryId(tableName, primaryColumn);
  } catch {
    return 1;
  }
}

async function loadCommercialEntryData(force = false) {
  if (commercialEntryLoadPromise) return commercialEntryLoadPromise;
  if (commercialEntryData.loaded && !force) {
    renderActiveCommercialEntryView();
    return commercialEntryData;
  }

  commercialEntryLoadPromise = (async () => {
    const [
      clientes,
      productos,
      pedidos,
      detallePedidos,
      entregas,
      entregasDetalle,
      ventas,
      cobros,
      cobrosDetalle,
      chequesRecibidos,
      fletes,
      canales,
      acreedores,
      acreedoresEtiquetas,
      comisiones,
      etiquetas
    ] = await Promise.all([
      backendTableRowsForEntry("clientes"),
      backendTableRowsForEntry("productos"),
      backendTableRowsForEntry("pedidos"),
      backendTableRowsForEntry("detalle_pedidos"),
      backendTableRowsForEntry("entregas"),
      backendTableRowsForEntry("entregas_detalle"),
      backendTableRowsForEntry("ventas"),
      backendTableRowsForEntry("cobros"),
      backendTableRowsForEntry("cobros_detalle"),
      backendTableRowsForEntry("cheques_recibidos"),
      backendTableRowsForEntry("fletes"),
      backendTableRowsForEntry("canales"),
      backendTableRowsForEntry("acreedores"),
      backendTableRowsForEntry("acreedores_etiquetas"),
      backendTableRowsForEntry("comisiones"),
      backendTableRowsForEntry("etiquetas")
    ]);

    commercialEntryData = {
      loaded: true,
      clientes,
      productos,
      pedidos,
      detalle_pedidos: detallePedidos,
      entregas,
      entregas_detalle: entregasDetalle,
      ventas,
      cobros,
      cobros_detalle: cobrosDetalle,
      cheques_recibidos: chequesRecibidos,
      fletes,
      canales,
      acreedores,
      acreedores_etiquetas: acreedoresEtiquetas,
      comisiones,
      etiquetas
    };
    renderActiveCommercialEntryView();
    return commercialEntryData;
  })();

  try {
    return await commercialEntryLoadPromise;
  } catch (error) {
    const statusId = {
      "orders-entry": "orders-status",
      "logistics-entry": "logistics-status",
      "sales-entry": "sales-status",
      "collections-entry": "collections-status",
      "commissions-entry": "commissions-status",
      "received-check-entry": "received-check-status"
    }[activeCommercialEntryView()] || "orders-status";
    setCommercialStatus(statusId, `No se pudieron cargar los datos comerciales: ${error.message}. Volvé a abrir la vista para reintentar.`, "error");
    throw error;
  } finally {
    commercialEntryLoadPromise = null;
  }
}

function activeCommercialEntryView() {
  return document.querySelector(".view.active")?.id?.replace(/^view-/, "") || "";
}

function renderActiveCommercialEntryView() {
  const renderers = {
    "orders-entry": renderOrderEntry,
    "logistics-entry": renderLogisticsEntry,
    "sales-entry": renderSalesEntry,
    "collections-entry": renderCollectionsEntry,
    "commissions-entry": renderCommissionsEntry,
    "received-check-entry": renderReceivedCheckEntry
  };
  renderers[activeCommercialEntryView()]?.();
}
