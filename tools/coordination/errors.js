'use strict';

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\bOPENAI_API_KEY\s*[:=]\s*\S+/gi,
  /\b(?:Authorization|api[_-]?key)\b\s*[:=]\s*["']?[^"',\s}]+["']?/gi,
  /data:[^,\s]{1,200}(?:;[^,\s]{1,200})?;base64,[A-Za-z0-9+/=_-]+/gi,
  /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{64,}(?![A-Za-z0-9+/_=-])/g,
];

const MAX_ERROR_FIELD_LENGTH = 1_000;
const TRACE_HEADER_NAMES = new Set([
  'cf-ray',
  'openai-request-id',
  'request-id',
  'traceparent',
  'tracestate',
  'x-correlation-id',
  'x-envoy-upstream-service-time',
  'x-request-id',
  'x-trace-id',
]);

class CoordinationError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'CoordinationError';
    this.code = options.code || 'COORDINATION_ERROR';
    this.temporary = Boolean(options.temporary);
    this.retryAfterMs = Number.isFinite(options.retryAfterMs)
      ? Math.max(0, options.retryAfterMs)
      : null;
    this.httpStatus = Number.isInteger(options.httpStatus)
      ? options.httpStatus
      : null;
    this.openaiError = sanitizeOpenAIError(options.openaiError);
    this.requestId = sanitizeErrorField(options.requestId, 200);
    this.traceHeaders = sanitizeTraceHeaders(options.traceHeaders);
    this.requestedModel = sanitizeErrorField(options.requestedModel, 200);
    this.endpoint = sanitizeEndpoint(options.endpoint);
    this.cause = options.cause;
  }
}

function redactSecrets(value) {
  let output = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, '[REDACTED]');
  }
  return output;
}

function sanitizeErrorField(value, maximumLength = MAX_ERROR_FIELD_LENGTH) {
  if (typeof value !== 'string') return null;
  const sanitized = redactSecrets(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized ? sanitized.slice(0, maximumLength) : null;
}

function sanitizeOpenAIError(error) {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const sanitized = {
    type: sanitizeErrorField(error.type, 200),
    code: sanitizeErrorField(error.code, 200),
    param: sanitizeErrorField(error.param, 300),
    message: sanitizeErrorField(error.message, MAX_ERROR_FIELD_LENGTH),
  };
  return Object.values(sanitized).some((value) => value !== null)
    ? sanitized
    : null;
}

function sanitizeTraceHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null;
  const sanitized = {};
  for (const [name, value] of Object.entries(headers)) {
    const safeName = sanitizeErrorField(name, 100)?.toLowerCase();
    const safeValue = sanitizeErrorField(value, 300);
    if (safeName && TRACE_HEADER_NAMES.has(safeName) && safeValue) {
      sanitized[safeName] = safeValue;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function sanitizeEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) return null;
  try {
    const parsed = new URL(endpoint);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return sanitizeErrorField(endpoint, 500);
  }
}

function safeErrorSummary(error) {
  const code = sanitizeErrorField(error?.code, 200) || 'UNKNOWN_ERROR';
  const message = sanitizeErrorField(error?.message || 'Error desconocido', 500)
    || 'Error desconocido';
  const summary = { code, message };
  if (Number.isInteger(error?.httpStatus)) summary.httpStatus = error.httpStatus;
  const openaiError = sanitizeOpenAIError(error?.openaiError);
  if (openaiError) summary.openaiError = openaiError;
  const requestId = sanitizeErrorField(error?.requestId, 200);
  if (requestId) summary.requestId = requestId;
  const traceHeaders = sanitizeTraceHeaders(error?.traceHeaders);
  if (traceHeaders) summary.traceHeaders = traceHeaders;
  const requestedModel = sanitizeErrorField(error?.requestedModel, 200);
  if (requestedModel) summary.requestedModel = requestedModel;
  const endpoint = sanitizeEndpoint(error?.endpoint);
  if (endpoint) summary.endpoint = endpoint;
  return summary;
}

module.exports = {
  CoordinationError,
  redactSecrets,
  sanitizeEndpoint,
  sanitizeErrorField,
  sanitizeOpenAIError,
  sanitizeTraceHeaders,
  safeErrorSummary,
};
