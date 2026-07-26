'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const { readJsonLimited } = require('./atomic-fs');
const { CoordinationError } = require('./errors');
const { assertSchema, loadSchema } = require('./schema-validator');
const {
  assertSafeRepositoryFile,
  sanitizeGitOutput,
} = require('./security');

const execFileAsync = promisify(execFile);

const DOMAIN_AGENT_FILES = Object.freeze({
  arquitectura: 'arquitectura.md',
  inventario: 'inventario.md',
  compras: 'compras.md',
  ventas: 'ventas.md',
  tesoreria: 'tesoreria.md',
  rrhh: 'rrhh.md',
  reportes: 'reportes.md',
  contabilidad: 'contabilidad.md',
  administracion: 'administracion.md',
  'ui-ux': 'ui-ux.md',
  'base-de-datos': 'base-de-datos.md',
  bugs: 'bugs.md',
  'nuevas-funcionalidades': 'nuevas-funcionalidades.md',
  'analista-funcional': 'analista-funcional.md',
});

const DEFAULT_PROJECT_CONTEXT = Object.freeze({
  version: '1.0',
  description: 'Fuentes permanentes legacy de coordinación.',
  globalSources: Object.freeze([
    Object.freeze({
      label: 'AGENTS.md',
      path: 'AGENTS.md',
      required: true,
      selection: 'full',
    }),
    Object.freeze({
      label: 'BASE DE DESARROLLO',
      path: '.agents/_base-development.md',
      required: true,
      selection: 'full',
    }),
    Object.freeze({
      label: 'AGENTE COORDINADOR',
      path: '.agents/coordinador.md',
      required: true,
      selection: 'full',
    }),
    Object.freeze({
      label: 'OWNERSHIP',
      path: '.agents/file-ownership.md',
      required: true,
      selection: 'full',
    }),
  ]),
  domainAgentFiles: Object.freeze(
    Object.fromEntries(
      Object.entries(DOMAIN_AGENT_FILES)
        .map(([domain, filename]) => [domain, `.agents/${filename}`]),
    ),
  ),
  architectureSource: Object.freeze({
    label: 'ARQUITECTURA RELEVANTE',
    path: 'docs/architecture.md',
    required: true,
    selection: 'relevant-sections',
  }),
});

function assertSafePermanentContextSource(reference, label) {
  assertSafeRepositoryFile(reference, label);
  const normalized = String(reference).replace(/\\/g, '/');
  const allowed =
    normalized === 'AGENTS.md' ||
    /^\.agents\/[A-Za-z0-9._-]+\.md$/.test(normalized) ||
    normalized === 'docs/architecture.md' ||
    /^docs\/coordination\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(normalized);
  if (!allowed) {
    throw new CoordinationError(
      `${label} debe ser AGENTS.md, un manual .agents, architecture.md o docs/coordination.`,
      { code: 'PROJECT_CONTEXT_SOURCE_NOT_ALLOWED' },
    );
  }
  return normalized;
}

async function readOptionalLimited(filePath, maximumBytes, options = {}) {
  let buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (options.required) {
        throw new CoordinationError(
          `Falta la fuente permanente obligatoria ${options.label || path.basename(filePath)}.`,
          { code: 'REQUIRED_PROJECT_CONTEXT_MISSING' },
        );
      }
      return limitTextValue('[ARCHIVO NO DISPONIBLE]', maximumBytes);
    }
    throw error;
  }
  return limitTextValue(buffer, maximumBytes);
}

function limitTextValue(value, maximumBytes) {
  const buffer = Buffer.from(String(value), 'utf8');
  if (buffer.byteLength <= maximumBytes) return buffer.toString('utf8');
  const marker = Buffer.from('\n[TRUNCADO]');
  if (maximumBytes <= marker.byteLength) {
    return buffer.subarray(0, maximumBytes).toString('utf8');
  }
  return Buffer.concat([
    buffer.subarray(0, maximumBytes - marker.byteLength),
    marker,
  ]).toString('utf8');
}

function extractArchitectureSections(markdown, domain, maximumBytes) {
  const chunks = String(markdown).split(/(?=^#{1,3}\s)/m);
  const domainWords = domain.split('-');
  const commonWords = [
    'arquitectura',
    'fuente de verdad',
    'backend',
    'frontend',
    'contrato',
    'dependenc',
    'seguridad',
    'base de datos',
  ];
  const selected = chunks.filter((chunk, index) => {
    if (index === 0) return true;
    const heading = chunk.split(/\r?\n/, 1)[0].toLowerCase();
    return [...domainWords, ...commonWords].some((word) => heading.includes(word));
  });
  const result = selected.join('\n').trim() || String(markdown);
  const buffer = Buffer.from(result, 'utf8');
  if (buffer.byteLength <= maximumBytes) return result;
  return `${buffer.subarray(0, maximumBytes).toString('utf8')}\n[TRUNCADO]`;
}

async function gitSummary(
  repoRoot,
  maximumBytes,
  exec = execFileAsync,
  relevantFiles = [],
  allowGlobalFallback = true,
) {
  const options = {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: Math.max(maximumBytes * 4, 1024 * 1024),
    windowsHide: true,
  };
  const safeFiles = [...new Set((relevantFiles || []).slice(0, 100))]
    .map((reference) => {
      assertSafeRepositoryFile(reference, 'Archivo relevante para Git');
      return reference.replace(/\\/g, '/');
    });
  if (safeFiles.length === 0 && !allowGlobalFallback) {
    return '[SIN ARCHIVOS RELEVANTES DECLARADOS PARA ESTA REVISIÓN]';
  }
  const pathspec = safeFiles.length > 0 ? safeFiles : ['.'];
  try {
    const [statusResult, statResult, numstatResult] = await Promise.all([
      exec('git', ['status', '--short', '--', ...pathspec], options),
      exec('git', ['diff', '--stat', '--no-ext-diff', '--', ...pathspec], options),
      exec('git', ['diff', '--numstat', '--no-ext-diff', '--', ...pathspec], options),
    ]);
    const combined = [
      'git status --short:',
      statusResult.stdout,
      'git diff --stat:',
      statResult.stdout,
      'git diff --numstat:',
      numstatResult.stdout,
    ].join('\n');
    return sanitizeGitOutput(combined, maximumBytes);
  } catch (error) {
    throw new CoordinationError('No se pudo obtener el resumen limitado de Git.', {
      code: 'GIT_SUMMARY_FAILED',
      cause: error,
    });
  }
}

async function loadProjectContextManifest(repoRoot, maximumBytes = 128 * 1024) {
  const manifestPath = path.join(repoRoot, '.coordination', 'project-context.json');
  const schemaPath = path.join(repoRoot, '.coordination', 'project-context.schema.json');
  if (!await fs.access(manifestPath).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  })) {
    return DEFAULT_PROJECT_CONTEXT;
  }
  const [manifest, schema] = await Promise.all([
    readJsonLimited(manifestPath, maximumBytes),
    loadSchema(schemaPath),
  ]);
  assertSchema(manifest, schema, 'Manifest de contexto permanente');
  for (const source of [...manifest.globalSources, manifest.architectureSource]) {
    assertSafePermanentContextSource(
      source.path,
      `Fuente permanente ${source.label}`,
    );
  }
  if (manifest.architectureSource.path !== 'docs/architecture.md') {
    throw new CoordinationError(
      'architectureSource debe apuntar exactamente a docs/architecture.md.',
      { code: 'INVALID_PROJECT_CONTEXT' },
    );
  }
  for (const [domain, reference] of Object.entries(manifest.domainAgentFiles)) {
    if (!Object.prototype.hasOwnProperty.call(DOMAIN_AGENT_FILES, domain)) {
      throw new CoordinationError(
        `project-context.json contiene un dominio desconocido: ${domain}.`,
        { code: 'INVALID_PROJECT_CONTEXT' },
      );
    }
    const normalized = assertSafePermanentContextSource(
      reference,
      `AGENT permanente ${domain}`,
    );
    if (!normalized.startsWith('.agents/')) {
      throw new CoordinationError(
        `El contexto permanente de ${domain} debe apuntar a un manual .agents.`,
        { code: 'INVALID_PROJECT_CONTEXT' },
      );
    }
  }
  return manifest;
}

function sourceContent(markdown, source, domain, maximumBytes) {
  if (source.selection === 'relevant-sections') {
    return extractArchitectureSections(markdown, domain, maximumBytes);
  }
  return limitTextValue(markdown, maximumBytes);
}

function evidenceMetadataForContext(evidence) {
  if (!evidence) return null;
  const manifest = evidence.manifest || {};
  return {
    visualImpact: manifest.visualImpact || null,
    revision: manifest.revision || null,
    blocked: Boolean(evidence.blocked),
    blockedReasons: (evidence.blockedReasons || []).map((entry) => ({
      code: entry.code,
      evidenceId: entry.evidenceId,
    })),
    blockedQuestions: [...(evidence.blockedQuestions || [])],
    evidenceIds: [...(evidence.evidenceIds || [])],
    images: (evidence.images || []).map((entry) => ({
      evidenceId: entry.evidenceId,
      filename: entry.filename,
      mimeType: entry.mimeType,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      viewport: entry.viewport,
      screen: entry.screen,
      state: entry.state,
      capturedAt: entry.capturedAt,
      visualImpact: entry.visualImpact,
    })),
  };
}

function appendWithinLimit(parts, label, content, budget) {
  const header = `\n\n===== ${label} =====\n`;
  const available = budget.maximum - budget.used - Buffer.byteLength(header);
  if (available <= 0) return;
  const buffer = Buffer.from(String(content), 'utf8');
  const marker = Buffer.from('\n[TRUNCADO]');
  const selected = buffer.byteLength <= available
    ? buffer
    : available > marker.byteLength
      ? Buffer.concat([buffer.subarray(0, available - marker.byteLength), marker])
      : buffer.subarray(0, available);
  parts.push(header, selected.toString('utf8'));
  budget.used += Buffer.byteLength(header) + selected.byteLength;
}

async function buildCoordinatorContext(options) {
  const { repoRoot, handoff, config } = options;
  const contentBudget = Math.max(0, config.maxTotalContextBytes - 2_048);
  const hasTaskContext = Boolean(options.taskContext);
  const evidenceMetadata = evidenceMetadataForContext(options.evidence);
  const handoffBudget = Math.min(
    config.maxHandoffBytes,
    Math.floor(contentBudget * 0.32),
  );
  const taskBudget = hasTaskContext ? Math.floor(contentBudget * 0.22) : 0;
  const evidenceBudget = evidenceMetadata ? Math.floor(contentBudget * 0.08) : 0;
  const gitBudget = Math.min(
    config.maxDiffBytes,
    Math.floor(contentBudget * 0.12),
  );
  const guidanceBudget = Math.max(
    0,
    contentBudget - handoffBudget - taskBudget - evidenceBudget - gitBudget,
  );
  const projectContext = options.projectContext ||
    await loadProjectContextManifest(repoRoot);
  const domainAgentPath = projectContext.domainAgentFiles[handoff.domain];
  if (!domainAgentPath) {
    throw new CoordinationError(
      `No hay un AGENT permanente configurado para ${handoff.domain}.`,
      { code: 'PROJECT_CONTEXT_DOMAIN_MISSING' },
    );
  }
  const permanentSources = [
    ...projectContext.globalSources,
    {
      label: `AGENTE DEL DOMINIO ${handoff.domain}`,
      path: domainAgentPath,
      required: true,
      selection: 'full',
    },
    projectContext.architectureSource,
  ];
  const guidanceFileBudget = Math.min(
    config.maxContextFileBytes,
    Math.max(256, Math.floor(guidanceBudget / permanentSources.length)),
  );

  const parts = [];
  const budget = { maximum: config.maxTotalContextBytes, used: 0 };
  for (const source of permanentSources) {
    const raw = await readOptionalLimited(
      path.join(repoRoot, source.path),
      guidanceFileBudget,
      {
        required: source.required,
        label: source.label,
      },
    );
    appendWithinLimit(
      parts,
      source.label,
      sourceContent(raw, source, handoff.domain, guidanceFileBudget),
      budget,
    );
  }

  if (hasTaskContext) {
    appendWithinLimit(
      parts,
      'SOLICITUD ORIGINAL',
      limitTextValue(options.taskContext.originalRequest || '[NO DISPONIBLE]', taskBudget * 0.35),
      budget,
    );
    appendWithinLimit(
      parts,
      'OBJETIVO DE LA TAREA',
      limitTextValue(options.taskContext.objective || handoff.objective, taskBudget * 0.2),
      budget,
    );
    appendWithinLimit(
      parts,
      'CONTEXTO RUNTIME RESUMIDO',
      limitTextValue(JSON.stringify(options.taskContext, null, 2), taskBudget * 0.45),
      budget,
    );
  }
  const handoffForContext =
    handoff.version === '2.0' && handoff.evidenceManifest
      ? {
        ...handoff,
        evidenceManifest: '[MANIFEST VALIDADO; IMÁGENES INCORPORADAS POR SEPARADO]',
      }
      : handoff;
  appendWithinLimit(
    parts,
    'HANDOFF VALIDADO',
    limitTextValue(JSON.stringify(handoffForContext, null, 2), handoffBudget),
    budget,
  );
  if (evidenceMetadata) {
    appendWithinLimit(
      parts,
      'EVIDENCIAS VISUALES VALIDADAS',
      limitTextValue(JSON.stringify(evidenceMetadata, null, 2), evidenceBudget),
      budget,
    );
  }
  const relevantFiles = [
    ...(handoff.filesCreated || []),
    ...(handoff.filesModified || []),
  ];
  appendWithinLimit(
    parts,
    'ESTADO Y RESUMEN LIMITADO DE GIT',
    await gitSummary(
      repoRoot,
      gitBudget,
      options.execGit,
      relevantFiles,
      handoff.version !== '2.0',
    ),
    budget,
  );
  return parts.join('').trim();
}

async function buildCoordinatorInput(options) {
  const context = await buildCoordinatorContext(options);
  const content = [{
    type: 'input_text',
    text: context,
  }];
  if (!options.evidence?.blocked) {
    for (const image of options.evidence?.inputImages || []) {
      content.push({
        type: 'input_image',
        image_url: image.image_url,
        detail: image.detail || 'auto',
      });
    }
  }
  return [{
    role: 'user',
    content,
  }];
}

module.exports = {
  buildCoordinatorInput,
  buildCoordinatorContext,
  assertSafePermanentContextSource,
  evidenceMetadataForContext,
  extractArchitectureSections,
  gitSummary,
  limitTextValue,
  loadProjectContextManifest,
  readOptionalLimited,
};
