import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.{ts,tsx}'],
    // React component tests run under happy-dom; everything else stays on node.
    environmentMatchGlobs: [['tests/**/*.test.tsx', 'happy-dom']],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/shared/types.ts',
        'src/shared/messages.ts',
        'src/**/main.tsx',
        'src/popup/runtime.ts'
      ]
    }
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@background': resolve(__dirname, 'src/background'),
      '@popup': resolve(__dirname, 'src/popup')
    }
  }
});
