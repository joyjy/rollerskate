---
type: Runbook
title: Local Review Runbook
description: 使用 CLI 或 Console 检查、追踪和恢复双 Agent acceptance Review。
tags: [rollerskate, local, review, cli, console, recovery]
timestamp: 2026-07-24
---

# Local Review Runbook

Local Review 不依赖 Server 或 Matrix。开始前保持前台 Runtime 可运行，并在同一个 Local workspace 中准备 Git repo、acceptance subject、Reviewer 与 Implementer；Console 是同一 application query/control 的视觉入口，不拥有第二套状态机。

## 1. 准备 Agent

```bash
scripts/rs agent create reviewer --client codex
scripts/rs agent create implementer --client claude-code
```

两个 role 必须是不同 Local Agent；client 可以相同。Reviewer 只获得 read profile，Implementer 只获得 Local workspace 的 write profile。Codex 与 Claude Code 可以承担这两个 role；受信任本机上的 Kimi Code 只可承担 Implementer，不能承担 Reviewer。Kimi prompt mode 使用自身 auto permission，当前支持边界是功能可用，不代表与 Codex `workspace-write` 等价的进程级 sandbox。

## 2. 创建 request 文件

```json
{
  "schemaVersion": 1,
  "subject": "/absolute/runtime/workspace/plan.md",
  "reviewer": "reviewer",
  "implementer": "implementer",
  "reworkLimit": 2
}
```

- `subject` 必须是 Local workspace 内的真实文件；首版固定为 acceptance subject。
- workspace 必须是 Git repo。Runtime 自动计算 subject、workspace 和 implementation revision，用户不手填 hash。
- `reworkLimit` 是 0–20 的语义返修上限，与单次 provider retry 无关。

## 3. 创建并运行

```bash
scripts/rs review create /absolute/path/to/review.json --request-id release-acceptance-1
scripts/rs start --no-open
```

`request-id` 是本地幂等键；相同键重复 create 返回原 root Event，不建立第二条链。Runtime 首次处理 request 时创建 `<subject>.review.yaml`，之后由 Capability 原子维护。

Implementer 可以修改 workspace，但不能编辑 sidecar。Reviewer 复核通过、明确 blocked 或达到 rework limit 后，chain 进入 terminal。

同一 workspace 首版一次只允许一条 active Review；terminal 后才能创建下一条，避免两条链互相改变 implementation revision。

## 4. 查看与追踪

```bash
scripts/rs review list
scripts/rs review list --limit 20
scripts/rs review inspect <root-event-id>
scripts/rs review trace <root-event-id>
```

`inspect` 与 `trace` 当前返回同一完整 JSON：`summary`、当前 workspace revision、MRSF artifact 和按 causality 排序的规范化 Event/Execution/Session audit。常用终态字段是 `summary.terminalDecision` 与 `summary.terminalReason`；可执行恢复以 `summary.availableActions.recover` 为准。

打开 `http://localhost:4300/console/reviews` 可以查看同一 list/detail。blocked Review 会显示稳定 `failure:review:<root-event-id>`，可下钻 Runtime Failure；Runtime Failure 的 Inspect trace 会返回同一个 Review。

## 5. 恢复

先停止前台 loop，再恢复 interrupted Runtime work：

```bash
scripts/rs recover
scripts/rs review recover <root-event-id>
scripts/rs start --no-open
```

`review recover` 不 replay 或跳过 decision。expected Execution 仍 queued/retry-wait 时保持原链；failed 或与 projection 不一致时终止为 blocked，等待人处理 subject/workspace 后新建 Review。

## 限制

- 当前没有 cancel、force-pass、换 Agent、提高既有 rework limit、自动 commit/push/MR 或 Server trigger。
- sidecar 是 JSON-compatible YAML；只能通过 Capability 更新。
- Review 只授权 Local workspace；repo 外文件、ignored secrets 和 symlink-untracked 内容不能作为自动 acceptance evidence。
