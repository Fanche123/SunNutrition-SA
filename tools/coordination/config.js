'use strict';

const fs = require('node:fs/promises');

const { DEFAULT_CONFIG, getCoordinationPaths } = require('./constants');
const { CoordinationError } = require('./errors');

const OPENAI_MAX_REQUEST_BYTES = 25 * 1024 * 1024;
const REQUEST_ENVELOPE_RESERVE_BYTES = 1024 * 1024;

const NUMBER_RULES = Object.freeze({
  debounceMs: [25, 60_000],
  scanIntervalMs: [250, 24 * 60 * 60_000],
  stableFileMs: [0, 60_000],
  lockStaleMs: [5_000, 24 * 60 * 60_000],
  stateLockWaitMs: [100, 60_000],
  maxHandoffBytes: [1_024, 5 * 1024 * 1024],
  maxContextFileBytes: [1_024, 1024 * 1024],
  maxDiffBytes: [1_024, 1024 * 1024],
  maxTotalContextBytes: [8_192, 5 * 1024 * 1024],
  maxResponseBytes: [1_024, 2 * 1024 * 1024],
  maxOutputTokens: [256, 32_000],
  retries: [0, 10],
  initialBackoffMs: [10, 60_000],
  maxBackoffMs: [10, 10 * 60_000],
  apiTimeoutMs: [1_000, 10 * 60_000],
  awaitTimeoutMs: [1_000, 60 * 60_000],
  awaitPollMs: [50, 60_000],
  heartbeatIntervalMs: [250, 60_000],
  heartbeatStaleMs: [1_000, 10 * 60_000],
  maxEvidenceImages: [0, 20],
  maxEvidenceImageBytes: [1_024, 25 * 1024 * 1024],
  maxEvidenceTotalBytes: [1_024, 100 * 1024 * 1024],
});

function flattenConfig(input) {
  const result = { ...input };
  const sections = [
    'watcher',
    'limits',
    'retry',
    'api',
    'await',
    'heartbeat',
    'evidence',
  ];
  for (const section of sections) {
    if (input?.[section] && typeof input[section] === 'object') {
      Object.assign(result, input[section]);
    }
  }

  const notificationSource = input?.notification ?? input?.notifications;
  if (typeof notificationSource === 'boolean') {
    result.notification = { enabled: notificationSource };
  } else if (notificationSource && typeof notificationSource === 'object') {
    result.notification = {
      enabled: Boolean(notificationSource.enabled),
    };
  }

  return result;
}

function validateConfig(input, sourceLabel = '.coordination/config.json') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CoordinationError(`${sourceLabel} debe contener un objeto JSON.`, {
      code: 'INVALID_CONFIG',
    });
  }

  const flat = flattenConfig(input);
  const result = {
    ...DEFAULT_CONFIG,
    notification: { ...DEFAULT_CONFIG.notification },
  };

  for (const [key, [minimum, maximum]] of Object.entries(NUMBER_RULES)) {
    if (flat[key] === undefined) continue;
    const value = Number(flat[key]);
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new CoordinationError(
        `${sourceLabel}: ${key} debe estar entre ${minimum} y ${maximum}.`,
        { code: 'INVALID_CONFIG' },
      );
    }
    result[key] = Math.floor(value);
  }

  if (flat.notification !== undefined) {
    result.notification = {
      enabled: Boolean(flat.notification?.enabled),
    };
  }
  if (flat.evidenceImageDetail !== undefined) {
    if (!['low', 'high', 'auto'].includes(flat.evidenceImageDetail)) {
      throw new CoordinationError(
        `${sourceLabel}: evidenceImageDetail debe ser low, high o auto.`,
        { code: 'INVALID_CONFIG' },
      );
    }
    result.evidenceImageDetail = flat.evidenceImageDetail;
  }

  if (result.maxBackoffMs < result.initialBackoffMs) {
    throw new CoordinationError(
      `${sourceLabel}: maxBackoffMs no puede ser menor que initialBackoffMs.`,
      { code: 'INVALID_CONFIG' },
    );
  }
  if (result.heartbeatStaleMs <= result.heartbeatIntervalMs) {
    throw new CoordinationError(
      `${sourceLabel}: heartbeatStaleMs debe ser mayor que heartbeatIntervalMs.`,
      { code: 'INVALID_CONFIG' },
    );
  }
  if (result.maxEvidenceTotalBytes < result.maxEvidenceImageBytes) {
    throw new CoordinationError(
      `${sourceLabel}: maxEvidenceTotalBytes no puede ser menor que maxEvidenceImageBytes.`,
      { code: 'INVALID_CONFIG' },
    );
  }
  const estimatedMultimodalRequestBytes =
    Math.ceil(result.maxEvidenceTotalBytes * 4 / 3) +
    result.maxTotalContextBytes +
    REQUEST_ENVELOPE_RESERVE_BYTES;
  if (estimatedMultimodalRequestBytes > OPENAI_MAX_REQUEST_BYTES) {
    throw new CoordinationError(
      `${sourceLabel}: la evidencia configurada excede el límite seguro del request multimodal.`,
      { code: 'INVALID_CONFIG' },
    );
  }

  return result;
}

async function loadConfig(repoRoot) {
  const paths = getCoordinationPaths(repoRoot);
  let content;
  try {
    content = await fs.readFile(paths.config, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return validateConfig({});
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new CoordinationError(
      '.coordination/config.json no contiene JSON válido.',
      { code: 'INVALID_CONFIG' },
    );
  }
  return validateConfig(parsed);
}

module.exports = {
  loadConfig,
  validateConfig,
};
