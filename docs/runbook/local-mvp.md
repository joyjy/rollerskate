---
type: Runbook
title: Offline Local Runtime Smoke
description: 不依赖 Matrix 验证 canonical Event、AgentHandler 与 Console 审计。
tags: [rollerskate, local-runtime, event, smoke]
timestamp: 2026-07-23
---

# Offline Local Runtime Smoke

先完成本地 Agent 注册与 workspace 配置，然后启动唯一 Local Runtime loop：

```bash
scripts/rs workspace set "$PWD/.rollerskate/agents"
scripts/rs agent create alice --client codex
scripts/rs start
```

另一个终端发送固定 schema request：

```bash
scripts/rs agent request alice "检查当前 workspace 并简要回复"
```

命令返回 Event ID 与 Execution ID。使用以下任一方式审计：

```bash
scripts/rs trace <event-id>
open http://localhost:4300/console/
```

预期同一个 canonical Event 可看到唯一 `agent` Handler、Execution、Result 与 Session；离线路径没有 Destination 或 Delivery。CLI 不提供 generic Event write。
