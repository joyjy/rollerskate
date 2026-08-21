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
- 新版 CLI 发现数据库需要升级且旧 Runtime 仍持有 loop lock 时会拒绝命令，不会在线迁移 schema；先停止旧 Runtime，再用新版 `start` 完成迁移和重启。
- Runtime 同时把前台输出写入 `<runtime>/logs/daemon.log`；文件达到 5 MiB 后按 `daemon.log.1` 至 `daemon.log.5` 轮转，所有日志文件保持 mode-0600。
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
scripts/rs agent create <handle> --client <codex|claude-code|kimi-code|pi> [--launch-arg <arg>]...
scripts/rs agent configure <handle> [--launch-arg <arg>]...
scripts/rs agent list
scripts/rs agent status <handle>
scripts/rs agent rename <handle> <new-handle>
scripts/rs agent suspend <handle>
scripts/rs agent resume <handle>
scripts/rs agent request <handle> [--session <ses_uuidv7>] <prompt...>
scripts/rs agent profile <handle>
scripts/rs agent profile <handle> update <json-file>
```

`handle` 是用户填写的短名称；Principal ID 由系统生成。创建时必须选择 `codex`、`claude-code`、`kimi-code` 或 `pi` adapter。`--launch-arg` 可重复，每次保存一个原始 argv 元素，不经过 shell 解析；例如 `--launch-arg --model --launch-arg claude-sonnet-4-6`。`agent configure` 原子替换该 Agent 的整组启动参数，不带 `--launch-arg` 时清空；下一次调用自动使用新 adapter 配置。

Codex 通过 app-server `thread/start|resume` params 设置 `read-only | workspace-write` sandbox、`approvalPolicy=never`、可选 network grant 与 invocation-scoped MCP config；不再调用 `codex exec --json`，launch args 只允许 `--model <model>`。

Session、output transport、workspace 与 permission/sandbox 参数由 adapter 控制，不能通过启动参数覆盖。Agent Run 的 external workspace grant 对所有 client 使用同一 `read | write` contract：Codex 与 Claude Code adapter 会把它转换为各自的进程权限参数。Kimi Code 通过 ACP v1 的 `session/new|resume|prompt` 运行：`read` grant 在新 Session 使用 `plan` mode，只批准 read/search/think/fetch tool kind；`write` grant 使用 `default` mode 并按次批准工具请求；恢复时 read/write access 已由 Session reference 锁定，不重复设置 mode。bundled profile 作为 prompt policy 注入；旧 Session reference 或 access 不匹配会新建 Session。Kimi launch args 只允许 `--model <model>`；Chat 合并 assistant message，Run/Subscription 只取末条，结果预算只计算 assistant text，不保存大块 tool trace。连续 120 秒没有 assistant/thought/tool/plan update 时 stall watchdog 终止调用，总 timeout 独立生效。macOS 进程固定使用 Kimi legacy engine 规避 v2 watcher 的 `EMFILE` 回归，但仍走 ACP v1。Kimi 的权限映射不等同于 Codex OS sandbox，授权根仍以 Runtime 传入的 workspace 和 prompt contract 为边界。Pi 对所有调用使用 `--mode rpc`；Runtime 预生成 exact provider ID，以 `--session-id` 创建或恢复，验证 `get_state` 后发送 prompt，并等待 `agent_settled`。单条超限 RPC record 会被丢弃并让 tool usage 保持未知，后续短 terminal result 仍可完成。Pi 用 `--tools` 白名单映射 grant：`read` 只开放 read/grep/find/ls，`write` 额外开放 write/edit/bash；工具白名单即权限边界，无 OS sandbox。`agent request` 直接向 Agent 发起一次请求，省略 `--session` 时由 Runtime 管理 Session。

`run start` 的 JSON 可在 `workspace` 中设置 `networkAccess: true`，但必须同时使用 `access: "write"`、Codex Steward 和 `maxDepth: 0`；省略时 Run 没有网络。该 authority 是 Run admission snapshot，不从 Agent launch args、环境变量或业务 prompt 推断，也不会扩散给子 Agent。

`scripts/rs start` 默认在 `PATH` 中发现 `codex`、`claude`、`kimi` 与 `pi`。需要固定 executable 时分别设置 `ROLLERSKATE_CODEX_EXECUTABLE`、`ROLLERSKATE_CLAUDE_CODE_EXECUTABLE`、`ROLLERSKATE_KIMI_CODE_EXECUTABLE` 或 `ROLLERSKATE_PI_EXECUTABLE`。单个 Agent 的 adapter 或可选 same-client history capability 不可用时，只让该 Agent 的 Execution 失败；同一 Chat 中其他 Agent 的 attention 与 dispatch 继续推进。

`agent profile` 读取 Server 上的公开 profile；`update` 使用包含 `expectedRevision` 的 JSON 做 compare-and-swap。公开 profile 只承载公共身份、角色、disclosure 和表达规则，不包含本地 prompt、workspace、memory、credential 或工具权限。

## Agent work request

```text
scripts/rs work-request inspect <agent-handle> <request-id>
scripts/rs work-request accept <agent-handle> <request-id> --revision <revision>
scripts/rs work-request reject <agent-handle> <request-id> --revision <revision>
scripts/rs work-request await-owner <agent-handle> <request-id> --revision <revision>
```

- `scripts/rs start` 为 active paired Agent 注册 process-scoped online route；Runtime 停止或 Server 不可达时，新请求返回 `target-unavailable`，不会排队等待恢复。Runtime 重启后旧 route 上尚未接受的请求也不会补推。
- Runtime diagnostics 给出 routed request ID；`inspect` 读取 requester、objective、context references、状态和当前 revision。`accept/reject/await-owner` 必须指定目标本地 Agent handle、Server work request ID 与该 revision。decision 幂等；`accept` 使用固定 Local policy revision 1，把实际 budget 限制为最多 20 steps/4 depth，并拒绝全部 remote grant expansion。
- 只有 Server 接受 decision 后才以稳定 owner request ID 创建既有 Steward Run并挂回 Run receipt；重复命令返回同一 Run。已经 accepted 但在挂 receipt 前中断的请求由下一次 Runtime cycle 恢复。
- terminal Run 只回传 outcome、最多 4 KiB summary 和 bounded artifact references；requester 看不到 Local Event trace、workspace、provider transcript，也不能远程停止目标 Run。

## Server Topic 与本地 activity access

```text
scripts/rs topic list
scripts/rs topic history [topic-id]
scripts/rs topic server-list
scripts/rs topic create <json-file>
scripts/rs topic profile update <topic-id> <json-file>
scripts/rs topic join <topic-id> <agent-handle>
scripts/rs topic publish <topic-id> <agent-handle> <transaction-id> <message...>
scripts/rs activity access grant <agent-handle>
scripts/rs activity access status <agent-handle>
scripts/rs activity access revoke <agent-handle>
```

- Topic create/profile update/join 使用已配对 Device 所代表的 Human authority；publish 只使用目标 Agent credential。`transaction-id` 是重试时必须复用的幂等键。
- `topic server-list` 读取已连接 Server 的 Topic control plane；`topic list/history` 只读取 Local Runtime 已持久化、按 Event ID 去重的被动 inbox。Server delivery 不创建 Local canonical Event、Handler 或 Execution，也不能远程唤起 provider。
- Network Console 可把现有 Local Agent enrollment/recovery 到 Server，加入或发布前显示 `主人 / 设备 / @Agent`。canonical identity 仍由 Human、Device 与 Agent ID 组成；显示名和设备名不承担唯一性。
- `activity access` 只管理 Owner 对 profiled Agent 的本地、显式、可撤销授权。查询结果受 source root、大小上限与 redaction 约束；原始 transcript、secret 和 credential 不上传 Server 或 Topic。
- Local Console 的 `/console/network` 通过 `Connect Server` / `Reconnect Server` 创建 browser pairing，并在新标签页使用 OIDC Authorization Code + PKCE 登录 Server、显式批准设备；pairing verifier 和最终 Device credential 始终留在 Local 后端。CLI `device login` 仍使用 Device Authorization Grant。v0.4.0 没有独立 Server admin UI。

## Local Chat

```text
scripts/rs chat post <message...>
scripts/rs chat history
scripts/rs chat status
scripts/rs chat governance
scripts/rs chat pause --revision <revision>
scripts/rs chat resume --revision <revision>
scripts/rs chat resume-and-wake --revision <revision> --idempotency-key <key>
scripts/rs chat participant add|remove <handle> --revision <revision>
scripts/rs chat free status
scripts/rs chat free start --idempotency-key <key> [--intent continue_recent|choose_from_themes|directed] [--brief <text>]
scripts/rs chat free continue-now --revision <revision>
scripts/rs chat free exit --revision <revision>
scripts/rs chat schedule status [schedule-id]
scripts/rs chat schedule create (--once <iso> | --cron <five-field-cron> --timezone <iana>) [--misfire skip|run_once] [--misfire-grace-ms <0-604800000>] [--candidates deterministic_one|sampled_sequential|all_available] [--intent continue_recent|choose_from_themes|directed] [--brief <text>] [--turn-budget <1-64>]
scripts/rs chat schedule pause|resume|cancel <schedule-id> --revision <revision>
scripts/rs chat presence set <handle> --scope <topic|global> --mode <available|snoozed> [--until <iso>] [--wake-keyword <literal>]...
scripts/rs chat session new <handle>
```

- `post` 追加 immutable Owner `chat.message` 并返回 queued Event ID；Runtime loop 在线时，ChatHandler 会对每个 Local Agent 应用 target 与 presence 状态机。写 `@handle` 只唤起该 Agent；不写 target 时所有 available Agent 都能自主 reply 或 silent。
- `history` 输出 Local Topic 的稳定 message timeline cursor page；内部 `chat.dispatch` 只在 Event trace 中查看。
- `status` 输出每个 Agent 的 lifecycle status 以及已有的 Global/Topic presence。未出现 presence 表示尚未做过显式 decision，运行时按 available 处理。
- `governance` 输出当前 `TopicGovernance`、active participant roster、最近 control receipts 和动作可用性；其中 `expectedRevision` 可直接用于后续 control。`pause`、`resume` 与 participant add/remove 都必须显式携带该 revision；同状态重试返回 `unchanged`，过期且仍需 mutation 的 revision 返回 `conflict` 和 current governance，不产生写入。
- `resume` 只恢复 Topic，不创建 Chat activation。`resume-and-wake` 还必须携带调用方生成并在重试时复用的 idempotency key；它只会收敛为一个 `reason=resumed` 的 canonical activation。
- participant add/remove 只修改 Local conversation roster；空 roster 合法。它不删除或 suspend Agent，不旋转 Session，不撤销 history grant，不删除消息，也不修改 Server membership。
- `chat free status` 输出 latest mode、recent receipts、expected revision 与 start/continue-now/exit availability。`start` 必须携带调用方在重试时复用的 idempotency key；默认使用 governance conversation policy，`directed` 必须同时提供 `--brief`。`continue-now` 只把当前 sample deadline 提前到现在，不绕过 single-root admission；`exit` 持久化 terminal mode 与 receipt。两个 mutation 都使用 status 返回的 revision 做 CAS。
- `chat schedule` 管理 Topic-owned scheduled activation，不是顶层 `schedule` arbitrary Scheduled Task 的别名。create 只接受 conversation time、misfire、candidate、intent 和 turn budget；`directed` intent 必须同时提供 `--brief`。status 返回 current schedule 与 recent occurrence receipts，pause/resume/cancel 必须使用其中的 revision 做 CAS。唯一 loop 的 `topic.schedule` phase 把每个 occurrence 至多 admission 为一个 canonical `chat.activation`；暂停窗口、misfire、paused Topic、scheduled policy disabled、空 eligible roster 或 active-root overlap 都写 bounded skip receipt 并推进，不 backfill。
- `presence set` 由 Owner 覆盖一个 Agent 的当前 scoped presence。`available` 不接受 `--until` 或 wake keyword；`snoozed` 必须提供未来的 `--until`，`--wake-keyword` 可重复。它修改的是 `Agent × (Global | 当前 Topic)` 状态，不是 Topic 配置，也不改变 Agent lifecycle。
- `session new` 清空该 Agent 的 current Session pointer并增加 generation，不删除历史。

Agent 每轮返回 `ChatDecision@1`，同时决定 speech 与下一步 presence；Owner 的 CLI 设置与 Agent decision 更新同一条 scoped state，后写入者生效。`snoozed` 可作用于 Topic 或 Global；active Global snooze 优先。直接 mention、对应 scope 的 literal wake keyword 或到期会让 Agent获得一次新决策机会，但不会替 Agent自动回复。当前 Chat 行为 prompt 是随 build 发布的 `prompt.chat.free-turn` 资源，没有独立 revision/editor。

Loopback API 使用同一 application control/query：`GET/POST /api/chat/schedules` 列表或创建；`POST /api/chat/schedules/<schedule-id>/pause|resume|cancel` 以 body `expectedRevision` 做 CAS。mutation 仍要求 Console request marker，API 不提供 generic Event write。

## Interactive Channel

```text
scripts/rs channel bind <agent-handle> --allow <local-chat:topic-id|server-topic:topic-id> [--allow <ref>]... --expires <iso> [--callback-session <ses_uuidv7>]
scripts/rs channel send <binding-id> <local-chat:topic-id|server-topic:topic-id> <idempotency-key> <message...>
scripts/rs channel status <binding-id>
scripts/rs channel follow <follow-token> [--wait <0-30000-ms>] [--after <cursor>]
scripts/rs channel revoke <binding-id> --revision <revision>
scripts/rs channel stop <follow-token> --revision <revision>
```

- `bind` 精确绑定一个 active Local Agent；Local Chat 同时要求该 Agent 是当前 active Topic participant，每个 allowed Channel 在创建时验证归属或 Server Topic membership，expiry 必须在未来。可选 callback Session 必须是该 Agent 已有的 durable `ses_*`，不会创建或采用桌面客户端临时会话。
- `send` 不接受 `--as`；sender 由 binding 唯一决定。调用方必须在重试时复用 idempotency key，同一 key 的 Channel/body 不一致会 fail closed。Local Chat send 进入 canonical Chat admission；Server Topic send 同时要求该 Agent 的 membership 与 credential，并复用稳定 transport transaction。返回值包含 durable send receipt、observed cursor 和 follow token。
- `follow` 不带 `--wait` 时读取持久状态；带参数时执行最长 30 秒的 bounded long-poll，并返回 `--after`（首次省略时为 send cursor）之后最多 100 个、合计最多 64 KiB 的 `delta` 与最后一个实际返回 Event 的 `nextCursor`。调用方用该 cursor 续读，不会跳过未返回事件或重放更早历史。Local follow 可使用 canonical conversation correlation；Server Topic 没有 thread correlation 时只把 delta 标为 `new_message`，不能声称 `first_reply` 或 `terminal`。默认 follow 使用 bounded quiet window/deadline；`stop` 与 `revoke` 都按 revision CAS。
- binding 带 callback Session 时，follow 达到条件后仅在 binding/revision/expiry 仍有效、Session 仍归同一 Agent 且 exact Session idle 时 admission 一个 canonical `agent.request`；busy 时保持 durable pending，revoke/expiry/ownership drift 会终止 callback。

Loopback API 提供 `GET /api/channels/<binding-id>`、`GET /api/channels/follows/<follow-token>?waitMilliseconds=<0-30000>&afterCursor=<cursor>`、`POST /api/channels/bindings`、`POST /api/channels/<binding-id>/send|revoke` 与 `POST /api/channels/follows/<follow-token>/stop`。mutation 要求 Console request marker；body 使用与 CLI 相同的 exact Agent/allowlist/idempotency/expected-revision 边界。

## Notice

```text
scripts/rs notice list [--limit <1-1000>]
scripts/rs notice inspect <notice-id>
scripts/rs notice mark-read <notice-id>
scripts/rs notice ack <notice-id>
scripts/rs notice rebuild
```

Notice Center 从 SQLite `notices` 读取由 `macos-notification` Delivery snapshot 和对应 `agent.result` 形成的 bounded projection，不依赖 macOS 通知中心是否仍保留横幅。`list` 默认按发生时间倒序返回 100 条；`inspect` 使用列表中的 `ntc1_...` Notice ID。`mark-read` 记录首次 read time；`ack` 同时保证 read 并记录首次 acknowledge time，重复执行不改写首次时间。`rebuild` 从 canonical facts 重投 derived columns，但保留同表 authoritative columns 中的 read/ack。

## Subscription

注册 one-shot 或 Continuous Subscription：

```text
scripts/rs subscription add <json-file>
```

One-shot 输入只接受 `SubscriptionDefinition@3`：

```json
{
  "schemaVersion": 3,
  "revision": "build-v1",
  "title": "Build completed",
  "ownerAgentId": "prn_uuidv7",
  "probe": {
    "plugin": {
      "path": "/absolute/path/to/plugin.ts",
      "id": "plugin-id",
      "config": {}
    },
    "artifactRevision": "git:commit-or-content-revision",
    "artifactDigest": "sha256:<64-lowercase-hex>",
    "policy": {
      "workspaceRoot": "/absolute/workspace",
      "allowedHttpOrigins": [],
      "allowedExecutables": [],
      "allowedEnvironment": [],
      "timeoutMilliseconds": 30000,
      "maxOutputBytes": 1048576
    }
  },
  "callbacks": [],
  "schedule": {
    "intervalMilliseconds": 1000,
    "maxWaitMilliseconds": 60000,
    "maxAttempts": 60
  },
  "approvedGrantDigest": "T1PNoYwrqgwDVLtfmj7L5e0Sq02OEbqHPC8RFhICuUU"
}
```

Definition 固定 probe artifact revision/digest、`approvedGrantDigest`，以及最多 16 个按 ordinal 执行的 `command.exec`、`agent.invoke` 或 `destination.deliver` callback。三个第一方 owner 使用同一 callback definition/grant、store 与 runtime；中断后未形成 durable Core work 的 started 和剩余 pending callback 标记为 `unknown`，不会盲目 replay。v2 输入和 legacy view 已移除。

长期观察使用 `schemaVersion: "ContinuousSubscriptionDefinition@1"`，保留相同 probe 边界，schedule 只包含 `intervalMilliseconds`，并使用共享 `agent.invoke | command.exec | destination.deliver` callback。Plugin observation 的稳定 `occurrenceKey` 只有在 callback terminal receipt 后才推进 checkpoint。

查询和控制：

```text
scripts/rs subscription list
scripts/rs subscription inspect <id>
scripts/rs subscription pause <id>
scripts/rs subscription resume <id>
scripts/rs subscription cancel <id>
```

完整注册与生命周期说明见 [Subscription runbook](./subscriptions.md)。

## Local Scheduled Task

创建文件使用 `schemaVersion: 1`（兼容的单 `agent.invoke`）或 `schemaVersion: 2`（ordered shared callbacks）。one-shot 兼容示例：

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

v2 保留相同 time/misfire/overlap 字段，并增加非空 `callbacks`；每项使用 `ProactiveCallbackDefinition@1` 与 `ProactiveCallbackGrant@1`，kind 为 `agent.invoke`、bounded `command.exec` 或 `destination.deliver`。`command.exec` 只接受 `runtime: "host"`，definition 与 grant 必须精确匹配 executable、argv、cwd、environment、timeout 和 output bound，并显式声明 filesystem roots、真实的 network authority 与空的 secret references。Host executable 是可信 code，可以启动传递子进程；RS 校验 exact grant，但不提供进程沙箱。历史 `runtime: "node"` callback 只读兼容，不能新增或执行。Schedule occurrence 只 materialize 一组 callback work；command/destination-only Schedule 不创建 Agent Event。

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

Run `scripts/rs schedule create --help` for the exact `command.exec` host callback contract.

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
    "access": "write",
    "effect": "may_remain_unchanged"
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
scripts/rs run decide <run-id> <json-file> --request-id <idempotency-key>
scripts/rs run cancel <run-id>
scripts/rs run close <run-id>
```

Run 必须二选一提供 `objective` 或 `workflowRef`；`inputs` 只与 workflow 一起使用。Steward 必须是 active Local Agent。可选 `orchestration: { "mode": "caller" }` 固定当前 active Local Agents 为 admitted roster、将 `maxDepth` 固定为 0，并让每个 Worker result 进入 `awaiting_orchestrator`。可选 external workspace grant 要求绝对、真实、Git-backed directory，并在 admission 时固定 canonical root、`read | write`、revision 与 write effect。write grant 必须显式选择 `must_change` 或 `may_remain_unchanged`；`must_change` 的 succeeded result 只有在 Runtime 独立观察到 revision 改变后才成立。相同 request ID 返回同一 Run；同一 canonical workspace 允许多个 read Run，但同时最多一条 non-terminal write Run。

autonomous Run 可选 `series: { "key": "<owner-stable-key>", "sourceRevision": "<immutable-revision>" }`。相同 key 复用一个 Run ID；相同 revision 复用 cycle/Session，不同 revision 创建 fresh cycle/Session。cycle terminal 后 Run 为 `awaiting_source`，`run inspect` 同时返回 series summary、cycle list 与每步 `cycleId`。caller/steward orchestration 不接受 series。Owner 在外部 source merged/closed 时用 `run close` 正常结束 awaiting-source Run；`run cancel` 表示显式中止。

`run decide` 的 JSON 必须是严格 `RunDecision@1`，包含当前 `expectedRunVersion`、bounded rationale 与 checked acceptance；action 只能是 `next_step`、`finish` 或 `needs_human`。`next_step.target` 只能是 `self` 或 admission roster 中的 exact Agent，不能增加 workspace/network/delegate authority。同一 request ID + 相同 decision 返回既有 receipt；payload 冲突或 stale version 失败。

Autonomous Run 的每个 Agent turn 返回 `AgentTurnResult@1`；Caller mode 返回 `AgentStepResult@1`，由 Caller decision 安排下一步。Run/Subscription typed result 可以是完整 JSON、单一 JSON fence 或带 bounded wrapper 的唯一顶层 object，字段 schema 始终严格。Run provider execution 只尝试一次；失败、contract-invalid 或未满足 `must_change` completion gate 时由一次 bounded Steward adjudication 决定 accept、带安全证据的单次 retry 或 `needs_human`，Runtime 无法排除 side effect 时拒绝 retry；adjudicator 不能用 normalized result 覆盖 Runtime revision 证据。Steward Console 使用同一 application query 展示 Run index、orchestration mode、typed checkpoint、decision receipts、mandate、workspace grant、turn budget、Agent exchanges、prompt/result/tool diagnostics 与 terminal summary，并允许取消活动 Run。完整状态机与恢复说明见 [Agent Run runbook](./reviews.md)。
