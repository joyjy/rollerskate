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
│   │   ├── application/          # 本机产品状态与 use cases
│   │   ├── capabilities/         # 随源码发布的第一方能力
│   │   ├── integrations/         # Agent、Matrix、Server 适配
│   │   ├── infrastructure/       # SQLite connection mechanics
│   │   ├── entrypoints/          # CLI 与 loopback HTTP 转换
│   │   └── bootstrap/            # 固定 runtime composition 与 migration
│   ├── ui/src/                   # Vue Console 浏览器端
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
    ├── plan/                     # 尚未实现的版本与能力计划
    ├── runbook/                  # 安装、运行与故障处理
```

## Boundary Notes

- 顶层依赖方向是 `protocol <- local`、`protocol <- server`；Local 与 Server 不直接相互导入，也不把各自内部状态放进 protocol。
- `core/` 拥有唯一长期运行的 loop；`capabilities/` 和 `integrations/` 提供行为与适配，`bootstrap/` 只做固定装配，三者都不能建立第二个 loop。
- `entrypoints/` 只把 CLI/HTTP 转成 application control/query；`local/ui/src/` 只走 loopback API，两者都不直接访问 store。
- `examples/plugins/` 只能实现 Capability 预留的沙箱 strategy slot，不能注册 Capability、Event、Route、Handler 或 loop；`examples/probes/` 和 `examples/commands/` 只演示 host-owned probe 与外部进程 receipt 边界，不属于 Runtime 产品源码。
- `scripts/`、`dev/` 和 `assets/` 不拥有产品行为；`dev/secrets/` 是 ignored 本地状态。

## Architecture And Validation

- `packages/protocol/`：[System topology](./system-topology.md)、[Event and Handler flow](./event-and-chat-flow.md)；`npm run verify -w @rollerskate/protocol`。
- `local/src/` 与 `local/ui/src/`：[Local Runtime](./local-runtime.md)、[State and recovery](./state-and-recovery.md)、[Poll Subscription](./poll-subscription.md)；`npm run verify -w @rollerskate/local`、`npm --prefix local/ui run type-check`、`npm --prefix local/ui run build`。
- `server/src/`：[Server foundation](./server-foundation.md)、[Room control plane](./room-control-plane.md)；`npm run verify -w @rollerskate/server`。
- `examples/`：[ADR 0005](./adrs/0005-capability-and-plugin-boundary.md)、[Poll Subscription](./poll-subscription.md)；随 Local 验证。
- 全仓编排与 helper：[Architecture index](./index.md)、[State and recovery](./state-and-recovery.md)；`npm run verify`、`npm run dev:init`。

## Shared Contracts

- `packages/protocol/src/index.ts`：Local/Server 网络 contract 的唯一源码入口。
- `local/src/core/event/model.ts`：Local canonical Event 与本地 Event ID 的事实源。
- `local/src/core/loop.ts`：唯一长期运行 loop、phase 调度和顶层异常隔离的事实源。
- `local/src/core/runtime/model.ts`：Local Route 与 durable execution facts 的事实源。
- `local/src/capabilities/subscription/plugin-contract.ts`：用户 Subscription Plugin 唯一允许实现的 strategy slot contract。
- `local/src/application/runtime-config.ts`：Local runtime paths 与 config schema 的事实源。
- `local/src/application/runtime-schema.ts`：Local SQLite 跨模块 schema composition 与 clean-cutover 的事实源。
- `server/src/adapter/persistence/mysql/migrations.ts`：Server MySQL schema migration 的事实源。
- 根 `package.json`：npm workspace、全仓 build/test/verify 的事实源。

## Generated Artifacts

- `packages/protocol/dist/` ← `packages/protocol/src/` 与 `packages/protocol/test/`，由 TypeScript build 生成，不跟踪、不手工修改。
- `local/dist/` ← `local/src/` 与 `local/test/`，由 TypeScript build 生成，不跟踪、不手工修改。
- `local/ui/dist/` ← `local/ui/src/`，由 Vite build 生成，不跟踪、不手工修改；`local/src/entrypoints/console/launcher.ts` 只负责提供该产物。
- `server/dist/` ← `server/src/` 与 `server/test/`，由 TypeScript build 生成，不跟踪、不手工修改。
- `dev/secrets/` ← `dev/init-secrets.mjs`，是 ignored 的本地开发 secret state，不是 repo source，不得提交。
- `tmp/node-test-report.json` ← `node-test.config.mjs` 与 node-test-kit，属于本地验证报告，不是架构事实源。
- `package-lock.json` 与各 package lockfile ← npm manifest resolution；通过 npm 维护，不手工声明依赖事实。

## Documentation Layers

- `docs/architecture/`：当前架构、ownership、ADR、稳定不变量和 change guidance。
- `docs/runbook/`：安装、运行、控制与故障处理步骤。
- `README.md`：人类项目入口和项目状态摘要，不复制完整 source map。

仓库当前没有独立 `doc/` API 生成输入层或 `knowledge/` 长期领域知识层；不要为了满足模板预建空目录。

## Change Guidance

- 新增、删除或重命名 workspace、主要 source root、owner、共享 contract、generator 或主要验证入口时，同一次变更必须更新本页。
- 改 core/Capability/Plugin 信任边界时，同时检查 [ADR 0005](./adrs/0005-capability-and-plugin-boundary.md)、[Local Runtime](./local-runtime.md) 与自动化隔离证据。
- 改 Server/Local ownership 或跨设备事实源时，同时检查 [Source of truth](./source-of-truth.md) 和对应 ADR。
- `AGENTS.md` 只保留本页的靠前指针与会直接改变 agent 行为的硬规则，不复制本页正文。
