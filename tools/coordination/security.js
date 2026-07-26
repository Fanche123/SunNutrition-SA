'use strict';

const path = require('node:path');

const { DOMAINS } = require('./constants');
const { CoordinationError, redactSecrets } = require('./errors');

const FORBIDDEN_KEY = /(?:api[_-]?key|secret|password|passwd|authorization|cookie|access[_-]?token|refresh[_-]?token)/i;
const SECRET_VALUE = /(?:\bsk-[A-Za-z0-9_-]{8,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b|\bOPENAI_API_KEY\s*[:=]\s*\S+)/i;
const FORBIDDEN_REFERENCE = /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|node_modules|\.git|\.codex[\\/]attachments?|attachments?|caches?|tmp)(?:[\\/]|$)/i;
const FORBIDDEN_BINARY_EXTENSION = /\.(?:pdf|png|jpe?g|gif|webp|bmp|tiff?|zip|7z|rar|docx?|xlsx?|pptx?|db|sqlite3?|csv|tsv)$/i;
const EXTERNAL_PATH = /(?:^|[\s"'`])(?:[A-Za-z]:[\\/]|\\\\[^\\]|\/(?:etc|home|users|var|tmp|private)(?:[\\/]|$)|file:\/\/)/i;
const EXTERNAL_URL = /(?:^|[\s"'`])https?:\/\/\S+/i;
const PARENT_TRAVERSAL = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const EMBEDDED_BINARY_REFERENCE = /(?:^|[\s"'`])\S+\.(?:pdf|png|jpe?g|gif|webp|bmp|tiff?|zip|7z|rar|docx?|xlsx?|pptx?|db|sqlite3?|csv|tsv)(?:$|[\s"'`,;])/i;
const EMBEDDED_DATA_REFERENCE = /(?:^|[\s"'`])data:[^,\s]+,/i;
const SAFE_EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
const SAFE_EVIDENCE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}\.(?:png|jpg|jpeg|webp)$/i;
const VISUAL_EVIDENCE_REFERENCE_PATHS = Object.freeze([
  /^\$\.visualReview\.images\[\d+\]\.filename$/,
  /^\$\.visualReview\.images\[\d+\]\.observations\[\d+\]$/,
  /^\$\.visualReview\.categoryAudit\[\d+\]\.(?:description|evidence)$/,
  /^\$\.visualReview\.crossImageFindings\[\d+\]$/,
]);
const PERSONAL_DATA_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:CUIT|CUIL)\s*[:#-]?\s*\d{2}-?\d{8}-?\d\b/i,
  /\bDNI\s*[:#-]?\s*\d{7,8}\b/i,
  /\b(?:tel[eé]fono|celular|whatsapp)\s*[:#-]?\s*\+?[\d\s()-]{8,}\b/i,
];
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertAllowedDomain(domain, label = 'domain') {
  if (!DOMAINS.includes(domain)) {
    throw new CoordinationError(`${label} no pertenece a un dominio permitido.`, {
      code: 'INVALID_DOMAIN',
    });
  }
  return domain;
}

function assertSafeTaskId(taskId, label = 'taskId') {
  if (
    typeof taskId !== 'string' ||
    !SAFE_TASK_ID.test(taskId) ||
    taskId.includes('..')
  ) {
    throw new CoordinationError(`${label} no es seguro para usar como identificador.`, {
      code: 'INVALID_TASK_ID',
    });
  }
  return taskId;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isVisualEvidenceReferencePath(currentPath) {
  return VISUAL_EVIDENCE_REFERENCE_PATHS.some((pattern) =>
    pattern.test(currentPath));
}

function maskExactEvidenceReferences(value, references) {
  let masked = value;
  for (const reference of references) {
    const escaped = escapeRegExp(reference);
    const exactReference = new RegExp(
      `(^|[\\s"'\\x60([{,;:])${escaped}(?=$|[\\s"'\\x60)\\]},;:!.])`,
      'g',
    );
    masked = masked.replace(exactReference, '$1[evidencia-validada]');
  }
  return masked;
}

function evidenceReferenceSets(references) {
  const identifiers = new Set();
  const filenames = new Set();
  for (const [index, reference] of (references || []).entries()) {
    // El path del manifest nunca integra la allowlist de la salida.
    const evidenceId = typeof reference === 'string'
      ? reference
      : reference?.evidenceId;
    const filename = typeof reference === 'string'
      ? reference
      : reference?.filename;
    if (
      typeof evidenceId !== 'string' ||
      !SAFE_EVIDENCE_ID.test(evidenceId) ||
      evidenceId.includes('..') ||
      (
        FORBIDDEN_BINARY_EXTENSION.test(evidenceId) &&
        !SAFE_EVIDENCE_FILENAME.test(evidenceId)
      )
    ) {
      throw new CoordinationError(
        `La evidencia autorizada ${index} tiene un evidenceId inseguro.`,
        { code: 'FORBIDDEN_FILE_REFERENCE' },
      );
    }
    identifiers.add(evidenceId);
    if (filename !== undefined && filename !== null) {
      if (
        typeof filename !== 'string' ||
        !SAFE_EVIDENCE_FILENAME.test(filename) ||
        path.basename(filename) !== filename ||
        filename.includes('..')
      ) {
        throw new CoordinationError(
          `La evidencia autorizada ${index} tiene un filename inseguro.`,
          { code: 'FORBIDDEN_FILE_REFERENCE' },
        );
      }
      filenames.add(filename);
    }
  }
  return {
    identifiers,
    filenames,
    allowedTextReferences: new Set([...identifiers, ...filenames]),
  };
}

function coordinatorEvidenceReferences(output) {
  const images = Array.isArray(output?.visualReview?.images)
    ? output.visualReview.images
    : [];
  return images.map((image) => ({
    evidenceId: image?.filename,
    filename: image?.filename,
  }));
}

function assertNoSecretMaterial(value, label = 'contenido', options = {}) {
  const allowedEvidenceReferences =
    options.allowedEvidenceReferences instanceof Set
      ? options.allowedEvidenceReferences
      : new Set(options.allowedEvidenceReferences || []);
  const allowEvidenceReferenceAtPath =
    typeof options.allowEvidenceReferenceAtPath === 'function'
      ? options.allowEvidenceReferenceAtPath
      : () => false;
  const visit = (current, currentPath) => {
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${currentPath}[${index}]`));
      return;
    }
    if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) {
        if (FORBIDDEN_KEY.test(key)) {
          throw new CoordinationError(`${label} contiene una clave sensible en ${currentPath}.`, {
            code: 'SENSITIVE_CONTENT',
          });
        }
        visit(child, `${currentPath}.${key}`);
      }
      return;
    }
    if (typeof current !== 'string') return;
    if (SECRET_VALUE.test(current)) {
      throw new CoordinationError(`${label} contiene material con apariencia de secreto.`, {
        code: 'SENSITIVE_CONTENT',
      });
    }
    if (PERSONAL_DATA_PATTERNS.some((pattern) => pattern.test(current))) {
      throw new CoordinationError(`${label} contiene datos personales identificables.`, {
        code: 'PERSONAL_DATA_CONTENT',
      });
    }
    if (FORBIDDEN_REFERENCE.test(current)) {
      throw new CoordinationError(`${label} contiene una referencia excluida.`, {
        code: 'FORBIDDEN_FILE_REFERENCE',
      });
    }
    if (
      EXTERNAL_PATH.test(current) ||
      EXTERNAL_URL.test(current) ||
      PARENT_TRAVERSAL.test(current.replace(/\\/g, '/'))
    ) {
      throw new CoordinationError(`${label} contiene una ruta externa o transversal.`, {
        code: 'PATH_OUTSIDE_ALLOWED_ROOT',
      });
    }
    if (EMBEDDED_DATA_REFERENCE.test(current)) {
      throw new CoordinationError(`${label} contiene contenido embebido no permitido.`, {
        code: 'EMBEDDED_BINARY_CONTENT',
      });
    }
    const binaryReferenceView =
      allowedEvidenceReferences.size > 0 &&
      allowEvidenceReferenceAtPath(currentPath)
        ? maskExactEvidenceReferences(current, allowedEvidenceReferences)
        : current;
    if (EMBEDDED_BINARY_REFERENCE.test(binaryReferenceView)) {
      throw new CoordinationError(`${label} referencia un adjunto o binario excluido.`, {
        code: 'FORBIDDEN_FILE_REFERENCE',
      });
    }
    if (current.length > 2_048 && /^[A-Za-z0-9+/=\r\n]+$/.test(current)) {
      throw new CoordinationError(`${label} contiene un bloque codificado no permitido.`, {
        code: 'EMBEDDED_BINARY_CONTENT',
      });
    }
  };
  visit(value, '$');
}

function assertSafeCoordinatorOutput(output, label = 'Salida', options = {}) {
  if (output?.version !== '2.0') {
    assertNoSecretMaterial(output, label);
    return output;
  }
  const hasExplicitReferences =
    Object.prototype.hasOwnProperty.call(options, 'evidenceReferences');
  const references = hasExplicitReferences
    ? options.evidenceReferences
    : coordinatorEvidenceReferences(output);
  const {
    identifiers,
    filenames,
    allowedTextReferences,
  } = evidenceReferenceSets(references);
  const allowedCanonicalReferences = new Set([...identifiers, ...filenames]);
  const images = Array.isArray(output?.visualReview?.images)
    ? output.visualReview.images
    : [];
  for (const [index, image] of images.entries()) {
    const filename = image?.filename;
    if (
      typeof filename !== 'string' ||
      !SAFE_EVIDENCE_FILENAME.test(filename) ||
      path.basename(filename) !== filename ||
      filename.includes('..') ||
      !allowedCanonicalReferences.has(filename)
    ) {
      throw new CoordinationError(
        `${label} referencia una evidencia no autorizada en visualReview.images[${index}].filename.`,
        { code: 'FORBIDDEN_FILE_REFERENCE' },
      );
    }
  }
  assertNoSecretMaterial(output, label, {
    allowedEvidenceReferences: allowedTextReferences,
    allowEvidenceReferenceAtPath: isVisualEvidenceReferencePath,
  });
  return output;
}

function assertSafeRepositoryFile(reference, label) {
  if (typeof reference !== 'string' || reference.trim() === '') {
    throw new CoordinationError(`${label} debe ser una ruta relativa no vacía.`, {
      code: 'INVALID_FILE_REFERENCE',
    });
  }
  const normalized = reference.replace(/\\/g, '/').trim();
  if (
    path.isAbsolute(reference) ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized === '..'
  ) {
    throw new CoordinationError(`${label} debe permanecer dentro del repositorio.`, {
      code: 'PATH_OUTSIDE_ALLOWED_ROOT',
    });
  }
  if (FORBIDDEN_REFERENCE.test(normalized) || FORBIDDEN_BINARY_EXTENSION.test(normalized)) {
    throw new CoordinationError(`${label} referencia contenido excluido de coordinación.`, {
      code: 'FORBIDDEN_FILE_REFERENCE',
    });
  }
}

function assertSafeHandoff(handoff) {
  assertNoSecretMaterial(handoff, 'El handoff');
  assertAllowedDomain(handoff.domain);
  assertSafeTaskId(handoff.taskId);
  if (handoff.parentTaskId !== null && handoff.parentTaskId !== undefined) {
    assertSafeTaskId(handoff.parentTaskId, 'parentTaskId');
  }

  for (const field of ['filesCreated', 'filesModified']) {
    for (const [index, reference] of (handoff[field] || []).entries()) {
      assertSafeRepositoryFile(reference, `${field}[${index}]`);
    }
  }

  for (const field of ['gitStatus', 'diffSummary']) {
    for (const entry of handoff[field] || []) {
      if (FORBIDDEN_REFERENCE.test(String(entry))) {
        throw new CoordinationError(`${field} contiene una referencia excluida.`, {
          code: 'FORBIDDEN_FILE_REFERENCE',
        });
      }
    }
  }
  return handoff;
}

function lineContainsForbiddenReference(line) {
  const value = String(line);
  return (
    FORBIDDEN_REFERENCE.test(value) ||
    EMBEDDED_BINARY_REFERENCE.test(value) ||
    FORBIDDEN_BINARY_EXTENSION.test(value.trim()) ||
    PERSONAL_DATA_PATTERNS.some((pattern) => pattern.test(value))
  );
}

function sanitizeGitOutput(output, maxBytes) {
  const allowedLines = String(output || '')
    .split(/\r?\n/)
    .filter((line) => !lineContainsForbiddenReference(line))
    .map((line) => redactSecrets(line))
    .join('\n');
  const buffer = Buffer.from(allowedLines, 'utf8');
  if (buffer.byteLength <= maxBytes) return allowedLines;
  return `${buffer.subarray(0, maxBytes).toString('utf8')}\n[TRUNCADO]`;
}

function sanitizeNotificationText(value, maximum = 140) {
  return redactSecrets(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

module.exports = {
  assertAllowedDomain,
  assertNoSecretMaterial,
  assertSafeCoordinatorOutput,
  assertSafeHandoff,
  assertSafeRepositoryFile,
  assertSafeTaskId,
  coordinatorEvidenceReferences,
  lineContainsForbiddenReference,
  sanitizeGitOutput,
  sanitizeNotificationText,
};
