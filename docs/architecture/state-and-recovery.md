---
type: Architecture
title: Rollerskate State And Recovery
description: Local Runtime 的统一 durable facts、有限重试、异常隔离与恢复边界。
tags: [rollerskate, sqlite, recovery, event, reliability]
timestamp: 2026-07-26
---

# State And Recovery

[返回 architecture index](./index.md)

Local Runtime 使用 Node 内置 SQLite 与 WAL。SQLite 是本机执行事实源；结构化日志提供运行审计，但不替代 durable facts。

## Durable domains

- canonical Event：统一 ID、type/source、Agent、Session/Destination snapshot 与 causality；输入 Event 携带 prompt 与可选 generic run context，`agent.result` 只携带 outcome、Core 不透明处理的 output/error。具体 result contract 由注册的 application continuation 解释。
- Local foundation：generated LocalDevice、唯一 LocalWorkspace/Local Chat、Local Topic、嵌入的 Owner identity 与创建时间。
- LocalAgent：短 handle、active/suspended、client、execution config 与 current Session pointer。
- Local Chat：immutable `chat.message`/`chat.dispatch`、Execution 上的 versioned attention/decision receipt、Topic/Global presence、prompt resource ID 与 handle snapshot；`chat_messages` 只提供可删除重建的 Timeline/read-progress projection。
- Execution：唯一 Event、唯一 Handler、attempt/max attempts、next retry、terminal status和 bounded versioned receipt。
- Session：Agent、adapter、workspace、provider Session ID 与可选 Run/cycle binding；Chat current Session 与 run/cycle-scoped Session 不共享。
- Delivery：稳定 delivery ID、immutable Destination kind/address snapshot、attempt、retry 与外部 receipt；当前 kind 为 Matrix 或 macOS notification。
- Subscription：固定 definition revision/digest、probe policy、interval/deadline/max attempts 与 terminal/delta observation；V5/V3 保存统一 proactive target 及对应 Run/action receipt，V4/V2 Run binding 与 V3/V1 callback 保持历史兼容。
- Local Scheduled Task：Schedule current definition/revision/next occurrence，以及按 occurrence 唯一、固定 immutable definition snapshot 的 ScheduleOccurrence；V3 target 原子关联 Steward Run/cycle/admission receipt 或 deterministic action receipt，V2/V1 保持历史兼容。
- Deterministic application action receipt：Owner registry 编译的 action ref/digest/input 对 exact source occurrence 的 immutable terminal fact；它不是 Event、Execution、callback 或 retry work。
- External workflow execution：Owner registry 编译的 versioned workflow ref/digest/input 对 exact source occurrence 的独立 durable work；保存 bounded retry、claim/renewable lease、effect boundary、terminal/unknown runtime receipt 与可选 manual resolution receipt，不复用 Agent Event/Execution。
- Proactive source migration receipt：稳定 request ID 对 paused legacy Schedule old revision/digest 与新 external workflow target/source revision 的 immutable mapping；迁移和 current revision 更新同事务提交。
- Topic activation schedule：Topic-owned once/cron intent schedule、next occurrence、CAS revision，以及按 occurrence 唯一的 admission/skip/failed receipt；不保存 arbitrary prompt、callback 或通用 ScheduleOccurrence。
- Interactive Channel：Agent-scoped binding/allowlist/expiry/callback Session，幂等 Local/Server send receipt、observed cursor、follow token 与 callback pending/admitted 状态。
- Agent Run：durable coordination object 保存可选 series/active cycle、mandate/workflow snapshot、orchestration mode、current step/checkpoint、budget、external workspace grant、CAS、cancel 与 terminal outcome；series revision cycle 另存 durable child，step transcript 留在 Event/Execution。
- Notice：derived projection 与 authoritative read/ack 同表；rebuild 只覆盖 derived columns。
- Server connection/binding 不进入 Local SQLite：Device/Agent credential 与 binding metadata 分别保存在 mode-0600 file store，Server Topic delivery 只进入独立的被动 inbox/cursor file store。
- Matrix outbound 仍可消费已经 admission 的 Destination snapshot；v0.4 原生 Server Topic ingress 与 legacy Matrix Room ingress 分离，前者只持久化 passive delivery，不建立 Local Event、Handler、Execution 或 Session。

旧 Work、lease、generic outbox、RoomChat invocation/turn/outbox 与独立 continuation work 不再是当前 Runtime domain。

## Reliability invariants

- Event 入库与唯一 queued Execution 原子完成。
- 同一 `(source.kind, source.externalId)` 只接受一次；Server Event 直接以全局 Event ID 去重。
- 同一 source message 对同一 Agent 只能有一个 attention receipt 和最多一个 `chat.dispatch`；ChatHandler 重试不会重复 admission。
- Topic governance revision 与 participant revision 随新 `chat.dispatch` 固化为 admission snapshot，attention receipt 同时保存 admission 时的有效 Topic/Global presence；AgentHandler 在 provider invoke 前通过 application guard 读取最新 governance 与 presence。paused、removed、inactive、revision-changed 或排队后新增/变化 snooze 的 dispatch 以 `cancelled` + `RuntimeExecutionSkipReceipt@1` 终止，provider 不启动；read-progress 将其投影为带 failure reason 的 `unread`。若 admission 时已经 snoozed 但由 mention/keyword 合法唤醒，未变化的 snapshot 不会在 claim 时被误杀。旧 dispatch 没有 governance snapshot 时仍复检当前 pause、strategy、participant 与 lifecycle eligibility，但不伪造历史 revision。
- Topic Pause/Resume 与 participant Add/Remove 的 current aggregate 和 immutable receipt 在同一 SQLite transaction 中恢复；重启后 query/action availability 直接读取该 revision，不从 Event 猜测状态。Resume 不补偿 paused 期间的 attention，也不自动激活。
- schema v70 在升级 transaction 内把每个 active Free Chat mode 恰好一次转为 `stopped`，追加 `details.reason=feature_retired` 的 `FreeChatModeReceipt@1`，并取消 `manual`、`starter` 或旧 `free-chat:*` root 下尚未完成的 Execution。已终止 mode、历史 receipt 和旧表均原样保留；重复初始化不会增加 revision 或 receipt。
- Global snooze 优先于 Topic presence；直接 mention、对应 scope 的 literal wake keyword 或到期让 Agent获得一次重新决策机会，最终 presence 仍以本轮 `ChatDecision@1` 为准。
- 每个 Event type 只有一个 Handler，不 fanout。
- generic Agent Execution 可以使用有限指数退火；每次 Agent Run 与 Subscription callback invocation 固定单次 provider attempt，达到 terminal failure 后产生一个 failed `agent.result` Event，`chat.dispatch` failure 不产生 relay。`OrchestratorBinding@3` 的首次 Orchestrator decision 若发生 provider failure 或严格 contract rejection，可在同一独立 Run 或 source cycle 内追加一次新的单次-attempt request；这不是重试原 Execution，也不适用于 write workspace。
- `agent.result` 只由 ResultHandler Execution 处理；Delivery retry 不重跑 Handler，ResultHandler terminal failure 不递归创建 Event。
- Autonomous Agent Run 一次 turn 只能 `complete` 或 delegate 一个 child；Caller-orchestrated Run 的 Worker 只返回 `AgentStepResult@1` 并进入 `awaiting_orchestrator`，由 admitted Local Owner 提交 current-version `RunDecision@1` 决定同一 Agent、另一 admitted Agent、finish 或 needs-human。result→checkpoint、decision→下一 Event/terminal 与 immutable receipt 各自在单一 transaction 完成；generic ResultHandler 只负责 contract routing。
- 普通 Run 的 `(runId, agentId)`、series Run 的 `(runId, cycleId, agentId)` 各自唯一；不同 revision、不同 Run、Chat 与 Run 不共享 Session。nested delegate 使用 `stepId/parentStepId` 形成 durable async call stack。
- cancel 幂等并阻止 queued work、retry、delegate、child 与 callback；已经 running 的 provider process不强杀，late result 只能留下审计事实。
- 相同 canonical external workspace 允许多个 read Run，但最多一个 non-terminal write Run；数据库唯一约束不声称隔离外部进程修改，每个 step 必须记录观察到的 revision/drift。
- Matrix Delivery 使用稳定 delivery ID 作为 transaction ID。
- terminal Subscription 与 `subscription.fire` Event/Execution 原子建立；非 terminal poll 不创建 Event。
- callback 在外部 effect 前持久化 started；正常失败继续下一项，started callback 遇到 crash 后与剩余 pending callback 一并 unknown，并终止对应 Execution，绝不自动 replay。
- callback `destination.deliver` 先持久化 host-origin Core Delivery；macOS notification 最多尝试一次，其他 adapter 使用 Core retry。Delivery terminal receipt 再投影到 callback occurrence，外发失败不会绕过 Delivery 状态机。
- 已成功或最终失败的 Execution 不因重启重放。
- ScheduleOccurrence 的 `(scheduleId, occurrenceKey)` 唯一；V3 Run target 的 cycle activation 与 envelope/receipt 同事务，action target 的 handler mutation与 terminal receipt 同事务。misfire 只记录一个 bounded skip/run-once window，overlap queue 只有一个 pending slot。
- Run target 只在 bound Run 为 `awaiting_source` 时激活 cycle；cycle terminal 回投 occurrence，Run terminal/cancel 按 binding policy 收口 source。action target 不创建 Agent work，重复 occurrence 只回读 receipt。
- external workflow execution ID 由 exact source identity 与 occurrence key 决定。source transaction 只负责唯一 enqueue；唯一 core loop 的 `proactive.external-workflow` phase 每次最多运行一个 child，claim 后持续续租，并在 spawn 前持久化 effect boundary。registry/preflight 在 boundary 前失败可按冻结 budget 重试；nonzero exit 是已知 failed，timeout、abort、signal 或 crash 后无法证明 exit 的结果是 unknown，均不会自动 replay。
- V5 one-shot terminal 与 V3 Continuous delta 按 target 分流：Run branch 延续 exact cycle 语义；action branch 使用 SQLite SAVEPOINT，成功或 skipped 推进 parent/checkpoint，失败回滚 handler mutation、写 failed receipt 并 block。两者都不自动重放 terminal occurrence。
- Topic scheduled activation 的 `(scheduleId, occurrenceKey)` receipt、schedule advance 与 canonical `chat.activation` admission 在同一 SQLite transaction 提交；duplicate cycle 返回同一 occurrence 事实。misfire、paused Topic、空 eligible roster 和 active-root overlap 都只 skip 当前 occurrence 并推进，不 backfill。
- Interactive Channel send 以 `(bindingId, idempotencyKey)` 幂等；Local send 进入 canonical Chat admission，Server send 复用稳定 transaction ID 并要求 Agent credential 与 Topic membership。follow 从 send receipt 的 observed cursor 继续；没有 Server correlation 时只报告新消息。callback 只向 binding 固定且仍由同一 Agent 拥有的 idle durable Session admission，busy 时保持 pending，revoke/expiry 后不再 admission。

## Crash and shutdown

Local Runtime loop 串行推进 Subscription、被动 Topic sync、Local Chat、Topic schedule、Interactive Channel、Scheduled Task 与 Runtime cycle，但每个 cycle 和每条 Execution/Delivery 分别隔离异常。单个失败只写结构化 failure log，不能结束主进程。被动 Topic sync 必须先原子持久化并按 Event ID 去重，再提交 Server cursor；它不触发 Agent 执行。

启动恢复不会把已进入 `running` 的 Agent provider invocation 放回重试。进程无法证明 crash 前是否已经产生 tool/provider side effect，因此这类 Execution 一律终态标为 `runtime_interrupted_unknown`，保存 `AgentInvocationRecoveryReceipt@1`（`replayed=false`），并为非 Chat Agent input 生成 canonical failed `agent.result`，让 Steward、Schedule/Subscription 等既有 continuation 收口。只有未开始的 `queued/retry_wait` Agent work 才继续正常 retry；ResultHandler 等纯本地 transaction handler 和具有独立幂等 receipt 的 retryable Delivery 保留有限重试。External workflow 的 claimed/pre-effect interruption 回到 `retry_wait` 或在 attempt exhausted 后 failed；running/post-effect interruption写 unknown 并保留 no-replay receipt，`rs recover` 也使用同一判断。Subscription probe 遵守剩余 deadline/attempt；callback phase 中未形成 durable Core work 的 started 与剩余 pending callback 收敛为 unknown，已绑定 host Delivery 的 callback 则等待 Core recovery 后按 terminal receipt reconcile。V1 ScheduleOccurrence 已经进入 provider invocation 时转为 `unknown`，对应 Execution 终止，直到用户根据 provider evidence使用 CLI resolve；V2 occurrence 从 durable Run/cycle/receipt 恢复，不能人工 resolve。SIGINT/SIGTERM 停止接收新 cycle，并通过 AbortSignal 取消可取消的 probe 与 external workflow child；后者因已越过 effect boundary 而收敛为 unknown。

Agent Run 恢复先读取 Run terminal/cancel/active cycle 状态，再处理关联 Execution。`awaiting_source` series 没有 active work，等待下一 source revision 或 `run close`；active cycle 只复用该 cycle 尚未开始的 queued Execution。`OrchestratorBinding@3` 独立 Run 或 source cycle 的首次 Orchestrator decision 在 provider failure 或严格 contract rejection 后自动追加一次只读 recovery request，并优先续用已证明的 Session；第二次失败停在 `awaiting_orchestrator`，由 Owner 使用带幂等 request ID 的 `run retry-orchestrator` 明确恢复。自动与手动恢复都从当前 Run version、状态和 fixed roster 重新渲染 prompt，同时复用已 settled request 的 Run context 与只读 Session evidence；不创建新 Run/cycle，也不接纳 write workspace。中断的 running Agent invocation 生成 failed result 后进入一次 bounded Steward adjudication，原 provider turn 绝不重放；`must_change` succeeded result 未产生 Runtime-observed revision change 也进入同一 adjudication。只有 Steward 返回 retry 与安全证据、且 Runtime safety gate 能排除 workspace/network/tool side effect 时才 admission 一个 `maxAttempts=1` retry Event；normalized acceptance 不能覆盖 revision evidence，retry 后仍未满足 effect 直接 `needs_human`，不递归。`awaiting_orchestrator` 直接恢复 durable Worker checkpoint。同 request ID 的已接受 decision 返回既有 receipt，stale version、cancel/terminal 后的 decision 与 late result 均 fail closed。ResultHandler 使用 deterministic continuation key 重放未完成 transaction。Run 已 cancelled 或 terminal 时不再恢复 child/callback；current cycle、step、Execution 或 Session binding 无法一致解释时 fail closed 为 `needs_human`。

provider invocation 与外部 Delivery 使用实际完成/失败时刻写 terminal fact；只有显式传入测试时钟时才固定整轮时间。这样 deadline 判断不会因一次长 provider call 复用 cycle-start timestamp。具体 result contract 对 immutable output 的确定性校验失败不重新解析同一结果；Autonomous Run 只允许上述一次 semantic adjudication，Subscription callback 直接失败。

Scheduled Task 声称 exactly-once 的边界是本地 occurrence admission；Run target 还覆盖同事务的 cycle/Event/Execution/receipt，application action target 只覆盖同库同步 mutation 与 deterministic receipt。external workflow 只保证 deterministic enqueue、单 lease owner、bounded no-shell invocation 和 unknown/no-replay recovery，不声称网络、Git、文件或子进程 effect exactly once；业务 LWW/remote receipt 是 manual recovery 的 terminal oracle。Topic activation schedule 与 Interactive Channel 继续按各自 receipt/transport 边界恢复，未知外部 outcome 不能盲目重放。

## Schema cutover

schema v72 以 v0.3.11 发布的 v44 为最早升级基线。v44–v70 保留既有升级链；v69→v70 退役 synthetic Chat activation 与 active Free Chat mode；v70→v71 为三个 proactive source 增加严格 target discriminator，并新增 `deterministic_action_receipts`；v71→v72 重建 Schedule/occurrence target constraints，新增 `external_workflow_executions` 与 `proactive_source_migration_receipts`。升级保留旧 lifecycle、callback/Run evidence 和 Free Chat 历史，旧 definition 不隐式升级 authority。upgrade guard 禁止 active Runtime 上原地升库。Release Candidate 历史表继续只做兼容识别，不属于当前 32 张表。完整 authority 和映射见 [Database Reference](./db-reference.md)。

## Change guidance

- 新副作用必须定义 stable ID、terminal receipt、retry ownership 与是否允许自动重试。
- 修改 Event/Execution/Delivery 状态机必须覆盖 duplicate、restart、failure isolation 与 terminal no-replay。
- 新 durable facts 必须出现在 Console audit 或明确说明为何仅是内部调度状态。
