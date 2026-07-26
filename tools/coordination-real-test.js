'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  atomicWriteFile,
  atomicWriteJson,
  ensureDirectory,
  sha256File,
} = require('./coordination/atomic-fs');
const { CoordinationAwaitService } = require('./coordination/await-service');
const { validateConfig } = require('./coordination/config');
const { getCoordinationPaths } = require('./coordination/constants');
const { CoordinatorService } = require('./coordination/coordinator-service');
const { EvidenceService } = require('./coordination/evidence-service');
const {
  createSubmissionId,
  submissionFileName,
} = require('./coordination/identity');
const { acquireLock } = require('./coordination/lock');
const { OpenAIResponsesClient } = require('./coordination/openai-client');
const { ProtocolActions } = require('./coordination/protocol-actions');
const {
  assertSchema,
  loadSchema,
  validateSchema,
} = require('./coordination/schema-validator');
const { assertSafeHandoff } = require('./coordination/security');
const { StateStore } = require('./coordination/state-store');
const { TaskStore } = require('./coordination/task-store');
const {
  AUDITABLE_VISUAL_CATEGORIES,
  deriveVisualFindings,
  validateStructuredVisualOutput,
} = require('./coordination/visual-contract');
const { CoordinationWatcher } = require('./coordination/watcher-core');
const COORDINATOR_OUTPUT_V2_SCHEMA =
  require('../.coordination/coordinator-output-v2.schema.json');

const SOURCE_REPO_ROOT = path.resolve(__dirname, '..');
const TEMP_PREFIX = 'erp-coordination-real-test-';
const DOMAIN = 'ui-ux';
const PNG_FILE = 'synthetic-ui-evidence.png';
const VISION_PNG_FILE = 'synthetic-erp-vision.png';
const DEFAULT_VISION_IMAGE_PATH = path.join(
  SOURCE_REPO_ROOT,
  'tests',
  'fixtures',
  'coordination',
  'synthetic-erp-vision-systematic.png',
);
const REAL_TEST_MODES = new Set(['transport', 'vision']);
const MAX_VISION_IMAGE_BYTES = 5 * 1024 * 1024;
const MIN_VISION_WIDTH = 1000;
const MIN_VISION_HEIGHT = 700;
const SYNTHETIC_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const DELIBERATE_VISION_CATEGORIES = Object.freeze([
  'excessive_whitespace',
  'weak_hierarchy',
  'low_contrast',
  'misalignment',
  'high_density',
  'overflow_or_clipping',
  'inconsistent_actions',
]);

const VISUAL_CATEGORY_LABELS = Object.freeze({
  excessive_whitespace: 'margen o espacio vacío excesivo',
  weak_hierarchy: 'jerarquía visual deficiente',
  low_contrast: 'contraste insuficiente',
  misalignment: 'acciones o controles desalineados',
  high_density: 'densidad visual elevada',
  overflow_or_clipping: 'overflow, recorte o desplazamiento horizontal',
  inconsistent_actions: 'claridad o consistencia deficiente de acciones',
  readability: 'legibilidad',
  responsive_layout: 'adaptación responsive',
  accessibility_visual: 'accesibilidad visual',
  other: 'otro problema visual',
});

const VISION_ANCHORS = Object.freeze([
  'ERP DEMO',
  'DATOS FICTICIOS',
  'Panel de operaciones',
  'Pedidos pendientes',
  'Alertas activas',
  'Órdenes recientes',
  'Fecha estimada de entrega',
  'DEMO-001',
  'Listo para despacho',
]);

const CONTRACT_FILES = Object.freeze([
  'handoff.schema.json',
  'coordinator-output.schema.json',
  'handoff-v2.schema.json',
  'coordinator-output-v2.schema.json',
  'task.schema.json',
  'evidence-manifest.schema.json',
  'project-context.schema.json',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

function responseModelMatchesConfigured(configuredModel, actualModel) {
  const configured = String(configuredModel || '').trim();
  const actual = String(actualModel || '').trim();
  return Boolean(
    configured &&
    actual &&
    (actual === configured || actual.startsWith(`${configured}-`)),
  );
}

function parsePngDimensions(buffer) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 24 ||
    !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    buffer.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) {
    throw new Error('La evidencia de visión no es un PNG válido con cabecera IHDR.');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1) {
    throw new Error('La evidencia de visión tiene dimensiones PNG inválidas.');
  }
  return { width, height };
}

function assertTemporaryRepositoryPath(repoRoot) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(repoRoot);
  const relative = path.relative(temporaryRoot, resolved);
  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    !path.basename(resolved).startsWith(TEMP_PREFIX)
  ) {
    throw new Error('Se rechazó una ruta inesperada para la prueba temporal.');
  }
  return resolved;
}

function environmentBeforeWrites() {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error(
      'Falta OPENAI_API_KEY. La prueba terminó antes de crear archivos temporales.',
    );
  }

  const model = String(process.env.COORDINATOR_MODEL || '').trim();
  if (!model) {
    throw new Error(
      'Falta COORDINATOR_MODEL. La prueba terminó antes de crear archivos temporales.',
    );
  }

  if (process.env.COORDINATION_REAL_TEST !== '1') {
    throw new Error(
      'Prueba real deshabilitada. Definí COORDINATION_REAL_TEST=1 para habilitarla.',
    );
  }

  if (typeof globalThis.fetch !== 'function') {
    throw new Error('La versión activa de Node.js no ofrece fetch global.');
  }

  const mode = String(
    process.env.COORDINATION_REAL_TEST_MODE || 'transport',
  ).trim().toLowerCase();
  if (!REAL_TEST_MODES.has(mode)) {
    throw new Error(
      'COORDINATION_REAL_TEST_MODE debe ser transport o vision.',
    );
  }

  const configuredVisionImagePath = String(
    process.env.COORDINATION_VISION_IMAGE || '',
  ).trim();
  const visionImagePath = configuredVisionImagePath ||
    DEFAULT_VISION_IMAGE_PATH;
  if (mode === 'vision') {
    if (!path.isAbsolute(visionImagePath)) {
      throw new Error(
        'La prueba de visión requiere COORDINATION_VISION_IMAGE con una ruta absoluta.',
      );
    }
  }

  return {
    apiKey,
    model,
    mode,
    visionImagePath: mode === 'vision'
      ? path.resolve(visionImagePath)
      : null,
    keepTemporaryRepo: process.env.COORDINATION_KEEP_REAL_TEST === '1',
  };
}

async function loadVisionEvidence(environment) {
  if (environment.mode !== 'vision') return null;
  let image;
  try {
    image = await fs.readFile(environment.visionImagePath);
  } catch {
    throw new Error('No se pudo leer COORDINATION_VISION_IMAGE.');
  }
  if (image.length > MAX_VISION_IMAGE_BYTES) {
    throw new Error('La captura sintética supera el límite aislado de 5 MiB.');
  }
  const dimensions = parsePngDimensions(image);
  if (
    dimensions.width < MIN_VISION_WIDTH ||
    dimensions.height < MIN_VISION_HEIGHT
  ) {
    throw new Error(
      `La captura debe medir al menos ${MIN_VISION_WIDTH}×${MIN_VISION_HEIGHT}.`,
    );
  }
  return {
    buffer: image,
    width: dimensions.width,
    height: dimensions.height,
    sizeBytes: image.length,
    sha256: sha256(image),
  };
}

function realTestConfig(mode = 'transport') {
  const visionMode = mode === 'vision';
  return validateConfig({
    debounceMs: 25,
    scanIntervalMs: 250,
    stableFileMs: 25,
    lockStaleMs: 5_000,
    stateLockWaitMs: 5_000,
    maxHandoffBytes: 128 * 1024,
    maxContextFileBytes: 8 * 1024,
    maxDiffBytes: 4 * 1024,
    maxTotalContextBytes: 48 * 1024,
    maxResponseBytes: 256 * 1024,
    maxOutputTokens: visionMode ? 6_000 : 4_000,
    retries: 0,
    initialBackoffMs: 10,
    maxBackoffMs: 10,
    apiTimeoutMs: 120_000,
    awaitTimeoutMs: 180_000,
    awaitPollMs: 100,
    heartbeatIntervalMs: 250,
    heartbeatStaleMs: 5_000,
    maxEvidenceImages: 2,
    maxEvidenceImageBytes: visionMode
      ? MAX_VISION_IMAGE_BYTES
      : 1024 * 1024,
    maxEvidenceTotalBytes: visionMode
      ? 6 * 1024 * 1024
      : 2 * 1024 * 1024,
    evidenceImageDetail: 'high',
    notification: false,
  }, 'configuración aislada de la prueba real');
}

async function writeText(repoRoot, relativePath, content) {
  return atomicWriteFile(
    path.join(repoRoot, relativePath),
    `${String(content).trim()}\n`,
    { root: repoRoot, overwrite: false },
  );
}

async function prepareSyntheticRepository(repoRoot) {
  const sourceContracts = path.join(SOURCE_REPO_ROOT, '.coordination');
  const targetContracts = path.join(repoRoot, '.coordination');
  await ensureDirectory(targetContracts);

  for (const filename of CONTRACT_FILES) {
    await fs.copyFile(
      path.join(sourceContracts, filename),
      path.join(targetContracts, filename),
    );
  }

  const sources = {
    'AGENTS.md': `
      # Repositorio sintético

      Este repositorio existe exclusivamente para una prueba aislada de coordinación.
      No contiene datos operativos ni permite cambios sobre el ERP real.
      Toda ejecución requiere aprobación humana explícita.
    `,
    '.agents/_base-development.md': `
      # Desarrollo sintético

      Limitá la revisión a la tarea y a la evidencia provistas.
      No ejecutes acciones, no consultes sistemas externos adicionales y no inventes datos.
    `,
    '.agents/coordinador.md': `
      # Coordinador sintético

      Revisá funcional y técnicamente la entrega.
      Conservá la identidad de tarea y exigí aprobación antes de cualquier próximo paso.
      Cuando exista una imagen, describí primero sus componentes y relaciones visibles.
      Después recorré exactamente una vez en categoryAudit estas categorías:
      ${AUDITABLE_VISUAL_CATEGORIES.join(', ')}.
      Para present usá severity low, medium o high, descripción y evidencia observable.
      Para absent usá severity=null, una descripción acotada y evidence=null.
      Para uncertain usá severity=null, un motivo y evidence parcial insuficiente o null.
      No omitas categorías, no inventes defectos y no
      marques present para alcanzar un umbral. detectedCategories y detectedIssues se derivan
      únicamente de las categorías present fundamentadas.
      Para continue o fix_required sin preguntas, redactá un nextPrompt ejecutable
      y completá recommendedChanges con category, instruction, target y expectedResult.
      La prosa narrativa no reemplaza ni amplía esas estructuras verificables.
    `,
    '.agents/file-ownership.md': `
      # Ownership sintético

      El dominio ui-ux es responsable únicamente de fixtures/synthetic-ui-card.html.
    `,
    '.agents/ui-ux.md': `
      # Especialista UI/UX sintético

      Evaluá el contenido visible de cada evidencia y describí hallazgos verificables.
      La captura de esta prueba no contiene información real.
    `,
    'docs/architecture.md': `
      # Arquitectura

      ## Coordinación

      El repositorio temporal contiene contratos, contexto, tarea, handoff y evidencia aislados.
      El watcher puede revisar, pero nunca aprobar ni ejecutar una propuesta.

      ## UI/UX

      La única pieza visual es una interfaz estática sintética sin conexión con el ERP.
    `,
    'fixtures/synthetic-ui-card.html': `
      <!doctype html>
      <html lang="es">
        <body>
          <main aria-label="Prueba sintética">
            <h1>Referencia visual sintética</h1>
            <p>La evidencia asociada es ficticia y no contiene datos operativos.</p>
          </main>
        </body>
      </html>
    `,
  };

  for (const [relativePath, content] of Object.entries(sources)) {
    await writeText(repoRoot, relativePath, content);
  }

  const projectContext = {
    version: '1.0',
    description:
      'Contexto permanente mínimo y completamente sintético para la prueba real aislada.',
    globalSources: [
      {
        label: 'AGENTS sintético',
        path: 'AGENTS.md',
        required: true,
        selection: 'full',
      },
      {
        label: 'Base de desarrollo sintética',
        path: '.agents/_base-development.md',
        required: true,
        selection: 'full',
      },
      {
        label: 'Coordinador sintético',
        path: '.agents/coordinador.md',
        required: true,
        selection: 'full',
      },
      {
        label: 'Ownership sintético',
        path: '.agents/file-ownership.md',
        required: true,
        selection: 'full',
      },
    ],
    domainAgentFiles: {
      'ui-ux': '.agents/ui-ux.md',
    },
    architectureSource: {
      label: 'Arquitectura sintética',
      path: 'docs/architecture.md',
      required: true,
      selection: 'relevant-sections',
    },
  };
  const projectContextSchema = await loadSchema(
    path.join(targetContracts, 'project-context.schema.json'),
  );
  assertSchema(
    projectContext,
    projectContextSchema,
    'Contexto sintético de la prueba real',
  );
  await atomicWriteJson(
    path.join(targetContracts, 'project-context.json'),
    projectContext,
    { root: targetContracts, overwrite: false },
  );
}

async function loadContracts(repoRoot) {
  const paths = getCoordinationPaths(repoRoot);
  const [
    handoffSchema,
    outputSchema,
    handoffV2Schema,
    outputV2Schema,
    taskSchema,
    evidenceManifestSchema,
  ] = await Promise.all([
    loadSchema(paths.handoffSchema),
    loadSchema(paths.coordinatorOutputSchema),
    loadSchema(paths.handoffV2Schema),
    loadSchema(paths.coordinatorOutputV2Schema),
    loadSchema(paths.taskSchema),
    loadSchema(paths.evidenceManifestSchema),
  ]);
  return {
    handoffSchema,
    outputSchema,
    handoffV2Schema,
    outputV2Schema,
    taskSchema,
    evidenceManifestSchema,
  };
}

async function createSyntheticEvidence(
  repoRoot,
  taskId,
  manifestSchema,
  options = {},
) {
  const visionMode = options.mode === 'vision';
  const capturedAt = new Date().toISOString();
  const directory = path.join(
    repoRoot,
    '.coordination',
    'evidence',
    taskId,
  );
  const filename = visionMode ? VISION_PNG_FILE : PNG_FILE;
  const imagePath = path.join(directory, filename);
  const image = visionMode
    ? options.visionEvidence?.buffer
    : Buffer.from(SYNTHETIC_PNG_BASE64, 'base64');
  if (!Buffer.isBuffer(image)) {
    throw new Error('La prueba de visión no recibió una captura PNG validada.');
  }
  const dimensions = parsePngDimensions(image);
  const visualImpact = visionMode ? 'material' : 'minor';
  await atomicWriteFile(imagePath, image, {
    root: repoRoot,
    overwrite: false,
  });

  const manifestReference = `.coordination/evidence/${taskId}/manifest.json`;
  const manifest = {
    version: '2.0',
    taskId,
    revision: 1,
    createdAt: capturedAt,
    visualImpact,
    readOnlyCaptureConfirmed: true,
    possiblySensitive: false,
    authorizedForApi: true,
    sensitiveReason: null,
    images: [
      {
        filename,
        path: `.coordination/evidence/${taskId}/${filename}`,
        mimeType: 'image/png',
        sizeBytes: image.length,
        sha256: sha256(image),
        viewport: {
          width: dimensions.width,
          height: dimensions.height,
          deviceScaleFactor: 1,
        },
        screen: visionMode
          ? 'Dashboard ERP ficticio de operaciones'
          : 'Tarjeta sintética de prueba del pipeline UI/UX',
        state: visionMode
          ? 'Vista completa de escritorio para revisión visual independiente'
          : 'Píxel estático sin datos reales usado para comprobar el envío multimodal',
        capturedAt,
        visualImpact,
        readOnlyCaptureConfirmed: true,
        possiblySensitive: false,
        authorizedForApi: true,
        sensitiveReason: null,
      },
    ],
  };
  assertSchema(manifest, manifestSchema, 'Manifest sintético de evidencias');
  await atomicWriteJson(
    path.join(directory, 'manifest.json'),
    manifest,
    { root: repoRoot, overwrite: false },
  );
  return {
    manifestReference,
    manifest,
    imageMetadata: {
      filename,
      width: dimensions.width,
      height: dimensions.height,
      sizeBytes: image.length,
      sha256: sha256(image),
    },
  };
}

function makeHandoff(input) {
  const visionMode = input.mode === 'vision';
  return {
    version: '2.0',
    submissionId: input.submissionId,
    taskId: input.taskId,
    revision: 1,
    previousRevision: null,
    domain: DOMAIN,
    sourceChat: 'chat:prueba-real-ui-ux',
    createdAt: new Date().toISOString(),
    status: 'completed',
    executionKind: 'initial',
    approvedProposalHash: null,
    approvedPrompt: null,
    objective: input.objective,
    summary: visionMode
      ? 'Se preparó una interfaz ERP ficticia y su captura no sensible para una revisión visual independiente.'
      : 'Se creó una tarjeta HTML ficticia y una captura PNG mínima para validar el circuito multimodal.',
    changes: visionMode
      ? [
          'Se agregó una referencia HTML estática dentro del repositorio temporal.',
          'Se asoció una captura representativa no sensible a la tarea sintética.',
        ]
      : [
          'Se agregó una tarjeta HTML estática dentro del repositorio temporal.',
          'Se generó una evidencia PNG no sensible asociada a la tarea sintética.',
        ],
    filesCreated: [
      'fixtures/synthetic-ui-card.html',
    ],
    filesModified: [],
    validationsExecuted: visionMode
      ? [
          'Se validó el manifest contra el contrato de evidencias.',
          'Se verificaron dimensiones, tamaño, MIME, hash y ubicación autorizada de la imagen.',
        ]
      : [
          'Se validó el manifest contra el contrato de evidencias.',
          'Se verificaron tamaño, MIME, hash y ubicación autorizada de la imagen.',
        ],
    validationsPending: [],
    risks: visionMode
      ? [
          'La captura es sintética y solo valida la capacidad perceptual del circuito coordinador.',
        ]
      : [
          'La captura de 1x1 píxel prueba el transporte multimodal, no la calidad de una interfaz real.',
        ],
    decisionsRequired: [],
    visualImpact: visionMode ? 'material' : 'minor',
    evidenceManifest: input.manifestReference,
    dataModified: {
      modified: false,
      description:
        'No se modificaron datos; todo el contenido de la prueba es sintético y temporal.',
    },
    suggestedCommit: null,
    gitStatus: [
      '?? fixtures/synthetic-ui-card.html',
    ],
    diffSummary: [
      'Se agregó una única fixture visual aislada para comprobar la coordinación.',
    ],
  };
}

async function registerRevisionBeforeExposure(options) {
  await options.taskStore.recordRevision(options.taskId, {
    revision: 1,
    submissionId: options.submissionId,
    domain: DOMAIN,
    status: 'awaiting_review',
    handoffHash: options.handoffHash,
    proposalHash: null,
    summary: options.handoff.summary,
  });

  await options.stateStore.mutate((state) => {
    const timestamp = new Date().toISOString();
    state.submissions[options.submissionId] = {
      taskId: options.taskId,
      submissionId: options.submissionId,
      revision: 1,
      domain: DOMAIN,
      protocolVersion: '2.0',
      sourceHash: options.handoffHash,
      path: path
        .relative(options.repoRoot, options.handoffPath)
        .replace(/\\/g, '/'),
      status: 'awaiting_review',
      createdAt: timestamp,
    };
    state.tasks[options.taskId] = {
      taskId: options.taskId,
      domain: DOMAIN,
      status: 'awaiting_review',
      revision: 1,
      updatedAt: timestamp,
    };
    state.activity.push({
      type: 'handoff_enqueued',
      taskId: options.taskId,
      domain: DOMAIN,
      at: timestamp,
    });
  });
}

function syntheticGitResult() {
  return Promise.resolve({ stdout: '', stderr: '' });
}

function watcherLogger() {
  const line = (value) => {
    if (value && typeof value === 'object') {
      return `${value.code || 'WATCHER_ERROR'}: ${value.message || 'Error del watcher'}`;
    }
    return String(value || 'Error del watcher');
  };
  return {
    log() {},
    info() {},
    warn(value) {
      process.stderr.write(`[watcher] ${line(value)}\n`);
    },
    error(value) {
      process.stderr.write(`[watcher] ${line(value)}\n`);
    },
  };
}

async function currentFileHash(awaited, stateStore, repoRoot, config) {
  if (/^[a-f0-9]{64}$/.test(String(awaited.fileHash || ''))) {
    return awaited.fileHash;
  }

  const state = await stateStore.load();
  const active = state.pendingByDomain[DOMAIN];
  if (
    !active ||
    active.taskId !== awaited.taskId ||
    active.proposalHash !== awaited.proposalHash
  ) {
    throw new Error('La propuesta dejó de ser la vigente antes de presentarla.');
  }
  if (/^[a-f0-9]{64}$/.test(String(active.fileHash || ''))) {
    return active.fileHash;
  }

  const pendingPath = path.resolve(repoRoot, active.path);
  return sha256File(pendingPath, config.maxResponseBytes);
}

function compact(value, maximum = 700) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maximum) return text;
  return `${text.slice(0, maximum - 1).trimEnd()}…`;
}

function lines(values, maximum = 3) {
  const selected = (values || []).slice(0, maximum);
  return selected.length > 0
    ? selected.map((value) => `- ${compact(value, 350)}`).join('\n')
    : '- Sin observaciones adicionales.';
}

function inspectResponsesRequest(requestBody, expected) {
  let parsed;
  try {
    parsed = JSON.parse(String(requestBody || ''));
  } catch {
    throw new Error('La auditoría no pudo decodificar el body de Responses API.');
  }
  if (parsed.model !== expected.model) {
    throw new Error('Responses API no recibió el modelo esperado para la prueba.');
  }
  if (parsed.store !== false) {
    throw new Error('La prueba real requiere store=false en Responses API.');
  }
  if (!Array.isArray(parsed.input)) {
    throw new Error('Responses API no recibió una entrada multimodal estructurada.');
  }

  const blocks = parsed.input.flatMap((message) =>
    Array.isArray(message?.content) ? message.content : []);
  const imageBlocks = blocks.filter((block) => block?.type === 'input_image');
  const textBlocks = blocks.filter((block) => block?.type === 'input_text');
  if (imageBlocks.length !== 1) {
    throw new Error('La prueba de visión requiere exactamente un input_image.');
  }

  const imageBlock = imageBlocks[0];
  const match = /^data:(image\/png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
    String(imageBlock.image_url || ''),
  );
  if (!match) {
    throw new Error('El input_image real no fue enviado como data URL PNG.');
  }
  if (imageBlock.detail !== 'high') {
    throw new Error('El input_image real no fue enviado con detail=high.');
  }

  const image = Buffer.from(match[2], 'base64');
  const dimensions = parsePngDimensions(image);
  const imageHash = sha256(image);
  if (
    imageHash !== expected.sha256 ||
    image.length !== expected.sizeBytes ||
    dimensions.width !== expected.width ||
    dimensions.height !== expected.height
  ) {
    throw new Error('El input_image no coincide con la captura sintética validada.');
  }

  const inputText = normalizeSearchText([
    parsed.instructions,
    ...textBlocks.map((block) => block.text),
  ].join('\n'));
  const answerKeyTerms = [
    'margen excesivo',
    'espacio vacio excesivo',
    'jerarquia deficiente',
    'contraste bajo',
    'desalineacion',
    'densidad alta',
    'desbordamiento',
    'claridad de acciones',
  ].filter((term) => inputText.includes(normalizeSearchText(term)));
  if (answerKeyTerms.length > 0) {
    throw new Error(
      'El contexto textual reveló respuestas visuales esperadas y contaminó la prueba.',
    );
  }

  return {
    model: parsed.model,
    store: parsed.store,
    requestBytes: Buffer.byteLength(String(requestBody || ''), 'utf8'),
    inputImageCount: imageBlocks.length,
    mimeType: match[1],
    detail: imageBlock.detail,
    imageSizeBytes: image.length,
    imageSha256: imageHash,
    width: dimensions.width,
    height: dimensions.height,
    usesDataUrl: true,
    answerKeyTermsFound: answerKeyTerms,
  };
}

function inspectRepairRequest(requestBody, expected) {
  let parsed;
  try {
    parsed = JSON.parse(String(requestBody || ''));
  } catch {
    throw new Error('La auditoría no pudo decodificar el body de reparación.');
  }
  if (parsed.model !== expected.model) {
    throw new Error('La reparación no recibió el modelo esperado.');
  }
  if (parsed.store !== false) {
    throw new Error('La reparación requiere store=false.');
  }

  const messages = Array.isArray(parsed.input) ? parsed.input : [];
  const blocks = messages.flatMap((message) =>
    Array.isArray(message?.content) ? message.content : []);
  const imageBlocks = blocks.filter((block) => block?.type === 'input_image');
  const textBlocks = blocks.filter((block) => block?.type === 'input_text');
  const inputText = [
    typeof parsed.input === 'string' ? parsed.input : '',
    ...textBlocks.map((block) => block.text),
  ].join('\n');
  if (imageBlocks.length !== 0 || /data:image\//i.test(inputText)) {
    throw new Error('La reparación intentó reenviar la imagen.');
  }
  const requiredMarkers = [
    '===== INVALID_OUTPUT =====',
    '===== VALIDATION_ERRORS =====',
    '===== REQUIRED_ACTION =====',
  ];
  if (requiredMarkers.some((marker) => !inputText.includes(marker))) {
    throw new Error('La reparación no recibió la salida inválida y sus errores exactos.');
  }
  const instructions = String(parsed.instructions || '');
  if (
    !/no vuelvas a analizar la imagen/i.test(instructions) ||
    !/exactamente las diez categor[ií]as/i.test(instructions) ||
    !/no agregues nuevas categor[ií]as present/i.test(instructions) ||
    !/no cambies verdict/i.test(instructions)
  ) {
    throw new Error('Las instrucciones de reparación no preservan los invariantes.');
  }

  return {
    model: parsed.model,
    store: parsed.store,
    requestBytes: Buffer.byteLength(String(requestBody || ''), 'utf8'),
    inputImageCount: 0,
    textOnly: true,
    containsInvalidOutput: true,
    containsValidationErrors: true,
    preservesCategories: true,
    preservesVerdict: true,
  };
}

function createAuditedFetch(expected) {
  const transport = {
    calls: 0,
    request: null,
    repairRequest: null,
    requests: [],
  };
  return {
    transport,
    fetchImpl: async (url, options = {}) => {
      transport.calls += 1;
      if (transport.calls > 2) {
        throw new Error('La prueba de visión realizó más de un intento de reparación.');
      }
      if (transport.calls === 1) {
        transport.request = inspectResponsesRequest(options.body, expected);
        transport.requests.push(transport.request);
      } else {
        transport.repairRequest = inspectRepairRequest(options.body, expected);
        transport.requests.push(transport.repairRequest);
      }
      return globalThis.fetch(url, options);
    },
  };
}

function visualCategoryLabel(category) {
  return VISUAL_CATEGORY_LABELS[category] || category;
}

function collectStructuredVisualSignals(output) {
  const visualReview = output?.visualReview || {};
  const images = Array.isArray(visualReview.images)
    ? visualReview.images
    : [];
  const evidence = images.find(
    (entry) => entry?.filename === VISION_PNG_FILE,
  );
  const observations = Array.isArray(evidence?.observations)
    ? evidence.observations
    : [];
  const crossImageFindings = Array.isArray(visualReview.crossImageFindings)
    ? visualReview.crossImageFindings
    : [];
  const structuredValidation = validateStructuredVisualOutput(output, {
    minimumRecommendedChanges: 0,
  });
  const derivedFindings = structuredValidation.passed
    ? deriveVisualFindings(structuredValidation.categoryAudit)
    : {
      detectedCategories: structuredValidation.detectedCategories || [],
      detectedIssues: structuredValidation.detectedIssues || [],
    };
  const issues = derivedFindings.detectedIssues;
  const presentCategorySet = new Set(derivedFindings.detectedCategories);
  const verifiedCategories = DELIBERATE_VISION_CATEGORIES.filter(
    (category) => presentCategorySet.has(category),
  );
  const missingCategories = DELIBERATE_VISION_CATEGORIES.filter(
    (category) => !verifiedCategories.includes(category),
  );
  const anchorText = normalizeSearchText([
    ...observations,
    ...issues.flatMap((issue) => [issue?.description, issue?.evidence]),
    ...(structuredValidation.categoryAudit || []).flatMap((audit) => [
      audit?.description,
      audit?.evidence,
    ]),
    ...crossImageFindings,
  ].join('\n'));
  const matchedAnchors = VISION_ANCHORS.filter((anchor) =>
    anchorText.includes(normalizeSearchText(anchor)));

  return {
    visualReview,
    evidence,
    issues,
    observations,
    crossImageFindings,
    verifiedCategories,
    missingCategories,
    matchedAnchors,
    structuredValidation,
  };
}

function validateVisualCategories(output, options = {}) {
  const validationOptions = {
    minimumRecommendedChanges:
      options.minimumRecommendedChanges === undefined
        ? 0
        : options.minimumRecommendedChanges,
  };
  if (Object.prototype.hasOwnProperty.call(options, 'expectedEvidenceIds')) {
    validationOptions.expectedEvidenceIds = options.expectedEvidenceIds;
  }
  const validation = validateStructuredVisualOutput(
    output,
    validationOptions,
  );
  const categoryCodes = new Set([
    'UNKNOWN_VISUAL_CATEGORY',
    'VISUAL_CATEGORY_AUDIT_DUPLICATE',
    'VISUAL_CATEGORY_AUDIT_STATUS_INVALID',
    'VISUAL_CATEGORY_AUDIT_NOT_GROUNDED',
    'VISUAL_CATEGORY_AUDIT_INCOMPLETE',
    'VISUAL_CATEGORY_AUDIT_UNEXPECTED',
    'VISUAL_CATEGORY_SEVERITY_REQUIRED',
    'VISUAL_CATEGORY_SEVERITY_UNEXPECTED',
    'VISUAL_CATEGORY_EVIDENCE_UNEXPECTED',
  ]);
  const categoryErrors = validation.errors.filter((error) =>
    categoryCodes.has(error.code) &&
    String(error.path || '').startsWith('visualReview.'));
  return {
    kind: 'visual_categories',
    passed: categoryErrors.length === 0,
    errors: categoryErrors,
    detectedCategories: validation.detectedCategories,
    detectedIssues: validation.detectedIssues,
    presentCategories: validation.presentCategories,
    categoryAudit: validation.categoryAudit,
    structuredValidation: validation,
  };
}

function evaluateVisualPerception(output) {
  const signals = collectStructuredVisualSignals(output);
  const checks = {
    reviewPerformed:
      signals.visualReview.performed === true &&
      signals.visualReview.status === 'reviewed',
    filenameMatched: Boolean(signals.evidence),
    enoughCategoryMatches: signals.verifiedCategories.length >= 4,
    enoughVisibleAnchors: signals.matchedAnchors.length >= 2,
  };
  return {
    kind: 'perception',
    passed: Object.values(checks).every(Boolean),
    checks,
    matchedCategories: signals.verifiedCategories,
    missingCategories: signals.missingCategories,
    matchedAnchors: signals.matchedAnchors,
    requiredCategoryMatches: 4,
    requiredVisibleAnchors: 2,
    evidenceIssueCount: signals.issues.length,
    evidenceIssues: signals.issues,
    evidenceObservations: signals.observations,
    crossImageFindings: signals.crossImageFindings,
  };
}

function validateRecommendedChanges(
  output,
  structuredValidation,
  minimum = 2,
  schemaErrors,
) {
  const changes = Array.isArray(output?.recommendedChanges)
    ? output.recommendedChanges
    : [];
  const effectiveSchemaErrors = Array.isArray(schemaErrors)
    ? schemaErrors
    : validateSchema(output, COORDINATOR_OUTPUT_V2_SCHEMA).errors;
  const invalidIndexes = new Set();
  const relevantCodes = new Set([
    'UNKNOWN_VISUAL_CATEGORY',
    'RECOMMENDED_CHANGE_NOT_EXECUTABLE',
    'RECOMMENDED_CHANGE_CATEGORY_MISMATCH',
  ]);
  for (const error of structuredValidation.errors) {
    const match = /^recommendedChanges\[(\d+)\]/.exec(error.path || '');
    if (match && relevantCodes.has(error.code)) {
      invalidIndexes.add(Number(match[1]));
    }
  }
  const correctionSchemaErrors = effectiveSchemaErrors.filter((message) => {
    const match = /^\$\.recommendedChanges\[(\d+)\]/.exec(message);
    if (!match) return false;
    invalidIndexes.add(Number(match[1]));
    return true;
  });
  const validChanges = changes.filter((_, index) => !invalidIndexes.has(index));
  const concretenessErrors = structuredValidation.errors.filter(
    (error) => error.code === 'RECOMMENDED_CHANGE_NOT_EXECUTABLE',
  );
  const categoryErrors = structuredValidation.errors.filter(
    (error) =>
      error.code === 'RECOMMENDED_CHANGE_CATEGORY_MISMATCH' ||
      (
        error.code === 'UNKNOWN_VISUAL_CATEGORY' &&
        String(error.path || '').startsWith('recommendedChanges[')
      ),
  );
  return {
    passed:
      validChanges.length >= minimum &&
      concretenessErrors.length === 0 &&
      categoryErrors.length === 0 &&
      correctionSchemaErrors.length === 0,
    minimum,
    changes,
    validChanges,
    concretenessErrors,
    categoryErrors,
    schemaErrors: correctionSchemaErrors,
  };
}

function validateVisionOutputContract(output) {
  const schemaValidation = validateSchema(
    output,
    COORDINATOR_OUTPUT_V2_SCHEMA,
  );
  const structuredValidation = validateStructuredVisualOutput(output, {
    expectedEvidenceIds: [VISION_PNG_FILE],
    minimumRecommendedChanges: 2,
  });
  const categoryValidation = validateVisualCategories(output, {
    expectedEvidenceIds: [VISION_PNG_FILE],
    minimumRecommendedChanges: 2,
  });
  const corrections = validateRecommendedChanges(
    output,
    structuredValidation,
    2,
    schemaValidation.errors,
  );
  const blockingQuestions = Array.isArray(output?.blockingQuestions)
    ? output.blockingQuestions
    : [];
  const nextPrompt = typeof output?.nextPrompt === 'string'
    ? output.nextPrompt.trim()
    : '';
  const requiresNextPrompt =
    ['continue', 'fix_required'].includes(output?.verdict) &&
    blockingQuestions.length === 0;
  const semanticErrors = structuredValidation.errors;
  const errorByCodes = (...codes) => {
    const accepted = new Set(codes);
    return semanticErrors.filter((error) => accepted.has(error.code));
  };
  const failureGroups = {
    schema: schemaValidation.errors.map((message) => ({
      code: 'OUTPUT_SCHEMA_INVALID',
      message,
      path: '$',
    })),
    categories: categoryValidation.errors,
    visualStructure: errorByCodes(
      'VISUAL_REVIEW_SCHEMA_INVALID',
      'VISUAL_IMAGE_OBSERVATION_REQUIRED',
      'VISUAL_REVIEW_STATE_INCONSISTENT',
      'VISUAL_REVIEW_CONTRADICTION',
      'VISUAL_EVIDENCE_NOT_FULLY_REVIEWED',
      'VISUAL_EVIDENCE_UNEXPECTED',
    ),
    correctionCount: errorByCodes('RECOMMENDED_CHANGES_INSUFFICIENT'),
    concreteness: errorByCodes('RECOMMENDED_CHANGE_NOT_EXECUTABLE'),
    verdictPrompt: errorByCodes(
      'NEXT_PROMPT_REQUIRED',
      'NEXT_PROMPT_NOT_EXECUTABLE',
      'VERDICT_PROMPT_INCONSISTENT',
    ),
    correctionCategories: corrections.categoryErrors,
    visionExpectation: [],
  };
  if (output?.verdict !== 'fix_required') {
    failureGroups.visionExpectation.push({
      code: 'VISION_FIX_REQUIRED_EXPECTED',
      message:
        'La salida visual con defectos concretos debe usar verdict=fix_required.',
      path: 'verdict',
    });
  }
  if (blockingQuestions.length > 0) {
    failureGroups.visionExpectation.push({
      code: 'VISION_UNEXPECTED_BLOCKING_QUESTIONS',
      message:
        'La revisión visual sintética no requiere preguntas bloqueantes.',
      path: 'blockingQuestions',
    });
  }
  if (requiresNextPrompt && nextPrompt.length === 0) {
    const alreadyReported = failureGroups.verdictPrompt.some(
      (error) => error.code === 'NEXT_PROMPT_REQUIRED',
    );
    if (!alreadyReported) {
      failureGroups.verdictPrompt.push({
        code: 'NEXT_PROMPT_REQUIRED',
        message:
          'fix_required sin preguntas bloqueantes requiere un nextPrompt ejecutable.',
        path: 'nextPrompt',
      });
    }
  }
  const allFailures = [
    ...failureGroups.categories,
    ...failureGroups.visualStructure,
    ...failureGroups.verdictPrompt,
    ...failureGroups.correctionCount,
    ...failureGroups.concreteness,
    ...failureGroups.correctionCategories,
    ...failureGroups.schema,
    ...failureGroups.visionExpectation,
  ];
  const firstFailure = allFailures[0] || null;
  const checks = {
    schemaValid: failureGroups.schema.length === 0,
    visualStructureValid: failureGroups.visualStructure.length === 0,
    categoriesValid: failureGroups.categories.length === 0,
    correctionCountValid:
      corrections.validChanges.length >= corrections.minimum &&
      failureGroups.correctionCount.length === 0,
    correctionsConcrete:
      failureGroups.concreteness.length === 0 &&
      failureGroups.correctionCategories.length === 0,
    verdictPromptConsistent: failureGroups.verdictPrompt.length === 0,
    correctiveVerdict: output?.verdict === 'fix_required',
    noBlockingQuestions: blockingQuestions.length === 0,
  };

  return {
    kind: 'output_contract',
    passed: Object.values(checks).every(Boolean),
    checks,
    failureCode: firstFailure?.code || null,
    failureMessage: firstFailure?.message || null,
    failures: failureGroups,
    requiresNextPrompt,
    nextPrompt,
    recommendedChanges: corrections.changes,
    validRecommendedChanges: corrections.validChanges,
    minimumRecommendedChanges: corrections.minimum,
    blockingQuestionCount: blockingQuestions.length,
    categoryValidation,
    schemaErrors: schemaValidation.errors,
  };
}

function validateImageTransport(transport, expected) {
  const request = transport?.request || null;
  const repairRequest = transport?.repairRequest || null;
  const requests = Array.isArray(transport?.requests)
    ? transport.requests
    : request
      ? [request]
      : [];
  const checks = {
    validCallCount: transport?.calls === 1 || transport?.calls === 2,
    requestCaptured: Boolean(request),
    modelMatches: request?.model === expected.model,
    responseModelReported:
      expected.requireActualResponseModel !== true ||
      (
        Array.isArray(expected.actualResponseModels) &&
        expected.actualResponseModels.length === transport?.calls
      ),
    responseModelMatchesConfigured:
      expected.requireActualResponseModel !== true ||
      (
        Array.isArray(expected.actualResponseModels) &&
        expected.actualResponseModels.length > 0 &&
        expected.actualResponseModels.every((actualModel) =>
          responseModelMatchesConfigured(expected.model, actualModel))
      ),
    storageDisabled: request?.store === false,
    exactlyOneImage:
      requests.reduce(
        (total, entry) => total + Number(entry?.inputImageCount || 0),
        0,
      ) === 1,
    pngDataUrl: request?.mimeType === 'image/png' && request?.usesDataUrl === true,
    highDetail: request?.detail === 'high',
    imageHashMatches: request?.imageSha256 === expected.sha256,
    imageSizeMatches: request?.imageSizeBytes === expected.sizeBytes,
    dimensionsMatch:
      request?.width === expected.width &&
      request?.height === expected.height,
    answerKeyAbsent: request?.answerKeyTermsFound?.length === 0,
    repairIsTextOnly:
      transport?.calls === 1 ||
      (
        repairRequest?.inputImageCount === 0 &&
        repairRequest?.textOnly === true &&
        repairRequest?.containsInvalidOutput === true &&
        repairRequest?.containsValidationErrors === true &&
        repairRequest?.preservesCategories === true &&
        repairRequest?.preservesVerdict === true
      ),
  };
  return {
    kind: 'transport',
    passed: Object.values(checks).every(Boolean),
    checks,
  };
}

function validatePresentationState(options) {
  if (!options.attempted) {
    return {
      kind: 'presentation',
      passed: null,
      attempted: false,
      checks: {},
      reason: options.reason || 'No ejecutada por una validación previa.',
    };
  }
  const checks = {
    notExecuted: options.presentation?.executed === false,
    approvalRequired: options.presentation?.approvalRequired === true,
    pendingPresented:
      options.finalState?.pendingByDomain?.[DOMAIN]?.status === 'presented',
    presentationRecorded: options.presentationRecord?.status === 'presented',
    summaryPreserved:
      options.presentationRecord?.promptSummary === options.presentation?.summary,
    promptPreserved:
      options.presentationRecord?.promptFull === options.presentation?.nextPrompt,
    recommendedChangesPreserved:
      JSON.stringify(options.presentationRecord?.recommendedChanges || []) ===
      JSON.stringify(options.presentation?.recommendedChanges || []),
    taskPresented: options.finalTask?.status === 'presented',
    noApprovals: options.approvalCount === 0,
    noExecutionActivities: options.executionActivityCount === 0,
  };
  return {
    kind: 'presentation',
    passed: Object.values(checks).every(Boolean),
    attempted: true,
    checks,
    reason: null,
  };
}

function visionValidationFailure(validations, options = {}) {
  if (!validations.transport.passed) {
    return {
      code: 'IMAGE_TRANSPORT_VALIDATION_FAILED',
      message: 'Falló la validación del transporte real de input_image.',
    };
  }
  const contract = validations.outputContract;
  if (!contract.passed) {
    return {
      code: contract.failureCode ||
        'OUTPUT_CONTRACT_VALIDATION_FAILED',
      message: contract.failureMessage ||
        'La salida no cumple el contrato funcional de coordinación.',
    };
  }
  if (!validations.perception.passed) {
    return {
      code: 'VISUAL_PERCEPTION_INSUFFICIENT',
      message:
        'La respuesta no alcanzó los umbrales declarados de percepción visual.',
    };
  }
  if (
    options.requirePresentation !== false &&
    validations.presentation.passed !== true
  ) {
    return {
      code: 'PRESENTATION_VALIDATION_FAILED',
      message: validations.presentation.reason ||
        'La presentación no quedó persistida de forma íntegra.',
    };
  }
  return null;
}

function evaluateVisionReview(output) {
  const perception = evaluateVisualPerception(output);
  const outputContract = validateVisionOutputContract(output);
  return {
    passed: perception.passed && outputContract.passed,
    perception,
    outputContract,
  };
}

function visionUserResponse(result) {
  const review = result.presentation || result.coordinatorOutput;
  const validations = result.validations;
  const perception = validations.perception;
  const outputContract = validations.outputContract;
  const audit = result.transportAudit;
  const manifestImage = result.manifest.images[0];
  const validationStatus = (validation) => {
    if (validation.passed === true) return 'APROBADA';
    if (validation.passed === false) return 'FALLIDA';
    return 'NO EJECUTADA';
  };
  const booleanStatus = (value) => value ? 'APROBADA' : 'FALLIDA';
  const overallPassed = [
    validations.transport,
    validations.perception,
    validations.outputContract,
    validations.presentation,
  ].every((validation) => validation.passed === true);
  const listAll = (values) => (values || []).length > 0
    ? values.map((value) => `- ${String(value)}`).join('\n')
    : '- Ninguno.';
  const contractFailureDetails = Object.entries(
    outputContract.failures || {},
  ).flatMap(([group, failures]) =>
    (failures || []).map((failure) =>
      `${group}: ${failure.code}: ${failure.message}`));
  return [
    'PRUEBA REAL CONTROLADA DE VISIÓN',
    `Resultado general: ${overallPassed ? 'APROBADA' : 'FALLIDA'}.`,
    `Transporte de imagen: ${validationStatus(validations.transport)}.`,
    `Percepción visual: ${validationStatus(validations.perception)}.`,
    `Contrato de salida: ${validationStatus(validations.outputContract)}.`,
    `- Schema: ${booleanStatus(outputContract.checks.schemaValid)}.`,
    `- Categorías estructuradas: ${booleanStatus(outputContract.checks.categoriesValid)}.`,
    `- Cantidad de correcciones: ${booleanStatus(outputContract.checks.correctionCountValid)}.`,
    `- Concreción: ${booleanStatus(outputContract.checks.correctionsConcrete)}.`,
    `- Consistencia verdict/prompt: ${booleanStatus(outputContract.checks.verdictPromptConsistent)}.`,
    `Presentación: ${validationStatus(validations.presentation)}.`,
    result.validationFailure
      ? `Motivo exacto: ${result.validationFailure.code}: ${result.validationFailure.message}`
      : 'Motivo exacto: ninguno.',
    'Detalle de fallas del contrato:',
    listAll(contractFailureDetails),
    `Modelo: ${(result.actualResponseModels || [])[0] || audit.model}.`,
    `Modelo configurado mediante COORDINATOR_MODEL: ${audit.model}.`,
    `IDs de modelo informados por Responses API: ${(result.actualResponseModels || []).join(', ') || 'no informado en este resultado'}.`,
    `Estado de revisión estructurada: ${result.reviewValidation?.status || 'sin_registro'}.`,
    `Llamadas a Responses API: ${result.transportCallCount}; cargas de imagen: 1.`,
    result.repairTransportAudit
      ? '- La segunda llamada fue una reparación textual sin input_image.'
      : '- No fue necesario un intento de reparación.',
    `Imagen: ${manifestImage.filename}, ${manifestImage.viewport.width}×${manifestImage.viewport.height}, ${manifestImage.sizeBytes} bytes.`,
    `SHA-256: ${manifestImage.sha256}.`,
    '',
    'MANIFEST Y TRANSPORTE',
    '- Manifest v2 validado con visualImpact=material.',
    `- Responses API recibió ${audit.inputImageCount} input_image PNG como data URL, detail=${audit.detail}.`,
    `- Hash del input_image: ${audit.imageSha256}.`,
    `- store=${audit.store}; claves de respuesta visual filtradas del input: ${audit.answerKeyTermsFound.length}.`,
    '',
    'ANÁLISIS TEXTUAL DE LA IA COORDINADORA',
    review.summary,
    '',
    'Hallazgos generales:',
    listAll(review.findings),
    '',
    'Hallazgos visuales de la captura:',
    listAll(perception.evidenceIssues.map((issue) =>
      `${issue.category}: ${issue.description} Evidencia: ${issue.evidence}`)),
    '',
    'Observaciones visibles:',
    listAll(perception.evidenceObservations),
    '',
    'Auditoría sistemática por categoría:',
    listAll((review.visualReview?.categoryAudit || []).map((audit) =>
      `${audit.category}: ${audit.status}; severity=${audit.severity ?? 'null'}; ${audit.description} Evidencia: ${audit.evidence}`)),
    '',
    'Hallazgos visuales transversales:',
    listAll(perception.crossImageFindings),
    '',
    'Próximo prompt propuesto:',
    outputContract.nextPrompt || '- Ninguno.',
    '',
    'Correcciones estructuradas:',
    listAll(outputContract.recommendedChanges.map((change) =>
      `${change.category} | ${change.target} | ${change.instruction} | Resultado: ${change.expectedResult}`)),
    '',
    'COINCIDENCIA DETERMINISTA',
    `Categorías deliberadas detectadas (${perception.matchedCategories.length}/${DELIBERATE_VISION_CATEGORIES.length}; mínimo ${perception.requiredCategoryMatches}):`,
    listAll(perception.matchedCategories.map((category) =>
      `${category}: ${visualCategoryLabel(category)}`)),
    `Anclas visibles detectadas (${perception.matchedAnchors.length}; mínimo ${perception.requiredVisibleAnchors}):`,
    listAll(perception.matchedAnchors),
    `Correcciones estructuradas ejecutables (${outputContract.validRecommendedChanges.length}; mínimo ${outputContract.minimumRecommendedChanges}):`,
    listAll(outputContract.validRecommendedChanges.map((change) =>
      `${change.category}: ${change.instruction}`)),
    `Veredicto: ${review.verdict}.`,
    '',
    'SEGURIDAD DEL CIRCUITO',
    `- Aprobaciones registradas: ${result.safety.approvalCount}.`,
    `- Inicios de ejecución registrados: ${result.safety.executionActivityCount}.`,
    `- Estado final: ${result.safety.taskStatus}; presentación ejecutada: ${result.presentation?.executed ?? false}.`,
    `- ERP real y .env sin cambios observados: ${result.sourceRuntimeUnchanged}.`,
    '- Toda la tarea, el watcher, el manifest y la evidencia vivieron en un repositorio temporal aislado.',
  ].join('\n');
}

function finalUserResponse(result) {
  if (result.mode === 'vision') return visionUserResponse(result);
  const review = result.presentation;
  const nextAction = review.nextPrompt || review.closeReason ||
    'La propuesta no contiene una acción ejecutable.';
  const approvalMeaning = review.verdict === 'close'
    ? 'aprobar el cierre recomendado'
    : 'ejecutar el prompt recomendado';
  const kept = result.keepTemporaryRepo
    ? `\nRepositorio temporal conservado para inspección: ${result.repoRoot}\n`
    : '';

  return [
    'TRABAJO REALIZADO',
    `Se completó una prueba real aislada de coordinación para la tarea ${review.taskId}.`,
    kept.trim(),
    '',
    'VALIDACIONES',
    `- Modelo configurado mediante COORDINATOR_MODEL: ${result.configuredModel}.`,
    `- Modelo realmente utilizado: ${(result.actualResponseModels || []).join(', ') || 'no informado'}.`,
    '- El watcher real procesó un handoff v2 dentro de un repositorio temporal.',
    '- La Responses API recibió contexto sintético y una imagen PNG como input_image.',
    '- La espera terminó con una revisión vigente y la propuesta quedó presentada.',
    '- No se registró aprobación, inicio de ejecución ni modificación del ERP real.',
    '',
    'REVISIÓN DE LA IA COORDINADORA',
    compact(review.summary),
    '',
    `Veredicto: ${review.verdict}. Próximo dominio: ${review.targetDomain}.`,
    lines(review.findings),
    review.risks?.length ? `\nRiesgos:\n${lines(review.risks)}` : '',
    review.blockingQuestions?.length
      ? `\nPreguntas bloqueantes:\n${lines(review.blockingQuestions)}`
      : '',
    '',
    'PRÓXIMA ACCIÓN PROPUESTA',
    compact(nextAction, 900),
    '',
    'REVISIÓN DEL USUARIO',
    'Revisá el contenido de la aplicación.',
    '',
    'APROBACIÓN',
    `Para ${approvalMeaning}, escribí exactamente:`,
    '',
    'Aprobar',
  ].filter((line, index, all) =>
    line !== '' || (index > 0 && all[index - 1] !== '')).join('\n');
}

async function removeTemporaryRepository(repoRoot) {
  const resolved = assertTemporaryRepositoryPath(repoRoot);
  await fs.rm(resolved, { recursive: true, force: true });
}

async function executeRealTest(environment, repoRoot) {
  assertTemporaryRepositoryPath(repoRoot);
  const visionEvidence = environment.mode === 'vision'
    ? environment.visionEvidence || await loadVisionEvidence(environment)
    : null;
  const config = realTestConfig(environment.mode);
  await prepareSyntheticRepository(repoRoot);
  const contracts = await loadContracts(repoRoot);
  const paths = getCoordinationPaths(repoRoot);

  const stateStore = new StateStore({
    repoRoot,
    lockWaitMs: config.stateLockWaitMs,
    lockStaleMs: config.lockStaleMs,
  });
  const taskStore = new TaskStore({
    repoRoot,
    taskSchema: contracts.taskSchema,
    lockWaitMs: config.stateLockWaitMs,
    lockStaleMs: config.lockStaleMs,
  });
  const evidenceService = new EvidenceService({
    repoRoot,
    manifestSchema: contracts.evidenceManifestSchema,
    config,
  });
  const auditedFetch = environment.mode === 'vision'
    ? createAuditedFetch({
        model: environment.model,
        sha256: visionEvidence.sha256,
        sizeBytes: visionEvidence.sizeBytes,
        width: visionEvidence.width,
        height: visionEvidence.height,
      })
    : null;
  const responseMetadata = [];
  const client = new OpenAIResponsesClient({
    apiKey: environment.apiKey,
    model: environment.model,
    fetchImpl: auditedFetch?.fetchImpl,
    timeoutMs: config.apiTimeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    maxOutputTokens: config.maxOutputTokens,
    onResponseMetadata(metadata) {
      const actualModel = String(metadata?.model || '').trim();
      if (!actualModel) {
        throw new Error(
          'Responses API no informó el ID exacto del modelo utilizado.',
        );
      }
      if (!responseModelMatchesConfigured(environment.model, actualModel)) {
        throw new Error(
          `Responses API informó un modelo distinto del configurado: ${actualModel}.`,
        );
      }
      responseMetadata.push({
        id: metadata?.id || null,
        model: actualModel,
      });
    },
  });
  const logger = watcherLogger();
  const coordinator = new CoordinatorService({
    repoRoot,
    client,
    config,
    outputSchema: contracts.outputSchema,
    outputV2Schema: contracts.outputV2Schema,
    taskStore,
    evidenceService,
    execGit: syntheticGitResult,
    logger,
  });
  const watcher = new CoordinationWatcher({
    repoRoot,
    config,
    handoffSchema: contracts.handoffSchema,
    outputSchema: contracts.outputSchema,
    handoffV2Schema: contracts.handoffV2Schema,
    outputV2Schema: contracts.outputV2Schema,
    coordinator,
    stateStore,
    taskStore,
    logger,
  });
  const awaitService = new CoordinationAwaitService({
    repoRoot,
    config,
    stateStore,
  });
  const actions = new ProtocolActions({
    repoRoot,
    config,
    handoffSchema: contracts.handoffSchema,
    outputSchema: contracts.outputSchema,
    handoffV2Schema: contracts.handoffV2Schema,
    outputV2Schema: contracts.outputV2Schema,
    stateStore,
    taskStore,
  });

  await stateStore.initialize();
  const taskId =
    `coordination-real-ui-ux-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const objective = environment.mode === 'vision'
    ? 'Realizar una auditoría visual sistemática, categoría por categoría, de una interfaz ERP ficticia.'
    : 'Comprobar de punta a punta la revisión multimodal del coordinador con contenido sintético.';
  await taskStore.create({
    taskId,
    sourceChat: 'chat:prueba-real-arquitectura',
    originalRequest: environment.mode === 'vision'
      ? 'Auditar sistemáticamente una interfaz ficticia aislada y fundamentar cada categoría con contenido observable.'
      : 'Crear una prueba aislada que envíe un reporte UI/UX y una imagen sintética al coordinador.',
    objective,
    initialDomain: DOMAIN,
    initialPrompt: environment.mode === 'vision'
      ? `Tarea ${taskId}: trabajá solo en el repositorio temporal, describí la evidencia ` +
        'sintética no sensible y auditá cada categoría sin inventar problemas.'
      : `Tarea ${taskId}: trabajá solo en el repositorio temporal, generá una fixture ` +
        'UI/UX sintética, validala y entregá un handoff v2 con evidencia no sensible.',
  });

  const evidence = await createSyntheticEvidence(
    repoRoot,
    taskId,
    contracts.evidenceManifestSchema,
    {
      mode: environment.mode,
      visionEvidence,
    },
  );
  const submissionId = createSubmissionId();
  const handoff = makeHandoff({
    taskId,
    submissionId,
    objective,
    manifestReference: evidence.manifestReference,
    mode: environment.mode,
  });
  assertSchema(handoff, contracts.handoffV2Schema, 'Handoff sintético');
  assertSafeHandoff(handoff);

  const serializedHandoff = `${JSON.stringify(handoff, null, 2)}\n`;
  const handoffHash = sha256(serializedHandoff);
  const handoffPath = path.join(paths.inbox, submissionFileName(handoff));
  await registerRevisionBeforeExposure({
    repoRoot,
    taskStore,
    stateStore,
    taskId,
    submissionId,
    handoff,
    handoffHash,
    handoffPath,
  });

  let watcherLock;
  let watcherNeedsStop = false;
  try {
    watcherLock = await acquireLock(paths.watcherLock, {
      staleMs: config.lockStaleMs,
    });
    watcherNeedsStop = true;
    await watcher.start();

    await atomicWriteFile(handoffPath, serializedHandoff, {
      root: paths.root,
      overwrite: false,
      validate: async (buffer) => {
        const parsed = JSON.parse(buffer.toString('utf8'));
        assertSchema(parsed, contracts.handoffV2Schema, 'Handoff sintético');
        assertSafeHandoff(parsed);
      },
    });

    const awaited = await awaitService.wait({
      taskId,
      domain: DOMAIN,
      handoffHash,
      submissionId,
      revision: 1,
      timeoutMs: config.awaitTimeoutMs,
    });
    let visionValidations = null;
    if (environment.mode === 'vision') {
      const perception = evaluateVisualPerception(awaited.output);
      const outputContract = validateVisionOutputContract(awaited.output);
      visionValidations = {
        transport: validateImageTransport(auditedFetch.transport, {
          model: environment.model,
          requireActualResponseModel: true,
          actualResponseModels: responseMetadata.map((entry) => entry.model),
          sha256: visionEvidence.sha256,
          sizeBytes: visionEvidence.sizeBytes,
          width: visionEvidence.width,
          height: visionEvidence.height,
        }),
        perception,
        outputContract,
        presentation: validatePresentationState({
          attempted: false,
          reason: 'No ejecutada hasta validar percepción y contrato de salida.',
        }),
      };
      const validationFailure = visionValidationFailure(
        visionValidations,
        { requirePresentation: false },
      );
      if (validationFailure) {
        const [currentState, currentTask] = await Promise.all([
          stateStore.load(),
          taskStore.load(taskId),
        ]);
        const executionActivities = (currentState.activity || []).filter((entry) =>
          entry?.taskId === taskId &&
          [
            'proposal_approved',
            'task_transfer_approved',
            'approved_task_started',
            'task_transfer_claimed',
            'task_closed_by_user',
            'approved_task_completed',
          ].includes(entry.type));
        const processedRecord = Object.values(
          currentState.processedFiles || {},
        ).find((entry) => entry?.taskId === taskId);
        const result = {
          mode: environment.mode,
          coordinatorOutput: awaited.output,
          presentation: null,
          repoRoot,
          keepTemporaryRepo: environment.keepTemporaryRepo,
          manifest: evidence.manifest,
          imageMetadata: evidence.imageMetadata,
          transportAudit: auditedFetch.transport.request,
          repairTransportAudit: auditedFetch.transport.repairRequest,
          transportCallCount: auditedFetch.transport.calls,
          reviewValidation: processedRecord?.reviewValidation || null,
          configuredModel: environment.model,
          actualResponseModels: responseMetadata.map((entry) => entry.model),
          validations: visionValidations,
          validationFailure,
          safety: {
            approvalCount:
              currentTask.approvals.length +
              Object.keys(currentState.approvals || {}).length +
              Object.keys(currentState.proposalApprovals || {}).length,
            executionActivityCount: executionActivities.length,
            taskStatus: currentTask.status,
          },
        };
        const error = new Error(validationFailure.message);
        error.code = validationFailure.code;
        error.realTestResult = result;
        throw error;
      }
    }

    const fileHash = await currentFileHash(
      awaited,
      stateStore,
      repoRoot,
      config,
    );
    const presentation = await actions.present({
      taskId,
      domain: DOMAIN,
      revision: 1,
      proposalHash: awaited.proposalHash,
      fileHash,
    }, 'chat:prueba-real-ui-ux');

    const [finalState, finalTask] = await Promise.all([
      stateStore.load(),
      taskStore.load(taskId),
    ]);
    const presentationRecord = finalState.presentations[awaited.proposalHash];
    const executionActivities = (finalState.activity || []).filter((entry) =>
      entry?.taskId === taskId &&
      [
        'proposal_approved',
        'task_transfer_approved',
        'approved_task_started',
        'task_transfer_claimed',
        'task_closed_by_user',
        'approved_task_completed',
      ].includes(entry.type));
    const approvalCount =
      finalTask.approvals.length +
      Object.keys(finalState.approvals || {}).length +
      Object.keys(finalState.proposalApprovals || {}).length;
    const processedRecord = Object.values(
      finalState.processedFiles || {},
    ).find((entry) => entry?.taskId === taskId);

    const result = {
      mode: environment.mode,
      coordinatorOutput: awaited.output,
      presentation,
      repoRoot,
      keepTemporaryRepo: environment.keepTemporaryRepo,
      manifest: evidence.manifest,
      imageMetadata: evidence.imageMetadata,
      transportAudit: auditedFetch?.transport.request || null,
      repairTransportAudit: auditedFetch?.transport.repairRequest || null,
      transportCallCount: auditedFetch?.transport.calls || 0,
      reviewValidation: processedRecord?.reviewValidation || null,
      configuredModel: environment.model,
      actualResponseModels: responseMetadata.map((entry) => entry.model),
      safety: {
        approvalCount,
        executionActivityCount: executionActivities.length,
        taskStatus: finalTask.status,
      },
    };
    if (environment.mode === 'vision') {
      visionValidations.presentation = validatePresentationState({
        attempted: true,
        presentation,
        presentationRecord,
        finalState,
        finalTask,
        approvalCount,
        executionActivityCount: executionActivities.length,
      });
      result.validations = visionValidations;
      result.validationFailure = visionValidationFailure(visionValidations);
      result.visionEvaluation = {
        passed:
          visionValidations.perception.passed &&
          visionValidations.outputContract.passed,
        perception: visionValidations.perception,
        outputContract: visionValidations.outputContract,
      };
      if (result.validationFailure) {
        const error = new Error(result.validationFailure.message);
        error.code = result.validationFailure.code;
        error.realTestResult = result;
        throw error;
      }
    } else {
      if (
        presentation.executed !== false ||
        presentation.approvalRequired !== true ||
        finalState.pendingByDomain[DOMAIN]?.status !== 'presented' ||
        presentationRecord?.status !== 'presented' ||
        presentationRecord?.promptSummary !== presentation.summary ||
        presentationRecord?.promptFull !== presentation.nextPrompt ||
        finalTask.status !== 'presented'
      ) {
        throw new Error('La propuesta no quedó registrada como presentada de forma íntegra.');
      }
      if (approvalCount > 0) {
        throw new Error('La prueba detectó una aprobación inesperada.');
      }
      if (executionActivities.length > 0) {
        throw new Error('La prueba detectó aprobación o ejecución automática.');
      }
    }
    return result;
  } finally {
    if (watcherNeedsStop) await watcher.stop().catch(() => {});
    if (watcherLock) await watcherLock.release().catch(() => {});
  }
}

async function sourceRuntimeMetadata() {
  const protectedPaths = [
    '.env',
    '.coordination/state.json',
    'tmp/app-state.json',
    'tmp/backend-data-cache.json',
  ];
  const metadata = {};
  for (const relativePath of protectedPaths) {
    const absolutePath = path.join(SOURCE_REPO_ROOT, relativePath);
    try {
      const stat = await fs.stat(absolutePath);
      metadata[relativePath] = {
        exists: true,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      metadata[relativePath] = {
        exists: false,
        size: null,
        mtimeMs: null,
      };
    }
  }
  return metadata;
}

function sourceRuntimeMatches(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}

async function main() {
  let environment;
  let temporaryRepo;
  let completed = false;
  let protectedBefore;
  try {
    protectedBefore = await sourceRuntimeMetadata();
    environment = environmentBeforeWrites();
    environment.visionEvidence = await loadVisionEvidence(environment);
    temporaryRepo = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
    const result = await executeRealTest(environment, temporaryRepo);
    const protectedAfter = await sourceRuntimeMetadata();
    result.sourceRuntimeUnchanged = sourceRuntimeMatches(
      protectedBefore,
      protectedAfter,
    );
    if (!result.sourceRuntimeUnchanged) {
      const error = new Error(
        'Cambió metadata protegida del ERP real durante la prueba.',
      );
      error.realTestResult = result;
      throw error;
    }
    process.stdout.write(`${finalUserResponse(result)}\n`);
    completed = true;
  } catch (error) {
    if (error?.realTestResult) {
      if (error.realTestResult.sourceRuntimeUnchanged === undefined) {
        const protectedAfter = await sourceRuntimeMetadata().catch(() => null);
        error.realTestResult.sourceRuntimeUnchanged = protectedAfter
          ? sourceRuntimeMatches(protectedBefore, protectedAfter)
          : false;
      }
      process.stdout.write(`${finalUserResponse(error.realTestResult)}\n`);
    }
    const code = error?.code ? `${error.code}: ` : '';
    process.stderr.write(`Prueba real fallida: ${code}${error?.message || String(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (temporaryRepo && !environment?.keepTemporaryRepo) {
      try {
        await removeTemporaryRepository(temporaryRepo);
      } catch (error) {
        process.stderr.write(
          `No se pudo limpiar el repositorio temporal: ${error?.message || String(error)}\n`,
        );
        process.exitCode = 1;
      }
    } else if (temporaryRepo && !completed) {
      process.stderr.write(`Repositorio temporal conservado: ${temporaryRepo}\n`);
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  collectStructuredVisualSignals,
  createAuditedFetch,
  createSyntheticEvidence,
  environmentBeforeWrites,
  evaluateVisualPerception,
  evaluateVisionReview,
  executeRealTest,
  finalUserResponse,
  inspectRepairRequest,
  inspectResponsesRequest,
  loadVisionEvidence,
  makeHandoff,
  parsePngDimensions,
  prepareSyntheticRepository,
  removeTemporaryRepository,
  sourceRuntimeMatches,
  validateImageTransport,
  validatePresentationState,
  validateRecommendedChanges,
  validateVisualCategories,
  validateVisionOutputContract,
  visionValidationFailure,
};
