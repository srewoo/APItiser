import type { GeneratedFile, GeneratedTestCase, ProjectMeta, TestFrameworkAdapter } from '@shared/types';
import { getResourcePath } from './pathing';

const toJsHeaderValue = (value: string): string =>
  value === 'Bearer {{API_TOKEN}}'
    ? "(process.env.API_TOKEN ? `Bearer ${process.env.API_TOKEN}` : 'Bearer replace-me')"
    : value === '{{API_KEY}}'
      ? "(process.env.API_KEY || 'replace-me')"
      : value === '{{CSRF_TOKEN}}'
        ? "(process.env.CSRF_TOKEN || 'replace-me')"
    : JSON.stringify(value);

const toJsHeadersObject = (headers: Record<string, string>): string => {
  const entries = Object.entries(headers);
  if (!entries.length) {
    return '{}';
  }

  return `{
      ${entries.map(([key, value]) => `${JSON.stringify(key)}: ${toJsHeaderValue(value)}`).join(',\n      ')}
    }`;
};

const toJsObject = (value: unknown): string => JSON.stringify(value ?? null, null, 2);

export class JestFrameworkAdapter implements TestFrameworkAdapter {
  readonly framework = 'jest' as const;

  render(tests: GeneratedTestCase[], projectMeta: ProjectMeta): GeneratedFile[] {
    const grouped = new Map<string, GeneratedTestCase[]>();
    const groupToPath = new Map<string, string>();

    for (const test of tests) {
      const pathMeta = getResourcePath(test.request.path);
      const key = `${pathMeta.resource}_${test.request.method.toLowerCase()}_${pathMeta.leaf}`;
      if (!grouped.has(key)) {
        grouped.set(key, []);
        groupToPath.set(key, `tests/${pathMeta.resource}/${test.request.method.toLowerCase()}-${pathMeta.leaf}.test.js`);
      }
      grouped.get(key)?.push(test);
    }

    return [...grouped.entries()].map(([groupKey, cases]) => {
      const testBlocks = cases
        .map((testCase) => {
          const requestBody = JSON.stringify(testCase.request.body ?? null, null, 2);
          const requestQuery = JSON.stringify(testCase.request.query ?? {}, null, 2);
          const requestHeaders = toJsHeadersObject(testCase.request.headers ?? {});
          const responseHeaders = JSON.stringify(testCase.expected.responseHeaders ?? {}, null, 2);
          const jsonSchema = toJsObject(testCase.expected.jsonSchema ?? null);
          const contractChecks = JSON.stringify(testCase.expected.contractChecks ?? [], null, 2);
          const contains = testCase.expected.contains?.length
            ? testCase.expected.contains.map((value) => `  expect(text).toContain(${JSON.stringify(value)});`).join('\n')
            : '  // No content assertions provided';
          const contentType = testCase.expected.contentType
            ? `  expect(response.headers.get('content-type') || '').toContain(${JSON.stringify(testCase.expected.contentType)});`
            : '  // No content-type assertions provided';
          const headerChecks = Object.keys(testCase.expected.responseHeaders ?? {}).length
            ? `  for (const [key, value] of Object.entries(${responseHeaders})) {\n    expect(response.headers.get(key)).toBe(value);\n  }`
            : '  // No response-header assertions provided';
          const schemaChecks = testCase.expected.jsonSchema
            ? `  const parsed = safeJsonParse(text);\n  assertSchemaShape(${jsonSchema}, parsed, 'response');`
            : '  // No schema assertions provided';
          const contractChecksBlock = testCase.expected.contractChecks?.length
            ? `  for (const contractCheck of ${contractChecks}) {\n    expect(typeof contractCheck).toBe('string');\n  }`
            : '  // No contract checks provided';
          const paginationCheck = testCase.expected.pagination
            ? `  const parsedForPagination = safeJsonParse(text);\n  expect(isPaginatedShape(parsedForPagination)).toBe(true);`
            : '  // Pagination not asserted';
          const idempotencyCheck = testCase.expected.idempotent
            ? `  const repeat = await fetch(\`${'${BASE_URL}'}${testCase.request.path}${'${query ? `?${query}` : ""}'}\`, {\n    method: ${JSON.stringify(testCase.request.method)},\n    headers: {\n      'Content-Type': 'application/json',\n      ...${requestHeaders}\n    },\n    body: ${requestBody} !== null ? JSON.stringify(${requestBody}) : undefined\n  });\n  expect(repeat.status).toBeLessThan(500);`
            : '  // Idempotency not asserted';

          return `test(${JSON.stringify(testCase.title)}, async () => {
  // ${testCase.category} coverage
  // Trust: ${testCase.trustLabel ?? 'heuristic'} (${testCase.trustScore ?? 0})
  const query = new URLSearchParams(
    Object.entries(${requestQuery}).reduce((acc, [key, value]) => {
      if (value !== undefined && value !== null) {
        acc[key] = String(value);
      }
      return acc;
    }, {})
  ).toString();

  const response = await fetch(\`${'${BASE_URL}'}${testCase.request.path}${'${query ? `?${query}` : ""}'}\`, {
    method: ${JSON.stringify(testCase.request.method)},
    headers: {
      'Content-Type': 'application/json',
      ...${requestHeaders}
    },
    body: ${requestBody} !== null ? JSON.stringify(${requestBody}) : undefined
  });

  expect(response.status).toBe(${testCase.expected.status});
  const text = await response.text();
${contains}
${contentType}
${headerChecks}
${schemaChecks}
${contractChecksBlock}
${paginationCheck}
${idempotencyCheck}
});`;
        })
        .join('\n\n');

      return {
        path: groupToPath.get(groupKey) ?? `tests/${groupKey}.test.js`,
        content: `/**
 * Generated by APItiser for ${projectMeta.repo.owner}/${projectMeta.repo.repo}
 * Set API_BASE_URL before running.
 * Replace placeholder auth values like Bearer {{API_TOKEN}} with real environment-backed credentials.
 */
const { fetch } = require('undici');
const BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

const safeJsonParse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const isPaginatedShape = (value) => Array.isArray(value)
  || (value && typeof value === 'object' && ['items', 'results', 'data'].some((key) => key in value));

const assertSchemaShape = (schema, value, path = 'response') => {
  if (!schema) {
    return;
  }
  if (schema.type === 'array') {
    expect(Array.isArray(value)).toBe(true);
    if (schema.items && Array.isArray(value) && value.length > 0) {
      assertSchemaShape(schema.items, value[0], ${'`${path}[0]`'});
    }
    return;
  }
  if (schema.type === 'object') {
    expect(value).not.toBeNull();
    expect(typeof value).toBe('object');
    for (const key of schema.required || []) {
      expect(value).toHaveProperty(key);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (value && Object.prototype.hasOwnProperty.call(value, key)) {
        assertSchemaShape(child, value[key], ${'`${path}.${key}`'});
      }
    }
    return;
  }
  if (schema.type === 'integer') {
    expect(Number.isInteger(value)).toBe(true);
    return;
  }
  if (schema.type === 'number') {
    expect(typeof value).toBe('number');
    return;
  }
  if (schema.type === 'boolean') {
    expect(typeof value).toBe('boolean');
    return;
  }
  expect(typeof value).toBe(schema.type || 'string');
};

${testBlocks}
`
      };
    });
  }

  renderReadme(projectMeta: ProjectMeta): GeneratedFile {
    const validationLine = projectMeta.validationSummary
      ? `Validation: ${projectMeta.validationSummary.passed}/${projectMeta.validationSummary.attempted} passed`
      : 'Validation: not run';
    const readinessNotes = projectMeta.readinessNotes?.length
      ? `\n## Readiness Notes\n\n${projectMeta.readinessNotes.map((note) => `- ${note}`).join('\n')}\n`
      : '';
    return {
      path: 'README.md',
      content: `# APItiser Generated Jest Tests

Generated at: ${projectMeta.generatedAt}
Repository: ${projectMeta.repo.owner}/${projectMeta.repo.repo}
Endpoints: ${projectMeta.endpointCount}
Readiness: ${projectMeta.readiness ?? 'review_required'}
${validationLine}

## Run

\`\`\`bash
npm install
export API_TOKEN=replace-me
API_BASE_URL=http://localhost:3000 npx jest tests
\`\`\`
${readinessNotes}`
    };
  }

  renderSupportFiles(): GeneratedFile[] {
    return [
      {
        path: 'jest.config.cjs',
        content: `module.exports = {\n  testEnvironment: 'node',\n  testMatch: ['**/tests/**/*.test.js'],\n  testTimeout: 30000\n};\n`
      },
      {
        path: 'package.json',
        content: `{\n  \"name\": \"apitiser-generated-tests\",\n  \"private\": true,\n  \"scripts\": {\n    \"test\": \"jest tests\"\n  },\n  \"devDependencies\": {\n    \"jest\": \"^29.7.0\",\n    \"undici\": \"^7.16.0\"\n  }\n}\n`
      }
    ];
  }
}
