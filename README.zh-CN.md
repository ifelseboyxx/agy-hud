# agy-hud

面向 Antigravity CLI 与 App 的实时状态栏、溢出检视与配置迁移插件：常驻终端输入框下方，实时展示模型与思考强度、上下文进度条、配额余量、吞吐/首字延迟/缓存命中率、活跃工具、Skills、MCP、原生 `/swarm` 状态与待办进度，并提供一键点击快照检视、交互式终端配置、Antigravity App `HUD Inspector` 视图与跨机脱敏配置迁移。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/ifelseboyxx/agy-hud)](https://github.com/ifelseboyxx/agy-hud/stargazers)
![Node.js](https://img.shields.io/badge/Node.js-%5E22.20.0%20%7C%7C%20%3E%3D24.0.0-339933)
![零运行时依赖](https://img.shields.io/badge/runtime%20deps-0-22D3EE)

![agy-hud 运行效果](assets/preview.png)

> [English](README.md) | **简体中文**

## 显示效果

默认（`full`）预设会展示当前权限/模式、模型与性能指标、上下文与配额状态，并在工具、Skills、MCP、Swarm 或待办活跃时自动追加活动行：

```text
 ⏵⏵ accept edits on (shift+tab to cycle)
 [G4 Carbon ◑ high] │ agy-hud git:(main*) │ ◷ 12m │ Swarm 1/2 │ Cost $0.185 │ 86.4 t/s · TTFT 1.62s · Cache 94%
  Context █████░░░░░ 48% (480k/1M) │ G 5h: 92.50% (3h 14m) | 7d: 88.20% (102h 6m)
  ◐ Edit: lines.ts | ✓ Read ×4 | ✓ Grep ×2 | +3 more
  ✓ Skills (2): agy-hud-setup, agy-hud-configure
  ✓ MCPs (1): filesystem
  ◐ Swarm (1/2): ◐ coder, ◌ reviewer
  ▸ Verify statusLine rollback guards (2/4) │ BG 1
```

- **模式行（`mode`）**：展示当前权限或代理模式（`bypass permissions`、`accept edits`、`plan`、`auto` 或 `default`）、可选 Vim 模式标记（`[NORMAL]` / `[INSERT]`）及快捷键提示。
- **身份与性能（`identity`）**：模型与思考强度（支持 `Orchestrator (Planner/Executor)` 角色解析）、当前目录与 git 分支（脏工作区带 `*`）、会话耗时、活跃 `Swarm` / `Agents` 计数、运行时徽章（`@agent`、`Battle`、`BG`、`! Approval`、`Q:N`）、会话费用与自适应终端宽度的 **Perf Capsule**（`t/s`、`TTFT`、`Cache%`）。
- **上下文与配额（`usage`）**：随占用变色的上下文进度条、token 容量与压缩估算值（`~used/max`），以及按模型优先展示的 `G` / `3P` 配额余量与重置倒计时。
- **活动行（`tools`、`skills`、`mcps`、`agents`、`todos`）与单行摘要（`activity`）**：展示运行中与已完成工具、已加载 Skills 与 MCP 服务、原生 `/swarm` 与子代理芯片（`◐` 工作中、`◌` 等待中）及待办进度。超出单行宽度时自动折叠为 `+N more`，在支持 OSC 8 的终端中可直接点击打开完整快照。

### 展示预设

| 预设 | 默认启用行（`lines`） | 行内片段（`segments`） | 适用场景 |
| :--- | :--- | :--- | :--- |
| `full` *(默认)* | `mode`、`identity`、`usage`、`tools`、`skills`、`mcps`、`agents`、`todos` | 全部开启 | 全量实时诊断 |
| `compact` | `mode`、`identity`、`usage`、`activity` | 全部开启 | 日常开发，单行展示高频活动摘要 |
| `swarm` | `mode`、`identity`、`usage`、`agents`、`todos` | 全部开启 | 多代理编排监控 |
| `minimal` | `identity`、`usage` | `model`、`git`、`badges`、`context`、`quota` | 精简双行核心指标 |
| `zen` | `identity`（行尾折叠 `Ctx%` 与 `5h%`） | `model`、`git`、`badges`、`context`、`quota` | 窄屏与分屏终端严格单行 |

## 安装

运行前需要 **Antigravity CLI（`agy`）** 与 **Node.js `^22.20.0 || >=24.0.0`**。

```bash
# 1. 安装插件包
agy plugin install https://github.com/ifelseboyxx/agy-hud

# 2. 接入状态栏并安装 `agy-hud` 终端命令
node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs wire
```

`wire` 会自动备份 `~/.gemini/antigravity-cli/settings.json` 中原有的状态栏配置、启用 `agy-hud`、安装用户级 `agy-hud` 命令（macOS/Linux 位于 `~/.local/bin/agy-hud`，Windows 位于 `%LOCALAPPDATA%\agy\bin\agy-hud.cmd`），并自动验证运行状态；若中途失败会自动完整回滚。

随时暂停或恢复显示：
- **Antigravity CLI 会话内**：`/statusline`（切换）、`/statusline off`、`/statusline on`。
- **终端命令**：`agy-hud off` / `agy-hud on`（或 `agy plugin disable|enable agy-hud`）。

<details>
<summary><strong>进阶安装选项、从源码构建与健康诊断</strong></summary>

```bash
# 跳过安装 `agy-hud` 终端命令（后续通过 node ~/.gemini/config/plugins/agy-hud/dist/cli.mjs 调用）
node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs wire --no-shim

# 将终端命令安装到自定义目录（或通过环境变量 AGY_HUD_BIN_DIR 指定）
node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs wire --bin-dir ~/.bin

# 运行完整健康检查（Node 版本、node:sqlite、HUD 渲染冒烟、settings、命令冒烟与插件校验）
agy-hud doctor
# 未将 `agy-hud` 加入 PATH 时的回退路径：
node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs doctor

# 从本地源码克隆构建并安装（需要 pnpm@11.1.1）
git clone https://github.com/ifelseboyxx/agy-hud.git agy-hud
cd agy-hud
pnpm install && pnpm build
node scripts/install.mjs install --wire-statusline

# 开发模式：从源码目录符号链接安装
pnpm hud:wire     # 符号链接插件 + 接入状态栏 + 安装命令
pnpm hud:install  # 仅符号链接插件，不修改现有 statusLine

# 项目级或自定义目录安装（默认跳过全局命令，除非显式传入 --bin-dir 或 AGY_HUD_BIN_DIR）
node scripts/install.mjs install --project [dir]
node scripts/install.mjs install --target <dir> --no-enable
```

</details>

## 卸载

### 推荐卸载流程

```bash
# 1. 恢复原有状态栏配置并移除 `agy-hud` 命令
agy-hud unwire

# 2. 移除插件包
agy plugin uninstall agy-hud
```

若安装时使用了 `--no-shim`，可直接运行插件内的解绑脚本：

```bash
node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs unwire
agy plugin uninstall agy-hud
```

- **会话内快速回退**：在 Antigravity CLI 中直接输入 `/statusline delete`，即可立即清除自定义状态栏并回退为内置默认状态栏。
- **未先 `unwire` 就卸载了插件？** 调用残留的 `agy-hud` 命令会在 `stderr` 打印精确的 `rm` / `del` 删除命令并以退出码 `1` 退出（绝不自删文件），可直接手动删除或补跑 `unwire`。
- **源码 / 链接安装卸载**：在本地源码仓库根目录执行 `node scripts/install.mjs uninstall --restore-statusline`。
- **文件清理范围**：`unwire` + `agy plugin uninstall` 会移除 `~/.gemini/config/plugins/agy-hud`、归属本安装的 `agy-hud` 命令，并在恢复原 `statusLine` 后删除 `~/.gemini/antigravity-cli/cache/agy-hud-statusline-backup.json`。如需彻底清空个人偏好与本地缓存，可按需手动删除 `~/.gemini/antigravity-cli/hud-config.json` 与 `~/.gemini/antigravity-cli/cache/agy_hud_*`。

## 溢出检视与 HUD Inspector

当单行状态栏出现 `+N more` 折叠或需要查看完整会话活动时，提供三条互补检视通道：

- **OSC 8 超链接直达**：在支持的终端中 `Cmd+Click`（或终端快捷打开）任意 `+N more` 徽章或 `compact` 模式的 `· snapshot` 尾部，即可打开当前会话的本地 Markdown 快照（`0o600` 权限，仅在实际渲染超链接且内容变化时按需写入）。
- **终端快照与交互弹层（`agy-hud` / `agy-hud snapshot`）**：
  ```bash
  # 在 Antigravity 输入框直接输入 !agy-hud，或在任意终端查看当前会话完整快照
  agy-hud
  agy-hud snapshot tools agents

  # 打开单键退出交互弹层（q/Esc/Enter 关闭，1-4/a 过滤分区，j/k 滚动，r 热刷新）
  agy-hud -p

  # 列出 CLI / APP / IDE 活跃与近期会话，或输出结构化 JSON
  agy-hud --sessions
  agy-hud -s <会话ID或前缀> --source all --json

  # 生成终端弹窗快捷键模板（支持 tmux、kitty、wezterm、ghostty、iterm2 或 all）
  agy-hud --keybindings
  agy-hud --keybindings all
  ```
- **Antigravity App `HUD Inspector`（MCP App）**：随 `mcp_config.json`（`dist/mcp-hud.mjs`）自动内置。在 Antigravity App 侧栏（`aux_pane`）或全页插件视图（`global`）中打开 **HUD Inspector**，即可查看 2 秒可见性感知实时遥测、可搜索的运行中与已完成工具、Skills、MCP 明细、Swarm 成员列表，并点击本地文件路径在侧栏中直接预览。

## 配置与自定义

插件内置了 `agy-hud-setup` 与 `agy-hud-configure` 两个 Skill，你可以直接在 Antigravity 对话中用自然语言调整配置，或在终端直接操作（无 `agy-hud` 命令时替换为 `node ~/.gemini/config/plugins/agy-hud/dist/cli.mjs`）：

```bash
# 启动双层交互式 TUI 配置器（第 1 层切换预设+实时预览，第 2 层开关与排序模块）
agy-hud configure -i

# 查看当前生效配置
agy-hud configure --show

# 切换预设（full | compact | swarm | minimal | zen）
agy-hud configure compact

# 一次命令内完成预设切换、行/片段插拔与自定义行序
agy-hud configure compact --enable tools,agents --disable activity,cost --order identity,usage,tools,agents

# 调整顶层选项、行内片段或兼容旧 show* 别名
agy-hud configure --set osc8Links=false --set maxAgentChips=6 --set segments.perf=true

# 重置为默认 full 配置
agy-hud configure --reset
```

配置文件位于 `~/.gemini/antigravity-cli/hud-config.json`（支持 `GEMINI_CLI_HOME` 覆盖）。在源码仓库根目录也可使用 `pnpm hud:configure -- <参数>`。

<details>
<summary><strong>全部配置项一览</strong></summary>

| 配置键 | 类型 / 取值 | 默认值 | 说明 |
| :--- | :--- | :---: | :--- |
| `preset` | `full` \| `compact` \| `swarm` \| `minimal` \| `zen` | `full` | 角色密度预设，用于初始化默认 `lines` 与 `segments`。 |
| `lines` | `mode`、`identity`、`usage`、`activity`、`tools`、`skills`、`mcps`、`agents`、`todos` 的有序数组 | `full` 行序列 | 显式启用的行模块列表及渲染顺序；空行自动折叠。 |
| `segments` | `model`、`git`、`duration`、`badges`、`cost`、`perf`、`context`、`quota` 的布尔开关 | 全部 `true` | 控制 `identity`、`usage`（及 `zen` 折叠尾部）的行内片段开关。 |
| `osc8Links` | `boolean` | `true` | 是否为 `+N more` / `snapshot` 输出 OSC 8 超链接（`NO_COLOR`、`TERM=dumb`、SSH 下自动关闭）。 |
| `maxAgentChips` | 整数 `0..20` | `8` | Swarm/Agent 芯片单行最大显示数量（超出折叠为 `+N more`，`0` 为隐藏）。 |

`hud-config.json` 与 `--set` 继续无损兼容旧版 `showModeLine`、`showPerfCapsule`、`showQuota`、`showCost`、`showSwarmChips`、`showToolsLine`、`showSkillsMcpLine`、`showTodosLine` 键名。

</details>

## 跨机配置迁移

在多台机器间迁移 Antigravity CLI 偏好设置、HUD 配置、MCP 模板与插件清单，同时自动剥离本地敏感信息：

```bash
# 导出脱敏配置模板与 plugins-manifest.json
agy-hud export-profile --out ./agy-profile

# 在目标机器导入（追加 --merge-mcp 可仅补充缺失的 MCP 服务）
agy-hud import-profile --in ./agy-profile --merge-mcp
```

- **导出产物**：`settings.template.json`、`config.template.json`、`mcp_config.template.json`、`hud-config.json` 与 `plugins-manifest.json`。
- **自动脱敏规则**：按白名单筛选可迁移字段，剔除机器绑定项（`trustedWorkspaces`、`remoteControlHostname`、`sidecars.*.projectId`），并将密钥/令牌、敏感命令行参数与请求头、URL 鉴权信息统一替换为 `<SET_IN_ENV>`。公开发布或分享前仍建议人工复核。
- **无损导入保护**：写入前先全量校验输入 JSON；深度合并 `settings.json` 时保留目标机原有的 `trustedWorkspaces`；绝不自动修改 `~/.gemini/config/config.json`（仅输出人工参考提示）；目标机已存在 `mcp_config.json` 时默认跳过，传入 `--merge-mcp` 才增量补充缺失项。

## 安全与可靠性

- **零运行时依赖**：构建为独立 ESM 产物（`dist/hud.mjs`、`dist/cli.mjs`、`dist/mcp-hud.mjs`），仅使用 Node.js 内置模块（`node:sqlite`、`node:fs`、`node:child_process`）与纯 TypeScript Protobuf 解码器。
- **只读遥测与路径隔离**：会话 SQLite 数据库与 Antigravity App/IDE 目录严格以只读方式访问（`?mode=ro` / `?immutable=1`，50ms 超时），所有缓存文件均收口于 `<cliHome>/cache`；`conversation_id`、`transcript_path` 与 Skill 路径均经可信根目录校验，阻断路径穿越与符号链接逃逸。
- **归属校验与原子回滚**：`settings.json` 由单一带锁写入模块（`src/cli/installer/settings.ts`）管理；命令启动器携带 `agy-hud-shim:v1` 归属头（Windows 下自动成对生成 `.cmd` 与伴生 POSIX 脚本），在 `wire`/`install` 时执行 5 秒 `--help` 冒烟门禁且绝不修改 shell rc 或 Windows 注册表；预检阶段拒绝覆盖外部文件或符号链接，`off` 与 `unwire`/`uninstall` 严格校验规范路径归属，损坏的 JSON 报错并原样保留，失败事务按字节校验原子回滚。
- **纯本地数据边界**：仅读取 statusLine stdin JSON、本地 Antigravity 会话目录、当前目录 `.git/HEAD` 及（迁移命令中的）`~/.gemini/config`，不发起任何网络请求；MCP App HTML 完全内联且符合 `default-src 'none'` CSP 策略。

## 开发与验证

```bash
pnpm install
pnpm verify
```

`pnpm verify` 依次执行 `oxlint --type-aware --deny-warnings`、`oxfmt --check`、`tsc --noEmit`、`vite build`（Vite 8 + Rolldown）、隔离环境的 `node --test` 以及全仓工程守卫校验。

如需在不触碰日常 Antigravity 环境的前提下隔离演练，可通过 `GEMINI_CLI_HOME=<临时目录>`、`GEMINI_HOME=<临时目录>/.gemini` 与 `--target <临时插件目录>` 指定沙箱路径。

## 许可证

MIT，参见 [LICENSE](LICENSE)。

## Star 历史

<a href="https://star-history.com/#ifelseboyxx/agy-hud&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=ifelseboyxx/agy-hud&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=ifelseboyxx/agy-hud&type=Date&theme=light" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=ifelseboyxx/agy-hud&type=Date" />
  </picture>
</a>
