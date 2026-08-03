const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SENSITIVE_FIELD = /password|contrase(?:n|ñ)a|secret|token|cookie|authorization|api[_-]?key|private[_-]?key|archivo|file|content|base64/i;
const READ_ONLY_POSTS = new Set([
  "/api/backend/sql",
  "/api/reception-invoice/read",
  "/api/payroll-scale/read",
  "/api/sales/invoice/read",
  "/api/sales/arca/prepare"
]);

function createAuditService({
  auditFile,
  recoveryFile = `${auditFile}.recovery.jsonl`,
  loadCache,
  loadRegistry,
  fsModule = fs,
  cryptoModule = crypto,
  now = () => new Date(),
  logError = () => {}
}) {
  let mutationTail = Promise.resolve();

  async function beginRequest(request, response, identity) {
    if (!isAuditedMutation(request)) return;
    let release;
    const previous = mutationTail;
    mutationTail = new Promise((resolve) => { release = resolve; });
    await previous;

    try {
      recoverPendingResults();
      assertAuditReady();
      request.auditRequestId = cryptoModule.randomUUID();
      response.setHeader("X-ERP-Request-Id", request.auditRequestId);
      appendRecoveryRecord({
        kind: "intent",
        requestId: request.auditRequestId,
        occurredAtUtc: now().toISOString(),
        actor: sanitizeActor(identity?.user),
        method: String(request.method || "").toUpperCase(),
        route: new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`).pathname
      });
    } catch (error) {
      release();
      throw error;
    }

    const before = safeCacheSnapshot(loadCache);
    const originalWriteHead = response.writeHead.bind(response);
    const originalEnd = response.end.bind(response);
    let deferredHead = null;
    let finalized = false;
    response.writeHead = function auditedWriteHead(...args) {
      deferredHead = args;
      response.statusCode = Number(args[0] || response.statusCode || 200);
      return response;
    };
    response.end = function auditedEnd(...args) {
      if (finalized) return originalEnd(...args);
      finalized = true;
      const status = Number(response.statusCode || 200);
      try {
        if (status >= 200 && status < 300) {
          const after = safeCacheSnapshot(loadCache);
          const summary = request.auditSummary || summarizeCacheChanges(before, after, loadRegistry);
          const event = buildRequestEvent(request, identity, summary, status);
          appendRecoveryRecord({ kind: "result", requestId: request.auditRequestId, event });
          try {
            appendEvent(event);
            appendRecoveryRecord({ kind: "complete", requestId: request.auditRequestId, state: "committed" });
            response.setHeader("X-ERP-Audit-State", "committed");
          } catch (error) {
            response.setHeader("X-ERP-Audit-State", "pending-recovery");
            logAuditFailure(error, request);
          }
        } else {
          appendRecoveryRecord({ kind: "complete", requestId: request.auditRequestId, state: "failed_response" });
        }
      } catch (error) {
        response.setHeader("X-ERP-Audit-State", "pending-recovery");
        logAuditFailure(error, request);
      }
      try {
        if (deferredHead) originalWriteHead(...deferredHead);
        return originalEnd(...args);
      } finally {
        release();
      }
    };
    response.once("close", () => {
      if (!finalized) {
        finalized = true;
        release();
      }
    });
  }

  function appendSecurityEvent(input) {
    const event = {
      id: cryptoModule.randomUUID(),
      occurredAtUtc: now().toISOString(),
      occurredAtBuenosAires: buenosAiresTimestamp(now()),
      actor: sanitizeActor(input.actor),
      action: cleanText(input.action, 80),
      outcome: input.outcome === "failure" ? "failure" : "success",
      module: "security",
      entity: cleanText(input.entity || "session", 80),
      recordId: cleanText(input.recordId || "", 120),
      route: cleanText(input.route || "", 240),
      method: "POST",
      changes: [],
      fields: []
    };
    try {
      recoverPendingResults();
      assertAuditReady();
      appendEvent(event);
    } catch (error) {
      try { appendRecoveryRecord({ kind: "result", requestId: event.id, event }); } catch {}
      logAuditFailure(error, { auditRequestId: event.id, url: event.route });
    }
  }

  function listEvents(filters = {}) {
    const integrity = readVerifiedEvents();
    const recovery = readRecoveryJournal();
    const committedIds = new Set(integrity.events.map((event) => event.id));
    const pendingEvents = recovery.pendingResults
      .map((record) => record.event)
      .filter((event) => event?.id && !committedIds.has(event.id))
      .map((event) => ({ ...event, recoveryState: "pending" }));
    let events = [...integrity.events, ...pendingEvents];
    const from = parseBoundary(filters.from, false);
    const to = parseBoundary(filters.to, true);
    const user = normalizeFilter(filters.user);
    const entity = normalizeFilter(filters.entity || filters.module);
    const action = normalizeFilter(filters.action);
    if (from) events = events.filter((event) => new Date(event.occurredAtUtc).getTime() >= from);
    if (to) events = events.filter((event) => new Date(event.occurredAtUtc).getTime() <= to);
    if (user) events = events.filter((event) => normalizeFilter(`${event.actor?.username} ${event.actor?.displayName}`).includes(user));
    if (entity) events = events.filter((event) => normalizeFilter(`${event.module} ${event.entity}`).includes(entity));
    if (action) events = events.filter((event) => normalizeFilter(event.action).includes(action));
    const limit = clampInteger(filters.limit, 200, 1, 1000);
    return {
      events: events.slice(-limit).reverse(),
      integrity: integrity.valid && recovery.valid && pendingEvents.length === 0 && recovery.unresolvedIntents.length === 0,
      pendingRecovery: pendingEvents.length + recovery.unresolvedIntents.length,
      total: events.length
    };
  }

  function handleList(request, response, sendJson) {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
      const result = listEvents(Object.fromEntries(url.searchParams.entries()));
      response.setHeader("Cache-Control", "no-store");
      return sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      return sendJson(response, 500, { ok: false, code: "AUDIT_READ_FAILED", error: "No se pudo leer el registro de actividad." });
    }
  }

  function appendEvent(event) {
    fsModule.mkdirSync(path.dirname(auditFile), { recursive: true });
    const previousHash = lastEventHash();
    const payload = { ...event, previousHash };
    const hash = digest(`${previousHash}\n${JSON.stringify(payload)}`);
    appendDurableLine(auditFile, { ...payload, hash });
    try { fsModule.chmodSync(auditFile, 0o600); } catch {}
  }

  function lastEventHash() {
    const verified = readVerifiedEvents();
    if (!verified.valid) throw new Error("La cadena de auditoria no supera la verificacion de integridad.");
    return String(verified.events.at(-1)?.hash || "");
  }

  function readVerifiedEvents() {
    if (!fsModule.existsSync(auditFile)) return { events: [], valid: true };
    const lines = fsModule.readFileSync(auditFile, "utf8").split(/\r?\n/).filter(Boolean);
    const events = [];
    let previousHash = "";
    let valid = true;
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        const hash = event.hash;
        const payload = { ...event };
        delete payload.hash;
        if (payload.previousHash !== previousHash || digest(`${previousHash}\n${JSON.stringify(payload)}`) !== hash) valid = false;
        previousHash = hash;
        events.push(event);
      } catch {
        valid = false;
      }
    }
    return { events, valid };
  }

  function buildRequestEvent(request, identity, summary, status) {
    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
    const normalized = normalizeSummary(summary, url.pathname);
    return {
      id: cryptoModule.randomUUID(),
      requestId: request.auditRequestId,
      occurredAtUtc: now().toISOString(),
      occurredAtBuenosAires: buenosAiresTimestamp(now()),
      actor: sanitizeActor(identity?.user),
      action: normalized.action,
      outcome: "success",
      module: normalized.module,
      entity: normalized.entity,
      recordId: normalized.recordId,
      route: url.pathname,
      method: String(request.method || "").toUpperCase(),
      status,
      changes: normalized.changes,
      fields: normalized.fields
    };
  }

  function assertAuditReady() {
    const integrity = readVerifiedEvents();
    if (!integrity.valid) throw new Error("La cadena de auditoria no supera la verificacion de integridad.");
    const recovery = readRecoveryJournal();
    if (!recovery.valid) throw new Error("El journal de recuperacion de auditoria no es valido.");
    fsModule.mkdirSync(path.dirname(auditFile), { recursive: true });
    const descriptor = fsModule.openSync(auditFile, "a", 0o600);
    try { fsModule.fsyncSync(descriptor); } finally { fsModule.closeSync(descriptor); }
  }

  function appendRecoveryRecord(record) {
    fsModule.mkdirSync(path.dirname(recoveryFile), { recursive: true });
    appendDurableLine(recoveryFile, { ...record, journaledAt: now().toISOString() });
    try { fsModule.chmodSync(recoveryFile, 0o600); } catch {}
  }

  function appendDurableLine(file, record) {
    fsModule.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    const descriptor = fsModule.openSync(file, "r+");
    try { fsModule.fsyncSync(descriptor); } finally { fsModule.closeSync(descriptor); }
  }

  function readRecoveryJournal() {
    if (!fsModule.existsSync(recoveryFile)) {
      return { valid: true, pendingResults: [], unresolvedIntents: [] };
    }
    const intents = new Map();
    const results = new Map();
    const completed = new Set();
    let valid = true;
    for (const line of fsModule.readFileSync(recoveryFile, "utf8").split(/\r?\n/).filter(Boolean)) {
      try {
        const record = JSON.parse(line);
        const requestId = cleanText(record.requestId, 120);
        if (!requestId) { valid = false; continue; }
        if (record.kind === "intent") intents.set(requestId, record);
        else if (record.kind === "result" && record.event) results.set(requestId, record);
        else if (record.kind === "complete") completed.add(requestId);
        else valid = false;
      } catch {
        valid = false;
      }
    }
    return {
      valid,
      pendingResults: [...results.entries()].filter(([id]) => !completed.has(id)).map(([, record]) => record),
      unresolvedIntents: [...intents.entries()]
        .filter(([id]) => !completed.has(id) && !results.has(id))
        .map(([, record]) => record)
    };
  }

  function recoverPendingResults() {
    const recovery = readRecoveryJournal();
    if (!recovery.valid) throw new Error("El journal de recuperacion de auditoria no es valido.");
    const integrity = readVerifiedEvents();
    if (!integrity.valid) throw new Error("La cadena de auditoria no supera la verificacion de integridad.");
    const committedIds = new Set(integrity.events.map((event) => event.id));
    for (const record of recovery.pendingResults) {
      if (!committedIds.has(record.event.id)) {
        appendEvent(record.event);
        committedIds.add(record.event.id);
      }
      appendRecoveryRecord({ kind: "complete", requestId: record.requestId, state: "recovered" });
    }
  }

  function logAuditFailure(error, request) {
    const route = cleanText(new URL(request.url || "/", "http://127.0.0.1").pathname, 160);
    const message = cleanText(error?.message || "audit-write-failed", 180);
    logError(`[AUDIT_PENDING] requestId=${cleanText(request.auditRequestId, 120)} route=${route} error=${message}`);
  }

  return { appendSecurityEvent, beginRequest, handleList, listEvents, readVerifiedEvents };
}

function isAuditedMutation(request) {
  const method = String(request.method || "GET").toUpperCase();
  if (!["POST", "PATCH", "DELETE"].includes(method)) return false;
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  if (["/api/auth/login", "/api/auth/logout"].includes(pathname) || pathname === "/api/runtime/shutdown") return false;
  return !READ_ONLY_POSTS.has(pathname);
}

function summarizeCacheChanges(before, after, loadRegistry) {
  const definitions = new Map();
  try {
    for (const definition of loadRegistry().tables || []) definitions.set(definition.name, definition);
  } catch {}
  const changes = [];
  const tables = new Set([...Object.keys(before?.tables || {}), ...Object.keys(after?.tables || {})]);
  for (const tableName of tables) {
    const beforeRows = before?.tables?.[tableName]?.rows || [];
    const afterRows = after?.tables?.[tableName]?.rows || [];
    const primaryKey = resolvePrimaryKey(definitions.get(tableName), beforeRows, afterRows);
    const beforeMap = indexRows(beforeRows, primaryKey);
    const afterMap = indexRows(afterRows, primaryKey);
    const added = [];
    const deleted = [];
    const updated = [];
    const fields = new Set();
    for (const [id, row] of afterMap) {
      if (!beforeMap.has(id)) added.push(id);
      else if (JSON.stringify(beforeMap.get(id)) !== JSON.stringify(row)) {
        updated.push(id);
        changedFields(beforeMap.get(id), row).forEach((field) => fields.add(field));
      }
    }
    for (const id of beforeMap.keys()) if (!afterMap.has(id)) deleted.push(id);
    if (!added.length && !updated.length && !deleted.length) continue;
    changes.push({
      entity: tableName,
      operation: changeOperation(added, updated, deleted),
      recordIds: [...added, ...updated, ...deleted].slice(0, 20),
      added: added.length,
      updated: updated.length,
      deleted: deleted.length,
      beforeCount: beforeRows.length,
      afterCount: afterRows.length,
      fields: [...fields].filter(safeField).slice(0, 40)
    });
  }
  return { changes };
}

function normalizeSummary(summary, pathname) {
  const changes = Array.isArray(summary?.changes) ? summary.changes : [];
  const routeParts = pathname.split("/").filter(Boolean);
  const inferredEntity = changes.map((change) => change.entity).join(", ") || summary?.entity || routeParts.at(-1) || "resource";
  const operations = new Set(changes.map((change) => change.operation));
  const action = cleanText(summary?.action || inferAction(pathname, operations), 80);
  const fields = (summary?.fields || changes.flatMap((change) => change.fields || [])).filter(safeField).slice(0, 50);
  const ids = changes.flatMap((change) => change.recordIds || []);
  return {
    action,
    module: cleanText(summary?.module || routeParts[1] || "application", 80),
    entity: cleanText(inferredEntity, 160),
    recordId: cleanText(summary?.recordId || ids.slice(0, 20).join(", "), 300),
    changes,
    fields
  };
}

function inferAction(pathname, operations) {
  if (/delete|discard|reversal|reverse/i.test(pathname)) return "delete_or_reverse";
  if (/confirm|close|apply|endorse/i.test(pathname)) return "confirm";
  if (operations.size === 1) return [...operations][0];
  return operations.size ? "change" : "execute";
}

function resolvePrimaryKey(definition, ...rowSets) {
  const requested = String(definition?.primaryKey || "").toLowerCase();
  const sample = rowSets.flat().find((row) => row && typeof row === "object") || {};
  if (requested) {
    const actual = Object.keys(sample).find((key) => key.toLowerCase() === requested);
    if (actual) return actual;
  }
  return Object.keys(sample).find((key) => /^id_/i.test(key)) || "_rowNumber";
}

function indexRows(rows, primaryKey) {
  return new Map((rows || []).map((row, index) => [String(row?.[primaryKey] ?? `row:${index}`), row]));
}

function changedFields(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]));
}

function changeOperation(added, updated, deleted) {
  const count = [added.length > 0, updated.length > 0, deleted.length > 0].filter(Boolean).length;
  if (count > 1) return "change";
  if (added.length) return "create";
  if (deleted.length) return "delete";
  return "update";
}

function safeCacheSnapshot(loadCache) {
  try { return JSON.parse(JSON.stringify(loadCache())); } catch { return { tables: {} }; }
}

function sanitizeActor(actor) {
  return {
    id: cleanText(actor?.id || "", 120),
    username: cleanText(actor?.username || "unknown", 80),
    displayName: cleanText(actor?.displayName || actor?.username || "", 120),
    role: cleanText(actor?.role || "anonymous", 80)
  };
}

function safeField(field) {
  return field && !String(field).startsWith("_") && !SENSITIVE_FIELD.test(String(field));
}

function buenosAiresTimestamp(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}-03:00`;
}

function parseBoundary(value, endOfDay) {
  if (!value) return null;
  const text = String(value).trim();
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}-03:00` : text);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function normalizeFilter(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanText(value, maximum) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, maximum);
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(Math.max(number, minimum), maximum) : fallback;
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

module.exports = {
  READ_ONLY_POSTS,
  SENSITIVE_FIELD,
  buenosAiresTimestamp,
  createAuditService,
  isAuditedMutation,
  summarizeCacheChanges
};
