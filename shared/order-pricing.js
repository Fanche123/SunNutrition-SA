(function exposeOrderPricing(root, factory) {
  const money = typeof module === "object" && module.exports
    ? require("./money")
    : root.ErpMoney;
  const api = factory(money);

  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.OrderPricing = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createOrderPricing(money) {
  "use strict";

  const RECEIPT_TYPES = Object.freeze(["Factura_A", "Factura_B", "Factura_C"]);
  const VAT_RATES = Object.freeze([0, 2.5, 5, 10.5, 21, 27]);

  function individualUnits(boxes, unitsPerBox) {
    const boxCount = Number(boxes);
    const unitCount = Number(unitsPerBox);
    if (!Number.isFinite(boxCount) || boxCount < 0) throw pricingError("INVALID_BOXES");
    if (!Number.isFinite(unitCount) || unitCount <= 0) throw pricingError("INVALID_UNITS_PER_BOX");
    const result = boxCount * unitCount;
    if (!Number.isSafeInteger(result)) throw pricingError("INVALID_INDIVIDUAL_UNITS");
    return result;
  }

  function discountedSubtotalCents(unitPrice, units, discountPercent = 0) {
    const normalizedUnits = Number(units);
    const discount = Number(discountPercent);
    if (!Number.isSafeInteger(normalizedUnits) || normalizedUnits < 0) {
      throw pricingError("INVALID_INDIVIDUAL_UNITS");
    }
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
      throw pricingError("INVALID_DISCOUNT");
    }
    const grossCents = money.multiplyCents(unitPrice, normalizedUnits);
    if (grossCents < 0) throw pricingError("INVALID_UNIT_PRICE");
    return money.multiplyCents(unitPrice, normalizedUnits * ((100 - discount) / 100));
  }

  function calculateLine({
    boxes,
    unitsPerBox,
    unitPrice,
    discountPercent = 0,
    vatRate,
    receiptType
  }) {
    if (!RECEIPT_TYPES.includes(receiptType)) throw pricingError("INVALID_RECEIPT_TYPE");
    const normalizedVatRate = Number(vatRate);
    if (!VAT_RATES.includes(normalizedVatRate)) throw pricingError("INVALID_VAT_RATE");
    if (receiptType === "Factura_C" && normalizedVatRate !== 0) {
      throw pricingError("VAT_NOT_ALLOWED_FOR_C");
    }

    const units = individualUnits(boxes, unitsPerBox);
    if (units <= 0) throw pricingError("INVALID_INDIVIDUAL_UNITS");
    const discount = Number(discountPercent);
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
      throw pricingError("INVALID_DISCOUNT");
    }

    const grossCents = money.multiplyCents(unitPrice, units);
    const discountedCents = discountedSubtotalCents(unitPrice, units, discount);
    const discountCents = grossCents - discountedCents;
    let netCents = discountedCents;
    let vatCents = 0;
    let totalCents = discountedCents;

    if (receiptType === "Factura_A") {
      vatCents = money.percentageCents(money.fromCents(netCents), normalizedVatRate);
      totalCents = netCents + vatCents;
    } else if (receiptType === "Factura_B") {
      netCents = money.divideCents(
        money.fromCents(discountedCents),
        1 + (normalizedVatRate / 100)
      );
      vatCents = discountedCents - netCents;
    }

    return Object.freeze({
      boxes: Number(boxes),
      unitsPerBox: Number(unitsPerBox),
      individualUnits: units,
      unitPrice: money.normalize(unitPrice),
      discountPercent: discount,
      vatRate: normalizedVatRate,
      gross: money.fromCents(grossCents),
      discountAmount: money.fromCents(discountCents),
      netSubtotal: money.fromCents(netCents),
      vat: money.fromCents(vatCents),
      total: money.fromCents(totalCents)
    });
  }

  function calculateInvoice(lines) {
    if (!Array.isArray(lines) || !lines.length) throw pricingError("MISSING_LINES");
    const netCents = money.sumCents(lines.map((line) => line.netSubtotal));
    const vatCents = money.sumCents(lines.map((line) => line.vat));
    const totalCents = money.sumCents(lines.map((line) => line.total));
    return Object.freeze({
      netSubtotal: money.fromCents(netCents),
      vat: money.fromCents(vatCents),
      total: money.fromCents(totalCents)
    });
  }

  function pricingError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  return Object.freeze({
    RECEIPT_TYPES,
    VAT_RATES,
    individualUnits,
    discountedSubtotalCents,
    calculateLine,
    calculateInvoice
  });
});
