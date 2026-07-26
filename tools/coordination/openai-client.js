'use strict';

const {
  CoordinationError,
  sanitizeErrorField,
  sanitizeOpenAIError,
  sanitizeTraceHeaders,
} = require('./errors');

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MAX_REQUEST_BYTES = 25 * 1024 * 1024;
const IMAGE_DATA_URL =
  /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const IMAGE_DETAILS = new Set(['auto', 'low', 'high']);
const TRACE_HEADER_NAMES = [
  'cf-ray',
  'openai-request-id',
  'request-id',
  'traceparent',
  'tracestate',
  'x-correlation-id',
  'x-envoy-upstream-service-time',
  'x-request-id',
  'x-trace-id',
];
const REQUEST_ID_HEADER_NAMES = [
  'x-request-id',
  'openai-request-id',
  'request-id',
];

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function getResponseHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    return headers.get(name);
  }
  if (typeof headers !== 'object' || Array.isArray(headers)) return null;
  const match = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  const value = match ? headers[match] : null;
  return Array.isArray(value) ? value.join(', ') : value;
}

function extractOpenAIResponseTrace(response) {
  const available = {};
  for (const name of TRACE_HEADER_NAMES) {
    const value = getResponseHeader(response?.headers, name);
    if (typeof value === 'string' && value.length > 0) {
      available[name] = value;
    }
  }
  const traceHeaders = sanitizeTraceHeaders(available);
  let requestId = null;
  for (const name of REQUEST_ID_HEADER_NAMES) {
    const value = getResponseHeader(response?.headers, name);
    requestId = sanitizeErrorField(value, 200);
    if (requestId) break;
  }
  return { requestId, traceHeaders };
}

async function readResponseBodyLimited(response, maximumBytes) {
  const contentLength = Number(getResponseHeader(response?.headers, 'content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    return { text: null, omitted: true };
  }
  if (response?.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.byteLength;
        if (total > maximumBytes) {
          await reader.cancel().catch(() => {});
          return { text: null, omitted: true };
        }
        chunks.push(chunk);
      }
      return { text: Buffer.concat(chunks).toString('utf8'), omitted: false };
    } catch {
      return { text: null, omitted: false };
    }
  }
  try {
    if (typeof response?.arrayBuffer === 'function') {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > maximumBytes) return { text: null, omitted: true };
      return { text: buffer.toString('utf8'), omitted: false };
    }
    if (typeof response?.text === 'function') {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > maximumBytes) {
        return { text: null, omitted: true };
      }
      return { text, omitted: false };
    }
  } catch {
    // A transport body that cannot be read must not obscure the HTTP failure.
  }
  return { text: null, omitted: false };
}

async function parseOpenAIErrorResponse(response, options = {}) {
  const maximumBytes = options.maxResponseBytes ?? 256 * 1024;
  const { text, omitted } = await readResponseBodyLimited(response, maximumBytes);
  let rawError = null;
  if (text) {
    try {
      const decoded = JSON.parse(text);
      if (decoded?.error && typeof decoded.error === 'object' && !Array.isArray(decoded.error)) {
        rawError = decoded.error;
      } else if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
        rawError = {
          type: decoded.type,
          code: decoded.code,
          param: decoded.param,
          message: decoded.message,
        };
      }
    } catch {
      rawError = {
        message:
          'OpenAI devolvió un cuerpo de error no JSON; su contenido fue omitido por seguridad.',
      };
    }
  }
  if (!rawError && omitted) {
    rawError = {
      message: 'El cuerpo de error fue omitido porque excede el límite seguro.',
    };
  }
  return sanitizeOpenAIError(rawError);
}

function classifyOpenAIHttpError(status, openaiError) {
  const type = String(openaiError?.type || '').toLowerCase();
  const code = String(openaiError?.code || '').toLowerCase();
  const param = String(openaiError?.param || '').toLowerCase();
  const message = String(openaiError?.message || '').toLowerCase();
  const diagnostic = `${type} ${code} ${param} ${message}`;

  if (
    status === 401 ||
    status === 403 ||
    /authentication|invalid_api_key|insufficient_permissions|permission_denied/.test(diagnostic)
  ) {
    return 'OPENAI_AUTH_ERROR';
  }
  if (
    status === 429 ||
    /rate_limit|rate limit|quota|insufficient_quota/.test(diagnostic)
  ) {
    return 'OPENAI_RATE_LIMIT';
  }
  if (
    /unsupported_parameter|unsupported parameter|parameter[^.]{0,120}not supported|incompatible parameter/.test(
      diagnostic,
    )
  ) {
    return 'OPENAI_UNSUPPORTED_PARAMETER';
  }
  if (
    /invalid_json_schema|schema_validation/.test(`${type} ${code}`) ||
    /(?:response_format(?:\.json_schema)?|json_schema|text\.format)\.schema/.test(param) ||
    /invalid schema|schema for (?:response_format|text\.format)|json schema/.test(message)
  ) {
    return 'OPENAI_INVALID_SCHEMA';
  }
  if (
    /invalid_parameter|unknown_parameter|unknown parameter|unknown property|unrecognized (?:parameter|property)|model_not_found/.test(
      diagnostic,
    ) ||
    (status === 400 && param.length > 0)
  ) {
    return 'OPENAI_INVALID_PARAMETER';
  }
  if (status === 400) return 'OPENAI_BAD_REQUEST';
  if ([408, 409, 425].includes(status)) return 'OPENAI_RETRYABLE_ERROR';
  if (status >= 500) return 'OPENAI_SERVER_ERROR';
  return 'OPENAI_API_ERROR';
}

async function createOpenAIHttpError(response, options = {}) {
  const status = Number.isInteger(response?.status) ? response.status : 0;
  const openaiError = await parseOpenAIErrorResponse(response, options);
  const trace = extractOpenAIResponseTrace(response);
  const code = classifyOpenAIHttpError(status, openaiError);
  const apiMessage = openaiError?.message;
  return new CoordinationError(
    apiMessage
      ? `OpenAI rechazó la solicitud con HTTP ${status}: ${apiMessage}`
      : `OpenAI rechazó la solicitud con HTTP ${status}.`,
    {
      code,
      temporary:
        code === 'OPENAI_RATE_LIMIT' ||
        [408, 409, 425].includes(status) ||
        status >= 500,
      retryAfterMs: parseRetryAfter(getResponseHeader(response?.headers, 'retry-after')),
      httpStatus: status,
      openaiError,
      requestId: trace.requestId,
      traceHeaders: trace.traceHeaders,
      requestedModel: options.requestedModel,
      endpoint: options.endpoint,
    },
  );
}

function extractOutputText(response) {
  if (response?.status === 'incomplete') {
    throw new CoordinationError('La API devolvió una respuesta incompleta.', {
      code: 'OPENAI_INCOMPLETE_RESPONSE',
      temporary: true,
    });
  }
  const textParts = [];
  for (const item of response?.output || []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content?.type === 'refusal') {
        throw new CoordinationError('El coordinador rechazó procesar el handoff.', {
          code: 'OPENAI_REFUSAL',
        });
      }
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        textParts.push(content.text);
      }
    }
  }
  if (textParts.length === 0) {
    throw new CoordinationError('La API no devolvió texto estructurado.', {
      code: 'OPENAI_EMPTY_RESPONSE',
      temporary: false,
    });
  }
  return textParts.join('');
}

function normalizeSchemaForStructuredOutputs(schema) {
  if (Array.isArray(schema)) {
    return schema.map(normalizeSchemaForStructuredOutputs);
  }
  if (!schema || typeof schema !== 'object') return schema;
  const entries = Object.entries(schema)
    .filter(([key]) => !['$schema', '$id', 'uniqueItems'].includes(key));
  const normalized = Object.fromEntries(
    entries.map(([key, value]) => [key, normalizeSchemaForStructuredOutputs(value)]),
  );
  if (Object.prototype.hasOwnProperty.call(normalized, 'const')) {
    const constant = normalized.const;
    normalized.enum = [constant];
    if (!normalized.type) {
      normalized.type = constant === null
        ? 'null'
        : Array.isArray(constant)
          ? 'array'
          : typeof constant;
    }
    delete normalized.const;
  }
  if (
    Array.isArray(normalized.oneOf) &&
    normalized.oneOf.length === 2
  ) {
    const nullVariant = normalized.oneOf.find((entry) => entry?.type === 'null');
    const valueVariant = normalized.oneOf.find(
      (entry) => entry?.type && entry.type !== 'null' && !Array.isArray(entry.type),
    );
    if (nullVariant && valueVariant) {
      delete normalized.oneOf;
      return {
        ...normalized,
        ...valueVariant,
        type: [valueVariant.type, 'null'],
      };
    }
  }
  if (Array.isArray(normalized.oneOf)) {
    normalized.anyOf = normalized.oneOf;
    delete normalized.oneOf;
  }
  return normalized;
}

function assertImageDataUrl(value) {
  if (typeof value !== 'string' || !IMAGE_DATA_URL.test(value)) {
    throw new CoordinationError(
      'Las imágenes de coordinación deben ser data URLs PNG, JPEG o WebP validadas.',
      { code: 'OPENAI_INVALID_IMAGE_INPUT' },
    );
  }
  return value;
}

function normalizeImageBlock(image) {
  if (!image || typeof image !== 'object' || Array.isArray(image)) {
    throw new CoordinationError('La evidencia multimodal tiene un formato inválido.', {
      code: 'OPENAI_INVALID_IMAGE_INPUT',
    });
  }
  const imageUrl = image.image_url || image.dataUrl;
  const detail = image.detail || 'auto';
  if (!IMAGE_DETAILS.has(detail)) {
    throw new CoordinationError('El detalle de imagen debe ser auto, low o high.', {
      code: 'OPENAI_INVALID_IMAGE_DETAIL',
    });
  }
  return {
    type: 'input_image',
    image_url: assertImageDataUrl(imageUrl),
    detail,
  };
}

function validateResponsesInput(input) {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input) || input.length === 0) {
    throw new CoordinationError('La entrada de Responses debe ser texto o mensajes.', {
      code: 'OPENAI_INVALID_INPUT',
    });
  }
  return input.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new CoordinationError('La entrada multimodal contiene un mensaje inválido.', {
        code: 'OPENAI_INVALID_INPUT',
      });
    }
    if (typeof message.role !== 'string' || !Array.isArray(message.content)) {
      throw new CoordinationError('Cada mensaje multimodal requiere role y content.', {
        code: 'OPENAI_INVALID_INPUT',
      });
    }
    const content = message.content.map((block) => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) {
        throw new CoordinationError('La entrada multimodal contiene un bloque inválido.', {
          code: 'OPENAI_INVALID_INPUT',
        });
      }
      if (block.type === 'input_text') {
        if (typeof block.text !== 'string' || block.text.length === 0) {
          throw new CoordinationError('input_text requiere texto no vacío.', {
            code: 'OPENAI_INVALID_INPUT',
          });
        }
        return {
          type: 'input_text',
          text: block.text,
        };
      }
      if (block.type === 'input_image') {
        return normalizeImageBlock(block);
      }
      {
        throw new CoordinationError(
          `Tipo de contenido no permitido en coordinación: ${String(block.type)}.`,
          { code: 'OPENAI_INVALID_INPUT' },
        );
      }
    });
    return {
      role: message.role,
      content,
    };
  });
}

function normalizeResponsesInput(input, images = []) {
  if (!Array.isArray(images)) {
    throw new CoordinationError('images debe ser una lista de evidencias validadas.', {
      code: 'OPENAI_INVALID_IMAGE_INPUT',
    });
  }
  if (images.length === 0) return validateResponsesInput(input);
  const imageBlocks = images.map(normalizeImageBlock);
  if (typeof input === 'string') {
    return [{
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: input,
        },
        ...imageBlocks,
      ],
    }];
  }
  const validated = validateResponsesInput(input);
  return [
    ...validated,
    {
      role: 'user',
      content: imageBlocks,
    },
  ];
}

class OpenAIResponsesClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 256 * 1024;
    this.maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    this.maxOutputTokens = options.maxOutputTokens ?? 4_000;
    this.endpoint = options.endpoint || RESPONSES_URL;
    this.onResponseMetadata =
      typeof options.onResponseMetadata === 'function'
        ? options.onResponseMetadata
        : null;
  }

  assertConfigured() {
    if (!this.apiKey) {
      throw new CoordinationError(
        'Falta OPENAI_API_KEY. Definila como variable de entorno; no uses .env.',
        { code: 'MISSING_API_KEY' },
      );
    }
    if (!this.model) {
      throw new CoordinationError(
        'Falta COORDINATOR_MODEL. Definilo como variable de entorno.',
        { code: 'MISSING_MODEL' },
      );
    }
    if (typeof this.fetch !== 'function') {
      throw new CoordinationError('Esta versión de Node no ofrece fetch global.', {
        code: 'FETCH_NOT_AVAILABLE',
      });
    }
  }

  async createStructuredResponse(options) {
    this.assertConfigured();
    const requestBody = JSON.stringify({
      model: this.model,
      store: false,
      max_output_tokens: this.maxOutputTokens,
      instructions: options.instructions,
      input: normalizeResponsesInput(options.input, options.images || []),
      text: {
        format: {
          type: 'json_schema',
          name: options.schemaName || 'coordinator_output',
          strict: true,
          schema: normalizeSchemaForStructuredOutputs(options.schema),
        },
      },
    });
    if (Buffer.byteLength(requestBody, 'utf8') > this.maxRequestBytes) {
      throw new CoordinationError(
        'La solicitud multimodal excede el tamaño máximo permitido.',
        { code: 'OPENAI_REQUEST_TOO_LARGE' },
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'sunnutrition-erp-coordinator/1.0',
        },
        body: requestBody,
        signal: controller.signal,
      });
    } catch (error) {
      const timeout = error?.name === 'AbortError';
      throw new CoordinationError(
        timeout ? 'La llamada a OpenAI agotó el tiempo.' : 'No se pudo conectar con OpenAI.',
        {
          code: timeout ? 'OPENAI_TIMEOUT' : 'OPENAI_UNAVAILABLE',
          temporary: true,
          cause: error,
        },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw await createOpenAIHttpError(response, {
        endpoint: this.endpoint,
        maxResponseBytes: this.maxResponseBytes,
        requestedModel: this.model,
      });
    }

    const contentLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
      throw new CoordinationError('La respuesta de OpenAI excede el tamaño permitido.', {
        code: 'OPENAI_RESPONSE_TOO_LARGE',
      });
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > this.maxResponseBytes) {
      throw new CoordinationError('La respuesta de OpenAI excede el tamaño permitido.', {
        code: 'OPENAI_RESPONSE_TOO_LARGE',
      });
    }

    let decoded;
    try {
      decoded = JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new CoordinationError('OpenAI devolvió JSON de transporte inválido.', {
        code: 'OPENAI_INVALID_TRANSPORT_JSON',
        temporary: true,
      });
    }
    if (this.onResponseMetadata) {
      this.onResponseMetadata({
        id: typeof decoded.id === 'string' ? decoded.id : null,
        model: typeof decoded.model === 'string' ? decoded.model : null,
      });
    }

    const outputText = extractOutputText(decoded);
    try {
      return JSON.parse(outputText);
    } catch {
      throw new CoordinationError('La salida estructurada no contiene JSON válido.', {
        code: 'OPENAI_INVALID_OUTPUT_JSON',
      });
    }
  }
}

module.exports = {
  OpenAIResponsesClient,
  assertImageDataUrl,
  classifyOpenAIHttpError,
  createOpenAIHttpError,
  extractOpenAIResponseTrace,
  extractOutputText,
  normalizeResponsesInput,
  normalizeSchemaForStructuredOutputs,
  parseRetryAfter,
  parseOpenAIErrorResponse,
};
