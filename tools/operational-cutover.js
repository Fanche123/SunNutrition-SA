const {
  OPERATIONAL_CUTOVER_AUDIT_FILE,
  OPERATIONAL_CUTOVER_STATE_FILE
} = require("../backend/config/paths");
const {
  LOCAL_CANONICAL,
  LOCAL_FROZEN,
  SITES_CANONICAL,
  initialState,
  publicState,
  readCutoverState,
  transitionCutoverState,
  writeCutoverState
} = require("../backend/services/operational-cutover.service");

const TASK_ID = "ERP-CUT-20260805-20";
const PROJECT_ID = "appgprj_6a720e1138508191a25317b67651208b";
const SITE_URL = "https://sunnutrition-erp-private.benjamindemayo.chatgpt.site";

function main() {
  const [command = "inspect", ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  if (command === "inspect") return printInspection();
  if (command === "initialize") return initialize();

  const loaded = readCutoverState(OPERATIONAL_CUTOVER_STATE_FILE, OPERATIONAL_CUTOVER_AUDIT_FILE);
  if (!loaded.valid) throw new Error(`Operational cutover state is not valid: ${loaded.error}`);
  const previous = loaded.state;
  if (command === "freeze") return freeze(previous, options);
  if (command === "activate-sites") return activateSites(previous, options);
  if (command === "abort-before-sites") return abortBeforeSites(previous, options);
  if (command === "complete-rollback") return completeRollback(previous, options);
  throw new Error(`Unknown command: ${command}`);
}

function printInspection() {
  const loaded = readCutoverState(OPERATIONAL_CUTOVER_STATE_FILE, OPERATIONAL_CUTOVER_AUDIT_FILE);
  if (loaded.valid) return printResult({ ok: true, valid: true, operational: publicState(loaded.state), stateHash: loaded.state.stateHash, eventHash: loaded.state.events.at(-1)?.hash || null });
  if (loaded.missing) return printResult({ ok: true, valid: true, initialized: false, operational: publicState(initialState()), stateHash: null, eventHash: null });
  throw new Error(`Operational cutover state is not valid: ${loaded.error}`);
}

function initialize() {
  const loaded = readCutoverState(OPERATIONAL_CUTOVER_STATE_FILE, OPERATIONAL_CUTOVER_AUDIT_FILE);
  if (loaded.valid) return printState(loaded.state, true);
  if (!loaded.missing) throw new Error(`Refusing to initialize over invalid cutover evidence: ${loaded.error}`);
  const state = writeCutoverState(OPERATIONAL_CUTOVER_STATE_FILE, OPERATIONAL_CUTOVER_AUDIT_FILE, initialState());
  return printState(state, false);
}

function freeze(previous, options) {
  const evidence = {
    frozenAt: isoNow(options["occurred-at"]),
    siteUrl: exact(options["site-url"] || SITE_URL, SITE_URL, "site-url"),
    projectId: exact(options["project-id"] || PROJECT_ID, PROJECT_ID, "project-id"),
    sourceHash: sha256Option(options, "source-hash"),
    localBackupHash: sha256Option(options, "local-backup-hash"),
    siteBackupHash: sha256Option(options, "site-backup-hash"),
    prefreezeReconciliationHash: sha256Option(options, "reconciliation-hash")
  };
  const runId = required(options, "run-id");
  if (previous.mode === LOCAL_FROZEN && previous.taskId === TASK_ID && previous.runId === runId) return printState(previous, true);
  if (previous.mode !== LOCAL_CANONICAL) throw new Error(`Local can only freeze from ${LOCAL_CANONICAL}; current mode is ${previous.mode}`);
  return persistTransition(previous, LOCAL_FROZEN, evidence.frozenAt, runId, evidence);
}

function activateSites(previous, options) {
  const runId = required(options, "run-id");
  if (previous.mode === SITES_CANONICAL && previous.taskId === TASK_ID && previous.runId === runId) return printState(previous, true);
  if (previous.mode !== LOCAL_FROZEN) throw new Error(`Sites can only become canonical while Local is frozen; current mode is ${previous.mode}`);
  const occurredAt = isoNow(options["occurred-at"]);
  const evidence = {
    activatedAt: occurredAt,
    finalReconciliationHash: sha256Option(options, "reconciliation-hash"),
    siteActivationEventHash: sha256Option(options, "site-event-hash"),
    siteCommit: sha1Option(options, "site-commit"),
    siteVersion: positiveInteger(options, "site-version")
  };
  return persistTransition(previous, SITES_CANONICAL, occurredAt, runId, evidence);
}

function abortBeforeSites(previous, options) {
  exact(required(options, "confirm"), "ABORT_TO_LOCAL_BEFORE_SITES_WRITES", "confirm");
  if (previous.mode !== LOCAL_FROZEN) throw new Error(`Pre-activation abort requires ${LOCAL_FROZEN}; current mode is ${previous.mode}`);
  const occurredAt = isoNow(options["occurred-at"]);
  return persistTransition(previous, LOCAL_CANONICAL, occurredAt, previous.runId, {
    abortedAt: occurredAt,
    abortEvidenceHash: sha256Option(options, "evidence-hash")
  });
}

function completeRollback(previous, options) {
  exact(required(options, "confirm"), "ROLLBACK_WITH_RECONCILED_SITE_WRITES", "confirm");
  if (previous.mode !== SITES_CANONICAL) throw new Error(`Operational rollback requires ${SITES_CANONICAL}; current mode is ${previous.mode}`);
  const occurredAt = isoNow(options["occurred-at"]);
  return persistTransition(previous, LOCAL_CANONICAL, occurredAt, previous.runId, {
    rollbackCompletedAt: occurredAt,
    reverseDeltaHash: sha256Option(options, "reverse-delta-hash"),
    rollbackReconciliationHash: sha256Option(options, "reconciliation-hash"),
    sitesSuspendedAt: isoNow(required(options, "sites-suspended-at"))
  });
}

function persistTransition(previous, toMode, occurredAt, runId, evidence) {
  const next = transitionCutoverState(previous, { toMode, occurredAt, taskId: TASK_ID, runId, evidence });
  writeCutoverState(OPERATIONAL_CUTOVER_STATE_FILE, OPERATIONAL_CUTOVER_AUDIT_FILE, next);
  const verified = readCutoverState(OPERATIONAL_CUTOVER_STATE_FILE, OPERATIONAL_CUTOVER_AUDIT_FILE);
  if (!verified.valid || verified.state.stateHash !== next.stateHash) throw new Error(`Persisted cutover state failed verification: ${verified.error || "hash mismatch"}`);
  return printState(verified.state, false);
}

function parseOptions(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    if (!key?.startsWith("--") || values[index + 1] === undefined) throw new Error(`Expected --name value, received: ${key || "<end>"}`);
    options[key.slice(2)] = values[index + 1];
  }
  return options;
}

function required(options, key) {
  const value = String(options[key] || "").trim();
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function sha256Option(options, key) {
  const value = required(options, key).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`--${key} must be a SHA-256 digest`);
  return value;
}

function sha1Option(options, key) {
  const value = required(options, key).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error(`--${key} must be a SHA-1 commit`);
  return value;
}

function positiveInteger(options, key) {
  const value = Number(required(options, key));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${key} must be a positive integer`);
  return value;
}

function isoNow(value) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw new Error("Timestamp must be valid ISO-8601");
  return date.toISOString();
}

function exact(value, expected, key) {
  if (value !== expected) throw new Error(`--${key} must equal ${expected}`);
  return value;
}

function printState(state, idempotent) {
  return printResult({ ok: true, idempotent, operational: publicState(state), stateHash: state.stateHash, eventHash: state.events.at(-1)?.hash || null });
}

function printResult(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

try { main(); }
catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
  process.exitCode = 1;
}
