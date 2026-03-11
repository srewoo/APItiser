import type { ApiEndpoint, GeneratedTestCase } from '@shared/types';

const formatRequest = (test: GeneratedTestCase, endpoint: ApiEndpoint): string => {
  const lines: string[] = [
    `# ${test.title}`,
    `# Category: ${test.category}`,
    ``,
    `${test.request.method} ${test.request.path}`,
  ];

  if (test.request.headers && Object.keys(test.request.headers).length) {
    for (const [key, value] of Object.entries(test.request.headers)) {
      lines.push(`${key}: ${value}`);
    }
  }

  if (test.request.query && Object.keys(test.request.query).length) {
    lines.push(`# Query: ${JSON.stringify(test.request.query)}`);
  }

  if (test.request.body !== undefined && test.request.body !== null) {
    lines.push(``, `Body: ${JSON.stringify(test.request.body, null, 2)}`);
  }

  lines.push(``, `# Expected Status: ${test.expected.status}`);
  if (test.expected.contains?.length) {
    lines.push(`# Expected Contains: ${test.expected.contains.join(', ')}`);
  }
  lines.push(`# Endpoint: ${endpoint.method} ${endpoint.path}`);

  return lines.join('\n');
};

interface TestPreviewModalProps {
  tests: GeneratedTestCase[];
  endpoints: ApiEndpoint[];
  onClose: () => void;
}

const copyToClipboard = async (text: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // fallback
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
  }
};

export function TestPreviewModal({ tests, endpoints, onClose }: TestPreviewModalProps) {
  const endpointsById = new Map(endpoints.map((ep) => [ep.id, ep]));
  const grouped = new Map<string, GeneratedTestCase[]>();

  for (const test of tests) {
    const existing = grouped.get(test.endpointId) ?? [];
    existing.push(test);
    grouped.set(test.endpointId, existing);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="panel settings-panel modal-panel preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Test Preview"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Test Preview ({tests.length} tests)</h2>
          <button type="button" className="ghost modal-close" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="preview-list">
          {[...grouped.entries()].map(([endpointId, endpointTests]) => {
            const endpoint = endpointsById.get(endpointId);
            if (!endpoint) return null;
            return (
              <div key={endpointId} className="preview-group">
                <h3 className="preview-endpoint">
                  <code>{endpoint.method}</code> {endpoint.path}
                </h3>
                {endpointTests.map((test, idx) => {
                  const code = formatRequest(test, endpoint);
                  return (
                    <div key={`${endpointId}-${idx}`} className={`preview-card category-${test.category}`}>
                      <div className="preview-card-header">
                        <span className="preview-title">{test.title}</span>
                        <span className={`chip active category-chip-${test.category}`}>{test.category}</span>
                        <button
                          type="button"
                          className="ghost copy-btn"
                          onClick={() => void copyToClipboard(code)}
                          title="Copy test to clipboard"
                        >
                          Copy
                        </button>
                      </div>
                      <pre className="preview-code">{code}</pre>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
