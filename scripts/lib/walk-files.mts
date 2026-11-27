import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  '.cache',
  '.scratch',
  '.agents',
  '.workbench',
]);

export interface WalkFilesOptions {
  skipDirs?: ReadonlySet<string>;
  skipRelDirs?: ReadonlySet<string>;
  includeFile: (relPosix: string, name: string) => boolean;
}

export function walkFiles(dir: string, resolvedRoot: string, opts: WalkFilesOptions, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  const skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(resolvedRoot, abs).split(path.sep).join('/');
      if (opts.skipRelDirs?.has(rel)) continue;
      walkFiles(abs, resolvedRoot, opts, out);
    } else if (entry.isFile()) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(resolvedRoot, abs).split(path.sep).join('/');
      if (opts.includeFile(rel, entry.name)) out.push(abs);
    }
  }
  return out;
}
