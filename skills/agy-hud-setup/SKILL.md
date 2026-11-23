---
name: agy-hud-setup
description: 安装、接入、诊断或卸载 agy-hud 状态栏插件并检查运行环境。当需要配置 agy-hud、在 Antigravity CLI 中接入 statusLine 或排查 HUD 状态异常时使用。
---

# agy-hud 安装与诊断

使用插件根目录下的 `scripts/install.mjs` 完成本地安装、状态栏接入、健康检查或卸载恢复。

## 常用操作

1. 构建产物（如尚未构建）：
   ```bash
   pnpm build
   ```
2. 链接安装插件但不覆盖现有 `statusLine`：
   ```bash
   node scripts/install.mjs install --link --no-enable
   ```
3. 安装并接入 `<cliHome>/settings.json` 的 `statusLine`（不触碰 `~/.gemini/config/config.json`）：
   ```bash
   node scripts/install.mjs install --link --no-enable --wire-statusline
   ```
4. 运行健康检查（Node 版本、`node:sqlite`、`dist/hud.mjs` stdin 冒烟、`agy plugin validate --strict`）：
   ```bash
   node scripts/install.mjs doctor
   ```
5. 卸载并恢复先前备份的 `statusLine`（若存在备份）：
   ```bash
   node scripts/install.mjs uninstall --restore-statusline
   ```
6. 启停与回退：
   - 会话内控制：`/statusline`（切换开关）、`/statusline off` / `/statusline on`、`/statusline delete`（回退为内置默认状态栏）。
   - 终端脚本：`pnpm hud:off` / `pnpm hud:on`（同步设置 `statusLine.enabled` 与 `agy plugin disable|enable agy-hud`）。
   - 仅开关插件包：`agy plugin disable agy-hud` / `agy plugin enable agy-hud`，或通过 `[agy-hud](customization://agy-hud)` 界面切换。

## 安全约束

- 切勿手工直接修改 `~/.gemini/config/config.json`。
- 如需在隔离目录演练，请通过 `--target <dir>` 与环境变量 `GEMINI_CLI_HOME=<dir>` 指定临时目录。
