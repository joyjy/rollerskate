---
type: Architecture
title: Poll Subscription
description: one-shot Subscription 如何在 terminal 时构造 canonical Event 并恢复固定 Session。
tags: [rollerskate, subscription, polling, event, session]
timestamp: 2026-07-23
---

# Poll Subscription

[返回 architecture index](./index.md)

## 主路径

```text
register fixed Session ID + prompt
  -> persist Plugin/config + interval/deadline/max attempts + probe policy
  -> claim one due Subscription
  -> Plugin plans one declarative HTTP/command probe
  -> Runtime executes the bounded probe
  -> Plugin returns terminal or non-terminal decision
  -> non-terminal: update next poll and debug log only
  -> terminal: atomically create one subscription.fire Event + Execution
  -> AgentHandler resumes the exact Session
  -> AgentHandler creates one agent.result Event + ResultHandler Execution
  -> ResultHandler handles the agent.result Event
  -> optional Destination Delivery
```

## 固定契约

注册 callback 的有效运行信息只有本地 Session ID 与 prompt。Agent、adapter、workspace 和 provider Session 均从 Session 事实解析，不能在 Subscription 中复制或覆盖。

Subscription 是随 Rollerskate 发布的第一方 Capability；Plugin 只是其中的 `subscription.probe@1` 沙箱 strategy slot。Plugin 只提供 `plan(config, context)` 与 `evaluate(config, result, context)`，不能注册 Capability、Event type、Route、Handler、loop 或 store，不能创建 timer、直接调用 Agent、直接写 Event 或访问 Runtime。

Plugin host 在独立受限进程与 VM context 中运行，不允许 runtime import、ambient environment、network、filesystem write 或 process spawn。HTTP/command probe 由 Capability host 按 origin/executable、cwd、environment、timeout 与 output limit 执行。第三方若要完整 Capability，必须修改源码并进入正式发布流程，详见 [ADR 0005](./adrs/0005-capability-and-plugin-boundary.md)。

Poll status、attempt 与非 terminal observation 只更新 Subscription 持久状态，并可输出 debug log；它们不是 Event，也没有 observation version 产品契约。只有 terminal decision 原子创建一次 `subscription.fire` Event，以 Subscription ID 作为外部幂等键。

外部 shell command 不是 Subscription 的子进程，也不由 poll cycle 启动。调用方只执行一次目标命令，并以 atomic rename 写入固定 workspace completion receipt；Subscription Plugin 只能通过 allowlist command probe 只读该 receipt。缺少 receipt 表示仍在运行，terminal receipt 才能触发 `subscription.fire`，因此 Runtime 重启或重试不会重新执行目标命令。

## 恢复与隔离

Subscription 使用有限 max attempts、deadline 与指数退火。重启后从 durable next poll 继续。取消、过期或撤销的 Subscription 不再 fire。

Subscription cycle 的异常只记录为该 cycle failure，不能结束 Local Runtime loop。fire 后的 Agent invocation、`agent.result` Event、ResultHandler Execution 与 Delivery 全部由统一 Runtime core 接管，不存在单独 continuation worker 或 Room continuation handler。

## 控制面

CLI 提供 add/list/inspect/pause/resume/cancel/revoke。Loopback Console 展示 Subscription 与由它产生的 Event 审计链；Console 不创建 Subscription、不修改 Plugin/config，不提供 Event 写入口。

## Change guidance

- 新 probe kind 必须定义 side-effect policy、secret、timeout/output 和取消语义。
- 监控 shell command 时保持“外部执行一次、receipt 原子写、probe 只读”的边界；不要把目标命令藏进 Plugin 或 poll cycle。
- 新 Plugin slot 必须定义 bounded input/output、host-owned I/O、权限 grant、版本和失败隔离；Plugin 不能扩展 Event core。
- 不把 poll/observation 状态升级成 Event；持续非 terminal monitoring 留待后续版本重新设计。
- callback 若需要结果二次加工，必须创建新的 canonical Event。
