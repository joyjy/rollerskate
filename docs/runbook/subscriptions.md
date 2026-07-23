---
type: Runbook
title: Poll Subscription
description: 注册 Agent 编写的 TypeScript poll plugin，并在外部 shell command 完成后一次性续接固定 Session。
tags: [rollerskate, subscription, polling, plugin, continuation]
---

# Poll Subscription

[返回 Quickstart](./quickstart.md)

## 前置条件

- `scripts/rs start` 正在运行，并且目标 Agent 已成功产生一个 durable Session；该 Session 是固定 callback target，不要求 Room 或 Matrix。
- Plugin、config 和 prompt 位于本机普通文件中。Plugin config 不保存 access token；command probe 复用显式 allowlist 的环境，HTTP probe只引用 allowlist 的环境变量名。
- `subscription add` 可在 Local Runtime loop 运行时执行；SQLite 负责并发与恢复，不需要重启 Runtime。

## Agent 工作流

目标 shell command 由调用方执行一次，并在结束时写入固定 workspace receipt。Subscription 只轮询这个 receipt；它不启动、重试或终止目标 command。Plugin 只实现两步：`plan` 返回一次只读 command probe；`evaluate` 把 receipt 解析为 JSON facts 和 `continue | success | failure`。Plugin 不写 timer、循环或 Session continuation。

仓库提供 [shell completion Plugin](../../examples/plugins/shell-command-completion.ts)、[config 示例](../../examples/plugins/shell-command-completion.config.example.json)、[prompt 示例](../../examples/plugins/shell-command-completion.prompt.md)、[receipt probe](../../examples/probes/read-command-receipt) 和 [command wrapper](../../examples/commands/run-with-receipt)。它们是 Agent 可改写的示例，不被 Rollerskate core import。

先在目标 workspace 执行一次命令；wrapper 会在 `.rollerskate-command-receipts/<command-id>.json` 以 atomic rename 写入 terminal receipt：

```bash
<repo>/examples/commands/run-with-receipt acceptance-1 sh -c 'sleep 10; exit 0'
```

将 config 的 `commandId`、`probeExecutable` 和 `cwd` 改成实际绝对路径，然后注册 Subscription：

```bash
scripts/rs subscription add acceptance-1 \
  --plugin "$PWD/examples/plugins/shell-command-completion.ts" \
  --plugin-id shell-command-completion \
  --config "$PWD/examples/plugins/shell-command-completion.config.json" \
  --session ses_example \
  --prompt-file "$PWD/examples/plugins/shell-command-completion.prompt.md" \
  --interval-ms 1000 \
  --max-wait-ms 600000 \
  --max-attempts 600 \
  --probe-timeout-ms 1000 \
  --max-output-bytes 4096 \
  --allow-executable "$PWD/examples/probes/read-command-receipt"
```

`read-command-receipt` 是 Subscription 唯一需要执行的 allowlist command；目标 shell command 不应加入 Subscription allowlist。Runtime 使用 absolute executable + args、`shell:false` 执行 probe。

## 检查与控制

```bash
scripts/rs subscription list
scripts/rs subscription inspect pipeline-123456
scripts/rs subscription pause pipeline-123456
scripts/rs subscription resume pipeline-123456
scripts/rs subscription cancel pipeline-123456
scripts/rs subscription revoke pipeline-123456
```

Local UI 同样读取 durable Subscription，并提供 pause、resume、cancel 和 revoke。`unknown` 表示 provider 可能已经执行但 receipt 未确认，Runtime 不会自动重放；当前版本只展示该状态，reconcile 仍需后续显式语义，不允许 UI 猜测成功。

## 验收

1. 注册后结束当前 Agent turn，在 CLI/UI 中确认状态为 `active` 且 attempt budget、deadline、Session 和 destination 正确。
2. 在一次或多次非 terminal probe 后重启 `scripts/rs start`，确认 attempt count 延续而不是归零。
3. shell command 结束并写入 terminal receipt 后，确认只生成一个 `subscription.fire`，原 Session 收到预定义 prompt，并产生 `agent.result` 与 ResultHandler Execution。
4. 重启 Runtime 或再次运行 cycle，确认目标 command 没有被重新执行，Agent invocation 与 fire Event 不增加第二次。
5. 在 Runtime、Event 与 Subscription 三页核对同一 durable facts；这一步是人工 release acceptance，自动测试和先前 dogfood 不能替代。
