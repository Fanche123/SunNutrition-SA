'use strict';

const { CoordinationError } = require('./errors');
const { getOutputPrompt, isV2Payload } = require('./identity');

const AUDITABLE_VISUAL_CATEGORIES = Object.freeze([
  'excessive_whitespace',
  'weak_hierarchy',
  'low_contrast',
  'misalignment',
  'high_density',
  'overflow_or_clipping',
  'inconsistent_actions',
  'readability',
  'responsive_layout',
  'accessibility_visual',
]);

const VISUAL_CATEGORIES = Object.freeze([
  ...AUDITABLE_VISUAL_CATEGORIES,
  'other',
]);

const AUDITABLE_VISUAL_CATEGORY_SET =
  new Set(AUDITABLE_VISUAL_CATEGORIES);
const VISUAL_CATEGORY_SET = new Set(VISUAL_CATEGORIES);
const VISUAL_AUDIT_STATUS_SET =
  new Set(['present', 'absent', 'uncertain']);
const VISUAL_AUDIT_SEVERITY_SET =
  new Set(['low', 'medium', 'high']);
const NON_EXECUTABLE_VERDICTS = new Set(['close', 'rejected', 'blocked']);

function nonBlank(value, minimum = 1) {
  return typeof value === 'string' && value.trim().length >= minimum;
}

function wordCount(value) {
  return (String(value || '').match(/[\p{L}\p{N}]+/gu) || []).length;
}

function concreteText(value, minimumCharacters, minimumWords) {
  return nonBlank(value, minimumCharacters) &&
    wordCount(value) >= minimumWords;
}

function normalizedText(value) {
  return String(value || '').trim().toLocaleLowerCase('es');
}

function addError(errors, code, message, path) {
  errors.push({ code, message, path });
}

function unique(values) {
  return [...new Set(values)];
}

function sameStringSet(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value));
}

function deriveVisualFindings(categoryAudit) {
  if (!Array.isArray(categoryAudit)) {
    return {
      detectedCategories: [],
      detectedIssues: [],
    };
  }
  const presentEntries = categoryAudit.filter((audit) =>
    audit?.status === 'present' &&
    AUDITABLE_VISUAL_CATEGORY_SET.has(audit?.category));
  return {
    detectedCategories: unique(
      presentEntries.map((audit) => audit.category),
    ),
    detectedIssues: presentEntries.map((audit) => ({
      category: audit.category,
      severity: audit.severity,
      description: audit.description,
      evidence: audit.evidence,
    })),
  };
}

function validateStructuredVisualOutput(output, options = {}) {
  if (!isV2Payload(output)) {
    return {
      passed: true,
      applicable: false,
      errors: [],
      groundedCategories: [],
      declaredCategories: [],
      detectedCategories: [],
      detectedIssues: [],
      presentCategories: [],
      categoryAudit: [],
      recommendedChanges: [],
    };
  }

  const errors = [];
  const review = output?.visualReview;
  const recommendedChanges = Array.isArray(output?.recommendedChanges)
    ? output.recommendedChanges
    : [];
  const minimumRecommendedChanges =
    options.minimumRecommendedChanges === undefined
      ? 1
      : Number(options.minimumRecommendedChanges);

  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    addError(
      errors,
      'VISUAL_REVIEW_SCHEMA_INVALID',
      'visualReview debe ser un objeto estructurado.',
      'visualReview',
    );
    return {
      passed: false,
      applicable: true,
      errors,
      groundedCategories: [],
      declaredCategories: [],
      detectedCategories: [],
      detectedIssues: [],
      presentCategories: [],
      categoryAudit: [],
      recommendedChanges,
    };
  }

  const images = Array.isArray(review.images) ? review.images : [];
  const categoryAudit = Array.isArray(review.categoryAudit)
    ? review.categoryAudit
    : [];
  const crossImageFindings = Array.isArray(review.crossImageFindings)
    ? review.crossImageFindings
    : [];
  if (
    typeof review.performed !== 'boolean' ||
    !Array.isArray(review.images) ||
    !Array.isArray(review.categoryAudit) ||
    !Array.isArray(review.crossImageFindings) ||
    !Array.isArray(output?.recommendedChanges)
  ) {
    addError(
      errors,
      'VISUAL_REVIEW_SCHEMA_INVALID',
      'La revisión visual no contiene todas las colecciones estructuradas.',
      'visualReview',
    );
  }

  for (const [imageIndex, image] of images.entries()) {
    const observations = Array.isArray(image?.observations)
      ? image.observations
      : [];
    if (
      !nonBlank(image?.filename) ||
      observations.length === 0 ||
      observations.some((observation) => !nonBlank(observation))
    ) {
      addError(
        errors,
        'VISUAL_IMAGE_OBSERVATION_REQUIRED',
        'Cada imagen analizada requiere filename y al menos una observación concreta.',
        `visualReview.images[${imageIndex}]`,
      );
    }
  }

  const auditEntryByCategory = new Map();
  const validAuditEntries = [];
  for (const [auditIndex, audit] of categoryAudit.entries()) {
    const auditPath = `visualReview.categoryAudit[${auditIndex}]`;
    let auditEntryValid = true;
    if (!AUDITABLE_VISUAL_CATEGORY_SET.has(audit?.category)) {
      addError(
        errors,
        'UNKNOWN_VISUAL_CATEGORY',
        `Categoría visual desconocida: ${String(audit?.category)}.`,
        `${auditPath}.category`,
      );
      continue;
    }
    if (auditEntryByCategory.has(audit.category)) {
      addError(
        errors,
        'VISUAL_CATEGORY_AUDIT_DUPLICATE',
        `La categoría ${audit.category} fue auditada más de una vez.`,
        `${auditPath}.category`,
      );
      continue;
    }
    auditEntryByCategory.set(audit.category, audit);
    if (!VISUAL_AUDIT_STATUS_SET.has(audit?.status)) {
      addError(
        errors,
        'VISUAL_CATEGORY_AUDIT_STATUS_INVALID',
        `Estado de auditoría desconocido para ${audit.category}.`,
        `${auditPath}.status`,
      );
      continue;
    }
    if (audit.status === 'present') {
      if (
        !concreteText(audit?.description, 12, 3) ||
        !concreteText(audit?.evidence, 16, 4) ||
        normalizedText(audit?.description) === normalizedText(audit?.evidence)
      ) {
        addError(
          errors,
          'VISUAL_CATEGORY_AUDIT_NOT_GROUNDED',
          `La categoría presente ${audit.category} requiere descripción y evidencia observables, distintas entre sí.`,
          auditPath,
        );
        auditEntryValid = false;
      }
      if (!VISUAL_AUDIT_SEVERITY_SET.has(audit.severity)) {
        addError(
          errors,
          'VISUAL_CATEGORY_SEVERITY_REQUIRED',
          `La categoría presente ${audit.category} requiere severity low, medium o high.`,
          `${auditPath}.severity`,
        );
        auditEntryValid = false;
      }
    } else if (audit.status === 'absent') {
      if (!concreteText(audit?.description, 8, 2)) {
        addError(
          errors,
          'VISUAL_CATEGORY_AUDIT_NOT_GROUNDED',
          `La categoría ausente ${audit.category} requiere una descripción acotada de lo inspeccionado.`,
          `${auditPath}.description`,
        );
        auditEntryValid = false;
      }
      if (audit.severity !== null) {
        addError(
          errors,
          'VISUAL_CATEGORY_SEVERITY_UNEXPECTED',
          `absent requiere severity=null para ${audit.category}.`,
          `${auditPath}.severity`,
        );
        auditEntryValid = false;
      }
      if (audit.evidence !== null) {
        addError(
          errors,
          'VISUAL_CATEGORY_EVIDENCE_UNEXPECTED',
          `absent requiere evidence=null para ${audit.category}.`,
          `${auditPath}.evidence`,
        );
        auditEntryValid = false;
      }
    } else if (audit.status === 'uncertain') {
      if (!concreteText(audit?.description, 12, 3)) {
        addError(
          errors,
          'VISUAL_CATEGORY_AUDIT_NOT_GROUNDED',
          `La categoría incierta ${audit.category} requiere explicar por qué la evidencia no permite decidir.`,
          `${auditPath}.description`,
        );
        auditEntryValid = false;
      }
      if (
        audit.evidence !== null &&
        (
          !concreteText(audit.evidence, 12, 3) ||
          normalizedText(audit.description) === normalizedText(audit.evidence)
        )
      ) {
        addError(
          errors,
          'VISUAL_CATEGORY_AUDIT_NOT_GROUNDED',
          `La evidencia parcial de ${audit.category} debe ser concreta, distinta o null.`,
          `${auditPath}.evidence`,
        );
        auditEntryValid = false;
      }
      if (audit.severity !== null) {
        addError(
          errors,
          'VISUAL_CATEGORY_SEVERITY_UNEXPECTED',
          `uncertain requiere severity=null para ${audit.category}.`,
          `${auditPath}.severity`,
        );
        auditEntryValid = false;
      }
    }
    if (auditEntryValid) validAuditEntries.push(audit);
  }

  const auditedRequiredCategories = AUDITABLE_VISUAL_CATEGORIES.filter(
    (category) => auditEntryByCategory.has(category),
  );
  if (
    review.performed &&
    (
      categoryAudit.length !== AUDITABLE_VISUAL_CATEGORIES.length ||
      auditedRequiredCategories.length !== AUDITABLE_VISUAL_CATEGORIES.length
    )
  ) {
    const missingCategories = AUDITABLE_VISUAL_CATEGORIES.filter(
      (category) => !auditEntryByCategory.has(category),
    );
    addError(
      errors,
      'VISUAL_CATEGORY_AUDIT_INCOMPLETE',
      `La auditoría visual debe cubrir las diez categorías; faltan: ${missingCategories.join(', ') || 'ninguna'}.`,
      'visualReview.categoryAudit',
    );
  }

  const {
    detectedCategories,
    detectedIssues,
  } = deriveVisualFindings(validAuditEntries);
  const declaredPresentCategories =
    deriveVisualFindings(categoryAudit).detectedCategories;
  const presentCategories = detectedCategories;

  if (review.performed) {
    if (review.status !== 'reviewed' || images.length === 0) {
      addError(
        errors,
        'VISUAL_REVIEW_STATE_INCONSISTENT',
        'performed=true requiere status=reviewed y al menos una imagen analizada.',
        'visualReview',
      );
    }
    if (review.confidence === 'not_applicable') {
      addError(
        errors,
        'VISUAL_REVIEW_STATE_INCONSISTENT',
        'Una revisión realizada requiere confidence low, medium o high.',
        'visualReview.confidence',
      );
    }
  } else {
    if (categoryAudit.length > 0) {
      addError(
        errors,
        'VISUAL_CATEGORY_AUDIT_UNEXPECTED',
        'performed=false requiere categoryAudit vacío.',
        'visualReview.categoryAudit',
      );
    }
    if (
      review.status === 'reviewed' ||
      images.length > 0 ||
      crossImageFindings.length > 0 ||
      review.confidence !== 'not_applicable'
    ) {
      addError(
        errors,
        'VISUAL_REVIEW_CONTRADICTION',
        'performed=false requiere imágenes, auditoría y listas visuales vacías, con confidence=not_applicable.',
        'visualReview',
      );
    }
  }

  if (Object.prototype.hasOwnProperty.call(options, 'expectedEvidenceIds')) {
    const expectedEvidenceIds = Array.isArray(options.expectedEvidenceIds)
      ? options.expectedEvidenceIds
      : [];
    const receivedFilenames = images
      .map((image) => image?.filename)
      .filter((filename) => typeof filename === 'string');
    if (expectedEvidenceIds.length > 0) {
      if (
        !review.performed ||
        !sameStringSet(receivedFilenames, expectedEvidenceIds) ||
        new Set(receivedFilenames).size !== receivedFilenames.length
      ) {
        addError(
          errors,
          'VISUAL_EVIDENCE_NOT_FULLY_REVIEWED',
          'La revisión visual no cubre exactamente todas las imágenes enviadas.',
          'visualReview.images',
        );
      }
    } else if (review.performed || receivedFilenames.length > 0) {
      addError(
        errors,
        'VISUAL_EVIDENCE_UNEXPECTED',
        'La salida declara una revisión visual sin imágenes enviadas.',
        'visualReview.images',
      );
    }
  }

  for (const [index, change] of recommendedChanges.entries()) {
    const changePath = `recommendedChanges[${index}]`;
    if (!VISUAL_CATEGORY_SET.has(change?.category)) {
      addError(
        errors,
        'UNKNOWN_VISUAL_CATEGORY',
        `Categoría de corrección desconocida: ${String(change?.category)}.`,
        `${changePath}.category`,
      );
    }
    if (
      !nonBlank(change?.instruction, 8) ||
      !nonBlank(change?.target, 2) ||
      !nonBlank(change?.expectedResult, 8)
    ) {
      addError(
        errors,
        'RECOMMENDED_CHANGE_NOT_EXECUTABLE',
        'Cada corrección requiere instruction, target y expectedResult concretos.',
        changePath,
      );
    }
    if (
      review.performed &&
      VISUAL_CATEGORY_SET.has(change?.category) &&
      !declaredPresentCategories.includes(change.category)
    ) {
      addError(
        errors,
        'RECOMMENDED_CHANGE_CATEGORY_MISMATCH',
        `La corrección ${change.category} no corresponde a una categoría marcada present.`,
        `${changePath}.category`,
      );
    }
    if (!review.performed && change?.category !== 'other') {
      addError(
        errors,
        'RECOMMENDED_CHANGE_CATEGORY_MISMATCH',
        'Sin revisión visual, las correcciones no visuales deben usar category=other.',
        `${changePath}.category`,
      );
    }
  }

  const blockingQuestions = Array.isArray(output?.blockingQuestions)
    ? output.blockingQuestions
    : [];
  const prompt = getOutputPrompt(output);
  const requiresExecution =
    ['continue', 'fix_required'].includes(output?.verdict) &&
    blockingQuestions.length === 0;
  if (requiresExecution) {
    if (!prompt) {
      addError(
        errors,
        'NEXT_PROMPT_REQUIRED',
        'continue o fix_required sin preguntas bloqueantes requiere nextPrompt ejecutable.',
        'nextPrompt',
      );
    } else if (!nonBlank(prompt, 8)) {
      addError(
        errors,
        'NEXT_PROMPT_NOT_EXECUTABLE',
        'nextPrompt debe contener una instrucción ejecutable concreta.',
        'nextPrompt',
      );
    }
    if (recommendedChanges.length < minimumRecommendedChanges) {
      addError(
        errors,
        'RECOMMENDED_CHANGES_INSUFFICIENT',
        `Se requieren al menos ${minimumRecommendedChanges} correcciones estructuradas.`,
        'recommendedChanges',
      );
    }
  }
  if (
    blockingQuestions.length > 0 ||
    NON_EXECUTABLE_VERDICTS.has(output?.verdict)
  ) {
    if (prompt || recommendedChanges.length > 0) {
      addError(
        errors,
        'VERDICT_PROMPT_INCONSISTENT',
        'El veredicto o las preguntas bloqueantes no admiten prompt ni correcciones ejecutables.',
        'nextPrompt',
      );
    }
  }

  return {
    passed: errors.length === 0,
    applicable: true,
    errors,
    groundedCategories: detectedCategories,
    declaredCategories: detectedCategories,
    detectedCategories,
    detectedIssues,
    presentCategories,
    categoryAudit,
    recommendedChanges,
  };
}

function assertStructuredVisualOutput(output, options = {}) {
  const validation = validateStructuredVisualOutput(output, options);
  if (!validation.passed) {
    const failure = validation.errors[0];
    throw new CoordinationError(failure.message, {
      code: failure.code,
    });
  }
  return output;
}

module.exports = {
  AUDITABLE_VISUAL_CATEGORIES,
  VISUAL_CATEGORIES,
  assertStructuredVisualOutput,
  deriveVisualFindings,
  validateStructuredVisualOutput,
};
