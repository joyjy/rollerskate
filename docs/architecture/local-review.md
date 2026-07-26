---
type: Architecture
title: Local Agent Run And Review Workflow
description: 通用 Agent Run、run-scoped Session、completion callback、external workspace grant 与 versioned review workflow。
tags: [rollerskate, local, agent-run, steward, review, workflow, callback]
timestamp: 2026-07-26
---

# Local Agent Run And Review Workflow

[返回 architecture index](./index.md)

Agent Run 是一次显式启动、可查询和可取消的本机 Agent 协作边界。Owner 选择一个 online Agent 作为该 Run 的 Steward；Steward 是运行时角色，不是 Agent 类型，也不是独立 Capability。任意参与 Agent 都可以完成自己的 step，或委派一个 child Agent；Runtime 在 child terminal 后通过 completion callback 恢复准确的 caller Session。

Review 是 `review@1` versioned workflow resource。它向 Steward 说明目标、输入、允许的能力、结果格式和 Agent 间如何交接，但不拥有 Handler、Store、loop 或固定 Reviewer/Implementer 状态机。其他 workflow 复用同一个 Agent Run engine。

普通 `#local` Chat 不创建或加入 Run，也不获得 Run 的 external workspace grant。Chat 与 Run 是否打通属于 future product design。

## Run admission

Run 只通过显式 `run start` 或 Agent 的 typed delegate 创建/推进。首次 admission 固定：

- `runId`、Owner request ID、Steward Agent 和独立 run-scoped Session；
- bounded `RunMandateSnapshot@1`，来源可以是内联 objective，也可以是 `workflowRef + inputs` 渲染后的 versioned workflow；
- 可选 `ExternalWorkspaceGrant@1`，由 Owner 指定 canonical root 和 `read | write`，workflow 与 Agent 都不能自行扩大；
- deadline、max steps、max depth 和其他 bounded execution budget。

同一个 Agent 在不同 Run、以及 Chat 与 Run 之间使用不同 Session。一个 Run 内首次委派某 Agent 时创建 `(runId, agentId)` 唯一 Session，后续 callback 复用；provider Session ID 仍只由 Runtime/adapter 管理。

没有 external workspace grant 的 Run 不继承 Chat sandbox 之外的路径权限。相同 canonical external workspace 可以有多个 read Run，但最多一个 non-terminal write Run；不同 worktree root 视为不同 workspace。read Run 不获得数据库快照隔离，每个 step 的 receipt 记录实际观察到的 revision 和 drift。

## Generic turn 与 callback

Agent Run 的每次 `agent.request` 都要求 `AgentTurnResult@1`：

- `complete`：结束当前 step，并声明 `succeeded | failed | needs_human`、bounded summary 与可选 artifact references；
- `delegate`：只创建一个 child step，包含目标 Agent、bounded objective 或 workflow invocation。首版不支持一轮 fan-out 或 `all/any` join。

每个 turn 的 prompt 都包含当时 active、且不含当前 Agent 的 delegate roster snapshot（`agentId + handle`）；Agent 必须从中选择 exact `targetAgentId`。该 snapshot 随 immutable request Event 留存，但不冻结整个 Run 的 Agent roster：后续 callback 会使用当时最新 active roster。

Agent 不填写 callback target。Runtime 从当前 run-scoped caller Session 生成 immutable callback binding，并在同一 transaction 中完成当前 result、推进 Run CAS、创建 child `agent.request` 与 Execution。child terminal success 或 failure 后，generic ResultHandler 以 `AgentStepCompletion@1` 创建一次 callback `agent.request`，目标是 admission 时固定的 caller Session；provider retry 期间不 callback。

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

## Lifecycle、cancel 与恢复

Run 状态是 `active | waiting | succeeded | failed | needs_human | cancelled`。`active` 表示当前 caller turn 正在推进，`waiting` 表示等待唯一 child terminal/callback；terminal 状态不再 admission 新工作。

`cancel` 是幂等的 Owner control：它把 Run 标记为 cancelled，取消尚未开始的 queued work，并阻止 retry、delegate、child request 与 callback admission。已经运行的 provider process不被强杀；其 late result 仍可作为审计事实保存，但不能恢复 Run。

Run、当前 step/Execution 与 `version` 提供 CAS/recovery authority。duplicate result、ResultHandler retry 或 restart 使用 deterministic child/callback key，只能建立一次后继 Event/Execution。terminal child failure仍通过 callback 返回 caller 决定；只有 root Agent failure、预算耗尽、authority violation 或无法恢复的不一致状态直接终止 Run。

`agent.result.output` 一旦写入就是 immutable fact，因此不对同一份 malformed contract 做无意义解析重试。Agent Run continuation strict parse 失败时，在一个 transaction 内把 Run terminalize 为 `failed`、写入 bounded `invalid_result` continuation receipt 并完成 ResultHandler Execution；Core 仍不理解具体 schema。

## `review@1` workflow

`review@1` 接收计划/acceptance、实现证据和可选 external workspace grant。workflow 可以要求 Steward 自己完成 review，也可以顺序委派其他 Agent 检查或修改；角色由当次 objective 决定，不持久化固定 Reviewer/Implementer columns。

Review finding、意见正文和修改说明属于 Agent output 或明确 artifact，不成为 Runtime 状态机字段。Runtime 只校验 `AgentTurnResult@1`、artifact reference budget、workspace authority 和 callback causality；它不理解 finding、rework、MRSF、Reviewer 或 Implementer。需要多轮返修时，由 workflow 指令和同一 Steward Session 基于 callback receipt 决定下一次单 child delegate。

## 源码边界

- `local/src/modules/agent-run/state-machine.ts`：Run lifecycle、single-child、cancel、budget 和 continuation 的纯策略；`result-contract.ts` 独立拥有 `AgentTurnResult@1` 类型与 strict parser。
- `local/src/application/agent-run/control.ts`、`query.ts` 与 `module.ts`：start/cancel、summary/detail/timeline 和 Runtime module manifest。
- `local/src/infrastructure/sqlite/agent-run-store.ts`：`agent_runs` CAS、run-scoped Session、write-workspace exclusion 与 transactional continuation。
- `local/src/core/runtime/model.ts` 与 generic ResultHandler：不透明 Agent output、`resultContractId` routing、`AgentStepCompletion@1` 和 completion callback 原语；不导入或解析具体 result contract，也不引用 workflow/role 名称。
- `local/resources/workflows/review.md`：`review@1` frontmatter、输入与协作规约。
- `local/src/entrypoints/cli/run.ts`、loopback API 与 Console：只调用 Agent Run application control/query。
- legacy `local/src/capabilities/review/` 与 `local/src/application/review/`：只读解释 schema v43 及更早 terminal Review history；不参与新 Run。

## Change guidance

- 新 workflow 默认只增加 versioned resource；需要专用 Runtime Event、Handler、Store 或 adapter capability 时，必须证明现有 Agent Run contract 无法表达。
- completion callback 只用于已知 child work 的一次 terminal return；等待未知外部条件继续使用 Poll Subscription。
- 新 callback payload 必须 bounded、versioned、可幂等重放，并覆盖 child success、terminal failure、cancel、duplicate 和 restart。
- 新 workspace authority 由 Owner admission 固定，不能由 workflow prompt、Agent output 或 provider Session 自行扩大。
