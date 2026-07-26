async function loadPartnerContributions() {
  try {
    const rows = await backendTableRowsForEntry("aportes_socios");
    const body = els["partner-contributions-history-body"];
    if (body) {
      body.innerHTML = rows
        .slice()
        .sort((left, right) => Number(right.id_aporte_socio) - Number(left.id_aporte_socio))
        .map((row) => `<tr>
          <td>${escapeHtml(formatDate(row.fecha) || "-")}</td>
          <td>${escapeHtml(row.nombre || "-")}</td>
          <td>${escapeHtml(row.tipo || "-")}</td>
          <td>${formatMoney(parseMoney(row.monto))}</td>
          <td>${row.id_egreso ? `#${escapeHtml(row.id_egreso)}` : "-"}</td>
        </tr>`)
        .join("") || emptyRow(5, "Todavia no hay aportes o retiros registrados.");
    }
    if (els["partner-contribution-date"] && !els["partner-contribution-date"].value) {
      els["partner-contribution-date"].value = toIsoDate(new Date());
    }
  } catch (error) {
    setCommercialStatus("partner-contribution-status", `No se pudieron cargar los aportes: ${error.message}`, "error");
  }
}

async function submitPartnerContribution(event) {
  event.preventDefault();
  const date = backendId(els["partner-contribution-date"]?.value);
  const name = backendId(els["partner-contribution-name"]?.value);
  const type = backendId(els["partner-contribution-type"]?.value);
  const amount = centsToMoney(Math.abs(entryMoneyCents("partner-contribution-amount")));
  const validNames = new Set(["Bautista de Mayo", "Benjamin de Mayo", "Miguel de Mayo", "Alejandro Ganzabal", "Facundo Aragon"]);

  if (!date || !validNames.has(name) || !["Aporte", "Retiro"].includes(type) || amount <= 0) {
    setCommercialStatus("partner-contribution-status", "Completa fecha, socio, movimiento y monto.", "error");
    return;
  }

  const button = event.submitter;
  setCommercialButtonLoading(button, true, "Guardando...");
  try {
    pendingPartnerContributionOperationId ||= newTreasuryOperationId("aporte-socio");
    const result = await saveTreasuryOperation("/api/treasury/partner-contributions", {
      operationId: pendingPartnerContributionOperationId,
      contribution: { fecha: date, nombre: name, tipo: type, monto: amount }
    });
    const contributionId = result.contributionId;
    const expenseId = result.expenseId;
    pendingPartnerContributionOperationId = "";
    event.target.reset();
    bankPartnerContributionDraft = null;
    setCommercialStatus("partner-contribution-status", `${type} #${contributionId} guardado con egreso #${expenseId}.`, "success");
    await loadPartnerContributions();
    if (bankReconciliationFileText.trim()) await analyzeBankReconciliation();
  } catch (error) {
    setCommercialStatus("partner-contribution-status", `No se pudo guardar el movimiento: ${error.message}`, "error");
  } finally {
    setCommercialButtonLoading(button, false);
  }
}

let pendingPartnerContributionOperationId = "";
