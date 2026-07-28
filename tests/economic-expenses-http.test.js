const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { EXPECTED_BACKEND_COLUMNS } = require("../backend/config/backend-columns");

const sourceRoot = path.resolve(__dirname, "..");
let isolatedRoot = "";
let serverProcess = null;
let baseUrl = "";
const observedStatuses = new Set();

async function main() {
  isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "erp-accounting-http-"));
  const projectRoot = path.join(isolatedRoot, "erp");
  copyProject(sourceRoot, projectRoot);
  seedCache(projectRoot);
  const portArgument = process.argv.find((value) => value.startsWith("--port="));
  const port = Number(portArgument?.split("=")[1]) || Number(process.env.ERP_HTTP_TEST_PORT) || await freePort();
  baseUrl = `http://127.0.0.1:${port}`;

  try {
    await startServer(projectRoot, port);
    if (process.argv.includes("--browser-server")) {
      console.log(JSON.stringify({ ready: true, port, isolatedRoot }));
      await new Promise((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
      return;
    }
    const officialBefore = await infrastructureChecks();
    const emptyDiagnostic = await request("GET", "/api/reports/income-statement/economic-comparison?year=2026&month=2");
    assert.equal(emptyDiagnostic.status, 200);
    assert.equal(emptyDiagnostic.body.economic.totalConfirmed, 0);

    const operations = await economicExpenseChecks();
    await applicationChecks(operations);
    await administrationChecks();
    await comparisonChecks(officialBefore);

    await stopServer();
    await startServer(projectRoot, port);
    await restartIdempotencyChecks(operations);

    const persisted = JSON.parse(fs.readFileSync(path.join(projectRoot, "tmp", "backend-data-cache.json"), "utf8"));
    assert.ok(persisted.tables.gastos_economicos.rows.length > 0);
    assert.ok(persisted.tables.gastos_egresos.rows.length > 0);
    console.log(JSON.stringify({
      ok: true,
      port,
      statuses: [...observedStatuses].sort((a, b) => a - b),
      expenseRows: persisted.tables.gastos_economicos.rows.length,
      applicationRows: persisted.tables.gastos_egresos.rows.length,
      isolatedRoot
    }));
  } finally {
    await stopServer();
    if (isolatedRoot && path.resolve(isolatedRoot).startsWith(path.resolve(os.tmpdir()))) {
      fs.rmSync(isolatedRoot, { recursive: true, force: true });
    }
  }
}

function copyProject(from, to) {
  fs.cpSync(from, to, {
    recursive: true,
    filter(source) {
      const relative = path.relative(from, source);
      if (!relative) return true;
      const first = relative.split(path.sep)[0];
      return ![".git", "tmp", "node_modules"].includes(first) && path.basename(source) !== ".env";
    }
  });
}

function seedCache(projectRoot) {
  const table = (headers, rows = []) => ({ headers, rows, rowCount: rows.length });
  const cache = {
    generatedAt: "",
    tables: {
      etiquetas: table(["id_etiqueta", "etiqueta"], [
        { id_etiqueta: "1", etiqueta: "Servicios" },
        { id_etiqueta: "2", etiqueta: "Intereses" }
      ]),
      egresos: table(EXPECTED_BACKEND_COLUMNS.egresos, [
        { id_egreso: "10", subtotal: 100, total: 121 },
        { id_egreso: "11", subtotal: 100, total: 100 },
        { id_egreso: "12", subtotal: 50, total: 50 },
        { id_egreso: "13", subtotal: 100.01, total: 100.01 }
      ]),
      gastos_economicos: table(EXPECTED_BACKEND_COLUMNS.gastos_economicos),
      gastos_egresos: table(EXPECTED_BACKEND_COLUMNS.gastos_egresos)
    },
    errors: []
  };
  fs.mkdirSync(path.join(projectRoot, "tmp"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "tmp", "backend-data-cache.json"), JSON.stringify(cache, null, 2));
}

async function infrastructureChecks() {
  assert.equal((await request("GET", "/api/health")).status, 200);
  const schema = await request("GET", "/api/backend/schema");
  const overview = await request("GET", "/api/backend/tables");
  const map = await request("GET", "/api/backend/map");
  for (const name of ["gastos_economicos", "gastos_egresos"]) {
    const definition = schema.body.schema.tables.find((row) => row.name === name);
    const summary = overview.body.tables.find((row) => row.name === name);
    const mapped = map.body.map.tables.find((row) => row.name === name);
    assert.ok(definition && summary && mapped);
    assert.equal(definition.primaryKey, EXPECTED_BACKEND_COLUMNS[name][0]);
    assert.deepStrictEqual(summary.headers, EXPECTED_BACKEND_COLUMNS[name]);
    assert.deepStrictEqual(mapped.expectedColumns, EXPECTED_BACKEND_COLUMNS[name]);
    assert.deepStrictEqual(mapped.actualColumns, EXPECTED_BACKEND_COLUMNS[name]);
  }
  const adminOverview = await request("GET", "/api/admin/tables");
  for (const name of ["gastos_economicos", "gastos_egresos"]) {
    const table = adminOverview.body.tables.find((row) => row.name === name);
    assert.deepStrictEqual(
      [table.capabilities.read, table.capabilities.insert, table.capabilities.update, table.capabilities.delete],
      [true, true, true, true]
    );
  }
  const official = await request("GET", "/api/reports/income-statement?year=2026&month=2&comparison=none");
  assert.equal(official.status, 200);
  assert.ok(official.body.report);
  return official.body;
}

async function economicExpenseChecks() {
  const discarded = await createDraft("discard", { origen_subclave: "discardable" });
  assert.equal((await request("POST", `/api/economic-expenses/${discarded.id}/discard`, {
    motivo: "Prueba de descarte",
    clave_idempotencia: "discard-op"
  })).status, 200);

  const main = await createDraft("main");
  let response = await request("GET", "/api/economic-expenses");
  assert.ok(response.body.rows.some((row) => String(row.id_gasto_economico) === String(main.id)));
  response = await request("GET", `/api/economic-expenses/${main.id}`);
  assert.equal(response.body.expense.concepto, "Gasto main");
  response = await request("POST", `/api/economic-expenses/${main.id}/draft`, {
    concepto: "Gasto principal editado",
    clave_idempotencia: "draft-edit-main"
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.expense.concepto, "Gasto principal editado");
  response = await request("POST", `/api/economic-expenses/${main.id}/confirm`, {
    clave_idempotencia: "confirm-main"
  });
  assert.equal(response.status, 200);
  assert.equal((await request("POST", `/api/economic-expenses/${main.id}/draft`, {
    concepto: "Bloqueado",
    clave_idempotencia: "blocked-edit"
  })).status, 409);
  assert.equal((await request("POST", `/api/economic-expenses/${main.id}/discard`, {
    motivo: "Bloqueado",
    clave_idempotencia: "blocked-discard"
  })).status, 409);

  for (const [suffix, amount] of [["positive", 10], ["negative", -5]]) {
    response = await request("POST", `/api/economic-expenses/${main.id}/adjustments`, expensePayload(`adjust-${suffix}`, {
      importe: amount,
      origen_subclave: `adjust-${suffix}`,
      motivo: `Ajuste ${suffix}`,
      clave_idempotencia: `adjust-${suffix}`
    }));
    assert.equal(response.status, 201);
  }
  response = await request("POST", `/api/economic-expenses/${main.id}/reversals`, expensePayload("reversal", {
    importe: -100,
    origen_subclave: "reversal-total",
    motivo: "Reversion total",
    clave_idempotencia: "reversal-total"
  }));
  assert.equal(response.status, 201);
  assert.equal(String(response.body.expense.id_gasto_precedente), String(main.id));

  for (const [name, override] of [
    ["missing-date", { fecha_economica: "" }],
    ["missing-tag", { id_etiqueta: "" }],
    ["missing-subkey", { origen_subclave: "" }]
  ]) {
    const draft = await createDraft(name, override);
    response = await request("POST", `/api/economic-expenses/${draft.id}/confirm`, {
      clave_idempotencia: `confirm-${name}`
    });
    assert.equal(response.status, 400);
  }

  const sameOriginA = await createAndConfirm("same-a", { origen_id: "shared", origen_subclave: "line-a", importe: 60 });
  const sameOriginB = await createAndConfirm("same-b", { origen_id: "shared", origen_subclave: "line-b", importe: 50 });
  const duplicate = await createDraft("duplicate", { origen_id: "shared", origen_subclave: "line-a", importe: 60 });
  assert.equal((await request("POST", `/api/economic-expenses/${duplicate.id}/confirm`, {
    clave_idempotencia: "confirm-duplicate"
  })).status, 409);

  const replayPayload = expensePayload("replay", { clave_idempotencia: "draft-replay" });
  response = await request("POST", "/api/economic-expenses/drafts", replayPayload);
  assert.equal(response.status, 201);
  const replayId = response.body.expense.id_gasto_economico;
  response = await request("POST", "/api/economic-expenses/drafts", replayPayload);
  assert.equal(response.status, 200);
  assert.equal(response.body.idempotent, true);
  assert.equal(String(response.body.expense.id_gasto_economico), String(replayId));
  assert.equal((await request("POST", "/api/economic-expenses/drafts", {
    ...replayPayload,
    concepto: "Payload distinto"
  })).status, 409);

  return { main, sameOriginA, sameOriginB, replayPayload, replayId };
}

async function applicationChecks(operations) {
  let response = await request("GET", "/api/economic-expenses/reconciliation/expenses/12");
  assert.equal(response.body.reconciliation.estado, "sin_aplicaciones");
  assert.equal(response.body.reconciliation.diferencia_documental, 50);

  const app1 = applicationPayload("app-main-1", operations.main.id, "10", 40);
  response = await request("POST", "/api/economic-expenses/applications", app1);
  assert.equal(response.status, 201);
  const app1Id = response.body.application.id_gasto_egreso;
  response = await request("GET", "/api/economic-expenses/reconciliation/expenses/10");
  assert.equal(response.body.reconciliation.estado, "parcial");
  assert.equal(response.body.reconciliation.importe_aplicado, 40);

  const app2 = applicationPayload("app-main-2", operations.main.id, "11", 60);
  assert.equal((await request("POST", "/api/economic-expenses/applications", app2)).status, 201);
  const otherExpenseApplication = applicationPayload("app-other-1", operations.sameOriginA.id, "10", 60);
  assert.equal((await request("POST", "/api/economic-expenses/applications", otherExpenseApplication)).status, 201);
  response = await request("GET", "/api/economic-expenses/reconciliation/expenses/10");
  assert.equal(response.body.reconciliation.estado, "conciliado");
  assert.equal(response.body.reconciliation.diferencia_documental, 0);

  assert.equal((await request("POST", "/api/economic-expenses/applications", applicationPayload(
    "overapply", operations.sameOriginB.id, "10", 50
  ))).status, 409);
  assert.equal((await request("POST", "/api/economic-expenses/applications", {
    ...applicationPayload("invalid-component", operations.sameOriginB.id, "12", 10),
    componente_egreso: "invalido"
  })).status, 400);
  assert.equal((await request("POST", "/api/economic-expenses/applications", {
    ...applicationPayload("other-missing", operations.sameOriginB.id, "12", 10),
    componente_egreso: "otro"
  })).status, 400);

  response = await request("POST", `/api/economic-expenses/applications/${app1Id}/replace`, {
    importe_aplicado: 40,
    motivo: "Sustitucion de prueba",
    clave_idempotencia: "replace-app-main-1"
  });
  assert.equal(response.status, 201);
  const replacementId = response.body.application.id_gasto_egreso;
  assert.equal((await request("POST", `/api/economic-expenses/applications/${app1Id}/replace`, {
    importe_aplicado: 39,
    motivo: "Segunda sustitucion",
    clave_idempotencia: "replace-twice"
  })).status, 409);
  assert.equal((await request("POST", `/api/economic-expenses/applications/${replacementId}/replace`, {
    importe_aplicado: 40,
    id_aplicacion_precedente: replacementId,
    motivo: "Ciclo",
    clave_idempotencia: "cycle-attempt"
  })).status, 409);
  response = await request("POST", `/api/economic-expenses/applications/${replacementId}/reverse`, {
    motivo: "Reversion de aplicacion",
    clave_idempotencia: "reverse-app-main-1"
  });
  assert.equal(response.status, 201);
  response = await request("GET", "/api/economic-expenses/reconciliation/expenses/10");
  assert.equal(response.body.reconciliation.importe_aplicado, 60);
  assert.equal(response.body.reconciliation.applications.length, 1);

  const toleranceExpense = await createAndConfirm("tolerance", { importe: 100, origen_subclave: "tolerance" });
  assert.equal((await request("POST", "/api/economic-expenses/applications", applicationPayload(
    "tolerance-app", toleranceExpense.id, "13", 100
  ))).status, 201);
  response = await request("GET", "/api/economic-expenses/reconciliation/expenses/13");
  assert.equal(response.body.reconciliation.estado, "conciliado");
  assert.ok(Math.abs(response.body.reconciliation.diferencia_documental - 0.01) < 0.0001);

  const replayApplication = applicationPayload("application-replay", operations.sameOriginB.id, "12", 20);
  response = await request("POST", "/api/economic-expenses/applications", replayApplication);
  assert.equal(response.status, 201);
  const replayApplicationId = response.body.application.id_gasto_egreso;
  response = await request("POST", "/api/economic-expenses/applications", replayApplication);
  assert.equal(response.status, 200);
  assert.equal(response.body.idempotent, true);
  assert.equal((await request("POST", "/api/economic-expenses/applications", {
    ...replayApplication,
    importe_aplicado: 21
  })).status, 409);
  operations.replayApplication = replayApplication;
  operations.replayApplicationId = replayApplicationId;
}

async function administrationChecks() {
  for (const name of ["gastos_economicos", "gastos_egresos"]) {
    const read = await request("GET", `/api/admin/tables/${name}?all=true`);
    assert.equal(read.status, 200);
    assert.deepStrictEqual(
      [read.body.table.capabilities.read, read.body.table.capabilities.insert, read.body.table.capabilities.update, read.body.table.capabilities.delete],
      [true, true, true, true]
    );
    assert.equal((await request("POST", `/api/admin/tables/${name}`, { rows: [{ columna_desconocida: true }] })).status, 400);
    assert.equal((await request("POST", `/api/admin/tables/${name}`, {
      rows: [{ [EXPECTED_BACKEND_COLUMNS[name][0]]: "inexistente" }]
    })).status, 400);
    const deletion = await request("POST", `/api/admin/tables/${name}`, { deletedIds: ["inexistente"] });
    assert.equal(deletion.status, 400);
    assert.equal(deletion.body.code, "ADMIN_PRIMARY_KEY_INVALID");
  }
}

async function comparisonChecks(officialBefore) {
  const diagnostic = await request("GET", "/api/reports/income-statement/economic-comparison?year=2026&month=2");
  assert.equal(diagnostic.status, 200);
  assert.equal(diagnostic.body.diagnostic, true);
  assert.ok(diagnostic.body.economic.totalConfirmed);
  assert.ok(Object.hasOwn(diagnostic.body.economic.totalsByPeriod, "2026-03"));
  assert.ok(Object.hasOwn(diagnostic.body.economic.totalsByTag, "1"));
  assert.ok(Array.isArray(diagnostic.body.economic.drafts));
  assert.ok(Array.isArray(diagnostic.body.economic.confirmedWithoutApplications));
  assert.ok(Array.isArray(diagnostic.body.economic.potentialDuplicates));
  assert.ok(Array.isArray(diagnostic.body.sourcesNotIntegrated));
  const officialAfter = await request("GET", "/api/reports/income-statement?year=2026&month=2&comparison=none");
  const expectedOfficial = structuredClone(officialBefore);
  expectedOfficial.report.operatingExpenses.services = 215;
  expectedOfficial.report.totalOperatingExpenses = 215;
  expectedOfficial.report.operatingResult = -215;
  expectedOfficial.report.netResult = -215;
  assert.deepStrictEqual(officialAfter.body, expectedOfficial);
}

async function restartIdempotencyChecks(operations) {
  let response = await request("POST", "/api/economic-expenses/drafts", operations.replayPayload);
  assert.equal(response.status, 200);
  assert.equal(response.body.idempotent, true);
  assert.equal(String(response.body.expense.id_gasto_economico), String(operations.replayId));
  assert.equal((await request("POST", "/api/economic-expenses/drafts", {
    ...operations.replayPayload,
    concepto: "Conflicto posterior al reinicio"
  })).status, 409);

  response = await request("POST", "/api/economic-expenses/applications", operations.replayApplication);
  assert.equal(response.status, 200);
  assert.equal(response.body.idempotent, true);
  assert.equal(String(response.body.application.id_gasto_egreso), String(operations.replayApplicationId));
  assert.equal((await request("POST", "/api/economic-expenses/applications", {
    ...operations.replayApplication,
    importe_aplicado: 22
  })).status, 409);
}

async function createDraft(name, overrides = {}) {
  const response = await request("POST", "/api/economic-expenses/drafts", expensePayload(name, overrides));
  assert.equal(response.status, 201);
  return { id: response.body.expense.id_gasto_economico, payload: response.body.expense };
}

async function createAndConfirm(name, overrides = {}) {
  const draft = await createDraft(name, overrides);
  const response = await request("POST", `/api/economic-expenses/${draft.id}/confirm`, {
    clave_idempotencia: `confirm-${name}`
  });
  assert.equal(response.status, 200);
  return { id: response.body.expense.id_gasto_economico, payload: response.body.expense };
}

function expensePayload(name, overrides = {}) {
  return {
    fecha_economica: "2026-03-15",
    id_etiqueta: "1",
    concepto: `Gasto ${name}`,
    tipo_economico: "operativo",
    tipo_movimiento: "original",
    importe: 100,
    origen_tipo: "fixture_http",
    origen_id: name,
    origen_subclave: "principal",
    clave_idempotencia: `draft-${name}`,
    ...overrides
  };
}

function applicationPayload(key, economicId, expenseId, amount) {
  return {
    id_gasto_economico: economicId,
    id_egreso: expenseId,
    importe_aplicado: amount,
    componente_egreso: "base_subtotal",
    clave_idempotencia: key
  };
}

async function request(method, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  observedStatuses.add(response.status);
  return { status: response.status, body: parsed };
}

async function startServer(projectRoot, port) {
  serverProcess = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH || "",
      PORT: String(port),
      ERP_HOST: "127.0.0.1",
      ERP_DEPLOYMENT_MODE: "local",
      ERP_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
      PYTHON_EXECUTABLE: process.env.PYTHON_EXECUTABLE || ""
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  serverProcess.stdout.on("data", (chunk) => { stdout += chunk; });
  serverProcess.stderr.on("data", (chunk) => { stderr += chunk; });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (serverProcess.exitCode !== null) throw new Error(`Servidor aislado termino antes de iniciar: ${stdout}\n${stderr}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Servidor aislado no inicio: ${stdout}\n${stderr}`);
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) {
    serverProcess = null;
    cleanupIsolatedServerLock();
    return;
  }
  serverProcess.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => serverProcess.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (serverProcess.exitCode === null) serverProcess.kill("SIGKILL");
  serverProcess = null;
  cleanupIsolatedServerLock();
}

function cleanupIsolatedServerLock() {
  if (!isolatedRoot || !baseUrl) return;
  const projectRoot = path.resolve(isolatedRoot, "erp");
  const temporaryRoot = path.resolve(os.tmpdir());
  if (!projectRoot.startsWith(temporaryRoot)) {
    throw new Error("El lock de prueba quedo fuera del directorio temporal aislado.");
  }
  const port = new URL(baseUrl).port;
  fs.rmSync(path.join(projectRoot, "tmp", `erp-server-${port}.lock.json`), { force: true });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
