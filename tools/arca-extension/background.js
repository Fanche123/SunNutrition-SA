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
  const SESSION_GENERATION_STORAGE_KEY = "sunnutritionArcaSessionGeneration";
  const SESSION_TRACE_STORAGE_KEY = "sunnutritionArcaSessionTrace";
  const SESSION_TRACE_LIMIT = 40;
  const SESSION_ALARM_PREFIX = "sunnutrition-arca-expiry:";
  const VAULT_STORAGE_KEY = "sunnutritionArcaEncryptedCredential";
  const VAULT_DB_NAME = "sunnutrition-arca-vault";
  const VAULT_STORE_NAME = "keys";
  const VAULT_KEY_ID = "arca-password-aes-gcm-v1";
  const VAULT_FORMAT_VERSION = 1;
  const AUTHORIZED_LOGIN_CUIT = "20398041063";
  const VAULT_AAD = `sunnutrition-arca-vault|${VAULT_FORMAT_VERSION}|${AUTHORIZED_LOGIN_CUIT}`;
  const EXPECTED_AUTOMATION = ARCA_FISCAL.AUTOMATION;
  const REPRESENTATIVE_DOM_CONTRACT = "representative-selection-v1";
  const FORBIDDEN_KEYS = /^(clave|password|passwd|cookie|cookies|token|mfa|captcha|certificado|certificate|firma|signature|secret|secreto)$/i;
  const fallbackSessions = new Map();
  let fallbackGeneration = 0;
  let fallbackTrace = [];
  let activeVaultController = null;
  let storageCriticalQueue = Promise.resolve();
  const sessionMutationQueues = new Map();

  const SESSION_EVENT = Object.freeze({
    PREPARE: "PREPARE",
    ASSOCIATE_TAB: "ASSOCIATE_TAB",
    RECOVER: "RECOVER",
    CLAIM_LOGIN_CUIT: "CLAIM_LOGIN_CUIT",
    CLAIM_LOGIN_PASSWORD: "CLAIM_LOGIN_PASSWORD",
    CONSUME_CREDENTIAL: "CONSUME_CREDENTIAL",
    COMPLETE_LOGIN: "COMPLETE_LOGIN",
    CLAIM_REPRESENTATIVE: "CLAIM_REPRESENTATIVE",
    CLAIM_SERVICE: "CLAIM_SERVICE",
    STAGE_PROGRESS: "STAGE_PROGRESS",
    PAGE_DIAGNOSTIC: "PAGE_DIAGNOSTIC",
    SECURITY_REJECTION: "SECURITY_REJECTION",
    REVIEW_REACHED: "REVIEW_REACHED",
    CANCEL: "CANCEL",
    REPLACE: "REPLACE",
    EXPIRE: "EXPIRE"
  });

  const SESSION_STATE = Object.freeze({
    ABSENT: "absent",
    PREPARED: "prepared|",
    LOGIN: "waiting_login|login",
    LOGIN_WAITING_REPRESENTATIVE: "waiting_representative|login",
    REPRESENTATIVE: "waiting_representative|representative",
    SERVICE: "service_recognized|service",
    INITIAL_STARTED: "completing_stage|initial",
    INITIAL_COMPLETED: "fields_completed|initial",
    EMISSION_STARTED: "completing_stage|emission",
    EMISSION_COMPLETED: "fields_completed|emission",
    RECIPIENT_STARTED: "completing_stage|recipient",
    RECIPIENT_COMPLETED: "fields_completed|recipient",
    LINES_STARTED: "completing_stage|lines",
    LINES_COMPLETED: "fields_completed|lines",
    REVIEW: "review_reached|review",
    INTERRUPTED: "interrupted|"
  });

  const ACTIVE_SESSION_STATES = Object.freeze([
    SESSION_STATE.PREPARED,
    SESSION_STATE.LOGIN,
    SESSION_STATE.LOGIN_WAITING_REPRESENTATIVE,
    SESSION_STATE.REPRESENTATIVE,
    SESSION_STATE.SERVICE,
    SESSION_STATE.INITIAL_STARTED,
    SESSION_STATE.INITIAL_COMPLETED,
    SESSION_STATE.EMISSION_STARTED,
    SESSION_STATE.EMISSION_COMPLETED,
    SESSION_STATE.RECIPIENT_STARTED,
    SESSION_STATE.RECIPIENT_COMPLETED,
    SESSION_STATE.LINES_STARTED,
    SESSION_STATE.LINES_COMPLETED
  ]);

  // Esta tabla es el contrato completo de estados. El reducer es el único lugar
  // que puede producir status/stage/payload nuevos para una sesión persistida.
  const SESSION_TRANSITIONS = Object.freeze({
    [SESSION_EVENT.PREPARE]: Object.freeze({ [SESSION_STATE.ABSENT]: SESSION_STATE.PREPARED }),
    [SESSION_EVENT.ASSOCIATE_TAB]: Object.freeze({ [SESSION_STATE.PREPARED]: SESSION_STATE.LOGIN }),
    [SESSION_EVENT.RECOVER]: Object.freeze(Object.fromEntries(ACTIVE_SESSION_STATES.map((state) => [state, state]))),
    [SESSION_EVENT.CLAIM_LOGIN_CUIT]: Object.freeze({ [SESSION_STATE.LOGIN]: SESSION_STATE.LOGIN }),
    [SESSION_EVENT.CLAIM_LOGIN_PASSWORD]: Object.freeze({
      [SESSION_STATE.LOGIN]: SESSION_STATE.LOGIN_WAITING_REPRESENTATIVE
    }),
    [SESSION_EVENT.CONSUME_CREDENTIAL]: Object.freeze({
      [SESSION_STATE.LOGIN_WAITING_REPRESENTATIVE]: SESSION_STATE.LOGIN_WAITING_REPRESENTATIVE
    }),
    [SESSION_EVENT.COMPLETE_LOGIN]: Object.freeze({
      [SESSION_STATE.LOGIN_WAITING_REPRESENTATIVE]: SESSION_STATE.LOGIN_WAITING_REPRESENTATIVE
    }),
    [SESSION_EVENT.CLAIM_REPRESENTATIVE]: Object.freeze({
      [SESSION_STATE.LOGIN_WAITING_REPRESENTATIVE]: SESSION_STATE.REPRESENTATIVE
    }),
    [SESSION_EVENT.CLAIM_SERVICE]: Object.freeze({
      [SESSION_STATE.REPRESENTATIVE]: SESSION_STATE.SERVICE
    }),
    [SESSION_EVENT.PAGE_DIAGNOSTIC]: Object.freeze(Object.fromEntries(ACTIVE_SESSION_STATES.map((state) => [state, state]))),
    [SESSION_EVENT.REVIEW_REACHED]: Object.freeze({
      [SESSION_STATE.LINES_COMPLETED]: SESSION_STATE.REVIEW
    }),
    [SESSION_EVENT.SECURITY_REJECTION]: Object.freeze(Object.fromEntries(
      ACTIVE_SESSION_STATES.map((state) => [state, SESSION_STATE.INTERRUPTED])
    )),
    [SESSION_EVENT.CANCEL]: Object.freeze(Object.fromEntries(
      ACTIVE_SESSION_STATES.map((state) => [state, SESSION_STATE.INTERRUPTED])
    )),
    [SESSION_EVENT.REPLACE]: Object.freeze(Object.fromEntries(
      ACTIVE_SESSION_STATES.map((state) => [state, SESSION_STATE.INTERRUPTED])
    )),
    [SESSION_EVENT.EXPIRE]: Object.freeze(Object.fromEntries(
      ACTIVE_SESSION_STATES.map((state) => [state, SESSION_STATE.INTERRUPTED])
    ))
  });

  const STAGE_PROGRESS_TRANSITIONS = Object.freeze({
    initial: Object.freeze({
      started: Object.freeze({
        [SESSION_STATE.SERVICE]: SESSION_STATE.INITIAL_STARTED,
        [SESSION_STATE.INITIAL_STARTED]: SESSION_STATE.INITIAL_STARTED,
        [SESSION_STATE.INITIAL_COMPLETED]: SESSION_STATE.INITIAL_COMPLETED
      }),
      completed: Object.freeze({
        [SESSION_STATE.SERVICE]: SESSION_STATE.INITIAL_COMPLETED,
        [SESSION_STATE.INITIAL_STARTED]: SESSION_STATE.INITIAL_COMPLETED,
        [SESSION_STATE.INITIAL_COMPLETED]: SESSION_STATE.INITIAL_COMPLETED
      })
    }),
    emission: Object.freeze({
      started: Object.freeze({
        [SESSION_STATE.INITIAL_COMPLETED]: SESSION_STATE.EMISSION_STARTED,
        [SESSION_STATE.EMISSION_STARTED]: SESSION_STATE.EMISSION_STARTED,
        [SESSION_STATE.EMISSION_COMPLETED]: SESSION_STATE.EMISSION_COMPLETED
      }),
      completed: Object.freeze({
        [SESSION_STATE.INITIAL_COMPLETED]: SESSION_STATE.EMISSION_COMPLETED,
        [SESSION_STATE.EMISSION_STARTED]: SESSION_STATE.EMISSION_COMPLETED,
        [SESSION_STATE.EMISSION_COMPLETED]: SESSION_STATE.EMISSION_COMPLETED
      })
    }),
    recipient: Object.freeze({
      started: Object.freeze({
        [SESSION_STATE.EMISSION_COMPLETED]: SESSION_STATE.RECIPIENT_STARTED,
        [SESSION_STATE.RECIPIENT_STARTED]: SESSION_STATE.RECIPIENT_STARTED,
        [SESSION_STATE.RECIPIENT_COMPLETED]: SESSION_STATE.RECIPIENT_COMPLETED
      }),
      completed: Object.freeze({
        [SESSION_STATE.EMISSION_COMPLETED]: SESSION_STATE.RECIPIENT_COMPLETED,
        [SESSION_STATE.RECIPIENT_STARTED]: SESSION_STATE.RECIPIENT_COMPLETED,
        [SESSION_STATE.RECIPIENT_COMPLETED]: SESSION_STATE.RECIPIENT_COMPLETED
      })
    }),
    lines: Object.freeze({
      started: Object.freeze({
        [SESSION_STATE.RECIPIENT_COMPLETED]: SESSION_STATE.LINES_STARTED,
        [SESSION_STATE.LINES_STARTED]: SESSION_STATE.LINES_STARTED,
        [SESSION_STATE.LINES_COMPLETED]: SESSION_STATE.LINES_COMPLETED
      }),
      completed: Object.freeze({
        [SESSION_STATE.RECIPIENT_COMPLETED]: SESSION_STATE.LINES_COMPLETED,
        [SESSION_STATE.LINES_STARTED]: SESSION_STATE.LINES_COMPLETED,
        [SESSION_STATE.LINES_COMPLETED]: SESSION_STATE.LINES_COMPLETED
      })
    })
  });

  const SAFE_DIAGNOSTIC_REASONS = new Set([
    "",
    "network_error",
    "screen_unrecognized",
    "selector_changed",
    "manual_action_required",
    "authorization_rejected",
    "unexpected_response",
    "session_expired",
    "payload_invalid",
    "manual_abort",
    "timeout",
    "pagehide",
    "unload",
    "session_replaced",
    "association_failed"
  ]);
  const SAFE_TRACE_STATUSES = new Set([
    "absent",
    "prepared",
    "waiting_login",
    "waiting_representative",
    "service_recognized",
    "completing_stage",
    "fields_completed",
    "review_reached",
    "interrupted"
  ]);
  const SAFE_TRACE_STAGES = new Set([
    "",
    "login",
    "representative",
    "service",
    "initial",
    "emission",
    "recipient",
    "lines",
    "review"
  ]);
  const SAFE_TRACE_RESULTS = new Set(["applied", "recorded", "rejected"]);
  const SAFE_TRACE_FLAG_KEYS = Object.freeze([
    "payloadPresent",
    "revisionPresent",
    "loginCuitSubmitted",
    "loginPasswordSubmitted",
    "loginCredentialConsumed",
    "loginCompleted",
    "tabMatched",
    "correlationMatched",
    "generationMatched"
  ]);

  function bytesToArray(value) {
    return Array.from(new Uint8Array(value));
  }

  function validByteArray(value, expectedLength = null) {
    return Array.isArray(value)
      && (expectedLength === null || value.length === expectedLength)
      && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
  }

  function validVaultRecord(record) {
    return Boolean(
      record
      && record.formatVersion === VAULT_FORMAT_VERSION
      && record.cuit === AUTHORIZED_LOGIN_CUIT
      && record.algorithm === "AES-GCM"
      && validByteArray(record.iv, 12)
      && validByteArray(record.ciphertext)
      && record.ciphertext.length >= 17
    );
  }

  function validVaultKey(key) {
    return Boolean(
      key
      && key.type === "secret"
      && key.extractable === false
      && key.algorithm?.name === "AES-GCM"
      && key.algorithm?.length === 256
      && Array.isArray(key.usages)
      && key.usages.length === 2
      && key.usages.includes("encrypt")
      && key.usages.includes("decrypt")
    );
  }

  function createVaultController({ cryptoApi, keyStore, recordStore, aadValue = VAULT_AAD }) {
    const subtle = cryptoApi?.subtle;
    const encoder = new TextEncoder();
    const aad = encoder.encode(aadValue);

    async function forget() {
      await Promise.all([recordStore.remove(), keyStore.remove()]);
      return { ok: true, status: "forgotten" };
    }

    async function key({ create = false } = {}) {
      let current = await keyStore.get();
      if (current && !validVaultKey(current)) {
        await forget();
        current = null;
      }
      if (!current && create) {
        current = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
          "encrypt",
          "decrypt"
        ]);
        if (!validVaultKey(current)) throw new Error("vault_key_invalid");
        await keyStore.set(current);
      }
      return current || null;
    }

    async function status() {
      const record = await recordStore.get();
      if (!record) return { ok: true, status: "empty" };
      if (!validVaultRecord(record) || !(await key())) {
        await forget();
        return { ok: false, status: "invalid" };
      }
      return { ok: true, status: "stored" };
    }

    async function save(value) {
      let secret = typeof value === "string" ? value : "";
      if (!secret) return { ok: false, status: "empty" };
      try {
        const vaultKey = await key({ create: true });
        const iv = cryptoApi.getRandomValues(new Uint8Array(12));
        const ciphertext = await subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
          vaultKey,
          encoder.encode(secret)
        );
        await recordStore.set({
          formatVersion: VAULT_FORMAT_VERSION,
          cuit: AUTHORIZED_LOGIN_CUIT,
          algorithm: "AES-GCM",
          iv: bytesToArray(iv),
          ciphertext: bytesToArray(ciphertext)
        });
        return { ok: true, status: "stored" };
      } finally {
        secret = null;
      }
    }

    async function decrypt() {
      const record = await recordStore.get();
      if (!validVaultRecord(record)) {
        if (record) await forget();
        return { ok: false, status: "invalid" };
      }
      const vaultKey = await key();
      if (!vaultKey) {
        await forget();
        return { ok: false, status: "invalid" };
      }
      try {
        const plaintext = await subtle.decrypt(
          {
            name: "AES-GCM",
            iv: new Uint8Array(record.iv),
            additionalData: aad,
            tagLength: 128
          },
          vaultKey,
          new Uint8Array(record.ciphertext)
        );
        let secret = new TextDecoder().decode(plaintext);
        if (!secret) throw new Error("vault_plaintext_empty");
        const result = { ok: true, status: "available", secret };
        secret = null;
        return result;
      } catch {
        await forget();
        return { ok: false, status: "invalid" };
      }
    }

    return { decrypt, forget, key, save, status };
  }

  function trustedPopupSender(sender) {
    try {
      const url = new URL(sender?.url || "");
      return url.protocol === "chrome-extension:"
        && url.hostname === root.chrome?.runtime?.id
        && url.pathname === "/popup.html";
    } catch {
      return false;
    }
  }

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

  function trustedLoginSender(sender) {
    if (!trustedInternalSender(sender)) return false;
    try {
      const url = new URL(sender.url);
      return url.hostname === "auth.afip.gob.ar"
        && (url.pathname === "/contribuyente_/login.xhtml"
          || url.pathname === "/contribuyente_/login.xhtml/");
    } catch {
      return false;
    }
  }

  function messageMatchesSession(message, session, { requireGeneration = false } = {}) {
    return Boolean(
      message
      && session?.payload
      && message.sessionId === session.id
      && message.revision === session.payload.revision
      && (!requireGeneration || (
        Number.isSafeInteger(message.generation)
        && message.generation === session.generation
      ))
    );
  }

  function trustedRepresentativeSender(sender) {
    if (!trustedInternalSender(sender)) return false;
    try {
      const url = new URL(sender.url);
      return url.protocol === "https:"
        && url.hostname === "fe.afip.gob.ar"
        && url.port === ""
        && url.pathname === "/rcel/jsp/index_bis.jsp"
        && url.search === ""
        && url.hash === "";
    } catch {
      return false;
    }
  }

  function trustedSenderForStage(sender, stage) {
    if (stage === "login") return trustedLoginSender(sender);
    if (stage === "representative") return trustedRepresentativeSender(sender);
    return ["service", "initial", "emission", "recipient", "lines"].includes(stage)
      && trustedInternalSender(sender);
  }

  function trustedReviewSender(sender) {
    if (!trustedInternalSender(sender)) return false;
    try {
      const url = new URL(sender.url);
      return url.protocol === "https:"
        && url.hostname === "fe.afip.gob.ar"
        && url.port === ""
        && url.pathname === "/rcel/jsp/genComResumenDatos.do"
        && url.search === ""
        && url.hash === "";
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
      updatedAt: session.updatedAt,
      generation: session.generation,
      sequence: session.sequence
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

  function callStorageArea(area, method, argument) {
    if (!area) return Promise.reject(new Error("storage_unavailable"));
    return new Promise((resolve, reject) => {
      try {
        const result = area[method](argument, (value) => {
          const error = root.chrome?.runtime?.lastError;
          if (error) reject(new Error(error.message));
          else resolve(value);
        });
        if (result && typeof result.then === "function") result.then(resolve, reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  function openVaultDatabase() {
    return new Promise((resolve, reject) => {
      if (!root.indexedDB) return reject(new Error("indexeddb_unavailable"));
      const request = root.indexedDB.open(VAULT_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(VAULT_STORE_NAME)) {
          database.createObjectStore(VAULT_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("indexeddb_open_failed"));
    });
  }

  async function vaultKeyOperation(mode, value) {
    const database = await openVaultDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(VAULT_STORE_NAME, mode === "get" ? "readonly" : "readwrite");
        const store = transaction.objectStore(VAULT_STORE_NAME);
        let result;
        const request = mode === "get"
          ? store.get(VAULT_KEY_ID)
          : mode === "set"
            ? store.put(value, VAULT_KEY_ID)
            : store.delete(VAULT_KEY_ID);
        request.onsuccess = () => {
          result = request.result;
        };
        request.onerror = () => reject(request.error || new Error("indexeddb_request_failed"));
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(transaction.error || new Error("indexeddb_transaction_failed"));
        transaction.onerror = () => reject(transaction.error || new Error("indexeddb_transaction_failed"));
      });
    } finally {
      database.close();
    }
  }

  function productionVaultController() {
    if (activeVaultController) return activeVaultController;
    if (!root.crypto?.subtle || !root.chrome?.storage?.local) {
      throw new Error("vault_runtime_unavailable");
    }
    activeVaultController = createVaultController({
      cryptoApi: root.crypto,
      keyStore: {
        get: () => vaultKeyOperation("get"),
        set: (value) => vaultKeyOperation("set", value),
        remove: () => vaultKeyOperation("remove")
      },
      recordStore: {
        async get() {
          const result = await callStorageArea(root.chrome.storage.local, "get", VAULT_STORAGE_KEY);
          return result?.[VAULT_STORAGE_KEY] || null;
        },
        set: (value) => callStorageArea(root.chrome.storage.local, "set", { [VAULT_STORAGE_KEY]: value }),
        remove: () => callStorageArea(root.chrome.storage.local, "remove", VAULT_STORAGE_KEY)
      }
    });
    return activeVaultController;
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

  async function readGenerationCounter() {
    if (!storageArea()) return fallbackGeneration;
    const result = await callStorage("get", SESSION_GENERATION_STORAGE_KEY);
    const value = result?.[SESSION_GENERATION_STORAGE_KEY];
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  async function nextSessionGeneration(records = {}) {
    const storedGeneration = await readGenerationCounter();
    const recordGeneration = Object.values(records).reduce((maximum, session) => (
      Number.isSafeInteger(session?.generation) ? Math.max(maximum, session.generation) : maximum
    ), 0);
    const next = Math.max(storedGeneration, recordGeneration) + 1;
    if (!storageArea()) {
      fallbackGeneration = next;
      return next;
    }
    await callStorage("set", { [SESSION_GENERATION_STORAGE_KEY]: next });
    return next;
  }

  async function readSafeTrace() {
    if (!storageArea()) return fallbackTrace.map(sanitizeSafeTraceEntry);
    const result = await callStorage("get", SESSION_TRACE_STORAGE_KEY);
    const trace = result?.[SESSION_TRACE_STORAGE_KEY];
    return Array.isArray(trace) ? trace.slice(-SESSION_TRACE_LIMIT).map(sanitizeSafeTraceEntry) : [];
  }

  async function writeSafeTrace(trace) {
    const safeTrace = Array.isArray(trace)
      ? trace.slice(-SESSION_TRACE_LIMIT).map(sanitizeSafeTraceEntry)
      : [];
    if (!storageArea()) {
      fallbackTrace = safeTrace.map((entry) => ({ ...entry, flags: { ...entry.flags } }));
      return;
    }
    await callStorage("set", { [SESSION_TRACE_STORAGE_KEY]: safeTrace });
  }

  async function clearSafeTrace() {
    await writeSafeTrace([]);
  }

  function safeReason(reason) {
    const value = String(reason || "");
    return SAFE_DIAGNOSTIC_REASONS.has(value) ? value : "unexpected_response";
  }

  function safeTraceSender(host, path) {
    const senderHost = String(host || "").toLowerCase();
    const senderPath = String(path || "");
    if (senderHost === "127.0.0.1" || senderHost === "erp_local") {
      return { senderHost: "erp_local", senderPath: "/erp" };
    }
    if (senderHost === "extension" || senderHost === String(root.chrome?.runtime?.id || "").toLowerCase()) {
      return {
        senderHost: "extension",
        senderPath: senderPath === "/popup.html" || senderPath === "/popup" ? "/popup" : "/extension"
      };
    }
    if (senderHost === "auth.afip.gob.ar") {
      return {
        senderHost,
        senderPath: ["/contribuyente_/login.xhtml", "/contribuyente_/login.xhtml/", "/login"].includes(senderPath)
          ? "/login"
          : "/other"
      };
    }
    if (senderHost === "fe.afip.gob.ar") {
      return {
        senderHost,
        senderPath: ["/rcel/jsp/index_bis.jsp", "/representative"].includes(senderPath)
          ? "/representative"
          : "/other"
      };
    }
    if (senderHost === "serviciosjava2.afip.gob.ar") {
      return {
        senderHost,
        senderPath: senderPath === "/service" || senderPath === "/rcel" || senderPath.startsWith("/rcel/")
          ? "/service"
          : "/other"
      };
    }
    return { senderHost: "", senderPath: "" };
  }

  function safeTraceTimestamp(value) {
    const timestamp = Date.parse(String(value || ""));
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
  }

  function sanitizeSafeTraceEntry(entry) {
    const identity = safeTraceSender(entry?.senderHost, entry?.senderPath);
    const flags = Object.fromEntries(
      SAFE_TRACE_FLAG_KEYS.map((key) => [key, entry?.flags?.[key] === true])
    );
    return {
      sequence: Number.isSafeInteger(entry?.sequence) && entry.sequence >= 0 ? entry.sequence : 0,
      timestamp: safeTraceTimestamp(entry?.timestamp),
      eventType: Object.values(SESSION_EVENT).includes(entry?.eventType) ? entry.eventType : "UNKNOWN",
      senderHost: identity.senderHost,
      senderPath: identity.senderPath,
      stateBefore: SAFE_TRACE_STATUSES.has(String(entry?.stateBefore || ""))
        ? String(entry.stateBefore)
        : "absent",
      stateAfter: SAFE_TRACE_STATUSES.has(String(entry?.stateAfter || ""))
        ? String(entry.stateAfter)
        : "absent",
      stageBefore: SAFE_TRACE_STAGES.has(String(entry?.stageBefore || ""))
        ? String(entry.stageBefore)
        : "",
      stageAfter: SAFE_TRACE_STAGES.has(String(entry?.stageAfter || ""))
        ? String(entry.stageAfter)
        : "",
      reason: safeReason(entry?.reason),
      flags,
      result: SAFE_TRACE_RESULTS.has(String(entry?.result || "")) ? String(entry.result) : "rejected"
    };
  }

  function senderTraceIdentity(sender) {
    try {
      const url = new URL(sender?.url || sender?.origin || "");
      return safeTraceSender(url.hostname, url.pathname);
    } catch {
      return { senderHost: "", senderPath: "" };
    }
  }

  function sessionStateKey(session) {
    if (!session) return SESSION_STATE.ABSENT;
    return `${String(session.status || "")}|${String(session.stage || "")}`;
  }

  function stateFields(stateKey) {
    const separator = stateKey.indexOf("|");
    return separator === -1
      ? { status: "", stage: "" }
      : { status: stateKey.slice(0, separator), stage: stateKey.slice(separator + 1) };
  }

  function normalizedSessionRecord(session) {
    if (!session) return null;
    return {
      ...session,
      generation: Number.isSafeInteger(session.generation) && session.generation > 0
        ? session.generation
        : 1,
      sequence: Number.isSafeInteger(session.sequence) && session.sequence >= 0
        ? session.sequence
        : 0,
      loginCuitSubmitted: session.loginCuitSubmitted === true,
      loginPasswordSubmitted: session.loginPasswordSubmitted === true,
      loginCredentialConsumed: session.loginCredentialConsumed === true,
      loginCompleted: session.loginCompleted === true
    };
  }

  function reduceSession(session, event) {
    if (!event || !Object.values(SESSION_EVENT).includes(event.type)) {
      return { ok: false, result: "rejected", reason: "unexpected_response", session };
    }
    if (event.type === SESSION_EVENT.PREPARE) {
      if (session || !Number.isSafeInteger(event.generation) || event.generation <= 0 || !event.payload) {
        return { ok: false, result: "rejected", reason: "unexpected_response", session };
      }
      const now = event.timestamp || new Date().toISOString();
      return {
        ok: true,
        result: "applied",
        reason: "",
        session: {
          id: event.sessionId,
          payload: event.payload,
          orderId: event.payload.order.id,
          status: "prepared",
          stage: "",
          reason: "",
          diagnosticReason: "",
          diagnosticStage: "",
          tabId: null,
          updatedAt: now,
          expiresAt: Date.parse(event.payload.expiresAt),
          generation: event.generation,
          sequence: 1,
          loginCuitSubmitted: false,
          loginPasswordSubmitted: false,
          loginCredentialConsumed: false,
          loginCompleted: false
        }
      };
    }

    const current = normalizedSessionRecord(session);
    if (!current) return { ok: false, result: "rejected", reason: "session_absent", session: null };
    const stateBefore = sessionStateKey(current);
    const transitionTable = event.type === SESSION_EVENT.STAGE_PROGRESS
      ? STAGE_PROGRESS_TRANSITIONS[event.stage]?.[event.phase]
      : SESSION_TRANSITIONS[event.type];
    const stateAfter = transitionTable?.[stateBefore];
    if (!stateAfter) {
      return { ok: false, result: "rejected", reason: "unexpected_response", session: current };
    }
    if (event.type === SESSION_EVENT.CLAIM_LOGIN_CUIT
      && (current.loginCuitSubmitted || current.loginPasswordSubmitted)) {
      return { ok: false, result: "rejected", reason: "authorization_rejected", session: current };
    }
    if (event.type === SESSION_EVENT.CLAIM_LOGIN_PASSWORD
      && (!current.loginCuitSubmitted || current.loginPasswordSubmitted)) {
      return { ok: false, result: "rejected", reason: "authorization_rejected", session: current };
    }
    if (event.type === SESSION_EVENT.CONSUME_CREDENTIAL
      && (!current.loginPasswordSubmitted || current.loginCredentialConsumed)) {
      return { ok: false, result: "rejected", reason: "authorization_rejected", session: current };
    }
    if (event.type === SESSION_EVENT.COMPLETE_LOGIN
      && (!current.loginPasswordSubmitted || !current.loginCredentialConsumed || current.loginCompleted)) {
      return { ok: false, result: "rejected", reason: "authorization_rejected", session: current };
    }
    if (event.type === SESSION_EVENT.EXPIRE && current.expiresAt > Number(event.now || Date.now())) {
      return { ok: false, result: "rejected", reason: "unexpected_response", session: current };
    }
    if (event.type === SESSION_EVENT.SECURITY_REJECTION && (
      event.authenticated !== true
      || String(event.stage || "") !== String(current.stage || "")
      || !SAFE_DIAGNOSTIC_REASONS.has(String(event.reason || ""))
    )) {
      return { ok: false, result: "rejected", reason: "authorization_rejected", session: current };
    }
    if (event.type === SESSION_EVENT.REVIEW_REACHED && event.finalSafe !== true) {
      return { ok: false, result: "rejected", reason: "authorization_rejected", session: current };
    }

    const next = { ...current };
    const fields = stateFields(stateAfter);
    next.status = fields.status;
    next.stage = fields.stage;
    next.sequence = current.sequence + 1;
    next.updatedAt = event.timestamp || new Date().toISOString();
    if (event.type !== SESSION_EVENT.PAGE_DIAGNOSTIC) {
      next.reason = "";
    }
    if (event.type === SESSION_EVENT.ASSOCIATE_TAB) next.tabId = event.tabId;
    if (event.type === SESSION_EVENT.CLAIM_LOGIN_CUIT) next.loginCuitSubmitted = true;
    if (event.type === SESSION_EVENT.CLAIM_LOGIN_PASSWORD) next.loginPasswordSubmitted = true;
    if (event.type === SESSION_EVENT.CONSUME_CREDENTIAL) next.loginCredentialConsumed = true;
    if (event.type === SESSION_EVENT.COMPLETE_LOGIN) next.loginCompleted = true;
    if (event.type === SESSION_EVENT.CLAIM_REPRESENTATIVE) next.loginCompleted = true;
    if (event.type === SESSION_EVENT.PAGE_DIAGNOSTIC) {
      next.diagnosticReason = safeReason(event.reason);
      next.diagnosticStage = String(event.stage || current.stage || "");
    } else {
      next.diagnosticReason = "";
      next.diagnosticStage = "";
    }
    if ([
      SESSION_EVENT.SECURITY_REJECTION,
      SESSION_EVENT.CANCEL,
      SESSION_EVENT.REPLACE,
      SESSION_EVENT.EXPIRE
    ].includes(event.type)) {
      next.reason = safeReason(event.reason);
      next.payload = null;
    }
    if (event.type === SESSION_EVENT.REVIEW_REACHED) {
      next.payload = null;
    }
    return { ok: true, result: stateBefore === stateAfter ? "recorded" : "applied", reason: "", session: next };
  }

  function traceFlags(session, context = {}) {
    return {
      payloadPresent: Boolean(session?.payload),
      revisionPresent: Boolean(session?.payload?.revision),
      loginCuitSubmitted: session?.loginCuitSubmitted === true,
      loginPasswordSubmitted: session?.loginPasswordSubmitted === true,
      loginCredentialConsumed: session?.loginCredentialConsumed === true,
      loginCompleted: session?.loginCompleted === true,
      tabMatched: context.tabMatched === true,
      correlationMatched: context.correlationMatched === true,
      generationMatched: context.generationMatched === true
    };
  }

  function safeTraceEntry(before, after, event, sender, result, context = {}) {
    const identity = senderTraceIdentity(sender);
    return sanitizeSafeTraceEntry({
      sequence: Number.isSafeInteger(after?.sequence) ? after.sequence : Number(before?.sequence || 0),
      timestamp: event.timestamp || new Date().toISOString(),
      eventType: Object.values(SESSION_EVENT).includes(event.type) ? event.type : "UNKNOWN",
      senderHost: identity.senderHost,
      senderPath: identity.senderPath,
      stateBefore: String(before?.status || "absent"),
      stateAfter: String(after?.status || before?.status || "absent"),
      stageBefore: String(before?.stage || ""),
      stageAfter: String(after?.stage || before?.stage || ""),
      reason: safeReason(event.reason),
      flags: traceFlags(after || before, context),
      result: ["applied", "recorded", "rejected"].includes(result) ? result : "rejected"
    });
  }

  async function appendSafeTrace(entry) {
    const trace = await readSafeTrace();
    trace.push(entry);
    await writeSafeTrace(trace);
  }

  function withStorageCritical(operation) {
    const run = storageCriticalQueue.then(operation, operation);
    storageCriticalQueue = run.catch(() => {});
    return run;
  }

  function withSessionMutation(sessionId, operation) {
    const key = String(sessionId || "");
    const previous = sessionMutationQueues.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(() => withStorageCritical(operation));
    const tracked = run.finally(() => {
      if (sessionMutationQueues.get(key) === tracked) sessionMutationQueues.delete(key);
    });
    sessionMutationQueues.set(key, tracked);
    return tracked;
  }

  function notifyTerminalSession(before, after, { closeTab = false } = {}) {
    const revision = before?.payload?.revision || "";
    if (after?.tabId && root.chrome?.tabs?.sendMessage) {
      root.chrome.tabs.sendMessage(after.tabId, {
        type: "CANCEL_ACTIVE_SESSION",
        sessionId: after.id,
        revision,
        reason: after.reason
      }, () => void root.chrome.runtime.lastError);
    }
    if (closeTab && after?.tabId && root.chrome?.tabs?.remove) {
      root.chrome.tabs.remove(after.tabId, () => void root.chrome.runtime.lastError);
    }
  }

  function cancelSession(session, reason, { closeTab = false } = {}) {
    if (!session) return null;
    const before = normalizedSessionRecord(session);
    const reduced = reduceSession(before, {
      type: reason === "timeout" ? SESSION_EVENT.EXPIRE : SESSION_EVENT.CANCEL,
      reason,
      now: reason === "timeout" ? Number.MAX_SAFE_INTEGER : Date.now()
    });
    if (!reduced.ok) return session;
    Object.assign(session, reduced.session);
    notifyTerminalSession(before, reduced.session, { closeTab });
    return session;
  }

  async function expireSessionUnlocked(sessionId, sender = null, now = Date.now()) {
    const records = await readSessionRecords();
    const before = normalizedSessionRecord(records[sessionId]);
    if (!before) return null;
    const event = { type: SESSION_EVENT.EXPIRE, reason: "timeout", now };
    const reduced = reduceSession(before, event);
    await appendSafeTrace(safeTraceEntry(before, reduced.session, event, sender, reduced.result, {
      tabMatched: true,
      correlationMatched: true,
      generationMatched: true
    }));
    if (!reduced.ok) return before;
    records[sessionId] = reduced.session;
    await writeSessionRecords(records);
    notifyTerminalSession(before, reduced.session);
    clearExpiryAlarm(sessionId);
    await clearSafeTrace();
    return reduced.session;
  }

  function expireSession(sessionId, records = null) {
    void records;
    return withSessionMutation(sessionId, () => expireSessionUnlocked(sessionId));
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

  async function prepareSessionUnlocked(message, sender) {
    const records = await readSessionRecords();
    const rejectionReason = preparedMessageRejectionReason(message);
    for (const existingValue of Object.values(records)) {
      const existing = normalizedSessionRecord(existingValue);
      const reduced = reduceSession(existing, {
        type: SESSION_EVENT.REPLACE,
        reason: "session_replaced"
      });
      if (reduced.ok) notifyTerminalSession(existing, reduced.session);
      clearExpiryAlarm(existing.id);
    }
    await writeSessionRecords({});
    await clearSafeTrace();
    if (rejectionReason) {
      return {
        ok: false,
        status: "rejected",
        reason: rejectionReason,
        contractVersion: ARCA_FISCAL.CONTRACT.version
      };
    }

    let vaultStatus;
    try {
      vaultStatus = await productionVaultController().status();
    } catch {
      vaultStatus = { ok: false, status: "invalid" };
    }
    if (!vaultStatus.ok || vaultStatus.status !== "stored") {
      return { ok: false, status: "rejected", reason: "manual_action_required" };
    }

    const generation = await nextSessionGeneration(records);
    const prepareEvent = {
      type: SESSION_EVENT.PREPARE,
      sessionId: message.sessionId,
      payload: message.payload,
      generation
    };
    const prepared = reduceSession(null, prepareEvent);
    if (!prepared.ok) return { ok: false, status: "rejected", reason: "unexpected_response" };
    let currentRecords = { [prepared.session.id]: prepared.session };
    await writeSessionRecords(currentRecords);
    await appendSafeTrace(safeTraceEntry(null, prepared.session, prepareEvent, sender, prepared.result, {
      correlationMatched: true,
      generationMatched: true
    }));
    createExpiryAlarm(prepared.session);

    let createdTab = null;
    try {
      createdTab = await createTab(LOGIN_URL);
      if (!createdTab?.id) throw new Error("arca_tab_missing");
      currentRecords = await readSessionRecords();
      const latest = normalizedSessionRecord(currentRecords[prepared.session.id]);
      if (!latest || latest.generation !== generation || latest.payload?.revision !== message.payload.revision) {
        throw new Error("session_replaced");
      }
      const associationEvent = { type: SESSION_EVENT.ASSOCIATE_TAB, tabId: createdTab.id };
      const associated = reduceSession(latest, associationEvent);
      if (!associated.ok) throw new Error("association_failed");
      currentRecords[latest.id] = associated.session;
      await writeSessionRecords(currentRecords);
      await appendSafeTrace(safeTraceEntry(latest, associated.session, associationEvent, sender, associated.result, {
        tabMatched: true,
        correlationMatched: true,
        generationMatched: true
      }));
      return publicStatus(associated.session);
    } catch {
      clearExpiryAlarm(prepared.session.id);
      currentRecords = await readSessionRecords();
      delete currentRecords[prepared.session.id];
      await writeSessionRecords(currentRecords);
      await clearSafeTrace();
      if (createdTab?.id && root.chrome?.tabs?.remove) {
        root.chrome.tabs.remove(createdTab.id, () => void root.chrome.runtime.lastError);
      }
      return { ok: false, status: "interrupted", reason: "association_failed" };
    }
  }

  function prepareSession(message, sender) {
    if (!trustedExternalSender(sender)) {
      return Promise.resolve({ ok: false, status: "rejected", reason: "origin_rejected" });
    }
    return withStorageCritical(() => prepareSessionUnlocked(message, sender));
  }

  async function applyStoredSessionEventUnlocked(message, sender, event) {
    const records = await readSessionRecords();
    const before = normalizedSessionRecord(records[String(message?.sessionId || "")]);
    const context = {
      tabMatched: Boolean(before && before.tabId === sender?.tab?.id),
      correlationMatched: Boolean(before && messageMatchesSession(message, before)),
      generationMatched: Boolean(before && Number.isSafeInteger(message?.generation)
        && message.generation === before.generation)
    };
    if (!before || !context.tabMatched || !context.correlationMatched || !context.generationMatched) {
      if (before) {
        await appendSafeTrace(safeTraceEntry(before, before, event, sender, "rejected", context));
      }
      return { ok: false, status: "rejected", reason: "authorization_rejected", session: before };
    }
    if (before.expiresAt <= Date.now() && event.type !== SESSION_EVENT.EXPIRE) {
      const expired = await expireSessionUnlocked(before.id, sender);
      return { ok: false, status: "rejected", reason: "session_expired", session: expired };
    }
    const reduced = reduceSession(before, event);
    await appendSafeTrace(safeTraceEntry(before, reduced.session, event, sender, reduced.result, context));
    if (!reduced.ok) {
      return { ok: false, status: "rejected", reason: reduced.reason, session: before };
    }
    records[before.id] = reduced.session;
    await writeSessionRecords(records);
    if ([SESSION_EVENT.SECURITY_REJECTION, SESSION_EVENT.REVIEW_REACHED].includes(event.type)) {
      clearExpiryAlarm(before.id);
      if (event.type === SESSION_EVENT.SECURITY_REJECTION) {
        notifyTerminalSession(before, reduced.session);
      }
    }
    return { ok: true, status: reduced.session.status, reason: "", session: reduced.session };
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
    if (!trustedExternalSender(sender)) {
      return { ok: false, status: "rejected", reason: "unexpected_response" };
    }
    if (message?.type === "GET_SESSION_STATUS") {
      return withStorageCritical(async () => {
        const records = await readSessionRecords();
        const sessionId = String(message.sessionId || "");
        const session = normalizedSessionRecord(records[sessionId]);
        if (session && session.expiresAt <= Date.now()) {
          return publicStatus(await expireSessionUnlocked(session.id, sender));
        }
        return publicStatus(session);
      });
    }
    if (message?.type === "CANCEL_SESSION") {
      const sessionId = String(message.sessionId || "");
      return withSessionMutation(sessionId, async () => {
        const records = await readSessionRecords();
        const before = normalizedSessionRecord(records[sessionId]);
        if (!before || !messageMatchesSession(message, before, { requireGeneration: true })) {
          return { ok: false, status: "not_found", reason: "unexpected_response" };
        }
        const reduced = reduceSession(before, { type: SESSION_EVENT.CANCEL, reason: "manual_abort" });
        if (!reduced.ok) return { ok: false, status: "not_found", reason: "unexpected_response" };
        notifyTerminalSession(before, reduced.session, { closeTab: message.closeTab === true });
        clearExpiryAlarm(before.id);
        delete records[sessionId];
        await writeSessionRecords(records);
        await clearSafeTrace();
        return publicStatus(reduced.session);
      });
    }
    return { ok: false, status: "rejected", reason: "unexpected_response" };
  }

  function activeSessionResponse(session) {
    return {
      ok: true,
      sessionId: session.id,
      revision: session.payload.revision,
      generation: session.generation,
      sequence: session.sequence,
      payload: session.payload,
      status: session.status,
      stage: session.stage || ""
    };
  }

  function mutationResponse(result, requestedStage = "") {
    const session = result.session;
    return {
      ok: result.ok,
      status: result.ok ? session.status : (result.status || "rejected"),
      reason: result.ok ? "" : (result.reason || "authorization_rejected"),
      stage: requestedStage || session?.stage || "",
      generation: session?.generation,
      sequence: session?.sequence
    };
  }

  async function getActiveSession(sender) {
    return withStorageCritical(async () => {
      const records = await readSessionRecords();
      const found = Object.values(records).find((entry) => entry.tabId === sender.tab.id);
      const session = normalizedSessionRecord(found);
      if (!session) return { ok: false, status: "not_found", reason: "session_absent" };
      if (session.expiresAt <= Date.now()) {
        await expireSessionUnlocked(session.id, sender);
        return { ok: false, status: "interrupted", reason: "session_expired" };
      }
      if (!session.payload || ["review_reached", "interrupted"].includes(session.status)) {
        return {
          ok: false,
          status: session.status || "interrupted",
          reason: session.reason || "session_terminal"
        };
      }
      const event = { type: SESSION_EVENT.RECOVER, reason: "" };
      const recovered = reduceSession(session, event);
      if (!recovered.ok) return { ok: false, status: "rejected", reason: "unexpected_response" };
      records[session.id] = recovered.session;
      await writeSessionRecords(records);
      await appendSafeTrace(safeTraceEntry(session, recovered.session, event, sender, recovered.result, {
        tabMatched: true,
        correlationMatched: true,
        generationMatched: true
      }));
      return activeSessionResponse(recovered.session);
    });
  }

  async function internalMutationMessage(message, sender) {
    const sessionId = String(message?.sessionId || "");
    if (!sessionId) return { ok: false, status: "rejected", reason: "authorization_rejected" };
    return withSessionMutation(sessionId, async () => {
      if (message.type === "AUTHORIZE_LOGIN_ACTION") {
        if (!trustedLoginSender(sender)) {
          return { ok: false, status: "rejected", stage: message.stage || "" };
        }
        const eventType = {
          login_cuit: SESSION_EVENT.CLAIM_LOGIN_CUIT,
          login_password: SESSION_EVENT.CLAIM_LOGIN_PASSWORD
        }[message.stage];
        if (!eventType) return { ok: false, status: "rejected", stage: message.stage || "" };
        return mutationResponse(
          await applyStoredSessionEventUnlocked(message, sender, { type: eventType, reason: "" }),
          message.stage
        );
      }
      if (message.type === "CONSUME_ENCRYPTED_CREDENTIAL") {
        if (!trustedLoginSender(sender)) return { ok: false, status: "invalid" };
        const claimed = await applyStoredSessionEventUnlocked(message, sender, {
          type: SESSION_EVENT.CONSUME_CREDENTIAL,
          reason: ""
        });
        if (!claimed.ok) return { ok: false, status: "invalid" };
        const decrypted = await productionVaultController().decrypt();
        return { ...decrypted, generation: claimed.session.generation, sequence: claimed.session.sequence };
      }
      if (message.type === "COMPLETE_LOGIN_ACTION") {
        if (!trustedLoginSender(sender)) return { ok: false, status: "rejected", stage: "login" };
        return mutationResponse(await applyStoredSessionEventUnlocked(message, sender, {
          type: SESSION_EVENT.COMPLETE_LOGIN,
          reason: ""
        }));
      }
      if (message.type === "AUTHORIZE_INTERIM_ACTION") {
        if (message.stage === "representative" && (
          !trustedRepresentativeSender(sender)
          || message.domContract !== REPRESENTATIVE_DOM_CONTRACT
        )) {
          return { ok: false, status: "rejected", stage: message.stage };
        }
        const eventType = {
          representative: SESSION_EVENT.CLAIM_REPRESENTATIVE,
          service: SESSION_EVENT.CLAIM_SERVICE
        }[message.stage];
        if (!eventType) return { ok: false, status: "rejected", stage: message.stage || "" };
        return mutationResponse(
          await applyStoredSessionEventUnlocked(message, sender, { type: eventType, reason: "" }),
          message.stage
        );
      }
      if (message.type === "REPORT_STAGE_PROGRESS") {
        if (!STAGE_PROGRESS_TRANSITIONS[message.stage]?.[message.phase]) {
          return { ok: false, status: "rejected", reason: "unexpected_response" };
        }
        return mutationResponse(await applyStoredSessionEventUnlocked(message, sender, {
          type: SESSION_EVENT.STAGE_PROGRESS,
          stage: message.stage,
          phase: message.phase,
          reason: ""
        }));
      }
      if (message.type === "REPORT_PAGE_DIAGNOSTIC") {
        if (!SAFE_DIAGNOSTIC_REASONS.has(String(message.reason || ""))) {
          return { ok: false, status: "rejected", reason: "unexpected_response" };
        }
        return mutationResponse(await applyStoredSessionEventUnlocked(message, sender, {
          type: SESSION_EVENT.PAGE_DIAGNOSTIC,
          stage: String(message.stage || ""),
          reason: message.reason
        }));
      }
      if (message.type === "REPORT_DOCUMENT_TRANSITION") {
        if (!["pagehide", "unload"].includes(message.reason)) {
          return { ok: false, status: "rejected", reason: "unexpected_response" };
        }
        return mutationResponse(await applyStoredSessionEventUnlocked(message, sender, {
          type: SESSION_EVENT.PAGE_DIAGNOSTIC,
          stage: String(message.stage || ""),
          reason: message.reason
        }));
      }
      if (message.type === "REJECT_SESSION_SECURITY") {
        if (!trustedSenderForStage(sender, String(message.stage || ""))) {
          return { ok: false, status: "rejected", reason: "authorization_rejected" };
        }
        return mutationResponse(await applyStoredSessionEventUnlocked(message, sender, {
          type: SESSION_EVENT.SECURITY_REJECTION,
          stage: String(message.stage || ""),
          reason: message.reason,
          authenticated: true
        }));
      }
      if (message.type === "REACH_REVIEW") {
        if (!trustedReviewSender(sender)) {
          return { ok: false, status: "rejected", reason: "authorization_rejected" };
        }
        return mutationResponse(await applyStoredSessionEventUnlocked(message, sender, {
          type: SESSION_EVENT.REVIEW_REACHED,
          stage: "review",
          reason: "",
          finalSafe: message.finalSubmissionAllowed === false
        }), "review");
      }
      return { ok: false, status: "rejected", reason: "unexpected_response" };
    });
  }

  async function internalMessage(message, sender) {
    if (trustedPopupSender(sender)) {
      if (message?.type === "SAVE_ENCRYPTED_CREDENTIAL") {
        return productionVaultController().save(message.secret);
      }
      if (message?.type === "GET_ENCRYPTED_CREDENTIAL_STATUS") {
        return productionVaultController().status();
      }
      if (message?.type === "FORGET_ENCRYPTED_CREDENTIAL") {
        return productionVaultController().forget();
      }
      if (message?.type === "GET_SAFE_SESSION_TRACE") {
        return withStorageCritical(async () => {
          const trace = await readSafeTrace();
          return { ok: true, status: trace.length ? "available" : "empty", trace };
        });
      }
      return { ok: false, status: "invalid" };
    }
    if (!trustedInternalSender(sender)) return { ok: false, status: "not_found" };
    if (message?.type === "CLEAR_TRANSIENT_CREDENTIAL") {
      return { ok: true, status: "cleared" };
    }
    if (message?.type === "GET_ACTIVE_SESSION") return getActiveSession(sender);
    return internalMutationMessage(message, sender);
  }

  function respondAsync(handler, message, sender, sendResponse) {
    Promise.resolve()
      .then(() => handler(message, sender))
      .then((response) => {
        sendResponse(response);
        if (response && Object.hasOwn(response, "secret")) response.secret = null;
      })
      .catch(() => {
        sendResponse({ ok: false, status: "interrupted", reason: "unexpected_response" });
      });
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
      expireSession(sessionId).catch(() => {});
    });
  }

  if (typeof module === "object" && module.exports) {
    module.exports = {
      FORBIDDEN_KEYS,
      EXPECTED_AUTOMATION,
      LOGIN_URL,
      REPRESENTATIVE_DOM_CONTRACT,
      SESSION_ALARM_PREFIX,
      SESSION_EVENT,
      SESSION_GENERATION_STORAGE_KEY,
      SESSION_STATE,
      SESSION_STORAGE_KEY,
      SESSION_TRACE_LIMIT,
      SESSION_TRACE_STORAGE_KEY,
      SESSION_TRANSITIONS,
      SESSION_TTL_MS,
      AUTHORIZED_LOGIN_CUIT,
      VAULT_AAD,
      VAULT_FORMAT_VERSION,
      VAULT_STORAGE_KEY,
      cancelSession,
      clearExpiryAlarm,
      containsForbiddenKey,
      createVaultController,
      createExpiryAlarm,
      expireSession,
      expiryAlarmName,
      externalMessage,
      internalMessage,
      messageMatchesSession,
      prepareSession,
      preparedMessageRejectionReason,
      publicStatus,
      readSafeTrace,
      readSessionRecords,
      reduceSession,
      trustedExternalSender,
      trustedInternalSender,
      trustedLoginSender,
      trustedPopupSender,
      trustedRepresentativeSender,
      trustedReviewSender,
      validatePreparedMessage,
      validVaultKey,
      validVaultRecord,
      withSessionMutation,
      writeSessionRecords,
      writeSafeTrace,
      setVaultControllerForTesting(controller) {
        activeVaultController = controller;
      }
    };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
