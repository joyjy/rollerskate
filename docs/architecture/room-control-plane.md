---
type: Architecture
title: Rollerskate Room Control Plane
description: Room、Human membership、AgentRoomBinding、Matrix Application Service、cursor/range 与在线 stream 的当前实现边界。
tags: [rollerskate, room, matrix, server, cursor]
timestamp: 2026-07-20
---

# Room Control Plane

[返回 architecture index](./index.md)

## 产品事实与 Matrix 事实

Server 中的 `Room`、`RoomHumanMembership`、`AgentRoomBinding` 与 Matrix membership 是不同事实。Matrix membership 只表示 virtual user 已进入 transport Room，不能授予 Agent 调用 Room API、读取历史或接收候选 Event 的权限；所有 Agent endpoint 都要求请求 credential 与 path 中的 Agent 完全匹配，并存在 active binding。

`public` Room 对 deployment 内已认证 Human 可发现和加入；Agent owner/operator 可以主动建立 binding。`private` Room 只有 active 且 `can_invite` 的 Human member 才能邀请其他 Human 或自己拥有/运维的 Agent；Human invitation 先形成 `invited` membership，受邀者显式 join 后才变成 `active`。新 binding 固定从 `mention_only` 开始，只有 Agent owner/operator 可以切换 `disabled|mention_only|proactive` 或让 Agent 离开。

## Matrix Application Service

Server 使用 Application Service token 创建 Human/Agent virtual principal、Room、membership 和 message。AS token 与 homeserver token 都只从 Server 环境读取；出站 Matrix 请求把 AS token 放在 `Authorization: Bearer` header，不放 query 或产品协议。homeserver 只通过带 HS token 的 `PUT /_matrix/app/v1/transactions/:txnId` 投递事件。

Matrix transaction 与 `matrix_event_id` 分别去重。一个 Matrix Event 在 Server 只形成一份 `EventEnvelope` 与 Room sequence；active bindings 再按 wake mode 形成独立在线候选。`disabled` 不推送，`mention_only` 只对 Matrix `m.mentions.user_ids` 中的目标 Agent 推送，`proactive` 接收所有新 message Event。

## Cursor、range 与 stream

每个 Room 在 MySQL 中维护单调递增的 `head_sequence`。对外 cursor 是绑定 Room identity 的 opaque `r1.<base64url>` 值；调用方不能把一个 Room 的 cursor 用于另一个 Room。Agent 先读取 `room_head = H`，再用 `after/through=H/limit` 分页取得固定快照，`H` 之后到达的 Event 留给下一轮。

SSE stream 只发送连接建立后的在线 Event，不保存离线 backlog。Local Runtime 恢复时必须通过 head/range 补 gap；Server 不把断线期间的 Event 重新塞入 stream，也不在这个阶段调用 Agent provider。

## 持久化与进程边界

MySQL migration `0004_room_control_plane` 增加 Room metadata/head、Human membership、Agent binding ownership、Matrix principal/transaction 和完整 Event JSON。Room sequence 分配与 Event insert 在同一 MySQL transaction 内完成，并以 Room row lock 串行化；SQL 已在 MySQL 8.4 验证。

在线 broker 当前是 Server 单进程内存 fan-out，没有跨实例 pub/sub。Phase 3 因此只支持单个 BFF 进程；若未来水平扩容，必须先增加 durable/cluster event notification，同时保持 head/range 是恢复事实源。
