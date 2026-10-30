/**
 * "Start it yourself" guidance: the dev-server command for the detected stack, pinned to a port
 * we choose (3000/8000/8080 are usually taken). Heuristic by design (ponytail: per-framework
 * defaults; read package.json scripts / Procfile if users report wrong commands). POSIX env
 * syntax — Windows users adapt `PORT=…`.
 */
import type { EndpointSource } from './types';

export type StartCommand = (port: number) => string;

const node: StartCommand = (port) => `PORT=${port} npm run dev   # or: PORT=${port} npm start`;
const go: StartCommand = (port) => `PORT=${port} go run .`;

const BY_SOURCE: Partial<Record<EndpointSource, StartCommand>> = {
  express: node,
  fastify: node,
  koa: node,
  hono: node,
  trpc: node,
  nextjs: (port) => `npm run dev -- -p ${port}`,
  nestjs: (port) => `PORT=${port} npm run start:dev`,
  fastapi: (port) => `uvicorn main:app --reload --port ${port}`,
  flask: (port) => `flask run --port ${port}`,
  django: (port) => `python manage.py runserver ${port}`,
  spring: (port) => `SERVER_PORT=${port} ./mvnw spring-boot:run   # or: SERVER_PORT=${port} ./gradlew bootRun`,
  jaxrs: (port) => `./mvnw quarkus:dev -Dquarkus.http.port=${port}`,
  gin: go,
  chi: go,
  echo: go,
  mux: go,
  nethttp: go,
  rails: (port) => `bin/rails server -p ${port}`,
  laravel: (port) => `php artisan serve --port ${port}`,
  symfony: (port) => `symfony server:start --port=${port}`
};

/** The most common code-route source wins; spec-only sources (OpenAPI/GraphQL/gRPC) say nothing. */
export const suggestStartCommand = (sources: EndpointSource[]): StartCommand | undefined => {
  const counts = new Map<EndpointSource, number>();
  for (const source of sources) {
    if (BY_SOURCE[source]) counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return top ? BY_SOURCE[top] : undefined;
};

/** A random port in an uncrowded range (above the usual 3000/5000/8000/8080 dev ports). */
export const randomDevPort = (random: () => number = Math.random): number => 40000 + Math.floor(random() * 9000);
