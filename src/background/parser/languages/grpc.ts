import type { ApiEndpoint, RepoFile, SchemaField } from '@shared/types';
import { buildEndpoint, makeBodySchema, makeEvidence } from '../endpointBuilder';

/**
 * gRPC / Protocol Buffers detection. Plain gRPC is not HTTP-testable, but the near-universal
 * transcoding conventions (gRPC-JSON transcoding, gRPC-web, Connect) expose every unary/streaming
 * RPC as `POST /<package>.<Service>/<Method>` with a JSON-encoded request message body. We surface
 * each `rpc` in every `service` so the generator can exercise them individually.
 *
 * This is a lightweight `.proto` scan (not a full protobuf compiler): it reads `service`/`rpc`
 * declarations and best-effort resolves the request `message` into a flat body schema. Streaming
 * RPCs still map to POST (Connect/grpc-web unary framing).
 */

const PROTO_SCALAR_TO_JSON: Record<string, { type: string; format?: string }> = {
  double: { type: 'number' },
  float: { type: 'number' },
  int32: { type: 'integer' },
  int64: { type: 'integer' },
  uint32: { type: 'integer' },
  uint64: { type: 'integer' },
  sint32: { type: 'integer' },
  sint64: { type: 'integer' },
  fixed32: { type: 'integer' },
  fixed64: { type: 'integer' },
  sfixed32: { type: 'integer' },
  sfixed64: { type: 'integer' },
  bool: { type: 'boolean' },
  string: { type: 'string' },
  bytes: { type: 'string', format: 'byte' }
};

const looksLikeProto = (file: RepoFile): boolean =>
  /\.proto$/i.test(file.path) || (/\bservice\s+\w+\s*\{/.test(file.content) && /\brpc\s+\w+\s*\(/.test(file.content));

/** Extract the `{ … }` body that follows the header regex match, tolerating nested braces. */
const extractBlockBody = (content: string, headerRegex: RegExp): { body: string; index: number } | null => {
  const match = headerRegex.exec(content);
  if (!match) return null;
  const open = content.indexOf('{', match.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < content.length; i += 1) {
    if (content[i] === '{') depth += 1;
    else if (content[i] === '}') {
      depth -= 1;
      if (depth === 0) return { body: content.slice(open + 1, i), index: match.index };
    }
  }
  return null;
};

const extractPackage = (content: string): string => {
  const match = /\bpackage\s+([A-Za-z0-9_.]+)\s*;/.exec(content);
  return match ? match[1] : '';
};

/** Parse `type name = N;` fields (incl. `repeated`) from a message body. */
const parseMessageFields = (body: string): Array<{ name: string; type?: string; required?: boolean; format?: string }> => {
  const fields: Array<{ name: string; type?: string; required?: boolean; format?: string }> = [];
  // Strip comments to avoid false matches.
  const cleaned = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const line of cleaned.split('\n')) {
    const match = /^\s*(?:(repeated|optional|required)\s+)?([A-Za-z0-9_.]+)\s+([A-Za-z0-9_]+)\s*=\s*\d+\s*;/.exec(line);
    if (!match) continue;
    const [, label, protoType, name] = match;
    if (protoType === 'map' || name === 'reserved') continue;
    const scalar = PROTO_SCALAR_TO_JSON[protoType];
    const jsonType = label === 'repeated' ? 'array' : scalar?.type ?? 'object';
    fields.push({ name, type: jsonType, format: scalar?.format, required: label === 'required' });
  }
  return fields;
};

const collectMessages = (content: string): Map<string, string> => {
  const messages = new Map<string, string>();
  const messageHeader = /\bmessage\s+([A-Za-z0-9_]+)\s*\{/g;
  let header: RegExpExecArray | null;
  while ((header = messageHeader.exec(content)) !== null) {
    const block = extractBlockBody(content.slice(header.index), /\bmessage\s+[A-Za-z0-9_]+\s*\{/);
    if (block) messages.set(header[1], block.body);
  }
  return messages;
};

export const parseGrpcEndpoints = (files: RepoFile[]): ApiEndpoint[] => {
  const endpoints: ApiEndpoint[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (!looksLikeProto(file)) continue;

    const pkg = extractPackage(file.content);
    const messages = collectMessages(file.content);

    const serviceHeader = /\bservice\s+([A-Za-z0-9_]+)\s*\{/g;
    let svc: RegExpExecArray | null;
    while ((svc = serviceHeader.exec(file.content)) !== null) {
      const serviceName = svc[1];
      const block = extractBlockBody(file.content.slice(svc.index), /\bservice\s+[A-Za-z0-9_]+\s*\{/);
      if (!block) continue;

      for (const rpc of block.body.matchAll(
        /\brpc\s+([A-Za-z0-9_]+)\s*\(\s*(?:stream\s+)?([A-Za-z0-9_.]+)\s*\)\s*returns\s*\(\s*(?:stream\s+)?([A-Za-z0-9_.]+)\s*\)/g
      )) {
        const [, methodName, reqType] = rpc;
        const qualifiedService = pkg ? `${pkg}.${serviceName}` : serviceName;
        const path = `/${qualifiedService}/${methodName}`;
        if (seen.has(path)) continue;
        seen.add(path);

        const reqMessageName = reqType.split('.').pop() ?? reqType;
        const fields = parseMessageFields(messages.get(reqMessageName) ?? '');
        const body = makeBodySchema(fields);
        const exampleBody = fields.reduce<Record<string, unknown>>((acc, field) => {
          acc[field.name] = field.type === 'array' ? [] : field.type === 'integer' || field.type === 'number' ? 0 : field.type === 'boolean' ? false : '';
          return acc;
        }, {});

        endpoints.push(
          buildEndpoint({
            method: 'POST',
            path,
            source: 'grpc',
            file,
            operationId: methodName,
            summary: `gRPC ${serviceName}.${methodName}`,
            description: `gRPC unary/streaming RPC ${serviceName}.${methodName}(${reqType}) — exposed over HTTP via gRPC-JSON/Connect transcoding.`,
            confidence: 0.75,
            evidence: [makeEvidence(file, `gRPC ${serviceName}.${methodName}`, file.content.indexOf(`rpc ${methodName}`))],
            body,
            pathParams: [] as SchemaField[],
            responses: [{ status: '200' }, { status: '400' }, { status: '401' }],
            examples: [
              {
                origin: 'code',
                request: { headers: { 'Content-Type': 'application/json' }, body: exampleBody },
                note: `Connect/grpc-web unary call. Request message: ${reqMessageName}.`
              }
            ]
          })
        );
      }
    }
  }

  return endpoints;
};
