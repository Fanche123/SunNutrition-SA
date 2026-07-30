const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const {
  APP_ID,
  RUNTIME_SCHEMA_VERSION,
  computeSourceFingerprint,
  runtimeLockPath
} = require("../backend/utils/server-runtime");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const MANAGER_PATH = path.join("tools", "erp-server.js");
const FAKE_SERVER_SOURCE = `
const http = require("node:http");
const runtime = JSON.parse(process.env.FAKE_RUNTIME_JSON);
runtime.pid = process.pid;
const token = process.env.FAKE_CONTROL_TOKEN || "";
const exposeRuntime = process.env.FAKE_EXPOSE_RUNTIME === "1";
const ocrReachable = process.env.FAKE_OCR_REACHABLE === "1";
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Connection", "close");
  if (request.method === "GET" && request.url === "/api/health") {
    response.writeHead(200);
    response.end(JSON.stringify(exposeRuntime ? { ok: true, runtime } : { ok: true }));
    return;
  }
  if (request.method === "GET" && request.url === "/api/health/ocr") {
    response.writeHead(ocrReachable ? 200 : 503);
    response.end(JSON.stringify(ocrReachable
      ? { ok: true, provider: "openai", connectivity: "reachable", providerStatus: 401 }
      : { ok: false, provider: "openai", connectivity: "unreachable", transportCode: "eacces" }));
    return;
  }
  if (request.method === "POST" && request.url === "/api/runtime/shutdown") {
    if (!token || request.headers["x-erp-runtime-token"] !== token) {
      response.writeHead(403);
      response.end(JSON.stringify({ ok: false }));
      return;
    }
    response.writeHead(202);
    response.end(JSON.stringify({ ok: true, instanceId: runtime.instanceId }));
    setImmediate(() => server.close());
    return;
  }
  response.writeHead(404);
  response.end(JSON.stringify({ error: "not found" }));
});

server.listen(runtime.port, runtime.host);
process.once("SIGTERM", () => server.close());
`;

test("ocr-status distingue frescura de conectividad y consulta al proceso administrado", async () => {
  for (const reachable of [false, true]) {
    const port = await freePort();
    const environment = isolatedEnvironment(port);
    const runtime = fakeRuntime({
      port,
      projectRoot: PROJECT_ROOT,
      sourceFingerprint: computeSourceFingerprint(PROJECT_ROOT)
    });
    const controlToken = crypto.randomBytes(32).toString("hex");
    let serverProcess;

    try {
      serverProcess = spawnFakeServer(runtime, controlToken, true, {
        FAKE_OCR_REACHABLE: reachable ? "1" : "0"
      });
      const health = await waitForHealth(port, (body) => body?.runtime?.instanceId, serverProcess);
      writeLock(port, { ...health.runtime, controlToken });

      const result = await runNode([MANAGER_PATH, "ocr-status", "--json"], environment);
      assert.equal(result.code, reachable ? 0 : 2);
      const status = parseJsonOutput(result.stdout);
      assert.equal(status.state, reachable ? "ocr_reachable" : "ocr_unreachable");
      assert.equal(status.runtime.pid, health.runtime.pid);
      assert.equal(status.ocr.connectivity, reachable ? "reachable" : "unreachable");
    } finally {
      await cleanupOwnedProcess(port, serverProcess, environment);
    }
  }
});

test("la huella cambia con codigo fuente y no con runtime temporal", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "erp-runtime-fingerprint-"));
  try {
    fs.mkdirSync(path.join(fixtureRoot, "backend"), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, "tmp"), { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, "package.json"), '{"name":"fixture"}\n', "utf8");
    fs.writeFileSync(path.join(fixtureRoot, "server.js"), "module.exports = 1;\n", "utf8");
    fs.writeFileSync(path.join(fixtureRoot, "backend", "route.js"), "module.exports = 'a';\n", "utf8");

    const initial = computeSourceFingerprint(fixtureRoot);
    fs.writeFileSync(path.join(fixtureRoot, "tmp", "runtime.json"), '{"changed":true}\n', "utf8");
    assert.equal(computeSourceFingerprint(fixtureRoot), initial);

    fs.writeFileSync(path.join(fixtureRoot, "backend", "route.js"), "module.exports = 'b';\n", "utf8");
    assert.notEqual(computeSourceFingerprint(fixtureRoot), initial);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("start, status, conflicto EADDRINUSE, restart y stop usan una sola instancia verificable", async () => {
  const port = await freePort();
  const environment = isolatedEnvironment(port);
  let firstServer;
  let restartedServer;

  try {
    firstServer = spawnLongRunning([MANAGER_PATH, "start"], environment);
    const firstHealth = await waitForHealth(port, (body) => body?.runtime?.instanceId, firstServer);
    assert.equal(firstHealth.runtime.projectRoot, PROJECT_ROOT);
    assert.equal(firstHealth.runtime.sourceFingerprint, computeSourceFingerprint(PROJECT_ROOT));
    assert.equal(Object.hasOwn(firstHealth.runtime, "controlToken"), false);

    const status = await runNode([MANAGER_PATH, "status", "--json"], environment);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(parseJsonOutput(status.stdout).state, "running_fresh");

    const duplicateStart = await runNode([MANAGER_PATH, "start", "--json"], environment);
    assert.equal(duplicateStart.code, 0, duplicateStart.stderr);
    assert.equal(
      (await requestJson(port, "GET", "/api/health")).body.runtime.instanceId,
      firstHealth.runtime.instanceId
    );

    const conflict = await runNode(["server.js"], environment);
    assert.equal(conflict.code, 1, conflict.stdout);
    assert.match(conflict.stderr, /ERP_SERVER_PORT_IN_USE/);
    assert.match(conflict.stderr, /npm\.cmd run server:status/);
    assert.equal(
      (await requestJson(port, "GET", "/api/health")).body.runtime.instanceId,
      firstHealth.runtime.instanceId
    );

    const unauthorized = await requestJson(port, "POST", "/api/runtime/shutdown", {
      "X-ERP-Runtime-Token": "token-incorrecto"
    });
    assert.equal(unauthorized.statusCode, 403);
    assert.equal((await requestJson(port, "GET", "/api/health")).statusCode, 200);

    restartedServer = spawnLongRunning([MANAGER_PATH, "restart"], environment);
    const restartedHealth = await waitForHealth(
      port,
      (body) => body?.runtime?.instanceId && body.runtime.instanceId !== firstHealth.runtime.instanceId,
      restartedServer
    );
    assert.notEqual(restartedHealth.runtime.instanceId, firstHealth.runtime.instanceId);
    await waitForExit(firstServer, 5000);

    const restartedStatus = await runNode([MANAGER_PATH, "status", "--json"], environment);
    assert.equal(restartedStatus.code, 0, restartedStatus.stderr);
    assert.equal(parseJsonOutput(restartedStatus.stdout).state, "running_fresh");

    const stopped = await runNode([MANAGER_PATH, "stop"], environment);
    assert.equal(stopped.code, 0, stopped.stderr);
    await waitForExit(restartedServer, 5000);
    await waitForPortToClose(port);
    assert.equal(fs.existsSync(runtimeLockPath(PROJECT_ROOT, port)), false);
  } finally {
    await cleanupOwnedProcess(port, restartedServer, environment);
    await cleanupOwnedProcess(port, firstServer, environment);
  }
});

test("un runtime obsoleto administrado se detecta y reinicia sin usar el PID para cerrarlo", async () => {
  const port = await freePort();
  const environment = isolatedEnvironment(port);
  const staleRuntime = fakeRuntime({
    port,
    projectRoot: PROJECT_ROOT,
    sourceFingerprint: `sha256:${"0".repeat(64)}`
  });
  const controlToken = crypto.randomBytes(32).toString("hex");
  let staleServer;
  let restartedServer;

  try {
    staleServer = spawnFakeServer(staleRuntime, controlToken, true);
    const staleHealth = await waitForHealth(port, (body) => body?.runtime?.instanceId, staleServer);
    writeLock(port, { ...staleHealth.runtime, controlToken });

    const staleStatus = await runNode([MANAGER_PATH, "status", "--json"], environment);
    assert.equal(staleStatus.code, 2);
    const parsedStatus = parseJsonOutput(staleStatus.stdout);
    assert.equal(parsedStatus.state, "running_stale");
    assert.equal(parsedStatus.canControl, true);

    restartedServer = spawnLongRunning([MANAGER_PATH, "restart"], environment);
    const freshHealth = await waitForHealth(
      port,
      (body) => body?.runtime?.sourceFingerprint === computeSourceFingerprint(PROJECT_ROOT),
      restartedServer
    );
    assert.notEqual(freshHealth.runtime.instanceId, staleHealth.runtime.instanceId);
    await waitForExit(staleServer, 5000);

    const stop = await runNode([MANAGER_PATH, "stop"], environment);
    assert.equal(stop.code, 0, stop.stderr);
    await waitForExit(restartedServer, 5000);
    await waitForPortToClose(port);
  } finally {
    await cleanupOwnedProcess(port, restartedServer, environment);
    await cleanupOwnedProcess(port, staleServer, environment);
  }
});

test("un host local alternativo no reemplaza el lock ni inicia una segunda instancia", async () => {
  const port = await freePort();
  const originalEnvironment = isolatedEnvironment(port, "127.0.0.1");
  const alternateEnvironment = isolatedEnvironment(port, "localhost");
  const lockPath = runtimeLockPath(PROJECT_ROOT, port);
  let serverProcess;

  try {
    serverProcess = spawnLongRunning([MANAGER_PATH, "start"], originalEnvironment);
    const health = await waitForHealth(port, (body) => body?.runtime?.instanceId, serverProcess);
    const originalLock = fs.readFileSync(lockPath, "utf8");

    const alternateStatus = await runNode([MANAGER_PATH, "status", "--json"], alternateEnvironment);
    assert.equal(alternateStatus.code, 2);
    assert.equal(parseJsonOutput(alternateStatus.stdout).state, "running_other_host");
    assert.equal(fs.readFileSync(lockPath, "utf8"), originalLock);

    const refusedStart = await runNode([MANAGER_PATH, "start", "--json"], alternateEnvironment);
    assert.equal(refusedStart.code, 2);
    assert.equal(parseJsonOutput(refusedStart.stdout).state, "running_other_host");
    assert.equal(fs.readFileSync(lockPath, "utf8"), originalLock);
    assert.equal(
      (await requestJson(port, "GET", "/api/health")).body.runtime.instanceId,
      health.runtime.instanceId
    );

    const alternateStop = await runNode([MANAGER_PATH, "stop"], alternateEnvironment);
    assert.equal(alternateStop.code, 0, alternateStop.stderr);
    await waitForExit(serverProcess, 5000);
    await waitForPortToClose(port);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    await cleanupOwnedProcess(port, serverProcess, originalEnvironment);
  }
});

test("dos start concurrentes con lock obsoleto y hosts distintos conservan una sola instancia controlable", async () => {
  const port = await freePort();
  const primaryEnvironment = isolatedEnvironment(port, "127.0.0.1");
  const alternateEnvironment = isolatedEnvironment(port, "localhost");
  const lockPath = runtimeLockPath(PROJECT_ROOT, port);
  let primaryProcess;
  let alternateProcess;

  writeLock(port, {
    ...fakeRuntime({
      port,
      projectRoot: PROJECT_ROOT,
      sourceFingerprint: computeSourceFingerprint(PROJECT_ROOT),
      pid: 2147483647
    }),
    controlToken: crypto.randomBytes(32).toString("hex")
  });

  try {
    primaryProcess = spawnLongRunning([MANAGER_PATH, "start"], primaryEnvironment);
    alternateProcess = spawnLongRunning([MANAGER_PATH, "start"], alternateEnvironment);

    await waitForManagedRuntime(
      [primaryEnvironment, alternateEnvironment],
      [primaryProcess, alternateProcess]
    );

    const [primaryStatusResult, alternateStatusResult] = await Promise.all([
      runNode([MANAGER_PATH, "status", "--json"], primaryEnvironment),
      runNode([MANAGER_PATH, "status", "--json"], alternateEnvironment)
    ]);
    const statuses = [
      parseJsonOutput(primaryStatusResult.stdout),
      parseJsonOutput(alternateStatusResult.stdout)
    ];

    statuses.forEach((status) => {
      assert.ok(["running_fresh", "running_other_host"].includes(status.state), status.state);
      assert.equal(status.canControl, true);
    });
    assert.equal(statuses[0].runtime.instanceId, statuses[1].runtime.instanceId);

    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(lock.instanceId, statuses[0].runtime.instanceId);

    await delay(500);
    assert.equal(
      [primaryProcess, alternateProcess].filter((child) => child.exitCode === null).length,
      1
    );

    const stopped = await runNode([MANAGER_PATH, "stop"], primaryEnvironment);
    assert.equal(stopped.code, 0, stopped.stderr);
    await waitForExit(primaryProcess, 5000);
    await waitForExit(alternateProcess, 5000);
    await waitForPortToClose(port, "127.0.0.1");
    await waitForPortToClose(port, "localhost");
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    await cleanupOwnedProcess(port, alternateProcess, alternateEnvironment);
    await cleanupOwnedProcess(port, primaryProcess, primaryEnvironment);
  }
});

test("servidores de otro checkout o sin identidad nunca reciben una orden de cierre", async () => {
  const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), "erp-foreign-checkout-"));
  const foreignPort = await freePort();
  const foreignEnvironment = isolatedEnvironment(foreignPort);
  const foreignRuntime = fakeRuntime({
    port: foreignPort,
    projectRoot: foreignRoot,
    sourceFingerprint: `sha256:${"1".repeat(64)}`
  });
  let foreignServer;
  let unverifiedServer;

  try {
    foreignServer = spawnFakeServer(foreignRuntime, crypto.randomBytes(32).toString("hex"), true);
    const foreignHealth = await waitForHealth(foreignPort, (body) => body?.runtime?.instanceId, foreignServer);
    const foreignStop = await runNode([MANAGER_PATH, "stop", "--json"], foreignEnvironment);
    assert.equal(foreignStop.code, 2);
    assert.equal(parseJsonOutput(foreignStop.stdout).state, "running_foreign");
    assert.equal(
      (await requestJson(foreignPort, "GET", "/api/health")).body.runtime.instanceId,
      foreignHealth.runtime.instanceId
    );

    await terminateOwnedChild(foreignServer);
    foreignServer = null;
    await waitForPortToClose(foreignPort);

    const unverifiedPort = await freePort();
    const unverifiedEnvironment = isolatedEnvironment(unverifiedPort);
    unverifiedServer = spawnFakeServer(fakeRuntime({
      port: unverifiedPort,
      projectRoot: PROJECT_ROOT,
      sourceFingerprint: computeSourceFingerprint(PROJECT_ROOT)
    }), "", false);
    await waitForHealth(unverifiedPort, (body) => body?.ok, unverifiedServer);

    const refusedStart = await runNode([MANAGER_PATH, "start", "--json"], unverifiedEnvironment);
    assert.equal(refusedStart.code, 2);
    assert.equal(parseJsonOutput(refusedStart.stdout).state, "running_unverified");
    assert.equal((await requestJson(unverifiedPort, "GET", "/api/health")).statusCode, 200);

    const refusedStop = await runNode([MANAGER_PATH, "stop", "--json"], unverifiedEnvironment);
    assert.equal(refusedStop.code, 2);
    assert.equal(parseJsonOutput(refusedStop.stdout).state, "running_unverified");
    assert.equal((await requestJson(unverifiedPort, "GET", "/api/health")).statusCode, 200);

    await terminateOwnedChild(unverifiedServer);
    unverifiedServer = null;
    await waitForPortToClose(unverifiedPort);
  } finally {
    await terminateOwnedChild(unverifiedServer);
    await terminateOwnedChild(foreignServer);
    fs.rmSync(foreignRoot, { recursive: true, force: true });
  }
});

test("locks obsoletos y PID reutilizado se limpian sin detener procesos", async () => {
  const managerSource = fs.readFileSync(path.join(PROJECT_ROOT, MANAGER_PATH), "utf8");
  assert.doesNotMatch(managerSource, /process\.kill\s*\(/);

  for (const stalePid of [2147483647, process.pid]) {
    const port = await freePort();
    const environment = isolatedEnvironment(port);
    const lockPath = runtimeLockPath(PROJECT_ROOT, port);
    const runtime = fakeRuntime({
      port,
      projectRoot: PROJECT_ROOT,
      sourceFingerprint: computeSourceFingerprint(PROJECT_ROOT),
      pid: stalePid
    });
    writeLock(port, {
      ...runtime,
      pid: stalePid,
      controlToken: crypto.randomBytes(32).toString("hex")
    });

    const status = await runNode([MANAGER_PATH, "status", "--json"], environment);
    assert.equal(status.code, 2);
    assert.equal(parseJsonOutput(status.stdout).state, "stale_lock");
    assert.equal(fs.existsSync(lockPath), true);

    const stop = await runNode([MANAGER_PATH, "stop"], environment);
    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(fs.existsSync(lockPath), false);
  }
});

function isolatedEnvironment(port, host = "127.0.0.1") {
  return {
    ...process.env,
    PORT: String(port),
    ERP_HOST: host,
    ERP_DEPLOYMENT_MODE: "local",
    ERP_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`
  };
}

function fakeRuntime({
  port,
  projectRoot,
  sourceFingerprint,
  pid = 1
}) {
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    appId: APP_ID,
    instanceId: crypto.randomUUID(),
    pid,
    startedAt: new Date().toISOString(),
    projectRoot,
    workingDirectory: projectRoot,
    sourceFingerprint,
    host: "127.0.0.1",
    port,
    nodeVersion: process.version
  };
}

function spawnFakeServer(runtime, controlToken, exposeRuntime, extraEnvironment = {}) {
  return spawnLongRunning(["-e", FAKE_SERVER_SOURCE], {
    ...process.env,
    FAKE_RUNTIME_JSON: JSON.stringify(runtime),
    FAKE_CONTROL_TOKEN: controlToken,
    FAKE_EXPOSE_RUNTIME: exposeRuntime ? "1" : "0",
    ...extraEnvironment
  });
}

function writeLock(port, value) {
  const lockPath = runtimeLockPath(PROJECT_ROOT, port);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function spawnLongRunning(args, environment) {
  const child = spawn(process.execPath, args, {
    cwd: PROJECT_ROOT,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdoutText = "";
  child.stderrText = "";
  child.stdout.on("data", (chunk) => { child.stdoutText += chunk; });
  child.stderr.on("data", (chunk) => { child.stderrText += chunk; });
  return child;
}

function runNode(args, environment, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawnLongRunning(args, environment);
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timeout ejecutando node ${args.join(" ")}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({
        code: code ?? (signal ? 1 : 0),
        signal,
        stdout: child.stdoutText,
        stderr: child.stderrText
      });
    });
  });
}

async function waitForHealth(port, predicate, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) {
      throw new Error(`Servidor termino antes de iniciar.\n${child.stdoutText}\n${child.stderrText}`);
    }
    try {
      const response = await requestJson(port, "GET", "/api/health");
      if (response.statusCode === 200 && predicate(response.body)) return response.body;
      lastError = `HTTP ${response.statusCode}`;
    } catch (error) {
      lastError = error.message;
    }
    await delay(50);
  }
  throw new Error(`Health no quedo disponible: ${lastError}\n${child?.stdoutText || ""}\n${child?.stderrText || ""}`);
}

async function waitForManagedRuntime(environments, children, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";

  while (Date.now() < deadline) {
    for (const environment of environments) {
      const result = await runNode([MANAGER_PATH, "status", "--json"], environment, 5000);
      try {
        const status = parseJsonOutput(result.stdout);
        lastStatus = status.state;
        if (["running_fresh", "running_other_host"].includes(status.state)) return status;
      } catch {}
    }
    if (children.every((child) => child.exitCode !== null)) {
      throw new Error(`Ambos start concurrentes terminaron sin runtime (${lastStatus}).`);
    }
    await delay(50);
  }

  throw new Error(`No aparecio un runtime administrado concurrente (${lastStatus}).`);
}

function requestJson(port, method, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method,
      headers: {
        Connection: "close",
        ...headers
      }
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        let body = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {}
        resolve({ statusCode: response.statusCode, body, raw });
      });
    });
    request.setTimeout(1000, () => request.destroy(new Error("timeout")));
    request.once("error", reject);
    request.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForPortToClose(port, host = "127.0.0.1", timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await portIsOpen(port, host)) return;
    await delay(50);
  }
  throw new Error(`El puerto aislado ${host}:${port} no se libero.`);
}

function portIsOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(timeoutMs).then(() => {
      throw new Error(`El proceso ${child.pid} no termino.\n${child.stdoutText}\n${child.stderrText}`);
    })
  ]);
}

async function cleanupOwnedProcess(port, child, environment) {
  if (!child) return;
  if (child.exitCode === null) {
    try {
      await runNode([MANAGER_PATH, "stop"], environment, 5000);
    } catch {}
  }
  if (child.exitCode === null) await terminateOwnedChild(child);
  fs.rmSync(runtimeLockPath(PROJECT_ROOT, port), { force: true });
}

async function terminateOwnedChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForExit(child, 2000);
  } catch {
    child.kill("SIGKILL");
    await waitForExit(child, 2000);
  }
}

function parseJsonOutput(output) {
  const line = String(output || "").trim().split(/\r?\n/).filter(Boolean).at(-1);
  return JSON.parse(line);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
