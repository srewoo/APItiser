import { describe, expect, it } from 'vitest';
import { parseGrpcEndpoints } from '@background/parser/languages/grpc';
import type { RepoFile } from '@shared/types';

const makeFile = (path: string, content: string): RepoFile => ({ path, content });

describe('parseGrpcEndpoints', () => {
  it('emits POST /<package>.<Service>/<Method> for each rpc with a request-message body', () => {
    const file = makeFile(
      'user.proto',
      `syntax = "proto3";
package acme.users.v1;

message GetUserRequest {
  string id = 1;
  bool include_deleted = 2;
}

message ListUsersRequest {
  int32 page = 1;
  repeated string tags = 2;
}

message User { string id = 1; }

service UserService {
  rpc GetUser (GetUserRequest) returns (User);
  rpc ListUsers (ListUsersRequest) returns (stream User);
}
`
    );

    const endpoints = parseGrpcEndpoints([file]);
    expect(endpoints).toHaveLength(2);
    expect(endpoints.every((e) => e.method === 'POST' && e.source === 'grpc')).toBe(true);

    const get = endpoints.find((e) => e.operationId === 'GetUser');
    expect(get?.path).toBe('/acme.users.v1.UserService/GetUser');
    expect(get?.body?.properties?.id).toBeDefined();
    expect((get?.body?.properties?.include_deleted as { type: string }).type).toBe('boolean');

    const list = endpoints.find((e) => e.operationId === 'ListUsers');
    expect(list?.path).toBe('/acme.users.v1.UserService/ListUsers');
    // repeated → array
    expect((list?.body?.properties?.tags as { type: string }).type).toBe('array');
    expect((list?.body?.properties?.page as { type: string }).type).toBe('integer');
  });

  it('works without a package declaration', () => {
    const file = makeFile(
      'svc.proto',
      `message PingRequest { string msg = 1; }
service Health { rpc Ping (PingRequest) returns (PingRequest); }`
    );
    const endpoints = parseGrpcEndpoints([file]);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].path).toBe('/Health/Ping');
  });

  it('ignores non-proto files', () => {
    expect(parseGrpcEndpoints([makeFile('app.ts', 'const x = 1;')])).toHaveLength(0);
  });
});
