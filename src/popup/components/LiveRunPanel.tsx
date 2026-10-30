import { useEffect, useState } from 'react';
import type { LocalServiceState, StackComponent } from '@shared/types';
import { CodeFolder, type CodeFolderProps } from './CodeFolder';
import { isLoopbackUrl } from '@shared/localUrl';
import { randomDevPort, type StartCommand } from '@shared/startCommand';

interface LiveRunPanelProps {
  service?: LocalServiceState;
  /** Start needs a repo: the page's, or the scanned one. */
  canStart: boolean;
  /** The runner isn't installed — offer the installer instead of a dead end. */
  runnerMissing: boolean;
  onDownloadRunner: () => void;
  /** Per-repo folder control; omitted when no repo is known. */
  codeFolder?: Omit<CodeFolderProps, 'disabled'>;
  /** Where runs go: the running service, else the configured Base URL. */
  target?: string;
  allowRemote: boolean;
  hasTests: boolean;
  running: boolean;
  busy: boolean;
  onStartService: () => void;
  onStopService: () => void;
  onRunAll: () => void;
  onCancelRun: () => void;
  /** Manual ("start it yourself") flow: suggested command and the editable Base URL. */
  startSuggestion?: StartCommand;
  baseUrl: string;
  onBaseUrlChange: (url: string) => void;
}

type Reachability = { state: 'idle' | 'checking' } | { state: 'up' | 'down'; message: string };

/** Any HTTP answer (even 404) means a server is listening; only a network error means it isn't. */
const checkReachable = async (url: string): Promise<Reachability> => {
  try {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(4000) });
    return { state: 'up', message: `Server is up (HTTP ${response.status}).` };
  } catch {
    return { state: 'down', message: 'Nothing answered at that address yet — is the server running?' };
  }
};

/** A random high port that nothing on this machine answers on (a few tries, then best effort). */
const pickFreeDevPort = async (): Promise<number> => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = randomDevPort();
    if ((await checkReachable(`http://localhost:${port}`)).state === 'down') return port;
  }
  return randomDevPort();
};

function ManualStart({ startSuggestion, baseUrl, onBaseUrlChange }: Pick<LiveRunPanelProps, 'startSuggestion' | 'baseUrl' | 'onBaseUrlChange'>) {
  const [draft, setDraft] = useState(baseUrl);
  const [reach, setReach] = useState<Reachability>({ state: 'idle' });
  const [port, setPort] = useState<number>();
  useEffect(() => setDraft(baseUrl), [baseUrl]); // state loads after first render
  useEffect(() => {
    void pickFreeDevPort().then(setPort);
  }, []);
  const suggestedUrl = port ? `http://localhost:${port}` : '';
  const commit = (url: string) => {
    setDraft(url);
    setReach({ state: 'idle' });
    onBaseUrlChange(url.trim());
  };
  return (
    <ol className="manual-start">
      <li>
        In your repo, start the API{port ? ` on free port ${port}` : ''}{startSuggestion ? ':' : '.'}
        {startSuggestion && port ? <pre className="result-snippet">{startSuggestion(port)}</pre> : null}
      </li>
      <li>
        <label>
          Where it is listening
          <input
            type="text"
            value={draft}
            placeholder={suggestedUrl || 'http://localhost:4xxxx'}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => commit(event.target.value)}
          />
        </label>
        {suggestedUrl && draft !== suggestedUrl ? (
          <button type="button" className="link-btn" onClick={() => commit(suggestedUrl)}>Use {suggestedUrl}</button>
        ) : null}
      </li>
      <li>
        <button
          type="button"
          className="ghost endpoint-control-btn"
          disabled={!draft.trim() || reach.state === 'checking'}
          onClick={async () => {
            setReach({ state: 'checking' });
            setReach(await checkReachable(draft.trim()));
          }}
        >
          {reach.state === 'checking' ? 'Checking…' : 'Check connection'}
        </button>{' '}
        {reach.state === 'up' || reach.state === 'down' ? (
          <span className={reach.state === 'up' ? 'check-ok' : 'check-bad'}>{reach.message}</span>
        ) : null}
      </li>
    </ol>
  );
}

const COMPONENT_ICON: Record<StackComponent['status'], string> = { starting: '…', running: '●', failed: '✗', stopped: '○' };

function StackComponents({ components }: { components: StackComponent[] }) {
  if (!components.length) return null;
  return (
    <ul className="stack-components">
      {components.map((item) => (
        <li key={item.name} className={`stack-${item.status}`}>
          <span aria-hidden="true">{COMPONENT_ICON[item.status]}</span>{' '}
          <strong>{item.name}</strong>
          {item.url ? <> — <a href={item.url} target="_blank" rel="noreferrer">{item.url}</a></> : null}
          {item.message ? <span className="subtle"> {item.message}</span> : null}
        </li>
      ))}
    </ul>
  );
}

const STATUS_LABEL: Record<LocalServiceState['status'], string> = {
  starting: 'Starting…',
  running: 'Running',
  stopped: 'Stopped',
  error: 'Failed'
};

export function LiveRunPanel({
  service,
  canStart,
  runnerMissing,
  onDownloadRunner,
  codeFolder,
  target,
  allowRemote,
  hasTests,
  running,
  busy,
  onStartService,
  onStopService,
  onRunAll,
  onCancelRun,
  startSuggestion,
  baseUrl,
  onBaseUrlChange
}: LiveRunPanelProps) {
  const status = service?.status ?? 'stopped';
  const up = status === 'running' || status === 'starting';
  const remoteBlocked = Boolean(target && !isLoopbackUrl(target) && !allowRemote);

  return (
    <section className="panel live-run">
      <h2>Run in Browser</h2>

      <div className="service-bar">
        <span className={`service-dot service-${status}`} aria-hidden="true" />
        <div className="service-text">
          <strong>Local service: {STATUS_LABEL[status]}</strong>
          {service?.message ? <span className="subtle" title={service.message}>{service.message}</span> : null}
        </div>
        {up ? (
          <button type="button" className="ghost endpoint-control-btn" onClick={onStopService} disabled={running}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="ghost endpoint-control-btn"
            onClick={onStartService}
            disabled={busy || !canStart}
            title={canStart ? 'Find or clone this repo, start its databases, API and frontend' : 'Open a GitHub/GitLab repo page first'}
          >
            Start
          </button>
        )}
      </div>
      {codeFolder ? <CodeFolder {...codeFolder} disabled={up} /> : null}
      <StackComponents components={service?.components ?? []} />
      {runnerMissing ? (
        <p className="run-warning">
          <button type="button" className="link-btn" onClick={onDownloadRunner}>Download the local runner</button>
          {' '}— unzip it and run <code>./install.sh</code> once. Start works after that.
        </p>
      ) : null}
      {!up ? (
        <details className="manual-start-toggle">
          <summary className="subtle">Or start it yourself</summary>
          <ManualStart startSuggestion={startSuggestion} baseUrl={baseUrl} onBaseUrlChange={onBaseUrlChange} />
        </details>
      ) : null}

      <p className="subtle">
        Target: {target ? <code>{target}</code> : 'none — start the local service or set a Base URL in Settings'}
      </p>
      {remoteBlocked ? (
        <p className="run-warning" role="alert">
          {target} is not a local address. Live tests send mutating and attack-style requests, so they are blocked
          unless you allow non-local URLs in Settings.
        </p>
      ) : null}

      <div className="endpoint-control-actions">
        {running ? (
          <button type="button" className="ghost" onClick={onCancelRun}>Stop run</button>
        ) : (
          <button type="button" onClick={onRunAll} disabled={busy || !hasTests || !target || remoteBlocked}>
            ▶ Run all tests
          </button>
        )}
      </div>
      {!hasTests ? <p className="subtle">Generate tests, then run each endpoint with its ▶ button.</p> : null}
    </section>
  );
}
