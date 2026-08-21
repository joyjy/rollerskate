---
type: Architecture
title: Local Steward And Review Workflow
description: Steward Run 的 autonomous/caller orchestration、series/cycle Session、checkpoint/decision、external workspace grant 与 versioned workflow。
tags: [rollerskate, local, agent-run, steward, orchestrator, cycle, checkpoint, review, workflow, callback]
timestamp: 2026-07-26
---

# Local Steward And Review Workflow

[返回 architecture index](./index.md)

Steward 是一次显式启动、可查询和可取消的本机 Agent 协作领域；它的 durable aggregate 使用 `agent_runs`、`agent_run_decisions`、`runId` 和 `AgentRunContext@1`。Control surface 提供 autonomous、manual caller 和 steward 三种启动语义；持久层只需要 `autonomous | caller` 两种 mode，steward 是 caller mode 加 `OrchestratorBinding@2`。autonomous Agent 用 `AgentTurnResult@1` 完成或委派 child；manual caller 由 Worker 交付 checkpoint、Owner 提交 `RunDecision@1`；steward 由 admission 时固定的 Codex Orchestrator 先拆分目标并选择首个 Worker，此后读取 Worker checkpoint、受限历史与当前 roster，返回严格 `RunDecision@2`。三条路径最终都经过同一个 Store transition authority。Steward 是 application domain，不是 Agent 类型，也不是 Capability。

Review 与 Forum 分别是 `review@1`、`forum@1` versioned workflow resource。它们向 Steward 说明目标、输入、允许的能力、结果格式和 Agent 间如何交接，但不拥有 Handler、Store、loop 或固定角色状态机。其他 workflow 复用同一个 Steward engine。

外部 owner 可以用 `series.key + series.sourceRevision` 把反复变化的同一业务对象映射为长期 autonomous Run。GTD MR 使用 `gitlab-mr:<mr_ref>` 复用 Run ID，并以 immutable `head_sha` 创建 revision cycle：`mr-readiness@1` 只返回变更摘要和 `complete | incomplete | uncertain`，人工按需的 quality review 可以在同 revision cycle 续用 Session。Rollerskate 只保存 Run/cycle/Session、workspace revision、receipt 与 trace，不读取 MR、attention、reviewed revision 或 WorkItem lifecycle。

Run 产物仍以 canonical Agent result 为唯一事实源，不建立 artifact table。`AgentTurnResult@1.outputs[]` 保存 bounded JSON/Markdown/text 产物，terminal step 自动投影一个 primary Output，`artifactRefs` 同目录展示；Steward query 按 Run→Cycle→Output 形成逻辑目录，并用 `stepId:kind:id` 生成 Cycle 内稳定唯一的 Output ID。Console 只做安全文本/字段预览和 raw 展开，不解释 workflow schema，也不渲染产物 HTML。历史 `workflowResult` 在 schema 初始化时一次性改写为 `outputs[id=result]`，运行时 contract 不保留双读兼容。

普通 `#local` Chat 不创建或加入 Run，也不获得 Run 的 external workspace grant。Chat 与 Run 是否打通属于 future product design。

## Run admission

Run 只通过显式 `run start` 创建；autonomous Run 后续通过 Agent 的 typed delegate 推进，caller/steward Run 后续只通过 typed decision 推进。未显式指定 steward 时，`run start` 选择当前 active、client 为 `codex`、handle 为 `codex` 的 Local Agent 作为 Orchestrator；显式 legacy steward 仍可启动 autonomous Run。首次 admission 固定：

- `runId`、Owner request ID、Steward Agent 和独立 run-scoped Session；
- bounded `RunMandateSnapshot@1`，来源可以是内联 objective，也可以是 `workflowRef + inputs` 渲染后的 versioned workflow；
- 可选 `ExternalWorkspaceGrant@1`，由 Owner 指定 canonical root 和 `read | write`；write grant 还必须选择 `must_change | may_remain_unchanged` effect，workflow 与 Agent 都不能自行扩大；
- deadline、max steps、max depth 和其他 bounded execution budget。

manual caller Run 固定 `OrchestratorBinding@1`、active Local participant roster 与 `maxDepth = 0`；binding 只接受 Owner principal、`run-decision@1` 和 `deliveryPolicy = manual`。steward Run 固定 `OrchestratorBinding@2`、Codex Orchestrator 的 exact Local Agent/client/handle snapshot、`run-decision@2`、participant roster 与可选 Vikunja Task destination。Worker 不能委派、结束 Run 或扩大 participant、budget、deadline、workspace 与 network authority；Orchestrator 也只能选择 admission roster 中当前仍 active 的 Agent。

autonomous Run 默认在每个 turn 使用当时 active Local Agent roster。caller/steward Run 在 admission 时冻结 exact participant IDs；后续 prompt 与 decision admission 只能使用该 roster，不能因新 Agent 上线或 Agent 猜测 ID 而扩大 authority。相同 Owner request ID 的重试只有在完整 binding、mandate、workspace grant 与 budget 相同才返回原 Run，否则 fail closed。

同一个 Agent 在不同 Run、以及 Chat 与 Run 之间使用不同 Session。普通 Run 内首次调用某 Agent 时创建 `(runId, agentId)` 唯一 Session；series Run 使用 `(runId, cycleId, agentId)`，因此同 revision callback/review 可续用 Session，而新 revision 必须创建 fresh Session。provider Session ID 仍只由 Runtime/adapter 管理。

没有 external workspace grant 的 Run 不继承 Chat sandbox 之外的路径权限。相同 canonical external workspace 可以有多个 read Run，但最多一个 non-terminal write Run；不同 worktree root 视为不同 workspace。read Run 不获得数据库快照隔离，每个 step 的 receipt 记录实际观察到的 revision 和 drift。write Run 的新 admission 必须显式选择 effect；历史未携带 effect 的持久 grant 仍可读取，并按 `may_remain_unchanged` 语义解释。

## Autonomous turn 与 callback

autonomous Agent Run 的每次 `agent.request` 都要求 `AgentTurnResult@1`。解析器先接受完整 JSON、单一 Markdown fence 或带至多 4 KiB wrapper 的唯一顶层 JSON object，再对字段执行同一 strict schema；多对象、截断或未知字段仍失败：

- `complete`：结束当前 step，并声明 `succeeded | failed | needs_human`、bounded summary 与可选 artifact references；
- `delegate`：只创建一个 child step，包含目标 Agent、bounded objective 或 workflow invocation。首版不支持一轮 fan-out 或 `all/any` join。

每个 autonomous turn 的 prompt 都包含当时 active、且不含当前 Agent 的 delegate roster snapshot（`agentId + handle`）；Agent 必须从中选择 exact `targetAgentId`。该 snapshot 随 immutable request Event 留存。caller/steward continuation 则只使用 admission 时固定的 participant IDs，并在创建下一 Event 前再次校验 target 仍 active。

Agent 不填写 callback target。Runtime 从当前 run-scoped caller Session 生成 immutable callback binding，并在同一 transaction 中完成当前 result、推进 Run CAS、创建 child `agent.request` 与 Execution。child terminal success 或 failure 后，generic ResultHandler 以 `AgentStepCompletion@1` 创建一次 callback `agent.request`，目标是 admission 时固定的 caller Session；recovery adjudication 或获准的单次 retry 期间不 callback。

```text
Run R1 / Agent A Session A1
  -> agent.request step 1
  -> AgentTurnResult delegate Agent B
     -> Agent B Session B1 / agent.request step 2
     -> agent.result
     -> AgentStepCompletion callback / Session A1
  -> Agent A completes or delegates the next single child
```

嵌套委派形成 durable async call stack：A → B 的 callback 指向 A，B → C 的 callback 指向 B。所有 request、result 和 callback 共享 `runId`，使用 `stepId/parentStepId` 表达层级；Event/Execution 保留完整交流记录，`agent_runs` 不复制 transcript，也不建立 `agent_run_steps` 表。

## Caller/Steward checkpoint 与 decision

manual caller Run 从首个 Worker 开始；steward Run 则先以 `stepCount = 0` 向固定 Codex Orchestrator 请求初始 `RunDecision@2`。初始 decision 建立 bounded `OrchestratorState@1`、拆分任务并选择首个 Worker，只有随后真正的 Worker 才消耗 step budget。每个 Worker `agent.request` 使用 `AgentStepResult@1`；结果严格包含 `outcome`、bounded summary、artifact references，以及可选 acceptance evidence、unresolved questions 和 observed workspace revision，不包含 delegate 或 terminal authority。Runtime 将结果和 request/result/Execution identity 固定成 `AgentRunCheckpoint@1`，原子写入 `agent_runs.checkpoint_json`，并把 Run 转为 `awaiting_orchestrator`。

manual Owner 读取当前 checkpoint 与 Run version 后提交 strict `RunDecision@1`。steward mode 用 Orchestrator 的 run-scoped Session 建立 `agent.request`：首轮 prompt 包含 objective、remaining budget 和 fixed participant roster，后续再加入 current checkpoint 与从 immutable decisions/receipts 重建的 `OrchestratorState@1`；最多保留 32 个结构化 task，不复制完整 transcript 或隐藏推理。Orchestrator 返回 strict `RunDecision@2`：

- `next_step`：目标是产生 checkpoint 的 `self` Agent，或 admission roster 中另一个 exact Agent；mandate 是 bounded objective 或 versioned workflow invocation；
- `finish`：以 `succeeded | failed` 和 bounded summary 结束 Run；
- `needs_human`：以 decision rationale 结束为 `needs_human`。

decision 必须携带 `expectedRunVersion`、rationale、checked acceptance 和独立 request ID；`RunDecision@2` 还携带完整、bounded 的当前 task state。Store 在一个 transaction 中校验 orchestration mode、current decision source/checkpoint producer、Run version、admitted participant、目标 Agent 当前 active、deadline 与 step budget，写入 immutable `agent_run_decisions` receipt，再建立唯一的下一步 Event/Execution 或 terminal state。相同 request ID 只返回原 receipt；不同 request 不能越过 CAS。Orchestrator malformed/stale/越权 decision 不会被自动改写；后续 checkpoint 保持可由 manual Owner `RunDecision@1` 收口，首轮失败则保留 `stepCount = 0` 的 decision source 进入同一人工接管入口。

steward Run terminal 时，可选 Vikunja Task destination 通过普通 Core Delivery 写回一个包含 Run ID、terminal status、summary 和稳定隐藏 marker 的 comment。adapter 写前查询、写后 readback；transport ambiguous 或 restart 重试先按 delivery ID marker 查重，因此同一个 terminal delivery 至多追加一次。Vikunja token 绑定 operator 配置的 endpoint origin，用户输入的 Task URL 不同源时在读取 token 前失败。Delivery 成败不改变已经 terminal 的 Run。

## Lifecycle、cancel 与恢复

Run 状态是 `active | waiting | awaiting_orchestrator | awaiting_source | succeeded | failed | needs_human | cancelled`。普通 Run 的 terminal result 直接结束 Run；series cycle 的 terminal result 关闭当前 cycle，并把 Run 转为 `awaiting_source`，清空 active cycle，但保留 Run identity。后续相同 source revision 可重新激活既有 cycle，不同 revision 创建新 cycle；series 只支持 autonomous orchestration。`run close` 才把 `awaiting_source` Run 正常结束为 `succeeded`，`cancel` 仍是显式 Owner 中止。

`cancel` 是幂等的 Owner control：它把 Run 标记为 cancelled，取消尚未开始的 queued work，并阻止 retry、delegate、child request 与 callback admission。已经运行的 provider process不被强杀；其 late result 仍可作为审计事实保存，但不能恢复 Run。

Run、当前 step/Execution、checkpoint 与 `version` 提供 CAS/recovery authority。duplicate result、ResultHandler retry 或 restart 使用 deterministic child/callback/decision key，只能建立一次后继 Event/Execution。autonomous child terminal failure 仍通过 callback 返回 caller 决定；caller checkpoint 跨 restart 保持 `awaiting_orchestrator`，不会自行推进。

Agent Run 的 provider Execution 固定 `maxAttempts=1`，因此 provider failure、output overflow 与 unknown side effect 不由 Core 自动重跑。autonomous continuation 遇到这些失败、strict contract-invalid，或 `must_change` succeeded result 没有 Runtime-observed revision change 时，在同一个 step admission 一次 `AgentTurnAdjudication@1`：Steward 只能接受一个无需猜测即可规范化且不与 Runtime evidence 冲突的完整结果、携带非空安全证据请求一次 retry，或进入 `needs_human`。adjudication 自身或获准 retry 再失败不会递归；write workspace 已 drift、network authority 存在、write-capable tool usage 无法排除，或 retry 后 effect 仍未满足时，Runtime safety gate 收敛为 `needs_human`。accepted normalized result 仍从 canonical adjudication output 投影到 Run Output Folder，不复制新表。Subscription callback 同样 `maxAttempts=1`，contract-invalid 直接失败，不启动隐式修正链。Worker provider failure或 malformed output 仍被收敛为 outcome=`failed` 的 `AgentStepResult@1` checkpoint；Orchestrator 输出不合法时保留该 checkpoint 给 manual recovery。Core 始终不理解这些具体 schema。

## `review@1` workflow

`review@1` 接收计划/acceptance、实现证据和可选 external workspace grant。workflow 可以要求 Steward 自己完成 review，也可以顺序委派其他 Agent 检查或修改；角色由当次 objective 决定，不持久化固定 Reviewer/Implementer columns。

Review finding、意见正文和修改说明属于 Agent output 或明确 artifact，不成为 Runtime 状态机字段。Runtime 按 orchestration mode 校验 `AgentTurnResult@1` 或 `AgentStepResult@1`、artifact reference budget、workspace authority 和 continuation causality；它不理解 finding、rework、MRSF、Reviewer 或 Implementer。autonomous mode 的多轮返修由 workflow 指令和 callback receipt 决定下一次单 child delegate；caller mode 则由 Owner 基于 checkpoint 提交下一 `RunDecision@1`。

## `forum@1`

`forum@1` 在同一 Steward engine 上用临时 child objective 表达 proposer、challenger、investigator 和 synthesizer；这些名称不进入 Agent type、Run column、Event schema 或 Session identity。Orchestrator 根据 objective、acceptance、current checkpoint 和 bounded task state 顺序选择下一个 Agent 或结束；没有 Project-specific admission、effect grant 或专用 provider state。

Vikunja Task URL 只是 Host 在 start 时传入的普通 destination snapshot。Agent 若在 objective 中看到该链接，可像其他上下文引用一样理解任务；Runtime 不从链接推导 participant、policy、workspace 或 effect authority。最终 comment 写回由 Destination/Delivery adapter 单独完成，不需要 `ProjectBinding`、Project schema 或 Server effect ledger。

## 源码边界

- `local/src/modules/steward/state-machine.ts`：两种持久 orchestration mode 与三种启动语义的 Run lifecycle、single-child、checkpoint、decision、cancel、budget 和 continuation 纯策略；`result-contract.ts` 独立拥有 autonomous `AgentTurnResult@1`，`caller-contract.ts` 独立拥有两版 Orchestrator binding、`AgentStepResult@1`、`AgentRunCheckpoint@1`、`OrchestratorState@1` 与两版 Run decision。
- `local/src/application/steward/control.ts`、`query.ts`、`module.ts` 与 `result-recovery.ts`：start/cancel/decide、summary/detail/timeline、Runtime module manifest，以及 bounded autonomous result adjudication/retry gate。
- `local/src/infrastructure/sqlite/agent-run-store.ts`：`agent_runs` CAS、`agent_run_cycles` revision lifecycle、`agent_run_decisions` receipt、cycle-scoped Session、write-workspace exclusion 与 transactional continuation。
- `local/src/core/runtime/model.ts` 与 generic ResultHandler：不透明 Agent output、`resultContractId` routing、`AgentStepCompletion@1` 和 completion callback 原语；不导入或解析具体 result contract，也不引用 workflow/role 名称。
- `local/resources/workflows/review.md`：`review@1` frontmatter、输入与协作规约。
- `local/resources/workflows/mr-readiness.md`：`mr-readiness@1` 的严格 first-pass 结果契约；不拥有 MR workflow 或 attention。
- `local/resources/workflows/forum.md`：`forum@1` 的临时角色、信息增量与停止规约；不拥有 Project/provider authority。
- `local/src/application/steward/decision.ts` 与 `control-support.ts`：manual/internal decision 共用 admission，以及 start binding/roster 的纯辅助逻辑。
- `local/src/integrations/vikunja/task-destination.ts`：terminal comment 的普通 Destination adapter、stable marker、read-before-write/readback 和 ambiguous-commit 去重。
- `local/src/entrypoints/cli/run.ts`、loopback API 与 Steward Console：只调用 `application/steward` control/query；Schedule 与 Subscription 从各自 application query 读取自己的 conversation。

## Change guidance

- 新 workflow 默认只增加 versioned resource；需要专用 Runtime Event、Handler、Store 或 adapter capability 时，必须证明现有 Agent Run contract 无法表达。
- completion callback 只用于已知 child work 的一次 terminal return；等待未知外部条件继续使用 Subscription。
- 新 callback payload 必须 bounded、versioned、可幂等重放，并覆盖 child success、terminal failure、cancel、duplicate 和 restart。
- 新 orchestration producer 必须通过当前 binding 声明的 RunDecision contract 和 current Run version 推进 Run，不能直接改 Run、checkpoint 或建立下一步 Event。
- 新 reply destination 属于 Destination/Delivery 边界，只报告 checkpoint/terminal receipt；delivery 成败不能隐式推进 Run。
- 新 workspace authority 由 Owner admission 固定，不能由 workflow prompt、Agent output 或 provider Session 自行扩大。
