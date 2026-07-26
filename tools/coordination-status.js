'use strict';

const { getRepoRoot } = require('./coordination/constants');
const { safeErrorSummary } = require('./coordination/errors');
const { formatStatus, getCoordinationStatus } = require('./coordination/status-service');

async function main(argv = process.argv.slice(2)) {
  const status = await getCoordinationStatus(getRepoRoot());
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatStatus(status)}\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[coordinación] ${JSON.stringify(safeErrorSummary(error))}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
