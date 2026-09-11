---
type: Runbook
title: Subscription
description: 通过 Steward Run 注册并观察 one-shot 或 continuous Subscription source。
tags: [rollerskate, subscription, polling, plugin, steward-run]
---

# Subscription

[返回 Quickstart](./quickstart.md)

v0.5.5 起，Subscription 是 Run 的 source，不是独立执行入口。Owner 先登记可信 probe Plugin，再以 `RunIntent@1` 创建 Steward Run；Steward 的 `await_source` 决策原子建立 `SubscriptionDefinition@4` 或 `ContinuousSubscriptionDefinition@2` 与 Run binding。terminal observation 或新 delta 只激活该 Run 的一个 cycle，不直接执行 Agent、command 或 destination callback。

旧 `SubscriptionDefinition@3` / `ContinuousSubscriptionDefinition@1` 仍可读取、暂停和取消；`subscription add` 与 legacy resume 已关闭，不能新建或重新启用 callback definition。

迁移 legacy `command.exec` definition 时，Owner 必须先在 `LegacyTriggerWorkflowRegistry@1` 登记 exact source revision + callback 到 bundled versioned workflow 与 participant 的唯一映射，并显式选择 `terminalResultPolicy: "retain" | "deliver"`，再以 `run legacy-migration-plan` / `run legacy-migrate` 完成审批。`retain` 只在 Run Workspace 保留 cycle 证据且禁止 destination；`deliver` 必须登记既有 result destination。后台健康检查应选择 `retain`。replacement Run 不继承 raw command callback；它通过同一 Plugin source 建立无 callback 的 V4/V2 definition，每个 cycle 只由 workflow 分类并保留 durable evidence。Continuous source 仍只在 cycle succeeded 后推进 checkpoint，失败周期不会被误记为已处理。

## 登记 probe Plugin

在目标 runtime 的 `subscription-plugins.json` 写入 Owner registry。`pluginPath` 接受 project-relative `project:` 引用或本机 `file://` URL；`workspaceRef` 接受 `project:self`、`local:workspace` 或目录 `file://` URL。

```json
{
  "schemaVersion": "SubscriptionPluginRegistry@1",
  "plugins": [
    {
      "ref": "plugin:shell-command-completion@1",
      "pluginPath": "project:examples/plugins/shell-command-completion.ts",
      "pluginId": "shell-command-completion",
      "workspaceRef": "project:self",
      "triggerKinds": ["until", "continuous"],
      "allowedHttpOrigins": [],
      "allowedExecutables": [
        "/absolute/repo/examples/probes/read-command-receipt"
      ]
    }
  ]
}
```

Run admission 会读取 Plugin artifact、canonical workspace 与 allowlist，并把 artifact digest 和 registry policy digest 固定到 Run authority。registry 缺失、Plugin 未登记、kind 不匹配或 admission 后 registry 漂移都在 probe/occurrence 前 fail closed。Plugin config 不得保存 token。

## 创建 one-shot Run

one-shot 使用 `triggerIntent: "until"`。objective 说明 terminal 条件和 probe config；authority 仍由 compiler 与 registry 生成，不在 intent 里手写 grant。

```json
{
  "schemaVersion": "RunIntent@1",
  "requestId": "acceptance-command-1",
  "objective": "每 1 秒使用 plugin:shell-command-completion@1 检查 commandId acceptance-1；terminal 后由 worker 验证 receipt 并总结。",
  "acceptance": ["同一 terminal observation 只激活一个 Run cycle", "receipt 状态与摘要可从 Run Workspace 读取"],
  "contextRefs": ["command:acceptance-1"],
  "workspaceRef": "file:///absolute/workspace",
  "desiredEffect": "read",
  "triggerIntent": "until",
  "requestedParticipantRefs": ["agent:worker"],
  "terminalEvidence": ["Run source 显示 terminal observation", "Run cycle 有验收摘要"]
}
```

```bash
scripts/rs run preflight /absolute/workspace/run-intent.json
scripts/rs run start /absolute/workspace/run-intent.json
```

Steward 只能在 admitted plugin refs、policy digest、interval 和 participant/workspace ceiling 内选择 `subscription.until@1`。首次 probe 在一个完整 interval 后发生。

## 创建 Continuous Run

长期观察使用 `triggerIntent: "continuous"`，其余入口不变。objective 应要求 Plugin 给出稳定 `occurrenceKey`，并说明每个 delta cycle 的验收与 checkpoint 条件。

`ContinuousSubscriptionDefinition@2` 在新 key 上建立 pending occurrence；只有对应 Run cycle `succeeded` 后才推进 checkpoint。`failed`、`needs_human` 或 unknown receipt 均保留旧 checkpoint，重启后依据同一 binding receipt 恢复，不猜测、不自动重放 side effect。

## 检查与控制

```bash
scripts/rs run list
scripts/rs run inspect <run-id>
scripts/rs subscription list
scripts/rs subscription inspect <subscription-id>
scripts/rs subscription pause <subscription-id>
scripts/rs subscription resume <subscription-id>
scripts/rs subscription cancel <subscription-id>
```

Run Workspace 是唯一一级执行页面：显示 source definition/revision、last occurrence、cycle、checkpoint、reconcile 状态和 source diagnostics deep link。Subscription 页面只负责 probe、observation 与 source-owned recovery。Run cancel/close 后按 binding 的 cancellation policy 停止未来 occurrence。

## 验收

1. `run preflight` 固定正确的 Plugin ref、artifact/policy digest、workspace、participant 和 trigger interval ceiling，且不创建 Event。
2. source 创建后只出现 `SubscriptionDefinition@4` 或 `ContinuousSubscriptionDefinition@2`，没有 callbacks。
3. duplicate poll 对同一 `occurrenceKey` 只恢复一个 Run cycle；one-shot terminal 只写一次。
4. Runtime 重启后沿同一 source/Run receipt 继续，continuous checkpoint 不因失败或 unknown 前移。
5. 修改 registry 后，既有 Run 的新 source registration fail closed，不扩大 authority。
6. legacy `command.exec` migration 只在 exact Owner mapping 与 bundled workflow artifact 均匹配时 ready；replacement definition 无 callbacks，未配置 destination 时保持静默，显式 terminal destination 不泄露 observation 正文。

## 确定性观察入口

无需 Agent 判断的 until/continuous 观察与长命令统一使用 `run preflight/start`。调用方只选择已登记 source 和业务参数，或给出原命令 argv/cwd；Run compiler 生成 source 与可选回传绑定，不调用模型。`subscription register-desktop` 不再新建普通工作，已有定义保留。语法和预检结果见 [统一 Run CLI](cli-reference.md#统一-run-提交与预检)，ownership 见 [统一 Run 架构](../architecture/unified-run.md)。
