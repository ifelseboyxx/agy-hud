---
name: agy-hud-configure
description: 配置 agy-hud 状态栏模块、预设方案（zen/minimal/compact/swarm/full）与展示选项，或在多台机器间导出导入脱敏的 Antigravity CLI 配置包。当需要切换 HUD 预设、插拔模块或跨机迁移配置时使用。
---

# agy-hud 展示配置与跨机迁移

通过 `agy-hud`（无 shim 回退路径：`node ~/.gemini/config/plugins/agy-hud/dist/cli.mjs`）管理 `<cliHome>/hud-config.json` 模块与展示选项，或执行脱敏配置导出与导入。

## 展示配置 (`configure`)

- 查看当前生效配置：
  ```bash
  agy-hud configure --show
  ```
- 启动交互式双层配置编辑器（第一层切换预设与实时预览，第二层按行插拔、排序模块与片段，需在交互式 TTY 终端中运行）：
  ```bash
  agy-hud configure -i
  # 或
  agy-hud configure --interactive
  ```
- 切换 5 种角色预设（默认 `full`）：
  - `full`（默认）：最多 8 行全量诊断（`mode` + `identity` + `usage` + 独立 `tools`、`skills`、`mcps`、`agents`、`todos`）
  - `zen`：极简 1 行（`identity` + 折叠 `Ctx`/`5h` 尾部）
  - `minimal`：2 行（`identity` + `usage`）
  - `compact`：3-4 行日常开发（`mode` + `identity` + `usage` + 单行高频 `activity` 摘要）
  - `swarm`：4-5 行多代理编排（`mode` + `identity` + `usage` + `agents` + `todos`）
  ```bash
  agy-hud configure zen
  agy-hud configure --preset swarm
  ```
- 插拔 `Line Module`（`mode|identity|usage|activity|tools|skills|mcps|agents|todos`）与 `Inline Segment`（`model|git|duration|badges|cost|perf|context|quota`），并自定义行顺序：
  ```bash
  agy-hud configure compact --enable tools,agents --disable activity,cost --order identity,usage,tools,agents
  ```
- 单独修改顶层选项（`osc8Links`、`maxAgentChips`）、片段（`segments.<id>`）或兼容旧 `show*` 别名：
  ```bash
  agy-hud configure --set osc8Links=false --set maxAgentChips=6 --set segments.perf=true
  agy-hud configure --set showCost=false --set showSkillsMcpLine=true
  ```
- 重置为默认 `full` 配置：
  ```bash
  agy-hud configure --reset
  ```

## 跨机迁移 (`export-profile` / `import-profile`)

- 导出脱敏配置包（自动剔除 `trustedWorkspaces`、`remoteControlHostname`、`sidecars.*.projectId` 与敏感密钥，并对 `hud-config.json` 按白名单校验与去重）：
  ```bash
  agy-hud export-profile --out ./agy-profile-bundle
  ```
- 在目标机器导入配置包（深度合并并保留目标机 `trustedWorkspaces`，不直接修改 `config.json`）：
  ```bash
  agy-hud import-profile --in ./agy-profile-bundle
  ```
