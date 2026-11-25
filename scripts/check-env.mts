import { isSupportedNodeVersion, NODE_RANGE_LABEL } from '../src/core/guards.ts';
import { isMainEntry } from '../src/core/paths.ts';

export function checkRuntimeEnvironment(): string[] {
  const errors: string[] = [];
  if (!isSupportedNodeVersion(process.versions.node)) {
    errors.push(`Node ${process.versions.node} 不满足 ${NODE_RANGE_LABEL}`);
  }

  const ua = process.env.npm_config_user_agent ?? '';
  if (ua !== '' && !ua.startsWith('pnpm/')) {
    errors.push(`本仓库仅使用 pnpm（检测到 ${ua.split(' ')[0] ?? ua}），请改用 pnpm install`);
  }
  return errors;
}

if (isMainEntry(import.meta.url)) {
  const errors = checkRuntimeEnvironment();
  if (errors.length > 0) {
    for (const err of errors) console.error(`[FAIL] ${err}`);
    process.exit(1);
  }
  console.log(`[OK] 环境基线检查通过 (Node ${process.versions.node})`);
}
