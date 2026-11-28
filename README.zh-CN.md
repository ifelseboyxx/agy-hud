<div align="center">

<img src="assets/logo.svg" width="84" alt="agy-hud logo">

# agy-hud

**常驻 Antigravity CLI 输入框下方的实时终端 HUD——支持快照检视与跨机配置迁移。**<br>
实时展示模型、直观配额、吞吐延迟、详细 Git 变更、美元/人民币费用、活跃工具与 `/swarm` 状态——零构建安装，零运行时依赖。

[![CI](https://github.com/ifelseboyxx/agy-hud/actions/workflows/ci.yml/badge.svg)](https://github.com/ifelseboyxx/agy-hud/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform: macOS · Linux · Windows](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-lightgrey.svg)
![Node ^22.20 || >=24](https://img.shields.io/badge/node-%5E22.20%20%7C%7C%20%3E%3D24-brightgreen.svg)
![Zero Runtime Deps](https://img.shields.io/badge/runtime%20deps-0-22D3EE)
[![Stars](https://img.shields.io/github/stars/ifelseboyxx/agy-hud)](https://github.com/ifelseboyxx/agy-hud/stargazers)

[安装](#安装) · [显示效果](#显示效果) · [溢出检视](#溢出检视) · [配置与自定义](#配置与自定义) · [卸载](#卸载) · [English](README.md)

<img src="assets/preview.png" width="100%" alt="Antigravity CLI 输入框下方的 agy-hud 实时状态栏，展示模式、模型、git 分支、Swarm 计数、性能指标、上下文进度条、配额、工具、Skills、MCP 与待办">
<br>
<sub>Antigravity CLI 输入框下方的默认 <code>full</code> 预设：模型、吞吐延迟、上下文、配额、工具、Skills、MCP、<code>/swarm</code> 与待办进度</sub>

</div>

## 为什么做这个

Antigravity 在执行任务时，你往往想一眼看清当前模型与思考强度、上下文剩余空间、配额余量、流式吞吐与首字延迟、当前会话费用，以及工具和 `/swarm` 子代理正在做什么——而不想打断对话或到处翻找日志。

`agy-hud` 常驻在 Antigravity CLI 终端输入框下方，按终端宽度自适应渲染实时遥测与活动明细，并支持 OSC 8 快照直达、终端弹层检视与跨机配置迁移——无需本地构建，零运行时依赖。

## 显示效果

默认（`full`）预设会展示当前权限/模式、模型与性能指标、上下文与配额状态，并在工具、Skills、MCP、Swarm 或待办活跃时自动追加活动行：

```text
 ⏵⏵ accept edits on (shift+tab to cycle)
 [G4 Carbon ● high] │ agy-hud git:(main +!? ↑1) +48 -12 │ ◷ 12m │ Swarm 1/2 │ Cost ~$0.185 / ¥1.34 │ 86.4 token/s · TTFT 1.6s · Cache 94%
  Context █████░░░░░ 48% (246k/512k) │ Gemini 5h: 92% left (3h14m) | 7d: 88% left (4d6h)
  ◐ Edit: lines.ts | ✓ Read ×4 | ✓ Grep ×2 | +3 more
  ✓ Skills (1): hud
  ✓ MCPs (1): filesystem
  ◐ Swarm (1/2): ◐ coder, ◌ reviewer
  ▸ Verify statusLine rollback guards (2/4) │ Bg Tasks 1
```

- **模式行（`mode`）** — 当前权限或代理模式（`bypass permissions`、`accept edits`、`plan`、`auto`、`default`）、可选 Vim 标记（`[NORMAL]` / `[INSERT]`）及切换提示
- **身份与性能（`identity`）** — 模型与按模型上限自适应的思考强度显示（`◔ low` / `◑ medium` / `◕ high` / `● 最高思考` / `✦ max`，凡达到当前模型最高思考档位——如 Hydrogen/Neon 的 `xhigh`、Carbon/Argon/Claude/Flash 的 `high`——均自动呈现满格标识与克制的铂金冰光单束扫光动效，并支持 `Orchestrator (Planner/Executor)` 双角色独立判定）、工作区与带缓存的增强 Git 状态（`=+!->?$ ↑N↓N` 与 `+N -M` 变更行数，宽度 `< 100` 自动降级为 `git:(branch*)`）、耗时、`Swarm` / `Agents` 计数、运行时徽章（`@agent`、`Battle`、`Bg Tasks`、`! Approval`、`! Auth`、`Review`、`Retry`、`! Error`、`Queued`）、纯离线美元/人民币会话费用（当宿主通过 `statusLine` stdin 上报有效 `cost` 总额时显示，估算价带 `~` 前缀；未上报时自动隐藏，例如配额订阅或未上报定价的模型）与宽度自适应 **Perf Capsule**（`token/s`、`TTFT`、带异常预警的 `Cache%`）
- **上下文与配额（`usage`）** — 随占用变色的有效上下文预算进度条（支持中英混合感知的压缩估算 `~used/max`），以及直观的 `Gemini` / `Claude/GPT` 剩余配额（显式 `left`、整数百分比含 `<1%`/`99%`/`100%` 边界精度、紧凑 `4d6h` 重置倒计时及按需显示的配额消耗预测 `~0% <eta>` / `!`）
- **活动行（`tools`、`skills`、`mcps`、`agents`、`todos`）与摘要行（`activity`）** — 运行中与已完成工具、已加载 Skills 与 MCP 服务、`/swarm` 与子代理芯片（`◐` 工作中、`◌` 等待中）及待办进度；超宽时折叠为支持 OSC 8 点击直达的 `+N more`（或 `· snapshot`）

### 展示预设

| 预设 | 默认启用行（`lines`） | 行内片段（`segments`） | 适用场景 |
| :--- | :--- | :--- | :--- |
| `full` *(默认)* | `mode`、`identity`、`usage`、`tools`、`skills`、`mcps`、`agents`、`todos` | 全部开启 | 全量实时诊断 |
| `compact` | `mode`、`identity`、`usage`、`activity` | 全部开启 | 日常开发，单行展示高频活动摘要 |
| `swarm` | `mode`、`identity`、`usage`、`agents`、`todos` | 全部开启 | 多代理编排监控 |
| `minimal` | `identity`、`usage` | `model`、`git`、`badges`、`context`、`quota` | 精简双行核心指标 |
| `zen` | `identity`（行尾折叠 `Ctx%` 与 `5h%`） | `model`、`git`、`badges`、`context`、`quota` | 窄屏与分屏终端严格单行 |

## 安装

运行前需要 **Node.js `^22.20.0 || >=24.0.0`**（支持 macOS、Linux、Windows），无需本地克隆或构建。

```bash
# 一键安装（随时重跑同一命令即可原地升级）
agy plugin install https://github.com/ifelseboyxx/agy-hud

# 或锁定到具体发布版本（仅支持单段 semver 标签，切勿向 agy plugin install 传入 .zip 压缩包）
agy plugin install https://github.com/ifelseboyxx/agy-hud/tree/v0.1.0
```

启动 `agy`，一步激活终端状态栏（热重载立即生效，无需重启）：

```text
/hud setup
```

也可以直接运行 CLI 内置命令启用：

```text
/statusline node ~/.gemini/config/plugins/agy-hud/dist/hud.mjs
```

随时在 Antigravity CLI 会话内输入 `/statusline`、`/statusline off` 或 `/statusline on` 暂停与恢复。

> **说明：** 在 Antigravity 插件列表中将 `agy-hud` 设为 `disabled`（或执行 `agy plugin disable agy-hud`）只会更新 `~/.gemini/config/config.json` 并停用 `/hud` skill。由于 Antigravity 宿主不把 `statusLine` 作为插件组件托管，已在 `~/.gemini/antigravity-cli/settings.json` 中接线的底部状态栏仍会继续运行。仅暂停状态栏请使用 `/statusline off`；如需通过安装脚本操作，运行 `node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs off`（仅停用归属本安装的 `statusLine`）或 `on`（重新接入并启用本安装，接管其他 `statusLine` 前会先备份原配置）。在默认全局安装、未传 `--no-enable` 且 `PATH` 上 `agy` 可用时，`off` / `on` 还会尽最大努力同步调用 `agy plugin disable|enable agy-hud`（宿主插件命令失败时仅输出回退提示而不阻断退出，详细边界见 [docs/host-contracts.md](docs/host-contracts.md)）。

<details>
<summary><strong>进阶选项：安装独立 <code>agy-hud</code> 终端命令、健康诊断、源码构建与 Link Install 迁移</strong></summary>

```bash
# 可选：自动写入 settings.json 并安装全局 `agy-hud` 命令（支持 `!agy-hud`、`agy-hud -p`、`agy-hud preview`）
node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs wire

# 仅写入 settings.json，跳过安装全局 `agy-hud` 命令
node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs wire --no-shim

# 将终端命令安装到自定义目录（或设置环境变量 AGY_HUD_BIN_DIR）
node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs wire --bin-dir ~/.bin

# 停用归属本安装的 statusLine / 重新接入并启用 statusLine（默认全局且 agy 可用时尽最大努力同步开关插件）
node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs off
node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs on

# 运行完整健康诊断
node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs doctor

# 从旧版 --link（Link Install）符号链接切换到零构建 Plugin Install：
agy plugin uninstall agy-hud && agy plugin install https://github.com/ifelseboyxx/agy-hud

# 贡献者本地源码构建与符号链接开发安装（需要 pnpm@11.1.1）
git clone https://github.com/ifelseboyxx/agy-hud.git agy-hud && cd agy-hud
pnpm install && pnpm build
pnpm hud:wire     # 符号链接插件 + 接入状态栏 + 安装命令 + 运行 doctor
pnpm hud:install  # 符号链接插件 + 安装命令 + 运行 doctor（保留现有 statusLine）

# 项目级或自定义目录安装
node scripts/install.mjs install --project [dir]
node scripts/install.mjs install --target <dir> --no-enable
```

</details>

## 溢出检视

当单行状态栏出现 `+N more` 或 `· snapshot` 折叠时，可通过两条终端原生通道查看完整未截断的会话快照：

- **OSC 8 超链接直达** — 在支持的终端中 `Cmd+Click`（或终端快捷打开）任意 `+N more` 徽章或 `· snapshot` 尾部，即可打开当前会话的本地 `0o600` Markdown 快照（仅在实际渲染超链接且内容变化时按需写入）。
- **终端快照与交互弹层** — 在 Antigravity CLI 输入框直接输入 `!agy-hud` 或在任意终端执行 `agy-hud` 查看明细，使用 `-p` 打开单键退出交互弹层，或生成各终端弹窗快捷键。

```bash
# 查看当前会话完整快照或按分区过滤（context、tools、skills、mcps、agents）
agy-hud
agy-hud snapshot context tools agents

# 打开单键退出交互弹层（q/Esc/Enter 关闭，1-5/c/a 过滤分区，j/k 滚动，r 热刷新）
agy-hud -p

# 列出活跃与近期 CLI 会话，或输出结构化 JSON
agy-hud --sessions
agy-hud -s <会话ID或前缀> --json

# 生成终端弹窗快捷键模板（支持 tmux、kitty、wezterm、ghostty、iterm2 或 all）
agy-hud --keybindings
agy-hud --keybindings all
```

## 配置与自定义

在 Antigravity 对话中直接使用 **`/hud`**（例如 `/hud compact`、`/hud preview`、`/hud setup`、`/hud check`），或在终端中运行 `agy-hud`（未安装全局命令时替换为 `node ~/.gemini/config/plugins/agy-hud/dist/cli.mjs`）：

```bash
# 离线预览任意终端宽度下的 HUD 布局（无需启动实时会话）
agy-hud preview 120
agy-hud preview --narrow
agy-hud preview --all-presets

# 启动双层交互式 TUI 配置器（第 1 层切换预设+实时预览，第 2 层开关排序模块、osc8Links 与 costCurrency）
agy-hud configure -i

# 查看当前生效配置
agy-hud configure --show

# 切换预设（full | compact | swarm | minimal | zen）
agy-hud configure compact

# 一次命令内完成预设切换、行/片段插拔与自定义行序
agy-hud configure compact --enable tools,agents --disable activity,cost --order identity,usage,tools,agents

# 配置美元 / 人民币会话费用显示（100% 离线，零网络请求）
agy-hud configure --set costCurrency=both --set usdToCnyRate=7.25

# 配置窄分屏覆盖（终端宽度 < 100 列时自动生效并跳过隐藏模块的采集器）
agy-hud configure --narrow-disable cost,perf,todos
agy-hud configure --set narrow.segments.cost=inherit
agy-hud configure --narrow-reset

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
| `costCurrency` | `usd` \| `cny` \| `both` | `usd` | 纯离线费用币种（`both` 宽屏显示 `$0.818 / ¥5.93`，`< 100` 列紧凑为 `$0.82/¥5.93`）；当宿主通过 `statusLine` stdin 上报有效 `cost` 总额时显示，`agy-hud` 不维护本地模型单价表。 |
| `usdToCnyRate` | 数值 `0.01..1000` | `7.25` | 纯离线美元兑人民币汇率，跨 HUD、OSC 8 Markdown 与 CLI `snapshot` 共享。 |
| `narrow` | `{ lines?: HudLineId[], segments?: Partial<HudSegments> }` | *(省略)* | 可选窄分屏覆盖（`terminal_width < 100` 触发），未声明键继承顶层配置，隐藏项同步跳过采集器。 |
| `osc8Links` | `boolean` | `true` | 是否为 `+N more` / `snapshot` 输出 OSC 8 超链接（`NO_COLOR`、`TERM=dumb`、SSH 下自动关闭）。 |
| `maxAgentChips` | 整数 `0..20` | `8` | Swarm/Agent 芯片单行最大显示数量（超出折叠为 `+N more`，`0` 为隐藏）。 |

</details>

## 跨机配置迁移

在多台机器间迁移 Antigravity CLI 偏好设置、HUD 配置（含 `costCurrency`、`usdToCnyRate` 与 `narrow` 覆盖）、MCP 模板与插件清单，同时自动剥离本地敏感信息：

```bash
# 导出脱敏配置模板与 plugins-manifest.json
agy-hud export-profile --out ./agy-profile

# 在目标机器导入（追加 --merge-mcp 可仅补充缺失的 MCP 服务）
agy-hud import-profile --in ./agy-profile --merge-mcp
```

- **导出产物** — `settings.template.json`、`config.template.json`、`mcp_config.template.json`、`hud-config.json` 与 `plugins-manifest.json`
- **自动脱敏规则** — 按白名单筛选可迁移字段，剔除机器绑定项（`trustedWorkspaces`、`remoteControlHostname`、`sidecars.*.projectId`），并将密钥/令牌、敏感命令行参数与请求头、URL 鉴权信息统一替换为 `<SET_IN_ENV>`；公开发布或分享前建议人工复核
- **无损导入保护** — 写入前先全量校验输入 JSON；深度合并 `settings.json` 时保留目标机原有的 `trustedWorkspaces`；绝不自动修改 `~/.gemini/config/config.json`（仅输出人工参考提示）；目标机已存在 `mcp_config.json` 时默认跳过，传入 `--merge-mcp` 才增量补充缺失项

## 卸载

卸载前务必**先解绑状态栏，再卸载插件包**，避免触发 Antigravity CLI 的 30 次失败熔断器。也可以在 Antigravity CLI 对话中直接运行 **`/hud uninstall`**（或 `/hud uninstall --purge`）。

### 推荐两步干净卸载

```bash
# 1. 恢复原有 statusLine、移除归属本安装的 `agy-hud` 命令并清理临时缓存（默认保留 hud-config.json）
node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs unwire

# 2. 移除插件包并清理宿主注册记录
agy plugin uninstall agy-hud
```

如需**零残留彻底清理**（额外移除 `hud-config.json` 与孤立的状态栏备份，并打印清理回执）：

```bash
node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs unwire --purge
agy plugin uninstall agy-hud
```

在当前活跃 CLI 会话内也可随时输入 `/statusline delete`，立即清除状态栏且无需重启。

### 文件清理范围

| 路径 / 项目 | 默认卸载（`unwire` + `agy plugin uninstall`） | 零残留（`unwire --purge` + `agy plugin uninstall`） |
| :--- | :---: | :---: |
| `~/.gemini/config/plugins/agy-hud/` 及 `config.json` / `import_manifest.json` | 清理 | 清理 |
| `~/.gemini/antigravity-cli/settings.json` 中归属本安装的 `statusLine` | 恢复 / 移除 | 恢复 / 移除 |
| 归属本安装的 `agy-hud` 命令（`~/.local/bin/agy-hud` 或 `%LOCALAPPDATA%\agy\bin\agy-hud*`） | 清理 | 清理 |
| 临时缓存（`~/.gemini/antigravity-cli/cache/agy_hud_*`） | 清理 | 清理 |
| `~/.gemini/antigravity-cli/hud-config.json` | 保留 | 清理 |
| 孤立的 `~/.gemini/antigravity-cli/cache/agy-hud-statusline-backup.json` | 恢复时清理 | 清理（若有其他活跃 `agy-hud` 接入则跳过） |

<details>
<summary><strong>乱序卸载恢复与源码 / Link Install 卸载</strong></summary>

- **未先 `unwire` 就执行了 `agy plugin uninstall agy-hud`**：在 Antigravity CLI 中执行 `/statusline delete`（或手动删除 `~/.gemini/antigravity-cli/settings.json` 中的 `statusLine`）。若 `PATH` 上仍残留 `agy-hud` 启动器，调用它会在 `stderr` 打印精确的 `rm` / `del` 手动清理命令（绝不自删）。
- **源码 / `Link Install` / 项目级卸载**：在本地源码仓库根目录运行 `node scripts/install.mjs uninstall --restore-statusline`（追加 `--purge` 零残留清理）。

</details>

## 工作原理

`agy-hud` 将 Antigravity CLI 的 `statusLine` stdin 载荷与严格只读的本机遥测、会话记录、SQLite/WAL 数据库、`/swarm` 成员表及带缓存的无锁 Git 状态结合，由同一套增量扫描与聚合管线驱动三个 CLI 端面，保证跨视图计数与顺序完全一致。

```text
 Antigravity CLI (stdin ~300 ms) ──┐
 本地 SQLite/WAL + 会话记录      ──┼──> 共享采集与聚合管线 ──> 终端 HUD / OSC 8 / CLI 快照
 /swarm 成员 + Git + 进程状态    ──┘                       （对 CLI 数据库目录严格只读）
```

| 端面 | 读取来源 | 呈现方式 |
| :--- | :--- | :--- |
| **终端 HUD**（`dist/hud.mjs`） | `statusLine` stdin、`hud-config.json`、会话记录、SQLite/WAL、`/swarm`、缓存 Git | 常驻 CLI 输入框下方的 ANSI 状态行 |
| **OSC 8 快照** | 同一次实时采集结果（按内容摘要门控） | 写入 `<cliHome>/cache/` 的 `0o600` Markdown |
| **CLI 与弹层**（`agy-hud` / `-p`） | CLI 会话索引、会话记录与 SQLite/WAL 数据库 | 终端快照、单键交互弹层或结构化 JSON |

更详细的架构分层与宿主协议见 [docs/architecture.md](docs/architecture.md) 与 [docs/host-contracts.md](docs/host-contracts.md)。

## 安全与可靠性

- **纯本地边界，零网络请求** — 仅读取 `statusLine` stdin JSON、本地 CLI 会话文件、本地 Git 状态（`--no-optional-locks`）及（迁移命令中的）`~/.gemini/config`；美元/人民币换算 100% 离线
- **零运行时依赖** — 构建为 5 个固定无哈希独立 ESM/类型文件（`dist/hud.mjs`、`dist/cli.mjs`、`dist/index.mjs`、`dist/index.d.mts`、`dist/types.d.mts`），仅使用 Node.js 内置模块与纯 TypeScript Protobuf 解码器
- **只读数据库访问与路径隔离** — CLI SQLite 与 WAL 文件严格只读（`?immutable=1` 或临时 `os.tmpdir()` 隔离副本，50 ms 超时，对数据库目录零写入）；所有缓存收口于 `<cliHome>/cache`（`0o600`），会话、记录与 Skill 路径均经可信根目录校验
- **归属校验与原子回滚** — `settings.json` 由单一带锁模块（`src/cli/installer/settings.ts`）写入；命令启动器携带 `agy-hud-shim:v1` 归属头并在 `wire`/`install` 时执行 5 秒 `--help` 冒烟门禁，绝不改写 shell rc 或 Windows 注册表；损坏的 JSON 报错并原样保留，失败事务按字节校验原子回滚

## 开发与验证

```bash
pnpm install
pnpm dev             # 启动本地 README 与文档预览站点
pnpm dist:check      # 校验仓内 dist/ 与 src/ 字节一致及 100755 可执行权限
pnpm verify          # 全量代码检查、格式校验、类型检查、构建、测试与工程守卫
pnpm validate:plugin # 运行官方 agy plugin validate --json 校验（需要本机 agy CLI）
```

`pnpm verify` 依次执行 `oxlint --type-aware --deny-warnings`、`oxfmt --check`、`tsc --noEmit`、`pnpm build`（Vite 8 + Rolldown）、隔离环境的 `node --test` 以及全仓架构与 Marketplace 清单守卫校验。

如需在不触碰日常 Antigravity 环境的前提下隔离演练，可通过 `GEMINI_CLI_HOME=<临时目录>`、`GEMINI_HOME=<临时目录>/.gemini` 与 `--target <临时插件目录>` 指定沙箱路径。

## 许可证

[MIT](LICENSE)。

## Star 历史

<a href="https://star-history.com/#ifelseboyxx/agy-hud&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=ifelseboyxx/agy-hud&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=ifelseboyxx/agy-hud&type=Date&theme=light" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=ifelseboyxx/agy-hud&type=Date" />
  </picture>
</a>
