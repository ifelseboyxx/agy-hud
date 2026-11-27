import type { Visitor } from 'oxc-parser';

export const STATUSLINE_SINGLE_WRITER = 'src/cli/installer/settings.ts';

const FILE_WRITE_CALLEES = new Set([
  'writeJsonAtomicSync',
  'writeBufferAtomicSync',
  'writeSymlinkAtomicSync',
  'restoreEntrySnapshotSync',
  'restoreOwnedEntrySnapshotSync',
  'writeFileSync',
  'writeFile',
  'appendFileSync',
  'renameSync',
  'rename',
  'copyFileSync',
  'copyFile',
  'commitPlannedOps',
]);
const FILE_REMOVE_CALLEES = new Set(['rmSync', 'unlinkSync', 'unlink']);

function getPropertyKeyName(node: unknown): string | null {
  if (typeof node !== 'object' || node === null) return null;
  const rec = node as { type?: string; name?: unknown; value?: unknown };
  if (rec.type === 'Identifier' && typeof rec.name === 'string') return rec.name;
  if (rec.type === 'Literal' && typeof rec.value === 'string') return rec.value;
  return null;
}

function getCalleeName(callee: unknown): string | null {
  if (typeof callee !== 'object' || callee === null) return null;
  const rec = callee as { type?: string; name?: unknown; computed?: boolean; property?: unknown };
  if (rec.type === 'Identifier' && typeof rec.name === 'string') return rec.name;
  if (rec.type === 'MemberExpression' && !rec.computed) return getPropertyKeyName(rec.property);
  return null;
}

function isStatusLineMember(member: unknown): boolean {
  if (typeof member !== 'object' || member === null) return false;
  const rec = member as { type?: string; computed?: boolean; property?: unknown };
  if (rec.type !== 'MemberExpression') return false;
  const prop = rec.property as { type?: string; name?: unknown; value?: unknown } | undefined;
  if (!prop) return false;
  if (!rec.computed && prop.type === 'Identifier' && prop.name === 'statusLine') return true;
  return Boolean(rec.computed) && prop.type === 'Literal' && prop.value === 'statusLine';
}

interface PathBindingQuery {
  readonly directVars: ReadonlySet<string>;
  readonly objVars: ReadonlySet<string>;
  readonly isPathsCall: (node: unknown) => boolean;
  readonly propName: string;
  readonly literalNeedle?: string;
}

function exprReferencesPathBinding(expr: unknown, query: PathBindingQuery): boolean {
  if (typeof expr !== 'object' || expr === null) return false;
  const node = expr as Record<string, unknown>;
  if (node.type === 'Identifier' && typeof node.name === 'string') return query.directVars.has(node.name);
  if (node.type === 'Literal' && typeof node.value === 'string' && query.literalNeedle !== undefined) {
    return node.value.includes(query.literalNeedle);
  }
  if (
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TSTypeAssertion' ||
    node.type === 'ParenthesizedExpression'
  ) {
    return exprReferencesPathBinding(node.expression, query);
  }
  if (node.type === 'LogicalExpression') {
    return exprReferencesPathBinding(node.left, query) || exprReferencesPathBinding(node.right, query);
  }
  if (node.type === 'ConditionalExpression') {
    return exprReferencesPathBinding(node.consequent, query) || exprReferencesPathBinding(node.alternate, query);
  }
  if (node.type === 'MemberExpression' && getPropertyKeyName(node.property) === query.propName) {
    const obj = node.object as Record<string, unknown> | undefined;
    if (obj?.type === 'Identifier' && typeof obj.name === 'string' && query.objVars.has(obj.name)) return true;
    if (query.isPathsCall(obj)) return true;
  }
  if (node.type === 'ArrayExpression' && Array.isArray(node.elements)) {
    return node.elements.some((el) => exprReferencesPathBinding(el, query));
  }
  if (node.type === 'ObjectExpression' && Array.isArray(node.properties)) {
    return node.properties.some((prop) => {
      if (typeof prop !== 'object' || prop === null) return false;
      const p = prop as Record<string, unknown>;
      return exprReferencesPathBinding(p.value ?? p.argument, query);
    });
  }
  if (node.type === 'CallExpression' && Array.isArray(node.arguments)) {
    return node.arguments.some((arg) => exprReferencesPathBinding(arg, query));
  }
  if (node.type === 'TemplateLiteral') {
    const quasis = Array.isArray(node.quasis) ? (node.quasis as Array<{ value?: { raw?: string } }>) : [];
    const expressions = Array.isArray(node.expressions) ? node.expressions : [];
    const needle = query.literalNeedle;
    if (needle !== undefined && quasis.some((q) => (q.value?.raw ?? '').includes(needle))) {
      return true;
    }
    return expressions.some((ex) => exprReferencesPathBinding(ex, query));
  }
  return false;
}

export interface StatusLineFenceTracker {
  readonly handlers: Pick<
    ConstructorParameters<typeof Visitor>[0],
    'ImportDeclaration' | 'VariableDeclarator' | 'Literal' | 'Property' | 'AssignmentExpression' | 'UnaryExpression'
  >;
  onCallExpression(node: { callee: unknown; arguments: readonly unknown[] }): void;
  collectErrors(relPosix: string): string[];
}

export function createStatusLineFenceTracker(enabled: boolean): StatusLineFenceTracker {
  let hasFileWriteCall = false;
  let hasSettingsJsonLiteral = false;
  let hasBackupFileLiteral = false;
  let hasStatusLineWriteKey = false;
  let hasGetSettingsPathsCall = false;
  let hasDirectSettingsPathWrite = false;
  let hasDirectBackupPathWrite = false;
  const settingsPathsAliases = new Set<string>(['getSettingsPaths']);
  const settingsPathVars = new Set<string>();
  const backupPathVars = new Set<string>();
  const settingsPathsObjVars = new Set<string>();

  const isGetSettingsPathsCall = (node: unknown): boolean => {
    if (typeof node !== 'object' || node === null) return false;
    const rec = node as { type?: string; callee?: unknown };
    if (rec.type !== 'CallExpression') return false;
    const name = getCalleeName(rec.callee);
    return name !== null && settingsPathsAliases.has(name);
  };

  const isGetSettingsPathsExpr = (node: unknown): boolean => {
    if (isGetSettingsPathsCall(node)) return true;
    if (typeof node !== 'object' || node === null) return false;
    const rec = node as { type?: string; name?: unknown };
    return rec.type === 'Identifier' && typeof rec.name === 'string' && settingsPathsObjVars.has(rec.name);
  };

  const settingsQuery: PathBindingQuery = {
    directVars: settingsPathVars,
    objVars: settingsPathsObjVars,
    isPathsCall: isGetSettingsPathsCall,
    propName: 'settingsPath',
  };
  const backupQuery: PathBindingQuery = {
    directVars: backupPathVars,
    objVars: settingsPathsObjVars,
    isPathsCall: isGetSettingsPathsCall,
    propName: 'backupPath',
    literalNeedle: 'agy-hud-statusline-backup.json',
  };

  const trackAliasBinding = (varName: string, rhs: unknown): void => {
    if (isGetSettingsPathsExpr(rhs)) {
      settingsPathsObjVars.add(varName);
      return;
    }
    if (exprReferencesPathBinding(rhs, settingsQuery)) {
      settingsPathVars.add(varName);
    }
    if (exprReferencesPathBinding(rhs, backupQuery)) {
      backupPathVars.add(varName);
    }
  };

  return {
    handlers: {
      ImportDeclaration(node): void {
        if (!enabled) return;
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportSpecifier' && getPropertyKeyName(spec.imported) === 'getSettingsPaths') {
            settingsPathsAliases.add(spec.local.name);
          }
        }
      },
      VariableDeclarator(node): void {
        if (!enabled || node.init === null) return;
        if (node.id.type === 'Identifier') {
          trackAliasBinding(node.id.name, node.init);
        } else if (node.id.type === 'ObjectPattern' && isGetSettingsPathsExpr(node.init)) {
          for (const prop of node.id.properties) {
            if (prop.type !== 'Property' || prop.value.type !== 'Identifier') continue;
            const key = getPropertyKeyName(prop.key);
            if (key === 'settingsPath') settingsPathVars.add(prop.value.name);
            if (key === 'backupPath') {
              backupPathVars.add(prop.value.name);
            }
          }
        }
      },
      Literal(node): void {
        if (!enabled || typeof node.value !== 'string') return;
        if (node.value === 'settings.json' || node.value.endsWith('/settings.json')) hasSettingsJsonLiteral = true;
        if (node.value.includes('agy-hud-statusline-backup.json')) hasBackupFileLiteral = true;
      },
      Property(node): void {
        if (!enabled) return;
        if (
          (!node.computed && node.key.type === 'Identifier' && node.key.name === 'statusLine') ||
          (node.key.type === 'Literal' && node.key.value === 'statusLine')
        ) {
          hasStatusLineWriteKey = true;
        }
      },
      AssignmentExpression(node): void {
        if (!enabled) return;
        if (isStatusLineMember(node.left)) hasStatusLineWriteKey = true;
        if (node.left.type === 'Identifier') {
          trackAliasBinding(node.left.name, node.right);
        }
      },
      UnaryExpression(node): void {
        if (enabled && node.operator === 'delete' && isStatusLineMember(node.argument)) hasStatusLineWriteKey = true;
      },
    },
    onCallExpression(node): void {
      if (!enabled) return;
      const calleeName = getCalleeName(node.callee);
      if (calleeName === null) return;
      if (settingsPathsAliases.has(calleeName)) hasGetSettingsPathsCall = true;
      if (FILE_WRITE_CALLEES.has(calleeName)) {
        hasFileWriteCall = true;
        for (const arg of node.arguments) {
          if (exprReferencesPathBinding(arg, settingsQuery)) {
            hasDirectSettingsPathWrite = true;
          }
          if (exprReferencesPathBinding(arg, backupQuery)) {
            hasDirectBackupPathWrite = true;
          }
        }
      }
      if (FILE_REMOVE_CALLEES.has(calleeName)) {
        for (const arg of node.arguments) {
          if (exprReferencesPathBinding(arg, settingsQuery)) {
            hasDirectSettingsPathWrite = true;
          }
          if (exprReferencesPathBinding(arg, backupQuery)) {
            hasDirectBackupPathWrite = true;
          }
        }
      }
    },
    collectErrors(relPosix: string): string[] {
      const out: string[] = [];
      if (hasDirectBackupPathWrite || (hasFileWriteCall && hasBackupFileLiteral)) {
        out.push(`${relPosix}: statusLine backup may only be written in ${STATUSLINE_SINGLE_WRITER}`);
      }
      if (
        hasDirectSettingsPathWrite ||
        (hasFileWriteCall && (hasSettingsJsonLiteral || hasGetSettingsPathsCall) && hasStatusLineWriteKey)
      ) {
        out.push(`${relPosix}: settings.json statusLine may only be written in ${STATUSLINE_SINGLE_WRITER}`);
      }
      return out;
    },
  };
}
