/**
 * Shared, per-language rendering of EXECUTABLE response assertions.
 *
 * Before this module, generated suites asserted little more than a status code: contract
 * checks were emitted as `// verify manually` comments and schema validation was type-only.
 * Here we render real, field-level assertions (`bodyAssertions`), deep schema validation
 * that honours enum/range/length/pattern, a meaningful idempotency oracle (compare two
 * responses for equivalence, ignoring volatile fields), and a retry/backoff wrapper.
 *
 * Each language exposes:
 *  - a `*_HELPERS` preamble injected once per test file (getByPath, assertBody, jsonType,
 *    assertSchemaShape, isPaginatedShape, assertIdempotent, retrying fetch/client).
 *  - a `renderBodyAssertions*` function that emits per-test assertion calls.
 */
import type { BodyAssertion, GeneratedTestCase } from '@shared/types';

const jsonAssertions = (testCase: GeneratedTestCase): BodyAssertion[] => testCase.expected.bodyAssertions ?? [];

const contractCommentLines = (testCase: GeneratedTestCase, prefix: string): string[] =>
  (testCase.expected.contractChecks ?? []).map(
    (value) => `${prefix} Contract note: ${String(value).replace(/\s+/g, ' ').trim()}`
  );

// ---------------------------------------------------------------------------
// JavaScript family (jest, vitest, supertest, playwright use jest-style matchers;
// mocha uses chai). The runtime helpers are identical; only the matcher calls differ.
// ---------------------------------------------------------------------------

const JS_RUNTIME_HELPERS = `const VOLATILE_KEY_RE = /(updated_?at|created_?at|timestamp|^time$|^date$|request_?id|trace_?id|etag|last_?modified)/i;
const stripVolatile = (value) => {
  if (Array.isArray(value)) {
    return value.map(stripVolatile);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !VOLATILE_KEY_RE.test(key))
        .map(([key, child]) => [key, stripVolatile(child)])
    );
  }
  return value;
};
const jsonType = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
};
const getByPath = (obj, path) => {
  if (!path) return obj;
  const parts = String(path).replace(/\\[(\\d+)\\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
};
const isPaginatedShape = (value) => Array.isArray(value)
  || (value && typeof value === 'object'
    && (['items', 'results', 'data'].some((key) => key in value) || Object.values(value).some((entry) => Array.isArray(entry))));
const assertSchemaShape = (schema, value, path = 'response') => {
  if (!schema) return;
  const t = schema.type;
  if (Array.isArray(schema.enum) && schema.enum.length) {
    expect(schema.enum).toContainEqual(value);
  }
  if (t === 'array') {
    expect(Array.isArray(value)).toBe(true);
    if (typeof schema.minLength === 'number') expect(value.length).toBeGreaterThanOrEqual(schema.minLength);
    if (typeof schema.maxLength === 'number') expect(value.length).toBeLessThanOrEqual(schema.maxLength);
    if (schema.items && Array.isArray(value) && value.length > 0) assertSchemaShape(schema.items, value[0], path + '[0]');
    return;
  }
  if (t === 'object') {
    expect(value).not.toBeNull();
    expect(typeof value).toBe('object');
    for (const key of schema.required || []) expect(value).toHaveProperty(key);
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (value && Object.prototype.hasOwnProperty.call(value, key)) assertSchemaShape(child, value[key], path + '.' + key);
    }
    return;
  }
  if (t === 'integer') { expect(Number.isInteger(value)).toBe(true); }
  else if (t === 'number') { expect(typeof value).toBe('number'); }
  else if (t === 'boolean') { expect(typeof value).toBe('boolean'); }
  else if (t === 'string') {
    expect(typeof value).toBe('string');
    if (typeof schema.minLength === 'number') expect(value.length).toBeGreaterThanOrEqual(schema.minLength);
    if (typeof schema.maxLength === 'number') expect(value.length).toBeLessThanOrEqual(schema.maxLength);
    if (schema.pattern) expect(value).toMatch(new RegExp(schema.pattern));
  }
  if ((t === 'integer' || t === 'number') && typeof value === 'number') {
    if (typeof schema.minimum === 'number') expect(value).toBeGreaterThanOrEqual(schema.minimum);
    if (typeof schema.maximum === 'number') expect(value).toBeLessThanOrEqual(schema.maximum);
  }
};
const assertIdempotent = (first, repeat) => {
  expect(repeat.status).toBe(first.status);
  if (first.json !== undefined && repeat.json !== undefined) {
    expect(stripVolatile(repeat.json)).toEqual(stripVolatile(first.json));
  }
};
const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_RETRIES = Number(process.env.API_MAX_RETRIES || 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fetchWithRetry = async (url, init) => {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, init);
    if (!RETRYABLE.has(res.status) || attempt >= MAX_RETRIES) return res;
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 250 * Math.pow(2, attempt));
    attempt += 1;
  }
};`;

const CHAI_RUNTIME_HELPERS = JS_RUNTIME_HELPERS
  // chai assertion dialect
  .replace(/expect\(schema\.enum\)\.toContainEqual\(value\);/g, 'expect(schema.enum).to.deep.include(value);')
  .replace(/expect\(Array\.isArray\(value\)\)\.toBe\(true\);/g, 'expect(value).to.be.an("array");')
  .replace(/expect\(value\.length\)\.toBeGreaterThanOrEqual\(schema\.minLength\);/g, 'expect(value.length).to.be.at.least(schema.minLength);')
  .replace(/expect\(value\.length\)\.toBeLessThanOrEqual\(schema\.maxLength\);/g, 'expect(value.length).to.be.at.most(schema.maxLength);')
  .replace(/expect\(value\)\.not\.toBeNull\(\);/g, 'expect(value).to.not.equal(null);')
  .replace(/expect\(typeof value\)\.toBe\('object'\);/g, 'expect(value).to.be.an("object");')
  .replace(/expect\(value\)\.toHaveProperty\(key\);/g, 'expect(value).to.have.property(key);')
  .replace(/expect\(Number\.isInteger\(value\)\)\.toBe\(true\);/g, 'expect(Number.isInteger(value)).to.equal(true);')
  .replace(/expect\(typeof value\)\.toBe\('number'\);/g, 'expect(value).to.be.a("number");')
  .replace(/expect\(typeof value\)\.toBe\('boolean'\);/g, 'expect(value).to.be.a("boolean");')
  .replace(/expect\(typeof value\)\.toBe\('string'\);/g, 'expect(value).to.be.a("string");')
  .replace(/expect\(value\)\.toMatch\(new RegExp\(schema\.pattern\)\);/g, 'expect(value).to.match(new RegExp(schema.pattern));')
  .replace(/expect\(value\)\.toBeGreaterThanOrEqual\(schema\.minimum\);/g, 'expect(value).to.be.at.least(schema.minimum);')
  .replace(/expect\(value\)\.toBeLessThanOrEqual\(schema\.maximum\);/g, 'expect(value).to.be.at.most(schema.maximum);')
  .replace(/expect\(repeat\.status\)\.toBe\(first\.status\);/g, 'expect(repeat.status).to.equal(first.status);')
  .replace(/expect\(stripVolatile\(repeat\.json\)\)\.toEqual\(stripVolatile\(first\.json\)\);/g, 'expect(stripVolatile(repeat.json)).to.deep.equal(stripVolatile(first.json));');

export const jsRuntimeHelpers = (style: 'jest' | 'chai'): string =>
  style === 'chai' ? CHAI_RUNTIME_HELPERS : JS_RUNTIME_HELPERS;

const jsAssertLine = (a: BodyAssertion, actual: string, label: string, style: 'jest' | 'chai'): string => {
  const v = JSON.stringify(a.value ?? null);
  const jest = style === 'jest';
  switch (a.op) {
    case 'exists':
      return jest ? `expect(${actual}).not.toBeUndefined();` : `expect(${actual}).to.not.equal(undefined);`;
    case 'absent':
      return jest ? `expect(${actual}).toBeUndefined();` : `expect(${actual}).to.equal(undefined);`;
    case 'equals':
      return jest ? `expect(${actual}).toEqual(${v});` : `expect(${actual}).to.deep.equal(${v});`;
    case 'type':
      return jest ? `expect(jsonType(${actual})).toBe(${v});` : `expect(jsonType(${actual})).to.equal(${v});`;
    case 'contains':
      return jest ? `expect(${actual}).toContain(${v});` : `expect(${actual}).to.include(${v});`;
    case 'matches':
      return jest ? `expect(String(${actual})).toMatch(new RegExp(${v}));` : `expect(String(${actual})).to.match(new RegExp(${v}));`;
    case 'gt':
      return jest ? `expect(Number(${actual})).toBeGreaterThan(Number(${v}));` : `expect(Number(${actual})).to.be.above(Number(${v}));`;
    case 'gte':
      return jest ? `expect(Number(${actual})).toBeGreaterThanOrEqual(Number(${v}));` : `expect(Number(${actual})).to.be.at.least(Number(${v}));`;
    case 'lt':
      return jest ? `expect(Number(${actual})).toBeLessThan(Number(${v}));` : `expect(Number(${actual})).to.be.below(Number(${v}));`;
    case 'lte':
      return jest ? `expect(Number(${actual})).toBeLessThanOrEqual(Number(${v}));` : `expect(Number(${actual})).to.be.at.most(Number(${v}));`;
    case 'in':
      // Guard against a non-array `value` so the emitted line fails cleanly instead of throwing
      // a matcher TypeError (e.g. expect(5).toContainEqual(...)).
      return jest
        ? `expect(Array.isArray(${v}) ? ${v} : []).toContainEqual(${actual});`
        : `expect(Array.isArray(${v}) ? ${v} : []).to.deep.include(${actual});`;
    case 'length':
      return jest ? `expect((${actual} || []).length).toBe(Number(${v}));` : `expect((${actual} || []).length).to.equal(Number(${v}));`;
    default:
      return `/* unknown assertion: ${label} */`;
  }
};

/** Render executable body assertions for a JS-family renderer. `bodyVar` holds parsed JSON. */
export const renderBodyAssertionsJs = (
  testCase: GeneratedTestCase,
  bodyVar: string,
  indent: string,
  style: 'jest' | 'chai'
): string => {
  const assertions = jsonAssertions(testCase);
  const contractNotes = contractCommentLines(testCase, `${indent}//`);
  if (!assertions.length) {
    return [`${indent}// No body assertions provided`, ...contractNotes].join('\n');
  }
  const lines = assertions.map((a) => {
    const actual = `getByPath(${bodyVar}, ${JSON.stringify(a.path)})`;
    const desc = a.description ? `${indent}// ${a.description.replace(/\s+/g, ' ').trim()}\n` : '';
    return `${desc}${indent}${jsAssertLine(a, actual, a.path || '<root>', style)}`;
  });
  return [...lines, ...contractNotes].join('\n');
};

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

export const PY_RUNTIME_HELPERS = `import re
import time

_VOLATILE_RE = re.compile(r'(updated_?at|created_?at|timestamp|^time$|^date$|request_?id|trace_?id|etag|last_?modified)', re.I)
_RETRYABLE = {429, 502, 503, 504}
_MAX_RETRIES = int(os.getenv('API_MAX_RETRIES', '2'))

def strip_volatile(value):
    if isinstance(value, list):
        return [strip_volatile(v) for v in value]
    if isinstance(value, dict):
        return {k: strip_volatile(v) for k, v in value.items() if not _VOLATILE_RE.search(k)}
    return value

def json_type(value):
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'boolean'
    if isinstance(value, list):
        return 'array'
    if isinstance(value, int):
        return 'integer'
    if isinstance(value, float):
        return 'number'
    if isinstance(value, str):
        return 'string'
    if isinstance(value, dict):
        return 'object'
    return 'unknown'

def get_by_path(obj, path):
    if not path:
        return obj
    cur = obj
    for part in re.sub(r'\\[(\\d+)\\]', r'.\\1', str(path)).split('.'):
        if part == '':
            continue
        if cur is None:
            return None
        if isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return None
        elif isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
    return cur

def is_paginated_shape(value):
    return isinstance(value, list) or (isinstance(value, dict) and (any(k in value for k in ('items', 'results', 'data')) or any(isinstance(v, list) for v in value.values())))

def assert_schema_shape(schema, value, path='response'):
    if not schema:
        return
    t = schema.get('type')
    if isinstance(schema.get('enum'), list) and schema['enum']:
        assert value in schema['enum'], f'{path} not in enum'
    if t == 'array':
        assert isinstance(value, list), f'{path} expected array'
        if isinstance(schema.get('minLength'), int):
            assert len(value) >= schema['minLength']
        if isinstance(schema.get('maxLength'), int):
            assert len(value) <= schema['maxLength']
        if schema.get('items') and value:
            assert_schema_shape(schema['items'], value[0], f'{path}[0]')
    elif t == 'object':
        assert isinstance(value, dict), f'{path} expected object'
        for key in schema.get('required', []):
            assert key in value, f'{path}.{key} required'
        for key, child in (schema.get('properties') or {}).items():
            if key in value:
                assert_schema_shape(child, value[key], f'{path}.{key}')
    elif t == 'integer':
        assert isinstance(value, int) and not isinstance(value, bool), f'{path} expected integer'
    elif t == 'number':
        assert isinstance(value, (int, float)) and not isinstance(value, bool), f'{path} expected number'
    elif t == 'boolean':
        assert isinstance(value, bool), f'{path} expected boolean'
    elif t == 'string':
        assert isinstance(value, str), f'{path} expected string'
        if isinstance(schema.get('minLength'), int):
            assert len(value) >= schema['minLength']
        if isinstance(schema.get('maxLength'), int):
            assert len(value) <= schema['maxLength']
        if schema.get('pattern'):
            assert re.search(schema['pattern'], value), f'{path} pattern mismatch'
    if t in ('integer', 'number') and isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(schema.get('minimum'), (int, float)):
            assert value >= schema['minimum']
        if isinstance(schema.get('maximum'), (int, float)):
            assert value <= schema['maximum']

def assert_idempotent(first, repeat):
    assert repeat.status_code == first.status_code, 'idempotent repeat changed status'
    try:
        assert strip_volatile(repeat.json()) == strip_volatile(first.json()), 'idempotent repeat changed body'
    except ValueError:
        pass

def request_with_retry(**kwargs):
    attempt = 0
    while True:
        resp = requests.request(**kwargs)
        if resp.status_code not in _RETRYABLE or attempt >= _MAX_RETRIES:
            return resp
        retry_after = resp.headers.get('retry-after')
        delay = float(retry_after) if retry_after and retry_after.replace('.', '', 1).isdigit() else 0.25 * (2 ** attempt)
        time.sleep(delay)
        attempt += 1`;

const pyLiteral = (value: unknown): string =>
  JSON.stringify(value ?? null)
    .replace(/\btrue\b/g, 'True')
    .replace(/\bfalse\b/g, 'False')
    .replace(/\bnull\b/g, 'None');

const pyAssertLine = (a: BodyAssertion, actual: string): string => {
  const v = pyLiteral(a.value);
  switch (a.op) {
    case 'exists':
      return `assert ${actual} is not None`;
    case 'absent':
      return `assert ${actual} is None`;
    case 'equals':
      return `assert ${actual} == ${v}`;
    case 'type':
      return `assert json_type(${actual}) == ${v}`;
    case 'contains':
      return `assert ${v} in (${actual} or [])`;
    case 'matches':
      return `assert re.search(${v}, str(${actual}))`;
    case 'gt':
      return `assert float(${actual}) > float(${v})`;
    case 'gte':
      return `assert float(${actual}) >= float(${v})`;
    case 'lt':
      return `assert float(${actual}) < float(${v})`;
    case 'lte':
      return `assert float(${actual}) <= float(${v})`;
    case 'in':
      return `assert ${actual} in ${v}`;
    case 'length':
      return `assert len(${actual} or []) == int(${v})`;
    default:
      return `pass`;
  }
};

export const renderBodyAssertionsPy = (testCase: GeneratedTestCase, bodyVar: string, indent: string): string => {
  const assertions = jsonAssertions(testCase);
  const contractNotes = contractCommentLines(testCase, `${indent}#`);
  if (!assertions.length) {
    return [`${indent}# No body assertions provided`, ...contractNotes].join('\n');
  }
  const lines = assertions.map((a) => {
    const actual = `get_by_path(${bodyVar}, ${JSON.stringify(a.path)})`;
    const desc = a.description ? `${indent}# ${a.description.replace(/\s+/g, ' ').trim()}\n` : '';
    return `${desc}${indent}${pyAssertLine(a, actual)}`;
  });
  return [...lines, ...contractNotes].join('\n');
};

// ---------------------------------------------------------------------------
// Go and Java emit assertions as documented expectations plus the generic JSON-path
// check helpers from their preambles. Body-assertion support for Go/Java is rendered
// as comments (their HTTP harness is more bespoke); schema/idempotency assertions are
// still executed via the status/contract helpers already present in those renderers.
// ---------------------------------------------------------------------------

export const renderBodyAssertionsComment = (testCase: GeneratedTestCase, prefix: string): string => {
  const assertions = jsonAssertions(testCase);
  const lines = [
    ...assertions.map((a) => `${prefix} assert ${a.path || '<root>'} ${a.op}${a.value !== undefined ? ' ' + JSON.stringify(a.value) : ''}`),
    ...contractCommentLines(testCase, prefix)
  ];
  return lines.length ? lines.join('\n') : `${prefix} No body assertions provided`;
};
