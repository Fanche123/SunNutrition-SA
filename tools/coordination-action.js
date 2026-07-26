'use strict';

const path = require('node:path');

const { assertPathInside, readFileLimited } = require('./coordination/atomic-fs');
const { loadConfig } = require('./coordination/config');
const { getCoordinationPaths, getRepoRoot } = require('./coordination/constants');
const { CoordinationError, safeErrorSummary } = require('./coordination/errors');
const { ProtocolActions } = require('./coordination/protocol-actions');
const { loadSchema } = require('./coordination/schema-validator');
const { assertSafeRepositoryFile } = require('./coordination/security');

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value.startsWith('--')) {
      const key = value.slice(2);
      if (key === 'json') {
        options.json = true;
      } else {
        options[key] = rest[++index];
      }
    } else {
      positional.push(value);
    }
  }
  return { command, options, positional };
}

async function readStdinLimited(maximumBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > maximumBytes) {
      throw new CoordinationError('La entrada estándar excede el máximo permitido.', {
        code: 'FILE_TOO_LARGE',
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonSource(source, repoRoot, maximumBytes, label = 'Entrada JSON') {
  let content;
  if (source === '-') {
    content = await readStdinLimited(maximumBytes);
  } else {
    if (!source) {
      throw new CoordinationError(`${label} requiere un archivo relativo o "-".`, {
        code: 'MISSING_JSON_SOURCE',
      });
    }
    assertSafeRepositoryFile(source, label);
    const candidate = assertPathInside(repoRoot, path.resolve(repoRoot, source), label);
    content = (await readFileLimited(candidate, maximumBytes)).toString('utf8');
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new CoordinationError(`${label} no contiene JSON válido.`, {
      code: 'INVALID_JSON',
    });
  }
}

async function readHandoffSource(source, repoRoot, maximumBytes) {
  return readJsonSource(source, repoRoot, maximumBytes, 'Archivo de handoff');
}

function v2Criteria(domain, options, settings = {}) {
  const criteria = {
    taskId: options['task-id'],
    domain,
  };
  if (options.revision !== undefined) criteria.revision = Number(options.revision);
  if (options['proposal-hash'] !== undefined) {
    criteria.proposalHash = options['proposal-hash'];
  }
  if (options['file-hash'] !== undefined) criteria.fileHash = options['file-hash'];
  if (options['submission-id'] !== undefined) {
    criteria.submissionId = options['submission-id'];
  }
  if (options['handoff-hash'] !== undefined) {
    criteria.handoffHash = options['handoff-hash'];
  }
  if (settings.actor) criteria.actor = settings.actor;
  return criteria;
}

function formatRecommendedChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) return '';
  return `Correcciones estructuradas:\n${changes
    .map((change) =>
      `- [${change.category}] ${change.instruction} ` +
      `(objetivo: ${change.target}; resultado: ${change.expectedResult})`)
    .join('\n')}\n`;
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (result.firstPrompt) {
    process.stdout.write(
      `Tarea: ${result.taskId}\nDominio: ${result.domain}\nRevisión inicial: ${result.revision}\n` +
      `Primer prompt:\n${result.firstPrompt}\n` +
      'La tarea quedó registrada. No se ejecutó ninguna instrucción.\n',
    );
    return;
  }
  if (result.version === '2.0' || result.proposalHash || result.nextPrompt !== undefined) {
    process.stdout.write(
      `Tarea: ${result.taskId}\n` +
      `${result.revision ? `Revisión: ${result.revision}\n` : ''}` +
      `${result.domain ? `Dominio: ${result.domain}\n` : ''}` +
      `${result.targetDomain ? `Próximo dominio: ${result.targetDomain}\n` : ''}` +
      `${result.verdict ? `Veredicto: ${result.verdict}\n` : ''}` +
      `${result.summary ? `Resumen: ${result.summary}\n` : ''}` +
      `${result.nextPrompt ? `Prompt propuesto:\n${result.nextPrompt}\n` : ''}` +
      formatRecommendedChanges(result.recommendedChanges) +
      `${result.proposalHash ? `Proposal hash: ${result.proposalHash}\n` : ''}` +
      `${result.fileHash ? `File hash: ${result.fileHash}\n` : ''}` +
      `Ejecutado: ${result.executed === true ? 'sí' : 'no'}\n`,
    );
    return;
  }
  if (result.promptForSpecialist) {
    process.stdout.write(
      `Tarea: ${result.taskId}\nDominio: ${result.domain}\n` +
      `${result.objective ? `Objetivo: ${result.objective}\n` : ''}` +
      `${result.coordinatorAnalysis ? `Análisis: ${result.coordinatorAnalysis}\n` : ''}` +
      `Prompt:\n${result.promptForSpecialist}\n` +
      `${result.risks ? `Riesgos: ${result.risks.join('; ') || 'ninguno declarado'}\n` : ''}` +
      `${result.blockingQuestions ? `Preguntas bloqueantes: ${result.blockingQuestions.join('; ') || 'ninguna'}\n` : ''}` +
      `${result.plannedFiles ? `Archivos previstos: ${result.plannedFiles.join(', ') || 'no declarados'}\n` : ''}` +
      `${result.shownHash ? `Hash mostrado: ${result.shownHash}\n` : ''}` +
      `${result.message || 'No se ejecutó ninguna instrucción.'}\n`,
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const repoRoot = dependencies.repoRoot || getRepoRoot();
  const paths = getCoordinationPaths(repoRoot);
  const config = dependencies.config || await loadConfig(repoRoot);
  const [handoffSchema, outputSchema] = await Promise.all([
    dependencies.handoffSchema || loadSchema(paths.handoffSchema),
    dependencies.outputSchema || loadSchema(paths.coordinatorOutputSchema),
  ]);
  const actions = dependencies.actions || new ProtocolActions({
    repoRoot,
    config,
    handoffSchema,
    outputSchema,
  });
  const { command, positional, options } = parseArguments(argv);
  let result;
  switch (command) {
    case 'create-task':
      result = await actions.createTask(
        await readJsonSource(
          positional[0],
          repoRoot,
          config.maxHandoffBytes,
          'Solicitud de tarea',
        ),
      );
      break;
    case 'enqueue':
      result = await actions.enqueue(
        await readHandoffSource(positional[0], repoRoot, config.maxHandoffBytes),
      );
      break;
    case 'review':
      result = await actions.review(positional[0], options.reviewer || `chat:${positional[0]}`);
      break;
    case 'approve':
      result = options['task-id']
        ? await actions.approve(
          v2Criteria(positional[0], options, { actor: options.actor || 'usuario' }),
          options.actor || 'usuario',
        )
        : await actions.approve(
          positional[0],
          options.actor || 'usuario',
          options['shown-hash'],
        );
      break;
    case 'begin':
      result = options['task-id']
        ? await actions.begin(v2Criteria(positional[0], options))
        : await actions.begin(positional[0], options['shown-hash']);
      break;
    case 'present':
      result = await actions.present(
        v2Criteria(positional[0], options),
        options.reviewer || `chat:${positional[0]}`,
      );
      break;
    case 'observe':
      result = await actions.observe(
        v2Criteria(positional[0], options, { actor: options.actor || 'usuario' }),
        options.text,
        options.actor || 'usuario',
      );
      break;
    case 'continue-task':
      result = await actions.continueTask(
        v2Criteria(positional[0], options, {
          actor: options.actor || `chat:${positional[0]}`,
        }),
        options.actor || `chat:${positional[0]}`,
      );
      break;
    case 'retry-review':
      result = await actions.retryReview(v2Criteria(options.domain, options));
      break;
    case 'reject':
      result = await actions.reject(positional[0], options.reason, options['shown-hash']);
      break;
    case 'modify':
      result = await actions.modify(
        positional[0],
        options.instruction,
        options['shown-hash'],
      );
      break;
    default:
      throw new CoordinationError(
        'Uso v2: create-task <archivo|-> | enqueue <archivo|-> | ' +
        'present <dominio> --task-id ID --revision N --proposal-hash HASH --file-hash HASH | ' +
        'approve <dominio> --task-id ID --revision N --proposal-hash HASH --file-hash HASH | ' +
        'begin <dominio> --task-id ID --revision N --proposal-hash HASH | ' +
        'observe <dominio> --task-id ID --revision N --proposal-hash HASH ' +
        '--file-hash HASH --text X | continue-task <dominio> --task-id ID | ' +
        'retry-review --task-id ID --submission-id ID --revision N --domain DOMINIO. ' +
        'Recuperación v1: review/approve/begin/reject/modify con shownHash.',
        { code: 'INVALID_COMMAND' },
      );
  }
  printResult(result, Boolean(options.json));
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
  readHandoffSource,
  readJsonSource,
  v2Criteria,
};
