---
name: agy-hud-setup
description: 安装、接入、诊断或卸载 agy-hud 状态栏插件并检查运行环境。当需要配置 agy-hud、在 Antigravity CLI 中接入 statusLine 或排查 HUD 状态异常时使用。
---

# agy-hud 安装、宿主接入与诊断

优先通过 Antigravity 官方插件命令安装 `agy-hud`，再用 `wire` / `unwire` 完成宿主 `statusLine` 与用户级 `CLI Shim`（`agy-hud`）的接入和解绑。

若尚未安装 `CLI Shim` 或处于 `--no-shim` 模式，可将下方命令中的 `agy-hud` 替换为便携回退路径：`node ~/.gemini/config/plugins/agy-hud/dist/cli.mjs`（安装器子命令亦可使用 `node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs`）。

## 推荐流程（插件优先）

1. 通过官方插件命令安装插件包：
   ```bash
   agy plugin install https://github.com/ifelseboyxx/agy-hud
   ```
2. 执行原地宿主接入（写入 `<cliHome>/settings.json` 的 `statusLine` 并备份旧配置、安装带 `agy-hud-shim:v1` 归属头的 `CLI Shim`、运行 `doctor` 冒烟门禁）：
   ```bash
   node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs wire
   ```
   - 如需跳过 `CLI Shim` 安装：`--no-shim`
   - 如需自定义 shim 目录：`--bin-dir <dir>`（或环境变量 `AGY_HUD_BIN_DIR`）
3. 运行健康检查（Node 版本、`node:sqlite`、`dist/hud.mjs` stdin 冒烟、`statusLine`、`CLI Shim` 5s `--help` 冒烟、`agy plugin validate --strict`）：
   ```bash
   agy-hud doctor
   # 无 shim 回退：
   node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs doctor
   ```
4. 解绑宿主接入并卸载插件（不破坏用户原有 `statusLine` 或非本插件归属的文件）：
   ```bash
   agy-hud unwire
   # 无 shim 回退：
   node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs unwire
   agy plugin uninstall agy-hud
   ```
   - 若用户直接运行了 `agy plugin uninstall agy-hud` 而未先 `unwire`，残留 `CLI Shim` 会在执行时向 `stderr` 输出精确的 `rm` / `del` 清理提示并以退出码 `1` 退出（绝不自删）；也可再执行一次 `unwire` 自动清理。

## 启停与回退

- 会话内控制：`/statusline`（切换开关）、`/statusline off` / `/statusline on`、`/statusline delete`（回退为内置默认状态栏）。
- 终端命令：`agy-hud off` / `agy-hud on`（或回退路径 / `pnpm hud:off` / `pnpm hud:on`），仅同步切换 `statusLine.enabled` 与 `agy plugin disable|enable agy-hud`，保留现有 `CLI Shim`。
- 仅开关插件包：`agy plugin disable agy-hud` / `agy plugin enable agy-hud`，或通过 `[agy-hud](customization://agy-hud)` 界面切换。

## 本地源码开发与独立安装

在 `agy-hud` 源码仓库中开发联调时，保留 `install` / `uninstall` 与 `--link` 工作流：

```bash
pnpm build
# 符号链接开发安装并接入 statusLine + CLI Shim
pnpm hud:wire
# 仅符号链接插件，不修改现有 statusLine
pnpm hud:install
# 卸载插件并恢复备份的 statusLine，同时移除归属本安装的 CLI Shim
node scripts/install.mjs uninstall --restore-statusline
```

## 安全约束

- 切勿手工直接修改 `~/.gemini/config/config.json`，也绝不自动改写 shell rc 文件（`.zshrc`/`.bashrc`）或 Windows 注册表。
- `install` / `wire` 会在写入前校验 `CLI Shim` 路径：若目标位置存在非 `agy-hud-shim:v1` 的外部文件、符号链接或目录，立即在预检阶段拒绝执行且不触碰插件目录与 `settings.json`。
- `--project [dir]` 与 `--target <dir>` 默认跳过 `CLI Shim` 安装与移除，除非显式传入 `--bin-dir <dir>` 或 `AGY_HUD_BIN_DIR`。
- 如需在隔离目录演练，请结合 `HOME=<dir>`、`GEMINI_CLI_HOME=<dir>`、`GEMINI_HOME=<dir>/.gemini` 与 `--target <dir>`（以及可选 `--bin-dir <dir>`）。
