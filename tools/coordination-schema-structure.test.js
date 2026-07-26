'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { before, test } = require('node:test');

const {
  loadSchema,
  validateSchema,
} = require('./coordination/schema-validator');
const {
  normalizeSchemaForStructuredOutputs,
} = require('./coordination/openai-client');
const {
  AUDITABLE_VISUAL_CATEGORIES,
} = require('./coordination/visual-contract');

const OUTPUT_SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '.coordination',
  'coordinator-output-v2.schema.json',
);
let outputSchema;

before(async () => {
  outputSchema = await loadSchema(OUTPUT_SCHEMA_PATH);
});

function findArraySchemasWithoutItems(schema, schemaPath = '$', visited = new Set()) {
  if (!schema || typeof schema !== 'object') return [];
  if (visited.has(schema)) return [];
  visited.add(schema);

  const errors = [];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const usesArrayKeywords = ['minItems', 'maxItems', 'uniqueItems'].some(
    (keyword) => Object.prototype.hasOwnProperty.call(schema, keyword),
  );
  if (
    (types.includes('array') || usesArrayKeywords) &&
    !Object.prototype.hasOwnProperty.call(schema, 'items')
  ) {
    errors.push(schemaPath);
  }

  if (Array.isArray(schema)) {
    schema.forEach((entry, index) => {
      errors.push(...findArraySchemasWithoutItems(
        entry,
        `${schemaPath}[${index}]`,
        visited,
      ));
    });
    return errors;
  }

  for (const [key, value] of Object.entries(schema)) {
    if (!value || typeof value !== 'object') continue;
    errors.push(...findArraySchemasWithoutItems(
      value,
      `${schemaPath}.${key}`,
      visited,
    ));
  }
  return errors;
}

function categoryAuditSchema() {
  return {
    ...outputSchema.properties.visualReview.properties.categoryAudit,
    $defs: outputSchema.$defs,
  };
}

function makeVisualCategoryAudit() {
  return AUDITABLE_VISUAL_CATEGORIES.map((category, index) => ({
    category,
    status: index < 4 ? 'present' : 'absent',
    description: index < 4
      ? `Se observa evidencia inequívoca para la categoría ${category}.`
      : `No se observa evidencia suficiente para la categoría ${category}.`,
    evidence: index < 4
      ? `El panel sintético contiene un elemento visible asociado a ${category}.`
      : null,
    severity: index < 4 ? 'medium' : null,
  }));
}

test('coordinator output schema has items for every array node recursively', () => {
  assert.deepEqual(findArraySchemasWithoutItems(outputSchema), []);
  assert.deepEqual(
    findArraySchemasWithoutItems(
      normalizeSchemaForStructuredOutputs(outputSchema),
    ),
    [],
  );
});

test('visual categoryAudit accepts the ten canonical category entries', () => {
  const categoryAudit = makeVisualCategoryAudit();
  const result = validateSchema(categoryAudit, categoryAuditSchema());

  assert.equal(categoryAudit.length, 10);
  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('non-visual categoryAudit accepts the canonical empty array', () => {
  const result = validateSchema([], categoryAuditSchema());

  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('recursive array-schema check reports a nested synthetic array without items', () => {
  const invalidSchema = {
    type: 'object',
    properties: {
      validList: {
        type: 'array',
        items: { type: 'string' },
      },
      nestedVariant: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            properties: {
              invalidList: {
                type: 'array',
              },
            },
          },
        ],
      },
      incompleteEmptyArrayVariant: {
        anyOf: [
          { maxItems: 0 },
          {
            type: 'array',
            items: { type: 'string' },
            minItems: 10,
            maxItems: 10,
          },
        ],
      },
    },
  };

  assert.deepEqual(
    findArraySchemasWithoutItems(invalidSchema),
    [
      '$.properties.nestedVariant.anyOf[1].properties.invalidList',
      '$.properties.incompleteEmptyArrayVariant.anyOf[0]',
    ],
  );
});
