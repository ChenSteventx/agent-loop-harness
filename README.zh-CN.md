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

## 安装为命令与 Skill

`npm i -g .` 把 harness 装成 `agent-loop` 命令（本仓仍保持 private，不发布 npm）；
不装则用 `npm run loop --` 从检出目录跑。`skills/agent-loop/` 是一个 Claude Code
skill，驱动单次受限运行并如实汇报 harness 裁定（确定性权威：提交与裁定归 harness）；
`ln -s "$(pwd)/skills/agent-loop" ~/.claude/skills/agent-loop` 激活后用 `/agent-loop`
调用，详见 `skills/README.md`。

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
npm run loop -- eval compare list --project <PROJECT_SCOPE>
npm run loop -- memory list
npm run loop -- config champion --project <PROJECT_SCOPE>
npm run loop -- canary status
```

## Full-task Replay 与可执行 Offline Compare

Verify-only Replay 只重验历史 Commit；Full-task Replay 会在钉住 Baseline Commit 的隔离
Evaluation Worktree 里重新执行整个任务（Author 产出 → Harness 提交 → 真实验证命令），
全程不写 `state.sqlite`。变体配置中的 `providerOrder`、`retryLimit`、`timeoutMs`
会真实生效，因此比较测量的是配置差异而不是提示词漂移。

```bash
# 从真实 Run 导出带 source 指针的 Historical Dataset（不改动检入的 eval/ 目录）
npm run loop -- eval dataset export --run-id <RUN_ID> --id <DATASET_ID> --out <FILE>

# Full-task Replay：默认使用当前 Active Champion，或用 --variant-id 显式指定
npm run loop -- replay --run-id <RUN_ID> --mode full [--variant-id <VARIANT_ID>]

# 对 Champion 与 Challenger 各跑 Full-task Replay，落库真实 Offline Comparison；
# 数据集任务缺 source 指针或不可完整重放时立即中止（fail-closed）
npm run loop -- eval compare run --id <COMPARISON_ID> --proposal-id <PROPOSAL_ID> [--dataset-dir <DIR>]
```

整套演进周期可纯 CLI 驱动，无需 seed 脚本：`config champion-init` 建初始
Champion（在任何正式 Run 之前就能建，只开 Evaluation 库、拒绝覆盖已有
Champion），`proposal create --dataset-dir` 让提案引用自定义数据集目录。之后
`proposal approve` / `proposal challenger` / `eval compare run` 即可跑完
Champion→提案→Challenger→比较。

```bash
npm run loop -- config champion-init --project <PROJECT_SCOPE> [--version <V>] [--config <JSON>]
```

Change Proposal 只允许已真实接线的 Target（`provider-routing`、`retry-policy`、
`timeout-policy`）；其余词汇表条目在对应 Runtime 接线与契约测试落地前会被
`unsupported-runtime-target` 拒绝，杜绝「晋升一个从不生效的配置」。

## Canary 分配与观测的事实来源

`canary assign` 的 Policy 完全由人工批准记录推导（流量比例、允许项目、任务上限、
时间窗、额外预算），环境变量不控制任何范围；Assignment 落库 `approvalId`、
`policyHash` 与 `expiresAt`。`canary observe` 只接受标识符：它校验正式 Run Binding
与 Assignment 的绑定关系，导出该 Run 的脱敏事实，再确定性投影
ready/done/verificationFailures/postMergeFailures/humanEscalation/latency/tokens——
操作者无法口述运行结果。

```bash
npm run loop -- canary approve --id <APPROVAL_ID> --proposal-id <PROPOSAL_ID> \
  --challenger-id <VARIANT_ID> --approved-by <WHO> --reason <WHY> \
  --expires-at <ISO_TIMESTAMP> [--basis-points N] [--maximum-tasks N]
npm run loop -- canary assign --id <ASSIGNMENT_ID> --comparison-id <COMPARISON_ID> \
  --task-key <TASK_ID> --risk low --approval-id <APPROVAL_ID>
npm run loop -- canary observe --id <OBSERVATION_ID> --assignment-id <ASSIGNMENT_ID> --run-id <RUN_ID>
```

## 运行时演进配置

演进 target 中真正接线到正式执行的有：`prompt-variant`（有界模板注册表选
author 提示词）、`provider-routing`、`role-model-selection`（逐次调用的模型
覆盖，参数与身份记录同步生效；提案仅限 author 席位）、`retry-policy`、
`timeout-policy`、`memory-retrieval`（人工审批过的记忆按仓库标识精确匹配后，
以有界 advisory 冻进 Run Binding）。`low-risk-review-rubric` 已接线（低风险
评审提示词消费）但暂不可提案——离线评价器没有 reviewer 席位、量不出它的
效果；先由人工安装的 Champion 配置直接设置。`run --template reviewed` 可把
执行模板升到风险下限之上（只许升不许降），让低风险 Run 也能走独立评审。

## 派生视图与类型化恢复处置

`status --derived` 在持久状态之外输出一份只读派生视图：下一步动作、证据缺口
快照（不触发任何写回或对账）、预算使用情况，以及阻塞 Run 的类型化恢复处置。
恢复处置是四选一的封闭联合：`retryable`（含建议等待时间）、`already-committed`、
`human-action-required`（含具体动作）、`terminal`——消费方按类型分支，不再解析
自由文本。

```bash
npm run loop -- status --run-id <RUN_ID> --derived
```

## 声明式项目接入（非 Node 项目）

多数项目不需要写 TypeScript Adapter，一份 JSON 配置即可接入：

```bash
cat > project.json <<'JSON'
{
  "name": "python-service",
  "policyVersion": "python-service/v1",
  "sensitivePathSegments": ["payments/", "auth/"],
  "rewriteNodeCommands": false
}
JSON

npm run loop -- --project-config project.json run --task ... --repository ...
```

验证命令来自任务文件本身，任何能把检查表达为 argv 命令的技术栈都能接入
（也可用环境变量 `AGENT_LOOP_PROJECT_CONFIG` 指定路径）。边界与既有 Adapter
完全一致：配置表达不了 Adapter 端口之外的任何权力——没有 Git 元数据权、
没有裁定权、没有晋升权。`sensitivePathSegments` 必填，「没有敏感路径」必须
显式写 `[]`；校验通过的配置内容会哈希进生效的 Policy 版本并冻结进 Run
Binding，恢复时改配置文件会直接阻塞 Run，而不是悄悄改判风险。

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
