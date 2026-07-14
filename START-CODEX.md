你正在一个全新的、独立的 `agent-loop-harness` 仓库中工作。

先读取并严格遵守：

- `AGENTS.md`
- `plan/THREE-PHASES.zh-CN.md`
- `automation/manifest.json`
- `tasks/phase-1/` 下的任务卡

你的当前目标是：**连续完成 Phase 1，但不得进入 Phase 2。**

执行方式：

1. 按 `automation/manifest.json` 中 Phase 1 的顺序逐张处理任务卡。
2. 每次只实施当前任务卡的最小完整范围；不得提前实现后续任务。
3. 开始每张卡前检查 Git 状态和已有实现，保证重复执行是安全的。
4. 每张卡完成后真实运行任务卡要求的检查，以及：
   - `npm run typecheck`
   - `npm test`
5. 只有真实命令退出码为 0，才能把该卡视为完成。
6. 当前卡完成后，不等待我确认，立即继续下一张卡。
7. 若检查失败，先在当前卡范围内修复一次并重新验证。
8. 只有以下情况才停止：
   - 行为级歧义无法从当前仓库、测试或文档解决；
   - 需要 Secret、越权访问或仓库外写入；
   - 环境故障使真实验证无法进行；
   - 当前卡必须违反 `AGENTS.md` 才能继续；
   - Phase 1 Gate 已全部通过。
9. 不得调用另一个 Codex、不得创建 Subagent、不得运行 `codex exec`，因为当前会话本身就是唯一 Author。
10. 不得访问任何外部业务仓库，也不得添加任何项目特有术语或特例。

在工作过程中保持 KISS：

- 不建立动态 Agent DAG。
- 不建立分布式 Lease/Fencing。
- 不建立向量数据库、Web UI、自动演进或完整 Hook 平台。
- 不把 plan、review、fix、learn 建成顶层持久状态。
- 不用长文档代替可运行代码和测试。
- 不为了理论上可能但尚未出现的故障增加复杂边界。

Phase 1 的完成证据必须包括：

- `open -> ready -> merged -> done` 的确定性状态转换；
- SQLite 状态与事件事务；
- 独立 Git worktree；
- 真实 CommandRunner 退出码；
- Codex CLI Adapter 的结构化事件捕获；
- 一个非业务化示例 Project Adapter；
- Commit 变化使相关 Evidence 失效；
- 崩溃或中断后可恢复；
- Fake Provider 驱动的端到端测试；
- 所有 typecheck 和 test 真实通过。

Phase 1 Gate 通过后停止，给出：

- 实际修改文件；
- 实际执行命令及退出码；
- 已验证能力；
- 尚未验证事项；
- 剩余风险；
- 推荐 Commit Message；
- 人工进入 Phase 2 前应检查的事项。

现在开始执行 Phase 1 第一张未完成任务卡，并持续工作到 Phase 1 Gate 或明确阻塞。
