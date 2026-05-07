import type { GeneratedFile, GeneratedTestCase, ProjectMeta, TestFrameworkAdapter } from '@shared/types';
import { getResourcePath } from './pathing';

const escapeBackticks = (value: string): string => value.replace(/`/g, '` + "`" + `');

const toGoString = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const headerValueExpr = (value: string): string => {
  if (value === 'Bearer {{API_TOKEN}}') {
    return `"Bearer " + getEnv("API_TOKEN", "replace-me")`;
  }
  if (value === '{{API_KEY}}') {
    return `getEnv("API_KEY", "replace-me")`;
  }
  if (value === '{{CSRF_TOKEN}}') {
    return `getEnv("CSRF_TOKEN", "replace-me")`;
  }
  return toGoString(value);
};

const renderHeaders = (headers: Record<string, string>): string => {
  const entries = Object.entries(headers);
  if (!entries.length) {
    return '';
  }
  return entries.map(([k, v]) => `\treq.Header.Set(${toGoString(k)}, ${headerValueExpr(v)})`).join('\n');
};

const renderQuery = (query: Record<string, unknown>): string => {
  const entries = Object.entries(query ?? {});
  if (!entries.length) {
    return '';
  }
  const lines = entries.map(
    ([k, v]) => `\tq.Set(${toGoString(k)}, fmt.Sprint(${JSON.stringify(v ?? '')}))`
  );
  return `\tq := req.URL.Query()\n${lines.join('\n')}\n\treq.URL.RawQuery = q.Encode()`;
};

const goSafeName = (value: string): string =>
  value
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[0-9]/, (m) => `t${m}`) || 'Test';

export class GoTestFrameworkAdapter implements TestFrameworkAdapter {
  readonly framework = 'gotest' as const;

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
          `tests/${pathMeta.resource}/${test.request.method.toLowerCase()}_${pathMeta.leaf}_test.go`
        );
      }
      grouped.get(key)?.push(test);
    }

    return [...grouped.entries()].map(([groupKey, cases]) => {
      const fnBlocks = cases
        .map((testCase, index) => {
          const fnName = `Test_${goSafeName(groupKey)}_${index + 1}`;
          const bodyVar =
            testCase.request.body !== undefined && testCase.request.body !== null
              ? `bodyBytes := []byte(\`${escapeBackticks(JSON.stringify(testCase.request.body))}\`)\n\tbodyReader := bytes.NewReader(bodyBytes)`
              : `var bodyReader io.Reader = nil`;
          const headers = renderHeaders(testCase.request.headers ?? {});
          const queryBlock = renderQuery((testCase.request.query as Record<string, unknown>) ?? {});
          const containsAsserts = (testCase.expected.contains ?? [])
            .map(
              (s) =>
                `\tif !strings.Contains(string(respBody), ${toGoString(s)}) {\n\t\tt.Errorf("expected response to contain %q", ${toGoString(s)})\n\t}`
            )
            .join('\n');
          const ctAssert = testCase.expected.contentType
            ? `\tif ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, ${toGoString(testCase.expected.contentType)}) {\n\t\tt.Errorf("unexpected content-type: %s", ct)\n\t}`
            : '';
          const headerAsserts = Object.entries(testCase.expected.responseHeaders ?? {})
            .map(
              ([k, v]) =>
                `\tif got := resp.Header.Get(${toGoString(k)}); got != ${toGoString(v)} {\n\t\tt.Errorf("header %s = %q, want %q", ${toGoString(k)}, got, ${toGoString(v)})\n\t}`
            )
            .join('\n');

          return `func ${fnName}(t *testing.T) {
\t// ${testCase.category} coverage — trust: ${testCase.trustLabel ?? 'heuristic'} (${testCase.trustScore ?? 0})
\tbaseURL := getEnv("API_BASE_URL", "http://localhost:3000")
\t${bodyVar}
\treq, err := http.NewRequest(${toGoString(testCase.request.method)}, baseURL + ${toGoString(testCase.request.path)}, bodyReader)
\tif err != nil { t.Fatalf("build request: %v", err) }
\treq.Header.Set("Content-Type", "application/json")
${headers}
${queryBlock}
\tclient := &http.Client{Timeout: 30 * time.Second}
\tresp, err := client.Do(req)
\tif err != nil { t.Fatalf("do request: %v", err) }
\tdefer resp.Body.Close()
\trespBody, _ := io.ReadAll(resp.Body)
\tif resp.StatusCode != ${testCase.expected.status} {
\t\tt.Errorf("status = %d, want ${testCase.expected.status}; body=%s", resp.StatusCode, string(respBody))
\t}
${ctAssert}
${headerAsserts}
${containsAsserts}
}`;
        })
        .join('\n\n');

      const pkgName = goSafeName(groupKey).toLowerCase().slice(0, 40) || 'apitests';

      return {
        path: groupToPath.get(groupKey) ?? `tests/${groupKey}_test.go`,
        content: `// Generated by APItiser for ${projectMeta.repo.owner}/${projectMeta.repo.repo}
// Set API_BASE_URL and any auth env vars before running: go test ./...
package ${pkgName}

import (
\t"bytes"
\t"fmt"
\t"io"
\t"net/http"
\t"os"
\t"strings"
\t"testing"
\t"time"
)

func getEnv(key, def string) string {
\tif v := os.Getenv(key); v != "" { return v }
\treturn def
}

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
      ? `\n## Readiness Notes\n\n${projectMeta.readinessNotes.map((n) => `- ${n}`).join('\n')}\n`
      : '';
    return {
      path: 'README.md',
      content: `# APItiser Generated Go Tests

Generated at: ${projectMeta.generatedAt}
Repository: ${projectMeta.repo.owner}/${projectMeta.repo.repo}
Endpoints: ${projectMeta.endpointCount}
Readiness: ${projectMeta.readiness ?? 'review_required'}
${validationLine}

## Run

\`\`\`bash
export API_TOKEN=replace-me
API_BASE_URL=http://localhost:3000 go test ./tests/...
\`\`\`
${readinessNotes}`
    };
  }

  renderSupportFiles(projectMeta?: ProjectMeta): GeneratedFile[] {
    const mod = (projectMeta?.repo.repo ?? 'apitiser-generated-tests').replace(/[^a-zA-Z0-9_-]/g, '-');
    return [
      {
        path: 'go.mod',
        content: `module github.com/apitiser/${mod}\n\ngo 1.21\n`
      }
    ];
  }
}
