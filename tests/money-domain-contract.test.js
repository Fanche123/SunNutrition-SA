const assert = require("assert");
const fs = require("fs");
const path = require("path");
const money = require("../shared/money");
const { roundBackendMoney } = require("../backend/utils/inventory-numbers");

const ROOT = path.join(__dirname, "..");

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function testCommissionRoundsOnceAtTheFinalCentBoundary() {
  const saleTotalCents = money.toCents(1210.01);
  const subtotalCents = money.toCents(1000.01);
  const paidCents = money.toCents(605.01);
  const commissionableCents = Math.round((subtotalCents * paidCents) / saleTotalCents);
  const commissionCents = money.multiplyCents(money.fromCents(commissionableCents), 0.1);

  assert.strictEqual(Number.isSafeInteger(commissionableCents), true);
  assert.strictEqual(Number.isSafeInteger(commissionCents), true);
  assert.strictEqual(money.toCents(money.fromCents(commissionCents)), commissionCents);
}

function testReportTotalsUseExactCentSums() {
  const sales = money.sum(0.1, 0.2, 397055.25);
  const costs = money.sum(100000.1, 200000.2);
  const resultCents = money.toCents(sales) - money.toCents(costs);

  assert.strictEqual(money.format(sales), "$ 397.055,55");
  assert.strictEqual(money.format(money.fromCents(resultCents)), "$ 97.055,25");
}

function testFrontendConsumersUseTheCanonicalContract() {
  const paymentPlans = source("assets/js/modules/payment-plans.js");
  const payments = source("assets/js/modules/payment-entry.js");
  const collections = source("assets/js/modules/collections-retentions.js");
  const commissions = source("assets/js/modules/commissions-entry.js");
  const reports = source("assets/js/modules/reports-cashflow.js");
  const editor = source("assets/js/modules/data-editor.js");

  assert.doesNotMatch(paymentPlans, /new Intl\.NumberFormat/);
  assert.doesNotMatch(paymentPlans, /function moneyToCents\(/);
  assert.match(paymentPlans, /data-money-input/);
  assert.match(paymentPlans, /moneyToCents\(quota\.capital\)/);

  assert.doesNotMatch(payments, /Number\(String\(input\.value/);
  assert.match(payments, /differenceCents === 0/);
  assert.match(collections, /collectedAmountCents \+ retentionsCents !== invoiceTotalCents/);
  assert.match(commissions, /commissionableSubtotalCents/);
  assert.match(commissions, /ErpMoney\.multiplyCents/);
  assert.match(reports, /function reportMoneySum\(/);
  assert.match(reports, /ErpMoney\.sumRatios\(/);
  assert.doesNotMatch(source("assets/js/app.js"), /setUtilityProducedMetric|moneyToCents|Math\.round/);
  assert.doesNotMatch(source("assets/js/modules/dashboard.js"), /Math\.round\(moneyToCents/);
  assert.match(editor, /function isDataEditorMoneyColumn\(/);
  assert.match(editor, /ErpMoneyColumns\?\.isMoneyColumn/);
  assert.match(
    source("backend/services/backend-table.service.js"),
    /isMoneyColumn\(tableName, column\)/
  );
}

function testReadOnlyStartupDoesNotRewriteServerState() {
  const appSource = source("assets/js/app.js");
  const cleanupFunction = appSource.match(
    /function persistBackendOnlyStateCleanup\(\) \{([\s\S]*?)\n\}/
  );

  assert(cleanupFunction, "No se encontro la limpieza local de estado al iniciar.");
  assert.match(cleanupFunction[1], /localStorage\.setItem/);
  assert.doesNotMatch(cleanupFunction[1], /saveStateToServer|fetch\(/);
}

function testRatioSumsRoundOnlyOnce() {
  assert.strictEqual(
    money.sumRatiosCents([
      { value: "10,00", divisor: 3 },
      { value: "-1,00", divisor: 6 }
    ]),
    317
  );
}

function testPersistedNumericValueDoesNotGainPresentationText() {
  const parsed = money.parseInput("$ 999.645,25");
  assert.deepStrictEqual(
    { ok: parsed.ok, cents: parsed.cents, amount: parsed.amount },
    { ok: true, cents: 99964525, amount: 999645.25 }
  );
  assert.strictEqual(typeof parsed.amount, "number");
  assert.strictEqual(money.format(parsed.amount), "$ 999.645,25");
}

function testValuedInventoryUsesTheSameCentBoundary() {
  assert.strictEqual(roundBackendMoney(0.1 + 0.2), 0.3);
  assert.strictEqual(roundBackendMoney(397055.255), 397055.26);
  assert.match(
    source("backend/services/inventory-valuation.service.js"),
    /inventoryValueCents \+= lineValueCents/
  );
  assert.match(
    source("backend/services/inventory-valuation.service.js"),
    /multiplyCents\(normalizedUnitCost, quantity\)/
  );
  assert.match(
    source("backend/services/income-calculation.service.js"),
    /calculatedValueCents \+= multiplyCents\(unitCost, quantity\)/
  );
}

function main() {
  testCommissionRoundsOnceAtTheFinalCentBoundary();
  testReportTotalsUseExactCentSums();
  testFrontendConsumersUseTheCanonicalContract();
  testReadOnlyStartupDoesNotRewriteServerState();
  testRatioSumsRoundOnlyOnce();
  testPersistedNumericValueDoesNotGainPresentationText();
  testValuedInventoryUsesTheSameCentBoundary();
  console.log("Money domain contract tests: OK");
}

main();
