const { parseInput } = require("../../shared/money");

const MAX_BINARY_RESIDUE_TOLERANCE = 1e-9;

function parseStrictMoneyInput(value, options = {}) {
  const parseOptions = {
    allowEmpty: options.allowEmpty === true,
    allowNegative: options.allowNegative !== false
  };
  const candidate = typeof value === "number" ? String(value) : value;
  const textual = parseInput(candidate, parseOptions);
  if (textual.ok && !textual.empty) return textual;
  if (textual.empty) return textual;

  // JSON no conserva si un Number provino de aritmética. Se admite solamente
  // el residuo binario mínimo que normaliza al mismo centavo (0.1 + 0.2).
  if (typeof value === "number" && textual.error === "TOO_MANY_DECIMALS") {
    const rounded = parseInput(value, parseOptions);
    const scale = Math.max(1, Math.abs(value), Math.abs(rounded.amount || 0));
    const binaryResidueTolerance = Math.min(
      MAX_BINARY_RESIDUE_TOLERANCE,
      Number.EPSILON * scale * 4
    );
    if (
      rounded.ok
      && !rounded.empty
      && Math.abs(value - rounded.amount) <= binaryResidueTolerance
    ) {
      return rounded;
    }
  }

  return textual;
}

function strictMoneyToCents(value, options = {}) {
  const parsed = parseStrictMoneyInput(value, {
    ...options,
    allowEmpty: options.emptyAsZero === true
  });
  if (parsed.empty && options.emptyAsZero === true) return 0;
  if (!parsed.ok || parsed.empty) {
    const error = new RangeError(
      "El monto monetario debe ser válido y tener como máximo dos decimales."
    );
    error.code = parsed.error || "EMPTY_NOT_ALLOWED";
    throw error;
  }
  return parsed.cents;
}

module.exports = {
  parseStrictMoneyInput,
  strictMoneyToCents
};
