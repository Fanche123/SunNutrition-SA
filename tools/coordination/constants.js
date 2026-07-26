'use strict';

const path = require('node:path');

const DOMAINS = Object.freeze([
  'arquitectura',
  'inventario',
  'compras',
  'ventas',
  'tesoreria',
  'rrhh',
  'reportes',
  'contabilidad',
  'administracion',
  'ui-ux',
  'base-de-datos',
  'bugs',
  'nuevas-funcionalidades',
  'analista-funcional',
]);

const LEGACY_VERDICTS = Object.freeze([
  'close',
  'continue',
  'fix_required',
  'blocked',
  'needs_functional_decision',
  'needs_database_review',
  'needs_architecture_review',
]);

const V2_VERDICTS = Object.freeze([
  'continue',
  'fix_required',
  'close',
  'rejected',
  'blocked',
]);

const VERDICTS = Object.freeze([...new Set([...LEGACY_VERDICTS, ...V2_VERDICTS])]);

const DEFAULT_CONFIG = Object.freeze({
  debounceMs: 350,
  scanIntervalMs: 10_000,
  stableFileMs: 500,
  lockStaleMs: 5 * 60_000,
  stateLockWaitMs: 5_000,
  maxHandoffBytes: 256 * 1024,
  maxContextFileBytes: 64 * 1024,
  maxDiffBytes: 48 * 1024,
  maxTotalContextBytes: 320 * 1024,
  maxResponseBytes: 256 * 1024,
  maxOutputTokens: 4_000,
  retries: 3,
  initialBackoffMs: 750,
  maxBackoffMs: 12_000,
  apiTimeoutMs: 90_000,
  awaitTimeoutMs: 10 * 60_000,
  awaitPollMs: 750,
  heartbeatIntervalMs: 5_000,
  heartbeatStaleMs: 30_000,
  maxEvidenceImages: 6,
  maxEvidenceImageBytes: 5 * 1024 * 1024,
  maxEvidenceTotalBytes: 15 * 1024 * 1024,
  evidenceImageDetail: 'high',
  notification: Object.freeze({
    enabled: false,
  }),
});

function getRepoRoot() {
  return path.resolve(__dirname, '..', '..');
}

function getCoordinationPaths(repoRoot = getRepoRoot()) {
  const root = path.join(repoRoot, '.coordination');
  return {
    repoRoot,
    root,
    inbox: path.join(root, 'inbox'),
    processing: path.join(root, 'processing'),
    pending: path.join(root, 'pending'),
    approved: path.join(root, 'approved'),
    rejected: path.join(root, 'rejected'),
    completed: path.join(root, 'completed'),
    failed: path.join(root, 'failed'),
    runtime: path.join(root, 'runtime'),
    queue: path.join(root, 'runtime', 'queue'),
    tasks: path.join(root, 'runtime', 'tasks'),
    presentations: path.join(root, 'runtime', 'presentations'),
    transfers: path.join(root, 'runtime', 'transfers'),
    evidence: path.join(root, 'evidence'),
    heartbeat: path.join(root, 'runtime', 'watcher-heartbeat.json'),
    state: path.join(root, 'state.json'),
    stateLock: path.join(root, 'runtime', 'state.lock'),
    watcherLock: path.join(root, 'runtime', 'watcher.lock'),
    handoffSchema: path.join(root, 'handoff.schema.json'),
    handoffV2Schema: path.join(root, 'handoff-v2.schema.json'),
    coordinatorOutputSchema: path.join(root, 'coordinator-output.schema.json'),
    coordinatorOutputV2Schema: path.join(root, 'coordinator-output-v2.schema.json'),
    taskSchema: path.join(root, 'task.schema.json'),
    evidenceManifestSchema: path.join(root, 'evidence-manifest.schema.json'),
    projectContext: path.join(root, 'project-context.json'),
    projectContextSchema: path.join(root, 'project-context.schema.json'),
    config: path.join(root, 'config.json'),
  };
}

module.exports = {
  DEFAULT_CONFIG,
  DOMAINS,
  LEGACY_VERDICTS,
  V2_VERDICTS,
  VERDICTS,
  getCoordinationPaths,
  getRepoRoot,
};
