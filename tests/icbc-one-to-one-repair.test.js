const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createBankMatchingService } = require("../backend/services/bank-matching.service");
const { createBankParserService } = require("../backend/services/bank-parser.service");
const { createBankPersistenceService } = require("../backend/services/bank-persistence.service");
const { createBankReconciliationService } = require("../backend/services/bank-reconciliation.service");
const {
  ASSIGNMENTS,
  PRESERVED,
  repairIcBcOneToOne,
  restoreBackup
} = require("../backend/migrations/20260728-icbc-one-to-one-repair");

const backendId = (value) => String(value ?? "").trim();
const backendNumber = (value) => Number(value) || 0;
const normalize = (value) => String(value ?? "").trim().toLowerCase();
const table = (rows) => ({ rows, rowCount: rows.length });

function repairFixture() {
  const movements = [
    ...PRESERVED.map(({ movementId, paymentId, concept, cents }) => movement(movementId, paymentId, concept, cents)),
    ...ASSIGNMENTS.map(({ movementId, fromPaymentId, concept, cents }) => movement(movementId, fromPaymentId, concept, cents))
  ];
  const pairs = [
    [5814, 5815, 2590.85, 7816, "14"],
    [5835, 5837, 100766.46, 7842, "11"],
    [5838, 5840, 2173.32, 7844, "11"]
  ];
  return {
    tables: {
      movimientos_bancarios: table(movements),
      pagos: table(pairs.flatMap(([left, right, amount]) => [
        { id_pago: left, banco: "ICBC", monto: amount },
        { id_pago: right, banco: "ICBC", monto: amount }
      ])),
      detalle_pagos: table(pairs.flatMap(([left, right, amount, expense], pairIndex) => [
        { id_detalle_pago: pairIndex * 2 + 1, id_pago: left, id_egreso: expense, monto_cancelado: amount },
        { id_detalle_pago: pairIndex * 2 + 2, id_pago: right, id_egreso: expense, monto_cancelado: amount }
      ])),
      egresos: table(pairs.map(([, , , id_egreso, id_etiqueta]) => ({ id_egreso, id_etiqueta })))
    }
  };
}

function movement(id, paymentId, concept, cents) {
  const amount = cents / 100;
  return {
    id_movimiento_bancario: id,
    banco: "ICBC",
    concepto: concept,
    detalle: concept,
    debito: amount,
    importe: -amount,
    id_pago: String(paymentId),
    id_cobro: ""
  };
}

test("la reparación reasigna sólo los tres id_pago y es idempotente", () => {
  const source = repairFixture();
  const before = JSON.parse(JSON.stringify(source));
  const first = repairIcBcOneToOne(source);
  assert.deepEqual(first.report.changes.map(({ id, before: oldId, after }) => [id, oldId, after]), [
    [8, "5814", "5815"],
    [95, "5835", "5837"],
    [99, "5838", "5840"]
  ]);
  assert.deepEqual(source, before);
  const second = repairIcBcOneToOne(first.cache);
  assert.equal(second.report.idempotent, true);
  assert.deepEqual(second.cache, first.cache);
});

test("la reparación aborta sin estado parcial si una precondición deriva", () => {
  const source = repairFixture();
  source.tables.pagos.rows.find((row) => row.id_pago === 5840).monto = 1;
  const before = JSON.parse(JSON.stringify(source));
  assert.throws(() => repairIcBcOneToOne(source), /PAYMENT_SIGNATURE_DRIFT/);
  assert.deepEqual(source, before);
});

test("restore rechaza deriva posterior sin cambiar un byte", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "erp-tes-restore-"));
  const cacheFile = path.join(directory, "cache.json");
  const backupFile = path.join(directory, "backup.json");
  const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();
  try {
    fs.writeFileSync(backupFile, JSON.stringify({ state: "before" }));
    fs.writeFileSync(cacheFile, JSON.stringify({ state: "applied" }));
    const sourceHash = hash(backupFile);
    const appliedHash = hash(cacheFile);
    assert.equal(restoreBackup(cacheFile, backupFile, sourceHash, appliedHash).restored, true);
    assert.equal(hash(cacheFile), sourceHash);
    fs.writeFileSync(cacheFile, JSON.stringify({ state: "later-operation" }));
    const beforeBytes = fs.readFileSync(cacheFile);
    assert.throws(
      () => restoreBackup(cacheFile, backupFile, sourceHash, appliedHash),
      /RESTORE_TARGET_DRIFT/
    );
    assert.deepEqual(fs.readFileSync(cacheFile), beforeBytes);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function matchingService() {
  return createBankMatchingService({
    backendNormalizeText: normalize,
    backendNumber,
    bankDateDistance: () => 0,
    bankTextOverlapScore: (left, right) => {
      const tokens = new Set(normalize(left).split(/\W+/).filter(Boolean));
      return normalize(right).split(/\W+/).filter((token) => tokens.has(token)).length;
    },
    normalizeBankCuit: normalize
  });
}

test("el matching usa detalle y deja pendiente un empate real", () => {
  const matching = matchingService();
  const movement = { date: "2026-07-20", detail: "IMP S/CRED CT", provider: "Estado" };
  const candidates = [
    { id: "1", date: "2026-07-20", amount: 100, party: "Estado", description: "IMP S/CRED CT" },
    { id: "2", date: "2026-07-20", amount: 100, party: "Estado", description: "SIRCREB" }
  ];
  assert.equal(matching.bestBankMatch(movement, candidates, 100, { requireIdentity: true }).id, "1");
  assert.equal(matching.bestBankMatch(movement, [
    { ...candidates[0], id: "1", description: "" },
    { ...candidates[0], id: "2", description: "" }
  ], 100, { requireIdentity: true, rejectTies: true }), null);
});

function parserService() {
  const matching = matchingService();
  return createBankParserService({
    backendIsoDate: (value) => value,
    backendNormalizeText: normalize,
    backendNumber,
    bankManualCheckDepositMatch: () => null,
    bankMovementBackendCreditorId: () => "32",
    bankSourceDestinationForOriginType: () => ({}),
    bestBankMatch: matching.bestBankMatch,
    bestBankSourceMatch: () => null,
    compactBankText: String,
    consumePersistedBankMovement: () => null,
    exactPendingExpenseMatch: () => null,
    extractBankCheckNumber: () => "",
    extractBankCuit: () => "",
    identifyBankCounterparty: () => ({ name: "Estado", idEtiqueta: "11", type: "datos_bancarios" }),
    normalizeBankCheckNumber: String,
    normalizeBankCuit: normalize,
    uniqueExactBankMatch: matching.uniqueExactBankMatch
  });
}

test("dos movimientos y dos pagos se consumen uno-a-uno, aun con orden inverso", () => {
  const parser = parserService();
  const payments = [
    { type: "pago", id: "10", date: "2026-07-20", amount: 100, direction: "debito", party: "Estado", description: "IMP S/CRED CT" },
    { type: "pago", id: "11", date: "2026-07-20", amount: 100, direction: "debito", party: "Estado", description: "SIRCREB" }
  ];
  const movements = [
    { date: "2026-07-20", amount: -100, detail: "IMP S/CRED CT" },
    { date: "2026-07-20", amount: -100, detail: "SIRCREB" }
  ];
  const assign = (rows) => {
    const used = new Set();
    return Object.fromEntries([...rows].sort((left, right) => left.detail.localeCompare(right.detail)).map((row) => {
      const analyzed = parser.analyzeBankMovement(row, payments, [], [], [], [], new Map(), [], new Map(), new Map(), [], "ICBC", used);
      return [row.detail, analyzed.match?.id || ""];
    }));
  };
  assert.deepEqual(assign(movements), assign([...movements].reverse()));
  assert.deepEqual(assign(movements), { "IMP S/CRED CT": "10", SIRCREB: "11" });
});

test("un pago persistido queda excluido y persistencia rechaza muchos-a-uno", () => {
  const parser = parserService();
  const used = new Set(["10"]);
  const analyzed = parser.analyzeBankMovement(
    { date: "2026-07-20", amount: -100, detail: "IMP S/CRED CT" },
    [
      { type: "pago", id: "10", date: "2026-07-20", amount: 100, direction: "debito", party: "Estado", description: "IMP S/CRED CT" },
      { type: "pago", id: "11", date: "2026-07-20", amount: 100, direction: "debito", party: "Estado", description: "SIRCREB" }
    ],
    [], [], [], [], new Map(), [], new Map(), new Map(), [], "ICBC", used
  );
  assert.notEqual(analyzed.match?.id, "10");

  const persistence = createBankPersistenceService({
    backendId,
    cleanBackendText: (value) => String(value ?? "").trim(),
    ensureBackendTable: (tables, name) => { tables[name] ||= table([]); }
  });
  const tables = {
    pagos: table([{ id_pago: 10 }]),
    movimientos_bancarios: table([
      { id_movimiento_bancario: 1, id_pago: "10", id_cobro: "" },
      { id_movimiento_bancario: 2, id_pago: "", id_cobro: "" }
    ])
  };
  assert.throws(
    () => persistence.persistBankMovement(tables, {
      canonicalMovementId: 2,
      match: { type: "pago", id: 10 }
    }, "ICBC"),
    /ya esta asociado/
  );
});

test("el reporte integrado asigna pagos una sola vez y es estable ante orden físico inverso", () => {
  const matching = createBankMatchingService({
    backendBankMatches: () => true,
    backendExpenseCounterpartyInfo: (expense) => ({ name: "Estado", cuit: "", detail: expense.detalle }),
    backendGroupRowsById: (rows, key) => {
      const groups = new Map();
      (rows || []).forEach((row) => {
        const id = backendId(row[key]);
        groups.set(id, [...(groups.get(id) || []), row]);
      });
      return groups;
    },
    backendId,
    backendIsoDate: String,
    backendNormalizeText: normalize,
    backendNumber,
    backendRowsById: (rows, key) => new Map((rows || []).map((row) => [backendId(row[key]), row])),
    bankDateDistance: () => 0,
    bankTextOverlapScore: (left, right) => {
      const tokens = new Set(normalize(left).split(/\W+/).filter(Boolean));
      return normalize(right).split(/\W+/).filter((token) => tokens.has(token)).length;
    },
    compactBankText: (value) => String(value ?? "").trim(),
    normalizeBankCuit: normalize
  });
  const parser = createBankParserService({
    backendIsoDate: String,
    backendNormalizeText: normalize,
    backendNumber,
    bankManualCheckDepositMatch: () => null,
    bankMovementBackendCreditorId: () => "32",
    bankSourceDestinationForOriginType: () => ({}),
    bestBankMatch: matching.bestBankMatch,
    bestBankSourceMatch: () => null,
    compactBankText: String,
    consumePersistedBankMovement: () => null,
    exactPendingExpenseMatch: () => null,
    identifyBankCounterparty: () => ({ name: "Estado", idEtiqueta: "11", type: "datos_bancarios" }),
    normalizeBankCheckNumber: String,
    normalizeBankCuit: normalize,
    uniqueExactBankMatch: matching.uniqueExactBankMatch
  });
  const base = {
    tables: {
      movimientos_bancarios: table([
        { id_movimiento_bancario: 1, banco: "ICBC", fecha: "2026-07-20", detalle: "IMP S/CRED CT", concepto: "IMP S/CRED CT", importe: -100, debito: 100, credito: 0, id_pago: "", id_cobro: "", _bankMovementKey: "b" },
        { id_movimiento_bancario: 2, banco: "ICBC", fecha: "2026-07-20", detalle: "SIRCREB", concepto: "SIRCREB", importe: -100, debito: 100, credito: 0, id_pago: "", id_cobro: "", _bankMovementKey: "a" },
        { id_movimiento_bancario: 3, banco: "ICBC", fecha: "2026-07-19", detalle: "persistido", concepto: "persistido", importe: -100, debito: 100, credito: 0, id_pago: "12", id_cobro: "", _bankMovementKey: "c" }
      ]),
      pagos: table([
        { id_pago: 10, fecha_pago: "2026-07-20", banco: "ICBC", monto: 100 },
        { id_pago: 11, fecha_pago: "2026-07-20", banco: "ICBC", monto: 100 },
        { id_pago: 12, fecha_pago: "2026-07-19", banco: "ICBC", monto: 100 }
      ]),
      detalle_pagos: table([
        { id_pago: 10, id_egreso: 20, monto_cancelado: 100 },
        { id_pago: 11, id_egreso: 21, monto_cancelado: 100 },
        { id_pago: 12, id_egreso: 20, monto_cancelado: 100 }
      ]),
      egresos: table([
        { id_egreso: 20, detalle: "IMP S/CRED CT", tipo_factura: "IMP S/CRED CT" },
        { id_egreso: 21, detalle: "SIRCREB", tipo_factura: "SIRCREB" }
      ]),
      datos_bancarios: table([])
    }
  };
  assert.equal(matching.backendBankPaymentCandidates(base.tables, "ICBC").length, 3);
  const build = (cache) => createBankReconciliationService({
    analyzeBankMovement: parser.analyzeBankMovement,
    backendBankCollectionCandidates: () => [],
    backendBankCreditPayableCandidates: () => [],
    backendBankIdentityIndex: () => [],
    backendBankPayableCandidates: () => [],
    backendBankPaymentCandidates: matching.backendBankPaymentCandidates,
    backendBankSourceCandidates: () => [],
    backendId,
    backendIssuedChecksByNumber: () => new Map(),
    backendNormalizeText: normalize,
    backendNumber,
    backendReceivedCheckDepositGroups: () => [],
    backendReceivedChecksByNumber: () => new Map(),
    bankMovementAssociation: (movement) => ({
      idPago: movement.match?.type === "pago" ? backendId(movement.match.id) : "",
      idCobro: movement.match?.type === "cobro" ? backendId(movement.match.id) : ""
    }),
    canonicalPendingBankMovements: (tables) => tables.movimientos_bancarios.rows
      .filter((row) => !backendId(row.id_pago))
      .map((row) => ({
        ...row,
        date: row.fecha,
        amount: row.importe,
        detail: row.detalle,
        concept: row.concepto,
        movementKey: row._bankMovementKey
      })),
    cleanBackendText: (value) => String(value ?? "").trim(),
    ensureBackendTable: (tables, name) => { tables[name] ||= table([]); },
    loadCache: () => cache,
    normalizeBackendBankDetails: () => {},
    seedDefaultBankDetails: () => {}
  }).buildBankReconciliationReport({}, cache);
  const direct = build(JSON.parse(JSON.stringify(base)));
  const reversedCache = JSON.parse(JSON.stringify(base));
  reversedCache.tables.movimientos_bancarios.rows.reverse();
  const reversed = build(reversedCache);
  const mapping = (report) => Object.fromEntries(report.movements.map((row) => [row.detail, row.match?.id || ""]));
  assert.equal(direct.movements.length, 2, JSON.stringify(direct.movements));
  assert.deepEqual(mapping(direct), { "IMP S/CRED CT": "10", SIRCREB: "11" });
  assert.deepEqual(mapping(reversed), mapping(direct));

  const tied = JSON.parse(JSON.stringify(base));
  tied.tables.egresos.rows.forEach((row) => { row.detalle = ""; row.tipo_factura = ""; });
  assert.deepEqual(mapping(build(tied)), { "IMP S/CRED CT": "", SIRCREB: "" });
});
