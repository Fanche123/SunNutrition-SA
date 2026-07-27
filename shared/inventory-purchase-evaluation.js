(function exposeInventoryPurchaseEvaluation(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.InventoryPurchaseEvaluation = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createInventoryPurchaseEvaluation() {
  "use strict";

  const DAILY_CONSUMPTION_BY_ITEM = Object.freeze({
    maizpisingallo: 496.65 * 1.285,
    azucar: 496.65 * 0.143,
    aceite: 496.65 * 0.186,
    escenciadevainilla: 496.65 * 0.007,
    esenciadevainilla: 496.65 * 0.007,
    bobinabarrapop: 30100 / 5212,
    caja140: 215 / 25
  });

  function normalizeItemToken(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  function dailyConsumptionForItem(itemName) {
    return DAILY_CONSUMPTION_BY_ITEM[normalizeItemToken(itemName)] || 0;
  }

  function inventoryPurchaseMetrics(input = {}) {
    const itemName = String(input.itemName || "").trim();
    const provider = String(input.provider || "").trim();
    const stock = finiteInputNumber(input.stock);
    const leadDays = finiteInputNumber(input.leadDays);
    const businessDays = finiteInputNumber(input.businessDays);
    const dailyConsumption = dailyConsumptionForItem(itemName);
    const canEvaluate = Boolean(
      dailyConsumption
      && provider
      && leadDays
      && Number.isFinite(stock)
      && Number.isFinite(businessDays)
    );
    const required = canEvaluate ? dailyConsumption * businessDays : NaN;
    const shouldBuy = canEvaluate && stock < required;
    const daysRemaining = canEvaluate ? stock / dailyConsumption : NaN;

    return {
      itemId: String(input.itemId ?? "").trim(),
      itemName,
      stock,
      unit: String(input.unit || "").trim(),
      provider,
      leadDays,
      businessDays,
      dailyConsumption,
      required,
      daysRemaining,
      canEvaluate,
      shouldBuy
    };
  }

  function finiteInputNumber(value) {
    if (value === null || value === undefined || String(value).trim() === "") return NaN;
    const number = Number(value);
    return Number.isFinite(number) ? number : NaN;
  }

  function inventoryPurchaseAlert(input = {}) {
    const metrics = inventoryPurchaseMetrics(input);
    return metrics.shouldBuy ? metrics : null;
  }

  return {
    DAILY_CONSUMPTION_BY_ITEM,
    dailyConsumptionForItem,
    inventoryPurchaseAlert,
    inventoryPurchaseMetrics,
    normalizeItemToken
  };
});
