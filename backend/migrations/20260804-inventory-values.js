const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { BACKEND_CACHE_FILE, ROOT_DIR } = require("../config/paths");
const { EXPECTED_BACKEND_COLUMNS } = require("../config/backend-columns");
const { createIncomeCalculationService } = require("../services/income-calculation.service");
const { createInventoryValuationService } = require("../services/inventory-valuation.service");
const { backendGroupRowsById, backendId, backendRowsById } = require("../utils/ids");
const { backendInventoryQuantity } = require("../utils/inventory-numbers");
const { fromCents, multiplyCents, toCents } = require("../../shared/money");

const REPAIR_ID = "ERP-INV-20260804-05";
const BARRA_POP_RECIPE_ID = "6";
const BARRA_POP_GRANEL_KG_PER_UNIT = 0.0165;
const DEFAULT_EVIDENCE_DIR = path.join(ROOT_DIR, "tmp", "repair-backups", REPAIR_ID);

function createCanonicalValuationService() {
  const calculations = createIncomeCalculationService({
    backendGroupRowsById,
    backendId,
    backendInventoryQuantity,
    backendRowsById
  });
  return createInventoryValuationService({
    backendGroupRowsById,
    backendId,
    backendInventoryQuantity,
    backendIsoDate: calculations.backendIsoDate,
    backendLatestSupplyCostMap: calculations.backendLatestSupplyCostMap,
    backendNormalizeText: calculations.backendNormalizeText,
    backendNumber: calculations.backendNumber,
    backendRecipeQuantity: calculations.backendRecipeQuantity,
    backendRowsById,
    backendTurnRank: calculations.backendTurnRank,
    expectedBackendColumns: EXPECTED_BACKEND_COLUMNS
  });
}

function buildInventoryValueBackfill(cache) {
  const valuationCache = structuredClone(cache);
  const recipeCorrection = applyBarraPopRecipeCorrection(valuationCache);
  const valuation = createCanonicalValuationService()
    .calculateBackendInventoryValuations(valuationCache, null, {
      allowStoredDetailCostFallback: false,
      requireHistoricalEvidence: true
    });
  const differences = valuation.inventories
    .map((row) => {
      const beforeCents = toCents(row.storedValue);
      const afterCents = toCents(row.value);
      return {
        id: row.inventoryId,
        date: row.date,
        turn: row.turn,
        before: fromCents(beforeCents),
        after: fromCents(afterCents),
        difference: fromCents(afterCents - beforeCents),
        beforeCents,
        afterCents
      };
    });
  const missingCosts = valuation.issues.filter((issue) => issue.code === "MISSING_COST");
  const unsupportedCostSources = valuation.issues.filter((issue) => issue.code === "UNSUPPORTED_COST_SOURCE");
  const issuesByInventory = backendGroupRowsById(valuation.issues, "inventoryId");
  const omittedInventoryIds = new Set(valuation.issues.map((issue) => issue.inventoryId));
  const eligibleInventoryIds = new Set(valuation.inventories
    .map((row) => row.inventoryId)
    .filter((inventoryId) => !omittedInventoryIds.has(inventoryId)));
  const eligibleDifferences = differences.filter((row) => eligibleInventoryIds.has(row.id));
  const inventoryChanges = eligibleDifferences.filter((row) => row.afterCents !== row.beforeCents);
  const detailDifferences = valuation.inventories.flatMap((inventory) => inventory.details.map((detail) => {
    const beforeUnitCostCents = toCents(detail.detail.costo_unitario_usado);
    const afterUnitCostCents = toCents(detail.unitCost);
    const beforeValueCents = toCents(detail.detail.valor_total);
    const afterValueCents = toCents(detail.value);
    return {
      id: detail.detailId,
      inventoryId: inventory.inventoryId,
      itemId: detail.itemId,
      date: inventory.date,
      turn: inventory.turn,
      beforeUnitCost: fromCents(beforeUnitCostCents),
      afterUnitCost: fromCents(afterUnitCostCents),
      beforeValue: fromCents(beforeValueCents),
      afterValue: fromCents(afterValueCents),
      unitCostDifferenceCents: afterUnitCostCents - beforeUnitCostCents,
      valueDifferenceCents: afterValueCents - beforeValueCents
    };
  }));
  const eligibleDetailDifferences = detailDifferences.filter((row) => eligibleInventoryIds.has(row.inventoryId));
  const detailChanges = eligibleDetailDifferences.filter((row) => (
    row.unitCostDifferenceCents !== 0 || row.valueDifferenceCents !== 0
  ));
  const resultCache = structuredClone(valuationCache);
  const resultInventoriesById = new Map((resultCache.tables?.inventarios?.rows || [])
    .map((row) => [backendId(row.id_inventario), row]));
  const resultDetailsById = new Map((resultCache.tables?.detalle_inventarios?.rows || [])
    .map((row) => [backendId(row.id_detalle_inventario), row]));
  inventoryChanges.forEach((change) => {
    const row = resultInventoriesById.get(change.id);
    if (row) row.valor_total = change.after;
  });
  detailChanges.forEach((change) => {
    const row = resultDetailsById.get(change.id);
    if (!row) return;
    row.costo_unitario_usado = change.afterUnitCost;
    row.valor_total = change.afterValue;
  });

  const beforeCounts = tableCounts(cache);
  const afterCounts = tableCounts(resultCache);
  const nonDerivedBefore = logicalNonDerivedHash(cache, { ignoreBarraPopRecipeQuantity: true });
  const nonDerivedAfter = logicalNonDerivedHash(resultCache, { ignoreBarraPopRecipeQuantity: true });
  if (JSON.stringify(beforeCounts) !== JSON.stringify(afterCounts)) {
    throw repairError("INVENTORY_BACKFILL_COUNT_DRIFT", "El backfill alteraria conteos de tablas.");
  }
  if (nonDerivedBefore !== nonDerivedAfter) {
    throw repairError("INVENTORY_BACKFILL_SCOPE_DRIFT", "El backfill alteraria datos distintos de los tres campos derivados autorizados.");
  }
  assertPersistedInventoryInvariants(resultCache, eligibleInventoryIds);
  const changedInventories = new Set(detailChanges.map((row) => row.inventoryId));
  inventoryChanges.forEach((row) => changedInventories.add(row.id));
  const sortedDates = [...inventoryChanges, ...detailChanges].map((row) => row.date).filter(Boolean).sort();
  const sortedIds = [...changedInventories].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const missingCostGroups = groupMissingCosts(missingCosts, valuation.inventories);
  const report = {
    repairId: REPAIR_ID,
    idempotent: !recipeCorrection.changed && inventoryChanges.length === 0 && detailChanges.length === 0,
    recipeCorrection,
    changedRows: inventoryChanges.length,
    changedInventoryRows: inventoryChanges.length,
    changedDetailRows: detailChanges.length,
    inventoryIds: {
      first: sortedIds[0] ?? null,
      last: sortedIds.at(-1) ?? null
    },
    dateRange: {
      from: sortedDates[0] || "",
      to: sortedDates.at(-1) || ""
    },
    totals: {
      before: fromCents(eligibleDifferences.reduce((total, row) => total + row.beforeCents, 0)),
      after: fromCents(eligibleDifferences.reduce((total, row) => total + row.afterCents, 0)),
      difference: fromCents(eligibleDifferences.reduce((total, row) => total + row.afterCents - row.beforeCents, 0))
    },
    largestDifferences: inventoryChanges
      .slice()
      .sort((left, right) => Math.abs(right.afterCents - right.beforeCents) - Math.abs(left.afterCents - left.beforeCents))
      .slice(0, 12)
      .map(publicChange),
    inventory1742: inventoryAuditSummary(valuation.inventories, "1742"),
    inventory1744: inventoryChanges.find((row) => row.id === "1744")
      ? publicChange(inventoryChanges.find((row) => row.id === "1744"))
      : currentInventorySummary(valuation.inventories, "1744"),
    diagnostics: {
      missingCostRows: missingCosts.length,
      missingCostsByItem: missingCostGroups,
      unsupportedCostSourceRows: unsupportedCostSources.length,
      eligibleInventories: eligibleInventoryIds.size,
      omittedInventories: omittedInventoryIds.size,
      omittedInventoryRows: valuation.inventories
        .filter((row) => omittedInventoryIds.has(row.inventoryId))
        .map((row) => ({
          id: row.inventoryId,
          date: row.date,
          turn: row.turn,
          issues: (issuesByInventory.get(row.inventoryId) || []).map((issue) => ({
            itemId: issue.itemId,
            detailId: issue.detailId,
            code: issue.code
          }))
        })),
      storedDetailCostFallbackRows: 0,
      negativeQuantityRows: valuation.issues.filter((issue) => issue.code === "NEGATIVE_QUANTITY").length,
      invalidQuantityRows: valuation.issues.filter((issue) => issue.code === "INVALID_QUANTITY").length,
      nonFiniteValues: valuation.issues.filter((issue) => issue.code === "NON_FINITE_VALUE").length,
      note: "Cada inventario es atomico: cualquier detalle no demostrable omite el inventario completo; los elegibles no usan costos futuros ni fallback persistido."
    },
    tableCountsBefore: beforeCounts,
    tableCountsAfter: afterCounts,
    logicalNonDerivedHashBefore: nonDerivedBefore,
    logicalNonDerivedHashAfter: nonDerivedAfter
  };
  return {
    cache: resultCache,
    report,
    changes: inventoryChanges.map(publicChange),
    detailChanges: detailChanges.map(publicDetailChange)
  };
}

function applyBarraPopRecipeCorrection(cache) {
  const recipe = (cache.tables?.recetas?.rows || []).find((row) => backendId(row.id_receta) === BARRA_POP_RECIPE_ID);
  if (!recipe) {
    throw repairError("INVENTORY_RECIPE_MISSING", `No se encontro la receta ${BARRA_POP_RECIPE_ID}.`);
  }
  if (backendId(recipe.id_item_resultado) !== "3" || backendId(recipe.id_item_componente) !== "4") {
    throw repairError("INVENTORY_RECIPE_IDENTITY_DRIFT", "La receta 6 ya no corresponde a Barra_Pop y Granel Dulce.");
  }
  const before = Number(String(recipe.cantidad_componente).replace(",", "."));
  if (!Number.isFinite(before) || (before !== 0.02 && before !== BARRA_POP_GRANEL_KG_PER_UNIT)) {
    throw repairError("INVENTORY_RECIPE_VALUE_DRIFT", `La receta 6 tiene un valor inesperado: ${recipe.cantidad_componente}.`);
  }
  recipe.cantidad_componente = BARRA_POP_GRANEL_KG_PER_UNIT;
  return {
    idReceta: BARRA_POP_RECIPE_ID,
    itemResultado: "3",
    itemComponente: "4",
    unidadBase: recipe.unidad_base || "Kg",
    before,
    after: BARRA_POP_GRANEL_KG_PER_UNIT,
    changed: before !== BARRA_POP_GRANEL_KG_PER_UNIT
  };
}

function runInventoryValueBackfill(command = "dry-run", options = {}) {
  if (!["dry-run", "apply", "restore"].includes(command)) {
    throw repairError("INVENTORY_BACKFILL_COMMAND_INVALID", `Comando invalido: ${command}.`);
  }
  const cacheFile = path.resolve(options.cacheFile || BACKEND_CACHE_FILE);
  const evidenceDir = path.resolve(options.evidenceDir || DEFAULT_EVIDENCE_DIR);
  if (command === "restore") return restoreInventoryValueBackup(cacheFile, options.backupFile, evidenceDir);

  const sourceBuffer = fs.readFileSync(cacheFile);
  const sourceStat = fs.statSync(cacheFile);
  const sourceSha256 = sha256(sourceBuffer);
  const sourceCache = JSON.parse(sourceBuffer.toString("utf8"));
  const result = buildInventoryValueBackfill(sourceCache);
  const resultBuffer = Buffer.from(JSON.stringify(result.cache, null, 2), "utf8");
  const backupFile = path.resolve(options.backupFile || path.join(
    evidenceDir,
    `backend-data-cache.before-${sourceSha256.slice(0, 12)}.json`
  ));
  const auditFile = path.resolve(options.auditFile || path.join(evidenceDir, "inventory-value-backfill-audit.json"));
  const execution = {
    command,
    source: {
      path: cacheFile,
      bytes: sourceStat.size,
      mtime: sourceStat.mtime.toISOString(),
      sha256: sourceSha256
    },
    resultSha256: sha256(resultBuffer),
    backupFile,
    auditFile,
    report: result.report
  };
  if (command === "dry-run" || result.report.idempotent) return execution;

  const backup = ensureVerifiedBackup(sourceBuffer, backupFile, execution.resultSha256);
  execution.backup = backup;
  let replaced = false;
  try {
    if (sha256(fs.readFileSync(cacheFile)) !== sourceSha256) {
      throw repairError("INVENTORY_BACKFILL_SOURCE_DRIFT", "El cache cambio despues del dry-run interno.");
    }
    writeAtomic(cacheFile, resultBuffer);
    replaced = true;
    if (typeof options.afterWrite === "function") options.afterWrite({ cacheFile, execution });
    const persistedBuffer = fs.readFileSync(cacheFile);
    if (sha256(persistedBuffer) !== execution.resultSha256) {
      throw repairError("INVENTORY_BACKFILL_WRITE_MISMATCH", "La escritura atomica no coincide con el resultado calculado.");
    }
    const persisted = JSON.parse(persistedBuffer.toString("utf8"));
    const secondPass = buildInventoryValueBackfill(persisted);
    if (!secondPass.report.idempotent || secondPass.report.changedRows !== 0) {
      throw repairError("INVENTORY_BACKFILL_NOT_IDEMPOTENT", "El segundo dry-run posterior todavia propone cambios.");
    }
    execution.postApplyDryRun = secondPass.report;
    writeAtomic(auditFile, Buffer.from(JSON.stringify(execution, null, 2), "utf8"));
    return execution;
  } catch (error) {
    if (replaced && sha256(fs.readFileSync(cacheFile)) === execution.resultSha256) {
      writeAtomic(cacheFile, fs.readFileSync(backupFile));
    }
    throw error;
  }
}

function ensureVerifiedBackup(sourceBuffer, backupFile, appliedSha256 = "") {
  fs.mkdirSync(path.dirname(backupFile), { recursive: true });
  if (!fs.existsSync(backupFile)) fs.writeFileSync(backupFile, sourceBuffer, { flag: "wx" });
  const backupBuffer = fs.readFileSync(backupFile);
  const sourceHash = sha256(sourceBuffer);
  if (sha256(backupBuffer) !== sourceHash) {
    throw repairError("INVENTORY_BACKFILL_BACKUP_MISMATCH", "El backup existente no coincide con el cache fuente.");
  }
  JSON.parse(backupBuffer.toString("utf8"));
  const stat = fs.statSync(backupFile);
  const manifest = {
    repairId: REPAIR_ID,
    path: backupFile,
    bytes: stat.size,
    mtime: stat.mtime.toISOString(),
    sha256: sourceHash,
    appliedSha256
  };
  writeAtomic(`${backupFile}.manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
  return manifest;
}

function restoreInventoryValueBackup(cacheFile, backupFile, evidenceDir = DEFAULT_EVIDENCE_DIR) {
  const resolvedBackup = backupFile
    ? path.resolve(backupFile)
    : newestBackupFile(evidenceDir);
  if (!resolvedBackup || !fs.existsSync(resolvedBackup)) {
    throw repairError("INVENTORY_BACKFILL_BACKUP_MISSING", "No se encontro un backup para restaurar.");
  }
  const manifestFile = `${resolvedBackup}.manifest.json`;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const backupBuffer = fs.readFileSync(resolvedBackup);
  if (manifest.repairId !== REPAIR_ID || manifest.sha256 !== sha256(backupBuffer)) {
    throw repairError("INVENTORY_BACKFILL_BACKUP_INVALID", "El backup o su manifiesto no son validos.");
  }
  JSON.parse(backupBuffer.toString("utf8"));
  const currentSha256 = sha256(fs.readFileSync(cacheFile));
  if (currentSha256 === manifest.sha256) {
    return { command: "restore", cacheFile, backup: manifest, restored: false, idempotent: true, restoredSha256: currentSha256 };
  }
  const auditFile = path.join(path.resolve(evidenceDir), "inventory-value-backfill-audit.json");
  const auditedAppliedSha256 = fs.existsSync(auditFile)
    ? String(JSON.parse(fs.readFileSync(auditFile, "utf8")).resultSha256 || "")
    : "";
  const expectedAppliedSha256 = String(manifest.appliedSha256 || auditedAppliedSha256 || "");
  if (!expectedAppliedSha256 || currentSha256 !== expectedAppliedSha256) {
    throw repairError(
      "INVENTORY_BACKFILL_RESTORE_TARGET_DRIFT",
      "El cache cambio despues del backfill; restore no puede sobrescribir datos posteriores."
    );
  }
  writeAtomic(cacheFile, backupBuffer);
  return { command: "restore", cacheFile, backup: manifest, restored: true, idempotent: false, restoredSha256: sha256(fs.readFileSync(cacheFile)) };
}

function groupMissingCosts(issues, inventories) {
  const inventoryById = new Map(inventories.map((row) => [row.inventoryId, row]));
  const groups = new Map();
  issues.forEach((issue) => {
    if (!groups.has(issue.itemId)) groups.set(issue.itemId, { itemId: issue.itemId, rows: 0, dates: [] });
    const group = groups.get(issue.itemId);
    group.rows += 1;
    const date = inventoryById.get(issue.inventoryId)?.date;
    if (date) group.dates.push(date);
  });
  return [...groups.values()].map((group) => ({
    itemId: group.itemId,
    rows: group.rows,
    dateFrom: group.dates.sort()[0] || "",
    dateTo: group.dates.sort().at(-1) || ""
  }));
}

function currentInventorySummary(inventories, inventoryId) {
  const row = inventories.find((candidate) => candidate.inventoryId === inventoryId);
  return row ? { id: row.inventoryId, date: row.date, turn: row.turn, before: row.storedValue, after: row.value, difference: 0 } : null;
}

function inventoryAuditSummary(inventories, inventoryId) {
  const row = inventories.find((candidate) => candidate.inventoryId === inventoryId);
  if (!row) return null;
  const bobina = row.details.find((detail) => detail.itemId === "8");
  return {
    id: row.inventoryId,
    date: row.date,
    turn: row.turn,
    before: row.storedValue,
    after: row.value,
    bobinaBarraPop: bobina ? {
      detailId: bobina.detailId,
      quantity: bobina.quantity,
      unitCost: bobina.unitCost,
      value: bobina.value
    } : null
  };
}

function publicChange(row) {
  return { id: row.id, date: row.date, turn: row.turn, before: row.before, after: row.after, difference: row.difference };
}

function publicDetailChange(row) {
  return {
    id: row.id,
    inventoryId: row.inventoryId,
    itemId: row.itemId,
    date: row.date,
    turn: row.turn,
    beforeUnitCost: row.beforeUnitCost,
    afterUnitCost: row.afterUnitCost,
    beforeValue: row.beforeValue,
    afterValue: row.afterValue
  };
}

function assertPersistedInventoryInvariants(cache, inventoryIds = null) {
  const detailsByInventory = backendGroupRowsById(cache.tables?.detalle_inventarios?.rows || [], "id_inventario");
  (cache.tables?.inventarios?.rows || []).forEach((inventory) => {
    const inventoryId = backendId(inventory.id_inventario);
    if (inventoryIds && !inventoryIds.has(inventoryId)) return;
    const detailTotalCents = (detailsByInventory.get(inventoryId) || []).reduce((total, detail) => {
      const expectedValueCents = multiplyCents(detail.costo_unitario_usado, Number(detail.cantidad || 0));
      const storedValueCents = toCents(detail.valor_total);
      if (expectedValueCents !== storedValueCents) {
        throw repairError(
          "INVENTORY_BACKFILL_DETAIL_INVARIANT",
          `El detalle ${backendId(detail.id_detalle_inventario)} no coincide con cantidad por costo unitario.`
        );
      }
      return total + storedValueCents;
    }, 0);
    if (toCents(inventory.valor_total) !== detailTotalCents) {
      throw repairError(
        "INVENTORY_BACKFILL_HEADER_INVARIANT",
        `El inventario ${inventoryId} no coincide con la suma persistida de sus detalles.`
      );
    }
  });
}

function tableCounts(cache) {
  return Object.fromEntries(Object.entries(cache.tables || {})
    .map(([name, table]) => [name, Array.isArray(table?.rows) ? table.rows.length : 0]));
}

function logicalNonDerivedHash(cache, options = {}) {
  const copy = structuredClone(cache);
  (copy.tables?.inventarios?.rows || []).forEach((row) => { delete row.valor_total; });
  (copy.tables?.detalle_inventarios?.rows || []).forEach((row) => {
    delete row.costo_unitario_usado;
    delete row.valor_total;
  });
  if (options.ignoreBarraPopRecipeQuantity) {
    (copy.tables?.recetas?.rows || []).forEach((row) => {
      if (backendId(row.id_receta) === BARRA_POP_RECIPE_ID) delete row.cantidad_componente;
    });
  }
  return sha256(Buffer.from(JSON.stringify(copy), "utf8"));
}

function newestBackupFile(evidenceDir) {
  if (!fs.existsSync(evidenceDir)) return "";
  return fs.readdirSync(evidenceDir)
    .filter((name) => /^backend-data-cache\.before-[a-f0-9]+\.json$/i.test(name))
    .map((name) => path.join(evidenceDir, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0] || "";
}

function writeAtomic(file, buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempFile, buffer, { flag: "wx" });
    fs.renameSync(tempFile, file);
  } finally {
    if (fs.existsSync(tempFile)) fs.rmSync(tempFile, { force: true });
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function repairError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

if (require.main === module) {
  try {
    const result = runInventoryValueBackfill(process.argv[2] || "dry-run", {
      backupFile: process.argv[3]
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: error.code || "INVENTORY_BACKFILL_FAILED",
      error: error.message,
      issueCount: error.issueCount,
      missingCostsByItem: error.missingCostsByItem,
      dryRun: error.dryRun
    }, null, 2));
    process.exitCode = 1;
  }
}

module.exports = {
  BARRA_POP_GRANEL_KG_PER_UNIT,
  BARRA_POP_RECIPE_ID,
  REPAIR_ID,
  buildInventoryValueBackfill,
  createCanonicalValuationService,
  ensureVerifiedBackup,
  logicalNonDerivedHash,
  restoreInventoryValueBackup,
  runInventoryValueBackfill,
  tableCounts
};
