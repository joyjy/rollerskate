---
type: Runbook
title: Local Agent Run And Review Workflow Runbook
description: 使用 CLI 启动、检查、追踪和取消通用 Agent Run，并通过 review@1 执行审查协作。
tags: [rollerskate, local, agent-run, steward, review, workflow, cli, console]
timestamp: 2026-07-26
---

# Local Agent Run And Review Workflow Runbook

Agent Run 不依赖 Server 或 Matrix。Owner 选择一个 active Local Agent 作为本 Run 的 Steward；Steward 是临时角色，不是 Agent 类型。Runtime 为每个参与 Agent 建立 Run 专属 Session，并在 child terminal 后恢复准确的 caller Session。

## 1. 准备 Agent

```bash
scripts/rs agent create steward --client codex
scripts/rs agent create reviewer --client claude-code
scripts/rs agent create implementer --client kimi-code
```

Agent Run 不固定 Reviewer/Implementer 名单，也不限制某种 client 只能承担某种角色。Steward 或 workflow 可以顺序委派任意 active Local Agent；每轮最多一个 child，首版没有 fan-out/join。

## 2. 创建 Run 文件

内联 objective：

```json
{
  "schemaVersion": 1,
  "steward": "steward",
  "objective": "检查当前实现是否满足计划，并给出可验证结论。",
  "workspace": {
    "root": "/absolute/path/to/git-worktree",
    "access": "read"
  },
  "maxSteps": 12,
  "maxDepth": 4,
  "deadlineAt": "2030-07-26T18:00:00+08:00"
}
```

使用 `review@1`：

```json
{
  "schemaVersion": 1,
  "steward": "steward",
  "workflowRef": "review@1",
  "inputs": {
    "plan": "/absolute/path/to/plan.md",
    "acceptance": "验证实现、测试和边界"
  },
  "workspace": {
    "root": "/absolute/path/to/git-worktree",
    "access": "write"
  }
}
```

`objective` 与 `workflowRef` 必须二选一；`inputs` 只与 workflow 一起使用。`workspace` 可省略；提供时 root 必须是绝对、真实、Git-backed directory。Runtime 在 admission 固定 canonical root、`read | write` 与 Git revision，Agent output 不能扩大权限。相同 root 可以并发多个 read Run，但同时最多一个 non-terminal write Run。

## 3. 启动与推进

```bash
scripts/rs run start /absolute/path/to/run.json --request-id acceptance-1
scripts/rs start --no-open
```

`request-id` 是本地幂等键；相同键重复 start 返回原 Run。每个 turn 必须返回一个 `AgentTurnResult@1`：

- `complete`：以 `succeeded | failed | needs_human` 完成当前 step；
- `delegate`：指定一个 child Agent，并给出 bounded objective 或 workflow invocation。

Agent 不填写 callback target。Runtime 从 caller 的 Run Session 固定 callback binding；child provider retry 不 callback，child terminal 后只恢复一次 caller。A → B → C 会形成 durable async call stack，B 的完成先回 B 的 caller，再由 B 决定如何回 A。

## 4. 查询与取消

```bash
scripts/rs run list
scripts/rs run list --limit 20
scripts/rs run inspect <run-id>
scripts/rs run trace <run-id>
scripts/rs run cancel <run-id>
```

`inspect` 与 `trace` 返回同一 application detail：Run summary/projection、participants、Run Sessions、delegate/callback exchanges、directional counts、完整 Event trace，以及 external workspace 当前 revision。Runtime Console 显示最近一条 Agent Run，并可取消 `active | waiting` Run。

`cancel` 幂等地停止尚未开始的 work、retry、delegate、child 和 callback admission；不会强杀已经运行的 provider process。late result 只保留审计，不能恢复 cancelled Run。

Crash recovery 使用通用 Runtime 入口：

```bash
scripts/rs recover
scripts/rs start --no-open
```

Run continuation、child/callback admission 与 Result Execution completion在同一 SQLite transaction 中提交；duplicate result、ResultHandler retry 或 restart 不能建立第二个后继。

## 5. Legacy Review

schema v43 及更早的 terminal Review history 只保留在 `/console/reviews` 与 loopback read API 中。legacy `review`/`steward` CLI 和全部 mutation 已移除；新审查使用 `scripts/rs run start` + `review@1`。

## 当前限制

- 一轮只允许一个 child；没有 fan-out、join 或 Chat 自动升级为 Run。
- external workspace 是显式 Owner grant，不是 Chat sandbox；多个 workspace 或自动 worktree provisioning 尚未实现。
- workflow 是源码内 versioned resource，不是用户可安装的任意 Workflow DSL。
- Run 不自动 commit、push、创建 MR 或扩大 filesystem/network/process 权限。
