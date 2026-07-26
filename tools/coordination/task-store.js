'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  atomicWriteJson,
  ensureDirectory,
  pathExists,
  readJsonLimited,
} = require('./atomic-fs');
const { getCoordinationPaths } = require('./constants');
const { CoordinationError } = require('./errors');
const { waitForLock } = require('./lock');
const { assertSchema, loadSchema } = require('./schema-validator');
const {
  assertAllowedDomain,
  assertNoSecretMaterial,
  assertSafeTaskId,
} = require('./security');

const DEFAULT_MAX_TASK_BYTES = 2 * 1024 * 1024;
const DEFAULT_LOCK_WAIT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const MAX_CONTEXT_EVENTS = 20;
const MAX_CONTEXT_REVISIONS = 10;
const MAX_CONTEXT_OBSERVATIONS = 20;
const MAX_CONTEXT_DECISIONS = 20;
const MAX_CONTEXT_APPROVALS = 10;
const MAX_CONTEXT_TRANSFERS = 10;

function nowIso(now = Date.now) {
  return new Date(now()).toISOString();
}

function randomId(prefix, randomBytes = crypto.randomBytes) {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

function createTaskId(domain, options = {}) {
  assertAllowedDomain(domain);
  const instant = new Date((options.now || Date.now)())
    .toISOString()
    .replace(/[-:.]/g, '')
    .replace('Z', 'Z');
  const suffix = (options.randomBytes || crypto.randomBytes)(5).toString('hex');
  return assertSafeTaskId(`${domain}-${instant}-${suffix}`);
}

function cleanText(value, label, maximum) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CoordinationError(`${label} debe ser texto no vacío.`, {
      code: 'INVALID_TASK_TEXT',
    });
  }
  const text = value.trim();
  if (text.length > maximum) {
    throw new CoordinationError(`${label} excede ${maximum} caracteres.`, {
      code: 'TASK_TEXT_TOO_LARGE',
    });
  }
  assertNoSecretMaterial(text, label);
  return text;
}

function nullableHash(value, label) {
  if (value === null || value === undefined) return null;
  if (!/^[a-f0-9]{64}$/.test(String(value))) {
    throw new CoordinationError(`${label} no es un SHA-256 válido.`, {
      code: 'INVALID_TASK_HASH',
    });
  }
  return String(value);
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) {
    throw new CoordinationError(`${label} contiene identidades duplicadas.`, {
      code: 'DUPLICATE_TASK_HISTORY_IDENTITY',
    });
  }
}

function assertTaskInvariants(task, schema) {
  assertSchema(task, schema, 'Tarea coordinada');
  assertSafeTaskId(task.taskId);
  assertAllowedDomain(task.initialDomain, 'initialDomain');
  assertAllowedDomain(task.currentDomain, 'currentDomain');
  assertNoSecretMaterial(task, 'La tarea coordinada');

  assertUnique(task.revisions.map((entry) => entry.revision), 'revisions.revision');
  assertUnique(task.revisions.map((entry) => entry.submissionId), 'revisions.submissionId');
  assertUnique(task.observations.map((entry) => entry.observationId), 'observations');
  assertUnique(task.decisions.map((entry) => entry.decisionId), 'decisions');
  assertUnique(task.events.map((entry) => entry.eventId), 'events');
  assertUnique(
    task.approvals.map((entry) => `${entry.revision}:${entry.proposalHash}`),
    'approvals',
  );
  assertUnique(
    task.transfers.map((entry) => `${entry.revision}:${entry.proposalHash}`),
    'transfers',
  );

  const highestRevision = task.revisions.reduce(
    (highest, entry) => Math.max(highest, entry.revision),
    0,
  );
  if (task.nextRevision <= highestRevision) {
    throw new CoordinationError(
      'nextRevision debe ser mayor que todas las revisiones registradas.',
      { code: 'INVALID_NEXT_REVISION' },
    );
  }
  return task;
}

function makeEvent(input, options = {}) {
  const at = input.at || nowIso(options.now);
  const eventId = input.eventId || randomId('event', options.randomBytes);
  return {
    eventId: assertSafeTaskId(eventId, 'eventId'),
    type: String(input.type || '').trim(),
    at,
    domain: input.domain ?? null,
    revision: input.revision ?? null,
    proposalHash: nullableHash(input.proposalHash, 'event.proposalHash'),
    summary: cleanText(input.summary, 'event.summary', 4_000),
  };
}

function makeInitialTask(input, options = {}) {
  const createdAt = input.createdAt || nowIso(options.now);
  const initialDomain = assertAllowedDomain(input.initialDomain, 'initialDomain');
  const taskId = input.taskId
    ? assertSafeTaskId(input.taskId)
    : createTaskId(initialDomain, options);
  const task = {
    version: '2.0',
    taskId,
    createdAt,
    updatedAt: createdAt,
    status: input.status || 'initial_prompt_issued',
    sourceChat: cleanText(input.sourceChat || 'chat:coordinador', 'sourceChat', 200),
    originalRequest: cleanText(input.originalRequest, 'originalRequest', 30_000),
    objective: cleanText(
      input.objective || input.originalRequest,
      'objective',
      30_000,
    ),
    initialDomain,
    currentDomain: initialDomain,
    initialPrompt: cleanText(input.initialPrompt, 'initialPrompt', 30_000),
    historySummary: String(input.historySummary || '').trim().slice(0, 20_000),
    nextRevision: 1,
    revisions: [],
    observations: [],
    decisions: [],
    approvals: [],
    transfers: [],
    events: [],
  };
  task.events.push(makeEvent({
    type: 'task_created',
    at: createdAt,
    domain: initialDomain,
    summary: 'Solicitud original registrada y primer prompt emitido por el Coordinador.',
  }, options));
  return task;
}

function taskContextForCoordinator(task, options = {}) {
  const tail = (values, maximum) => values.slice(-maximum);
  const context = {
    taskId: task.taskId,
    status: task.status,
    originalRequest: task.originalRequest,
    objective: task.objective,
    initialDomain: task.initialDomain,
    currentDomain: task.currentDomain,
    initialPrompt: task.initialPrompt,
    historySummary: task.historySummary,
    nextRevision: task.nextRevision,
    revisions: tail(task.revisions, options.maxRevisions ?? MAX_CONTEXT_REVISIONS),
    observations: tail(
      task.observations,
      options.maxObservations ?? MAX_CONTEXT_OBSERVATIONS,
    ),
    decisions: tail(task.decisions, options.maxDecisions ?? MAX_CONTEXT_DECISIONS),
    approvals: tail(task.approvals, options.maxApprovals ?? MAX_CONTEXT_APPROVALS),
    transfers: tail(task.transfers, options.maxTransfers ?? MAX_CONTEXT_TRANSFERS),
    recentEvents: tail(task.events, options.maxEvents ?? MAX_CONTEXT_EVENTS),
  };
  assertNoSecretMaterial(context, 'El contexto runtime de la tarea');
  return context;
}

class TaskStore {
  constructor(options = {}) {
    if (!options.repoRoot) {
      throw new CoordinationError('TaskStore requiere repoRoot.', {
        code: 'MISSING_REPO_ROOT',
      });
    }
    this.repoRoot = path.resolve(options.repoRoot);
    this.paths = getCoordinationPaths(this.repoRoot);
    this.tasksRoot = path.join(this.paths.runtime, 'tasks');
    this.taskSchemaPath = path.join(this.paths.root, 'task.schema.json');
    this.taskSchema = options.taskSchema || null;
    this.maxTaskBytes = options.maxTaskBytes ?? DEFAULT_MAX_TASK_BYTES;
    this.lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
    this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    this.now = options.now || Date.now;
    this.randomBytes = options.randomBytes || crypto.randomBytes;
  }

  async getSchema() {
    if (!this.taskSchema) {
      this.taskSchema = await loadSchema(this.taskSchemaPath);
    }
    return this.taskSchema;
  }

  taskDirectory(taskId) {
    return path.join(this.tasksRoot, assertSafeTaskId(taskId));
  }

  taskPath(taskId) {
    return path.join(this.taskDirectory(taskId), 'task.json');
  }

  lockPath(taskId) {
    return path.join(this.taskDirectory(taskId), 'task.lock');
  }

  async create(input) {
    const schema = await this.getSchema();
    const task = makeInitialTask(input, {
      now: this.now,
      randomBytes: this.randomBytes,
    });
    assertTaskInvariants(task, schema);
    const directory = this.taskDirectory(task.taskId);
    await ensureDirectory(directory);
    await atomicWriteJson(this.taskPath(task.taskId), task, {
      root: this.paths.root,
      overwrite: false,
      validateJson: (value) => assertTaskInvariants(value, schema),
    });
    return task;
  }

  async exists(taskId) {
    return pathExists(this.taskPath(taskId));
  }

  async rollbackCreate(expectedTask) {
    const taskId = assertSafeTaskId(expectedTask?.taskId);
    const directory = this.taskDirectory(taskId);
    const lock = await waitForLock(this.lockPath(taskId), {
      waitMs: this.lockWaitMs,
      staleMs: this.lockStaleMs,
    });
    try {
      const current = await this.load(taskId);
      if (JSON.stringify(current) !== JSON.stringify(expectedTask)) {
        throw new CoordinationError(
          'La tarea cambió y no puede revertirse como una creación incompleta.',
          { code: 'TASK_CHANGED_DURING_CREATE_ROLLBACK' },
        );
      }
      await fs.unlink(this.taskPath(taskId));
    } finally {
      await lock.release();
    }
    await fs.rmdir(directory).catch((error) => {
      if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
    });
  }

  async load(taskId) {
    const schema = await this.getSchema();
    const candidate = this.taskPath(taskId);
    if (!await pathExists(candidate)) {
      throw new CoordinationError(`No existe la tarea ${taskId}.`, {
        code: 'TASK_NOT_FOUND',
      });
    }
    return assertTaskInvariants(
      await readJsonLimited(candidate, this.maxTaskBytes),
      schema,
    );
  }

  async mutate(taskId, mutator) {
    assertSafeTaskId(taskId);
    if (typeof mutator !== 'function') {
      throw new CoordinationError('TaskStore.mutate requiere una función.', {
        code: 'INVALID_TASK_MUTATOR',
      });
    }
    await ensureDirectory(this.taskDirectory(taskId));
    const lock = await waitForLock(this.lockPath(taskId), {
      waitMs: this.lockWaitMs,
      staleMs: this.lockStaleMs,
    });
    try {
      const schema = await this.getSchema();
      const current = await this.load(taskId);
      const proposed = await mutator(current);
      const updated = proposed && proposed !== current ? proposed : current;
      updated.updatedAt = nowIso(this.now);
      assertTaskInvariants(updated, schema);
      await atomicWriteJson(this.taskPath(taskId), updated, {
        root: this.paths.root,
        overwrite: true,
        validateJson: (value) => assertTaskInvariants(value, schema),
      });
      return updated;
    } finally {
      await lock.release();
    }
  }

  async appendEvent(taskId, input) {
    return this.mutate(taskId, (task) => {
      task.events.push(makeEvent(input, {
        now: this.now,
        randomBytes: this.randomBytes,
      }));
      return task;
    });
  }

  async recordRevision(taskId, input) {
    return this.mutate(taskId, (task) => {
      const revision = Number(input.revision ?? task.nextRevision);
      const timestamp = input.createdAt || nowIso(this.now);
      task.revisions.push({
        revision,
        submissionId: assertSafeTaskId(input.submissionId, 'submissionId'),
        domain: assertAllowedDomain(input.domain, 'revision.domain'),
        status: input.status || 'awaiting_review',
        handoffHash: nullableHash(input.handoffHash, 'revision.handoffHash'),
        proposalHash: nullableHash(input.proposalHash, 'revision.proposalHash'),
        summary: String(input.summary || '').trim().slice(0, 8_000),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      task.nextRevision = Math.max(task.nextRevision, revision + 1);
      task.status = input.taskStatus || 'awaiting_review';
      task.currentDomain = input.domain;
      task.events.push(makeEvent({
        type: 'revision_recorded',
        at: timestamp,
        domain: input.domain,
        revision,
        proposalHash: input.proposalHash ?? null,
        summary: input.summary || `Revisión ${revision} registrada.`,
      }, {
        now: this.now,
        randomBytes: this.randomBytes,
      }));
      return task;
    });
  }

  async recordObservation(taskId, input) {
    return this.mutate(taskId, (task) => {
      const observation = {
        observationId: assertSafeTaskId(
          input.observationId || randomId('observation', this.randomBytes),
          'observationId',
        ),
        revision: Number(input.revision),
        text: cleanText(input.text, 'observation.text', 8_000),
        createdAt: input.createdAt || nowIso(this.now),
        status: input.status || 'pending',
      };
      task.observations.push(observation);
      task.events.push(makeEvent({
        type: 'user_observation_recorded',
        at: observation.createdAt,
        domain: task.currentDomain,
        revision: observation.revision,
        summary: 'Se registró una observación textual del usuario para una nueva revisión.',
      }, {
        now: this.now,
        randomBytes: this.randomBytes,
      }));
      return task;
    });
  }

  async recordApproval(taskId, input) {
    return this.mutate(taskId, (task) => {
      const approval = {
        revision: Number(input.revision),
        proposalHash: nullableHash(input.proposalHash, 'approval.proposalHash'),
        domain: assertAllowedDomain(input.domain, 'approval.domain'),
        targetDomain: assertAllowedDomain(input.targetDomain, 'approval.targetDomain'),
        prompt: input.prompt === null
          ? null
          : cleanText(input.prompt, 'approval.prompt', 30_000),
        approvedAt: input.approvedAt || nowIso(this.now),
        approvedBy: cleanText(input.approvedBy || 'usuario', 'approval.approvedBy', 200),
        status: input.status || 'approved',
      };
      if (!approval.proposalHash) {
        throw new CoordinationError('La aprobación requiere proposalHash.', {
          code: 'INVALID_TASK_HASH',
        });
      }
      task.approvals.push(approval);
      task.status = approval.status === 'closed' ? 'closed' : 'approved';
      task.events.push(makeEvent({
        type: approval.status === 'closed' ? 'task_closed' : 'proposal_approved',
        at: approval.approvedAt,
        domain: approval.domain,
        revision: approval.revision,
        proposalHash: approval.proposalHash,
        summary: approval.status === 'closed'
          ? 'El usuario aprobó el cierre.'
          : 'El usuario aprobó la propuesta sin ejecución automática.',
      }, {
        now: this.now,
        randomBytes: this.randomBytes,
      }));
      return task;
    });
  }

  async recordDecision(taskId, input) {
    return this.mutate(taskId, (task) => {
      const decision = {
        decisionId: assertSafeTaskId(
          input.decisionId || randomId('decision', this.randomBytes),
          'decisionId',
        ),
        text: cleanText(input.text, 'decision.text', 8_000),
        createdAt: input.createdAt || nowIso(this.now),
        domain: assertAllowedDomain(
          input.domain || task.currentDomain,
          'decision.domain',
        ),
        revision: input.revision === null || input.revision === undefined
          ? null
          : Number(input.revision),
      };
      task.decisions.push(decision);
      task.events.push(makeEvent({
        type: 'decision_recorded',
        at: decision.createdAt,
        domain: decision.domain,
        revision: decision.revision,
        summary: 'Se registró una decisión previa relevante para la tarea.',
      }, {
        now: this.now,
        randomBytes: this.randomBytes,
      }));
      return task;
    });
  }

  async recordTransfer(taskId, input) {
    return this.mutate(taskId, (task) => {
      const transfer = {
        revision: Number(input.revision),
        proposalHash: nullableHash(input.proposalHash, 'transfer.proposalHash'),
        fromDomain: assertAllowedDomain(input.fromDomain, 'transfer.fromDomain'),
        toDomain: assertAllowedDomain(input.toDomain, 'transfer.toDomain'),
        prompt: cleanText(input.prompt, 'transfer.prompt', 30_000),
        approvedAt: input.approvedAt || nowIso(this.now),
        status: input.status || 'pending',
      };
      if (!transfer.proposalHash) {
        throw new CoordinationError('La transferencia requiere proposalHash.', {
          code: 'INVALID_TASK_HASH',
        });
      }
      task.transfers.push(transfer);
      task.status = 'transferred';
      task.currentDomain = transfer.toDomain;
      task.events.push(makeEvent({
        type: 'task_transferred',
        at: transfer.approvedAt,
        domain: transfer.toDomain,
        revision: transfer.revision,
        proposalHash: transfer.proposalHash,
        summary: `Transferencia aprobada de ${transfer.fromDomain} a ${transfer.toDomain}.`,
      }, {
        now: this.now,
        randomBytes: this.randomBytes,
      }));
      return task;
    });
  }

  async setHistorySummary(taskId, summary) {
    const value = String(summary || '').trim();
    if (value.length > 20_000) {
      throw new CoordinationError('historySummary excede 20000 caracteres.', {
        code: 'TASK_TEXT_TOO_LARGE',
      });
    }
    if (value) assertNoSecretMaterial(value, 'historySummary');
    return this.mutate(taskId, (task) => {
      task.historySummary = value;
      return task;
    });
  }

  async context(taskId, options = {}) {
    return taskContextForCoordinator(await this.load(taskId), options);
  }
}

module.exports = {
  TaskStore,
  assertTaskInvariants,
  createTaskId,
  makeInitialTask,
  taskContextForCoordinator,
};
