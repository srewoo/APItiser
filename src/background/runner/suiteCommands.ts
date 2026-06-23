import type { TestFramework } from '@shared/types';

/**
 * Install + test commands for running an APItiser-generated suite via its own framework
 * runner. Mirrors the support files each renderer emits (package.json / requirements.txt /
 * go.mod / pom.xml), so the downloaded suite runs the same way the host runs it.
 */
export const suiteCommandsFor = (framework: TestFramework): { install?: string; test: string } => {
  switch (framework) {
    case 'jest':
    case 'supertest':
      return { install: 'npm install', test: 'npx jest tests' };
    case 'vitest':
      return { install: 'npm install', test: 'npx vitest run' };
    case 'mocha':
      return { install: 'npm install', test: 'npx mocha "tests/**/*.spec.js"' };
    case 'pytest':
      return { install: 'pip install -r requirements.txt', test: 'pytest -q tests' };
    case 'gotest':
      return { install: 'go mod download', test: 'go test ./...' };
    case 'restassured':
      return { test: 'mvn -q test' };
    case 'playwright':
      return { install: 'npm install', test: 'npx playwright test' };
    default:
      return { test: 'echo "No runner mapped for this framework" && exit 1' };
  }
};
