---
type: Architecture
title: Rollerskate Local Runtime
description: Local-first Runtime 的默认基础设施、canonical Event、immutable Local Chat、单 Handler Route、Session 与审计边界。
tags: [rollerskate, local-runtime, event, handler, audit]
timestamp: 2026-07-23
---

# Local Runtime

[返回 architecture index](./index.md)

一个设备只运行一个 Local Runtime loop。默认 Runtime home 是 `~/.rollerskate/`；首次启动自动创建 LocalDevice、`<runtime>/workspace`、Owner Principal、唯一 `Local` Chat、承载它的 Local Topic 与 loop state，不依赖 Server 登录。显式 `--runtime <absolute-path>` 用于隔离测试实例；旧 repo-local `.rollerskate/` 不再参与默认发现。

```text
CLI request ─────────┐
Subscription fire ──┼─> canonical Event + Execution ─> Event.type ─> exactly one Handler
Scheduled run ──────┤                                      │
Review transition ─┤                                      │
Server Event (v0.4) ┘                         agent.result Event
                                                          │
                                                          v
                                                ResultHandler Execution
                                                          │
                                                          v
                                              zero or more Deliveries

owner chat.message
  -> ChatHandler per-Agent attention/presence decision
  -> zero or more chat.dispatch + Agent Execution
  -> ChatDecision@1
  -> agent chat.message | silent | failed audit fact
```

## Canonical Event

`local/src/core/event/model.ts` 是 Event source of truth。所有 Event 都包含全局 `evt_` UUIDv7、固定 `type`、source、可选 Principal/Session/Destination，以及 `rootEventId/parentEventId/hop` 因果关系。`chat.message` 保存 `topicId`、sender、body 与可选 resolved target/handle snapshot；`chat.dispatch` 保存同一 `topicId`、源 message、目标 Principal、稳定 `promptResourceId` 与 rendered Agent prompt。旧 dispatch card payload 保持可读，但不再生成。

- CLI、Subscription 与 Scheduled Task 在本地构造 Event 并生成统一 ID。
- v0.4 Server ingress 必须原样保存 Server 已生成的 Rollerskate Event ID，不能建立第二个语义副本；Matrix 通过 Server TransportBinding 进入，不在 v43 Local schema 私建 ingress binding。
- 用户入口不接受任意 Event envelope；每种 ingress 只接受自己的固定 schema。

`RuntimeStore.appendEvent` 原子保存 Event 与唯一 Execution。旧 `inputs → TriggerRouter → Work[]`、generic emit 和独立 Event store 已移除。

源码中的 core 位于 `local/src/core/`，其中 `core/loop.ts` 拥有唯一长期运行的 loop、cycle 调度、pause/stop 生命周期和顶层异常隔离。`bootstrap/runtime.ts` 只创建固定的 application service、第一方 Capability 与 integration，再交给 core loop 驱动；它不拥有第二个 loop，也不允许 Capability 启动自己的 daemon。完整 ownership 见 [Source map](./source-map.md)。

## Route 与 Handler

Route 只表示需要程序执行的 `Event.type → Handler kind`。`agent.request`、`subscription.fire` 与 `chat.dispatch` 路由到 `AgentHandler`；`agent.result` 路由到 `ResultHandler`；`review.requested` 与 `review.decision` 路由到固定 ReviewHandler；`chat.message` 路由到 ChatHandler。ChatHandler 在 dispatch 时应用 sender/target/lifecycle 与 Topic/Global presence 状态机，并事务性建立 per-Agent attention receipt、零个或多个 `chat.dispatch`。

`AgentHandler` 调用由 Principal identity 选择的 provider adapter，并由 Execution 持久化有限指数退火重试。传统 Agent input 成功或最终失败仍创建 `agent.result` fallback；Local Chat adapter 返回 `ChatDecision@1`，Runtime 原子保存 Session、Topic/Global presence、decision receipt 与可选 Agent sender `chat.message`，failure 只写 Execution/audit facts。Chat 行为说明只存在于独立 `prompt.chat.free-turn` 资源，build 将资源复制到 `dist/resources`。

Matrix Room 不是本地 Route。当前 outbound adapter 可以投递已经 admission 的 Matrix Destination snapshot；ingress binding、cursor 与 Session persistence 等 v0.4 Server Topic/TransportBinding model 完成后再启用。

## Capability 与 Plugin

Subscription、Scheduled Task 与 Review 是第一方 bundled Capability：它们随 Rollerskate 源码、migration、测试和发布交付，由项目负责运行稳定性。Capability 可以通过固定 ingress 产生预先注册的 Event，但不能绕过 core 或建立并列 loop。Scheduled Task 的 revision、cron/timezone、misfire/overlap、Session policy 与 unknown recovery 见 [Local Scheduled Task](./scheduled-task.md)；Review 的 MRSF、双 Agent authority、projection 与有限返修见 [Local Multi-Client Review](./local-review.md)。

用户 Plugin 不是 Capability，也不是 Handler。它只能实现 Capability 预先声明的受限 strategy slot；当前唯一 slot 是 `subscription.probe@1`。Plugin 不能注册 Event type、Route、Handler、loop 或 store，不能直接调用 Agent 或访问 Runtime。完整信任边界见 [ADR 0005](./adrs/0005-capability-and-plugin-boundary.md)。

## Session、恢复与异常隔离

Session 保存本地 Session ID、Agent Principal、adapter、workspace 与 provider session ID。每个 Local Agent 在 `Local` 中有独立 current Session；后续 dispatch 默认续接，New session 只清空该 Agent 的 current pointer 并提高 generation，不删除旧 Session 或 Chat history。

普通中断恢复把 `running` Execution 与 `delivering` Delivery 放回有限重试状态。ScheduledRun 已经进入 provider invocation 时转为 `unknown` 并停止对应 Execution，等待显式 reconciliation；已经 terminal 的 Agent Execution 不重放 provider 调用。

Review projection 始终指向唯一 expected Event/active Execution。global recovery 复用既有 Execution；Review-specific recovery 对 failed 或不一致的 expected state fail closed 为 blocked，不创建新的 transition。Reviewer 与 Implementer 的 Session pointer 按 root/role 分离。

## 审计

SQLite 是本机持久事实源。Events application query 是 CLI `event list/trace`、正式 `/api/events` 与 Console Events 的共同语义出口；旧 `/api/runtime/events` 只保留为现有 consumer 的过渡 alias。Agents 的 list/detail query 同时服务 CLI 与 `/api/agents`，mutation 后重新返回同一个 detail projection。Chats 继续复用固定 `ChatTimeline` 与 `ChatStatus` query。没有 generic Event write API，Event history 不提供修改或删除。

Loop 输出结构化 JSON log，包括 Subscription、Local Chat、Scheduled Task、Runtime cycle 与 cycle failure。v0.3 先用这些日志做运行审计，不引入 Observer；需要 durable 的产品事实仍必须进入统一数据库。

## Runtime operations projection

Runtime 运维面只投影一个 Local Runtime，不复制 Agents、Events、Chats 或 Subscriptions 的常态 inventory：

- process state 是 `running | paused | degraded | stopped`；Core Loop phase 是独立的 `idle | in_cycle` 维度。
- Loop state file 在 cycle 期间记录当前 phase scope，并在 cycle 完成后记录 start/end/duration；旧 schema v1 文件缺少这些可选字段时仍按 idle 读取。
- `RuntimeControlAvailability` 统一计算 pause、resume 与 recover；CLI 和 loopback mutation 使用同一个 guard。Recover 只有在进程停止且存在 interrupted Execution、Delivery 或 ScheduledRun 时可用。
- `RuntimeWorkloadStatus` 只计唯一 Loop 仍负责推进的 Execution、Delivery 和尚未关联 Event/Execution 的 ScheduledRun；terminal history、配置对象、Session、Result 与失败后等待 Owner 的对象不进入 active workload。
- `RuntimeFailureSummary` 是对 failed Execution/Delivery、unknown ScheduledRun、Subscription error、blocked Review 与无 active Agent readiness 的 bounded application projection，不是新的 durable table。detail 仍由 owning domain 或 Event trace 解释。

Runtime operations 的 SQLite 读取位于 `infrastructure/sqlite/runtime-operations-query.ts`；它只查询现有 canonical/durable facts，不新增 schema、业务 identity 或 materialized projection。Console `/api/runtime` 组合 status、controls、workload 与 failures，`/api/failures` 提供同一 Failure list/inspect query。

## Console engineering boundary

Console 固定包含 Runtime、Events、Agents、Chats 与 Subscriptions 五个直接 URL。`vue-router` 拥有 `/console` 默认选择、direct entry、history 与视图 lifecycle；fresh Runtime 进入 Agents，存在 active Agent 时进入 Chats。

`scripts/rs start` 在唯一 loopback HTTP server 上同时挂载 Console API 与 Vite middleware。`local/ui/src/` 是 Console 产品运行源，Vue、TypeScript 与 CSS 修改通过 HMR 进入已打开页面；`local/ui/dist/` 只用于 build verification，不是默认启动输入。Vite 不接管或热替换 Core Loop、Capability、application 或 SQLite resource lifecycle，非 UI 源码变化仍要求重新编译并重启 Local Runtime。

浏览器端只通过 loopback API 读取或调用 application control/query。所有 response 在进入视图前经过 `local/ui/src/api/schema.ts` 的运行时校验；HTTP、JSON 或嵌套 schema 错误只形成 bounded local error。`useApi` 统一取消、latest-request-wins、轮询、visibility、stale 与卸载行为，`useMutation` 统一 pending、局部错误和成功刷新。视图或组件不得恢复直接 `fetch().json() as Xxx`、手写 history 或独立轮询 lifecycle。

Console 保持轻量页面组件和既有 CSS primitive，不拥有领域模型，也不建立通用 design system。新增或修改 loopback API 时必须同步 schema、UI test 与直接 URL/browser smoke；标准 `npm run verify` 包含 Console production build 和 Vitest。

## Process boundary

Agent adapter 使用 absolute executable、args array、`shell:false`、显式 cwd/environment、structured stdin/stdout、timeout 与输出上限。每个 Agent 的 `executionConfig.launchArgs` 持久保存独立 argv；application 层限制数量、单项/总字节，并拒绝覆盖 adapter 拥有的协议、Session、workspace 与 permission/sandbox 参数。配置变化进入 adapter cache key，下一次 invocation 自动重建 adapter，不要求重启 Runtime。

Codex、Claude Code 与 Kimi Code 都实现相同 `RuntimeAgentAdapter`，首次执行创建 provider Session，后续通过本地 Session 精确恢复。Codex 使用 JSONL，Claude Code 使用 result JSON，Kimi Code 使用 prompt-mode stream JSONL 与 `session.resume_hint`。Review admission 按 result schema 与 workspace access 分别校验；Kimi Code 在受信任本机上只声明 `ImplementerResult@1 + write`，adapter 在进程返回后计算并回填 Runtime 可验证的 workspace revision，不声明 Reviewer read capability。

Poll Plugin 只能计划和解析一次受限 probe；真实 HTTP/command 由 Runtime 按 allowlist、workspace、environment、timeout 与 output budget 执行。非 terminal poll 只更新 Subscription 状态和 debug log，只有 terminal `subscription.fire` 才成为 Event。

## Change guidance

- 新 ingress 必须先定义固定输入 schema，再转换为 canonical Event。
- 新 Event type 必须在 Route 中指定唯一 Handler，并有无 fanout 测试。
- 新 Capability 必须修改源码并进入正式 migration、verification 与 release；不通过 Plugin 动态安装。
- 新 Plugin slot 必须声明 host-owned side effects、权限、资源预算、版本、审计与失败语义。
- 新外部输出目标实现 Destination adapter，不进入 Route。
- 需要二次处理时创建带因果关系的新 Event。
- Server Event 接入属于 v0.4；v0.3 不修改 Server 路由实现。
