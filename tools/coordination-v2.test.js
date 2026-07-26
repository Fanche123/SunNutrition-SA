'use strict';

// Integración aislada del protocolo v2. Nunca usa la API ni el runtime real.

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const {
  pathExists,
  readJsonLimited,
} = require('./coordination/atomic-fs');
const { CoordinationAwaitService } = require('./coordination/await-service');
const { main: awaitCommand } = require('./coordination-await');
const { validateConfig } = require('./coordination/config');
const {
  getCoordinationPaths,
  getRepoRoot,
} = require('./coordination/constants');
const {
  CoordinatorService,
  getReviewOutcome,
} = require('./coordination/coordinator-service');
const { CoordinationError } = require('./coordination/errors');
const {
  createProposalToken,
  submissionFileName,
} = require('./coordination/identity');
const { ProtocolActions } = require('./coordination/protocol-actions');
const { loadSchema } = require('./coordination/schema-validator');
const { StateStore } = require('./coordination/state-store');
const { getCoordinationStatus } = require('./coordination/status-service');
const { TaskStore } = require('./coordination/task-store');
const { CoordinationWatcher } = require('./coordination/watcher-core');

const sourceRoot = getRepoRoot();
const temporaryRoots = new Set();
const schemas = {};
const VISUAL_AUDIT_FIXTURE = Object.freeze([
  {
    category: 'excessive_whitespace',
    status: 'absent',
    description: 'No se observan espacios vacíos injustificados en la captura analizada.',
    evidence: null,
    severity: null,
  },
  {
    category: 'weak_hierarchy',
    status: 'absent',
    description: 'La jerarquía visual de la pantalla resulta clara y diferenciada.',
    evidence: null,
    severity: null,
  },
  {
    category: 'low_contrast',
    status: 'absent',
    description: 'Los textos y controles mantienen un contraste visual perceptible.',
    evidence: null,
    severity: null,
  },
  {
    category: 'misalignment',
    status: 'absent',
    description: 'Los componentes visibles conservan una alineación regular y consistente.',
    evidence: null,
    severity: null,
  },
  {
    category: 'high_density',
    status: 'absent',
    description: 'La distribución visible no presenta una densidad excesiva de información.',
    evidence: null,
    severity: null,
  },
  {
    category: 'overflow_or_clipping',
    status: 'absent',
    description: 'No se identifican contenidos desbordados o recortados en la captura.',
    evidence: null,
    severity: null,
  },
  {
    category: 'inconsistent_actions',
    status: 'absent',
    description: 'Las acciones visibles utilizan un tratamiento visual coherente entre sí.',
    evidence: null,
    severity: null,
  },
  {
    category: 'readability',
    status: 'absent',
    description: 'El contenido textual visible conserva una legibilidad adecuada.',
    evidence: null,
    severity: null,
  },
  {
    category: 'responsive_layout',
    status: 'uncertain',
    description: 'La adaptación a otros anchos no puede determinarse con esta evidencia.',
    evidence: 'La evidencia contiene una única captura estática de un solo tamaño de viewport.',
    severity: null,
  },
  {
    category: 'accessibility_visual',
    status: 'uncertain',
    description: 'La accesibilidad visual completa no puede confirmarse solo con la captura.',
    evidence: 'La imagen no permite verificar foco, estados interactivos ni ayudas no visibles.',
    severity: null,
  },
]);

function categoryAuditForIssues(issues) {
  const issuesByCategory = new Map(
    issues.map((issue) => [issue.category, issue]),
  );
  return VISUAL_AUDIT_FIXTURE.map((entry) => {
    const issue = issuesByCategory.get(entry.category);
    return issue
      ? {
        category: issue.category,
        status: 'present',
        description: issue.description,
        evidence: issue.evidence,
        severity: issue.severity,
      }
      : { ...entry };
  });
}

before(async () => {
  const sourcePaths = getCoordinationPaths(sourceRoot);
  [
    ['handoff', sourcePaths.handoffSchema],
    ['output', sourcePaths.coordinatorOutputSchema],
    ['handoffV2', sourcePaths.handoffV2Schema],
    ['outputV2', sourcePaths.coordinatorOutputV2Schema],
  ].forEach(([key, candidate]) => {
    schemas[key] = candidate;
  });
  for (const [key, candidate] of Object.entries(schemas)) {
    schemas[key] = await loadSchema(candidate);
  }
});

after(async () => {
  const safeRoot = path.resolve(os.tmpdir());
  for (const root of temporaryRoots) {
    const resolved = path.resolve(root);
    assert.equal(path.relative(safeRoot, resolved).startsWith('..'), false);
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

async function assertRejectCode(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

function taskInput(taskId, domain = 'compras') {
  return {
    taskId,
    sourceChat: 'chat:coordinador',
    originalRequest: `Pedido sintético para ${domain}.`,
    objective: `Validar el ciclo de ${domain}.`,
    initialDomain: domain,
    initialPrompt: `TASK_ID=${taskId}\nRealizá solamente la tarea sintética.`,
    historySummary: '',
  };
}

function handoffV2(taskId, domain = 'compras', overrides = {}) {
  return {
    version: '2.0',
    submissionId: `${taskId}-r1-report`,
    taskId,
    revision: 1,
    previousRevision: null,
    domain,
    sourceChat: `chat:${domain}`,
    createdAt: new Date().toISOString(),
    status: 'completed',
    executionKind: 'initial',
    approvedProposalHash: null,
    approvedPrompt: null,
    objective: `Validar el ciclo de ${domain}.`,
    summary: 'Entrega sintética sin datos reales.',
    changes: ['Cambio sintético autorizado por el pedido inicial.'],
    filesCreated: [],
    filesModified: ['tools/example.js'],
    validationsExecuted: ['Prueba sintética correcta.'],
    validationsPending: [],
    risks: [],
    decisionsRequired: [],
    visualImpact: 'none',
    evidenceManifest: null,
    dataModified: {
      modified: false,
      description: 'No se modificaron datos persistentes.',
    },
    suggestedCommit: null,
    gitStatus: ['M tools/example.js'],
    diffSummary: ['Un archivo sintético modificado.'],
    ...overrides,
  };
}

function outputV2(handoff, sourceHash, overrides = {}) {
  const verdict = overrides.verdict || 'continue';
  const blocked = verdict === 'blocked';
  const closed = verdict === 'close';
  const blockingQuestions = overrides.blockingQuestions ||
    (blocked ? ['Falta una decisión sintética.'] : []);
  const executable =
    ['continue', 'fix_required'].includes(verdict) &&
    blockingQuestions.length === 0;
  return {
    version: '2.0',
    taskId: handoff.taskId,
    revision: handoff.revision,
    domain: handoff.domain,
    targetDomain: handoff.domain,
    verdict,
    summary: 'La revisión sintética fue completada.',
    findings: ['La identidad y las validaciones son coherentes.'],
    risks: [],
    blockingQuestions,
    visualReview: {
      status: 'not_applicable',
      performed: false,
      images: [],
      categoryAudit: [],
      crossImageFindings: [],
      confidence: 'not_applicable',
    },
    nextPrompt: executable
      ? 'Ejecutá la siguiente corrección sintética y volvé a validar.'
      : null,
    recommendedChanges: executable
      ? [{
        category: 'other',
        instruction: 'Aplicá la corrección sintética indicada y repetí la validación.',
        target: 'flujo sintético',
        expectedResult: 'El flujo queda corregido y validado sin alterar datos reales.',
      }]
      : [],
    userReviewInstructions: 'Revisá la aplicación antes de aprobar.',
    closeReason: closed ? 'La tarea sintética está completa.' : null,
    evidenceRequired: false,
    proposalHash: createProposalToken({
      taskId: handoff.taskId,
      revision: handoff.revision,
      sourceHash,
    }),
    sourceHash,
    approvalRequired: true,
    commitMessage: null,
    ...overrides,
  };
}

async function copyContracts(root) {
  const sourcePaths = getCoordinationPaths(sourceRoot);
  const targetPaths = getCoordinationPaths(root);
  await fs.mkdir(targetPaths.root, { recursive: true });
  const files = [
    'handoff.schema.json',
    'coordinator-output.schema.json',
    'handoff-v2.schema.json',
    'coordinator-output-v2.schema.json',
    'task.schema.json',
    'evidence-manifest.schema.json',
    'project-context.schema.json',
    'project-context.json',
  ];
  await Promise.all(files.map((name) =>
    fs.copyFile(
      path.join(sourcePaths.root, name),
      path.join(targetPaths.root, name),
    )));
}

async function createEnvironment(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-coordination-flow-v2-'));
  temporaryRoots.add(root);
  await copyContracts(root);
  const config = validateConfig({
    stableFileMs: 0,
    debounceMs: 25,
    scanIntervalMs: 250,
    retries: 0,
    initialBackoffMs: 10,
    maxBackoffMs: 10,
    awaitTimeoutMs: 1_000,
    awaitPollMs: 50,
    heartbeatIntervalMs: 250,
    heartbeatStaleMs: 2_000,
    ...options.config,
  }, 'config de integración v2');
  const stateStore = new StateStore({
    repoRoot: root,
    lockWaitMs: config.stateLockWaitMs,
    lockStaleMs: config.lockStaleMs,
  });
  const taskStore = new TaskStore({
    repoRoot: root,
    lockWaitMs: config.stateLockWaitMs,
    lockStaleMs: config.lockStaleMs,
  });
  const calls = [];
  const coordinator = options.coordinator ||
    (
      typeof options.coordinatorFactory === 'function'
        ? await options.coordinatorFactory({
          root,
          config,
          stateStore,
          taskStore,
        })
        : {
          async coordinate(handoff, sourceHash) {
            calls.push({ handoff, sourceHash });
            return outputV2(
              handoff,
              sourceHash,
              typeof options.output === 'function'
                ? options.output(handoff, sourceHash)
                : options.output,
            );
          },
        }
    );
  const watcher = new CoordinationWatcher({
    repoRoot: root,
    config,
    handoffSchema: schemas.handoff,
    outputSchema: schemas.output,
    handoffV2Schema: schemas.handoffV2,
    outputV2Schema: schemas.outputV2,
    coordinator,
    stateStore,
    taskStore,
    sleep: async () => {},
    random: () => 0.5,
    logger: { info() {}, error() {} },
    notificationStream: { write() {} },
  });
  const actions = new ProtocolActions({
    repoRoot: root,
    config,
    handoffSchema: schemas.handoff,
    outputSchema: schemas.output,
    handoffV2Schema: schemas.handoffV2,
    outputV2Schema: schemas.outputV2,
    stateStore,
    taskStore,
  });
  await actions.initialize();
  return {
    root,
    paths: getCoordinationPaths(root),
    config,
    stateStore,
    taskStore,
    watcher,
    actions,
    calls,
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function visualOutputForRepair(handoff, sourceHash) {
  const issue = {
    category: 'weak_hierarchy',
    severity: 'medium',
    description: 'Las acciones principales y secundarias compiten visualmente.',
    evidence: 'Los botones superiores muestran el mismo peso y tamaño visible.',
  };
  return outputV2(handoff, sourceHash, {
    verdict: 'fix_required',
    proposalHash: createProposalToken({
      taskId: handoff.taskId,
      revision: handoff.revision,
      sourceHash,
    }),
    visualReview: {
      status: 'reviewed',
      performed: true,
      images: [{
        filename: 'capture.png',
        observations: [
          'La captura sintética muestra un tablero ficticio con acciones visibles.',
          issue.evidence,
        ],
      }],
      categoryAudit: categoryAuditForIssues([issue]),
      crossImageFindings: [],
      confidence: 'high',
    },
    recommendedChanges: [{
      category: 'weak_hierarchy',
      instruction: 'Diferenciá la acción principal de los controles secundarios.',
      target: 'barra de acciones del tablero sintético',
      expectedResult: 'La prioridad de la acción principal resulta evidente.',
    }],
  });
}

function visualOutputForTwoEvidence(handoff, sourceHash) {
  const issue = {
    category: 'weak_hierarchy',
    severity: 'medium',
    description:
      'La jerarquía de acciones resulta débil en screen-a.png y screen-b.png.',
    evidence:
      'screen-a.png y screen-b.png muestran acciones primarias y secundarias con el mismo peso.',
  };
  return outputV2(handoff, sourceHash, {
    verdict: 'fix_required',
    visualReview: {
      status: 'reviewed',
      performed: true,
      images: [
        {
          filename: 'screen-a.png',
          observations: [
            'screen-a.png muestra la cabecera y la primera barra de acciones sintética.',
          ],
        },
        {
          filename: 'screen-b.png',
          observations: [
            'screen-b.png muestra la tabla y la segunda barra de acciones sintética.',
          ],
        },
      ],
      categoryAudit: categoryAuditForIssues([issue]),
      crossImageFindings: [
        'screen-a.png y screen-b.png repiten la misma jerarquía débil de acciones.',
      ],
      confidence: 'high',
    },
    recommendedChanges: [{
      category: 'weak_hierarchy',
      instruction: 'Diferenciá la acción primaria de los controles secundarios.',
      target: 'barras de acciones de las dos pantallas sintéticas',
      expectedResult: 'La prioridad de la acción principal resulta evidente.',
    }],
  });
}

async function createVisualRepairFixture(responseFactory) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-visual-repair-v2-'));
  temporaryRoots.add(root);
  await copyContracts(root);
  const taskId = `task-visual-repair-${temporaryRoots.size}`;
  const sourceHash = 'd'.repeat(64);
  const handoff = handoffV2(taskId, 'ui-ux', {
    submissionId: `${taskId}-r1-report`,
    visualImpact: 'material',
    evidenceManifest: `.coordination/evidence/${taskId}/manifest.json`,
  });
  const proposalHash = createProposalToken({
    taskId,
    revision: 1,
    sourceHash,
  });
  const taskStore = new TaskStore({ repoRoot: root });
  await taskStore.create(taskInput(taskId, 'ui-ux'));
  await taskStore.recordRevision(taskId, {
    revision: 1,
    submissionId: handoff.submissionId,
    domain: 'ui-ux',
    status: 'awaiting_review',
    handoffHash: sourceHash,
    proposalHash: null,
    summary: 'Entrega sintética para reparar el contrato visual.',
  });
  const baseOutput = visualOutputForRepair(handoff, sourceHash);
  const responses = responseFactory(cloneJson(baseOutput));
  const calls = [];
  const logs = [];
  let prepareCalls = 0;
  const evidenceService = {
    async prepareEvidenceInputs() {
      prepareCalls += 1;
      return {
        blocked: false,
        blockedQuestions: [],
        blockedReasons: [],
        evidenceIds: ['capture.png'],
        images: [],
        inputImages: [{
          type: 'input_image',
          image_url: 'data:image/png;base64,iVBORw0KGgo=',
          detail: 'high',
        }],
      };
    },
  };
  const service = new CoordinatorService({
    repoRoot: root,
    config: validateConfig({}),
    outputSchema: schemas.output,
    outputV2Schema: schemas.outputV2,
    taskStore,
    evidenceService,
    buildContext: async () => 'Contexto sintético seguro.',
    logger: {
      info(entry) {
        logs.push(entry);
      },
      error(entry) {
        logs.push(entry);
      },
    },
    client: {
      async createStructuredResponse(options) {
        calls.push(options);
        const response = responses[calls.length - 1];
        if (!response) {
          throw new CoordinationError('Se intentó una llamada adicional inesperada.', {
            code: 'UNEXPECTED_REPAIR_CALL',
          });
        }
        return cloneJson(response);
      },
    },
  });
  return {
    baseOutput,
    calls,
    get prepareCalls() {
      return prepareCalls;
    },
    handoff,
    logs,
    proposalHash,
    root,
    service,
    sourceHash,
    taskStore,
  };
}

async function createAndReview(environment, options = {}) {
  const taskId = options.taskId || `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const domain = options.domain || 'compras';
  await environment.actions.createTask(taskInput(taskId, domain));
  const handoff = handoffV2(taskId, domain, options.handoff);
  const enqueued = await environment.actions.enqueue(handoff);
  await environment.watcher.scan({ waitForStable: true });
  const awaitService = new CoordinationAwaitService({
    repoRoot: environment.root,
    config: environment.config,
    stateStore: environment.stateStore,
  });
  const ready = await awaitService.wait({
    taskId,
    submissionId: enqueued.submissionId,
    revision: enqueued.revision,
    domain,
    handoffHash: enqueued.handoffHash,
    timeoutMs: environment.config.awaitTimeoutMs,
  });
  assert.equal(ready?.status, 'review_ready');
  return { taskId, domain, handoff, enqueued, ready };
}

function exactCriteria(review) {
  return {
    taskId: review.taskId,
    domain: review.domain,
    revision: review.ready.revision,
    proposalHash: review.ready.proposalHash,
    fileHash: review.ready.fileHash,
  };
}

test('v2 01-02: Chat Coordinador creates a stable task and preserves original intent', async () => {
  const environment = await createEnvironment();
  const input = taskInput('task-create-original', 'contabilidad');
  const created = await environment.actions.createTask(input);
  assert.equal(created.taskId, input.taskId);
  assert.equal(created.domain, 'contabilidad');
  assert.equal(created.firstPrompt, input.initialPrompt);
  assert.equal(created.executed, false);
  const stored = await environment.taskStore.load(input.taskId);
  assert.equal(stored.originalRequest, input.originalRequest);
  assert.equal(stored.objective, input.objective);
});

test('v2 task creation rolls back the runtime file when state registration fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-task-create-rollback-v2-'));
  temporaryRoots.add(root);
  await copyContracts(root);
  const taskStore = new TaskStore({ repoRoot: root });
  const failingStateStore = {
    async initialize() {},
    async mutate() {
      throw new CoordinationError('Fallo sintético de state.json.', {
        code: 'SYNTHETIC_STATE_FAILURE',
      });
    },
  };
  const actions = new ProtocolActions({
    repoRoot: root,
    config: validateConfig({}),
    handoffSchema: schemas.handoff,
    outputSchema: schemas.output,
    handoffV2Schema: schemas.handoffV2,
    outputV2Schema: schemas.outputV2,
    stateStore: failingStateStore,
    taskStore,
  });
  const input = taskInput('task-create-rollback');
  await assertRejectCode(() => actions.createTask(input), 'SYNTHETIC_STATE_FAILURE');
  assert.equal(await taskStore.exists(input.taskId), false);
});

test('v2 03-06: specialist handoff is reviewed, awaited and ready without review command', async () => {
  const environment = await createEnvironment();
  const review = await createAndReview(environment, { taskId: 'task-auto-await' });
  assert.equal(environment.calls.length, 1);
  assert.equal(review.ready.output.taskId, review.taskId);
  assert.equal(review.ready.output.domain, review.domain);
  assert.match(review.ready.proposalHash, /^[a-f0-9]{64}$/);
  assert.match(review.ready.fileHash, /^[a-f0-9]{64}$/);
  const state = await environment.stateStore.load();
  assert.equal(state.pendingByDomain[review.domain].status, 'pending');
  assert.equal(state.presentations[review.ready.proposalHash], undefined);
});

test('v2 06: present records the full exact proposal before user approval', async () => {
  const environment = await createEnvironment();
  const review = await createAndReview(environment, { taskId: 'task-present-exact' });
  const presented = await environment.actions.present(exactCriteria(review), 'chat:compras');
  assert.equal(presented.status, 'presented');
  assert.equal(presented.executed, false);
  const state = await environment.stateStore.load();
  const record = state.presentations[review.ready.proposalHash];
  assert.equal(record.status, 'presented');
  assert.equal(record.promptFull, review.ready.output.nextPrompt);
  assert.equal(record.verdict, 'continue');
  assert.equal(record.expectedApprovalResult, 'begin');
  await environment.stateStore.mutate((current) => {
    current.presentations[review.ready.proposalHash].targetDomain = 'ventas';
  });
  await assertRejectCode(
    () => environment.actions.approve(exactCriteria(review), 'usuario'),
    'V2_PROPOSAL_NOT_PRESENTED',
  );
});

test('v2 07 and 14: continue can be approved and begun only in chat, never by tooling', async () => {
  const environment = await createEnvironment();
  const review = await createAndReview(environment, { taskId: 'task-continue' });
  await environment.actions.present(exactCriteria(review));
  const approved = await environment.actions.approve(exactCriteria(review), 'usuario');
  assert.equal(approved.executed, false);
  assert.equal(approved.terminal, false);
  const begun = await environment.actions.begin({
    taskId: review.taskId,
    domain: review.domain,
    revision: review.ready.revision,
    proposalHash: review.ready.proposalHash,
  });
  assert.equal(begun.executed, false);
  assert.equal(begun.nextPrompt, review.ready.output.nextPrompt);
});

test('v2 08: fix_required preserves an executable proposal when it has no blockers', async () => {
  const environment = await createEnvironment({
    output: { verdict: 'fix_required' },
  });
  const review = await createAndReview(environment, { taskId: 'task-fix-required' });
  assert.equal(review.ready.output.verdict, 'fix_required');
  assert.ok(review.ready.output.nextPrompt);
  const presented = await environment.actions.present(exactCriteria(review));
  assert.equal(presented.verdict, 'fix_required');
});

test('v2 09: close approval is terminal and never exposes a prompt to begin', async () => {
  const environment = await createEnvironment({
    output: {
      verdict: 'close',
      nextPrompt: null,
      closeReason: 'La tarea está completa.',
    },
  });
  const review = await createAndReview(environment, { taskId: 'task-close' });
  await environment.actions.present(exactCriteria(review));
  const approved = await environment.actions.approve(exactCriteria(review), 'usuario');
  assert.equal(approved.terminal, true);
  assert.equal(approved.nextPrompt, null);
  assert.equal(approved.executed, false);
  await assertRejectCode(
    () => environment.actions.begin({
      taskId: review.taskId,
      domain: review.domain,
      revision: review.ready.revision,
      proposalHash: review.ready.proposalHash,
    }),
    'NO_EXACT_APPROVED_PROPOSAL',
  );
});

test('v2 10-11: blocked review and blocking questions cannot be approved', async () => {
  const environment = await createEnvironment({
    output: {
      verdict: 'blocked',
      nextPrompt: null,
      blockingQuestions: ['¿Qué criterio debe aplicarse?'],
    },
  });
  const review = await createAndReview(environment, { taskId: 'task-blocked' });
  await environment.actions.present(exactCriteria(review));
  await assertRejectCode(
    () => environment.actions.approve(exactCriteria(review), 'usuario'),
    'BLOCKING_QUESTIONS_UNRESOLVED',
  );
});

test('v2 rejected review has no executable prompt and cannot be approved', async () => {
  const environment = await createEnvironment({
    output: {
      verdict: 'rejected',
      nextPrompt: null,
      closeReason: null,
    },
  });
  const review = await createAndReview(environment, { taskId: 'task-rejected' });
  assert.equal(review.ready.output.verdict, 'rejected');
  assert.equal(review.ready.output.nextPrompt, null);
  await environment.actions.present(exactCriteria(review));
  await assertRejectCode(
    () => environment.actions.approve(exactCriteria(review), 'usuario'),
    'BLOCKING_QUESTIONS_UNRESOLVED',
  );
});

test('v2 12-13: natural user observation supersedes proposal and enqueues a new API review', async () => {
  const environment = await createEnvironment();
  const review = await createAndReview(environment, { taskId: 'task-observation' });
  await environment.actions.present(exactCriteria(review));
  const observed = await environment.actions.observe(
    exactCriteria(review),
    'La tabla sigue sin mostrar claramente el estado.',
    'usuario',
  );
  assert.equal(observed.revision, 2);
  assert.equal(observed.previousRevision, 1);
  assert.equal(observed.executed, false);
  assert.equal(await pathExists(path.resolve(environment.root, observed.path)), true);
  const task = await environment.taskStore.load(review.taskId);
  assert.equal(task.observations.at(-1).text, 'La tabla sigue sin mostrar claramente el estado.');
  assert.equal(task.revisions[0].status, 'superseded');
  const state = await environment.stateStore.load();
  assert.equal(state.presentations[review.ready.proposalHash].status, 'superseded');
});

test('v2 15: a proposal that was never presented cannot be approved', async () => {
  const environment = await createEnvironment();
  const review = await createAndReview(environment, { taskId: 'task-not-presented' });
  await assertRejectCode(
    () => environment.actions.approve(exactCriteria(review), 'usuario'),
    'V2_PROPOSAL_STATUS_INVALID',
  );
});

test('v2 16-19: stale hash, revision and domain identities are rejected', async () => {
  const environment = await createEnvironment();
  const review = await createAndReview(environment, { taskId: 'task-stale-identity' });
  const criteria = exactCriteria(review);
  await assertRejectCode(
    () => environment.actions.present({
      ...criteria,
      fileHash: '0'.repeat(64),
    }),
    'V2_PROPOSAL_NOT_CURRENT',
  );
  await assertRejectCode(
    () => environment.actions.present({
      ...criteria,
      revision: 2,
    }),
    'V2_PROPOSAL_NOT_CURRENT',
  );
  await assertRejectCode(
    () => environment.actions.present({
      ...criteria,
      domain: 'ventas',
    }),
    'V2_PROPOSAL_NOT_CURRENT',
  );
});

test('v2 20: double approval and double begin are prevented', async () => {
  const environment = await createEnvironment();
  const review = await createAndReview(environment, { taskId: 'task-double-action' });
  const criteria = exactCriteria(review);
  await environment.actions.present(criteria);
  await environment.actions.approve(criteria, 'usuario');
  await assertRejectCode(
    () => environment.actions.approve(criteria, 'usuario'),
    'V2_PROPOSAL_STATUS_INVALID',
  );
  const beginCriteria = {
    taskId: review.taskId,
    domain: review.domain,
    revision: review.ready.revision,
    proposalHash: review.ready.proposalHash,
  };
  await environment.actions.begin(beginCriteria);
  await assertRejectCode(
    () => environment.actions.begin(beginCriteria),
    'NO_EXACT_APPROVED_PROPOSAL',
  );
});

test('v2 21: cross-domain approval creates a recoverable transfer with same taskId', async () => {
  const environment = await createEnvironment({
    output: {
      targetDomain: 'ventas',
      nextPrompt: 'Validá el contrato de ventas sin modificar Compras.',
    },
  });
  const review = await createAndReview(environment, { taskId: 'task-transfer' });
  const criteria = exactCriteria(review);
  await environment.actions.present(criteria);
  const approved = await environment.actions.approve(criteria, 'usuario');
  assert.equal(approved.transferRequired, true);
  assert.equal(approved.targetDomain, 'ventas');
  const claimed = await environment.actions.continueTask({
    taskId: review.taskId,
    domain: 'ventas',
  });
  assert.equal(claimed.taskId, review.taskId);
  assert.equal(claimed.nextPrompt, review.ready.output.nextPrompt);
  const begun = await environment.actions.begin({
    taskId: review.taskId,
    domain: 'ventas',
    revision: review.ready.revision,
    proposalHash: review.ready.proposalHash,
  });
  assert.equal(begun.executed, false);
});

test('v2 approval barrier: r2 cannot be enqueued without exact approve and begin', async () => {
  const environment = await createEnvironment();
  const review = await createAndReview(environment, { taskId: 'task-no-bypass' });
  const unauthorized = handoffV2(review.taskId, review.domain, {
    submissionId: 'task-no-bypass-r2-report',
    revision: 2,
    previousRevision: 1,
    executionKind: 'approved-proposal',
    approvedProposalHash: review.ready.proposalHash,
    approvedPrompt: review.ready.output.nextPrompt,
  });
  await assertRejectCode(
    () => environment.actions.enqueue(unauthorized),
    'HANDOFF_WITHOUT_EXECUTION_APPROVAL',
  );
});

test('v2 approved execution can publish the next contiguous report', async () => {
  const environment = await createEnvironment({
    output: (handoff) => ({
      nextPrompt: handoff.revision === 1
        ? 'Aplicá la corrección aprobada para r2.'
        : 'Continuá con una validación distinta.',
    }),
  });
  const review = await createAndReview(environment, { taskId: 'task-authorized-r2' });
  const criteria = exactCriteria(review);
  await environment.actions.present(criteria);
  await environment.actions.approve(criteria, 'usuario');
  await environment.actions.begin({
    taskId: review.taskId,
    domain: review.domain,
    revision: 1,
    proposalHash: review.ready.proposalHash,
  });
  const next = handoffV2(review.taskId, review.domain, {
    submissionId: 'task-authorized-r2-report',
    revision: 2,
    previousRevision: 1,
    executionKind: 'approved-proposal',
    approvedProposalHash: review.ready.proposalHash,
    approvedPrompt: review.ready.output.nextPrompt,
  });
  const enqueued = await environment.actions.enqueue(next);
  assert.equal(enqueued.revision, 2);
  assert.equal(enqueued.executed, false);
});

test('v2 22-23: await reports timeout and inactive watcher without changing state', async () => {
  const environment = await createEnvironment();
  const beforeState = JSON.stringify(await environment.stateStore.load());
  const inactiveService = new CoordinationAwaitService({
    repoRoot: environment.root,
    config: environment.config,
    stateStore: environment.stateStore,
  });
  await assertRejectCode(
    () => inactiveService.inspect({
      taskId: 'task-missing',
      domain: 'compras',
      revision: 1,
      handoffHash: '0'.repeat(64),
    }),
    'WATCHER_INACTIVE',
  );
  assert.equal(JSON.stringify(await environment.stateStore.load()), beforeState);

  const timeoutService = new CoordinationAwaitService({
    repoRoot: environment.root,
    config: environment.config,
    stateStore: environment.stateStore,
    now: (() => {
      let current = 0;
      return () => current;
    })(),
    sleep: async () => {},
  });
  timeoutService.inspect = async () => null;
  let tick = 0;
  timeoutService.now = () => {
    tick += 20;
    return tick;
  };
  await assertRejectCode(
    () => timeoutService.wait({
      taskId: 'task-timeout',
      domain: 'compras',
      timeoutMs: 10,
      pollMs: 1,
    }),
    'COORDINATION_AWAIT_TIMEOUT',
  );
});

test('v2 await CLI requires the exact revision identity', async () => {
  await assertRejectCode(
    () => awaitCommand([
      '--task-id', 'task-await-cli',
      '--domain', 'compras',
      '--handoff-hash', '0'.repeat(64),
      '--timeout', '10',
    ]),
    'MISSING_REVISION',
  );
});

test('v2 queued review keeps waiting instead of reporting replacement', async () => {
  const environment = await createEnvironment();
  await environment.watcher.heartbeat.beat();
  await environment.stateStore.mutate((state) => {
    state.pendingByDomain.compras = {
      taskId: 'other-task',
      status: 'pending',
    };
    state.submissions['queued-submission'] = {
      taskId: 'queued-task',
      submissionId: 'queued-submission',
      revision: 1,
      domain: 'compras',
      status: 'queued',
    };
  });
  const service = new CoordinationAwaitService({
    repoRoot: environment.root,
    config: environment.config,
    stateStore: environment.stateStore,
  });
  const result = await service.inspect({
    taskId: 'queued-task',
    submissionId: 'queued-submission',
    revision: 1,
    domain: 'compras',
  });
  assert.equal(result, null);
});

test('v2 24: retry-review recovers the exact failed visual submission without re-execution', async () => {
  const environment = await createEnvironment({
    coordinator: {
      async coordinate() {
        throw new CoordinationError(
          'La salida del coordinador referencia un adjunto o binario excluido.',
          {
            code: 'FORBIDDEN_FILE_REFERENCE',
            temporary: false,
          },
        );
      },
    },
  });
  const taskId = 'task-api-failure';
  await environment.actions.createTask(taskInput(taskId));
  const handoff = handoffV2(taskId, 'compras', {
    visualImpact: 'material',
    evidenceManifest: `.coordination/evidence/${taskId}/manifest.json`,
  });
  const enqueued = await environment.actions.enqueue(handoff);
  await environment.watcher.scan({ waitForStable: true });
  const failedState = await environment.stateStore.load();
  const failedRecord = Object.values(failedState.processedFiles)
    .find((entry) => entry.submissionId === enqueued.submissionId);
  assert.equal(failedRecord.status, 'failed');
  const retried = await environment.actions.retryReview({
    taskId,
    submissionId: enqueued.submissionId,
    revision: 1,
    domain: 'compras',
    handoffHash: enqueued.handoffHash,
  });
  assert.equal(retried.status, 'retrying');
  assert.equal(
    await pathExists(path.join(environment.paths.inbox, submissionFileName(handoff))),
    true,
  );
  environment.watcher.coordinator = {
    async coordinate(retriedHandoff, sourceHash) {
      return visualOutputForTwoEvidence(retriedHandoff, sourceHash);
    },
  };
  await environment.watcher.scan({ waitForStable: true });
  const awaitService = new CoordinationAwaitService({
    repoRoot: environment.root,
    config: environment.config,
    stateStore: environment.stateStore,
  });
  const ready = await awaitService.wait({
    taskId,
    submissionId: enqueued.submissionId,
    revision: 1,
    domain: 'compras',
    handoffHash: enqueued.handoffHash,
    timeoutMs: environment.config.awaitTimeoutMs,
  });
  assert.equal(ready.status, 'review_ready');
  assert.equal(ready.submissionId, enqueued.submissionId);
  assert.equal(ready.revision, 1);
  assert.deepEqual(
    ready.output.visualReview.images.map((image) => image.filename),
    ['screen-a.png', 'screen-b.png'],
  );
  const presented = await environment.actions.present({
    taskId,
    domain: 'compras',
    revision: 1,
    proposalHash: ready.proposalHash,
    fileHash: ready.fileHash,
  }, 'chat:compras');
  assert.equal(presented.status, 'presented');
  assert.equal(presented.executed, false);
  const recoveredState = await environment.stateStore.load();
  const task = await environment.taskStore.load(taskId);
  assert.equal(
    task.revisions.filter((entry) =>
      entry.submissionId === enqueued.submissionId).length,
    1,
  );
  assert.deepEqual(recoveredState.approvals, {});
  assert.deepEqual(recoveredState.proposalApprovals, {});
});

test('v2 retry-review restores failed state when the task update fails', async () => {
  const environment = await createEnvironment({
    coordinator: {
      async coordinate() {
        throw new CoordinationError('API sintética no disponible.', {
          code: 'OPENAI_UNAVAILABLE',
          temporary: false,
        });
      },
    },
  });
  const taskId = 'task-api-retry-rollback';
  await environment.actions.createTask(taskInput(taskId));
  const handoff = handoffV2(taskId);
  const enqueued = await environment.actions.enqueue(handoff);
  await environment.watcher.scan({ waitForStable: true });
  const before = await environment.stateStore.load();
  const failedEntry = Object.entries(before.processedFiles)
    .find(([, entry]) => entry.submissionId === enqueued.submissionId);
  environment.actions.taskStore = {
    async mutate() {
      throw new CoordinationError('Fallo sintético de task.json.', {
        code: 'SYNTHETIC_TASK_FAILURE',
      });
    },
  };
  await assertRejectCode(
    () => environment.actions.retryReview({
      taskId,
      submissionId: enqueued.submissionId,
      revision: 1,
      domain: 'compras',
      handoffHash: enqueued.handoffHash,
    }),
    'SYNTHETIC_TASK_FAILURE',
  );
  const restored = await environment.stateStore.load();
  assert.equal(restored.processedFiles[failedEntry[0]].status, 'failed');
  assert.equal(
    restored.submissions[enqueued.submissionId].status,
    before.submissions[enqueued.submissionId].status,
  );
  assert.equal(
    await pathExists(path.resolve(environment.root, failedEntry[1].failedPath)),
    true,
  );
});

test('v2 30-32: none ignores images and minor evidence remains optional', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-coordinator-visual-policy-v2-'));
  temporaryRoots.add(root);
  await copyContracts(root);
  const taskStore = new TaskStore({ repoRoot: root });
  await taskStore.create(taskInput('task-minor', 'ui-ux'));
  await taskStore.recordRevision('task-minor', {
    revision: 1,
    submissionId: 'task-minor-r1-report',
    domain: 'ui-ux',
    status: 'awaiting_review',
    handoffHash: 'b'.repeat(64),
    proposalHash: null,
    summary: 'Entrega visual menor.',
  });
  const sourceHash = 'b'.repeat(64);
  const handoff = handoffV2('task-minor', 'ui-ux', {
    submissionId: 'task-minor-r1-report',
    visualImpact: 'minor',
    evidenceManifest: null,
  });
  const proposalHash = createProposalToken({
    taskId: handoff.taskId,
    revision: 1,
    sourceHash,
  });
  const service = new CoordinatorService({
    repoRoot: root,
    config: validateConfig({}),
    outputSchema: schemas.output,
    outputV2Schema: schemas.outputV2,
    taskStore,
    buildContext: async () => 'Contexto sintético seguro.',
    client: {
      async createStructuredResponse() {
        return outputV2(handoff, sourceHash, {
          verdict: 'close',
          nextPrompt: null,
          closeReason: 'El ajuste menor quedó validado.',
          proposalHash,
        });
      },
    },
  });
  const noImages = await service.prepareEvidence({
    ...handoff,
    visualImpact: 'none',
    evidenceManifest: '.coordination/evidence/task-minor/manifest.json',
  });
  assert.equal(noImages.count, 0);
  const reviewed = await service.coordinate(handoff, sourceHash);
  assert.equal(reviewed.verdict, 'close');
  assert.equal(reviewed.evidenceRequired, false);
});

test('v2 33 and 39: real image input requires concrete findings for every capture', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-coordinator-visual-review-v2-'));
  temporaryRoots.add(root);
  await copyContracts(root);
  const taskStore = new TaskStore({ repoRoot: root });
  await taskStore.create(taskInput('task-visual-review', 'ui-ux'));
  await taskStore.recordRevision('task-visual-review', {
    revision: 1,
    submissionId: 'task-visual-review-r1-report',
    domain: 'ui-ux',
    status: 'awaiting_review',
    handoffHash: 'c'.repeat(64),
    proposalHash: null,
    summary: 'Entrega visual con captura.',
  });
  const sourceHash = 'c'.repeat(64);
  const handoff = handoffV2('task-visual-review', 'ui-ux', {
    submissionId: 'task-visual-review-r1-report',
    visualImpact: 'material',
    evidenceManifest: '.coordination/evidence/task-visual-review/manifest.json',
  });
  const proposalHash = createProposalToken({
    taskId: handoff.taskId,
    revision: 1,
    sourceHash,
  });
  let receivedInput;
  const evidenceService = {
    async prepareEvidenceInputs() {
      return {
        blocked: false,
        blockedQuestions: [],
        blockedReasons: [],
        evidenceIds: ['capture.png'],
        images: [],
        inputImages: [{
          type: 'input_image',
          image_url: 'data:image/png;base64,iVBORw0KGgo=',
          detail: 'high',
        }],
      };
    },
  };
  const makeService = (issues) => new CoordinatorService({
    repoRoot: root,
    config: validateConfig({}),
    outputSchema: schemas.output,
    outputV2Schema: schemas.outputV2,
    taskStore,
    evidenceService,
    buildContext: async () => 'Contexto sintético seguro.',
    client: {
      async createStructuredResponse(options) {
        receivedInput = options.input;
        return outputV2(handoff, sourceHash, {
          proposalHash,
          visualReview: issues.length > 0
            ? {
              status: 'reviewed',
              performed: true,
              images: [{
                filename: 'capture.png',
                observations: [
                  'La captura muestra una pantalla sintética en su estado inicial.',
                ],
              }],
              categoryAudit: categoryAuditForIssues(issues),
              crossImageFindings: [],
              confidence: 'high',
            }
            : {
              status: 'not_provided',
              performed: false,
              images: [],
              categoryAudit: [],
              crossImageFindings: [],
              confidence: 'not_applicable',
            },
          recommendedChanges: issues.length > 0
            ? [{
              category: issues[0].category,
              instruction: 'Reordená las acciones para reforzar su jerarquía visual.',
              target: 'barra de acciones de la pantalla sintética',
              expectedResult: 'La acción principal queda claramente diferenciada.',
            }]
            : [{
              category: 'other',
              instruction: 'Adjuntá y revisá la captura visual requerida para continuar.',
              target: 'evidencia visual de la tarea',
              expectedResult: 'La revisión incluye la captura solicitada y sus hallazgos.',
            }],
        });
      },
    },
  });
  const reviewed = await makeService([{
    category: 'weak_hierarchy',
    severity: 'medium',
    description: 'Las acciones principales y secundarias compiten visualmente.',
    evidence: 'Los botones de la barra usan el mismo peso y tamaño visible.',
  },
  ]).coordinate(handoff, sourceHash);
  assert.equal(receivedInput[0].content[1].type, 'input_image');
  assert.match(receivedInput[0].content[1].image_url, /^data:image\/png;base64,/);
  assert.equal(
    Object.hasOwn(reviewed.visualReview.images[0], 'detectedIssues'),
    false,
  );
  assert.equal(
    Object.hasOwn(reviewed.visualReview, 'detectedCategories'),
    false,
  );
  assert.equal(
    reviewed.visualReview.categoryAudit.find(
      (entry) => entry.category === 'weak_hierarchy',
    ).status,
    'present',
  );
  await assertRejectCode(
    () => makeService([]).coordinate(handoff, sourceHash),
    'VISUAL_EVIDENCE_NOT_FULLY_REVIEWED',
  );
});

test('two authorized evidences cross CoordinatorService, watcher and ProtocolActions without OpenAI', async () => {
  let receivedInput;
  let currentHandoff;
  let evidencePrepareCalls = 0;
  const environment = await createEnvironment({
    coordinatorFactory: async ({
      root,
      config,
      taskStore,
    }) => new CoordinatorService({
      repoRoot: root,
      config,
      outputSchema: schemas.output,
      outputV2Schema: schemas.outputV2,
      taskStore,
      evidenceService: {
        async prepareEvidenceInputs() {
          evidencePrepareCalls += 1;
          return {
            blocked: false,
            blockedQuestions: [],
            blockedReasons: [],
            evidenceIds: ['screen-a.png', 'screen-b.png'],
            images: [
              {
                evidenceId: 'screen-a.png',
                filename: 'screen-a.png',
              },
              {
                evidenceId: 'screen-b.png',
                filename: 'screen-b.png',
              },
            ],
            inputImages: [
              {
                type: 'input_image',
                image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
                detail: 'high',
              },
              {
                type: 'input_image',
                image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAAB',
                detail: 'high',
              },
            ],
          };
        },
      },
      buildContext: async ({ handoff }) => {
        currentHandoff = handoff;
        return 'Contexto visual sintético con dos evidencias autorizadas.';
      },
      client: {
        async createStructuredResponse(options) {
          receivedInput = options.input;
          const text = receivedInput[0].content.find(
            (entry) => entry.type === 'input_text',
          )?.text;
          const sourceHash = text?.match(/sourceHash:\s*([a-f0-9]{64})/)?.[1];
          assert.ok(sourceHash);
          return visualOutputForTwoEvidence(currentHandoff, sourceHash);
        },
      },
    }),
  });

  const review = await createAndReview(environment, {
    taskId: 'task-two-authorized-evidences',
    domain: 'ui-ux',
    handoff: {
      visualImpact: 'material',
      evidenceManifest:
        '.coordination/evidence/task-two-authorized-evidences/manifest.json',
    },
  });
  const sentImages = receivedInput[0].content.filter(
    (entry) => entry.type === 'input_image',
  );
  assert.equal(evidencePrepareCalls, 1);
  assert.equal(sentImages.length, 2);
  assert.deepEqual(
    review.ready.output.visualReview.images.map((image) => image.filename),
    ['screen-a.png', 'screen-b.png'],
  );

  const beforePresentation = await environment.stateStore.load();
  const processed = Object.values(beforePresentation.processedFiles).find(
    (entry) => entry.taskId === review.taskId,
  );
  assert.equal(processed.status, 'pending');
  assert.equal(processed.reviewValidation.status, 'valid_initially');
  assert.deepEqual(beforePresentation.approvals, {});
  assert.deepEqual(beforePresentation.proposalApprovals, {});

  const presented = await environment.actions.present(
    exactCriteria(review),
    'chat:ui-ux',
  );
  assert.equal(presented.status, 'presented');
  assert.equal(presented.executed, false);
  assert.deepEqual(
    presented.recommendedChanges,
    review.ready.output.recommendedChanges,
  );
  const finalState = await environment.stateStore.load();
  assert.deepEqual(finalState.approvals, {});
  assert.deepEqual(finalState.proposalApprovals, {});
  assert.equal(
    finalState.activity.some((entry) =>
      /proposal_approved|approved_task_started|task_transfer_claimed/.test(
        entry.type,
      )),
    false,
  );
});

test('visual review is distinguished when valid on the first attempt', async () => {
  const fixture = await createVisualRepairFixture((baseOutput) => [
    baseOutput,
  ]);

  const reviewed = await fixture.service.coordinate(
    fixture.handoff,
    fixture.sourceHash,
  );

  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.prepareCalls, 1);
  assert.equal(
    fixture.calls[0].input[0].content.filter(
      (entry) => entry.type === 'input_image',
    ).length,
    1,
  );
  assert.deepEqual(getReviewOutcome(reviewed), {
    status: 'valid_initially',
    attempts: 1,
    initialError: null,
  });
  assert.equal(
    fixture.logs.some(
      (entry) => entry.code === 'COORDINATOR_REVIEW_VALID_INITIAL',
    ),
    true,
  );
});

test('one textual repair restores evidence required by a present category', async () => {
  const fixture = await createVisualRepairFixture((baseOutput) => {
    const invalid = cloneJson(baseOutput);
    const audit = invalid.visualReview.categoryAudit.find(
      (entry) => entry.category === 'weak_hierarchy',
    );
    audit.evidence = null;
    return [invalid, cloneJson(baseOutput)];
  });

  const reviewed = await fixture.service.coordinate(
    fixture.handoff,
    fixture.sourceHash,
  );
  const repaired = reviewed.visualReview.categoryAudit.find(
    (entry) => entry.category === 'weak_hierarchy',
  );

  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.prepareCalls, 1);
  assert.equal(typeof fixture.calls[1].input, 'string');
  assert.equal(fixture.calls[1].input.includes('data:image/'), false);
  assert.equal(typeof repaired.evidence, 'string');
  assert.equal(
    getReviewOutcome(reviewed).status,
    'repaired',
  );
});

test('text-only repair cannot invent visual evidence absent from immutable observations', async () => {
  const fixture = await createVisualRepairFixture((baseOutput) => {
    const invalid = cloneJson(baseOutput);
    invalid.visualReview.categoryAudit.find(
      (entry) => entry.category === 'weak_hierarchy',
    ).evidence = null;
    const invented = cloneJson(baseOutput);
    invented.visualReview.categoryAudit.find(
      (entry) => entry.category === 'weak_hierarchy',
    ).evidence =
      'Un control lateral inventado aparece superpuesto sobre una tarjeta inexistente.';
    return [invalid, invented];
  });

  await assert.rejects(
    () => fixture.service.coordinate(fixture.handoff, fixture.sourceHash),
    (error) => {
      assert.equal(error.code, 'VISUAL_REPAIR_FAILED');
      assert.equal(
        error.repairErrors[1].code,
        'VISUAL_REPAIR_EVIDENCE_SOURCE_MISSING',
      );
      return true;
    },
  );
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.prepareCalls, 1);
});

test('one textual repair corrects absent severity without reloading the image', async () => {
  const fixture = await createVisualRepairFixture((baseOutput) => {
    const invalid = cloneJson(baseOutput);
    const repaired = cloneJson(baseOutput);
    const invalidAudit = invalid.visualReview.categoryAudit.find(
      (entry) => entry.category === 'excessive_whitespace',
    );
    invalidAudit.severity = 'low';
    invalidAudit.evidence =
      'La salida previa agregó una evidencia narrativa a una categoría ausente.';
    return [invalid, repaired];
  });

  const reviewed = await fixture.service.coordinate(
    fixture.handoff,
    fixture.sourceHash,
  );
  const repairedAudit = reviewed.visualReview.categoryAudit.find(
    (entry) => entry.category === 'excessive_whitespace',
  );

  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.prepareCalls, 1);
  assert.equal(repairedAudit.status, 'absent');
  assert.equal(repairedAudit.severity, null);
  assert.equal(repairedAudit.evidence, null);
  assert.equal(typeof fixture.calls[1].input, 'string');
  assert.equal(fixture.calls[1].input.includes('data:image/'), false);
  assert.match(fixture.calls[1].input, /VISUAL_CATEGORY_SEVERITY_UNEXPECTED/);
  assert.match(fixture.calls[1].instructions, /no vuelvas a analizar la imagen/i);
  assert.deepEqual(getReviewOutcome(reviewed), {
    status: 'repaired',
    attempts: 2,
    initialError: {
      code: 'VISUAL_CATEGORY_SEVERITY_UNEXPECTED',
      message:
        'VISUAL_CATEGORY_SEVERITY_UNEXPECTED: absent requiere severity=null para excessive_whitespace.',
    },
  });
  assert.equal(reviewed.verdict, fixture.baseOutput.verdict);
  assert.deepEqual(reviewed.findings, fixture.baseOutput.findings);
  assert.deepEqual(
    reviewed.visualReview.categoryAudit,
    fixture.baseOutput.visualReview.categoryAudit,
  );
  assert.equal(reviewed.nextPrompt, fixture.baseOutput.nextPrompt);
});

test('one textual repair corrects uncertain severity and preserves its evidence', async () => {
  const fixture = await createVisualRepairFixture((baseOutput) => {
    const invalid = cloneJson(baseOutput);
    const repaired = cloneJson(baseOutput);
    invalid.visualReview.categoryAudit.find(
      (entry) => entry.category === 'responsive_layout',
    ).severity = 'low';
    return [invalid, repaired];
  });

  const reviewed = await fixture.service.coordinate(
    fixture.handoff,
    fixture.sourceHash,
  );
  const uncertain = reviewed.visualReview.categoryAudit.find(
    (entry) => entry.category === 'responsive_layout',
  );

  assert.equal(fixture.calls.length, 2);
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(uncertain.severity, null);
  assert.match(uncertain.evidence, /captura estática/i);
  assert.deepEqual(getReviewOutcome(reviewed).status, 'repaired');
});

test('one textual repair restores one missing canonical category', async () => {
  const fixture = await createVisualRepairFixture((baseOutput) => {
    const invalid = cloneJson(baseOutput);
    const repaired = cloneJson(baseOutput);
    invalid.visualReview.categoryAudit =
      invalid.visualReview.categoryAudit.filter(
        (entry) => entry.category !== 'accessibility_visual',
      );
    repaired.visualReview.categoryAudit.find(
      (entry) => entry.category === 'accessibility_visual',
    ).evidence = null;
    return [invalid, repaired];
  });

  const reviewed = await fixture.service.coordinate(
    fixture.handoff,
    fixture.sourceHash,
  );

  assert.equal(fixture.calls.length, 2);
  assert.equal(reviewed.visualReview.categoryAudit.length, 10);
  assert.equal(
    reviewed.visualReview.categoryAudit.filter(
      (entry) => entry.category === 'accessibility_visual',
    ).length,
    1,
  );
  const restored = reviewed.visualReview.categoryAudit.find(
    (entry) => entry.category === 'accessibility_visual',
  );
  assert.equal(restored.status, 'uncertain');
  assert.equal(restored.severity, null);
  assert.equal(restored.evidence, null);
  assert.equal(getReviewOutcome(reviewed).status, 'repaired');
});

test('a missing category cannot be repaired as absent without visual support', async () => {
  const fixture = await createVisualRepairFixture((baseOutput) => {
    const invalid = cloneJson(baseOutput);
    invalid.visualReview.categoryAudit =
      invalid.visualReview.categoryAudit.filter(
        (entry) => entry.category !== 'accessibility_visual',
      );
    const unsafe = cloneJson(baseOutput);
    const restored = unsafe.visualReview.categoryAudit.find(
      (entry) => entry.category === 'accessibility_visual',
    );
    restored.status = 'absent';
    restored.severity = null;
    restored.evidence = null;
    restored.description =
      'La captura no presenta barreras visuales de accesibilidad.';
    return [invalid, unsafe];
  });

  await assert.rejects(
    () => fixture.service.coordinate(fixture.handoff, fixture.sourceHash),
    (error) => {
      assert.equal(error.code, 'VISUAL_REPAIR_FAILED');
      assert.equal(
        error.repairErrors[1].code,
        'VISUAL_REPAIR_MISSING_CATEGORY_UNSAFE',
      );
      return true;
    },
  );
  assert.equal(fixture.calls.length, 2);
});

test('one textual repair removes a repeated canonical category', async () => {
  const fixture = await createVisualRepairFixture((baseOutput) => {
    const invalid = cloneJson(baseOutput);
    invalid.visualReview.categoryAudit.push({
      ...invalid.visualReview.categoryAudit[0],
    });
    return [invalid, cloneJson(baseOutput)];
  });

  const reviewed = await fixture.service.coordinate(
    fixture.handoff,
    fixture.sourceHash,
  );

  assert.equal(fixture.calls.length, 2);
  assert.equal(reviewed.visualReview.categoryAudit.length, 10);
  assert.equal(
    new Set(
      reviewed.visualReview.categoryAudit.map((entry) => entry.category),
    ).size,
    10,
  );
  assert.equal(getReviewOutcome(reviewed).status, 'repaired');
});

test('duplicate repair must preserve one original canonical conclusion', async () => {
  const fixture = await createVisualRepairFixture((baseOutput) => {
    const invalid = cloneJson(baseOutput);
    invalid.visualReview.categoryAudit.push({
      ...invalid.visualReview.categoryAudit[0],
    });
    const rewritten = cloneJson(baseOutput);
    rewritten.visualReview.categoryAudit[0].description =
      'La distribución fue reinterpretada durante la reparación textual.';
    return [invalid, rewritten];
  });

  await assert.rejects(
    () => fixture.service.coordinate(fixture.handoff, fixture.sourceHash),
    (error) => {
      assert.equal(error.code, 'VISUAL_REPAIR_FAILED');
      assert.equal(
        error.repairErrors[1].code,
        'VISUAL_REPAIR_SCOPE_VIOLATION',
      );
      return true;
    },
  );
  assert.equal(fixture.calls.length, 2);
});

test('visual repair cannot convert an already canonical category', async () => {
  const fixture = await createVisualRepairFixture((baseOutput) => {
    const invalid = cloneJson(baseOutput);
    invalid.visualReview.categoryAudit.find(
      (entry) => entry.category === 'excessive_whitespace',
    ).severity = 'low';
    const forbidden = cloneJson(baseOutput);
    const changed = forbidden.visualReview.categoryAudit.find(
      (entry) => entry.category === 'excessive_whitespace',
    );
    changed.status = 'present';
    changed.severity = 'low';
    changed.description = 'La pantalla contiene una zona vacía visualmente dominante.';
    changed.evidence = 'El panel derecho permanece vacío en casi toda su superficie.';
    return [invalid, forbidden];
  });

  await assert.rejects(
    () => fixture.service.coordinate(fixture.handoff, fixture.sourceHash),
    (error) => {
      assert.equal(error.code, 'VISUAL_REPAIR_FAILED');
      assert.equal(
        error.repairErrors[1].code,
        'VISUAL_REPAIR_CATEGORY_CHANGE_FORBIDDEN',
      );
      return true;
    },
  );
  assert.equal(fixture.calls.length, 2);
});

test('visual repair cannot change verdict or any field outside categoryAudit', async () => {
  const fixture = await createVisualRepairFixture((baseOutput) => {
    const invalid = cloneJson(baseOutput);
    invalid.visualReview.categoryAudit.find(
      (entry) => entry.category === 'excessive_whitespace',
    ).severity = 'low';
    const forbidden = cloneJson(baseOutput);
    forbidden.verdict = 'continue';
    return [invalid, forbidden];
  });

  await assert.rejects(
    () => fixture.service.coordinate(fixture.handoff, fixture.sourceHash),
    (error) => {
      assert.equal(error.code, 'VISUAL_REPAIR_FAILED');
      assert.equal(
        error.repairErrors[1].code,
        'VISUAL_REPAIR_VERDICT_CHANGE_FORBIDDEN',
      );
      return true;
    },
  );
  assert.equal(fixture.calls.length, 2);
});

test('a still-invalid second response fails once with both sanitized errors', async () => {
  const fixture = await createVisualRepairFixture((baseOutput) => {
    const invalid = cloneJson(baseOutput);
    invalid.visualReview.categoryAudit.find(
      (entry) => entry.category === 'excessive_whitespace',
    ).severity = 'low';
    return [invalid, cloneJson(invalid)];
  });

  await assert.rejects(
    () => fixture.service.coordinate(fixture.handoff, fixture.sourceHash),
    (error) => {
      assert.equal(error.code, 'VISUAL_REPAIR_FAILED');
      assert.equal(error.temporary, false);
      assert.equal(error.repairErrors.length, 2);
      assert.equal(
        error.repairErrors[0].code,
        'VISUAL_CATEGORY_SEVERITY_UNEXPECTED',
      );
      assert.equal(
        error.repairErrors[1].code,
        'VISUAL_CATEGORY_SEVERITY_UNEXPECTED',
      );
      assert.doesNotMatch(error.message, /data:image|iVBOR/);
      return true;
    },
  );
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.prepareCalls, 1);
  assert.equal(
    fixture.logs.some((entry) => entry.code === 'VISUAL_REPAIR_FAILED'),
    true,
  );
});

test('repair runs before pending presentation, approval or execution', async () => {
  let apiCalls = 0;
  let prepareCalls = 0;
  let baseOutput;
  let currentHandoff;
  const environment = await createEnvironment({
    coordinatorFactory: async ({
      root,
      config,
      stateStore,
      taskStore,
    }) => new CoordinatorService({
      repoRoot: root,
      config,
      outputSchema: schemas.output,
      outputV2Schema: schemas.outputV2,
      taskStore,
      evidenceService: {
        async prepareEvidenceInputs() {
          prepareCalls += 1;
          return {
            blocked: false,
            blockedQuestions: [],
            blockedReasons: [],
            evidenceIds: ['capture.png'],
            images: [],
            inputImages: [{
              type: 'input_image',
              image_url: 'data:image/png;base64,iVBORw0KGgo=',
              detail: 'high',
            }],
          };
        },
      },
      buildContext: async ({ handoff }) => {
        currentHandoff = handoff;
        return 'Contexto visual sintético seguro.';
      },
      client: {
        async createStructuredResponse(options) {
          apiCalls += 1;
          if (apiCalls === 1) {
            const text = options.input[0].content[0].text;
            const sourceHash = text.match(/sourceHash:\s*([a-f0-9]{64})/)?.[1];
            assert.ok(sourceHash);
            baseOutput = visualOutputForRepair(currentHandoff, sourceHash);
            const invalid = cloneJson(baseOutput);
            invalid.visualReview.categoryAudit.find(
              (entry) => entry.category === 'excessive_whitespace',
            ).severity = 'low';
            return invalid;
          }
          assert.equal(apiCalls, 2);
          assert.equal(typeof options.input, 'string');
          assert.equal(options.input.includes('data:image/'), false);
          const stateDuringRepair = await stateStore.load();
          assert.deepEqual(stateDuringRepair.pendingByDomain, {});
          assert.deepEqual(stateDuringRepair.presentations, {});
          assert.deepEqual(stateDuringRepair.approvals, {});
          assert.deepEqual(stateDuringRepair.proposalApprovals, {});
          assert.equal(
            stateDuringRepair.activity.some((entry) =>
              /approved|execution|presented|pending_created/.test(entry.type)),
            false,
          );
          return cloneJson(baseOutput);
        },
      },
    }),
  });

  const review = await createAndReview(environment, {
    taskId: 'task-repair-before-presentation',
    domain: 'ui-ux',
    handoff: {
      visualImpact: 'material',
      evidenceManifest:
        '.coordination/evidence/task-repair-before-presentation/manifest.json',
    },
  });
  const state = await environment.stateStore.load();
  const processed = Object.values(state.processedFiles).find(
    (entry) => entry.taskId === review.taskId,
  );

  assert.equal(apiCalls, 2);
  assert.equal(prepareCalls, 1);
  assert.equal(processed.reviewValidation.status, 'repaired');
  assert.equal(processed.reviewValidation.attempts, 2);
  assert.equal(
    state.activity.some((entry) => entry.type === 'visual_review_repaired'),
    true,
  );
  assert.deepEqual(state.presentations, {});
  assert.deepEqual(state.approvals, {});
  assert.deepEqual(state.proposalApprovals, {});
  assert.equal(
    state.activity.some((entry) =>
      /proposal_approved|approved_task_started|task_transfer_claimed/.test(
        entry.type,
      )),
    false,
  );
});

test('failed repair persists both sanitized errors without pending or execution', async () => {
  let apiCalls = 0;
  let invalidOutput;
  let currentHandoff;
  const environment = await createEnvironment({
    coordinatorFactory: async ({
      root,
      config,
      taskStore,
    }) => new CoordinatorService({
      repoRoot: root,
      config,
      outputSchema: schemas.output,
      outputV2Schema: schemas.outputV2,
      taskStore,
      evidenceService: {
        async prepareEvidenceInputs() {
          return {
            blocked: false,
            blockedQuestions: [],
            blockedReasons: [],
            evidenceIds: ['capture.png'],
            images: [],
            inputImages: [{
              type: 'input_image',
              image_url: 'data:image/png;base64,iVBORw0KGgo=',
              detail: 'high',
            }],
          };
        },
      },
      buildContext: async ({ handoff }) => {
        currentHandoff = handoff;
        return 'Contexto visual sintético seguro.';
      },
      client: {
        async createStructuredResponse(options) {
          apiCalls += 1;
          if (apiCalls === 1) {
            const text = options.input[0].content[0].text;
            const sourceHash = text.match(/sourceHash:\s*([a-f0-9]{64})/)?.[1];
            invalidOutput = visualOutputForRepair(currentHandoff, sourceHash);
            invalidOutput.visualReview.categoryAudit.find(
              (entry) => entry.category === 'excessive_whitespace',
            ).severity = 'low';
          }
          return cloneJson(invalidOutput);
        },
      },
    }),
  });
  const taskId = 'task-repair-fails-safely';
  await environment.actions.createTask(taskInput(taskId, 'ui-ux'));
  const handoff = handoffV2(taskId, 'ui-ux', {
    visualImpact: 'material',
    evidenceManifest: `.coordination/evidence/${taskId}/manifest.json`,
  });
  const enqueued = await environment.actions.enqueue(handoff);

  await environment.watcher.scan({ waitForStable: true });

  const state = await environment.stateStore.load();
  const processed = Object.values(state.processedFiles).find(
    (entry) => entry.taskId === taskId,
  );
  const submission = state.submissions[enqueued.submissionId];

  assert.equal(apiCalls, 2);
  assert.equal(processed.status, 'failed');
  assert.equal(processed.error.code, 'VISUAL_REPAIR_FAILED');
  assert.equal(processed.reviewValidation.status, 'repair_failed');
  assert.equal(processed.reviewValidation.repairErrors.length, 2);
  assert.equal(submission.status, 'failed');
  assert.equal(submission.reviewValidation.status, 'repair_failed');
  assert.equal(
    state.errors.some((entry) =>
      entry.code === 'VISUAL_REPAIR_FAILED' &&
      entry.repairErrors?.length === 2),
    true,
  );
  assert.equal(
    state.activity.some(
      (entry) => entry.type === 'visual_review_repair_failed',
    ),
    true,
  );
  assert.deepEqual(state.pendingByDomain, {});
  assert.deepEqual(state.presentations, {});
  assert.deepEqual(state.approvals, {});
  assert.deepEqual(state.proposalApprovals, {});
  assert.equal(
    state.activity.some((entry) =>
      /proposal_approved|approved_task_started|task_transfer_claimed/.test(
        entry.type,
      )),
    false,
  );
});

test('v2 40: material visual work cannot close without real evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-coordinator-semantic-v2-'));
  temporaryRoots.add(root);
  await copyContracts(root);
  const taskStore = new TaskStore({ repoRoot: root });
  await taskStore.create(taskInput('task-material', 'ui-ux'));
  await taskStore.recordRevision('task-material', {
    revision: 1,
    submissionId: 'task-material-r1-report',
    domain: 'ui-ux',
    status: 'awaiting_review',
    handoffHash: 'a'.repeat(64),
    proposalHash: null,
    summary: 'Entrega material.',
  });
  const sourceHash = 'a'.repeat(64);
  const handoff = handoffV2('task-material', 'ui-ux', {
    submissionId: 'task-material-r1-report',
    visualImpact: 'material',
    evidenceManifest: null,
  });
  const proposalHash = createProposalToken({
    taskId: handoff.taskId,
    revision: 1,
    sourceHash,
  });
  const service = new CoordinatorService({
    repoRoot: root,
    config: validateConfig({}),
    outputSchema: schemas.output,
    outputV2Schema: schemas.outputV2,
    taskStore,
    buildContext: async () => 'Contexto sintético seguro.',
    client: {
      async createStructuredResponse() {
        return outputV2(handoff, sourceHash, {
          verdict: 'close',
          nextPrompt: null,
          closeReason: 'Cierre prematuro.',
          proposalHash,
        });
      },
    },
  });
  const reviewed = await service.coordinate(handoff, sourceHash);
  assert.equal(reviewed.verdict, 'fix_required');
  assert.equal(reviewed.evidenceRequired, true);
  assert.match(reviewed.nextPrompt, /evidencias visuales/i);
});

test('v2 42-43: Contabilidad remains valid and every persisted artifact is JSON', async () => {
  const environment = await createEnvironment();
  const review = await createAndReview(environment, {
    taskId: 'task-contabilidad-v2',
    domain: 'contabilidad',
  });
  assert.equal(review.ready.output.domain, 'contabilidad');
  const state = await readJsonLimited(environment.paths.state, 5 * 1024 * 1024);
  assert.equal(state.version, 1);
  const task = await readJsonLimited(
    path.join(environment.paths.tasks, review.taskId, 'task.json'),
    2 * 1024 * 1024,
  );
  assert.equal(task.version, '2.0');
  const status = await getCoordinationStatus(environment.root);
  assert.equal(status.tasks.some((entry) => entry.taskId === review.taskId), true);
  assert.equal(
    status.submissions.some((entry) => entry.submissionId === review.enqueued.submissionId),
    true,
  );
});
