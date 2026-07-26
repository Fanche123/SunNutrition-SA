'use strict';

const fs = require('node:fs/promises');

const { CoordinationError } = require('./errors');

function actualType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, expected) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => {
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (type === 'array') return Array.isArray(value);
    if (type === 'null') return value === null;
    return typeof value === type;
  });
}

function resolveLocalRef(rootSchema, ref) {
  if (!ref.startsWith('#/')) return null;
  return ref
    .slice(2)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((current, key) => current?.[key], rootSchema);
}

function validateNode(value, schema, path, errors, rootSchema) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.$ref) {
    const resolved = resolveLocalRef(rootSchema, schema.$ref);
    if (!resolved) {
      errors.push(`${path}: referencia no soportada ${schema.$ref}.`);
      return;
    }
    validateNode(value, resolved, path, errors, rootSchema);
    return;
  }

  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    errors.push(`${path}: debe ser ${JSON.stringify(schema.const)}.`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) {
    errors.push(`${path}: valor fuera del enum permitido.`);
  }

  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) validateNode(value, child, path, errors, rootSchema);
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.filter((child) => {
      const childErrors = [];
      validateNode(value, child, path, childErrors, rootSchema);
      return childErrors.length === 0;
    });
    if (matches.length === 0) errors.push(`${path}: no coincide con ninguna variante anyOf.`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((child) => {
      const childErrors = [];
      validateNode(value, child, path, childErrors, rootSchema);
      return childErrors.length === 0;
    });
    if (matches.length !== 1) errors.push(`${path}: debe coincidir con exactamente una variante oneOf.`);
  }

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    errors.push(`${path}: se esperaba ${JSON.stringify(schema.type)} y llegó ${actualType(value)}.`);
    return;
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      errors.push(`${path}: longitud menor que ${schema.minLength}.`);
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      errors.push(`${path}: longitud mayor que ${schema.maxLength}.`);
    }
    if (schema.pattern) {
      let pattern;
      try {
        pattern = new RegExp(schema.pattern);
      } catch {
        errors.push(`${path}: el schema contiene un patrón inválido.`);
        return;
      }
      if (!pattern.test(value)) errors.push(`${path}: no cumple el patrón requerido.`);
    }
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) {
      errors.push(`${path}: debe ser una fecha ISO date-time válida.`);
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: debe ser mayor o igual que ${schema.minimum}.`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: debe ser menor o igual que ${schema.maximum}.`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: requiere al menos ${schema.minItems} elementos.`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: admite como máximo ${schema.maxItems} elementos.`);
    }
    if (schema.uniqueItems) {
      const serialized = value.map((entry) => JSON.stringify(entry));
      if (new Set(serialized).size !== serialized.length) {
        errors.push(`${path}: contiene elementos duplicados.`);
      }
    }
    if (schema.items) {
      value.forEach((entry, index) => {
        validateNode(entry, schema.items, `${path}[${index}]`, errors, rootSchema);
      });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${path}.${key}: campo requerido ausente.`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validateNode(child, properties[key], `${path}.${key}`, errors, rootSchema);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: propiedad adicional no permitida.`);
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === 'object'
      ) {
        validateNode(child, schema.additionalProperties, `${path}.${key}`, errors, rootSchema);
      }
    }
  }
}

function validateSchema(value, schema) {
  const errors = [];
  validateNode(value, schema, '$', errors, schema);
  return { valid: errors.length === 0, errors };
}

function assertSchema(value, schema, label = 'JSON') {
  const result = validateSchema(value, schema);
  if (!result.valid) {
    throw new CoordinationError(
      `${label} no cumple el schema: ${result.errors.slice(0, 10).join(' ')}`,
      { code: 'SCHEMA_VALIDATION_FAILED' },
    );
  }
  return value;
}

async function loadSchema(filePath, maxBytes = 512 * 1024) {
  let content;
  try {
    content = await fs.readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new CoordinationError(`Falta el schema requerido: ${filePath}`, {
        code: 'SCHEMA_NOT_FOUND',
      });
    }
    throw error;
  }
  if (content.byteLength > maxBytes) {
    throw new CoordinationError(`El schema excede ${maxBytes} bytes: ${filePath}`, {
      code: 'SCHEMA_TOO_LARGE',
    });
  }
  try {
    return JSON.parse(content.toString('utf8'));
  } catch {
    throw new CoordinationError(`El schema no contiene JSON válido: ${filePath}`, {
      code: 'INVALID_SCHEMA_JSON',
    });
  }
}

module.exports = {
  assertSchema,
  loadSchema,
  validateSchema,
};
