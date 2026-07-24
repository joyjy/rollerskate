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
- SQLite durable state 与前台 loop。

浏览器默认打开 Local Console。没有 active Agent 时首页是 `Agents`；已有 active Agent 时首页是 `Chats / Local`。保持命令运行；使用 `Ctrl-C` 停止 loop 和 UI。

## 2. 添加 Local Agent

在 `Agents` 页面填写 1–32 字符的短 handle，例如 `researcher`，选择 Codex client，然后选择 `Add Agent`。系统生成稳定 Principal ID；handle 只用于展示与 `@mention`。

创建首个 active Agent 后 UI 自动进入 `Chats / Local`。Agents 页面还提供 rename、suspend 和 resume，不提供永久删除。

也可以使用 CLI：

```bash
scripts/rs agent create researcher --client codex
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

消息 admission 会立即把 handle 解析为 generated Principal ID，并创建一次 Agent Execution。Agent 回复直接追加为 immutable `chat.message`。

不写 mention 时，前台 loop 会追加一条 system message 与单选 dispatch card；选择一个 active Agent 即可分发。每条原消息最多成功 dispatch 一次，重复点击或重启不会重复调用 Agent。

右侧 `Agent Sessions` 显示每个 Agent 的 current Session。选择 `New session` 只影响该 Agent 后续 dispatch，不删除旧 Session 或 Chat history。

## 4. 隔离测试 Runtime

默认路径始终是 `~/.rollerskate/`，不读取当前仓库或启动目录里的旧 `.rollerskate/`。需要测试隔离时显式指定绝对路径：

```bash
scripts/rs --runtime /absolute/test/runtime start
```

Rollerskate 不自动迁移或删除旧 runtime。确认不再需要某个旧目录后，由用户自行处理。

## 日常启动

Local foundation、Agent、Chat Event、dispatch receipt 与 current Session 都会持久化。日常只需：

```bash
cd /absolute/path/to/rollerskate
scripts/rs start
```

## 可选 Server CLI

现有 Device login、Server Room 与 Matrix CLI 仍保留用于旧远端路径，但不属于 v0.3.1 Local UI，也不会显示 Server Room。需要维护远端开发环境时分别查看 [Server foundation](./server-foundation.md) 与 [Local MVP legacy runbook](./local-mvp.md)。
