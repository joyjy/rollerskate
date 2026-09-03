---
type: Architecture
title: Rollerskate Source Of Truth
description: 产品、网络、本地运行、Agent 与 workspace 数据的权威归属。
tags: [rollerskate, source-of-truth, ownership, data]
timestamp: 2026-07-26
---

# Source Of Truth

[返回 architecture index](./index.md)

## Ownership map

| 事实 | 权威系统 | Rollerskate 的其他层如何使用 |
| --- | --- | --- |
| Local Owner/Agent Principal、LocalDevice、LocalWorkspace、`Local` Chat/Topic | Local Runtime SQLite/filesystem | 首次启动本地生成；未来 Server binding 不合并或替换 Local identity。 |
| Server 用户登录、remote Device/Agent identity、Home placement | Server | Local 通过 connection-scoped binding 引用，保留本地执行否决权。 |
| Matrix room、thread、sender、message history | Matrix | Adapter 保存最小 transport reference 与 delivery evidence。 |
| 产品 identity、Agent、placement、Room/membership/binding 与产品 Event projection | Server | Client 和 Local 只保存当前操作需要的投影与引用。 |
| IntegrationBinding endpoint/profile/scope/placement 与 revision | Server | Local 只在 ExternalRef trigger read 时重读 exact binding；它不是 Run participant、workflow、workspace 或外写 authority。credential 只保存为 placement 内 opaque reference。 |
| Agent work request identity、在线 route binding、共享状态、decision/Run/result receipt | Server | Local owner 决定 admission 并拥有实际 Run；Server 只保存 bounded request/result 与 Run ID reference。未接受请求不进入 Local Event/Run，Runtime 重启不补推旧 route 请求。 |
| Vikunja Project/Task/comment 与 revision | Vikunja | read-only Connector 通过 `ExternalRef@1`、bounded `Observation@1` 引用；terminal Run comment 由普通 `vikunja-task` Destination/Delivery 写回。RS 不复制完整 Project history。 |
| Local `chat.message`/`chat.dispatch` history、Topic ID、dispatch receipt、Execution/Session/Delivery | Local Runtime SQLite canonical Event/work state | 对唯一 `Local` Chat/Topic 与本机执行恢复权威；`chat_messages` 只是可重建 Timeline/read-progress projection，远端产品/聊天历史仍不在此复制。 |
| Local Topic status、participant roster、conversation policy/themes、governance revision 与 control receipt | Local Topic governance aggregate + immutable receipt | application/topic 对本机 conversation admission policy 与 queued dispatch claim-time eligibility 权威；不替代 Chat Event history，不修改 Agent lifecycle、Server membership、Session 或 history grant。 |
| 历史 Free Chat mode 与 receipt | Local Runtime SQLite historical audit | schema v70 migration 对 active mode 恰好一次写入 `feature_retired` stop receipt；之后没有 runtime writer、timer、control/query 或新的 mode，旧表不再是 current product state。 |
| Topic activation schedule definition、next occurrence、revision 与 occurrence receipt | Local `TopicActivationSchedule` aggregate + immutable receipt | application/topic 对 scheduled conversation intent、candidate policy 与 occurrence advance 权威；与 arbitrary Scheduled Task 分离，Core 只拥有复用的 canonical Chat activation/Execution。 |
| Interactive Channel Agent binding、allowlist、expiry、send/follow/callback state | Local Channel binding + send receipt + follow state | application/channel 对本地授权与恢复权威；Local Chat Event 或 Server Topic message 仍由各自 owner 拥有，Channel 只保存 bounded body/reference、cursor、transport receipt 与 callback admission 状态。 |
| Steward Run mandate、可选 series/revision cycle、orchestration binding、run/cycle-scoped Sessions、current lifecycle/checkpoint、budget、close/cancel 与 decision audit | Local Runtime SQLite `agent_runs` + `agent_run_cycles` + `agent_run_decisions` + `agent_sessions` | Steward application/Store 是唯一 transition authority；series cycle terminal 只把 Run 转为 `awaiting_source`，外部 owner 决定何时新建 revision cycle或 close。workflow、Agent prose、provider Session、Vikunja link 和 Console 都不能独立推进 Run。 |
| Run step、Agent result、bounded outputs 与 autonomous completion callback history | Local canonical Event/Execution | `agent_runs` 只保存 current coordination/checkpoint state；application query 按 `runId/cycleId/stepId` 投影 transcript、往返次数和逻辑 Output Folder，terminal primary Output、显式 outputs 与 artifact refs 都不复制进新表。 |
| Versioned Agent workflow（包括 `review@1`、`mr-readiness@1`、`forum@1`） | `local/resources/workflows/` | workflow 定义目标、输入和协作规约，不拥有 Runtime Handler、Store、外部业务 lifecycle 或固定 Agent role。 |
| Local ScheduleDefinition/ScheduleRevision/ScheduleOccurrence、next occurrence 与 admission decision | Local Runtime SQLite | Runtime core loop 独占 time/misfire/overlap/freshness；V3 source application 在同事务中激活 bound Run cycle、执行同库 action 或 enqueue registered external workflow，Server 或 provider scheduler 不能替代本机决定。 |
| External workflow registration、execution lease/effect boundary 与 terminal/manual receipt | mode-0600 Owner registry + Local Runtime SQLite | Owner registry 固定 versioned workflow/input/command/authority/retry；SQLite execution 是 occurrence 级恢复事实。业务 LWW/remote receipt 只作为 unknown manual recovery oracle，不覆盖 Runtime history。 |
| Chat sandbox 与 external workspace | Local filesystem / Owner grant | Chat Session 不获得项目 workspace；需要源码的 Run 在 admission 时固定 canonical external root 与 `read | write`，Agent/workflow 不能自行扩大。 |
| 额外 path、secret grant、pause/stop decision | Local Runtime / owner | Server 可请求，不能自行授予或读取值。 |
| Agent provider session/tool execution | Agent provider | Runtime 保存 invocation state、receipt 与必要摘要。 |
| Local Chat 聊天展示 | Local `chat_messages` rebuildable projection | message 内容仍来自 immutable Event；read progress 只解释 Agent Execution，不存在用户 read cursor 或可修改 message record。 |
| Server Room 聊天展示与待投递消息 | Server projection + Matrix transport | Local 仅保存执行所需 reference、result 与 delivery receipt。 |
| 当前架构事实 | `docs/architecture/` + source | Active plan 不能覆盖已实现事实。 |
| 未实现工作 | 内部规划 | 实现并验证后再迁入 architecture/runbook 与源码事实。 |

## Data movement limits

- Local 永久保存自身 `Local` Chat Event history；但不因此复制 Server Room、Matrix 或 Agent provider 的完整信息。
- Server 不同步整个 workspace、Local SQLite、path grant 或 secret value。
- Server 的 Integration records 只保存 `credentialRef`；secret value 留在 Connector placement，不能进入 binding response、Observation、Agent prompt、Delivery payload 或普通日志。
- Local 调用外部 Agent provider 时，只在明确 sandbox/cwd 与用户知情边界内发送完成请求所需上下文。
- 相同 external workspace 允许多个 read Run，但最多一个 non-terminal write Run；并行写必须使用不同 worktree root。
- Matrix history 留在 Matrix；Local 只保存未消费 working set，以及幂等、correlation、trace 与 reply 所需的最小事实。
- Server Topic Interactive Channel follow 只读取 Local passive inbox 的 bounded cursor working set；缺少 thread correlation 时不能从消息先后推断 reply/terminal。Channel callback 不复制 provider transcript，只保存 exact `ses_*` reference 与 canonical callback Event ID。
- Agent 迁移到另一设备时，workspace 数据迁移与额外授权是显式流程，不由 placement 自动隐式复制。

## Remote working-set retention classes

- 以下规则只适用于 Server/Matrix working set；Local `Local` 的 immutable Event history 按本地 Chat/Topic 事实长期保留。
- 未消费 remote 消息正文：保留到 Attention Turn 消费、明确过期或被 Server 撤回。
- 失败或待重试内容：保留到恢复完成或达到 bounded TTL。
- 已消费内容：清除正文，只保留 remote event reference、hash、cursor、decision 与 receipt。
- `delta.md` 等 context artifact：Attention Turn 结束后清理；需要历史时通过 Server BFF 查询 Matrix，而不是要求 Local 永久搜索。
- 本地授权、runtime state 与 receipt：按本机恢复和审计需要持久化，但不能包含完整远端对象副本。

## Change guidance

任何新增同步或本地缓存字段都必须回答：谁创建、谁可修改、离线时谁权威、冲突如何解决、为何必须落本地、何时清理、是否包含敏感数据以及如何撤销。无法回答时，不得加入 Server/Local 协议或 Local SQLite。
