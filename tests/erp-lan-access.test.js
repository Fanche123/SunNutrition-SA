const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
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
  safeEqual
} = require("../tools/erp-lan-access");

test("limita clientes a la subred configurada", () => {
  assert.equal(isAddressInSubnet("192.168.0.42", "192.168.0.0", 24), true);
  assert.equal(isAddressInSubnet("::ffff:192.168.0.249", "192.168.0.0", 24), true);
  assert.equal(isAddressInSubnet("192.168.1.42", "192.168.0.0", 24), false);
  assert.equal(isAddressInSubnet("203.0.113.5", "192.168.0.0", 24), false);
});

test("calcula la red sin hardcodear la IP Wi-Fi", () => {
  assert.equal(networkAddress("192.168.0.249", 24), "192.168.0.0");
  assert.equal(networkAddress("172.20.7.8", 16), "172.20.0.0");
  assert.equal(normalizeIpv4("::ffff:10.0.0.4"), "10.0.0.4");
});

test("la excepcion rechaza cualquier interfaz fuera de 192.168.0.0/24", () => {
  assert.equal(isAddressInSubnet("192.168.0.249", AUTHORIZED_NETWORK, AUTHORIZED_PREFIX_LENGTH), true);
  assert.equal(isAddressInSubnet("192.168.1.10", AUTHORIZED_NETWORK, AUTHORIZED_PREFIX_LENGTH), false);
  assert.equal(isAddressInSubnet("10.0.0.10", AUTHORIZED_NETWORK, AUTHORIZED_PREFIX_LENGTH), false);
  assert.equal(isAddressInSubnet("172.16.0.10", AUTHORIZED_NETWORK, AUTHORIZED_PREFIX_LENGTH), false);
  assert.equal(
    authorizedLanInterfaces().every((entry) => (
      entry.network === AUTHORIZED_NETWORK
      && entry.prefixLength === AUTHORIZED_PREFIX_LENGTH
      && isAddressInSubnet(entry.host, AUTHORIZED_NETWORK, AUTHORIZED_PREFIX_LENGTH)
    )),
    true
  );
});

test("reescribe origen local y elimina headers de control", () => {
  const headers = rewriteProxyHeaders({
    host: "192.168.0.249:3001",
    origin: "http://192.168.0.249:3001",
    referer: "http://192.168.0.249:3001/",
    "x-erp-runtime-token": "no-forward",
    "x-erp-lan-control-token": "no-forward"
  });
  assert.equal(headers.host, "127.0.0.1:3000");
  assert.equal(headers.origin, "http://127.0.0.1:3000");
  assert.equal(headers.referer, "http://127.0.0.1:3000/");
  assert.equal(headers["x-erp-runtime-token"], undefined);
  assert.equal(headers["x-erp-lan-control-token"], undefined);
});

test("modela y recupera locks invalidos sin borrar un lock cambiado", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-lan-lock-"));
  try {
    fs.mkdirSync(path.join(rootDir, "tmp"));
    const file = runtimeLockPath(3101, rootDir);
    fs.writeFileSync(file, "{invalido");
    const first = readLockState(3101, rootDir);
    assert.equal(first.state, "invalid");
    fs.writeFileSync(file, "{otro");
    assert.throws(() => removeInactiveLock(first, 3101, rootDir), /cambio/);
    const second = readLockState(3101, rootDir);
    assert.equal(removeInactiveLock(second, 3101, rootDir), true);
    assert.equal(readLockState(3101, rootDir).state, "missing");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("detecta cambios en la huella propia", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-lan-fingerprint-"));
  try {
    const file = path.join(rootDir, "proxy.js");
    fs.writeFileSync(file, "uno");
    const first = computeSourceFingerprint(file);
    fs.writeFileSync(file, "dos");
    assert.notEqual(computeSourceFingerprint(file), first);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("valida locks completos y tokens con comparacion constante", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-lan-valid-"));
  try {
    fs.mkdirSync(path.join(rootDir, "tmp"));
    const lock = {
      schemaVersion: 1,
      appId: APP_ID,
      instanceId: "instance",
      pid: 123,
      projectRoot: rootDir,
      workingDirectory: rootDir,
      executablePath: process.execPath,
      commandLine: "node proxy.js serve",
      sourceFingerprint: "sha256:test",
      host: "192.168.0.249",
      port: 3102,
      network: "192.168.0.0",
      prefixLength: 24,
      controlToken: "x".repeat(32)
    };
    fs.writeFileSync(runtimeLockPath(3102, rootDir), JSON.stringify(lock));
    assert.equal(readLockState(3102, rootDir).state, "valid");
    assert.equal(safeEqual("control", "control"), true);
    assert.equal(safeEqual("control", "otro"), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("no reclama un controller lock recien creado sin metadata", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-lan-control-"));
  try {
    fs.mkdirSync(path.join(rootDir, "tmp"));
    const lockDirectory = controlLockPath(3103, rootDir);
    fs.mkdirSync(lockDirectory);
    assert.equal(reclaimAbandonedControlLock(lockDirectory), false);
    assert.equal(fs.existsSync(lockDirectory), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
