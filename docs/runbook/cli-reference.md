---
type: Runbook
title: Rollerskate CLI Command Reference
description: scripts/rs 当前 Local product 的公开命令与参数边界。
tags: [rollerskate, cli, local-runtime, chat, subscription, scheduled-task, review]
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
scripts/rs doctor --local
scripts/rs status
scripts/rs trace <event-id>
scripts/rs event list
scripts/rs event trace <event-id>
scripts/rs workload status
scripts/rs failure list
scripts/rs failure inspect <failure-ref>
scripts/rs recover
scripts/rs pause
scripts/rs resume
```

- `start` 在前台运行 Local Runtime loop、loopback API 与内置 Vite Console，默认打开浏览器；`local/ui/src/` 修改通过 HMR 进入已打开页面，非 UI 源码不会热替换；使用 `Ctrl-C` 一并停止。
- `doctor --local` 只读验证当前 Local-first database、schema、Foundation 与固定 workspace，不读取兼容旧 Server/Matrix 路径的 `config.json`、`secrets.json` 或 Matrix token。
- `status` 输出结构化 Runtime process 状态、唯一 Core Loop phase、Workload 摘要、Failure 数量与解释；不再用 Event、Session 或历史 Result 的累计量冒充 active workload。
- `event list/trace` 是 Events application query 的正式 CLI；顶层 `trace` 是同一 `event trace` query 的兼容 shortcut。
- `workload status` 输出 Core Loop 当前负责推进的 ready、running、retrying 与 total canonical work unit；已经关联 Execution 的 ScheduledRun 不重复计数。
- `failure list/inspect` 输出影响 Runtime readiness、workload 或需要 Owner 介入的 bounded projection，并给出稳定 object/Event reference 与下钻提示。
- `recover` 仅在 Runtime 已停止且确实存在 interrupted durable work 时可用。普通 `running` Execution 和 retryable Delivery 回到有限重试；已经进入 provider invocation 的 ScheduledRun 改为 `unknown` 并停止对应 Execution，避免盲目重放可能已有 side effect 的请求。Agent Run 复用 Execution recovery 与 generic ResultHandler continuation，没有专用 `steward recover`。
- `pause` 与 `resume` 使用与 Console 相同的 structured availability guard，控制后续 Runtime cycle claim，不删除 durable state，也不取消已开始的 provider invocation。

全部 canonical Event 与 Runtime log event 见 [Event Reference](../architecture/event-reference.md)。

## Local Agent

```text
scripts/rs agent create <handle> --client <codex|claude-code|kimi-code> [--launch-arg <arg>]...
scripts/rs agent configure <handle> [--launch-arg <arg>]...
scripts/rs agent list
scripts/rs agent status <handle>
scripts/rs agent rename <handle> <new-handle>
scripts/rs agent suspend <handle>
scripts/rs agent resume <handle>
scripts/rs agent request <handle> [--session <ses_uuidv7>] <prompt...>
```

`handle` 是用户填写的短名称；Principal ID 由系统生成。创建时必须选择 `codex`、`claude-code` 或 `kimi-code` adapter。`--launch-arg` 可重复，每次保存一个原始 argv 元素，不经过 shell 解析；例如 `--launch-arg --model --launch-arg claude-sonnet-4-6`。`agent configure` 原子替换该 Agent 的整组启动参数，不带 `--launch-arg` 时清空；下一次调用自动使用新 adapter 配置。

Session、structured output、workspace 与 permission/sandbox 参数由 adapter 控制，不能通过启动参数覆盖。Agent Run 的 external workspace grant 对所有 client 使用同一 `read | write` contract：Codex 与 Claude Code adapter 会把它转换为进程权限参数；受信任本机上的 Kimi Code 目前只在 prompt 中接收 grant，仍使用自身 auto permission，并不提供与 Codex `read-only` / `workspace-write` 等价的进程级 sandbox。`agent request` 直接向 Agent 发起一次请求，省略 `--session` 时由 Runtime 管理 Session。

`scripts/rs start` 默认在 `PATH` 中发现 `codex`、`claude` 与 `kimi`。需要固定 executable 时分别设置 `ROLLERSKATE_CODEX_EXECUTABLE`、`ROLLERSKATE_CLAUDE_CODE_EXECUTABLE` 或 `ROLLERSKATE_KIMI_CODE_EXECUTABLE`。

## Local Chat

```text
scripts/rs chat post <message...>
scripts/rs chat history
scripts/rs chat status
scripts/rs chat presence set <handle> --scope <topic|global> --mode <available|snoozed> [--until <iso>] [--wake-keyword <literal>]...
scripts/rs chat session new <handle>
```

- `post` 追加 immutable Owner `chat.message` 并返回 queued Event ID；Runtime loop 在线时，ChatHandler 会对每个 Local Agent 应用 target 与 presence 状态机。写 `@handle` 只唤起该 Agent；不写 target 时所有 available Agent 都能自主 reply 或 silent。
- `history` 输出 Local Topic 的稳定 message timeline cursor page；内部 `chat.dispatch` 只在 Event trace 中查看。
- `status` 输出每个 Agent 的 lifecycle status 以及已有的 Global/Topic presence。未出现 presence 表示尚未做过显式 decision，运行时按 available 处理。
- `presence set` 由 Owner 覆盖一个 Agent 的当前 scoped presence。`available` 不接受 `--until` 或 wake keyword；`snoozed` 必须提供未来的 `--until`，`--wake-keyword` 可重复。它修改的是 `Agent × (Global | 当前 Topic)` 状态，不是 Topic 配置，也不改变 Agent lifecycle。
- `session new` 清空该 Agent 的 current Session pointer并增加 generation，不删除历史。

Agent 每轮返回 `ChatDecision@1`，同时决定 speech 与下一步 presence；Owner 的 CLI 设置与 Agent decision 更新同一条 scoped state，后写入者生效。`snoozed` 可作用于 Topic 或 Global；active Global snooze 优先。直接 mention、对应 scope 的 literal wake keyword 或到期会让 Agent获得一次新决策机会，但不会替 Agent自动回复。当前 Chat 行为 prompt 是随 build 发布的 `prompt.chat.free-turn` 资源，没有独立 revision/editor。

## Notice

```text
scripts/rs notice list [--limit <1-1000>]
scripts/rs notice inspect <notice-id>
scripts/rs notice mark-read <notice-id>
scripts/rs notice ack <notice-id>
scripts/rs notice rebuild
```

Notice Center 从 SQLite `notices` 读取由 `macos-notification` Delivery snapshot 和对应 `agent.result` 形成的 bounded projection，不依赖 macOS 通知中心是否仍保留横幅。`list` 默认按发生时间倒序返回 100 条；`inspect` 使用列表中的 `ntc1_...` Notice ID。`mark-read` 记录首次 read time；`ack` 同时保证 read 并记录首次 acknowledge time，重复执行不改写首次时间。`rebuild` 从 canonical facts 重投 derived columns，但保留同表 authoritative columns 中的 read/ack。

## Poll Subscription

注册 Subscription：

```text
scripts/rs subscription add <json-file>
```

Subscription 文件使用版本化 JSON：

```json
{
  "schemaVersion": 2,
  "title": "Build completed",
  "ownerAgentId": "prn_uuidv7",
  "probe": {
    "plugin": {
      "path": "/absolute/path/to/plugin.ts",
      "id": "plugin-id",
      "config": {}
    },
    "policy": {
      "allowedHttpOrigins": [],
      "allowedExecutables": [],
      "allowedEnvironment": [],
      "timeoutMilliseconds": 30000,
      "maxOutputBytes": 1048576
    }
  },
  "callback": {
    "providerSessionId": "provider_session_id",
    "prompt": "Handle the terminal observation."
  },
  "schedule": {
    "intervalMilliseconds": 1000,
    "maxWaitMilliseconds": 60000,
    "maxAttempts": 60
  }
}
```

`title` 是 required 的 1–120 字符用户名称，并作为 terminal callback 的 macOS native notification 标题。`ownerAgentId` 来自 `agent list`，是 Subscription 的准入主体。`callback.providerSessionId` 是公开 client 的原生会话 ID，不是 Rollerskate `ses_`；它无需预注册，terminal 时 Runtime 才创建或复用内部 Session。callback workspace 取执行 `subscription add` 时的当前目录，因此应从原会话 workspace 运行该命令。Agent 创建时绑定的 client 决定 callback adapter；Codex Desktop 与 CLI 会话共用同一个 Agent 与 resume driver。

注册成功后调用 Agent 必须结束当前 turn。首次 probe 在一个完整 polling interval 后才到期，避免 callback 与注册 turn 并发续接同一 provider Session。

callback 完成表示结果已写入 provider history，不保证已打开的 Desktop/CLI 即时刷新。Runtime 会额外尝试一次 macOS native notification；该 Delivery 的失败不会改变 callback outcome。

`probe.policy` 只限制每次 probe 可访问的 HTTP origin、可执行文件、环境变量、运行时长和输出大小，不授予目标 shell command 权限。该字段可省略；省略后使用空 allowlist、30 秒 timeout 与 1 MiB output limit。除可执行的 Plugin 文件外，注册所需声明全部位于这一份 JSON。创建成功后 Runtime 生成 `sub_` UUIDv7，外部不指定 Subscription ID。

查询和控制：

```text
scripts/rs subscription list
scripts/rs subscription inspect <id>
scripts/rs subscription pause <id>
scripts/rs subscription resume <id>
scripts/rs subscription cancel <id>
```

Subscription 命令输出 JSON。完整注册示例和生命周期说明见 [Poll Subscription runbook](./subscriptions.md)。

## Local Scheduled Task

创建文件使用 `schemaVersion: 1`。one-shot 示例：

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

cron 把 `kind` 改为 `cron`，expression 使用五字段 numeric cron，并必须增加 `"timezone": "Asia/Shanghai"`。Session 需要固定续接时使用 `{ "policy": "fixed", "fixedSessionId": "ses_uuidv7" }`；Session 必须属于同一 Agent 与 Local workspace。

```text
scripts/rs schedule create <json-file>
scripts/rs schedule update <schedule-id> <json-file>
scripts/rs schedule list
scripts/rs schedule inspect <schedule-id>
scripts/rs schedule pause <schedule-id>
scripts/rs schedule resume <schedule-id>
scripts/rs schedule cancel <schedule-id>
scripts/rs schedule run-now <schedule-id> --request-id <idempotency-key>
scripts/rs schedule runs <schedule-id> [--limit <count>]
scripts/rs schedule trace <run-id>
scripts/rs schedule resolve <run-id> <succeeded|failed>
```

update 文件比 create 多一个 `expectedRevision`，其余字段是完整的新 revision。pause/resume/cancel 与相同 request ID 的 run-now 都是幂等操作。`run-now` 不移动正常 occurrence。`trace` 返回 run 以及可用的 Event/Execution/Session/result audit；`resolve` 只处理 provider outcome 无法确认的 `unknown` run，不重新执行 Agent。

完整示例、cron/DST、misfire、overlap 与恢复说明见 [Scheduled Task runbook](./scheduled-tasks.md)。

Console 的 `/console/schedules` 使用与以上 query/control 相同的 application view。页面只显示当前状态允许的 pause/resume/cancel/run-now/resolve，并要求 loopback Console request marker；不是绕过 CLI policy 的独立控制面。

## Agent Run 与 `review@1`

创建文件使用 `schemaVersion: 1`：

```json
{
  "schemaVersion": 1,
  "steward": "steward",
  "workflowRef": "review@1",
  "inputs": {
    "plan": "/absolute/workspace/plan.md",
    "acceptance": "/absolute/workspace/acceptance.md"
  },
  "workspace": {
    "root": "/absolute/workspace",
    "access": "write"
  },
  "maxSteps": 12,
  "maxDepth": 4
}
```

```text
scripts/rs run start <json-file> --request-id <idempotency-key>
scripts/rs run list [--limit <count>]
scripts/rs run inspect <run-id>
scripts/rs run trace <run-id>
scripts/rs run cancel <run-id>
```

Run 必须二选一提供 `objective` 或 `workflowRef`；`inputs` 只与 workflow 一起使用。Steward 必须是 active Local Agent。可选 external workspace grant 要求绝对、真实、Git-backed directory，并在 admission 时固定 canonical root、`read | write` 与 revision。相同 request ID 返回同一 Run；同一 canonical workspace 允许多个 read Run，但同时最多一条 non-terminal write Run。

每个 Agent turn 只返回 `AgentTurnResult@1`：完成当前 step，或顺序委派一个 child Agent。Runtime 固定 callback 到准确的 caller Session；Agent 不能选择 callback target。Console 的 Latest Agent Run 使用同一 application query 展示 mandate、Steward、workspace grant、turn/depth budget、Agent exchanges 与 terminal summary，并允许取消活动 Run。完整状态机与恢复说明见 [Agent Run runbook](./reviews.md)。

## Legacy Review history

schema v43 及更早 terminal Review 只保留在 `/console/reviews` 和 loopback read API 中检查。legacy `review`/`steward` CLI 已整体移除；新审查通过通用 Agent Run 的 `review@1` workflow 执行。
