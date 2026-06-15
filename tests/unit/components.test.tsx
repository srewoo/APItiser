import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ErrorBoundary } from '@popup/components/ErrorBoundary';
import { EndpointList } from '@popup/components/EndpointList';
import { ActionFooter } from '@popup/components/ActionFooter';
import { CoveragePanel, PerformancePanel } from '@popup/components/CoveragePanel';
import { TestPreviewModal } from '@popup/components/TestPreviewModal';
import { ProgressTimeline } from '@popup/components/ProgressTimeline';
import { makeEndpoint, makeGeneratedTestCase, makeJobState, makeRunMetric } from '@shared/testing/factories';

afterEach(cleanup);

describe('ErrorBoundary', () => {
  const Boom = () => {
    throw new Error('kaboom');
  };

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>
    );
    expect(screen.getByText('all good')).toBeTruthy();
  });

  it('renders the default fallback and calls onError when a child throws', () => {
    const onError = vi.fn();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary onError={onError}>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('kaboom')).toBeTruthy();
    expect(onError).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('recovers when the retry button is pressed', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let shouldThrow = true;
    const Maybe = () => {
      if (shouldThrow) throw new Error('first render fails');
      return <p>recovered</p>;
    };
    render(
      <ErrorBoundary>
        <Maybe />
      </ErrorBoundary>
    );
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.getByText('recovered')).toBeTruthy();
    spy.mockRestore();
  });

  it('uses a custom fallback render prop when provided', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary fallback={(error) => <p>custom: {error.message}</p>}>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByText('custom: kaboom')).toBeTruthy();
    spy.mockRestore();
  });
});

describe('EndpointList', () => {
  const endpoints = [
    makeEndpoint({
      id: 'GET::/users',
      method: 'GET',
      path: '/users',
      confidence: 0.9,
      trustLabel: 'high',
      trustScore: 88
    }),
    makeEndpoint({ id: 'POST::/users', method: 'POST', path: '/users', confidence: 0 })
  ];

  const baseProps = {
    endpoints,
    selectedEndpointSet: new Set(['GET::/users', 'POST::/users']),
    existingCoveredSet: new Set<string>(),
    selectedEndpointCount: 2,
    selectedEligibleCount: 2,
    skipExistingEnabled: false,
    busy: false,
    methodFilter: 'ALL',
    onMethodFilterChange: vi.fn(),
    onEndpointToggle: vi.fn(),
    onSelectAll: vi.fn(),
    onClearAll: vi.fn(),
    activeOrLatestJob: makeJobState({ totalEndpoints: 2 })
  };

  it('shows an empty hint when there are no endpoints', () => {
    render(<EndpointList {...baseProps} endpoints={[]} />);
    expect(screen.getByText(/Run Scan Repo/i)).toBeTruthy();
  });

  it('renders a row per endpoint with method, path and confidence', () => {
    render(<EndpointList {...baseProps} />);
    expect(screen.getAllByText('/users')).toHaveLength(2);
    expect(screen.getByText('90% conf')).toBeTruthy();
    expect(screen.getByText('high')).toBeTruthy();
  });

  it('filters by HTTP method', () => {
    render(<EndpointList {...baseProps} methodFilter="POST" />);
    // GET row filtered out → only the POST /users path remains
    expect(screen.getAllByText('/users')).toHaveLength(1);
  });

  it('invokes callbacks for filter pills, select/clear and toggling', () => {
    render(<EndpointList {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'GET' }));
    expect(baseProps.onMethodFilterChange).toHaveBeenCalledWith('GET');

    fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    expect(baseProps.onSelectAll).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear All' }));
    expect(baseProps.onClearAll).toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(baseProps.onEndpointToggle).toHaveBeenCalled();
  });

  it('disables checkboxes blocked by skip-existing', () => {
    render(<EndpointList {...baseProps} skipExistingEnabled existingCoveredSet={new Set(['GET::/users'])} />);
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes.some((c) => c.disabled)).toBe(true);
  });
});

describe('ActionFooter', () => {
  const baseProps = {
    busy: false,
    hasRepo: true,
    hasEndpoints: true,
    hasArtifact: false,
    skipExistingEnabled: false,
    selectedEligibleCount: 2,
    selectedEndpointCount: 2,
    onScan: vi.fn(),
    onGenerate: vi.fn(),
    onDownload: vi.fn(),
    onCancel: vi.fn(),
    onClear: vi.fn()
  };

  it('enables scan/generate when a repo and endpoints are present', () => {
    render(<ActionFooter {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan Repo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate Tests' }));
    expect(baseProps.onScan).toHaveBeenCalled();
    expect(baseProps.onGenerate).toHaveBeenCalled();
  });

  it('disables scan when no repo and download when no artifact', () => {
    render(<ActionFooter {...baseProps} hasRepo={false} />);
    expect((screen.getByRole('button', { name: 'Scan Repo' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Download/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows Cancel while busy and Clear otherwise', () => {
    const { rerender } = render(<ActionFooter {...baseProps} busy />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(baseProps.onCancel).toHaveBeenCalled();
    rerender(<ActionFooter {...baseProps} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(baseProps.onClear).toHaveBeenCalled();
  });

  it('renders readiness label and an Export Postman button on completion', () => {
    const onExportPostman = vi.fn();
    render(
      <ActionFooter
        {...baseProps}
        hasArtifact
        readiness="production_candidate"
        readinessNotes={['All live checks passed']}
        jobStage="complete"
        onExportPostman={onExportPostman}
      />
    );
    expect(screen.getByText(/production candidate/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Download Validated Tests/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Export Postman' }));
    expect(onExportPostman).toHaveBeenCalled();
  });
});

describe('CoveragePanel & PerformancePanel', () => {
  it('renders coverage figures and validation ratio', () => {
    const job = makeJobState({
      totalEndpoints: 3,
      coverage: { endpointsDetected: 3, testsGenerated: 9, coveragePercent: 67, gaps: ['no security tests'] },
      validationSummary: {
        attempted: 9,
        passed: 8,
        failed: 1,
        repaired: 0,
        skipped: 0,
        lastValidatedAt: 0,
        results: []
      },
      readiness: 'review_required'
    });
    render(<CoveragePanel activeOrLatestJob={job} selectedFramework="jest" />);
    expect(screen.getByText('67%')).toBeTruthy();
    expect(screen.getByText('8/9')).toBeTruthy();
    expect(screen.getByText('no security tests')).toBeTruthy();
    expect(screen.getByText(/1 tests still failed/)).toBeTruthy();
  });

  it('suggests a framework when it differs from the selected one', () => {
    const job = makeJobState({ suggestedFramework: 'pytest' });
    render(<CoveragePanel activeOrLatestJob={job} selectedFramework="jest" />);
    expect(screen.getByText(/Suggested framework/)).toBeTruthy();
    expect(screen.getByText(/Pytest/)).toBeTruthy();
  });

  it('handles a null job gracefully', () => {
    render(<CoveragePanel activeOrLatestJob={null} />);
    expect(screen.getByText('Coverage Snapshot')).toBeTruthy();
  });

  it('formats performance timings and falls back when no metric exists', () => {
    const { rerender } = render(<PerformancePanel latestMetric={undefined} />);
    expect(screen.getByText(/Run a full scan/)).toBeTruthy();
    rerender(
      <PerformancePanel
        latestMetric={makeRunMetric({ scanMs: 500, generationMs: 2500, totalMs: 3000, status: 'complete' })}
      />
    );
    expect(screen.getByText('500 ms')).toBeTruthy();
    expect(screen.getByText('2.5 s')).toBeTruthy();
    expect(screen.getByText(/COMPLETE/)).toBeTruthy();
  });
});

describe('TestPreviewModal', () => {
  const endpoints = [makeEndpoint({ id: 'GET::/users', method: 'GET', path: '/users' })];
  const tests = [
    makeGeneratedTestCase({ endpointId: 'GET::/users', category: 'positive', title: 'lists users' }),
    makeGeneratedTestCase({
      endpointId: 'GET::/users',
      category: 'security',
      title: 'rejects anon',
      trustLabel: 'high'
    })
  ];

  it('renders grouped tests with a count in the header', () => {
    render(<TestPreviewModal tests={tests} endpoints={endpoints} onClose={vi.fn()} />);
    expect(screen.getByText('Test Preview (2 tests)')).toBeTruthy();
    expect(screen.getByText('lists users')).toBeTruthy();
    expect(screen.getByText('rejects anon')).toBeTruthy();
  });

  it('closes via the close button and backdrop, but not when clicking the dialog', () => {
    const onClose = vi.fn();
    render(<TestPreviewModal tests={tests} endpoints={endpoints} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1); // stopPropagation guards the dialog
  });

  it('copies a test body to the clipboard', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<TestPreviewModal tests={tests} endpoints={endpoints} onClose={vi.fn()} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]);
    expect(writeText).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('ProgressTimeline', () => {
  const noIssues: never[] = [];

  it('renders the stage list, progress and idle status for a null job', () => {
    render(
      <ProgressTimeline
        activeOrLatestJob={null}
        visibleQualityIssues={noIssues}
        qualityStatusLabel={undefined}
        latestBatchDiagnostic={undefined}
      />
    );
    expect(screen.getByText('No active job')).toBeTruthy();
    expect(screen.getByText('generating')).toBeTruthy();
    expect(screen.getByText('0%')).toBeTruthy();
  });

  it('reflects an in-progress generating job with percentage and checkpoint note', () => {
    const job = makeJobState({
      stage: 'generating',
      progress: 45,
      statusText: 'Generating batch 2/4',
      resumedFromCheckpoint: true
    });
    render(
      <ProgressTimeline
        activeOrLatestJob={job}
        visibleQualityIssues={noIssues}
        qualityStatusLabel={undefined}
        latestBatchDiagnostic={undefined}
      />
    );
    expect(screen.getByText('45%')).toBeTruthy();
    expect(screen.getByText('Generating batch 2/4')).toBeTruthy();
    expect(screen.getByText(/Recovered from checkpoint/)).toBeTruthy();
  });

  it('shows the quality gate box with issues and live validation summary', () => {
    const job = makeJobState({
      stage: 'validating',
      repairAttempts: 1,
      validationSummary: {
        attempted: 4,
        passed: 3,
        failed: 1,
        repaired: 1,
        skipped: 0,
        lastValidatedAt: 0,
        results: [
          {
            endpointId: 'GET::/users',
            title: 'lists users',
            success: false,
            durationMs: 10,
            failures: [{ type: 'status', message: 'Expected 200 got 500' }]
          }
        ]
      }
    });
    render(
      <ProgressTimeline
        activeOrLatestJob={job}
        visibleQualityIssues={[{ code: 'WEAK_SECURITY', message: 'No auth tests', severity: 'warn' }] as never}
        qualityStatusLabel="warn"
        latestBatchDiagnostic={{ repairAttempted: true } as never}
      />
    );
    expect(screen.getByText(/Quality gate:/)).toBeTruthy();
    expect(screen.getByText('No auth tests')).toBeTruthy();
    const liveLine = screen.getByText(/Live validation:/);
    expect(liveLine.parentElement?.textContent).toContain('3/4 passed');
    expect(screen.getByText(/Expected 200 got 500/)).toBeTruthy();
  });
});
