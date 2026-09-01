---
type: Runbook
title: Offline Local Runtime Smoke
description: 不依赖 Matrix 验证 RunIntent、Steward Run、canonical Event 与 Console 审计。
tags: [rollerskate, local-runtime, event, smoke]
timestamp: 2026-07-23
---

# Offline Local Runtime Smoke

创建 Local Agent，然后启动唯一 Local Runtime loop：

```bash
scripts/rs agent create alice --client codex
scripts/rs start
```

另一个终端创建严格 `RunIntent@1`：

```json
{
  "schemaVersion": "RunIntent@1",
  "requestId": "offline-smoke-1",
  "objective": "检查当前 workspace 并简要回复。",
  "acceptance": ["返回 exact evidence"],
  "contextRefs": ["smoke:offline"],
  "workspaceRef": "project:self",
  "desiredEffect": "read",
  "requestedParticipantRefs": ["agent:alice"],
  "terminalEvidence": ["Run terminal receipt"]
}
```

```bash
scripts/rs run preflight /absolute/path/to/intent.json
scripts/rs run start /absolute/path/to/intent.json
```

命令返回 Run、root Event 与 `OrchestratorBinding@3` admission。使用以下任一方式审计：

```bash
scripts/rs run inspect <run-id>
scripts/rs run trace <run-id>
open http://localhost:4300/console/steward
```

预期 Run Workspace 可看到唯一 root Event、`agent` Handler、Execution、Result、Run-scoped Session 与 admission authority；离线路径没有 Destination 或 Delivery。CLI 不提供 direct Agent 或 generic Event write。
