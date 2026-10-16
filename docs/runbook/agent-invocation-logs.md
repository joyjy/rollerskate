---
type: Runbook
title: Agent 执行过程日志
tags: [rollerskate, agent, logs]
---

# Agent 执行过程日志

Runtime 将每次 Agent 调用写入独立 JSONL 文件。运行中就能读取已完成的行。日志是诊断证据，执行状态以 SQLite 中的 Execution 和 Run 为准。

## 路径与内容

日志路径是 `<runtime>/runs/<runId>/executions/<executionId>/attempt-<attempt>-<invocation UUID>.jsonl`。没有 Run 的 Chat 调用进入 `runs/unbound/`。每行包含 schema、时间、序号、Execution、attempt、Event、Agent、adapter 和可用的 Session 标识。Run 调用另含 Run、Step、cycle 和 parentStep 标识。provider session 在 provider 确认后补入后续行。

`AgentInvocationLog@1` 记录公开 assistant 文本、工具调用和工具结果。`assistant.delta` 是增量，`assistant.message` 是完整消息，不能把两者直接拼接。工具事件保留 provider 的调用 ID 和状态。thought 只保存标记，隐藏推理正文不落盘。Claude 的工具参数增量只记元数据，完整工具输入在公开 tool-use 块到达后记录。

`invocation.completed` 只表示 provider 调用返回。`invocation.failed` 记录错误类型和可用的结构化失败原因。原始进程诊断可能包含隐藏推理，不复制到日志。最后的 `execution.state` 读取数据库中的执行状态，可能是 `retry_wait`。这些事件不表示 Run 已通过业务验收。

文件权限为 `0600`，日志目录为 `0700`。大于 32 KiB 的单条内容写入同目录的 `.payload.json`。JSONL 保留相对文件名和字节数。

单条内容超过 1 MiB 时只记省略原因。每次调用的内容预算为 32 MiB，达到上限后记录 `output.truncated`。调用终态和执行状态仍保留。文件及旁路内容合计上界为 34 MiB。

写入前会隐藏敏感字段、已知环境凭据、Bearer、常见 key 和 URL 密码。脱敏是尽力处理，不能识别所有业务秘密。跨事件拆开的自定义秘密也可能无法识别。不要把日志公开分享。

## 运行中查看

以下命令使用默认 Runtime。其他实例需在命令前添加 `--runtime <absolute-path>`。

```sh
scripts/rs run-log list --run <run-id>
scripts/rs run-log read <absolute-jsonl-path>
scripts/rs run-log read <absolute-jsonl-path> --after-sequence 100
scripts/rs run-log payload <absolute-payload-path>
scripts/rs run-log stats
```

`list` 返回日志路径和保护原因。`read` 返回已完成的 JSONL 行。`--after-sequence` 返回指定序号之后的记录，便于增量查看。大结果使用日志所在目录中的相对引用。`payload` 按原逻辑路径读取普通或压缩结果。普通文件也能用 `tail -f <absolute-jsonl-path>` 查看。

进程崩溃后，reader 忽略末尾未完成的行。日志缺少终态时，结果保持未知。普通追加写入后即可读取，关闭时执行 fsync。运行中的尾部不保证断电持久性。

## 压缩与清理

维护命令默认只返回预览。压缩默认等待 7 天，清理默认等待 30 天。可用 `--older-than-days <N>` 指定天数。

```sh
scripts/rs run-log compress
scripts/rs run-log cleanup
```

预览返回 `revision`、具体路径、动作、字节数和保护原因。确认清单后，用同一组选项和 revision 执行：

```sh
scripts/rs run-log compress --apply --revision <preview-SHA>
scripts/rs run-log cleanup --apply --revision <preview-SHA>
```

清理会永久删除预览中的文件。执行清理前必须审阅并明确确认具体路径。本文的命令示例不授予 agent 删除权限。

只有已归档的 `succeeded`、`failed`、`cancelled` Run 才能维护。`needs_human`、未绑定 Run、未知状态和未封存日志均受保护。清理以整个 Run 为单位，保留同一 Run 下所有 Step 的父子关系。JSONL、封存标记和旁路结果使用同一保留期，不单独删除子结果。`progress.json` 和业务状态不在清理范围。

writer 只创建新的调用文件，绝不重新追加旧文件。writer 关闭文件后才写 `.sealed` 标记。压缩只能处理封存文件。writer 注册和维护共用独占锁，维护执行前复核预览。文件、状态或选择条件变化时，旧预览失效。

JSONL 和旁路结果的冷压缩使用 gzip。压缩保留权限和修改时间。压缩成功且解压校验通过后才替换原文件。reader 优先读取普通 `.jsonl`，缺少普通文件时读取 `.jsonl.gz`。本实现没有恢复追加旧日志的入口，因此无需写前还原。

维护已开始写入后失败会保留 `<runtime>/runs/.maintenance.lock`。预检拒绝会释放锁。残留锁阻止后续维护和日志注册。日志创建失败只发告警，不改变 Agent 执行和重试。恢复锁前，必须确认原维护进程已退出并检查普通文件、压缩文件与临时文件。恢复操作仍需按具体路径确认。

## Provider 与验证范围

Codex app-server、Kimi ACP 和 Pi RPC 在既有流式边界记录输出。Claude Code 在日志启用时使用 `stream-json --verbose --include-partial-messages`，仍由原终态 decoder 校验成功结果。Chat 的同 Session 工具接续继续传递输出回调。

新增功能不建立日志 SQLite 表，不复制过程正文到数据库。因此本次不需要日志库 incremental vacuum，也不改变 Runtime 数据库的 vacuum 配置。冷压缩按需执行，不增加后台 loop。

参考：

- [Codex 压缩读取与写前还原](https://github.com/openai/codex/pull/25087)
- [Codex 冷压缩及竞态边界](https://github.com/openai/codex/pull/25089)
- [Codex 日志库空间回收](https://github.com/openai/codex/pull/49069)
- [Claude 应用数据目录](https://code.claude.com/docs/en/claude-directory)
- [Claude 流式输出](https://code.claude.com/docs/en/headless#stream-responses)。
