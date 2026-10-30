import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EndpointList } from '@popup/components/EndpointList';
import { LiveRunPanel } from '@popup/components/LiveRunPanel';
import { ResultsPanel } from '@popup/components/ResultsPanel';
import { randomDevPort, suggestStartCommand } from '@shared/startCommand';
import {
  makeEndpoint,
  makeGeneratedTestCase,
  makeJobState,
  makeValidationResult,
  makeValidationSummary
} from '@shared/testing/factories';

afterEach(cleanup);

const users = makeEndpoint({ id: 'GET::/users', method: 'GET', path: '/users' });

describe('EndpointList run button', () => {
  const renderList = (onRunEndpoint = vi.fn(), runDisabled = false) => {
    const job = makeJobState({
      endpoints: [users],
      generatedTests: [makeGeneratedTestCase({ endpointId: users.id })],
      validationSummary: makeValidationSummary({
        results: [makeValidationResult({ endpointId: users.id, success: false })]
      })
    });
    render(
      <EndpointList
        endpoints={[users]}
        selectedEndpointSet={new Set([users.id])}
        existingCoveredSet={new Set()}
        selectedEndpointCount={1}
        selectedEligibleCount={1}
        skipExistingEnabled={false}
        busy={false}
        methodFilter="ALL"
        onMethodFilterChange={vi.fn()}
        onEndpointToggle={vi.fn()}
        onSelectAll={vi.fn()}
        onClearAll={vi.fn()}
        activeOrLatestJob={job}
        onRunEndpoint={onRunEndpoint}
        runDisabled={runDisabled}
      />
    );
    return onRunEndpoint;
  };

  it('runs a single endpoint and shows its last result', () => {
    const onRun = renderList();
    fireEvent.click(screen.getByRole('button', { name: 'Run tests for GET /users' }));
    expect(onRun).toHaveBeenCalledWith('GET::/users');
    expect(screen.getByText('0/1')).toBeTruthy();
  });

  it('disables the run button when runs are blocked', () => {
    renderList(vi.fn(), true);
    expect(screen.getByRole('button', { name: 'Run tests for GET /users' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('ResultsPanel', () => {
  it('groups results by endpoint and shows failure details', () => {
    const summary = makeValidationSummary({
      attempted: 2,
      passed: 1,
      failed: 1,
      targetBaseUrl: 'http://localhost:8080',
      results: [
        makeValidationResult({ endpointId: users.id, title: 'ok case' }),
        makeValidationResult({
          endpointId: users.id,
          title: 'bad case',
          success: false,
          status: 500,
          failures: [{ type: 'status', message: 'Expected HTTP 200 but received 500.' }],
          responseSnippet: '{"error":"boom"}'
        })
      ]
    });
    render(<ResultsPanel summary={summary} endpoints={[users]} running={false} />);
    expect(screen.getByText('GET /users')).toBeTruthy();
    expect(screen.getByText('1/2')).toBeTruthy();
    expect(screen.getByText(/Expected HTTP 200 but received 500/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Failed' }));
    expect(screen.getByText('bad case')).toBeTruthy();
  });

  it('renders nothing before any run', () => {
    const { container } = render(<ResultsPanel summary={undefined} endpoints={[]} running={false} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('LiveRunPanel', () => {
  // The manual-start flow probes localhost for a free port; never hit the real network.
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const baseProps = {
    canStart: true,
    runnerMissing: false,
    onDownloadRunner: vi.fn(),
    allowRemote: false,
    hasTests: true,
    running: false,
    busy: false,
    onStartService: vi.fn(),
    onStopService: vi.fn(),
    onRunAll: vi.fn(),
    onCancelRun: vi.fn(),
    baseUrl: '',
    onBaseUrlChange: vi.fn()
  };

  it('starts the service and runs all tests against a local target', () => {
    render(<LiveRunPanel {...baseProps} target="http://localhost:8080" />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    fireEvent.click(screen.getByRole('button', { name: '▶ Run all tests' }));
    expect(baseProps.onStartService).toHaveBeenCalled();
    expect(baseProps.onRunAll).toHaveBeenCalled();
  });

  it('blocks runs against a non-local target and says why', () => {
    render(<LiveRunPanel {...baseProps} target="https://api.example.com" />);
    expect(screen.getByRole('alert').textContent).toContain('not a local address');
    expect(screen.getByRole('button', { name: '▶ Run all tests' }).hasAttribute('disabled')).toBe(true);
  });

  it('offers Stop while the service is running', () => {
    render(
      <LiveRunPanel
        {...baseProps}
        target="http://localhost:8080"
        service={{ status: 'running', baseUrl: 'http://localhost:8080', updatedAt: 0 }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(baseProps.onStopService).toHaveBeenCalled();
  });

  it('guides a manual start on a random free port: command, URL, and a connection check', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // → port 44500
    let serverStarted = false;
    // Probes before the user starts anything find the port free; after "starting", it answers.
    const fetchMock = vi.fn((url: string) =>
      serverStarted && url === 'http://localhost:44500' ? Promise.resolve({ status: 404 }) : Promise.reject(new TypeError('Failed to fetch'))
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<LiveRunPanel {...baseProps} startSuggestion={(port) => `uvicorn main:app --port ${port}`} />);

    expect(await screen.findByText('uvicorn main:app --port 44500')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:44500', expect.anything()); // probed free first
    fireEvent.click(screen.getByRole('button', { name: 'Use http://localhost:44500' }));
    expect(baseProps.onBaseUrlChange).toHaveBeenCalledWith('http://localhost:44500');

    serverStarted = true;
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
    expect(await screen.findByText('Server is up (HTTP 404).')).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('skips a random port that is already taken', async () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValue(0.5); // 40000 (busy), then 44500
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      url === 'http://localhost:40000' ? Promise.resolve({ status: 200 }) : Promise.reject(new TypeError('Failed to fetch'))
    ));
    render(<LiveRunPanel {...baseProps} startSuggestion={(port) => `go run . # ${port}`} />);
    expect(await screen.findByText('go run . # 44500')).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('reports when nothing is listening', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    render(<LiveRunPanel {...baseProps} baseUrl="http://localhost:9" />);
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
    expect(await screen.findByText(/Nothing answered/)).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

describe('suggestStartCommand', () => {
  it('uses the dominant code-route framework and ignores spec-only sources', () => {
    expect(suggestStartCommand(['openapi', 'fastapi', 'fastapi', 'express'])?.(41234)).toBe('uvicorn main:app --reload --port 41234');
    expect(suggestStartCommand(['openapi', 'graphql'])).toBeUndefined();
  });
});

describe('randomDevPort', () => {
  it('stays above the crowded dev ports', () => {
    expect(randomDevPort(() => 0)).toBe(40000);
    expect(randomDevPort(() => 0.9999)).toBeLessThan(49000);
  });
});

describe('LiveRunPanel one-click Start', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
  });
  afterEach(() => vi.unstubAllGlobals());

  const props = {
    canStart: true,
    runnerMissing: false,
    onDownloadRunner: vi.fn(),
    allowRemote: false,
    hasTests: true,
    running: false,
    busy: false,
    onStartService: vi.fn(),
    onStopService: vi.fn(),
    onRunAll: vi.fn(),
    onCancelRun: vi.fn(),
    baseUrl: '',
    onBaseUrlChange: vi.fn()
  };

  it('lists the stack: reused DB, started DB, and the frontend with its link', () => {
    render(
      <LiveRunPanel
        {...props}
        target="http://localhost:41000"
        service={{
          status: 'running',
          baseUrl: 'http://localhost:41000',
          updatedAt: 0,
          components: [
            { name: 'redis', status: 'running', message: 'Already running on port 6379 — reusing it.' },
            { name: 'mongo', status: 'running', message: 'Started in Docker on port 27017.' },
            { name: 'frontend', status: 'running', message: 'Frontend is up.', url: 'http://localhost:41001' }
          ]
        }}
      />
    );
    expect(screen.getByText('redis')).toBeTruthy();
    expect(screen.getByText(/reusing it/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'http://localhost:41001' }).getAttribute('href')).toBe('http://localhost:41001');
  });

  it('offers the installer when the local runner is missing', () => {
    render(<LiveRunPanel {...props} runnerMissing service={{ status: 'error', message: 'x', updatedAt: 0 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download the local runner' }));
    expect(props.onDownloadRunner).toHaveBeenCalled();
  });

  it('needs a repo page to start', () => {
    render(<LiveRunPanel {...props} canStart={false} />);
    expect(screen.getByRole('button', { name: 'Start' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('ResultsPanel verdicts', () => {
  const summary = makeValidationSummary({
    attempted: 2, passed: 0, failed: 2,
    results: [
      makeValidationResult({ endpointId: users.id, title: 'crashes', success: false, status: 500, verdict: 'api', verdictReason: 'The server errored (HTTP 500).', failures: [{ type: 'status', message: 'Expected HTTP 200 but received 500.' }] }),
      makeValidationResult({ endpointId: users.id, title: 'bad id', success: false, status: 404, verdict: 'test', verdictReason: 'Bad payload.', failures: [{ type: 'status', message: 'Expected HTTP 200 but received 404.' }] })
    ]
  });

  it('counts and labels likely API bugs vs tests that need fixing, with matching actions', () => {
    const onFixTest = vi.fn();
    const onFixCode = vi.fn();
    render(<ResultsPanel summary={summary} endpoints={[users]} running={false} onFixTest={onFixTest} onFixCode={onFixCode} />);
    expect(screen.getByText('1 likely API bug')).toBeTruthy();
    expect(screen.getByText('1 test need fixing')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fix this test…' }));
    expect(onFixTest).toHaveBeenCalledWith(expect.objectContaining({ title: 'bad id' }));
    fireEvent.click(screen.getByRole('button', { name: 'Propose a code fix…' }));
    expect(onFixCode).toHaveBeenCalledWith(expect.objectContaining({ title: 'crashes' }));
  });

  it('filters to likely bugs only', () => {
    render(<ResultsPanel summary={summary} endpoints={[users]} running={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Likely bugs' }));
    expect(screen.getByText('crashes')).toBeTruthy();
    expect(screen.queryByText('bad id')).toBeNull();
  });
});
