import type { JobState, RunMetric } from '@shared/types';

const formatMs = (value?: number): string => {
  if (!value && value !== 0) return '—';
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(1)} s`;
};

interface CoveragePanelProps {
  activeOrLatestJob: JobState | null;
}

export function CoveragePanel({ activeOrLatestJob }: CoveragePanelProps) {
  return (
    <section className="panel">
      <h2>Coverage Snapshot</h2>
      <div className="coverage-grid">
        <article>
          <p>Endpoints</p>
          <strong>{activeOrLatestJob?.coverage?.endpointsDetected ?? activeOrLatestJob?.totalEndpoints ?? 0}</strong>
        </article>
        <article>
          <p>Tests</p>
          <strong>{activeOrLatestJob?.coverage?.testsGenerated ?? activeOrLatestJob?.generatedTests.length ?? 0}</strong>
        </article>
        <article>
          <p>Coverage</p>
          <strong>{activeOrLatestJob?.coverage?.coveragePercent ?? 0}%</strong>
        </article>
      </div>
      <div className="gap-list">
        {(activeOrLatestJob?.coverage?.gaps ?? []).slice(0, 3).map((gap) => (
          <p key={gap}>{gap}</p>
        ))}
      </div>
    </section>
  );
}

interface PerformancePanelProps {
  latestMetric: RunMetric | undefined;
}

export function PerformancePanel({ latestMetric }: PerformancePanelProps) {
  return (
    <section className="panel">
      <h2>Performance</h2>
      <div className="coverage-grid">
        <article>
          <p>Scan Time</p>
          <strong>{formatMs(latestMetric?.scanMs)}</strong>
        </article>
        <article>
          <p>Generation Time</p>
          <strong>{formatMs(latestMetric?.generationMs)}</strong>
        </article>
        <article>
          <p>Total Runtime</p>
          <strong>{formatMs(latestMetric?.totalMs)}</strong>
        </article>
      </div>
      {latestMetric ? (
        <p className="subtle">
          Last run: {latestMetric.status.toUpperCase()} • {latestMetric.endpointsDetected} endpoints • {latestMetric.testsGenerated} tests
        </p>
      ) : (
        <p className="subtle">Run a full scan + generate cycle to capture metrics.</p>
      )}
    </section>
  );
}
