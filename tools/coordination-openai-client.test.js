'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { safeErrorSummary } = require('./coordination/errors');
const { OpenAIResponsesClient } = require('./coordination/openai-client');

const TEST_ENDPOINT = 'https://api.openai.test/v1/responses';
const TEST_MODEL = 'gpt-5.6-terra';
const MINIMAL_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
  },
  required: ['ok'],
  additionalProperties: false,
};

function makeHeaders(values = {}) {
  const entries = Object.entries(values).map(([key, value]) => [
    key.toLowerCase(),
    String(value),
  ]);
  const normalized = new Map(entries);
  return {
    get(name) {
      return normalized.get(String(name).toLowerCase()) ?? null;
    },
    entries() {
      return normalized.entries();
    },
    forEach(callback) {
      for (const [key, value] of entries) callback(value, key, this);
    },
  };
}

function makeErrorResponse({
  status = 400,
  body,
  headers = {},
  json = true,
}) {
  const encoded = Buffer.from(
    json ? JSON.stringify(body) : String(body),
    'utf8',
  );
  return {
    ok: false,
    status,
    headers: makeHeaders(headers),
    async arrayBuffer() {
      return encoded;
    },
    async text() {
      return encoded.toString('utf8');
    },
  };
}

function makeClient(response, overrides = {}) {
  return new OpenAIResponsesClient({
    apiKey: 'sk-client-secret-1234567890',
    model: TEST_MODEL,
    endpoint: TEST_ENDPOINT,
    fetchImpl: async () => response,
    ...overrides,
  });
}

async function captureFailure(response, options = {}) {
  const client = makeClient(response, options.client);
  try {
    await client.createStructuredResponse({
      instructions: options.instructions || 'Diagnóstico mínimo.',
      input: options.input || 'Respondé con un objeto JSON.',
      schemaName: 'minimal_diagnostic',
      schema: MINIMAL_SCHEMA,
    });
  } catch (error) {
    return {
      error,
      summary: safeErrorSummary(error),
    };
  }
  assert.fail('La llamada simulada debía ser rechazada por OpenAI.');
}

test('OpenAI error classifies a rejected JSON Schema from the response body', async () => {
  const { error, summary } = await captureFailure(makeErrorResponse({
    body: {
      error: {
        type: 'invalid_request_error',
        code: 'invalid_json_schema',
        param: 'text.format.schema',
        message: 'Invalid schema for response_format: required must include every property.',
      },
    },
  }));

  assert.equal(error.code, 'OPENAI_INVALID_SCHEMA');
  assert.equal(summary.code, 'OPENAI_INVALID_SCHEMA');
  assert.equal(summary.httpStatus, 400);
  assert.deepEqual(summary.openaiError, {
    type: 'invalid_request_error',
    code: 'invalid_json_schema',
    param: 'text.format.schema',
    message: 'Invalid schema for response_format: required must include every property.',
  });
  assert.equal(summary.requestedModel, TEST_MODEL);
  assert.equal(summary.endpoint, TEST_ENDPOINT);
});

test('OpenAI error classifies an incompatible parameter as unsupported', async () => {
  const { summary } = await captureFailure(makeErrorResponse({
    body: {
      error: {
        type: 'invalid_request_error',
        code: 'unsupported_parameter',
        param: 'temperature',
        message: "Unsupported parameter: 'temperature' is not supported with this model.",
      },
    },
  }));

  assert.equal(summary.code, 'OPENAI_UNSUPPORTED_PARAMETER');
  assert.equal(summary.openaiError.param, 'temperature');
  assert.equal(summary.openaiError.code, 'unsupported_parameter');
});

test('OpenAI error classifies an unknown request property as an invalid parameter', async () => {
  const { summary } = await captureFailure(makeErrorResponse({
    body: {
      error: {
        type: 'invalid_request_error',
        code: 'unknown_parameter',
        param: 'text.format.unexpected',
        message: "Unknown parameter: 'text.format.unexpected'.",
      },
    },
  }));

  assert.equal(summary.code, 'OPENAI_INVALID_PARAMETER');
  assert.equal(summary.openaiError.param, 'text.format.unexpected');
  assert.equal(summary.openaiError.code, 'unknown_parameter');
});

test('OpenAI error safely represents a non-JSON response body', async () => {
  const { summary } = await captureFailure(makeErrorResponse({
    body: '<html>Bad request</html>',
    json: false,
  }));

  assert.equal(summary.code, 'OPENAI_BAD_REQUEST');
  assert.equal(summary.httpStatus, 400);
  assert.equal(summary.openaiError.type, null);
  assert.equal(summary.openaiError.code, null);
  assert.equal(summary.openaiError.param, null);
  assert.equal(typeof summary.openaiError.message, 'string');
  assert.equal(summary.openaiError.message.length > 0, true);
});

test('OpenAI error captures request ID and allowlisted trace headers', async () => {
  const { summary } = await captureFailure(makeErrorResponse({
    status: 429,
    headers: {
      'x-request-id': 'req_diagnostic_123',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      'cf-ray': 'trace-ray-123',
      'retry-after': '2',
      authorization: 'Bearer sk-header-secret-1234567890',
      'set-cookie': 'session=private',
    },
    body: {
      error: {
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
        param: null,
        message: 'Rate limit reached.',
      },
    },
  }));

  assert.equal(summary.code, 'OPENAI_RATE_LIMIT');
  assert.equal(summary.requestId, 'req_diagnostic_123');
  assert.equal(
    summary.traceHeaders.traceparent,
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  );
  assert.equal(summary.traceHeaders['cf-ray'], 'trace-ray-123');
  assert.equal(Object.hasOwn(summary.traceHeaders, 'authorization'), false);
  assert.equal(Object.hasOwn(summary.traceHeaders, 'set-cookie'), false);
});

test('OpenAI diagnostic summary redacts secrets, authorization, data URLs and base64', async () => {
  const dataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const standaloneBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkA8AAQUBAScY42YAAAAASUVORK5CYII=';
  const response = makeErrorResponse({
    body: {
      error: {
        type: 'invalid_request_error',
        code: 'invalid_value',
        param: 'input',
        message: [
          'Authorization: Bearer sk-response-secret-1234567890',
          'OPENAI_API_KEY=sk-env-secret-1234567890',
          dataUrl,
          standaloneBase64,
        ].join(' '),
      },
    },
  });
  const { summary } = await captureFailure(response, {
    instructions:
      `PROMPT_COMPLETO_NO_DEBE_APARECER ${dataUrl} sk-prompt-secret-1234567890`,
    input: 'CONTENIDO_SENSIBLE_NO_DEBE_APARECER',
  });
  const serialized = JSON.stringify(summary);

  assert.equal(summary.code, 'OPENAI_INVALID_PARAMETER');
  assert.doesNotMatch(serialized, /sk-[A-Za-z0-9_-]+/);
  assert.doesNotMatch(serialized, /Authorization/i);
  assert.doesNotMatch(serialized, /data:image/i);
  assert.doesNotMatch(serialized, /iVBORw0KGgo/);
  assert.doesNotMatch(serialized, /PROMPT_COMPLETO_NO_DEBE_APARECER/);
  assert.doesNotMatch(serialized, /CONTENIDO_SENSIBLE_NO_DEBE_APARECER/);
  assert.match(serialized, /\[REDACTED/);
});
