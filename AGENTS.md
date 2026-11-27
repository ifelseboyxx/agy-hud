# AGENTS.md

- **依赖边界**：使用 `pnpm` 与 Node 标准库；运行时保持零外部 `dependencies`，新增开发依赖前先核查 `package.json`。
- **验证门禁**：改动源码、依赖或校验配置后必须跑通 `pnpm verify`（零错误、零警告；快速迭代可用 `pnpm check:fast`，自动格式化并验证可用 `pnpm verify:fix`）。
- **配置与归属红线**：只读 HUD 热路径（`readHudConfig` / `readCliSettings`）静默降级且永不写回用户配置；写路径（`configure`、installer、`migrate`）与 `doctor` 遇损坏或非法 UTF-8 JSON 须报错并原样保留；卸载恢复与 `off` 前校验 `statusLine` 归属且仅在写入成功后删除备份；多文件变更先全量预检并在失败时回滚。
- **跨宿主零写入**：读取 Antigravity App 数据目录与 SQLite/WAL 保持严格只读（禁止就地 checkpoint 或改写目录项），诊断样本使用隔离 CLI Home。
- **提交授权**：未经用户明确指令不执行 `git commit` / `git push`，改动默认停留在工作区待审阅；获授权后按 `.commitlintrc.cjs` 规范提交。

## References

- 审查判断规范（阳性对照、symlink 校验边界、并发与四端测试粒度、未发布格式策略）：`CODING_STANDARDS.md`
- 维护 `.scratch/<feature>/` 规格、ticket 生命周期或 `/wayfinder`：`docs/agents/issue-tracker.md`
- 应用或解释 issue triage 标签：`docs/agents/triage-labels.md`
- 命名领域概念、查术语或记录 ADR：`docs/agents/domain.md` -> `GLOSSARY.md` / `docs/adr/`
- 改动分层、数据流、持久化或专项一致性测试：`docs/architecture.md`
- 改动 protobuf、SQLite/WAL、transcript、OSC 8 或 MCP 宿主协议：`docs/host-contracts.md`
