# Agent Loop Harness：Codex 连续施工包

这是一个**全新、独立、通用**的 Agent Loop/Harness 仓库起点。它不会读取、修改或依赖任何既有业务仓库。

本包解决两个问题：

1. 用三期、有限任务卡构建脚手架，避免一次性过度设计。
2. 让 Codex 在当前一期内持续工作：一张任务卡完成并通过真实验证后，自动进入下一张；中断后重跑同一命令即可恢复。

## 最短使用路径

```bash
# 1. 解压后进入目录
cd agent-loop-harness-codex-continuous-starter

# 2. 初始化 Git、安装依赖、检查 Codex 登录
node automation/setup.mjs

# 3. 让 Codex 连续完成第一期
node automation/continue.mjs phase-1

# 4. 查看进度
node automation/status.mjs
```

也可使用 npm 别名：

```bash
npm run codex:phase1
npm run codex:status
```

第一期完成后先人工检查 Diff 和测试，再运行：

```bash
npm run codex:phase2
```

第三期只有在第二期完成且已有真实运行数据后再执行：

```bash
npm run codex:phase3
```

## 持续 working 的实际含义

`automation/continue.mjs` 不会启动一个无限长、不可恢复的对话。它会：

1. 按 `automation/manifest.json` 顺序读取任务卡。
2. 每张卡启动一个新的 `codex exec --json` 调用。
3. 保存 JSONL 事件、最终结构化报告和 stderr。
4. Codex 报告完成后，由普通进程真实运行 `npm run typecheck` 和 `npm test`。
5. 验证失败时，最多再给 Codex 一次修复机会。
6. 短暂失败时有限重试；额度、认证或持续失败时停止。
7. 已完成任务写入 `.codex-work/state.json`；重跑命令会跳过已完成卡片。
8. 每一期 Gate 后停止，不会自动跨期扩张。

输出目录：

```text
.codex-work/
  state.json
  runs/<task-id>/<attempt>/
    events.jsonl
    final.json
    stderr.log
    verification.log
    thread-id.txt
```

`.codex-work/` 已加入 `.gitignore`。

## 中断和恢复

网络波动或进程中断后，直接重跑当前期：

```bash
node automation/continue.mjs phase-1
```

执行器会从首个未完成任务继续。若某次 Codex 调用已产生 Session ID，运行目录中会保存 `thread-id.txt`，可人工恢复：

```bash
codex exec resume <SESSION_ID> \
  "Inspect the current repository state and continue the bounded task."
```

默认自动恢复策略刻意保持简单：

- 短暂网络/服务错误：最多重试一次。
- 验证失败：最多追加一次修复调用。
- Quota 或认证错误：立即停止，不反复消耗请求。
- 不明错误：有限重试后停止。

## 一段 Prompt 模式

更推荐上述执行器。若你希望在 Codex 交互界面中用一段 Prompt 连续完成第一期，复制 `START-CODEX.md` 的全部内容。

不要在一个 Codex 会话中让 Codex 再调用 `codex exec`；这会形成递归调用。执行器模式由你在终端启动，交互模式则由当前 Codex 直接逐卡实施，二选一。

## 安全和 KISS 边界

- 默认 `workspace-write`，无沙箱内网络。
- 不使用 `danger-full-access`。
- 一个仓库、一个本地状态写入者、一个可写 Author。
- 第一期不使用 Subagent、跨 Provider、Memory、Hook、动态 DAG、自动 Merge 或自动演进。
- LLM 输出不是命令执行证据。
- 状态推进必须依赖真实退出码和绑定当前 Commit 的 Evidence。
- 任何外部业务项目仅能在脚手架稳定后通过独立 Adapter 接入。

## 三层运行边界

这三个入口用途不同，不能互相冒充：

```text
automation/continue.mjs
= 构建本仓库的 Bootstrap Driver，只按任务卡推进脚手架施工

src/cli.ts + Orchestrator
= 对目标项目执行开放 Loop 的产品 Runtime，唯一能够推进正式 Run

src/evaluation | src/memory | src/evolution
= 旁路评估与受控演进 Sidecar，只读脱敏 Fact，不得控制正式 Run
```

Phase 3 新增独立的 `evaluation.sqlite`、Historical Replay、Golden/Holdout Dataset、Metrics、
Candidate Memory、Champion/Challenger、Offline Compare、Shadow 和低风险 Canary。Memory Retrieval
与 Canary 均默认关闭；Fixture 只能证明机制可运行，数据不足时 Readiness 必须保持关闭，不能宣称生产收益。

常用只读入口：

```bash
npm run loop -- metrics summary
npm run loop -- eval readiness
npm run loop -- replay --run-id <RUN_ID> --mode verify-only
npm run loop -- memory list
npm run loop -- config champion --project <PROJECT_SCOPE>
npm run loop -- canary status
```

## Outbox 邮件通知与 Metrics Digest

通知由两个彼此独立的 SQLite Transactional Outbox 保存：正式 Run 通知写入
`state.sqlite`，Phase 3 Proposal、Evaluation、Shadow、Canary、Candidate Memory 与
Metrics Digest 通知写入 `evaluation.sqlite`。以下命令会同时报告或投递两个 Outbox，
但各自独立记录成功、重试与 Dead Letter：

```bash
npm run loop -- notify dispatch
npm run loop -- notify status
npm run loop -- notify dead-letters
npm run loop -- notify digest --period daily
npm run loop -- notify digest --period weekly
```

`notify digest` 只读取已结束的 UTC 日/周时间窗，渲染 Digest，并以稳定去重键写入
Evolution Outbox。它不会在进程内启动 Scheduler。由外部 Cron 负责先生成 Digest，
再投递到 SMTP，例如：

```cron
# 每天 UTC 00:05 生成上一完整日的 Digest，00:10 投递两个 Outbox
5 0 * * * cd /path/to/agent-loop-harness && npm run loop -- --loop-home /var/lib/agent-loop notify digest --period daily
10 0 * * * cd /path/to/agent-loop-harness && npm run loop -- --loop-home /var/lib/agent-loop notify dispatch

# 每周一 UTC 00:15 生成上一完整七日的 Digest
15 0 * * 1 cd /path/to/agent-loop-harness && npm run loop -- --loop-home /var/lib/agent-loop notify digest --period weekly
```

SMTP 端点、发件人、收件人和凭据只从调用方注入的 Secret 环境变量读取，不写入
SQLite、日志或示例配置：

```text
AGENT_LOOP_SMTP_HOST
AGENT_LOOP_SMTP_PORT
AGENT_LOOP_SMTP_SECURITY=tls|starttls|none
AGENT_LOOP_SMTP_USERNAME
AGENT_LOOP_SMTP_PASSWORD
AGENT_LOOP_SMTP_TIMEOUT_MS
AGENT_LOOP_EMAIL_FROM
AGENT_LOOP_EMAIL_TO

AGENT_LOOP_NOTIFY_MAX_ATTEMPTS
AGENT_LOOP_NOTIFY_BASE_DELAY_MS
AGENT_LOOP_NOTIFY_MAX_DELAY_MS
AGENT_LOOP_NOTIFY_BATCH_SIZE
```

邮件投递不是 Loop State，邮件成功不是 Gate。邮件、Digest、Replay、Memory、Shadow
或 Canary 通知失败，只能更新对应 Outbox 的重试或 Dead Letter 字段，不得回滚已经
完成的开发结果，也不得修改正式 Run、Operation、Event、Evidence 或 Finding。
Evolution Outbox 没有正式 Run 的写权限。

## 文件索引

- `START-CODEX.md`：可直接粘贴给 Codex 的单段总 Prompt。
- `AGENTS.md`：全仓库约束。
- `plan/THREE-PHASES.zh-CN.md`：三期路线。
- `tasks/`：有限任务卡。
- `automation/continue.mjs`：连续执行器。
- `automation/status.mjs`：状态查看。
- `automation/manifest.json`：任务顺序和验证命令。
- `automation/report.schema.json`：Codex 最终报告 Schema。
