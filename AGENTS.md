# Rollerskate Agent Guide

Rollerskate 是一个 npm monorepo。仓库根目录只负责 workspace 编排、统一构建、测试和开发环境，不承载根级 `src/`。

## Read First

- [Source Map](docs/architecture/source-map.md) 是 package、source root、ownership、generated artifact 与验证入口的唯一事实源。
- [Architecture Index](docs/architecture/index.md) 是当前产品架构、稳定不变量、ADR 与专题文档入口。
- 新增或修改 SQLite table、migration、materialized projection/index 或 durable object/state 前，必须先读 [Database Reference](docs/architecture/db-reference.md)，完成 Event-only / index / object 分类，并明确 owner、字段事实源、事务和 rebuild/reconciliation 规则。
- 未实现计划不能覆盖 architecture 文档和源码事实；公开源码快照不包含内部 plan 与 verification 文件。

## Hard Boundaries

- 顶层依赖方向是 `protocol <- local`、`protocol <- server`；`local` 与 `server` 不直接相互导入。
- Local core 只拥有 canonical Event（包括 `agent.result`）、Route、Execution、Handler、Session、Destination/Delivery、唯一 loop 及其 retry/recovery/audit/exception-isolation 不变量；不拥有平行 Result 模型、具体 Capability 或 integration。
- 新增垂直领域时，默认只新增 `application/<domain>/control.ts`、`query.ts`，按需增加 `modules/<domain>/state-machine.ts`、persistence adapter、entrypoint 和 UI；每个 composition boundary 最多增加一条显式 module registration。不得在 core、通用 ResultHandler、Agent adapter 或无关领域增加 `<domain>Invocation`、结果 schema 分支或业务状态判断；确需修改 core 时，必须先在 [Local Runtime](docs/architecture/local-runtime.md) 证明它是至少两个领域可复用的运行原语。
- `local/src/core/loop.ts` 拥有唯一长期运行的 loop；`bootstrap/runtime.ts` 只能装配源码内受控的 Capability 与 integration，不得引入 Room daemon、Work loop、动态 phase registration 或 Capability 自有 daemon。
- 第一方玩法叫 Capability，必须进入源码、测试、migration 和正式发布流程。第三方若要新增完整 Capability，必须修改源码；当前不提供可安装 Capability/Handler/Route 扩展点。
- 用户 Plugin 只能填入某个 Capability 预先声明的沙箱 strategy slot。Plugin 不能注册 Event type、Route、Handler、loop 或 store，不能直接访问 Runtime、Agent、network、filesystem、process、secrets 或 environment。
- 新 ingress 先定义固定 schema，再构造 canonical Event；不开放 generic emit、fanout 或 Observer API。
- 新外部输出实现 Destination/Delivery integration，不把 Room、webhook 或 channel 建模为 Handler Route。
- Console 浏览器源码属于 `local/ui/src/`；loopback API/static host 属于 `local/src/entrypoints/console/`，只能调用 application control/query，不能直接读写 store。
- 不创建根 `src/`。任何 `dist/` 都是生成物，不得编辑、评审或当作源码事实。
- 修改 CLI 命令需要维持 [CLI Reference](docs/runbook/cli-reference.md) 准确。
- 修改 `event.type` 需要维持 [Event Reference](docs/architecture/event-reference.md) 准确。

## Verification

- 全仓：`npm run build`、`npm test`、`npm run verify`
- 单 package：`npm run verify -w @rollerskate/protocol`、`npm run verify -w @rollerskate/local`、`npm run verify -w @rollerskate/server`
- Console：`npm --prefix local/ui run type-check`、`npm --prefix local/ui run build`

测试放在所属 package 的 `test/`，从公共边界验证行为。标准验证必须 fresh build，不能信任陈旧 `dist`。CLI 是稳定接口；Console 变更至少检查桌面和移动端浏览器布局。
