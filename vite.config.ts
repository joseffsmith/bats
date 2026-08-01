import { defineConfig } from 'vite';

export default defineConfig({
  // Commit sha stamped into replay-log headers so a captured game can be
  // replayed against the engine version that produced it. CI passes BUILD_SHA
  // as a docker build arg; local dev builds record 'dev'.
  define: {
    __BUILD_SHA__: JSON.stringify(process.env.BUILD_SHA ?? 'dev'),
  },
  server: {
    port: 5173,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
