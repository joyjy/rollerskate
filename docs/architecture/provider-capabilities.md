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
| Claude Code | 日志启用时 `--print --output-format stream-json --verbose --include-partial-messages`，其他调用保留 JSON 结果，后续 `--resume`；Chat MCP 工具；Host 复检 resumed receipt identity | 默认终态结果 1 MiB；公开流式输出写入文件，仍无等价的 meaningful-idle watchdog | 进程超时/终止，不宣称协议级 interrupt 或 meaningful-idle 语义等价 |

每次 invocation 仍创建 provider 进程。接续 Session 可以利用 provider 已持久保存的对话及其恢复逻辑，但不保证旧进程的 shell、PTY、后台任务、watcher 或其他内存对象延续；当前没有常驻 app-server pool。恢复时实际返回的 provider Session 必须与本次请求一致，不能以另一 Session 的结果覆盖它。已声明的 adapter/policy identity 变更仍按既有 Session 退役规则处理，不等于原 Session 被成功恢复。

1 MiB 不是模型 context window：它分别可能是 assistant/result 限额、传输 record 限额或 RS 工具回传预算。不能把所有限制一起放大。Codex 的协议记录与结果预算已拆开；Kimi typed request 在有副作用的工具执行前预留响应空间，普通工具错误以 bounded result 返回原 Session。超过 history 或调用次数预算仍明确失败。Claude 的终态 JSON 结果仍受独立输出预算限制，超预算不能伪装为成功。

RS 的业务事实由各领域 durable source 持有，Session 只承载对话接续。Chat 和 Run 都不能因为 provider 失败就重放可能已产生效果的整轮；Chat 新执行最多一次，历史 retry 也在调用 provider 前阻断。人工回答必须恢复原 Run checkpoint 的可用 idle Session，丢失时保留问题与证据并拒绝，不静默重建 Worker。远端回执丢失后的 Channel delivery outcome 保持 unknown，失败/撤权不代表副作用被撤销。

协议测试入口：`local/test/{codex-runtime-agent,codex-record-budget,kimi-code-runtime-agent,pi-runtime-agent,claude-code-runtime-agent}.test.ts`；跨 adapter Host / fallback 恢复测试见 `local-chat-flow.test.ts`、`client-history.test.ts`，Run 人工回答见 `chat-human-answer.test.ts`。

## Local Chat 原生网页搜索

Console 的 Participants 是加入/移除和加入后工具控制的唯一列表；每个已加入 Agent 展开 Client history、Web search、presence 与 Session continuity。工具授权属于该 Local Agent，跨 Local Chat turn 保留；移除参与者保留设置，但运行前必须重新通过当前 roster、active lifecycle、running dispatch 与 Session 校验。开关在下一次 provider invocation（含同 Session continuation）生效，不中断已经开始的调用。

| Client | 当前搜索控制 | 证据边界 |
| --- | --- | --- |
| Codex | 每轮显式 `web_search=live|disabled`，默认 disabled | app-server `webSearch` completed item 进入既有 invocation toolUsage；不扩大 shell network access |
| Claude Code | 每轮 `--tools` 及 `--allowedTools` 增减原生 `WebSearch` | 工具注册受实际 provider 支持影响；JSON terminal 输出未提供调用明细时不合成 toolUsage |
| Kimi Code | Unsupported | 当前 ACP 接入没有已验证的逐轮原生搜索开关；不将 UI 状态冒充工具隔离 |
| Pi | `pi-web-access@0.29.0` 的 Exa MCP 搜索，按调用加载受控 Pi 扩展 | 开启仅注册 `web_search`；关闭不加载扩展，保留同 Session 和原 RS 工具，不开放抓取、克隆、provider 自动回退或环境凭据解析 |

`application/chat/web-search.ts` 拥有授权检查与 Console projection，`modules/agent/web-search.ts` 拥有当前 adapter 能力声明；bootstrap 将授权 resolver 注入支持的 adapter。配置损坏或 authority/roster 校验失败时不开放搜索。调用证据仍在原 Execution invocation receipt；链接和模型自述不构成工具调用证据。验证入口为 `chat-web-search.test.ts`、对应 adapter tests、Console Participants tests。

Pi 的集成入口为 `local/resources/agents/pi-exa-extension.ts`，经 Pi TypeScript loader 导入锁定依赖的 `callExaMcp`；`pi-exa-search.mjs` 只拥有固定查询 schema、20 秒预算与 16000 字符结果上限。只调用免 key 的 `web_search_exa`（最多 5 条），限流和网络错误原样作为工具失败，不合成结果。完整 `pi-web-access` 交互扩展不加载；dependency 版本和实际使用的源码加入既有 provider policy 内容指纹。开关复用 Owner 搜索授权；无额外配置文件、MCP server 进程或后台服务。

执行过程日志由 `core/runtime/agent-invocation.ts` 声明公开输出回调，runner 在已核验的当前 Session/Turn 内发出事件。bootstrap 注入私有文件 journal。过程正文不进入 SQLite，状态和重试仍归既有 Execution。存储、运行中读取与维护见 [执行日志 runbook](../runbook/agent-invocation-logs.md)。
