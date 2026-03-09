import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        include: ['tests/**/*.test.ts']
    },
    resolve: {
        alias: {
            '@shared': resolve(__dirname, 'src/shared'),
            '@background': resolve(__dirname, 'src/background'),
            '@popup': resolve(__dirname, 'src/popup')
        }
    }
});
