---
type: Architecture
title: Canonical Spec Registry
description: Rollerskate 内部 versioned spec 的 canonical identity、单一 registry、兼容状态与 artifact digest 边界。
tags: [rollerskate, spec, contract, registry, compatibility]
---

# Canonical Spec Registry

[返回 architecture index](./index.md)

`local/src/modules/spec/registry.ts` 是 Rollerskate 内部 versioned spec identity 和 resolution 的唯一事实源。它不取代各领域的 payload parser；registry 把唯一 canonical ref 映射到 `kind`、`active | historical` status、owner、source、parser、payload discriminator，以及适用时的 `artifactDigest`。领域 parser 继续由原 owner 维护 strict keys、字段类型、预算和状态语义。

## Identity boundary

Canonical grammar 固定为 `spec:rollerskate/<name>@<major>`，由 `SpecRef@1` parser 解析。`<name>` 使用小写字母、数字、`.` 和 `-`，`major` 是 1–999999 的正整数。大小写变体、未知 namespace、缺失 major、额外 path 和未登记 ref 都 fail closed；registry 不猜 alias。

三类 identity 必须分离：

- spec ref 只表达 versioned contract、template、workflow、result contract 或 bundled capability identity，例如 `spec:rollerskate/run-intent@1`；
- resource instance ref/identity 继续由 owner contract 持有，例如 workspace/destination/agent/plugin ref，或 `RunSourceBinding.source` 的 kind、id 与 definition revision；这些值不进入 `spec:` namespace；
- `sha256:<hex>` 只绑定 file-backed artifact 内容。code-native entry 的 `artifactDigest` 为 `null`，不能用 digest 冒充版本，也不能把 spec ref 传入 digest parser。

现有持久化 `RunSourceBinding@1.source.definitionRevision` 仍保留 `<payload-discriminator>:<instance-revision>` 兼容 token，避免在本 slice 批量改写数据库记录。新 producer 在构造该 resource identity 前先通过 registry 解析 definition contract；这个持久化 token 不是 canonical spec ref，`parseSpecRef` 不接受它。

## Resolution and compatibility

- `parseSpecRef` / `normalizeSpecRef` 只处理 canonical identity；`resolveSpecRef` 只接受已登记 canonical ref。
- `resolveSpecToken` 把现有 payload discriminator 映射到 canonical ref；每个 token 只能映射一个 entry。默认只解析 `active` entry，因此 public intake、Agent output 和其他外部输入不会因为旧 major 曾经存在而获得兼容。
- `assertSpecCompatibility` 始终要求 exact identity，不猜测 major 间的向前或向后兼容。历史 Run 以持久化的 expected contract 继续校验它原本绑定的 exact identity。
- `historical` entry 只服务已存在的持久化记录；具体 persistence reader 必须显式设置 `allowHistorical`，普通 resolution 默认拒绝。
- `verifySpecArtifact` 对 file-backed workflow 比较 registry digest；code-native contract/template/capability 必须传 `null`。

公共调用方仍只提交 `RunIntent@1`。Owner compiler 把该 discriminator 解析为 `spec:rollerskate/run-intent@1`，再选择内部 authority、Steward request、Orchestrator binding 和 result contract；调用方不提交内部 spec graph、participant/workspace resolution 或 Steward execution details。

## Run-chain inventory

`specRegistryInventory()` 从 registry 本身生成 readback；focused test 逐项证明 ref 唯一、token 无碰撞、owner/parser/source 非空。首个闭环包含：

- intake/compiler：`RunIntent@1`、`StewardRunRequest@2`、`RunAuthorityEnvelope@1`；
- orchestration：`OrchestratorBinding@3`、`RunDecision@3`、`AgentStepResult@1`、`AgentRunCheckpoint@1`；
- source/target binding：`RunSourceBinding@1`、`ProactiveTarget@1`、`ScheduleRevision@3`、`SubscriptionDefinition@5`、`ContinuousSubscriptionDefinition@3`、`TriggerOccurrenceEnvelope@1`、`DeterministicApplicationActionReceipt@1`；
- source templates：`schedule.once@1`、`schedule.cron@1`、`subscription.until@1`、`subscription.continuous@1`；
- workflows：`review@1`、`mr-readiness@1`、`forum@1`、`continuous-observation-monitor@1`，四者是 file-backed artifact 并绑定 digest；
- result contracts：`agent-turn-result@1`、`agent-step-result@1`、`run-decision@3`、`agent-turn-adjudication@1`、`agent-turn-retry-result@1`；
- bundled capabilities：`scheduled-task@1`、`subscription@1`。template entry 显式指向 owning capability。

## Migration status

- `active`：上述 Run 主链、四份 workflow、四个 source template、两个 bundled capability、当前 `AgentRunDecisionReceipt@2`，以及仍由 manual Owner control 使用的 `OrchestratorBinding@1` / `RunDecision@1`。active 不等于 public 默认入口；public intake 仍只选择 `OrchestratorBinding@3` / `RunDecision@3`。
- `historical`：旧 Steward `OrchestratorBinding@2` / `RunDecision@2`、`AgentRunDecisionReceipt@1`、`ScheduleRevision@1`、`SubscriptionDefinition@3` 与 `ContinuousSubscriptionDefinition@1`。它们只服务 persisted Run、decision audit 和 legacy source read/reconcile，不能成为新的通用输入。
- `unmigrated, out of this slice`：其余 versioned token 不自动进入 registry，也不批量改写。Local core/Event/Session/Delivery token 继续由 `local/src/core/` owner；Chat/Foundation/application view token 由对应 `local/src/modules/` 与 `application/` owner；callback/integration token 由对应 capability/integration owner；Local/Server wire token 由 `packages/protocol/src/` owner。新增 Run 跨边界引用前必须先登记，不得另建 parser/registry。

## Change guidance

- 新 registry entry 必须有唯一 canonical ref、kind、`active | historical` status、owner/source、parser、payload discriminator 和适用的 artifact digest；同名 spec 的不同 major 必须保持同一 kind。
- 新 file-backed workflow 修改内容后必须同步 registry digest；digest drift 测试应先失败，再更新登记值。
- 只有可定位的持久化记录和 reader 才能保留 historical token；外部输入版本变化必须显式升级 producer/consumer，不能走历史兼容 adapter。
- registry 只保存 identity 与追溯 metadata。payload shape、resource instance lifecycle、artifact storage 和业务状态仍归原领域 owner。
