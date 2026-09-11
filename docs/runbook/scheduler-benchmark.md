# 调度基准

`npm run --silent benchmark:scheduler > results.json` 默认测量当前 `HEAD`，运行三轮。使用 `--refs <ref,ref,...> --rounds 1` 比较当前分发仓库内实际存在且依赖一致的提交；refs 指向已提交源码，未提交修改不参与测量。

入口为 `scripts/scheduler-benchmark/run.mjs`，负载为同目录 `workload.mjs`。runner 用 `git archive` 创建临时源码快照并 fresh build，复用本机已安装依赖，`--refs HEAD,working-tree` 可同时比较已提交基线和当前 `local/src` 快照，输出 sourceDigest；不 checkout、不创建 worktree、不联网、不调用真实 Agent、不读写默认 Runtime。protocol、lockfile、Local package 声明须在各 ref 间相同，否则拒绝比较；protocol 会 fresh build。临时源码、SQLite 与 loop state 在退出时按 exact path 清理。

## 测量对象

实际执行各 ref 的 `runLoop`、`RuntimeCycle.poll`、`RuntimeStore`、`AgentHandler` 与 `ResultHandler`。每个场景使用独立真实 SQLite，保留原子 claim、lane 串行、Result 生成/处理与状态文件写入。Agent adapter 只执行本地可控 Promise，正常任务延迟 2ms；没有模型耗时。支持 wake 的版本按 production bootstrap 连接持久化通知、完成通知和 next-due 等待；旧版本使用它本身的默认轮询。没有复制或模拟调度算法。

| 场景 | 固定负载与测量目的 |
|---|---|
| idle | 空闲 1200ms，记录 CPU 时间、loop cycles、Execution claim 调用次数及 due 查询调用次数。 |
| enqueue | loop 启动 30ms 后提交一个短任务，观察入队唤醒。 |
| due | 30ms 后提交 due 时间在 100ms 之后的短任务，测量从 due 到实际 invocation 的延迟。 |
| burst | 30ms 后提交 60 个不同 lane 的短任务，观察每轮 claim 上限与完成唤醒对突发吞吐的影响。 |
| slow-source | 第一个 source phase 等待 400ms，30ms 时提交短任务，观察后续 Runtime phase 是否被阻塞。 |
| hot-lane | 100 个更早 due、同 Agent/workspace 的任务先入队，随后排入一个独立 lane probe 和一个真实 canonical Result。按对应版本的准入容量饱和后再等待 400ms 释放 adapter gate：旧版 claim=100/invocation=1，限量版同 Agent invocation=2、无已 claim 的 lane 等待者。 |
| mixed | 同样顺序，但前 100 个任务分别属于独立 lane；在容量满载 400ms 时记录 Result 和短任务 probe 等待。 |

容量场景的 Result 在计时前通过真实 `completeExecution` 产生，先前 100 个任务使用较早的 due timestamp 排在其前；fixture priming 不计入吞吐。gate 是用于复现饱和的受控条件，不代表真实 Agent 耗时；每个未绑定 Session 的调用返回独立 provider Session identity，避免制造不存在的 Session 冲突。

## 指标与门槛

JSON 保存环境、exact commit、每轮原始指标、跨轮中位数和检查结果。ready-to-start 使用单调时钟，从提交完成与 due 两者较晚者计至 adapter.invoke 真正开始，包含 claim 后等待 lane 的时间。Result 延迟从 canonical Result 提交完成计至 ResultHandler 开始。p50/p95/p99 是每轮事件样本的 nearest-rank 分位数，summary 是各轮分位数的中位数，不是合并样本分位数；单任务场景的尾分位数只等于该次观测，不能推断生产 p99。

吞吐为计时内 admitted Agent 数 / 从 loop 启动到全部 Result 终态的时间，包含初始 30ms 等待和 Result drain；不等于纯 adapter 吞吐。claimScans 只计 `claimDueExecutions` 调用，dueQueries 只计两个 nextDue 查询调用，均不是 SQLite 全部语句或物理扫描页数。CPU 是测量进程的 user+system 时间，包含 SQLite、状态文件与测量 wrapper 开销，作为观察值，不设跨机器绝对阈值。

初始回归门槛针对此受控负载预先固定：有 wake 的版本相对无 wake 基线，enqueue/due 延迟各不超过 50%，burst 吞吐至少 2 倍，idle claim 调用不超过每秒 6 次。存在基线时不通过即返回非零退出码；单 ref 运行只执行行为不变量检查。基准还断言所有工作成功收口、due 前不调用、对应版本的每 Agent 并发不超限、旧版全局 claim 不超过 100、限量版不超过 7、容量场景确实饱和，以及 20 秒场景超时。慢 source/lane/Result 的剩余限制是诊断结果，不伪装成已通过的生产 SLO。

这些阈值只用于避免已实现 wake/due 行为退化。选择下个调度改动时，应结合重复结果与实际任务量；不能由构造负载直接宣称生产系统已经积压或饿死。

限量版保留同一组 100 个输入；`mixed` 的四个 provider 名额都会被较早工作占用，后来的 Agent probe 需要排队。这一指标不承诺优于无约束并发；重点对照热点 Agent 隔离、Result 保留名额和短任务吞吐代价。这里的 hot-lane 使用独立新 Session 请求，同 provider Session 串行另由 `runtime-scheduling.test.ts` 验证。
