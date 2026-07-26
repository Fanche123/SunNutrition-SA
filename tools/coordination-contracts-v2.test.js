'use strict';

// Pruebas unitarias aisladas de contratos, contexto y evidencia v2.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const { validateConfig } = require('./coordination/config');
const {
  VISUAL_CATEGORY_AUDIT_PROMPT,
} = require('./coordination/coordinator-service');
const {
  buildCoordinatorContext,
  buildCoordinatorInput,
  loadProjectContextManifest,
} = require('./coordination/context-builder');
const {
  EvidenceService,
  sha256Buffer,
} = require('./coordination/evidence-service');
const {
  OpenAIResponsesClient,
  normalizeResponsesInput,
  normalizeSchemaForStructuredOutputs,
} = require('./coordination/openai-client');
const { assertV2OutputContract } = require('./coordination/protocol-actions');
const {
  assertSchema,
  loadSchema,
  validateSchema,
} = require('./coordination/schema-validator');
const {
  assertSafeCoordinatorOutput,
} = require('./coordination/security');
const { TaskStore } = require('./coordination/task-store');
const {
  AUDITABLE_VISUAL_CATEGORIES,
  deriveVisualFindings,
  validateStructuredVisualOutput,
} = require('./coordination/visual-contract');
const {
  collectStructuredVisualSignals,
  createAuditedFetch,
  environmentBeforeWrites,
  evaluateVisualPerception,
  finalUserResponse,
  inspectRepairRequest,
  parsePngDimensions,
  validateImageTransport,
  validatePresentationState,
  validateRecommendedChanges,
  validateVisualCategories,
  validateVisionOutputContract,
  visionValidationFailure,
} = require('./coordination-real-test');

const repoRoot = path.resolve(__dirname, '..');
const temporaryRoots = new Set();
const schemas = {};
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

before(async () => {
  const schemaFiles = {
    handoff: 'handoff-v2.schema.json',
    output: 'coordinator-output-v2.schema.json',
    task: 'task.schema.json',
    evidence: 'evidence-manifest.schema.json',
    projectContext: 'project-context.schema.json',
  };
  for (const [key, filename] of Object.entries(schemaFiles)) {
    schemas[key] = await loadSchema(path.join(repoRoot, '.coordination', filename));
  }
});

after(async () => {
  const tempRoot = path.resolve(os.tmpdir());
  for (const root of temporaryRoots) {
    const resolved = path.resolve(root);
    assert.equal(path.relative(tempRoot, resolved).startsWith('..'), false);
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

async function makeTemporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-coordination-v2-test-'));
  temporaryRoots.add(root);
  return root;
}

function makeHandoff(overrides = {}) {
  return {
    version: '2.0',
    submissionId: 'task-v2-r1-report',
    taskId: 'task-v2',
    revision: 1,
    previousRevision: null,
    domain: 'ui-ux',
    sourceChat: 'chat:ui-ux',
    createdAt: '2026-07-23T12:00:00.000Z',
    status: 'completed',
    executionKind: 'initial',
    approvedProposalHash: null,
    approvedPrompt: null,
    objective: 'Validar el ciclo coordinado v2.',
    summary: 'Entrega sintética sin datos reales.',
    changes: ['Cambio sintético'],
    filesCreated: [],
    filesModified: ['assets/css/styles.css'],
    validationsExecuted: ['Prueba sintética'],
    validationsPending: [],
    risks: [],
    decisionsRequired: [],
    visualImpact: 'material',
    evidenceManifest: '.coordination/evidence/task-v2/manifest.json',
    dataModified: {
      modified: false,
      description: 'No se modificaron datos.',
    },
    suggestedCommit: null,
    gitStatus: ['M assets/css/styles.css'],
    diffSummary: ['Una hoja de estilos modificada.'],
    ...overrides,
  };
}

function makeCategoryAudit(presentCategories = []) {
  const presentSet = new Set(presentCategories);
  return AUDITABLE_VISUAL_CATEGORIES.map((category) => {
    const present = presentSet.has(category);
    return {
      category,
      status: present ? 'present' : 'absent',
      description: present
        ? `La revisión confirma una manifestación visible de ${category}.`
        : `La revisión no encuentra una manifestación visible de ${category}.`,
      evidence: present
        ? `La región inspeccionada contiene elementos concretos que respaldan ${category}.`
        : null,
      severity: present ? 'medium' : null,
    };
  });
}

function makeOutput(overrides = {}) {
  return {
    version: '2.0',
    taskId: 'task-v2',
    revision: 1,
    domain: 'ui-ux',
    targetDomain: 'ui-ux',
    verdict: 'continue',
    summary: 'La entrega requiere un ajuste localizado.',
    findings: ['La acción principal necesita mayor jerarquía.'],
    risks: [],
    blockingQuestions: [],
    visualReview: {
      status: 'reviewed',
      performed: true,
      images: [{
        filename: 'screen.png',
        observations: ['La pantalla muestra el módulo Planes de pago.'],
      }],
      categoryAudit: makeCategoryAudit(['weak_hierarchy']),
      crossImageFindings: ['La pantalla mantiene una composición legible.'],
      confidence: 'high',
    },
    nextPrompt: 'Ajustar únicamente el margen superior y volver a validar.',
    recommendedChanges: [{
      category: 'weak_hierarchy',
      instruction: 'Destacá la acción principal sin alterar el flujo existente.',
      target: 'barra de acciones',
      expectedResult: 'La acción primaria será identificable de inmediato.',
    }],
    userReviewInstructions: 'Revisá el margen superior de la pantalla.',
    closeReason: null,
    evidenceRequired: false,
    proposalHash: 'a'.repeat(64),
    sourceHash: 'b'.repeat(64),
    approvalRequired: true,
    commitMessage: null,
    ...overrides,
  };
}

function makeVisionRunnerOutput(overrides = {}) {
  return makeOutput({
    verdict: 'fix_required',
    summary:
      'ERP DEMO — DATOS FICTICIOS muestra Panel de operaciones, Pedidos pendientes, ' +
      'Alertas activas, Órdenes recientes y DEMO-001.',
    findings: [],
    visualReview: {
      status: 'reviewed',
      performed: true,
      images: [{
        filename: 'synthetic-erp-vision.png',
        observations: [
          'Se ven cuatro KPI, la tabla de Órdenes recientes y DEMO-001.',
          'La cabecera contiene ERP DEMO — DATOS FICTICIOS.',
        ],
      }],
      categoryAudit: makeCategoryAudit([
        'excessive_whitespace',
        'low_contrast',
        'high_density',
        'overflow_or_clipping',
      ]),
      crossImageFindings: ['El contenido principal no se adapta bien al ancho visible.'],
      confidence: 'high',
    },
    nextPrompt:
      'Aplicá las correcciones visuales estructuradas y repetí la validación con la misma captura sintética.',
    recommendedChanges: [
      {
        category: 'overflow_or_clipping',
        instruction: 'Reorganizá las columnas para evitar que el contenido quede cortado.',
        target: 'tabla Órdenes recientes',
        expectedResult: 'La tabla será legible sin desplazamiento horizontal.',
      },
      {
        category: 'low_contrast',
        instruction: 'Aumentá la diferencia tonal del texto secundario respecto del fondo.',
        target: 'estado bajo Alertas activas',
        expectedResult: 'El estado podrá leerse con claridad.',
      },
      {
        category: 'excessive_whitespace',
        instruction: 'Redistribuí los KPI para aprovechar el ancho disponible.',
        target: 'fila de tarjetas KPI',
        expectedResult: 'El panel tendrá una composición equilibrada.',
      },
    ],
    ...overrides,
  });
}

function makeAuthorizedTwoEvidenceOutput() {
  const output = makeOutput({
    verdict: 'fix_required',
    visualReview: {
      status: 'reviewed',
      performed: true,
      images: [
        {
          filename: 'screen-a.png',
          observations: [
            'screen-a.png muestra el encabezado y la primera acción sintética.',
          ],
        },
        {
          filename: 'screen-b.png',
          observations: [
            'screen-b.png muestra la tabla y la segunda acción sintética.',
          ],
        },
      ],
      categoryAudit: makeCategoryAudit(['weak_hierarchy']),
      crossImageFindings: [
        'screen-a.png y screen-b.png mantienen la misma jerarquía débil de acciones.',
      ],
      confidence: 'high',
    },
    nextPrompt:
      'Diferenciá la acción primaria en ambas capturas sintéticas y repetí la validación.',
    recommendedChanges: [{
      category: 'weak_hierarchy',
      instruction: 'Diferenciá visualmente la acción primaria de las secundarias.',
      target: 'barras de acciones sintéticas',
      expectedResult: 'La acción primaria se reconoce inmediatamente en ambas pantallas.',
    }],
  });
  const hierarchy = output.visualReview.categoryAudit.find(
    (entry) => entry.category === 'weak_hierarchy',
  );
  hierarchy.description =
    'La jerarquía de acciones resulta débil en screen-a.png y screen-b.png.';
  hierarchy.evidence =
    'screen-a.png y screen-b.png muestran botones principales y secundarios con el mismo peso.';
  return output;
}

function makeManifest(taskId, buffer, overrides = {}) {
  const filename = overrides.filename || 'screen.png';
  const imageOverrides = overrides.image || {};
  return {
    version: '2.0',
    taskId,
    revision: 1,
    createdAt: '2026-07-23T12:00:00.000Z',
    visualImpact: 'material',
    readOnlyCaptureConfirmed: true,
    possiblySensitive: false,
    authorizedForApi: false,
    sensitiveReason: null,
    images: [{
      filename,
      path: `.coordination/evidence/${taskId}/${filename}`,
      mimeType: 'image/png',
      sizeBytes: buffer.length,
      sha256: sha256Buffer(buffer),
      viewport: {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
      },
      screen: 'Planes de pago',
      state: 'Consulta sin datos reales',
      capturedAt: '2026-07-23T12:00:00.000Z',
      visualImpact: 'material',
      readOnlyCaptureConfirmed: true,
      possiblySensitive: false,
      authorizedForApi: false,
      sensitiveReason: null,
      ...imageOverrides,
    }],
    ...Object.fromEntries(
      Object.entries(overrides)
        .filter(([key]) => !['filename', 'image'].includes(key)),
    ),
  };
}

async function writeEvidenceFixture(options = {}) {
  const root = options.root || await makeTemporaryRoot();
  const taskId = options.taskId || 'task-evidence';
  const buffer = options.buffer || ONE_PIXEL_PNG;
  const directory = path.join(root, '.coordination', 'evidence', taskId);
  await fs.mkdir(directory, { recursive: true });
  const manifest = makeManifest(taskId, buffer, options.manifestOverrides || {});
  const imagePath = path.join(directory, manifest.images[0].filename);
  await fs.writeFile(imagePath, buffer);
  await fs.writeFile(
    path.join(directory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { root, taskId, directory, manifest, imagePath };
}

async function writeTwoAuthorizedEvidenceFixture() {
  const root = await makeTemporaryRoot();
  const taskId = 'task-two-authorized-evidence-files';
  const directory = path.join(root, '.coordination', 'evidence', taskId);
  const buffers = [
    ONE_PIXEL_PNG,
    Buffer.concat([
      ONE_PIXEL_PNG,
      Buffer.from('\nsecond-safe-synthetic-image\n'),
    ]),
  ];
  const filenames = ['screen-a.png', 'screen-b.png'];
  const manifest = makeManifest(taskId, buffers[0], {
    possiblySensitive: true,
    authorizedForApi: true,
    sensitiveReason: 'Capturas sintéticas autorizadas para la prueba.',
    image: {
      possiblySensitive: true,
      authorizedForApi: true,
      sensitiveReason: 'Captura sintética autorizada para la prueba.',
    },
  });
  manifest.images = filenames.map((filename, index) => ({
    ...manifest.images[0],
    filename,
    path: `.coordination/evidence/${taskId}/${filename}`,
    sizeBytes: buffers[index].length,
    sha256: sha256Buffer(buffers[index]),
    screen: `Pantalla sintética ${index + 1}`,
    state: `Estado sintético autorizado ${index + 1}`,
  }));

  await fs.mkdir(directory, { recursive: true });
  await Promise.all(filenames.map((filename, index) =>
    fs.writeFile(path.join(directory, filename), buffers[index])));
  await fs.writeFile(
    path.join(directory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { root, taskId, manifest };
}

test('v2 schemas accept the complete contracts and permanent manifest', async () => {
  assert.doesNotThrow(() => assertSchema(makeHandoff(), schemas.handoff, 'handoff v2'));
  assert.doesNotThrow(() => assertSchema(makeOutput(), schemas.output, 'output v2'));
  const projectContext = JSON.parse(await fs.readFile(
    path.join(repoRoot, '.coordination', 'project-context.json'),
    'utf8',
  ));
  assert.doesNotThrow(() =>
    assertSchema(projectContext, schemas.projectContext, 'project context'));
  const operationalDocument = JSON.parse(JSON.stringify(projectContext));
  operationalDocument.globalSources[0].path = 'docs/REPORTE_OPERATIVO.md';
  assert.throws(
    () => assertSchema(
      operationalDocument,
      schemas.projectContext,
      'project context operativo',
    ),
    (error) => error.code === 'SCHEMA_VALIDATION_FAILED',
  );
  assert.deepEqual(
    normalizeSchemaForStructuredOutputs(schemas.output).properties.approvalRequired.enum,
    [true],
  );
});

test('TaskStore preserves original intent, objective, decisions and bounded context', async () => {
  const root = await makeTemporaryRoot();
  const store = new TaskStore({
    repoRoot: root,
    taskSchema: schemas.task,
  });
  await store.create({
    taskId: 'task-store-v2',
    sourceChat: 'chat:coordinador',
    originalRequest: 'Quiero mejorar la lectura de la pantalla de prueba.',
    objective: 'Hacer comprensible la jerarquía sin cambiar datos.',
    initialDomain: 'ui-ux',
    initialPrompt: 'Inspeccioná la pantalla sintética y aplicá el cambio acotado.',
  });
  await store.recordRevision('task-store-v2', {
    revision: 1,
    submissionId: 'task-store-v2-r1-report',
    domain: 'ui-ux',
    handoffHash: '1'.repeat(64),
    summary: 'Primera entrega sintética.',
  });
  await store.recordObservation('task-store-v2', {
    revision: 1,
    text: 'El margen todavía parece demasiado grande.',
  });
  await store.recordDecision('task-store-v2', {
    revision: 1,
    domain: 'ui-ux',
    text: 'Conservar la estructura existente.',
  });
  await store.recordApproval('task-store-v2', {
    revision: 1,
    proposalHash: '2'.repeat(64),
    domain: 'ui-ux',
    targetDomain: 'ui-ux',
    prompt: 'Reducir solamente el margen superior.',
    approvedBy: 'usuario',
  });
  const task = await store.load('task-store-v2');
  assert.equal(task.nextRevision, 2);
  assert.equal(task.observations.length, 1);
  assert.equal(task.decisions.length, 1);
  assert.equal(task.approvals.length, 1);
  const context = await store.context('task-store-v2');
  assert.equal(context.originalRequest, task.originalRequest);
  assert.equal(context.objective, task.objective);
  assert.equal(context.decisions[0].text, 'Conservar la estructura existente.');
  assert.equal(context.approvals[0].prompt, 'Reducir solamente el margen superior.');
});

test('EvidenceService validates MIME, hash and emits real image data', async () => {
  const fixture = await writeEvidenceFixture();
  const service = new EvidenceService({
    repoRoot: fixture.root,
    manifestSchema: schemas.evidence,
    config: {
      maxEvidenceImages: 2,
      maxEvidenceImageBytes: 1024 * 1024,
      maxEvidenceTotalBytes: 2 * 1024 * 1024,
      evidenceImageDetail: 'high',
    },
  });
  const result = await service.prepareEvidenceInputs({
    taskId: fixture.taskId,
    revision: 1,
    visualImpact: 'material',
  });
  assert.equal(result.blocked, false);
  assert.deepEqual(result.evidenceIds, ['screen.png']);
  assert.equal(result.images[0].mimeType, 'image/png');
  assert.match(result.images[0].dataUrl, /^data:image\/png;base64,/);
  assert.equal(result.inputImages[0].type, 'input_image');
  assert.equal(result.inputImages[0].detail, 'high');
  assert.equal(Object.hasOwn(result.inputImages[0], 'path'), false);
});

test('EvidenceService emits two explicitly authorized synthetic evidences atomically', async () => {
  const fixture = await writeTwoAuthorizedEvidenceFixture();
  const service = new EvidenceService({
    repoRoot: fixture.root,
    manifestSchema: schemas.evidence,
    config: {
      maxEvidenceImages: 2,
      maxEvidenceImageBytes: 1024 * 1024,
      maxEvidenceTotalBytes: 2 * 1024 * 1024,
      evidenceImageDetail: 'high',
    },
  });

  const result = await service.prepareEvidenceInputs({
    taskId: fixture.taskId,
    revision: 1,
    visualImpact: 'material',
  });

  assert.equal(fixture.manifest.authorizedForApi, true);
  assert.equal(
    fixture.manifest.images.every((image) => image.authorizedForApi === true),
    true,
  );
  assert.equal(result.blocked, false);
  assert.deepEqual(result.evidenceIds, ['screen-a.png', 'screen-b.png']);
  assert.equal(result.images.length, 2);
  assert.equal(result.inputImages.length, 2);
  assert.equal(
    result.inputImages.every(
      (image) =>
        image.type === 'input_image' &&
        image.detail === 'high' &&
        /^data:image\/png;base64,/.test(image.image_url) &&
        !Object.hasOwn(image, 'path'),
    ),
    true,
  );
});

test('EvidenceService blocks traversal, invalid MIME and configured excess', async () => {
  const fixture = await writeEvidenceFixture();
  const service = new EvidenceService({
    repoRoot: fixture.root,
    manifestSchema: schemas.evidence,
  });
  await assert.rejects(
    () => service.prepareEvidenceInputs({
      taskId: fixture.taskId,
      manifestPath: `.coordination/evidence/${fixture.taskId}/../manifest.json`,
    }),
    (error) => error.code === 'EVIDENCE_MANIFEST_PATH_INVALID',
  );

  const invalidFixture = await writeEvidenceFixture({
    buffer: Buffer.from('not-an-image'),
  });
  const invalidService = new EvidenceService({
    repoRoot: invalidFixture.root,
    manifestSchema: schemas.evidence,
  });
  await assert.rejects(
    () => invalidService.prepareEvidenceInputs({ taskId: invalidFixture.taskId }),
    (error) => error.code === 'EVIDENCE_MIME_MISMATCH',
  );

  const limitedService = new EvidenceService({
    repoRoot: fixture.root,
    manifestSchema: schemas.evidence,
    maxImageBytes: 1,
  });
  await assert.rejects(
    () => limitedService.prepareEvidenceInputs({ taskId: fixture.taskId }),
    (error) => error.code === 'EVIDENCE_IMAGE_TOO_LARGE',
  );
});

test('sensitive evidence needs explicit authorization and hard secrets never pass', async () => {
  const sensitive = await writeEvidenceFixture({
    manifestOverrides: {
      possiblySensitive: true,
      authorizedForApi: false,
      sensitiveReason: 'La captura puede contener un identificador.',
      image: {
        possiblySensitive: true,
        authorizedForApi: false,
        sensitiveReason: 'Posible identificador visible.',
      },
    },
  });
  const sensitiveService = new EvidenceService({
    repoRoot: sensitive.root,
    manifestSchema: schemas.evidence,
  });
  const blocked = await sensitiveService.prepareEvidenceInputs({
    taskId: sensitive.taskId,
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.inputImages.length, 0);
  assert.equal(blocked.blockedReasons[0].code, 'EVIDENCE_AUTHORIZATION_REQUIRED');

  const secretBuffer = Buffer.concat([
    ONE_PIXEL_PNG,
    Buffer.from('\nOPENAI_API_KEY=sk-test-secret-123456789\n'),
  ]);
  const hardSecret = await writeEvidenceFixture({
    buffer: secretBuffer,
    manifestOverrides: {
      possiblySensitive: true,
      authorizedForApi: true,
      sensitiveReason: 'Evidencia autorizada para verificar el bloqueo.',
      image: {
        possiblySensitive: true,
        authorizedForApi: true,
        sensitiveReason: 'Evidencia autorizada para verificar el bloqueo.',
      },
    },
  });
  const hardSecretService = new EvidenceService({
    repoRoot: hardSecret.root,
    manifestSchema: schemas.evidence,
  });
  const secretBlocked = await hardSecretService.prepareEvidenceInputs({
    taskId: hardSecret.taskId,
  });
  assert.equal(secretBlocked.blocked, true);
  assert.equal(secretBlocked.inputImages.length, 0);
  assert.equal(
    secretBlocked.blockedReasons[0].code,
    'EVIDENCE_HARD_SECRET_DETECTED',
  );
});

test('coordinator security permits exact authorized evidence names only in visual fields', () => {
  const output = makeAuthorizedTwoEvidenceOutput();
  const evidenceReferences = [
    {
      evidenceId: 'evidence-a',
      filename: 'screen-a.png',
      path: 'C:\\ignored\\screen-a.png',
    },
    {
      evidenceId: 'evidence-b',
      filename: 'screen-b.png',
      path: '../ignored/screen-b.png',
    },
  ];

  assert.doesNotThrow(() => assertSafeCoordinatorOutput(
    output,
    'Salida v2 con dos evidencias autorizadas',
    { evidenceReferences },
  ));
  assert.doesNotThrow(() => assertSafeCoordinatorOutput(
    output,
    'Salida v2 con referencias canónicas derivadas',
  ));
  assert.doesNotThrow(() => assertSafeCoordinatorOutput(
    output,
    'Salida v2 con referencias string',
    { evidenceReferences: ['screen-a.png', 'screen-b.png'] },
  ));
});

test('coordinator security rejects unlisted files, unsafe routes and embedded content', () => {
  const evidenceReferences = [
    { evidenceId: 'evidence-a', filename: 'screen-a.png' },
    { evidenceId: 'evidence-b', filename: 'screen-b.png' },
  ];
  const cases = [
    {
      name: 'filename canónico no listado',
      expectedCode: 'FORBIDDEN_FILE_REFERENCE',
      mutate(output) {
        output.visualReview.images[1].filename = 'screen-c.png';
      },
    },
    {
      name: 'filename narrativo no listado',
      expectedCode: 'FORBIDDEN_FILE_REFERENCE',
      mutate(output) {
        output.visualReview.images[0].observations[0] =
          'La comparación incorpora también screen-c.png';
      },
    },
    {
      name: 'ruta relativa no autorizada',
      expectedCode: 'FORBIDDEN_FILE_REFERENCE',
      mutate(output) {
        output.visualReview.images[0].observations[0] =
          'La captura proviene de screens/screen-a.png';
      },
    },
    {
      name: 'ruta absoluta',
      expectedCode: 'PATH_OUTSIDE_ALLOWED_ROOT',
      mutate(output) {
        output.visualReview.images[0].observations[0] =
          'La captura está en C:\\Users\\persona\\screen-a.png.';
      },
    },
    {
      name: 'traversal',
      expectedCode: 'PATH_OUTSIDE_ALLOWED_ROOT',
      mutate(output) {
        output.visualReview.images[0].observations[0] = '../screen-a.png';
      },
    },
    {
      name: 'URL externa',
      expectedCode: 'PATH_OUTSIDE_ALLOWED_ROOT',
      mutate(output) {
        output.visualReview.images[0].observations[0] =
          'La captura está en https://example.invalid/screen-a.png.';
      },
    },
    {
      name: 'secreto',
      expectedCode: 'SENSITIVE_CONTENT',
      mutate(output) {
        output.visualReview.images[0].observations[0] =
          'Token sintético sk-test-secret-123456789.';
      },
    },
    {
      name: 'data URL',
      expectedCode: 'EMBEDDED_BINARY_CONTENT',
      mutate(output) {
        output.visualReview.images[0].observations[0] =
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
      },
    },
    {
      name: 'bloque base64',
      expectedCode: 'EMBEDDED_BINARY_CONTENT',
      mutate(output) {
        output.visualReview.crossImageFindings[0] = 'A'.repeat(2_100);
      },
    },
  ];

  for (const testCase of cases) {
    const output = makeAuthorizedTwoEvidenceOutput();
    testCase.mutate(output);
    assert.throws(
      () => assertSafeCoordinatorOutput(
        output,
        `Salida insegura: ${testCase.name}`,
        { evidenceReferences },
      ),
      (error) => error.code === testCase.expectedCode,
      testCase.name,
    );
  }
  assert.throws(
    () => assertSafeCoordinatorOutput(
      makeAuthorizedTwoEvidenceOutput(),
      'Salida con evidenceId binario no visual',
      {
        evidenceReferences: [
          { evidenceId: 'report.pdf', filename: 'screen-a.png' },
          { evidenceId: 'screen-b.png', filename: 'screen-b.png' },
        ],
      },
    ),
    (error) => error.code === 'FORBIDDEN_FILE_REFERENCE',
  );
});

test('visual contract requires the exact authorized A+B evidence set', () => {
  const output = makeAuthorizedTwoEvidenceOutput();
  const expectedEvidenceIds = ['screen-a.png', 'screen-b.png'];
  const schemaValidation = validateSchema(output, schemas.output);
  const complete = validateStructuredVisualOutput(output, {
    expectedEvidenceIds,
    minimumRecommendedChanges: 1,
  });

  assert.equal(schemaValidation.valid, true, schemaValidation.errors.join('\n'));
  assert.equal(complete.passed, true, JSON.stringify(complete.errors));

  const incomplete = JSON.parse(JSON.stringify(output));
  incomplete.visualReview.images = incomplete.visualReview.images.filter(
    (image) => image.filename !== 'screen-b.png',
  );
  const incompleteValidation = validateStructuredVisualOutput(incomplete, {
    expectedEvidenceIds,
    minimumRecommendedChanges: 1,
  });
  assert.equal(incompleteValidation.passed, false);
  assert.equal(
    incompleteValidation.errors.some(
      (error) => error.code === 'VISUAL_EVIDENCE_NOT_FULLY_REVIEWED',
    ),
    true,
  );
});

test('context uses permanent/runtime sources and never substitutes a path for an image', async () => {
  const fixture = await writeEvidenceFixture({ taskId: 'task-v2' });
  await fs.mkdir(path.join(fixture.root, '.agents'), { recursive: true });
  await fs.writeFile(
    path.join(fixture.root, '.agents', 'ui-ux.md'),
    '# Especialista UI/UX sintético\n',
  );
  const evidence = await new EvidenceService({
    repoRoot: fixture.root,
    manifestSchema: schemas.evidence,
  }).prepareEvidenceInputs({ taskId: fixture.taskId });
  const config = validateConfig({
    maxTotalContextBytes: 64 * 1024,
    maxContextFileBytes: 8 * 1024,
    maxDiffBytes: 4 * 1024,
    maxHandoffBytes: 32 * 1024,
  }, 'config v2 de test');
  const projectContext = {
    version: '1.0',
    description: 'Contexto sintético.',
    globalSources: [{
      label: 'AGENTS.md',
      path: 'AGENTS.md',
      required: false,
      selection: 'full',
    }],
    domainAgentFiles: {
      'ui-ux': '.agents/ui-ux.md',
    },
    architectureSource: {
      label: 'ARQUITECTURA RELEVANTE',
      path: 'docs/architecture.md',
      required: false,
      selection: 'relevant-sections',
    },
  };
  const taskContext = {
    taskId: 'task-v2',
    status: 'awaiting_review',
    originalRequest: 'Pedido original sintético.',
    objective: 'Objetivo sintético.',
    initialDomain: 'ui-ux',
    currentDomain: 'ui-ux',
    initialPrompt: 'Prompt inicial sintético.',
    historySummary: 'Una entrega.',
    nextRevision: 2,
    revisions: [],
    observations: [],
    decisions: [],
    approvals: [],
    transfers: [],
    recentEvents: [],
  };
  const options = {
    repoRoot: fixture.root,
    handoff: makeHandoff(),
    taskContext,
    evidence,
    projectContext,
    config,
    execGit: async () => ({ stdout: '', stderr: '' }),
  };
  const context = await buildCoordinatorContext(options);
  assert.match(context, /===== SOLICITUD ORIGINAL =====/);
  assert.match(context, /===== OBJETIVO DE LA TAREA =====/);
  assert.match(context, /===== CONTEXTO RUNTIME RESUMIDO =====/);
  assert.match(context, /===== EVIDENCIAS VISUALES VALIDADAS =====/);
  assert.equal(context.includes('data:image/png;base64,'), false);
  assert.equal(context.includes('.coordination/evidence/'), false);

  const input = await buildCoordinatorInput(options);
  const imageBlock = input[0].content.find((entry) => entry.type === 'input_image');
  assert.match(imageBlock.image_url, /^data:image\/png;base64,/);
  assert.equal(Object.hasOwn(imageBlock, 'path'), false);

  await assert.rejects(
    () => buildCoordinatorContext({
      ...options,
      projectContext: {
        ...projectContext,
        globalSources: [{
          ...projectContext.globalSources[0],
          required: true,
        }],
      },
    }),
    (error) => error.code === 'REQUIRED_PROJECT_CONTEXT_MISSING',
  );
});

test('multimodal evidence limits must fit the bounded OpenAI request', () => {
  assert.throws(
    () => validateConfig({
      maxEvidenceImageBytes: 5 * 1024 * 1024,
      maxEvidenceTotalBytes: 20 * 1024 * 1024,
    }, 'config multimodal insegura'),
    (error) => error.code === 'INVALID_CONFIG',
  );
});

test('OpenAI client keeps text compatibility and sends validated multimodal blocks', async () => {
  const normalizedText = normalizeResponsesInput('Contexto legacy.');
  assert.equal(normalizedText, 'Contexto legacy.');
  assert.throws(
    () => normalizeResponsesInput('Contexto.', [{ image_url: 'C:\\capture.png' }]),
    (error) => error.code === 'OPENAI_INVALID_IMAGE_INPUT',
  );

  let capturedBody;
  let responseMetadata;
  const client = new OpenAIResponsesClient({
    apiKey: 'clave-solo-para-test',
    model: 'modelo-solo-para-test',
    onResponseMetadata(metadata) {
      responseMetadata = metadata;
    },
    fetchImpl: async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      const transport = Buffer.from(JSON.stringify({
        id: 'resp_model_metadata_test',
        model: 'modelo-solo-para-test',
        status: 'completed',
        output: [{
          type: 'message',
          content: [{
            type: 'output_text',
            text: JSON.stringify(makeOutput()),
          }],
        }],
      }));
      return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        async arrayBuffer() {
          return transport;
        },
      };
    },
  });
  await client.createStructuredResponse({
    instructions: 'Revisar evidencia sintética.',
    input: 'Contexto sintético.',
    images: [{
      dataUrl: `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}`,
      detail: 'high',
    }],
    schemaName: 'coordinator_output_v2',
    schema: schemas.output,
  });
  assert.equal(capturedBody.store, false);
  assert.equal(capturedBody.text.format.strict, true);
  assert.equal(capturedBody.input[0].content[1].type, 'input_image');
  assert.match(capturedBody.input[0].content[1].image_url, /^data:image\/png;base64,/);
  assert.equal(
    JSON.stringify(capturedBody.input).includes('.coordination/evidence'),
    false,
  );
  assert.deepEqual(responseMetadata, {
    id: 'resp_model_metadata_test',
    model: 'modelo-solo-para-test',
  });
});

test('versioned project context can be loaded without copying its source content', async () => {
  const manifest = await loadProjectContextManifest(repoRoot);
  assert.equal(manifest.version, '1.0');
  assert.equal(manifest.domainAgentFiles.contabilidad, '.agents/contabilidad.md');
  assert.equal(
    manifest.globalSources.some((entry) => entry.path === '.agents/file-ownership.md'),
    true,
  );
});

test('vision prompt requires a neutral category-by-category audit without revealing the threshold', () => {
  for (const category of AUDITABLE_VISUAL_CATEGORIES) {
    assert.match(VISUAL_CATEGORY_AUDIT_PROMPT, new RegExp(category));
  }
  assert.match(VISUAL_CATEGORY_AUDIT_PROMPT, /present, absent o uncertain/);
  assert.match(VISUAL_CATEGORY_AUDIT_PROMPT, /evidencia propia/i);
  assert.match(VISUAL_CATEGORY_AUDIT_PROMPT, /no marques present/i);
  assert.doesNotMatch(
    VISUAL_CATEGORY_AUDIT_PROMPT,
    /4\s*\/\s*7|m[ií]nimo\s+4|siete defectos|seven defects/i,
  );
});

test('structured output schema preserves three discriminated categoryAudit variants', () => {
  const normalized = normalizeSchemaForStructuredOutputs(schemas.output);
  const visualReviewSchema = normalized.properties.visualReview;
  const variants =
    visualReviewSchema.properties.categoryAudit.items.anyOf;

  assert.equal(variants.length, 3);
  assert.deepEqual(
    variants.map((variant) => variant.$ref),
    [
      '#/$defs/visualAuditPresent',
      '#/$defs/visualAuditAbsent',
      '#/$defs/visualAuditUncertain',
    ],
  );
  assert.deepEqual(
    normalized.$defs.visualAuditPresent.properties.status.enum,
    ['present'],
  );
  assert.deepEqual(
    normalized.$defs.visualAuditAbsent.properties.severity.type,
    'null',
  );
  assert.deepEqual(
    normalized.$defs.visualAuditUncertain.properties.evidence.type,
    ['string', 'null'],
  );
  assert.equal(
    Object.hasOwn(visualReviewSchema.properties, 'detectedCategories'),
    false,
  );
  assert.equal(
    Object.hasOwn(
      visualReviewSchema.properties.images.items.properties,
      'detectedIssues',
    ),
    false,
  );
});

test('present accepts only low, medium or high severity', () => {
  for (const severity of ['low', 'medium', 'high']) {
    const output = makeOutput();
    output.visualReview.categoryAudit.find(
      (audit) => audit.category === 'weak_hierarchy',
    ).severity = severity;
    const schemaValidation = validateSchema(output, schemas.output);
    const semanticValidation = validateStructuredVisualOutput(output);

    assert.equal(schemaValidation.valid, true);
    assert.equal(semanticValidation.passed, true);
  }
});

test('present with null severity is rejected by schema and semantics', () => {
  const output = makeOutput();
  output.visualReview.categoryAudit.find(
    (audit) => audit.category === 'weak_hierarchy',
  ).severity = null;

  const schemaValidation = validateSchema(output, schemas.output);
  const semanticValidation = validateStructuredVisualOutput(output);

  assert.equal(schemaValidation.valid, false);
  assert.equal(
    semanticValidation.errors.some(
      (error) => error.code === 'VISUAL_CATEGORY_SEVERITY_REQUIRED',
    ),
    true,
  );
});

test('absent with non-null severity is rejected by schema and semantics', () => {
  const output = makeVisionRunnerOutput();
  const absent = output.visualReview.categoryAudit.find(
    (audit) => audit.category === 'misalignment',
  );
  absent.severity = 'low';

  const schemaValidation = validateSchema(output, schemas.output);
  const semanticValidation = validateStructuredVisualOutput(output);

  assert.equal(schemaValidation.valid, false);
  assert.equal(
    semanticValidation.errors.some(
      (error) => error.code === 'VISUAL_CATEGORY_SEVERITY_UNEXPECTED',
    ),
    true,
  );
});

test('absent requires null evidence in schema and semantics', () => {
  const output = makeVisionRunnerOutput();
  const absent = output.visualReview.categoryAudit.find(
    (audit) => audit.category === 'misalignment',
  );
  absent.evidence =
    'La categoría ausente no debe transportar evidencia narrativa adicional.';

  const schemaValidation = validateSchema(output, schemas.output);
  const semanticValidation = validateStructuredVisualOutput(output);

  assert.equal(schemaValidation.valid, false);
  assert.equal(
    semanticValidation.errors.some(
      (error) => error.code === 'VISUAL_CATEGORY_EVIDENCE_UNEXPECTED',
    ),
    true,
  );
});

test('uncertain with non-null severity is rejected by schema and semantics', () => {
  const output = makeVisionRunnerOutput();
  const uncertain = output.visualReview.categoryAudit.find(
    (audit) => audit.category === 'responsive_layout',
  );
  uncertain.status = 'uncertain';
  uncertain.description =
    'Una sola captura no permite confirmar el comportamiento en otros anchos.';
  uncertain.evidence =
    'Solo existe un viewport fijo, por lo que la adaptación adicional es insuficiente.';
  uncertain.severity = 'medium';

  const schemaValidation = validateSchema(output, schemas.output);
  const semanticValidation = validateStructuredVisualOutput(output);

  assert.equal(schemaValidation.valid, false);
  assert.equal(
    semanticValidation.errors.some(
      (error) => error.code === 'VISUAL_CATEGORY_SEVERITY_UNEXPECTED',
    ),
    true,
  );
});

test('complete category audit covers every required category exactly once', () => {
  const output = makeVisionRunnerOutput();
  const validation = validateStructuredVisualOutput(output, {
    expectedEvidenceIds: ['synthetic-erp-vision.png'],
    minimumRecommendedChanges: 2,
  });
  const categories = output.visualReview.categoryAudit.map(
    (audit) => audit.category,
  );

  assert.equal(validation.passed, true);
  assert.deepEqual(new Set(categories), new Set(AUDITABLE_VISUAL_CATEGORIES));
  assert.equal(categories.length, AUDITABLE_VISUAL_CATEGORIES.length);
});

test('detected categories and issues are derived only from canonical categoryAudit', () => {
  const output = makeVisionRunnerOutput();
  const derived = deriveVisualFindings(output.visualReview.categoryAudit);
  const validation = validateStructuredVisualOutput(output, {
    expectedEvidenceIds: ['synthetic-erp-vision.png'],
    minimumRecommendedChanges: 2,
  });
  const expectedCategories = [
    'excessive_whitespace',
    'low_contrast',
    'high_density',
    'overflow_or_clipping',
  ];

  assert.deepEqual(derived.detectedCategories, expectedCategories);
  assert.deepEqual(validation.detectedCategories, expectedCategories);
  assert.deepEqual(validation.detectedIssues, derived.detectedIssues);
  assert.deepEqual(
    derived.detectedIssues.map((issue) => Object.keys(issue).sort()),
    expectedCategories.map(() =>
      ['category', 'description', 'evidence', 'severity']),
  );
  assert.equal(
    derived.detectedIssues.every((issue) => issue.status === undefined),
    true,
  );
});

test('legacy duplicated visual conclusions are not part of the model contract', () => {
  const output = makeVisionRunnerOutput();
  output.visualReview.detectedCategories = ['low_contrast'];
  output.visualReview.images[0].detectedIssues = [{
    category: 'low_contrast',
    severity: 'high',
    description: 'Conclusión redundante que ya existe en categoryAudit.',
    evidence: 'Este campo legado no pertenece a la salida canónica.',
  }];

  const schemaValidation = validateSchema(output, schemas.output);

  assert.equal(schemaValidation.valid, false);
  assert.equal(
    schemaValidation.errors.some(
      (message) => message.includes('detectedCategories'),
    ),
    true,
  );
  assert.equal(
    schemaValidation.errors.some(
      (message) => message.includes('detectedIssues'),
    ),
    true,
  );
});

test('absent category is valid without issue, declaration or severity', () => {
  const output = makeVisionRunnerOutput();
  const absent = output.visualReview.categoryAudit.find(
    (audit) => audit.category === 'misalignment',
  );
  const derived = deriveVisualFindings(output.visualReview.categoryAudit);
  const validation = validateStructuredVisualOutput(output, {
    expectedEvidenceIds: ['synthetic-erp-vision.png'],
    minimumRecommendedChanges: 2,
  });

  assert.equal(absent.status, 'absent');
  assert.equal(absent.severity, null);
  assert.equal(
    derived.detectedCategories.includes('misalignment'),
    false,
  );
  assert.equal(
    derived.detectedIssues.some(
      (issue) => issue.category === 'misalignment',
    ),
    false,
  );
  assert.equal(validation.passed, true);
});

test('uncertain category is valid when the evidence explains the limitation', () => {
  const output = makeVisionRunnerOutput();
  const uncertain = output.visualReview.categoryAudit.find(
    (audit) => audit.category === 'responsive_layout',
  );
  uncertain.status = 'uncertain';
  uncertain.description =
    'Una captura fija no permite confirmar el comportamiento en otros anchos.';
  uncertain.evidence =
    'Solo se observa un viewport de escritorio y no existen vistas de quiebre adicionales.';
  uncertain.severity = null;

  const validation = validateStructuredVisualOutput(output, {
    expectedEvidenceIds: ['synthetic-erp-vision.png'],
    minimumRecommendedChanges: 2,
  });

  assert.equal(validation.passed, true);
  assert.equal(
    validation.presentCategories.includes('responsive_layout'),
    false,
  );
});

test('present category without concrete audit evidence is rejected specifically', () => {
  const output = makeVisionRunnerOutput();
  const present = output.visualReview.categoryAudit.find(
    (audit) => audit.category === 'excessive_whitespace',
  );
  present.evidence = 'Dato insuficiente';

  const validation = validateStructuredVisualOutput(output, {
    expectedEvidenceIds: ['synthetic-erp-vision.png'],
    minimumRecommendedChanges: 2,
  });

  assert.equal(validation.passed, false);
  assert.equal(
    validation.errors.some(
      (error) => error.code === 'VISUAL_CATEGORY_AUDIT_NOT_GROUNDED',
    ),
    true,
  );
  assert.equal(
    validation.presentCategories.includes('excessive_whitespace'),
    false,
  );
});

test('category audit rejects missing and duplicated category passes', () => {
  const missing = makeVisionRunnerOutput();
  missing.visualReview.categoryAudit.pop();
  const missingValidation = validateStructuredVisualOutput(missing, {
    expectedEvidenceIds: ['synthetic-erp-vision.png'],
    minimumRecommendedChanges: 2,
  });

  const duplicate = makeVisionRunnerOutput();
  duplicate.visualReview.categoryAudit.push({
    ...duplicate.visualReview.categoryAudit[0],
  });
  const duplicateValidation = validateStructuredVisualOutput(duplicate, {
    expectedEvidenceIds: ['synthetic-erp-vision.png'],
    minimumRecommendedChanges: 2,
  });

  assert.equal(
    missingValidation.errors.some(
      (error) => error.code === 'VISUAL_CATEGORY_AUDIT_INCOMPLETE',
    ),
    true,
  );
  assert.equal(
    duplicateValidation.errors.some(
      (error) => error.code === 'VISUAL_CATEGORY_AUDIT_DUPLICATE',
    ),
    true,
  );
});

test('a recommended change for an absent category is rejected', () => {
  const output = makeVisionRunnerOutput();
  const lowContrast = output.visualReview.categoryAudit.find(
    (audit) => audit.category === 'low_contrast',
  );
  lowContrast.status = 'absent';
  lowContrast.severity = null;
  lowContrast.description =
    'No se observa un problema de contraste en la región inspeccionada.';
  lowContrast.evidence = null;

  const validation = validateStructuredVisualOutput(output, {
    expectedEvidenceIds: ['synthetic-erp-vision.png'],
    minimumRecommendedChanges: 2,
  });

  assert.equal(validation.passed, false);
  assert.equal(
    validation.errors.some(
      (error) => error.code === 'RECOMMENDED_CHANGE_CATEGORY_MISMATCH',
    ),
    true,
  );
});

test('narrative categories are not invented by the structured evaluator', () => {
  const output = makeVisionRunnerOutput();
  output.summary +=
    ' La narrativa también menciona legibilidad, accesibilidad y desalineación.';

  const signals = collectStructuredVisualSignals(output);

  assert.deepEqual(signals.verifiedCategories, [
    'excessive_whitespace',
    'low_contrast',
    'high_density',
    'overflow_or_clipping',
  ]);
  assert.equal(
    signals.structuredValidation.presentCategories.includes('readability'),
    false,
  );
  assert.equal(
    signals.structuredValidation.presentCategories.includes(
      'accessibility_visual',
    ),
    false,
  );
});

test('an image with only two real issues keeps a valid contract but fails the 4-of-7 perception threshold', () => {
  const output = makeVisionRunnerOutput();
  const realCategories = ['low_contrast', 'overflow_or_clipping'];
  output.visualReview.categoryAudit = makeCategoryAudit(realCategories);
  output.recommendedChanges = output.recommendedChanges.filter(
    (change) => realCategories.includes(change.category),
  );

  const contract = validateVisionOutputContract(output);
  const perception = evaluateVisualPerception(output);

  assert.equal(contract.passed, true);
  assert.equal(perception.matchedCategories.length, 2);
  assert.equal(perception.requiredCategoryMatches, 4);
  assert.equal(perception.passed, false);
});

test('a synthetic review with seven grounded issues passes the unchanged 4-of-7 threshold', () => {
  const output = makeVisionRunnerOutput();
  const plantedCategories = [
    'excessive_whitespace',
    'weak_hierarchy',
    'low_contrast',
    'misalignment',
    'high_density',
    'overflow_or_clipping',
    'inconsistent_actions',
  ];
  output.visualReview.categoryAudit = makeCategoryAudit(plantedCategories);

  const contract = validateVisionOutputContract(output);
  const perception = evaluateVisualPerception(output);

  assert.equal(contract.passed, true);
  assert.equal(perception.matchedCategories.length, 7);
  assert.equal(perception.requiredCategoryMatches, 4);
  assert.equal(perception.passed, true);
});

test('systematic synthetic fixture has the validated dimensions and hash', async () => {
  const fixturePath = path.join(
    repoRoot,
    'tests',
    'fixtures',
    'coordination',
    'synthetic-erp-vision-systematic.png',
  );
  const image = await fs.readFile(fixturePath);

  assert.deepEqual(parsePngDimensions(image), {
    width: 1536,
    height: 1024,
  });
  assert.equal(image.length, 1328515);
  assert.equal(
    sha256Buffer(image),
    '13ec94835380eb3f26c2d4c9d620bf19bc763f33273928b9c4fe4f92acd818b1',
  );
});

test('vision runner respects COORDINATOR_MODEL and selects gpt-5.6-terra', () => {
  const keys = [
    'OPENAI_API_KEY',
    'COORDINATOR_MODEL',
    'COORDINATION_REAL_TEST',
    'COORDINATION_REAL_TEST_MODE',
    'COORDINATION_VISION_IMAGE',
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  try {
    process.env.OPENAI_API_KEY = 'synthetic-test-key';
    process.env.COORDINATOR_MODEL = 'gpt-5.6-terra';
    process.env.COORDINATION_REAL_TEST = '1';
    process.env.COORDINATION_REAL_TEST_MODE = 'vision';
    delete process.env.COORDINATION_VISION_IMAGE;

    const environment = environmentBeforeWrites();

    assert.equal(environment.model, 'gpt-5.6-terra');
    assert.equal(environment.mode, 'vision');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('vision runner passes through another configured compatible model', () => {
  const keys = [
    'OPENAI_API_KEY',
    'COORDINATOR_MODEL',
    'COORDINATION_REAL_TEST',
    'COORDINATION_REAL_TEST_MODE',
    'COORDINATION_VISION_IMAGE',
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  try {
    process.env.OPENAI_API_KEY = 'synthetic-test-key';
    process.env.COORDINATOR_MODEL = 'compatible-vision-model';
    process.env.COORDINATION_REAL_TEST = '1';
    process.env.COORDINATION_REAL_TEST_MODE = 'vision';
    delete process.env.COORDINATION_VISION_IMAGE;

    const environment = environmentBeforeWrites();

    assert.equal(environment.model, 'compatible-vision-model');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('vision report identifies the exact Terra model used', () => {
  const output = makeVisionRunnerOutput();
  const perception = evaluateVisualPerception(output);
  const outputContract = validateVisionOutputContract(output);
  const report = finalUserResponse({
    mode: 'vision',
    coordinatorOutput: output,
    presentation: {
      ...output,
      executed: false,
    },
    validations: {
      transport: { passed: true },
      perception,
      outputContract,
      presentation: { passed: true },
    },
    validationFailure: null,
    transportAudit: {
      model: 'gpt-5.6-terra',
      inputImageCount: 1,
      detail: 'high',
      imageSha256:
        '13ec94835380eb3f26c2d4c9d620bf19bc763f33273928b9c4fe4f92acd818b1',
      store: false,
      answerKeyTermsFound: [],
    },
    transportCallCount: 1,
    actualResponseModels: ['gpt-5.6-terra'],
    repairTransportAudit: null,
    reviewValidation: {
      status: 'valid_initially',
    },
    manifest: {
      images: [{
        filename: 'synthetic-erp-vision.png',
        viewport: { width: 1536, height: 1024 },
        sizeBytes: 1328515,
        sha256:
          '13ec94835380eb3f26c2d4c9d620bf19bc763f33273928b9c4fe4f92acd818b1',
      }],
    },
    safety: {
      approvalCount: 0,
      executionActivityCount: 0,
      taskStatus: 'presented',
    },
    sourceRuntimeUnchanged: true,
  });

  assert.match(report, /Modelo: gpt-5\.6-terra\./);
  assert.match(
    report,
    /IDs de modelo informados por Responses API: gpt-5\.6-terra\./,
  );
});

test('structured visual category accepts different wording for the same issue', () => {
  const first = makeVisionRunnerOutput();
  const second = makeVisionRunnerOutput();
  first.visualReview.categoryAudit.find(
    (audit) => audit.category === 'low_contrast',
  ).description =
    'La información auxiliar se pierde contra la superficie clara.';
  second.visualReview.categoryAudit.find(
    (audit) => audit.category === 'low_contrast',
  ).description =
    'Cuesta separar las leyendas secundarias del fondo del panel.';

  const firstSignals = collectStructuredVisualSignals(first);
  const secondSignals = collectStructuredVisualSignals(second);

  assert.equal(firstSignals.verifiedCategories.includes('low_contrast'), true);
  assert.equal(secondSignals.verifiedCategories.includes('low_contrast'), true);
});

test('structured visual category is valid without its literal keyword in prose', () => {
  const output = makeVisionRunnerOutput();
  const audit = output.visualReview.categoryAudit.find(
    (entry) => entry.category === 'excessive_whitespace',
  );
  audit.description = 'Una gran porción del lienzo no aporta información.';
  audit.evidence = 'Después de las cuatro tarjetas queda una franja completamente libre.';

  const categoryValidation = validateVisualCategories(output, {
    expectedEvidenceIds: ['synthetic-erp-vision.png'],
    minimumRecommendedChanges: 2,
  });

  assert.equal(categoryValidation.passed, true);
  assert.equal(
    categoryValidation.detectedCategories.includes('excessive_whitespace'),
    true,
  );
});

test('structured visual category without evidence is rejected specifically', () => {
  const output = makeVisionRunnerOutput();
  output.visualReview.categoryAudit.find(
    (audit) => audit.category === 'excessive_whitespace',
  ).evidence = 'abcdefgh';

  const validation = validateStructuredVisualOutput(output, {
    expectedEvidenceIds: ['synthetic-erp-vision.png'],
    minimumRecommendedChanges: 2,
  });
  const outputContract = validateVisionOutputContract(output);

  assert.equal(validation.passed, false);
  assert.equal(
    validation.errors.some(
      (error) => error.code === 'VISUAL_CATEGORY_AUDIT_NOT_GROUNDED',
    ),
    true,
  );
  assert.equal(outputContract.checks.schemaValid, true);
  assert.equal(outputContract.checks.categoriesValid, false);
  assert.equal(
    outputContract.failureCode,
    'VISUAL_CATEGORY_AUDIT_NOT_GROUNDED',
  );
});

test('unknown structured visual category is rejected by schema and semantics', () => {
  const output = makeVisionRunnerOutput();
  output.visualReview.categoryAudit[0].category = 'layout_balance';

  const schemaValidation = validateSchema(output, schemas.output);
  const semanticValidation = validateStructuredVisualOutput(output, {
    expectedEvidenceIds: ['synthetic-erp-vision.png'],
    minimumRecommendedChanges: 2,
  });
  const outputContract = validateVisionOutputContract(output);

  assert.equal(schemaValidation.valid, false);
  assert.equal(
    semanticValidation.errors.some(
      (error) => error.code === 'UNKNOWN_VISUAL_CATEGORY',
    ),
    true,
  );
  assert.equal(outputContract.checks.categoriesValid, false);
  assert.equal(outputContract.failureCode, 'UNKNOWN_VISUAL_CATEGORY');
});

test('vision output contract counts semantic structured corrections, not prompt words', () => {
  const output = makeVisionRunnerOutput({
    nextPrompt:
      'Aplicá el plan estructurado adjunto y verificá nuevamente la interfaz.',
  });
  const outputContract = validateVisionOutputContract(output);
  const correctionValidation = validateRecommendedChanges(
    output,
    outputContract.categoryValidation.structuredValidation,
    2,
  );

  assert.equal(outputContract.passed, true);
  assert.equal(correctionValidation.validChanges.length, 3);
  assert.equal(outputContract.checks.correctionsConcrete, true);
});

test('fix_required with prompt and structured changes satisfies the contract', () => {
  const output = makeVisionRunnerOutput();
  const perception = evaluateVisualPerception(output);
  const outputContract = validateVisionOutputContract(output);

  assert.equal(perception.passed, true);
  assert.equal(perception.matchedCategories.length, 4);
  assert.equal(perception.matchedAnchors.length >= 2, true);
  assert.equal(outputContract.passed, true);
  assert.equal(outputContract.validRecommendedChanges.length >= 2, true);
  assert.doesNotThrow(() => assertV2OutputContract(output));
});

test('vision output contract reports correction count separately', () => {
  const output = makeVisionRunnerOutput();
  output.recommendedChanges = output.recommendedChanges.slice(0, 1);

  const outputContract = validateVisionOutputContract(output);
  const failure = visionValidationFailure({
    transport: { passed: true },
    perception: evaluateVisualPerception(output),
    outputContract,
    presentation: { passed: null },
  }, { requirePresentation: false });

  assert.equal(outputContract.checks.schemaValid, true);
  assert.equal(outputContract.checks.categoriesValid, true);
  assert.equal(outputContract.checks.correctionCountValid, false);
  assert.equal(
    outputContract.failures.correctionCount[0].code,
    'RECOMMENDED_CHANGES_INSUFFICIENT',
  );
  assert.equal(failure.code, 'RECOMMENDED_CHANGES_INSUFFICIENT');
});

test('vision output contract reports correction concreteness separately', () => {
  const output = makeVisionRunnerOutput();
  output.recommendedChanges[0].target = ' ';

  const outputContract = validateVisionOutputContract(output);
  const failure = visionValidationFailure({
    transport: { passed: true },
    perception: evaluateVisualPerception(output),
    outputContract,
    presentation: { passed: null },
  }, { requirePresentation: false });

  assert.equal(outputContract.checks.correctionCountValid, true);
  assert.equal(outputContract.checks.correctionsConcrete, false);
  assert.equal(
    outputContract.failures.concreteness[0].code,
    'RECOMMENDED_CHANGE_NOT_EXECUTABLE',
  );
  assert.equal(outputContract.failureCode, 'RECOMMENDED_CHANGE_NOT_EXECUTABLE');
  assert.equal(failure.code, 'RECOMMENDED_CHANGE_NOT_EXECUTABLE');
});

test('schema-invalid recommended change is not counted as executable', () => {
  const output = makeVisionRunnerOutput();
  output.recommendedChanges = output.recommendedChanges.slice(0, 2);
  output.recommendedChanges[0].unexpected = 'extra';

  const outputContract = validateVisionOutputContract(output);

  assert.equal(outputContract.checks.schemaValid, false);
  assert.equal(outputContract.validRecommendedChanges.length, 1);
  assert.equal(outputContract.checks.correctionCountValid, false);
});

test('vision output contract reports verdict and prompt inconsistency separately', () => {
  const output = makeVisionRunnerOutput({
    verdict: 'close',
    closeReason: 'La revisión sintética queda cerrada.',
  });

  const outputContract = validateVisionOutputContract(output);
  const failure = visionValidationFailure({
    transport: { passed: true },
    perception: evaluateVisualPerception(output),
    outputContract,
    presentation: { passed: null },
  }, { requirePresentation: false });

  assert.equal(outputContract.checks.verdictPromptConsistent, false);
  assert.equal(
    outputContract.failures.verdictPrompt[0].code,
    'VERDICT_PROMPT_INCONSISTENT',
  );
  assert.equal(failure.code, 'VERDICT_PROMPT_INCONSISTENT');
});

test('fix_required without nextPrompt reports the prompt failure, not perception', () => {
  const output = makeVisionRunnerOutput({ nextPrompt: null });
  const perception = evaluateVisualPerception(output);
  const outputContract = validateVisionOutputContract(output);
  const failure = visionValidationFailure({
    transport: { passed: true },
    perception,
    outputContract,
    presentation: { passed: null },
  }, { requirePresentation: false });

  assert.equal(perception.passed, true);
  assert.equal(outputContract.passed, false);
  assert.equal(outputContract.failureCode, 'NEXT_PROMPT_REQUIRED');
  assert.equal(failure.code, 'NEXT_PROMPT_REQUIRED');
  assert.doesNotMatch(failure.message, /percepción insuficiente/i);
});

test('contract failure remains specific when perception also misses its threshold', () => {
  const output = makeVisionRunnerOutput({ nextPrompt: null });
  const presentCategories = [
    'excessive_whitespace',
    'low_contrast',
    'high_density',
  ];
  output.visualReview.categoryAudit = makeCategoryAudit(presentCategories);
  output.recommendedChanges = output.recommendedChanges.filter(
    (change) => presentCategories.includes(change.category),
  );
  const perception = evaluateVisualPerception(output);
  const outputContract = validateVisionOutputContract(output);
  const failure = visionValidationFailure({
    transport: { passed: true },
    perception,
    outputContract,
    presentation: { passed: null },
  }, { requirePresentation: false });

  assert.equal(perception.passed, false);
  assert.equal(failure.code, 'NEXT_PROMPT_REQUIRED');
});

test('narrative cannot inflate or contradict structured visual categories', () => {
  const output = makeVisionRunnerOutput();
  const presentCategories = [
    'excessive_whitespace',
    'low_contrast',
    'high_density',
  ];
  output.visualReview.categoryAudit = makeCategoryAudit(presentCategories);
  output.recommendedChanges = output.recommendedChanges.filter(
    (change) => presentCategories.includes(change.category),
  );
  output.summary +=
    ' Además afirma desalineación, acciones inconsistentes, overflow y recorte.';

  const perception = evaluateVisualPerception(output);
  const outputContract = validateVisionOutputContract(output);

  assert.equal(perception.matchedCategories.length, 3);
  assert.equal(perception.passed, false);
  assert.equal(outputContract.checks.categoriesValid, true);
});

test('v2 output without images remains compatible with the structured contract', () => {
  const output = makeOutput({
    visualReview: {
      status: 'not_applicable',
      performed: false,
      images: [],
      categoryAudit: [],
      crossImageFindings: [],
      confidence: 'not_applicable',
    },
    nextPrompt: 'Aplicá la corrección técnica indicada y volvé a validar.',
    recommendedChanges: [{
      category: 'other',
      instruction: 'Ajustá la validación técnica localizada del contrato.',
      target: 'evaluador de coordinación',
      expectedResult: 'La salida cumplirá el contrato sin evidencia visual.',
    }],
  });

  const schemaValidation = validateSchema(output, schemas.output);
  const semanticValidation = validateStructuredVisualOutput(output);

  assert.equal(schemaValidation.valid, true);
  assert.equal(semanticValidation.passed, true);
  assert.doesNotThrow(() => assertV2OutputContract(output));
});

test('audited transport permits one text-only repair and exactly one image load', async () => {
  const expected = {
    model: 'gpt-5.6-terra',
    sha256: sha256Buffer(ONE_PIXEL_PNG),
    sizeBytes: ONE_PIXEL_PNG.length,
    width: 1,
    height: 1,
  };
  const audited = createAuditedFetch(expected);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true });
  try {
    await audited.fetchImpl('https://example.invalid', {
      body: JSON.stringify({
        model: expected.model,
        store: false,
        instructions: 'Auditá la evidencia sin respuestas predefinidas.',
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: 'Contexto sintético.' },
            {
              type: 'input_image',
              image_url:
                `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}`,
              detail: 'high',
            },
          ],
        }],
      }),
    });
    await audited.fetchImpl('https://example.invalid', {
      body: JSON.stringify({
        model: expected.model,
        store: false,
        instructions: [
          'No vuelvas a analizar la imagen.',
          'Asegurá exactamente las diez categorías.',
          'No agregues nuevas categorías present.',
          'No cambies verdict.',
        ].join(' '),
        input: [
          '===== INVALID_OUTPUT =====',
          '{"visualReview":{"categoryAudit":[]}}',
          '===== VALIDATION_ERRORS =====',
          '[{"code":"VISUAL_CATEGORY_SEVERITY_UNEXPECTED"}]',
          '===== REQUIRED_ACTION =====',
          'Corregí únicamente el contrato.',
        ].join('\n'),
      }),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const validation = validateImageTransport(audited.transport, expected);

  assert.equal(audited.transport.calls, 2);
  assert.equal(audited.transport.request.inputImageCount, 1);
  assert.equal(audited.transport.repairRequest.inputImageCount, 0);
  assert.equal(audited.transport.repairRequest.textOnly, true);
  assert.equal(validation.passed, true);
});

test('repair request rejects image reloads and a third API call', async () => {
  const expected = {
    model: 'gpt-5.6-terra',
    sha256: sha256Buffer(ONE_PIXEL_PNG),
    sizeBytes: ONE_PIXEL_PNG.length,
    width: 1,
    height: 1,
  };
  const repairBody = {
    model: expected.model,
    store: false,
    instructions: [
      'No vuelvas a analizar la imagen.',
      'Asegurá exactamente las diez categorías.',
      'No agregues nuevas categorías present.',
      'No cambies verdict.',
    ].join(' '),
    input: [
      '===== INVALID_OUTPUT =====',
      '{}',
      '===== VALIDATION_ERRORS =====',
      '[]',
      '===== REQUIRED_ACTION =====',
      'Corregí.',
    ].join('\n'),
  };
  assert.throws(
    () => inspectRepairRequest(JSON.stringify({
      ...repairBody,
      input: `${repairBody.input}\ndata:image/png;base64,AAAA`,
    }), expected),
    /reenviar la imagen/i,
  );

  const audited = createAuditedFetch(expected);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true });
  try {
    const initialBody = {
      model: expected.model,
      store: false,
      instructions: 'Auditá la evidencia.',
      input: [{
        role: 'user',
        content: [{
          type: 'input_image',
          image_url:
            `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}`,
          detail: 'high',
        }],
      }],
    };
    await audited.fetchImpl('https://example.invalid', {
      body: JSON.stringify(initialBody),
    });
    await audited.fetchImpl('https://example.invalid', {
      body: JSON.stringify(repairBody),
    });
    await assert.rejects(
      () => audited.fetchImpl('https://example.invalid', {
        body: JSON.stringify(repairBody),
      }),
      /más de un intento de reparación/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('vision runner validates transport and presentation independently', () => {
  const transport = validateImageTransport({
    calls: 1,
    request: {
      model: 'gpt-5.6-terra',
      store: false,
      inputImageCount: 1,
      mimeType: 'image/png',
      usesDataUrl: true,
      detail: 'high',
      imageSha256: 'a'.repeat(64),
      imageSizeBytes: 123,
      width: 1536,
      height: 1024,
      answerKeyTermsFound: [],
    },
  }, {
    model: 'gpt-5.6-terra',
    sha256: 'a'.repeat(64),
    sizeBytes: 123,
    width: 1536,
    height: 1024,
  });
  const presentation = {
    executed: false,
    approvalRequired: true,
    summary: 'Resumen visual.',
    nextPrompt: 'Corregí la interfaz.',
    recommendedChanges: [{
      category: 'other',
      instruction: 'Corregí la interfaz sintética.',
      target: 'panel principal',
      expectedResult: 'La interfaz quedará validada.',
    }],
  };
  const presentationValidation = validatePresentationState({
    attempted: true,
    presentation,
    presentationRecord: {
      status: 'presented',
      promptSummary: presentation.summary,
      promptFull: presentation.nextPrompt,
      recommendedChanges: presentation.recommendedChanges,
    },
    finalState: {
      pendingByDomain: {
        'ui-ux': { status: 'presented' },
      },
    },
    finalTask: { status: 'presented' },
    approvalCount: 0,
    executionActivityCount: 0,
  });

  assert.equal(transport.passed, true);
  assert.equal(presentationValidation.passed, true);
});

test('v2 pending contract rejects fix_required without executable nextPrompt', () => {
  assert.throws(
    () => assertV2OutputContract(
      makeVisionRunnerOutput({ nextPrompt: null }),
    ),
    (error) => error.code === 'NEXT_PROMPT_REQUIRED',
  );
});
