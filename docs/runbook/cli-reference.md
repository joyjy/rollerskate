---
type: Runbook
title: Rollerskate CLI Command Reference
description: scripts/rs 当前 Local product 的公开命令与参数边界。
tags: [rollerskate, cli, local-runtime, subscription]
timestamp: 2026-07-24
---

# Rollerskate CLI Command Reference

本文是 `scripts/rs` 当前 Local product 的单一人类可读命令索引。`scripts/rs --help` 与 CLI 源码是公开接口的事实源；命令变化时必须在同一次修改中更新本文。

## 全局入口

```text
scripts/rs [--runtime <absolute-path>] [command]
scripts/rs --help
```

- 默认 Runtime home 是 `~/.rollerskate/`。
- `--runtime <absolute-path>` 必须放在 command 前，用于隔离整套 Runtime state；它不是 workspace 参数。
- 不带 command 会报错；使用 `scripts/rs --help` 查看命令。

## Local Runtime

```text
scripts/rs start [--no-open] [--ui-port <port>]
scripts/rs status
scripts/rs trace <event-id>
scripts/rs recover
scripts/rs pause
scripts/rs resume
```

- `start` 在前台运行 Local Runtime loop 与 Local UI，默认打开浏览器；使用 `Ctrl-C` 停止。
- `status` 查看 loop 状态。
- `trace` 输出一条 Event 从入库、执行、Agent 返回到可选投递的完整审计 JSON。
- `recover` 仅在 loop 已停止时，把异常退出后仍处于 `running` 的 Execution 和 `delivering` 的 Delivery 改为 `retry_wait`；它不修改 Event，也不立即重跑 Agent。
- `pause` 与 `resume` 控制 Runtime cycle，不删除 durable state。

全部 canonical Event 与 Runtime log event 见 [Event Reference](../architecture/event-reference.md)。

## Local Agent

```text
scripts/rs agent create <handle> --client codex
scripts/rs agent list
scripts/rs agent status <handle>
scripts/rs agent rename <handle> <new-handle>
scripts/rs agent suspend <handle>
scripts/rs agent resume <handle>
scripts/rs agent request <handle> [--session <ses_uuidv7>] <prompt...>
```

`handle` 是用户填写的短名称；Principal ID 由系统生成。创建时使用 `codex` adapter。`agent request` 直接向 Agent 发起一次请求，省略 `--session` 时由 Runtime 管理 Session。

## Poll Subscription

注册 Subscription：

```text
scripts/rs subscription add <json-file>
```

Subscription 文件使用版本化 JSON：

```json
{
  "schemaVersion": 1,
  "ownerAgentId": "prn_uuidv7",
  "plugin": {
    "path": "/absolute/path/to/plugin.ts",
    "id": "plugin-id",
    "config": {}
  },
  "callback": {
    "providerSessionId": "provider_session_id",
    "prompt": "Handle the terminal observation."
  },
  "schedule": {
    "intervalMilliseconds": 1000,
    "maxWaitMilliseconds": 60000,
    "maxAttempts": 60
  },
  "executionPolicy": {
    "allowedHttpOrigins": [],
    "allowedExecutables": [],
    "allowedEnvironment": [],
    "timeoutMilliseconds": 30000,
    "maxOutputBytes": 1048576
  }
}
```

`ownerAgentId` 来自 `agent list`，是 Subscription 的准入主体。`callback.providerSessionId` 是 Codex 的原生会话 ID，不是 Rollerskate `ses_`；它无需预注册，terminal 时 Runtime 才创建或复用内部 Session。callback workspace 取执行 `subscription add` 时的当前目录，因此应从原会话 workspace 运行该命令。Codex Desktop 与 CLI 会话共用同一个 Agent 与 resume driver。

注册成功后调用 Agent 必须结束当前 turn。首次 probe 在一个完整 polling interval 后才到期，避免 callback 与注册 turn 并发续接同一 provider Session。

`executionPolicy` 只限制每次 probe 可访问的 HTTP origin、可执行文件、环境变量、运行时长和输出大小，不授予目标 shell command 权限。该字段可省略；省略后使用空 allowlist、30 秒 timeout 与 1 MiB output limit。除可执行的 Plugin 文件外，注册所需声明全部位于这一份 JSON。创建成功后 Runtime 生成 `sub_` UUIDv7，外部不指定 Subscription ID。

查询和控制：

```text
scripts/rs subscription list
scripts/rs subscription inspect <id>
scripts/rs subscription pause <id>
scripts/rs subscription resume <id>
scripts/rs subscription cancel <id>
```

Subscription 命令输出 JSON。完整注册示例和生命周期说明见 [Poll Subscription runbook](./subscriptions.md)。
