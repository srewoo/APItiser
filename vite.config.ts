import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@background': resolve(__dirname, 'src/background'),
      '@popup': resolve(__dirname, 'src/popup')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    modulePreload: false,
    chunkSizeWarningLimit: 1000,
    // Force CommonJS deps (@babel/*, yaml) to initialize lazily and in dependency order.
    // Without this, their circular requires can run a module's interop before its exports
    // object exists → "Object.defineProperty called on non-object", which fails service-worker
    // registration (the failure point shifts with chunking, so it's intermittent otherwise).
    commonjsOptions: { strictRequires: true },
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        sidepanel: resolve(__dirname, 'sidepanel.html'),
        help: resolve(__dirname, 'help.html'),
        privacypolicy: resolve(__dirname, 'privacypolicy.html'),
        'service-worker': resolve(__dirname, 'src/background/service-worker.ts')
      },
      output: {
        entryFileNames: (chunkInfo) =>
          chunkInfo.name === 'service-worker' ? 'service-worker.js' : 'assets/[name].js',
        chunkFileNames: 'assets/chunk-[name].js',
        assetFileNames: 'assets/[name][extname]',
        manualChunks: (id) => {
          if (id.includes('/src/background/parser/')) return 'bg-parser';
          if (id.includes('/src/background/generation/')) return 'bg-generation';
          if (id.includes('/src/background/llm/')) return 'bg-llm';
          if (id.includes('/src/background/repo/')) return 'bg-repo';
          return undefined;
        }
      }
    }
  }
});
