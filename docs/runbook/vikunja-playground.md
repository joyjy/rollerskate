---
type: Runbook
title: Vikunja Playground Connector Runbook
description: 配置、验证并恢复 Rollerskate playground@1 Vikunja Connector。
tags: [rollerskate, vikunja, connector, playground, recovery]
---

# Vikunja Playground Connector Runbook

## 运行边界

Vikunja `playground@1` Connector 实现严格的 `describe/observe/read`，只支持 Project 与 WorkItem 的 bounded 读取和 observation。Vikunja 是 Project、Task、comment 与 provider revision 的权威；Connector 只输出 `ExternalRef@1`、bounded snapshot 和 `Observation@1`，不复制完整历史，也不提供通用 mutation。

Integration binding 只保存 endpoint、`credentialRef`、profile/schema allowlist 和 placement。placement 必须在调用时解析 `credentialRef`，通过内存中的 token callback 交给 Connector；token 不得进入参数、binding response、ledger、Agent prompt、Delivery payload 或普通日志。非 loopback endpoint 必须使用 HTTPS，loopback 开发允许 `http://127.0.0.1`、`http://localhost` 或 `http://[::1]`。

写回结果不经过 Connector apply 或 Server effect ledger。Host 在 Steward Run admission 时可提供一个 Vikunja Task URL；terminal Run 建立普通 `vikunja-task` Core Delivery，adapter 用 token 向该 Task 追加 comment。Task URL 不授予 participant、workspace、workflow 或其他 provider 操作权限。

## 隔离 smoke

先确认本地 Vikunja 已在 `127.0.0.1:3456` 运行并允许注册，再执行：

```bash
ROLLERSKATE_VIKUNJA_URL=http://127.0.0.1:3456 \
ROLLERSKATE_VIKUNJA_SMOKE_ALLOW_WRITE=true \
npm --prefix local run smoke:vikunja
```

该命令只在显式 `ROLLERSKATE_VIKUNJA_SMOKE_ALLOW_WRITE=true` 时运行。它会在内存中生成随机 username/password，注册隔离用户，登录后通过 provider setup API 创建专属 Project 和一个 Task；随后通过 read-only Connector 验证 observe/read，并用普通 Task Destination 连续投递同一个 delivery 两次，确认隐藏 marker 只出现一次。输出只包含隔离 username、provider ID、observed revision 和 delivery receipt，不包含 password/token。

smoke 会删除自己创建的本地临时 ledger，但会保留 Vikunja 中的隔离用户、Project、Task 与关联证据，方便人工检查。清理这些 provider artifact 是 destructive action，必须另行列出 exact target 并确认，不能由 smoke 自动执行。

## Cursor 与重启恢复

生产装配必须给每个 Integration binding 一个稳定、私有的 ledger path。Connector 以 mode 0600 原子写 ledger，拒绝 symlink 和 group/world-readable 文件。

- `observe` 对同一个输入 cursor 返回完全相同的 pending batch；只有调用方使用 `nextCursor` 再次调用，Connector 才提交该批 revision checkpoint。
- 未 acknowledge 时重启，仍返回原 pending batch，不跳过 provider change。
- task listing 使用 provider 的全局 Task endpoint 和 exact `project = <id> && done in true, false` filter，避免 Vikunja 默认 list view 隐藏 done Task；每个返回 Task 仍要通过 `project_id` scope check。
- pagination 固定按 provider Task ID 升序；checkpoint 只保存 external ID/revision，不保存完整 provider payload。

## Steward Run writeback

普通 Steward Run 通过 `run start` 进入既有 engine。未指定 steward 时，当前 active 的 `codex` Local Agent 作为 Orchestrator；Worker roster、objective/acceptance、workspace grant、deadline 和 step budget 在 admission 时固定。可选 `taskUrl` 只建立 terminal reply destination，不触发 provider read，也不改变 Run authority。

Agent 可以在 objective 中接收用户临时给出的 Vikunja Task 链接，并像其他普通 context reference 一样处理。Runtime 不自动把链接解析成 Project、participant、policy 或 seed snapshot。需要当前 Task 内容时，由上层显式调用 Connector read 或其他已授权工具；结果写回只发生在 Run terminal 后。

真实 Orchestrator dogfood 使用普通 Run CLI：先确保 Runtime 已配置 active `codex` Orchestrator、至少一个 Worker，以及成对的 `ROLLERSKATE_VIKUNJA_URL` / `ROLLERSKATE_VIKUNJA_TOKEN`。Task URL 的 origin 必须与配置的 endpoint 一致，避免把凭据发送到用户输入的其他域名。start input 可以携带 `taskUrl` 和 participant handles；具体 JSON/CLI 形状以 `scripts/rs run start --help` 与 Console schema 为准。隔离 provider write path 先用上面的 smoke 验证。

## Delivery 恢复

每个 terminal writeback 使用 Core `delivery_id` 生成稳定隐藏 marker：`<!-- rollerskate-delivery:<delivery_id> -->`。adapter 写前读取最近 comments；不存在 marker 才 PUT，随后再次读取确认。结果为：

- provider 明确失败：Core 按普通 Delivery retry policy 处理；
- transport 在 PUT 后中断：下一次 retry 先找到已有 marker，返回同一 receipt，不再追加；
- Runtime 在 terminal Run 与 Delivery 之间重启：pending Delivery 由唯一 loop 恢复；Run 不会因此回到 non-terminal；
- token/adapter 暂不可用：Delivery 保持可诊断、可重试，manual Run result 仍可从 `run inspect` 读取。

不要手工删除 marker 或复制相同 delivery ID 到另一 Task。若用户需要修改已经写回的结论，应启动新的 Run/Delivery，让它拥有新的 idempotency identity。
