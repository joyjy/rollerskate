---
type: Runbook
title: Rollerskate Scheduled Task
description: 通过 Steward Run 或 Owner-registered external workflow 建立、观察和控制 Local one-shot/cron source。
tags: [rollerskate, local, scheduled-task, cron, steward-run, external-workflow]
timestamp: 2026-08-26
---

# Scheduled Task

Scheduled Task 只拥有时间、misfire、overlap 和 occurrence recovery。Agent 工作由 Steward Run 承担；同库确定性 mutation 由 Owner application action 承担；受控 Git/网络/进程工作由 Owner-registered external workflow 承担。三者都编译为 `ScheduleRevision@3` 的 `ProactiveTarget@1`，公共 Schedule 不接受 raw Agent、prompt、command、argv 或 grant。

旧 `ScheduleRevision@1` 仍可读取、暂停和取消；`schedule create/update` 已关闭 legacy callback admission，未迁移的 V1 不能 resume/run-now。Owner 可把 paused V1 显式迁移为 registered external workflow，保留同一个 Schedule ID 和旧 occurrence history。完整参数索引见 [CLI Command Reference](./cli-reference.md)，时间与恢复语义见 [Local Scheduled Task architecture](../architecture/scheduled-task.md)。

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

Steward 只能选择 admitted kind 和 participant，并以 `schedule.once@1` 或 `schedule.cron@1` 建立 source。Schedule owner 校验 expression、timezone、interval ceiling、deadline、misfire 和 overlap policy，最终写 current `ScheduleRevision@3`。

## 迁移 legacy Schedule 到 external workflow

先由 Owner 在默认 runtime root 的 `~/.rollerskate/external-workflows.json` 写入 mode-0600 registry。registration 固定 versioned ref/input schema/input、file URL executable/cwd、原始 argv 数组、exact environment、filesystem roots、network declaration、timeout/output bound 与 retry；加载时把 executable content digest 纳入 registration digest。host child 不经过 shell，也不获得 Runtime ambient environment。该声明不是 OS sandbox，workflow 本身仍必须只在固定参数和 roots 内操作。

```json
{
  "schemaVersion": "OwnerExternalWorkflowRegistry@1",
  "workflows": [{
    "schemaVersion": "OwnerExternalWorkflowRegistration@1",
    "ref": "workflow:maintenance/example@1",
    "inputSchema": "MaintenanceInput@1",
    "fixedInput": { "mode": "dry-run" },
    "command": {
      "executable": "file:///absolute/project/scripts/maintenance",
      "arguments": ["--dry-run"],
      "cwd": "file:///absolute/project",
      "environment": { "PATH": "/usr/bin:/bin" },
      "timeoutMilliseconds": 1800000,
      "maxOutputBytes": 131072
    },
    "authority": {
      "filesystemRoots": ["file:///absolute/project"],
      "networkAccess": true
    },
    "retry": { "maxAttempts": 2, "backoffMilliseconds": 30000 }
  }]
}
```

先 pause legacy source，记录 `schedule inspect` 返回的 current revision，再执行幂等迁移：

```bash
chmod 600 ~/.rollerskate/external-workflows.json
scripts/rs schedule migrate-workflow <schedule-id> \
  --workflow-ref workflow:maintenance/example@1 \
  --expected-revision <legacy-revision> \
  --request-id <stable-migration-id>
scripts/rs schedule resume <schedule-id>
scripts/rs schedule run-now <schedule-id> --request-id <stable-occurrence-id>
```

首次运行应使用 registry 固定的 dry-run 参数。`schedule occurrences`/`trace` 会显示 external execution ID、attempt、lease/effect boundary 与 terminal receipt。nonzero exit 是 failed；timeout、abort 或 effect boundary 后 crash 是 unknown，Runtime 不重放。Owner 先检查 workflow 自己的 LWW/remote receipt，再用 `schedule resolve <run-id> succeeded|failed` 追加 manual resolution；原 unknown receipt不会被覆盖。

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
2. source 创建或迁移后是 `ScheduleRevision@3`，且 definition 不含 raw Agent、prompt、workspace、callback、executable、argv 或 grant。
3. duplicate tick、misfire 与 overlap 都由 Schedule owner形成唯一 occurrence；每个 accepted occurrence 最多激活一个 Run cycle、action receipt 或 external execution。
4. Runtime 重启后从同一 occurrence 和 owning durable receipt 恢复；external workflow 只在 pre-effect boundary 内按 budget retry，unknown 不盲目重放。
5. Run target 从 Run Workspace 判断结果；external target 从 Schedule occurrence、external receipt 与业务 LWW 联合判断。
