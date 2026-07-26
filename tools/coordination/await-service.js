'use strict';

const path = require('node:path');

const {
  assertPathInside,
  pathExists,
  readJsonLimited,
  sha256File,
} = require('./atomic-fs');
const { getCoordinationPaths } = require('./constants');
const { CoordinationError } = require('./errors');
const { readHeartbeat } = require('./heartbeat');
const {
  coordinatorProposalHash,
  getRevision,
  getSubmissionId,
  isV2Payload,
} = require('./identity');
const { StateStore } = require('./state-store');

class CoordinationAwaitService {
  constructor(options) {
    this.repoRoot = options.repoRoot;
    this.paths = getCoordinationPaths(options.repoRoot);
    this.config = options.config;
    this.stateStore = options.stateStore || new StateStore({ repoRoot: options.repoRoot });
    this.sleep = options.sleep || ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now || (() => Date.now());
  }

  async inspect(criteria) {
    const state = await this.stateStore.load();
    const active = state.pendingByDomain[criteria.domain];
    const submission = criteria.submissionId
      ? state.submissions[criteria.submissionId]
      : Object.values(state.submissions).find((entry) =>
        entry?.taskId === criteria.taskId &&
        (!criteria.revision || Number(entry.revision) === Number(criteria.revision)));
    const processed = Object.values(state.processedFiles).find((entry) =>
      entry?.taskId === criteria.taskId &&
      (!criteria.submissionId || entry.submissionId === criteria.submissionId) &&
      (!criteria.handoffHash || entry.hash === criteria.handoffHash));

    if (processed?.status === 'failed') {
      throw new CoordinationError('El watcher no pudo generar la revisión.', {
        code: processed.error?.code || 'COORDINATION_REVIEW_FAILED',
      });
    }
    if (submission?.status === 'failed') {
      throw new CoordinationError('El watcher no pudo generar la revisión.', {
        code: 'COORDINATION_REVIEW_FAILED',
      });
    }
    const newerRevision = Object.values(state.submissions).find((entry) =>
      entry?.taskId === criteria.taskId &&
      criteria.revision &&
      Number(entry.revision) > Number(criteria.revision) &&
      entry.status !== 'failed');
    if (newerRevision) {
      throw new CoordinationError('La revisión solicitada fue reemplazada por una posterior.', {
        code: 'REVISION_REPLACED',
      });
    }
    if (!active) {
      const heartbeat = await readHeartbeat(this.repoRoot, {
        staleMs: this.config.heartbeatStaleMs,
        now: this.now,
      });
      if (!heartbeat?.active) {
        throw new CoordinationError('El watcher no está activo o su heartbeat venció.', {
          code: 'WATCHER_INACTIVE',
        });
      }
      return null;
    }
    if (active.taskId !== criteria.taskId) {
      if (
        ['queued', 'processing', 'retrying', 'awaiting_review'].includes(processed?.status) ||
        ['queued', 'processing', 'retrying', 'awaiting_review'].includes(submission?.status)
      ) {
        const heartbeat = await readHeartbeat(this.repoRoot, {
          staleMs: this.config.heartbeatStaleMs,
          now: this.now,
        });
        if (!heartbeat?.active) {
          throw new CoordinationError('El watcher no está activo o su heartbeat venció.', {
            code: 'WATCHER_INACTIVE',
          });
        }
        return null;
      }
      throw new CoordinationError('La propuesta fue reemplazada por otra tarea del dominio.', {
        code: 'REVIEW_REPLACED',
      });
    }
    if (criteria.revision && Number(active.revision) !== Number(criteria.revision)) {
      if (
        Number(active.revision) < Number(criteria.revision) &&
        ['queued', 'processing', 'retrying', 'awaiting_review'].includes(
          submission?.status || processed?.status,
        )
      ) {
        const heartbeat = await readHeartbeat(this.repoRoot, {
          staleMs: this.config.heartbeatStaleMs,
          now: this.now,
        });
        if (!heartbeat?.active) {
          throw new CoordinationError('El watcher no está activo o su heartbeat venció.', {
            code: 'WATCHER_INACTIVE',
          });
        }
        return null;
      }
      throw new CoordinationError('La revisión solicitada ya no es la vigente.', {
        code: 'REVISION_REPLACED',
      });
    }
    if (criteria.submissionId && active.submissionId !== criteria.submissionId) {
      if (
        ['queued', 'processing', 'retrying', 'awaiting_review'].includes(
          submission?.status || processed?.status,
        )
      ) {
        const heartbeat = await readHeartbeat(this.repoRoot, {
          staleMs: this.config.heartbeatStaleMs,
          now: this.now,
        });
        if (!heartbeat?.active) {
          throw new CoordinationError('El watcher no está activo o su heartbeat venció.', {
            code: 'WATCHER_INACTIVE',
          });
        }
        return null;
      }
      throw new CoordinationError('El submission solicitado ya no es el vigente.', {
        code: 'SUBMISSION_REPLACED',
      });
    }
    if (criteria.handoffHash && active.sourceHash !== criteria.handoffHash) {
      throw new CoordinationError('El hash del handoff no coincide con la revisión.', {
        code: 'HANDOFF_HASH_MISMATCH',
      });
    }
    if (['rejected', 'closed'].includes(active.status)) {
      throw new CoordinationError('La propuesta ya no admite continuación.', {
        code: active.status === 'closed' ? 'TASK_ALREADY_CLOSED' : 'REVIEW_REJECTED',
      });
    }
    if (!['pending', 'presented', 'shown'].includes(active.status)) {
      const heartbeat = await readHeartbeat(this.repoRoot, {
        staleMs: this.config.heartbeatStaleMs,
        now: this.now,
      });
      if (!heartbeat?.active) {
        throw new CoordinationError('El watcher no está activo o su heartbeat venció.', {
          code: 'WATCHER_INACTIVE',
        });
      }
      return null;
    }

    const candidate = assertPathInside(
      path.join(this.paths.pending, criteria.domain),
      path.resolve(this.repoRoot, active.path),
      'Pending',
    );
    if (!await pathExists(candidate)) {
      throw new CoordinationError('El archivo de revisión registrado no existe.', {
        code: 'PENDING_FILE_MISSING',
      });
    }
    const output = await readJsonLimited(candidate, this.config.maxResponseBytes);
    const actualFileHash = await sha256File(candidate, this.config.maxResponseBytes);
    const proposalHash = isV2Payload(output)
      ? coordinatorProposalHash(output)
      : active.pendingHash || active.shownHash;
    if (active.proposalHash && proposalHash !== active.proposalHash) {
      throw new CoordinationError('La propuesta cambió después de ser registrada.', {
        code: 'PROPOSAL_HASH_CHANGED',
      });
    }
    if (active.fileHash && active.fileHash !== actualFileHash) {
      throw new CoordinationError('El archivo de propuesta cambió después de registrarse.', {
        code: 'PROPOSAL_FILE_HASH_CHANGED',
      });
    }
    if (
      isV2Payload(output) &&
      (
        output.taskId !== criteria.taskId ||
        output.domain !== criteria.domain ||
        Number(output.revision) !== Number(active.revision)
      )
    ) {
      throw new CoordinationError('La propuesta no conserva la identidad solicitada.', {
        code: 'REVIEW_IDENTITY_MISMATCH',
      });
    }
    return {
      status: 'review_ready',
      taskId: output.taskId,
      submissionId: active.submissionId || getSubmissionId(output),
      revision: getRevision(output),
      domain: criteria.domain,
      proposalHash,
      fileHash: actualFileHash,
      output,
      presented: active.status === 'presented' || active.status === 'shown',
      executed: false,
    };
  }

  async wait(criteria) {
    const timeoutMs = criteria.timeoutMs ?? this.config.awaitTimeoutMs;
    const pollMs = criteria.pollMs ?? this.config.awaitPollMs;
    const deadline = this.now() + timeoutMs;
    while (this.now() <= deadline) {
      const result = await this.inspect(criteria);
      if (result) return result;
      await this.sleep(Math.min(pollMs, Math.max(0, deadline - this.now())));
    }
    throw new CoordinationError('Venció el tiempo de espera de la revisión.', {
      code: 'COORDINATION_AWAIT_TIMEOUT',
    });
  }
}

module.exports = {
  CoordinationAwaitService,
};
