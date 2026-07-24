---
type: Runbook
title: Poll Subscription
description: 注册 Agent 编写的 TypeScript poll plugin，并在外部 shell command 完成后一次性续接固定 Session。
tags: [rollerskate, subscription, polling, plugin, continuation]
---

# Poll Subscription

[返回 Quickstart](./quickstart.md)

## 前置条件

- `scripts/rs start` 正在运行，调用方知道当前 provider session ID；Agent 是 Subscription 的准入主体，当前 Codex Desktop/CLI 会话是固定 callback target，不要求预先制造 Rollerskate `ses_`，也不要求 Room 或 Matrix。
- Plugin 与版本化 Subscription JSON 位于本机普通文件中。Plugin config 不保存 access token；command probe 复用显式 allowlist 的环境，HTTP probe只引用 allowlist 的环境变量名。
- `subscription add` 可在 Local Runtime loop 运行时执行；SQLite 负责并发与恢复，不需要重启 Runtime。

## Agent 工作流

目标 shell command 由调用方执行一次，并在结束时写入固定 workspace receipt。Subscription 只轮询这个 receipt；它不启动、重试或终止目标 command。Plugin 只实现两步：`plan` 返回一次只读 command probe；`evaluate` 把 receipt 解析为 JSON facts 和 `continue | success | failure`。Plugin 不写 timer、循环或 Session continuation。

仓库提供 [shell completion Plugin](../../examples/plugins/shell-command-completion.ts)、[receipt probe](../../examples/probes/read-command-receipt) 和 [command wrapper](../../examples/commands/run-with-receipt)。它们是 Agent 可改写的示例，不被 Rollerskate core import；Plugin config 和 callback prompt 直接写入下面的单份 Subscription JSON。

先在目标 workspace 执行一次命令；wrapper 会在 `.rollerskate-command-receipts/<command-id>.json` 以 atomic rename 写入 terminal receipt：

```bash
<repo>/examples/commands/run-with-receipt acceptance-1 sh -c 'sleep 10; exit 0'
```

创建 `subscription.json`，把 provider Session、Plugin config、prompt、schedule 和 execution policy 放进同一份版本化输入：

```json
{
  "schemaVersion": 1,
  "ownerAgentId": "prn_uuidv7",
  "plugin": {
    "path": "/absolute/repo/examples/plugins/shell-command-completion.ts",
    "id": "shell-command-completion",
    "config": {
      "commandId": "acceptance-1",
      "probeExecutable": "/absolute/repo/examples/probes/read-command-receipt",
      "cwd": "/absolute/workspace"
    }
  },
  "callback": {
    "providerSessionId": "019f925c-9759-78b1-816f-781f78062885",
    "prompt": "Report the command outcome."
  },
  "schedule": {
    "intervalMilliseconds": 1000,
    "maxWaitMilliseconds": 600000,
    "maxAttempts": 600
  },
  "executionPolicy": {
    "allowedHttpOrigins": [],
    "allowedExecutables": [
      "/absolute/repo/examples/probes/read-command-receipt"
    ],
    "allowedEnvironment": [],
    "timeoutMilliseconds": 1000,
    "maxOutputBytes": 4096
  }
}
```

然后注册：

```bash
scripts/rs subscription add /absolute/workspace/subscription.json
```

`ownerAgentId` 可从 `scripts/rs agent list` 读取。Runtime 先确认该 Agent 为 active，再按 Agent client、当前工作目录和 `callback.providerSessionId` 固定 callback snapshot。若该 provider Session 已登记为本地 `ses_`，它必须属于同一 Agent 与 workspace；未登记时允许注册，并在 terminal fire 的同一事务中 lazy materialize `ses_`。Codex Desktop 与 CLI 创建的会话都由同一个 Codex Agent 和 `codex exec resume` 续接。

注册命令返回后，调用 Agent 必须立即结束当前 turn。首次 probe 安排在创建时间加一个完整 `intervalMilliseconds` 之后，不会在注册瞬间执行；这是为了避免 terminal callback 与正在注册的 turn 并发续接同一 provider Session。当前版本以该调用协议保证 callback target idle，不支持向 active turn 并发 fire。

命令输出系统生成的 `sub_` UUIDv7；后续查询和控制使用该 ID。`executionPolicy` 是 probe 的能力边界：`read-command-receipt` 是 Subscription 唯一需要执行的 allowlist command，目标 shell command 不应加入 allowlist。Runtime 使用 absolute executable + args、`shell:false` 执行 probe。

## 检查与控制

```bash
scripts/rs subscription list
scripts/rs subscription inspect sub_uuidv7
scripts/rs subscription pause sub_uuidv7
scripts/rs subscription resume sub_uuidv7
scripts/rs subscription cancel sub_uuidv7
```

Local UI 同样读取 durable Subscription，并提供 pause、resume 和 cancel。`unknown` 表示 provider 可能已经执行但 receipt 未确认，Runtime 不会自动重放；当前版本只展示该状态，reconcile 仍需后续显式语义，不允许 UI 猜测成功。

## 验收

1. 注册后立即结束当前 Agent turn，在 CLI/UI 中确认 owner Agent、client、状态、attempt budget、deadline、provider Session 与 callback workspace 正确；注册后一个 interval 以内不应开始首次 probe。
2. 在一次或多次非 terminal probe 后重启 `scripts/rs start`，确认 attempt count 延续而不是归零。
3. shell command 结束并写入 terminal receipt 后，确认只生成一个 `subscription.fire`，terminal 事务创建或复用本地 `ses_`，原 provider Session 收到预定义 prompt，并产生 `agent.result` 与 ResultHandler Execution。
4. 重启 Runtime 或再次运行 cycle，确认目标 command 没有被重新执行，Agent invocation 与 fire Event 不增加第二次。
5. 在 Runtime、Event 与 Subscription 三页核对同一 durable facts；这一步是人工 release acceptance，自动测试和先前 dogfood 不能替代。
