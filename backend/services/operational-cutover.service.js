const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const STATE_VERSION = 1;
const LOCAL_CANONICAL = "local_canonical";
const LOCAL_FROZEN = "local_frozen_sites_pending";
const SITES_CANONICAL = "sites_canonical_local_read_only";
const VALID_MODES = new Set([LOCAL_CANONICAL, LOCAL_FROZEN, SITES_CANONICAL]);
const SAFE_POST_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/logout",
  "/api/backend/sql",
  "/api/backend/sql/generate",
  "/api/inventory/purchase-snapshot/preview",
  "/api/payroll-scale/read",
  "/api/reception-invoice/read",
  "/api/runtime/shutdown",
  "/api/sales/invoice/read"
]);

function createOperationalCutoverService({ stateFile, auditFile, logError = console.error }) {
  return {
    getPublicState() {
      const result = readCutoverState(stateFile, auditFile);
      if (result.valid) return publicState(result.state);
      if (result.missing) return publicState(initialState());
      logError(`operational_cutover_state_invalid: ${result.error}`);
      return {
        mode: "guard_error",
        canonicalSource: "none",
        localReadOnly: true,
        siteUrl: null,
        taskId: null,
        runId: null,
        frozenAt: null,
        activatedAt: null,
        stateSequence: null,
        stateValid: false
      };
    },
    mutationBlock(method, pathname) {
      const normalizedMethod = String(method || "GET").toUpperCase();
      if (!["POST", "PATCH", "DELETE"].includes(normalizedMethod)) return null;
      if (isSafeReadOnlyPost(normalizedMethod, pathname)) return null;
      const current = this.getPublicState();
      if (!current.localReadOnly) return null;
      const code = current.mode === SITES_CANONICAL
        ? "LOCAL_READ_ONLY_SITES_CANONICAL"
        : current.mode === LOCAL_FROZEN
          ? "LOCAL_CUTOVER_FROZEN"
          : "LOCAL_CUTOVER_STATE_INVALID";
      return {
        code,
        status: 423,
        error: current.mode === SITES_CANONICAL
          ? "El ERP Local es un respaldo de solo lectura. Las nuevas operaciones se realizan únicamente en Sites."
          : current.mode === LOCAL_FROZEN
            ? "El ERP Local está congelado para el corte. Sites todavía no fue habilitado como escritor."
            : "El estado de corte Local no pudo validarse; las mutaciones permanecen bloqueadas por seguridad.",
        operational: current
      };
    }
  };
}

function readCutoverState(stateFile, auditFile) {
  let raw;
  try {
    raw = fs.readFileSync(stateFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" && !hasAuditEvidence(auditFile)) {
      return { valid: false, missing: true, error: "missing" };
    }
    return { valid: false, missing: false, error: String(error?.message || error) };
  }
  try {
    const state = JSON.parse(raw);
    validateState(state);
    if (auditFile && (state.events.length || hasAuditEvidence(auditFile))) validateAuditAgainstState(auditFile, state);
    return { valid: true, missing: false, state };
  } catch (error) {
    return { valid: false, missing: false, error: String(error?.message || error) };
  }
}

function writeCutoverState(stateFile, auditFile, state) {
  validateState(state);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const latestEvent = state.events.at(-1);
  if (latestEvent) ensureAuditEvent(auditFile, latestEvent);
  const temporary = `${stateFile}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, stateFile);
  return state;
}

function transitionCutoverState(previous, { toMode, occurredAt, taskId, runId, evidence }) {
  validateState(previous);
  if (!VALID_MODES.has(toMode)) throw new Error(`Invalid cutover destination mode: ${toMode}`);
  if (!taskId || !runId || !Number.isFinite(Date.parse(occurredAt))) throw new Error("Cutover transition requires taskId, runId and ISO timestamp");
  const previousHash = previous.events.at(-1)?.hash || "0".repeat(64);
  const eventCore = {
    sequence: previous.sequence + 1,
    occurredAt,
    taskId,
    runId,
    fromMode: previous.mode,
    toMode,
    evidence: evidence || {},
    previousHash
  };
  const event = { ...eventCore, hash: sha256(canonicalStringify(eventCore)) };
  const state = {
    ...previous,
    mode: toMode,
    taskId,
    runId,
    sequence: event.sequence,
    events: [...previous.events, event],
    updatedAt: occurredAt,
    ...(evidence || {})
  };
  state.stateHash = stateHashFor(state);
  validateState(state);
  return state;
}

function initialState() {
  const state = {
    version: STATE_VERSION,
    mode: LOCAL_CANONICAL,
    taskId: null,
    runId: null,
    siteUrl: null,
    projectId: null,
    sourceHash: null,
    frozenAt: null,
    activatedAt: null,
    sequence: 0,
    updatedAt: null,
    events: []
  };
  state.stateHash = stateHashFor(state);
  return state;
}

function validateState(state) {
  if (!state || state.version !== STATE_VERSION || !VALID_MODES.has(state.mode)) throw new Error("Unsupported operational cutover state");
  if (!Number.isSafeInteger(state.sequence) || state.sequence < 0 || !Array.isArray(state.events) || state.events.length !== state.sequence) {
    throw new Error("Invalid operational cutover event sequence");
  }
  let previousHash = "0".repeat(64);
  state.events.forEach((event, index) => {
    const { hash, ...core } = event;
    if (event.sequence !== index + 1 || core.previousHash !== previousHash || sha256(canonicalStringify(core)) !== hash) {
      throw new Error("Operational cutover event chain mismatch");
    }
    previousHash = hash;
  });
  if (state.stateHash !== stateHashFor(state)) throw new Error("Operational cutover state hash mismatch");
  if (state.mode !== LOCAL_CANONICAL && (!state.taskId || !state.runId || !state.frozenAt)) {
    throw new Error("Frozen cutover state is incomplete");
  }
  return state;
}

function stateHashFor(state) {
  const { stateHash: _ignored, ...body } = state;
  return sha256(canonicalStringify(body));
}

function publicState(state) {
  return {
    mode: state.mode,
    canonicalSource: state.mode === LOCAL_CANONICAL ? "local" : state.mode === SITES_CANONICAL ? "sites" : "none",
    localReadOnly: state.mode !== LOCAL_CANONICAL,
    siteUrl: state.siteUrl || null,
    taskId: state.taskId || null,
    runId: state.runId || null,
    frozenAt: state.frozenAt || null,
    activatedAt: state.activatedAt || null,
    stateSequence: state.sequence,
    stateValid: true
  };
}

function isSafeReadOnlyPost(method, pathname) {
  if (method !== "POST") return false;
  return SAFE_POST_PATHS.has(pathname) || /^\/api\/admin\/tables\/[^/]+\/delete-preview$/.test(pathname);
}

function ensureAuditEvent(auditFile, event) {
  fs.mkdirSync(path.dirname(auditFile), { recursive: true });
  const existing = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8") : "";
  const events = parseAuditEvents(existing);
  if (events.some((candidate) => candidate.hash === event.hash)) return;
  const expectedPreviousHash = events.at(-1)?.hash || "0".repeat(64);
  if (event.previousHash !== expectedPreviousHash || event.sequence !== events.length + 1) {
    throw new Error("Operational cutover audit chain mismatch");
  }
  fs.appendFileSync(auditFile, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
}

function validateAuditAgainstState(auditFile, state) {
  const events = parseAuditEvents(fs.readFileSync(auditFile, "utf8"));
  if (events.length !== state.events.length) throw new Error("Operational cutover audit/state length mismatch");
  events.forEach((event, index) => {
    if (event.hash !== state.events[index]?.hash || canonicalStringify(event) !== canonicalStringify(state.events[index])) {
      throw new Error("Operational cutover audit/state event mismatch");
    }
  });
}

function parseAuditEvents(raw) {
  return String(raw || "").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function hasAuditEvidence(auditFile) {
  if (!auditFile) return false;
  try { return fs.readFileSync(auditFile, "utf8").trim().length > 0; }
  catch (error) {
    if (error?.code === "ENOENT") return false;
    return true;
  }
}

function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

module.exports = {
  LOCAL_CANONICAL,
  LOCAL_FROZEN,
  SITES_CANONICAL,
  createOperationalCutoverService,
  initialState,
  publicState,
  readCutoverState,
  stateHashFor,
  transitionCutoverState,
  validateState,
  writeCutoverState
};
