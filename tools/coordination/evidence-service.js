'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  assertPathInside,
  readFileLimited,
  readJsonLimited,
} = require('./atomic-fs');
const { getCoordinationPaths } = require('./constants');
const { CoordinationError } = require('./errors');
const { assertSchema, loadSchema } = require('./schema-validator');
const { assertSafeTaskId } = require('./security');

const DEFAULT_MAX_IMAGES = 5;
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 15 * 1024 * 1024;
const DEFAULT_MAX_MANIFEST_BYTES = 256 * 1024;
const ALLOWED_MIME_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
]);
const EXTENSION_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
});
const SAFE_MANIFEST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;
const SAFE_IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}\.(?:png|jpg|jpeg|webp)$/i;
const HARD_SECRET_PATTERNS = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{8,}\b/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/i,
  /\bOPENAI_API_KEY\s*[:=]\s*\S+/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd)\s*[:=]\s*\S{6,}/i,
]);
const PERSONAL_DATA_PATTERNS = Object.freeze([
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:CUIT|CUIL)\s*[:#-]?\s*\d{2}-?\d{8}-?\d\b/i,
  /\bDNI\s*[:#-]?\s*\d{7,8}\b/i,
  /\b(?:tel[eé]fono|celular|whatsapp)\s*[:#-]?\s*\+?[\d\s()-]{8,}\b/i,
]);

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sniffImageMime(buffer) {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function imageDataUrl(buffer, mimeType) {
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    throw new CoordinationError('No se puede codificar un MIME de imagen no permitido.', {
      code: 'EVIDENCE_MIME_NOT_ALLOWED',
    });
  }
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function textualSignals(value) {
  const text = String(value || '');
  return {
    hardSecret: HARD_SECRET_PATTERNS.some((pattern) => pattern.test(text)),
    personalData: PERSONAL_DATA_PATTERNS.some((pattern) => pattern.test(text)),
  };
}

function binarySignals(buffer) {
  // Los metadatos de PNG/JPEG/WebP pueden contener texto en claro. Esto no
  // sustituye OCR: la declaración del manifest sigue siendo obligatoria.
  const sample = buffer.toString('latin1');
  return textualSignals(sample);
}

function makeBlockedResult(manifest, reasons, totalBytes = 0) {
  const uniqueReasons = reasons.filter(
    (entry, index, all) =>
      all.findIndex((candidate) =>
        candidate.code === entry.code && candidate.evidenceId === entry.evidenceId) === index,
  );
  return {
    manifest,
    blocked: true,
    blockedReasons: uniqueReasons,
    blockedQuestions: uniqueReasons.map((entry) => entry.question),
    evidenceIds: manifest?.images?.map((entry) => entry.filename) || [],
    images: [],
    inputImages: [],
    totalBytes,
  };
}

async function assertRegularNonSymlink(candidate, expectedType, label) {
  let stat;
  try {
    stat = await fs.lstat(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new CoordinationError(`${label} no existe.`, {
        code: 'EVIDENCE_PATH_NOT_FOUND',
      });
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new CoordinationError(`${label} no puede ser un enlace simbólico.`, {
      code: 'EVIDENCE_SYMLINK_FORBIDDEN',
    });
  }
  const valid = expectedType === 'directory' ? stat.isDirectory() : stat.isFile();
  if (!valid) {
    throw new CoordinationError(`${label} no tiene el tipo esperado.`, {
      code: 'EVIDENCE_INVALID_FILE_TYPE',
    });
  }
  return stat;
}

function assertManifestSemantics(manifest, options) {
  if (manifest.taskId !== options.taskId) {
    throw new CoordinationError('El manifest pertenece a otro taskId.', {
      code: 'EVIDENCE_TASK_MISMATCH',
    });
  }
  if (
    options.revision !== undefined &&
    Number(manifest.revision) !== Number(options.revision)
  ) {
    throw new CoordinationError('El manifest pertenece a otra revisión.', {
      code: 'EVIDENCE_REVISION_MISMATCH',
    });
  }
  if (
    options.visualImpact &&
    manifest.visualImpact !== options.visualImpact
  ) {
    throw new CoordinationError('El impacto visual del manifest no coincide.', {
      code: 'EVIDENCE_VISUAL_IMPACT_MISMATCH',
    });
  }
  if (manifest.readOnlyCaptureConfirmed !== true) {
    throw new CoordinationError('La captura no confirma ausencia de escrituras.', {
      code: 'EVIDENCE_READ_ONLY_NOT_CONFIRMED',
    });
  }
  if (manifest.images.some((entry) => entry.possiblySensitive) && !manifest.possiblySensitive) {
    throw new CoordinationError(
      'El manifest debe marcarse sensible cuando una captura lo está.',
      { code: 'EVIDENCE_SENSITIVITY_MISMATCH' },
    );
  }
  if (manifest.possiblySensitive && !manifest.sensitiveReason) {
    throw new CoordinationError('El manifest sensible requiere un motivo.', {
      code: 'EVIDENCE_SENSITIVITY_REASON_REQUIRED',
    });
  }
  for (const image of manifest.images) {
    if (image.readOnlyCaptureConfirmed !== true) {
      throw new CoordinationError(
        `La captura ${image.filename} no confirma ausencia de escrituras.`,
        { code: 'EVIDENCE_READ_ONLY_NOT_CONFIRMED' },
      );
    }
    if (image.possiblySensitive && !image.sensitiveReason) {
      throw new CoordinationError(
        `La captura ${image.filename} requiere un motivo de sensibilidad.`,
        { code: 'EVIDENCE_SENSITIVITY_REASON_REQUIRED' },
      );
    }
  }
}

class EvidenceService {
  constructor(options = {}) {
    if (!options.repoRoot) {
      throw new CoordinationError('EvidenceService requiere repoRoot.', {
        code: 'MISSING_REPO_ROOT',
      });
    }
    this.repoRoot = path.resolve(options.repoRoot);
    this.paths = getCoordinationPaths(this.repoRoot);
    this.evidenceRoot = path.join(this.paths.root, 'evidence');
    this.manifestSchemaPath = path.join(this.paths.root, 'evidence-manifest.schema.json');
    this.manifestSchema = options.manifestSchema || null;
    const config = options.config || {};
    this.maxImages = options.maxImages ??
      config.maxEvidenceImages ??
      DEFAULT_MAX_IMAGES;
    this.maxImageBytes = options.maxImageBytes ??
      config.maxEvidenceImageBytes ??
      DEFAULT_MAX_IMAGE_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ??
      config.maxEvidenceTotalBytes ??
      DEFAULT_MAX_TOTAL_BYTES;
    this.maxManifestBytes = options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES;
    this.imageDetail = options.evidenceImageDetail ??
      config.evidenceImageDetail ??
      'auto';
    if (!['auto', 'low', 'high'].includes(this.imageDetail)) {
      throw new CoordinationError('evidenceImageDetail debe ser auto, low o high.', {
        code: 'INVALID_EVIDENCE_IMAGE_DETAIL',
      });
    }
  }

  async getSchema() {
    if (!this.manifestSchema) {
      this.manifestSchema = await loadSchema(this.manifestSchemaPath);
    }
    return this.manifestSchema;
  }

  taskEvidenceDirectory(taskId) {
    return path.join(this.evidenceRoot, assertSafeTaskId(taskId));
  }

  resolveManifestPath(taskId, manifestReference) {
    const taskDirectory = this.taskEvidenceDirectory(taskId);
    const reference = manifestReference ||
      `.coordination/evidence/${taskId}/manifest.json`;
    if (typeof reference !== 'string' || path.isAbsolute(reference)) {
      throw new CoordinationError('El manifest debe usar una ruta relativa.', {
        code: 'EVIDENCE_MANIFEST_PATH_INVALID',
      });
    }
    const normalized = reference.replace(/\\/g, '/');
    const expectedPrefix = `.coordination/evidence/${taskId}/`;
    if (
      !normalized.startsWith(expectedPrefix) ||
      normalized.slice(expectedPrefix.length).includes('/') ||
      !SAFE_MANIFEST_NAME.test(path.basename(normalized))
    ) {
      throw new CoordinationError('El manifest debe estar en la carpeta exacta de la tarea.', {
        code: 'EVIDENCE_MANIFEST_PATH_INVALID',
      });
    }
    return assertPathInside(
      taskDirectory,
      path.resolve(this.repoRoot, normalized),
      'Manifest de evidencias',
    );
  }

  async validateRoots(taskId, manifestPath) {
    const taskDirectory = this.taskEvidenceDirectory(taskId);
    await assertRegularNonSymlink(this.evidenceRoot, 'directory', 'Carpeta de evidencias');
    await assertRegularNonSymlink(taskDirectory, 'directory', 'Carpeta de evidencias de la tarea');
    await assertRegularNonSymlink(manifestPath, 'file', 'Manifest de evidencias');

    const [realEvidenceRoot, realTaskDirectory, realManifest] = await Promise.all([
      fs.realpath(this.evidenceRoot),
      fs.realpath(taskDirectory),
      fs.realpath(manifestPath),
    ]);
    assertPathInside(realEvidenceRoot, realTaskDirectory, 'Carpeta real de evidencias');
    assertPathInside(realTaskDirectory, realManifest, 'Manifest real de evidencias');
    return { taskDirectory, realTaskDirectory };
  }

  async prepareEvidenceInputs(options = {}) {
    const taskId = assertSafeTaskId(options.taskId);
    const manifestPath = this.resolveManifestPath(taskId, options.manifestPath);
    const roots = await this.validateRoots(taskId, manifestPath);
    const schema = await this.getSchema();
    const manifest = await readJsonLimited(manifestPath, this.maxManifestBytes);
    assertSchema(manifest, schema, 'Manifest de evidencias');
    assertManifestSemantics(manifest, {
      taskId,
      revision: options.revision,
      visualImpact: options.visualImpact,
    });

    if (manifest.images.length > this.maxImages) {
      throw new CoordinationError(
        `El manifest supera el máximo configurado de ${this.maxImages} imágenes.`,
        { code: 'EVIDENCE_TOO_MANY_IMAGES' },
      );
    }

    const authorizationReasons = [];
    if (manifest.possiblySensitive && manifest.authorizedForApi !== true) {
      authorizationReasons.push({
        code: 'EVIDENCE_AUTHORIZATION_REQUIRED',
        evidenceId: 'manifest',
        question:
          'La evidencia fue marcada como posiblemente sensible. Autorizá expresamente su envío a la API o generá una captura sanitizada.',
      });
    }
    for (const image of manifest.images) {
      if (image.possiblySensitive && image.authorizedForApi !== true) {
        authorizationReasons.push({
          code: 'EVIDENCE_AUTHORIZATION_REQUIRED',
          evidenceId: image.filename,
          question:
            `La captura ${image.filename} fue marcada como posiblemente sensible. Autorizá expresamente su envío o reemplazala por una versión sanitizada.`,
        });
      }
    }
    if (authorizationReasons.length > 0) {
      return makeBlockedResult(manifest, authorizationReasons);
    }

    const images = [];
    const blockedReasons = [];
    let totalBytes = 0;
    const seenPaths = new Set();
    const seenHashes = new Set();

    for (const entry of manifest.images) {
      if (!SAFE_IMAGE_NAME.test(entry.filename) || path.basename(entry.filename) !== entry.filename) {
        throw new CoordinationError('El manifest contiene un nombre de imagen inseguro.', {
          code: 'EVIDENCE_FILENAME_INVALID',
        });
      }
      const expectedRelative =
        `.coordination/evidence/${taskId}/${entry.filename}`;
      if (entry.path.replace(/\\/g, '/') !== expectedRelative) {
        throw new CoordinationError(
          `La ruta declarada para ${entry.filename} no coincide con su tarea.`,
          { code: 'EVIDENCE_PATH_MISMATCH' },
        );
      }
      if (seenPaths.has(entry.path) || seenHashes.has(entry.sha256)) {
        throw new CoordinationError('El manifest contiene evidencias duplicadas.', {
          code: 'EVIDENCE_DUPLICATE',
        });
      }
      seenPaths.add(entry.path);
      seenHashes.add(entry.sha256);

      const candidate = assertPathInside(
        roots.taskDirectory,
        path.resolve(this.repoRoot, entry.path),
        'Imagen de evidencia',
      );
      const stat = await assertRegularNonSymlink(
        candidate,
        'file',
        `Evidencia ${entry.filename}`,
      );
      const realCandidate = await fs.realpath(candidate);
      assertPathInside(roots.realTaskDirectory, realCandidate, 'Imagen real de evidencia');

      if (stat.size !== entry.sizeBytes) {
        throw new CoordinationError(
          `El tamaño de ${entry.filename} no coincide con el manifest.`,
          { code: 'EVIDENCE_SIZE_MISMATCH' },
        );
      }
      if (stat.size > this.maxImageBytes) {
        throw new CoordinationError(
          `La imagen ${entry.filename} supera el máximo individual.`,
          { code: 'EVIDENCE_IMAGE_TOO_LARGE' },
        );
      }
      totalBytes += stat.size;
      if (totalBytes > this.maxTotalBytes) {
        throw new CoordinationError('Las evidencias superan el máximo total permitido.', {
          code: 'EVIDENCE_TOTAL_TOO_LARGE',
        });
      }

      const buffer = await readFileLimited(candidate, this.maxImageBytes);
      const actualMime = sniffImageMime(buffer);
      const extensionMime = EXTENSION_MIME[path.extname(entry.filename).toLowerCase()];
      if (
        !actualMime ||
        !ALLOWED_MIME_TYPES.includes(actualMime) ||
        actualMime !== entry.mimeType ||
        extensionMime !== actualMime
      ) {
        throw new CoordinationError(
          `El MIME real de ${entry.filename} no coincide o no está permitido.`,
          { code: 'EVIDENCE_MIME_MISMATCH' },
        );
      }
      const actualHash = sha256Buffer(buffer);
      if (actualHash !== entry.sha256) {
        throw new CoordinationError(
          `El hash de ${entry.filename} no coincide con el manifest.`,
          { code: 'EVIDENCE_HASH_MISMATCH' },
        );
      }

      const metadataSignals = textualSignals(`${entry.screen}\n${entry.state}`);
      const contentSignals = binarySignals(buffer);
      if (metadataSignals.hardSecret || contentSignals.hardSecret) {
        blockedReasons.push({
          code: 'EVIDENCE_HARD_SECRET_DETECTED',
          evidenceId: entry.filename,
          question:
            `La captura ${entry.filename} contiene material con apariencia de clave o token. Debe reemplazarse por una evidencia sanitizada; la autorización no habilita su envío.`,
        });
        continue;
      }
      const detectedPersonalData =
        metadataSignals.personalData || contentSignals.personalData;
      if (
        detectedPersonalData &&
        !(manifest.authorizedForApi === true && entry.authorizedForApi === true)
      ) {
        blockedReasons.push({
          code: 'EVIDENCE_PERSONAL_DATA_AUTHORIZATION_REQUIRED',
          evidenceId: entry.filename,
          question:
            `La captura ${entry.filename} puede contener datos personales. Autorizá expresamente su envío en el manifest o generá una versión sanitizada.`,
        });
        continue;
      }

      const dataUrl = imageDataUrl(buffer, actualMime);
      images.push({
        evidenceId: entry.filename,
        filename: entry.filename,
        mimeType: actualMime,
        sizeBytes: stat.size,
        sha256: actualHash,
        viewport: entry.viewport,
        screen: entry.screen,
        state: entry.state,
        capturedAt: entry.capturedAt,
        visualImpact: entry.visualImpact,
        dataUrl,
      });
    }

    if (blockedReasons.length > 0) {
      return makeBlockedResult(manifest, blockedReasons, totalBytes);
    }

    return {
      manifest,
      blocked: false,
      blockedReasons: [],
      blockedQuestions: [],
      evidenceIds: images.map((entry) => entry.evidenceId),
      images,
      inputImages: images.map((entry) => ({
        type: 'input_image',
        image_url: entry.dataUrl,
        detail: this.imageDetail,
      })),
      totalBytes,
    };
  }
}

async function prepareEvidenceInputs(options) {
  const service = options.service || new EvidenceService(options);
  return service.prepareEvidenceInputs(options);
}

module.exports = {
  ALLOWED_MIME_TYPES,
  EvidenceService,
  imageDataUrl,
  prepareEvidenceInputs,
  sha256Buffer,
  sniffImageMime,
};
