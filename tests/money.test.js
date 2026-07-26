const assert = require("assert");
const money = require("../shared/money");
const moneyColumns = require("../shared/money-columns");

function parsed(value, options) {
  const result = money.parseInput(value, options);
  assert.strictEqual(result.ok, true, `Se esperaba un importe válido: ${value}`);
  assert.strictEqual(result.empty, false);
  assert.strictEqual(result.error, null);
  return result;
}

function testZero() {
  assert.strictEqual(parsed(0).cents, 0);
  assert.strictEqual(money.normalize(0), 0);
  assert.strictEqual(money.format(0), "$ 0,00");
}

function testInteger() {
  assert.strictEqual(parsed(397055).cents, 39705500);
  assert.strictEqual(money.format(397055), "$ 397.055,00");
}

function testOneDecimal() {
  assert.strictEqual(parsed(397055.5).cents, 39705550);
  assert.strictEqual(money.format(397055.5), "$ 397.055,50");
}

function testTwoDecimals() {
  assert.strictEqual(parsed(397055.25).cents, 39705525);
  assert.strictEqual(money.normalize(397055.25), 397055.25);
}

function testNegativeValues() {
  assert.strictEqual(parsed("-1.234,56", { allowNegative: true }).cents, -123456);
  assert.strictEqual(money.format("-1.234,56"), "$ -1.234,56");
  assert.deepStrictEqual(
    money.parseInput("-1,00", { allowNegative: false }),
    {
      ok: false,
      cents: null,
      amount: null,
      error: "NEGATIVE_NOT_ALLOWED",
      empty: false
    }
  );
}

function testLargeSafeValues() {
  const maximum = parsed("9.999.999.999.999,99");
  assert.strictEqual(maximum.cents, 999999999999999);
  assert.strictEqual(
    money.format("9.999.999.999.999,99"),
    "$ 9.999.999.999.999,99"
  );
  assert.strictEqual(
    money.toCents(money.fromCents(maximum.cents)),
    maximum.cents
  );
  assert.strictEqual(
    money.parseInput("10.000.000.000.000,00").error,
    "UNSAFE_RANGE"
  );
}

function testExactAddition() {
  assert.strictEqual(money.sumCents(0.1, 0.2), 30);
  assert.strictEqual(money.sum(0.1, 0.2), 0.3);
  assert.strictEqual(money.format(money.sum(0.1, 0.2)), "$ 0,30");
}

function testPercentageFractionOfCent() {
  assert.strictEqual(money.percentageCents("0,05", 10), 1);
  assert.strictEqual(money.percentage("19,99", 21), 4.2);
}

function testArgentineThousands() {
  assert.strictEqual(parsed("999.645,25").cents, 99964525);
}

function testCommaDecimal() {
  assert.strictEqual(parsed("999645,25").cents, 99964525);
}

function testDotDecimal() {
  assert.strictEqual(parsed("999645.25").cents, 99964525);
}

function testCurrencySymbol() {
  assert.strictEqual(parsed("$ 999.645,25").cents, 99964525);
}

function testRuntimeInputMatrixAndDisplayedRoundtrip() {
  const accepted = [
    ["1.234,56", 123456],
    ["1234,56", 123456],
    ["1234.56", 123456],
    ["$ 1.234,56", 123456],
    ["0,10", 10],
    ["0,20", 20]
  ];

  accepted.forEach(([input, expectedCents]) => {
    const result = parsed(input, { allowEmpty: false, allowNegative: false });
    assert.strictEqual(result.cents, expectedCents);
    const displayed = money.format(result.amount);
    assert.strictEqual(
      parsed(displayed, { allowEmpty: false, allowNegative: false }).cents,
      expectedCents
    );
  });

  assert.strictEqual(
    parsed("-1.234,56", { allowEmpty: false, allowNegative: true }).cents,
    -123456
  );
  assert.strictEqual(
    money.parseInput("-1.234,56", { allowEmpty: false, allowNegative: false }).error,
    "NEGATIVE_NOT_ALLOWED"
  );
  assert.strictEqual(
    money.parseInput("1.234,567", { allowEmpty: false }).error,
    "TOO_MANY_DECIMALS"
  );
  assert.strictEqual(
    money.parseInput("importe invalido", { allowEmpty: false }).error,
    "INVALID_FORMAT"
  );
  assert.strictEqual(
    money.parseInput("", { allowEmpty: false }).error,
    "EMPTY_NOT_ALLOWED"
  );
  assert.strictEqual(money.parseInput("", { allowEmpty: true }).empty, true);
}

function testInvalidInput() {
  const letters = money.parseInput("ABC 12,30");
  assert.strictEqual(letters.ok, false);
  assert.strictEqual(letters.error, "INVALID_FORMAT");
  assert.strictEqual(money.parseInput(Infinity).error, "NON_FINITE");
  assert.strictEqual(money.parseInput({ amount: 10 }).error, "INVALID_TYPE");

  assert.deepStrictEqual(money.parseInput("  "), {
    ok: true,
    cents: null,
    amount: null,
    error: null,
    empty: true
  });
  assert.deepStrictEqual(money.parseInput("", { allowEmpty: false }), {
    ok: false,
    cents: null,
    amount: null,
    error: "EMPTY_NOT_ALLOWED",
    empty: false
  });
  assert.strictEqual(money.toCents(""), 0);
}

function testTooManyManualDecimals() {
  const comma = money.parseInput("10,123");
  const dot = money.parseInput("10.123");
  assert.strictEqual(comma.ok, false);
  assert.strictEqual(comma.error, "TOO_MANY_DECIMALS");
  assert.strictEqual(dot.ok, false);
  assert.strictEqual(dot.error, "TOO_MANY_DECIMALS");
}

function testAlwaysTwoDecimals() {
  assert.strictEqual(money.format(0), "$ 0,00");
  assert.strictEqual(money.format(1), "$ 1,00");
  assert.strictEqual(money.format(1.5), "$ 1,50");
  assert.strictEqual(money.format(1.25), "$ 1,25");
  assert.strictEqual(money.formatInput(999645.25), "999.645,25");
}

function testCentComparisons() {
  assert.strictEqual(money.equals(0.1 + 0.2, 0.3), true);
  assert.strictEqual(money.compare("10,00", "9,99"), 1);
  assert.strictEqual(money.compare("9,99", "10,00"), -1);
  assert.strictEqual(money.compare("$ 10,00", 10), 0);
}

function testSingleFinalRounding() {
  const totalBeforePercentage = money.sum("0,05", "0,05");
  assert.strictEqual(totalBeforePercentage, 0.1);
  assert.strictEqual(money.percentageCents(totalBeforePercentage, 10), 1);
  assert.strictEqual(money.multiplyCents("0,05", "0.1"), 1);
  assert.strictEqual(money.divideCents("0,05", 2), 3);
  assert.strictEqual(money.divide("10,00", 4), 2.5);
  assert.strictEqual(money.divide("-0,05", 2), -0.03);
  assert.throws(() => money.divide("10,00", 0), (error) => error.code === "DIVIDE_BY_ZERO");
  assert.strictEqual(money.normalize(money.percentage("19,99", 21)), 4.2);
}

function testExports() {
  assert.strictEqual(globalThis.ErpMoney, money);
  [
    "parseInput",
    "toCents",
    "fromCents",
    "normalize",
    "format",
    "equals",
    "compare",
    "sumCents",
    "sum",
    "multiplyCents",
    "multiply",
    "divideCents",
    "divide",
    "sumRatiosCents",
    "sumRatios",
    "percentageCents",
    "percentage"
  ].forEach((name) => assert.strictEqual(typeof money[name], "function", name));
}

function testSemanticMoneyColumns() {
  assert.strictEqual(Object.isFrozen(moneyColumns.columnsByTable.pagos), true);
  assert.strictEqual(moneyColumns.isMoneyColumn("pagos", "monto"), true);
  assert.strictEqual(moneyColumns.isMoneyColumn("proveedores", "pedido_minimo"), true);
  assert.strictEqual(moneyColumns.isMoneyColumn("productos", "costo_base"), true);
  assert.strictEqual(moneyColumns.isMoneyColumn("productos", "cantidad_individual"), false);
  assert.strictEqual(moneyColumns.isMoneyColumn("canales", "comision"), false);
  assert.strictEqual(moneyColumns.isMoneyColumn("detalle_pedidos", "bonificacion"), false);
}

function main() {
  testZero();
  testInteger();
  testOneDecimal();
  testTwoDecimals();
  testNegativeValues();
  testLargeSafeValues();
  testExactAddition();
  testPercentageFractionOfCent();
  testArgentineThousands();
  testCommaDecimal();
  testDotDecimal();
  testCurrencySymbol();
  testRuntimeInputMatrixAndDisplayedRoundtrip();
  testInvalidInput();
  testTooManyManualDecimals();
  testAlwaysTwoDecimals();
  testCentComparisons();
  testSingleFinalRounding();
  testExports();
  testSemanticMoneyColumns();
  console.log("Money tests: OK");
}

main();
