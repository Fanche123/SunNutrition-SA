function backendBankMatches(value, bank, normalizeText) {
  if (typeof normalizeText !== "function") {
    throw new TypeError("backendBankMatches requiere un normalizador de texto.");
  }
  const normalizedValue = normalizeText(value);
  const normalizedBank = normalizeText(bank);
  return !normalizedValue || !normalizedBank || normalizedValue.includes(normalizedBank) || normalizedBank.includes(normalizedValue);
}

function bankDateDistance(leftIso, rightIso) {
  if (!leftIso || !rightIso) return 999;
  return Math.round(Math.abs(new Date(`${leftIso}T00:00:00`) - new Date(`${rightIso}T00:00:00`)) / 86400000);
}

function compactBankText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\s+Ă‚Â·\s+/g, " Ă‚Â· ")
    .trim();
}

function normalizeBankCuit(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  const withoutLeadingZeros = digits.replace(/^0+/, "");
  return withoutLeadingZeros.length >= 7 ? withoutLeadingZeros : digits;
}

function extractBankCuit(value) {
  const text = String(value || "");
  const match = text.match(/\b0*(20|23|24|27|30|33|34)\d{9}\b/);
  return match ? match[0] : "";
}

function normalizeBankCheckNumber(value) {
  const digits = String(value || "").replace(/\D/g, "").replace(/^0+/, "");
  return digits || "";
}

function extractBankCheckNumber(value) {
  const text = String(value || "").toUpperCase();
  if (!/(E\s*-?\s*CHEQ|ECHEQ|CHEQUE|CH\s|CH\.|CAMARA|CÄ‚ÂMARA)/.test(text)) return "";

  const markerMatch = text.match(/(?:E\s*-?\s*CHEQ|ECHEQ|CHEQUE|CH\.?|CAMARA|CÄ‚ÂMARA)\s*([0-9]{3,12})/);
  if (markerMatch) return normalizeBankCheckNumber(markerMatch[1]);

  const candidates = [...text.matchAll(/\b([0-9]{3,12})\b/g)].map((match) => match[1]);
  const nonCuitCandidates = candidates.filter((candidate) => normalizeBankCuit(candidate).length !== 11);
  return normalizeBankCheckNumber(nonCuitCandidates.at(-1) || candidates.at(-1) || "");
}

function bankTextOverlapScore(left, right) {
  const ignored = new Set(["de", "del", "la", "el", "los", "las", "sa", "srl", "sas", "y", "a", "por", "con", "pago", "transferencia", "transf"]);
  const leftTokens = new Set(String(left || "").split(/\s+/).filter((token) => token.length >= 3 && !ignored.has(token)));
  const rightTokens = String(right || "").split(/\s+/).filter((token) => token.length >= 3 && !ignored.has(token));
  return rightTokens.reduce((score, token) => score + (leftTokens.has(token) ? 1 : 0), 0);
}


module.exports = { backendBankMatches, bankDateDistance, compactBankText, normalizeBankCuit, extractBankCuit, normalizeBankCheckNumber, extractBankCheckNumber, bankTextOverlapScore };
