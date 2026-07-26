'use strict';

const { loadConfig } = require('./coordination/config');
const { CoordinatorService } = require('./coordination/coordinator-service');
const { getCoordinationPaths, getRepoRoot } = require('./coordination/constants');
const { safeErrorSummary } = require('./coordination/errors');
const { acquireLock } = require('./coordination/lock');
const { OpenAIResponsesClient } = require('./coordination/openai-client');
const { loadSchema } = require('./coordination/schema-validator');
const { CoordinationWatcher } = require('./coordination/watcher-core');

async function createWatcher(options = {}) {
  const repoRoot = options.repoRoot || getRepoRoot();
  const paths = getCoordinationPaths(repoRoot);
  const config = options.config || await loadConfig(repoRoot);
  const logger = options.logger || console;
  const [handoffSchema, outputSchema] = await Promise.all([
    options.handoffSchema || loadSchema(paths.handoffSchema),
    options.outputSchema || loadSchema(paths.coordinatorOutputSchema),
  ]);
  const client = options.client || new OpenAIResponsesClient({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.COORDINATOR_MODEL,
    timeoutMs: config.apiTimeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    maxOutputTokens: config.maxOutputTokens,
  });
  if (!options.coordinator) client.assertConfigured();
  const coordinator = options.coordinator || new CoordinatorService({
    repoRoot,
    client,
    config,
    outputSchema,
    logger,
  });
  return new CoordinationWatcher({
    repoRoot,
    config,
    handoffSchema,
    outputSchema,
    coordinator,
    logger,
    sleep: options.sleep,
    random: options.random,
    notificationStream: options.notificationStream,
  });
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const once = argv.includes('--once');
  const repoRoot = dependencies.repoRoot || getRepoRoot();
  const paths = getCoordinationPaths(repoRoot);
  const config = dependencies.config || await loadConfig(repoRoot);
  const lock = await (dependencies.acquireLock || acquireLock)(paths.watcherLock, {
    staleMs: config.lockStaleMs,
  });
  let watcher;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await watcher?.stop();
    } finally {
      await lock.release();
    }
  };

  try {
    watcher = dependencies.watcher || await createWatcher({ repoRoot, config });
    if (once) {
      await watcher.initialize();
      await watcher.scan({ waitForStable: true });
      await stop();
      return;
    }
    await watcher.start();
    console.info('[coordinación] Watcher activo. No ejecuta ni aprueba prompts.');
    process.once('SIGINT', () => stop().then(() => process.exit(0)));
    process.once('SIGTERM', () => stop().then(() => process.exit(0)));
  } catch (error) {
    await stop();
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[coordinación] ${JSON.stringify(safeErrorSummary(error))}`);
    process.exitCode = 1;
  });
}

module.exports = {
  createWatcher,
  main,
};
