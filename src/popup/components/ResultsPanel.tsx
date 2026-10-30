import { useMemo, useState } from 'react';
import type { ApiEndpoint, AppliedCodeFix, ValidationResult, ValidationSummary } from '@shared/types';

interface ResultsPanelProps {
  summary?: ValidationSummary;
  endpoints: ApiEndpoint[];
  running: boolean;
  /** "Fix this test" — for failures where the test is wrong. */
  onFixTest?: (result: ValidationResult) => void;
  /** "Propose a code fix" — for likely bugs in the API. */
  onFixCode?: (result: ValidationResult) => void;
  /** The last applied code fix, with Undo. */
  codeFix?: AppliedCodeFix;
  onUndoCodeFix?: () => void;
}

interface EndpointGroup {
  endpointId: string;
  label: string;
  results: ValidationResult[];
  passed: number;
}

type Filter = 'all' | 'failed' | 'bugs';

const groupResults = (results: ValidationResult[], endpoints: ApiEndpoint[]): EndpointGroup[] => {
  const byId = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const groups = new Map<string, EndpointGroup>();
  for (const result of results) {
    let group = groups.get(result.endpointId);
    if (!group) {
      const endpoint = byId.get(result.endpointId);
      group = {
        endpointId: result.endpointId,
        label: endpoint ? `${endpoint.method} ${endpoint.path}` : result.endpointId,
        results: [],
        passed: 0
      };
      groups.set(result.endpointId, group);
    }
    group.results.push(result);
    if (result.success) group.passed += 1;
  }
  // Failing endpoints first — that's what the user came to look at.
  return [...groups.values()].sort((a, b) => (a.passed === a.results.length ? 1 : 0) - (b.passed === b.results.length ? 1 : 0));
};

const VERDICT_LABEL = { api: 'Likely API bug', test: 'Test needs fixing', missing: 'Route not found' } as const;

function ResultRow({ result, onFixTest, onFixCode }: { result: ValidationResult } & Pick<ResultsPanelProps, 'onFixTest' | 'onFixCode'>) {
  return (
    <details className={`result-row ${result.success ? 'pass' : 'fail'}`} open={!result.success}>
      <summary>
        <span aria-label={result.success ? 'passed' : 'failed'}>{result.success ? '✓' : '✗'}</span>
        <span className="result-title">
          {result.title}
          {result.verdict ? <em className={`verdict verdict-${result.verdict}`}>{VERDICT_LABEL[result.verdict]}</em> : null}
        </span>
        <span className="result-meta">
          {result.status ?? '—'} · {result.durationMs} ms
        </span>
      </summary>
      <div className="result-body">
        {result.verdictReason ? <p className={`verdict-reason verdict-${result.verdict}`}>{result.verdictReason}</p> : null}
        {result.method ? <p><code>{result.method} {result.path}</code></p> : null}
        {result.category ? <p className="subtle">Category: {result.category}</p> : null}
        {result.failures.map((failure, index) => (
          <p key={`${failure.type}-${index}`} className="result-failure">
            <strong>{failure.type}</strong>: {failure.message}
          </p>
        ))}
        {result.responseSnippet ? <pre className="result-snippet">{result.responseSnippet}</pre> : null}
        {result.verdict === 'test' && onFixTest ? (
          <button type="button" className="ghost endpoint-control-btn" onClick={() => onFixTest(result)}>
            Fix this test…
          </button>
        ) : null}
        {result.verdict === 'api' && onFixCode ? (
          <button type="button" className="ghost endpoint-control-btn" onClick={() => onFixCode(result)}>
            Propose a code fix…
          </button>
        ) : null}
      </div>
    </details>
  );
}

export function ResultsPanel({ summary, endpoints, running, onFixTest, onFixCode, codeFix, onUndoCodeFix }: ResultsPanelProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const groups = useMemo(() => groupResults(summary?.results ?? [], endpoints), [summary?.results, endpoints]);
  const bugs = summary?.results.filter((result) => result.verdict === 'api').length ?? 0;
  const testFixes = summary?.results.filter((result) => result.verdict === 'test').length ?? 0;
  // Counted per endpoint: one missing route is one problem, however many tests hit it.
  const missingRoutes = new Set(summary?.results.filter((result) => result.verdict === 'missing').map((result) => result.endpointId)).size;
  const visible = groups
    .map((group) =>
      filter === 'bugs' ? { ...group, results: group.results.filter((result) => result.verdict === 'api') } : group
    )
    .filter((group) => (filter === 'all' ? true : filter === 'bugs' ? group.results.length > 0 : group.passed < group.results.length));

  if (!summary || (!summary.results.length && !summary.notRunReason && !running)) {
    return null;
  }

  const chip = (value: Filter, label: string) => (
    <button type="button" className={`chip ${filter === value ? 'active' : ''}`} aria-pressed={filter === value} onClick={() => setFilter(value)}>
      {label}
    </button>
  );

  return (
    <section className="panel results-panel" aria-live="polite">
      <h2>Live Results</h2>
      <p className="subtle">
        {running ? 'Running… ' : ''}
        {summary.passed}/{summary.attempted} passed
        {summary.failed ? ` · ${summary.failed} failed` : ''}
        {summary.skipped ? ` · ${summary.skipped} skipped` : ''}
        {summary.targetBaseUrl ? <> · <code>{summary.targetBaseUrl}</code></> : null}
      </p>
      {bugs || testFixes || missingRoutes ? (
        <p className="verdict-summary">
          {bugs ? <span className="verdict verdict-api">{bugs} likely API bug{bugs === 1 ? '' : 's'}</span> : null}
          {testFixes ? <span className="verdict verdict-test">{testFixes} test{testFixes === 1 ? '' : 's'} need fixing</span> : null}
          {missingRoutes ? (
            <span className="verdict verdict-missing">
              {missingRoutes} route{missingRoutes === 1 ? '' : 's'} not found on the API
            </span>
          ) : null}
        </p>
      ) : null}
      {codeFix ? (
        <p className="code-fix-applied">
          Code fix applied to <code>{codeFix.files.join(', ')}</code>
          {codeFix.explanation ? ` — ${codeFix.explanation}` : ''}{' '}
          {onUndoCodeFix ? (
            <button type="button" className="link-btn" onClick={onUndoCodeFix}>
              Undo
            </button>
          ) : null}
        </p>
      ) : null}
      {summary.notRunReason ? <p className="run-warning">{summary.notRunReason}</p> : null}
      {(summary.warnings ?? []).slice(0, 2).map((warning) => (
        <p key={warning} className="subtle">{warning}</p>
      ))}
      {groups.length ? (
        <div className="filter-pills">
          {chip('all', 'All')}
          {chip('failed', 'Failed')}
          {bugs ? chip('bugs', 'Likely bugs') : null}
        </div>
      ) : null}
      <div className="results-list">
        {visible.map((group) => (
          <details key={group.endpointId} className="result-group" open={group.passed < group.results.length}>
            <summary>
              <code>{group.label}</code>
              <span className={`result-count ${group.passed === group.results.length ? 'pass' : 'fail'}`}>
                {group.passed}/{group.results.length}
              </span>
            </summary>
            {group.results.map((result, index) => (
              <ResultRow key={`${result.title}-${index}`} result={result} onFixTest={onFixTest} onFixCode={onFixCode} />
            ))}
          </details>
        ))}
      </div>
    </section>
  );
}
