---
type: Runbook
title: Local Steward And Review Workflow Runbook
description: 使用 CLI 启动、检查、追踪、人工接管和取消 autonomous/manual/Steward Run，并通过 review@1 执行审查协作。
tags: [rollerskate, local, agent-run, steward, orchestrator, review, workflow, cli, console]
timestamp: 2026-07-26
---

# Local Steward And Review Workflow Runbook

Steward 不依赖 Server 或 Matrix。公共 start 只接受 `RunIntent@1`，由 Owner 持有的 deterministic compiler 通过 canonical spec registry 按显式 `stewardRef` 或 Owner policy 选择 active Local Agent 作为 Orchestrator（未配置时默认 `codex`），解析 participant/workspace/destination reference，并固定 `RunAuthorityEnvelope@1`。Steward 不是 Agent 类型。指定负责人/执行者及二人 roster 的约束见 [CLI Reference](./cli-reference.md#显式指定负责人和执行者)。Runtime 为每个参与 Agent 建立 Run 专属 Session；旧 autonomous/manual raw input 只保留为内部 legacy seam。default steward 固定 `OrchestratorBinding@3`，先由选中的 Steward `RunDecision@6` 拆分并选择首个 Worker，之后按 Worker checkpoint 继续编排或绑定已准入 source，失败时可人工接管。CLI 使用简短的 `run` 子命令，持久对象使用 `agent_runs` 与 `agent_run_decisions`，都属于 Steward application domain。

## 1. 准备 Agent

```bash
scripts/rs agent create codex --client codex
scripts/rs agent create reviewer --client claude-code
scripts/rs agent create implementer --client kimi-code
```

Agent Run 不固定 Reviewer/Implementer 名单，也不限制某种 client 只能承担某种角色。autonomous Steward 或 workflow 可以顺序委派任意 active Local Agent；checkpoint-driven mode 只能从 admission roster 选择下一 Agent。当前只有 Orchestrator 必须是 handle/client 均为 `codex`；每轮最多一个 child/next step，没有 fan-out/join。

## 2. 创建 Run 文件

只读 objective：

```json
{
  "schemaVersion": "RunIntent@1",
  "requestId": "review-acceptance-1",
  "objective": "检查当前实现是否满足计划，并给出可验证结论。",
  "acceptance": ["给出 exact implementation 和 test evidence"],
  "contextRefs": ["release:acceptance"],
  "workspaceRef": "file:///absolute/path/to/git-worktree",
  "desiredEffect": "read",
  "requestedParticipantRefs": ["agent:reviewer"],
  "terminalEvidence": ["review artifact"]
}
```

需要修改 workspace：

```json
{
  "schemaVersion": "RunIntent@1",
  "requestId": "fix-acceptance-1",
  "objective": "修复验收缺口并验证。",
  "acceptance": ["缺口关闭且验证通过"],
  "contextRefs": ["release:acceptance"],
  "workspaceRef": "file:///absolute/path/to/git-worktree",
  "desiredEffect": "change",
  "terminalEvidence": ["changed workspace revision", "test receipt"]
}
```

`workspaceRef` 接受 `project:self`、`local:workspace` 或显式本机 `file://` Git workspace。`desiredEffect: read` 编译为只读 grant，`change` 编译为 `write + must_change`；省略 workspace 时 effect 只能省略或为 `none`。participant 使用 `agent:<handle>` / `principal:<id>`，result destination 使用已登记的 `destination:<dst-id>`。compiler 固定 canonical root、revision、roster、network off 和 budget；无法解析或合同冲突时 fail closed。

## 3. 启动与推进

```bash
scripts/rs run preflight /absolute/path/to/run-intent.json
scripts/rs run start /absolute/path/to/run-intent.json
scripts/rs start --no-open
```

`preflight` 不创建 Event/Execution/Run；start 使用 intent 内的 `requestId` 作为本地幂等键，相同 request 返回原 Run。内部 legacy autonomous mode 的每个 turn 必须返回一个 `AgentTurnResult@1`：

- `complete`：以 `succeeded | failed | needs_human` 完成当前 step；
- `delegate`：指定一个 child Agent，并给出 bounded objective 或 workflow invocation。

Agent 不填写 callback target。Runtime 从 caller 的 Run Session 固定 callback binding；child provider retry 不 callback，child terminal 后只恢复一次 caller。A → B → C 会形成 durable async call stack，B 的完成先回 B 的 caller，再由 B 决定如何回 A。

default steward 的第一个 Agent invocation 就是准入选中的 Orchestrator：它在 `stepCount = 0` 时读取 objective、remaining budget、participant roster 和 admitted authority，建立最多 32 个结构化 task 的 `OrchestratorState@1`，并用 strict `RunDecision@6` 选择首个 Worker。之后 checkpoint-driven Worker 必须返回 `AgentStepResult@1`；结果不会直接完成整个 Run，而是形成 `AgentRunCheckpoint@1`，状态进入 `awaiting_orchestrator`，同一 Steward Session 再读取 checkpoint 与历史状态做下一次 decision。

如果 Orchestrator 输出 malformed/stale/越权 decision，或返回未在 registry/authority 中登记的 source template，Runtime 保留 current decision source：后续轮次保留 Worker checkpoint，首轮则保留 `stepCount = 0` 的初始 source。此时先用 `inspect` 读取 current state 和 Run version，再提交 manual `RunDecision@1`：

```json
{
  "schemaVersion": "RunDecision@1",
  "action": "next_step",
  "expectedRunVersion": 2,
  "rationale": "首轮发现已修复，需要同一 Agent 复查。",
  "checkedAcceptance": ["已记录修复证据"],
  "nextStep": {
    "target": { "kind": "self" },
    "mandate": {
      "kind": "objective",
      "objective": "复查修复并运行验收测试。"
    }
  }
}
```

```bash
scripts/rs run inspect <run-id>
scripts/rs run decide <run-id> /absolute/path/to/decision.json --request-id review-next-1
```

`expectedRunVersion` 必须使用 inspect 返回的当前值。action 还可以是 `finish` 或 `needs_human`；`next_step` 只能选择 `self` 或 admission 时固定且当前仍 active 的 exact Agent。manual decision 不能伪造 `RunDecision@3` 的 Orchestrator task state，也不能提交 `await_source`。

## 4. 查询、决定与取消

```bash
scripts/rs run list
scripts/rs run list --limit 20
scripts/rs run inspect <run-id>
scripts/rs run trace <run-id>
scripts/rs run decide <run-id> /absolute/path/to/decision.json --request-id <idempotency-key>
scripts/rs run cancel <run-id>
```

`inspect` 与 `trace` 返回同一 application detail：Run summary/projection、orchestration binding、participants、current checkpoint、完整 orchestration history、Run Sessions、delegate/callback exchanges、directional counts、完整 Event trace，以及 external workspace 当前 revision。Steward Console `/console/steward` 展示相同事实，并可取消 `active | waiting | awaiting_orchestrator` Run。Schedules 与 Subscriptions 页面分别在自己的 ScheduledRun 或 one-shot fire 下展示自己的 conversation；三处只共享 invocation 展示组件。

`cancel` 幂等地停止尚未开始的 work、retry、delegate、child 和 callback admission；不会强杀已经运行的 provider process。late result 只保留审计，不能恢复 cancelled Run。

Crash recovery 使用通用 Runtime 入口：

```bash
scripts/rs recover
scripts/rs start --no-open
```

Run continuation、child/callback/checkpoint admission 与 Result Execution completion在同一 SQLite transaction 中提交；accepted decision 与下一 Event/Execution 或 terminal transition 也原子提交。duplicate result、decision retry、ResultHandler retry 或 restart 不能建立第二个后继。restart 后的 `awaiting_orchestrator` checkpoint 保持可 inspect/decide，不会自行重跑 Worker。

## 当前限制

- 每次 transition 只允许一个 autonomous child 或 caller next step；没有 fan-out、join 或 Chat 自动升级为 Run。
- external workspace 是显式 Owner grant，不是 Chat sandbox；多个 workspace 或自动 worktree provisioning 尚未实现。
- workflow 是源码内 versioned resource，不是用户可安装的任意 Workflow DSL。
- Run 不自动 commit、push、创建 MR 或扩大 filesystem/network/process 权限。
- 当前 Orchestrator 固定为 active `codex` handle/client；动态 allocation 尚未实现。
- Vikunja Task 只接收 terminal writeback；Codex task/thread 的异步 checkpoint/terminal reply delivery 尚未实现。
