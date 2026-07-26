'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  runDiagnostic,
} = require('./coordination-api-diagnostic');

function fakeHeaders(values = {}) {
  const normalized = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    get(name) {
      return normalized[String(name).toLowerCase()] ?? null;
    },
  };
}

function fakeResponse(status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: fakeHeaders({
      'content-length': String(body.byteLength),
      ...headers,
    }),
    async arrayBuffer() {
      return body;
    },
  };
}

test('el diagnóstico recorre las cinco etapas en orden y no expone requests', async () => {
  const calls = [];
  const model = 'gpt-5.6-terra';
  const report = await runDiagnostic({
    apiKey: 'diagnostic-key-must-not-appear',
    model,
    timeoutMs: 1_000,
    fetchImpl: async (endpoint, request) => {
      calls.push({
        endpoint,
        method: request.method,
        body: request.body ? JSON.parse(request.body) : null,
      });
      return fakeResponse(
        200,
        calls.length === 1
          ? { id: model }
          : { id: `resp_${calls.length}`, model },
        { 'x-request-id': `req_${calls.length}` },
      );
    },
  });

  assert.equal(report.result, 'passed');
  assert.deepEqual(
    report.stages.map((stage) => stage.id),
    [
      'model_access',
      'responses_api',
      'structured_outputs_minimal',
      'full_coordinator_contract',
      'input_image',
    ],
  );
  assert.equal(calls.length, 5);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].body, null);
  assert.equal(calls[1].body.text, undefined);
  assert.equal(calls[1].body.input.includes('OK'), true);
  assert.equal(
    calls[2].body.text.format.schema.additionalProperties,
    false,
  );
  assert.equal(
    calls[3].body.text.format.name,
    'coordinator_output_v2_diagnostic',
  );
  assert.equal(
    calls[4].body.input[0].content[1].type,
    'input_image',
  );

  const serializedReport = JSON.stringify(report);
  assert.equal(serializedReport.includes('diagnostic-key-must-not-appear'), false);
  assert.equal(serializedReport.includes('data:image/'), false);
  assert.equal(serializedReport.includes('Respondé únicamente'), false);
});

test('el diagnóstico respeta COORDINATOR_MODEL y se detiene en la primera falla', async () => {
  const calls = [];
  const model = 'gpt-5.6-terra';
  const report = await runDiagnostic({
    environment: {
      OPENAI_API_KEY: 'environment-key-must-not-appear',
      COORDINATOR_MODEL: model,
    },
    timeoutMs: 1_000,
    fetchImpl: async (endpoint, request) => {
      calls.push({
        endpoint,
        method: request.method,
      });
      if (calls.length === 3) {
        return fakeResponse(
          400,
          {
            error: {
              type: 'invalid_request_error',
              code: 'invalid_json_schema',
              param: 'text.format.schema',
              message:
                'Invalid schema. Authorization: Bearer secret-value data:image/png;base64,AAAA',
            },
          },
          {
            'x-request-id': 'req_failed_stage_3',
            traceparent: '00-safe-trace-01',
          },
        );
      }
      if (calls.length > 3) {
        throw new Error('No se deben invocar etapas posteriores.');
      }
      return fakeResponse(
        200,
        calls.length === 1
          ? { id: model }
          : { id: `resp_${calls.length}`, model },
      );
    },
  });

  assert.equal(calls.length, 3);
  assert.equal(report.requestedModel, model);
  assert.equal(report.result, 'failed');
  assert.equal(report.failedStage, 'structured_outputs_minimal');
  assert.deepEqual(
    report.stages.map((stage) => stage.result),
    ['passed', 'passed', 'failed'],
  );
  assert.equal(report.stages[2].error.code, 'OPENAI_INVALID_SCHEMA');
  assert.equal(report.stages[2].error.httpStatus, 400);
  assert.equal(report.stages[2].error.requestId, 'req_failed_stage_3');
  assert.equal(report.stages[2].error.requestedModel, model);

  const serializedReport = JSON.stringify(report);
  assert.equal(serializedReport.includes('environment-key-must-not-appear'), false);
  assert.equal(serializedReport.includes('secret-value'), false);
  assert.equal(serializedReport.includes('data:image/'), false);
  assert.equal(serializedReport.includes('AAAA'), false);
});
