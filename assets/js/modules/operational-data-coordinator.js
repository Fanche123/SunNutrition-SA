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
  if (commercialEntryData.loaded && !force) {
    renderCommercialEntryViews();
    return;
  }

  try {
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
      backendTableRowsForEntry("clientes").catch(() => []),
      backendTableRowsForEntry("productos").catch(() => []),
      backendTableRowsForEntry("pedidos").catch(() => []),
      backendTableRowsForEntry("detalle_pedidos").catch(() => []),
      backendTableRowsForEntry("entregas").catch(() => []),
      backendTableRowsForEntry("entregas_detalle").catch(() => []),
      backendTableRowsForEntry("ventas").catch(() => []),
      backendTableRowsForEntry("cobros").catch(() => []),
      backendTableRowsForEntry("cobros_detalle").catch(() => []),
      backendTableRowsForEntry("cheques_recibidos").catch(() => []),
      backendTableRowsForEntry("fletes").catch(() => []),
      backendTableRowsForEntry("canales").catch(() => []),
      backendTableRowsForEntry("acreedores").catch(() => []),
      backendTableRowsForEntry("acreedores_etiquetas").catch(() => []),
      backendTableRowsForEntry("comisiones").catch(() => []),
      backendTableRowsForEntry("etiquetas").catch(() => [])
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
    renderCommercialEntryViews();
  } catch (error) {
    setCommercialStatus("orders-status", `No se pudieron cargar los datos comerciales: ${error.message}`, "error");
  }
}

function renderCommercialEntryViews() {
  renderOrderEntry();
  renderLogisticsEntry();
  renderSalesEntry();
  renderCollectionsEntry();
  renderCommissionsEntry();
  renderReceivedCheckEntry();
}
