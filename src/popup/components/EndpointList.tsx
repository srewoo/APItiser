import type { ApiEndpoint, JobState } from '@shared/types';

interface EndpointListProps {
  endpoints: ApiEndpoint[];
  selectedEndpointSet: Set<string>;
  existingCoveredSet: Set<string>;
  selectedEndpointCount: number;
  selectedEligibleCount: number;
  skipExistingEnabled: boolean;
  busy: boolean;
  groupBy?: 'method' | 'source' | 'none';
  methodFilter: string;
  onMethodFilterChange: (method: string) => void;
  onEndpointToggle: (endpointId: string, checked: boolean) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  activeOrLatestJob: JobState | null;
  /** Per-endpoint run; omitted when there is nothing to run against. */
  onRunEndpoint?: (endpointId: string) => void;
  runDisabled?: boolean;
}

interface EndpointRunInfo {
  tests: number;
  passed: number;
  ran: number;
}

const buildRunInfo = (job: JobState | null): Map<string, EndpointRunInfo> => {
  const info = new Map<string, EndpointRunInfo>();
  const entry = (id: string): EndpointRunInfo => {
    const existing = info.get(id) ?? { tests: 0, passed: 0, ran: 0 };
    info.set(id, existing);
    return existing;
  };
  for (const test of job?.generatedTests ?? []) entry(test.endpointId).tests += 1;
  for (const result of job?.validationSummary?.results ?? []) {
    const item = entry(result.endpointId);
    item.ran += 1;
    if (result.success) item.passed += 1;
  }
  return info;
};

const METHODS = ['ALL', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function EndpointList({
  endpoints,
  selectedEndpointSet,
  existingCoveredSet,
  selectedEndpointCount,
  selectedEligibleCount,
  skipExistingEnabled,
  busy,
  methodFilter,
  onMethodFilterChange,
  onEndpointToggle,
  onSelectAll,
  onClearAll,
  activeOrLatestJob,
  onRunEndpoint,
  runDisabled,
}: EndpointListProps) {
  const runInfo = buildRunInfo(activeOrLatestJob);
  const activeRun = activeOrLatestJob?.endpointRun;
  const runningIds = new Set(activeRun?.endpointIds ?? []);
  const filteredEndpoints = methodFilter === 'ALL'
    ? endpoints
    : endpoints.filter((ep) => ep.method === methodFilter);

  return (
    <section className="panel">
      <h2>Detected Endpoints</h2>
      <p className="subtle">{activeOrLatestJob?.totalEndpoints ?? 0} APIs found</p>
      <p className="subtle">
        {activeOrLatestJob?.existingTestEndpointIds?.length ?? 0} already tested •{' '}
        {activeOrLatestJob?.eligibleEndpointCount ?? activeOrLatestJob?.totalEndpoints ?? 0} to generate
      </p>
      {endpoints.length ? (
        <>
          {/* Method filter pills */}
          <div className="filter-pills">
            {METHODS.map((method) => (
              <button
                key={method}
                type="button"
                aria-pressed={methodFilter === method}
                className={`chip ${methodFilter === method ? 'active' : ''}`}
                onClick={() => onMethodFilterChange(method)}
              >
                {method}
              </button>
            ))}
          </div>
          <div className="endpoint-controls">
            <p className="subtle">
              {selectedEndpointCount} selected • {selectedEligibleCount} selected for generation
            </p>
            <div className="endpoint-control-actions">
              <button type="button" className="ghost endpoint-control-btn" onClick={onSelectAll} disabled={busy}>
                Select All
              </button>
              <button type="button" className="ghost endpoint-control-btn" onClick={onClearAll} disabled={busy}>
                Clear All
              </button>
            </div>
          </div>
          <div className="endpoint-list endpoint-list-scroll">
            {filteredEndpoints.map((endpoint) => {
              const blockedBySkip = skipExistingEnabled && existingCoveredSet.has(endpoint.id);
              const checked = selectedEndpointSet.has(endpoint.id) && !blockedBySkip;
              const info = runInfo.get(endpoint.id);
              return (
                <label key={endpoint.id} className={`endpoint-row ${checked ? 'checked' : 'unchecked'}`}>
                  <input
                    className="endpoint-checkbox"
                    type="checkbox"
                    checked={checked}
                    disabled={busy || blockedBySkip}
                    onChange={(event) => onEndpointToggle(endpoint.id, event.target.checked)}
                  />
                  <code>{endpoint.method}</code>
                  <div className="endpoint-label">
                    <span>{endpoint.path}</span>
                    {endpoint.evidence?.[0]?.filePath ? (
                      <span className="endpoint-source" title={endpoint.evidence[0].filePath}>
                        {endpoint.evidence[0].filePath.split('/').pop()}
                      </span>
                    ) : null}
                  </div>
                  <div className="endpoint-badges">
                    {endpoint.confidence ? (
                      <em
                        className="endpoint-tag"
                        title={endpoint.evidence?.[0]?.reason ? `Evidence: ${endpoint.evidence[0].reason}` : 'Detection confidence'}
                      >
                        {Math.round(endpoint.confidence * 100)}% conf
                      </em>
                    ) : null}
                    {endpoint.trustLabel ? (
                      <em className="endpoint-tag" title={`Trust score ${endpoint.trustScore ?? 0}`}>
                        {endpoint.trustLabel}
                      </em>
                    ) : null}
                    {existingCoveredSet.has(endpoint.id) ? <em className="endpoint-tag">existing test</em> : null}
                    {info?.ran ? (
                      <em
                        className={`run-badge ${info.passed === info.ran ? 'pass' : 'fail'}`}
                        title="Live results: passed / run"
                      >
                        {info.passed}/{info.ran}
                      </em>
                    ) : null}
                    {onRunEndpoint && info?.tests ? (
                      <button
                        type="button"
                        className="ghost run-endpoint-btn"
                        aria-label={`Run tests for ${endpoint.method} ${endpoint.path}`}
                        title={`Run ${info.tests} test(s)`}
                        disabled={runDisabled || Boolean(activeRun)}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onRunEndpoint(endpoint.id);
                        }}
                      >
                        {runningIds.has(endpoint.id) ? '…' : '▶'}
                      </button>
                    ) : null}
                  </div>
                </label>
              );
            })}
          </div>
        </>
      ) : (
        <p className="subtle">No endpoints yet. Run Scan Repo to populate this list.</p>
      )}
    </section>
  );
}
