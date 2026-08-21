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
- Subscription：固定 definition revision/digest、free probe policy、interval/deadline/max attempts、terminal identity/observation，以及按 ordinal 保存 versioned definition、exact grant 与 receipt 的 callback occurrences。
- Local Scheduled Task：Schedule current definition/revision/next occurrence，以及按 occurrence 唯一、固定 immutable definition snapshot、可关联 Event/Execution/Session/result 的 ScheduledRun。
- Topic activation schedule：Topic-owned once/cron intent schedule、next occurrence、CAS revision，以及按 occurrence 唯一的 admission/skip/failed receipt；不保存 arbitrary prompt、callback 或 ScheduledRun。
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
- Topic Pause/Resume 与 participant Add/Remove 的 current aggregate 和 immutable receipt 在同一 SQLite transaction 中恢复；重启后 query/action availability 直接读取该 revision，不从 Event 猜测状态。Resume 不补偿 paused 期间的 attention，也不自动激活；Resume & wake 的显式 idempotency key 映射到 canonical `chat.activation` external identity，进程在 governance commit 后退出时，重试仍会创建或返回同一个 `reason=resumed` activation。
- Free Chat mode 与每次 state transition receipt 在同一 SQLite transaction 中提交。cycle sample 在 activation admission 前已持久化；pending root external identity 为 `free-chat:<modeId>:<cycle>`，crash/restart 会重新关联同一 canonical root。Runtime 只评估当前 sample deadline，sleep 期间遗漏的 deadline 不展开为 backfill；活跃 root 存在时 continue-now 也不能建立重叠 root。meaningful Owner/Agent message 通过 `(createdAt,eventId)` cursor 恰好推进一次并重采样；terminal root 无贡献则累计 silence，达到 boundary 后持久化 stop receipt。
- Global snooze 优先于 Topic presence；直接 mention、对应 scope 的 literal wake keyword 或到期让 Agent获得一次重新决策机会，最终 presence 仍以本轮 `ChatDecision@1` 为准。
- 每个 Event type 只有一个 Handler，不 fanout。
- generic Agent Execution 可以使用有限指数退火；Agent Run 与 Subscription callback 固定单次 provider attempt，达到 terminal failure 后产生一个 failed `agent.result` Event，`chat.dispatch` failure 不产生 relay。
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
- ScheduledRun 的 `(scheduleId, occurrenceKey)` 唯一；Event admission 以 `scheduled-run:<runId>` 再次去重。misfire 只记录一个 bounded skip/run-once window，overlap queue 只有一个 pending slot。
- Scheduled Task 固定 Session 与同 schedule work 串行；manual run 使用调用方 request ID，并且不移动正常 occurrence。
- Topic scheduled activation 的 `(scheduleId, occurrenceKey)` receipt、schedule advance 与 canonical `chat.activation` admission 在同一 SQLite transaction 提交；duplicate cycle 返回同一 occurrence 事实。misfire、paused Topic、空 eligible roster 和 active-root overlap 都只 skip 当前 occurrence 并推进，不 backfill。
- Interactive Channel send 以 `(bindingId, idempotencyKey)` 幂等；Local send 进入 canonical Chat admission，Server send 复用稳定 transaction ID 并要求 Agent credential 与 Topic membership。follow 从 send receipt 的 observed cursor 继续；没有 Server correlation 时只报告新消息。callback 只向 binding 固定且仍由同一 Agent 拥有的 idle durable Session admission，busy 时保持 pending，revoke/expiry 后不再 admission。

## Crash and shutdown

Local Runtime loop 串行推进 Subscription、被动 Topic sync、Local Chat、Topic schedule、Interactive Channel、Scheduled Task 与 Runtime cycle，但每个 cycle 和每条 Execution/Delivery 分别隔离异常。单个失败只写结构化 failure log，不能结束主进程。被动 Topic sync 必须先原子持久化并按 Event ID 去重，再提交 Server cursor；它不触发 Agent 执行。

启动恢复不会把已进入 `running` 的 Agent provider invocation 放回重试。进程无法证明 crash 前是否已经产生 tool/provider side effect，因此这类 Execution 一律终态标为 `runtime_interrupted_unknown`，保存 `AgentInvocationRecoveryReceipt@1`（`replayed=false`），并为非 Chat Agent input 生成 canonical failed `agent.result`，让 Steward、Schedule/Subscription 等既有 continuation 收口。只有未开始的 `queued/retry_wait` Agent work 才继续正常 retry；ResultHandler 等纯本地 transaction handler 和具有独立幂等 receipt 的 retryable Delivery 保留有限重试。Subscription probe 遵守剩余 deadline/attempt；callback phase 中未形成 durable Core work 的 started 与剩余 pending callback 收敛为 unknown，已绑定 host Delivery 的 callback 则等待 Core recovery 后按 terminal receipt reconcile。ScheduledRun 已经进入 provider invocation 时，run 转为 `unknown`，对应 Execution 终止，直到用户根据 provider evidence 使用 CLI resolve；不会自动重放可能已有 side effect 的请求。SIGINT/SIGTERM 停止接收新 cycle，并通过 AbortSignal 取消可取消的 probe。

Agent Run 恢复先读取 Run terminal/cancel/active cycle 状态，再处理关联 Execution。`awaiting_source` series 没有 active work，等待下一 source revision 或 `run close`；active cycle 只复用该 cycle 尚未开始的 queued Execution。中断的 running Agent invocation 生成 failed result 后进入一次 bounded Steward adjudication，原 provider turn 绝不重放；`must_change` succeeded result 未产生 Runtime-observed revision change 也进入同一 adjudication。只有 Steward 返回 retry 与安全证据、且 Runtime safety gate 能排除 workspace/network/tool side effect 时才 admission 一个 `maxAttempts=1` retry Event；normalized acceptance 不能覆盖 revision evidence，retry 后仍未满足 effect 直接 `needs_human`，不递归。`awaiting_orchestrator` 直接恢复 durable Worker checkpoint。同 request ID 的已接受 decision 返回既有 receipt，stale version、cancel/terminal 后的 decision 与 late result 均 fail closed。ResultHandler 使用 deterministic continuation key 重放未完成 transaction。Run 已 cancelled 或 terminal 时不再恢复 child/callback；current cycle、step、Execution 或 Session binding 无法一致解释时 fail closed 为 `needs_human`。

provider invocation 与外部 Delivery 使用实际完成/失败时刻写 terminal fact；只有显式传入测试时钟时才固定整轮时间。这样 deadline 判断不会因一次长 provider call 复用 cycle-start timestamp。具体 result contract 对 immutable output 的确定性校验失败不重新解析同一结果；Autonomous Run 只允许上述一次 semantic adjudication，Subscription callback 直接失败。

Scheduled Task 声称 exactly-once 的边界是本地 occurrence/Event/Execution admission，不是 provider side effect。Topic activation schedule 的 exactly-once 边界同样只覆盖本地 occurrence receipt 与 canonical Chat activation admission；Interactive Channel 的发送边界是本地幂等 receipt 及稳定 transport transaction，不把远端 side effect 宣称为 exactly-once。provider 或网络 outcome 无法确认时按各 owner 的 durable receipt 恢复或收敛，不能盲目重放。

## Schema cutover

schema v63 以 v0.3.11 发布的 v44 为最早升级基线。v44–v62 保留既有升级链；v62→v63 为 `agent_runs` 增加 series/active cycle，创建 `agent_run_cycles`，并为 `agent_sessions` 增加 cycle binding。升级保留旧 Run/Session/Event/receipt，旧普通 Run 的 series/cycle 均为空。upgrade guard 禁止 active Runtime 上原地升库。Release Candidate 历史表继续只做兼容识别，不属于当前 28 张表。完整 authority 和映射见 [Database Reference](./db-reference.md)。

## Change guidance

- 新副作用必须定义 stable ID、terminal receipt、retry ownership 与是否允许自动重试。
- 修改 Event/Execution/Delivery 状态机必须覆盖 duplicate、restart、failure isolation 与 terminal no-replay。
- 新 durable facts 必须出现在 Console audit 或明确说明为何仅是内部调度状态。
