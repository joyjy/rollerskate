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

Local Topic 的 `TopicGovernance` 是 application-owned durable current state：status、participant roster、participant-message/scheduled policy、conversation intent default/themes 和 revision 作为一个 aggregate 持久化。首次 materialize 只快照当时 active Local Agents；后续 Agent lifecycle 不改写 roster。每次 mutation 必须以 expected revision CAS，并在同一 transaction 追加 bounded `TopicGovernanceControlReceipt@1`；同状态操作不增加 revision，stale revision 返回 current aggregate 且不写入。Pause/Resume 与 participant Add/Remove 由现有 Chat CLI 和 loopback API 调用同一个 application control；Resume 本身不创建 activation。这一状态不替代 Chat Event history，不归 Core 所有，也不改变 Agent lifecycle、Session、history grant、Chat history 或 Server Topic membership。

Local Chat 是 source-driven group conversation。Owner message、Agent message 或显式 Topic schedule 先形成 immutable canonical source Event，Topic governance 再按 participant roster、presence 与 policy 决定每个 Agent 是否获得 attention；没有新 source 时不建立 Execution，也不调用 Agent。`starter`、`manual` 与 Free Chat timer activation 已从 Runtime、CLI、API 和 Console 退役，application admission 对残留 synthetic activation fail closed。schema v70 仅为历史 active Free Chat mode 追加一次 `feature_retired` stop receipt，并保留旧 mode/receipt 数据用于审计。

`TopicActivationSchedule` 仍属于 Topic application vertical，但与允许 arbitrary prompt、callback 和 Session policy 的 Scheduled Task 分开建模。每个 once/cron schedule 固定 timezone、misfire、candidate、intent 和 turn budget；唯一 loop 每轮只运行一次 `topic.schedule` phase，并用 `(scheduleId, occurrenceKey)` receipt 与 canonical activation external identity 收敛为至多一个 scheduled `chat.activation`。Pause/cancel 作为 durable CAS control；resume 会把暂停窗口内已错过的 current occurrence 记为 `paused-window` skip，并直接推进到下一个未来 occurrence，不展开 backlog。运行期 misfire skip、paused Topic、scheduled policy disabled、空 eligible roster或已有 active conversation root 也都只写一个 bounded skip receipt。

Interactive Channel 是 `application/channel` vertical，不是 Core Route 或可安装 integration。唯一 loop 的 `channel.interactive` phase 只负责恢复 pending send、推进 bounded follow 与 admission callback。Binding 精确绑定一个 active Local Agent、channel allowlist、revision、expiry 与可选由该 Agent 拥有的 durable `ses_*`；Local Chat binding/send 还会复核 current Topic participant roster。send 以 `(bindingId, idempotencyKey)` 固定 sender、Channel ref、body、transport transaction、observed cursor 和 follow token。`local-chat` 通过既有 Local Chat admission 写 canonical message；`server-topic` 必须同时满足本地 inbox membership 与该 Agent credential。follow long-poll 每次限制 30 秒、100 个 Event 与 64 KiB delta；Server 没有 thread correlation 时只把 cursor 之后的内容标为“新消息”，不能声称 `first_reply` 或 `terminal`。可选 callback 只在 exact binding/session 仍有效、Agent 仍 active、Session 属于同一 Agent 且当前 idle 时，以稳定 external ID admission 一个 canonical `agent.request`；busy 时 durable pending，不创建任意客户端回调。

联网 Agent work request 复用唯一 loop 的 `agent-work-request` phase，但不成为 Event ingress。每个 Runtime process 为 active paired Agent 注册一个临时 route ID；phase 只续租、读取属于该 exact route 的 bounded request diagnostics、恢复已经 accepted 但未挂 receipt 的 Run，并把本机 terminal Run 的 bounded summary 回写 Server。普通 Chat/Topic/Vikunja 文本不会经过该 application control。Owner 必须用 `work-request accept|reject|await-owner` 显式决定；固定 Local policy revision 1 将 workflow 限于 `review@1|forum@1`、budget 限于 20 steps/0 depth、首版不接受 remote grant。Server accepted receipt 会编译成 `RunIntent@1` 和 Owner workflow policy，再以 `work-request:<id>` 幂等键建立 `OrchestratorBinding@3` Steward Run；Run 与 transcript 仍只在 Local SQLite，Server 只持有 Run ID receipt 和 bounded public result。

Local Chat 默认仍只拥有 conversation Event/decision。没有 proposal 时，用户可对 exact Owner message 显式选择 `Hand off to Run`，application 以 `chat-work:<eventId>` 固定 request ID；Agent 返回 `propose_run` 时，每个 dispatch 独立投影一张卡片，Owner 选择并预检 exact workspace 后，以 `chat-work:<eventId>:<dispatchEventId>` 确认该卡片。两条路径都经同一 RunAdmissionCompiler 建立 Steward Run。Agent chat reply、普通 message、proposal 或 activation 都不能自动产生 Run，也不能调用 callback、command 或 destination。

```text
RunIntent / Owner policy ─> Steward Run ─> canonical Agent Event + Execution
Schedule occurrence ──────> bound Run cycle ────────────────┤
Subscription observation ─> bound Run cycle ────────────────┤
Chat conversation ─────────> chat.dispatch Event ────────────┤
Topic schedule ────────────> chat.activation Event ──────────┤
Legacy persisted definition ─> legacy callback reconcile only
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

`local/src/core/event/model.ts` 是 Event source of truth。所有 Event 都包含全局 `evt_` UUIDv7、固定 `type`、source、可选 Principal/Session/Destination，以及 `rootEventId/parentEventId/hop` 因果关系。`chat.message` 保存 `topicId`、sender、body、可选 `replyToEventId` 与 resolved `targets[]` Principal/handle snapshot；历史单数 `target` 只在读取时归一化为单元素列表，新 Event 不再写入。每个目标独立形成 `chat.dispatch`，保存同一 `topicId`、源 message、目标 Principal、稳定 `promptResourceId` 与 rendered Agent prompt。旧 dispatch card payload 保持可读，但不再生成。

- CLI、Subscription 与 Scheduled Task 在本地构造 Event 并生成统一 ID。
- v0.4 Server ingress 必须原样保存 Server 已生成的 Rollerskate Event ID，不能建立第二个语义副本；Matrix 通过 Server TransportBinding 进入，不在当前 Local schema 私建 ingress binding。
- 用户入口不接受任意 Event envelope；每种 ingress 只接受自己的固定 schema。

`RuntimeStore.appendEvent` 原子保存 Event 与唯一 Execution。旧 `inputs → TriggerRouter → Work[]`、generic emit 和独立 Event store 已移除。

Runtime loop 每次 poll 都先收集已完成 outcome，再在容量内继续 claim 新的 due Execution 与 Delivery；长时间 provider invocation 不会阻止后续独立工作被 claim。本进程通过 keyed wake signal 在 RuntimeStore 持久化新工作或 RuntimeCycle 释放容量时唤醒唯一 loop，generation 在 cycle scan 前固定，避免扫描与进入等待之间丢失通知；等待时间同时受最近 due Execution/Delivery 和最长 250 毫秒兜底扫描约束，因此跨进程写入或丢失的进程内通知仍会被 SQLite 扫描发现。AgentHandler 对同一 provider Session 串行化调用；尚无 Session 的 Run 调用按 Run/cycle/Agent 组成 lane，其他独立请求按 Event 分开；Chat 保留同 Agent 串行入口。准入容量与 workspace 冲突规则见「Execution 准入资源」。每条 Execution 仍独立完成、重试和隔离异常；Runtime 关闭时先停止 loop wake subscription，再 settle 已经接受的工作并关闭 stores。

源码中的 core 位于 `local/src/core/`，其中 `core/loop.ts` 拥有唯一长期运行的 loop、cycle 调度、pause/stop 生命周期和顶层异常隔离。`bootstrap/runtime.ts` 只创建固定的 application service、第一方 Capability 与 integration，再交给 core loop 驱动；它不拥有第二个 loop，也不允许 Capability 启动自己的 daemon。启动时 Runtime 对 `local/dist/src` 与 `packages/protocol/dist/src` 的可执行 JavaScript 生成 `RuntimeArtifactRevision@1` 指纹并固定到 `loop-state.json`；status/Console 重新计算当前 expected revision，只有 expected/running 相等、PID 存活、heartbeat fresh、schema current 且目标 Run trace 可读时，才能证明运行实例加载了目标版本。完整 ownership 见 [Source map](./source-map.md)。

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

Route 只表示需要程序执行的 `Event.type → Handler kind`。`agent.request`、`subscription.fire` 与 `chat.dispatch` 路由到 `AgentHandler`；`agent.result` 路由到 generic `ResultHandler`；`chat.activation` 与 `chat.message` 路由到 ChatHandler。Agent Run 不增加专用 Event type 或 Handler：Run control 通过带 generic run context 的 `agent.request` 启动，`ResultHandler` 只按 `resultContractId` 路由；autonomous continuation 解析 `AgentTurnResult@1`，Caller continuation 解析 `AgentStepResult@1` 并形成 durable checkpoint，下一步只由 application control 接受严格 `RunDecision@1` 后原子 admission。ChatHandler 在 dispatch 前通过 application-owned Topic governance policy 统一过滤 paused Topic、strategy policy、participant roster 与 Agent lifecycle，再应用 sender/target、Topic/Global presence 和 root conversation budget；governance/participant revision 与 attention presence snapshot 随现有 receipt/Event 持久化。AgentHandler 只消费 transport-neutral execution guard decision；dispatch 在 provider invoke 前按最新 governance/participant revision 与排队后变化的 snooze 复检，拒绝时以 `cancelled` Execution 和 durable skip receipt 终止，不让 Core 导入 TopicGovernance。

`AgentHandler` 调用由 Principal identity 选择的 provider adapter。generic Agent input 可以使用 Execution 的有限指数退火，Agent Run 与 Subscription callback 则在 admission 时固定 `maxAttempts=1`，避免 provider error、output overflow 或未知 side effect 被 Core 盲目重放。传统 Agent input 成功或最终失败仍创建 `agent.result` fallback；Local Chat adapter 返回 `ChatDecision@1`，Runtime 原子保存 Session、Topic/Global presence、decision receipt 与可选 Agent sender `chat.message`，failure 只写 Execution/audit facts。Chat history 与 Kimi tool request continuation 由 application decorator 在 AgentHandler 外完成；Core 不枚举 `ClientHistoryRequest@1` 或领域 read tool。Chat 行为说明只存在于独立 prompt 资源，build 将资源复制到 `dist/resources`。

Chat 的 `list_chat_work` 通过 Host 注入的当前 `chat.dispatch` 绑定 Agent/Topic/Session，调用时复检 running Execution、Agent active、Topic active 和 participant membership；模型只能传 bounded page limit（默认 10、最多 20）和同 scope cursor。新发现能力不等于全局 Run 列表，也不改变既有 exact-ID `get_run`/`event_trace` read grant。`list_chat_work`、`get_run.work` 与 Chat proposal card 共用 Steward work projection：manual fallback 依据已结算的 intervention receipt 展示需要人处理，保留实际 `awaiting_orchestrator` 非终态；Run terminal 不由单个 provider turn 成功推导。产物只返回最多 20 条 metadata references，正文仍由 Run detail/source 拥有。查询借用调用方数据库连接，领域 lifecycle 只有一个 owner；不新增恢复 loop 或 mutable work table。

Chat 写工具由 `tool-policy.ts` 声明，原生 MCP、pi extension 和 Kimi request continuation 使用相同调用边界。`start_chat_run` 把当前 Local Owner 的不可变原消息（及有界回复上下文）作为 mandate，Agent 解释执行意图，Host 验证 running dispatch、Owner identity、有效参与者与 Session；Host 不用关键词假装完成自然语言授权判定。读写 workspace 要求 Owner 本条消息中出现 exact canonical Git root，否则返回缺权，沿用现有 proposal preflight/confirmation。网络、发布和外部投递不随工具自动授权。`control_chat_run` 仅控制原 Agent/Session 关联的 exact Run，在同一事务中复检版本，复用取消、初始只读 Steward fallback retry，以及 `steward/human-input.ts` 的 exact question answer continuation；普通 Caller checkpoint 仍由原 Run decision owner 处理。每轮最多 20 次调用、单响应 256 KiB、总响应 1 MiB，写动作在变更前预留响应预算。

Chat 的 `resource-tools.ts` 提供 `list/get/control_subscription` 与 `list/get/control_schedule`：读取 Local Owner Runtime 内的 bounded 公共摘要，返回现有 Console deep link；显式 Owner 指令下可 pause/resume/cancel。`action-scope.ts` 在同一 immediate transaction 内复检原消息、running dispatch、Agent/Topic/participant 与 Session；各领域 control 拥有 legacy resume 禁入与状态转换。`stateToken` 是当前 source-owned object 的内容指纹，读取与控制时复检，不持久化，也不是授权凭证；stale 调用拒绝后需要重新读取和判断。新建定义、run-now、archive 和 unknown-effect resolution 不在本工具集。控制结果描述 source 状态，关联 Run/cycle 的终态仍查原 owner。

`channel-tools.ts` 只发现当前 Agent 的既有 binding，并提供 send、follow snapshot 与 stop-follow。发送要求 Owner 明确指令，Host 固定 sender、原消息和 dispatch，复检 binding revision、allowlist、expiry 与绑定 Session；不会代 Owner 发言或自动创建 grant。`channel/control.ts` 的共同 admission 原子保存 pending send/follow，唯一 loop 在 effect boundary 再核验绑定与 membership 后投递。Chat send 使用 `chat-channel:<messageId>:<dispatchId>:<targetDigest>` 去重，不因更换 binding 重发相同指令和目标。Chat 不启用普通 Channel 的 `agent.request` callback；send/follow settled 后由同一 `chat.work-return` phase 以 `chat-channel-return:<sendId>` 回到原 Chat Session。pending 不等于已发，accepted 不等于收到回复，quiet/expired/stopped 不等于业务成功。撤销绑定后仅能查本 Agent 的发送/跟随状态，不能读取新的 channel 正文。

Session-bound attention 是可复用的 Runtime 原语：Chat 委派 Run 需要回到原负责 Session；普通 Interactive Channel callback 在原 Session 空闲后消费 `agent.request`，Chat 发起的 Channel 工作则消费同一个 `chat.activation` 原语。原语只表达 exact Session 绑定与串行执行，不把 Run/Channel lifecycle 放入 Core。`chat.activation` 可固定一个非 Run Session 及匹配 Agent；只有 activation 的绑定决定接收会话，普通 Agent message 的 Session 仍只表示发送者。Topic policy 在 admission 与 invoke 前复检会话与有效参与者。

新 `chat-execute:<messageId>:<dispatchId>` Run 的阻塞/终态与 `chat-channel` send/follow 的 settled 状态由 `chat.work-return` phase 每轮按 keyset 检查最多 20 个候选，游标只用于公平扫描，重启可从头扫描。原 dispatch completion receipt 提供 exact Session，缺失、轮换、忙碌或退出参与时不借用新会话。返回以 `chat-work-return:<runId>:<version>` 原子创建 canonical activation/Execution，不新增第二个 workflow 状态机；重复启动读取同一 ledger，旧 `chat-work` Run 不自动回放。Return 是证据而非新 Owner grant。activation 已受理后按既有 Execution/expiry/skip 规则结算；失败或过期不会自动重试模型 turn，Run 事实仍可由 `list_chat_work`、原消息卡片和 detail 查询，不把通知失败当成业务完成。

Matrix Room 不是本地 Route。当前 outbound adapter 可以投递已经 admission 的 Matrix Destination snapshot；ingress binding、cursor 与 Session persistence 等 v0.4 Server Topic/TransportBinding model 完成后再启用。

## Capability 与 Plugin

Subscription 与 Scheduled Task 是第一方 bundled Capability：它们随 Rollerskate 源码、migration、测试和发布交付，由项目负责运行稳定性。Capability 不能绕过 core 或建立并列 loop。Topic scheduled activation 与 Interactive Channel 是独立 application vertical。Steward 的 durable aggregate 保留 `agent_runs`、`runId` 和 `AgentRunContext@1`。current `ScheduleRevision@3`、`SubscriptionDefinition@5` 与 `ContinuousSubscriptionDefinition@3 | @4` 共用 `ProactiveTarget@1`：Run target 原子激活已绑定 cycle；Owner-registered application action 只执行同库同步 mutation并保存 terminal receipt；Owner-registered external workflow 固定 versioned ref、input、command artifact digest、filesystem/network authority 与 retry policy，通过独立 lease/effect-boundary receipt 执行。三者均不把 raw Agent、prompt、shell、argv 或 grant 暴露给公共 Schedule。历史 callback 与旧 Run-binding generation 按 discriminator 保持隔离。Scheduled Task 见 [Local Scheduled Task](./scheduled-task.md)，Subscription 见 [Subscription](./poll-subscription.md)，Steward 与 Review 见 [Local Steward And Review Workflow](./local-review.md)。

Runtime 在唯一 loop 的 Agent 执行 phase 之前至多每秒为每个 Steward Run 原子维护固定的 `~/.rollerskate/runs/<runId>/progress.json`，保证已经 admission 的 Run 在可能长时间占用 provider 前先形成可观察文件。每个文件使用 `RunProgressSnapshot@1`，从对应 `agent_runs` authority 重建，包含 Run identity、状态、当前 step / Execution、step budget 与更新时间；不保存 transcript、Agent 原始输出或 terminal summary。启动时最多回填最近 1000 条 Run，后续只扫描最近 100 条 hot Run，并按 Run version / updated time 只投影发生 transition 的文件。`~/.rollerskate/progress.json` 仅使用 `RunProgressIndex@1` 列出最近 Run 的 ID、状态和各自的 progress path，不作为聚合业务进度。内容没有变化时不重写，因此文件 mtime 也可用于观察该 Run 是否发生 transition。进程健康与当前 phase 仍由并列的 `loop-state.json` 表达，消费者不能用 progress 文件替代 liveness，也不能回写这些文件推进业务状态。

Release Candidate 不是 Local application phase。外部业务包可提供 Owner-registered Subscription probe Plugin，并以 `RunIntent@1(triggerIntent=continuous)` 建立消息与 Run-terminal 两条 Steward Run source；每个 bounded observation 只激活绑定 Run cycle，业务账本和回复由外部包或登记的 terminal destination 持有。Local 不解释 MR、AR、Issue、Release Pack 或飞书消息关系。历史 `ProactiveCallbackInput@1` command definition 只保留 inventory/reconcile，不是新 admission。全新数据库不创建 `release_candidate_*` 表；旧 schema 58/59 已有的完整历史表只被兼容性识别并原样保留，不属于当前 schema，也没有 Runtime writer。

用户 Plugin 不是 Capability，也不是 Handler。它只能实现 Capability 预先声明的受限 strategy slot；当前唯一 slot 是 `subscription.probe@1`。Plugin 不能注册 Event type、Route、Handler、loop 或 store，不能直接调用 Agent 或访问 Runtime。完整信任边界见 [ADR 0005](./adrs/0005-capability-and-plugin-boundary.md)。

## Session、恢复与异常隔离

Chat 与 Run 共用的执行不变量是：provider failure 不得自动重放可能已产生副作用的 invocation；Chat Agent 新执行最多一次，历史 retry 在调用 provider 前阻断。Core 在接纳 resumed receipt 前校验 provider Session identity；Kimi typed continuation 在执行下一工具前也校验。具体能力与输出预算见 [Provider 矩阵](./provider-capabilities.md)。

Session 保存本地 Session ID、Agent Principal、adapter、workspace 与 provider session ID。每个 Local Agent 在 `Local` 中有独立 current Session；后续 dispatch 默认续接，New session 只清空该 Agent 的 current pointer 并提高 generation，不删除旧 Session 或 Chat history。

每个普通 Agent Run 为每个参与 Agent 创建独立 run-scoped Session，并在该 Run 的多轮 callback 中复用；series Run 则按 revision cycle 创建 cycle-scoped Session，同 revision 可续用、新 revision 必须隔离。同一 Agent 参与两个 Run 时使用两个 Session；Run Session 不复用 `#local` Chat Session。需要访问源码的 Run 由 Owner 在 admission 时提供 explicit external workspace grant；没有 grant 的 Run 不继承 Chat sandbox 之外的路径权限。

普通中断恢复把可安全重试的 Execution 与 `delivering` Delivery 放回有限重试状态。legacy ScheduleOccurrence 已经进入 provider invocation 时转为 `unknown` 并停止对应 Execution，等待显式 reconciliation；Run-bound occurrence 从 durable cycle/receipt 恢复，不能人工 resolve。已经 terminal 的 Agent Execution 不重放 provider 调用。

Agent Run 始终指向唯一 active step/Execution。global recovery 复用既有 Execution；Run CAS 与 deterministic callback key 防止 retry、duplicate result 或 restart 创建第二个 child request。external workflow 在 effect boundary 前中断可按固定 budget 重试，boundary 后中断只能写 `unknown` 并等待 Owner 根据外部事实 resolve，不能盲目重放。cancel 不强杀已经运行的 provider process，但会取消 queued work，并拒绝后续 retry、delegate 与 callback admission。

Caller-orchestrated Run 固定 admission 时的 active participant roster，`maxDepth=0`，并为每个参与 Agent 复用自己的 `(runId, agentId)` Session。Worker 结果只把 Run 转为 `awaiting_orchestrator`；CLI/Console 从 typed checkpoint 展示等待状态。Local Owner 的 exact current-version decision 可以在同一 Run admission self/agent next step，或终结为 succeeded/failed/needs-human；duplicate request 只重放 receipt，stale、非 roster target 和任何 authority expansion 都拒绝。

## 审计

SQLite 是本机持久事实源。Events application query 是 CLI `event list/trace`、`/api/events` 与 Console Events 的共同语义出口；轮询列表只返回 bounded audit summary，选中的 detail 才按 `rootEventId` 定向读取完整 conversation timeline。Agents 的 list/detail query 同时服务 CLI 与 `/api/agents`，mutation 后重新返回同一个 detail projection。Chats 的 prompt history 继续使用 bounded `ChatTimeline`，Console timeline 改读 `chat_messages` rebuildable projection；当前 conversation 与 participant last turn 使用 Topic/root/Agent 定向查询，不从通用 100/200 条历史窗口猜测。CLI `run` 与 Steward Console 共用 `application/steward/query.ts`，按 `runId/stepId/parentStepId` 组合 Agent request/result/callback timeline 和往返次数。current Schedule/Subscription query 返回统一 target，并按分支显示 exact Run/cycle/admission link 或 deterministic action receipt；旧版本返回对应的 Run-binding 或 legacy Event/callback audit。没有 generic Event write API，Event history 不提供修改或删除。

Loop 输出结构化 JSON log，包括 Subscription、Local Chat、Topic schedule、Interactive Channel、Scheduled Task、Runtime cycle 与 cycle failure。日志只做运行审计，不引入 Observer；需要 durable 的产品事实仍必须进入统一数据库。

## Runtime operations projection

Runtime 运维面只投影一个 Local Runtime，不复制 Agents、Events、Chats 或 Subscriptions 的常态 inventory：

- process state 是 `running | paused | degraded | stopped`；Core Loop phase 是独立的 `idle | in_cycle` 维度。
- Loop state file 在 cycle 期间记录当前 phase scope，并在 cycle 完成后记录 start/end/duration；旧 schema v1 文件缺少这些可选字段时仍按 idle 读取。
- `RuntimeControlAvailability` 统一计算 pause、resume 与 recover；CLI 和 loopback mutation 使用同一个 guard。Recover 只有在进程停止且存在 interrupted Execution、Delivery、legacy ScheduleOccurrence 或 external workflow execution 时可用；external recovery 会区分 pre-effect retry、attempt-exhausted failure 与 post-effect unknown。
- `RuntimeWorkloadStatus` 只计唯一 Loop 仍负责推进的 Execution、Delivery 和尚未关联 V1 Event或 V2 cycle 的 ScheduleOccurrence；terminal history、配置对象、Session、Result 与失败后等待 Owner 的对象不进入 active workload。
- `RuntimeFailureSummary` 是对 failed Execution/Delivery、unknown legacy ScheduleOccurrence、Subscription error 与无 active Agent readiness 的 bounded application projection，不是新的 durable table。Agent Run terminal/needs-human/cancelled 由 Steward Console 和 Run trace 直接解释。detail 仍由 owning domain 或 Event trace 解释。

Runtime operations 的 SQLite 读取位于 `infrastructure/sqlite/runtime-operations-query.ts`；它只查询现有 canonical/durable facts，不新增 schema、业务 identity 或 materialized projection。Console `/api/runtime` 组合 status、controls、workload 与 failures，`/api/failures` 提供同一 Failure list/inspect query。

## Console engineering boundary

Console 固定包含 Runtime、Events、Agents、Chats、Steward、Schedules 与 Subscriptions 七个直接 URL。Steward `Runs` 是唯一执行列表与结果页；Schedules 与 Subscriptions 只显示 definition、next action、pending/checkpoint/reconcile、linked Run/cycle 与标记为 `legacy / non-public` 的历史 callback diagnostics。Run Workspace 反向展示 trigger source 与 exact diagnostics deep link。Runtime 不复制 Latest Run。`vue-router` 拥有 `/console` 默认选择、direct entry、history 与视图 lifecycle；fresh Runtime 进入 Agents，存在 active Agent 时进入 Chats。

`scripts/rs start` 由 CLI 自己 detached 启动唯一 Runtime 进程，等待 Core Loop lock/state ready 后返回；`stop/restart` 以同一 Loop PID 为事实源，不依赖 shell、PTY 或外部 supervisor。`--foreground` 只保留给开发与自动化验证。Runtime 在唯一 loopback HTTP server 上同时挂载 Console API 与 Vite middleware。`local/ui/src/` 是 Console 产品运行源，Vue、TypeScript 与 CSS 修改通过 HMR 进入已打开页面；`local/ui/dist/` 只用于 build verification，不是默认启动输入。Vite 不接管或热替换 Core Loop、Capability、application 或 SQLite resource lifecycle，非 UI 源码变化仍要求重新编译并通过 `restart` 重启 Local Runtime。

浏览器端只通过 loopback API 读取或调用 application control/query。所有 response 在进入视图前经过 `local/ui/src/api/schema.ts` 的运行时校验；HTTP、JSON 或嵌套 schema 错误只形成 bounded local error。`useApi` 统一取消、latest-request-wins、轮询、visibility、stale 与卸载行为，`useMutation` 统一 pending、局部错误和成功刷新。视图或组件不得恢复直接 `fetch().json() as Xxx`、手写 history 或独立轮询 lifecycle。

Console 保持轻量页面组件和既有 CSS primitive，不拥有领域模型，也不建立通用 design system。新增或修改 loopback API 时必须同步 schema、UI test 与直接 URL/browser smoke；标准 `npm run verify` 包含 Console production build 和 Vitest。

## Process boundary

Agent adapter 使用 absolute executable、args array、`shell:false`、显式 cwd/environment、structured stdin/stdout、timeout 与输出上限。每个 Agent 的 `executionConfig.launchArgs` 持久保存独立 argv；application 层限制数量、单项/总字节，并拒绝覆盖 adapter 拥有的协议、Session、workspace 与 permission/sandbox 参数。配置变化进入 adapter cache key，下一次 invocation 自动重建 adapter，不要求重启 Runtime。普通 Steward Run 默认没有网络；只有非委派的 Codex Run（`maxDepth=0`）在 `workspace.access=write` 下显式声明 `workspace.networkAccess=true` 时，网络 authority 才随 workspace grant 固化并传给 Codex adapter。read-only、非 Codex 或可委派 Run 不能申请网络。

Codex、Claude Code、Kimi Code 与 pi 都实现相同 `RuntimeAgentAdapter`，首次执行创建 provider Session，后续通过本地 Session 精确恢复。`integrations/agent/runner/` 以 ACP 的 turn/session 语义定义内部 provider-neutral 协议：request 包含 prompt、Session、workspace access、可选 model、独立 total/meaningful-idle budget 与 bounded progress callback，receipt 统一投影 assistant message、observed tool、usage 与 terminal；`process.ts` 统一拥有无 shell spawn、bounded stderr 与分级停止。ACP、Pi RPC 与 Codex app-server 只在各自 runner 内处理 wire protocol，adapter 只负责 Runtime Event prompt、grant/policy、progress/failure 转换与结果选择。MCP server 必须同时声明由 Runtime 控制的 tool manifest；Claude Code 据此生成 exact `--allowedTools`，避免 server 已注入但工具不可调用或额外工具被隐式放行。

Codex 使用 app-server 的 LF-delimited JSON-RPC transport，每次调用严格执行 `initialize`、`initialized`、`thread/start|resume`、`turn/start`，接收 assistant/reasoning/plan/tool 的流式通知，并只在 `turn/completed` 后形成 `codex-runtime-app-server-v1` receipt。流式通知只投影 bounded progress kind 与计数，不持久化 delta 正文；默认连续 300 秒没有 meaningful update 时触发 stall，每次 assistant/reasoning/plan/tool update 都会续期。只有 workflow 显式声明 invocation budget 时才启用不可续期的 total deadline。stall、deadline/protocol error 对 active Turn 发送 `turn/interrupt` 后有界收进程。provider `interrupted`、协议退出与失败保持不同 termination reason；意外的 server approval request、非 completed turn、超限 protocol record 或 assistant aggregate 都 fail closed。workspace sandbox、`approvalPolicy=never`、network grant、model 与 invocation-scoped MCP server 通过 Thread params/config 传入，不再拼接 `codex exec --json` argv。Claude Code 仍使用 result JSON。Kimi Code 使用 ACP v1：`session/new` 创建 Session，后续以 `session/resume` 精确恢复，`session/prompt` 的 `end_turn` 是 terminal boundary；Chat 合并 assistant message，Run/Subscription 只取末条。adapter 只保留 assistant text 和 bounded tool identity，不保留 `rawInput`、`rawOutput` 等 trace；结果字节上限只约束 assistant text，因此超大 tool trace 不再吞掉短结果。Kimi 采用相同的 300 秒 meaningful-event watchdog 与显式 total deadline 语义；thought 会续期 idle。read grant 在新 Session 选择 `plan` mode，并只批准 read/search/think/fetch tool kind；write grant 选择 `default` mode 并按次批准工具请求；恢复时 access 已由 versioned Session reference 锁定，不重复设置 provider mode。bundled read/write profile 作为 prompt policy 注入，profile 内容、Session reference version 与 policy digest 编入 `kimi-code-runtime-acp-v1` identity；旧格式或 access 不匹配会新建 Session。可选 launch args 只允许 `--model <model>`，由 `session/set_config_option` 应用。macOS 上固定启用 Kimi legacy engine，规避 v2 workspace watcher 在空目录也可能触发的 `EMFILE` 回归；transport 仍是同一 ACP v1。Pi RPC 同样只在 `agent_settled` 后完成；read grant 加载 content-attested `read_git_diff`，扩展内容同时进入 `pi-runtime-rpc-v1:<digest>` identity 与 Runtime revision，同路径内容漂移会要求 Runtime reload。

pi 使用 RPC mode，以 LF-delimited JSON command/event 交互；adapter 先验证 `get_state` 返回 Runtime 预生成并持久续用的 exact `--session-id`，再发送 `prompt`，只在 `agent_settled` 后形成结果。它不再把整个 provider stdout 当作一次进程结果，也不使用 `--print` 或 `--session`。增量 decoder 丢弃超过单条预算的 RPC record 并继续读取 terminal assistant；发生丢弃时 tool diagnostics 保持未知。`--tools` 白名单映射 read/write grant，read-only Git 与 Chat tools extension 由 adapter 独占装配，调用方不能注入 extension、skill、context file 或 system prompt。Chat read tool grant 携带 application manifest digest，工具名与 extension 内容都进入 provider policy identity。协议 identity 为 `pi-runtime-rpc-v1:<policy-digest>`；bundled extension 或 manifest 改变会漂移 identity、退役旧 Session，并要求加载匹配的新 Runtime artifact。Adapter 只声明 transport、Session resume 与 workspace read/write 等原语能力；它不枚举 Steward/Reviewer/Implementer 或 workflow result schema。Agent Run protocol prompt 按 run context 要求 autonomous `AgentTurnResult@1` 或 caller `AgentStepResult@1`；Core 仍保存不透明 output，由对应 Agent Run continuation 在 adapter 与 Core 之外校验并推进。

Runtime restart 对已 claim 为 `running` 的 Agent invocation 采用 fail-closed unknown，而不是消费剩余 attempt 重放 provider turn：Core 持久化 unknown/no-replay receipt，并生成 canonical failed result。Autonomous Agent Run 将其送入一次 bounded Steward adjudication；Subscription callback 直接失败，不自行重放；其他 owner 按自己的 durable continuation 收口。业务 vertical 不得各自把同一个中断 invocation 重排回队列。

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

### Execution 准入资源

限量准入是 Chat dispatch、Steward Run 与 Subscription Agent invocation 共用的 core 原语：SQLite queued/retry_wait/running 与 canonical Result 是唯一持久事实；不新增调度表。RuntimeCycle 在原子 claim 前按 handler 容量、Agent、Session/新 Run lane 和 workspace 读写冲突选择工作。等待项保持 queued/retry_wait，恢复仍沿用现有 interrupted/unknown 判定。Result 保留独立容量，并延续其源 invocation 的 workspace 保护直到结果消费完成。source phase I/O 生命周期不属于本切片。

初始容量为全局 Agent invocation 4、每个注册 Agent 2、同 Session 1；Result Handler 保留 2、Chat Handler 保留 1，后两者不占 provider 名额。Agent 按轮转分配机会，同 lane 保持 FIFO；读写重叠时保留先来顺序，防止后来 reader 越过已排队 writer。不同 Session 的只读调用可并发；重叠 workspace 只要一侧写入就互斥。已有 active write Run 同根目录唯一约束保持有效，执行层保护不替代 Run admission。

每次 claim 在 SQLite immediate transaction 内复核 durable running 与待消费 Result；进程内只缓存上限 1000 条不可变 Event 和公平轮转提示，不缓存执行状态或容量。关闭时只等待已接受的 invocation，未准入项留在 SQLite。`scheduling.ts` 持有容量默认值；Steward 选择权重由独立 policy 持有。

## 文件与网络权限的独立映射

`ExternalWorkspaceGrant@1` 的文件 access 与 networkAccess 是独立的运行原语：只读取证 Run 可以在 Owner 明确授权后联网，写入交付 Run 同样独立声明网络。Core 只校验字段和持久化，不判断业务是否需要网络；Steward admission 拥有权限调整。Codex 的只读调用通过 `turn/start.sandboxPolicy={type:readOnly,networkAccess}` 映射，不能以 workspace-write 代替只读。Subscription 的准入限制仍归自身 owner。网络开关不是 HTTP 方法或目标域名白名单，不可宣称它强制远端只读。
