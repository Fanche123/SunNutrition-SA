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
    activityCode: "106131",
    saleCondition: "Cheque",
    productCode: "4",
    productCodeLabel: "Producto o servicio",
    unitsValue: "7",
    unitsText: "unidades",
    kilogramsValue: "1",
    kilogramsText: "kilogramos",
    vatValue: "5",
    vatText: "21%",
    quantityPrecision: "2",
    unitPricePrecision: "2"
  });
  const CONTRACT = Object.freeze({
    version: 5,
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
      || !lines.every((line) => invoiceLineIsValid(
        line,
        payload.invoice.receiptType,
        payload.customer.address
      ))
      || !invoiceTotalsAreValid(lines, totals)
    ) return false;
    return true;
  }

  function invoiceLineIsValid(line, receiptType, customerAddress) {
    const quantity = Number(line?.quantity);
    const discountPercent = Number(line?.discountPercent);
    const gross = moneyCents(line?.gross);
    const discount = moneyCents(line?.discountAmount);
    const net = moneyCents(line?.netSubtotal);
    const vat = moneyCents(line?.vat);
    const total = moneyCents(line?.total);
    const unitPrice = moneyCents(line?.unitPrice);
    const quantityHundredths = Math.round(quantity * 100);
    const unitIsValid = lineUnitIsValid(line);
    if (
      !unitIsValid
      || line?.description !== buildLineDescription(line?.boxes, line?.productName, customerAddress)
      || !validArcaQuantity(quantity)
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
      || gross !== Math.round((unitPrice * quantityHundredths) / 100)
      || total !== net + vat
    ) return false;
    const discountedBase = gross - discount;
    if (discountedBase < 0 || discountedBase !== (receiptType === "Factura_A" ? net : total)) {
      return false;
    }
    return receiptType === "Factura_A"
      ? vat === Math.round((net * CONTRACT.vatRate) / 100)
      : net === Math.round(total / (1 + (CONTRACT.vatRate / 100)));
  }

  function lineUnitIsValid(line) {
    const classification = classifyProduct(line?.productName);
    if (!classification) return false;
    if (classification === "units") {
      const boxes = Number(line?.boxes);
      const unitsPerBox = Number(line?.unitsPerBox);
      return line?.unitValue === AUTOMATION.unitsValue
        && line?.unitText === AUTOMATION.unitsText
        && Number.isFinite(boxes)
        && boxes > 0
        && Number.isFinite(unitsPerBox)
        && unitsPerBox > 0
        && Number.isSafeInteger(Number(line?.quantity))
        && Number(line.quantity) === boxes * unitsPerBox;
    }
    return line?.unitValue === AUTOMATION.kilogramsValue
      && line?.unitText === AUTOMATION.kilogramsText
      && Number(line?.quantity) === Number(line?.boxes);
  }

  function classifyProduct(productName) {
    const normalized = normalizeDisplayText(productName).toLowerCase();
    if (normalized === "materia prima pochoclo dulce") return "kilograms";
    if (/^barra(?:\s|$)/.test(normalized)) return "units";
    return "";
  }

  function normalizeDisplayText(value) {
    return String(value || "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  }

  function buildLineDescription(boxes, productName, customerAddress) {
    const quantity = displayQuantity(boxes);
    const product = normalizeDisplayText(productName);
    const address = normalizeDisplayText(customerAddress);
    return quantity && product && address
      ? `${quantity} ${product} - Entrega: ${address}`
      : "";
  }

  function displayQuantity(value) {
    const quantity = Number(value);
    if (!validArcaQuantity(quantity)) return "";
    return String(quantity);
  }

  function validArcaQuantity(value) {
    if (!Number.isFinite(value) || value <= 0) return false;
    const hundredths = Math.round(value * 100);
    return Number.isSafeInteger(hundredths) && Math.abs((value * 100) - hundredths) < 1e-7;
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
    buildLineDescription,
    calendarDayDifference,
    classifyProduct,
    normalizeDisplayText,
    preparedPayloadIsValid,
    ruleForReceipt,
    validIsoCalendarDate,
    validateProductInvoiceDate
  });
});
