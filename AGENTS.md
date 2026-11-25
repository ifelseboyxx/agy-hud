# AGENTS.md

- **运行环境与依赖边界**：仅使用 `pnpm` 与 `package.json` 声明的 Node 版本（`preinstall` 强制校验）；运行时保持零外部 `dependencies`，优先使用 Node 标准库，新增开发依赖或通用工具前先核查 `package.json` 现有依赖。
- **工程验证与 IDE 一致性**：修改源码、依赖或校验配置后必须跑通 `pnpm verify`（零错误、零警告）；新建或移动的 `src/`、`scripts/`、`tests/` 与 `vite.config.ts` 文件须被根 `tsconfig.json` 直接收录，并与 `.oxlintrc.json` `typeAware` 保持零诊断。
- **结构守卫与测试隔离**：单元测试放同级 `__tests__/`，跨模块与工程门禁测试放顶层 `tests/`；测试经 `pnpm test` 预加载剥离 `GIT_*`；单文件不超过 500 行，全仓禁止 pictographic emoji。
- **配置所有权与失败语义**：缺失的用户配置文件允许初始化；写路径（`configure`、installer、`migrate`）与 `doctor` 遇到损坏或非法 UTF-8 JSON 须报错并原样保留、禁止覆盖；只读 HUD 热路径（`readHudConfig` / `readCliSettings`）静默降级且永不写回用户配置，避免触发宿主 30 次失败熔断。卸载恢复与 `off` 停用前须校验 `statusLine` 归属本次安装，且仅在写入成功后删除备份；多文件变更先全量预检，失败时回滚已写入变更。
- **并发与轮询一致性**：改动交互式配置保存须用锁内交错测试验证 stale draft 拒绝并保留并发写入；改动 HUD Inspector 轮询或宿主推送须用交错测试验证按 `session + source + request sequence` 双向丢弃过期 push/poll 响应，超时后允许重试。
- **单一写入者与单一实现**：`<cliHome>/settings.json` 的 `statusLine` 及备份只经 `src/cli/installer/settings.ts` 写入；`src/` 与 `scripts/` 共享能力保持单一实现，`validate-architecture` 的 `KNOWN_DUPLICATE_FUNCTIONS` 棘轮只减不增。
- **跨宿主读取与四端一致**：改动跨宿主会话读取须用临时 App 根目录验证读写前后目录项与内容零变更（含关闭写者后的 WAL 场景），诊断样本使用隔离 CLI Home；改动 transcript 续读或 Activity Snapshot 聚合须用同一夹具校对 HUD、OSC 8 Markdown、CLI `snapshot`、MCP `HUD Inspector` 四入口（含同 inode 同长度改写），宽度裁剪与展示顺序由各入口测试。
- **未发布格式策略**：首次公开发布前，自有持久化格式（备份、缓存、`hud-config.json`）直接升级，不写 legacy 分支或迁移测试；发布后的兼容分支须注明引入版本与移除条件。
- **测试粒度与耗时**：单个 `it` 只断言一条行为，标题不串联多个场景；`__tests__/` 单测应在 `500ms` 内，`tests/` 集成测试约 `2s`，`pnpm test` 总耗时以 `10s` 为观察线。
- **提交授权与规范**：未经用户明确指令不执行 `git commit` / `git push`，改动默认停留在工作区待审阅；获授权后按 `.commitlintrc.cjs` 提交 `type(scope): 短句`（允许 `scope`：`root`、`hud`、`collectors`、`render`、`cli`、`skills`、`scripts`、`tests`、`docs`、`deps`）。

## References

- 维护 `.scratch/<feature>/` 规格、ticket 生命周期或 `/wayfinder`：`docs/agents/issue-tracker.md`
- 应用或解释 issue triage 标签：`docs/agents/triage-labels.md`
- 命名领域概念、查术语或记录 ADR：`docs/agents/domain.md` -> `GLOSSARY.md` / `docs/adr/`
- 改动分层、数据流、持久化或专项一致性测试：`docs/architecture.md`
- 改动 protobuf、SQLite/WAL、transcript、OSC 8 或 MCP 宿主协议：`docs/host-contracts.md`
