'use strict';

const {
  createOpenAIHttpError,
  extractOpenAIResponseTrace,
  normalizeSchemaForStructuredOutputs,
} = require('./coordination/openai-client');
const {
  CoordinationError,
  safeErrorSummary,
  sanitizeEndpoint,
  sanitizeErrorField,
} = require('./coordination/errors');

const COORDINATOR_OUTPUT_V2_SCHEMA =
  require('../.coordination/coordinator-output-v2.schema.json');

const RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_SUCCESS_RESPONSE_BYTES = 512 * 1024;
const MINIMAL_IMAGE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
function modelEndpointFor(responsesEndpoint, model) {
  const parsed = new URL(responsesEndpoint);
  parsed.pathname = parsed.pathname.replace(
    /\/responses\/?$/,
    `/models/${encodeURIComponent(model)}`,
  );
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

const responseTraceMetadata = extractOpenAIResponseTrace;

function publicResponseMetadata(response, decoded, context) {
  const trace = responseTraceMetadata(response);
  return {
    httpStatus: response.status,
    endpoint: sanitizeEndpoint(context.endpoint),
    requestedModel: sanitizeErrorField(context.requestedModel, 200),
    responseModel: sanitizeErrorField(decoded?.model || decoded?.id, 200),
    responseId: sanitizeErrorField(decoded?.id, 200),
    requestId: trace.requestId,
    traceHeaders: trace.traceHeaders,
  };
}

async function readSuccessJson(response) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (
    Number.isFinite(declaredLength)
    && declaredLength > MAX_SUCCESS_RESPONSE_BYTES
  ) {
    throw new CoordinationError(
      'La respuesta diagnóstica de OpenAI excede el tamaño permitido.',
      { code: 'OPENAI_RESPONSE_TOO_LARGE' },
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_SUCCESS_RESPONSE_BYTES) {
    throw new CoordinationError(
      'La respuesta diagnóstica de OpenAI excede el tamaño permitido.',
      { code: 'OPENAI_RESPONSE_TOO_LARGE' },
    );
  }
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new CoordinationError(
      'OpenAI devolvió JSON de transporte inválido durante el diagnóstico.',
      { code: 'OPENAI_INVALID_TRANSPORT_JSON' },
    );
  }
}

async function requestJson(options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let response;
  try {
    response = await options.fetchImpl(options.endpoint, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'sunnutrition-erp-coordinator-diagnostic/1.0',
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });
  } catch (error) {
    const timeout = error?.name === 'AbortError';
    throw new CoordinationError(
      timeout
        ? 'La llamada diagnóstica a OpenAI agotó el tiempo.'
        : 'No se pudo conectar con OpenAI durante el diagnóstico.',
      {
        code: timeout ? 'OPENAI_TIMEOUT' : 'OPENAI_UNAVAILABLE',
        temporary: true,
        requestedModel: options.requestedModel,
        endpoint: options.endpoint,
        cause: error,
      },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw await createOpenAIHttpError(response, {
      requestedModel: options.requestedModel,
      endpoint: options.endpoint,
    });
  }

  const decoded = await readSuccessJson(response);
  return {
    decoded,
    metadata: publicResponseMetadata(response, decoded, options),
  };
}

function minimalStructuredSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
    },
    required: ['ok'],
    additionalProperties: false,
  };
}

function buildDiagnosticStages(options) {
  const common = {
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    requestedModel: options.model,
    timeoutMs: options.timeoutMs,
  };
  const responsesEndpoint = options.responsesEndpoint;
  const modelEndpoint = modelEndpointFor(responsesEndpoint, options.model);

  return [
    {
      number: 1,
      id: 'model_access',
      description: 'Acceso al modelo mediante Models API.',
      run: () => requestJson({
        ...common,
        method: 'GET',
        endpoint: modelEndpoint,
      }),
    },
    {
      number: 2,
      id: 'responses_api',
      description: 'Compatibilidad mínima con Responses API, sin schema ni imagen.',
      run: () => requestJson({
        ...common,
        method: 'POST',
        endpoint: responsesEndpoint,
        body: {
          model: options.model,
          store: false,
          max_output_tokens: 256,
          input: 'Respondé únicamente con OK.',
        },
      }),
    },
    {
      number: 3,
      id: 'structured_outputs_minimal',
      description: 'Structured Outputs con un JSON Schema mínimo.',
      run: () => requestJson({
        ...common,
        method: 'POST',
        endpoint: responsesEndpoint,
        body: {
          model: options.model,
          store: false,
          max_output_tokens: 256,
          input: 'Devolvé el resultado diagnóstico solicitado.',
          text: {
            format: {
              type: 'json_schema',
              name: 'coordinator_diagnostic_minimal',
              strict: true,
              schema: minimalStructuredSchema(),
            },
          },
        },
      }),
    },
    {
      number: 4,
      id: 'full_coordinator_contract',
      description: 'Compatibilidad del contrato completo actual, sin imagen.',
      run: () => requestJson({
        ...common,
        method: 'POST',
        endpoint: responsesEndpoint,
        body: {
          model: options.model,
          store: false,
          max_output_tokens: 4_000,
          instructions:
            'Generá una salida sintética válida para comprobar únicamente el contrato.',
          input:
            'Diagnóstico aislado del contrato del coordinador. No hay datos reales ni imagen.',
          text: {
            format: {
              type: 'json_schema',
              name: 'coordinator_output_v2_diagnostic',
              strict: true,
              schema: normalizeSchemaForStructuredOutputs(
                COORDINATOR_OUTPUT_V2_SCHEMA,
              ),
            },
          },
        },
      }),
    },
    {
      number: 5,
      id: 'input_image',
      description: 'Compatibilidad de input_image con una imagen sintética mínima.',
      run: () => requestJson({
        ...common,
        method: 'POST',
        endpoint: responsesEndpoint,
        body: {
          model: options.model,
          store: false,
          max_output_tokens: 256,
          input: [{
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Confirmá brevemente que podés procesar esta imagen sintética.',
              },
              {
                type: 'input_image',
                image_url: MINIMAL_IMAGE_DATA_URL,
                detail: 'low',
              },
            ],
          }],
        },
      }),
    },
  ];
}

function diagnosticOptions(environment = process.env, overrides = {}) {
  const apiKey = String(overrides.apiKey || environment.OPENAI_API_KEY || '').trim();
  const model = String(
    overrides.model || environment.COORDINATOR_MODEL || '',
  ).trim();
  if (!apiKey) {
    throw new CoordinationError(
      'Falta OPENAI_API_KEY. Definila solo como variable de entorno.',
      { code: 'MISSING_API_KEY' },
    );
  }
  if (!model) {
    throw new CoordinationError(
      'Falta COORDINATOR_MODEL. Para esta prueba usá gpt-5.6-terra.',
      { code: 'MISSING_MODEL' },
    );
  }
  const fetchImpl = overrides.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new CoordinationError('Esta versión de Node no ofrece fetch global.', {
      code: 'FETCH_NOT_AVAILABLE',
    });
  }
  return {
    apiKey,
    model,
    fetchImpl,
    responsesEndpoint: overrides.responsesEndpoint || RESPONSES_ENDPOINT,
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

async function runDiagnostic(overrides = {}) {
  const options = diagnosticOptions(overrides.environment, overrides);
  const report = {
    requestedModel: sanitizeErrorField(options.model, 200),
    responsesEndpoint: sanitizeEndpoint(options.responsesEndpoint),
    stoppedAtFirstFailure: true,
    stages: [],
    result: 'running',
  };

  for (const stage of buildDiagnosticStages(options)) {
    try {
      const outcome = await stage.run();
      report.stages.push({
        number: stage.number,
        id: stage.id,
        description: stage.description,
        result: 'passed',
        ...outcome.metadata,
      });
    } catch (error) {
      report.stages.push({
        number: stage.number,
        id: stage.id,
        description: stage.description,
        result: 'failed',
        error: safeErrorSummary(error),
      });
      report.result = 'failed';
      report.failedStage = stage.id;
      return report;
    }
  }

  report.result = 'passed';
  report.failedStage = null;
  return report;
}

async function main() {
  let report;
  try {
    report = await runDiagnostic();
  } catch (error) {
    report = {
      result: 'configuration_failed',
      stoppedAtFirstFailure: true,
      error: safeErrorSummary(error),
      stages: [],
    };
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (report.result === 'passed') {
    process.stdout.write(serialized);
    return;
  }
  process.stderr.write(serialized);
  process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  buildDiagnosticStages,
  diagnosticOptions,
  main,
  minimalStructuredSchema,
  modelEndpointFor,
  publicResponseMetadata,
  requestJson,
  responseTraceMetadata,
  runDiagnostic,
};
