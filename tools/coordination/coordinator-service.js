'use strict';

const { isDeepStrictEqual } = require('node:util');

const { buildCoordinatorContext } = require('./context-builder');
const { DOMAINS, getCoordinationPaths } = require('./constants');
const {
  CoordinationError,
  safeErrorSummary,
} = require('./errors');
const {
  createProposalToken,
  getOutputPrompt,
  isV2Payload,
} = require('./identity');
const {
  assertSchema,
  loadSchema,
  validateSchema,
} = require('./schema-validator');
const {
  assertAllowedDomain,
  assertSafeCoordinatorOutput,
  assertSafeTaskId,
} = require('./security');
const { TaskStore } = require('./task-store');
const {
  AUDITABLE_VISUAL_CATEGORIES,
  assertStructuredVisualOutput,
  validateStructuredVisualOutput,
} = require('./visual-contract');

const REVIEW_OUTCOMES = new WeakMap();
const REPAIRABLE_VISUAL_ERROR_CODES = new Set([
  'UNKNOWN_VISUAL_CATEGORY',
  'VISUAL_CATEGORY_AUDIT_DUPLICATE',
  'VISUAL_CATEGORY_AUDIT_INCOMPLETE',
  'VISUAL_CATEGORY_AUDIT_NOT_GROUNDED',
  'VISUAL_CATEGORY_SEVERITY_REQUIRED',
  'VISUAL_CATEGORY_SEVERITY_UNEXPECTED',
  'VISUAL_CATEGORY_EVIDENCE_UNEXPECTED',
]);

const INSTRUCTIONS = [
  'Actuás únicamente como coordinador revisor del ERP.',
  'No ejecutes código, comandos, prompts ni modificaciones.',
  'Analizá solo el contexto entregado; evitá auditorías globales innecesarias.',
  'Respetá los AGENTS y el ownership incluidos.',
  'Generá una única salida que cumpla exactamente el JSON Schema.',
  'approvalRequired debe ser true: toda ejecución depende del usuario.',
  'No inventes rutas ni dominios. Elegí targetDomain solo de la lista permitida.',
  'Conservá taskId y sourceHash exactamente como aparecen al final de la entrada.',
  'No incluyas secretos, datos personales, adjuntos, caches ni contenido binario.',
].join('\n');

const VISUAL_CATEGORY_DEFINITIONS = Object.freeze({
  excessive_whitespace:
    'vacío injustificado que rompe el balance o el flujo visual',
  weak_hierarchy:
    'prioridades o agrupaciones difíciles de distinguir',
  low_contrast:
    'separación insuficiente entre primer plano y fondo',
  misalignment:
    'bordes, baselines o posiciones incoherentes entre elementos relacionados',
  high_density:
    'contenido o controles amontonados con poco aire',
  overflow_or_clipping:
    'contenido cortado, fuera del contenedor o con scroll involuntario',
  inconsistent_actions:
    'acciones equivalentes con estilo, ubicación o jerarquía incoherentes',
  readability:
    'texto difícil de leer por tamaño, longitud, espaciado o compresión',
  responsive_layout:
    'adaptación deficiente observable en el viewport',
  accessibility_visual:
    'barrera visual observable, sin inferir teclado ni semántica no visible',
});

const VISUAL_CATEGORY_AUDIT_PROMPT = [
  'Antes de diagnosticar, describí en observations los componentes, textos y relaciones espaciales realmente visibles de cada imagen.',
  `Completá visualReview.categoryAudit recorriendo exactamente una vez estas categorías: ${AUDITABLE_VISUAL_CATEGORIES.join(', ')}.`,
  'Para cada categoría indicá status=present, absent o uncertain y respetá exactamente la variante correspondiente.',
  'present requiere severity=low, medium o high, description no vacía y evidence observable no vacía.',
  'absent requiere severity=null, una description acotada de lo inspeccionado y evidence=null.',
  'uncertain requiere severity=null, una description no vacía del motivo y evidence=null o evidencia parcial insuficiente.',
  'No omitas categorías aunque ya hayas encontrado problemas evidentes.',
  'status=present exige evidencia propia que nombre una región, componente, texto o relación espacial visible.',
  'Si la captura demuestra que no hay defecto, usá absent; si no permite decidirlo, usá uncertain y explicá la limitación.',
  'No marques present para completar una cuota ni a partir del nombre de la categoría.',
  'Evaluá por separado categorías que puedan solaparse y aportá evidencia propia para cada present.',
  'categoryAudit es la única fuente canónica de conclusiones visuales; no generes detectedCategories ni detectedIssues.',
  'recommendedChanges debe referirse solo a categorías present, nunca a absent o uncertain.',
  ...AUDITABLE_VISUAL_CATEGORIES.map(
    (category) => `${category}: ${VISUAL_CATEGORY_DEFINITIONS[category]}.`,
  ),
].join('\n');

const V2_INSTRUCTIONS = [
  'Actuás como responsable funcional y técnico del ciclo completo de esta tarea ERP.',
  'Revisá la intención original, el prompt aprobado, el historial, las pruebas, riesgos y evidencias.',
  'No ejecutes código, comandos, prompts ni modificaciones.',
  'La revisión pertenece al dominio actual; targetDomain solo indica el próximo especialista.',
  'Usá únicamente continue, fix_required, close, rejected o blocked.',
  'close debe tener nextPrompt null y una razón de cierre concreta.',
  'continue y fix_required sin preguntas requieren nextPrompt y recommendedChanges no vacíos.',
  'Cada recommendedChange requiere category, instruction, target y expectedResult ejecutables.',
  'Si hay hallazgos visuales, recommendedChanges debe convertirlos en correcciones concretas.',
  'Nunca autorices ejecución: approvalRequired debe ser true.',
  'Analizá realmente cada input_image recibido y devolvé visualReview estructurado por captura.',
  VISUAL_CATEGORY_AUDIT_PROMPT,
  'La narrativa es solo humana: categoryAudit es la única fuente normativa de conclusiones visuales.',
  'Sin imágenes, usá performed=false, listas visuales vacías, confidence=not_applicable y category=other para cambios no visuales.',
  'No incluyas secretos, datos personales, rutas locales, caches ni contenido binario.',
].join('\n');

const VISUAL_REPAIR_INSTRUCTIONS = [
  'Actuás únicamente como reparador del contrato estructurado de una revisión ya realizada.',
  'No vuelvas a analizar la imagen: esta llamada no incluye input_image.',
  'Corregí exclusivamente las inconsistencias de visualReview.categoryAudit indicadas en validationErrors.',
  'Devolvé nuevamente el objeto completo y ajustado al JSON Schema.',
  'Conservá exactamente todos los campos fuera de visualReview.categoryAudit.',
  'Dentro de categoryAudit asegurá exactamente las diez categorías obligatorias, una vez cada una.',
  'Podés agregar una categoría faltante o quitar una repetida solo para completar esa estructura.',
  'Toda categoría faltante debe agregarse como uncertain, con severity=null y evidence=null; no afirmes que estaba ausente.',
  'Una categoría repetida solo puede reducirse a una de sus entradas originales; si sus status se contradicen, no inventes una resolución.',
  'No agregues nuevas categorías present ni cambies el conjunto de categorías present.',
  'Conservá el status de toda categoría no duplicada; corregí solo estructura, severidad, descripción o evidencia señaladas.',
  'Si una categoría present carece de evidencia, reutilizá literalmente una observation o crossImageFinding ya existente; no redactes evidencia visual nueva.',
  'No uses la reparación para alcanzar un umbral.',
  'No cambies taskId, revision, domain, targetDomain, sourceHash ni proposalHash.',
  'No cambies verdict, summary, findings, risks, blockingQuestions, evidencia, observaciones, nextPrompt ni recommendedChanges.',
  'No apruebes ni ejecutes nada.',
].join('\n');

function getReviewOutcome(output) {
  return output && typeof output === 'object'
    ? REVIEW_OUTCOMES.get(output) || null
    : null;
}

function setReviewOutcome(output, outcome) {
  if (output && typeof output === 'object') {
    REVIEW_OUTCOMES.set(output, Object.freeze({ ...outcome }));
  }
  return output;
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function withoutCategoryAudit(output) {
  const clone = jsonClone(output);
  if (clone.visualReview && typeof clone.visualReview === 'object') {
    delete clone.visualReview.categoryAudit;
  }
  return clone;
}

function auditEntries(output) {
  const audit = output?.visualReview?.categoryAudit;
  return Array.isArray(audit) ? audit : null;
}

function auditStatusGroups(output) {
  const audit = auditEntries(output);
  if (!audit) return null;
  const map = new Map();
  for (const entry of audit) {
    if (
      !entry ||
      typeof entry.category !== 'string' ||
      typeof entry.status !== 'string'
    ) {
      continue;
    }
    if (!map.has(entry.category)) map.set(entry.category, []);
    map.get(entry.category).push(entry);
  }
  return map;
}

function presentCategorySet(output) {
  return new Set(
    (auditEntries(output) || [])
      .filter(
        (entry) =>
          AUDITABLE_VISUAL_CATEGORIES.includes(entry?.category) &&
          entry?.status === 'present',
      )
      .map((entry) => entry.category),
  );
}

function sameSet(left, right) {
  return left.size === right.size &&
    [...left].every((value) => right.has(value));
}

function repairableAuditFields(inspection) {
  const fieldsByIndex = new Map();
  const allow = (index, ...fields) => {
    if (!fieldsByIndex.has(index)) fieldsByIndex.set(index, new Set());
    fields.forEach((field) => fieldsByIndex.get(index).add(field));
  };
  for (const error of inspection?.semanticErrors || []) {
    const match = /visualReview\.categoryAudit\[(\d+)\](?:\.(\w+))?/.exec(
      String(error.path || ''),
    );
    if (!match) continue;
    const index = Number(match[1]);
    const field = match[2];
    if (
      field === 'status' ||
      field === 'severity' ||
      field === 'description' ||
      field === 'evidence'
    ) {
      allow(index, field);
    } else if (error.code === 'VISUAL_CATEGORY_AUDIT_NOT_GROUNDED') {
      allow(index, 'description', 'evidence');
    }
  }
  return fieldsByIndex;
}

function canonicalAuditEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return entry;
  }
  return Object.fromEntries(
    ['category', 'status', 'severity', 'description', 'evidence']
      .filter((field) => Object.prototype.hasOwnProperty.call(entry, field))
      .map((field) => [field, entry[field]]),
  );
}

function normalizedRepairText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function immutableVisualSupport(output) {
  const review = output?.visualReview;
  const observations = Array.isArray(review?.images)
    ? review.images.flatMap((image) =>
      Array.isArray(image?.observations) ? image.observations : [])
    : [];
  const crossImageFindings = Array.isArray(review?.crossImageFindings)
    ? review.crossImageFindings
    : [];
  return new Set(
    [...observations, ...crossImageFindings]
      .map(normalizedRepairText)
      .filter(Boolean),
  );
}

function assertPresentRepairUsesExistingSupport(
  initialEntry,
  repairedEntry,
  support,
) {
  if (initialEntry?.status !== 'present') return;
  for (const field of ['description', 'evidence']) {
    if (initialEntry?.[field] === repairedEntry?.[field]) continue;
    if (!support.has(normalizedRepairText(repairedEntry?.[field]))) {
      throw new CoordinationError(
        `La reparación intentó redactar ${field} visual nueva para ${initialEntry.category} sin respaldo inmutable.`,
        { code: 'VISUAL_REPAIR_EVIDENCE_SOURCE_MISSING' },
      );
    }
  }
}

function assertVisualRepairScope(initialOutput, repairedOutput, inspection) {
  if (
    !isDeepStrictEqual(
      withoutCategoryAudit(initialOutput),
      withoutCategoryAudit(repairedOutput),
    )
  ) {
    const verdictChanged = initialOutput?.verdict !== repairedOutput?.verdict;
    throw new CoordinationError(
      verdictChanged
        ? 'La reparación intentó cambiar indebidamente el veredicto.'
        : 'La reparación intentó modificar campos fuera de categoryAudit.',
      {
        code: verdictChanged
          ? 'VISUAL_REPAIR_VERDICT_CHANGE_FORBIDDEN'
          : 'VISUAL_REPAIR_SCOPE_VIOLATION',
      },
    );
  }

  const initialGroups = auditStatusGroups(initialOutput);
  const repairedAudit = auditEntries(repairedOutput);
  if (!initialGroups || !repairedAudit) {
    throw new CoordinationError(
      'La reparación no conservó una lista categoryAudit verificable.',
      { code: 'VISUAL_REPAIR_CATEGORY_CHANGE_FORBIDDEN' },
    );
  }
  const repairedByCategory = new Map();
  for (const entry of repairedAudit) {
    if (
      !entry ||
      !AUDITABLE_VISUAL_CATEGORIES.includes(entry.category) ||
      repairedByCategory.has(entry.category)
    ) {
      throw new CoordinationError(
        'La reparación no dejó exactamente una entrada por categoría visual obligatoria.',
        { code: 'VISUAL_REPAIR_CATEGORY_CHANGE_FORBIDDEN' },
      );
    }
    repairedByCategory.set(entry.category, entry);
  }
  if (
    repairedByCategory.size !== AUDITABLE_VISUAL_CATEGORIES.length ||
    AUDITABLE_VISUAL_CATEGORIES.some(
      (category) => !repairedByCategory.has(category),
    )
  ) {
    throw new CoordinationError(
      'La reparación no completó exactamente las diez categorías visuales obligatorias.',
      { code: 'VISUAL_REPAIR_CATEGORY_CHANGE_FORBIDDEN' },
    );
  }

  const initialPresent = presentCategorySet(initialOutput);
  const repairedPresent = presentCategorySet(repairedOutput);
  if (!sameSet(initialPresent, repairedPresent)) {
    throw new CoordinationError(
      'La reparación intentó cambiar el conjunto de categorías visuales presentes.',
      { code: 'VISUAL_REPAIR_CATEGORY_CHANGE_FORBIDDEN' },
    );
  }
  const support = immutableVisualSupport(initialOutput);
  for (const category of AUDITABLE_VISUAL_CATEGORIES) {
    const initialCategoryEntries = initialGroups.get(category) || [];
    const repairedEntry = repairedByCategory.get(category);
    const initialStatuses = new Set(
      initialCategoryEntries
        .map((entry) => entry.status)
        .filter((status) => ['present', 'absent', 'uncertain'].includes(status)),
    );
    if (
      initialCategoryEntries.length === 1 &&
      initialStatuses.size === 1 &&
      !initialStatuses.has(repairedEntry.status)
    ) {
      throw new CoordinationError(
        `La reparación cambió indebidamente el status de ${category}.`,
        { code: 'VISUAL_REPAIR_CATEGORY_CHANGE_FORBIDDEN' },
      );
    }
    if (initialCategoryEntries.length === 0) {
      if (
        repairedEntry.status !== 'uncertain' ||
        repairedEntry.severity !== null ||
        repairedEntry.evidence !== null
      ) {
        throw new CoordinationError(
          `La categoría faltante ${category} solo puede repararse como uncertain sin evidencia nueva.`,
          { code: 'VISUAL_REPAIR_MISSING_CATEGORY_UNSAFE' },
        );
      }
      continue;
    }
    if (
      initialCategoryEntries.length > 1 &&
      (
        initialStatuses.size !== 1 ||
        !initialStatuses.has(repairedEntry.status)
      )
    ) {
      throw new CoordinationError(
        `La categoría repetida ${category} tiene conclusiones incompatibles y no puede repararse sin revisar la imagen.`,
        { code: 'VISUAL_REPAIR_DUPLICATE_AMBIGUOUS' },
      );
    }
    if (initialCategoryEntries.length > 1) {
      const preservesOriginal = initialCategoryEntries.some(
        (entry) => isDeepStrictEqual(
          canonicalAuditEntry(entry),
          canonicalAuditEntry(repairedEntry),
        ),
      );
      if (!preservesOriginal) {
        throw new CoordinationError(
          `La reparación reescribió la conclusión repetida de ${category}.`,
          { code: 'VISUAL_REPAIR_SCOPE_VIOLATION' },
        );
      }
      continue;
    }
    assertPresentRepairUsesExistingSupport(
      initialCategoryEntries[0],
      repairedEntry,
      support,
    );
  }

  const allowedFields = repairableAuditFields(inspection);
  initialOutput.visualReview.categoryAudit.forEach((initialEntry, index) => {
    if (
      !initialEntry ||
      !AUDITABLE_VISUAL_CATEGORIES.includes(initialEntry.category) ||
      (initialGroups.get(initialEntry.category) || []).length !== 1
    ) {
      return;
    }
    const repairedEntry = repairedByCategory.get(initialEntry.category);
    const allowed = allowedFields.get(index) || new Set();
    const initialFixed = canonicalAuditEntry(initialEntry);
    const repairedFixed = canonicalAuditEntry(repairedEntry);
    for (const field of allowed) {
      delete initialFixed[field];
      delete repairedFixed[field];
    }
    if (!isDeepStrictEqual(initialFixed, repairedFixed)) {
      throw new CoordinationError(
        `La reparación modificó campos no señalados de ${initialEntry.category}.`,
        { code: 'VISUAL_REPAIR_SCOPE_VIOLATION' },
      );
    }
  });
}

function schemaErrorPath(message) {
  return String(message || '').match(/^(\$[^:]*):/)?.[1] || '$';
}

function inspectVisualContract(output, schema, evidenceIds) {
  const schemaValidation = validateSchema(output, schema);
  const structuredValidation = validateStructuredVisualOutput(output, {
    expectedEvidenceIds: evidenceIds || [],
    minimumRecommendedChanges: 1,
  });
  const schemaErrors = schemaValidation.errors.map((message) => ({
    code: 'SCHEMA_VALIDATION_FAILED',
    message,
    path: schemaErrorPath(message),
  }));
  return {
    passed: schemaValidation.valid && structuredValidation.passed,
    schemaErrors,
    semanticErrors: structuredValidation.errors,
    errors: [
      ...structuredValidation.errors,
      ...schemaErrors,
    ],
  };
}

function visualContractError(inspection, label = 'La salida') {
  const first = inspection.errors[0] || {
    code: 'SCHEMA_VALIDATION_FAILED',
    message: `${label} no cumple el contrato estructurado.`,
  };
  return new CoordinationError(`${first.code}: ${first.message}`, {
    code: first.code,
  });
}

function isRepairableVisualInspection(inspection, output) {
  if (!auditEntries(output) || inspection.errors.length === 0) return false;
  const schemaErrorsAreScoped = inspection.schemaErrors.every((error) =>
    String(error.path || '').startsWith('$.visualReview.categoryAudit'));
  const semanticErrorsAreScoped = inspection.semanticErrors.every(
    (error) =>
      REPAIRABLE_VISUAL_ERROR_CODES.has(error.code) &&
      String(error.path || '').startsWith('visualReview.categoryAudit'),
  );
  return (
    schemaErrorsAreScoped &&
    semanticErrorsAreScoped &&
    (inspection.schemaErrors.length > 0 ||
      inspection.semanticErrors.length > 0)
  );
}

function repairInput(output, inspection) {
  return [
    '===== INVALID_OUTPUT =====',
    JSON.stringify(output),
    '===== VALIDATION_ERRORS =====',
    JSON.stringify(inspection.errors.map((error) => ({
      code: error.code,
      path: error.path || null,
      message: error.message,
    }))),
    '===== REQUIRED_ACTION =====',
    'Reemití el objeto completo corrigiendo solo esas inconsistencias de categoryAudit.',
  ].join('\n');
}

function compactSafeError(error) {
  const safe = safeErrorSummary(error);
  return {
    code: safe.code,
    message: safe.message.slice(0, 180),
  };
}

function visualRepairFailure(initialError, repairError) {
  const initial = compactSafeError(initialError);
  const repair = compactSafeError(repairError);
  const error = new CoordinationError(
    `La reparación visual estructurada falló. Inicial ${initial.code}: ${initial.message} Reparación ${repair.code}: ${repair.message}`,
    {
      code: 'VISUAL_REPAIR_FAILED',
      temporary: false,
      cause: repairError,
    },
  );
  error.reviewRepairStatus = 'repair_failed';
  error.repairErrors = [
    { attempt: 'initial', ...initial },
    { attempt: 'repair', ...repair },
  ];
  return error;
}

function optionalEvidenceService(repoRoot, config) {
  try {
    const module = require('./evidence-service');
    const EvidenceService = module.EvidenceService || module.CoordinationEvidenceService;
    return EvidenceService ? new EvidenceService({ repoRoot, config }) : null;
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND' && /evidence-service/.test(error.message)) return null;
    throw error;
  }
}

class CoordinatorService {
  constructor(options) {
    this.repoRoot = options.repoRoot;
    this.client = options.client;
    this.config = options.config;
    this.outputSchema = options.outputSchema;
    this.outputV2Schema = options.outputV2Schema || null;
    this.buildContext = options.buildContext || buildCoordinatorContext;
    this.execGit = options.execGit;
    this.logger = options.logger || {
      info() {},
      warn() {},
      error() {},
    };
    this.taskStore = options.taskStore || new TaskStore({
      repoRoot: options.repoRoot,
      lockWaitMs: options.config.stateLockWaitMs,
      lockStaleMs: options.config.lockStaleMs,
    });
    this.evidenceService = options.evidenceService ??
      optionalEvidenceService(options.repoRoot, options.config);
  }

  async schemaFor(handoff) {
    if (!isV2Payload(handoff)) return this.outputSchema;
    if (!this.outputV2Schema) {
      this.outputV2Schema = await loadSchema(
        getCoordinationPaths(this.repoRoot).coordinatorOutputV2Schema,
      );
    }
    return this.outputV2Schema;
  }

  async taskContext(handoff) {
    if (!isV2Payload(handoff)) return null;
    if (!this.taskStore || typeof this.taskStore.context !== 'function') {
      throw new CoordinationError('No está disponible el contexto persistente de la tarea.', {
        code: 'TASK_CONTEXT_UNAVAILABLE',
      });
    }
    return this.taskStore.context(handoff.taskId);
  }

  async prepareEvidence(handoff) {
    if (
      !isV2Payload(handoff) ||
      handoff.visualImpact === 'none' ||
      !handoff.evidenceManifest
    ) {
      return {
        blocked: false,
        blockedQuestions: [],
        blockedReasons: [],
        evidenceIds: [],
        images: [],
        inputImages: [],
        inputItems: [],
        count: 0,
        sensitiveBlocked: false,
      };
    }
    if (!this.evidenceService) {
      throw new CoordinationError('El handoff declara evidencias pero falta EvidenceService.', {
        code: 'EVIDENCE_SERVICE_UNAVAILABLE',
      });
    }
    const prepare =
      this.evidenceService.prepareEvidenceInputs ||
      this.evidenceService.prepareForCoordinator ||
      this.evidenceService.prepare;
    if (typeof prepare !== 'function') {
      throw new CoordinationError('EvidenceService no expone una interfaz compatible.', {
        code: 'EVIDENCE_SERVICE_INCOMPATIBLE',
      });
    }
    const prepared = await prepare.call(this.evidenceService, {
      taskId: handoff.taskId,
      revision: handoff.revision,
      visualImpact: handoff.visualImpact,
      manifestPath: handoff.evidenceManifest,
    });
    const inputItems = Array.isArray(prepared?.inputImages)
      ? prepared.inputImages
      : [];
    return {
      ...prepared,
      inputItems,
      count: inputItems.filter((item) => item?.type === 'input_image').length,
      sensitiveBlocked: Boolean(prepared?.blocked),
    };
  }

  assertSafeOutput(output, evidence = null) {
    const options = evidence
      ? {
        evidenceReferences:
          Array.isArray(evidence.images) && evidence.images.length > 0
          ? evidence.images.map(({ evidenceId, filename }) => ({
            evidenceId,
            filename,
          }))
          : (evidence.evidenceIds || []),
      }
      : {};
    assertSafeCoordinatorOutput(
      output,
      'La salida del coordinador',
      options,
    );
  }

  assertV2Identity(output, handoff, sourceHash, proposalToken) {
    if (
      output.taskId !== handoff.taskId ||
      output.revision !== handoff.revision ||
      output.domain !== handoff.domain ||
      output.sourceHash !== sourceHash
    ) {
      throw new CoordinationError('La revisión v2 cambió la identidad de la entrega.', {
        code: 'OUTPUT_IDENTITY_MISMATCH',
      });
    }
    if (output.proposalHash !== proposalToken) {
      throw new CoordinationError('La revisión no repitió el proposalHash asignado.', {
        code: 'OUTPUT_PROPOSAL_HASH_MISMATCH',
      });
    }
    assertAllowedDomain(output.domain, 'output.domain');
    assertAllowedDomain(output.targetDomain, 'output.targetDomain');
    if (output.approvalRequired !== true) {
      throw new CoordinationError('La salida intentó omitir la aprobación humana.', {
        code: 'APPROVAL_INVARIANT_VIOLATION',
      });
    }
  }

  enforceV2Semantics(output, handoff, sourceHash, proposalToken, evidence) {
    this.assertV2Identity(output, handoff, sourceHash, proposalToken);

    output.blockingQuestions = [
      ...(output.blockingQuestions || []),
      ...(evidence.blockedQuestions || []),
    ].filter((question, index, all) => all.indexOf(question) === index);

    if (evidence.blocked) {
      output.verdict = 'blocked';
      output.nextPrompt = null;
      output.recommendedChanges = [];
      output.closeReason = null;
      output.evidenceRequired = true;
      output.visualReview.status = 'sensitive_blocked';
      output.visualReview.performed = false;
      output.visualReview.images = [];
      output.visualReview.categoryAudit = [];
      output.visualReview.crossImageFindings = [];
      output.visualReview.confidence = 'not_applicable';
    }

    const missingMaterialEvidence =
      handoff.visualImpact === 'material' &&
      evidence.count === 0;
    if (missingMaterialEvidence) {
      output.evidenceRequired = true;
      if (output.verdict === 'close') {
        output.verdict = 'fix_required';
        output.closeReason = null;
      }
      if (!evidence.sensitiveBlocked && output.blockingQuestions.length === 0) {
        const instruction =
          'Generá evidencias visuales sanitizadas de las pantallas y estados modificados, ' +
          'validalas y envialas en la próxima revisión antes de solicitar el cierre.';
        output.nextPrompt = getOutputPrompt(output)
          ? `${getOutputPrompt(output)}\n\n${instruction}`
          : instruction;
        output.recommendedChanges = [{
          category: 'other',
          instruction,
          target: 'Evidencias visuales sanitizadas de la tarea',
          expectedResult:
            'La próxima revisión incluye capturas válidas de todos los estados modificados.',
        }];
      }
      if (evidence.sensitiveBlocked) {
        output.blockingQuestions = [
          ...output.blockingQuestions,
          'La evidencia puede contener información sensible. ¿Podés aportar una captura sanitizada?',
        ].filter((question, index, all) => all.indexOf(question) === index);
      }
    }
    if (output.blockingQuestions.length > 0) {
      output.nextPrompt = null;
      output.recommendedChanges = [];
    }
    if (output.verdict === 'blocked' && output.blockingQuestions.length === 0) {
      throw new CoordinationError('blocked requiere al menos una pregunta bloqueante.', {
        code: 'BLOCKED_WITHOUT_QUESTION',
      });
    }
    if (output.verdict === 'rejected' && getOutputPrompt(output)) {
      throw new CoordinationError('rejected no puede contener un prompt ejecutable.', {
        code: 'REJECTED_WITH_EXECUTABLE_PROMPT',
      });
    }
    if (output.verdict === 'close') {
      if (getOutputPrompt(output)) {
        throw new CoordinationError('close no puede contener un prompt ejecutable.', {
          code: 'CLOSE_WITH_EXECUTABLE_PROMPT',
        });
      }
      if (!output.closeReason) {
        throw new CoordinationError('close requiere una razón de cierre.', {
          code: 'CLOSE_REASON_REQUIRED',
        });
      }
    }
    if (
      ['continue', 'fix_required'].includes(output.verdict) &&
      output.blockingQuestions.length === 0 &&
      !getOutputPrompt(output)
    ) {
      throw new CoordinationError('La revisión requiere un próximo prompt ejecutable.', {
        code: 'NEXT_PROMPT_REQUIRED',
      });
    }
    assertStructuredVisualOutput(output, {
      expectedEvidenceIds: evidence.evidenceIds || [],
      minimumRecommendedChanges: 1,
    });
    return output;
  }

  finalizeV2Output(output, context) {
    this.assertV2Identity(
      output,
      context.handoff,
      context.sourceHash,
      context.proposalToken,
    );
    this.assertSafeOutput(output, context.evidence);
    this.enforceV2Semantics(
      output,
      context.handoff,
      context.sourceHash,
      context.proposalToken,
      context.evidence,
    );
    assertSchema(output, context.schema, 'Salida del coordinador');
    this.assertSafeOutput(output, context.evidence);
    assertSafeTaskId(output.taskId, 'output.taskId');
    assertAllowedDomain(output.targetDomain, 'output.targetDomain');
    return output;
  }

  logReview(code, message, handoff) {
    this.logger.info?.({
      code,
      message,
      taskId: handoff.taskId,
      domain: handoff.domain,
    });
  }

  async coordinate(handoff, sourceHash) {
    assertSafeTaskId(handoff.taskId);
    const v2 = isV2Payload(handoff);
    const proposalToken = v2
      ? createProposalToken({
        taskId: handoff.taskId,
        revision: handoff.revision,
        sourceHash,
      })
      : null;
    const schema = await this.schemaFor(handoff);
    const [taskContext, evidence] = await Promise.all([
      this.taskContext(handoff),
      this.prepareEvidence(handoff),
    ]);
    const context = await this.buildContext({
      repoRoot: this.repoRoot,
      handoff,
      config: this.config,
      execGit: this.execGit,
      taskContext,
      evidence,
    });
    const textInput = [
      context,
      '\n\n===== INVARIANTES DE ESTA RESPUESTA =====',
      `taskId: ${handoff.taskId}`,
      v2 ? `revision: ${handoff.revision}` : '',
      v2 ? `domain actual: ${handoff.domain}` : '',
      v2 ? `proposalHash asignado (repetir exactamente): ${proposalToken}` : '',
      `sourceHash: ${sourceHash}`,
      `targetDomain permitido: ${DOMAINS.join(', ')}`,
      evidence.blockedReasons?.length
        ? `Evidencia bloqueada: ${evidence.blockedReasons
          .map((entry) => entry.code)
          .join(', ')}`
        : '',
      evidence.blockedQuestions?.length
        ? `Preguntas obligatorias por evidencia: ${evidence.blockedQuestions.join(' | ')}`
        : '',
    ].join('\n');
    const input = evidence.inputItems.length > 0
      ? [{
        role: 'user',
        content: [
          { type: 'input_text', text: textInput },
          ...evidence.inputItems,
        ],
      }]
      : textInput;

    let output = await this.client.createStructuredResponse({
      instructions: v2 ? V2_INSTRUCTIONS : INSTRUCTIONS,
      input,
      schema,
    });
    if (!v2) {
      assertSchema(output, schema, 'Salida bruta del coordinador');
      this.assertSafeOutput(output);
      assertSafeTaskId(output.taskId, 'output.taskId');
      assertAllowedDomain(output.targetDomain, 'output.targetDomain');
      if (output.taskId !== handoff.taskId) {
        throw new CoordinationError('La salida cambió el taskId del handoff.', {
          code: 'OUTPUT_TASK_ID_MISMATCH',
        });
      }
      if (output.sourceHash !== sourceHash) {
        throw new CoordinationError('La salida no conserva el hash de origen.', {
          code: 'OUTPUT_SOURCE_HASH_MISMATCH',
        });
      }
      if (output.approvalRequired !== true) {
        throw new CoordinationError('La salida intentó omitir la aprobación humana.', {
          code: 'APPROVAL_INVARIANT_VIOLATION',
        });
      }
      return output;
    }

    const validationContext = {
      handoff,
      sourceHash,
      proposalToken,
      evidence,
      schema,
    };
    this.assertV2Identity(output, handoff, sourceHash, proposalToken);
    this.assertSafeOutput(output, evidence);

    const initialInspection = evidence.blocked
      ? { passed: true, errors: [], schemaErrors: [], semanticErrors: [] }
      : inspectVisualContract(output, schema, evidence.evidenceIds || []);
    if (!initialInspection.passed) {
      const initialError = visualContractError(
        initialInspection,
        'La salida inicial',
      );
      if (!isRepairableVisualInspection(initialInspection, output)) {
        throw initialError;
      }

      const initialOutput = jsonClone(output);
      this.logReview(
        'VISUAL_REPAIR_STARTED',
        'La revisión visual requiere una reparación estructurada única.',
        handoff,
      );
      try {
        const repairedOutput = await this.client.createStructuredResponse({
          instructions: VISUAL_REPAIR_INSTRUCTIONS,
          input: repairInput(initialOutput, initialInspection),
          schema,
          schemaName: 'coordinator_output_v2_visual_repair',
        });
        assertVisualRepairScope(
          initialOutput,
          repairedOutput,
          initialInspection,
        );
        this.assertV2Identity(
          repairedOutput,
          handoff,
          sourceHash,
          proposalToken,
        );
        this.assertSafeOutput(repairedOutput, evidence);
        const repairedInspection = inspectVisualContract(
          repairedOutput,
          schema,
          evidence.evidenceIds || [],
        );
        if (!repairedInspection.passed) {
          throw visualContractError(
            repairedInspection,
            'La salida reparada',
          );
        }
        output = this.finalizeV2Output(repairedOutput, validationContext);
      } catch (repairError) {
        const failure = visualRepairFailure(initialError, repairError);
        this.logger.error?.(safeErrorSummary(failure));
        throw failure;
      }
      const initialSummary = compactSafeError(initialError);
      setReviewOutcome(output, {
        status: 'repaired',
        attempts: 2,
        initialError: initialSummary,
      });
      this.logReview(
        'VISUAL_REPAIR_SUCCEEDED',
        'La revisión visual fue reparada y revalidada correctamente.',
        handoff,
      );
      return output;
    }

    output = this.finalizeV2Output(output, validationContext);
    setReviewOutcome(output, {
      status: 'valid_initially',
      attempts: 1,
      initialError: null,
    });
    this.logReview(
      'COORDINATOR_REVIEW_VALID_INITIAL',
      'La revisión fue válida en el primer intento.',
      handoff,
    );
    return output;
  }
}

module.exports = {
  CoordinatorService,
  INSTRUCTIONS,
  V2_INSTRUCTIONS,
  VISUAL_CATEGORY_AUDIT_PROMPT,
  VISUAL_REPAIR_INSTRUCTIONS,
  assertVisualRepairScope,
  getReviewOutcome,
  inspectVisualContract,
};
