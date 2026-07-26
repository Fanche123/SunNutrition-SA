const { fromCents, toCents } = require("../../shared/money");

function createEconomicExpenseComparisonService({ backendId, backendNumber, buildLegacyReport, loadCache, sendJson }) {
  function handleComparison(request, response) {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
      const year = Number(url.searchParams.get("year"));
      const month = Number(url.searchParams.get("month"));
      if (!Number.isInteger(year) || !Number.isInteger(month) || month < 0 || month > 11) {
        return sendJson(response, 400, { ok: false, error: "Periodo invalido." });
      }
      const period = `${year}-${String(month + 1).padStart(2, "0")}`;
      const cache = loadCache();
      const tables = cache.tables || {};
      const expenses = tables.gastos_economicos?.rows || [];
      const applications = tables.gastos_egresos?.rows || [];
      const confirmed = expenses.filter((row) => row.estado === "confirmado" && row.periodo_economico === period);
      const drafts = expenses.filter((row) => row.estado === "borrador" && (!row.periodo_economico || row.periodo_economico === period));
      const activeApplications = applications.filter((row) => row.estado === "vigente" && row.tipo_aplicacion !== "reversion");
      const appliedByExpense = new Map();
      activeApplications.forEach((row) => {
        const id = backendId(row.id_gasto_economico);
        appliedByExpense.set(
          id,
          (appliedByExpense.get(id) || 0) + Math.abs(toCents(backendNumber(row.importe_aplicado)))
        );
      });
      const byPeriod = sumBy(confirmed, (row) => row.periodo_economico, backendNumber);
      const byTag = sumBy(confirmed, (row) => backendId(row.id_etiqueta), backendNumber);
      const economicTotalCents = confirmed.reduce(
        (sum, row) => sum + toCents(backendNumber(row.importe)),
        0
      );
      const legacy = buildLegacyReport(year, month);
      const legacyExpenseTotalCents = toCents(backendNumber(legacy.totalCostOfSales))
        + toCents(backendNumber(legacy.totalOperatingExpenses))
        + toCents(backendNumber(legacy.totalNonOperatingExpenses));
      const withoutApplications = confirmed.filter((row) => !appliedByExpense.has(backendId(row.id_gasto_economico)));
      const overapplications = confirmed.filter((row) =>
        (appliedByExpense.get(backendId(row.id_gasto_economico)) || 0)
          > Math.abs(toCents(backendNumber(row.importe)))
      );
      const functionalGroups = new Map();
      expenses.filter((row) => row.estado !== "descartado").forEach((row) => {
        const key = [
          row.origen_tipo,
          backendId(row.origen_id),
          row.origen_subclave,
          row.tipo_economico,
          row.tipo_movimiento
        ].join("|");
        if (!functionalGroups.has(key)) functionalGroups.set(key, []);
        functionalGroups.get(key).push(row);
      });
      const potentialDuplicates = [...functionalGroups.entries()]
        .filter(([, rows]) => rows.length > 1)
        .map(([functionalKey, rows]) => ({ functionalKey, rows }));
      return sendJson(response, 200, {
        ok: true,
        diagnostic: true,
        period,
        legacy,
        economic: {
          totalConfirmed: fromCents(economicTotalCents),
          totalsByPeriod: byPeriod,
          totalsByTag: byTag,
          drafts,
          confirmedWithoutApplications: withoutApplications,
          overapplications,
          potentialDuplicates
        },
        difference: fromCents(economicTotalCents - legacyExpenseTotalCents),
        sourcesNotIntegrated: ["otros_gastos", "sueldos", "comisiones", "recepciones", "entregas", "planes_pagos"]
      });
    } catch (error) {
      return sendJson(response, 500, { ok: false, error: error.message });
    }
  }

  return { handleComparison };
}

function sumBy(rows, keyFor, backendNumber) {
  const centsByKey = rows.reduce((result, row) => {
    const key = keyFor(row) || "sin_clasificar";
    result[key] = (result[key] || 0) + toCents(backendNumber(row.importe));
    return result;
  }, {});
  return Object.fromEntries(Object.entries(centsByKey).map(([key, cents]) => [key, fromCents(cents)]));
}

module.exports = { createEconomicExpenseComparisonService };
