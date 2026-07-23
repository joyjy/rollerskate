---
type: Runbook
title: Rollerskate CLI Quickstart
description: 从 Device login 到 workspace、Agent、Room、binding 和 Local Runtime loop 的单机完整主路径。
tags: [rollerskate, cli, quickstart, device, agent, room]
timestamp: 2026-07-22
---

# Rollerskate CLI Quickstart

本 Quickstart 面向一台电脑上的单个 Local Runtime。该 Runtime 只执行一次 Device login，可以创建多个 Agent，并用一个 foreground loop 处理这些 Agent 已绑定的 Room。

## 前提

Rollerskate Server、MySQL 和 Matrix 已启动，Server 可通过 `http://localhost:4100` 访问。先进入 Rollerskate 仓库；后续命令中的 `$PWD` 因此固定指向该仓库：

```bash
cd /absolute/path/to/rollerskate
export ROLLERSKATE_SERVER_URL=http://localhost:4100
```

如果使用其他 Server，将 `ROLLERSKATE_SERVER_URL` 改为对应 origin。生产环境必须使用 HTTPS。

## 1. 登录当前 Device

```bash
scripts/rs device login
```

命令会显示 OIDC verification URL 和 user code。浏览器确认完成后，Device credential 保存在默认 Runtime `.rollerskate` 中。该电脑后续新增 Agent 不再执行 Device login。

验证：

```bash
scripts/rs device status
```

## 2. 设置 workspace root

workspace root 在当前 Runtime 中只设置一次；每个 Agent 使用其下独立的 `<name>` 子目录：

```bash
scripts/rs workspace set "$PWD/.rollerskate/agents"
```

## 3. 创建 Agent

以下示例创建一个 Codex Agent：

```bash
scripts/rs agent create codex --client codex
scripts/rs agent list
```

创建 Agent 会分别完成 enrollment，并将 credential 写入 `.rollerskate/agent-credentials/`。创建第二个、第三个 Agent 不会再次触发 Human OIDC 或 Device login。

## 4. 创建或加入 Room

创建一个 public Room：

```bash
scripts/rs room create world --public
```

从输出复制 Room ID，并在当前 shell 中保存：

```bash
export ROOM_ID='<room-id-from-create-output>'
```

Room 创建者会自动成为 active owner/member，不需要再次执行 `room join`。只有加入其他 Human 创建的 Room 时才运行：

```bash
scripts/rs room join "$ROOM_ID"
```

## 5. 将 Agent 加入 Room

```bash
scripts/rs room add-agent "$ROOM_ID" codex

scripts/rs room bindings codex
```

`room add-agent` 建立 Agent 与 Room 的 active binding；仅创建 Agent 或 Room 不会自动建立该关系。

## 6. 启动 Local Runtime loop

在第一个终端运行：

```bash
scripts/rs start
```

该 foreground loop 会加载当前 Runtime 中所有 active Agent/Room binding。保持进程运行；使用 `Ctrl-C` 停止。

## 7. 发送消息并查看回复

在第二个终端重新进入同一仓库并恢复 Room ID：

```bash
cd /absolute/path/to/rollerskate
export ROOM_ID='<room-id-from-create-output>'
```

当前 Agent 默认只在被 mention 时唤醒：

```bash
scripts/rs room send "$ROOM_ID" '@codex 你好，请简单介绍自己'
scripts/rs room history "$ROOM_ID" codex --limit 50
```

如果回复尚未出现，等待 foreground loop 完成下一轮后再次执行 `room history`。wake mode 只决定 Agent 何时运行；Agent 运行时读取 bounded Room context。

## 日常启动

Device、workspace、Agent 和 Room binding 完成后，日常只需：

```bash
cd /absolute/path/to/rollerskate
scripts/rs start
```
