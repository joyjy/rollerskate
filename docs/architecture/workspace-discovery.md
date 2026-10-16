# Workspace 发现与 Fork

Chat Agent 和 Console 通过 `application/workspace/discovery.ts` 查询 Git 元数据，通过 `application/workspace/control.ts` 创建工作区。既有 `application/workspace/query.ts` 拥有带执行授权的正文检查，两者不能互相替代。Console、MCP、Pi 和 typed Chat request 共用 Chat 工具 manifest，adapter 不维护独立工具清单。

`find_workspaces` 接收项目名或准确绝对路径；查询只返回 canonical root、引用、当前分支、默认分支来源、base SHA 和内容指纹。默认候选来自当前项目、Local workspace，以及 `~/Projects` 的直接子目录。Owner 可用 `<runtime>/workspace-discovery.json` 的 `schemaVersion: 1`、`roots: string[]`、`registered: string[]` 替换搜索根并补充登记；每组最多 32 项，文件最多 16 KiB。每个根最多检查 500 个目录项，每次最多检查 40 个 Git 候选、返回 20 个结果；截断会显式返回，不递归扫描、不跟随候选目录软链、不读取仓库正文。

默认分支以显式 `git config rollerskate.defaultBranch` 为先，否则仅接受唯一的本地 remote HEAD symbolic ref。当前分支、`init.defaultBranch`、main/master 词面均不作为证据；多个 remote HEAD 或本地缺少对应 commit 时阻止 Fork，保留 Use。没有隐式 fetch/pull。

`fork_workspace` 在创建前重验候选 token，固定展示过的默认分支/base SHA，在源目录旁创建 `<repo>-wt-<purpose>`、分支 `rs/<purpose>`。输入 requestId 在同一 authority 下幂等；路径/分支冲突明确失败，不搬运 dirty 改动、不自动清理、不启动 Run。Owner 在原 Run 卡片点击 Fork 提供权限；Agent 工具要求当前 eligible/running dispatch 的 Owner 原文是 `Fork Workspace <canonical path>` 或 `创建独立工作区 <canonical path>`（可带开头 @mention）。一般讨论、结果回调和只给路径不授予 Fork 权限。

文件对象的持久化与恢复边界见 [Database Reference](db-reference.md)。Fork 成功后卡片保留结果并回到原有路径预检、任务来源/问答和最终确认；Use 不创建工作区，最终 Run 准入仍重验路径/revision。浏览器会话保存准确 Fork 请求，以相同 requestId 恢复回执；同一 ID 不可改成另一组已受理参数。预检失败不撤销已创建的工作区。

验证入口：`local/test/workspace-control.test.ts`、`chat-workspace-tools.test.ts`、`chat-run-proposal-api.test.ts` 和 UI 的 `ChatWorkspacePicker.test.ts`、既有卡片/ChatsView 测试。真实 provider 与浏览器验收另行记录，manifest 测试不证明外部 provider 实测。
