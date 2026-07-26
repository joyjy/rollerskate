---
type: Architecture
title: Rollerskate Source Map
description: Rollerskate monorepo 的源码归属、共享契约、生成关系、文档层与验证入口。
tags: [rollerskate, architecture, source-map, ownership]
---

# Rollerskate Source Map

[返回 architecture index](./index.md)

本页是仓库 source roots 与 ownership 的唯一事实源。它描述稳定目录，不枚举普通源码文件，也不保存实施计划或历史。

## Directory Tree

```text
rollerskate/
├── packages/
│   └── protocol/
│       ├── src/                  # Local / Server 网络 contract
│       └── test/                 # protocol 公共边界验证
├── local/
│   ├── src/
│   │   ├── core/                 # canonical Event、execution kernel、唯一 loop
│   │   ├── application/          # 按业务域组织的 control、query 与 application module
│   │   ├── modules/              # Local 产品模型与纯状态策略
│   │   ├── capabilities/         # 随源码发布的第一方能力
│   │   ├── integrations/         # Agent、Matrix、Server 适配
│   │   ├── infrastructure/       # SQLite/file persistence 与运行资源加载
│   │   ├── entrypoints/          # CLI 与 loopback HTTP 转换
│   │   └── bootstrap/            # 固定 runtime composition 与 migration
│   ├── resources/                # 随 build 发布的 prompt 与 versioned workflow
│   ├── scripts/                  # Local package build helper
│   ├── ui/src/                   # 由 Local product 内置 Vite 实时提供的 Vue Console 源码
│   └── test/                     # Local Runtime 公共边界验证
├── server/
│   ├── src/                      # 远端 control plane、Matrix AS 与 BFF
│   └── test/                     # Server 公共边界验证
├── examples/
│   ├── plugins/                  # 受限 strategy slot 示例
│   ├── probes/                   # allowlist command probe 示例
│   └── commands/                 # 外部命令与 completion receipt wrapper 示例
├── scripts/                      # repo launch、build 与验证 helper
├── dev/                          # 本地服务编排与开发 secret 初始化
├── assets/                       # 人类入口视觉资产
└── docs/
    ├── architecture/             # 当前架构、ownership 与 ADR
    ├── plan/                     # 尚未完成验收的 release plans
    ├── runbook/                  # 安装、运行与故障处理
    └── verification/             # 版本验收范围与外部证据
```

## Boundary Notes

- 顶层依赖方向是 `protocol <- local`、`protocol <- server`；Local 与 Server 不直接相互导入，也不把各自内部状态放进 protocol。
- `core/` 拥有唯一长期运行的 loop；`capabilities/` 和 `integrations/` 提供行为与适配，`bootstrap/` 只做固定装配，三者都不能建立第二个 loop。
- 一个 application vertical 以 `control.ts`、`query.ts` 为公共边界，纯 transition policy 放入 `modules/<domain>/state-machine.ts`，SQLite/file 细节放入 `infrastructure/`，CLI/HTTP/UI 只做转换。源码内第一方 vertical 在各 composition boundary 通过一条显式 manifest registration 接入；不依赖运行时扫描任意源码文件，也不把业务分支塞进 core 或 Agent adapter。
- `entrypoints/` 只把 CLI/HTTP 转成 application control/query，并在同一 loopback HTTP server 上挂载 Vite middleware；`local/ui/src/` 是 Console 产品运行源，只走 loopback API，两者都不直接访问 store。
- `examples/plugins/` 只能实现 Capability 预留的沙箱 strategy slot，不能注册 Capability、Event、Route、Handler 或 loop；`examples/probes/` 和 `examples/commands/` 只演示 host-owned probe 与外部进程 receipt 边界，不属于 Runtime 产品源码。
- `scripts/`、`dev/` 和 `assets/` 不拥有产品行为；`dev/secrets/` 是 ignored 本地状态。

## Architecture And Validation

- `packages/protocol/`：[System topology](./system-topology.md)、[Event and Handler flow](./event-and-chat-flow.md)；`npm run verify -w @rollerskate/protocol`。
- `local/src/` 与 `local/ui/src/`：[Local Runtime](./local-runtime.md)、[State and recovery](./state-and-recovery.md)、[Poll Subscription](./poll-subscription.md)、[Local Agent Run And Review Workflow](./local-review.md)；`npm run verify -w @rollerskate/local`、`npm --prefix local/ui test`、`npm --prefix local/ui run type-check`、`npm --prefix local/ui run build`。
- `server/src/`：[Server foundation](./server-foundation.md)、[Room control plane](./room-control-plane.md)；`npm run verify -w @rollerskate/server`。
- `examples/`：[ADR 0005](./adrs/0005-capability-and-plugin-boundary.md)、[Poll Subscription](./poll-subscription.md)；随 Local 验证。
- 全仓编排与 helper：[Architecture index](./index.md)、[State and recovery](./state-and-recovery.md)；`npm run verify`、`npm run dev:init`。

## Shared Contracts

- `packages/protocol/src/index.ts`：Local/Server 网络 contract 的唯一源码入口。
- `local/src/core/event/model.ts`：Local canonical Event 与本地 Event ID 的事实源。
- `local/src/modules/foundation/model.ts`：LocalDevice、LocalWorkspace、Principal、LocalAgent 与 handle policy 的事实源；`local/src/infrastructure/sqlite/foundation-store.ts` 负责 SQLite persistence 与 bootstrap。
- `local/src/modules/agent/client-profile.ts`：受支持 Agent client、adapter ID、per-Agent launch args schema 与 reserved-argument policy 的事实源。
- `local/src/core/chat/`：`ChatDecision@1`、scoped presence 与纯 attention planning 的事实源。
- `local/src/application/chat/` 与 `local/resources/prompts/chat/`：Chat control/handler 编排、稳定 prompt resource ID、context rendering 与 Chat 行为资源的事实源。
- `local/src/application/runtime/query.ts`、`workload-query.ts` 与 `failure-query.ts`：Runtime process/control availability、Loop workload 与 bounded Failure projection 的共同 CLI/Console 语义出口。
- `local/src/application/event/query.ts`：Events list/trace 的共同 CLI/Console 语义出口；Runtime 兼容入口只能委托它。
- `local/src/infrastructure/sqlite/chat-store.ts`：唯一 `Local` Chat 的 SQLite projection、Owner message admission 与 current Session pointer。
- `local/src/core/loop.ts`：唯一长期运行 loop、phase 调度和顶层异常隔离的事实源。
- `local/src/core/runtime/model.ts`：Local Route、durable execution、generic result-contract routing context 与 completion callback primitive 的事实源；Core 不拥有具体 Agent result schema。
- `local/src/capabilities/subscription/plugin-contract.ts`：用户 Subscription Plugin 唯一允许实现的 strategy slot contract。
- `local/src/capabilities/scheduled-task/model.ts`、`time.ts` 与 `store.ts`：Schedule/ScheduledRun、one-shot/cron/timezone 与 durable admission 的事实源。
- `local/src/application/agent-run/` 与 `local/src/modules/agent-run/`：Agent Run control/query、module manifest、`AgentTurnResult@1`、纯状态机、mandate/workflow admission 与 callback policy 的事实源；Steward 只是 Run 中被指定的 Agent role。
- `local/src/infrastructure/sqlite/agent-run-store.ts`：`agent_runs` lifecycle、CAS、run-scoped Session binding、cancel 与 transactional continuation persistence。
- `local/src/infrastructure/workspace/revision.ts`：external Git workspace canonicalization 与 generic `workspace-revision-v1` 计算；业务 workflow 不得在此加入自己的 sidecar/exclusion 语义。
- `local/resources/workflows/`：versioned Agent workflow 资源；`review@1` 定义审查与 Agent 协作规约，不拥有 Runtime engine。
- `local/src/capabilities/review/` 与 `local/src/application/review/`：只保留 schema v43 及更早 legacy Review history parser/query，以及兼容旧 Review sidecar 的 revision wrapper；不再 admission 新 Review。
- `local/src/infrastructure/runtime/config.ts`：Local runtime paths 与 config schema 的事实源。
- `local/src/infrastructure/sqlite/local-schema.ts`：Local SQLite v44 的完整 DDL、组合 schema version、兼容 migration 与 projection trigger 的唯一事实源；`schema.ts` 和 `runtime-schema.ts` 是薄入口，`runtime-mappers.ts` 持有 Runtime row mapping。
- `local/src/infrastructure/sqlite/runtime-operations-query.ts`：Runtime Workload、Failure 与 recovery precondition 的只读 SQLite facts adapter，不拥有 durable object 或 projection table。
- `local/src/application/notice/` 与 `local/src/infrastructure/sqlite/notice-store.ts`：Notice list/inspect/read/ack/rebuild 的共同 application contract，以及可重建 projection 与 authoritative user state adapter；RuntimeStore 不拥有 Notice query/control。
- `local/src/entrypoints/console/launcher.ts` 与 `local/ui/`：同源 loopback API、Vite source runtime、Vue Console 和 HMR lifecycle 的事实源；`scripts/rs start` 不从 `local/ui/dist/` 提供产品 UI。
- `server/src/adapter/persistence/mysql/migrations.ts`：Server MySQL schema migration 的事实源。
- 根 `package.json`：Protocol/Local/Server npm workspace 与全仓 build/test/verify 的事实源；嵌套的 `local/ui/` 由自己的 manifest/lockfile 管理，root `postinstall` 负责 clean install，避免把父 package 与子目录声明成重叠 workspace。

## Generated Artifacts

- `packages/protocol/dist/` ← `packages/protocol/src/` 与 `packages/protocol/test/`，由 TypeScript build 生成，不跟踪、不手工修改。
- `local/dist/` ← `local/src/`、`local/test/` 与 `local/resources/`，由 TypeScript build 和 resource copy step 生成，不跟踪、不手工修改。
- `local/ui/dist/` ← `local/ui/src/`，由 Vite build 生成，不跟踪、不手工修改；它只用于 production-build verification 或显式 frozen artifact，不是 `scripts/rs start` 的产品运行输入。
- `server/dist/` ← `server/src/` 与 `server/test/`，由 TypeScript build 生成，不跟踪、不手工修改。
- `dev/secrets/` ← `dev/init-secrets.mjs`，是 ignored 的本地开发 secret state，不是 repo source，不得提交。
- `tmp/node-test-report.json` ← `node-test.config.mjs` 与 node-test-kit，属于本地验证报告，不是架构事实源。
- `package-lock.json` 与各 package lockfile ← npm manifest resolution；通过 npm 维护，不手工声明依赖事实。

## Documentation Layers

- `docs/architecture/`：当前架构、ownership、ADR、稳定不变量和 change guidance。
- `docs/runbook/`：安装、运行、控制与故障处理步骤。
- `README.md`：人类项目入口，不复制完整 source map。

仓库当前没有独立 `doc/` API 生成输入层或 `knowledge/` 长期领域知识层；不要为了满足模板预建空目录。

## Change Guidance

- 新增、删除或重命名 workspace、主要 source root、owner、共享 contract、generator 或主要验证入口时，同一次变更必须更新本页。
- 改 core/Capability/Plugin 信任边界时，同时检查 [ADR 0005](./adrs/0005-capability-and-plugin-boundary.md)、[Local Runtime](./local-runtime.md) 与自动化隔离证据。
- 改 Server/Local ownership 或跨设备事实源时，同时检查 [Source of truth](./source-of-truth.md) 和对应 ADR。
- `AGENTS.md` 只保留本页的靠前指针与会直接改变 agent 行为的硬规则，不复制本页正文。
