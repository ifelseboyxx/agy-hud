import path from 'node:path';

import { defineConfig, type BuildEnvironmentOptions, type InlineConfig, type LogLevel, type UserConfig } from 'vite';

import { oxcIsolatedDtsAndMinifyPlugin } from './scripts/oxc-build-plugins.ts';

export const HUD_ENTRY_INPUT: Readonly<Record<string, string>> = {
  hud: 'src/hud-entry.ts',
};

export const SHARED_ENTRY_INPUTS: Readonly<Record<string, string>> = {
  cli: 'src/cli-entry.ts',
  index: 'src/index.ts',
};

export interface ViteBuildPassOptions {
  readonly rootDir?: string;
  readonly outDir: string;
  readonly input: Readonly<Record<string, string>>;
  readonly emitDts?: boolean;
  readonly codeSplitting?: boolean;
  readonly logLevel?: LogLevel;
}

function createRolldownBuildOptions(
  outDir: string,
  input: Readonly<Record<string, string>>,
  options: { readonly rootDir?: string; readonly codeSplitting?: boolean } = {},
): BuildEnvironmentOptions {
  const resolvedRoot = options.rootDir !== undefined ? path.resolve(options.rootDir) : undefined;
  const resolvedInput = Object.fromEntries(
    Object.entries(input).map(([name, entryPath]) => [
      name,
      resolvedRoot !== undefined ? path.resolve(resolvedRoot, entryPath) : entryPath,
    ]),
  );
  return {
    ssr: true,
    target: 'node22',
    outDir,
    emptyOutDir: false,
    minify: false,
    rolldownOptions: {
      input: resolvedInput,
      external: [/^node:/],
      output: {
        entryFileNames: '[name].mjs',
        chunkFileNames: 'chunks/[name]-[hash].mjs',
        format: 'esm',
        ...(options.codeSplitting === false ? { codeSplitting: false } : {}),
      },
    },
  };
}

export function createViteBuildConfig(options: ViteBuildPassOptions): InlineConfig {
  return {
    configFile: false,
    root: options.rootDir,
    logLevel: options.logLevel,
    plugins: [oxcIsolatedDtsAndMinifyPlugin({ emitDts: options.emitDts })],
    build: createRolldownBuildOptions(options.outDir, options.input, {
      rootDir: options.rootDir,
      codeSplitting: options.codeSplitting,
    }),
  };
}

const STANDALONE_VITE_OUT_DIR = '.cache/vite-standalone';

const config: UserConfig = defineConfig({
  plugins: [oxcIsolatedDtsAndMinifyPlugin()],
  build: createRolldownBuildOptions(STANDALONE_VITE_OUT_DIR, { ...HUD_ENTRY_INPUT, ...SHARED_ENTRY_INPUTS }),
});

export default config;
