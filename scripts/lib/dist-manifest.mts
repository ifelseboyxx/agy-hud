export const EXPECTED_DIST_FILES: readonly string[] = ['cli.mjs', 'hud.mjs', 'index.d.mts', 'index.mjs', 'types.d.mts'];

export const EXECUTABLE_DIST_FILES: readonly string[] = ['cli.mjs', 'hud.mjs'];

export const EXECUTABLE_REPO_PATHS: readonly string[] = [
  ...EXECUTABLE_DIST_FILES.map((file) => `dist/${file}`),
  'scripts/install.mjs',
];
