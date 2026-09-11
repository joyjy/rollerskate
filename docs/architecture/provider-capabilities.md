---
type: Architecture
title: Provider 能力与恢复边界
timestamp: 2026-09-10
---

# Provider 能力与恢复边界

本表描述 RS 当前 adapter 的实现契约，不代表厂商产品全部能力，也不代替真实 provider 验收。共同接口由 `core/runtime/agent-invocation.ts` 持有，协议装配归 `integrations/agent/`，Chat 工具及 typed request 接续归 `application/chat/`。

| Adapter | Session 与工具 | 输出预算与进度 | 停止与降级 |
| --- | --- | --- | --- |
| Codex | app-server `thread/start` / `thread/resume`，校验 exact Thread；invocation-scoped MCP tools | assistant 默认 1 MiB；协议 record 独立 16 MiB，resume 不把历史 transcript 算成本轮结果；有流式 progress / meaningful-idle watchdog | `turn/interrupt`；超时或中断不能证明外部写入未发生 |
| Kimi Code | ACP v1 new/resume，缺 resume capability 则拒绝；access 绑定 versioned Session reference；Chat 使用 `ChatToolRequest@1` 同 Session 接续 | assistant 默认 1 MiB，超大 tool trace 不计入 assistant；有 meaningful-idle watchdog；Chat history/tool response 共享 1 MiB 预算 | `session/cancel`；typed request 是显式降级，不宣称 native MCP 同等能力 |
| pi | RPC `--session-id`，`get_state` 校验 exact identity；content-attested native extension tools | 丢弃超预算单条 RPC trace，继续等待短结果；`agent_settled` 为 terminal；有 meaningful-idle watchdog | `abort`；丢失 trace 后 diagnostics 保持 unknown |
| Claude Code | 每次 `--print --output-format json`，后续 `--resume`；Chat MCP 工具；Host 复检 resumed receipt identity | 默认整份结果输出 1 MiB；当前没有与前三者等价的流式进度/meaningful-idle 协议 | 进程超时/终止，不宣称协议级 interrupt 或实时工具进度等价 |

每次 invocation 仍创建 provider 进程。接续 Session 可以利用 provider 已持久保存的对话及其恢复逻辑，但不保证旧进程的 shell、PTY、后台任务、watcher 或其他内存对象延续；当前没有常驻 app-server pool。恢复时实际返回的 provider Session 必须与本次请求一致，不能以另一 Session 的结果覆盖它。已声明的 adapter/policy identity 变更仍按既有 Session 退役规则处理，不等于原 Session 被成功恢复。

1 MiB 不是模型 context window：它分别可能是 assistant/result 限额、传输 record 限额或 RS 工具回传预算。不能把所有限制一起放大。Codex 的协议记录与结果预算已拆开；Kimi typed request 在有副作用的工具执行前预留响应空间，普通工具错误以 bounded result 返回原 Session。超过 history 或调用次数预算仍明确失败。Claude 整份 JSON 输出的限制仍在，超预算不能伪装为成功。

RS 的业务事实由各领域 durable source 持有，Session 只承载对话接续。Chat 和 Run 都不能因为 provider 失败就重放可能已产生效果的整轮；Chat 新执行最多一次，历史 retry 也在调用 provider 前阻断。人工回答必须恢复原 Run checkpoint 的可用 idle Session，丢失时保留问题与证据并拒绝，不静默重建 Worker。远端回执丢失后的 Channel delivery outcome 保持 unknown，失败/撤权不代表副作用被撤销。

协议测试入口：`local/test/{codex-runtime-agent,codex-record-budget,kimi-code-runtime-agent,pi-runtime-agent,claude-code-runtime-agent}.test.ts`；跨 adapter Host / fallback 恢复测试见 `local-chat-flow.test.ts`、`client-history.test.ts`，Run 人工回答见 `chat-human-answer.test.ts`。真实 provider 的功能与恢复能力应按此矩阵分别验证。
