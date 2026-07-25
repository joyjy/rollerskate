---
type: Architecture
title: Local Multi-Client Review
description: versioned acceptance subject、MRSF artifact、双 Agent 权限、durable projection 与单 loop Review 状态机。
tags: [rollerskate, local, review, capability, mrsf, event]
timestamp: 2026-07-24
---

# Local Multi-Client Review

[返回 architecture index](./index.md)

Local Review 是随源码发布的固定 Capability。它让两个独立 Local Agent 围绕一个 acceptance subject 完成审查、有限返修和复核；Reviewer 与 Implementer 可以使用相同或不同 client adapter，但始终拥有独立 provider Session。

Review 不创建 Task、Goal、Round 或通用 workflow。所有 Agent 调用继续经过唯一 core loop 和 canonical `agent.request → agent.result` 主链。

## 内容与 revision

- subject 只允许 `acceptance`，由 workspace 内一个完整文件及 `file1_` 内容 hash 标识。
- evidence 首版固定为一个 Git workspace，使用 `workspace-revision-v1`。clean workspace 固定 repo identity、HEAD 和 clean marker；dirty workspace增加 tracked binary diff hash 与排序后的 untracked path/content manifest。
- `*.review.yaml` 是 Capability 拥有的派生 sidecar，不参与 implementation revision，避免 sidecar 更新反向制造 workspace 漂移；ignored、repo 外和 symlink-untracked 内容同样不进入 manifest。
- sidecar 使用 `mrsf.review@1`。当前 writer 产生 JSON-compatible YAML，由 `artifact-schema.ts` 唯一校验；未知 schema、路径不匹配或内容 hash 不匹配都会拒绝推进。
- Reviewer 可以提议新增或 resolve finding；Implementer只能为 open finding 写 reply。Capability 校验后原子替换 sidecar，Agent 不能自行编辑或 resolve。

## Durable projection

`reviews` 是一个 bounded aggregate，保存 `rootEventId`、phase、cycle、expected Event/active Execution、subject/artifact/implementation revision、rework count/limit 和 terminal decision/reason。它只负责 transition admission 与恢复，不复制 subject 或 finding 正文。

`transitions_json` 使用 versioned、bounded receipt 保存 `(rootEventId, phase, cycleIndex)` 对应的 Reviewer/Implementer admission。aggregate CAS、parent Execution 完成、child Event 和 child Execution 在同一 SQLite transaction 中发生；retry 或 restart 不建立第二个 Agent request。

`reviewer_session_id` 与 `implementer_session_id` 分别保存两个角色的 Session，并有不相等约束。即使两个 Agent 使用同一种 adapter，也不共享 Session；下一轮只恢复同一 root 和同一 role 的既有 Session。

首版同一 workspace 和同一 subject 各最多有一条 active Review chain，避免不同 root 并发写 workspace 或竞争同一个 sidecar；chain terminal 后唯一准入自动释放。

## 状态机

```text
review.requested
  -> Reviewer agent.request [read + ReviewerResult@1]
  -> agent.result
  -> review.decision
       passed  -> terminal
       blocked -> terminal
       findings, below limit
         -> Implementer agent.request [write + ImplementerResult@1]
         -> agent.result
         -> next review.requested
```

`ReviewRuntime` 是 `review.requested` 与 `review.decision` 的唯一 Handler。`ResultHandler` 只在 parent `agent.request` 携带源码生成的 `review-invocation@1` 时，把结构化 result 交给 Review continuation；它仍不直接调用下一位 Agent。

admission 会同时检查 Reviewer 支持 `ReviewerResult@1 + read`，Implementer 支持 `ImplementerResult@1 + write`。Codex 映射为 `read-only` 或 `workspace-write` sandbox；Claude Code 映射为 plan/read tools 或 `acceptEdits` write tools。不支持的 adapter 在 provider invocation 前把链终止为 blocked。

## 失败与恢复

- subject、artifact、evidence 或 workspace revision 漂移时 fail closed。
- provider failure、无效 JSON、未知 result schema、workspace 外或非文件 finding anchor、越权 artifact mutation、Implementer 没有产生新 implementation revision，都会把当前 chain 终止为 blocked 并保存 bounded reason。
- findings 达到 rework limit 后不再调用 Implementer，终止为 blocked。
- global `scripts/rs recover` 先把 interrupted Execution 放回既有有限重试；`scripts/rs review recover` 检查 projection 的 expected Execution。queued/retry-wait 保持可运行，failed 或异常 succeeded 状态 fail closed 为 blocked。
- CLI 与 Console 通过同一 application query 展示完整链。Console 只在 application guard 允许时暴露 recover；blocked Review 以稳定 Runtime Failure reference 下钻，不复制 Failure 状态。

## 源码边界

- `local/src/capabilities/review/artifact-schema.ts`：`mrsf.review@1` 唯一事实源和原子 writer。
- `local/src/capabilities/review/result-contract.ts`：Reviewer/Implementer JSON result contract。
- `local/src/capabilities/review/workspace-revision.ts`：subject 与 workspace revision。
- `local/src/capabilities/review/store.ts`：bounded aggregate、transition receipt、role Session 与 transactional child admission。
- `local/src/capabilities/review/runtime.ts`：固定状态机与 authority validation。
- `local/src/application/review/control.ts`：Review admission/recover application control，不拥有状态机。
- `local/src/application/review/query.ts`：CLI、loopback HTTP 与 Console 共用的 summary/detail、available actions、reason、规范化 Event trace 与 Runtime Failure reference。
- `local/src/entrypoints/cli/review.ts`、`local/src/entrypoints/console/launcher.ts`：薄 entrypoint，只调用共用 query/control。
