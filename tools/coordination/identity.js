'use strict';

const crypto = require('node:crypto');

const { sha256Value } = require('./atomic-fs');

function isV2Payload(value) {
  return value?.version === '2.0' ||
    (
      Number.isInteger(value?.revision) &&
      (
        typeof value?.submissionId === 'string' ||
        typeof value?.nextPrompt === 'string' ||
        Object.prototype.hasOwnProperty.call(value || {}, 'proposalHash')
      )
    );
}

function getRevision(value) {
  return isV2Payload(value) ? Number(value.revision) : 1;
}

function getSubmissionId(value) {
  return isV2Payload(value) ? (value.submissionId || null) : value.taskId;
}

function getOutputPrompt(output) {
  return String(output?.nextPrompt ?? output?.promptForSpecialist ?? '').trim();
}

function getOutputSummary(output) {
  return String(output?.summary ?? output?.summaryForUser ?? '').trim();
}

function getOutputDomain(output, fallback) {
  return output?.domain || fallback || output?.targetDomain;
}

function coordinatorPromptHash(output) {
  return sha256Value({
    targetDomain: output.targetDomain,
    verdict: output.verdict,
    promptForSpecialist: getOutputPrompt(output),
    recommendedChanges: output.recommendedChanges || [],
  });
}

function coordinatorProposalHash(output) {
  if (isV2Payload(output) && /^[a-f0-9]{64}$/.test(String(output.proposalHash || ''))) {
    return output.proposalHash;
  }
  return sha256Value({
    taskId: output.taskId,
    revision: getRevision(output),
    domain: output.domain || null,
    targetDomain: output.targetDomain,
    verdict: output.verdict,
    nextPrompt: getOutputPrompt(output),
    recommendedChanges: output.recommendedChanges || [],
    closeReason: output.closeReason || null,
    evidenceRequired: output.evidenceRequired || [],
  });
}

function createProposalToken(input) {
  return sha256Value({
    taskId: input.taskId,
    revision: Number(input.revision),
    sourceHash: input.sourceHash,
  });
}

function createSubmissionId() {
  return crypto.randomUUID();
}

function submissionFileName(handoff) {
  if (!isV2Payload(handoff)) return `${handoff.taskId}.json`;
  return `${handoff.taskId}.r${getRevision(handoff)}.${getSubmissionId(handoff)}.json`;
}

function proposalFileName(output) {
  if (!isV2Payload(output)) return `${output.taskId}.json`;
  return `${output.taskId}.r${getRevision(output)}.json`;
}

function taskRevisionKey(taskId, revision) {
  return `${taskId}:r${Number(revision)}`;
}

module.exports = {
  coordinatorProposalHash,
  coordinatorPromptHash,
  createProposalToken,
  createSubmissionId,
  getOutputDomain,
  getOutputPrompt,
  getOutputSummary,
  getRevision,
  getSubmissionId,
  isV2Payload,
  proposalFileName,
  submissionFileName,
  taskRevisionKey,
};
