import { defineConfig } from 'vitest/config';

// Short build identifier shown in the UI so the owner can tell which version
// is loaded on the phone. CI sets GITHUB_SHA; locally we fall back to "dev".
const buildId = (process.env.GITHUB_SHA ?? 'dev').slice(0, 7);
const buildTime = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

export default defineConfig({
  // Relative asset paths so the site works under a GitHub Pages sub-path
  // (https://<user>.github.io/Music-App/).
  base: './',
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  worker: {
    // The AudioWorklet module is bundled through Vite's worker pipeline
    // (see src/audio/mic.ts). It must be a single self-contained file.
    format: 'es',
  },
  build: {
    target: 'es2020',
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
