const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  LOCAL_FROZEN,
  SITES_CANONICAL,
  createOperationalCutoverService,
  initialState,
  readCutoverState,
  transitionCutoverState,
  writeCutoverState
} = require("../backend/services/operational-cutover.service");

const DIGEST = "a".repeat(64);

test("Local cutover guard is fail-closed, audited and preserves read-only helpers", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "erp-cutover-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, "state.json");
  const auditFile = path.join(directory, "events.jsonl");
  const service = createOperationalCutoverService({ stateFile, auditFile, logError: () => {} });

  assert.equal(service.getPublicState().canonicalSource, "local");
  assert.equal(service.mutationBlock("POST", "/api/treasury/payments"), null);
  writeCutoverState(stateFile, auditFile, initialState());

  const frozenAt = "2026-08-05T15:00:00.000Z";
  const frozen = transitionCutoverState(initialState(), {
    toMode: LOCAL_FROZEN,
    occurredAt: frozenAt,
    taskId: "ERP-CUT-20260805-20",
    runId: "cutover-test",
    evidence: { frozenAt, sourceHash: DIGEST }
  });
  writeCutoverState(stateFile, auditFile, frozen);

  assert.equal(readCutoverState(stateFile, auditFile).valid, true);
  assert.equal(service.getPublicState().canonicalSource, "none");
  assert.equal(service.mutationBlock("GET", "/api/treasury/payments"), null);
  assert.equal(service.mutationBlock("POST", "/api/backend/sql"), null);
  assert.equal(service.mutationBlock("POST", "/api/treasury/payments").code, "LOCAL_CUTOVER_FROZEN");

  const activatedAt = "2026-08-05T15:10:00.000Z";
  const activated = transitionCutoverState(frozen, {
    toMode: SITES_CANONICAL,
    occurredAt: activatedAt,
    taskId: "ERP-CUT-20260805-20",
    runId: "cutover-test",
    evidence: { activatedAt }
  });
  writeCutoverState(stateFile, auditFile, activated);
  assert.equal(service.getPublicState().canonicalSource, "sites");
  assert.equal(service.mutationBlock("DELETE", "/api/admin/tables/clientes/1").code, "LOCAL_READ_ONLY_SITES_CANONICAL");

  fs.unlinkSync(stateFile);
  assert.equal(service.getPublicState().mode, "guard_error");
  assert.equal(service.mutationBlock("POST", "/api/app-state").code, "LOCAL_CUTOVER_STATE_INVALID");
});

test("tampering either state or append-only audit fails closed", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "erp-cutover-tamper-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, "state.json");
  const auditFile = path.join(directory, "events.jsonl");
  const frozenAt = "2026-08-05T15:00:00.000Z";
  const frozen = transitionCutoverState(initialState(), {
    toMode: LOCAL_FROZEN,
    occurredAt: frozenAt,
    taskId: "ERP-CUT-20260805-20",
    runId: "cutover-test",
    evidence: { frozenAt }
  });
  writeCutoverState(stateFile, auditFile, frozen);

  fs.appendFileSync(auditFile, `${JSON.stringify({ hash: "tampered" })}\n`);
  const service = createOperationalCutoverService({ stateFile, auditFile, logError: () => {} });
  assert.equal(service.getPublicState().mode, "guard_error");
  assert.equal(service.mutationBlock("PATCH", "/api/admin/tables/clientes/cell").status, 423);
});

test("Local exposes its read-only source banner before requesting credentials", () => {
  const index = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const access = fs.readFileSync(path.join(__dirname, "../assets/js/modules/access.js"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../assets/css/styles.css"), "utf8");

  assert.ok(index.indexOf('id="operational-source-banner"') < index.indexOf('id="auth-screen"'));
  assert.ok(access.indexOf("await loadOperationalState();") < access.indexOf('nativeFetch("/api/auth/session"'));
  assert.match(styles, /\.auth-pending\.local-read-only-active \.auth-screen\s*\{[\s\S]*min-height:/);
});
