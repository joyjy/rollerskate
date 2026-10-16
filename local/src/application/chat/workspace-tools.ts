import { findWorkspaces } from "../workspace/discovery.js";
import { forkWorkspace, type ForkWorkspaceInput } from "../workspace/control.js";
import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import { chatActionDispatch, ownerActionScope } from "./action-scope.js";
import type { ChatToolContext } from "./tool-policy.js";

export const chatWorkspaceToolDefinitions = [{
  name: "find_workspaces",
  description: "Discover bounded Git workspace candidates by project name, or inspect an exact absolute path. Returns canonical roots, current/default branches and base SHA. Reads metadata only. Show the default branch and base SHA before proposing Fork. Candidates never grant file access, Fork or Run authority; use the original Run card for ambiguous choices.",
  inputSchema: {type:"object",additionalProperties:false,properties:{query:{type:"string",minLength:1,maxLength:120},path:{type:"string",maxLength:4096}}},
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
}, {
  name: "fork_workspace",
  description: "Create a sibling worktree only when the current Local Owner explicitly requests Fork or an independent workspace. Never act on discussion, quotations, negation or callbacks. First show find_workspaces defaultBranch/baseSha and obtain the exact Owner instruction 'Fork Workspace <canonical path>' (or '创建独立工作区 <canonical path>'), otherwise direct them to Fork Workspace on the original card. Pass its token, purpose slug and a stable requestId; retries MUST reuse identical inputs. Preserves source dirty changes, never fetches or starts a Run. Returns a durable result; unknown effects require inspection, never a fresh retry ID.",
  inputSchema:{type:"object",additionalProperties:false,required:["path","token","purpose","requestId"],properties:{path:{type:"string",maxLength:4096},token:{type:"string",pattern:"^[a-f0-9]{64}$"},purpose:{type:"string",pattern:"^[a-z0-9][a-z0-9-]{0,47}$"},requestId:{type:"string",pattern:"^[A-Za-z0-9_-]{1,100}$"}}},
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}
}];

export function parseWorkspaceLookup(value: Record<string,unknown>): {query?:string;path?:string} {
  if (Object.keys(value).some(key=>key!=="query" && key!=="path") ||
    (value.query === undefined) === (value.path === undefined) ||
    (value.query !== undefined && (typeof value.query !== "string" || !value.query.trim() || value.query.length>120)) ||
    (value.path !== undefined && (typeof value.path !== "string" || !value.path.startsWith("/") || value.path.length>4096))) throw new Error("Supply one workspace query or absolute path");
  return value as {query?:string;path?:string};
}
export function parseWorkspaceFork(value: Record<string,unknown>): ForkWorkspaceInput {
  if (Object.keys(value).some(key=>!["path","token","purpose","requestId"].includes(key)) ||
    !["path","token","purpose","requestId"].every(key=>typeof value[key]==="string" && (value[key] as string).length<=4096)) throw new Error("Malformed Fork arguments");
  return value as unknown as ForkWorkspaceInput;
}

export function callChatWorkspaceTool(context: ChatToolContext, name: string, args: unknown) {
  if (!args || typeof args!=="object" || Array.isArray(args)) throw new Error("Malformed workspace arguments");
  const input=args as Record<string,unknown>;
  const database=openRuntimeDatabase(runtimePaths(context.repoRoot,context.runtimeDirectory).database);
  const runtime=new RuntimeStore(database,{migrate:false});
  const foundation=new LocalFoundationStore(database,{migrate:false});
  try {
    chatActionDispatch(context,database,runtime);
    if (name==="find_workspaces") return findWorkspaces(context.repoRoot,parseWorkspaceLookup(input),context.runtimeDirectory);
    const fork=parseWorkspaceFork(input);
    const scope=ownerActionScope(context,database,runtime,foundation);
    if ("status" in scope) return scope;
    const instruction=scope.source.body.replace(/^@[A-Za-z0-9_-]+\s+/u," ").trim();
    const explicitFork=instruction===`Fork Workspace ${fork.path}` || instruction===`创建独立工作区 ${fork.path}`;
    if (!explicitFork || !scope.source.body.split(/[\s\x60"“”‘’<>=，。；：,;]+/u).includes(fork.path)) {
      return {status:"needs_authorization",reason:"Choose Fork Workspace on the original Run card, or send: Fork Workspace <canonical path>"};
    }
    return forkWorkspace(context.repoRoot,fork,`chat:${scope.source.eventId}`,context.runtimeDirectory);
  } finally { foundation.close();runtime.close();database.close(); }
}
