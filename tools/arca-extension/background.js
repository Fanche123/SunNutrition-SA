(function initializeArcaExtension(root) {
  "use strict";

  if (typeof root.importScripts === "function" && !root.ArcaFiscalContract) {
    root.importScripts("arca-fiscal-contract.js");
  }
  const ARCA_FISCAL = root.ArcaFiscalContract
    || (typeof module === "object" && module.exports ? require("./arca-fiscal-contract") : null);
  const LOGIN_URL = "https://auth.afip.gob.ar/contribuyente_/login.xhtml?action=SYSTEM&system=rcel";
  const SESSION_TTL_MS = 5 * 60 * 1000;
  const SESSION_STORAGE_KEY = "sunnutritionArcaPreparedSessions";
  const SESSION_ALARM_PREFIX = "sunnutrition-arca-expiry:";
  const EXPECTED_AUTOMATION = ARCA_FISCAL.AUTOMATION;
  const FORBIDDEN_KEYS = /^(clave|password|passwd|cookie|cookies|token|mfa|captcha|certificado|certificate|firma|signature|secret|secreto)$/i;
  const fallbackSessions = new Map();
  let operationQueue = Promise.resolve();

  function preparedMessageRejectionReason(message, now = Date.now()) {
    if (!message || message.type !== "PREPARE_SESSION") return "payload_invalid";
    if (!/^[0-9a-f-]{36}$/i.test(String(message.sessionId || ""))) return "payload_invalid";
    if (!message.payload) return "payload_invalid";
    if (message.payload.contractVersion !== ARCA_FISCAL.CONTRACT.version) {
      return "contract_incompatible";
    }
    const expiresAt = Date.parse(message.payload.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return "session_expired";
    if (expiresAt > now + SESSION_TTL_MS + 5000) return "payload_invalid";
    if (message.payload.mode !== "review_only" || message.payload.finalSubmissionAllowed !== false) {
      return "payload_invalid";
    }
    if (!/^[a-f0-9]{64}$/i.test(String(message.payload.revision || ""))) return "payload_invalid";
    if (containsForbiddenKey(message.payload)) return "payload_invalid";
    if (!ARCA_FISCAL.preparedPayloadIsValid(message.payload)) return "payload_invalid";
    return Boolean(
      message.payload.order?.id
      && message.payload.customer?.cuit
      && message.payload.invoice?.pointOfSale
      && Array.isArray(message.payload.lines)
      && message.payload.lines.length
    ) ? "" : "payload_invalid";
  }

  function validatePreparedMessage(message) {
    return preparedMessageRejectionReason(message) === "";
  }

  function containsForbiddenKey(value) {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(containsForbiddenKey);
    return Object.entries(value).some(([key, nested]) => (
      FORBIDDEN_KEYS.test(key) || containsForbiddenKey(nested)
    ));
  }

  function trustedExternalSender(sender) {
    try {
      const url = new URL(sender?.url || sender?.origin || "");
      return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port === "3000";
    } catch {
      return false;
    }
  }

  function trustedInternalSender(sender) {
    try {
      const url = new URL(sender?.url || "");
      return Number.isInteger(sender?.tab?.id)
        && (sender.frameId === undefined || sender.frameId === 0)
        && url.protocol === "https:"
        && ["auth.afip.gob.ar", "fe.afip.gob.ar", "serviciosjava2.afip.gob.ar"].includes(url.hostname);
    } catch {
      return false;
    }
  }

  function publicStatus(session) {
    if (!session) return { ok: false, status: "not_found", reason: "unexpected_response" };
    return {
      ok: true,
      status: session.status,
      stage: session.stage || "",
      reason: session.reason || "",
      orderId: session.orderId,
      updatedAt: session.updatedAt
    };
  }

  function storageArea() {
    return root.chrome?.storage?.session || null;
  }

  function expiryAlarmName(sessionId) {
    return `${SESSION_ALARM_PREFIX}${sessionId}`;
  }

  function createExpiryAlarm(session) {
    if (session?.id && Number.isFinite(session.expiresAt) && root.chrome?.alarms?.create) {
      root.chrome.alarms.create(expiryAlarmName(session.id), { when: session.expiresAt });
    }
  }

  function clearExpiryAlarm(sessionId) {
    if (sessionId && root.chrome?.alarms?.clear) {
      root.chrome.alarms.clear(expiryAlarmName(sessionId), () => void root.chrome.runtime.lastError);
    }
  }

  function callStorage(method, argument) {
    const area = storageArea();
    if (!area) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback) => (value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      const onResolve = finish(resolve);
      const onReject = finish(reject);
      try {
        const result = area[method](argument, (value) => {
          const error = root.chrome?.runtime?.lastError;
          if (error) onReject(new Error(error.message));
          else onResolve(value);
        });
        if (result && typeof result.then === "function") result.then(onResolve, onReject);
      } catch (error) {
        onReject(error);
      }
    });
  }

  async function readSessionRecords() {
    if (!storageArea()) {
      return Object.fromEntries([...fallbackSessions.entries()].map(([id, session]) => [id, { ...session }]));
    }
    const result = await callStorage("get", SESSION_STORAGE_KEY);
    const records = result?.[SESSION_STORAGE_KEY];
    return records && typeof records === "object" && !Array.isArray(records) ? records : {};
  }

  async function writeSessionRecords(records) {
    const cleanRecords = records && typeof records === "object" ? records : {};
    if (!storageArea()) {
      fallbackSessions.clear();
      Object.entries(cleanRecords).forEach(([id, session]) => fallbackSessions.set(id, { ...session }));
      return;
    }
    await callStorage("set", { [SESSION_STORAGE_KEY]: cleanRecords });
  }

  function cancelSession(session, reason, { closeTab = false } = {}) {
    if (!session) return;
    session.status = "interrupted";
    session.stage = "";
    session.reason = reason;
    session.updatedAt = new Date().toISOString();
    session.payload = null;
    if (session.tabId && root.chrome?.tabs?.sendMessage) {
      root.chrome.tabs.sendMessage(session.tabId, {
        type: "CANCEL_ACTIVE_SESSION",
        sessionId: session.id,
        reason
      }, () => void root.chrome.runtime.lastError);
    }
    if (closeTab && session.tabId && root.chrome?.tabs?.remove) {
      root.chrome.tabs.remove(session.tabId, () => void root.chrome.runtime.lastError);
    }
  }

  async function expireSession(sessionId, records = null) {
    const currentRecords = records || await readSessionRecords();
    const session = currentRecords[sessionId];
    if (!session) return false;
    cancelSession(session, "timeout");
    clearExpiryAlarm(sessionId);
    await writeSessionRecords(currentRecords);
    return true;
  }

  function createTab(url) {
    return new Promise((resolve, reject) => {
      try {
        const result = root.chrome.tabs.create({ url, active: true }, (tab) => {
          const error = root.chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(tab);
        });
        if (result && typeof result.then === "function") result.then(resolve, reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  async function prepareSession(message, sender) {
    if (!trustedExternalSender(sender)) {
      return { ok: false, status: "rejected", reason: "origin_rejected" };
    }
    const records = await readSessionRecords();
    const rejectionReason = preparedMessageRejectionReason(message);
    Object.values(records).forEach((existing) => {
      cancelSession(existing, "manual_abort");
      clearExpiryAlarm(existing.id);
    });
    if (rejectionReason) {
      await writeSessionRecords({});
      return {
        ok: false,
        status: "rejected",
        reason: rejectionReason,
        contractVersion: ARCA_FISCAL.CONTRACT.version
      };
    }
    const session = {
      id: message.sessionId,
      payload: message.payload,
      orderId: message.payload.order.id,
      status: "prepared",
      stage: "",
      reason: "",
      tabId: null,
      updatedAt: new Date().toISOString(),
      expiresAt: Date.parse(message.payload.expiresAt)
    };
    await writeSessionRecords({ [session.id]: session });
    createExpiryAlarm(session);
    try {
      const tab = await createTab(LOGIN_URL);
      if (!tab?.id) throw new Error("ARCA tab was not created");
      const latestRecords = await readSessionRecords();
      const latestSession = latestRecords[session.id];
      if (!latestSession || latestSession.payload?.revision !== session.payload.revision) {
        if (tab.id && root.chrome?.tabs?.remove) {
          root.chrome.tabs.remove(tab.id, () => void root.chrome.runtime.lastError);
        }
        return { ok: false, status: "interrupted", reason: "manual_abort" };
      }
      latestSession.tabId = tab.id;
      latestSession.status = "waiting_login";
      latestSession.stage = "login";
      latestSession.updatedAt = new Date().toISOString();
      await writeSessionRecords(latestRecords);
      return publicStatus(latestSession);
    } catch {
      const latestRecords = await readSessionRecords();
      const latestSession = latestRecords[session.id];
      if (latestSession) {
        cancelSession(latestSession, "association_failed");
        clearExpiryAlarm(latestSession.id);
        await writeSessionRecords(latestRecords);
      }
      return latestSession
        ? { ...publicStatus(latestSession), ok: false }
        : { ok: false, status: "rejected", reason: "association_failed" };
    }
  }

  async function externalMessage(message, sender) {
    if (message?.type === "PING") {
      return trustedExternalSender(sender)
        ? {
          ok: true,
          contractVersion: ARCA_FISCAL.CONTRACT.version,
          mode: "review_only"
        }
        : { ok: false };
    }
    if (message?.type === "PREPARE_SESSION") return prepareSession(message, sender);
    if (message?.type === "GET_SESSION_STATUS" && trustedExternalSender(sender)) {
      const records = await readSessionRecords();
      const sessionId = String(message.sessionId || "");
      const session = records[sessionId];
      if (session && session.expiresAt <= Date.now()) {
        await expireSession(session.id, records);
        return publicStatus(records[sessionId]);
      }
      return publicStatus(session);
    }
    if (message?.type === "CANCEL_SESSION" && trustedExternalSender(sender)) {
      const records = await readSessionRecords();
      const sessionId = String(message.sessionId || "");
      const session = records[sessionId];
      if (!session) return { ok: false, status: "not_found", reason: "unexpected_response" };
      cancelSession(session, "manual_abort", { closeTab: message.closeTab === true });
      clearExpiryAlarm(session.id);
      delete records[sessionId];
      await writeSessionRecords(records);
      return { ...publicStatus(session), status: "interrupted", reason: "manual_abort" };
    }
    return { ok: false, status: "rejected", reason: "unexpected_response" };
  }

  async function internalMessage(message, sender) {
    if (!trustedInternalSender(sender)) return { ok: false, status: "not_found" };
    const records = await readSessionRecords();
    const session = Object.values(records).find((entry) => entry.tabId === sender.tab.id);
    if (!session) return { ok: false, status: "not_found" };
    if (message?.type === "GET_ACTIVE_SESSION") {
      if (session.expiresAt <= Date.now() || !session.payload || session.status === "interrupted") {
        await expireSession(session.id, records);
        return { ok: false, status: "not_found" };
      }
      return {
        ok: true,
        sessionId: session.id,
        payload: session.payload,
        status: session.status,
        stage: session.stage || ""
      };
    }
    if (message?.type === "AUTHORIZE_INTERIM_ACTION") {
      const allowedPreviousStage = {
        representative: "login",
        service: "representative"
      }[message.stage];
      if (
        !allowedPreviousStage
        || session.stage !== allowedPreviousStage
        || ["review_reached", "interrupted"].includes(session.status)
        || !session.payload
      ) return { ok: false, status: "rejected", stage: session.stage || "" };
      session.status = message.stage === "representative"
        ? "waiting_representative"
        : "service_recognized";
      session.stage = message.stage;
      session.reason = "";
      session.updatedAt = new Date().toISOString();
      records[session.id] = session;
      await writeSessionRecords(records);
      return { ok: true, status: session.status, stage: session.stage };
    }
    if (message?.type === "UPDATE_SESSION") {
      const allowedStatuses = new Set([
        "waiting_login",
        "waiting_representative",
        "service_recognized",
        "completing_stage",
        "fields_completed",
        "review_reached",
        "interrupted"
      ]);
      const allowedStages = new Set([
        "", "login", "representative", "service", "initial", "emission", "recipient", "lines", "review"
      ]);
      const allowedReasons = new Set([
        "",
        "network_error",
        "screen_unrecognized",
        "selector_changed",
        "session_expired",
        "unexpected_response"
      ]);
      if (
        !allowedStatuses.has(message.status)
        || !allowedStages.has(message.stage || "")
        || !allowedReasons.has(message.reason || "")
      ) {
        return { ok: false };
      }
      if (["review_reached", "interrupted"].includes(session.status) || !session.payload) {
        return publicStatus(session);
      }
      const stageOrder = ["", "login", "representative", "service", "initial", "emission", "recipient", "lines", "review"];
      if (
        !["review_reached", "interrupted"].includes(message.status)
        && stageOrder.indexOf(message.stage || "") < stageOrder.indexOf(session.stage || "")
      ) {
        return { ok: false };
      }
      session.status = message.status;
      session.stage = message.stage || "";
      session.reason = message.reason || "";
      session.updatedAt = new Date().toISOString();
      if (session.status === "review_reached" || session.status === "interrupted") {
        session.payload = null;
        clearExpiryAlarm(session.id);
      }
      records[session.id] = session;
      await writeSessionRecords(records);
      return publicStatus(session);
    }
    return { ok: false };
  }

  function respondAsync(handler, message, sender, sendResponse) {
    const operation = operationQueue.then(() => handler(message, sender));
    operationQueue = operation.catch(() => {});
    operation
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, status: "interrupted", reason: "unexpected_response" }));
    return true;
  }

  if (root.chrome?.runtime?.onMessageExternal) {
    root.chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => (
      respondAsync(externalMessage, message, sender, sendResponse)
    ));
    root.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => (
      respondAsync(internalMessage, message, sender, sendResponse)
    ));
  }
  if (root.chrome?.alarms?.onAlarm) {
    root.chrome.alarms.onAlarm.addListener((alarm) => {
      if (!String(alarm?.name || "").startsWith(SESSION_ALARM_PREFIX)) return;
      const sessionId = alarm.name.slice(SESSION_ALARM_PREFIX.length);
      operationQueue = operationQueue.then(() => expireSession(sessionId)).catch(() => {});
    });
  }

  if (typeof module === "object" && module.exports) {
    module.exports = {
      FORBIDDEN_KEYS,
      EXPECTED_AUTOMATION,
      LOGIN_URL,
      SESSION_ALARM_PREFIX,
      SESSION_STORAGE_KEY,
      SESSION_TTL_MS,
      cancelSession,
      clearExpiryAlarm,
      containsForbiddenKey,
      createExpiryAlarm,
      expireSession,
      expiryAlarmName,
      externalMessage,
      internalMessage,
      prepareSession,
      preparedMessageRejectionReason,
      publicStatus,
      readSessionRecords,
      trustedExternalSender,
      trustedInternalSender,
      validatePreparedMessage,
      writeSessionRecords
    };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
