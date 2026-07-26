---
type: Architecture
title: Rollerskate Local Runtime
description: Local-first Runtime 的默认基础设施、canonical Event、immutable Local Chat、单 Handler Route、Session 与审计边界。
tags: [rollerskate, local-runtime, event, handler, audit]
timestamp: 2026-07-26
---

# Local Runtime

[返回 architecture index](./index.md)

一个设备只运行一个 Local Runtime loop。默认 Runtime home 是 `~/.rollerskate/`；首次启动自动创建 LocalDevice、`<runtime>/workspace`、Owner Principal、唯一 `Local` Chat、承载它的 Local Topic 与 loop state，不依赖 Server 登录。显式 `--runtime <absolute-path>` 用于隔离测试实例；旧 repo-local `.rollerskate/` 不再参与默认发现。

```text
CLI / Agent Run ────┐
Subscription fire ──┼─> canonical Event + Execution ─> Event.type ─> exactly one Handler
Scheduled run ──────┤                                      │
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
- v0.4 Server ingress 必须原样保存 Server 已生成的 Rollerskate Event ID，不能建立第二个语义副本；Matrix 通过 Server TransportBinding 进入，不在当前 Local schema 私建 ingress binding。
- 用户入口不接受任意 Event envelope；每种 ingress 只接受自己的固定 schema。

`RuntimeStore.appendEvent` 原子保存 Event 与唯一 Execution。旧 `inputs → TriggerRouter → Work[]`、generic emit 和独立 Event store 已移除。

源码中的 core 位于 `local/src/core/`，其中 `core/loop.ts` 拥有唯一长期运行的 loop、cycle 调度、pause/stop 生命周期和顶层异常隔离。`bootstrap/runtime.ts` 只创建固定的 application service、第一方 Capability 与 integration，再交给 core loop 驱动；它不拥有第二个 loop，也不允许 Capability 启动自己的 daemon。完整 ownership 见 [Source map](./source-map.md)。

## Application vertical 与 composition

Local 按业务域组织 application，但不为每个业务域扩展一套 Runtime：

- `application/<domain>/control.ts` 拥有 mutation use case，`query.ts` 拥有 CLI/HTTP/Console 共用 read model；领域纯 transition policy 放到 `modules/<domain>/state-machine.ts`。
- Store 是 infrastructure adapter，不能反向成为 application API；CLI、loopback HTTP 与 UI 只调用 control/query，不复制状态机。
- 每个 Runtime、CLI、HTTP 和 UI composition boundary 只有一个显式 module list。新增第一方 vertical 最多在需要的 boundary 各增加一条 registration；不运行任意源码目录扫描，也不开放第三方动态 Capability。
- 新 vertical 默认复用已有 Event、Execution、Session、Agent result、Delivery 与 callback 原语。只有出现至少两个独立消费者、且 retry/recovery/authority 语义一致时，才把新能力提升为 core contract。
- core、通用 ResultHandler 和 Agent adapter 不枚举 `Steward`、`Review`、`Reviewer`、`Implementer` 或 workflow result schema；workflow-specific 指令、角色和 artifact contract 留在 versioned resource 内。

Runtime application module manifest只贡献稳定的 `moduleId` 和可选 result-continuation registration。ResultHandler 按 parent request 的 `resultContractId` 查找至多一个 continuation；duplicate ID 在 bootstrap fail fast，request 没有 contract 才按普通 result/Delivery 处理，显式 contract 未注册则 fail closed。manifest 不是第三方 Plugin API，不能注册 loop phase、任意 Event ingress、store 或外部 side effect。CLI、HTTP 与 UI 使用各自同层的薄 registry，不能反向塞进 Runtime manifest。

这个边界的验收问题是：再增加一个 approval/deployment workflow 时，是否只需新增领域资源/策略和一条 registration，而不修改 core 或每个 Agent adapter。如果不能，说明抽象仍在泄漏。

## Route 与 Handler

Route 只表示需要程序执行的 `Event.type → Handler kind`。`agent.request`、`subscription.fire` 与 `chat.dispatch` 路由到 `AgentHandler`；`agent.result` 路由到 generic `ResultHandler`；`chat.message` 路由到 ChatHandler。legacy `review.requested/review.decision` 只保留历史类型，active Runtime 不注册 ReviewHandler。Agent Run 不增加专用 Event type 或 Handler：Run control 通过带 generic run context 的 `agent.request` 启动，`ResultHandler` 只按 `resultContractId` 路由；注册的 Agent Run continuation 解析 `AgentTurnResult@1`，再根据 host-owned completion callback 原子推进。ChatHandler 在 dispatch 时应用 sender/target/lifecycle 与 Topic/Global presence 状态机，并事务性建立 per-Agent attention receipt、零个或多个 `chat.dispatch`。

`AgentHandler` 调用由 Principal identity 选择的 provider adapter，并由 Execution 持久化有限指数退火重试。传统 Agent input 成功或最终失败仍创建 `agent.result` fallback；Local Chat adapter 返回 `ChatDecision@1`，Runtime 原子保存 Session、Topic/Global presence、decision receipt 与可选 Agent sender `chat.message`，failure 只写 Execution/audit facts。Chat 行为说明只存在于独立 `prompt.chat.free-turn` 资源，build 将资源复制到 `dist/resources`。

Matrix Room 不是本地 Route。当前 outbound adapter 可以投递已经 admission 的 Matrix Destination snapshot；ingress binding、cursor 与 Session persistence 等 v0.4 Server Topic/TransportBinding model 完成后再启用。

## Capability 与 Plugin

Subscription 与 Scheduled Task 是第一方 bundled Capability：它们随 Rollerskate 源码、migration、测试和发布交付，由项目负责运行稳定性。Capability 可以通过固定 ingress 产生预先注册的 Event，但不能绕过 core 或建立并列 loop。Agent Run 是 application/runtime 协作对象，不是另一个 Capability engine；Steward 是 Run 中承担协调职责的 Agent，Review 是 versioned workflow。Scheduled Task 见 [Local Scheduled Task](./scheduled-task.md)，Agent Run 与 Review 见 [Local Agent Run And Review Workflow](./local-review.md)。

用户 Plugin 不是 Capability，也不是 Handler。它只能实现 Capability 预先声明的受限 strategy slot；当前唯一 slot 是 `subscription.probe@1`。Plugin 不能注册 Event type、Route、Handler、loop 或 store，不能直接调用 Agent 或访问 Runtime。完整信任边界见 [ADR 0005](./adrs/0005-capability-and-plugin-boundary.md)。

## Session、恢复与异常隔离

Session 保存本地 Session ID、Agent Principal、adapter、workspace 与 provider session ID。每个 Local Agent 在 `Local` 中有独立 current Session；后续 dispatch 默认续接，New session 只清空该 Agent 的 current pointer 并提高 generation，不删除旧 Session 或 Chat history。

每个 Agent Run 为每个参与 Agent 创建独立 run-scoped Session，并在该 Run 的多轮 callback 中复用。同一 Agent 参与两个 Run 时使用两个 Session；Run Session 不复用 `#local` Chat Session。需要访问源码的 Run 由 Owner 在 admission 时提供 explicit external workspace grant；没有 grant 的 Run 不继承 Chat sandbox 之外的路径权限。

普通中断恢复把 `running` Execution 与 `delivering` Delivery 放回有限重试状态。ScheduledRun 已经进入 provider invocation 时转为 `unknown` 并停止对应 Execution，等待显式 reconciliation；已经 terminal 的 Agent Execution 不重放 provider 调用。

Agent Run 始终指向唯一 active step/Execution。global recovery 复用既有 Execution；Run CAS 与 deterministic callback key 防止 retry、duplicate result 或 restart 创建第二个 child request。cancel 不强杀已经运行的 provider process，但会取消 queued work，并拒绝后续 retry、delegate 与 callback admission。

## 审计

SQLite 是本机持久事实源。Events application query 是 CLI `event list/trace`、正式 `/api/events` 与 Console Events 的共同语义出口；旧 `/api/runtime/events` 只保留为现有 consumer 的过渡 alias。Agents 的 list/detail query 同时服务 CLI 与 `/api/agents`，mutation 后重新返回同一个 detail projection。Chats 的 prompt history 继续使用 bounded `ChatTimeline`，Console timeline 改读 `chat_messages` rebuildable projection；Agent Run CLI 与 Runtime Overview 共用 application query，按 `runId/stepId/parentStepId` 组合 Agent request/result/callback timeline 和往返次数。没有 generic Event write API，Event history 不提供修改或删除。

Loop 输出结构化 JSON log，包括 Subscription、Local Chat、Scheduled Task、Runtime cycle 与 cycle failure。v0.3 先用这些日志做运行审计，不引入 Observer；需要 durable 的产品事实仍必须进入统一数据库。

## Runtime operations projection

Runtime 运维面只投影一个 Local Runtime，不复制 Agents、Events、Chats 或 Subscriptions 的常态 inventory：

- process state 是 `running | paused | degraded | stopped`；Core Loop phase 是独立的 `idle | in_cycle` 维度。
- Loop state file 在 cycle 期间记录当前 phase scope，并在 cycle 完成后记录 start/end/duration；旧 schema v1 文件缺少这些可选字段时仍按 idle 读取。
- `RuntimeControlAvailability` 统一计算 pause、resume 与 recover；CLI 和 loopback mutation 使用同一个 guard。Recover 只有在进程停止且存在 interrupted Execution、Delivery 或 ScheduledRun 时可用。
- `RuntimeWorkloadStatus` 只计唯一 Loop 仍负责推进的 Execution、Delivery 和尚未关联 Event/Execution 的 ScheduledRun；terminal history、配置对象、Session、Result 与失败后等待 Owner 的对象不进入 active workload。
- `RuntimeFailureSummary` 是对 failed Execution/Delivery、unknown ScheduledRun、Subscription error、legacy blocked Review 与无 active Agent readiness 的 bounded application projection，不是新的 durable table。Agent Run terminal/needs-human/cancelled 由 Runtime Overview 和 Run trace 直接解释。detail 仍由 owning domain 或 Event trace 解释。

Runtime operations 的 SQLite 读取位于 `infrastructure/sqlite/runtime-operations-query.ts`；它只查询现有 canonical/durable facts，不新增 schema、业务 identity 或 materialized projection。Console `/api/runtime` 组合 status、controls、workload 与 failures，`/api/failures` 提供同一 Failure list/inspect query。

## Console engineering boundary

Console 固定包含 Runtime、Events、Agents、Chats 与 Subscriptions 五个直接 URL。`vue-router` 拥有 `/console` 默认选择、direct entry、history 与视图 lifecycle；fresh Runtime 进入 Agents，存在 active Agent 时进入 Chats。

`scripts/rs start` 在唯一 loopback HTTP server 上同时挂载 Console API 与 Vite middleware。`local/ui/src/` 是 Console 产品运行源，Vue、TypeScript 与 CSS 修改通过 HMR 进入已打开页面；`local/ui/dist/` 只用于 build verification，不是默认启动输入。Vite 不接管或热替换 Core Loop、Capability、application 或 SQLite resource lifecycle，非 UI 源码变化仍要求重新编译并重启 Local Runtime。

浏览器端只通过 loopback API 读取或调用 application control/query。所有 response 在进入视图前经过 `local/ui/src/api/schema.ts` 的运行时校验；HTTP、JSON 或嵌套 schema 错误只形成 bounded local error。`useApi` 统一取消、latest-request-wins、轮询、visibility、stale 与卸载行为，`useMutation` 统一 pending、局部错误和成功刷新。视图或组件不得恢复直接 `fetch().json() as Xxx`、手写 history 或独立轮询 lifecycle。

Console 保持轻量页面组件和既有 CSS primitive，不拥有领域模型，也不建立通用 design system。新增或修改 loopback API 时必须同步 schema、UI test 与直接 URL/browser smoke；标准 `npm run verify` 包含 Console production build 和 Vitest。

## Process boundary

Agent adapter 使用 absolute executable、args array、`shell:false`、显式 cwd/environment、structured stdin/stdout、timeout 与输出上限。每个 Agent 的 `executionConfig.launchArgs` 持久保存独立 argv；application 层限制数量、单项/总字节，并拒绝覆盖 adapter 拥有的协议、Session、workspace 与 permission/sandbox 参数。配置变化进入 adapter cache key，下一次 invocation 自动重建 adapter，不要求重启 Runtime。

Codex、Claude Code 与 Kimi Code 都实现相同 `RuntimeAgentAdapter`，首次执行创建 provider Session，后续通过本地 Session 精确恢复。Codex 使用 JSONL，Claude Code 使用 result JSON，Kimi Code 使用 prompt-mode stream JSONL 与 `session.resume_hint`。Adapter 只声明 structured output、Session resume 与 workspace read/write 等原语能力；它不枚举 Steward/Reviewer/Implementer 或 workflow result schema。Agent Run protocol prompt 要求统一返回 `AgentTurnResult@1`；Core 仍保存不透明 output，由 Agent Run continuation 在 adapter 与 Core 之外校验并推进。

Poll Plugin 只能计划和解析一次受限 probe；真实 HTTP/command 由 Runtime 按 allowlist、workspace、environment、timeout 与 output budget 执行。非 terminal poll 只更新 Subscription 状态和 debug log，只有 terminal `subscription.fire` 才成为 Event。

## Change guidance

- 新 ingress 必须先定义固定输入 schema，再转换为 canonical Event。
- 新 Event type 必须在 Route 中指定唯一 Handler，并有无 fanout 测试。
- 新 Capability 必须修改源码并进入正式 migration、verification 与 release；不通过 Plugin 动态安装。
- 新 application vertical 先证明不能由现有 generic Event/Execution/Session/callback 表达；未证明前不得增加 domain Event、Handler kind、adapter capability 或 ResultHandler 分支。
- 新 Plugin slot 必须声明 host-owned side effects、权限、资源预算、版本、审计与失败语义。
- 新外部输出目标实现 Destination adapter，不进入 Route。
- 需要二次处理时创建带因果关系的新 Event。
- Server Event 接入属于 v0.4；v0.3 不修改 Server 路由实现。
