const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { createAccessConfig, LOCAL_HOSTS } = require("../backend/config/access");
const {
  APP_ID,
  computeSourceFingerprint,
  loadEnvFile,
  projectRootsEqual,
  readRuntimeLock,
  removeInactiveRuntimeLock,
  removeRuntimeLockIfOwned,
  runtimeLockMatchesIdentity
} = require("../backend/utils/server-runtime");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PRIMARY_LOCAL_ROOT = path.resolve("C:\\Users\\benja\\Documents\\ERP");
const PRIMARY_LOCAL_HOST = "127.0.0.1";
const PRIMARY_LOCAL_PORT = 3000;
const HEALTH_PATH = "/api/health";
const OCR_HEALTH_PATH = "/api/health/ocr";
const SHUTDOWN_PATH = "/api/runtime/shutdown";
const REQUEST_TIMEOUT_MS = 1000;
const SHUTDOWN_TIMEOUT_MS = 8000;
const START_TIMEOUT_MS = 15000;

async function main(argv = process.argv.slice(2)) {
  loadEnvFile(PROJECT_ROOT);
  const command = String(argv.find((argument) => !argument.startsWith("-")) || "status").toLowerCase();
  const json = argv.includes("--json");
  const checkOnly = argv.includes("--check");
  const accessConfig = createAccessConfig(process.env);
  const context = {
    rootDir: PROJECT_ROOT,
    host: accessConfig.host,
    port: accessConfig.port,
    mode: accessConfig.mode
  };

  if (command === "ensure") return runEnsure(context, { json, checkOnly });
  if (command === "status") return runStatus(context, { json });
  if (command === "ocr-status") return runOcrStatus(context, { json });
  if (command === "start") return runStart(context, { json });
  if (command === "restart") return runRestart(context, { json });
  if (command === "stop") return runStop(context, { json });

  throw new Error(`Comando desconocido "${command}". Use ensure, start, status, ocr-status, restart o stop.`);
}

async function inspectRuntime(context) {
  const expectedFingerprint = computeSourceFingerprint(context.rootDir);
  const lock = readRuntimeLock(context.rootDir, context.port);
  const requestedProbe = await probeRuntimeHost(context.host, context.port);
  let activeProbe = requestedProbe;

  if (!requestedProbe.listening) {
    const alternateHosts = [
      ...(lock.state === "valid" ? [lock.value.host] : []),
      ...LOCAL_HOSTS
    ].filter((host, index, values) => (
      !hostsEqual(host, context.host)
      && values.findIndex((candidate) => hostsEqual(candidate, host)) === index
    ));

    for (const host of alternateHosts) {
      const alternateProbe = await probeRuntimeHost(host, context.port);
      if (alternateProbe.listening) {
        activeProbe = alternateProbe;
        break;
      }
    }
  }

  const listening = activeProbe.listening;
  const runtime = validPublicRuntime(activeProbe.health.body?.runtime)
    ? activeProbe.health.body.runtime
    : null;

  const result = {
    state: "stopped",
    url: formatUrl(context.host, context.port),
    activeUrl: listening ? formatUrl(activeProbe.host, context.port) : null,
    controlHost: activeProbe.host,
    expectedProjectRoot: path.resolve(context.rootDir),
    expectedFingerprint,
    listening,
    healthStatus: activeProbe.health.statusCode || null,
    runtime,
    lockState: lock.state,
    lockPath: lock.path,
    canControl: false
  };
  Object.defineProperty(result, "lockSnapshot", {
    value: lock.snapshot || null,
    enumerable: false
  });

  if (!listening) {
    result.state = lock.state === "missing" ? "stopped" : "stale_lock";
    if (lock.error) result.lockError = lock.error;
    return result;
  }

  if (!runtime) {
    result.state = "running_unverified";
    return result;
  }

  const sameProject = projectRootsEqual(runtime.projectRoot, context.rootDir);
  const fresh = runtime.sourceFingerprint === expectedFingerprint;
  const lockMatches = lock.state === "valid" && runtimeLockMatchesIdentity(lock.value, runtime);
  result.canControl = sameProject && lockMatches;
  if (lockMatches) {
    result.controlHost = lock.value.host;
    result.activeUrl = formatUrl(lock.value.host, context.port);
  }

  if (!sameProject) {
    result.state = "running_foreign";
  } else if (!lockMatches) {
    result.state = "running_unmanaged";
  } else if (!hostsEqual(lock.value.host, context.host)) {
    result.state = "running_other_host";
  } else if (!fresh) {
    result.state = "running_stale";
  } else {
    result.state = "running_fresh";
  }
  return result;
}

async function runStatus(context, options = {}) {
  const status = await inspectRuntime(context);
  writeStatus(status, options);
  process.exitCode = status.state === "running_fresh" ? 0 : 2;
  return status;
}

async function runOcrStatus(context, options = {}) {
  const status = await inspectRuntime(context);
  if (status.state !== "running_fresh") {
    writeStatus(status, options);
    process.exitCode = 2;
    return status;
  }

  const result = await inspectOcr(context, status);
  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (result.state === "ocr_reachable") {
    console.log(`OCR accesible desde el servidor ERP PID ${status.runtime.pid}.`);
    console.log(`Proveedor: ${result.ocr.provider}; respuesta de conectividad HTTP ${result.ocr.providerStatus}.`);
  } else {
    console.error(`OCR sin conectividad desde el servidor ERP PID ${status.runtime.pid}.`);
    console.error(`Transporte: ${result.ocr.transportCode || "respuesta_invalida"}.`);
  }
  process.exitCode = result.state === "ocr_reachable" ? 0 : 2;
  return result;
}

async function runEnsure(context, options = {}) {
  const configurationError = primaryEnsureConfigurationError(context);
  if (configurationError) {
    const result = {
      state: "ensure_invalid_configuration",
      action: "none",
      error: configurationError,
      expected: {
        projectRoot: PRIMARY_LOCAL_ROOT,
        workingDirectory: PRIMARY_LOCAL_ROOT,
        host: PRIMARY_LOCAL_HOST,
        port: PRIMARY_LOCAL_PORT,
        mode: "local"
      },
      actual: {
        projectRoot: path.resolve(context.rootDir),
        workingDirectory: path.resolve(process.cwd()),
        host: context.host,
        port: context.port,
        mode: context.mode
      }
    };
    writeEnsureResult(result, options);
    process.exitCode = 2;
    return result;
  }

  try {
    const result = await ensureOperational(context, options);
    writeEnsureResult(result, options);
    process.exitCode = result.state === "operational" ? 0 : 2;
    return result;
  } catch (error) {
    const result = {
      state: "ensure_failed",
      action: error.action || "none",
      error: error.message,
      diagnosis: error.diagnosis || null
    };
    writeEnsureResult(result, options);
    process.exitCode = 2;
    return result;
  }
}

async function ensureOperational(context, options = {}) {
  let status = await inspectRuntime(context);
  const initialState = status.state;
  let action = "no_op";
  let inspectedProcess = null;

  if (status.state === "running_fresh") {
    inspectedProcess = await verifyManagedProcess(context, status);
    const initialOcr = await inspectOcr(context, status);
    if (initialOcr.state === "ocr_reachable") {
      return operationalResult(status, initialOcr, inspectedProcess, action, initialState);
    }
    if (options.checkOnly) {
      return needsRestoreResult(status, initialOcr, inspectedProcess, "ocr_unreachable");
    }
    await stopVerifiedRuntime(context, status, inspectedProcess, "restarted_ocr_unreachable");
    action = "restarted_ocr_unreachable";
    status = await startDetachedAndWait(context);
  } else if (options.checkOnly) {
    if (status.canControl) inspectedProcess = await verifyManagedProcess(context, status);
    return needsRestoreResult(status, null, inspectedProcess, status.state);
  } else if (status.canControl) {
    inspectedProcess = await verifyManagedProcess(context, status);
    await stopVerifiedRuntime(context, status, inspectedProcess, "restarted_runtime");
    action = status.state === "running_stale"
      ? "restarted_stale"
      : "restarted_wrong_host";
    status = await startDetachedAndWait(context);
  } else {
    if (status.state === "stale_lock") {
      status = await clearStaleLock(context, status);
    }
    if (status.state !== "stopped") {
      throw ensureError(
        `No se puede restaurar el servidor desde el estado ${status.state}; no se detuvo ningun proceso.`,
        "none",
        status
      );
    }
    action = "started";
    status = await startDetachedAndWait(context);
  }

  inspectedProcess = await verifyManagedProcess(context, status);
  const ocr = await inspectOcr(context, status);
  if (ocr.state !== "ocr_reachable") {
    throw ensureError(
      `El servidor quedo running_fresh, pero OCR sigue inaccesible (${ocr.ocr.transportCode || "respuesta_invalida"}).`,
      action,
      { server: status, ocr: ocr.ocr }
    );
  }
  return operationalResult(status, ocr, inspectedProcess, action, initialState);
}

async function inspectOcr(context, status) {
  const probe = await requestJson({
    host: status.controlHost,
    port: context.port,
    path: OCR_HEALTH_PATH,
    method: "GET",
    timeoutMs: 7000
  });
  return {
    ...status,
    state: probe.statusCode === 200 && probe.body?.connectivity === "reachable"
      ? "ocr_reachable"
      : "ocr_unreachable",
    ocr: probe.body || {
      ok: false,
      connectivity: "unreachable",
      transportCode: probe.errorCode || "invalid_response"
    }
  };
}

function primaryEnsureConfigurationError(context) {
  if (!projectRootsEqual(context.rootDir, PRIMARY_LOCAL_ROOT)) {
    return "server:ensure solo puede ejecutarse con el tooling del checkout Local principal.";
  }
  if (!projectRootsEqual(process.cwd(), PRIMARY_LOCAL_ROOT)) {
    return "server:ensure debe ejecutarse desde el cwd del checkout Local principal.";
  }
  if (context.host !== PRIMARY_LOCAL_HOST || Number(context.port) !== PRIMARY_LOCAL_PORT) {
    return `server:ensure exige ${PRIMARY_LOCAL_HOST}:${PRIMARY_LOCAL_PORT}; limpie overrides de ERP_HOST/PORT.`;
  }
  if (context.mode !== "local") {
    return "server:ensure exige ERP_DEPLOYMENT_MODE=local.";
  }
  return "";
}

async function stopVerifiedRuntime(context, status, inspectedProcess, action) {
  if (!inspectedProcess?.verified) {
    throw ensureError("La identidad del proceso no quedo verificada; no se envio el cierre.", action, status);
  }
  await requestSafeShutdown(context, status);
  const stopped = await waitForStopped(context);
  if (stopped.state !== "stopped") {
    throw ensureError("La instancia verificada no quedo detenida; no se inicio otra.", action, stopped);
  }
}

async function startDetachedAndWait(context) {
  const child = childProcess.spawn(process.execPath, [
    path.join(context.rootDir, "tools", "erp-server.js"),
    "start"
  ], {
    cwd: context.rootDir,
    env: {
      ...process.env,
      ERP_DEPLOYMENT_MODE: "local",
      ERP_HOST: context.host,
      PORT: String(context.port)
    },
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastStatus = null;
  while (Date.now() < deadline) {
    lastStatus = await inspectRuntime(context);
    if (lastStatus.state === "running_fresh") return lastStatus;
    if (["running_foreign", "running_unmanaged", "running_unverified"].includes(lastStatus.state)) {
      break;
    }
    await delay(100);
  }
  throw ensureError(
    `El servidor iniciado en background no alcanzo running_fresh dentro de ${START_TIMEOUT_MS} ms.`,
    "started",
    lastStatus
  );
}

async function waitForStopped(context) {
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  let status = await inspectRuntime(context);
  while (Date.now() < deadline) {
    if (status.state === "stale_lock") status = await clearStaleLock(context, status);
    if (status.state === "stopped") return status;
    await delay(100);
    status = await inspectRuntime(context);
  }
  return status;
}

async function verifyManagedProcess(context, status) {
  if (!status.canControl || !status.runtime) {
    throw ensureError("Health y lock no acreditan ownership del proceso; no se actuo.", "none", status);
  }
  if (!projectRootsEqual(status.runtime.projectRoot, context.rootDir)
    || !projectRootsEqual(status.runtime.workingDirectory, context.rootDir)
    || status.runtime.host !== status.controlHost
    || status.runtime.port !== Number(context.port)) {
    throw ensureError("PID, checkout, cwd, host o puerto no coinciden con el Local principal.", "none", status);
  }

  let processIdentity = {
    pid: status.runtime.pid,
    executablePath: status.runtime.executablePath || "",
    commandLine: status.runtime.commandLine || "",
    source: "runtime_lock"
  };
  if (!processIdentity.commandLine) {
    processIdentity = {
      ...await readOperatingSystemProcess(status.runtime.pid),
      source: "operating_system"
    };
  }

  if (processIdentity.pid !== status.runtime.pid
    || !commandLineLooksLikeErp(processIdentity.commandLine, context.rootDir)
    || processIdentity.executablePath
      && path.basename(processIdentity.executablePath).toLowerCase() !== (process.platform === "win32" ? "node.exe" : "node")) {
    throw ensureError(
      "La linea de comando del PID no corresponde al servidor ERP esperado; no se actuo.",
      "none",
      { status, processIdentity }
    );
  }
  return { ...processIdentity, verified: true };
}

function commandLineLooksLikeErp(commandLine, rootDir) {
  const normalized = String(commandLine || "").replace(/\\/gu, "/").toLowerCase();
  const managerPath = path.join(rootDir, "tools", "erp-server.js").replace(/\\/gu, "/").toLowerCase();
  const serverPath = path.join(rootDir, "server.js").replace(/\\/gu, "/").toLowerCase();
  return normalized.includes(managerPath)
    || normalized.includes(serverPath)
    || /(?:^|[\s"'])tools\/erp-server\.js(?:$|[\s"'])/u.test(normalized)
    || /(?:^|[\s"'])server\.js(?:$|[\s"'])/u.test(normalized);
}

async function readOperatingSystemProcess(pid) {
  if (process.platform === "win32") return readWindowsProcess(pid);
  const commandPath = `/proc/${pid}/cmdline`;
  const executablePath = `/proc/${pid}/exe`;
  try {
    const commandLine = fs.readFileSync(commandPath, "utf8").split("\0").filter(Boolean).join(" ");
    return {
      pid,
      executablePath: fs.readlinkSync(executablePath),
      commandLine
    };
  } catch (error) {
    throw ensureError(
      `No se pudo inspeccionar la linea de comando del PID ${pid}: ${error.message}`,
      "none",
      { pid }
    );
  }
}

function readWindowsProcess(pid) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}"`,
    "if ($null -eq $process) { throw 'PID no encontrado' }",
    "[pscustomobject]@{ pid = [int]$process.ProcessId; executablePath = [string]$process.ExecutablePath; commandLine = [string]$process.CommandLine } | ConvertTo-Json -Compress"
  ].join("; ");

  return new Promise((resolve, reject) => {
    childProcess.execFile("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true,
      timeout: 5000
    }, (error, stdout, stderr) => {
      if (error) {
        reject(ensureError(
          `No se pudo inspeccionar la linea de comando del PID ${pid}: ${String(stderr || error.message).trim()}`,
          "none",
          { pid }
        ));
        return;
      }
      try {
        resolve(JSON.parse(String(stdout).trim()));
      } catch (parseError) {
        reject(ensureError(
          `La identidad del PID ${pid} no produjo JSON valido: ${parseError.message}`,
          "none",
          { pid }
        ));
      }
    });
  });
}

function operationalResult(status, ocr, inspectedProcess, action, initialState) {
  return {
    state: "operational",
    action,
    initialState,
    server: "running_fresh",
    ocr: "ocr_reachable",
    pid: status.runtime.pid,
    commandLine: inspectedProcess.commandLine,
    processIdentitySource: inspectedProcess.source,
    workingDirectory: status.runtime.workingDirectory,
    projectRoot: status.runtime.projectRoot,
    host: status.runtime.host,
    port: status.runtime.port,
    sourceFingerprint: status.runtime.sourceFingerprint,
    providerStatus: ocr.ocr.providerStatus
  };
}

function needsRestoreResult(status, ocr, inspectedProcess, reason) {
  return {
    state: "ensure_needs_restore",
    action: "none",
    reason,
    server: status.state,
    ocr: ocr?.state || "not_checked",
    pid: status.runtime?.pid || null,
    commandLine: inspectedProcess?.commandLine || null,
    workingDirectory: status.runtime?.workingDirectory || null,
    projectRoot: status.runtime?.projectRoot || status.expectedProjectRoot,
    host: status.runtime?.host || status.controlHost,
    port: status.runtime?.port || null
  };
}

function ensureError(message, action, diagnosis) {
  const error = new Error(message);
  error.action = action;
  error.diagnosis = diagnosis;
  return error;
}

function writeEnsureResult(result, options = {}) {
  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }
  const write = result.state === "operational" ? console.log : console.error;
  write(`[SERVER_ENSURE] ${result.state}; accion=${result.action}.`);
  if (result.state === "operational") {
    write(`server=${result.server}; ocr=${result.ocr}.`);
    write(`PID ${result.pid}; comando ${result.commandLine}`);
    write(`cwd ${result.workingDirectory}`);
    write(`checkout ${result.projectRoot}`);
    write(`host/puerto ${result.host}:${result.port}`);
    return;
  }
  write(result.error || `Diagnostico: ${result.reason}.`);
  if (result.diagnosis) write(`Detalle: ${JSON.stringify(result.diagnosis)}`);
}

async function runStart(context, options = {}) {
  let status = await inspectRuntime(context);
  if (status.state === "running_fresh") {
    writeStatus(status, options);
    if (!options.json) console.log("El ERP ya esta iniciado y corresponde al codigo actual.");
    process.exitCode = 0;
    return status;
  }
  if (status.state === "stale_lock") {
    status = await clearStaleLock(context, status);
    if (status.state === "running_fresh") {
      writeStatus(status, options);
      if (!options.json) console.log("Otra instancia inicio el ERP y corresponde al codigo actual.");
      process.exitCode = 0;
      return status;
    }
  }
  if (!["stopped", "stale_lock"].includes(status.state)) {
    writeStatus(status, options);
    if (!options.json) {
      console.error(startRefusalMessage(status));
      console.error("No se detuvo ningun proceso.");
    }
    process.exitCode = 2;
    return status;
  }

  if (status.state === "stale_lock") {
    writeStatus(status, options);
    if (!options.json) console.error("El lock cambio durante la limpieza; no se inicio otra instancia.");
    process.exitCode = 2;
    return status;
  }
  if (!options.json) {
    console.log(`Iniciando SunNutrition ERP en ${status.url} desde ${status.expectedProjectRoot}...`);
  }
  require(path.join(context.rootDir, "server.js"));
  return status;
}

async function runRestart(context, options = {}) {
  let status = await inspectRuntime(context);
  if (["running_foreign", "running_unmanaged", "running_unverified"].includes(status.state)) {
    writeStatus(status, options);
    if (!options.json) {
      console.error(controlRefusalMessage(status));
      console.error("No se detuvo ningun proceso.");
    }
    process.exitCode = 2;
    return status;
  }

  if (status.state === "stale_lock") {
    status = await clearStaleLock(context, status);
    if (status.state !== "stopped") {
      writeStatus(status, options);
      if (!options.json) console.error("El estado cambio durante la limpieza; el ERP no se reinicio.");
      process.exitCode = 2;
      return status;
    }
  }

  if (status.canControl) {
    await requestSafeShutdown(context, status);
  }

  let afterStop = await inspectRuntime(context);
  if (afterStop.state === "stale_lock") {
    afterStop = await clearStaleLock(context, afterStop);
  }
  if (afterStop.listening) {
    writeStatus(afterStop, options);
    if (!options.json) console.error("El puerto volvio a ocuparse; el ERP no se reinicio.");
    process.exitCode = 2;
    return afterStop;
  }

  if (afterStop.state !== "stopped") {
    writeStatus(afterStop, options);
    if (!options.json) console.error("El lock cambio durante la limpieza; el ERP no se reinicio.");
    process.exitCode = 2;
    return afterStop;
  }
  if (!options.json) console.log(`Reiniciando SunNutrition ERP en ${afterStop.url}...`);
  require(path.join(context.rootDir, "server.js"));
  return afterStop;
}

async function runStop(context, options = {}) {
  let status = await inspectRuntime(context);
  if (status.canControl) {
    await requestSafeShutdown(context, status);
    if (!options.json) console.log(`Servidor ERP detenido de forma segura (${status.runtime.instanceId}).`);
    process.exitCode = 0;
    return status;
  }
  if (status.state === "stale_lock") {
    status = await clearStaleLock(context, status);
  }
  if (status.state === "stopped") {
    if (!options.json) {
      console.log("El servidor ERP ya estaba detenido o se retiro un lock obsoleto sin detener procesos.");
    }
    process.exitCode = 0;
    return status;
  }

  writeStatus(status, options);
  if (!options.json) {
    console.error(controlRefusalMessage(status));
    console.error("No se detuvo ningun proceso.");
  }
  process.exitCode = 2;
  return status;
}

async function clearStaleLock(context, originalStatus) {
  const current = await inspectRuntime(context);
  if (current.state !== "stale_lock") return current;
  if (!originalStatus.lockSnapshot
    || current.lockSnapshot !== originalStatus.lockSnapshot) {
    return current;
  }

  const removed = removeInactiveRuntimeLock(
    context.rootDir,
    context.port,
    current.lockSnapshot
  );
  if (!removed) return inspectRuntime(context);
  return inspectRuntime(context);
}

async function requestSafeShutdown(context, originalStatus) {
  const current = await inspectRuntime(context);
  if (!current.canControl
    || current.runtime.instanceId !== originalStatus.runtime.instanceId
    || current.runtime.pid !== originalStatus.runtime.pid) {
    throw new Error("La instancia cambio durante la verificacion. No se envio la orden de cierre.");
  }

  const lock = readRuntimeLock(context.rootDir, context.port);
  if (lock.state !== "valid" || !runtimeLockMatchesIdentity(lock.value, current.runtime)) {
    throw new Error("El lock dejo de coincidir con el servidor. No se envio la orden de cierre.");
  }

  const response = await requestJson({
    host: current.controlHost,
    port: context.port,
    path: SHUTDOWN_PATH,
    method: "POST",
    headers: { "X-ERP-Runtime-Token": lock.value.controlToken }
  });
  if (response.statusCode !== 202 || response.body?.instanceId !== current.runtime.instanceId) {
    throw new Error(
      `El servidor rechazo el cierre seguro (${response.statusCode || response.errorCode || "sin respuesta"}).`
    );
  }

  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const health = await requestJson({
      host: current.controlHost,
      port: context.port,
      path: HEALTH_PATH,
      method: "GET",
      timeoutMs: 300
    });
    if (!health.connected || health.body?.runtime?.instanceId !== current.runtime.instanceId) {
      removeRuntimeLockIfOwned(context.rootDir, {
        publicIdentity: current.runtime,
        controlToken: lock.value.controlToken
      });
      return;
    }
    await delay(100);
  }
  throw new Error("La instancia confirmada no libero el puerto dentro del timeout; no se inicio otra.");
}

function validPublicRuntime(runtime) {
  return Boolean(runtime
    && runtime.appId === APP_ID
    && Number.isInteger(runtime.pid)
    && Number.isInteger(runtime.port)
    && runtime.instanceId
    && runtime.startedAt
    && runtime.projectRoot
    && runtime.sourceFingerprint);
}

function writeStatus(status, options = {}) {
  if (options.json) {
    console.log(JSON.stringify(status));
    return;
  }

  if (status.state === "running_fresh") {
    console.log(`ERP activo y actualizado en ${status.url}.`);
    console.log(`PID ${status.runtime.pid}; inicio ${status.runtime.startedAt}.`);
    console.log(`Codigo: ${status.runtime.projectRoot}`);
    console.log(`Huella: ${status.runtime.sourceFingerprint}`);
    return;
  }
  if (status.state === "running_stale") {
    console.error(`ERP activo pero obsoleto en ${status.activeUrl}.`);
    console.error(`Runtime: ${status.runtime.sourceFingerprint}`);
    console.error(`Codigo actual: ${status.expectedFingerprint}`);
    console.error('Ejecute "npm.cmd run server:restart" antes de validar.');
    return;
  }
  if (status.state === "running_other_host") {
    console.error(`ERP activo en ${status.activeUrl}, pero este comando esperaba ${status.url}.`);
    console.error("El lock se conservo y no se inicio una segunda instancia.");
    console.error("Use el ERP_HOST registrado o server:restart/server:stop para controlar la instancia verificada.");
    return;
  }
  if (status.state === "running_foreign") {
    console.error(`El puerto ${status.activeUrl} pertenece a otro checkout.`);
    console.error(`Runtime: ${status.runtime.projectRoot}`);
    console.error(`Esperado: ${status.expectedProjectRoot}`);
    console.error("Ejecute status/restart/stop desde el checkout que figura en Runtime.");
    return;
  }
  if (status.state === "running_unmanaged") {
    console.error(`El ERP en ${status.activeUrl} no tiene un lock verificable para este checkout.`);
    console.error(`PID informado por health: ${status.runtime.pid}; instancia ${status.runtime.instanceId}.`);
    console.error("Cierre la terminal que lo inicio; no se detuvo ningun proceso.");
    return;
  }
  if (status.state === "running_unverified") {
    console.error(`El puerto ${status.activeUrl} esta ocupado por un servicio sin identidad ERP verificable.`);
    console.error("Identifique a su propietario; no se detuvo ningun proceso ni se uso el PID como prueba.");
    return;
  }
  if (status.state === "stale_lock") {
    console.error(`No hay servidor en ${status.url}, pero existe un lock obsoleto: ${status.lockPath}`);
    console.error("start, restart o stop pueden retirarlo sin detener procesos.");
    return;
  }
  console.error(`No hay servidor ERP activo en ${status.url}.`);
  console.error('Ejecute "npm.cmd start" para iniciarlo.');
}

function startRefusalMessage(status) {
  if (status.state === "running_stale") {
    return 'El runtime pertenece a este checkout pero esta obsoleto. Use "npm.cmd run server:restart".';
  }
  return controlRefusalMessage(status);
}

function controlRefusalMessage(status) {
  if (status.state === "running_other_host") {
    return `Ya existe una instancia verificable en ${status.activeUrl}; no se reemplazo su lock.`;
  }
  if (status.state === "running_foreign") {
    return "Cierre o reinicie el servidor desde el checkout que figura en su identidad.";
  }
  if (status.state === "running_unmanaged") {
    return "Cierre la instancia desde la terminal que la inicio y vuelva a arrancar con npm.cmd start.";
  }
  return "Identifique primero al propietario del puerto; nunca use taskkill /IM node.exe ni cierres masivos.";
}

async function probeRuntimeHost(host, port) {
  const health = await requestJson({
    host,
    port,
    path: HEALTH_PATH,
    method: "GET"
  });
  return {
    host,
    health,
    listening: health.connected || await isPortListening(host, port)
  };
}

function hostsEqual(left, right) {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
}

function formatUrl(host, port) {
  const hostname = String(host).includes(":") ? `[${host}]` : host;
  return `http://${hostname}:${port}`;
}

function requestJson({ host, port, path: requestPath, method, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const request = http.request({
      hostname: host,
      port,
      path: requestPath,
      method,
      headers
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        let body = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {}
        resolve({
          connected: true,
          statusCode: response.statusCode,
          body,
          raw
        });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("timeout")));
    request.on("error", (error) => resolve({
      connected: false,
      statusCode: null,
      body: null,
      errorCode: error.code || error.message
    }));
    request.end();
  });
}

function isPortListening(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(400);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[ERP_SERVER_ERROR] ${error.message}`);
    console.error("No se detuvo ningun proceso no verificado.");
    process.exitCode = 1;
  });
}

module.exports = {
  ensureOperational,
  inspectRuntime,
  main,
  requestSafeShutdown,
  runEnsure,
  runOcrStatus,
  runRestart,
  runStart,
  runStatus,
  runStop
};
