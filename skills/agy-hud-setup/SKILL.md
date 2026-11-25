---
name: agy-hud-setup
description: 安装、接入、诊断或卸载 agy-hud（wire/unwire、statusLine、CLI Shim 与 Node/sqlite 运行环境检查）。
---

# agy-hud 安装、宿主接入与诊断

优先通过 Antigravity 官方插件命令安装 `agy-hud`，再用 `wire` / `unwire` 完成宿主 `statusLine` 与用户级 `CLI Shim`（`agy-hud`）的接入和解绑。

若尚未安装 `CLI Shim` 或处于 `--no-shim` 模式，将下方命令中的 `agy-hud` 替换为 `node ~/.gemini/config/plugins/agy-hud/dist/cli.mjs`（安装器子命令亦可使用 `node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs`）。

## 安装与接入（插件优先）

1. 通过官方插件命令安装插件包：
   ```bash
   agy plugin install https://github.com/ifelseboyxx/agy-hud
   ```
2. 执行原地宿主接入（写入 `<cliHome>/settings.json` 的 `statusLine` 并备份旧配置、安装带 `agy-hud-shim:v1` 归属头的 `CLI Shim`、运行 `doctor` 冒烟门禁）：
   ```bash
   node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs wire
   ```
   - 跳过 `CLI Shim` 安装：`--no-shim`
   - 自定义 shim 目录：`--bin-dir <dir>`（或环境变量 `AGY_HUD_BIN_DIR`）
3. 运行健康检查（Node 版本、`node:sqlite`、`dist/hud.mjs` stdin 冒烟、`statusLine`、`CLI Shim` 5s `--help` 冒烟、`agy plugin validate --strict`）：
   ```bash
   agy-hud doctor
   ```

## 解绑与卸载

按顺序解绑宿主接入再卸载插件（自动恢复原有 `statusLine`，并仅移除归属本安装的 `CLI Shim`）：

```bash
agy-hud unwire
agy plugin uninstall agy-hud
```

若用户直接运行了 `agy plugin uninstall agy-hud` 而未先 `unwire`，插件目录与 `install.mjs` 已被删除；调用残留 `CLI Shim` 会保持文件原样，向 `stderr` 输出精确的 `rm` / `del` 手动清理命令并以退出码 `1` 退出。按提示手动删除该 shim 文件，并在 Antigravity CLI 中执行 `/statusline delete` 恢复默认状态栏。

## 启停与回退

- 会话内控制：`/statusline`（切换开关）、`/statusline off` / `/statusline on`、`/statusline delete`（回退为内置默认状态栏）。
- 终端命令：
  - `agy-hud off`：仅禁用归属本次安装的 `statusLine` 并执行 `agy plugin disable agy-hud`，保留 `CLI Shim`。
  - `agy-hud on`：经 `wireCliStatusLine` 重新接入完整 `statusLine` 命令并执行 `agy plugin enable agy-hud`，保留 `CLI Shim`。
- 仅开关插件包：`agy plugin disable agy-hud` / `agy plugin enable agy-hud`，或通过 `[agy-hud](customization://agy-hud)` 界面切换。

## 本地源码开发与独立安装

在 `agy-hud` 源码仓库中开发联调时使用 `install` / `uninstall` 与 `--link`：

```bash
pnpm build
# 符号链接开发安装，接入 statusLine + CLI Shim 并运行 doctor
pnpm hud:wire
# 符号链接开发安装，安装 CLI Shim 并运行 doctor（保留现有 statusLine，--no-enable）
pnpm hud:install
# 本地启停状态栏与插件
pnpm hud:on
pnpm hud:off
# 卸载插件、恢复备份的 statusLine，并移除归属本安装的 CLI Shim
node scripts/install.mjs uninstall --restore-statusline
```

## 安全约束

- 宿主接入只经 `wire` / `unwire` / `install` / `uninstall` / `on` / `off` 完成；保持 `~/.gemini/config/config.json`、shell rc 文件（`.zshrc`/`.bashrc`）与 Windows 注册表原样不变。
- `install` / `wire` 在预检阶段校验 `CLI Shim` 路径：目标位置若为非 `agy-hud-shim:v1` 的外部文件、符号链接或目录，立即报错中止，保持插件目录与 `settings.json` 原样。
- `--project [dir]` 与 `--target <dir>` 默认跳过 `CLI Shim` 安装与移除，需管理 shim 时显式传入 `--bin-dir <dir>` 或 `AGY_HUD_BIN_DIR`。
- 隔离目录演练时同时设置 `HOME=<dir>`、`GEMINI_CLI_HOME=<dir>`、`GEMINI_HOME=<dir>/.gemini` 与 `--target <dir>`（可选 `--bin-dir <dir>`）。
