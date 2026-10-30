import { describe, expect, it } from 'vitest';
// The native-messaging host is a standalone ESM script. It guards all stdin/process wiring
// behind an `isMain` check, so importing it here only pulls in the pure helpers.
import {
  isValidPort,
  isPathInsideDir,
  decodeFrames,
  portFromLogLine,
  findFreePort,
  isPortOpen
} from '../../native-host/apitiser-runner.mjs';
import { createServer } from 'node:net';

const frame = (obj: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  return Buffer.concat([len, body]);
};

describe('native host — isValidPort', () => {
  it('accepts ports in [1, 65535] and rejects the rest', () => {
    expect(isValidPort(8080)).toBe(true);
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(70000)).toBe(false);
    expect(isValidPort(3.5)).toBe(false);
    expect(isValidPort(NaN)).toBe(false);
  });
});

describe('native host — isPathInsideDir', () => {
  it('accepts paths inside the root', () => {
    expect(isPathInsideDir('/suite', 'a/b.test.js')).toBe(true);
    expect(isPathInsideDir('/suite', 'nested/deep/file.js')).toBe(true);
  });

  it('rejects traversal and absolute escapes', () => {
    expect(isPathInsideDir('/suite', '../evil.js')).toBe(false);
    expect(isPathInsideDir('/suite', '../../etc/passwd')).toBe(false);
    expect(isPathInsideDir('/suite', '/etc/passwd')).toBe(false);
  });
});

describe('native host — decodeFrames', () => {
  it('decodes multiple whole frames and leaves no remainder', () => {
    const buf = Buffer.concat([frame({ type: 'ping' }), frame({ type: 'shutdown' })]);
    const { messages, rest, error } = decodeFrames(buf);
    expect(error).toBeUndefined();
    expect(messages).toEqual([{ type: 'ping' }, { type: 'shutdown' }]);
    expect(rest.length).toBe(0);
  });

  it('keeps a partial trailing frame in the remainder', () => {
    const whole = frame({ type: 'ping' });
    const partial = frame({ type: 'boot' }).subarray(0, 5); // header + 1 byte
    const { messages, rest } = decodeFrames(Buffer.concat([whole, partial]));
    expect(messages).toEqual([{ type: 'ping' }]);
    expect(rest.length).toBe(5);
  });

  it('flags an oversized frame and drops the buffer', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(5_000_000, 0); // exceeds default 1 MB cap
    const { messages, rest, error } = decodeFrames(Buffer.concat([header, Buffer.from('x')]));
    expect(error).toBe('oversized');
    expect(messages).toEqual([]);
    expect(rest.length).toBe(0);
  });

  it('flags a malformed (non-JSON) frame', () => {
    const body = Buffer.from('not json', 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(body.length, 0);
    const { error } = decodeFrames(Buffer.concat([len, body]));
    expect(error).toBe('malformed');
  });
});

describe('portFromLogLine', () => {
  it.each([
    ['sample-api listening on 4789', 4789],
    ['INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)', 8000],
    ['  ➜  Local:   http://localhost:5173/', 5173],
    ['Tomcat started on port 8081 (http)', 8081],
    ['Listening at 9000', 9000],
    ['Connected to mongodb://localhost:27017', undefined],
    ['connecting to http://localhost:9200', undefined],
    ['Redis ready on port 6379', undefined],
    ['GET /users 200 12ms', undefined]
  ])('%s → %s', (line, port) => {
    expect(portFromLogLine(line)).toBe(port);
  });
});

describe('port probing', () => {
  it('finds a free port and sees it open once something listens there', async () => {
    const port = await findFreePort();
    expect(isValidPort(port)).toBe(true);
    expect(await isPortOpen(port)).toBe(false);

    const server = createServer();
    await new Promise<void>((resolve) => server.listen(port, resolve));
    try {
      expect(await isPortOpen(port)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
