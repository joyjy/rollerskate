---
type: Reference
title: Rollerskate Local Database Reference
description: Local SQLite 的 Event / index / object 建模规范，以及 schema v44 的 15 张物理表、ownership、authority 与迁移规则。
tags: [rollerskate, local, sqlite, database, schema]
timestamp: 2026-07-26
---

# Rollerskate Local Database Reference

[返回 architecture index](./index.md)

`local/src/infrastructure/sqlite/local-schema.ts` 是 Local SQLite DDL、组合版本与兼容迁移的唯一事实源；`schema.ts` 只负责打开数据库并调用它，各 Store 不再各自创建业务表。schema v44 只有下文登记的 15 张产品表，不包含 SQLite 内部表。

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

- `events` 中的 `chat.message` 仍唯一拥有 Topic、sender、body、target、causality 与产品时间；`chat_messages` 没有独立修改入口。
- projection 以 `event_id` 为稳定键，复制 timeline 所需 snapshot，并用 `ChatAttentionReceiptList@1` 固定该消息处理时的 active Agent 分母。suspended Agent 不进入分母；后续新增、suspend、resume 或 rename 不改历史 snapshot。
- `ChatReadProgress@1` 只解释 Runtime processing：对应 Agent Execution `succeeded` 为 `read`，queued/running/retry 为 `reading`，terminal failure 为 `failed`，target/presence/policy skip 为 `unread`。reply 与 silent 都在 Execution 成功后计入 read。
- `chat_messages_topic_cursor(topic_id, created_at DESC, event_id DESC)` 服务 Timeline；`events_chat_topic_cursor` 继续支持 canonical Event 诊断查询。
- Event admission、attention receipt 与 Execution transition 通过 trigger/同一 SQLite transaction 增量更新 projection。`LocalChatStore.rebuildProjection()` 可以先清空 projection，再从 Event、Execution receipt 和 dispatch Execution 完整重建并核对 row count。
- `projected_at` 只诊断 freshness，不成为 cursor 或产品时间 authority。

这里的 read 不是 Telegram/飞书意义上的“用户看过”。v0.3.11 明确不承载 Owner/成员 read cursor、unread inbox、手工 mark-read 或 `chat_read_receipts`；未来若增加 per-user read label，该状态拥有独立用户、游标和生命周期，必须另建 authoritative Chat state，不能写回 Event 或复用 `ChatReadProgress@1`。

Notice Center 需要独立物理表，因为 Notice 除了 Delivery/Event 派生摘要，还拥有不能从事实重建的 read/ack。schema v44 延续两类 authority 放在同一张 `notices` 表：

- `title`、`summary`、`outcome`、Delivery 状态和 reference/time 字段是 derived projection。
- `read_at`、`acknowledged_at`、`state_updated_at` 是 authoritative user state。
- Delivery trigger 或显式 rebuild 只 upsert derived columns；不能覆盖用户状态。

因此 `chat_messages` 可以整表删除重建，而 `notices` 不能丢弃 read/ack 后整表重建。两者都提供独立视图，但只有 Notice 同时拥有不可重建的用户状态。

## schema v44：15 张物理表

| Table | Classification / owner | 主键与职责 |
|---|---|---|
| `schema_meta` | schema composition / `infrastructure/sqlite/local-schema` | `key`；保存组合 schema version。 |
| `local_foundation` | durable singleton / Foundation | `singleton=1`；保存 Device、Workspace、Local Topic 与嵌入的 Owner identity。 |
| `agents` | durable object / Foundation | `principal_id`；保存 Agent identity、client/config 和 current Session pointer。 |
| `agent_sessions` | durable continuity / Runtime | `session_id`；保存 adapter/provider Session、workspace binding 与可选 Agent Run binding。 |
| `events` | immutable Event / `core/event` | `event_id`；保存七种 canonical Event、causality、typed payload 和 Destination snapshots。 |
| `executions` | durable work / `core/runtime` | `execution_id`；保存 Handler claim/retry/终态与 bounded versioned receipt。 |
| `agent_runs` | durable coordination object / `application/agent-run` | `run_id`；保存 mandate/workflow snapshot、Steward Session、current step、budget、CAS、cancel 与 terminal outcome。 |
| `chat_messages` | rebuildable projection / `application/chat` | `event_id`；保存 Timeline snapshot、attention denominator 与 Agent Execution-driven read progress，不拥有消息或用户 read state。 |
| `deliveries` | durable work / `core/runtime` | `delivery_id`；保存一次 result 投递、Destination snapshot、retry 与外部 receipt。 |
| `chat_presence` | durable policy / `core/chat` | `(agent_id, scope_kind, scope_id)`；保存 scoped available/snoozed 状态。 |
| `subscriptions` | durable object / Poll Subscription | `subscription_id`；保存 probe policy、callback binding、poll lifecycle 与 terminal Event pointer。 |
| `schedules` | durable current object / Scheduled Task | `schedule_id`；保存 current definition、current revision 和 next occurrence。 |
| `scheduled_runs` | durable occurrence / Scheduled Task | `run_id`；保存 occurrence lifecycle 和 bounded immutable definition snapshot。 |
| `reviews` | legacy read-only aggregate / Review | `root_event_id`；仅保留 schema v43 及更早 terminal Review 的查询历史；新 Review 作为 `review@1` workflow 运行在 `agent_runs`。 |
| `notices` | projection + authoritative state / `application/notice` | `notice_id`；保存 derived Notice snapshot 与 read/ack。 |

### Foundation 与 Agent continuity

`local_foundation` 嵌入唯一 Owner，因为 Local Runtime 没有独立 Principal roster 控制面。`agents` 合并旧 Agent principal、profile 与 current-session pointer；`agent_sessions` 保持独立，因为它是会持续增长的 provider continuity history。

`agents.current_session_id` 只表示 Chat/普通 Agent request 的 current pointer，`agent_sessions` row 才是 Session identity。一个 Session 可以跨多次 Execution 使用，不能与 `executions` 合并。run-scoped Session 使用可选 `run_id`，并由 partial unique index 保证同一个 `(run_id, agent_id)` 只有一个 Session；它不写回 `agents.current_session_id`，也不与 Chat Session 共用。

### Event、Execution 与 receipt

`events` 是 immutable facts，`executions` 是 mutable retry/recovery state，二者不能合并。Chat attention receipt 列表和 Chat decision receipt 迁入对应 `executions.receipt_json`：

- `ChatAttentionReceiptList@1` 属于 `chat.message` 的 Chat Execution；
- `ChatDecisionReceipt@1` 属于 `chat.dispatch` 的 Agent Execution。

receipt 写入必须经过对应 versioned runtime parser，当前列上限为 64 KiB。新增 Handler receipt 需要定义独立 schema，不能复用任意 JSON。

Agent Run 的 `AgentTurnResult@1` 是 encoded in `agent.result.output` 的 bounded、versioned module contract；Core 将 output 作为不透明字符串保存，不再把解析结果复制进 `events.payload_json`。注册的 Agent Run continuation 负责 strict parsing。`AgentStepCompletion@1` 保存于 callback `agent.request` 的 run context，`AgentRunContinuationReceipt@1` 保存于对应 ResultHandler Execution receipt；workflow-specific finding、role 或 transcript 不复制进 `executions` 或 `agent_runs`。

同一 immutable output 的 contract validation failure 不是 retryable work。Agent Run continuation 将 Run terminalize 为 `failed`，并在 ResultHandler Execution 写 `AgentRunContinuationReceipt@1 { outcome: "invalid_result", error }`；该 receipt 是 bounded diagnosis，不成为第二份结果事实源。

### Agent Run lifecycle

`agent_runs` 命中独立 identity、cancel、CAS/recovery、budget 和 external workspace write exclusion，因此不能塞进 Event 或 Execution receipt。`run_id` 绑定 root `agent.request`；`active_step_id`、`active_execution_id` 与 `version` 共同守住 restart/duplicate continuation。status 为 `active | waiting | succeeded | failed | needs_human | cancelled`，terminal Run 保留供 CLI、Console 与 Event trace 查询。

`mandate_snapshot_json` 是 bounded、versioned `RunMandateSnapshot@1`：保存内联 objective，或 workflow ID/version、validated inputs 与 rendered instruction snapshot。可选 `workspace_grant_json` 保存 Owner admission 的 canonical external root、`read | write` 与初始 revision；它不是 Agent 自行修改的配置。deadline、max steps、max depth 和 step count 是 Run current state。

每个 `agent.request.prompt` 保存该 turn 的 active delegate roster 和 exact `AgentTurnResult@1` shape；roster 是 immutable Event prompt snapshot，不进入 `agent_runs` current state，也不建立 Agent membership 表。Store 读取 mandate/workspace JSON 时必须重新校验 schemaVersion、exact fields、类型与大小，不能只依赖 `json_valid` 或 TypeScript cast。

Run transcript 不复制到 JSON 或 `agent_run_steps`：所有 request、result 和 callback 都在 `events/executions` 中共享 `runId`，并用 `stepId/parentStepId` 还原调用链。每次 continuation 在同一 transaction 内完成 ResultHandler Execution、更新 Run CAS，并建立最多一个 child/callback Event 与 Execution。deterministic continuation key 保证 retry、duplicate result 和 restart 不重复 admission。

跨 owner transaction 不等于复制 ownership：bootstrap/application unit of work 把同一 `DatabaseSync` transaction 交给 RuntimeStore 与 AgentRunStore；RuntimeStore 仍唯一写 Event/Execution/Session，AgentRunStore 只写 `agent_runs` 和 Run-specific constraint。AgentRunStore 不复制 Event mapper、Execution claim/retry 或 child admission SQL，RuntimeStore 也不增加 `agent_runs` column/transition 方法。

相同 canonical external workspace 可以并行多个 read Run，但 partial unique index只允许一个 non-terminal write Run。cancel 原子写入 terminal state并取消 queued Execution；已经 running 的 provider result可以写入审计 Event，但 trigger/ResultHandler 在读取 cancelled Run 后不得创建 retry、child 或 callback。

### Destination snapshot 与 Delivery

schema v43 不建立 `destinations` 表。当前产品没有独立 Destination 管理面或生命周期；保留可变 Destination object 只会制造无主配置。

Event admission 把每个 Destination 的 `destinationId/kind/address/createdAt/updatedAt` 固定到 `events.destination_snapshots_json`。ResultHandler 从 parent/result Event snapshot 建立 Delivery，并把 `kind/address` 再固定到 `deliveries`。因此重启、retry 与历史查询不依赖进程内 cache，也不会被后续同 ID 的配置变化改写。

如果未来出现可独立增删、授权、轮换或被多条未入队工作引用的 Destination 控制面，届时再以真实生命周期重新建立对象表。

### Schedule 与 ScheduledRun

`schedules` 只保存 current definition；`scheduled_runs.definition_snapshot_json` 保存实际 occurrence 使用的 `ScheduleDefinitionSnapshot@1`，当前上限 128 KiB。历史 revision 只有被某个 run 使用时才保证可查。

这避免为了未发生的配置版本维护独立 revision 表，同时保证已经 admission 的 run 在 Schedule 修改后仍能准确恢复。需要完整 Schedule 配置审计历史时，应先证明产品查询与 retention 需求，再重新引入 revision log。

### Legacy Review aggregate

`reviews` 只为既有 terminal Review 保留 read-only inspection。schema v44 不注册 ReviewHandler，不允许 application/CLI/Console create/recover；新审查通过 versioned `review@1` workflow 启动 generic Agent Run。升级时如果发现 non-terminal legacy Review 会 fail closed，要求先用上一版本完成或恢复，避免同时存在两个可写引擎。

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
| `agent_runs_active_write_workspace` | `agent_runs` | 保证同一 canonical external workspace 最多一条 non-terminal write Run。 |
| `agent_sessions_run_agent` | `agent_sessions` | 保证一个 Run 内每个 Agent 只有一个 run-scoped Session。 |
| `chat_messages_topic_cursor` | `chat_messages` | 按 Topic 与 `(created_at, event_id)` 稳定分页 Chat Timeline。 |
| `deliveries_due` | `deliveries` | claim pending/retry-wait Delivery。 |
| `subscriptions_due` | `subscriptions` | 查询到期 Subscription。 |
| `schedules_due` | `schedules` | 查询到期 Schedule。 |
| `scheduled_runs_schedule`、`scheduled_runs_status` | `scheduled_runs` | 查询 run history 与 active/unknown state。 |
| `reviews_active_subject`、`reviews_active_workspace` | `reviews` | 保证 active Review 的 subject/workspace 排他性。 |
| `notices_timeline` | `notices` | 稳定读取 Notice Center timeline。 |

## v42/v43 → v44 migration

升级在一个 `BEGIN IMMEDIATE` transaction 内完成，临时关闭 FK enforcement，完成复制、校验形状、删除旧表、写入 schema version 后再提交并恢复 FK。

- Owner 嵌入 `local_foundation`；Agent principal/profile/pointer 合入 `agents`；`sessions` 改为 `agent_sessions`。
- Destination 定义固化到 Event/Delivery snapshots，随后删除旧 `destinations`。
- Chat attention/decision receipts 转换为 versioned Execution receipts；legacy Chat helper tables 删除；随后从 `chat.message`、attention receipt 与 dispatch Execution backfill `chat_messages`。
- Subscription、Schedule、Review 与 Notice 按上文模型收敛。
- Server connection/binding、Matrix ingress binding 与旧 Device/Agent enrollment 不属于当前 Local foundation，迁移后删除；Server Agent authentication、Topic/TransportBinding 与 cursor/session persistence 在 v0.4 按真实 control-plane lifecycle 重建。

若数据库仍声明 v42，但部分同名 target table 已经具有完整 compacted 列并保存数据，迁移把非空 current-shaped table 视为该 aggregate 的优先来源，逐列原样复制 snapshot、receipt 与 user state；只有 current-shaped source 为空且对应 legacy source 非空时才回退到 legacy transformation。该兼容分支仍在同一 transaction 内执行并接受 exact row count 与 foreign-key verification，避免中间版本写出的混合 schema 丢失 Foundation、Agent 或 Capability state。

v43 → v44 增加 `agent_runs`、`agent_sessions.run_id` 与 `chat_messages`。terminal legacy Review 原样保留为只读历史；non-terminal legacy Review 阻止升级。`chat_messages` 不复制旧 projection，而是始终由 canonical facts 幂等 backfill；migration 以及显式 rebuild 都核对 `chat.message` 与 projection exact row count。正式 migration 只接受 schema v43 和更早已发布形状，不把同版本未知 table shape 当作兼容来源。

迁移必须保留 canonical Event、Execution/Delivery retry state、Session continuity、Capability current state/已发生 snapshot、Review transition、Notice read/ack，并通过 `PRAGMA foreign_key_check`。

## Change guidance

- 新增物理表必须登记 `split reason`，明确命中的独立生命周期、CAS、recovery、持续增长或 authority 条件；“更规范”“方便 join”“便于以后扩展”不构成拆表理由。
- 新增、删除或重命名表/named index，或改变主键、owner、字段 authority、snapshot/receipt schema、投影来源或 rebuild 规则时，同步本页与 `LOCAL_SCHEMA_VERSION`。
- 物理 schema 只能由 `local-schema.ts` 创建；Store 可以执行 domain transaction，但不能私建业务表或维护平行 migration。
- migration 必须有 fresh schema exact-table 测试、上一正式版本 fixture migration、foreign-key check，以及所属 Store/Capability 行为测试。
- Event schema、Route 和因果链仍归 [Event Reference](./event-reference.md)，不要在本页复制 Event 字段注册表。
