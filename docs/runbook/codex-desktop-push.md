# 将 Chat 回复与 Subscription 观察 push 到 Codex Desktop

Owner 可以将一条发给指定 Agent 的 Local Chat 请求绑定到本机已加载的 Codex Desktop 任务。Agent 的直接回复通过现有 Runtime Delivery 自动推送；silent、失败、其他 Agent 的回复、后续对话和独立 Run 结果不会自动外发。

RS 内置 Desktop IPC 传输，随 Local package 构建发布，只使用 RS 已有的 Node 运行时；用户不需要安装 ai-meta、Python 或外部 `codex-push` helper。本机 Codex Desktop 需要正在运行且已加载目标任务。

```sh
scripts/rs start --no-open
scripts/rs chat post --codex-thread <完整任务UUID> -- '@codex 请回答这个问题'
```

默认连接同一用户的 `~/.codex/ipc/ipc.sock`，校验 socket 与父目录的属主和写权限。需要自定义 socket 时，在 Runtime 启动时设置 `ROLLERSKATE_CODEX_IPC_SOCKET=/absolute/path/ipc.sock`。Desktop 传输实现在 `local/src/integrations/codex-desktop/`；Runtime Delivery 与 Owner CLI 共用它。

Owner 或已授权的外部进程可直接调用：

```sh
printf '%s' '外部执行结果' | scripts/rs codex-push --thread <完整任务UUID> send
```

直接入口从 stdin 读取至多 64 KiB 正文，可选 `--socket <path>`、`--timeout <seconds>`（默认 20，最大 60）。它只向 exact 任务发送一次，不建立 Subscription、Delivery 或新的监控权限；返回 `CodexPushReceipt@1`，退出码 accepted=0、not_sent=1、rejected=2、unknown=3。

`--codex-thread` 必须位于正文之前，并使用 `--` 分隔。正文必须明确 mention 恰好一个 active participant；任务 UUID 不从最近任务、当前窗口或 Agent 输出推断。每次带该参数提交请求，只授权把该 Agent 对本请求的直接回复发到此任务。此入口属于本机 Owner CLI，不新增 Agent 任意发送工具，也不扩大 provider 沙箱权限。

CLI 返回 canonical Owner `eventId`。用 `scripts/rs event trace <event-id>` 找到直接 `chat.dispatch` 与 Agent reply Event，再用 `scripts/rs event trace <reply-event-id>` 读取 Delivery 和 Desktop receipt；Delivery 的 `origin.id` 是该 reply Event，Console 的对应 Event audit 也可查看。推送消息保留 Agent 回复正文；请求、回复、Agent、Topic、Delivery 和正文摘要保存在 Delivery receipt 中，正文仍为来源数据。投递的 IPC 连接在 Delivery 执行时建立，回执后关闭；Run 预检另用短连接做只读 owner discovery，不发送用户输入。无模型轮询和额外常驻进程。

`CodexPushReceipt@1.status=accepted` 仅证明 Desktop owner 返回 turn ID；RS 将它保存为 Delivery receipt，并标记 `delivered`（传输接受）。端到端验收仍要求唯一标记实际出现在指定任务中。内置传输先尝试 steer，仅在 exact 任务明确返回 active turn 已结束、证明输入未提交后，才向同一 owner 调用一次 start，继承该任务的模型、工作目录和权限；跨设备、远端和应用重启后未加载的任务尚未验证。

每条 Desktop Delivery 只有一次尝试。传输的 `not_sent/rejected/unknown` 回执保留在 `lastError`；超时、异常回执、进程中断按未知结果处理，Runtime 崩溃恢复使用 `runtime_interrupted_unknown`。它们都终态为 `failed`，不会自动重发。对同一 Delivery 调用通用 failure retry 会被拒绝并保留原回执；必须先核验目标任务实际消息，再由 Owner 决定是否发起新请求。消息（包括来源封装）超过 64 KiB 时在外发前失败。

新版本将 Local schema v74 升为 v75，为现有 `deliveries.destination_kind` 增加 `codex-desktop`，保留旧记录、receipt 和重试预算；必须先停止旧 Runtime 再升级。旧源码不读取 v75，回退应使用升级前的完整 Runtime 备份。Desktop IPC 协议由 RS integration 维护，Desktop 更新后应重新做实际接收验收。

## Agent Run 终态回传

Agent Run 使用已登记的 `destination:<dst-id>`。目标 kind 必须是 `codex-desktop`，地址绑定 exact `threadId`。`run preflight/start` 检查目标格式和当前 Desktop owner。预检不发送消息，也不保证未来投递成功。

Worker checkpoint、DAG 收件和终态投递都支持该目标。Run/cycle 的 succeeded、failed、needs_human 和 cancelled 终态创建 Delivery。新 Agent Run 会在 admission 同一事务注册 Run Subscription（返回 subscriptionId）；它还报告等待编排、执行失败、deadline 耗尽和重启后恢复监控等状态。Desktop 回传正文包含终态摘要，产物和完整 trace 仍在 Run Workspace。原有 Chat 请求不会自动授权独立 Run 回传，Run 必须显式绑定 destination。

Delivery receipt 保存 runId、rootEventId、可选 cycleId、目标任务和正文摘要。accepted 只证明传输接受。真实验收还须在绑定任务里看到本次唯一标记。投递失败不会把已结束的 Run 恢复为 active，也不会重跑 Agent。

### 自动 Run Subscription

Run Subscription 根据 immutable destination 回传 exact Desktop task；Local Chat Run 则沿原 dispatch 和负责 Session 返回。没有返回目标时 admission receipt 的 monitoring 与详情明确标记 blocked，不猜测最近会话。查询使用 `scripts/rs subscription run-monitors`、`scripts/rs subscription inspect <sub_run_id>`、`scripts/rs subscription deliveries <sub_run_id>`；`run inspect` 也返回 monitoring。已有 command/observe Run 继续使用其准入时自动建立的 source Subscription。

异常通知不等于任务失败终态；等待编排、Execution failed/retry_wait、deadline 与人工问题都需读取 Run 原始状态再继续。终态通知复用原 Delivery identity，重复扫描和重启不重复执行 Run。Runtime 恢复后继续观察、报告 monitoring_resumed；旧 delivering 的未知结果沿 Desktop 单次投递边界保持 failed/blocked，不盲目补发。Runtime 完全停止期间不能自行即时通知，恢复检查在下一次启动后进行。

Subscription 的 completed 仅表示已观察到 Run 终态且通知无待投递或失败记录。Desktop delivered 仍只证明传输接受；Chat 回传还检查负责回合实际生成可见回复及其 Delivery，silent、skip、失败或未送达保留 blocked/pending。监控不会因为 Run 已结束而丢弃通知失败，也不会因此重新执行工作。

## 将等待与检查交给 Subscription

### 预计耗时较长的本地命令

安装软件、安装依赖、下载文件、拉取镜像、构建与批处理等已获授权的非交互命令，预计耗时较长时，Agent 应在启动前使用 `run start`。入口自动建立完成凭据和 Subscription；不能只以“尚未接入凭据”为由回退普通等待。短命令无需后台化；已经启动且没有回执的命令不为接入而重复执行。

```sh
scripts/rs run preflight --id pull-postgres-1 --return-to codex-desktop:<当前任务完整UUID> --cwd /absolute/workspace --title '拉取 PostgreSQL 镜像' --timeout 3600 -- docker pull postgres:17
scripts/rs run start --id pull-postgres-1 --return-to codex-desktop:<当前任务完整UUID> --cwd /absolute/workspace --title '拉取 PostgreSQL 镜像' --timeout 3600 -- docker pull postgres:17
scripts/rs run inspect <返回的runId>
```

示例不授权下载。执行前绑定原命令、明确 cwd、当前任务完整 UUID，并确认目标仍在本机 Desktop 加载；不选择最近任务或相似标题。联网、安装、提权、远端写入仍按原命令申请权限，审批时保留 `--` 后完整命令，不为可执行任意命令的 `run start` 设置通用持久提权前缀。入口继承调用者权限，不申请 sudo、不提升权限、不让 Runtime 代为运行原命令。需要 TTY、口令或人工交互时保留前台流程。

预检与启动共用编译器，检查权限/工具声明、路径、source 绑定和 Runtime freshness；指定 Desktop 目标时以只读 discovery 检查 exact 本机 owner 和 untrusted-input 支持，缺失时在工作启动前阻断；完成探测由源码内固定工具生成，无需调用方拼装 Plugin/Subscription JSON。完整输入、结构化诊断、退出码和确定性 Run 语义归 [CLI Reference](cli-reference.md#统一-run-提交与预检)。

执行者在 `<runtime>/commands/<runId>/receipt.json` 原子写入 `ShellCommandReceipt@1`，`output.log` 保存输出。Subscription 零模型读取回执，短通知回传 outcome 与精确 receipt 查询命令；退出码、信号及日志位置按需查询，不自动发送完整日志或命令参数。回执证明直接子进程退出；软件是否可用、镜像 digest 和服务健康仍需原任务验收。worker 崩溃、启动中断或回执缺失保持 unknown，不以 PID 消失推断成功，不自动重跑。

`--timeout` 只限制观察；超时、`run cancel`、关闭任务或回传失败不会中断命令。停止进程须另核验身份和权限。观察超时后不补发晚到的完成结果，仍可用原 runId 读取最终回执。相同 request ID 不重复执行，先 inspect，不更换 ID 盲目重试安装或镜像操作。

只有已查明的接入障碍（例如 Runtime 未启动或版本不匹配、目标生命周期不支持、沙箱禁止后台进程、命令要求交互）才使用有界 fallback，并说明具体缺口。缺权限时先完成其余准备，再申请权限；不通过后台执行绕过。可独立继续的工作照常推进，不用模型反复轮询。

### 观察已有外部来源

```sh
scripts/rs run preflight --id pipeline-42 --title '等待 pipeline 42' --source plugin:my-pipeline@1 --input /absolute/path/pipeline-input.json --return-to codex-desktop:<当前任务完整UUID> --timeout 3600
scripts/rs run start --id pipeline-42 --title '等待 pipeline 42' --source plugin:my-pipeline@1 --input /absolute/path/pipeline-input.json --return-to codex-desktop:<当前任务完整UUID> --timeout 3600
```

已声明 `plugin:build-pipeline@1` 的 GitLab source 时，优先用 `run pipeline preflight|start --id … --project … --pipeline … --expected-sha … --return-to codex-desktop:<完整任务UUID> --timeout …`；这会生成同一 Run submission，而不是 shell watcher。完整 Owner registry declaration 与 SHA binding 见 [CLI Reference](cli-reference.md#gitlab-pipeline-typed-submission)。

source 必须由 Owner 在当前 Runtime 的 `subscription-plugins.json` 登记；注册表拥有 Plugin identity/path、适用模式、workspace 和 HTTP/executable allowlist。input 文件只提供该来源的业务参数。预检在沙箱求出 probe plan 并验证工具与权限，不发出 HTTP 请求或执行 probe 命令；plan 与后续 evaluate 的数据依赖不能全部静态证明，Runtime 继续检查每次动态计划。

需要连续观察时用 `--continuous` 替代 `--timeout`，Plugin 必须登记 continuous 模式；新 occurrence 才投递，相同 occurrence 不重发。省略 `--return-to` 时只保存观察结果。`subscription register-desktop` 不再开放新建，既有 Subscription、checkpoint、action receipt 和 Delivery 不做迁移或删除；文件 workflow 的 Owner 注册与恢复仍走原集成管理面。

终态/delta、action receipt 和 Desktop Delivery 在同一个 source transaction 中提交。Delivery 的 origin 绑定 action receipt；出站再次核对 source definition、occurrence、目标与正文。外部观察仍是来源数据，不授予新权限。

优先用 `run inspect <runId>` 一次查看执行、观察和回传；需要 source 级排障时使用 `subscription inspect <sourceId>`、`subscription deliveries <sourceId>`。action succeeded 或 source completed 只证明动作入队，Delivery 才是传输 oracle；目标任务中的实际消息才证明接收。已发送或结果未知的 Delivery 不自动重放。

本接入沿用上文已有 Desktop active/idle transport 支持；本地已加载的空闲任务可在原回合结束后由 start 唤醒。预检不发送测试消息，也不宣称未来目标一定可用；投递时仍核验任务状态，失败留在 Delivery。旧失败 Delivery 不会因 Runtime 升级自动重发。

Owner 可通过 `subscription notifications mute codex-thread <UUID> --reason <text>` 暂停指定会话的全部 Desktop 通知。检查 inFlightDeliveryIds 为空后才能报告静音已生效。独立 Run、command/observe 和原 Chat 回传共用发送前检查；关闭终态 Run 的监控使用同入口的 close run。Runtime 重启不为相同 Run 状态重复生成恢复通知。具体 CLI 与回执语义见 [CLI Reference](cli-reference.md)。
