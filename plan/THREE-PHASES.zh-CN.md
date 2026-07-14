# 三期路线：先可靠，再协作，最后学习

## Phase 1：单 Agent 的可靠闭环

目标：在一个通用示例项目上证明以下最小链路可运行、可验证、可恢复。

```text
task.yaml
→ isolated worktree
→ Codex author
→ real command verification
→ evidence
→ ready
→ merged
→ done
```

只实现：Core、SQLite、Git/Worktree、CommandRunner、Codex Adapter、CLI、示例 Adapter、Evidence 失效和 Resume。

不实现：Subagent、Claude、Pi/DeepSeek、邮件、Memory、动态 DAG、自动 Merge、自动演进。

## Phase 2：有限多 Agent 与 Provider 韧性

目标：只增加三种固定模板，并验证它们是否产生净收益。

```text
solo:      Author → Verify
assisted:  Read-only Explorer → Author → Verify
reviewed:  Author → Verify + Independent Review → optional one Repair
```

增加：风险路由、Explorer、Reviewer/Finding、Provider Supervisor、Claude Code Adapter、Pi/DeepSeek Adapter、双 Primary Profile、最小 Outbox/Human Inbox。

仍禁止：任意动态 DAG、多 Agent 共享写目录、无限递归、模型投票、自动 Arbitration、自动 Memory。

## Phase 3：评价、轻量记忆与受控演进

进入条件：Phase 2 完成，且已有足够成功、失败、Fallback 和人工介入运行记录。

增加：Metrics、Historical Replay、Holdout、Candidate Memory、Change Proposal、Champion/Challenger、Offline Compare、Shadow、低风险 Canary 和配置回滚。

永远不允许模型自动修改：安全策略、Secret 处理、Tool 权限、正式 State/Gate、Acceptance、人工验收测试、自动 Merge、审计事实。

## 晋升原则

- 日期不是晋升条件，机器证据才是。
- 一期失败就修一期，不通过增加二期能力掩盖问题。
- 二期只有在能统计成本、延迟、Unique Confirmed Finding 和 False Positive 后，才进入三期。
- 三期没有 Holdout、Rollback 和明确 Guardrail 时，不能称为受控自进化。
