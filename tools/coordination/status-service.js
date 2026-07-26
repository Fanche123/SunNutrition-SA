'use strict';

const fs = require('node:fs/promises');
const { DOMAINS, getCoordinationPaths } = require('./constants');
const { readHeartbeat } = require('./heartbeat');
const { createEmptyState, normalizeState } = require('./state-store');

async function countJson(directory) {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .length;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

async function readStateReadonly(statePath) {
  try {
    return normalizeState(JSON.parse(await fs.readFile(statePath, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return createEmptyState();
    throw error;
  }
}

async function getCoordinationStatus(repoRoot) {
  const paths = getCoordinationPaths(repoRoot);
  const state = await readStateReadonly(paths.state);
  const pending = {};
  for (const domain of DOMAINS) {
    const active = state.pendingByDomain[domain] || null;
    pending[domain] = active && {
      taskId: active.taskId,
      status: active.status,
      protocolVersion: active.protocolVersion || '1.0',
      submissionId: active.submissionId || null,
      verdict: active.verdict || null,
      proposalHash: active.proposalHash || null,
      fileHash: active.fileHash || active.shownHash || null,
      domain: active.domain || domain,
      targetDomain: active.targetDomain || domain,
      hasBlockingQuestions: Boolean(active.hasBlockingQuestions),
      revision: active.revision || 1,
      createdAt: active.createdAt || null,
      presentedAt: active.presentedAt || active.shownAt || null,
    };
  }
  const [approved, completed, failed, rejected] = await Promise.all([
    countJson(paths.approved),
    countJson(paths.completed),
    countJson(paths.failed),
    countJson(paths.rejected),
  ]);
  const activeEntries = Object.values(pending).filter(Boolean);
  const tasks = Object.values(state.tasks);
  const submissions = Object.values(state.submissions);
  const heartbeat = await readHeartbeat(repoRoot).catch(() => null);
  const queued = Object.values(state.queuedByDomain)
    .reduce((total, entries) => total + (Array.isArray(entries) ? entries.length : 0), 0);
  return {
    pending,
    heartbeat,
    presentations: Object.values(state.presentations),
    transfers: Object.values(state.transfers),
    tasks,
    submissions,
    totals: {
      tasks: tasks.length,
      submissions: submissions.length,
      pending: activeEntries.filter(
        (entry) => ['pending', 'shown', 'writing', 'review_ready'].includes(entry.status),
      ).length,
      presented: activeEntries.filter((entry) => entry.status === 'presented').length,
      awaitingRevision: tasks.filter(
        (entry) => ['approved', 'executing', 'transferred'].includes(entry.status),
      ).length,
      approved,
      approvedAwaitingChat: activeEntries.filter((entry) => entry.status === 'approved').length,
      executing: activeEntries.filter((entry) => entry.status === 'executing').length,
      completed,
      failed,
      rejected,
      blocked: activeEntries.filter(
        (entry) => entry.verdict === 'blocked' || entry.hasBlockingQuestions,
      ).length,
      queued,
    },
    lastActivity: state.activity[state.activity.length - 1] || null,
    updatedAt: state.updatedAt || null,
  };
}

function formatStatus(status) {
  const lines = [
    'Estado de coordinación (solo lectura)',
    `Pendientes: ${status.totals.pending}`,
    `Presentados al usuario: ${status.totals.presented}`,
    `Esperando nueva entrega: ${status.totals.awaitingRevision}`,
    `Tareas registradas: ${status.totals.tasks}`,
    `Entregas registradas: ${status.totals.submissions}`,
    `Aprobados: ${status.totals.approved}`,
    `Aprobados esperando al chat: ${status.totals.approvedAwaitingChat}`,
    `En ejecución declarada: ${status.totals.executing}`,
    `En cola: ${status.totals.queued}`,
    `Completados: ${status.totals.completed}`,
    `Fallidos: ${status.totals.failed}`,
    `Rechazados: ${status.totals.rejected}`,
    `Bloqueados: ${status.totals.blocked}`,
    `Watcher: ${status.heartbeat?.active ? 'activo' : 'inactivo'}`,
    '',
    'Por dominio:',
  ];
  for (const domain of DOMAINS) {
    const pending = status.pending[domain];
    lines.push(
      pending
        ? `- ${domain}: ${pending.taskId} (${pending.status}` +
          `${pending.protocolVersion === '2.0' ? `, r${pending.revision}` : ''}` +
          `${pending.verdict ? `, ${pending.verdict}` : ''}` +
          `${pending.hasBlockingQuestions ? ', preguntas bloqueantes' : ''})`
        : `- ${domain}: sin pendiente`,
    );
  }
  lines.push(
    '',
    status.lastActivity
      ? `Última actividad: ${status.lastActivity.at} - ${status.lastActivity.type}`
      : 'Última actividad: sin registros',
  );
  return lines.join('\n');
}

module.exports = {
  formatStatus,
  getCoordinationStatus,
  readStateReadonly,
};
