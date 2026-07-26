const { normalize } = require("../../shared/money");

// Las cantidades ya normalizadas usan punto decimal; no deben pasar por el parser monetario local.
function backendInventoryQuantity(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const normalized = String(value ?? "").trim().replace(/\s/g, "").replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function roundBackendMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return normalize(number);
}

module.exports = { backendInventoryQuantity, roundBackendMoney };
