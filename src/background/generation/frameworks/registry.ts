import type { TestFramework, TestFrameworkAdapter } from '@shared/types';
import { JestFrameworkAdapter } from './jest';
import { MochaFrameworkAdapter } from './mocha';
import { PytestFrameworkAdapter } from './pytest';
import { SupertestFrameworkAdapter } from './supertest';
import { GoTestFrameworkAdapter } from './gotest';
import { RestAssuredFrameworkAdapter } from './restassured';

const adapters: Record<TestFramework, TestFrameworkAdapter> = {
  jest: new JestFrameworkAdapter(),
  mocha: new MochaFrameworkAdapter(),
  pytest: new PytestFrameworkAdapter(),
  supertest: new SupertestFrameworkAdapter(),
  gotest: new GoTestFrameworkAdapter(),
  restassured: new RestAssuredFrameworkAdapter()
};

export const getFrameworkAdapter = (framework: TestFramework): TestFrameworkAdapter => adapters[framework];
