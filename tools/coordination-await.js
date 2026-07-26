'use strict';

const { loadConfig } = require('./coordination/config');
const { getRepoRoot } = require('./coordination/constants');
const { CoordinationError, safeErrorSummary } = require('./coordination/errors');
const { CoordinationAwaitService } = require('./coordination/await-service');
const {
  assertAllowedDomain,
  assertSafeTaskId,
} = require('./coordination/security');

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    options[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const values = parseArguments(argv);
  assertSafeTaskId(values['task-id'], 'task-id');
  assertAllowedDomain(values.domain);
  if (values['submission-id'] !== undefined) {
    assertSafeTaskId(values['submission-id'], 'submission-id');
  }
  if (!/^[a-f0-9]{64}$/.test(String(values['handoff-hash'] || ''))) {
    throw new CoordinationError('--handoff-hash debe ser un SHA-256 válido.', {
      code: 'INVALID_HANDOFF_HASH',
    });
  }
  const revision = values.revision === undefined
    ? undefined
    : Number(values.revision);
  if (revision === undefined) {
    throw new CoordinationError('--revision es obligatorio para verificar la entrega exacta.', {
      code: 'MISSING_REVISION',
    });
  }
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) {
    throw new CoordinationError('--revision debe ser un entero positivo.', {
      code: 'INVALID_REVISION',
    });
  }
  const timeoutSeconds = values.timeout === undefined
    ? undefined
    : Number(values.timeout);
  if (
    timeoutSeconds !== undefined &&
    (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 3_600)
  ) {
    throw new CoordinationError('--timeout debe ser mayor que 0 y no superar 3600 segundos.', {
      code: 'INVALID_TIMEOUT',
    });
  }
  const repoRoot = dependencies.repoRoot || getRepoRoot();
  const config = dependencies.config || await loadConfig(repoRoot);
  const service = dependencies.service || new CoordinationAwaitService({ repoRoot, config });
  const result = await service.wait({
    taskId: values['task-id'],
    domain: values.domain,
    handoffHash: values['handoff-hash'],
    submissionId: values['submission-id'],
    revision,
    timeoutMs: timeoutSeconds === undefined
      ? config.awaitTimeoutMs
      : timeoutSeconds * 1_000,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[coordinación] ${JSON.stringify(safeErrorSummary(error))}`);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  parseArguments,
};
