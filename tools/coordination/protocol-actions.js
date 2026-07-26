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
const { DOMAINS, getCoordinationPaths } = require('./constants');
const { CoordinationError } = require('./errors');
const {
  coordinatorProposalHash,
  coordinatorPromptHash,
  createSubmissionId,
  getOutputPrompt,
  getOutputSummary,
  getRevision,
  getSubmissionId,
  isV2Payload,
  proposalFileName,
  submissionFileName,
  taskRevisionKey,
} = require('./identity');
const { assertSchema, loadSchema } = require('./schema-validator');
const {
  assertAllowedDomain,
  assertNoSecretMaterial,
  assertSafeCoordinatorOutput,
  assertSafeHandoff,
  assertSafeRepositoryFile,
  assertSafeTaskId,
} = require('./security');
const { StateStore, ensureCoordinationStructure } = require('./state-store');
const { TaskStore } = require('./task-store');
const { assertStructuredVisualOutput } = require('./visual-contract');

function repoRelative(repoRoot, candidate) {
  return path.relative(repoRoot, candidate).replace(/\\/g, '/');
}

function assertSha256(value, label = 'hash') {
  if (!/^[a-f0-9]{64}$/.test(String(value || ''))) {
    throw new CoordinationError(`${label} debe ser un SHA-256 exacto.`, {
      code: 'EXACT_HASH_REQUIRED',
    });
  }
  return value;
}

function safeActor(value, fallback = 'usuario') {
  const actor = String(value || fallback).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120);
  assertNoSecretMaterial(actor, 'El actor');
  return actor || fallback;
}

function assertV2OutputContract(output) {
  if (!isV2Payload(output)) return output;
  return assertStructuredVisualOutput(output, {
    minimumRecommendedChanges: 1,
  });
}

function assertSafeCorrection(instruction) {
  if (typeof instruction !== 'string' || instruction.trim() === '') {
    throw new CoordinationError('La modificación requiere una instrucción no vacía.', {
      code: 'MISSING_MODIFICATION_INSTRUCTION',
    });
  }
  if (instruction.length > 4_000) {
    throw new CoordinationError('La modificación supera los 4000 caracteres.', {
      code: 'MODIFICATION_TOO_LARGE',
    });
  }
  assertNoSecretMaterial(instruction, 'La modificación');
  if (
    /(?:^|\s)[A-Za-z]:[\\/]/.test(instruction) ||
    /(?:^|\s)\\\\[^\\]/.test(instruction) ||
    /(?:^|\s)\/(?:etc|home|users|var|tmp|private)\//i.test(instruction)
  ) {
    throw new CoordinationError(
      'La modificación no puede indicar rutas absolutas fuera del repositorio.',
      { code: 'EXTERNAL_PATH_IN_INSTRUCTION' },
    );
  }
  return instruction.trim();
}

async function listDomainPending(directory) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => ({
        name: entry.name,
        stat: await fs.stat(path.join(directory, entry.name)),
      })));
    return files.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

class ProtocolActions {
  constructor(options) {
    this.repoRoot = options.repoRoot;
    this.paths = getCoordinationPaths(options.repoRoot);
    this.config = options.config;
    this.handoffSchema = options.handoffSchema;
    this.outputSchema = options.outputSchema;
    this.handoffV2Schema = options.handoffV2Schema || null;
    this.outputV2Schema = options.outputV2Schema || null;
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

  assertSafeOutput(output, label = 'Pending') {
    assertSafeCoordinatorOutput(output, label);
  }

  assertV2ExecutionAuthorization(handoff, task, state) {
    const noApprovedExecution =
      handoff.approvedProposalHash === null &&
      handoff.approvedPrompt === null;
    if (handoff.executionKind === 'initial') {
      if (
        handoff.revision !== 1 ||
        handoff.previousRevision !== null ||
        task.revisions.length !== 0 ||
        !noApprovedExecution
      ) {
        throw new CoordinationError('El handoff inicial no cumple la identidad de r1.', {
          code: 'INVALID_INITIAL_HANDOFF',
        });
      }
      return;
    }

    const priorRevision = task.revisions.find((entry) =>
      entry.revision === handoff.previousRevision);
    if (handoff.executionKind === 'user-observation') {
      const priorProposal = state.currentProposalByTask[handoff.taskId];
      const noChanges =
        handoff.changes.length === 0 &&
        handoff.filesCreated.length === 0 &&
        handoff.filesModified.length === 0 &&
        handoff.gitStatus.length === 0 &&
        handoff.diffSummary.length === 0 &&
        handoff.dataModified.modified === false;
      if (
        !noApprovedExecution ||
        !noChanges ||
        !priorRevision ||
        !['presented', 'superseded'].includes(priorRevision.status) ||
        !priorProposal ||
        Number(priorProposal.revision) !== handoff.previousRevision ||
        priorProposal.status !== 'superseded'
      ) {
        throw new CoordinationError(
          'La observación no puede declarar ejecución ni omitir la propuesta previa.',
          { code: 'INVALID_USER_OBSERVATION_HANDOFF' },
        );
      }
      return;
    }

    if (handoff.executionKind === 'recovery') {
      const noChanges =
        handoff.changes.length === 0 &&
        handoff.filesCreated.length === 0 &&
        handoff.filesModified.length === 0 &&
        handoff.dataModified.modified === false;
      if (!noApprovedExecution || !noChanges || priorRevision?.status !== 'failed') {
        throw new CoordinationError('El recovery no representa una recuperación segura.', {
          code: 'INVALID_RECOVERY_HANDOFF',
        });
      }
      return;
    }

    if (!['approved-proposal', 'transferred'].includes(handoff.executionKind)) {
      throw new CoordinationError('executionKind v2 no está soportado.', {
        code: 'UNSUPPORTED_EXECUTION_KIND',
      });
    }
    const proposalHash = assertSha256(
      handoff.approvedProposalHash,
      'approvedProposalHash',
    );
    const approval = state.proposalApprovals[proposalHash];
    const taskApproval = task.approvals.find((entry) =>
      entry.revision === handoff.previousRevision &&
      entry.proposalHash === proposalHash);
    if (
      !priorRevision ||
      priorRevision.status !== 'executing' ||
      priorRevision.proposalHash !== proposalHash ||
      !approval ||
      approval.status !== 'executing' ||
      approval.taskId !== handoff.taskId ||
      Number(approval.revision) !== handoff.previousRevision ||
      approval.targetDomain !== handoff.domain ||
      approval.prompt !== handoff.approvedPrompt ||
      !taskApproval ||
      taskApproval.status !== 'executing' ||
      taskApproval.prompt !== handoff.approvedPrompt
    ) {
      throw new CoordinationError(
        'El handoff no deriva de una propuesta exacta aprobada y comenzada.',
        { code: 'HANDOFF_WITHOUT_EXECUTION_APPROVAL' },
      );
    }
    const transfer = state.transfers[proposalHash];
    if (
      handoff.executionKind === 'transferred' &&
      (
        !transfer ||
        transfer.status !== 'executing' ||
        transfer.toDomain !== handoff.domain
      )
    ) {
      throw new CoordinationError('La transferencia no fue reclamada y comenzada.', {
        code: 'TRANSFER_NOT_EXECUTING',
      });
    }
    if (
      handoff.executionKind === 'approved-proposal' &&
      approval.domain !== approval.targetDomain
    ) {
      throw new CoordinationError('Una propuesta transferida requiere executionKind transferred.', {
        code: 'EXECUTION_KIND_MISMATCH',
      });
    }
  }

  async createTask(input) {
    await this.initialize();
    const task = await this.taskStore.create(input);
    try {
      await this.stateStore.mutate((state) => {
        state.tasks[task.taskId] = {
          taskId: task.taskId,
          domain: task.currentDomain,
          status: task.status,
          revision: 0,
          updatedAt: task.updatedAt,
        };
        state.activity.push({
          type: 'task_created',
          taskId: task.taskId,
          domain: task.currentDomain,
          at: new Date().toISOString(),
        });
      });
    } catch (error) {
      try {
        await this.taskStore.rollbackCreate(task);
      } catch (rollbackError) {
        throw new CoordinationError(
          'No se pudo revertir una creación de tarea incompleta.',
          {
            code: 'TASK_CREATE_ROLLBACK_FAILED',
            cause: rollbackError,
          },
        );
      }
      throw error;
    }
    return {
      taskId: task.taskId,
      domain: task.initialDomain,
      revision: 1,
      firstPrompt: task.initialPrompt,
      status: task.status,
      executed: false,
    };
  }

  async enqueue(handoff) {
    await this.initialize();
    const v2 = isV2Payload(handoff);
    const schema = await this.handoffSchemaFor(handoff);
    assertSchema(handoff, schema, 'Handoff');
    assertSafeHandoff(handoff);
    const destination = path.join(this.paths.inbox, submissionFileName(handoff));
    let task = null;
    if (v2) {
      task = await this.taskStore.load(handoff.taskId);
      const coordinationState = await this.stateStore.load();
      if (task.currentDomain !== handoff.domain) {
        throw new CoordinationError('La entrega pertenece a un dominio distinto del vigente.', {
          code: 'TASK_DOMAIN_MISMATCH',
        });
      }
      if (handoff.revision !== task.nextRevision) {
        throw new CoordinationError('La revisión no coincide con nextRevision.', {
          code: 'TASK_REVISION_MISMATCH',
        });
      }
      const expectedPrevious = handoff.revision === 1 ? null : handoff.revision - 1;
      if (handoff.previousRevision !== expectedPrevious) {
        throw new CoordinationError('previousRevision no es contigua.', {
          code: 'TASK_PREVIOUS_REVISION_MISMATCH',
        });
      }
      if (task.revisions.some((entry) =>
        entry.revision === handoff.revision ||
        entry.submissionId === handoff.submissionId)) {
        throw new CoordinationError('La revisión o submissionId ya fue registrado.', {
          code: 'TASK_REVISION_ALREADY_EXISTS',
        });
      }
      if (coordinationState.submissions[handoff.submissionId]) {
        throw new CoordinationError('submissionId ya existe en coordinación.', {
          code: 'SUBMISSION_ALREADY_EXISTS',
        });
      }
      this.assertV2ExecutionAuthorization(handoff, task, coordinationState);
    }
    await atomicWriteJson(destination, handoff, {
      root: this.paths.root,
      overwrite: false,
      validateJson: (value) => {
        assertSchema(value, schema, 'Handoff');
        assertSafeHandoff(value);
      },
    });
    const handoffHash = await sha256File(destination, this.config.maxHandoffBytes);
    if (v2) {
      try {
        await this.taskStore.recordRevision(handoff.taskId, {
          revision: handoff.revision,
          submissionId: handoff.submissionId,
          domain: handoff.domain,
          status: 'awaiting_review',
          handoffHash,
          proposalHash: null,
          summary: handoff.summary,
        });
        await this.stateStore.mutate((state) => {
          const entry = {
            taskId: handoff.taskId,
            submissionId: handoff.submissionId,
            revision: handoff.revision,
            domain: handoff.domain,
            protocolVersion: '2.0',
            sourceHash: handoffHash,
            path: repoRelative(this.repoRoot, destination),
            status: 'awaiting_review',
            createdAt: new Date().toISOString(),
          };
          state.submissions[handoff.submissionId] = entry;
          state.tasks[handoff.taskId] = {
            taskId: handoff.taskId,
            domain: handoff.domain,
            status: 'awaiting_review',
            revision: handoff.revision,
            updatedAt: new Date().toISOString(),
          };
        });
      } catch (error) {
        await this.taskStore.mutate(handoff.taskId, (currentTask) => {
          const recorded = currentTask.revisions.some((entry) =>
            entry.revision === handoff.revision &&
            entry.submissionId === handoff.submissionId);
          if (recorded) {
            currentTask.revisions = currentTask.revisions.filter((entry) =>
              !(
                entry.revision === handoff.revision &&
                entry.submissionId === handoff.submissionId
              ));
            currentTask.events = currentTask.events.filter((entry) =>
              !(
                entry.type === 'revision_recorded' &&
                entry.revision === handoff.revision
              ));
            currentTask.nextRevision = task.nextRevision;
            currentTask.status = task.status;
            currentTask.currentDomain = task.currentDomain;
          }
          return currentTask;
        }).catch(() => {});
        await fs.unlink(destination).catch(() => {});
        throw error;
      }
    }
    await this.stateStore.recordActivity('handoff_enqueued', {
      taskId: handoff.taskId,
      domain: handoff.domain,
    });
    return {
      taskId: handoff.taskId,
      submissionId: getSubmissionId(handoff),
      revision: getRevision(handoff),
      domain: handoff.domain,
      handoffHash,
      path: repoRelative(this.repoRoot, destination),
      executed: false,
    };
  }

  async discoverPending(domain) {
    const directory = path.join(this.paths.pending, domain);
    const files = await listDomainPending(directory);
    if (files.length === 0) return null;
    if (files.length > 1) {
      throw new CoordinationError(
        `Hay ${files.length} pendientes activos para ${domain}; se requiere recuperación manual.`,
        { code: 'MULTIPLE_ACTIVE_PENDING' },
      );
    }
    const candidate = path.join(directory, files[0].name);
    const output = await this.readAndValidateOutput(candidate, domain);
    await this.stateStore.mutate((state) => {
      state.pendingByDomain[domain] = {
        taskId: output.taskId,
        path: repoRelative(this.repoRoot, candidate),
        sourceHash: output.sourceHash,
        status: 'pending',
        verdict: output.verdict,
        hasBlockingQuestions: output.blockingQuestions.length > 0,
        createdAt: files[0].stat.birthtime.toISOString(),
        shownAt: null,
        shownHash: null,
        revision: 1,
      };
    });
    return { output, candidate };
  }

  async resolveActive(domain) {
    assertAllowedDomain(domain);
    let state = await this.stateStore.load();
    let active = state.pendingByDomain[domain];
    if (!active) {
      const discovered = await this.discoverPending(domain);
      if (!discovered) {
        throw new CoordinationError(`No hay un pendiente activo para ${domain}.`, {
          code: 'NO_ACTIVE_PENDING',
        });
      }
      state = await this.stateStore.load();
      active = state.pendingByDomain[domain];
    }
    if (active.status === 'approved') {
      throw new CoordinationError('El pendiente ya fue aprobado.', {
        code: 'PENDING_ALREADY_APPROVED',
      });
    }
    if (active.status === 'executing') {
      throw new CoordinationError('La tarea aprobada ya fue declarada en ejecución.', {
        code: 'PENDING_ALREADY_EXECUTING',
      });
    }
    const expectedRoot = path.join(this.paths.pending, domain);
    const candidate = assertPathInside(
      expectedRoot,
      path.resolve(this.repoRoot, active.path),
      'Pending',
    );
    if (!await pathExists(candidate)) {
      throw new CoordinationError('El archivo pending registrado no existe.', {
        code: 'PENDING_FILE_MISSING',
      });
    }
    const output = await this.readAndValidateOutput(candidate, domain);
    if (output.taskId !== active.taskId || output.sourceHash !== active.sourceHash) {
      throw new CoordinationError('El pending no coincide con el estado registrado.', {
        code: 'PENDING_STATE_MISMATCH',
      });
    }
    return { state, active, candidate, output };
  }

  async readAndValidateOutput(candidate, domain) {
    const output = await readJsonLimited(candidate, this.config.maxResponseBytes);
    assertSchema(output, await this.outputSchemaFor(output), 'Pending');
    assertV2OutputContract(output);
    this.assertSafeOutput(output, 'Pending');
    assertSafeTaskId(output.taskId, 'pending.taskId');
    assertAllowedDomain(output.targetDomain, 'pending.targetDomain');
    if ((isV2Payload(output) ? output.domain : output.targetDomain) !== domain) {
      throw new CoordinationError('El pending pertenece a otro dominio.', {
        code: 'PENDING_DOMAIN_MISMATCH',
      });
    }
    if (output.approvalRequired !== true) {
      throw new CoordinationError('El pending no exige aprobación humana.', {
        code: 'APPROVAL_INVARIANT_VIOLATION',
      });
    }
    return output;
  }

  async findObjective(taskId, revision = null) {
    const state = await this.stateStore.load();
    const records = Object.values(state.processedFiles)
      .filter((entry) =>
        entry.taskId === taskId &&
        (revision === null || Number(entry.revision || 1) === Number(revision)))
      .sort((left, right) => Number(right.revision || 1) - Number(left.revision || 1));
    const record = records[0];
    if (!record?.handoffPath) return null;
    const candidate = assertPathInside(
      this.paths.completed,
      path.resolve(this.repoRoot, record.handoffPath),
      'Handoff completado',
    );
    if (!await pathExists(candidate)) return null;
    const handoff = await readJsonLimited(candidate, this.config.maxHandoffBytes);
    assertSchema(handoff, await this.handoffSchemaFor(handoff), 'Handoff completado');
    return {
      objective: handoff.objective,
      plannedFiles: [...new Set([
        ...(handoff.filesCreated || []),
        ...(handoff.filesModified || []),
      ])],
    };
  }

  async findCompletedHandoff(taskId, revision) {
    const state = await this.stateStore.load();
    const record = Object.values(state.processedFiles).find((entry) =>
      entry.taskId === taskId &&
      Number(entry.revision || 1) === Number(revision) &&
      entry.handoffPath);
    if (!record) {
      throw new CoordinationError('No se encontró el handoff de la revisión vigente.', {
        code: 'COMPLETED_HANDOFF_NOT_FOUND',
      });
    }
    const candidate = assertPathInside(
      this.paths.completed,
      path.resolve(this.repoRoot, record.handoffPath),
      'Handoff completado',
    );
    const handoff = await readJsonLimited(candidate, this.config.maxHandoffBytes);
    assertSchema(handoff, await this.handoffSchemaFor(handoff), 'Handoff completado');
    if (!isV2Payload(handoff)) {
      throw new CoordinationError('La observación requiere una tarea v2.', {
        code: 'V2_HANDOFF_REQUIRED',
      });
    }
    return { handoff, record, candidate };
  }

  makeReviewView(output, details = {}) {
    return {
      taskId: output.taskId,
      domain: output.targetDomain,
      objective: details.objective || 'No disponible en el estado recuperado.',
      coordinatorAnalysis: output.summaryForUser,
      promptForSpecialist: output.promptForSpecialist,
      risks: output.risks,
      plannedFiles: details.plannedFiles || [],
      verdict: output.verdict,
      blockingQuestions: output.blockingQuestions,
      approvalRequired: true,
    };
  }

  async resolveV2(request, allowedStatuses = ['pending', 'presented']) {
    if (!request || typeof request !== 'object') {
      throw new CoordinationError('La acción v2 requiere criterios exactos.', {
        code: 'V2_CRITERIA_REQUIRED',
      });
    }
    assertSafeTaskId(request.taskId);
    assertAllowedDomain(request.domain);
    const revision = Number(request.revision);
    if (!Number.isInteger(revision) || revision < 1) {
      throw new CoordinationError('revision debe ser un entero positivo.', {
        code: 'REVISION_REQUIRED',
      });
    }
    const proposalHash = assertSha256(request.proposalHash, 'proposalHash');
    const fileHash = assertSha256(request.fileHash, 'fileHash');
    const state = await this.stateStore.load();
    const active = state.pendingByDomain[request.domain];
    if (
      !active ||
      active.protocolVersion !== '2.0' ||
      active.taskId !== request.taskId ||
      Number(active.revision) !== revision ||
      active.proposalHash !== proposalHash ||
      active.fileHash !== fileHash
    ) {
      throw new CoordinationError('La propuesta exacta ya no es la vigente.', {
        code: 'V2_PROPOSAL_NOT_CURRENT',
      });
    }
    if (!allowedStatuses.includes(active.status)) {
      throw new CoordinationError('La propuesta no está en un estado válido para esta acción.', {
        code: 'V2_PROPOSAL_STATUS_INVALID',
      });
    }
    const candidate = assertPathInside(
      path.join(this.paths.pending, request.domain),
      path.resolve(this.repoRoot, active.path),
      'Pending v2',
    );
    if (!await pathExists(candidate)) {
      throw new CoordinationError('El archivo de propuesta no existe.', {
        code: 'PENDING_FILE_MISSING',
      });
    }
    const output = await this.readAndValidateOutput(candidate, request.domain);
    const actualFileHash = await sha256File(candidate, this.config.maxResponseBytes);
    if (
      !isV2Payload(output) ||
      output.taskId !== request.taskId ||
      output.revision !== revision ||
      coordinatorProposalHash(output) !== proposalHash ||
      output.sourceHash !== active.sourceHash ||
      actualFileHash !== fileHash
    ) {
      throw new CoordinationError('La propuesta cambió o no coincide con los criterios.', {
        code: 'V2_PROPOSAL_HASH_MISMATCH',
      });
    }
    const current = state.currentProposalByTask[request.taskId];
    if (
      !current ||
      current.proposalHash !== proposalHash ||
      current.fileHash !== fileHash ||
      Number(current.revision) !== revision
    ) {
      throw new CoordinationError('La propuesta fue reemplazada por otra revisión.', {
        code: 'V2_PROPOSAL_SUPERSEDED',
      });
    }
    return { state, active, candidate, output, actualFileHash };
  }

  makeV2ReviewView(output, active, details = {}) {
    return {
      status: 'presented',
      taskId: output.taskId,
      submissionId: active.submissionId,
      revision: output.revision,
      domain: output.domain,
      targetDomain: output.targetDomain,
      objective: details.objective || null,
      summary: output.summary,
      findings: output.findings,
      risks: output.risks,
      blockingQuestions: output.blockingQuestions,
      visualReview: output.visualReview,
      nextPrompt: output.nextPrompt,
      recommendedChanges: output.recommendedChanges,
      userReviewInstructions: output.userReviewInstructions,
      verdict: output.verdict,
      closeReason: output.closeReason,
      evidenceRequired: output.evidenceRequired,
      proposalHash: output.proposalHash,
      fileHash: active.fileHash,
      approvalRequired: true,
      executed: false,
    };
  }

  async present(request, reviewer = `chat:${request?.domain || 'coordinador'}`) {
    await this.initialize();
    const resolved = await this.resolveV2(request, ['pending', 'presented']);
    const shownBy = safeActor(reviewer, `chat:${request.domain}`);
    const presentedAt = new Date().toISOString();
    const taskBefore = await this.taskStore.load(request.taskId);
    if (!taskBefore.revisions.some((entry) =>
      entry.revision === Number(request.revision) &&
      entry.submissionId === resolved.active.submissionId)) {
      throw new CoordinationError('La revisión presentada no existe.', {
        code: 'TASK_REVISION_NOT_FOUND',
      });
    }
    const previousPresentation = resolved.state.presentations[request.proposalHash] || null;
    try {
      await this.stateStore.mutate((state) => {
        const current = state.pendingByDomain[request.domain];
        if (
          !current ||
          current.taskId !== request.taskId ||
          current.proposalHash !== request.proposalHash ||
          current.fileHash !== request.fileHash
        ) {
          throw new CoordinationError('La propuesta cambió durante la presentación.', {
            code: 'PENDING_CHANGED_DURING_PRESENTATION',
          });
        }
        current.status = 'presented';
        current.presentedAt = current.presentedAt || presentedAt;
        current.presentedBy = shownBy;
        state.presentations[request.proposalHash] = {
          taskId: request.taskId,
          submissionId: current.submissionId,
          revision: request.revision,
          domain: request.domain,
          targetDomain: resolved.output.targetDomain,
          proposalHash: request.proposalHash,
          fileHash: request.fileHash,
          verdict: resolved.output.verdict,
          promptSummary: resolved.output.summary,
          promptFull: resolved.output.nextPrompt,
          recommendedChanges: resolved.output.recommendedChanges,
          expectedApprovalResult: resolved.output.verdict === 'close'
            ? 'close'
            : resolved.output.targetDomain !== resolved.output.domain
              ? 'transfer'
              : 'begin',
          presentedAt: current.presentedAt,
          presentedBy: shownBy,
          status: 'presented',
        };
        state.activity.push({
          type: 'proposal_presented',
          taskId: request.taskId,
          domain: request.domain,
          at: presentedAt,
        });
      });
      await this.taskStore.mutate(request.taskId, (task) => {
        const revision = task.revisions.find((entry) =>
          entry.revision === Number(request.revision) &&
          entry.submissionId === resolved.active.submissionId);
        if (!revision) {
          throw new CoordinationError('La revisión presentada no existe.', {
            code: 'TASK_REVISION_NOT_FOUND',
          });
        }
        revision.status = 'presented';
        revision.updatedAt = presentedAt;
        task.status = 'presented';
        return task;
      });
    } catch (error) {
      await this.stateStore.mutate((state) => {
        state.pendingByDomain[request.domain] = resolved.active;
        if (previousPresentation) {
          state.presentations[request.proposalHash] = previousPresentation;
        } else {
          delete state.presentations[request.proposalHash];
        }
      }).catch(() => {});
      throw error;
    }
    const details = await this.findObjective(request.taskId, request.revision) || {};
    return {
      ...this.makeV2ReviewView(resolved.output, resolved.active, details),
      presentedAt,
      presentedBy: shownBy,
    };
  }

  async review(domain, reviewer = `chat:${domain}`) {
    await this.initialize();
    const active = await this.resolveActive(domain);
    const pendingHash = await sha256File(active.candidate, this.config.maxResponseBytes);
    const details = await this.findObjective(active.output.taskId) || {};
    const safeReviewer = String(reviewer)
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 120) || `chat:${domain}`;
    assertNoSecretMaterial(safeReviewer, 'La identidad de revisión');
    await this.stateStore.mutate((state) => {
      const current = state.pendingByDomain[domain];
      if (!current || current.taskId !== active.output.taskId) {
        throw new CoordinationError('El pending cambió durante la revisión.', {
          code: 'PENDING_CHANGED_DURING_REVIEW',
        });
      }
      current.status = 'shown';
      current.shownAt = new Date().toISOString();
      current.shownHash = pendingHash;
      current.pendingHash = pendingHash;
      current.shownBy = safeReviewer;
      state.activity.push({
        type: 'pending_shown',
        taskId: active.output.taskId,
        domain,
        at: new Date().toISOString(),
      });
    });
    return {
      ...this.makeReviewView(active.output, details),
      shownHash: pendingHash,
      shownBy: safeReviewer,
    };
  }

  async assertShownAndUnchanged(domain, expectedShownHash) {
    const active = await this.resolveActive(domain);
    if (active.active.status !== 'shown' || !active.active.shownHash) {
      throw new CoordinationError(
        'Primero hay que ejecutar "Revisar pendiente" en el chat del dominio.',
        { code: 'PENDING_NOT_SHOWN' },
      );
    }
    if (!/^[a-f0-9]{64}$/.test(String(expectedShownHash || ''))) {
      throw new CoordinationError(
        'La acción requiere el shownHash devuelto por "Revisar pendiente".',
        { code: 'SHOWN_HASH_REQUIRED' },
      );
    }
    if (expectedShownHash !== active.active.shownHash) {
      throw new CoordinationError(
        'El shownHash no corresponde a la versión mostrada en este chat.',
        { code: 'SHOWN_HASH_MISMATCH' },
      );
    }
    const actualHash = await sha256File(active.candidate, this.config.maxResponseBytes);
    if (
      actualHash !== active.active.shownHash ||
      (active.active.pendingHash && actualHash !== active.active.pendingHash)
    ) {
      throw new CoordinationError(
        'El pending cambió después de mostrarse. Debe revisarse nuevamente.',
        { code: 'PENDING_HASH_CHANGED' },
      );
    }
    return { ...active, actualHash };
  }

  async approveV2(request, actor = request?.actor || 'usuario') {
    await this.initialize();
    const resolved = await this.resolveV2(request, ['presented']);
    const output = resolved.output;
    const presentation = resolved.state.presentations[request.proposalHash];
    if (
      !presentation ||
      presentation.status !== 'presented' ||
      presentation.fileHash !== request.fileHash ||
      presentation.domain !== request.domain ||
      presentation.targetDomain !== output.targetDomain ||
      Number(presentation.revision) !== Number(request.revision) ||
      presentation.verdict !== output.verdict ||
      presentation.promptFull !== output.nextPrompt ||
      JSON.stringify(presentation.recommendedChanges) !==
        JSON.stringify(output.recommendedChanges) ||
      presentation.promptSummary !== output.summary ||
      presentation.expectedApprovalResult !== (
        output.verdict === 'close'
          ? 'close'
          : output.targetDomain !== output.domain
            ? 'transfer'
            : 'begin'
      )
    ) {
      throw new CoordinationError('La propuesta exacta no fue presentada al usuario.', {
        code: 'V2_PROPOSAL_NOT_PRESENTED',
      });
    }
    if (output.blockingQuestions.length > 0 || ['blocked', 'rejected'].includes(output.verdict)) {
      throw new CoordinationError('La propuesta tiene bloqueos sin resolver.', {
        code: 'BLOCKING_QUESTIONS_UNRESOLVED',
      });
    }
    if (resolved.state.proposalApprovals[request.proposalHash]) {
      throw new CoordinationError('La propuesta ya tiene una decisión registrada.', {
        code: 'PROPOSAL_ALREADY_DECIDED',
      });
    }
    const terminal = output.verdict === 'close';
    const transfer = !terminal && output.targetDomain !== output.domain;
    const prompt = getOutputPrompt(output) || null;
    if (terminal && output.targetDomain !== output.domain) {
      throw new CoordinationError('Un cierre no puede transferirse a otro dominio.', {
        code: 'CLOSE_DOMAIN_MISMATCH',
      });
    }
    if (!terminal && !prompt) {
      throw new CoordinationError('La propuesta aprobable requiere nextPrompt.', {
        code: 'NEXT_PROMPT_REQUIRED',
      });
    }

    const approvedBy = safeActor(actor);
    const approvedAt = new Date().toISOString();
    const destination = path.join(this.paths.approved, proposalFileName(output));
    if (await pathExists(destination)) {
      throw new CoordinationError('Ya existe el archivo aprobado de esta revisión.', {
        code: 'APPROVED_DESTINATION_EXISTS',
      });
    }
    await atomicMove(resolved.candidate, destination, { root: this.paths.root });
    try {
      await this.stateStore.mutate((state) => {
        const current = state.pendingByDomain[request.domain];
        if (
          !current ||
          current.proposalHash !== request.proposalHash ||
          current.fileHash !== request.fileHash ||
          current.status !== 'presented'
        ) {
          throw new CoordinationError('La propuesta cambió durante la aprobación.', {
            code: 'PENDING_CHANGED_DURING_APPROVAL',
          });
        }
        const status = terminal ? 'closed' : transfer ? 'transferred' : 'approved';
        const approval = {
          taskId: output.taskId,
          submissionId: current.submissionId,
          revision: output.revision,
          domain: output.domain,
          targetDomain: output.targetDomain,
          proposalHash: output.proposalHash,
          fileHash: request.fileHash,
          path: repoRelative(this.repoRoot, destination),
          prompt,
          status,
          approvedAt,
          approvedBy,
          executed: false,
        };
        state.proposalApprovals[output.proposalHash] = approval;
        state.approvals[taskRevisionKey(output.taskId, output.revision)] = approval;
        state.currentProposalByTask[output.taskId] = {
          ...(state.currentProposalByTask[output.taskId] || {}),
          ...approval,
        };
        state.presentations[output.proposalHash].status = 'approved';
        if (terminal || transfer) {
          delete state.pendingByDomain[request.domain];
        } else {
          state.pendingByDomain[request.domain] = {
            ...current,
            status: 'approved',
            path: repoRelative(this.repoRoot, destination),
            approvedAt,
            approvedBy,
          };
        }
        if (transfer) {
          state.transfers[output.proposalHash] = {
            taskId: output.taskId,
            revision: output.revision,
            proposalHash: output.proposalHash,
            fileHash: request.fileHash,
            fromDomain: output.domain,
            toDomain: output.targetDomain,
            prompt,
            approvedAt,
            approvedBy,
            status: 'approved',
            executed: false,
          };
        }
        state.activity.push({
          type: terminal
            ? 'task_closed_by_user'
            : transfer
              ? 'task_transfer_approved'
              : 'proposal_approved',
          taskId: output.taskId,
          domain: output.domain,
          at: approvedAt,
        });
      });
      await this.taskStore.mutate(output.taskId, (task) => {
        const revision = task.revisions.find((entry) =>
          entry.revision === output.revision &&
          entry.submissionId === resolved.active.submissionId);
        if (!revision) {
          throw new CoordinationError('La revisión aprobada no existe.', {
            code: 'TASK_REVISION_NOT_FOUND',
          });
        }
        if (task.approvals.some((entry) =>
          entry.revision === output.revision &&
          entry.proposalHash === output.proposalHash)) {
          throw new CoordinationError('La aprobación ya existe en la tarea.', {
            code: 'PROPOSAL_ALREADY_DECIDED',
          });
        }
        task.approvals.push({
          revision: output.revision,
          proposalHash: output.proposalHash,
          domain: output.domain,
          targetDomain: output.targetDomain,
          prompt,
          approvedAt,
          approvedBy,
          status: terminal ? 'closed' : 'approved',
        });
        revision.status = terminal ? 'closed' : 'approved';
        revision.updatedAt = approvedAt;
        if (transfer) {
          task.transfers.push({
            revision: output.revision,
            proposalHash: output.proposalHash,
            fromDomain: output.domain,
            toDomain: output.targetDomain,
            prompt,
            approvedAt,
            status: 'pending',
          });
          task.currentDomain = output.targetDomain;
        }
        task.status = terminal ? 'closed' : transfer ? 'transferred' : 'approved';
        return task;
      });
    } catch (error) {
      await this.stateStore.mutate((state) => {
        delete state.proposalApprovals[output.proposalHash];
        delete state.approvals[taskRevisionKey(output.taskId, output.revision)];
        delete state.transfers[output.proposalHash];
        state.presentations[output.proposalHash] = presentation;
        state.currentProposalByTask[output.taskId] = {
          ...(state.currentProposalByTask[output.taskId] || {}),
          status: 'review_ready',
          path: repoRelative(this.repoRoot, resolved.candidate),
        };
        state.pendingByDomain[request.domain] = resolved.active;
      }).catch(() => {});
      await atomicMove(destination, resolved.candidate, { root: this.paths.root }).catch(() => {});
      throw error;
    }
    return {
      taskId: output.taskId,
      submissionId: resolved.active.submissionId,
      revision: output.revision,
      domain: output.domain,
      targetDomain: output.targetDomain,
      proposalHash: output.proposalHash,
      fileHash: request.fileHash,
      approvedAt,
      approvedBy,
      terminal,
      transferRequired: transfer,
      nextPrompt: terminal ? null : prompt,
      executed: false,
    };
  }

  async approve(domain, actor = 'usuario', expectedShownHash) {
    if (domain && typeof domain === 'object') {
      return this.approveV2(domain, actor);
    }
    await this.initialize();
    assertNoSecretMaterial(actor, 'El actor');
    const active = await this.assertShownAndUnchanged(domain, expectedShownHash);
    if (active.output.blockingQuestions.length > 0) {
      throw new CoordinationError(
        'El pending tiene preguntas bloqueantes; debe modificarse o resolverse antes de aprobar.',
        { code: 'BLOCKING_QUESTIONS_UNRESOLVED' },
      );
    }
    const safeActor = String(actor).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120) || 'usuario';
    const destination = path.join(this.paths.approved, `${active.output.taskId}.json`);
    if (await pathExists(destination)) {
      throw new CoordinationError('Ya existe un registro approved para este taskId.', {
        code: 'APPROVED_DESTINATION_EXISTS',
      });
    }
    await atomicMove(active.candidate, destination, { root: this.paths.root });
    const approvedAt = new Date().toISOString();
    try {
      await this.stateStore.mutate((state) => {
        const current = state.pendingByDomain[domain];
        if (!current || current.taskId !== active.output.taskId) {
          throw new CoordinationError('El pending cambió durante la aprobación.', {
            code: 'PENDING_CHANGED_DURING_APPROVAL',
          });
        }
        const terminalClose = active.output.verdict === 'close';
        if (terminalClose) {
          delete state.pendingByDomain[domain];
          for (const record of Object.values(state.processedFiles)) {
            if (record.taskId === active.output.taskId) record.status = 'closed';
          }
        } else {
          current.status = 'approved';
          current.path = repoRelative(this.repoRoot, destination);
          current.approvedAt = approvedAt;
          current.approvedBy = safeActor;
        }
        state.approvals[active.output.taskId] = {
          status: terminalClose ? 'closed' : 'approved',
          domain,
          actor: safeActor,
          approvedAt,
          shownHash: active.actualHash,
          path: repoRelative(this.repoRoot, destination),
        };
        state.activity.push({
          type: terminalClose ? 'task_closed_by_user' : 'pending_approved',
          taskId: active.output.taskId,
          domain,
          at: approvedAt,
        });
      });
    } catch (error) {
      await atomicMove(destination, active.candidate, { root: this.paths.root }).catch(() => {});
      throw error;
    }
    return {
      taskId: active.output.taskId,
      domain,
      approvedAt,
      approvedBy: safeActor,
      terminal: active.output.verdict === 'close',
      promptForSpecialist:
        active.output.verdict === 'close' ? null : active.output.promptForSpecialist,
      executed: false,
      message: active.output.verdict === 'close'
        ? 'Cierre registrado. No se ejecutó un prompt ni se requiere un handoff hijo.'
        : 'Aprobación registrada. La ejecución corresponde exclusivamente al chat especialista.',
    };
  }

  async beginV2(request) {
    await this.initialize();
    if (!request || typeof request !== 'object') {
      throw new CoordinationError('begin v2 requiere criterios exactos.', {
        code: 'V2_CRITERIA_REQUIRED',
      });
    }
    assertSafeTaskId(request.taskId);
    assertAllowedDomain(request.domain);
    const revision = Number(request.revision);
    const proposalHash = assertSha256(request.proposalHash, 'proposalHash');
    const state = await this.stateStore.load();
    const approval = state.proposalApprovals[proposalHash];
    if (
      !approval ||
      approval.status !== 'approved' ||
      approval.taskId !== request.taskId ||
      Number(approval.revision) !== revision ||
      approval.targetDomain !== request.domain
    ) {
      throw new CoordinationError('No existe una aprobación exacta lista para comenzar.', {
        code: 'NO_EXACT_APPROVED_PROPOSAL',
      });
    }
    const fileHash = assertSha256(approval.fileHash, 'fileHash');
    if (
      request.fileHash !== undefined &&
      assertSha256(request.fileHash, 'fileHash') !== fileHash
    ) {
      throw new CoordinationError('El fileHash provisto no coincide con la aprobación.', {
        code: 'APPROVED_FILE_HASH_MISMATCH',
      });
    }
    if (
      approval.domain !== approval.targetDomain &&
      state.transfers[proposalHash]?.status !== 'claimed'
    ) {
      throw new CoordinationError('La transferencia debe reclamarse antes de comenzar.', {
        code: 'TRANSFER_NOT_CLAIMED',
      });
    }
    const candidate = assertPathInside(
      this.paths.approved,
      path.resolve(this.repoRoot, approval.path),
      'Propuesta aprobada',
    );
    const output = await this.readAndValidateOutput(candidate, approval.domain);
    const actualFileHash = await sha256File(candidate, this.config.maxResponseBytes);
    if (
      !isV2Payload(output) ||
      output.taskId !== request.taskId ||
      output.revision !== revision ||
      output.proposalHash !== proposalHash ||
      actualFileHash !== fileHash ||
      output.verdict === 'close'
    ) {
      throw new CoordinationError('La propuesta aprobada no coincide o es terminal.', {
        code: 'APPROVED_PROPOSAL_MISMATCH',
      });
    }
    const prompt = getOutputPrompt(output);
    if (!prompt) {
      throw new CoordinationError('La propuesta aprobada no contiene nextPrompt.', {
        code: 'NEXT_PROMPT_REQUIRED',
      });
    }
    const startedAt = new Date().toISOString();
    const previousActive = state.pendingByDomain[request.domain] || null;
    const previousTransfer = state.transfers[proposalHash] || null;
    const taskBefore = await this.taskStore.load(request.taskId);
    if (!taskBefore.revisions.some((entry) =>
      entry.revision === revision &&
      entry.proposalHash === proposalHash)) {
      throw new CoordinationError('La revisión aprobada no existe.', {
        code: 'TASK_REVISION_NOT_FOUND',
      });
    }
    try {
      await this.stateStore.mutate((current) => {
        const currentApproval = current.proposalApprovals[proposalHash];
        if (
          !currentApproval ||
          currentApproval.status !== 'approved' ||
          currentApproval.fileHash !== fileHash
        ) {
          throw new CoordinationError('La aprobación cambió antes de comenzar.', {
            code: 'APPROVAL_CHANGED_BEFORE_BEGIN',
          });
        }
        currentApproval.status = 'executing';
        currentApproval.startedAt = startedAt;
        const currentTransfer = current.transfers[proposalHash];
        if (currentTransfer?.status === 'claimed') {
          currentTransfer.status = 'executing';
          currentTransfer.startedAt = startedAt;
        }
        const active = current.pendingByDomain[request.domain];
        if (
          active?.taskId === request.taskId &&
          active.proposalHash === proposalHash
        ) {
          active.status = 'executing';
          active.startedAt = startedAt;
        }
        current.activity.push({
          type: 'approved_task_started',
          taskId: request.taskId,
          domain: request.domain,
          at: startedAt,
        });
      });
      await this.taskStore.mutate(request.taskId, (task) => {
        const taskRevision = task.revisions.find((entry) =>
          entry.revision === revision &&
          entry.proposalHash === proposalHash);
        if (!taskRevision) {
          throw new CoordinationError('La revisión aprobada no existe.', {
            code: 'TASK_REVISION_NOT_FOUND',
          });
        }
        taskRevision.status = 'executing';
        taskRevision.updatedAt = startedAt;
        const taskApproval = task.approvals.find((entry) =>
          entry.revision === revision &&
          entry.proposalHash === proposalHash);
        if (!taskApproval || taskApproval.status !== 'approved') {
          throw new CoordinationError('La aprobación no existe en la tarea.', {
            code: 'TASK_APPROVAL_NOT_FOUND',
          });
        }
        taskApproval.status = 'executing';
        const taskTransfer = task.transfers.find((entry) =>
          entry.revision === revision &&
          entry.proposalHash === proposalHash);
        if (taskTransfer?.status === 'claimed') taskTransfer.status = 'executing';
        task.status = 'executing';
        task.currentDomain = request.domain;
        return task;
      });
    } catch (error) {
      await this.stateStore.mutate((current) => {
        current.proposalApprovals[proposalHash] = approval;
        if (previousTransfer) current.transfers[proposalHash] = previousTransfer;
        if (previousActive) {
          current.pendingByDomain[request.domain] = previousActive;
        } else {
          delete current.pendingByDomain[request.domain];
        }
      }).catch(() => {});
      throw error;
    }
    return {
      taskId: request.taskId,
      revision,
      domain: request.domain,
      proposalHash,
      fileHash,
      startedAt,
      nextPrompt: prompt,
      executed: false,
      message: 'Inicio registrado; la ejecución corresponde exclusivamente al chat especialista.',
    };
  }

  async begin(domain, expectedShownHash) {
    if (domain && typeof domain === 'object') {
      return this.beginV2(domain);
    }
    await this.initialize();
    assertAllowedDomain(domain);
    if (!/^[a-f0-9]{64}$/.test(String(expectedShownHash || ''))) {
      throw new CoordinationError(
        'La ejecución requiere el shownHash de la versión aprobada.',
        { code: 'SHOWN_HASH_REQUIRED' },
      );
    }

    const state = await this.stateStore.load();
    const active = state.pendingByDomain[domain];
    if (!active || active.status !== 'approved') {
      throw new CoordinationError('No hay una versión aprobada esperando ejecución.', {
        code: 'NO_APPROVED_PENDING',
      });
    }
    if (active.shownHash !== expectedShownHash) {
      throw new CoordinationError('El shownHash no coincide con la versión aprobada.', {
        code: 'SHOWN_HASH_MISMATCH',
      });
    }
    const candidate = assertPathInside(
      this.paths.approved,
      path.resolve(this.repoRoot, active.path),
      'Approved',
    );
    const output = await this.readAndValidateOutput(candidate, domain);
    const actualHash = await sha256File(candidate, this.config.maxResponseBytes);
    if (actualHash !== expectedShownHash) {
      throw new CoordinationError('La versión aprobada cambió antes de ejecutarse.', {
        code: 'APPROVED_HASH_CHANGED',
      });
    }
    const approval = state.approvals[output.taskId];
    if (
      approval?.status !== 'approved' ||
      approval.domain !== domain ||
      approval.shownHash !== expectedShownHash
    ) {
      throw new CoordinationError('El registro de aprobación no coincide.', {
        code: 'APPROVAL_STATE_MISMATCH',
      });
    }

    const startedAt = new Date().toISOString();
    await this.stateStore.mutate((currentState) => {
      const current = currentState.pendingByDomain[domain];
      if (
        !current ||
        current.taskId !== output.taskId ||
        current.status !== 'approved' ||
        current.shownHash !== expectedShownHash
      ) {
        throw new CoordinationError('La aprobación cambió antes de iniciar.', {
          code: 'APPROVAL_CHANGED_BEFORE_BEGIN',
        });
      }
      current.status = 'executing';
      current.startedAt = startedAt;
      currentState.activity.push({
        type: 'approved_task_started',
        taskId: output.taskId,
        domain,
        at: startedAt,
      });
    });

    return {
      taskId: output.taskId,
      domain,
      startedAt,
      promptForSpecialist: output.promptForSpecialist,
      executed: false,
      message: 'Inicio registrado. El prompt todavía debe ejecutarlo el chat especialista.',
    };
  }

  async continueTask(request, actor = request?.actor || `chat:${request?.domain || 'destino'}`) {
    await this.initialize();
    if (!request || typeof request !== 'object') {
      throw new CoordinationError('continue-task requiere criterios exactos.', {
        code: 'V2_CRITERIA_REQUIRED',
      });
    }
    assertSafeTaskId(request.taskId);
    assertAllowedDomain(request.domain);
    const state = await this.stateStore.load();
    const candidates = Object.values(state.transfers).filter((entry) =>
      entry?.status === 'approved' &&
      entry.taskId === request.taskId &&
      entry.toDomain === request.domain);
    if (candidates.length !== 1) {
      throw new CoordinationError(
        candidates.length === 0
          ? 'No hay una transferencia aprobada para esta tarea y dominio.'
          : 'Hay más de una transferencia aprobada; se requieren criterios exactos.',
        { code: candidates.length === 0 ? 'NO_APPROVED_TRANSFER' : 'AMBIGUOUS_TRANSFER' },
      );
    }
    const transfer = candidates[0];
    const revision = Number(transfer.revision);
    const proposalHash = assertSha256(transfer.proposalHash, 'proposalHash');
    const fileHash = assertSha256(transfer.fileHash, 'fileHash');
    if (
      (request.revision !== undefined && Number(request.revision) !== revision) ||
      (request.proposalHash !== undefined &&
        assertSha256(request.proposalHash, 'proposalHash') !== proposalHash) ||
      (request.fileHash !== undefined &&
        assertSha256(request.fileHash, 'fileHash') !== fileHash)
    ) {
      throw new CoordinationError('Los criterios provistos no coinciden con la transferencia.', {
        code: 'TRANSFER_CRITERIA_MISMATCH',
      });
    }
    const approval = state.proposalApprovals[proposalHash];
    if (
      !transfer ||
      transfer.status !== 'approved' ||
      transfer.taskId !== request.taskId ||
      Number(transfer.revision) !== revision ||
      transfer.fileHash !== fileHash ||
      transfer.toDomain !== request.domain ||
      !approval ||
      approval.status !== 'transferred' ||
      approval.fileHash !== fileHash
    ) {
      throw new CoordinationError('No existe una transferencia exacta disponible.', {
        code: 'NO_EXACT_APPROVED_TRANSFER',
      });
    }
    const active = state.pendingByDomain[request.domain];
    if (active && active.taskId !== request.taskId) {
      throw new CoordinationError('El dominio destino ya tiene otra tarea activa.', {
        code: 'TARGET_DOMAIN_BUSY',
      });
    }
    const candidate = assertPathInside(
      this.paths.approved,
      path.resolve(this.repoRoot, approval.path),
      'Propuesta transferida',
    );
    const output = await this.readAndValidateOutput(candidate, transfer.fromDomain);
    const actualFileHash = await sha256File(candidate, this.config.maxResponseBytes);
    if (
      output.taskId !== request.taskId ||
      output.revision !== revision ||
      output.proposalHash !== proposalHash ||
      actualFileHash !== fileHash ||
      output.targetDomain !== request.domain
    ) {
      throw new CoordinationError('La transferencia cambió antes de ser reclamada.', {
        code: 'TRANSFER_PROPOSAL_MISMATCH',
      });
    }
    const claimedAt = new Date().toISOString();
    const claimedBy = safeActor(actor, `chat:${request.domain}`);
    const previousTargetPending = state.pendingByDomain[request.domain] || null;
    try {
      await this.stateStore.mutate((current) => {
        const currentTransfer = current.transfers[proposalHash];
        const currentApproval = current.proposalApprovals[proposalHash];
        if (
          currentTransfer?.status !== 'approved' ||
          currentApproval?.status !== 'transferred' ||
          currentTransfer.fileHash !== fileHash
        ) {
          throw new CoordinationError('La transferencia ya no está disponible.', {
            code: 'TRANSFER_CHANGED_BEFORE_CLAIM',
          });
        }
        currentTransfer.status = 'claimed';
        currentTransfer.claimedAt = claimedAt;
        currentTransfer.claimedBy = claimedBy;
        currentApproval.status = 'approved';
        currentApproval.claimedAt = claimedAt;
        currentApproval.claimedBy = claimedBy;
        current.pendingByDomain[request.domain] = {
          taskId: request.taskId,
          submissionId: approval.submissionId,
          revision,
          protocolVersion: '2.0',
          domain: request.domain,
          originDomain: transfer.fromDomain,
          targetDomain: request.domain,
          proposalHash,
          fileHash,
          sourceHash: output.sourceHash,
          path: approval.path,
          status: 'approved',
          verdict: output.verdict,
          hasBlockingQuestions: false,
          createdAt: claimedAt,
          approvedAt: approval.approvedAt,
        };
        current.activity.push({
          type: 'task_transfer_claimed',
          taskId: request.taskId,
          domain: request.domain,
          at: claimedAt,
        });
      });
      await this.taskStore.mutate(request.taskId, (task) => {
        const taskTransfer = task.transfers.find((entry) =>
          entry.revision === revision &&
          entry.proposalHash === proposalHash);
        if (!taskTransfer || taskTransfer.status !== 'pending') {
          throw new CoordinationError('La transferencia no existe en la tarea.', {
            code: 'TASK_TRANSFER_NOT_FOUND',
          });
        }
        taskTransfer.status = 'claimed';
        task.currentDomain = request.domain;
        task.status = 'approved';
        return task;
      });
    } catch (error) {
      await this.stateStore.mutate((current) => {
        current.transfers[proposalHash] = transfer;
        current.proposalApprovals[proposalHash] = approval;
        if (previousTargetPending) {
          current.pendingByDomain[request.domain] = previousTargetPending;
        } else {
          delete current.pendingByDomain[request.domain];
        }
      }).catch(() => {});
      throw error;
    }
    return {
      taskId: request.taskId,
      revision,
      domain: request.domain,
      fromDomain: transfer.fromDomain,
      proposalHash,
      fileHash,
      claimedAt,
      claimedBy,
      nextPrompt: getOutputPrompt(output),
      executed: false,
    };
  }

  async observe(request, observation, actor = request?.actor || 'usuario') {
    await this.initialize();
    const text = assertSafeCorrection(observation ?? request?.observation);
    const resolved = await this.resolveV2(request, ['presented']);
    const task = await this.taskStore.load(request.taskId);
    const nextRevision = task.nextRevision;
    if (nextRevision !== Number(request.revision) + 1) {
      throw new CoordinationError('La propuesta presentada ya no es la última revisión.', {
        code: 'V2_PROPOSAL_SUPERSEDED',
      });
    }
    const { handoff: previous } = await this.findCompletedHandoff(
      request.taskId,
      request.revision,
    );
    const sourceChat = safeActor(actor, 'usuario');
    const handoff = {
      ...previous,
      submissionId: createSubmissionId(),
      revision: nextRevision,
      previousRevision: Number(request.revision),
      domain: resolved.output.domain,
      sourceChat,
      createdAt: new Date().toISOString(),
      status: 'partial',
      executionKind: 'user-observation',
      approvedProposalHash: null,
      approvedPrompt: null,
      summary: `Nueva revisión solicitada por observación del usuario: ${text}`,
      changes: [],
      filesCreated: [],
      filesModified: [],
      validationsExecuted: [],
      validationsPending: [],
      risks: [...previous.risks],
      decisionsRequired: [text],
      evidenceManifest: null,
      dataModified: {
        modified: false,
        description: 'La observación no ejecutó cambios ni modificó datos del ERP.',
      },
      suggestedCommit: null,
      gitStatus: [],
      diffSummary: [],
    };
    const archiveName =
      `${path.basename(resolved.candidate, '.json')}.superseded-by-observation.` +
      `${handoff.submissionId}.json`;
    const archive = path.join(this.paths.rejected, archiveName);
    if (await pathExists(archive)) {
      throw new CoordinationError('Ya existe el archivo de observación reemplazante.', {
        code: 'OBSERVATION_ARCHIVE_EXISTS',
      });
    }
    const previousPresentation =
      resolved.state.presentations[request.proposalHash] || null;
    const previousCurrentProposal =
      resolved.state.currentProposalByTask[request.taskId] || null;
    const previousSubmission =
      resolved.state.submissions[resolved.active.submissionId] || null;
    let enqueued;
    let observationRecorded = false;
    await atomicMove(resolved.candidate, archive, { root: this.paths.root });
    try {
      await this.stateStore.mutate((state) => {
        const current = state.pendingByDomain[request.domain];
        if (
          !current ||
          current.taskId !== request.taskId ||
          current.proposalHash !== request.proposalHash ||
          current.fileHash !== request.fileHash
        ) {
          throw new CoordinationError('La propuesta cambió antes de observarse.', {
            code: 'PENDING_CHANGED_DURING_OBSERVATION',
          });
        }
        delete state.pendingByDomain[request.domain];
        state.currentProposalByTask[request.taskId] = {
          ...(state.currentProposalByTask[request.taskId] || {}),
          status: 'superseded',
          supersededAt: handoff.createdAt,
          path: repoRelative(this.repoRoot, archive),
        };
        const presentation = state.presentations[request.proposalHash];
        if (presentation) {
          presentation.status = 'superseded';
          presentation.observationAt = handoff.createdAt;
        }
        const priorSubmission = state.submissions[resolved.active.submissionId];
        if (priorSubmission) {
          priorSubmission.status = 'superseded';
          priorSubmission.supersededAt = handoff.createdAt;
        }
        state.observations[handoff.submissionId] = {
          taskId: request.taskId,
          fromRevision: Number(request.revision),
          revision: nextRevision,
          submissionId: handoff.submissionId,
          domain: request.domain,
          text,
          createdAt: handoff.createdAt,
          status: 'awaiting_review',
        };
        state.activity.push({
          type: 'user_observation_prepared',
          taskId: request.taskId,
          domain: request.domain,
          at: handoff.createdAt,
        });
      });
      await this.taskStore.recordObservation(request.taskId, {
        revision: nextRevision,
        text,
        createdAt: handoff.createdAt,
        status: 'pending',
      });
      observationRecorded = true;
      await this.taskStore.mutate(request.taskId, (currentTask) => {
        const oldRevision = currentTask.revisions.find((entry) =>
          entry.revision === Number(request.revision) &&
          entry.submissionId === resolved.active.submissionId);
        if (!oldRevision) {
          throw new CoordinationError('La revisión observada no existe.', {
            code: 'TASK_REVISION_NOT_FOUND',
          });
        }
        oldRevision.status = 'superseded';
        oldRevision.updatedAt = handoff.createdAt;
        return currentTask;
      });
      enqueued = await this.enqueue(handoff);
    } catch (error) {
      if (observationRecorded) {
        await this.taskStore.mutate(request.taskId, (currentTask) => {
          currentTask.observations = currentTask.observations.filter((entry) =>
            !(
              entry.revision === nextRevision &&
              entry.text === text &&
              entry.createdAt === handoff.createdAt
            ));
          currentTask.events = currentTask.events.filter((entry) =>
            !(
              entry.type === 'user_observation_recorded' &&
              entry.revision === nextRevision
            ));
          const oldRevision = currentTask.revisions.find((entry) =>
            entry.revision === Number(request.revision) &&
            entry.submissionId === resolved.active.submissionId);
          if (oldRevision) {
            const prior = task.revisions.find((entry) =>
              entry.revision === oldRevision.revision &&
              entry.submissionId === oldRevision.submissionId);
            oldRevision.status = prior?.status || 'presented';
            oldRevision.updatedAt = prior?.updatedAt || oldRevision.updatedAt;
          }
          currentTask.status = task.status;
          currentTask.currentDomain = task.currentDomain;
          return currentTask;
        }).catch(() => {});
      }
      await this.stateStore.mutate((state) => {
        state.pendingByDomain[request.domain] = resolved.active;
        if (previousPresentation) {
          state.presentations[request.proposalHash] = previousPresentation;
        }
        if (previousCurrentProposal) {
          state.currentProposalByTask[request.taskId] = previousCurrentProposal;
        }
        if (previousSubmission) {
          state.submissions[resolved.active.submissionId] = previousSubmission;
        }
        delete state.observations[handoff.submissionId];
      }).catch(() => {});
      await atomicMove(archive, resolved.candidate, { root: this.paths.root }).catch(() => {});
      throw error;
    }
    return {
      ...enqueued,
      previousRevision: Number(request.revision),
      status: 'awaiting_review',
      executed: false,
    };
  }

  async retryReview(request) {
    await this.initialize();
    if (!request || typeof request !== 'object') {
      throw new CoordinationError('retry-review requiere criterios exactos.', {
        code: 'V2_CRITERIA_REQUIRED',
      });
    }
    assertSafeTaskId(request.taskId);
    assertSafeTaskId(request.submissionId, 'submissionId');
    assertAllowedDomain(request.domain);
    const revision = Number(request.revision);
    const state = await this.stateStore.load();
    const recordEntry = Object.entries(state.processedFiles).find(([, entry]) =>
      entry.taskId === request.taskId &&
      entry.submissionId === request.submissionId &&
      Number(entry.revision) === revision &&
      entry.domain === request.domain);
    if (!recordEntry || recordEntry[1].status !== 'failed' || !recordEntry[1].failedPath) {
      throw new CoordinationError('No existe una revisión fallida exacta para reintentar.', {
        code: 'FAILED_REVIEW_NOT_FOUND',
      });
    }
    const [fileName, record] = recordEntry;
    const previousSubmission = state.submissions[request.submissionId]
      ? { ...state.submissions[request.submissionId] }
      : null;
    if (request.handoffHash && record.hash !== assertSha256(request.handoffHash, 'handoffHash')) {
      throw new CoordinationError('El handoffHash no coincide con la revisión fallida.', {
        code: 'HANDOFF_HASH_MISMATCH',
      });
    }
    const source = assertPathInside(
      this.paths.failed,
      path.resolve(this.repoRoot, record.failedPath),
      'Handoff fallido',
    );
    const destination = path.join(this.paths.inbox, fileName);
    if (await pathExists(destination)) {
      throw new CoordinationError('El handoff ya está esperando un reintento.', {
        code: 'RETRY_ALREADY_ENQUEUED',
      });
    }
    await atomicMove(source, destination, { root: this.paths.root });
    const retryAt = new Date().toISOString();
    try {
      await this.stateStore.mutate((current) => {
        const currentRecord = current.processedFiles[fileName];
        if (
          !currentRecord ||
          currentRecord.status !== 'failed' ||
          currentRecord.submissionId !== request.submissionId
        ) {
          throw new CoordinationError('La revisión fallida cambió antes del reintento.', {
            code: 'FAILED_REVIEW_CHANGED',
          });
        }
        currentRecord.status = 'retrying';
        currentRecord.retryAt = retryAt;
        const submission = current.submissions[request.submissionId];
        if (submission) {
          submission.status = 'retrying';
          submission.updatedAt = retryAt;
        }
        current.activity.push({
          type: 'review_retry_enqueued',
          taskId: request.taskId,
          domain: request.domain,
          at: retryAt,
        });
      });
      await this.taskStore.mutate(request.taskId, (task) => {
        const taskRevision = task.revisions.find((entry) =>
          entry.revision === revision &&
          entry.submissionId === request.submissionId);
        if (!taskRevision || taskRevision.status !== 'failed') {
          throw new CoordinationError('La revisión fallida no existe en la tarea.', {
            code: 'TASK_REVISION_NOT_FOUND',
          });
        }
        taskRevision.status = 'awaiting_review';
        taskRevision.updatedAt = retryAt;
        task.status = 'awaiting_review';
        return task;
      });
    } catch (error) {
      await atomicMove(destination, source, { root: this.paths.root }).catch(() => {});
      await this.stateStore.mutate((current) => {
        const currentRecord = current.processedFiles[fileName];
        if (
          currentRecord?.status === 'retrying' &&
          currentRecord.retryAt === retryAt
        ) {
          current.processedFiles[fileName] = { ...record };
        }
        if (previousSubmission) {
          current.submissions[request.submissionId] = previousSubmission;
        } else {
          delete current.submissions[request.submissionId];
        }
        current.activity = current.activity.filter((entry) =>
          !(
            entry.type === 'review_retry_enqueued' &&
            entry.taskId === request.taskId &&
            entry.domain === request.domain &&
            entry.at === retryAt
          ));
      }).catch(() => {});
      throw error;
    }
    return {
      taskId: request.taskId,
      submissionId: request.submissionId,
      revision,
      domain: request.domain,
      handoffHash: record.hash,
      status: 'retrying',
      retryAt,
      executed: false,
    };
  }

  async reject(domain, reason, expectedShownHash) {
    await this.initialize();
    const active = await this.assertShownAndUnchanged(domain, expectedShownHash);
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new CoordinationError('El rechazo requiere un motivo.', {
        code: 'MISSING_REJECTION_REASON',
      });
    }
    assertNoSecretMaterial(reason, 'El motivo de rechazo');
    const safeReason = reason.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 1_000);
    const destination = path.join(this.paths.rejected, `${active.output.taskId}.json`);
    await atomicMove(active.candidate, destination, { root: this.paths.root });
    const rejectedAt = new Date().toISOString();
    try {
      await this.stateStore.mutate((state) => {
        const current = state.pendingByDomain[domain];
        if (!current || current.taskId !== active.output.taskId) {
          throw new CoordinationError('El pending cambió durante el rechazo.', {
            code: 'PENDING_CHANGED_DURING_REJECTION',
          });
        }
        delete state.pendingByDomain[domain];
        state.approvals[active.output.taskId] = {
          status: 'rejected',
          domain,
          reason: safeReason,
          rejectedAt,
          shownHash: active.actualHash,
          path: repoRelative(this.repoRoot, destination),
        };
        state.activity.push({
          type: 'pending_rejected',
          taskId: active.output.taskId,
          domain,
          at: rejectedAt,
        });
      });
    } catch (error) {
      await atomicMove(destination, active.candidate, { root: this.paths.root }).catch(() => {});
      throw error;
    }
    return { taskId: active.output.taskId, domain, reason: safeReason, rejectedAt, executed: false };
  }

  async modify(domain, instruction, expectedShownHash) {
    await this.initialize();
    const active = await this.assertShownAndUnchanged(domain, expectedShownHash);
    const correction = assertSafeCorrection(instruction);
    const previousQuestions = active.output.blockingQuestions.length > 0
      ? `Preguntas bloqueantes previas:\n${active.output.blockingQuestions
        .map((question) => `- ${question}`)
        .join('\n')}\n\n`
      : '';
    const updated = {
      ...active.output,
      promptForSpecialist:
        `${active.output.promptForSpecialist.trim()}\n\n` +
        previousQuestions +
        `Aclaración o corrección solicitada por el usuario:\n${correction}`,
      blockingQuestions: [],
    };
    assertSchema(updated, this.outputSchema, 'Pending modificado');
    assertNoSecretMaterial(updated, 'Pending modificado');
    const revision = Number(active.active.revision || 1) + 1;
    const archive = path.join(
      this.paths.rejected,
      `${active.output.taskId}.replaced-r${revision - 1}.json`,
    );
    await atomicMove(active.candidate, archive, { root: this.paths.root });
    try {
      await atomicWriteJson(active.candidate, updated, {
        root: this.paths.root,
        overwrite: false,
        validateJson: (value) => assertSchema(value, this.outputSchema, 'Pending modificado'),
      });
    } catch (error) {
      await atomicMove(archive, active.candidate, { root: this.paths.root }).catch(() => {});
      throw error;
    }
    const modifiedHash = await sha256File(active.candidate, this.config.maxResponseBytes);
    const modifiedAt = new Date().toISOString();
    const details = await this.findObjective(updated.taskId) || {};
    try {
      await this.stateStore.mutate((state) => {
        const current = state.pendingByDomain[domain];
        if (!current || current.taskId !== updated.taskId) {
          throw new CoordinationError('El pending cambió durante la modificación.', {
            code: 'PENDING_CHANGED_DURING_MODIFICATION',
          });
        }
        current.status = 'shown';
        current.revision = revision;
        current.shownAt = modifiedAt;
        current.shownHash = modifiedHash;
        current.pendingHash = modifiedHash;
        current.shownBy = active.active.shownBy || `chat:${domain}`;
        current.hasBlockingQuestions = false;
        current.replacedAt = modifiedAt;
        for (const record of Object.values(state.processedFiles)) {
          if (record.taskId === updated.taskId) {
            record.promptHash = coordinatorPromptHash(updated);
          }
        }
        state.activity.push({
          type: 'pending_modified_and_shown',
          taskId: updated.taskId,
          domain,
          at: modifiedAt,
        });
      });
    } catch (error) {
      const rollback = path.join(
        this.paths.runtime,
        `${updated.taskId}.modify-rollback-${Date.now()}.json`,
      );
      try {
        await atomicMove(active.candidate, rollback, { root: this.paths.root });
        await atomicMove(archive, active.candidate, { root: this.paths.root });
        await fs.unlink(rollback).catch(() => {});
      } catch {
        // Se preservan ambos archivos en runtime/rejected para recuperación manual.
      }
      throw error;
    }
    return {
      ...this.makeReviewView(updated, details),
      revision,
      modifiedAt,
      shownHash: modifiedHash,
      shownBy: active.active.shownBy || `chat:${domain}`,
      approvalRequired: true,
    };
  }
}

module.exports = {
  ProtocolActions,
  assertSafeCorrection,
  assertV2OutputContract,
  listDomainPending,
};
