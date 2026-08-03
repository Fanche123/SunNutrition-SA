const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createAccessConfig } = require("../backend/config/access");
const { createSecurityStore } = require("../backend/repositories/security-store.repository");
const { createAccessControl } = require("../backend/services/access-control.service");
const { createAuditService } = require("../backend/services/audit.service");
const { createAuthService, hashPassword, verifyPassword } = require("../backend/services/auth.service");
const { canUseGenericTableMutation } = require("../backend/services/backend-table.service");
const { createInventoryEntryService } = require("../backend/services/inventory-entry.service");
const { setCorsHeaders } = require("../backend/utils/http");
const { isOwnerOnlyApi, isViewAllowed } = require("../shared/access-policy");
const { parseOptions } = require("../tools/manage-users");

test("scrypt usa salts distintos y nunca conserva la contraseña", () => {
  const first = hashPassword("Frase segura 1234");
  const second = hashPassword("Frase segura 1234");
  assert.equal(first.algorithm, "scrypt");
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
  assert.equal(verifyPassword("Frase segura 1234", first), true);
  assert.equal(verifyPassword("incorrecta", first), false);
  assert.doesNotMatch(JSON.stringify(first), /Frase segura 1234/);
});

test("dos sesiones se autentican como actores diferentes sin exponer hashes", async (context) => {
  const harness = authHarness(context);
  harness.auth.createUser({ username: "propietario", displayName: "Propietario", role: "owner", password: "Clave propietaria 123" });
  harness.auth.createUser({ username: "administrativa", displayName: "Administrativa", role: "employee_admin", password: "Clave empleada 456" });

  const ownerLogin = await harness.login("propietario", "Clave propietaria 123");
  const employeeLogin = await harness.login("administrativa", "Clave empleada 456");
  const owner = harness.auth.authenticateRequest({ headers: { cookie: ownerLogin.cookie } });
  const employee = harness.auth.authenticateRequest({ headers: { cookie: employeeLogin.cookie } });
  assert.equal(owner.user.username, "propietario");
  assert.equal(employee.user.username, "administrativa");
  assert.notEqual(owner.sessionId, employee.sessionId);
  assert.equal(ownerLogin.payload.user.password, undefined);
  assert.doesNotMatch(fs.readFileSync(harness.usersFile, "utf8"), /Clave propietaria|Clave empleada/);
});

test("el empleado queda fuera de usuarios y el cliente no define el rol", async () => {
  const config = createAccessConfig({});
  const sendJson = (response, status, payload) => { response.statusCode = status; response.payload = payload; };
  const employee = { allowed: true, user: { id: "u2", username: "empleada", role: "employee_admin" }, roles: ["employee_admin"] };
  const access = createAccessControl({
    accessConfig: config,
    authenticateRequest: () => employee,
    sendJson,
    setCorsHeaders
  });
  const denied = responseCapture();
  const request = {
    method: "GET",
    url: "/api/auth/users",
    headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
    body: { role: "owner", userId: "u1" }
  };
  assert.equal(await access(request, denied), false);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.payload.code, "OWNER_REQUIRED");
  assert.equal(request.accessIdentity, undefined);
});

test("la matriz central reserva analisis y seguridad, pero permite administracion tecnica", async () => {
  const config = createAccessConfig({});
  const sendJson = (response, status, payload) => { response.statusCode = status; response.payload = payload; };
  const accessFor = (role) => createAccessControl({
    accessConfig: config,
    authenticateRequest: () => ({ allowed: true, user: { id: role, username: role, role }, roles: [role] }),
    sendJson,
    setCorsHeaders
  });
  const employeeAccess = accessFor("employee_admin");
  const ownerAccess = accessFor("owner");

  for (const path of [
    "/api/auth/users",
    "/api/audit/events",
    "/api/reports/income-statement?from=2026-01-01&to=2026-01-31",
    "/api/reports/cashflow",
    "/api/reports/production?from=2026-01-01&to=2026-01-31"
  ]) {
    const denied = responseCapture();
    assert.equal(await employeeAccess(requestFor("GET", path), denied), false, path);
    assert.equal(denied.payload.code, "OWNER_REQUIRED", path);
  }

  for (const [method, path] of [
    ["GET", "/api/backend/tables"],
    ["GET", "/api/backend/schema"],
    ["GET", "/api/backend/map"],
    ["GET", "/api/admin/tables"],
    ["POST", "/api/admin/tables/clientes"],
    ["POST", "/api/backend/sql"]
  ]) {
    assert.equal(await employeeAccess(requestFor(method, path), responseCapture()), true, `${method} ${path}`);
  }

  const arbitraryWrite = responseCapture();
  assert.equal(await employeeAccess(requestFor("POST", "/api/backend/tables/clientes"), arbitraryWrite), false);
  assert.equal(arbitraryWrite.payload.code, "OWNER_REQUIRED");

  assert.equal(await employeeAccess(requestFor("POST", "/api/backend/tables/egresos"), responseCapture()), true);
  assert.equal(await ownerAccess(requestFor("POST", "/api/backend/tables/clientes"), responseCapture()), true);
  assert.equal(await ownerAccess(requestFor("GET", "/api/reports/cashflow"), responseCapture()), true);
  assert.equal(canUseGenericTableMutation({ user: { role: "employee_admin" } }, "egresos", []), true);
  assert.equal(canUseGenericTableMutation({ user: { role: "employee_admin" } }, "egresos", ["1"]), false);
  assert.equal(canUseGenericTableMutation({ user: { role: "employee_admin" } }, "clientes", []), false);
});

test("la politica compartida oculta Analisis y conserva Administracion tecnica para el empleado", () => {
  for (const view of ["results", "cashflow", "production", "activity-log", "user-management"]) {
    assert.equal(isViewAllowed("employee_admin", view), false, view);
  }
  for (const view of ["dashboard", "data-editor", "data-map", "sql", "settings"]) {
    assert.equal(isViewAllowed("employee_admin", view), true, view);
  }
  for (const view of ["results", "cashflow", "production", "activity-log", "user-management", "data-editor", "sql"]) {
    assert.equal(isViewAllowed("owner", view), true, view);
  }
  assert.equal(isOwnerOnlyApi("/api/reports/cashflow"), true);
  assert.equal(isOwnerOnlyApi("/api/auth/users"), true);
  assert.equal(isOwnerOnlyApi("/api/audit/events"), true);
  assert.equal(isOwnerOnlyApi("/api/admin/tables"), false);
  assert.equal(isOwnerOnlyApi("/api/backend/sql"), false);
});

test("el HTML y el cambio de vista aplican la matriz sin depender de CSS", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(__dirname, "..", "assets", "js", "app.js"), "utf8");
  const accessSource = fs.readFileSync(path.join(__dirname, "..", "assets", "js", "modules", "access.js"), "utf8");
  assert.match(html, /<div class="nav-group is-collapsed" data-analysis-only>[\s\S]*?<span>Análisis<\/span>/);
  for (const view of ["results", "cashflow", "production"]) {
    assert.match(html, new RegExp(`id="view-${view}"[^>]*data-analysis-only`), view);
  }
  assert.match(html, /data-view="activity-log" data-owner-only/);
  assert.match(html, /data-view="user-management" data-owner-only/);
  assert.doesNotMatch(html, /data-view="data-editor"[^>]*data-owner-only/);
  assert.doesNotMatch(html, /data-view="sql"[^>]*data-owner-only/);
  assert.match(appSource, /erpAccessPolicy\?\.isViewAllowed\(authenticatedRole, view\)\) view = "dashboard"/);
  assert.match(accessSource, /erpAccessPolicy\?\.isViewAllowed\(user\.role, "results"\) === true/);
});

test("cada mutación exitosa produce un solo evento; un fallo no produce éxito y no filtra secretos", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "erp-audit-test-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const auditFile = path.join(directory, "activity.jsonl");
  let cache = { tables: { clientes: { rows: [{ id_cliente: 1, nombre_cliente: "Antes", password: "secreto-original" }] } } };
  const service = createAuditService({
    auditFile,
    loadCache: () => JSON.parse(JSON.stringify(cache)),
    loadRegistry: () => ({ tables: [{ name: "clientes", primaryKey: "id_cliente" }] })
  });
  const actor = { allowed: true, user: { id: "u2", username: "administrativa", displayName: "Administrativa", role: "employee_admin" } };

  const request = requestFor("POST", "/api/backend/tables/clientes");
  const response = new TestResponse();
  await service.beginRequest(request, response, actor);
  cache.tables.clientes.rows[0].nombre_cliente = "Después";
  cache.tables.clientes.rows[0].password = "secreto-nuevo";
  response.writeHead(200);
  response.end(JSON.stringify({ ok: true, actor: "falsificado" }));

  const failedRequest = requestFor("POST", "/api/backend/tables/clientes");
  const failedResponse = new TestResponse();
  await service.beginRequest(failedRequest, failedResponse, actor);
  failedResponse.writeHead(400);
  failedResponse.end(JSON.stringify({ ok: false }));

  const result = service.listEvents({ limit: 10 });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].actor.username, "administrativa");
  assert.equal(result.events[0].outcome, "success");
  assert.match(result.events[0].occurredAtBuenosAires, /-03:00$/);
  assert.deepEqual(result.events[0].fields, ["nombre_cliente"]);
  assert.equal(result.integrity, true);
  const raw = fs.readFileSync(auditFile, "utf8");
  assert.doesNotMatch(raw, /secreto-original|secreto-nuevo|falsificado/);
});

test("la cadena append-only detecta alteraciones", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "erp-audit-chain-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const auditFile = path.join(directory, "activity.jsonl");
  const service = createAuditService({
    auditFile,
    loadCache: () => ({ tables: {} }),
    loadRegistry: () => ({ tables: [] })
  });
  service.appendSecurityEvent({ action: "login", actor: { id: "u1", username: "owner", role: "owner" } });
  const original = fs.readFileSync(auditFile, "utf8");
  fs.writeFileSync(auditFile, original.replace('"action":"login"', '"action":"altered"'));
  assert.equal(service.readVerifiedEvents().valid, false);
});

test("un fallo de append conserva respuesta unica y deja resultado durable recuperable", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "erp-audit-recovery-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const auditFile = path.join(directory, "activity.jsonl");
  const recoveryFile = path.join(directory, "recovery.jsonl");
  let failAuditAppend = true;
  const fsModule = new Proxy(fs, {
    get(target, property) {
      if (property === "appendFileSync") {
        return (file, ...args) => {
          if (failAuditAppend && path.resolve(file) === path.resolve(auditFile)) throw new Error("disk-failure");
          return target.appendFileSync(file, ...args);
        };
      }
      return target[property];
    }
  });
  let cache = { tables: { clientes: { rows: [{ id_cliente: 1, nombre_cliente: "Antes" }] } } };
  const service = createAuditService({
    auditFile,
    recoveryFile,
    fsModule,
    loadCache: () => JSON.parse(JSON.stringify(cache)),
    loadRegistry: () => ({ tables: [{ name: "clientes", primaryKey: "id_cliente" }] })
  });
  const actor = { allowed: true, user: { id: "u2", username: "administrativa", role: "employee_admin" } };
  const request = requestFor("POST", "/api/treasury/example");
  const response = new TestResponse();
  await service.beginRequest(request, response, actor);
  cache.tables.clientes.rows[0].nombre_cliente = "Despues";
  response.writeHead(200);
  assert.doesNotThrow(() => response.end(JSON.stringify({ ok: true })));
  assert.equal(response.endCalls, 1);
  assert.equal(response.headers["X-ERP-Audit-State"], "pending-recovery");
  assert.equal(response.headers["X-ERP-Request-Id"], request.auditRequestId);
  const pending = service.listEvents({ limit: 10 });
  assert.equal(pending.events.length, 1);
  assert.equal(pending.events[0].requestId, request.auditRequestId);
  assert.equal(pending.events[0].recoveryState, "pending");
  assert.equal(pending.integrity, false);

  failAuditAppend = false;
  const failedRequest = requestFor("POST", "/api/treasury/example");
  const failedResponse = new TestResponse();
  await service.beginRequest(failedRequest, failedResponse, actor);
  failedResponse.writeHead(400);
  failedResponse.end(JSON.stringify({ ok: false }));
  const recovered = service.listEvents({ limit: 10 });
  assert.equal(recovered.events.length, 1);
  assert.equal(recovered.events[0].requestId, request.auditRequestId);
  assert.equal(recovered.integrity, true);
});

test("la segunda escritura de usuarios crea un backup SHA-256 restaurable", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "erp-users-backup-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const usersFile = path.join(directory, "users.json");
  const store = createSecurityStore({ usersFile });
  store.writeUsers({ version: 1, users: [{ id: "u1", username: "owner" }] });
  const original = fs.readFileSync(usersFile);
  const result = store.writeUsers({ version: 1, users: [{ id: "u1", username: "owner" }, { id: "u2", username: "employee" }] });
  const backup = fs.readFileSync(result.backup.file);
  assert.deepEqual(backup, original);
  assert.equal(result.backup.sha256, require("node:crypto").createHash("sha256").update(original).digest("hex"));
});

test("barsPerDay declara metadata auditable sin registrar su valor", async () => {
  const request = { body: { barsPerDay: 12345 } };
  const response = responseCapture();
  const cache = {};
  const service = createInventoryEntryService({
    loadCache: () => cache,
    readJsonBody: async (input) => input.body,
    saveBackendCache: () => {},
    sendJson: (output, status, payload) => { output.statusCode = status; output.payload = payload; },
    updateInventoryPurchaseConfig: (_cache, barsPerDay) => ({ config: { barsPerDay }, snapshot: { barsPerDay } })
  });
  await service.handleInventoryPurchaseProductionRate(request, response);
  assert.deepEqual(request.auditSummary, {
    action: "update",
    module: "inventory",
    entity: "inventoryPurchaseConfig",
    recordId: "barsPerDay",
    fields: ["barsPerDay"]
  });
  assert.doesNotMatch(JSON.stringify(request.auditSummary), /12345/);
});

test("el bootstrap no admite contrasena en argumentos", () => {
  assert.throws(() => parseOptions(["--password", "no-usar"]), /no esta admitido/i);
  assert.deepEqual(parseOptions(["--username", "owner", "--display-name", "Propietario", "--role", "owner"]), {
    username: "owner",
    "display-name": "Propietario",
    role: "owner"
  });
});

test("conciliacion ofrece atajos del Editor al empleado autorizado", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "assets", "js", "modules", "bank-reconciliation-render.js"), "utf8");
  const context = {
    bankMovementCreditorId: () => "",
    bankMovementLooksLikeCheckDeposit: () => false,
    bankReconciliationOpenDebtCreditorIds: new Set(),
    escapeHtml: (value) => String(value),
    moneyToCents: (value) => Math.round(Number(value || 0) * 100),
    erpAuthentication: { user: { role: "employee_admin" } },
    erpAccessPolicy: { isViewAllowed }
  };
  vm.runInNewContext(source, context);
  const unmatched = { status: "pendiente", action: "Revisar", amount: 100, suggestedCounterparty: { name: "Cliente" } };
  const check = { status: "pendiente", action: "Revisar", amount: 100, checkNumber: "123" };
  assert.match(context.bankReconciliationActionCell(unmatched, 0), /data-bank-add-client=/);
  assert.match(context.bankReconciliationActionCell(check, 0), /data-bank-add-check=/);

  context.erpAuthentication.user.role = "owner";
  assert.match(context.bankReconciliationActionCell(unmatched, 0), /data-bank-add-client=/);
  assert.match(context.bankReconciliationActionCell(check, 0), /data-bank-add-check=/);
});

function authHarness(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "erp-auth-test-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const usersFile = path.join(directory, "users.json");
  const auditEvents = [];
  const auth = createAuthService({
    store: createSecurityStore({ usersFile }),
    readJsonBody: async (request) => request.body || {},
    sendJson: (response, status, payload) => {
      response.statusCode = status;
      response.payload = payload;
      return payload;
    },
    auditSecurityEvent: (event) => auditEvents.push(event)
  });
  return {
    auth,
    usersFile,
    auditEvents,
    async login(username, password) {
      const response = responseCapture();
      await auth.handleLogin({ body: { username, password }, headers: {}, socket: { remoteAddress: "127.0.0.1" } }, response);
      return { cookie: String(response.headers["Set-Cookie"]).split(";")[0], payload: response.payload };
    }
  };
}

function requestFor(method, url) {
  return { method, url, headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } };
}

function responseCapture() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status) { this.statusCode = status; },
    end() {}
  };
}

class TestResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.endCalls = 0;
  }
  setHeader(name, value) { this.headers[name] = value; }
  writeHead(status) { this.statusCode = status; }
  end(body) { this.endCalls += 1; this.body = body; this.emit("finish"); }
}
