import { describe, expect, it } from 'vitest';
import { parseGraphQLEndpoints } from '@background/parser/languages/graphql';
import type { RepoFile } from '@shared/types';

const makeFile = (path: string, content: string): RepoFile => ({ path, content });

describe('parseGraphQLEndpoints', () => {
  it('emits one POST /graphql endpoint per Query and Mutation field', () => {
    const file = makeFile(
      'schema.graphql',
      `
type Query {
  user(id: ID!): User
  users: [User!]!
}

type Mutation {
  createUser(input: CreateUserInput!): User
}

type User { id: ID! name: String }
`
    );

    const endpoints = parseGraphQLEndpoints([file]);
    expect(endpoints).toHaveLength(3);
    expect(endpoints.every((e) => e.method === 'POST' && e.path === '/graphql')).toBe(true);
    expect(endpoints.every((e) => e.source === 'graphql')).toBe(true);

    const opIds = endpoints.map((e) => e.operationId).sort();
    expect(opIds).toEqual(['createUser', 'user', 'users']);

    // Distinct endpoint ids so they don't collapse in canonicalization.
    expect(new Set(endpoints.map((e) => e.id)).size).toBe(3);

    const createUser = endpoints.find((e) => e.operationId === 'createUser');
    expect(createUser?.summary).toContain('mutation');
    expect(createUser?.body?.required).toContain('query');
    expect(JSON.stringify(createUser?.examples?.[0]?.request?.body)).toContain('mutation { createUser }');
  });

  it('detects inline SDL embedded in a .ts file', () => {
    const file = makeFile(
      'schema.ts',
      `export const typeDefs = gql\`
        type Query {
          health: String
        }
      \`;`
    );
    const endpoints = parseGraphQLEndpoints([file]);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].operationId).toBe('health');
  });

  it('ignores files with no GraphQL schema', () => {
    const file = makeFile('app.ts', `export const x = 1;`);
    expect(parseGraphQLEndpoints([file])).toHaveLength(0);
  });
});
