import { useState } from 'react';
import type { EventMessage } from '@shared/messages';
import type { HostPlatform, LLMProvider } from '@shared/types';
import { sendCommand } from '@popup/runtime';

type CheckState = 'idle' | 'checking' | 'valid' | 'invalid';
type CheckResult = { state: CheckState; message?: string };
type TokenService = 'openai' | 'gemini' | 'claude' | 'github' | 'gitlab' | 'atlassian';

const SERVICES: Array<{ id: TokenService; label: string; hint: string }> = [
  { id: 'openai', label: 'OpenAI', hint: 'Tests access to the Models API.' },
  { id: 'gemini', label: 'Google Gemini', hint: 'Tests access to the Gemini Models API.' },
  { id: 'claude', label: 'Anthropic Claude', hint: 'Tests access to Anthropic Models.' },
  { id: 'github', label: 'GitHub', hint: 'Tests access to your GitHub user profile.' },
  { id: 'gitlab', label: 'GitLab', hint: 'Tests access to your GitLab user profile.' },
  { id: 'atlassian', label: 'Atlassian Jira Cloud', hint: 'Requires your Jira site URL and Atlassian account email.' }
];

const providerFor = (service: TokenService): LLMProvider | null =>
  service === 'openai' || service === 'gemini' ? service : service === 'claude' ? 'claude' : null;

const repoFor = (service: TokenService): HostPlatform | null =>
  service === 'github' || service === 'gitlab' ? service : null;

export function TokenCheck() {
  const [tokens, setTokens] = useState<Record<TokenService, string>>({
    openai: '', gemini: '', claude: '', github: '', gitlab: '', atlassian: ''
  });
  const [results, setResults] = useState<Record<TokenService, CheckResult>>({
    openai: { state: 'idle' }, gemini: { state: 'idle' }, claude: { state: 'idle' },
    github: { state: 'idle' }, gitlab: { state: 'idle' }, atlassian: { state: 'idle' }
  });
  const [atlassianSiteUrl, setAtlassianSiteUrl] = useState('');
  const [atlassianEmail, setAtlassianEmail] = useState('');

  const updateToken = (service: TokenService, value: string) => setTokens((current) => ({ ...current, [service]: value }));
  const setResult = (service: TokenService, result: CheckResult) => setResults((current) => ({ ...current, [service]: result }));

  const checkToken = async (service: TokenService): Promise<void> => {
    const token = tokens[service].trim();
    if (!token) {
      setResult(service, { state: 'invalid', message: 'Enter a token first.' });
      return;
    }

    setResult(service, { state: 'checking' });
    try {
      const provider = providerFor(service);
      const repo = repoFor(service);
      let response: EventMessage;
      if (provider) {
        response = await sendCommand({ type: 'TEST_PROVIDER_KEY', payload: { provider, apiKey: token } });
      } else if (repo) {
        response = await sendCommand({ type: 'TEST_REPO_TOKEN', payload: { platform: repo, token } });
      } else {
        // Jira is an optional host permission (only this checker uses it) — ask on this click.
        if (!(await chrome.permissions.request({ origins: ['https://*.atlassian.net/*'] }))) {
          setResult(service, { state: 'invalid', message: 'Permission to reach atlassian.net was declined.' });
          return;
        }
        response = await sendCommand({
          type: 'TEST_ATLASSIAN_TOKEN',
          payload: { siteUrl: atlassianSiteUrl, email: atlassianEmail, token }
        });
      }

      const payload = response.type === 'PROVIDER_KEY_STATUS' || response.type === 'REPO_TOKEN_STATUS' || response.type === 'ATLASSIAN_TOKEN_STATUS'
        ? response.payload
        : { ok: false, message: 'Token check did not return a result.' };
      setResult(service, { state: payload.ok ? 'valid' : 'invalid', message: payload.message });
    } catch (error) {
      setResult(service, { state: 'invalid', message: error instanceof Error ? error.message : 'Token check failed.' });
    }
  };

  return (
    <main className="token-check-page">
      <header>
        <p className="eyebrow">APItiser utility</p>
        <h1>Token Checker</h1>
        <p>Validate credentials without saving them. APItiser sends one API request per check and discards the entered values afterwards.</p>
      </header>

      <section className="token-check-grid" aria-label="Token validation services">
        {SERVICES.map((service) => {
          const result = results[service.id];
          return (
            <article className="token-card" key={service.id}>
              <div className="token-card-heading">
                <div><h2>{service.label}</h2><p>{service.hint}</p></div>
                {result.state !== 'idle' && <span className={`token-result ${result.state}`}>{result.state === 'checking' ? 'Checking' : result.state === 'valid' ? 'Valid' : 'Invalid'}</span>}
              </div>
              {service.id === 'atlassian' && <>
                <label>Jira Cloud site URL<input type="url" value={atlassianSiteUrl} onChange={(event) => setAtlassianSiteUrl(event.target.value)} placeholder="https://your-team.atlassian.net" autoComplete="url" /></label>
                <label>Atlassian account email<input type="email" value={atlassianEmail} onChange={(event) => setAtlassianEmail(event.target.value)} placeholder="you@company.com" autoComplete="email" /></label>
              </>}
              <label>{service.id === 'atlassian' ? 'API token' : 'Token / API key'}<input type="password" value={tokens[service.id]} onChange={(event) => updateToken(service.id, event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void checkToken(service.id); }} placeholder="Paste credential" autoComplete="off" /></label>
              <div className="token-card-footer">
                <button type="button" onClick={() => void checkToken(service.id)} disabled={result.state === 'checking'}>{result.state === 'checking' ? 'Checking…' : 'Check token'}</button>
                {result.message && <p className={result.state === 'valid' ? 'token-message valid' : 'token-message invalid'}>{result.message}</p>}
              </div>
            </article>
          );
        })}
      </section>
    </main>
  );
}
