const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { LOCAL_HOSTS } = require("../config/access");

const APP_ID = "sunnutrition-erp";
const RUNTIME_SCHEMA_VERSION = 1;
const SOURCE_DIRECTORIES = ["assets", "backend", "shared"];
const SOURCE_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".svg"]);
const SOURCE_ROOT_FILES = [
  "index.html",
  "package-lock.json",
  "package.json",
  "server.js",
  path.join("tools", "backend-sqlite-query.py"),
  path.join("tools", "erp-server.js")
];

function loadEnvFile(rootDir, env = process.env) {
  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) return;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!env[key]) env[key] = value;
  });
}

function resolveProjectRoot(rootDir) {
  const resolved = path.resolve(rootDir);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function canonicalProjectRoot(rootDir) {
  const resolved = resolveProjectRoot(rootDir);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function projectRootsEqual(left, right) {
  if (!left || !right || !path.isAbsolute(String(left)) || !path.isAbsolute(String(right))) return false;
  return canonicalProjectRoot(left) === canonicalProjectRoot(right);
}

function computeSourceFingerprint(rootDir) {
  const projectRoot = resolveProjectRoot(rootDir);
  const relativePaths = collectSourceFiles(projectRoot);
  const hash = crypto.createHash("sha256");

  relativePaths.forEach((relativePath) => {
    const normalizedPath = relativePath.split(path.sep).join("/");
    hash.update(normalizedPath);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(projectRoot, relativePath)));
    hash.update("\0");
  });

  return `sha256:${hash.digest("hex")}`;
}

function collectSourceFiles(projectRoot) {
  const relativePaths = [];

  SOURCE_ROOT_FILES.forEach((relativePath) => {
    if (fs.existsSync(path.join(projectRoot, relativePath))) relativePaths.push(relativePath);
  });

  SOURCE_DIRECTORIES.forEach((directoryName) => {
    const absoluteDirectory = path.join(projectRoot, directoryName);
    if (!fs.existsSync(absoluteDirectory)) return;
    collectSourceDirectory(projectRoot, absoluteDirectory, relativePaths);
  });

  return relativePaths.sort((left, right) => left.localeCompare(right, "en"));
}

function collectSourceDirectory(projectRoot, directory, relativePaths) {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en"));

  entries.forEach((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSourceDirectory(projectRoot, absolutePath, relativePaths);
      return;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) return;
    relativePaths.push(path.relative(projectRoot, absolutePath));
  });
}

function createRuntimeSession({ rootDir, host, port, now = new Date(), pid = process.pid }) {
  const projectRoot = resolveProjectRoot(rootDir);
  const publicIdentity = Object.freeze({
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    appId: APP_ID,
    instanceId: crypto.randomUUID(),
    pid,
    startedAt: now.toISOString(),
    projectRoot,
    workingDirectory: path.resolve(process.cwd()),
    sourceFingerprint: computeSourceFingerprint(projectRoot),
    host,
    port,
    nodeVersion: process.version
  });

  return Object.freeze({
    publicIdentity,
    controlToken: crypto.randomBytes(32).toString("hex")
  });
}

function runtimeLockPath(rootDir, port) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    throw new Error(`Puerto de runtime invalido: ${port}`);
  }
  return path.join(resolveProjectRoot(rootDir), "tmp", `erp-server-${numericPort}.lock.json`);
}

function runtimeLockRecord(session) {
  return {
    ...session.publicIdentity,
    controlToken: session.controlToken
  };
}

function writeRuntimeLock(rootDir, session) {
  const lockRecord = runtimeLockRecord(session);
  const lockPath = runtimeLockPath(rootDir, lockRecord.port);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify(lockRecord, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });

  return lockPath;
}

function readRuntimeLock(rootDir, port) {
  const lockPath = runtimeLockPath(rootDir, port);
  if (!fs.existsSync(lockPath)) return { state: "missing", path: lockPath, value: null };

  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const snapshot = runtimeLockSnapshot(raw);
    const value = JSON.parse(raw);
    const validationError = validateRuntimeLock(value, port);
    if (validationError) {
      return { state: "invalid", path: lockPath, value: null, snapshot, error: validationError };
    }
    return { state: "valid", path: lockPath, value, snapshot };
  } catch (error) {
    return {
      state: "invalid",
      path: lockPath,
      value: null,
      error: `Lock ilegible: ${error.message}`
    };
  }
}

function validateRuntimeLock(value, expectedPort) {
  if (!value || typeof value !== "object") return "El lock no contiene un objeto JSON.";
  if (value.schemaVersion !== RUNTIME_SCHEMA_VERSION || value.appId !== APP_ID) {
    return "El lock no pertenece a esta version del ERP.";
  }
  if (!Number.isInteger(value.pid) || value.pid < 1) return "El lock no contiene un PID valido.";
  if (value.port !== Number(expectedPort)) return "El lock corresponde a otro puerto.";
  if (!LOCAL_HOSTS.has(String(value.host || ""))) return "El lock no contiene un host local valido.";
  if (!path.isAbsolute(String(value.projectRoot || ""))) return "El lock no contiene una ruta absoluta.";
  if (!value.instanceId || !value.startedAt || !value.sourceFingerprint) {
    return "El lock no contiene la identidad completa del runtime.";
  }
  if (!/^[a-f0-9]{64}$/i.test(String(value.controlToken || ""))) {
    return "El lock no contiene un token de control valido.";
  }
  return "";
}

function runtimeLockMatchesIdentity(lockRecord, publicIdentity) {
  if (!lockRecord || !publicIdentity) return false;
  return lockRecord.appId === APP_ID
    && publicIdentity.appId === APP_ID
    && lockRecord.schemaVersion === publicIdentity.schemaVersion
    && lockRecord.instanceId === publicIdentity.instanceId
    && lockRecord.pid === publicIdentity.pid
    && lockRecord.port === publicIdentity.port
    && lockRecord.host === publicIdentity.host
    && lockRecord.startedAt === publicIdentity.startedAt
    && lockRecord.sourceFingerprint === publicIdentity.sourceFingerprint
    && projectRootsEqual(lockRecord.projectRoot, publicIdentity.projectRoot);
}

function removeRuntimeLockIfOwned(rootDir, session) {
  const current = readRuntimeLock(rootDir, session.publicIdentity.port);
  if (current.state !== "valid" || !runtimeLockMatchesIdentity(current.value, session.publicIdentity)) return false;
  if (!safeTokenEquals(current.value.controlToken, session.controlToken)) return false;
  fs.rmSync(current.path, { force: true });
  return true;
}

function removeInactiveRuntimeLock(rootDir, port, expectedSnapshot) {
  if (!expectedSnapshot) return false;
  const lockPath = runtimeLockPath(rootDir, port);
  const claimPath = `${lockPath}.${process.pid}.${crypto.randomUUID()}.stale-claim`;

  try {
    fs.renameSync(lockPath, claimPath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }

  const claimedRaw = fs.readFileSync(claimPath, "utf8");
  if (runtimeLockSnapshot(claimedRaw) !== expectedSnapshot) {
    try {
      fs.copyFileSync(claimPath, lockPath, fs.constants.COPYFILE_EXCL);
      fs.rmSync(claimPath, { force: true });
    } catch (error) {
      throw new Error(
        `El lock cambio durante la limpieza y no pudo restaurarse automaticamente: ${error.message}`
      );
    }
    return false;
  }

  fs.rmSync(claimPath, { force: true });
  return true;
}

function runtimeLockSnapshot(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

function safeTokenEquals(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  return leftBuffer.length === rightBuffer.length
    && leftBuffer.length > 0
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

module.exports = {
  APP_ID,
  RUNTIME_SCHEMA_VERSION,
  canonicalProjectRoot,
  computeSourceFingerprint,
  createRuntimeSession,
  loadEnvFile,
  projectRootsEqual,
  readRuntimeLock,
  removeInactiveRuntimeLock,
  removeRuntimeLockIfOwned,
  resolveProjectRoot,
  runtimeLockMatchesIdentity,
  runtimeLockPath,
  safeTokenEquals,
  writeRuntimeLock
};
