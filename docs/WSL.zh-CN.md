# WSL 运行与外部验证回退

正常情况下，连续执行器要求 Codex 在 `workspace-write` 沙箱内运行检查，然后由沙箱外的确定性执行器再次运行 `automation/manifest.json` 中的真实验证命令。

部分 WSL/aTrust 环境可以正常编辑文件，但 Codex 的 Linux 沙箱可能拒绝测试所需的子进程，或丢失测试运行器创建的临时目录，常见表现包括 `EPERM` 和随机临时目录下的 `ENOENT`。这不是测试通过，也不能把模型说明当作证据。

## 显式开启兼容回退

只在确认属于上述沙箱限制时，复制执行下面整段：

```bash
cd /home/test/code/agent-loop-harness-20260714-180429

export PATH="$HOME/.local/node22/bin:$HOME/.local/bin:$PATH"
hash -r

export CODEX_EXTERNAL_VERIFICATION_FALLBACK=1
node automation/continue.mjs phase-1
```

这个开关不会关闭 Codex 沙箱，也不会使用 `danger-full-access`。它只允许 Codex 返回结构化状态 `external_verification_required`。该状态必须同时记录：

- 实际尝试过但失败或无法取得退出码的命令；
- 真实错误；
- `not_verified` 中尚未验证的项目。

随后，连续执行器会在 Codex 沙箱外真实运行当前任务卡配置的验证命令。只有所有命令退出码都是 `0`，任务卡才会进入完成状态。外部验证失败时，仍然只允许任务卡配置的有限修复次数；耗尽后停止。

普通断言失败、类型错误、实现未完成、缺少依赖、网络/认证/额度故障或行为歧义不得使用该回退，仍会按原规则停止。默认不开启时，新的回退状态也会失败关闭。

阶段完成或不再需要兼容回退时可以关闭：

```bash
unset CODEX_EXTERNAL_VERIFICATION_FALLBACK
```
