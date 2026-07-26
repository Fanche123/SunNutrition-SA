'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const {
  assertPathInside,
  atomicMove,
  atomicWriteJson,
  pathExists,
  readJsonLimited,
  sha256File,
} = require('./atomic-fs');
const { getReviewOutcome } = require('./coordinator-service');
const { DOMAINS, getCoordinationPaths } = require('./constants');
const { CoordinationError, safeErrorSummary } = require('./errors');
const { WatcherHeartbeat } = require('./heartbeat');
const {
  coordinatorProposalHash,
  coordinatorPromptHash,
  createSubmissionId,
  getOutputSummary,
  getRevision,
  getSubmissionId,
  isV2Payload,
  proposalFileName,
  submissionFileName,
} = require('./identity');
const { notifyPending } = require('./notification');
const { retryWithBackoff } = require('./retry');
const { assertSchema, loadSchema } = require('./schema-validator');
const {
  assertAllowedDomain,
  assertSafeCoordinatorOutput,
  assertSafeHandoff,
  assertSafeTaskId,
} = require('./security');
const { StateStore, ensureCoordinationStructure } = require('./state-store');
const { TaskStore } = require('./task-store');
const { assertStructuredVisualOutput } = require('./visual-contract');

function jsonFiles(entries) {
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function listJsonFiles(directory) {
  try {
    return jsonFiles(await fs.readdir(directory, { withFileTypes: true }));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function uniqueDestination(directory, originalName, suffix) {
  const extension = path.extname(originalName) || '.json';
  const stem = path.basename(originalName, extension);
  const first = path.join(directory, `${stem}.${suffix}${extension}`);
  if (!await pathExists(first)) return first;
  return path.join(
    directory,
    `${stem}.${suffix}.${Date.now()}-${process.pid}${extension}`,
  );
}

function snapshotEntry(container, key) {
  if (!Object.prototype.hasOwnProperty.call(container, key)) {
    return { exists: false, value: null };
  }
  return {
    exists: true,
    value: JSON.parse(JSON.stringify(container[key])),
  };
}

function restoreEntry(container, key, snapshot) {
  if (snapshot.exists) {
    container[key] = JSON.parse(JSON.stringify(snapshot.value));
  } else {
    delete container[key];
  }
}

async function restoreStateWithRetry(store, ...argumentsForMutate) {
  try {
    return await store.mutate(...argumentsForMutate);
  } catch {
    return store.mutate(...argumentsForMutate);
  }
}

class CoordinationWatcher {
  constructor(options) {
    this.repoRoot = options.repoRoot;
    this.paths = getCoordinationPaths(options.repoRoot);
    this.config = options.config;
    this.handoffSchema = options.handoffSchema;
    this.outputSchema = options.outputSchema;
    this.handoffV2Schema = options.handoffV2Schema || null;
    this.outputV2Schema = options.outputV2Schema || null;
    this.coordinator = options.coordinator;
    this.stateStore = options.stateStore || new StateStore({
      repoRoot: options.repoRoot,
      lockWaitMs: options.config.stateLockWaitMs,
      lockStaleMs: options.config.lockStaleMs,
    });
    this.taskStore = options.taskStore || new TaskStore({
      repoRoot: options.repoRoot,
      lockWaitMs: options.config.stateLockWaitMs,
      lockStaleMs: options.config.lockStaleMs,
    });
    this.logger = options.logger || console;
    this.sleep = options.sleep;
    this.random = options.random;
    this.notificationStream = options.notificationStream || process.stdout;
    this.atomicWriteJson = options.atomicWriteJson || atomicWriteJson;
    this.heartbeat = options.heartbeat || new WatcherHeartbeat({
      repoRoot: options.repoRoot,
      intervalMs: options.config.heartbeatIntervalMs,
      instanceId: createSubmissionId(),
    });
    this.activeFiles = new Set();
    this.fsWatcher = null;
    this.scanTimer = null;
    this.debounceTimer = null;
    this.stabilityTimer = null;
    this.scanPromise = null;
  }

  async initialize() {
    await ensureCoordinationStructure(this.repoRoot);
    await this.stateStore.initialize();
  }

  async handoffSchemaFor(handoff) {
    if (!isV2Payload(handoff)) return this.handoffSchema;
    if (!this.handoffV2Schema) {
      this.handoffV2Schema = await loadSchema(this.paths.handoffV2Schema);
    }
    return this.handoffV2Schema;
  }

  async outputSchemaFor(output) {
    if (!isV2Payload(output)) return this.outputSchema;
    if (!this.outputV2Schema) {
      this.outputV2Schema = await loadSchema(this.paths.coordinatorOutputV2Schema);
    }
    return this.outputV2Schema;
  }

  assertSafeOutput(output, label) {
    assertSafeCoordinatorOutput(output, label);
  }

  async isStable(filePath, waitForStable = false) {
    const stat = await fs.stat(filePath);
    let remaining = this.config.stableFileMs - (Date.now() - stat.mtimeMs);
    if (remaining <= 0) return true;
    if (!waitForStable) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = setTimeout(() => {
        this.scan().catch((error) => this.logger.error(safeErrorSummary(error)));
      }, remaining + 25);
      return false;
    }
    await (this.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
      remaining + 25,
    );
    const second = await fs.stat(filePath);
    return second.size === stat.size && second.mtimeMs === stat.mtimeMs;
  }

  async scan(options = {}) {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = (async () => {
      await this.heartbeat.beat();
      return this.performScan(options);
    })().finally(() => {
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  async performScan(options = {}) {
    await this.promoteQueued();
    const processing = await listJsonFiles(this.paths.processing);
    for (const name of processing) {
      await this.processClaimedFile(path.join(this.paths.processing, name));
    }

    const inbox = await listJsonFiles(this.paths.inbox);
    for (const name of inbox) {
      const source = path.join(this.paths.inbox, name);
      if (!await this.isStable(source, Boolean(options.waitForStable))) continue;
      await this.claimAndProcess(source);
    }
  }

  async claimAndProcess(source) {
    if (this.activeFiles.has(source)) return;
    this.activeFiles.add(source);
    try {
      const destination = path.join(this.paths.processing, path.basename(source));
      if (await pathExists(destination)) {
        throw new CoordinationError('Ya existe un archivo homónimo en processing.', {
          code: 'PROCESSING_NAME_COLLISION',
        });
      }
      await atomicMove(source, destination, { root: this.paths.root });
      await this.processClaimedFile(destination);
    } catch (error) {
      if (await pathExists(source)) await this.failFile(source, error);
      else throw error;
    } finally {
      this.activeFiles.delete(source);
    }
  }

  async findExistingResult(handoffOrTaskId, sourceHash) {
    const handoff = typeof handoffOrTaskId === 'object' ? handoffOrTaskId : null;
    const taskId = handoff?.taskId || handoffOrTaskId;
    const v2 = isV2Payload(handoff);
    const domains = v2 ? [handoff.domain] : DOMAINS;
    const fileName = v2
      ? proposalFileName({
        version: '2.0',
        taskId,
        revision: handoff.revision,
      })
      : `${taskId}.json`;
    for (const domain of domains) {
      for (const candidate of [
        path.join(this.paths.pending, domain, fileName),
        path.join(this.paths.queue, domain, fileName),
      ]) {
        if (!await pathExists(candidate)) continue;
        const output = await readJsonLimited(candidate, this.config.maxResponseBytes);
        assertSchema(output, await this.outputSchemaFor(output), 'Pending recuperado');
        assertStructuredVisualOutput(output, { minimumRecommendedChanges: 1 });
        this.assertSafeOutput(output, 'Pending recuperado');
        assertAllowedDomain(output.targetDomain, 'pending.targetDomain');
        const owningDomain = v2 ? output.domain : output.targetDomain;
        if (owningDomain !== domain || output.approvalRequired !== true) {
          throw new CoordinationError('El pending recuperado viola su dominio o aprobación.', {
            code: 'RECOVERED_PENDING_INVARIANT_VIOLATION',
          });
        }
        if (
          output.taskId === taskId &&
          output.sourceHash === sourceHash &&
          (!v2 || output.revision === handoff.revision)
        ) {
          return {
            output,
            candidate,
            domain,
            queued: candidate.startsWith(this.paths.queue),
            fileHash: await sha256File(candidate, this.config.maxResponseBytes),
          };
        }
      }
    }
    return null;
  }

  async releaseApprovedParent(handoff) {
    if (!handoff.parentTaskId) return;
    await this.stateStore.mutate((state) => {
      const active = state.pendingByDomain[handoff.domain];
      if (
        ['approved', 'executing'].includes(active?.status) &&
        active.taskId === handoff.parentTaskId
      ) {
        if (state.approvals[active.taskId]) {
          state.approvals[active.taskId].completedAt = new Date().toISOString();
          state.approvals[active.taskId].completionTaskId = handoff.taskId;
        }
        delete state.pendingByDomain[handoff.domain];
        state.activity.push({
          type: 'approved_task_completed',
          taskId: active.taskId,
          domain: handoff.domain,
          at: new Date().toISOString(),
        });
      }
    });
  }

  async assertNoCoordinationLoop(handoff, promptHash) {
    if (isV2Payload(handoff)) {
      const state = await this.stateStore.load();
      const repeated = Object.values(state.processedFiles).find((record) =>
        record?.taskId === handoff.taskId &&
        Number(record.revision) < Number(handoff.revision) &&
        record.promptHash === promptHash);
      if (repeated) {
        throw new CoordinationError(
          'La propuesta repite exactamente una instrucción de una revisión anterior.',
          { code: 'COORDINATION_LOOP_DETECTED' },
        );
      }
      return;
    }
    if (!handoff.parentTaskId) return;
    const state = await this.stateStore.load();
    const recordsByTask = new Map(
      Object.values(state.processedFiles)
        .filter((record) => record?.taskId)
        .map((record) => [record.taskId, record]),
    );
    const visited = new Set([handoff.taskId]);
    let ancestorTaskId = handoff.parentTaskId;

    for (let depth = 0; ancestorTaskId && depth < 50; depth += 1) {
      if (visited.has(ancestorTaskId)) {
        throw new CoordinationError('La cadena parentTaskId contiene un ciclo.', {
          code: 'COORDINATION_LOOP_DETECTED',
        });
      }
      visited.add(ancestorTaskId);
      const ancestor = recordsByTask.get(ancestorTaskId);
      if (!ancestor) return;
      if (ancestor.promptHash && ancestor.promptHash === promptHash) {
        throw new CoordinationError(
          'La propuesta repite una instrucción exacta dentro de su cadena de ancestros.',
          { code: 'COORDINATION_LOOP_DETECTED' },
        );
      }
      ancestorTaskId = ancestor.parentTaskId || null;
    }

    if (ancestorTaskId) {
      throw new CoordinationError(
        'La cadena parentTaskId supera el límite seguro de 50 niveles.',
        { code: 'COORDINATION_LOOP_DETECTED' },
      );
    }
  }

  async processClaimedFile(filePath) {
    const fileName = path.basename(filePath);
    if (this.activeFiles.has(filePath)) return;
    this.activeFiles.add(filePath);
    let handoff;
    let sourceHash;
    try {
      handoff = await readJsonLimited(filePath, this.config.maxHandoffBytes);
      const v2 = isV2Payload(handoff);
      assertSchema(handoff, await this.handoffSchemaFor(handoff), 'Handoff');
      assertSafeHandoff(handoff);
      if (fileName !== submissionFileName(handoff)) {
        throw new CoordinationError('El nombre del handoff no coincide con taskId.', {
          code: 'HANDOFF_FILENAME_MISMATCH',
        });
      }
      sourceHash = await sha256File(filePath, this.config.maxHandoffBytes);

      const state = await this.stateStore.load();
      const duplicate = state.hashes[sourceHash];
      if (duplicate) {
        const destination = await uniqueDestination(
          this.paths.completed,
          fileName,
          'duplicate',
        );
        await atomicMove(filePath, destination, { root: this.paths.root });
        await this.stateStore.mutate((current) => {
          const previous = current.processedFiles[fileName] || {};
          current.processedFiles[fileName] = {
            ...previous,
            taskId: handoff.taskId,
            hash: sourceHash,
            status: 'duplicate',
            duplicateOf: duplicate.taskId,
            completedAt: new Date().toISOString(),
          };
          current.activity.push({
            type: 'duplicate_ignored',
            taskId: handoff.taskId,
            domain: handoff.domain,
            at: new Date().toISOString(),
          });
        });
        return;
      }

      const reusedTask = !v2 && Object.values(state.processedFiles).find(
        (record) => record.taskId === handoff.taskId && record.hash !== sourceHash,
      );
      if (reusedTask) {
        throw new CoordinationError('El taskId ya fue usado con otro contenido.', {
          code: 'TASK_ID_REUSED',
        });
      }

      if (v2) {
        const task = await this.taskStore.load(handoff.taskId);
        const revision = task.revisions.find((entry) =>
          entry.revision === handoff.revision &&
          entry.submissionId === handoff.submissionId);
        if (!revision) {
          throw new CoordinationError(
            'La entrega v2 no está registrada en la tarea persistente.',
            { code: 'TASK_REVISION_NOT_FOUND' },
          );
        }
        if (revision.handoffHash && revision.handoffHash !== sourceHash) {
          throw new CoordinationError(
            'El hash del handoff no coincide con la revisión registrada.',
            { code: 'TASK_REVISION_HASH_MISMATCH' },
          );
        }
      }

      await this.releaseApprovedParent(handoff);
      const recovered = await this.findExistingResult(handoff, sourceHash);
      if (recovered) {
        const promptHash = coordinatorPromptHash(recovered.output);
        await this.assertNoCoordinationLoop(handoff, promptHash);
        await this.finishSuccessfulFile(
          filePath,
          fileName,
          handoff,
          sourceHash,
          { ...recovered, promptHash },
        );
        return;
      }

      await this.stateStore.mutate((current) => {
        current.processedFiles[fileName] = {
          taskId: handoff.taskId,
          parentTaskId: handoff.parentTaskId,
          submissionId: getSubmissionId(handoff),
          revision: getRevision(handoff),
          domain: handoff.domain,
          protocolVersion: v2 ? '2.0' : '1.0',
          hash: sourceHash,
          status: 'processing',
          startedAt: new Date().toISOString(),
        };
      });

      const output = await retryWithBackoff(
        () => this.coordinator.coordinate(handoff, sourceHash),
        {
          retries: this.config.retries,
          initialMs: this.config.initialBackoffMs,
          maximumMs: this.config.maxBackoffMs,
          sleep: this.sleep,
          random: this.random,
          onRetry: async ({ attempt, waitMs, error }) => {
            await this.stateStore.mutate((current) => {
              current.retries[sourceHash] = {
                count: attempt,
                lastAt: new Date().toISOString(),
                nextAt: new Date(Date.now() + waitMs).toISOString(),
                error: safeErrorSummary(error),
              };
            });
          },
        },
      );
      const reviewOutcome = getReviewOutcome(output);
      assertSchema(output, await this.outputSchemaFor(output), 'Salida del coordinador');
      assertStructuredVisualOutput(output, { minimumRecommendedChanges: 1 });
      this.assertSafeOutput(output, 'Salida del coordinador');
      assertSafeTaskId(output.taskId, 'output.taskId');
      assertAllowedDomain(output.targetDomain, 'output.targetDomain');
      if (output.taskId !== handoff.taskId || output.sourceHash !== sourceHash) {
        throw new CoordinationError('La salida no conserva la identidad del handoff.', {
          code: 'OUTPUT_IDENTITY_MISMATCH',
        });
      }
      if (output.approvalRequired !== true) {
        throw new CoordinationError('La salida intentó omitir aprobación humana.', {
          code: 'APPROVAL_INVARIANT_VIOLATION',
        });
      }

      const promptHash = coordinatorPromptHash(output);
      await this.assertNoCoordinationLoop(handoff, promptHash);
      if (v2 && (output.domain !== handoff.domain || output.revision !== handoff.revision)) {
        throw new CoordinationError('La salida cambió el dominio o revisión del handoff.', {
          code: 'OUTPUT_IDENTITY_MISMATCH',
        });
      }

      const placement = await this.placeResult(output, handoff);
      await this.finishSuccessfulFile(
        filePath,
        fileName,
        handoff,
        sourceHash,
        { output, promptHash, reviewOutcome, ...placement },
      );
    } catch (error) {
      await this.failFile(filePath, error, {
        taskId: handoff?.taskId,
        submissionId: handoff ? getSubmissionId(handoff) : null,
        revision: handoff ? getRevision(handoff) : null,
        domain: handoff?.domain || null,
        hash: sourceHash,
        reviewStatus: error?.reviewRepairStatus || null,
        repairErrors: error?.repairErrors || [],
      });
    } finally {
      this.activeFiles.delete(filePath);
    }
  }

  async placeResult(output, handoff = null) {
    const v2 = isV2Payload(output);
    const domain = v2 ? handoff?.domain || output.domain : output.targetDomain;
    const resultName = proposalFileName(output);
    const pendingPath = path.join(
      this.paths.pending,
      domain,
      resultName,
    );
    const queuedPath = path.join(
      this.paths.queue,
      domain,
      resultName,
    );
    let queued = false;
    let superseded = null;
    let supersededArchive = null;
    let candidateCreated = false;

    const initialState = await this.stateStore.load();
    const initialActive = initialState.pendingByDomain[domain];
    if (initialActive && initialActive.taskId !== output.taskId) {
      queued = true;
    } else if (v2 && initialActive?.taskId === output.taskId) {
      if (Number(initialActive.revision) > Number(output.revision)) {
        throw new CoordinationError('La revisión recibida ya fue reemplazada.', {
          code: 'STALE_TASK_REVISION',
        });
      }
      if (
        Number(initialActive.revision) === Number(output.revision) &&
        initialActive.submissionId &&
        initialActive.submissionId !== handoff.submissionId
      ) {
        throw new CoordinationError('La revisión ya tiene otra entrega vigente.', {
          code: 'REVISION_SUBMISSION_CONFLICT',
        });
      }
      if (Number(initialActive.revision) < Number(output.revision)) {
        superseded = { ...initialActive };
        if (!['approved', 'executing'].includes(initialActive.status)) {
          const previousPath = assertPathInside(
            path.join(this.paths.pending, domain),
            path.resolve(this.repoRoot, initialActive.path),
            'Pending reemplazado',
          );
          if (await pathExists(previousPath)) {
            supersededArchive = await uniqueDestination(
              this.paths.rejected,
              path.basename(previousPath),
              'superseded',
            );
            await atomicMove(previousPath, supersededArchive, { root: this.paths.root });
          }
        }
      }
    }

    const submissionKey = v2 ? handoff.submissionId : output.taskId;
    const placementSnapshot = {
      pending: snapshotEntry(initialState.pendingByDomain, domain),
      queue: snapshotEntry(initialState.queuedByDomain, domain),
      submission: snapshotEntry(initialState.submissions, submissionKey),
      currentProposal: snapshotEntry(initialState.currentProposalByTask, output.taskId),
      supersededSubmission: superseded?.submissionId
        ? snapshotEntry(initialState.submissions, superseded.submissionId)
        : null,
      supersededApproval: superseded?.proposalHash
        ? snapshotEntry(initialState.proposalApprovals, superseded.proposalHash)
        : null,
    };

    try {
      await this.stateStore.mutate((state) => {
      const active = state.pendingByDomain[domain];
      if (queued) {
        if (!active || active.taskId === output.taskId) {
          throw new CoordinationError('El dominio cambió mientras se encolaba la revisión.', {
            code: 'PENDING_CHANGED_DURING_PLACEMENT',
          });
        }
        const queue = state.queuedByDomain[domain] || [];
        if (!queue.some((entry) =>
          entry.taskId === output.taskId &&
          Number(entry.revision || 1) === getRevision(output))) {
          queue.push({
            taskId: output.taskId,
            submissionId: v2 ? handoff.submissionId : output.taskId,
            revision: getRevision(output),
            protocolVersion: v2 ? '2.0' : '1.0',
            path: path.relative(this.repoRoot, queuedPath).replace(/\\/g, '/'),
            sourceHash: output.sourceHash,
            proposalHash: v2 ? coordinatorProposalHash(output) : null,
            verdict: output.verdict,
            hasBlockingQuestions: output.blockingQuestions.length > 0,
            queuedAt: new Date().toISOString(),
          });
        }
        state.queuedByDomain[domain] = queue;
      } else {
        if (
          active &&
          (
            active.taskId !== output.taskId ||
            (v2 && Number(active.revision) > Number(output.revision))
          )
        ) {
          throw new CoordinationError('El pending cambió durante la colocación.', {
            code: 'PENDING_CHANGED_DURING_PLACEMENT',
          });
        }
        state.pendingByDomain[domain] = {
          taskId: output.taskId,
          submissionId: v2 ? handoff.submissionId : output.taskId,
          protocolVersion: v2 ? '2.0' : '1.0',
          path: path.relative(this.repoRoot, pendingPath).replace(/\\/g, '/'),
          sourceHash: output.sourceHash,
          status: 'writing',
          domain,
          targetDomain: output.targetDomain,
          proposalHash: v2 ? coordinatorProposalHash(output) : null,
          fileHash: null,
          verdict: output.verdict,
          hasBlockingQuestions: output.blockingQuestions.length > 0,
          createdAt: new Date().toISOString(),
          shownAt: null,
          shownHash: null,
          presentedAt: null,
          revision: getRevision(output),
        };
        if (v2 && superseded) {
          const oldKey = superseded.submissionId;
          const completedExecution = ['approved', 'executing'].includes(superseded.status);
          state.submissions[oldKey] = {
            ...(state.submissions[oldKey] || superseded),
            status: completedExecution ? 'completed' : 'superseded',
            [completedExecution ? 'completedAt' : 'supersededAt']:
              new Date().toISOString(),
          };
          const oldApproval = state.proposalApprovals[superseded.proposalHash];
          if (completedExecution && oldApproval) {
            oldApproval.status = 'completed';
            oldApproval.completedAt = new Date().toISOString();
          }
        }
      }
      });
    } catch (error) {
      await restoreStateWithRetry(this.stateStore, (state) => {
        restoreEntry(state.pendingByDomain, domain, placementSnapshot.pending);
        restoreEntry(state.queuedByDomain, domain, placementSnapshot.queue);
        restoreEntry(state.submissions, submissionKey, placementSnapshot.submission);
        restoreEntry(
          state.currentProposalByTask,
          output.taskId,
          placementSnapshot.currentProposal,
        );
        if (superseded?.submissionId && placementSnapshot.supersededSubmission) {
          restoreEntry(
            state.submissions,
            superseded.submissionId,
            placementSnapshot.supersededSubmission,
          );
        }
        if (superseded?.proposalHash && placementSnapshot.supersededApproval) {
          restoreEntry(
            state.proposalApprovals,
            superseded.proposalHash,
            placementSnapshot.supersededApproval,
          );
        }
      }).catch((rollbackError) => {
        this.logger.error(safeErrorSummary(rollbackError));
      });
      if (supersededArchive && superseded?.path) {
        await atomicMove(
          supersededArchive,
          path.resolve(this.repoRoot, superseded.path),
          { root: this.paths.root },
        ).catch(() => {});
      }
      throw error;
    }

    const candidate = queued ? queuedPath : pendingPath;
    try {
      const outputSchema = await this.outputSchemaFor(output);
      const candidateExisted = await pathExists(candidate);
      if (!candidateExisted) {
        candidateCreated = true;
        await this.atomicWriteJson(candidate, output, {
          root: this.paths.root,
          overwrite: false,
          validateJson: (value) => assertSchema(value, outputSchema, 'Pending'),
        });
      } else {
        const existing = await readJsonLimited(candidate, this.config.maxResponseBytes);
        assertSchema(existing, outputSchema, 'Pending existente');
        this.assertSafeOutput(existing, 'Pending existente');
        if (JSON.stringify(existing) !== JSON.stringify(output)) {
          throw new CoordinationError(
            'El destino pending ya contiene otra salida.',
            { code: 'PENDING_DESTINATION_CONFLICT' },
          );
        }
      }
      const fileHash = await sha256File(candidate, this.config.maxResponseBytes);
      await this.stateStore.mutate((state) => {
        const entry = {
          taskId: output.taskId,
          submissionId: v2 ? handoff.submissionId : output.taskId,
          revision: getRevision(output),
          domain,
          targetDomain: output.targetDomain,
          sourceHash: output.sourceHash,
          proposalHash: v2 ? coordinatorProposalHash(output) : null,
          fileHash,
          path: path.relative(this.repoRoot, candidate).replace(/\\/g, '/'),
          status: queued ? 'queued' : 'review_ready',
          updatedAt: new Date().toISOString(),
        };
        state.submissions[submissionKey] = entry;
        if (v2) {
          state.currentProposalByTask[output.taskId] = entry;
        }
        if (!queued) {
          const current = state.pendingByDomain[domain];
          if (
            !current ||
            current.taskId !== output.taskId ||
            Number(current.revision) !== getRevision(output)
          ) {
            throw new CoordinationError('El pending cambió antes de confirmar la escritura.', {
              code: 'PENDING_CHANGED_DURING_PLACEMENT',
            });
          }
          current.fileHash = fileHash;
          current.status = 'pending';
        }
      });
      return { candidate, domain, queued, fileHash };
    } catch (error) {
      if (candidateCreated && await pathExists(candidate)) {
        await fs.unlink(candidate).catch(() => {});
      }
      await restoreStateWithRetry(this.stateStore, (state) => {
        restoreEntry(state.pendingByDomain, domain, placementSnapshot.pending);
        restoreEntry(state.queuedByDomain, domain, placementSnapshot.queue);
        restoreEntry(state.submissions, submissionKey, placementSnapshot.submission);
        restoreEntry(
          state.currentProposalByTask,
          output.taskId,
          placementSnapshot.currentProposal,
        );
        if (superseded?.submissionId && placementSnapshot.supersededSubmission) {
          restoreEntry(
            state.submissions,
            superseded.submissionId,
            placementSnapshot.supersededSubmission,
          );
        }
        if (superseded?.proposalHash && placementSnapshot.supersededApproval) {
          restoreEntry(
            state.proposalApprovals,
            superseded.proposalHash,
            placementSnapshot.supersededApproval,
          );
        }
        state.activity.push({
          type: 'output_placement_rolled_back',
          taskId: output.taskId,
          domain,
          at: new Date().toISOString(),
        });
      });
      if (supersededArchive && superseded?.path) {
        const previousPath = path.resolve(this.repoRoot, superseded.path);
        await atomicMove(supersededArchive, previousPath, {
          root: this.paths.root,
        }).catch(() => {});
      }
      throw error;
    }
  }

  async finishSuccessfulFile(filePath, fileName, handoff, sourceHash, result) {
    const destination = await uniqueDestination(this.paths.completed, fileName, 'completed');
    const initialState = await this.stateStore.load();
    const finishSnapshot = {
      processed: snapshotEntry(initialState.processedFiles, fileName),
      hash: snapshotEntry(initialState.hashes, sourceHash),
      retry: snapshotEntry(initialState.retries, sourceHash),
      pending: snapshotEntry(initialState.pendingByDomain, result.domain),
    };
    const taskSnapshot = isV2Payload(handoff) && !result.queued
      ? await this.taskStore.load(handoff.taskId)
      : null;
    let taskMutationAttempted = false;
    const activityAt = new Date().toISOString();
    await atomicMove(filePath, destination, { root: this.paths.root });
    try {
      await this.stateStore.mutate((state) => {
        const v2 = isV2Payload(handoff);
        state.processedFiles[fileName] = {
          taskId: handoff.taskId,
          parentTaskId: handoff.parentTaskId,
          submissionId: getSubmissionId(handoff),
          revision: getRevision(handoff),
          protocolVersion: v2 ? '2.0' : '1.0',
          domain: handoff.domain,
          hash: sourceHash,
          promptHash: result.promptHash || coordinatorPromptHash(result.output),
          proposalHash: v2 ? coordinatorProposalHash(result.output) : null,
          fileHash: result.fileHash || null,
          status: result.queued ? 'queued' : 'pending',
          targetDomain: result.domain,
          reviewValidation: result.reviewOutcome || null,
          outputPath: path.relative(this.repoRoot, result.candidate).replace(/\\/g, '/'),
          handoffPath: path.relative(this.repoRoot, destination).replace(/\\/g, '/'),
          completedAt: activityAt,
        };
        state.hashes[sourceHash] = {
          taskId: handoff.taskId,
          sourceFile: fileName,
          processedAt: activityAt,
        };
        delete state.retries[sourceHash];
        if (!result.queued) {
          const active = state.pendingByDomain[result.domain];
          if (
            active?.taskId === handoff.taskId &&
            (!v2 || active.submissionId === handoff.submissionId)
          ) {
            active.status = 'pending';
            active.fileHash = result.fileHash || active.fileHash || null;
          }
        }
        state.activity.push({
          type: result.queued ? 'output_queued' : 'pending_created',
          taskId: handoff.taskId,
          domain: result.domain,
          at: activityAt,
        });
        if (result.reviewOutcome?.status) {
          state.activity.push({
            type: result.reviewOutcome.status === 'repaired'
              ? 'visual_review_repaired'
              : 'review_valid_initially',
            taskId: handoff.taskId,
            domain: result.domain,
            at: activityAt,
          });
        }
      });
      if (isV2Payload(handoff) && !result.queued) {
        taskMutationAttempted = true;
        await this.taskStore.mutate(handoff.taskId, (task) => {
          const revision = task.revisions.find((entry) =>
            entry.revision === handoff.revision &&
            entry.submissionId === handoff.submissionId);
          if (!revision) {
            throw new CoordinationError(
              'La entrega no está registrada en la tarea persistente.',
              { code: 'TASK_REVISION_NOT_FOUND' },
            );
          }
          revision.status = 'review_ready';
          revision.handoffHash = sourceHash;
          revision.proposalHash = coordinatorProposalHash(result.output);
          revision.summary = getOutputSummary(result.output);
          revision.updatedAt = activityAt;
          if (handoff.approvedProposalHash) {
            const priorRevision = task.revisions.find((entry) =>
              entry.proposalHash === handoff.approvedProposalHash);
            const priorApproval = task.approvals.find((entry) =>
              entry.proposalHash === handoff.approvedProposalHash);
            const priorTransfer = task.transfers.find((entry) =>
              entry.proposalHash === handoff.approvedProposalHash);
            if (priorRevision && ['approved', 'executing'].includes(priorRevision.status)) {
              priorRevision.status = 'completed';
              priorRevision.updatedAt = activityAt;
            }
            if (priorApproval && ['approved', 'executing', 'transferred'].includes(
              priorApproval.status,
            )) {
              priorApproval.status = 'completed';
            }
            if (priorTransfer && ['claimed', 'executing'].includes(priorTransfer.status)) {
              priorTransfer.status = 'completed';
            }
          }
          task.status = 'review_ready';
          task.currentDomain = handoff.domain;
          return task;
        });
      }
    } catch (error) {
      if (taskMutationAttempted && taskSnapshot) {
        await restoreStateWithRetry(
          this.taskStore,
          handoff.taskId,
          () => JSON.parse(JSON.stringify(taskSnapshot)),
        ).catch((rollbackError) => {
          this.logger.error(safeErrorSummary(rollbackError));
        });
      }
      if (await pathExists(destination) && !await pathExists(filePath)) {
        await atomicMove(destination, filePath, { root: this.paths.root }).catch(() => {});
      }
      await restoreStateWithRetry(this.stateStore, (state) => {
        restoreEntry(state.processedFiles, fileName, finishSnapshot.processed);
        restoreEntry(state.hashes, sourceHash, finishSnapshot.hash);
        restoreEntry(state.retries, sourceHash, finishSnapshot.retry);
        restoreEntry(state.pendingByDomain, result.domain, finishSnapshot.pending);
        state.activity = state.activity.filter((entry) =>
          !(
            entry.at === activityAt &&
            entry.taskId === handoff.taskId &&
            entry.domain === result.domain &&
            ['output_queued', 'pending_created'].includes(entry.type)
          ));
      }).catch((rollbackError) => {
        this.logger.error(safeErrorSummary(rollbackError));
      });
      throw error;
    }
    if (!result.queued) {
      notifyPending({
        domain: result.domain,
        taskId: handoff.taskId,
        summary: getOutputSummary(result.output),
        protocolVersion: isV2Payload(handoff) ? '2.0' : '1.0',
        revision: getRevision(handoff),
      }, {
        enabled: this.config.notification.enabled,
        stream: this.notificationStream,
        logger: this.logger,
      });
    }
  }

  async failFile(filePath, error, context = {}) {
    const exists = await pathExists(filePath);
    const repairErrors = Array.isArray(context.repairErrors)
      ? context.repairErrors.slice(0, 2).map((entry) => ({
        attempt: entry?.attempt === 'repair' ? 'repair' : 'initial',
        ...safeErrorSummary(entry),
      }))
      : [];
    let destination = null;
    if (exists) {
      destination = await uniqueDestination(this.paths.failed, path.basename(filePath), 'failed');
      await atomicMove(filePath, destination, { root: this.paths.root });
    }
    await this.stateStore.mutate((state) => {
      const name = path.basename(filePath);
      const previous = state.processedFiles[name] || {};
      state.processedFiles[name] = {
        ...previous,
        taskId: context.taskId || previous.taskId || null,
        submissionId: context.submissionId || previous.submissionId || null,
        revision: context.revision || previous.revision || null,
        domain: context.domain || previous.domain || null,
        hash: context.hash || previous.hash || null,
        status: 'failed',
        failedAt: new Date().toISOString(),
        failedPath: destination
          ? path.relative(this.repoRoot, destination).replace(/\\/g, '/')
          : null,
        error: safeErrorSummary(error),
        ...(context.reviewStatus
          ? { reviewValidation: {
            status: context.reviewStatus,
            attempts: 2,
            repairErrors,
          } }
          : {}),
      };
      if (context.submissionId && state.submissions[context.submissionId]) {
        state.submissions[context.submissionId] = {
          ...state.submissions[context.submissionId],
          status: 'failed',
          failedAt: new Date().toISOString(),
          error: safeErrorSummary(error),
          ...(context.reviewStatus
            ? { reviewValidation: {
              status: context.reviewStatus,
              attempts: 2,
              repairErrors,
            } }
            : {}),
        };
      }
      state.errors.push({
        ...safeErrorSummary(error),
        ...(repairErrors.length > 0 ? { repairErrors } : {}),
        file: name,
        taskId: context.taskId || null,
        at: new Date().toISOString(),
      });
      state.activity.push({
        type: 'processing_failed',
        taskId: context.taskId || null,
        domain: context.domain || null,
        at: new Date().toISOString(),
      });
      if (context.reviewStatus === 'repair_failed') {
        state.activity.push({
          type: 'visual_review_repair_failed',
          taskId: context.taskId || null,
          domain: context.domain || null,
          at: new Date().toISOString(),
        });
      }
    }).catch((stateError) => {
      this.logger.error(safeErrorSummary(stateError));
    });
    if (context.taskId && context.submissionId) {
      await this.taskStore.mutate(context.taskId, (task) => {
        const revision = task.revisions.find((entry) =>
          entry.submissionId === context.submissionId);
        if (revision) {
          revision.status = 'failed';
          revision.updatedAt = new Date().toISOString();
          task.status = 'failed';
        }
        return task;
      }).catch((taskError) => {
        this.logger.error(safeErrorSummary(taskError));
      });
    }
    this.logger.error(safeErrorSummary(error));
  }

  async promoteQueued() {
    const state = await this.stateStore.load();
    for (const domain of DOMAINS) {
      if (state.pendingByDomain[domain]) continue;
      const queue = state.queuedByDomain[domain] || [];
      const next = queue[0];
      if (!next) continue;
      const source = path.resolve(this.repoRoot, next.path);
      if (!await pathExists(source)) {
        await this.stateStore.mutate((current) => {
          current.queuedByDomain[domain] = (current.queuedByDomain[domain] || [])
            .filter((entry) => entry.taskId !== next.taskId);
          current.errors.push({
            code: 'QUEUED_FILE_MISSING',
            message: 'Falta un resultado en cola.',
            file: path.basename(source),
            taskId: next.taskId,
            at: new Date().toISOString(),
          });
        });
        continue;
      }
      const destination = path.join(this.paths.pending, domain, path.basename(source));
      const output = await readJsonLimited(source, this.config.maxResponseBytes);
      const v2 = isV2Payload(output);
      assertSchema(output, await this.outputSchemaFor(output), 'Pending promovido');
      assertStructuredVisualOutput(output, { minimumRecommendedChanges: 1 });
      this.assertSafeOutput(output, 'Pending promovido');
      if (
        (v2 ? output.domain : output.targetDomain) !== domain ||
        output.taskId !== next.taskId ||
        output.sourceHash !== next.sourceHash ||
        (v2 && output.revision !== next.revision) ||
        output.approvalRequired !== true
      ) {
        throw new CoordinationError('El pending en cola viola su identidad.', {
          code: 'QUEUED_PENDING_INVARIANT_VIOLATION',
        });
      }
      const beforePromotion = await this.stateStore.load();
      const submissionKey = next.submissionId || next.taskId;
      const processedSnapshots = Object.fromEntries(
        Object.entries(beforePromotion.processedFiles)
          .filter(([, record]) =>
            record.taskId === next.taskId &&
            (!v2 || record.submissionId === next.submissionId))
          .map(([name, record]) => [name, {
            exists: true,
            value: JSON.parse(JSON.stringify(record)),
          }]),
      );
      const promotionSnapshot = {
        queue: snapshotEntry(beforePromotion.queuedByDomain, domain),
        pending: snapshotEntry(beforePromotion.pendingByDomain, domain),
        submission: snapshotEntry(beforePromotion.submissions, submissionKey),
        currentProposal: snapshotEntry(
          beforePromotion.currentProposalByTask,
          next.taskId,
        ),
      };
      const promotionTaskSnapshot = v2
        ? await this.taskStore.load(next.taskId)
        : null;
      const promotedAt = new Date().toISOString();
      let moved = false;
      let taskMutationAttempted = false;
      let fileHash;
      try {
        await atomicMove(source, destination, { root: this.paths.root });
        moved = true;
        fileHash = await sha256File(destination, this.config.maxResponseBytes);
        await this.stateStore.mutate((current) => {
          current.queuedByDomain[domain] = (current.queuedByDomain[domain] || [])
            .filter((entry) =>
              !(
                entry.taskId === next.taskId &&
                Number(entry.revision || 1) === Number(next.revision || 1)
              ));
          current.pendingByDomain[domain] = {
            taskId: next.taskId,
            submissionId: submissionKey,
            protocolVersion: v2 ? '2.0' : '1.0',
            path: path.relative(this.repoRoot, destination).replace(/\\/g, '/'),
            sourceHash: next.sourceHash,
            status: 'pending',
            domain,
            targetDomain: output.targetDomain,
            proposalHash: v2 ? coordinatorProposalHash(output) : null,
            fileHash,
            verdict: output.verdict,
            hasBlockingQuestions: output.blockingQuestions.length > 0,
            createdAt: promotedAt,
            shownAt: null,
            shownHash: null,
            presentedAt: null,
            revision: getRevision(output),
          };
          if (v2) {
            const submission = {
              ...(current.submissions[next.submissionId] || {}),
              taskId: next.taskId,
              submissionId: next.submissionId,
              revision: next.revision,
              domain,
              targetDomain: output.targetDomain,
              sourceHash: next.sourceHash,
              proposalHash: coordinatorProposalHash(output),
              fileHash,
              path: path.relative(this.repoRoot, destination).replace(/\\/g, '/'),
              status: 'review_ready',
              updatedAt: promotedAt,
            };
            current.submissions[next.submissionId] = submission;
            current.currentProposalByTask[next.taskId] = submission;
          }
          for (const record of Object.values(current.processedFiles)) {
            if (
              record.taskId === next.taskId &&
              (!v2 || record.submissionId === next.submissionId)
            ) {
              record.status = 'pending';
              record.fileHash = fileHash;
            }
          }
          current.activity.push({
            type: 'queued_output_promoted',
            taskId: next.taskId,
            domain,
            at: promotedAt,
          });
        });
        if (v2) {
          taskMutationAttempted = true;
          await this.taskStore.mutate(next.taskId, (task) => {
            const revision = task.revisions.find((entry) =>
              entry.revision === next.revision &&
              entry.submissionId === next.submissionId);
            if (!revision) {
              throw new CoordinationError('La revisión promovida no existe en la tarea.', {
                code: 'TASK_REVISION_NOT_FOUND',
              });
            }
            revision.status = 'review_ready';
            revision.proposalHash = coordinatorProposalHash(output);
            revision.summary = getOutputSummary(output);
            revision.updatedAt = promotedAt;
            task.status = 'review_ready';
            task.currentDomain = domain;
            return task;
          });
        }
      } catch (error) {
        if (taskMutationAttempted && promotionTaskSnapshot) {
          await restoreStateWithRetry(
            this.taskStore,
            next.taskId,
            () => JSON.parse(JSON.stringify(promotionTaskSnapshot)),
          ).catch((rollbackError) => {
            this.logger.error(safeErrorSummary(rollbackError));
          });
        }
        if (moved && await pathExists(destination) && !await pathExists(source)) {
          await atomicMove(destination, source, { root: this.paths.root }).catch(() => {});
        }
        await restoreStateWithRetry(this.stateStore, (current) => {
          restoreEntry(current.queuedByDomain, domain, promotionSnapshot.queue);
          restoreEntry(current.pendingByDomain, domain, promotionSnapshot.pending);
          restoreEntry(current.submissions, submissionKey, promotionSnapshot.submission);
          restoreEntry(
            current.currentProposalByTask,
            next.taskId,
            promotionSnapshot.currentProposal,
          );
          for (const [name, snapshot] of Object.entries(processedSnapshots)) {
            restoreEntry(current.processedFiles, name, snapshot);
          }
          current.activity = current.activity.filter((entry) =>
            !(
              entry.type === 'queued_output_promoted' &&
              entry.taskId === next.taskId &&
              entry.domain === domain &&
              entry.at === promotedAt
            ));
        }).catch((rollbackError) => {
          this.logger.error(safeErrorSummary(rollbackError));
        });
        throw error;
      }
      notifyPending({
        domain,
        taskId: next.taskId,
        summary: getOutputSummary(output),
        protocolVersion: v2 ? '2.0' : '1.0',
        revision: getRevision(output),
      }, {
        enabled: this.config.notification.enabled,
        stream: this.notificationStream,
        logger: this.logger,
      });
    }
  }

  async start() {
    await this.initialize();
    await this.heartbeat.start();
    await this.scan({ waitForStable: true });
    const watcher = require('node:fs').watch(this.paths.inbox, () => {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.scan().catch((error) => this.logger.error(safeErrorSummary(error)));
      }, this.config.debounceMs);
    });
    this.fsWatcher = watcher;
    this.scanTimer = setInterval(() => {
      this.scan().catch((error) => this.logger.error(safeErrorSummary(error)));
    }, this.config.scanIntervalMs);
  }

  async stop() {
    clearTimeout(this.debounceTimer);
    clearTimeout(this.stabilityTimer);
    clearInterval(this.scanTimer);
    this.fsWatcher?.close();
    this.fsWatcher = null;
    if (this.scanPromise) await this.scanPromise;
    await this.heartbeat.stop();
  }
}

module.exports = {
  CoordinationWatcher,
  listJsonFiles,
  uniqueDestination,
};
