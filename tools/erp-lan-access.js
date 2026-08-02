const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const TARGET_HOST = "127.0.0.1";
const TARGET_PORT = 3000;
const DEFAULT_PORT = 3001;
const APP_ID = "sunnutrition-erp-lan";
const SCHEMA_VERSION = 1;
const AUTHORIZED_NETWORK = "192.168.0.0";
const AUTHORIZED_PREFIX_LENGTH = 24;
const HEALTH_PATH = "/__erp_lan/health";
const SHUTDOWN_PATH = "/__erp_lan/shutdown";
const START_TIMEOUT_MS = 10000;
const STOP_TIMEOUT_MS = 8000;
const CONTROL_LOCK_TIMEOUT_MS = 15000;

async function main(argv = process.argv.slice(2)) {
  const command = String(argv[0] || "status").toLowerCase();
  if (command === "serve") return serve();
  if (command === "start") return start();
  if (command === "status") return status();
  if (command === "stop") return stop();
  throw new Error('Comando desconocido "' + command + '". Use start, status o stop.');
}

async function start() {
  const endpoint = resolveLanEndpoint(process.env);
  return withControlLock(endpoint.port, async () => {
    let current = await inspect(endpoint);
    if (current.state === "running_fresh") {
      printRunning(current.runtime);
      return;
    }
    if (current.state === "running_stale") {
      await requestSafeShutdown(current);
      await waitUntilStopped(endpoint, current.runtime.instanceId);
      current = await inspect(endpoint);
    }
    if (current.state === "running_unverified") {
      throw new Error("El puerto " + endpoint.port + " esta ocupado por un proceso no verificado; no se controla.");
    }
    if (current.state === "stale_lock") removeInactiveLock(current.lockState, endpoint.port);

    await requireTargetHealth();
    const child = spawn(process.execPath, [__filename, "serve"], {
      cwd: PROJECT_ROOT,
      detached: true,
      env: {
        ...process.env,
        ERP_LAN_HOST: endpoint.host,
        ERP_LAN_PORT: String(endpoint.port)
      },
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await delay(150);
      const next = await inspect(endpoint);
      if (next.state === "running_fresh") {
        printRunning(next.runtime);
        return;
      }
      if (next.state === "running_unverified") {
        throw new Error("El puerto " + endpoint.port + " quedo ocupado por un proceso no verificado.");
      }
    }
    throw new Error("El proxy LAN no inicio dentro de " + START_TIMEOUT_MS + " ms.");
  });
}

async function status() {
  const endpoint = endpointForInspection(process.env);
  const current = await inspect(endpoint);
  if (current.state === "running_fresh") {
    printRunning(current.runtime);
    return;
  }
  if (current.state === "running_stale") {
    console.error('Proxy LAN obsoleto PID ' + current.runtime.pid + '; ejecute "npm.cmd run lan:start" para renovarlo de forma autenticada.');
  } else if (current.state === "running_unverified") {
    console.error("Puerto " + endpoint.port + " ocupado por un proceso no verificado; no se controla.");
  } else if (current.state === "stale_lock") {
    console.error("Proxy LAN detenido con lock " + current.lockState.state + ": " + runtimeLockPath(endpoint.port));
  } else {
    console.error("Proxy LAN detenido en el puerto " + endpoint.port + ".");
  }
  process.exitCode = 2;
}

async function stop() {
  const endpoint = endpointForInspection(process.env);
  return withControlLock(endpoint.port, async () => {
    const current = await inspect(endpoint);
    if (current.state === "stopped") {
      console.log("Proxy LAN ya estaba detenido en el puerto " + endpoint.port + ".");
      return;
    }
    if (current.state === "stale_lock") {
      removeInactiveLock(current.lockState, endpoint.port);
      console.log("Lock LAN inactivo retirado; no se detuvo ningun proceso.");
      return;
    }
    if (current.state === "running_unverified") {
      throw new Error("No se detuvo el proceso no verificado que ocupa el puerto " + endpoint.port + ".");
    }
    await requestSafeShutdown(current);
    await waitUntilStopped(endpoint, current.runtime.instanceId);
    console.log("Proxy LAN detenido de forma autenticada (PID " + current.runtime.pid + ").");
  });
}

async function serve() {
  const endpoint = resolveLanEndpoint(process.env);
  const runtime = {
    schemaVersion: SCHEMA_VERSION,
    appId: APP_ID,
    instanceId: crypto.randomUUID(),
    pid: process.pid,
    projectRoot: PROJECT_ROOT,
    workingDirectory: path.resolve(process.cwd()),
    executablePath: process.execPath,
    commandLine: process.argv.map(quoteArgument).join(" "),
    sourceFingerprint: computeSourceFingerprint(__filename),
    host: endpoint.host,
    port: endpoint.port,
    network: endpoint.network,
    prefixLength: endpoint.prefixLength,
    targetHost: TARGET_HOST,
    targetPort: TARGET_PORT,
    controlToken: crypto.randomBytes(32).toString("base64url"),
    startedAt: new Date().toISOString()
  };

  await requireTargetHealth();
  let closing = false;
  const server = http.createServer((request, response) => {
    if (!isAddressInSubnet(request.socket.remoteAddress, runtime.network, runtime.prefixLength)) {
      return sendText(response, 403, "Acceso fuera de la subred local denegado.");
    }
    if (request.url === HEALTH_PATH && request.method === "GET") {
      return sendJson(response, 200, publicRuntime(runtime));
    }
    if (request.url === SHUTDOWN_PATH && request.method === "POST") {
      if (!safeEqual(request.headers["x-erp-lan-control-token"], runtime.controlToken)) {
        return sendJson(response, 403, { ok: false });
      }
      sendJson(response, 202, { ok: true, instanceId: runtime.instanceId });
      setImmediate(shutdown);
      return;
    }
    proxyRequest(request, response, runtime);
  });

  function shutdown() {
    if (closing) return;
    closing = true;
    server.close(() => {
      removeRuntimeLockIfOwned(runtime);
      process.exitCode = 0;
    });
    const forceExit = setTimeout(() => {
      removeRuntimeLockIfOwned(runtime);
      process.exit(1);
    }, 5000);
    forceExit.unref();
  }

  server.on("error", (error) => {
    removeRuntimeLockIfOwned(runtime);
    console.error("[ERP_LAN_ERROR] " + error.message);
    process.exitCode = 1;
  });
  server.listen(runtime.port, runtime.host, () => {
    try {
      writeRuntimeLock(runtime);
    } catch (error) {
      console.error("[ERP_LAN_LOCK_ERROR] " + error.message);
      shutdown();
    }
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("exit", () => removeRuntimeLockIfOwned(runtime));
}

function proxyRequest(request, response, runtime) {
  const headers = rewriteProxyHeaders(request.headers);
  const upstream = http.request({
    host: runtime.targetHost,
    port: runtime.targetPort,
    method: request.method,
    path: request.url,
    headers,
    timeout: 30000
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("Timeout del ERP local.")));
  upstream.on("error", () => {
    if (!response.headersSent) sendText(response, 502, "El ERP local no esta disponible.");
    else response.destroy();
  });
  request.pipe(upstream);
}

function rewriteProxyHeaders(inputHeaders) {
  const headers = { ...inputHeaders };
  headers.host = TARGET_HOST + ":" + TARGET_PORT;
  delete headers["proxy-connection"];
  delete headers["x-erp-runtime-token"];
  delete headers["x-erp-lan-control-token"];
  if (headers.origin) headers.origin = "http://" + TARGET_HOST + ":" + TARGET_PORT;
  if (headers.referer) headers.referer = "http://" + TARGET_HOST + ":" + TARGET_PORT + "/";
  return headers;
}

async function inspect(endpoint) {
  const currentFingerprint = computeSourceFingerprint(__filename);
  const lockState = readLockState(endpoint.port);
  const hosts = [...new Set([
    ...(lockState.state === "valid" ? [lockState.value.host] : []),
    ...(endpoint.host ? [endpoint.host] : []),
    ...authorizedLanInterfaces().map((candidate) => candidate.host)
  ])];
  for (const host of hosts) {
    const health = await requestJson({ host, port: endpoint.port, path: HEALTH_PATH });
    if (health.statusCode !== 200 || health.body?.appId !== APP_ID) continue;
    if (lockState.state !== "valid" || !runtimeMatchesLock(health.body, lockState.value)) {
      return { state: "running_unverified", runtime: health.body, lockState };
    }
    return {
      state: health.body.sourceFingerprint === currentFingerprint ? "running_fresh" : "running_stale",
      runtime: health.body,
      lockState,
      controlHost: host
    };
  }
  for (const host of hosts) {
    if (await isPortListening(host, endpoint.port)) return { state: "running_unverified", lockState };
  }
  if (lockState.state !== "missing") return { state: "stale_lock", lockState };
  return { state: "stopped", lockState };
}

function endpointForInspection(env) {
  const port = configuredPort(env);
  const lockState = readLockState(port);
  if (lockState.state === "valid") {
    return {
      host: lockState.value.host,
      port,
      network: lockState.value.network,
      prefixLength: lockState.value.prefixLength
    };
  }
  const requestedHost = String(env.ERP_LAN_HOST || "").trim();
  if (requestedHost) return resolveLanEndpoint(env);
  const candidates = authorizedLanInterfaces();
  return { ...(candidates.length === 1 ? candidates[0] : { host: "" }), port };
}

function resolveLanEndpoint(env) {
  const requestedHost = String(env.ERP_LAN_HOST || "").trim();
  const candidates = authorizedLanInterfaces();
  const matches = requestedHost
    ? candidates.filter((candidate) => candidate.host === requestedHost)
    : candidates;
  if (matches.length !== 1) {
    const available = candidates.map((candidate) => candidate.host).join(", ") || "ninguna";
    throw new Error("No se pudo elegir una IPv4 LAN unica. Defina ERP_LAN_HOST; disponibles: " + available + ".");
  }
  return { ...matches[0], port: configuredPort(env) };
}

function authorizedLanInterfaces() {
  return Object.values(os.networkInterfaces()).flat().filter((entry) => {
    const family = entry?.family === 4 || entry?.family === "IPv4";
    return family
      && !entry.internal
      && isAddressInSubnet(entry.address, AUTHORIZED_NETWORK, AUTHORIZED_PREFIX_LENGTH);
  }).map((entry) => ({
    host: entry.address,
    prefixLength: AUTHORIZED_PREFIX_LENGTH,
    network: AUTHORIZED_NETWORK
  }));
}

function configuredPort(env) {
  const value = Number(env.ERP_LAN_PORT || DEFAULT_PORT);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("ERP_LAN_PORT debe ser un puerto valido.");
  }
  return value;
}

function readLockState(port, rootDir = PROJECT_ROOT) {
  const file = runtimeLockPath(port, rootDir);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const snapshot = hashText(raw);
    try {
      const value = JSON.parse(raw);
      return validRuntimeLock(value, port, rootDir)
        ? { state: "valid", value, snapshot, path: file }
        : { state: "invalid", snapshot, path: file };
    } catch {
      return { state: "invalid", snapshot, path: file };
    }
  } catch (error) {
    if (error.code === "ENOENT") return { state: "missing", path: file };
    return { state: "invalid", snapshot: null, path: file, error: error.message };
  }
}

function validRuntimeLock(value, port, rootDir) {
  return value?.schemaVersion === SCHEMA_VERSION
    && value.appId === APP_ID
    && typeof value.instanceId === "string"
    && Number.isInteger(value.pid)
    && path.resolve(value.projectRoot || "") === path.resolve(rootDir)
    && path.resolve(value.workingDirectory || "") === path.resolve(rootDir)
    && typeof value.executablePath === "string"
    && typeof value.commandLine === "string"
    && typeof value.sourceFingerprint === "string"
    && typeof value.host === "string"
    && value.port === Number(port)
    && typeof value.network === "string"
    && Number.isInteger(value.prefixLength)
    && typeof value.controlToken === "string"
    && value.controlToken.length >= 32;
}

function runtimeMatchesLock(runtime, lock) {
  return runtime.instanceId === lock.instanceId
    && runtime.pid === lock.pid
    && path.resolve(runtime.projectRoot || "") === path.resolve(lock.projectRoot)
    && path.resolve(runtime.workingDirectory || "") === path.resolve(lock.workingDirectory)
    && runtime.executablePath === lock.executablePath
    && runtime.commandLine === lock.commandLine
    && runtime.host === lock.host
    && runtime.port === lock.port;
}

function removeInactiveLock(lockState, port, rootDir = PROJECT_ROOT) {
  if (!["valid", "invalid"].includes(lockState.state)) return false;
  const current = readLockState(port, rootDir);
  if (current.state === "missing") return false;
  if (!lockState.snapshot || current.snapshot !== lockState.snapshot) {
    throw new Error("El lock LAN cambio durante la limpieza; no se retiro.");
  }
  fs.rmSync(runtimeLockPath(port, rootDir), { force: true });
  return true;
}

async function withControlLock(port, action, rootDir = PROJECT_ROOT) {
  fs.mkdirSync(path.join(rootDir, "tmp"), { recursive: true });
  const file = controlLockPath(port, rootDir);
  const deadline = Date.now() + CONTROL_LOCK_TIMEOUT_MS;
  let owned = false;
  const controlId = crypto.randomUUID();
  while (!owned && Date.now() < deadline) {
    try {
      fs.mkdirSync(file);
      try {
        fs.writeFileSync(
          path.join(file, "owner.json"),
          JSON.stringify({ pid: process.pid, controlId, createdAt: Date.now() }),
          { flag: "wx" }
        );
      } catch (error) {
        fs.rmSync(file, { recursive: true, force: true });
        throw error;
      }
      owned = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (reclaimAbandonedControlLock(file)) continue;
      await delay(100);
    }
  }
  if (!owned) throw new Error("Otro control LAN sigue en curso; reintente en unos segundos.");
  try {
    return await action();
  } finally {
    const owner = readJsonFile(path.join(file, "owner.json"));
    if (owner?.pid === process.pid && owner?.controlId === controlId) {
      fs.rmSync(file, { recursive: true, force: true });
    }
  }
}

function reclaimAbandonedControlLock(file) {
  let age = 0;
  try {
    age = Date.now() - fs.statSync(file).mtimeMs;
  } catch (error) {
    return error.code === "ENOENT";
  }
  const owner = readJsonFile(path.join(file, "owner.json"));
  if (!owner || !Number.isInteger(owner.pid) || !Number.isFinite(owner.createdAt)) {
    if (age < CONTROL_LOCK_TIMEOUT_MS) return false;
    return claimAndRemove(file);
  }
  if (Date.now() - owner.createdAt < CONTROL_LOCK_TIMEOUT_MS || processExists(owner.pid)) return false;
  return claimAndRemove(file);
}

function claimAndRemove(file) {
  const claim = file + ".claim-" + process.pid + "-" + crypto.randomUUID();
  try {
    fs.renameSync(file, claim);
    fs.rmSync(claim, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    return false;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function requestSafeShutdown(current) {
  const response = await requestJson({
    host: current.controlHost || current.runtime.host,
    port: current.runtime.port,
    path: SHUTDOWN_PATH,
    method: "POST",
    headers: { "x-erp-lan-control-token": current.lockState.value.controlToken }
  });
  if (response.statusCode !== 202 || response.body?.instanceId !== current.runtime.instanceId) {
    throw new Error("El proxy LAN rechazo el apagado autenticado.");
  }
}

async function waitUntilStopped(endpoint, instanceId) {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(150);
    const next = await inspect(endpoint);
    if (!["running_fresh", "running_stale"].includes(next.state)
      || next.runtime?.instanceId !== instanceId) {
      if (next.state === "stale_lock") removeInactiveLock(next.lockState, endpoint.port);
      return;
    }
  }
  throw new Error("El proxy LAN " + instanceId + " no confirmo su cierre.");
}

function writeRuntimeLock(runtime) {
  fs.mkdirSync(path.dirname(runtimeLockPath(runtime.port)), { recursive: true });
  fs.writeFileSync(runtimeLockPath(runtime.port), JSON.stringify(runtime, null, 2) + "\n", { flag: "wx" });
}

function removeRuntimeLockIfOwned(runtime) {
  const lockState = readLockState(runtime.port);
  if (lockState.state === "valid"
    && lockState.value.instanceId === runtime.instanceId
    && lockState.value.pid === runtime.pid) {
    fs.rmSync(runtimeLockPath(runtime.port), { force: true });
  }
}

function runtimeLockPath(port, rootDir = PROJECT_ROOT) {
  return path.join(rootDir, "tmp", "erp-lan-" + port + ".lock.json");
}

function controlLockPath(port, rootDir = PROJECT_ROOT) {
  return path.join(rootDir, "tmp", "erp-lan-" + port + ".control.lock");
}

function publicRuntime(runtime) {
  const { controlToken, ...publicFields } = runtime;
  return { ok: true, ...publicFields, allowedCidr: runtime.network + "/" + runtime.prefixLength };
}

function computeSourceFingerprint(file) {
  return "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isAddressInSubnet(address, network, prefixLength) {
  const normalized = normalizeIpv4(address);
  if (!normalized || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) return false;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (ipv4ToInt(normalized) & mask) === (ipv4ToInt(network) & mask);
}

function normalizeIpv4(address) {
  const value = String(address || "");
  if (value.startsWith("::ffff:")) return value.slice(7);
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) ? value : null;
}

function ipv4ToInt(address) {
  const parts = String(address).split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return -1;
  return parts.reduce((value, part) => ((value << 8) | part) >>> 0, 0);
}

function networkAddress(address, prefixLength) {
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  const value = ipv4ToInt(address) & mask;
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}

async function requireTargetHealth() {
  const health = await requestJson({ host: TARGET_HOST, port: TARGET_PORT, path: "/api/health" });
  if (health.statusCode !== 200 || health.body?.ok !== true) {
    throw new Error("El ERP principal no responde en http://" + TARGET_HOST + ":" + TARGET_PORT + "/api/health.");
  }
}

function requestJson({ host, port, path: requestPath, method = "GET", headers = {} }) {
  return new Promise((resolve) => {
    const request = http.request({ host, port, path: requestPath, method, headers, timeout: 1000 }, (response) => {
      let raw = "";
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
        resolve({ statusCode: response.statusCode || 0, body });
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve({ statusCode: 0, body: null }));
    request.end();
  });
}

function isPortListening(host, port) {
  if (!host) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function quoteArgument(argument) {
  const value = String(argument);
  return /\s/.test(value) ? '"' + value.replace(/"/g, '\\"') + '"' : value;
}

function printRunning(runtime) {
  console.log("Proxy LAN activo: PID " + runtime.pid + "; comando " + runtime.commandLine);
  console.log("cwd " + runtime.workingDirectory + "; checkout " + runtime.projectRoot);
  console.log("URL para dispositivos del Wi-Fi domestico: http://" + runtime.host + ":" + runtime.port + "/");
  console.log("Red permitida: " + runtime.network + "/" + runtime.prefixLength + "; destino local: http://" + TARGET_HOST + ":" + TARGET_PORT + ".");
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  APP_ID,
  AUTHORIZED_NETWORK,
  AUTHORIZED_PREFIX_LENGTH,
  authorizedLanInterfaces,
  computeSourceFingerprint,
  controlLockPath,
  isAddressInSubnet,
  networkAddress,
  normalizeIpv4,
  readLockState,
  reclaimAbandonedControlLock,
  removeInactiveLock,
  rewriteProxyHeaders,
  runtimeLockPath,
  safeEqual,
  validRuntimeLock
};
