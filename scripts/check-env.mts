const [rawMajor = 0, rawMinor = 0] = process.versions.node.split('.').map(Number);
const major = Number.isFinite(rawMajor) ? rawMajor : 0;
const minor = Number.isFinite(rawMinor) ? rawMinor : 0;
const ok = (major === 22 && minor >= 20) || major >= 24;
if (!ok) {
  console.error(`[FAIL] Node ${process.versions.node} 不满足 ^22.20.0 || >=24.0.0`);
  process.exit(1);
}

const ua = process.env.npm_config_user_agent ?? '';
if (ua !== '' && !ua.startsWith('pnpm/')) {
  console.error(`[FAIL] 本仓库仅使用 pnpm（检测到 ${ua.split(' ')[0] ?? ua}），请改用 pnpm install`);
  process.exit(1);
}

console.log(`[OK] 环境基线检查通过 (Node ${process.versions.node})`);
