import path from 'node:path';

import type { ParseResult } from 'oxc-parser';
import type { ResolverFactory } from 'oxc-resolver';

import { toPosixPath } from '../../src/core/paths.ts';

export const PUBLIC_EXPORT_ENTRIES: ReadonlySet<string> = new Set([
  'src/index.ts',
  'src/cli-entry.ts',
  'src/hud-entry.ts',
]);

export function isUnusedExportScanTarget(relPosix: string): boolean {
  return relPosix.startsWith('src/') && !relPosix.includes('/__tests__/') && !PUBLIC_EXPORT_ENTRIES.has(relPosix);
}

export interface UnusedExportsTracker {
  recordFile(
    rootDir: string,
    fullPath: string,
    relPosix: string,
    parsed: ParseResult,
    dynamicRelativeSpecifiers: ReadonlySet<string>,
    resolver: ResolverFactory,
  ): void;
  collectErrors(): string[];
}

function resolveTargetRel(
  rootDir: string,
  fullPath: string,
  specifier: string,
  resolver: ResolverFactory,
): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const resolved = resolver.resolveFileSync(fullPath, specifier);
  if (resolved.error || !resolved.path || !resolved.path.startsWith(rootDir)) return null;
  return toPosixPath(path.relative(rootDir, resolved.path));
}

function addUsedExport(usedByTarget: Map<string, Set<string>>, targetRel: string, name: string): void {
  let names = usedByTarget.get(targetRel);
  if (!names) {
    names = new Set<string>();
    usedByTarget.set(targetRel, names);
  }
  names.add(name);
}

export function createUnusedExportsTracker(): UnusedExportsTracker {
  const exportedByFile = new Map<string, Set<string>>();
  const usedByTarget = new Map<string, Set<string>>();
  const starAllTargets = new Set<string>();
  const starNamedTargets = new Set<string>();

  return {
    recordFile(rootDir, fullPath, relPosix, parsed, dynamicRelativeSpecifiers, resolver): void {
      if (isUnusedExportScanTarget(relPosix)) {
        const names = new Set<string>();
        for (const exp of parsed.module.staticExports) {
          for (const entry of exp.entries) {
            if (entry.isType) continue;
            if (entry.exportName.kind === 'Default') {
              names.add('default');
            } else if (entry.exportName.kind === 'Name' && entry.exportName.name !== null) {
              names.add(entry.exportName.name);
            }
          }
        }
        if (names.size > 0) exportedByFile.set(relPosix, names);
      }

      for (const imp of parsed.module.staticImports) {
        const targetRel = resolveTargetRel(rootDir, fullPath, imp.moduleRequest.value, resolver);
        if (targetRel === null) continue;
        for (const entry of imp.entries) {
          if (entry.importName.kind === 'NamespaceObject') {
            starAllTargets.add(targetRel);
          } else if (entry.importName.kind === 'Default') {
            addUsedExport(usedByTarget, targetRel, 'default');
          } else if (entry.importName.kind === 'Name' && entry.importName.name !== null) {
            addUsedExport(usedByTarget, targetRel, entry.importName.name);
          }
        }
      }

      for (const exp of parsed.module.staticExports) {
        for (const entry of exp.entries) {
          const spec = entry.moduleRequest?.value;
          if (!spec) continue;
          const targetRel = resolveTargetRel(rootDir, fullPath, spec, resolver);
          if (targetRel === null) continue;
          if (entry.importName.kind === 'All') {
            starAllTargets.add(targetRel);
          } else if (entry.importName.kind === 'AllButDefault') {
            starNamedTargets.add(targetRel);
          } else if (entry.importName.kind === 'Name' && entry.importName.name !== null) {
            addUsedExport(usedByTarget, targetRel, entry.importName.name);
          }
        }
      }

      for (const spec of dynamicRelativeSpecifiers) {
        const targetRel = resolveTargetRel(rootDir, fullPath, spec, resolver);
        if (targetRel !== null) starAllTargets.add(targetRel);
      }
    },

    collectErrors(): string[] {
      const errors: string[] = [];
      for (const [relPosix, exportedNames] of [...exportedByFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (starAllTargets.has(relPosix)) continue;
        const namedStarred = starNamedTargets.has(relPosix);
        const used = usedByTarget.get(relPosix);
        for (const name of [...exportedNames].sort()) {
          if (namedStarred && name !== 'default') continue;
          if (!used?.has(name)) {
            errors.push(
              `${relPosix}: unused export '${name}' (not imported anywhere; remove 'export' or delete dead code)`,
            );
          }
        }
      }
      return errors;
    },
  };
}
