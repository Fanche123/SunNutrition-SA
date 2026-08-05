const { fromCents, normalize: normalizeMoney, toCents } = require("../../shared/money");

function createCashflowService({ backendCreditorDisplayName, backendCurrentDateIso, backendExpenseSupplierName, backendId, backendIsoDate, backendNormalizeText, backendNumber, backendRowsById, buildTreasuryManagementSnapshot, loadCache }) {
  function buildBackendCashflowReport() {
    const cache = loadCache();
    const tables = cache.tables || {};
    const startIso = backendCurrentDateIso();
    const treasuryPosition = buildTreasuryManagementSnapshot(cache, "icbc").position;
    const payables = backendCashflowPayableEvents(tables);
    const receivables = backendCashflowReceivableEvents(tables);
    const receivedChecks = backendCashflowReceivedCheckEvents(tables, startIso);
    const issuedChecks = backendCashflowIssuedCheckEvents(tables);
    const events = [
      ...payables,
      ...receivables,
      ...issuedChecks,
      ...receivedChecks
    ].filter((event) => event.date && Math.abs(toCents(event.amount)) > 1000);
  
    const groups = backendCashflowGroups(events, startIso);
    const visibleGroups = groups.filter((group) => group.week.number <= 4);
    const banks = fromCents(treasuryPosition.banksTotalCents);
    const cash = treasuryPosition.cash.available
      ? fromCents(treasuryPosition.cash.balanceCents)
      : null;
    const weeks = backendCashflowWeeks(
      visibleGroups,
      cash === null ? null : sumMoney([banks, cash]),
      startIso
    );
  
    return {
      source: "backend",
      startIso,
      cards: {
        banks,
        cash,
        checksOnHand: fromCents(treasuryPosition.receivedChecks.availableTotalCents),
        receivable: sumMoney(receivables.map((event) => event.amount)),
        debts: sumMoney(payables.map((event) => Math.abs(event.amount))),
        checksToCover: fromCents(treasuryPosition.issuedChecks.pendingTotalCents)
      },
      groups,
      visibleGroups,
      weeks
    };
  }
  
  function backendCashflowPayableEvents(tables) {
    const paidByExpense = new Map();
    (tables.detalle_pagos?.rows || []).forEach((detail) => {
      const expenseId = backendId(detail.id_egreso);
      if (!expenseId) return;
      paidByExpense.set(
        expenseId,
        (paidByExpense.get(expenseId) || 0) + toCents(backendNumber(detail.monto_cancelado))
      );
    });
  
    return (tables.egresos?.rows || []).map((expense) => {
      const expenseId = backendId(expense.id_egreso);
      const invoiceType = expense.tipo_factura || "";
      if (!backendCashflowInvoiceTypeVisible(invoiceType)) return null;
      const balanceCents = toCents(backendNumber(expense.total)) - (paidByExpense.get(expenseId) || 0);
      if (balanceCents <= 1000) return null;
      return {
        type: "payable",
        label: "Pago",
        date: backendIsoDate(expense.fecha_prevista_pago) || backendIsoDate(expense.fecha_factura),
        party: backendExpenseSupplierName(expense, tables) || "Sin acreedor",
        documentType: invoiceType || "Sin tipo",
        documentNumber: expense.nro_factura || "Sin numero",
        effectiveDate: backendIsoDate(expense.fecha_factura),
        amount: fromCents(-balanceCents)
      };
    }).filter(Boolean);
  }
  
  function backendCashflowReceivableEvents(tables) {
    const clientsById = backendRowsById(tables.clientes?.rows, "id_cliente");
    const collectedBySale = new Map();
    (tables.cobros_detalle?.rows || []).forEach((detail) => {
      const saleId = backendId(detail.id_venta);
      if (!saleId) return;
      collectedBySale.set(
        saleId,
        (collectedBySale.get(saleId) || 0) + toCents(backendNumber(detail.monto_cancelado))
      );
    });
  
    return (tables.ventas?.rows || []).map((sale) => {
      const saleId = backendId(sale.id_venta);
      const balanceCents = toCents(backendNumber(sale.total)) - (collectedBySale.get(saleId) || 0);
      if (balanceCents <= 1000) return null;
      const client = clientsById.get(backendId(sale.id_cliente));
      return {
        type: "receivable",
        label: "Cobro",
        date: backendIsoDate(sale.fecha_acordada) || backendIsoDate(sale.fecha_factura),
        party: client?.nombre_cliente || "Sin cliente",
        documentType: sale.tipo_factura || "Sin tipo",
        documentNumber: sale.nro_factura || "Sin numero",
        effectiveDate: backendIsoDate(sale.fecha_factura),
        amount: fromCents(balanceCents)
      };
    }).filter(Boolean);
  }
  
  function backendCashflowReceivedCheckEvents(tables, startIso) {
    const clientsById = backendRowsById(tables.clientes?.rows, "id_cliente");
    const cobrosById = backendRowsById(tables.cobros?.rows, "id_cobro");
  
    return (tables.cheques_recibidos?.rows || []).map((check) => {
      const collection = cobrosById.get(backendId(check.id_cobro));
      if (!backendCashflowCheckIsPending(check.estado)) return null;
      const useDate = backendIsoDate(check.fecha_uso);
      if (!useDate || useDate < startIso) return null;
      const amount = normalizeMoney(backendNumber(check.monto ?? collection?.monto));
      if (toCents(amount) <= 1000) return null;
      const client = clientsById.get(backendId(check.id_cliente || collection?.id_cliente));
      return {
        type: "received-check",
        label: "Cheque",
        date: useDate,
        party: check.cliente || client?.nombre_cliente || "Sin cliente",
        documentType: "Cheque",
        documentNumber: check.nro_cheque || "Sin numero",
        effectiveDate: backendIsoDate(check.fecha_entregado) || backendIsoDate(collection?.fecha_cobro),
        amount
      };
    }).filter(Boolean);
  }
  
  function backendCashflowIssuedCheckEvents(tables) {
    const creditorsById = backendRowsById(tables.acreedores?.rows, "id_acreedor");
  
    return (tables.cheques_entregados?.rows || []).map((check) => {
      if (!backendCashflowCheckIsPending(check.estado)) return null;
      const amount = normalizeMoney(backendNumber(check.monto));
      if (toCents(amount) <= 1000) return null;
      const creditor = creditorsById.get(backendId(check.id_acreedor));
      return {
        type: "issued-check",
        label: "Cheque a cubrir",
        date: backendIsoDate(check.fecha_uso),
        party: backendCreditorDisplayName(creditor, tables) || "Sin acreedor",
        documentType: "Cheque",
        documentNumber: check.nro_cheque || "Sin numero",
        effectiveDate: backendIsoDate(check.fecha_entregado),
        amount: fromCents(-Math.abs(toCents(amount)))
      };
    }).filter(Boolean);
  }
  
  function backendCashflowCheckIsPending(status) {
    const normalized = backendNormalizeText(status);
    return normalized === "pendiente";
  }
  
  function backendCashflowGroups(events, startIso) {
    const groups = new Map();
  
    events.forEach((event) => {
      const key = [
        event.type,
        event.date,
        backendNormalizeText(event.party),
        backendNormalizeText(event.documentType),
        backendNormalizeText(event.documentNumber),
        event.effectiveDate || "",
        event.amount
      ].join("|");
      if (!groups.has(key)) {
        groups.set(key, {
          ...event,
          overrideKey: backendCashflowOverrideKey(event),
          amountCents: 0,
          count: 0
        });
      }
      const group = groups.get(key);
      group.amountCents += toCents(event.amount);
      group.count += 1;
    });
  
    return [...groups.values()]
      .map(({ amountCents, ...group }) => ({
        ...group,
        amount: fromCents(amountCents),
        week: backendCashflowWeekForDate(group.date, startIso)
      }))
      .sort((left, right) => left.week.number - right.week.number || left.date.localeCompare(right.date) || left.party.localeCompare(right.party));
  }
  
  function backendCashflowWeeks(groups, initialCash, startIso) {
    let balanceCents = Number.isFinite(initialCash) ? toCents(initialCash) : null;
    const weeks = new Map();
    for (let number = 1; number <= 4; number += 1) {
      weeks.set(number, {
        ...backendCashflowWeekForNumber(number, startIso),
        incomeCents: 0,
        outcomeCents: 0,
        netCents: 0
      });
    }
  
    groups.forEach((group) => {
      if (group.week.number > 4) return;
      const week = weeks.get(group.week.number);
      const amountCents = toCents(group.amount);
      if (amountCents >= 0) week.incomeCents += amountCents;
      else week.outcomeCents += Math.abs(amountCents);
      week.netCents += amountCents;
    });
  
    return [...weeks.values()].map((week) => {
      if (balanceCents !== null) balanceCents += week.netCents;
      return {
        number: week.number,
        startIso: week.startIso,
        endIso: week.endIso,
        income: fromCents(week.incomeCents),
        outcome: fromCents(week.outcomeCents),
        net: fromCents(week.netCents),
        balance: balanceCents === null ? null : fromCents(balanceCents)
      };
    });
  }
  
  function backendCashflowWeekForDate(dateIso, startIso) {
    if (!dateIso || dateIso < startIso) return backendCashflowWeekForNumber(1, startIso);
    const days = Math.floor((new Date(`${dateIso}T00:00:00`) - new Date(`${startIso}T00:00:00`)) / 86400000);
    return backendCashflowWeekForNumber(Math.floor(days / 7) + 1, startIso);
  }
  
  function backendCashflowWeekForNumber(number, startIso) {
    const start = new Date(`${startIso}T00:00:00`);
    start.setDate(start.getDate() + ((number - 1) * 7));
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return {
      number,
      startIso: start.toISOString().slice(0, 10),
      endIso: end.toISOString().slice(0, 10)
    };
  }
  
  function backendCashflowOverrideKey(event) {
    return `${event.type}|${backendNormalizeText(event.party)}|${event.date}|${backendNormalizeText(event.documentType)}|${backendNormalizeText(event.documentNumber)}|${event.effectiveDate || ""}`;
  }
  
  function backendCashflowInvoiceTypeVisible(invoiceType) {
    const normalized = backendNormalizeText(invoiceType);
    return normalized !== "asiento" && normalized !== "remito a";
  }

  return buildBackendCashflowReport;
}

function sumMoney(values) {
  return fromCents(values.reduce((total, value) => total + toCents(value), 0));
}

module.exports = { createCashflowService };
