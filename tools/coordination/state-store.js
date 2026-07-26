'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const {
  atomicWriteJson,
  ensureDirectory,
  pathExists,
  readJsonLimited,
} = require('./atomic-fs');
const { DOMAINS, getCoordinationPaths } = require('./constants');
const { CoordinationError, safeErrorSummary } = require('./errors');
const { waitForLock } = require('./lock');

const MAX_STATE_BYTES = 5 * 1024 * 1024;
const MAX_HISTORY = 200;

function createEmptyState() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    processedFiles: {},
    hashes: {},
    pendingByDomain: {},
    queuedByDomain: {},
    approvals: {},
    presentations: {},
    transfers: {},
    observations: {},
    submissions: {},
    tasks: {},
    proposalApprovals: {},
    currentProposalByTask: {},
    errors: [],
    retries: {},
    activity: [],
  };
}

function normalizeState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CoordinationError('state.json debe contener un objeto.', {
      code: 'INVALID_STATE',
    });
  }
  if (input.version !== 1) {
    throw new CoordinationError('state.json usa una versión no soportada.', {
      code: 'UNSUPPORTED_STATE_VERSION',
    });
  }
  const base = createEmptyState();
  const result = { ...base, ...input };
  for (const key of [
    'processedFiles',
    'hashes',
    'pendingByDomain',
    'queuedByDomain',
    'approvals',
    'presentations',
    'transfers',
    'observations',
    'submissions',
    'tasks',
    'proposalApprovals',
    'currentProposalByTask',
    'retries',
  ]) {
    if (!result[key] || typeof result[key] !== 'object' || Array.isArray(result[key])) {
      throw new CoordinationError(`state.json contiene ${key} inválido.`, {
        code: 'INVALID_STATE',
      });
    }
  }
  for (const key of ['errors', 'activity']) {
    if (!Array.isArray(result[key])) {
      throw new CoordinationError(`state.json contiene ${key} inválido.`, {
        code: 'INVALID_STATE',
      });
    }
  }
  return result;
}

async function ensureCoordinationStructure(repoRoot) {
  const paths = getCoordinationPaths(repoRoot);
  const directories = [
    paths.inbox,
    paths.processing,
    paths.approved,
    paths.rejected,
    paths.completed,
    paths.failed,
    paths.runtime,
    paths.queue,
    paths.tasks,
    paths.presentations,
    paths.transfers,
    paths.evidence,
  ];
  for (const domain of DOMAINS) {
    directories.push(path.join(paths.pending, domain));
    directories.push(path.join(paths.queue, domain));
  }
  await Promise.all(directories.map((directory) => ensureDirectory(directory)));

  if (!await pathExists(paths.state)) {
    try {
      await atomicWriteJson(paths.state, createEmptyState(), {
        root: paths.root,
        overwrite: false,
      });
    } catch (error) {
      if (error.code !== 'DESTINATION_EXISTS') throw error;
    }
  }
  return paths;
}

class StateStore {
  constructor(options = {}) {
    this.repoRoot = options.repoRoot;
    this.paths = getCoordinationPaths(options.repoRoot);
    this.lockWaitMs = options.lockWaitMs ?? 5_000;
    this.lockStaleMs = options.lockStaleMs ?? 30_000;
    this.queue = Promise.resolve();
  }

  async initialize() {
    await ensureCoordinationStructure(this.repoRoot);
    return this.load();
  }

  async load() {
    if (!await pathExists(this.paths.state)) return createEmptyState();
    return normalizeState(await readJsonLimited(this.paths.state, MAX_STATE_BYTES));
  }

  async mutate(mutator) {
    const operation = async () => {
      await ensureCoordinationStructure(this.repoRoot);
      const lock = await waitForLock(this.paths.stateLock, {
        waitMs: this.lockWaitMs,
        staleMs: this.lockStaleMs,
      });
      try {
        const state = await this.load();
        const result = await mutator(state);
        state.updatedAt = new Date().toISOString();
        state.errors = state.errors.slice(-MAX_HISTORY);
        state.activity = state.activity.slice(-MAX_HISTORY);
        await atomicWriteJson(this.paths.state, state, {
          root: this.paths.root,
          overwrite: true,
        });
        return result;
      } finally {
        await lock.release();
      }
    };

    const pending = this.queue.then(operation, operation);
    this.queue = pending.catch(() => {});
    return pending;
  }

  async recordError(error, context = {}) {
    const safe = safeErrorSummary(error);
    return this.mutate((state) => {
      state.errors.push({
        ...safe,
        file: context.file ? path.basename(context.file) : null,
        taskId: context.taskId || null,
        at: new Date().toISOString(),
      });
    });
  }

  async recordActivity(type, details = {}) {
    return this.mutate((state) => {
      state.activity.push({
        type,
        taskId: details.taskId || null,
        domain: details.domain || null,
        at: new Date().toISOString(),
      });
    });
  }

  async clearForTests() {
    if (process.env.NODE_ENV !== 'test') {
      throw new CoordinationError('clearForTests solo está disponible en tests.', {
        code: 'TEST_ONLY_OPERATION',
      });
    }
    await fs.writeFile(this.paths.state, `${JSON.stringify(createEmptyState(), null, 2)}\n`);
  }
}

module.exports = {
  StateStore,
  createEmptyState,
  ensureCoordinationStructure,
  normalizeState,
};
