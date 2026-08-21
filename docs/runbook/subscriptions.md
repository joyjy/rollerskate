---
type: Runbook
title: Subscription
description: 注册版本化 poll Plugin，在 terminal observation 后执行 ordered exact-grant callbacks。
tags: [rollerskate, subscription, polling, plugin, callback]
---

# Subscription

[返回 Quickstart](./quickstart.md)

## 前置条件

- `scripts/rs start` 正在运行。
- `ownerAgentId` 对应 active Local Agent。
- Plugin 与 Subscription JSON 位于本机普通文件中；Plugin config 不保存 token。
- probe 与 callback 使用绝对路径、canonical origin 和显式 authority。

目标 shell command 由调用方执行一次并写入 durable receipt。Subscription 只轮询 receipt，不启动、重试或终止目标 command。仓库提供 [shell completion Plugin](../../examples/plugins/shell-command-completion.ts)、[receipt probe](../../examples/probes/read-command-receipt) 和 [command wrapper](../../examples/commands/run-with-receipt)。

## 注册 one-shot Subscription

公开输入只接受 `SubscriptionDefinition@3`：

```json
{
  "schemaVersion": 3,
  "revision": "acceptance-v1",
  "title": "Acceptance command completed",
  "ownerAgentId": "prn_uuidv7",
  "probe": {
    "plugin": {
      "path": "/absolute/repo/examples/plugins/shell-command-completion.ts",
      "id": "shell-command-completion",
      "config": {
        "commandId": "acceptance-1",
        "probeExecutable": "/absolute/repo/examples/probes/read-command-receipt",
        "cwd": "/absolute/workspace"
      }
    },
    "artifactRevision": "git:commit-or-content-revision",
    "artifactDigest": "sha256:<64-lowercase-hex>",
    "policy": {
      "workspaceRoot": "/absolute/workspace",
      "allowedHttpOrigins": [],
      "allowedExecutables": [
        "/absolute/repo/examples/probes/read-command-receipt"
      ],
      "allowedEnvironment": [],
      "timeoutMilliseconds": 1000,
      "maxOutputBytes": 4096
    }
  },
  "callbacks": [],
  "schedule": {
    "intervalMilliseconds": 1000,
    "maxWaitMilliseconds": 600000,
    "maxAttempts": 600
  },
  "approvedGrantDigest": "T1PNoYwrqgwDVLtfmj7L5e0Sq02OEbqHPC8RFhICuUU"
}
```

上例没有 callback；terminal observation 自身就是最终产品状态。添加 callback 时，每项必须有系统格式的 `scb_` callback ID、kind、`ProactiveCallbackDefinition@1` definition 和 `ProactiveCallbackGrant@1` exact grant，随后重新计算 `approvedGrantDigest`。支持 `command.exec`、`agent.invoke` 和 `destination.deliver`，最多 16 项并按数组顺序执行。

`command.exec` 的 definition 与 grant 都必须使用 `runtime: "host"`，并精确匹配 executable、argv、cwd、environment、timeout 和 output bound；grant 还声明 filesystem roots、真实的 network authority 与空 secret references。该 executable 是可信 host code，可以调用 Python、GTD CLI 或其他子进程，RS 不沙箱其传递子进程。执行前可用 `scripts/rs subscription add --help` 读取这条 contract；历史 SQLite 中的 `runtime: "node"` 记录只读兼容，不能新增或执行。

`agent.invoke` grant 必须固定 owner Agent、workspace、`workspaceAccess` 与 `networkAccess`；one-shot Subscription adapter 会固定 terminal observation、workspace revision 与 `SubscriptionAgentResult@1` result contract。修改仓库或访问网络必须显式授权。Agent 对 readback 已证明未产生写入的确定性请求错误可以在 grant 内做有限纠正；缺少权限或凭据、target/revision 不明确、写入结果有歧义、需要扩 scope 或纠正已耗尽时，返回 durable `blocked` / `failed`。

Plugin artifact digest 必须匹配 admission 时读取到的文件内容。首次 probe 安排在创建时间加一个完整 interval 之后，不会在注册瞬间执行。

```bash
scripts/rs subscription add /absolute/workspace/subscription.json
```

## Continuous Subscription

长期观察使用 `schemaVersion: "ContinuousSubscriptionDefinition@1"`。它保留相同 probe 边界，schedule 只包含 `intervalMilliseconds`，callbacks 使用共享 proactive callback definition/grant。

Plugin 每次 observation 必须给出稳定 `occurrenceKey`。新 key materialize callback group；全部 callback terminal 后才 checkpoint。相同 key 不重复执行，crash-unknown occurrence 不自动 replay。

## 检查与控制

```bash
scripts/rs subscription list
scripts/rs subscription inspect sub_uuidv7
scripts/rs subscription pause sub_uuidv7
scripts/rs subscription resume sub_uuidv7
scripts/rs subscription cancel sub_uuidv7
```

这些命令同时适用于 one-shot 与 Continuous Subscription。Console 展示 terminal/checkpoint observation、callback definition、exact grant、receipt 与 error。不存在 v2 输入、legacy list item 或 parent `fireEventId`。

## 验收

1. 注册后确认 definition revision/digest、probe artifact、owner、attempt budget、deadline 与 callback grants 正确。
2. 一次或多次 non-terminal probe 后重启 Runtime，确认 attempt count 和 next poll 延续。
3. terminal receipt 出现后，确认 terminal observation 只写入一次，callbacks 按 ordinal 执行并留下 receipt。
4. 对 `agent.invoke`，确认 callback occurrence 引用唯一 `subscription.fire` Event，Event 使用 callback ID 幂等，并按 exact workspace/network grant 执行。
5. 模拟 callback 中断，确认 started 与剩余 pending callback 收敛为 `unknown` 且不自动重放。
