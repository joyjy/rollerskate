---
type: Runbook
title: Rollerskate Scheduled Task
description: 通过 Steward Run 建立、观察和控制 Local one-shot/cron source。
tags: [rollerskate, local, scheduled-task, cron, steward-run]
timestamp: 2026-08-26
---

# Scheduled Task

v0.5.5 起，Scheduled Task 只拥有时间、misfire、overlap 和 occurrence recovery；所有工作执行都属于 Steward Run。Owner 以 `RunIntent@1` 创建 Run，Steward 的 `await_source` 决策原子建立 `ScheduleRevision@2` 与 Run binding。due occurrence 只激活绑定 Run 的一个 cycle，不直接调用 Agent。

旧 `ScheduleRevision@1` 仍可读取、暂停和取消；`schedule create/update/resume/run-now` 已关闭 legacy callback admission。完整参数索引见 [CLI Command Reference](./cli-reference.md)，时间与恢复语义见 [Local Scheduled Task architecture](../architecture/scheduled-task.md)。

## 创建 one-shot Run

先确认目标 Agent 已 active，然后准备只表达意图的 JSON：

```bash
scripts/rs agent list
```

```json
{
  "schemaVersion": "RunIntent@1",
  "requestId": "daily-summary-2026-08-26",
  "objective": "在 2026-08-27T09:00:00+08:00 触发一次，由 alice 生成工作摘要；misfire 使用 run_once、overlap 使用 queue。",
  "acceptance": ["只生成一次摘要", "结果附带 workspace revision 和验收证据"],
  "contextRefs": ["report:daily-summary"],
  "workspaceRef": "local:workspace",
  "desiredEffect": "read",
  "triggerIntent": "once",
  "requestedParticipantRefs": ["agent:alice"],
  "terminalEvidence": ["Run cycle succeeded", "摘要可从 Run Workspace 读取"]
}
```

```bash
scripts/rs run preflight /absolute/path/to/run-intent.json
scripts/rs run start /absolute/path/to/run-intent.json
```

`preflight` 只返回 compiled request、canonical workspace revision、participant roster、trigger ceiling 与 admission digest；不创建 Event、Execution 或 Run。`start` 用同一 `requestId` 幂等创建或恢复 `OrchestratorBinding@3` Run。

## 创建 cron Run

cron 使用 `triggerIntent: "cron"`，并在 objective 中明确 cron expression、IANA timezone、misfire/overlap policy 与 cycle acceptance，例如：

```json
{
  "schemaVersion": "RunIntent@1",
  "requestId": "weekday-work-report-v1",
  "objective": "按 Asia/Shanghai 的 0 9 * * 1-5 触发；misfire skip、overlap queue。每个 cycle 由 alice 检查 workspace 并生成工作日上午报告。",
  "acceptance": ["每个 due occurrence 至多激活一个 cycle", "报告标明 observed revision"],
  "contextRefs": ["report:weekday"],
  "workspaceRef": "file:///absolute/workspace",
  "desiredEffect": "read",
  "triggerIntent": "cron",
  "requestedParticipantRefs": ["agent:alice"],
  "terminalEvidence": ["cycle receipt", "report artifact"]
}
```

Steward 只能选择 admitted kind 和 participant，并以 `schedule.once@1` 或 `schedule.cron@1` 建立 source。Schedule owner 校验 expression、timezone、interval ceiling、deadline、misfire 和 overlap policy。

## 查询与控制

```bash
scripts/rs run list
scripts/rs run inspect <run-id>
scripts/rs schedule list
scripts/rs schedule inspect <schedule-id>
scripts/rs schedule occurrences <schedule-id> --limit 20
scripts/rs schedule trace <run-id>
scripts/rs schedule pause <schedule-id>
scripts/rs schedule resume <schedule-id>
scripts/rs schedule cancel <schedule-id>
```

Run Workspace 是唯一一级执行页面，展示 source ID/revision、next occurrence、pending occurrence、active cycle、reconcile 状态与 Schedule diagnostics deep link。Schedule 页面解释计时和 source-owned state；`schedule runs` 只是 `occurrences` 的兼容 alias。

pause 期间不积累 backfill；cancel 保留 definition、occurrence 和 Run history。Run-bound occurrence 的 authority 在 Steward Run/cycle，不能通过 legacy `resolve` 改写；只有历史 legacy unknown occurrence 仍允许人工 reconcile。

## 验收

1. `run preflight` 在 Event 前拒绝错误 workspace、inactive Agent、effect 冲突或超出 deadline/trigger authority 的请求。
2. source 创建后是 `ScheduleRevision@2`，且 definition 不含 Agent prompt、workspace 或 callback。
3. duplicate tick、misfire 与 overlap 都由 Schedule owner形成唯一 occurrence/receipt；每个 accepted occurrence 最多激活一个 Run cycle。
4. Runtime 重启后从同一 occurrence/Run binding receipt 恢复，不重复执行 worker side effect。
5. 用户只需 Run Workspace 即可判断 cycle 结果；时间诊断再沿 deep link 查看 Schedule。
