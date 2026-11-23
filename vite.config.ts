import { defineConfig, type UserConfig } from 'vite';

import { oxcIsolatedDtsAndMinifyPlugin } from './scripts/oxc-build-plugins.ts';

const config: UserConfig = defineConfig({
  plugins: [oxcIsolatedDtsAndMinifyPlugin()],
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    rolldownOptions: {
      input: {
        hud: 'src/hud-entry.ts',
        cli: 'src/cli-entry.ts',
        index: 'src/index.ts',
      },
      external: [/^node:/],
      output: {
        entryFileNames: '[name].mjs',
        chunkFileNames: 'chunks/[name]-[hash].mjs',
        format: 'esm',
      },
    },
  },
});

export default config;
