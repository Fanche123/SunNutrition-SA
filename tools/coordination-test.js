'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const {
  atomicWriteJson,
  pathExists,
  readJsonLimited,
  sha256File,
} = require('./coordination/atomic-fs');
const { validateConfig } = require('./coordination/config');
const {
  DOMAINS,
  getCoordinationPaths,
  getRepoRoot,
} = require('./coordination/constants');
const { buildCoordinatorContext } = require('./coordination/context-builder');
const { CoordinationError } = require('./coordination/errors');
const { acquireLock } = require('./coordination/lock');
const { notifyPending } = require('./coordination/notification');
const {
  OpenAIResponsesClient,
  normalizeSchemaForStructuredOutputs,
} = require('./coordination/openai-client');
const { ProtocolActions } = require('./coordination/protocol-actions');
const { calculateBackoff, retryWithBackoff } = require('./coordination/retry');
const { assertSchema, loadSchema } = require('./coordination/schema-validator');
const { StateStore } = require('./coordination/state-store');
const { getCoordinationStatus } = require('./coordination/status-service');
const { CoordinationWatcher } = require('./coordination/watcher-core');
const { createWatcher, main: watcherMain } = require('./coordination-watcher');

let handoffSchema;
let outputSchema;
const temporaryRoots = new Set();

before(async () => {
  const paths = getCoordinationPaths(getRepoRoot());
  [handoffSchema, outputSchema] = await Promise.all([
    loadSchema(paths.handoffSchema),
    loadSchema(paths.coordinatorOutputSchema),
  ]);
});

after(async () => {
  const tempRoot = path.resolve(os.tmpdir());
  for (const root of temporaryRoots) {
    const resolved = path.resolve(root);
    assert.equal(path.relative(tempRoot, resolved).startsWith('..'), false);
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

function makeHandoff(taskId, overrides = {}) {
  return {
    version: '1.0',
    taskId,
    parentTaskId: null,
    domain: 'compras',
    sourceChat: 'test-chat',
    createdAt: new Date().toISOString(),
    status: 'completed',
    objective: 'Validar el flujo de coordinación.',
    summary: 'Entrega sintética sin datos reales.',
    changes: ['Cambio sintético'],
    filesCreated: ['tools/example.js'],
    filesModified: [],
    validationsExecuted: ['Prueba sintética'],
    validationsPending: [],
    risks: [],
    decisionsRequired: [],
    dataModified: {
      modified: false,
      description: 'No se modificaron datos.',
    },
    suggestedCommit: 'test: coordinación sintética',
    gitStatus: ['M tools/example.js'],
    diffSummary: ['1 archivo modificado'],
    ...overrides,
  };
}

function makeOutput(handoff, sourceHash, overrides = {}) {
  return {
    taskId: handoff.taskId,
    targetDomain: handoff.domain,
    verdict: 'continue',
    summaryForUser: 'La entrega puede continuar.',
    promptForSpecialist: 'Continuar únicamente con la tarea aprobada.',
    commitMessage: 'test: continuar coordinación',
    approvalRequired: true,
    risks: [],
    blockingQuestions: [],
    sourceHash,
    ...overrides,
  };
}

async function createEnvironment(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-coordination-test-'));
  temporaryRoots.add(root);
  const paths = getCoordinationPaths(root);
  await fs.mkdir(paths.root, { recursive: true });
  await Promise.all([
    fs.writeFile(paths.handoffSchema, `${JSON.stringify(handoffSchema, null, 2)}\n`),
    fs.writeFile(paths.coordinatorOutputSchema, `${JSON.stringify(outputSchema, null, 2)}\n`),
  ]);
  const config = validateConfig({
    stableFileMs: 0,
    debounceMs: 25,
    scanIntervalMs: 250,
    retries: 0,
    initialBackoffMs: 10,
    maxBackoffMs: 10,
    ...options.config,
  }, 'config de test');
  const calls = { count: 0 };
  const coordinator = options.coordinator || {
    async coordinate(handoff, sourceHash) {
      calls.count += 1;
      return makeOutput(handoff, sourceHash, options.outputOverrides || {});
    },
  };
  const logs = [];
  const stateStore = new StateStore({
    repoRoot: root,
    lockWaitMs: config.stateLockWaitMs,
    lockStaleMs: config.lockStaleMs,
  });
  const watcher = new CoordinationWatcher({
    repoRoot: root,
    config,
    handoffSchema,
    outputSchema,
    coordinator,
    stateStore,
    logger: {
      info(value) { logs.push(String(value)); },
      error(value) { logs.push(JSON.stringify(value)); },
    },
    sleep: options.sleep,
    random: () => 0.5,
    notificationStream: { write() {} },
    atomicWriteJson: options.atomicWriteJson,
  });
  await watcher.initialize();
  const actions = new ProtocolActions({
    repoRoot: root,
    config,
    handoffSchema,
    outputSchema,
    stateStore,
  });
  return { root, paths, config, calls, coordinator, logs, stateStore, watcher, actions };
}

async function enqueueAndScan(environment, handoff) {
  await environment.actions.enqueue(handoff);
  await environment.watcher.scan({ waitForStable: true });
}

async function pendingFor(environment, domain, taskId) {
  const candidate = path.join(environment.paths.pending, domain, `${taskId}.json`);
  assert.equal(await pathExists(candidate), true);
  return candidate;
}

test('01. procesa un nuevo archivo en inbox', async () => {
  const environment = await createEnvironment();
  const handoff = makeHandoff('test-new-inbox');
  await enqueueAndScan(environment, handoff);
  assert.equal(environment.calls.count, 1);
  assert.equal(await pathExists(path.join(environment.paths.inbox, `${handoff.taskId}.json`)), false);
  assert.equal(await pathExists(await pendingFor(environment, 'compras', handoff.taskId)), true);
});

test('02. no procesa un archivo parcialmente escrito', async () => {
  const environment = await createEnvironment({ config: { stableFileMs: 1_000 } });
  const candidate = path.join(environment.paths.inbox, 'test-partial.json');
  await fs.writeFile(candidate, '{"version":');
  await environment.watcher.scan();
  assert.equal(await pathExists(candidate), true);
  await fs.writeFile(candidate, `${JSON.stringify(makeHandoff('test-partial'), null, 2)}\n`);
  const old = new Date(Date.now() - 2_000);
  await fs.utimes(candidate, old, old);
  await environment.watcher.scan();
  assert.equal(await pathExists(candidate), false);
  await pendingFor(environment, 'compras', 'test-partial');
});

test('03. ignora un archivo duplicado', async () => {
  const environment = await createEnvironment();
  const handoff = makeHandoff('test-duplicate');
  await enqueueAndScan(environment, handoff);
  await environment.actions.enqueue(handoff);
  await environment.watcher.scan({ waitForStable: true });
  assert.equal(environment.calls.count, 1);
  const state = await environment.stateStore.load();
  assert.equal(state.processedFiles['test-duplicate.json'].status, 'duplicate');
});

test('04. conserva deduplicación por hash después de reiniciar', async () => {
  const environment = await createEnvironment();
  const handoff = makeHandoff('test-hash-restart');
  await enqueueAndScan(environment, handoff);
  const restarted = new CoordinationWatcher({
    repoRoot: environment.root,
    config: environment.config,
    handoffSchema,
    outputSchema,
    coordinator: environment.coordinator,
    logger: { info() {}, error() {} },
  });
  await restarted.initialize();
  await environment.actions.enqueue(handoff);
  await restarted.scan({ waitForStable: true });
  assert.equal(environment.calls.count, 1);
});

test('05. acepta y valida una respuesta correcta del coordinador', async () => {
  const environment = await createEnvironment();
  const handoff = makeHandoff('test-valid-output');
  await enqueueAndScan(environment, handoff);
  const output = await readJsonLimited(
    await pendingFor(environment, 'compras', handoff.taskId),
    environment.config.maxResponseBytes,
  );
  assert.doesNotThrow(() => assertSchema(output, outputSchema, 'output'));
  assert.equal(output.approvalRequired, true);
});

test('06. rechaza una respuesta inválida del coordinador', async () => {
  const environment = await createEnvironment({
    coordinator: {
      async coordinate() {
        return { taskId: 'incompleto' };
      },
    },
  });
  await enqueueAndScan(environment, makeHandoff('test-invalid-output'));
  const state = await environment.stateStore.load();
  assert.equal(state.processedFiles['test-invalid-output.json'].status, 'failed');
  assert.equal(await pathExists(path.join(environment.paths.pending, 'compras', 'test-invalid-output.json')), false);
});

test('07. registra una API no disponible sin ejecutar nada', async () => {
  const environment = await createEnvironment({
    coordinator: {
      async coordinate() {
        throw new CoordinationError('API temporalmente no disponible.', {
          code: 'OPENAI_UNAVAILABLE',
          temporary: true,
        });
      },
    },
  });
  await enqueueAndScan(environment, makeHandoff('test-api-unavailable'));
  const state = await environment.stateStore.load();
  assert.equal(state.processedFiles['test-api-unavailable.json'].status, 'failed');
  assert.equal(Object.keys(state.approvals).length, 0);
});

test('08. reintenta solamente errores temporales', async () => {
  let attempts = 0;
  const environment = await createEnvironment({
    config: { retries: 2 },
    sleep: async () => {},
    coordinator: {
      async coordinate(handoff, sourceHash) {
        attempts += 1;
        if (attempts === 1) {
          throw new CoordinationError('Temporal.', {
            code: 'OPENAI_HTTP_503',
            temporary: true,
          });
        }
        return makeOutput(handoff, sourceHash);
      },
    },
  });
  await enqueueAndScan(environment, makeHandoff('test-retry'));
  assert.equal(attempts, 2);
  await pendingFor(environment, 'compras', 'test-retry');
});

test('09. aplica backoff exponencial acotado', async () => {
  assert.equal(calculateBackoff(1, { initialMs: 100, maximumMs: 1_000, jitterRatio: 0 }), 100);
  assert.equal(calculateBackoff(2, { initialMs: 100, maximumMs: 1_000, jitterRatio: 0 }), 200);
  assert.equal(calculateBackoff(9, { initialMs: 100, maximumMs: 1_000, jitterRatio: 0 }), 1_000);
  const waits = [];
  let attempt = 0;
  const result = await retryWithBackoff(async () => {
    attempt += 1;
    if (attempt < 3) {
      throw new CoordinationError('Temporal.', { temporary: true });
    }
    return 'ok';
  }, {
    retries: 2,
    initialMs: 100,
    maximumMs: 1_000,
    jitterRatio: 0,
    sleep: async (milliseconds) => waits.push(milliseconds),
  });
  assert.equal(result, 'ok');
  assert.deepEqual(waits, [100, 200]);
});

test('10. impide dos locks simultáneos', async () => {
  const environment = await createEnvironment();
  const lockPath = path.join(environment.paths.runtime, 'test.lock');
  const first = await acquireLock(lockPath, { staleMs: 60_000 });
  await assert.rejects(
    () => acquireLock(lockPath, { staleMs: 60_000 }),
    (error) => error.code === 'LOCK_HELD',
  );
  await first.release();
  const second = await acquireLock(lockPath, { staleMs: 60_000 });
  await second.release();
});

test('11. crea pending de forma atómica y sin temporales residuales', async () => {
  const environment = await createEnvironment();
  await enqueueAndScan(environment, makeHandoff('test-pending-atomic'));
  const directory = path.join(environment.paths.pending, 'compras');
  const names = await fs.readdir(directory);
  assert.deepEqual(names, ['test-pending-atomic.json']);
  assert.equal(names.some((name) => name.endsWith('.tmp')), false);
});

test('12. aprobar exige el hash mostrado y nunca ejecuta el prompt', async () => {
  const environment = await createEnvironment();
  await enqueueAndScan(environment, makeHandoff('test-approval'));
  let review = await environment.actions.review('compras');
  await assert.rejects(
    () => environment.actions.approve('compras', 'usuario'),
    (error) => error.code === 'SHOWN_HASH_REQUIRED',
  );
  const pending = await pendingFor(environment, 'compras', 'test-approval');
  await fs.appendFile(pending, ' ');
  await assert.rejects(
    () => environment.actions.approve('compras', 'usuario', review.shownHash),
    (error) => error.code === 'PENDING_HASH_CHANGED',
  );
  review = await environment.actions.review('compras');
  const approval = await environment.actions.approve('compras', 'usuario', review.shownHash);
  assert.equal(approval.executed, false);
  assert.equal(approval.terminal, false);
  assert.equal(await pathExists(path.join(environment.paths.approved, 'test-approval.json')), true);
  const beginning = await environment.actions.begin('compras', review.shownHash);
  assert.equal(beginning.executed, false);
  assert.equal(
    (await environment.stateStore.load()).pendingByDomain.compras.status,
    'executing',
  );
  const status = await getCoordinationStatus(environment.root);
  assert.equal(status.totals.executing, 1);
  assert.equal(status.totals.approvedAwaitingChat, 0);
});

test('13. rechazar registra motivo, mueve el archivo y no ejecuta', async () => {
  const environment = await createEnvironment();
  await enqueueAndScan(environment, makeHandoff('test-rejection'));
  const review = await environment.actions.review('compras');
  const rejection = await environment.actions.reject(
    'compras',
    'Falta una prueba.',
    review.shownHash,
  );
  assert.equal(rejection.executed, false);
  assert.equal(await pathExists(path.join(environment.paths.rejected, 'test-rejection.json')), true);
  const state = await environment.stateStore.load();
  assert.equal(state.pendingByDomain.compras, undefined);
  assert.equal(state.approvals['test-rejection'].status, 'rejected');
});

test('14. modificar reemplaza el prompt y exige una aprobación nueva', async () => {
  const environment = await createEnvironment();
  await enqueueAndScan(environment, makeHandoff('test-modification'));
  const review = await environment.actions.review('compras');
  const oldHash = await sha256File(
    await pendingFor(environment, 'compras', 'test-modification'),
    environment.config.maxResponseBytes,
  );
  const modified = await environment.actions.modify(
    'compras',
    'Agregar la validación localizada.',
    review.shownHash,
  );
  assert.match(modified.promptForSpecialist, /Agregar la validación localizada/);
  assert.equal(modified.revision, 2);
  const newHash = await sha256File(
    await pendingFor(environment, 'compras', 'test-modification'),
    environment.config.maxResponseBytes,
  );
  assert.notEqual(newHash, oldHash);
  assert.equal(
    await pathExists(path.join(environment.paths.rejected, 'test-modification.replaced-r1.json')),
    true,
  );
});

test('15. un chat no puede revisar un pending de otro dominio', async () => {
  const environment = await createEnvironment({
    outputOverrides: { targetDomain: 'ventas' },
  });
  await enqueueAndScan(environment, makeHandoff('test-wrong-domain'));
  await assert.rejects(
    () => environment.actions.review('compras'),
    (error) => error.code === 'NO_ACTIVE_PENDING',
  );
  const view = await environment.actions.review('ventas');
  assert.equal(view.domain, 'ventas');
});

test('16. dos tareas simultáneas para un dominio dejan una sola activa', async () => {
  const environment = await createEnvironment({
    coordinator: {
      async coordinate(handoff, sourceHash) {
        return makeOutput(handoff, sourceHash, { targetDomain: 'compras' });
      },
    },
  });
  await environment.actions.enqueue(makeHandoff('test-concurrent-a'));
  await environment.actions.enqueue(makeHandoff('test-concurrent-b', { domain: 'ventas' }));
  await environment.watcher.scan({ waitForStable: true });
  const state = await environment.stateStore.load();
  assert.equal(state.pendingByDomain.compras.taskId, 'test-concurrent-a');
  assert.equal(state.queuedByDomain.compras.length, 1);
  assert.equal(state.queuedByDomain.compras[0].taskId, 'test-concurrent-b');
});

test('17. reiniciar recupera archivos que quedaron en processing', async () => {
  const environment = await createEnvironment();
  const handoff = makeHandoff('test-processing-restart');
  await atomicWriteJson(
    path.join(environment.paths.processing, `${handoff.taskId}.json`),
    handoff,
    { root: environment.paths.root, overwrite: false },
  );
  const restarted = new CoordinationWatcher({
    repoRoot: environment.root,
    config: environment.config,
    handoffSchema,
    outputSchema,
    coordinator: environment.coordinator,
    logger: { info() {}, error() {} },
  });
  await restarted.initialize();
  await restarted.scan();
  await pendingFor(environment, 'compras', handoff.taskId);
});

test('18. sin OPENAI_API_KEY --once falla antes de mover inbox', async () => {
  const environment = await createEnvironment();
  const handoff = makeHandoff('test-missing-key');
  await environment.actions.enqueue(handoff);
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.COORDINATOR_MODEL;
  delete process.env.OPENAI_API_KEY;
  process.env.COORDINATOR_MODEL = 'test-model';
  try {
    await assert.rejects(
      () => createWatcher({ repoRoot: environment.root, config: environment.config }),
      (error) => error.code === 'MISSING_API_KEY',
    );
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.COORDINATOR_MODEL;
    else process.env.COORDINATOR_MODEL = previousModel;
  }
  assert.equal(
    await pathExists(path.join(environment.paths.inbox, `${handoff.taskId}.json`)),
    true,
  );
});

test('19. informa claramente la ausencia de COORDINATOR_MODEL', () => {
  const client = new OpenAIResponsesClient({
    apiKey: 'clave-solo-para-test',
    model: '',
    fetchImpl: async () => {
      throw new Error('No debe llamarse');
    },
  });
  assert.throws(
    () => client.assertConfigured(),
    (error) => error.code === 'MISSING_MODEL',
  );
});

test('20. no expone secretos en estado, logs ni llamada al coordinador', async () => {
  let coordinatorCalled = false;
  const environment = await createEnvironment({
    coordinator: {
      async coordinate() {
        coordinatorCalled = true;
        throw new Error('No debe llamarse');
      },
    },
  });
  const secret = 'sk-test-secret-123456789';
  const handoff = makeHandoff('test-secret', { objective: `Filtración ${secret}` });
  let caught;
  try {
    await environment.actions.enqueue(handoff);
  } catch (error) {
    caught = error;
  }
  assert.equal(caught.code, 'SENSITIVE_CONTENT');
  assert.equal(caught.message.includes(secret), false);
  assert.equal(coordinatorCalled, false);
  assert.equal(JSON.stringify(await environment.stateStore.load()).includes(secret), false);
  assert.equal(environment.logs.join('\n').includes(secret), false);
});

test('21. no permite aprobar mientras haya preguntas bloqueantes', async () => {
  const environment = await createEnvironment({
    outputOverrides: { blockingQuestions: ['¿Qué criterio funcional corresponde?'] },
  });
  await enqueueAndScan(environment, makeHandoff('test-blocking-question'));
  const review = await environment.actions.review('compras');
  await assert.rejects(
    () => environment.actions.approve('compras', 'usuario', review.shownHash),
    (error) => error.code === 'BLOCKING_QUESTIONS_UNRESOLVED',
  );
  assert.equal((await getCoordinationStatus(environment.root)).totals.blocked, 1);
  const modified = await environment.actions.modify(
    'compras',
    'Usar el criterio funcional confirmado por el usuario.',
    review.shownHash,
  );
  assert.deepEqual(modified.blockingQuestions, []);
  assert.equal((await getCoordinationStatus(environment.root)).totals.blocked, 0);
  const approval = await environment.actions.approve(
    'compras',
    'usuario',
    modified.shownHash,
  );
  assert.equal(approval.executed, false);
});

test('22. aprobar verdict close libera el dominio sin crear un loop', async () => {
  const environment = await createEnvironment({
    outputOverrides: {
      verdict: 'close',
      promptForSpecialist: 'Cerrar la tarea sin generar otra instrucción.',
    },
  });
  await enqueueAndScan(environment, makeHandoff('test-terminal-close'));
  const review = await environment.actions.review('compras');
  const result = await environment.actions.approve('compras', 'usuario', review.shownHash);
  assert.equal(result.terminal, true);
  assert.equal(result.promptForSpecialist, null);
  assert.equal(result.executed, false);
  const state = await environment.stateStore.load();
  assert.equal(state.pendingByDomain.compras, undefined);
  assert.equal(state.approvals['test-terminal-close'].status, 'closed');
});

test('23. status es estrictamente de solo lectura', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-coordination-status-test-'));
  temporaryRoots.add(root);
  const coordinationRoot = path.join(root, '.coordination');
  assert.equal(await pathExists(coordinationRoot), false);
  const status = await getCoordinationStatus(root);
  assert.equal(status.totals.pending, 0);
  assert.equal(await pathExists(coordinationRoot), false);
});

test('24. modify revierte archivos si falla la actualización de estado', async () => {
  const environment = await createEnvironment();
  await enqueueAndScan(environment, makeHandoff('test-modify-rollback'));
  const review = await environment.actions.review('compras');
  const candidate = await pendingFor(environment, 'compras', 'test-modify-rollback');
  const original = await fs.readFile(candidate, 'utf8');
  const originalMutate = environment.stateStore.mutate.bind(environment.stateStore);
  environment.stateStore.mutate = async () => {
    throw new CoordinationError('Falla de estado sintética.', { code: 'TEST_STATE_FAILURE' });
  };
  await assert.rejects(
    () => environment.actions.modify(
      'compras',
      'Cambio que debe revertirse.',
      review.shownHash,
    ),
    (error) => error.code === 'TEST_STATE_FAILURE',
  );
  environment.stateStore.mutate = originalMutate;
  assert.equal(await fs.readFile(candidate, 'utf8'), original);
});

test('25. start y stop procesan por evento o escaneo de respaldo', async () => {
  const environment = await createEnvironment();
  await environment.watcher.start();
  try {
    await environment.actions.enqueue(makeHandoff('test-live-watcher'));
    const candidate = path.join(
      environment.paths.pending,
      'compras',
      'test-live-watcher.json',
    );
    const deadline = Date.now() + 3_000;
    while (!await pathExists(candidate) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(await pathExists(candidate), true);
  } finally {
    await environment.watcher.stop();
  }
  assert.equal(environment.watcher.fsWatcher, null);
});

test('26. placeResult revierte la reserva si falla la escritura atómica', async () => {
  const environment = await createEnvironment({
    atomicWriteJson: async () => {
      throw new CoordinationError('Falla de escritura sintética.', {
        code: 'TEST_ATOMIC_WRITE_FAILURE',
      });
    },
  });
  await enqueueAndScan(environment, makeHandoff('test-placement-rollback'));
  const state = await environment.stateStore.load();
  assert.equal(state.pendingByDomain.compras, undefined);
  assert.deepEqual(state.queuedByDomain.compras || [], []);
  assert.equal(state.processedFiles['test-placement-rollback.json'].status, 'failed');
});

test('27. cliente Responses usa structured output compatible y extrae output_text', async () => {
  let captured;
  const expected = makeOutput(
    makeHandoff('test-responses-client'),
    'a'.repeat(64),
  );
  const client = new OpenAIResponsesClient({
    apiKey: 'clave-solo-para-test',
    model: 'modelo-solo-para-test',
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      const payload = {
        status: 'completed',
        output: [{
          type: 'message',
          content: [{
            type: 'output_text',
            text: JSON.stringify(expected),
          }],
        }],
      };
      const buffer = Buffer.from(JSON.stringify(payload));
      return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        async arrayBuffer() {
          return buffer;
        },
      };
    },
  });
  const result = await client.createStructuredResponse({
    instructions: 'Revisar.',
    input: 'Contexto sintético.',
    schema: outputSchema,
  });
  assert.deepEqual(result, expected);
  assert.equal(captured.url, 'https://api.openai.com/v1/responses');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.body.text.format.type, 'json_schema');
  assert.equal(captured.body.text.format.strict, true);
  assert.equal(captured.body.store, false);
  const apiSchemaText = JSON.stringify(captured.body.text.format.schema);
  assert.equal(apiSchemaText.includes('"oneOf"'), false);
  assert.equal(apiSchemaText.includes('"uniqueItems"'), false);
  assert.equal(apiSchemaText.includes('"const"'), false);
  assert.equal(captured.body.text.format.schema.properties.approvalRequired.type, 'boolean');
  assert.deepEqual(captured.body.text.format.schema.properties.approvalRequired.enum, [true]);
  const normalized = normalizeSchemaForStructuredOutputs(outputSchema);
  assert.deepEqual(captured.body.text.format.schema, normalized);
});

test('28. coordinator:once libera el lock incluso al ejecutarse dos veces', async () => {
  const environment = await createEnvironment();
  await watcherMain(['--once'], {
    repoRoot: environment.root,
    config: environment.config,
    watcher: environment.watcher,
  });
  assert.equal(await pathExists(environment.paths.watcherLock), false);
  await watcherMain(['--once'], {
    repoRoot: environment.root,
    config: environment.config,
    watcher: environment.watcher,
  });
  assert.equal(await pathExists(environment.paths.watcherLock), false);
});

test('29. detecta repetición exacta de prompt en la cadena A-B-A', async () => {
  const prompts = {
    'test-loop-a': 'Ejecutar el paso A.',
    'test-loop-b': 'Ejecutar el paso B.',
    'test-loop-c': 'Ejecutar el paso A.',
  };
  const environment = await createEnvironment({
    coordinator: {
      async coordinate(handoff, sourceHash) {
        return makeOutput(handoff, sourceHash, {
          promptForSpecialist: prompts[handoff.taskId],
        });
      },
    },
  });

  await enqueueAndScan(environment, makeHandoff('test-loop-a'));
  const reviewA = await environment.actions.review('compras');
  await environment.actions.approve('compras', 'usuario', reviewA.shownHash);

  await enqueueAndScan(environment, makeHandoff('test-loop-b', {
    parentTaskId: 'test-loop-a',
  }));
  const reviewB = await environment.actions.review('compras');
  await environment.actions.approve('compras', 'usuario', reviewB.shownHash);

  await enqueueAndScan(environment, makeHandoff('test-loop-c', {
    parentTaskId: 'test-loop-b',
  }));
  const state = await environment.stateStore.load();
  assert.equal(state.pendingByDomain.compras, undefined);
  assert.equal(state.processedFiles['test-loop-c.json'].status, 'failed');
  assert.equal(
    state.processedFiles['test-loop-c.json'].error.code,
    'COORDINATION_LOOP_DETECTED',
  );
});

test('30. bloquea datos personales y rutas externas antes de publicar', async () => {
  const environment = await createEnvironment();
  await assert.rejects(
    () => environment.actions.enqueue(makeHandoff('test-personal-data', {
      summary: 'Contacto: persona@example.com',
    })),
    (error) => error.code === 'PERSONAL_DATA_CONTENT',
  );
  await assert.rejects(
    () => environment.actions.enqueue(makeHandoff('test-external-path', {
      objective: 'Leer C:\\Users\\persona\\archivo.txt',
    })),
    (error) => error.code === 'PATH_OUTSIDE_ALLOWED_ROOT',
  );
  assert.deepEqual(await fs.readdir(environment.paths.inbox), []);
});

test('31. reserva contexto para AGENTS, handoff y resumen Git', async () => {
  const environment = await createEnvironment();
  await fs.mkdir(path.join(environment.root, '.agents'), { recursive: true });
  await fs.mkdir(path.join(environment.root, 'docs'), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(environment.root, 'AGENTS.md'), '# AGENTS sintético\n'),
    fs.writeFile(
      path.join(environment.root, '.agents', '_base-development.md'),
      '# Base sintética\n',
    ),
    fs.writeFile(
      path.join(environment.root, '.agents', 'coordinador.md'),
      '# Coordinador sintético\n',
    ),
    fs.writeFile(
      path.join(environment.root, '.agents', 'file-ownership.md'),
      '# Ownership sintético\n',
    ),
    fs.writeFile(
      path.join(environment.root, '.agents', 'compras.md'),
      '# Compras sintético\n',
    ),
    fs.writeFile(
      path.join(environment.root, 'docs', 'architecture.md'),
      '# Arquitectura sintética\n',
    ),
  ]);
  const config = validateConfig({
    maxTotalContextBytes: 32 * 1024,
    maxContextFileBytes: 8 * 1024,
    maxDiffBytes: 4 * 1024,
    maxHandoffBytes: 256 * 1024,
  }, 'config de presupuesto');
  const context = await buildCoordinatorContext({
    repoRoot: environment.root,
    handoff: makeHandoff('test-context-budget', {
      summary: 'Resumen largo '.repeat(800),
    }),
    config,
    execGit: async () => ({ stdout: ' M tools/example.js\n', stderr: '' }),
  });
  assert.equal(Buffer.byteLength(context, 'utf8') <= config.maxTotalContextBytes, true);
  for (const label of [
    'AGENTS.md',
    'BASE DE DESARROLLO',
    'AGENTE COORDINADOR',
    'AGENTE DEL DOMINIO compras',
    'OWNERSHIP',
    'ARQUITECTURA RELEVANTE',
    'HANDOFF VALIDADO',
    'ESTADO Y RESUMEN LIMITADO DE GIT',
  ]) {
    assert.match(context, new RegExp(`===== ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} =====`));
  }
});

test('32. una notificación local fallida no interrumpe el flujo', () => {
  assert.doesNotThrow(() => notifyPending({
    domain: 'compras',
    taskId: 'test-notification',
    summary: 'Resumen seguro.',
  }, {
    enabled: true,
    stream: {
      write() {
        throw new Error('Terminal sin aviso.');
      },
    },
    logger: {
      info() {
        throw new Error('Logger no disponible.');
      },
    },
  }));
});

test('33. soporta el dominio contabilidad en contratos, contexto y colas', async () => {
  assert.equal(DOMAINS.includes('contabilidad'), true);
  assert.deepEqual(handoffSchema.$defs.domain.enum, [...DOMAINS]);
  assert.deepEqual(outputSchema.$defs.domain.enum, [...DOMAINS]);

  const environment = await createEnvironment();
  const handoff = makeHandoff('test-accounting-domain', {
    domain: 'contabilidad',
  });
  await enqueueAndScan(environment, handoff);
  await pendingFor(environment, 'contabilidad', handoff.taskId);

  const context = await buildCoordinatorContext({
    repoRoot: getRepoRoot(),
    handoff,
    config: environment.config,
    execGit: async () => ({ stdout: '', stderr: '' }),
  });
  assert.match(context, /===== AGENTE DEL DOMINIO contabilidad =====/);
  assert.match(context, /AGENT de Contabilidad/);
});
