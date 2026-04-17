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
        ${entries.map(([key, value]) => `${JSON.stringify(key)}: ${toJsHeaderValue(value)}`).join(',\n        ')}
      }`;
};

const toJsObject = (value: unknown): string => JSON.stringify(value ?? null, null, 2);

export class MochaFrameworkAdapter implements TestFrameworkAdapter {
  readonly framework = 'mocha' as const;

  render(tests: GeneratedTestCase[], projectMeta: ProjectMeta): GeneratedFile[] {
    const grouped = new Map<string, GeneratedTestCase[]>();
    const groupToPath = new Map<string, string>();

    for (const test of tests) {
      const pathMeta = getResourcePath(test.request.path);
      const key = `${pathMeta.resource}_${test.request.method.toLowerCase()}_${pathMeta.leaf}`;
      if (!grouped.has(key)) {
        grouped.set(key, []);
        groupToPath.set(key, `tests/${pathMeta.resource}/${test.request.method.toLowerCase()}-${pathMeta.leaf}.spec.js`);
      }
      grouped.get(key)?.push(test);
    }

    return [...grouped.entries()].map(([groupKey, cases]) => {
      const itBlocks = cases
        .map((testCase) => {
          const requestBody = JSON.stringify(testCase.request.body ?? null, null, 2);
          const requestQuery = JSON.stringify(testCase.request.query ?? {}, null, 2);
          const requestHeaders = toJsHeadersObject(testCase.request.headers ?? {});
          const responseHeaders = JSON.stringify(testCase.expected.responseHeaders ?? {}, null, 2);
          const jsonSchema = toJsObject(testCase.expected.jsonSchema ?? null);
          const contains = testCase.expected.contains?.length
            ? testCase.expected.contains
                .map((value) => `    expect(text).to.include(${JSON.stringify(value)});`)
                .join('\n')
            : '    // No content assertions provided';
          const contentType = testCase.expected.contentType
            ? `    expect(response.headers.get('content-type') || '').to.include(${JSON.stringify(testCase.expected.contentType)});`
            : '    // No content-type assertions provided';
          const headerChecks = Object.keys(testCase.expected.responseHeaders ?? {}).length
            ? `    for (const [key, value] of Object.entries(${responseHeaders})) {\n      expect(response.headers.get(key)).to.equal(value);\n    }`
            : '    // No response-header assertions provided';
          const schemaChecks = testCase.expected.jsonSchema
            ? `    const parsed = safeJsonParse(text);\n    assertSchemaShape(${jsonSchema}, parsed, 'response');`
            : '    // No schema assertions provided';
          const paginationCheck = testCase.expected.pagination
            ? `    const parsedForPagination = safeJsonParse(text);\n    expect(isPaginatedShape(parsedForPagination)).to.equal(true);`
            : '    // Pagination not asserted';
          const idempotencyCheck = testCase.expected.idempotent
            ? `    const repeat = await fetch(\`${'${BASE_URL}'}${testCase.request.path}${'${query ? `?${query}` : ""}'}\`, {\n      method: ${JSON.stringify(testCase.request.method)},\n      headers: {\n        'Content-Type': 'application/json',\n        ...${requestHeaders}\n      },\n      body: ${requestBody} !== null ? JSON.stringify(${requestBody}) : undefined\n    });\n    expect(repeat.status).to.be.lessThan(500);`
            : '    // Idempotency not asserted';

          return `  it(${JSON.stringify(testCase.title)}, async () => {
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

    expect(response.status).to.equal(${testCase.expected.status});
    const text = await response.text();
${contains}
${contentType}
${headerChecks}
${schemaChecks}
${paginationCheck}
${idempotencyCheck}
  });`;
        })
        .join('\n\n');

      return {
        path: groupToPath.get(groupKey) ?? `tests/${groupKey}.spec.js`,
        content: `/**
 * Generated by APItiser for ${projectMeta.repo.owner}/${projectMeta.repo.repo}
 * Set API_BASE_URL before running.
 * Replace placeholder auth values like Bearer {{API_TOKEN}} with real environment-backed credentials.
 */
const { expect } = require('chai');
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
  if (!schema) return;
  if (schema.type === 'array') {
    expect(Array.isArray(value)).to.equal(true);
    if (schema.items && Array.isArray(value) && value.length > 0) {
      assertSchemaShape(schema.items, value[0], ${'`${path}[0]`'});
    }
    return;
  }
  if (schema.type === 'object') {
    expect(value).to.be.an('object');
    for (const key of schema.required || []) {
      expect(value).to.have.property(key);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (value && Object.prototype.hasOwnProperty.call(value, key)) {
        assertSchemaShape(child, value[key], ${'`${path}.${key}`'});
      }
    }
    return;
  }
  if (schema.type === 'integer') {
    expect(Number.isInteger(value)).to.equal(true);
    return;
  }
  if (schema.type === 'number') {
    expect(value).to.be.a('number');
    return;
  }
  if (schema.type === 'boolean') {
    expect(value).to.be.a('boolean');
    return;
  }
  expect(value).to.be.a(schema.type || 'string');
};

describe(${JSON.stringify(groupKey)}, () => {
${itBlocks}
});
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
      content: `# APItiser Generated Mocha + Chai Tests

Generated at: ${projectMeta.generatedAt}
Repository: ${projectMeta.repo.owner}/${projectMeta.repo.repo}
Endpoints: ${projectMeta.endpointCount}
Readiness: ${projectMeta.readiness ?? 'review_required'}
${validationLine}

## Run

\`\`\`bash
npm install
export API_TOKEN=replace-me
API_BASE_URL=http://localhost:3000 npx mocha "tests/**/*.spec.js"
\`\`\`
${readinessNotes}`
    };
  }

  renderSupportFiles(_projectMeta?: ProjectMeta): GeneratedFile[] {
    return [
      {
        path: '.mocharc.json',
        content: `{\n  \"spec\": \"tests/**/*.spec.js\",\n  \"timeout\": 30000\n}\n`
      },
      {
        path: 'package.json',
        content: `{\n  \"name\": \"apitiser-generated-tests\",\n  \"private\": true,\n  \"scripts\": {\n    \"test\": \"mocha \\\"tests/**/*.spec.js\\\"\"\n  },\n  \"devDependencies\": {\n    \"chai\": \"^4.5.0\",\n    \"mocha\": \"^10.7.3\",\n    \"undici\": \"^7.16.0\"\n  }\n}\n`
      }
    ];
  }
}
