(function exposeErpMoney(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.ErpMoney = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createErpMoney() {
  "use strict";

  // Limita importes a un rango que conserva el roundtrip cents -> Number -> cents.
  const MAX_SAFE_CENTS = 999999999999999n;
  function validResult(cents) {
    return {
      ok: true,
      cents,
      amount: cents / 100,
      error: null,
      empty: false
    };
  }

  function emptyResult() {
    return {
      ok: true,
      cents: null,
      amount: null,
      error: null,
      empty: true
    };
  }

  function invalidResult(error) {
    return {
      ok: false,
      cents: null,
      amount: null,
      error,
      empty: false
    };
  }

  function assertSafeCents(value) {
    const absolute = value < 0n ? -value : value;
    if (absolute > MAX_SAFE_CENTS) {
      throw moneyError("UNSAFE_RANGE");
    }
    return Number(value);
  }

  function moneyError(code) {
    const error = new RangeError(code);
    error.code = code;
    return error;
  }

  function decimalToScaledInteger(rawValue, scale) {
    const match = String(rawValue).toLowerCase().match(
      /^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/
    );
    if (!match) return null;

    const negative = match[1] === "-";
    const integer = match[2];
    const fraction = match[3] || "";
    const exponent = Number(match[4] || 0);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;

    const digits = BigInt(`${integer}${fraction}`);
    const fractionalPlaces = fraction.length - exponent;
    const scaleDifference = scale - fractionalPlaces;
    let scaled;

    if (scaleDifference >= 0) {
      scaled = digits * (10n ** BigInt(scaleDifference));
    } else {
      const divisor = 10n ** BigInt(-scaleDifference);
      scaled = (digits + (divisor / 2n)) / divisor;
    }

    return negative && scaled !== 0n ? -scaled : scaled;
  }

  function parseNumber(value, allowNegative) {
    if (!Number.isFinite(value)) return invalidResult("NON_FINITE");
    if (value < 0 && !allowNegative) return invalidResult("NEGATIVE_NOT_ALLOWED");

    const centsBigInt = decimalToScaledInteger(String(value), 2);
    if (centsBigInt === null) return invalidResult("INVALID_FORMAT");

    try {
      return validResult(assertSafeCents(centsBigInt));
    } catch (error) {
      return invalidResult(error.code || "UNSAFE_RANGE");
    }
  }

  function stripSignAndCurrency(rawValue) {
    let text = String(rawValue).trim().replace(/[\s\u00a0\u202f]/g, "");
    let negative = false;
    let signRead = false;

    if (text.startsWith("-") || text.startsWith("+")) {
      negative = text[0] === "-";
      signRead = true;
      text = text.slice(1);
    }

    if (text.startsWith("$")) {
      text = text.slice(1);
    }

    if (text.startsWith("-") || text.startsWith("+")) {
      if (signRead) return null;
      negative = text[0] === "-";
      text = text.slice(1);
    }

    if (!text || text.includes("$") || text.includes("+") || text.includes("-")) {
      return null;
    }

    return { text, negative };
  }

  function groupedIntegerIsValid(value, separator) {
    const escapedSeparator = separator === "." ? "\\." : ",";
    return new RegExp(`^\\d{1,3}(?:${escapedSeparator}\\d{3})+$`).test(value);
  }

  function splitManualNumber(value) {
    if (!/^[\d.,]+$/.test(value)) {
      return { error: "INVALID_FORMAT" };
    }

    const commaCount = (value.match(/,/g) || []).length;
    const dotCount = (value.match(/\./g) || []).length;
    let integerPart = value;
    let fractionPart = "";

    if (commaCount && dotCount) {
      const decimalSeparator = value.lastIndexOf(",") > value.lastIndexOf(".") ? "," : ".";
      const groupingSeparator = decimalSeparator === "," ? "." : ",";
      const decimalParts = value.split(decimalSeparator);

      if (decimalParts.length !== 2) return { error: "INVALID_FORMAT" };
      [integerPart, fractionPart] = decimalParts;

      if (
        !integerPart ||
        !groupedIntegerIsValid(integerPart, groupingSeparator) ||
        !/^\d+$/.test(fractionPart)
      ) {
        return { error: "INVALID_FORMAT" };
      }
      integerPart = integerPart.split(groupingSeparator).join("");
    } else if (commaCount || dotCount) {
      const separator = commaCount ? "," : ".";
      const count = commaCount || dotCount;

      if (count === 1) {
        [integerPart, fractionPart] = value.split(separator);
        if (!integerPart || !fractionPart || !/^\d+$/.test(integerPart + fractionPart)) {
          return { error: "INVALID_FORMAT" };
        }
      } else if (groupedIntegerIsValid(value, separator)) {
        integerPart = value.split(separator).join("");
      } else {
        return { error: "INVALID_FORMAT" };
      }
    } else if (!/^\d+$/.test(integerPart)) {
      return { error: "INVALID_FORMAT" };
    }

    if (fractionPart.length > 2) {
      return { error: "TOO_MANY_DECIMALS" };
    }

    return { integerPart, fractionPart };
  }

  function parseString(value, allowNegative) {
    const stripped = stripSignAndCurrency(value);
    if (!stripped) return invalidResult("INVALID_FORMAT");
    if (stripped.negative && !allowNegative) {
      return invalidResult("NEGATIVE_NOT_ALLOWED");
    }

    const parts = splitManualNumber(stripped.text);
    if (parts.error) return invalidResult(parts.error);

    const centsText = `${parts.integerPart}${parts.fractionPart.padEnd(2, "0")}`;
    let centsBigInt = BigInt(centsText);
    if (stripped.negative && centsBigInt !== 0n) centsBigInt = -centsBigInt;

    try {
      return validResult(assertSafeCents(centsBigInt));
    } catch (error) {
      return invalidResult(error.code || "UNSAFE_RANGE");
    }
  }

  function parseInput(value, options) {
    const settings = options || {};
    const allowNegative = settings.allowNegative !== false;

    if (
      value === null ||
      value === undefined ||
      (typeof value === "string" && value.trim() === "")
    ) {
      return settings.allowEmpty === false
        ? invalidResult("EMPTY_NOT_ALLOWED")
        : emptyResult();
    }
    if (typeof value === "number") return parseNumber(value, allowNegative);
    if (typeof value === "string") return parseString(value, allowNegative);
    return invalidResult("INVALID_TYPE");
  }

  function toCents(value, options) {
    const result = parseInput(value, options);
    if (result.empty && (!options || options.emptyAsZero !== false)) return 0;
    if (!result.ok || result.empty) throw moneyError(result.error || "INVALID_FORMAT");
    return result.cents;
  }

  function fromCents(cents) {
    if (!Number.isSafeInteger(cents)) throw moneyError("UNSAFE_RANGE");
    assertSafeCents(BigInt(cents));
    return cents / 100;
  }

  function normalize(value, options) {
    return fromCents(toCents(value, options));
  }

  function format(value, options) {
    const settings = options || {};
    const cents = toCents(value, settings);
    const negative = cents < 0;
    const absoluteText = String(Math.abs(cents)).padStart(3, "0");
    const integerText = absoluteText.slice(0, -2);
    const fractionText = absoluteText.slice(-2);
    const groupedInteger = integerText.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    const formatted = `${negative ? "-" : ""}${groupedInteger},${fractionText}`;
    return settings.withSymbol === false ? formatted : `$ ${formatted}`;
  }

  function equals(left, right) {
    return toCents(left) === toCents(right);
  }

  function compare(left, right) {
    const leftCents = toCents(left);
    const rightCents = toCents(right);
    return leftCents === rightCents ? 0 : leftCents < rightCents ? -1 : 1;
  }

  function moneyValues(args) {
    return args.length === 1 && Array.isArray(args[0]) ? args[0] : Array.from(args);
  }

  function sumCents() {
    const total = moneyValues(arguments).reduce(
      (current, value) => current + BigInt(toCents(value)),
      0n
    );
    return assertSafeCents(total);
  }

  function sum() {
    return fromCents(sumCents.apply(null, moneyValues(arguments)));
  }

  function parseFactor(value) {
    if (typeof value !== "number" && typeof value !== "string") {
      throw moneyError("INVALID_TYPE");
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw moneyError("NON_FINITE");
    }

    let text = String(value).trim().replace(/\s/g, "");
    if (text.includes(",") && !text.includes(".")) text = text.replace(",", ".");
    if (text.includes(",")) throw moneyError("INVALID_FORMAT");

    const match = text.toLowerCase().match(
      /^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/
    );
    if (!match) throw moneyError("INVALID_FORMAT");

    const negative = match[1] === "-";
    const integer = match[2];
    const fraction = match[3] || "";
    const exponent = Number(match[4] || 0);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) {
      throw moneyError("UNSAFE_RANGE");
    }

    let numerator = BigInt(`${integer}${fraction}`);
    let denominator = 10n ** BigInt(fraction.length);
    if (exponent > 0) numerator *= 10n ** BigInt(exponent);
    if (exponent < 0) denominator *= 10n ** BigInt(-exponent);
    if (negative) numerator = -numerator;
    return { numerator, denominator };
  }

  function roundedRatio(numerator, denominator) {
    if (denominator <= 0n) throw moneyError("INVALID_FORMAT");
    const negative = numerator < 0n;
    const absolute = negative ? -numerator : numerator;
    const rounded = (absolute + (denominator / 2n)) / denominator;
    return negative && rounded !== 0n ? -rounded : rounded;
  }

  function multiplyCents(value, multiplier) {
    const cents = BigInt(toCents(value));
    const factor = parseFactor(multiplier);
    return assertSafeCents(
      roundedRatio(cents * factor.numerator, factor.denominator)
    );
  }

  function multiply(value, multiplier) {
    return fromCents(multiplyCents(value, multiplier));
  }

  function divideCents(value, divisor) {
    const cents = BigInt(toCents(value));
    const factor = parseFactor(divisor);
    if (factor.numerator === 0n) throw moneyError("DIVIDE_BY_ZERO");

    let numerator = cents * factor.denominator;
    let denominator = factor.numerator;
    if (denominator < 0n) {
      numerator = -numerator;
      denominator = -denominator;
    }
    return assertSafeCents(roundedRatio(numerator, denominator));
  }

  function divide(value, divisor) {
    return fromCents(divideCents(value, divisor));
  }

  function sumRatiosCents(terms) {
    if (!Array.isArray(terms)) throw moneyError("INVALID_TYPE");

    let totalNumerator = 0n;
    let totalDenominator = 1n;
    terms.forEach((term) => {
      if (!term || typeof term !== "object") throw moneyError("INVALID_TYPE");
      const factor = parseFactor(term.divisor);
      if (factor.numerator === 0n) throw moneyError("DIVIDE_BY_ZERO");

      let termNumerator = BigInt(toCents(term.value)) * factor.denominator;
      let termDenominator = factor.numerator;
      if (termDenominator < 0n) {
        termNumerator = -termNumerator;
        termDenominator = -termDenominator;
      }

      totalNumerator = (totalNumerator * termDenominator)
        + (termNumerator * totalDenominator);
      totalDenominator *= termDenominator;
    });

    return assertSafeCents(roundedRatio(totalNumerator, totalDenominator));
  }

  function sumRatios(terms) {
    return fromCents(sumRatiosCents(terms));
  }

  function percentageCents(value, percent) {
    const cents = BigInt(toCents(value));
    const factor = parseFactor(percent);
    return assertSafeCents(
      roundedRatio(cents * factor.numerator, factor.denominator * 100n)
    );
  }

  function percentage(value, percent) {
    return fromCents(percentageCents(value, percent));
  }

  return Object.freeze({
    parseInput,
    toCents,
    fromCents,
    normalize,
    format,
    formatInput: (value) => format(value, { withSymbol: false }),
    equals,
    compare,
    sumCents,
    sum,
    multiplyCents,
    multiply,
    divideCents,
    divide,
    sumRatiosCents,
    sumRatios,
    percentageCents,
    percentage
  });
});
