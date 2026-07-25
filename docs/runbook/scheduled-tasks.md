---
type: Runbook
title: Rollerskate Scheduled Task
description: 通过 CLI 或 Console 创建、查看、控制和追踪 Local one-shot/cron Scheduled Task。
tags: [rollerskate, cli, console, local, scheduled-task, cron]
timestamp: 2026-07-24
---

# Scheduled Task

Scheduled Task 需要前台 Local Runtime loop 运行。它完全使用本机 SQLite 与 Agent adapter，不依赖 Server；CLI 与 Console 复用同一 application query/control。完整参数索引见 [CLI Command Reference](./cli-reference.md)，时间与恢复语义见 [Local Scheduled Task architecture](../architecture/scheduled-task.md)。

## 创建

先确认目标 Agent 已存在：

```bash
scripts/rs agent list
```

one-shot 文件：

```json
{
  "schemaVersion": 1,
  "agent": "alice",
  "kind": "once",
  "expression": "2026-07-25T09:00:00+08:00",
  "misfirePolicy": "run_once",
  "overlapPolicy": "queue",
  "misfireGraceMilliseconds": 60000,
  "session": { "policy": "new_each_run" },
  "prompt": "生成今天的工作摘要。"
}
```

cron 文件：

```json
{
  "schemaVersion": 1,
  "agent": "alice",
  "kind": "cron",
  "expression": "0 9 * * 1-5",
  "timezone": "Asia/Shanghai",
  "misfirePolicy": "skip",
  "overlapPolicy": "queue",
  "misfireGraceMilliseconds": 300000,
  "session": { "policy": "new_each_run" },
  "prompt": "检查 workspace 并生成工作日上午报告。"
}
```

创建并保存返回的 `sch_` ID：

```bash
scripts/rs schedule create /absolute/path/to/schedule.json
```

`once` 必须带 `Z` 或明确 offset；`cron` 必须带 IANA timezone。CLI 自动使用 Runtime 的 canonical Local workspace，不接受 JSON 自定义 workspace。

需要续接既有 Rollerskate Session 时，把 `session` 改为：

```json
{
  "policy": "fixed",
  "fixedSessionId": "ses_uuidv7"
}
```

该 Session 必须属于同一 Agent 和 Local workspace。普通 Desktop/CLI provider session ID 不能直接填在这里；先通过已有 Agent execution 形成 Rollerskate `ses_`。

## 查询与控制

```bash
scripts/rs schedule list
scripts/rs schedule inspect <schedule-id>
scripts/rs schedule runs <schedule-id>
scripts/rs schedule runs <schedule-id> --limit 20
scripts/rs schedule trace <run-id>
scripts/rs schedule pause <schedule-id>
scripts/rs schedule resume <schedule-id>
scripts/rs schedule cancel <schedule-id>
```

pause、resume 与 cancel 是幂等控制。pause 期间不会积累 backfill；resume 从恢复时间计算下一 cron occurrence。cancel 保留 revision 与 run history。

打开 `http://localhost:4300/console/schedules` 可以查看同一 list/detail，并执行 application guard 当前允许的 pause/resume/cancel/run-now。unknown run 会显示 Resolve succeeded/failed 和稳定 `failure:schedule:<run-id>`；先依据 provider evidence 判断，再从 Console 或 CLI resolve。

## 更新

update 文件与 create 相同，额外带当前 revision：

```json
{
  "schemaVersion": 1,
  "expectedRevision": 1,
  "agent": "alice",
  "kind": "cron",
  "expression": "30 9 * * 1-5",
  "timezone": "Asia/Shanghai",
  "misfirePolicy": "skip",
  "overlapPolicy": "queue",
  "misfireGraceMilliseconds": 300000,
  "session": { "policy": "new_each_run" },
  "prompt": "生成更新后的工作日上午报告。"
}
```

```bash
scripts/rs schedule update <schedule-id> /absolute/path/to/update.json
```

`expectedRevision` 不匹配时拒绝更新。已 admission 的 run 继续使用旧 revision；有未终结 run 时不能替换 Agent、workspace 或 fixed Session。

## 立即运行

```bash
scripts/rs schedule run-now <schedule-id> --request-id <stable-key>
```

`request-id` 是调用方选择的幂等键；重试相同命令返回同一个 run。manual run 不移动正常 schedule。若已有 active run，`overlapPolicy=skip` 形成 skipped run，`queue` 进入同一个单槽 pending 规则。

## 恢复 unknown

如果 Runtime 在 provider invocation 中异常退出，该 run 会保持 `unknown`，防止可能已有 side effect 的请求被盲目重放。先用 provider history、workspace 或其他 receipt 核对真实结果：

```bash
scripts/rs schedule trace <run-id>
scripts/rs schedule resolve <run-id> succeeded
# 或
scripts/rs schedule resolve <run-id> failed
```

只有 `unknown` run 可以 resolve。resolve 是人工 reconciliation，不重新调用 Agent。
