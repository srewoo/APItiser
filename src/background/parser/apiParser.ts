import type { ApiEndpoint, RepoFile } from '@shared/types';
import { parseCodeRoutes } from './codeRouteParser';
import { parseOpenApiSpecs } from './openApiParser';
import { parseGraphQLEndpoints } from './languages/graphql';
import { parseGrpcEndpoints } from './languages/grpc';
import { parseTrpcEndpoints } from './languages/trpc';
import { parseRailsRoutes } from './languages/ruby';
import { parsePhpEndpoints } from './languages/php';
import { canonicalizeEndpoints } from './canonicalize';

export const parseApiMap = (files: RepoFile[]): ApiEndpoint[] => {
  let codeEndpoints: ApiEndpoint[] = [];
  let openApiEndpoints: ApiEndpoint[] = [];
  let graphqlEndpoints: ApiEndpoint[] = [];
  let grpcEndpoints: ApiEndpoint[] = [];
  let trpcEndpoints: ApiEndpoint[] = [];
  let railsEndpoints: ApiEndpoint[] = [];
  let phpEndpoints: ApiEndpoint[] = [];

  try {
    codeEndpoints = parseCodeRoutes(files);
  } catch (error) {
    console.warn('[APItiser] Code route parsing failed during scan.', error);
  }

  try {
    openApiEndpoints = parseOpenApiSpecs(files);
  } catch (error) {
    console.warn('[APItiser] OpenAPI parsing failed during scan.', error);
  }

  try {
    graphqlEndpoints = parseGraphQLEndpoints(files);
  } catch (error) {
    console.warn('[APItiser] GraphQL parsing failed during scan.', error);
  }

  try {
    grpcEndpoints = parseGrpcEndpoints(files);
  } catch (error) {
    console.warn('[APItiser] gRPC parsing failed during scan.', error);
  }

  try {
    trpcEndpoints = parseTrpcEndpoints(files);
  } catch (error) {
    console.warn('[APItiser] tRPC parsing failed during scan.', error);
  }

  try {
    railsEndpoints = parseRailsRoutes(files);
  } catch (error) {
    console.warn('[APItiser] Rails parsing failed during scan.', error);
  }

  try {
    phpEndpoints = parsePhpEndpoints(files);
  } catch (error) {
    console.warn('[APItiser] PHP parsing failed during scan.', error);
  }

  return canonicalizeEndpoints(
    [
      ...openApiEndpoints,
      ...codeEndpoints,
      ...graphqlEndpoints,
      ...grpcEndpoints,
      ...trpcEndpoints,
      ...railsEndpoints,
      ...phpEndpoints
    ],
    files
  );
};
