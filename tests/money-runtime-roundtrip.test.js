const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const money = require("../shared/money");
const moneyColumns = require("../shared/money-columns");

const SOURCE_CACHE = path.join(__dirname, "..", "tmp", "backend-data-cache.json");

function fileHash(filename) {
  return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function monetarySnapshot(cache, { normalize = false } = {}) {
  const centsByCell = {};
  let invalidClassifiedCells = 0;

  Object.entries(cache.tables || {}).forEach(([tableName, table]) => {
    (table.rows || []).forEach((row, rowIndex) => {
      Object.entries(row || {}).forEach(([columnName, value]) => {
        if (!moneyColumns.isMoneyColumn(tableName, columnName)) return;
        if (value === null || value === undefined || String(value).trim() === "") return;

        const parsed = money.parseInput(value, {
          allowEmpty: false,
          allowNegative: true
        });
        if (!parsed.ok) {
          invalidClassifiedCells += 1;
          return;
        }

        const key = `${tableName}/${rowIndex}/${columnName}`;
        centsByCell[key] = parsed.cents;
        if (normalize) row[columnName] = money.fromCents(parsed.cents);
      });
    });
  });

  return { centsByCell, invalidClassifiedCells };
}

function nonMonetaryDigest(cache) {
  const comparable = structuredClone(cache);
  Object.entries(comparable.tables || {}).forEach(([tableName, table]) => {
    (table.rows || []).forEach((row) => {
      Object.entries(row || {}).forEach(([columnName, value]) => {
        if (!moneyColumns.isMoneyColumn(tableName, columnName)) return;
        const parsed = money.parseInput(value, {
          allowEmpty: true,
          allowNegative: true
        });
        if (parsed.ok && !parsed.empty) row[columnName] = "[MONETARY_CELL]";
      });
    });
  });
  return crypto.createHash("sha256").update(JSON.stringify(comparable)).digest("hex");
}

function atomicWriteJson(filename, value) {
  const temporary = `${filename}.next`;
  fs.writeFileSync(temporary, JSON.stringify(value), "utf8");
  fs.renameSync(temporary, filename);
}

test("el cache real conserva centavos tras tres guardados aislados sin doble redondeo", () => {
  assert.ok(fs.existsSync(SOURCE_CACHE), "Falta el cache de solo lectura para la prueba runtime.");
  const sourceHashBefore = fileHash(SOURCE_CACHE);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "erp-money-roundtrip-"));
  const temporaryCache = path.join(temporaryDirectory, "backend-data-cache.json");

  try {
    fs.copyFileSync(SOURCE_CACHE, temporaryCache);
    const initial = JSON.parse(fs.readFileSync(temporaryCache, "utf8"));
    const baseline = monetarySnapshot(initial);
    const initialNonMonetaryDigest = nonMonetaryDigest(initial);
    assert.ok(Object.keys(baseline.centsByCell).length > 0, "No se encontraron celdas monetarias válidas.");

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const workingCopy = JSON.parse(fs.readFileSync(temporaryCache, "utf8"));
      const beforeSave = monetarySnapshot(workingCopy, { normalize: true });
      assert.deepStrictEqual(beforeSave.centsByCell, baseline.centsByCell);

      atomicWriteJson(temporaryCache, workingCopy);
      const reloaded = JSON.parse(fs.readFileSync(temporaryCache, "utf8"));
      const afterReload = monetarySnapshot(reloaded);

      assert.deepStrictEqual(
        afterReload.centsByCell,
        baseline.centsByCell,
        `El ciclo ${cycle} modificó centavos.`
      );
      assert.strictEqual(
        nonMonetaryDigest(reloaded),
        initialNonMonetaryDigest,
        `El ciclo ${cycle} modificó datos no monetarios.`
      );
    }

    assert.strictEqual(fileHash(SOURCE_CACHE), sourceHashBefore);
    console.log(JSON.stringify({
      sourceUntouched: true,
      cycles: 3,
      stableMonetaryCells: Object.keys(baseline.centsByCell).length,
      invalidClassifiedCellsPreserved: baseline.invalidClassifiedCells
    }));
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
