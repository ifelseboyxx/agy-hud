# AGENTS.md

本文件仅记录 `agy-hud` 仓库的非显而易见工程约定与硬性门禁。

- **运行环境基线**：本仓仅使用 `pnpm` 与 Node `^22.20.0 || >=24.0.0`（安装依赖前由 `preinstall` 触发 `scripts/check-env.mts` 强制校验）。
- **依赖与实现边界**：运行时默认保持零外部 `dependencies`，优先使用 Node `>=22.20` 标准库；涉及脚本、构建或静态校验需新增依赖或手写通用逻辑前，先核查 `package.json` 现有依赖（如 `oxc-*`、`rolldown`）是否已覆盖。
- **工程验证与 IDE 一致性**：修改源码、依赖或验证配置后须跑通 `pnpm verify`（零错误、零警告）；若出现命令通过但 IDE 报红，核对报错文件最近祖先 `tsconfig.json` 归属（`src/`、`scripts/`、`tests/` 与 `vite.config.ts` 均须被根 `tsconfig.json` 直接收录）与 `.oxlintrc.json` 的 `typeAware` 及目标范围至零诊断。
- **结构守卫与测试隔离**：单元测试放被测文件同级 `__tests__/`，跨模块与工程门禁测试放顶层 `tests/`；所有测试进程经 `node --import ./scripts/lib/isolate-git-env.mts --test` 预加载剥离 `GIT_*` 环境变量，避免在 Git 钩子或 rebase 期间污染宿主仓；单文件不超过 500 行且全仓禁止 pictographic emoji。
- **配置所有权与失败语义**：缺失的用户配置文件允许初始化，损坏或不可读的 JSON 须报错并原样保留、禁止当空对象覆盖；卸载恢复与 `off` 停用前须校验当前 `statusLine` 归属本次安装，且仅在写入成功后删除备份；多文件变更（安装升级、配置导出/导入）须先全量校验输入与目标状态，并在中途失败时回滚已写入变更。
- **用户配置单一写入者**：`<cliHome>/settings.json` 的 `statusLine` 及其备份只经 `src/cli/installer/settings.ts` 一处写入，禁止新增第二处写入方。
- **共享能力单一实现**：`src/` 与 `scripts/` 不得各自实现同一能力（路径与 cliHome 解析、JSON 读写、文件锁、`statusLine` 归属判定）；`validate-architecture` 以 `KNOWN_DUPLICATE_FUNCTIONS` 棘轮（剥离 `Sync`/`Async` 后缀并按文件去重）拦截新增跨模块重复顶层函数，基线只减不增。
- **未发布格式不做兼容**：首次公开发布前，自有持久化格式（备份、缓存、`hud-config.json`）变更直接升级，不写 legacy 分支与迁移测试；发布后的兼容分支须注明引入版本与移除条件。
- **测试粒度与耗时**：一个 `it` 只断言一条行为，标题不以「and / 逗号」串联多个场景；`__tests__/` 单元测试应在 `500ms` 以内，`tests/` 集成测试允许约 `2s`，整体以 `pnpm test` 在 `10s` 以内为观察线（超线再考虑加自动门禁），优先单进程调用、注入时钟或缩短锁超时。
- **提交信息规范**：人工交互提交使用 `pnpm cz`；未经用户明确授权不执行 `git commit` / `git push`，改动默认停留在工作区待审阅。获授权后按 `.commitlintrc.cjs` 执行 `git commit -m "type(scope): 短句"`，允许的 `scope` 为 `root`、`hud`、`collectors`、`render`、`cli`、`skills`、`scripts`、`tests`、`docs`、`deps`。

## Agent skills

### Issue tracker

Issues and specs are tracked as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default canonical triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` + `docs/adr/` at the repo root, created lazily). See `docs/agents/domain.md`.
