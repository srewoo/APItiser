import type { TestFramework, TestFrameworkAdapter } from '@shared/types';
import { JestFrameworkAdapter } from './jest';
import { MochaFrameworkAdapter } from './mocha';
import { PytestFrameworkAdapter } from './pytest';

const adapters: Record<TestFramework, TestFrameworkAdapter> = {
  jest: new JestFrameworkAdapter(),
  mocha: new MochaFrameworkAdapter(),
  pytest: new PytestFrameworkAdapter()
};

export const getFrameworkAdapter = (framework: TestFramework): TestFrameworkAdapter => adapters[framework];
