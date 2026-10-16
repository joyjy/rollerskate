---
type: Runbook
title: Rollerskate Local-First Quickstart
description: 无需 Server 登录，在全局 Runtime home 启动、添加 Local Agent 并使用唯一 Local Chat/Topic。
tags: [rollerskate, local-first, quickstart, agent, chat, topic, console]
timestamp: 2026-07-22
---

# Rollerskate Local-First Quickstart

本 Quickstart 面向一台电脑上的单个 Local Runtime。主路径只依赖本机，不需要 Rollerskate Server、OIDC、Device enrollment、Matrix 或 Room binding。

完整命令和参数见 [CLI Command Reference](./cli-reference.md)。

## 1. 启动

进入仓库后运行：

```bash
cd /absolute/path/to/rollerskate
scripts/rs start
```

首次启动会在 `~/.rollerskate/` 自动创建：

- LocalDevice；
- `~/.rollerskate/workspace`；
- Local Owner Principal；
- 唯一 Local Chat `Local` 及其 Local Topic；
- SQLite durable state 与后台 Core Loop。

`start` 等待 Runtime 和 Console ready 后返回，daemon 不依赖当前终端。浏览器默认打开 Local Console。没有 active Agent 时首页是 `Agents`；已有 active Agent 时首页是 `Chats / Local`。Console 直接由内置 Vite 从 `local/ui/src/` 提供，Agent 或开发者保存 Vue、TypeScript、CSS 后，已打开页面通过 HMR 更新，不需要重新 build 或重启 Runtime；修改 `local/src/` 等非 UI 源码后运行 `scripts/rs restart`。需要停止服务时运行 `scripts/rs stop`；调试进程生命周期时可显式使用 `scripts/rs start --foreground`，并用 `Ctrl-C` 停止。

Run 卡片提示恢复时，直接在 **Chat 原卡片**点击 **请 agent 准备方案**。这会给原负责 agent 发送一次准备请求，不续跑、不取消、不重建任务；agent 通过 `prepare_chat_run_recovery` 提交修正方案。卡片展示原因、实际动作、工作区与验收检查，Owner 审阅后确认才在原 Run 执行；不需要编辑 JSON 或跳转 Steward。符合条件的初始只读 fallback 可直接在卡片确认重试；取消也在原卡片确认，不撤销已有外部效果或自动重建任务。Steward 只展示恢复诊断及回 Chat 入口，Schedules / Subscriptions 本轮没有改变。

## 2. 添加 Local Agent

在 `Agents` 页面填写 1–32 字符的短 handle，例如 `researcher`，选择 Codex、Claude Code 或 Kimi Code client；可选启动参数按“一行一个 argv 参数”填写，然后选择 `Add Agent`。系统生成稳定 Principal ID；handle 只用于展示与 `@mention`。

创建首个 active Agent 后 UI 自动进入 `Chats / Local`。Agents 页面还提供启动参数配置、rename、suspend 和 resume，不提供永久删除。

也可以使用 CLI：

```bash
scripts/rs agent create researcher --client codex
scripts/rs agent create writer --client claude-code --launch-arg --model --launch-arg claude-sonnet-4-6
scripts/rs agent create explorer --client kimi-code --launch-arg --model --launch-arg kimi-code/kimi-for-coding
scripts/rs agent configure explorer --launch-arg --model --launch-arg kimi-code/k2.5
scripts/rs agent list
scripts/rs agent rename researcher helper
scripts/rs agent suspend helper
scripts/rs agent resume helper
```

## 3. 使用 Local

在 Chats composer 中明确 mention：

```text
@helper 检查 workspace 并给出摘要
```

消息 admission 会立即把 handle 解析为 generated Principal ID；Core Loop 的 ChatHandler 只唤起该 Agent。Agent 回复直接追加为 immutable `chat.message` 并继续经过同一 ChatHandler。

不写 mention 时，ChatHandler 会让每个 available Agent 自主决定 reply 或 silent。Agent 还能在每轮把 Topic 或 Global presence 设为 `snoozed`；Owner 可用 `scripts/rs chat presence set <handle> --scope <topic|global> --mode <available|snoozed> ...` 覆盖同一条 scoped state。直接 mention、对应 scope 的 literal wake keyword 或到期让它获得一次重新决策机会。

右侧 `Agent Sessions` 显示每个 Agent 的 current Session。选择 `New session` 只影响该 Agent 后续 dispatch，不删除旧 Session 或 Chat history。

不打开 UI 也可以完成同样操作：

```bash
scripts/rs chat post "@helper 检查 workspace 并给出摘要"
scripts/rs chat history
scripts/rs chat status
scripts/rs chat session new helper
```

Agent result 产生本地通知后，Console 右上角 `Notices` 显示 bounded 未读数。打开 Notice Center 可查看投递结果、标记已读、确认并下钻 Subscription/Event；失败通知可继续进入 Runtime Failure。read/ack 保存在 SQLite，刷新或重启不会丢失。CLI 等价入口是 `scripts/rs notice list|inspect|mark-read|ack`。

### 从 Chat proposal 启动 Run

当 Agent 判断 Owner 的当前消息已经足够形成可执行工作时，可以在该消息下提出 Run proposal。每个 Agent 的 proposal 是独立卡片，固定展示 goal、in/out scope、acceptance、workspace effect、Chat Lead、Run Orchestrator、participants，以及缺信息时至多一个结构化 blocker。

- Proposal 只是提醒，不会自动执行。需要读写文件时，先在卡片选择 `Rollerskate source`、Local runtime workspace 或其他绝对 Git workspace；`Use workspace` 只做无副作用预检，并显示 canonical root、workspace revision、read/write grant 与 network-off 状态。只有 `Ready for Owner` 且没有关联 Run 时才显示 `Start Run`。
- 工作区区域可按项目名 `Find workspaces`，选择候选或手改绝对路径。`Inspect selected path` 显示默认分支和 base SHA；填写用途后 `Fork Workspace` 创建旁置工作区并回填原卡片。`Use workspace` 继续使用所选路径，最后仍需 `Start Run`。Fork 成功但后续校验失败时用保留的结果继续；网络结果未知时 `Recover Fork result` 重用原请求。默认分支未知时可配置 `git config rollerskate.defaultBranch <真实默认分支>` 后重新检查，不猜 main/master；搜索配置与权限边界见 [Workspace 发现与 Fork](../architecture/workspace-discovery.md)。
- 不采用某张卡片时选择 `Decline proposal`；拒绝只作用于该 Agent 的 exact proposal，刷新或重启后仍显示 `Declined`，不会影响同一消息下其他卡片。已启动的卡片不能再拒绝。
- 选择 `Start Run` 只确认这张卡片屏幕上这一版 proposal + workspace revision 和 exact effect；proposal 或 workspace 漂移时，旧确认会被拒绝，需要重新预检。
- `Needs clarification` 只显示一个 blocker，不提供启动按钮。应在 Chat 中补充信息，让 Agent 针对新的 Owner message 重新提案。
- 启动后卡片从既有 Steward Run 回读 started、needs-human 或 terminal 状态与 bounded summary；选择 `Open Run` 进入 `/console/steward?runId=<runId>` 查看完整控制和诊断。
- 消息列表不提供直接启动 Run 的旁路；需要卡片时向 Agent 请求 proposal，选择工作区并检查后再确认。阅读状态圈在回执生成前显示灰色等待状态，之后显示各 Agent 的处理进度。

Local Runtime 每张 proposal 卡片最多关联一个 `chat-work:<messageId>:<dispatchEventId>` Run。同一卡片的浏览器重试或重复选择 `Start Run` 只返回同一个 Run；同一 Owner message 下不同 Agent 的卡片可以各自启动，不共享 participant 或 Run identity。

## 4. 隔离测试 Runtime

默认路径始终是 `~/.rollerskate/`，不读取当前仓库或启动目录里的旧 `.rollerskate/`。需要测试隔离时显式指定绝对路径：

```bash
scripts/rs --runtime /absolute/test/runtime start
```

Rollerskate 不自动迁移或删除旧 runtime。确认不再需要某个旧目录后，由用户自行处理。

## 可选：主动定时工作

Local Runtime 可以按 one-shot 或 cron 主动创建 Agent work，不需要 Server。创建、更新、misfire/overlap、Session policy 与 unknown recovery 见 [Scheduled Task runbook](./scheduled-tasks.md)；已有 Schedule 可以在 `/console/schedules` 查看和控制。

## 可选：Agent Run 与 acceptance Review

Local Runtime 可以由一个 Steward 完成 bounded objective，或顺序委派 Agent，并可通过 `review@1` 围绕 versioned Plan 完成有限返修和复核，不需要 Server。CLI admission、trace、cancel 与 recovery 见 [Agent Run runbook](./reviews.md)；全部真实 Run 在 `/console/steward` 查看。

## 日常启动

Local foundation、Agent、Chat Event、dispatch receipt 与 current Session 都会持久化。日常只需：

```bash
cd /absolute/path/to/rollerskate
scripts/rs start
```

## 可选 Server CLI

现有 Device login、Server Room 与 Matrix CLI 仍保留用于旧远端路径，但不属于 v0.3.1 Local UI，也不会显示 Server Room。需要维护远端开发环境时分别查看 [Server foundation](./server-foundation.md) 与 [Local MVP legacy runbook](./local-mvp.md)。
