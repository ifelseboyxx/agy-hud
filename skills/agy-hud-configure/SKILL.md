---
name: agy-hud-configure
description: 配置 agy-hud 展示预设与开关选项，或在多台机器间导出导入脱敏的 Antigravity CLI 配置包。当需要切换 HUD 预设、调整展示片段或跨机迁移 CLI 配置时使用。
---

# agy-hud 展示配置与跨机迁移

通过 `dist/cli.mjs` 管理 `<cliHome>/hud-config.json` 展示选项，或执行脱敏配置导出与导入。

## 展示配置 (`configure`)

- 查看当前生效配置：
  ```bash
  node dist/cli.mjs configure --show
  ```
- 切换预设（`full` | `compact` | `minimal`）：
  ```bash
  node dist/cli.mjs configure --preset compact
  ```
- 单独修改开关或芯片上限：
  ```bash
  node dist/cli.mjs configure --set showPerfCapsule=true --set maxAgentChips=4
  ```
- 重置为默认配置：
  ```bash
  node dist/cli.mjs configure --reset
  ```

## 跨机迁移 (`export-profile` / `import-profile`)

- 导出脱敏配置包（自动剔除 `trustedWorkspaces`、`remoteControlHostname`、`sidecars.*.projectId` 与敏感密钥）：
  ```bash
  node dist/cli.mjs export-profile --out ./agy-profile-bundle
  ```
- 在目标机器导入配置包（深度合并并保留目标机 `trustedWorkspaces`，不直接修改 `config.json`）：
  ```bash
  node dist/cli.mjs import-profile --in ./agy-profile-bundle
  ```
