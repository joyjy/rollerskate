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
scripts/rs start [--foreground] [--no-open] [--ui-port <port>]
scripts/rs restart [--foreground] [--no-open] [--ui-port <port>]
scripts/rs stop
scripts/rs doctor --local
scripts/rs status
scripts/rs trace <event-id>
scripts/rs event list
scripts/rs event trace <event-id>
scripts/rs chat post --codex-thread <task-uuid> -- '@agent <message>'
scripts/rs workload status
scripts/rs failure list
scripts/rs failure inspect <failure-ref>
scripts/rs failure retry failure:delivery:<delivery-id>
scripts/rs recover
scripts/rs pause
scripts/rs resume
```

- `start` 默认 detached 启动 Local Runtime、loopback API 与内置 Vite Console，等 Core Loop ready 后返回；重复调用不会创建第二个进程。`stop` 向 Loop state 中的真实 PID 发送 `SIGTERM` 并等待优雅退出；`restart` 先停止再用当前源码和参数启动。`--foreground` 只用于开发和测试，终端信号会一并停止 Loop、API 与 Vite。
- Console 默认打开浏览器；`local/ui/src/` 修改通过 HMR 进入已打开页面，非 UI 源码不会热替换，改完后使用 `restart`。
- 新版 CLI 发现数据库需要升级且旧 Runtime 仍持有 loop lock 时会拒绝命令，不会在线迁移 schema；先停止旧 Runtime，再用新版 `start` 完成迁移和重启。
- `run list/inspect/trace`、`event list/trace`、`subscription list/inspect/history`、`agent list/status`、`chat history/status`、`chat schedule status`、`channel status`、不带 `--wait` 的 `channel follow` 与 `notice list/inspect` 只使用 read-only database connection，不创建目录、不初始化或迁移 schema。数据库版本落后时会保持原库不变并提示先停止旧 Runtime、再运行 `scripts/rs start` 升级；诊断命令本身不承担升级。
- Runtime 输出写入 `<runtime>/logs/daemon.log`；文件达到 5 MiB 后按 `daemon.log.1` 至 `daemon.log.5` 轮转，所有日志文件保持 mode-0600。
- `doctor --local` 只读验证当前 Local-first database、schema、Foundation 与固定 workspace，不读取兼容旧 Server/Matrix 路径的 `config.json`、`secrets.json` 或 Matrix token。
- `status` 输出结构化 Runtime process 状态、唯一 Core Loop phase、Workload 摘要、Failure 数量与解释，并同时显示当前构建产物的 expected revision、运行进程在 `loop-state.json` 固定的 revision 与 match 结果；PID 存活但 revision 不一致时不能宣称 Runtime 已加载目标代码。
- `event list/trace` 是 Events application query 的正式 CLI；顶层 `trace` 是同一 `event trace` query 的兼容 shortcut。
- `workload status` 输出 Core Loop 当前负责推进的 ready、running、retrying 与 total canonical work unit；已经关联 V1 Execution 或 V2 Run cycle 的 ScheduleOccurrence 不重复计数。
- `failure list/inspect` 输出影响 Runtime readiness、workload 或需要 Owner 介入的 bounded projection，并给出稳定 object/Event reference 与下钻提示。
- `failure retry` 只接受 exact failed Delivery failure ref，在 Owner 修复 transport 后追加一次 attempt budget，并沿原 origin/destination/payload 重试；重复调用 active 或 delivered Delivery 不复制投递。
- `recover` 仅在 Runtime 已停止且确实存在 interrupted durable work 时可用。安全可重试的 Execution 与 Delivery 恢复既有状态；已经进入 provider invocation 的 V1 ScheduleOccurrence 改为 `unknown` 并停止对应 Execution；external workflow 在 effect boundary 前恢复 retry，boundary 后改为 `unknown`，都避免盲目重放可能已有 side effect 的请求。Run-bound occurrence 与 Agent Run 复用 durable cycle、Execution recovery 与 generic ResultHandler continuation，没有专用 `steward recover`。
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
scripts/rs agent profile <handle>
scripts/rs agent profile <handle> update <json-file>
```

`handle` 是用户填写的短名称；Principal ID 由系统生成。创建时必须选择 `codex`、`claude-code`、`kimi-code` 或 `pi` adapter。`--launch-arg` 可重复，每次保存一个原始 argv 元素，不经过 shell 解析；例如 `--launch-arg --model --launch-arg claude-sonnet-4-6`。`agent configure` 原子替换该 Agent 的整组启动参数，不带 `--launch-arg` 时清空；下一次调用自动使用新 adapter 配置。

Codex 通过 app-server `thread/start|resume` params 设置 `read-only | workspace-write` sandbox、`approvalPolicy=never`、可选 network grant 与 invocation-scoped MCP config；不再调用 `codex exec --json`，launch args 只允许 `--model <model>` 和可选 `--reasoning-effort <none|minimal|low|medium|high|xhigh|max>`（各最多一次，具体模型支持范围由 provider 校验）。reasoning effort 经 thread config 固定，新建与恢复 Session 都使用该值；未指定时沿用本机 Codex 配置。assistant/reasoning/plan/tool 通知实时形成 bounded progress；默认 meaningful idle budget 为 300 秒，每次 meaningful update 都会续期。只有 Run workflow 显式声明 invocation budget 时才启用不可续期的 total deadline。stall、deadline 或 active protocol failure 会发送 `turn/interrupt` 并有界终止进程；partial delta 不会成为成功结果或写任务重放依据。

Session、output transport、workspace 与 permission/sandbox 参数由 adapter 控制，不能通过启动参数覆盖。Agent Run 的 external workspace grant 对所有 client 使用同一 `read | write` contract：Codex 与 Claude Code adapter 会把它转换为各自的进程权限参数。Kimi Code 通过 ACP v1 的 `session/new|resume|prompt` 运行：`read` grant 在新 Session 使用 `plan` mode，只批准 read/search/think/fetch tool kind；`write` grant 使用 `default` mode 并按次批准工具请求；恢复时 read/write access 已由 Session reference 锁定，不重复设置 mode。bundled profile 作为 prompt policy 注入；旧 Session reference 或 access 不匹配会新建 Session。Kimi launch args 只允许 `--model <model>`；Chat 合并 assistant message，Run/Subscription 只取末条，结果预算只计算 assistant text，不保存大块 tool trace。默认连续 300 秒没有 assistant/thought/tool/plan update 才触发 stall；持续 thought 会续期 idle，只有 workflow 显式 budget 才形成独立 total deadline。macOS 进程固定使用 Kimi legacy engine 规避 v2 watcher 的 `EMFILE` 回归，但仍走 ACP v1。Kimi 的权限映射不等同于 Codex OS sandbox，授权根仍以 Runtime 传入的 workspace 和 prompt contract 为边界。pi 对所有调用使用 `--mode rpc`；Runtime 预生成 exact provider ID，以 `--session-id` 创建或恢复，验证 `get_state` 后发送 prompt，并等待 `agent_settled`。单条超限 RPC record 会被丢弃并让 tool usage 保持未知，后续短 terminal result 仍可完成。pi 用 `--tools` 白名单映射 grant：`read` 只开放 read/grep/find/ls 和 bundled `read_git_diff`，`write` 额外开放 write/edit/bash 且不加载 Git 扩展；扩展内容进入 adapter identity 与 Runtime revision。工具白名单即权限边界，无 OS sandbox。Pi 与其他 streaming adapter 使用相同的 meaningful-idle / explicit-deadline 语义。公共 `agent request` 已关闭；需要执行工作时用 `run start` 的 stable participant ref 选择 Agent。

公共 Run 不接受 raw `workspace`、network 或 budget。`run start` 只接收 `RunIntent@1`；Owner compiler 从稳定 `workspaceRef` 与 `desiredEffect` 生成 canonical grant，当前默认 network off、`maxSteps=20`、`maxDepth=0`。

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
- Runtime diagnostics 给出 routed request ID；`inspect` 读取 requester、objective、context references、状态和当前 revision。`accept/reject/await-owner` 必须指定目标本地 Agent handle、Server work request ID 与该 revision。decision 幂等；`accept` 使用固定 Local policy revision 1，把实际 budget 限制为最多 20 steps/0 depth，并拒绝全部 remote grant expansion。
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
scripts/rs chat participant add|remove <handle> --revision <revision>
scripts/rs chat schedule status [schedule-id]
scripts/rs chat schedule create (--once <iso> | --cron <five-field-cron> --timezone <iana>) [--misfire skip|run_once] [--misfire-grace-ms <0-604800000>] [--candidates deterministic_one|sampled_sequential|all_available] [--intent continue_recent|choose_from_themes|directed] [--brief <text>] [--turn-budget <1-64>]
scripts/rs chat schedule pause|resume|cancel <schedule-id> --revision <revision>
scripts/rs chat presence set <handle> --scope <topic|global> --mode <available|snoozed> [--until <iso>] [--wake-keyword <literal>]...
scripts/rs chat session new <handle>
```

- `post` 追加 immutable Owner `chat.message` 并返回 queued Event ID；Runtime loop 在线时，ChatHandler 会对每个 Local Agent 应用 target 与 presence 状态机。写 `@handle` 只唤起该 Agent；不写 target 时所有 available Agent 都能自主 reply 或 silent。
- 有效 Agent 回复对象优先于正文 mention；没有有效回复对象时，只将当前 Chat 中 active 参与者的 mention 解析为接收者。未加入、已移除或 suspended 的 Agent mention 只作为正文；没有有效接收者时按普通消息发送，由现有 Chat 策略决定谁响应。
- `history` 输出 Local Topic 的稳定 message timeline cursor page；内部 `chat.dispatch` 只在 Event trace 中查看。
- `status` 输出每个 Agent 的 lifecycle status 以及已有的 Global/Topic presence。未出现 presence 表示尚未做过显式 decision，运行时按 available 处理。
- `governance` 输出当前 `TopicGovernance`、active participant roster、最近 control receipts 和动作可用性；其中 `expectedRevision` 可直接用于后续 control。`pause`、`resume` 与 participant add/remove 都必须显式携带该 revision；同状态重试返回 `unchanged`，过期且仍需 mutation 的 revision 返回 `conflict` 和 current governance，不产生写入。
- `resume` 只恢复 Topic，不创建 Chat activation。Local Chat 没有 Wake/Free Chat 命令；没有 Owner/Agent message 或显式 Topic schedule source 时不会调用 Agent。
- participant add/remove 只修改 Local conversation roster；空 roster 合法。它不删除或 suspend Agent，不旋转 Session，不撤销 history grant，不删除消息，也不修改 Server membership。
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
- `follow` 返回 `deliveryOutcome`：confirmed 只确认发送，not_started 表示尚未尝试，unknown 表示可能已产生远端效果（包括历史缺少尝试证据的 receipt）。failed/撤权不代表未发送，不能据此换 key 重发。`follow` 不带 `--wait` 时读取持久状态；带参数时执行最长 30 秒的 bounded long-poll，并返回 `--after`（首次省略时为 send cursor）之后最多 100 个、合计最多 64 KiB 的 `delta` 与最后一个实际返回 Event 的 `nextCursor`。调用方用该 cursor 续读，不会跳过未返回事件或重放更早历史。Local follow 可使用 canonical conversation correlation；Server Topic 没有 thread correlation 时只把 delta 标为 `new_message`，不能声称 `first_reply` 或 `terminal`。默认 follow 使用 bounded quiet window/deadline；`stop` 与 `revoke` 都按 revision CAS。
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

新的 Run-bound polling one-shot 或 Continuous Subscription 由带 `triggerIntent: "until" | "continuous"` 的 `RunIntent@1` 创建。Owner 在 runtime directory 的 `subscription-plugins.json` 登记 versioned plugin ref、project/file artifact、适用 trigger kind、probe workspace 与 HTTP/executable allowlist；compiler 读取并固定 artifact digest 与 trigger authority，调用方不能提交 raw plugin path、callback、Agent、command、destination 或 grant。没有匹配的 Owner registry entry 时，preflight 在 Event 创建前失败。

`subscription add` 固定返回 `legacy_trigger_write_closed`。历史 `SubscriptionDefinition@3` / `ContinuousSubscriptionDefinition@1` 仍可 inspect、pause、cancel、archive 和 reconcile；不能经公共 control resume。新 V4/V2 source 的 primary control 与结果判断都在 linked Run Workspace。

查询和控制：

```text
scripts/rs subscription list
scripts/rs subscription inspect <id>
scripts/rs subscription history <id> --json
scripts/rs subscription pause <id>
scripts/rs subscription resume <id>
scripts/rs subscription cancel <id>
```

确定性观察统一通过 `run preflight/start --source <plugin-ref> --input <business-input.json>` 提交；`--continuous` 保留连续观察，省略表示有界 until。`--return-to codex-desktop:<UUID>` 绑定回传任务，省略则只保存结果。`subscription register-desktop` 已关闭新建；已有定义、回执和 `subscription deliveries <id>` 仍可读。文件 workflow 的 Owner 注册/恢复是集成管理面，不是普通工作提交入口。


Owner file source 注册：

```bash
scripts/rs subscription register-file /absolute/path/file-subscription.json
```

```json
{
  "schemaVersion": "FileSubscriptionRegistration@1",
  "subscriptionId": "sub_00000000-0000-7000-8000-000000000001",
  "title": "本地文件订阅",
  "source": {
    "kind": "file",
    "root": "/absolute/canonical/directory",
    "recursive": true,
    "suffixes": [".md"],
    "exclude": ["_archive"],
    "debounceMilliseconds": 100,
    "maxDelayMilliseconds": 1000
  },
  "workflowRef": "workflow:example/sync@1"
}
```

`subscriptionId` 使用 Local `sub_` UUIDv7 格式；同 ID 同定义重复注册返回原记录，改变定义须使用新 ID。`workflowRef` 必须已经由 Owner external workflow registry 固定命令、input、artifact digest 与 authority；此入口不接受 raw command 或 grant。空 suffixes 匹配所有文件，exclude 是相对路径及其子树，均不是 glob。root 必须真实存在且为 canonical path。该命令只登记，不执行 target；Runtime 装配时加载 workflow registry，新增 registry entry 后需要匹配版本的 Runtime 重载。

File Subscription 的 `inspect` 返回 `nextPollAt=null`、source、fileListener、pending/checkpoint 和 external workflow 最近回执。`history` 保留其既有 Agent Event/Delivery 查询语义，external workflow 回执通过 `inspect` 查看。监听失败会重挂并补齐；target failed/unknown 会 block 且不自动重放。pause/cancel 停止后续监听准入，不撤销已准入的 workflow。

File external workflow 的 Owner 恢复入口：

```bash
scripts/rs --runtime /absolute/runtime subscription inspect <subscription-id>
scripts/rs --runtime /absolute/runtime subscription recover-file /absolute/recovery.json
scripts/rs --runtime /absolute/runtime subscription recoveries <subscription-id>
```

```json
{
  "schemaVersion": "FileSubscriptionRecovery@1",
  "subscriptionId": "sub_00000000-0000-7000-8000-000000000001",
  "expectedDefinitionRevision": "ContinuousSubscriptionDefinition@4:1",
  "executionId": "<inspect.externalWorkflowExecution.executionId>",
  "expectedAttemptCount": 1,
  "requestId": "owner-retry-001",
  "action": "retry",
  "reason": "已核对目标回执，确认幂等重跑安全；依赖故障已恢复",
  "retrySafe": true
}
```

`expectedDefinitionRevision` 与 `expectedAttemptCount` 分别取自 inspect 中 execution 的 `source.definitionRevision` 和 `attemptCount`，不能猜测。恢复只接受 exact blocked file Subscription 的当前 pending execution。`retry` 仅接受 failed，要求 `retrySafe: true` 与说明，保留 execution ID、occurrence、input、target 和旧 checkpoint，只追加一次 attempt budget 并恢复监听；registry/artifact 漂移会拒绝，不通过恢复升级命令权限。failed 也可能已有部分副作用，Owner 应先核对目标自己的幂等或外部回执。

unknown 必须先以 `action: "resolve-succeeded" | "resolve-failed"`、说明与新的 `requestId` 确认结果，并省略 `retrySafe`。确认 succeeded 追加 manual receipt，在同事务推进 pending checkpoint、清除 pending 并恢复 active，不重放目标；确认 failed 保持 blocked/pending，之后须另一次明确的 retry 请求才能执行。`subscription resume` 仍只用于 paused；cancelled source 拒绝新恢复。

命令返回不可变 `ExternalWorkflowRecoveryReceipt@1`，包含请求、原 terminal receipt、存在时的原 unknown receipt、人工确认回执及接受结果。同一 source + requestId + 完全相同请求始终返回原回执，即使执行已经成功；同 key 不同内容拒绝。不同 key 的过期 attempt、revision 或 pending execution 也拒绝。`recoveries` 按最近提交顺序读回最多 50 条 Owner 恢复记录，旧记录仍持久保留；当前执行状态继续通过 inspect 读取。恢复记录与 target/source 变化同事务提交，不覆盖原失败历史。重新挂载监听会补齐 blocked 期间可能遗漏的变更，因此原 pending 完成后可能发生新的范围失效调用；业务目标仍应按自身状态幂等。

`subscription history` 是固定 schema 的只读 JSON 查询，返回 `SubscriptionHistory@1`，并保持 `fires[] → deliveries[] → executions[]` 三层结构。每层分别保留来源标识、状态、错误和时间；Delivery 与 Execution 的 `attempt`、`maxAttempts`、`lastError` 是当前持久化的累计值和当前或最终错误，不表示数据库保存了逐 retry ledger。合法但尚未触发的 Subscription 返回 `queryStatus=ok`、`linkStatus=resolved` 和空 `fires`；旧记录无法可靠回溯时返回 `linkStatus=unresolved` 及稳定 `reasonCode`，查询错误则以非零命令结果退出，不伪装为空历史。

Console 的 `/console/subscriptions` 把 one-shot 与 Continuous 合并成 trigger diagnostics 列表。`GET /api/subscriptions?page=&pageSize=&q=&archive=current|archived|all` 返回稳定 envelope；V4/V2 显示 linked Run/cycle、pending/checkpoint/reconcile，legacy callback trace 标记为 `legacy / non-public`。

完整注册与生命周期说明见 [Subscription runbook](./subscriptions.md)。

## Local Scheduled Task

新的 Agent-backed Schedule 只能由带 `triggerIntent: "once" | "cron"` 的 `RunIntent@1` 建立。Steward 在 admitted authority 内选择 `schedule.once@1 | schedule.cron@1` template；application 原子写 `ScheduleRevision@3` 与 exact Run target。Owner 也可把 paused legacy V1 显式迁移到 mode-0600 registry 中的 versioned external workflow target。definition 不含 raw Agent、prompt、workspace、Session、callback、executable、argv、command 或 destination。

```text
scripts/rs schedule list
scripts/rs schedule inspect <schedule-id>
scripts/rs schedule pause <schedule-id>
scripts/rs schedule resume <schedule-id>
scripts/rs schedule cancel <schedule-id>
scripts/rs schedule run-now <schedule-id> --request-id <idempotency-key>
scripts/rs schedule migrate-workflow <schedule-id> --workflow-ref <workflow:name@version> --expected-revision <n> --request-id <idempotency-key>
scripts/rs schedule occurrences <schedule-id> [--limit <count>]
scripts/rs schedule runs <schedule-id> [--limit <count>] # legacy alias
scripts/rs schedule trace <run-id>
scripts/rs schedule resolve <run-id> <succeeded|failed>
```

`schedule create/update` 固定返回 `legacy_trigger_write_closed`。历史 V1 可 inspect、pause、cancel、archive 和 resolve unknown，但不能直接 resume 或 run-now；`migrate-workflow` 要求 paused V1、exact expected revision、registered ref 和稳定 request ID，成功后保留同一 Schedule ID 并写 immutable migration receipt。V2/V3 Run target 继续按 Run/source contract 工作；V3 external target 按独立 execution/lease/effect boundary/receipt 工作。`occurrences` 是主查询名，`runs` 是兼容 alias；trace 按 target 返回 Run/cycle、deterministic action 或 external workflow diagnostics。

完整示例、cron/DST、misfire、overlap 与恢复说明见 [Scheduled Task runbook](./scheduled-tasks.md)。

Console 的 `/console/schedules` 是 trigger diagnostics。`GET /api/schedules?page=&pageSize=&q=&archive=current|archived|all` 返回稳定分页 envelope；Run target occurrence 的 primary action 打开 linked Run，external workflow occurrence 展示 attempt、effect boundary 和 receipt，legacy trace 标记为 `legacy / non-public`。

## Agent Run 与 `review@1`

公共创建文件使用严格的 `RunIntent@1`；调用方只表达目标、验收、稳定 reference 与期望 effect，不提交 raw Agent/workspace/network grant：

```json
{
  "schemaVersion": "RunIntent@1",
  "requestId": "review-release-42",
  "objective": "评审当前 release 是否满足验收条件。",
  "acceptance": ["输出 exact source 和 test evidence"],
  "contextRefs": ["release:42"],
  "workspaceRef": "file:///absolute/workspace",
  "desiredEffect": "read",
  "requestedParticipantRefs": ["agent:reviewer"],
  "terminalEvidence": ["review artifact"]
}
```

```text
scripts/rs run preflight <intent-json-file> [--authorize-network]
scripts/rs run start <intent-json-file> [--authorize-network]
scripts/rs run authorize-network <run-id> --request-event <event-id> --expected-version <version>
scripts/rs run list [--limit <count>] [--archived]
scripts/rs run legacy-inventory
scripts/rs run legacy-migration-plan
scripts/rs run legacy-migrate <approval-json-file>
scripts/rs run inspect <run-id>
scripts/rs run trace <run-id>
scripts/rs run decide <run-id> <json-file> --request-id <idempotency-key>
scripts/rs run retry-orchestrator <run-id> --request-id <idempotency-key>
scripts/rs run cancel <run-id>
scripts/rs run close <run-id>
scripts/rs run archive <run-id>
scripts/rs run unarchive <run-id>
```

`run preflight` 只编译并返回 `StewardRunRequest@2`、authority summary 与稳定 admission digest，不创建 Event/Execution/Run。`workspaceRef` 当前接受 `project:self`、`local:workspace` 或显式本机 `file://` Git workspace；resolver 固定 canonical root 和当前 revision。`desiredEffect: read` 生成只读 grant，`change` 生成 `write + must_change`，`none` 不能同时提供 workspace。participant 使用 `agent:<handle>` 或 `principal:<id>`，compiler 总会加入 active `codex` Steward；destination 使用已登记的 `destination:<dst-id>`。无法唯一解析、未登记、effect 冲突或 authority 不可满足时，在 Event 创建前失败。

`run start` 只接受同一 `RunIntent@1`，其 `requestId` 同时是 idempotency key。原始 `schemaVersion: 1` / `StartStewardRunInput` 仅保留为内部 legacy seam，不是公共 CLI contract。compiler 当前固定 `maxSteps=20`、`maxDepth=0` 与初始 network off；Steward prompt 只看到 objective、acceptance、terminal evidence 和人可读 authority summary，不能改写 raw grant。

Console `POST /api/runs` 同样只接收 `RunIntent@1`。accepted External Work Request 先由本机 Owner receipt 缩小 workflow/budget/participant，再经过同一 compiler 建立 `OrchestratorBinding@3` Run。Local Chat 的普通消息仍是对话：没有 proposal 时，用户在 exact Owner message 上选择 `Hand off to Run`，以 `chat-work:<eventId>` 幂等创建 Run；有 proposal 时，每个 Agent dispatch 独立成卡，Owner 先做 workspace preflight，再以 `chat-work:<eventId>:<dispatchEventId>` 确认 exact revision。两者都不能由 Agent 自动触发。

默认 `run list` 只返回未归档 Run；`--archived` 只返回 archived Run。`run archive` 仅接受 terminal Run，`run unarchive` 可逆恢复默认可见性；两者都不删除或改写 Run、Event、Execution、Session、cycle、decision、output 与 trace 证据。

`run legacy-inventory` 以只读方式列出 active/paused Schedule、one-shot Subscription、Continuous Subscription、其 `ProactiveCallbackDefinition@1`、最近 occurrence 与所有未终结 occurrence。输出区分可重新准入的 `agent.invoke` 与需要 Owner 决定的 `command.exec` / delivery role；命令不 materialize callback、不创建 Run，也不修改 definition。

`run legacy-migration-plan` 同样只读，为每个 exact definition revision 输出 stable proposal digest、`ready | owner_decision | blocked_reconcile | already_applied`、目标 `RunIntent@1`、source template 与 authority delta。只有单一 `agent.invoke`、无未终结 occurrence、Agent/workspace/plugin 都可精确重新准入时才自动成为 `ready`；`command.exec` 必须先建立 Owner 持有的 versioned workflow，delivery 必须先确定 terminal result role。Owner 将 plan 中 exact source revision 与 proposal digest 写入严格 `LegacyTriggerMigrationApproval@1` 后，`run legacy-migrate` 才在一个 transaction 内创建 replacement Steward Run、pause 旧 definition，并写入 `legacy_trigger_migration_receipts`。重复提交返回同一 durable receipt；proposal/source revision 漂移或 pause 失败时整个 transaction 回滚。
`command.exec` 默认保持 `owner_decision`；只有 Owner 在 `~/.rollerskate/legacy-trigger-workflows.json` 的严格 `LegacyTriggerWorkflowRegistry@1` 中登记 exact source kind/id/revision + callback ID 到 bundled versioned workflow 与 `principal:<id>` 的唯一映射，并显式选择 `terminalResultPolicy: "retain" | "deliver"` 时，才可成为 `ready`。`retain` 禁止 `resultDestinationRef`，只保存 Run/cycle 证据；`deliver` 必须同时登记既有 `destination:<id>`。后台健康检查默认选择 `retain`。新 Run 只获得显式登记的 workflow、source template、participant 和可选 terminal result destination，不复制 raw command、workspace 或 network authority。
proposal digest 同时绑定 exact registry mapping 与 rendered workflow artifact digest；mapping 或 artifact 漂移会使旧 approval 失效。

`run decide` 的 JSON 必须是严格 `RunDecision@1`，包含当前 `expectedRunVersion`、bounded rationale 与 checked acceptance；action 只能是 `next_step`、`finish` 或 `needs_human`。`next_step.target` 只能是 `self` 或 admission roster 中的 exact Agent，不能增加 workspace/network/delegate authority。同一 request ID + 相同 decision 返回既有 receipt；payload 冲突或 stale version 失败。

新建公共 Run 使用 `RunDecision@6`，原始 acceptance 按 source order 固定为 `a1..aN`，连同 source digest 保存在 Orchestrator binding。可选 `RunIntent@1.dispatchNotes` 只提供执行建议，不改变原始验收。`checkedAcceptance` 为 `{id,status:pass|fail|unknown,evidenceRefs:string[]}`；成功要求原始条目完整且唯一、全部 pass、有证据引用、无 unresolvedQuestions。Runtime 校验完整性，不声称能自动证明自然语言证据的真实性；只读 Run 的不完整成功会携带错误反馈有界重试一次，不能用旧版 manual decision 绕过。已有 Run 按已绑定的旧 contract 继续，不迁移历史结果。

Steward 可用 `request_capability` 提交 network 请求，包含 acceptanceIds、targets 和 reason；`run inspect.capabilityRequest` 返回 exact requestEventId/runVersion/status。仅支持 standalone、无 source/cycle 的只读 Run。未获授权时暂停在原 Run，保留 checkpoint/state；Owner 可用 `run authorize-network` 确认 exact 请求，重复提交返回原续行 Event，取消、过期、版本漂移或不可用参与者不能续行。`start --authorize-network` 是 Owner 对本次 Run 的显式网络预授权，要求全体参与者为 Codex；初始仍离线，Steward 请求时自动准入，不再次问人。该参数不属于 RunIntent，Chat/外部请求不能通过输入字段自授权限。网络开关不强制 HTTP 方法或域名 allowlist；targets 是可审阅的使用目的，不能把此开关称为远端只读保护。文件仍保持 read-only，Codex 每次 turn 使用明确的 `readOnly.networkAccess` policy，包括恢复 Session。权限变更、续行 Event 和 Run CAS 同事务提交，不重复已完成 Worker。

`run inspect` 的 `intervention` 可返回 `RunIntervention@1`：只有 settled 的 manual fallback 才包含失败原因、exact request/result execution 和允许的恢复动作；普通 pending 时为 null。`outputFolders` 是结构化终态输出入口，包含稳定 outputId、原始 id、contentType、schemaVersion 与 value；新 Run 通过 `RunDecision@4.finish.outputs` 返回，不能用 trace 或 acceptedEvidence 替代。

`run retry-orchestrator` 是 Owner 对 `OrchestratorBinding@3` 初始只读决策的精确恢复入口，既适用于独立 Run，也适用于 source-bound Run 的 active cycle；只接受处于 `awaiting_orchestrator`、尚未产生 Worker checkpoint、且 workspace 非 write 的 Run。命令从当前 Run version、状态和 fixed roster 重新渲染 prompt，并复用最新已 settled Steward request 的 Run context 与只读 Session recovery evidence，追加一次新的 Steward request；它不会创建新 Run/cycle、改变 source binding 或重放未知 write outcome。`--request-id` 形成稳定 external ID：同一 key 重复调用返回同一 Event/Execution 的 `duplicate` receipt，即使 Run/cycle 后续已终结；不同 key 表示 Owner 明确授权另一次恢复尝试。独立 Run 或新 source cycle 的首次 Steward provider/contract failure 由 Runtime 自动重试一次，第二次失败仍保留 manual fallback。

Autonomous Run 的每个 Agent turn 返回 `AgentTurnResult@1`；Caller mode 返回 `AgentStepResult@1`，由 Caller decision 安排下一步。Run/Subscription typed result 可以是完整 JSON、单一 JSON fence 或带 bounded wrapper 的唯一顶层 object，字段 schema 始终严格。Run provider execution 只尝试一次；失败、contract-invalid 或未满足 `must_change` completion gate 时由一次 bounded Steward adjudication 决定 accept、带安全证据的单次 retry 或 `needs_human`，Runtime 无法排除 side effect 时拒绝 retry；adjudicator 不能用 normalized result 覆盖 Runtime revision 证据。Steward Console 使用同一 application query 展示 Run index、orchestration mode、typed checkpoint、decision receipts、mandate、workspace grant、turn budget、Agent exchanges、prompt/result/tool diagnostics 与 terminal summary，并允许取消活动 Run、归档 terminal Run及切换 archived 列表。`GET /api/runs?page=&pageSize=&q=&archive=current|archived|all` 与另外两类 owner 使用同一分页 envelope。完整状态机与恢复说明见 [Agent Run runbook](./reviews.md)。

### Steward Owner 分流与统计

- `scripts/rs run steward-policy`：读取当前配置和文件位置。
- `scripts/rs run steward-policy <policy.json>`：写入 Owner 配置；JSON 为 `{"schemaVersion":"StewardPolicy@1","entries":[{"agentId":"<exact registered Agent ID>","weight":100}]}`。entries 必须为 active Codex/Kimi/Pi Agent，权重合计 100；80/10/10 使用三个 entry。配置无需重启，在下一次新 Run 准入时读取。
- `scripts/rs run steward-stats [--policy-digest <sha256:digest>]`：按准入策略摘要与实际 steward 聚合 Run 数、进行中/needs_human/终态、成功率、曾 fallback 的比例及完成耗时。策略摘要可从 `run preflight` 的 stewardSelection 获取；不传筛选时各策略和历史无策略数据分别成组。

同一 request ID 保留已准入 steward；禁用实验时将 Codex Agent 设为 100，不改派既有 Run。少量样本只证明链路可用，不能代表模型质量差异。

## Codex Desktop 直接投递

`scripts/rs codex-push --thread <完整任务UUID> [--socket <absolute-path>] [--timeout <seconds>] send` 从 stdin 读取已授权消息，通过 RS 内置传输投递，不依赖 ai-meta 或外部 helper。CLI 与 Runtime Delivery 共用 socket/owner 校验和 steer/start 路径。回执、单次发送及生命周期限制见 [Desktop push](codex-desktop-push.md)。

## 统一 Run 提交与预检

Agent 工作保留 `RunIntent@1` 的真实调用方与触发语义；确定性 command/observe 工作使用 `RunIntent@2`。两者统一经 `run preflight/start` 提交、`run inspect/trace/list` 查询，CLI 参数和文件进入同一 application compiler。`run --help` 提供参数形式；Agent 参数支持 `--objective`、可重复的 `--acceptance`、`--workspace`、`--effect` 和 `--return-to`，无需手写基础 JSON。

```sh
scripts/rs run preflight --id install-jq-1 --title '安装 jq' --cwd /absolute/workspace --return-to codex-desktop:<任务UUID> --timeout 1800 -- brew install jq
scripts/rs run start --id install-jq-1 --title '安装 jq' --cwd /absolute/workspace --return-to codex-desktop:<任务UUID> --timeout 1800 -- brew install jq
scripts/rs run inspect <返回的runId>
scripts/rs run list --limit 20
scripts/rs run cancel <runId>
```

示例不授权安装。参数按 argv 传递，不隐式执行 shell；进程继承调用者权限与环境，stdin 关闭，日志私有。`--timeout` 是观察预算，默认 3600 秒、范围 1–2678400；确定性 Run 的 `cancel` 只取消后续观察，不杀进程或撤回已入队 Delivery。进程退出之后的软件可用性、镜像 digest 等仍按任务验收。

```json
{
  "schemaVersion": "RunIntent@2",
  "requestId": "pipeline-42",
  "title": "等待 pipeline 42",
  "maxWaitMilliseconds": 3600000,
  "resultDestinationRef": "codex-desktop:00000000-0000-7000-8000-000000000001",
  "work": {
    "kind": "observe",
    "sourceRef": "plugin:my-pipeline@1",
    "input": { "pipelineId": "42" }
  }
}
```

`work.input` 只包含来源所需的业务参数，具体字段由所选已登记 plugin 定义；不接受调用方拼装 probe policy、callback、内部 ID 或 grant。连续观察设置 `work.mode=continuous` 并省略 `maxWaitMilliseconds`。命令的 work 为 `{kind:"command", executable, args, cwd}`。确定性回传目前支持 `codex-desktop:<UUID>`，Agent 保留 `destination:<id>`；不支持的执行器/目标组合在准入失败，不猜测降级。

`preflight` 返回 `RunPreflight@1`：`status=passed|failed`、`plan`、`planDigest`、`diagnostics`、`unverified`。诊断包含 `code/field/expected/actual/fix`。它检查契约、工具声明、已登记权限、规范化路径及 Runtime freshness，对指定 Desktop 任务做只读 owner discovery，并在无权限的 plugin 沙箱中调用 plan；不会执行实际 probe、工作命令、创建 Run/Subscription 或发送消息。工具参数和权限检查在每次实际 probe 执行前复用，动态计划不能绕过。任意 shell 效果、远端凭据与未来 Desktop 目标可用性列为 unverified，不能当作已证明；执行时仍由原权限和 transport admission 约束。

`start` 总是重新编译，不接收预检结果作为授权。确定性结果返回 `runId/sourceId/run`，命令额外返回 `launch`（state、pid、回执和日志路径）。0 表示已准入或返回同一已准入请求；1 表示启动失败；2 表示配置/准入检查失败；3 表示准入或启动可能已发生、结果未知。退出码都不证明工作成功。相同 request ID 和相同意图返回原 Run，不同意图报 `REQUEST_CONFLICT`，不重复执行；中断预留保持 unknown，不能换 ID 盲重试。

`run inspect` 同时返回执行回执、source 和 Delivery 状态。命令成功与回传成功独立；无 destination 显示 `not_requested`，未入队显示 `not_enqueued`。Delivery `delivered` 只证明 Desktop 接受传输，真正接收仍核对目标任务。旧 `command start` 关闭，`command inspect <历史commandId>` 仅保留本轮已有命令回执的读回。后台完成与权限规则见 [Desktop push](codex-desktop-push.md#预计耗时较长的本地命令)。
