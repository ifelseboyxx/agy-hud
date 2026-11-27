export type SrcArchLayer =
  | 'types'
  | 'core-pure'
  | 'core-fs'
  | 'render'
  | 'collectors'
  | 'hud'
  | 'cli'
  | 'entrypoints'
  | 'public-index';

export const CORE_FS_MODULES: ReadonlySet<string> = new Set([
  'src/core/fs-utils.ts',
  'src/core/file-lock.ts',
  'src/core/safe-path.ts',
  'src/core/statusline-ownership.ts',
]);

export const PURE_PREVIEW_MODULES: ReadonlySet<string> = new Set(['src/cli/configure-tui-render.ts']);

export const FORBIDDEN_PURE_RUNTIME_BUILTINS: ReadonlySet<string> = new Set([
  'node:child_process',
  'child_process',
  'node:sqlite',
  'node:fs',
  'fs',
]);

const ALLOWED_LAYER_TARGETS: Readonly<Record<SrcArchLayer, ReadonlySet<SrcArchLayer>>> = {
  types: new Set<SrcArchLayer>(['types']),
  'core-pure': new Set<SrcArchLayer>(['types', 'core-pure']),
  'core-fs': new Set<SrcArchLayer>(['types', 'core-pure', 'core-fs']),
  render: new Set<SrcArchLayer>(['types', 'core-pure', 'render']),
  collectors: new Set<SrcArchLayer>(['types', 'core-pure', 'core-fs', 'collectors']),
  hud: new Set<SrcArchLayer>(['types', 'core-pure', 'core-fs', 'collectors', 'render', 'hud']),
  cli: new Set<SrcArchLayer>(['types', 'core-pure', 'core-fs', 'collectors', 'render', 'cli']),
  entrypoints: new Set<SrcArchLayer>(['types', 'core-pure', 'core-fs', 'collectors', 'render', 'hud', 'cli']),
  'public-index': new Set<SrcArchLayer>([
    'types',
    'core-pure',
    'core-fs',
    'collectors',
    'render',
    'hud',
    'cli',
    'entrypoints',
  ]),
};

export interface SrcModuleGraphNode {
  readonly allDeps: Set<string>;
  readonly runtimeDeps: Set<string>;
  readonly runtimeBuiltins: Set<string>;
}

export function classifySrcLayer(relPosix: string): SrcArchLayer | null {
  if (!relPosix.startsWith('src/') || relPosix.includes('/__tests__/')) {
    return null;
  }
  if (relPosix === 'src/index.ts') return 'public-index';
  if (relPosix === 'src/hud-entry.ts' || relPosix === 'src/cli-entry.ts') return 'entrypoints';
  if (relPosix === 'src/hud-runner.ts' || relPosix === 'src/hud-snapshot-publish.ts') return 'hud';
  if (
    relPosix === 'src/types.ts' ||
    relPosix === 'src/snapshot-types.ts' ||
    /^src\/[a-z-]+-types\.ts$/.test(relPosix)
  ) {
    return 'types';
  }
  if (CORE_FS_MODULES.has(relPosix)) return 'core-fs';
  if (relPosix.startsWith('src/core/')) return 'core-pure';
  if (relPosix.startsWith('src/render/')) return 'render';
  if (relPosix.startsWith('src/collectors/')) return 'collectors';
  if (relPosix.startsWith('src/cli/')) return 'cli';
  return null;
}

export function isAllowedLayerEdge(fromLayer: SrcArchLayer, toLayer: SrcArchLayer): boolean {
  return ALLOWED_LAYER_TARGETS[fromLayer].has(toLayer);
}

function isPureRoot(relPosix: string): boolean {
  return (
    (relPosix.startsWith('src/render/') && !relPosix.includes('/__tests__/')) || PURE_PREVIEW_MODULES.has(relPosix)
  );
}

function isAllowedPureRuntimeTarget(root: string, target: string): boolean {
  if (target === root) return true;
  const layer = classifySrcLayer(target);
  return layer === 'render' || layer === 'core-pure';
}

export function findLayerMatrixErrors(nodes: ReadonlyMap<string, SrcModuleGraphNode>): string[] {
  const errors: string[] = [];
  for (const from of [...nodes.keys()].sort()) {
    const fromLayer = classifySrcLayer(from);
    if (fromLayer === null) continue;
    const node = nodes.get(from);
    if (!node) continue;
    if (fromLayer === 'core-pure') {
      for (const builtin of [...node.runtimeBuiltins].sort()) {
        if (FORBIDDEN_PURE_RUNTIME_BUILTINS.has(builtin)) {
          errors.push(`${from} (core-pure): forbidden runtime builtin '${builtin}'`);
        }
      }
    }
    for (const to of [...node.allDeps].sort()) {
      const toLayer = classifySrcLayer(to);
      if (toLayer === null) continue;
      if (!isAllowedLayerEdge(fromLayer, toLayer)) {
        errors.push(`${from} (${fromLayer}): forbidden layer import -> ${to} (${toLayer})`);
      }
    }
  }
  return errors;
}

export function findTransitivePurityErrors(nodes: ReadonlyMap<string, SrcModuleGraphNode>): string[] {
  const errors: string[] = [];
  const roots = [...nodes.keys()].filter(isPureRoot).sort();

  for (const root of roots) {
    const parent = new Map<string, string | null>([[root, null]]);
    const queue: string[] = [root];
    const reported = new Set<string>();

    const tracePath = (end: string): string => {
      const chain: string[] = [end];
      let cur = parent.get(end) ?? null;
      while (cur !== null) {
        chain.push(cur);
        cur = parent.get(cur) ?? null;
      }
      return chain.reverse().join(' -> ');
    };

    while (queue.length > 0) {
      const cur = queue.shift()!;
      const node = nodes.get(cur);
      if (!node) continue;

      for (const builtin of [...node.runtimeBuiltins].sort()) {
        if (!FORBIDDEN_PURE_RUNTIME_BUILTINS.has(builtin)) continue;
        const key = `builtin:${cur}:${builtin}`;
        if (reported.has(key)) continue;
        reported.add(key);
        errors.push(
          `${root}: pure render closure reaches forbidden runtime builtin '${builtin}' via ${tracePath(cur)}`,
        );
      }

      for (const dep of [...node.runtimeDeps].sort()) {
        if (!isAllowedPureRuntimeTarget(root, dep)) {
          const key = `target:${dep}`;
          if (!reported.has(key)) {
            reported.add(key);
            errors.push(`${root}: pure render closure reaches impure module '${dep}' via ${tracePath(cur)} -> ${dep}`);
          }
          continue;
        }
        if (!parent.has(dep)) {
          parent.set(dep, cur);
          queue.push(dep);
        }
      }
    }
  }
  return errors;
}

export function findDependencyCycleErrors(nodes: ReadonlyMap<string, SrcModuleGraphNode>): string[] {
  const sortedKeys = [...nodes.keys()].sort();
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  const strongConnect = (v: string): void => {
    indices.set(v, nextIndex);
    lowlinks.set(v, nextIndex);
    nextIndex += 1;
    stack.push(v);
    onStack.add(v);

    const deps = [...(nodes.get(v)?.allDeps ?? [])].filter((d) => nodes.has(d)).sort();
    for (const w of deps) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const comp: string[] = [];
      while (true) {
        const w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      if (comp.length > 1) {
        sccs.push(comp.sort());
      } else if (comp.length === 1 && nodes.get(v)?.allDeps.has(v)) {
        sccs.push([v, v]);
      }
    }
  };

  for (const key of sortedKeys) {
    if (!indices.has(key)) {
      strongConnect(key);
    }
  }

  return sccs
    .sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''))
    .map((comp) => `circular dependency detected across src/ modules: ${comp.join(' <-> ')}`);
}
