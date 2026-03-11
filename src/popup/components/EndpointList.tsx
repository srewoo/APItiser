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
}

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
}: EndpointListProps) {
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
