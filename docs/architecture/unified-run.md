---
type: Architecture
title: 统一 Run 准入与确定性执行
description: Run 公共入口、编译预检、确定性执行与各领域事实源边界。
---

# 统一 Run 准入与确定性执行

Run 是普通工作提交、查询与取消的公共入口。`application/run/` 编译意图并组合既有领域；Agent 的持久编排与触发语义继续归 Steward，确定性命令与观察不创建虚假的 Agent、Event 或 Agent Execution。CLI 参数和 JSON 均进入同一编译器。输入/退出码的唯一说明归 [CLI Reference](../runbook/cli-reference.md#统一-run-提交与预检)。

## 意图、计划与权限

`RunIntent@1` 保留已有 Agent 消费者；`RunIntent@2` 明确 command/observe 工作。调用方提供业务目标/参数、工作目录、预算和明确的结果目标，不提交 Subscription definition、probe policy、callback 或内部关联 ID。

`preflightRun` 解析契约、求解 source/tool、校验权限与环境，返回 `RunPreflight@1`。指定 Desktop 目标时通过已有 IPC 的只读 owner discovery 验证 exact 本机任务与 untrusted-input 支持，缺失时阻断准入；不发送用户输入。有效计划携带 executor、canonical paths、source identity/artifact/policy、终态探测、结果目标和 digest。`startRun` 重新编译，拒绝把旧计划当作授权；Agent 路径继续调用原 admission compiler 与其事务内 workspace revision 检查。

Subscription 的 plugin plan 在既有无文件/网络/进程权限的 Node 沙箱执行。`probe-validation.ts` 持有工具 schema、allowlist 与 cwd 边界检查，预检和每次实际 probe 执行共同调用。路径相对于登记的 workspace 解析并检查 realpath；HTTP origin、executable 和 environment references 不能由 plugin 输出扩大。调用任意命令时权限继承调用者，不因 RS Runtime 拥有更宽权限而改变。

诊断携带 code/field/expected/actual/fix，独立错误尽量一起报告。unverified 明示任意 shell 效果、外部凭据与未来 Desktop 可用性等未证明项；不把它们伪装成验证通过。预检不执行真实 probe/工作命令、不写 Run/source/Event/Delivery，也不发送测试消息。通过预检不能阻止环境随后变化，因此 Runtime 仍执行各 owner 原有准入检查。

## 事实归属与恢复

| Owner | 唯一事实 |
|---|---|
| Run admission file | request identity、immutable intent、source ID、计划 digest、创建时间 |
| Command executor/receipt | 原命令 argv/cwd、PID 与直接子进程终态、日志位置 |
| Subscription | probe definition/policy、观察、预算、checkpoint、暂停/取消和 occurrence |
| Delivery | 精确目标、发送状态、transport receipt、投递失败 |
| Steward | 既有 Agent Run lifecycle、授权、decisions、cycle 与验收 |

确定性 Run 不保存另一份可变 status。查询从 executor/source/Delivery 组合出结果，命令成功与回传成功分别表示。连续观察可以持续运行并多次回传 delta；until 超时是观察终态，不是进程退出证明。无结果目标时使用固定 `action:subscription.observe@1` 保存 source terminal，不产生 Delivery。

`RunAdmission@1` 是独立的 immutable durable object，物理位置和读回约束归 [Database Reference](db-reference.md#确定性-run-admission文件对象)。request ID 确定 Run identity；独占预留先于 source 注册和进程启动。相同意图重复提交返回原 Run，不同意图报冲突。目录预留与 source SQLite transaction 无法原子提交：中断可以留下 incomplete/unknown，但绝不以缺少进程回执为依据重跑；源码查询暴露缺失阶段供 Owner 判断。没有第二个 retry queue、daemon 或命令状态表。

源观察、固定 action 与 Delivery enqueue 保持原 source transaction。Runtime 重启复用 Subscription/Delivery；脱离启动 CLI 的有限 command worker 自行落盘回执。worker 或宿主丢失时保持 unknown，不凭 PID 推断成功。Run cancel 只终止确定性 Run 的观察，不杀进程、撤回投递或重写历史。

## 入口与兼容边界

`command start` 和 `subscription register-desktop` 不再新建普通工作。已有命令回执继续支持 `command inspect`；旧 source、action、Delivery 保留当前读回/恢复语义，不隐式迁移。文件 workflow 的 Owner 注册/恢复是集成管理面，保留已有真实调用方。

确定性 Run 的 CLI/application、Chat 工作发现与既有 Console 详情共用 `inspectRun`。Chat `list_chat_work` 与有 Host 的 `get_run` 固定在当前 Agent、Topic 和 Session，返回 `agent | command | observe` 类型、来源、状态及准确详情入口；分页必须原样传回 `beforeDispatchEventId` 与 `beforeRunId`，同一 dispatch 的多个工作不会漏页。命令和观察不投影 Agent version 或人工控制，progress index 仍由原 Steward 读模型拥有。Desktop 仅复用已经验收的 active/idle transport；目标投递状态仍以发送时 admission 与实际接收为准。

## 固定 DAG 执行

`RunIntent@1.graph` 使用 `RunGraph@1` 声明角色、节点、needs 依赖、单一结果节点与预算请求；`modules/steward/graph-contract.ts` 是其纯解析与拓扑校验 owner。图参与现有 intent digest，不创建新的状态或持久化表。`application/run/validation.ts` 提供只读、离线格式校验，CLI `run validate` 只做输入输出转换。规范和样例归 [CLI Reference](../runbook/cli-reference.md#dag-输入与执行)。

格式有效不代表准入通过。Steward compiler 固定参与者 principal、只读权限和节点预算；解析后的 graph 随 `RunMandateSnapshot@1` 保存，属于 immutable admission snapshot。`application/steward/graph.ts` 从 canonical request/result 与 Result Execution 的收件回执派生节点状态，在 start/collect 的同一事务内选择就绪节点并按 maxConcurrency 派发。每个 Worker 复用 `AgentStepResult@1`，独立 Session；最终 checkpoint 仍走既有 Steward acceptance 和 terminal delivery。固定 DAG 不进入 dynamic next_step，不增加 daemon、Handler 或可变节点状态表。

失败后继 blocked，独立分支继续；所有已派发节点收件后形成最终 checkpoint。cancel/deadline 后迟到结果不再推进；restart 复用既有 Execution 恢复规则。schema v77 将 Run/Agent Session 关系从唯一索引改为普通索引，以允许独立 Session；串行流程显式查找最新 Run/Agent Session 后照旧复用。
