---
type: Reference
title: Rollerskate Local Database Reference
description: Local SQLite 的 Event / index / object 建模规范，以及 schema v72 的 32 张物理表、ownership、authority 与迁移规则。
tags: [rollerskate, local, sqlite, database, schema]
timestamp: 2026-07-26
---

# Rollerskate Local Database Reference

[返回 architecture index](./index.md)

`local/src/infrastructure/sqlite/schema/` 是 Local SQLite DDL、组合版本与兼容迁移的唯一事实边界；目录内 `index.ts` 是唯一公开入口，`definition.ts`、各版本 migration 与 `introspection.ts` 分别拥有当前定义、兼容升级和 SQLite metadata helpers。外层 `schema.ts` 只负责打开数据库并调用该入口，各 Store 不再各自创建业务表。schema v72 只有下文登记的 32 张产品表，不包含 SQLite 内部表。

## 物理建模总则：默认聚合，按生命周期拆分

Local SQLite 是 local-first、单 Owner 的嵌入式数据库。物理 schema 默认围绕 aggregate 和数据生命周期设计，不为每个不变量、关系或字段组分别建表。关系范式、外键完整性和查询方便本身不能成为拆表理由。

核心原则：

> 允许在明确 owner 下重复 immutable、bounded snapshot；不允许同一个 mutable fact 出现两个可独立修改的 authority。

只有命中以下至少一项时，才建立独立物理表：

- 数据拥有独立生命周期、retention 或删除语义；
- 数据需要独立并发更新、revision 或 CAS；
- 数据拥有独立 retry、claim、recovery 或 reconciliation；
- 一对多集合会持续增长，需要独立分页、索引或 retention；
- 数据拥有独立 authority、权限或 secret boundary。

未命中以上条件时，优先合入 owning aggregate。历史配置、admission context、transition 和外部结果可以使用 bounded、versioned、runtime-validated JSON snapshot/receipt。

snapshot/receipt 必须满足：

- 写入后不可独立修改；
- 声明 schema/version、大小上限和运行时校验；
- 能指出生成它的 authority 和写入时机；
- 不形成第二个 current-state 写入口；
- derived copy 必须声明 rebuild/reconciliation 方向。

## 持久化类型判定：Event / projection / object

新增持久化结构时，先判断需求属于 Event-only、index/projection 还是 durable object/state。只有语义本身已经是 canonical Event fact 时，才优先判断能否保持 Event-only；配置、授权、运行协调或独立生命周期不能为了少建表而强行 Event 化。查询性能问题先考虑 physical SQL index，不能直接作为新增 materialized projection table 的理由。

| 模型 | 何时使用 | 持久化约束 | 与 Event 的关系 |
|---|---|---|---|
| Event-only | 只记录已经发生的事实，Event causality 足以表达语义，读取时可以有界投影 | 只追加 immutable canonical Event；不为展示复制 mutable 状态表 | Event 是事实源；application query 可以临时组合 read model |
| Index / projection | 需要跨多个事实形成稳定产品视图、保存幂等 transition/recovery，或无法在每次操作时重放事实 | 声明稳定键、来源、写入触发、事务边界、rebuild 和冲突处理 | 指向或派生自 Event/object，不成为第二份内容事实源 |
| Durable object / state | 数据拥有独立 identity、配置、授权或生命周期，即使没有对应 Event 也成立 | owner 对完整性和迁移负责；明确 current state、snapshot/history 和引用约束 | Event 可以记录或触发变化，但对象不要求完全由 Event 重建 |
| Physical SQL index | 已有表的筛选、排序、唯一性或 claim 路径需要数据库支持 | 不创建业务 identity 或可读取 row；表达式与 partial predicate 必须匹配查询 | 只加速或约束已有事实 |

判定时遵守以下规则：

- 不因为 Console 需要列表就新增 Event type 或 projection table；优先使用 bounded application read model。
- 若运行正确性依赖原子 transition、claim、retry、去重、外部 receipt 或恢复，应建立 durable work/state，并声明与 Event admission 的事务边界。
- projection 若混入 read/ack、人工 resolution 或其他不可重建状态，必须逐列声明 authority；rebuild 只能覆盖 derived columns。
- JSON snapshot/receipt 不是无类型垃圾桶。每个字段必须有 schema/version、运行时校验和大小上限。
- 新结构由具体 domain、Capability 或 application view owner 持有；共用 SQLite 不使 Runtime 获得业务 ownership。

每次新增或实质修改表，至少登记 split reason、classification、主键/幂等键、owner、字段 authority、写入事务、rebuild/recovery、retention 和验证入口。判断顺序固定为：先识别唯一 mutable authority 和生命周期，再用拆表条件决定物理边界，最后选择 Event-only、projection、durable state 或 physical SQL index。

Event type、Route 与 causality 的完整清单由 [Event Reference](./event-reference.md) 维护。本页只登记数据库建模和物理表。

## Chat message projection 与 Notice Center

schema v43 的 Chat history 保持 Event-only；schema v44 因 Owner message 需要跨 attention receipt、`chat.dispatch` 与 Agent Execution 形成稳定的 per-Agent processing progress，增加 `chat_messages` rebuildable projection：

- `events` 中的 `chat.message` 仍唯一拥有 Topic、sender、body、`targets[]`、可选 `replyToEventId`、causality 与产品时间；历史单数 `target` 在 codec 边界归一化，`chat_messages` 没有独立修改入口。
- projection 以 `event_id` 为稳定键，复制 timeline 所需 snapshot，并用 `ChatAttentionReceiptList@1` 固定该消息处理时的 active Agent 分母。suspended Agent 不进入分母；后续新增、suspend、resume 或 rename 不改历史 snapshot。
- `ChatReadProgress@1` 只解释 Runtime processing：每个目标 Agent 的 Execution `succeeded` 为 `read`，queued/running/retry 为 `reading`，terminal failure 为 `failed`，非目标或 presence/policy skip 为 `unread`。多目标 Execution 彼此隔离；reply 与 silent 都在各自 Execution 成功后计入 read。
- `chat_messages_topic_cursor(topic_id, created_at DESC, event_id DESC)` 服务 Timeline；`events_chat_topic_cursor` 继续支持 canonical Event 诊断查询。
- Event admission、attention receipt 与 Execution transition 通过 trigger/同一 SQLite transaction 增量更新 projection。`LocalChatStore.rebuildProjection()` 可以先清空 projection，再从 Event、Execution receipt 和 dispatch Execution 完整重建并核对 row count。
- `projected_at` 只诊断 freshness，不成为 cursor 或产品时间 authority。

这里的 read 不是 Telegram/飞书意义上的“用户看过”。v0.3.11 明确不承载 Owner/成员 read cursor、unread inbox、手工 mark-read 或 `chat_read_receipts`；未来若增加 per-user read label，该状态拥有独立用户、游标和生命周期，必须另建 authoritative Chat state，不能写回 Event 或复用 `ChatReadProgress@1`。

Notice Center 需要独立物理表，因为 Notice 除了 Delivery/Event 派生摘要，还拥有不能从事实重建的 read/ack。schema v44 延续两类 authority 放在同一张 `notices` 表：

- `title`、`summary`、`outcome`、Delivery 状态和 reference/time 字段是 derived projection。
- `read_at`、`acknowledged_at`、`state_updated_at` 是 authoritative user state。
- Delivery trigger 或显式 rebuild 只 upsert derived columns；不能覆盖用户状态。

因此 `chat_messages` 可以整表删除重建，而 `notices` 不能丢弃 read/ack 后整表重建。两者都提供独立视图，但只有 Notice 同时拥有不可重建的用户状态。

## schema v72：32 张物理表

| Table | Classification / owner | 主键与职责 |
|---|---|---|
| `schema_meta` | schema composition / `infrastructure/sqlite/local-schema` | `key`；保存组合 schema version。 |
| `local_foundation` | durable singleton / Foundation | `singleton=1`；保存 Device、Workspace、Local Topic 与嵌入的 Owner identity。 |
| `agents` | durable object / Foundation | `principal_id`；保存 Agent identity、client/config 和 current Session pointer。 |
| `topic_governance` | durable current object / Topic governance | `topic_id`；保存 Topic status、participant roster、strategy/conversation policy 和 CAS revision。 |
| `topic_governance_control_receipts` | immutable audit child / Topic governance | `receipt_id`；按 `(topic_id, resulting_revision)` 保存 bounded、versioned control receipt。 |
| `free_chat_modes` | inert historical object / retired Free Chat | `mode_id`；保留旧 mode snapshot；schema v70 将 active row 恰好一次转为 `stopped`，之后无 runtime writer。 |
| `free_chat_mode_receipts` | immutable historical audit / retired Free Chat | `receipt_id`；保留旧 receipt，并为每个升级时 active mode 追加一条 `feature_retired` stop receipt。 |
| `topic_activation_schedules` | durable current object / Topic scheduled activation | `schedule_id`；保存 once/cron intent schedule、next occurrence、candidate policy 与 CAS revision。 |
| `topic_activation_schedule_receipts` | immutable audit child / Topic scheduled activation | `receipt_id`；按 `(schedule_id, sequence)` 与唯一 occurrence key 保存 control/admission/skip/failure receipt。 |
| `interactive_channel_bindings` | durable authority object / Interactive Channel | `binding_id`；保存 exact Agent、channel allowlist、expiry、可选 callback Session 与 CAS revision。 |
| `channel_send_receipts` | durable idempotent side-effect receipt / Interactive Channel | `send_id`；按 `(binding_id, idempotency_key)` 保存固定请求、transport transaction、cursor 与 follow token。 |
| `channel_follows` | durable follow/callback state / Interactive Channel | `follow_token`；每个 send 唯一，保存 cursor、condition、deadline、callback state 与 CAS revision。 |
| `agent_sessions` | durable continuity / Runtime | `session_id`；保存 adapter/provider Session、workspace binding 与可选 Agent Run/cycle binding。 |
| `events` | immutable Event / `core/event` | `event_id`；保存六种 canonical Event、causality、typed payload 和 Destination snapshots。 |
| `executions` | durable work / `core/runtime` | `execution_id`；保存 Handler claim/retry/终态与 bounded versioned receipt。 |
| `agent_runs` | Steward durable coordination object / `application/steward` | `run_id`；保存可选 series key/active cycle、mandate/workflow snapshot、orchestration/source binding、current step/checkpoint、budget、CAS、cancel、terminal outcome 与可逆 archive visibility。 |
| `agent_run_cycles` | durable revision child / `application/steward` | `cycle_id`；按 `(run_id, source_revision)` 唯一保存 series revision 的 mandate/workspace snapshot、source occurrence envelope、step lifecycle、status 与 terminal summary。 |
| `agent_run_decisions` | immutable audit/idempotency child / `application/steward` | `(run_id, request_id)`；保存 Caller 的严格 `RunDecision@1`、原子接受 receipt 与 resulting Run version；不拥有 current Run state。 |
| `legacy_trigger_migration_receipts` | immutable migration receipt / `application/steward` | `(source_kind, source_id, definition_revision)`；在迁移 transaction 内固定 exact legacy source、proposal/admission digest 与 replacement Run，支持不依赖当前 Agent/plugin/workspace 状态的幂等 replay。 |
| `chat_messages` | rebuildable projection / `application/chat` | `event_id`；保存 Timeline snapshot、attention denominator 与 Agent Execution-driven read progress，不拥有消息或用户 read state。 |
| `deliveries` | durable work / `core/runtime` | `delivery_id`；保存 Event 或 host origin 发起的一次投递、bounded payload、Destination snapshot、retry 与外部 receipt。 |
| `chat_presence` | durable policy / `core/chat` | `(agent_id, scope_kind, scope_id)`；保存 scoped available/snoozed 状态。 |
| `subscriptions` | durable object / Subscription | `subscription_id`；保存严格 V3 legacy callback、V4 Run binding 或 V5 unified target、probe policy、terminal observation、对应 receipt、reconcile summary 与可逆 archive visibility。 |
| `continuous_subscriptions` | durable object / Continuous Subscription | `subscription_id`；保存严格 V1 legacy callback、V2 Run binding 或 V3 unified target、probe policy、长期 poll lifecycle、pending observation、target receipt、source-owned checkpoint 与可逆 archive visibility。 |
| `proactive_callback_definitions` | immutable durable child / legacy Schedule、one-shot/Continuous Subscription | `definition_id`；按 owner revision 与 ordinal 保存共享 callback definition 和 exact grant snapshot。 |
| `proactive_callback_occurrences` | durable work occurrence / legacy Schedule、one-shot/Continuous Subscription | `occurrence_id`；按 trigger occurrence 与 ordinal 保存 started/terminal transition、Agent Event、bounded receipt 与 crash-unknown。 |
| `deterministic_action_receipts` | immutable terminal receipt / proactive source owner | `receipt_id`；按 `(source_kind, source_id, occurrence_key)` 唯一保存 target digest、versioned action ref、succeeded/skipped/failed 与 bounded receipt。 |
| `external_workflow_executions` | durable external work / proactive runtime | `execution_id`；按 `(source_kind, source_id, occurrence_key)` 唯一保存 fixed workflow target/observation、attempt、lease、effect boundary、terminal/unknown runtime receipt 与 manual resolution receipt。 |
| `proactive_source_migration_receipts` | immutable migration receipt / proactive application | `receipt_id`；按稳定 `request_id` 唯一固定 legacy Schedule old revision/digest 与新 external workflow target/source revision。 |
| `schedules` | durable current object / Scheduled Task | `schedule_id`；保存 V1 legacy callback、V2 Run binding 或 V3 unified target、current revision、可选 fixed ExternalRef trigger binding、next occurrence 与可逆 archive visibility。 |
| `scheduled_runs` | durable ScheduleOccurrence / Scheduled Task | `run_id`；保存 occurrence lifecycle、bounded immutable definition snapshot，以及 Run target 的 cycle/admission link；action 或 external workflow receipt 由对应独立表持有。 |
| `notices` | projection + authoritative state / `application/notice` | `notice_id`；保存 derived Notice snapshot 与 read/ack。 |

### Foundation 与 Agent continuity

`local_foundation` 嵌入唯一 Owner，因为 Local Runtime 没有独立 Principal roster 控制面。`agents` 合并旧 Agent principal、profile 与 current-session pointer；`agent_sessions` 保持独立，因为它是会持续增长的 provider continuity history。

`agents.current_session_id` 只表示 Chat/普通 Agent request 的 current pointer，`agent_sessions` row 才是 Session identity。一个 Session 可以跨多次 Execution 使用，不能与 `executions` 合并。普通 run-scoped Session 由 partial unique index 保证同一个 `(run_id, agent_id)` 只有一个；series Run 则保证 `(run_id, cycle_id, agent_id)` 唯一，使新 revision 隔离 Session、同 revision 续用。它们都不写回 `agents.current_session_id`，也不与 Chat Session 共用。

### Topic governance current state 与 control receipt

`topic_governance` 是 Topic application vertical 拥有的 durable current object，不替代 canonical Chat Event history，也不把 Server membership、Agent lifecycle、Session 或 history grant 合并进 participant roster。`status`、participant roster、strategy policy、conversation policy 与 `revision` 是同一个 mutable aggregate；participants、themes 和 policy 使用 bounded、runtime-validated JSON，避免为没有独立生命周期的字段组拆表。首次 materialize 固化当时 active Local Agents；后续 Agent add/suspend/resume 不重写 roster。

Chat admission snapshot 作为 `chat.dispatch` canonical Event payload 的 bounded scalar revision 保存，不复制 governance aggregate。claim-time rejection 使用既有 Execution `cancelled` terminal state、`last_error` 和 `RuntimeExecutionSkipReceipt@1`；`chat_message_read_progress_v1` 是可重建 projection，将 cancelled dispatch 映射为带原因的 `unread`。因此 slice 2 不增加 table 或 schema version；current-schema open 会按既有 projection rebuild seam 重建 view/trigger。

每次治理 mutation 使用 expected revision，在一个 `BEGIN IMMEDIATE` transaction 内 CAS 更新 `topic_governance` 并追加一条 `TopicGovernanceControlReceipt@1`。receipt 独立成表，因为审计记录持续增长且写入后不可变；它只保存 action、actor、前后 revision、changed fields 与时间，不复制 current snapshot，也不成为第二个控制入口。`topic_governance_receipts_topic_revision` 支持按 Topic 读取最近 receipt。当前没有 Topic deletion/receipt retention 或 Event rebuild 入口；Runtime restart 直接恢复 current object，receipt 只用于审计。

`free_chat_modes` 与 `free_chat_mode_receipts` 自 schema v70 起只是历史审计表。升级在一个 transaction 内把每个 active row CAS 为 `stopped`、保留原 state fields、增加 `stopReason=feature_retired`，并按原 sequence 追加唯一 `FreeChatModeReceipt@1`；同一 helper 重入不会再改 revision 或追加 receipt。迁移同时将 `manual`、`starter` 或旧 Free Chat root 下的 queued/retry/running Execution 终止为 `cancelled`，不删除 Event、mode 或 receipt。当前源码没有 Store、control/query、API/CLI/UI 或 loop phase 可继续写这两张表。

### Topic activation schedule 与 occurrence receipt

`topic_activation_schedules` 是 Topic application vertical 的 current object，不复用 `schedules`/`scheduled_runs`。它只允许 once/cron time、misfire、candidate、conversation intent 与 turn budget，不接受 arbitrary prompt、Session policy 或 shared proactive callback。`state_json` 是 bounded、runtime-validated aggregate snapshot；`status/revision/next_run_at/next_occurrence_key` 是索引与 CAS 所需 scalar authority。

control mutation 与 `TopicActivationScheduleReceipt@1` 在一个 `BEGIN IMMEDIATE` transaction 内提交。到期处理以 `(schedule_id, occurrence_key)` 唯一：schedule advance、`occurrence_admitted` receipt 与 canonical `chat.activation` admission 共用同一 database transaction；skip/failure 同样先形成 durable receipt 再推进。misfire、paused Topic、空 eligible roster 与 active-root overlap 不建立 backlog，cron 只保留下一个未来 occurrence。`topic_activation_schedule_receipts` 独立是因为 occurrence audit 持续增长且 immutable；它不拥有 current definition 或第二个 activation 入口。

### Interactive Channel binding、send 与 follow

`interactive_channel_bindings` 是 exact Agent authority object；allowlist、expiry、可选 owned `ses_*` callback 与 revision 属于同一 bounded `InteractiveChannelBinding@1` snapshot。Agent lifecycle、Local Chat Topic、Server membership、credential 与 Session identity 仍由各自 owner 掌握，binding 在 bind/send/callback admission 时只验证和引用，不复制它们。

`channel_send_receipts` 命中独立外部 side-effect/idempotency 生命周期。第一次 send admission 固定 binding revision、sender Agent、Channel ref、body fingerprint、stable transport transaction、observed cursor 与 follow token；同一 `(binding_id, idempotency_key)` 只能返回同一请求，payload 冲突 fail closed。Local send 通过 canonical Chat admission settle；Server send 需要 Agent credential 与 Topic membership，并通过同一 transaction ID 恢复 pending 请求。receipt 保留 bounded body/reference 与外部 message ID，不成为 Local/Server message history authority。

`channel_follows` 每个 send 恰好一条，以 stable token 保存 after/current cursor、condition、quiet/deadline、terminal reason 和 callback state。Local follow 可以基于 canonical conversation root 判定相关 reply/terminal；Server inbox 缺少 correlation 时只能推进为“new messages”，不能宣称 `first_reply` 或 `terminal`。callback 只引用 binding 固定、同 Agent owned 的 durable Session；Session busy 时保持 pending，idle 后以 stable external ID admission canonical `agent.request`。stop、binding revoke/expiry 或 ownership drift 都以 CAS 收敛，不建立任意客户端 callback。

### Shared proactive callback definition 与 occurrence

两张 `proactive_callback_*` 表承载 Schedule、one-shot Subscription 与 Continuous Subscription 共用的执行 contract，但不拥有 trigger parent 状态机。definition 命中独立 revision snapshot；occurrence 命中独立 claim、receipt 和 recovery，因此分别作为 immutable durable child 与 durable work occurrence。owner 仍是具体 Schedule 或 Subscription，shared store 只按 `owner_kind + owner_id + owner_revision` 注册 definition，并按 `owner_kind + owner_id + trigger_occurrence_key` 幂等 materialize occurrence。

definition/grant 使用严格的 `ProactiveCallbackDefinition@1` / `ProactiveCallbackGrant@1`，只允许 `agent.invoke`、bounded `command.exec` 与 `destination.deliver`，JSON 上限均为 64 KiB。Node `command.exec` 用 permission model 将文件读写限制在 exact `filesystemRoots`，禁止通过环境注入 Node/动态链接选项；Node 当前不能隔离网络，因此 grant 必须如实声明 `networkAccess: true`。`destination.deliver` 不直接调用 integration adapter，而是在同一 SQLite transaction 内建立 host-origin Core Delivery；Core Delivery 状态机拥有 claim、retry 与 adapter receipt，callback occurrence 只引用其 admission/terminal receipt。Schedule/Continuous 的 Agent callback 通过 Core 建立 `agent.request` Event，one-shot Subscription 则建立携带 terminal observation 与 exact invocation authority 的 `subscription.fire` Event。未形成 durable Core work 的 started callback 遇到进程中断时，该项与同 trigger occurrence 的剩余 pending 项转为 `unknown`；已经形成 Delivery 或 Agent Execution 的 occurrence随 Core recovery 继续 reconcile，不重复外发。terminal occurrence 保留用于审计；当前不提供独立删除或 retention 入口。

`subscriptions` 只保存 callback phase summary，不复制 child lifecycle。terminal observation 与 shared occurrence 在同一 transaction 写入；全部 occurrence terminal 后，parent 按优先级投影为 `completed_with_unknown | blocked | completed_with_errors | completed`。structured `SubscriptionAgentResult@1` 会被 owner adapter 解释为 `succeeded | blocked | failed`，不能只按 provider 进程退出码判定。

`continuous_subscriptions` 是独立 parent durable object，不复用 one-shot `subscriptions` 的 terminal/deadline 状态机。`checkpoint_occurrence_key` 与 checkpoint observation 是已完成 callback group 的 authority；`pending_occurrence_key` 与 pending observation 在 materialize callback occurrence 的同一 transaction 写入。pending 存在时停止 poll；callback 全部 terminal 后才 checkpoint、清除 pending、计算下一 poll，并保持 active。相同 stable occurrence key 是 no-delta，只推进下一 poll 且不再 materialize callback。unknown 也作为不可重放的 terminal receipt checkpoint，并在 `latest_error` 留下诊断。

### Event、Execution 与 receipt

`events` 是 immutable facts，`executions` 是 mutable retry/recovery state，二者不能合并。schema v53 曾在既有 17 张表上增加 `chat.activation` Event constraint；activation 的策略、candidate snapshot、expiry 与 turn budget 都属于 immutable Event payload，不新增物理表。Chat attention receipt 列表和 Chat decision receipt 迁入对应 `executions.receipt_json`：

- `ChatAttentionReceiptList@1` 属于 `chat.message` 或 `chat.activation` 的 Chat Execution；
- `ChatDecisionReceipt@1 | @2` 属于 `chat.dispatch` 的 Agent Execution；`@2` 只在 `speechAction=propose_run` 时携带严格 `ChatRunProposalDraft@1`。

receipt 写入必须经过对应 versioned runtime parser，当前列上限为 64 KiB。新增 Handler receipt 需要定义独立 schema，不能复用任意 JSON。

Chat-to-Run proposal 不增加物理表或 schema migration。每个 proposal 的 immutable fact 保存在对应 `chat.dispatch` Agent Execution 的 `ChatDecisionReceipt@2`；Owner 拒绝则追加一个携带 `ChatRunProposalDecision@1` 的 immutable system `chat.message`，以 `chat-run-proposal-decision:<sourceMessageEventId>:<dispatchEventId>` 保证逐 proposal 幂等，且不创建 Chat Execution。`application/chat` 只对 exact Owner source message + dispatch 做可重建投影。Owner 确认后，既有 `agent_runs.owner_request_id='chat-work:' || sourceMessageEventId || ':' || dispatchEventId` 是唯一 association authority；started、needs-human 与 terminal summary 都从该 row 读取，不能复制回 Chat receipt、`chat_messages` 或新的 reconcile state。

Agent provider 调用的可观测信息使用 `AgentInvocationReceipt@1`，保存 exact effective prompt、调用时间与 provider 实际报告的 token/turn/tool usage；provider 没有报告的字段必须保持 absent，不能伪装成 `0`。Chat 的 Agent Execution 因为同一列已经承载 decision receipt，把同一 `AgentInvocationDiagnostics@1` 嵌入 `ChatDecisionReceipt@1.invocation`。运行中的流式调用以 `AgentInvocationProgressReceipt@1` 覆盖同一 Execution receipt，最多按固定频率保存 Session reference、阶段、最后 meaningful 时间、计数和最后进度种类；失败时由 `AgentInvocationFailureReceipt@1` 取代，追加 termination reason、total/idle budget、协议终止状态与 recovery disposition。两者都禁止保存 raw assistant/thought/tool payload。它们是 bounded execution diagnosis，不是新的 Event fact，也不建立 invocation 表；restart 不从 progress receipt 恢复正在运行的 provider work，仍按 interrupted unknown 语义终止。

只读 Agent Run 的失败 receipt 可以保存尚未进入 `agent_sessions` 的 provider Session reference；只有后续 `AgentTurnAdjudication@1` 明确选择有证据的 `retry` 时，Runtime 才校验 exact agent/run/cycle/adapter/workspace 并把该 reference 提升为 durable Session。write-capable failure 固定为 `unknown_outcome_no_replay`，不得创建恢复 Session 或自动重放。promotion 与 retry Event admission 处于同一个 Runtime/Steward transaction；不增加新表、index 或 projection，也没有从 Event 重建 Session 的路径。

Agent Run 的 `AgentTurnResult@1` 与 `AgentStepResult@1` 是 encoded in `agent.result.output` 的 bounded、versioned module contract；Core 将 output 作为不透明字符串保存，不再把解析结果复制进 `events.payload_json`。注册的 Agent Run continuation 按 `resultContractId` strict parse。`AgentStepCompletion@1` 保存于 autonomous callback `agent.request` 的 run context，`AgentRunContinuationReceipt@1` 保存于对应 ResultHandler Execution receipt；workflow-specific finding、role 或 transcript 不复制进 `executions` 或 `agent_runs`。

同一 immutable output 的 contract validation failure 不是 retryable work。autonomous continuation 将 Run terminalize 为 `failed`，并在 ResultHandler Execution 写 bounded `invalid_result` diagnosis；caller continuation 把 provider failure 或 malformed output 归一成 failed checkpoint，交由 Owner decision 收口。两者都不重试解析，也不建立第二份结果事实源。

### Agent Run lifecycle

`agent_runs` 命中独立 identity、cancel、CAS/recovery、budget 和 external workspace write exclusion，因此不能塞进 Event 或 Execution receipt。`run_id` 绑定 root `agent.request`；`active_step_id`、`active_execution_id` 与 `version` 共同守住 restart/duplicate continuation。status 另含 `awaiting_source`：series cycle terminal 后 Run 保持可续接，只有 source close 或人工取消才终态。

`archived_at` 是 terminal Run 上独立、可逆的 Owner visibility state：默认列表排除 archived，显式 archived query 仍可读取，按 ID inspect/trace、Event、Execution、Session、cycle、decision、output 与 progress evidence 都不删除。archive/unarchive 不改 `status`、`updated_at` 或 Run CAS `version`；非 terminal Run fail closed，避免隐藏仍需执行、source close 或人工决策的工作。

Schedule、one-shot Subscription 与 Continuous Subscription 复用同一 visibility 语义，但字段仍由各自 owning table 持有。Schedule 只允许 `completed | cancelled` 归档；one-shot Subscription 只允许 `completed | blocked | cancelled | expired`；Continuous Subscription 只允许 `cancelled`。archive/unarchive 只改 `archived_at`，不改 lifecycle、`updated_at`、revision、next occurrence、poll checkpoint、callback 或 run history。Console 的三类列表以 `(updated_at DESC, id DESC)` 做稳定服务端分页，搜索只覆盖对象 identity、标题/mandate、owner/steward、status 和短定义字段，不扫描 prompt、Plugin config、output 或 trace。

`agent_run_cycles` 独立成表，因为 revision cycle 有自己的 identity、Session scope、step counter、terminal summary 和可增长历史，而 Run current row 只保存 active cycle pointer。cycle creation 与 Run activation 同 transaction；result continuation 同 transaction terminalize cycle 并把 Run 转为 `awaiting_source`。cycle 不从 Event 重建，永久随 Run 保留供 inspect/trace；`request_id` 表示创建该 cycle 的首次 admission，后续同 revision invocation 仍由 immutable Event/Execution 记录。

`orchestration_mode` 是 Run admission 后不可变的 `autonomous | caller`。Caller mode 固定 bounded `OrchestratorBinding@1 | @2 | @3`、冻结 admitted participant roster、关闭 Worker delegate，并在 Worker 返回严格 `AgentStepResult@1` 后把 bounded `AgentRunCheckpoint@1` 写入 owning `agent_runs` current row；此时 Run 非 terminal，且不保留 active Worker Execution。`@1` 由 manual Owner 提交 `RunDecision@1`；`@2` 由固定 Codex Orchestrator 的 run-scoped Session 提交含完整 bounded `OrchestratorState@1` 的 `RunDecision@2`；`@3` 另外固定 admission digest 与 authority ceiling，允许单一 `await_source` binding、source cycle 和显式 `finish(scope=cycle | run)`。失败时仍允许 manual `@1` fallback。`agent_run_decisions` 独立成表是因为审计与幂等记录持续增长且 immutable；同一 `(run_id, request_id)` 只可重放完全相同的 decision，current-version decision、下一 Event/Execution 或 terminal transition 与 versioned `AgentRunDecisionReceipt` 在同一 transaction 提交。

`agent_runs.source_binding_json` 是 Run current aggregate 内的 bounded `RunSourceBinding@1`，只能把 standalone `OrchestratorBinding@3` Run 单向提升为 single-source series；它引用 source owner 的 exact definition revision，但不复制 Schedule/Subscription 状态机。`agent_run_cycles.source_envelope_json` 是 cycle admission 时写入后不可独立修改的 bounded `TriggerOccurrenceEnvelope@1`。source occurrence Event、cycle row 和 Run `awaiting_orchestrator` CAS 必须在同一个 application transaction 内创建；`(run_id, occurrenceKey)` expression index与 `(run_id, source_revision)` constraint共同阻止重复唤醒。restart 直接恢复 Run/cycle/Event/Execution，不从时间或 transcript 重建 envelope。

`mandate_snapshot_json` 是 bounded、versioned `RunMandateSnapshot@1`：保存内联 objective，或 workflow ID/version、validated inputs、rendered instruction snapshot 与 workflow 可选声明的 bounded `AgentInvocationBudget@1`。该 per-turn total timeout 随每个 workflow turn 进入 immutable `AgentRunContext@1`；adapter 只校验并执行 `1..900000ms` 上下界。workflow 未声明时不存在绝对 invocation deadline，provider adapter 的默认 `timeoutMilliseconds` 只作为 meaningful-idle budget，持续 thought/tool/assistant/plan update 会续期。可选 `workspace_grant_json` 保存 Owner admission 的 canonical external root、`read | write` 与初始 revision；它不是 Agent 自行修改的配置。Run deadline、max steps、max depth 和 step count 仍是 Run current state，不与单次 provider total timeout 混用。

autonomous `agent.request.prompt` 保存该 turn 的 active delegate roster 和 exact `AgentTurnResult@1` shape；caller admission 则把 participant roster 固定在 mandate，Worker prompt 使用 `AgentStepResult@1` 且不提供 delegate authority。Event prompt snapshot 不建立 Agent membership 表。Store 读取 mandate/workspace JSON 时必须重新校验 schemaVersion、exact fields、类型与大小，不能只依赖 `json_valid` 或 TypeScript cast。

Run transcript 不复制到 JSON 或 `agent_run_steps`：所有 request、result 和 callback 都在 `events/executions` 中共享 `runId`，并用 `stepId/parentStepId` 还原调用链。每次 continuation 在同一 transaction 内完成 ResultHandler Execution、更新 Run CAS，并建立最多一个 child/callback Event 与 Execution。deterministic continuation key 保证 retry、duplicate result 和 restart 不重复 admission。

跨 owner transaction 不等于复制 ownership：bootstrap/application unit of work 把同一 `DatabaseSync` transaction 交给 RuntimeStore 与 AgentRunStore；RuntimeStore 仍唯一写 Event/Execution/Session，AgentRunStore 只写 `agent_runs`、`agent_run_decisions` 和 Run-specific constraint。AgentRunStore 不复制 Event mapper、Execution claim/retry 或 child admission SQL，RuntimeStore 也不增加 `agent_runs` column/transition 方法。

相同 canonical external workspace 可以并行多个 read Run，但 partial unique index只允许一个 non-terminal write Run。cancel 原子写入 terminal state并取消 queued Execution；已经 running 的 provider result可以写入审计 Event，但 trigger/ResultHandler 在读取 cancelled Run 后不得创建 retry、child 或 callback。

### Destination snapshot 与 Delivery

schema v43 不建立 `destinations` 表。当前产品没有独立 Destination 管理面或生命周期；保留可变 Destination object 只会制造无主配置。

Event admission 把每个 Destination 的 `destinationId/kind/address/createdAt/updatedAt` 固定到 `events.destination_snapshots_json`。ResultHandler 从 parent/result Event snapshot 建立 event-origin Delivery；host callback 使用 opaque stable origin 建立 host-origin Delivery。两条路径都把 `kind/address` 和 bounded payload 固定到 `deliveries`，并使用 `(origin_kind, origin_id, destination_id)` 幂等。因此重启、retry 与历史查询不依赖进程内 cache，也不会被后续同 ID 的配置变化改写。

如果未来出现可独立增删、授权、轮换或被多条未入队工作引用的 Destination 控制面，届时再以真实生命周期重新建立对象表。

### Schedule 与 ScheduleOccurrence

`schedules` 只保存 current definition。V1 legacy callback 与 V2 Run binding 保持历史兼容；current `ScheduleRevision@3` 清空旧 execution authority/source-binding columns，并在 `target_json` 保存严格 `ProactiveTarget@1`。Run target 内的 source ID/revision 必须与 owning Schedule/current revision 一致；`schedules_target_run` 保证一个 Run 最多绑定一个 current Schedule。

`scheduled_runs` 是兼容表名，application 主模型为 `ScheduleOccurrence`。`definition_snapshot_json` 保存实际 occurrence 使用的 `ScheduleDefinitionSnapshot@1 | @2 | @3`，当前上限 128 KiB。V3 Run target row 保存 `agent_run_id`、唯一 `cycle_id` 与严格 admission receipt；V3 action target 不保存 Agent/Event/Execution/Session/cycle link，而由 `(schedule, occurrenceKey)` 关联共享 deterministic receipt；V3 external workflow target 同样不保存 Agent link，source transaction 只 enqueue 对应 `external_workflow_executions` row，terminal state 由后续 loop phase 投影回来。

这避免为了未发生的配置版本维护独立 revision 表，同时保证已经 admission 的 occurrence 在 Schedule 修改后仍能准确恢复。需要完整 Schedule 配置审计历史时，应先证明产品查询与 retention 需求，再重新引入 revision log。

### Subscription 与 bound occurrence

`subscriptions.definition_schema` 严格区分 V3 legacy callback、V4 Run binding 与 current `SubscriptionDefinition@5` unified target。V5 Run target 保存 bound `agent_run_id`，terminal observation 后保存唯一 cycle/admission receipt；V5 action target 禁止这些 Run columns，并从共享 receipt 表读取 terminal action fact。

`continuous_subscriptions.definition_schema` 同样区分 V1 legacy callback、V2 Run binding 与 current V3 unified target。V3 Run target 延续 pending cycle 语义；V3 action target 在 observation transaction 内同步写 terminal receipt，succeeded/skipped 前移 checkpoint，failed 保留 pending 并 block。`continuous_subscriptions_bound_run` 保证一个 Run 最多绑定一个 Continuous Subscription。

`deterministic_action_receipts` 是 append-only terminal fact，不是 retry queue。receipt ID 由 exact source definition 与 occurrence key 决定，row 同时固定 target digest、action ref 与完整 bounded receipt。handler 只能在 owning `DatabaseSync` transaction 内同步运行；SAVEPOINT 让 handler 异常回滚其业务 mutation，而外层 source transaction仍能保存 failed receipt。任何网络、进程、文件或 Agent side effect 都不在该 exactly-once 边界内，因此 registry contract 明确禁止这类 handler。

`external_workflow_executions` 是独立 retry/lease state machine，因为外部进程、Git 与网络无法放入 source SQLite transaction。execution ID 由 exact source identity 与 occurrence key 决定；target digest、workflow ref、registration digest 与 observation 在 enqueue 时冻结。`claimed/running` 必须同时持有 owner/token/expiry，spawn 前写 `effect_started_at`；pre-effect interruption 可以回到 `retry_wait`，post-effect interruption只能写带 error 的 unknown runtime receipt。manual resolution 追加独立 receipt 并保留原 unknown receipt，不能把未知历史覆盖成仿佛 Runtime 直接成功。

`proactive_source_migration_receipts` 只记录 Owner 显式迁移，不是通用 revision log。它与 paused legacy Schedule 的 V1→V3 current-row rebuild 同事务写入；重复 request ID 只有在 schedule/ref/from-revision 全部一致时返回原 receipt。

历史 V4/V2 与 current V5/V3 的 Run-target occurrence 均在 source owner transaction 内写 `TriggerOccurrenceEnvelope@1`、Run cycle、orchestrator Event/Execution 与本地 admission receipt；重复 occurrence 返回已有 cycle。V3/V1 callback rows 保留 readback/reconcile，但 discriminator 禁止 Run-target generation materialize proactive callback。

### Notice authority

`notices` 使用稳定 `ntc1_<delivery_id>`，并以 `(source_kind, source_id)` 幂等。当前只投影 `macos-notification + agent.result`。

Delivery insert/update trigger 定向 upsert derived columns。显式 rebuild 从 `events + deliveries` 重投全部来源，但保留 `read_at`、`acknowledged_at` 与 `state_updated_at`。ack 必须同时保证 read；不能删除整表后重建，也不能把 user state 当缓存。

## 当前 named SQL indexes

| Index | Table | 职责 |
|---|---|---|
| `events_causal` | `events` | 按 root、hop、created time 读取 causality。 |
| `events_chat_topic_cursor` | `events` | 按 Topic 与 `(created_at, event_id)` 稳定分页 Chat history。 |
| `executions_due` | `executions` | claim queued/retry-wait Handler work。 |
| `agent_runs_status_updated` | `agent_runs` | 按 status 与更新时间分页查询并行 Run。 |
| `agent_runs_archive_updated` | `agent_runs` | 按 archive visibility 与原始 Run 更新时间读取 current/archived 列表。 |
| `agent_runs_active_write_workspace` | `agent_runs` | 保证同一 canonical external workspace 最多一条 non-terminal write Run。 |
| `agent_run_cycles_run_created` | `agent_run_cycles` | 按 Run 与创建时间读取 cycle history。 |
| `agent_run_cycles_run_occurrence` | `agent_run_cycles` | 保证同一 source occurrence 在一个 Run 中最多激活一个 cycle。 |
| `agent_sessions_run_agent` | `agent_sessions` | 保证普通 Run 内每个 Agent 只有一个 run-scoped Session。 |
| `agent_sessions_run_cycle_agent` | `agent_sessions` | 保证 series cycle 内每个 Agent 只有一个 cycle-scoped Session。 |
| `chat_messages_topic_cursor` | `chat_messages` | 按 Topic 与 `(created_at, event_id)` 稳定分页 Chat Timeline。 |
| `deliveries_due` | `deliveries` | claim pending/retry-wait Delivery。 |
| `subscriptions_due` | `subscriptions` | 查询到期 Subscription。 |
| `subscriptions_archive_updated` | `subscriptions` | 按 archive visibility 与原始更新时间稳定分页 one-shot Subscription。 |
| `continuous_subscriptions_due` | `continuous_subscriptions` | 读取 active、无 pending 且已到期的长期观察。 |
| `continuous_subscriptions_archive_updated` | `continuous_subscriptions` | 按 archive visibility 与原始更新时间稳定分页 Continuous Subscription。 |
| `proactive_callback_definitions_owner` | `proactive_callback_definitions` | 按 owner revision 与 ordinal 读取 immutable callback list。 |
| `proactive_callback_occurrences_status` | `proactive_callback_occurrences` | 按 status、owner 与 occurrence 顺序 claim/reconcile callback。 |
| `schedules_due` | `schedules` | 查询到期 Schedule。 |
| `schedules_archive_updated` | `schedules` | 按 archive visibility 与原始更新时间稳定分页 Schedule。 |
| `schedules_bound_run` | `schedules` | 保证一个 Run 最多绑定一个 V2 Schedule。 |
| `schedules_target_run` | `schedules` | 保证一个 Run 最多绑定一个 current V3 Run target。 |
| `scheduled_runs_schedule`、`scheduled_runs_status` | `scheduled_runs` | 查询 run history 与 active/unknown state。 |
| `external_workflow_executions_due` | `external_workflow_executions` | 按 status 与 next attempt claim bounded external workflow work。 |
| `notices_timeline` | `notices` | 稳定读取 Notice Center timeline。 |
| `topic_governance_receipts_topic_revision` | `topic_governance_control_receipts` | 按 Topic 与 resulting revision 读取最近 control receipt。 |
| `topic_activation_schedules_due`、`topic_activation_schedules_topic` | `topic_activation_schedules` | 查询到期 Topic schedule，以及按 Topic/更新时间读取 current schedules。 |
| `interactive_channel_bindings_agent` | `interactive_channel_bindings` | 按 Agent、status 与更新时间读取 binding。 |
| `channel_follows_status_updated` | `channel_follows` | 按 status 与更新时间推进 follow/callback recovery。 |

## Legacy compatibility tables

旧 schema 58/59 可能包含 `release_candidate_runtime`、`release_candidates`、`release_candidate_messages`，以及旧 v59 的 `release_candidate_effects`。这些表不属于当前 v72 产品 schema，全新数据库和从 v57 升级的数据库不会创建它们；迁移只接受完整的历史三表或四表组合并原样保留，Local 没有 reader/writer，外部业务 dispatcher 自己持有高水位和业务账本。

## v44–v71 → v72 migration

v0.3.11 首次正式推广时使用 schema v44，因此 v44 是唯一历史基线；v44 之前和缺失 version 的产品数据库不再直接迁移。v44–v62 先走既有兼容链；v62→v63 在一个 `BEGIN IMMEDIATE` transaction 内重建 `agent_runs`，加入 series/active cycle，创建 `agent_run_cycles`，并为 `agent_sessions` 增加 cycle binding；v63→v64 原位为 Run 增加 nullable `archived_at`；v64→v65 原位为 `schedules`、`subscriptions` 与 `continuous_subscriptions` 增加 nullable `archived_at` 及查询 index；v65→v66 为 Run/cycle 增加 nullable source binding/occurrence envelope；v66→v67 重建 Schedule/occurrence 表，加入严格 V1/V2 Run binding；v67→v68 重建 one-shot/Continuous Subscription；v68→v69 增加 legacy trigger migration receipt；v69→v70 退役 synthetic Chat activation；v70→v71 重建 unified `ProactiveTarget@1` source constraints并增加 deterministic action receipt；v71→v72 重建 Schedule/occurrence constraints以接纳 external workflow target，并新增 durable execution 与 source migration receipt。旧 definition 原样保留，不生成虚假的 Run/cycle/workflow authority。所有升级先通过 live Runtime guard；检测到旧 Runtime 仍持有 loop 时拒绝原地迁移。

- 保留 canonical non-Review Event、对应 Execution/Delivery retry state、Session continuity、Agent Run、V3/V1 Subscription、Schedule、Notice read/ack，以及已有 callback receipt；旧 definition 不隐式转换为 Run-bound版本。
- `review.requested`、`review.decision`、`review` Execution 与 `reviews` aggregate 明确丢弃；新审查只作为 `review@1` workflow 运行在通用 Steward Run 上。
- v2 Subscription aggregate 及其 parent `subscription.fire` Event chain、Delivery/Notice projection 不迁移；`subscriptions` 只接受 `SubscriptionDefinition@3`，不再保存旧 callback/session/`fire_event_id` 列。v51 专用 `subscription_callbacks` row 不猜测性转换为 shared occurrence；已有 terminal v3 parent 若 callback phase 尚未结束，收敛为 `completed_with_unknown`。v44 Schedule current revision 仍幂等回填共享 proactive callback definition。
- `chat_messages` 不复制旧 projection，而是从 canonical `chat.message`、Execution receipt 与 dispatch state 重建，并核对 exact row count。
- v47/v48 旧 Delivery shape 映射为 event origin；v49/v50 Event/host origin、payload、retry、receipt 与 Destination snapshot 原样保留。
- v44–v52 重建和 v53 additive upgrade 都只为已经存在的固定 Local Topic materialize governance；没有 Foundation row 的 fresh schema 保持未 materialize，首次 governance access 或 Runtime start 才按当时 active Agents 固化默认 roster。
- migration 完成后执行 `PRAGMA foreign_key_check`；任一受支持 table shape 无法解释时整笔回滚。

## Change guidance

- 新增物理表必须登记 `split reason`，明确命中的独立生命周期、CAS、recovery、持续增长或 authority 条件；“更规范”“方便 join”“便于以后扩展”不构成拆表理由。
- 新增、删除或重命名表/named index，或改变主键、owner、字段 authority、snapshot/receipt schema、投影来源或 rebuild 规则时，同步本页与 `LOCAL_SCHEMA_VERSION`。
- 物理 schema 只能由 `sqlite/schema/` 创建；Store 可以执行 domain transaction，但不能私建业务表或维护平行 migration。
- migration 必须有 fresh schema exact-table 测试、上一正式版本 fixture migration、foreign-key check，以及所属 Store/Capability 行为测试。
- Event schema、Route 和因果链仍归 [Event Reference](./event-reference.md)，不要在本页复制 Event 字段注册表。
