(function exposeArcaFiscalContract(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) {
    root.ArcaFiscalContract = api;
    root.initializeArcaFiscalContract = () => api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createArcaFiscalContract() {
  "use strict";

  const RECEIPT_RULES = Object.freeze({
    Factura_A: Object.freeze({
      label: "Factura A",
      recipientCondition: "responsable_inscripto",
      recipientConditionLabel: "IVA Responsable Inscripto"
    }),
    Factura_B: Object.freeze({
      label: "Factura B",
      recipientCondition: "exento",
      recipientConditionLabel: "IVA Sujeto Exento"
    })
  });
  const AUTOMATION = Object.freeze({
    representativeCuit: "30717550419",
    representativeName: "SUNNUTRITION S.A.",
    pointOfSale: "00001",
    concept: "Productos",
    activity: "Elaboración de alimentos o bases de cereales",
    saleCondition: "Cheque",
    productCode: "4",
    productCodeLabel: "Producto o servicio",
    lineDescription: "Barra Pop",
    unit: "Unidades"
  });
  const CONTRACT = Object.freeze({
    version: 3,
    issuerCondition: "responsable_inscripto",
    issuerConditionLabel: "IVA Responsable Inscripto",
    pointOfSale: AUTOMATION.pointOfSale,
    vatRate: 21,
    receiptTypes: Object.freeze(Object.keys(RECEIPT_RULES))
  });

  function ruleForReceipt(receiptType) {
    return RECEIPT_RULES[String(receiptType || "")] || null;
  }

  function argentinaCalendarIso(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function validIsoCalendarDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
  }

  function calendarDayDifference(value, referenceDate) {
    if (!validIsoCalendarDate(value) || !validIsoCalendarDate(referenceDate)) return Number.NaN;
    const toUtc = (iso) => {
      const [year, month, day] = iso.split("-").map(Number);
      return Date.UTC(year, month - 1, day);
    };
    return (toUtc(value) - toUtc(referenceDate)) / 86400000;
  }

  function validateProductInvoiceDate(value, referenceDate) {
    if (!validIsoCalendarDate(value)) return Object.freeze({ ok: false, reason: "invalid" });
    if (!validIsoCalendarDate(referenceDate)) return Object.freeze({ ok: false, reason: "invalid_reference" });
    const difference = calendarDayDifference(value, referenceDate);
    if (difference < -5 || difference > 5) {
      return Object.freeze({ ok: false, reason: "outside_five_day_window" });
    }
    if (difference > 0 && value.slice(0, 7) !== referenceDate.slice(0, 7)) {
      return Object.freeze({ ok: false, reason: "future_month" });
    }
    return Object.freeze({ ok: true, reason: "" });
  }

  function preparedPayloadIsValid(payload) {
    const rule = ruleForReceipt(payload?.invoice?.receiptType);
    const lines = payload?.lines;
    const totals = payload?.invoice?.totals;
    if (
      !rule
      || payload?.contractVersion !== CONTRACT.version
      || payload?.invoice?.issuerCondition !== CONTRACT.issuerCondition
      || payload?.invoice?.recipientCondition !== rule.recipientCondition
      || payload?.customer?.fiscalCondition !== rule.recipientCondition
      || payload?.invoice?.pointOfSale !== CONTRACT.pointOfSale
      || !validIsoCalendarDate(payload?.invoice?.invoiceDate)
      || String(payload?.customer?.cuit || "").replace(/\D/g, "").length !== 11
      || Object.entries(AUTOMATION).some(([key, value]) => payload?.automation?.[key] !== value)
      || !Array.isArray(lines)
      || !lines.length
      || !lines.every((line) => invoiceLineIsValid(line, payload.invoice.receiptType))
      || !invoiceTotalsAreValid(lines, totals)
    ) return false;
    return true;
  }

  function invoiceLineIsValid(line, receiptType) {
    const units = Number(line?.individualUnits);
    const discountPercent = Number(line?.discountPercent);
    const gross = moneyCents(line?.gross);
    const discount = moneyCents(line?.discountAmount);
    const net = moneyCents(line?.netSubtotal);
    const vat = moneyCents(line?.vat);
    const total = moneyCents(line?.total);
    const unitPrice = moneyCents(line?.unitPrice);
    if (
      !String(line?.description || "").trim()
      || !Number.isSafeInteger(units)
      || units <= 0
      || unitPrice === null
      || unitPrice <= 0
      || !Number.isFinite(discountPercent)
      || discountPercent < 0
      || discountPercent > 100
      || Number(line?.vatRate) !== CONTRACT.vatRate
      || [gross, discount, net, vat, total].some((value) => value === null || value < 0)
      || gross <= 0
      || net <= 0
      || total <= 0
      || total !== net + vat
    ) return false;
    const discountedBase = gross - discount;
    return discountedBase >= 0
      && discountedBase === (receiptType === "Factura_A" ? net : total);
  }

  function invoiceTotalsAreValid(lines, totals) {
    const net = moneyCents(totals?.netSubtotal);
    const vat = moneyCents(totals?.vat);
    const total = moneyCents(totals?.total);
    if ([net, vat, total].some((value) => value === null || value < 0) || total !== net + vat) return false;
    return net === sumLineCents(lines, "netSubtotal")
      && vat === sumLineCents(lines, "vat")
      && total === sumLineCents(lines, "total");
  }

  function moneyCents(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    const scaled = value * 100;
    const cents = Math.round(scaled);
    return Number.isSafeInteger(cents) && Math.abs(scaled - cents) < 1e-7 ? cents : null;
  }

  function sumLineCents(lines, key) {
    return lines.reduce((sum, line) => sum + moneyCents(line[key]), 0);
  }

  return Object.freeze({
    AUTOMATION,
    CONTRACT,
    RECEIPT_RULES,
    argentinaCalendarIso,
    calendarDayDifference,
    preparedPayloadIsValid,
    ruleForReceipt,
    validIsoCalendarDate,
    validateProductInvoiceDate
  });
});
