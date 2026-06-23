import type { GeneratedFile, GeneratedTestCase, ProjectMeta, TestFrameworkAdapter } from '@shared/types';
import { getResourcePath } from './pathing';
import { renderStatusAssertionPy } from '../statusExpectation';
import { pyPathExpr, identityHeaders } from './runtimeTokens';
import { PY_RUNTIME_HELPERS, renderBodyAssertionsPy } from './assertions';

const toPyObject = (value: unknown): string => {
  return JSON.stringify(value ?? null, null, 2)
    .replace(/\btrue\b/g, 'True')
    .replace(/\bfalse\b/g, 'False')
    .replace(/\bnull\b/g, 'None');
};

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

// Convert a header value into valid Python. Any `{{NAME}}` placeholder is resolved
// from the environment at runtime so generated suites never send a literal
// "{{token}}" string. Values without placeholders become plain string literals.
const toPyHeaderValue = (value: string): string => {
  if (!PLACEHOLDER_RE.test(value)) {
    return JSON.stringify(value);
  }
  PLACEHOLDER_RE.lastIndex = 0;

  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  let out = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  // Escape any literal braces (not part of a placeholder) so the f-string is valid.
  const escapeBraces = (segment: string): string => segment.replace(/\{/g, '{{').replace(/\}/g, '}}');
  while ((match = PLACEHOLDER_RE.exec(escaped)) !== null) {
    out += escapeBraces(escaped.slice(lastIndex, match.index));
    out += `{os.getenv('${match[1]}', 'replace-me')}`;
    lastIndex = match.index + match[0].length;
  }
  out += escapeBraces(escaped.slice(lastIndex));
  return `f"${out}"`;
};

// Python identifiers allow only [A-Za-z0-9_]; collapse everything else so generated
// function names (derived from URL paths) are always syntactically valid.
const pySafeIdentifier = (value: string): string =>
  value
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'test';

// Build a Python URL expression for a path. Concatenation (not an f-string) avoids
// brace-bearing paths like /users/{id} being interpreted as f-string fields, and any
// {{NAME}} runtime placeholder is rendered as an os.getenv(...) read so real ids can be
// injected via environment variables.
const toPyUrl = (path: string): string => pyPathExpr(path, (literal) => JSON.stringify(literal));

const toPyHeaders = (headers: Record<string, string>): string => {
  const entries = Object.entries(headers);
  if (!entries.length) {
    return '{}';
  }

  return `{
        ${entries.map(([key, value]) => `${JSON.stringify(key)}: ${toPyHeaderValue(value)}`).join(',\n        ')}
    }`;
};

export class PytestFrameworkAdapter implements TestFrameworkAdapter {
  readonly framework = 'pytest' as const;

  render(tests: GeneratedTestCase[], projectMeta: ProjectMeta): GeneratedFile[] {
    const grouped = new Map<string, GeneratedTestCase[]>();
    const groupToPath = new Map<string, string>();

    for (const test of tests) {
      const pathMeta = getResourcePath(test.request.path);
      const key = `${pathMeta.resource}_${test.request.method.toLowerCase()}_${pathMeta.leaf}`;
      if (!grouped.has(key)) {
        grouped.set(key, []);
        groupToPath.set(
          key,
          `tests/${pathMeta.resource}/test_${test.request.method.toLowerCase()}_${pathMeta.leaf}.py`
        );
      }
      grouped.get(key)?.push(test);
    }

    return [...grouped.entries()].map(([groupKey, cases]) => {
      const fnBlocks = cases
        .map((testCase, index) => {
          const fnName = pySafeIdentifier(`test_${groupKey}_${index + 1}`);
          const responseHeaders = toPyObject(testCase.expected.responseHeaders ?? {});
          const jsonSchema = toPyObject(testCase.expected.jsonSchema ?? null);
          // Contract checks are free-text expectations (e.g. "auth boundary enforced") that
          // cannot be auto-asserted; render them as documented expectations rather than a
          // tautological `isinstance(check, str)` assertion that verifies nothing.
          const headers = identityHeaders(testCase);
          const contains = testCase.expected.contains?.length
            ? testCase.expected.contains
                .map((value) => `    assert ${JSON.stringify(value)} in response.text`)
                .join('\n')
            : '    # No content assertions provided';
          const contentType = testCase.expected.contentType
            ? `    assert ${JSON.stringify(testCase.expected.contentType)} in (response.headers.get('Content-Type') or '')`
            : '    # No content-type assertions provided';
          const headerChecks = Object.keys(testCase.expected.responseHeaders ?? {}).length
            ? `    for key, value in ${responseHeaders}.items():\n        assert response.headers.get(key) == value`
            : '    # No response-header assertions provided';
          const schemaChecks = testCase.expected.jsonSchema
            ? `    assert_schema_shape(${jsonSchema}, body, 'response')`
            : '    # No schema assertions provided';
          const bodyAssertions = renderBodyAssertionsPy(testCase, 'body', '    ');
          const paginationCheck = testCase.expected.pagination
            ? `    assert is_paginated_shape(body)`
            : '    # Pagination not asserted';
          const idempotencyCheck = testCase.expected.idempotent
            ? `    repeat = request_with_retry(\n        method=${JSON.stringify(testCase.request.method)},\n        url=${toPyUrl(testCase.request.path)},\n        headers=${toPyHeaders(headers)},\n        params=${toPyObject(testCase.request.query ?? {})},\n        json=${toPyObject(testCase.request.body ?? null)}\n    )\n    assert_idempotent(response, repeat)`
            : '    # Idempotency not asserted';

          return `def ${fnName}():
    # ${testCase.category} coverage — identity: ${testCase.request.identity ?? 'primary'}
    # Trust: ${testCase.trustLabel ?? 'heuristic'} (${testCase.trustScore ?? 0})
    response = request_with_retry(
        method=${JSON.stringify(testCase.request.method)},
        url=${toPyUrl(testCase.request.path)},
        headers=${toPyHeaders(headers)},
        params=${toPyObject(testCase.request.query ?? {})},
        json=${toPyObject(testCase.request.body ?? null)}
    )
    body = safe_json(response)
${renderStatusAssertionPy(testCase, 'response.status_code', '    ')}
${contains}
${contentType}
${headerChecks}
${schemaChecks}
${bodyAssertions}
${paginationCheck}
${idempotencyCheck}
`;
        })
        .join('\n');

      return {
        path: groupToPath.get(groupKey) ?? `tests/test_${groupKey}.py`,
        content: `"""Generated by APItiser for ${projectMeta.repo.owner}/${projectMeta.repo.repo}

Set API_BASE_URL before running.
Replace placeholder auth values like Bearer {{API_TOKEN}} with real environment-backed credentials.
"""

import os
import requests

BASE_URL = os.getenv('API_BASE_URL', 'http://localhost:3000')

def safe_json(response):
    try:
        return response.json()
    except Exception:
        return None

${PY_RUNTIME_HELPERS}

${fnBlocks}
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
      content: `# APItiser Generated Pytest Suite

Generated at: ${projectMeta.generatedAt}
Repository: ${projectMeta.repo.owner}/${projectMeta.repo.repo}
Endpoints: ${projectMeta.endpointCount}
Readiness: ${projectMeta.readiness ?? 'review_required'}
${validationLine}

## Run

\`\`\`bash
pip install requests pytest
export API_TOKEN=replace-me
API_BASE_URL=http://localhost:3000 pytest tests
\`\`\`
${readinessNotes}`
    };
  }

  renderSupportFiles(_projectMeta?: ProjectMeta): GeneratedFile[] {
    return [
      {
        path: 'requirements.txt',
        content: `pytest>=8.0.0\nrequests>=2.32.0\n`
      },
      {
        path: 'pytest.ini',
        content: `[pytest]\ntestpaths = tests\n`
      }
    ];
  }
}
