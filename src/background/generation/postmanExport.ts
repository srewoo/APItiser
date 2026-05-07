import type { ApiEndpoint, GeneratedTestCase, RepoRef } from '@shared/types';

interface PostmanQuery {
  key: string;
  value: string;
}

interface PostmanUrl {
  raw: string;
  host: string[];
  path: string[];
  query?: PostmanQuery[];
  variable?: { key: string; value: string }[];
}

interface PostmanItem {
  name: string;
  request: {
    method: string;
    header: { key: string; value: string }[];
    url: PostmanUrl;
    body?: { mode: string; raw: string; options: { raw: { language: string } } };
    description?: string;
    auth?: PostmanAuth;
  };
  event?: { listen: string; script: { exec: string[]; type: string } }[];
}

interface PostmanFolder {
  name: string;
  item: (PostmanItem | PostmanFolder)[];
  description?: string;
}

interface PostmanAuth {
  type: 'bearer' | 'apikey' | 'noauth';
  bearer?: { key: string; value: string; type: string }[];
  apikey?: { key: string; value: string; in?: string }[];
}

interface PostmanCollection {
  info: { name: string; description: string; schema: string; _postman_id?: string };
  auth?: PostmanAuth;
  variable: { key: string; value: string; type: string }[];
  item: (PostmanItem | PostmanFolder)[];
  event?: { listen: string; script: { exec: string[]; type: string } }[];
}

const POSTMAN_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

const POSTMAN_PARAM_REGEX = /\{([^}]+)\}|:([a-zA-Z0-9_]+)/g;

const splitPath = (path: string): string[] =>
  path.replace(/^\//, '').split('/').filter(Boolean);

const toPostmanPath = (segments: string[]): { path: string[]; variables: { key: string; value: string }[] } => {
  const variables: { key: string; value: string }[] = [];
  const path = segments.map((segment) => {
    POSTMAN_PARAM_REGEX.lastIndex = 0;
    if (segment.startsWith(':')) {
      const key = segment.slice(1);
      variables.push({ key, value: `{{${key}}}` });
      return `:${key}`;
    }
    if (segment.startsWith('{') && segment.endsWith('}')) {
      const key = segment.slice(1, -1);
      variables.push({ key, value: `{{${key}}}` });
      return `:${key}`;
    }
    return segment;
  });
  return { path, variables };
};

const detectAuth = (headers: Record<string, string>): PostmanAuth | undefined => {
  for (const [key, value] of Object.entries(headers)) {
    const lk = key.toLowerCase();
    if (lk === 'authorization' && value.startsWith('Bearer')) {
      return { type: 'bearer', bearer: [{ key: 'token', value: '{{API_TOKEN}}', type: 'string' }] };
    }
    if (lk === 'x-api-key' || lk === 'apikey' || lk === 'api-key') {
      return {
        type: 'apikey',
        apikey: [
          { key: 'key', value: key },
          { key: 'value', value: '{{API_KEY}}' },
          { key: 'in', value: 'header' }
        ]
      };
    }
  }
  return undefined;
};

const buildTestScript = (test: GeneratedTestCase): string[] => {
  const lines: string[] = [];

  lines.push(`pm.test("Status is ${test.expected.status}", function () {`);
  lines.push(`  pm.response.to.have.status(${test.expected.status});`);
  lines.push(`});`);

  if (test.expected.contentType) {
    lines.push(`pm.test("Content-Type contains '${test.expected.contentType}'", function () {`);
    lines.push(`  pm.expect(pm.response.headers.get('Content-Type') || '').to.include(${JSON.stringify(test.expected.contentType)});`);
    lines.push(`});`);
  }

  for (const [hk, hv] of Object.entries(test.expected.responseHeaders ?? {})) {
    lines.push(`pm.test("Response header ${hk}", function () {`);
    lines.push(`  pm.expect(pm.response.headers.get(${JSON.stringify(hk)})).to.eql(${JSON.stringify(hv)});`);
    lines.push(`});`);
  }

  for (const substr of test.expected.contains ?? []) {
    lines.push(`pm.test(${JSON.stringify(`Body contains ${substr}`)}, function () {`);
    lines.push(`  pm.expect(pm.response.text()).to.include(${JSON.stringify(substr)});`);
    lines.push(`});`);
  }

  if (test.expected.jsonSchema) {
    lines.push(`pm.test("JSON shape", function () {`);
    lines.push(`  const data = pm.response.json();`);
    lines.push(`  const schema = ${JSON.stringify(test.expected.jsonSchema)};`);
    lines.push(`  function check(s, v) {`);
    lines.push(`    if (!s) return;`);
    lines.push(`    if (s.type === 'array') { pm.expect(Array.isArray(v)).to.be.true; if (s.items && Array.isArray(v) && v.length) check(s.items, v[0]); return; }`);
    lines.push(`    if (s.type === 'object') { pm.expect(v).to.be.an('object'); (s.required || []).forEach(function(k){ pm.expect(v).to.have.property(k); }); Object.entries(s.properties || {}).forEach(function(e){ if (v && Object.prototype.hasOwnProperty.call(v, e[0])) check(e[1], v[e[0]]); }); return; }`);
    lines.push(`    if (s.type === 'integer') { pm.expect(Number.isInteger(v)).to.be.true; return; }`);
    lines.push(`    if (s.type) pm.expect(typeof v).to.eql(s.type === 'number' ? 'number' : (s.type === 'boolean' ? 'boolean' : 'string'));`);
    lines.push(`  }`);
    lines.push(`  check(schema, data);`);
    lines.push(`});`);
  }

  if (test.expected.pagination) {
    lines.push(`pm.test("Paginated shape", function () {`);
    lines.push(`  const data = pm.response.json();`);
    lines.push(`  const ok = Array.isArray(data) || (data && ['items','results','data'].some(function(k){ return k in data; }));`);
    lines.push(`  pm.expect(ok).to.be.true;`);
    lines.push(`});`);
  }

  return lines;
};

const buildPostmanItem = (test: GeneratedTestCase, endpoint: ApiEndpoint | undefined): PostmanItem => {
  const segments = splitPath(test.request.path);
  const { path: postmanSegments, variables } = toPostmanPath(segments);

  const headers = Object.entries(test.request.headers ?? {})
    .filter(([k]) => k.toLowerCase() !== 'authorization' && k.toLowerCase() !== 'x-api-key')
    .map(([key, value]) => ({ key, value }));

  const queryItems = Object.entries(test.request.query ?? {}).map(([key, value]) => ({
    key,
    value: String(value)
  }));

  const rawUrl = `{{baseUrl}}/${postmanSegments.join('/')}${
    queryItems.length ? `?${queryItems.map((q) => `${q.key}={{${q.key}}}`).join('&')}` : ''
  }`;

  const item: PostmanItem = {
    name: `[${test.category}] ${test.title}`,
    request: {
      method: test.request.method,
      header: headers,
      url: {
        raw: rawUrl,
        host: ['{{baseUrl}}'],
        path: postmanSegments,
        ...(queryItems.length ? { query: queryItems } : {}),
        ...(variables.length ? { variable: variables } : {})
      },
      description: [
        endpoint?.summary,
        endpoint?.description,
        test.rationale ? `Rationale: ${test.rationale}` : undefined,
        test.trustLabel ? `Trust: ${test.trustLabel} (${test.trustScore ?? 0})` : undefined
      ]
        .filter(Boolean)
        .join('\n\n')
    }
  };

  const auth = detectAuth(test.request.headers ?? {});
  if (auth) {
    item.request.auth = auth;
  }

  if (test.request.body !== undefined && test.request.body !== null) {
    item.request.body = {
      mode: 'raw',
      raw: JSON.stringify(test.request.body, null, 2),
      options: { raw: { language: 'json' } }
    };
  }

  item.event = [
    {
      listen: 'test',
      script: { type: 'text/javascript', exec: buildTestScript(test) }
    }
  ];

  return item;
};

export const buildPostmanCollection = (
  repo: RepoRef,
  tests: GeneratedTestCase[],
  endpoints: ApiEndpoint[],
  baseUrl = 'http://localhost:3000'
): string => {
  const endpointsById = new Map(endpoints.map((ep) => [ep.id, ep]));

  // Two-level grouping: top folder = first path segment (resource); inner folder = METHOD path
  const resourceFolders = new Map<string, Map<string, PostmanItem[]>>();
  const pathVariableKeys = new Set<string>();
  const queryParamKeys = new Set<string>();

  for (const test of tests) {
    const endpoint = endpointsById.get(test.endpointId);
    const segments = splitPath(test.request.path);
    const resource = segments.find((s) => !s.startsWith(':') && !s.startsWith('{')) ?? 'root';
    const innerKey = `${test.request.method.toUpperCase()} ${test.request.path}`;

    if (!resourceFolders.has(resource)) {
      resourceFolders.set(resource, new Map());
    }
    const inner = resourceFolders.get(resource)!;
    if (!inner.has(innerKey)) {
      inner.set(innerKey, []);
    }
    inner.get(innerKey)!.push(buildPostmanItem(test, endpoint));

    for (const seg of segments) {
      if (seg.startsWith(':')) pathVariableKeys.add(seg.slice(1));
      else if (seg.startsWith('{') && seg.endsWith('}')) pathVariableKeys.add(seg.slice(1, -1));
    }
    for (const key of Object.keys(test.request.query ?? {})) {
      queryParamKeys.add(key);
    }
  }

  const items: (PostmanItem | PostmanFolder)[] = [...resourceFolders.entries()].map(([resourceName, inner]) => ({
    name: resourceName,
    item: [...inner.entries()].map(([groupName, groupItems]) => ({
      name: groupName,
      item: groupItems
    }))
  }));

  const collection: PostmanCollection = {
    info: {
      name: `APItiser — ${repo.owner}/${repo.repo}`,
      description: `Generated by APItiser. Repo: ${repo.platform}:${repo.owner}/${repo.repo}\n\nVariables:\n- baseUrl: API base URL\n- API_TOKEN: bearer token (if used)\n- API_KEY: API key (if used)`,
      schema: POSTMAN_SCHEMA
    },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{API_TOKEN}}', type: 'string' }] },
    variable: [
      { key: 'baseUrl', value: baseUrl, type: 'string' },
      { key: 'API_TOKEN', value: '', type: 'string' },
      { key: 'API_KEY', value: '', type: 'string' },
      ...[...pathVariableKeys].map((key) => ({ key, value: '', type: 'string' })),
      ...[...queryParamKeys].map((key) => ({ key, value: '', type: 'string' }))
    ],
    item: items,
    event: [
      {
        listen: 'prerequest',
        script: {
          type: 'text/javascript',
          exec: [
            "// Auto-injected: warn if required variables are unset",
            "['baseUrl'].forEach(function(k){ if(!pm.variables.get(k)) console.warn('Missing variable: '+k); });"
          ]
        }
      }
    ]
  };

  return JSON.stringify(collection, null, 2);
};

export const buildPostmanEnvironment = (baseUrl = 'http://localhost:3000'): string => {
  return JSON.stringify(
    {
      name: 'APItiser Environment',
      values: [
        { key: 'baseUrl', value: baseUrl, type: 'default', enabled: true },
        { key: 'API_TOKEN', value: '', type: 'secret', enabled: true },
        { key: 'API_KEY', value: '', type: 'secret', enabled: true }
      ],
      _postman_variable_scope: 'environment'
    },
    null,
    2
  );
};
