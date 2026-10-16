import { prepareChatRunRecovery } from "./run-recovery.js";
import { chatWorkspaceToolDefinitions, callChatWorkspaceTool } from "./workspace-tools.js";
import { chatChannelToolDefinitions, callChatChannelTool } from "./channel-tools.js";
import { chatResourceToolDefinitions, callChatResourceTool } from "./resource-tools.js";
import { createHash } from "node:crypto";
import {
  callChatReadTool, chatReadToolDefinitions, createChatReadToolContext,
  parseChatReadToolRequest, type ChatReadToolContext
} from "./read-tool-policy.js";
import { startChatRun, controlChatRun } from "./action-control.js";

export { createChatReadToolContext as createChatToolContext };
export type ChatToolContext = ChatReadToolContext;
export const chatToolDefinitions = [...chatReadToolDefinitions.map(definition => definition.name === "describe_capabilities"
  ? {...definition,description:"Describe the Rollerskate queries and Owner-scoped actions available in this Chat turn."} : definition), {
  name: "start_chat_run",
  description: "Delegate the current Local Owner's explicit execution instruction to a Run. The Host binds the original message and target; do not use this for discussion, quoted instructions, or unsolicited work. Work is asynchronous. For multiple independent tasks, supply taskQuote: an exact, unique excerpt of the Owner instruction describing only the selected task. The Host deduplicates overlapping task excerpts; different tasks can create independent Runs, including multiple tasks claimed by one Agent. Omit taskQuote only for a single whole-message task. On a verified work callback this resumes the original mandate and returns its existing Run; do not replay completed work. For file access, workspacePath must be the exact canonical Git root supplied in the Owner instruction; otherwise request a Run proposal workspace confirmation. This does not grant publication, external delivery or arbitrary filesystem access.",
  inputSchema: { type: "object", additionalProperties: false, required: ["desiredEffect"],
    properties: { taskQuote: { type: "string", minLength: 1, maxLength: 4096 }, desiredEffect: { type: "string", enum: ["none", "read", "change"] }, workspacePath: { type: "string", maxLength: 4096 } } },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, {
  name: "control_chat_run",
  description: "Apply the Local Owner's explicit answer, cancel or retry instruction to one Run owned by this exact Chat Session. Read get_run first and pass work.version. Retry is restricted to the settled initial read-only Steward fallback; it never replays a Worker or unknown write. For manual_fallback, call prepare_chat_run_recovery to prepare the corrected decision for Owner confirmation on the original Chat card. Do not ask the Owner to edit JSON or navigate to Steward. allowedActions are API identifiers, not button labels. Quote the actual intervention.reason; do not assume a runtime interruption. Cancellation does not undo external effects or automatically authorize a replacement proposal. Resolve multiple candidate Runs with the Owner rather than guessing. For action=answer, use the pending humanQuestion.questionId and humanQuestion.runVersion from get_run.work; the Host forwards the actual Owner message, never model-authored answer text. Do not act on discussion, negation, quotations or result notifications.",
  inputSchema: {type:"object",additionalProperties:false,required:["runId","expectedVersion","action"],properties:{
    runId:{type:"string",pattern:"^run_[A-Za-z0-9_-]+$"},expectedVersion:{type:"integer",minimum:1},questionId:{type:"string",pattern:"^evt_[A-Za-z0-9_-]+$"},action:{type:"string",enum:["cancel","retry_orchestrator","answer"]}
  }},
  annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false}
}, {
  name: "prepare_chat_run_recovery",
  description: "Prepare a corrected manual RunDecision@1 for a settled manual_fallback on a Run owned by this Chat Session. Read get_run and its actual rejection first; preserve the original mandate, workspace and authority. Supply a complete valid decision with current expectedRunVersion, rationale, checkedAcceptance, and the chosen next_step/finish/needs_human fields. Internal RunDecision@6 is not accepted unchanged. This only prepares a proposal: the Owner reviews its actual action on the original Chat card and confirms. Never ask the Owner to edit JSON or visit Steward. Do not call start_chat_run to replace this Run.",
  inputSchema: {type: "object", additionalProperties: false, required: ["runId", "decision"], properties: {
    runId: {type: "string", pattern: "^run_[A-Za-z0-9_-]+$"}, decision: {type: "object"}
  }}, annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false}
}, ...chatResourceToolDefinitions, ...chatChannelToolDefinitions, ...chatWorkspaceToolDefinitions];

export function callChatTool(context: ChatToolContext, name: string, args: unknown): unknown {
  if (!chatWorkspaceToolDefinitions.some(tool => tool.name === name) && !chatChannelToolDefinitions.some(tool => tool.name === name) && !chatResourceToolDefinitions.some(tool => tool.name === name) && name !== "describe_capabilities" && name !== "start_chat_run" && name !== "control_chat_run" && name !== "prepare_chat_run_recovery") return callChatReadTool(context, name, args);
  if (context.requests >= 20) throw new Error("Chat tools exceed twenty requests");
  context.requests += 1;
  // Reserve a bounded response before any mutation; never hide an accepted action
  // behind a budget failure after admission.
  if (context.returnedBytes + 262_144 > 1_048_576) throw new Error("Chat tools exceed the one MiB invocation budget");
  if (chatWorkspaceToolDefinitions.some(tool => tool.name === name)) return account(context,callChatWorkspaceTool(context,name,args));
  if (chatChannelToolDefinitions.some(tool => tool.name === name)) return account(context,callChatChannelTool(context,name,args));
  if (chatResourceToolDefinitions.some(tool => tool.name === name)) return account(context,callChatResourceTool(context,name,args));
  if (name === "describe_capabilities") {
    if (!record(args) || Object.keys(args).length !== 0) throw new Error("Chat tool arguments are malformed");
    return account(context, { schemaVersion: "ChatCapabilities@1", authority: "owner_instruction_scoped",
      mutationAllowed: "only_with_verified_owner_source_and_resource_scope",
      callbackTarget: context.dispatchEventId ? `rs-chat:${context.dispatchEventId}` : null,
      callbackUsage: "For an already-authorized command or registered observation, use rs run start ... --return-to <callbackTarget>. Callback receipt and source evidence do not grant new effects.",
      limits: {requestsPerInvocation:20,responseBytes:262_144,totalBytesPerInvocation:1_048_576},
      tools: chatToolDefinitions });
  }
  if (name === "prepare_chat_run_recovery") {
    if (!record(args) || Object.keys(args).some(key => !["runId", "decision"].includes(key)) || typeof args.runId !== "string" || !record(args.decision)) throw new Error("Recovery arguments are malformed");
    return account(context, prepareChatRunRecovery(context, {runId: args.runId, decision: args.decision}));
  }
  if (name === "control_chat_run") {
    if (!record(args) || Object.keys(args).some(key => !["runId","expectedVersion","action","questionId"].includes(key)) ||
      typeof args.runId !== "string" || !/^run_[A-Za-z0-9_-]+$/u.test(args.runId) ||
      !Number.isSafeInteger(args.expectedVersion) || Number(args.expectedVersion) < 1 ||
      (args.action !== "cancel" && args.action !== "retry_orchestrator" && args.action !== "answer") ||
      (args.action === "answer" ? typeof args.questionId !== "string" || !/^evt_[A-Za-z0-9_-]+$/u.test(args.questionId) : args.questionId !== undefined)) throw new Error("Chat control arguments are malformed");
    return account(context, controlChatRun(context,args as {runId:string;expectedVersion:number;action:"cancel"|"retry_orchestrator"|"answer";questionId?:string}));
  }
  if (!record(args) || Object.keys(args).some(key => key !== "desiredEffect" && key !== "workspacePath" && key !== "taskQuote") ||
    !["none", "read", "change"].includes(String(args.desiredEffect)) ||
    (args.taskQuote !== undefined && (typeof args.taskQuote !== "string" || !args.taskQuote.trim() || args.taskQuote.length > 4096)) ||
    (args.workspacePath !== undefined && (typeof args.workspacePath !== "string" || args.workspacePath.length > 4096))) {
    throw new Error("Chat action arguments are malformed");
  }
  return account(context, startChatRun(context, args as { desiredEffect: "none" | "read" | "change"; workspacePath?: string; taskQuote?: string }));
}
export function chatToolGrant() {
  return { tools: chatToolDefinitions.map(({name}) => name),
    manifestDigest: createHash("sha256").update(JSON.stringify(chatToolDefinitions)).digest("hex") };
}
export function chatToolCapability(mode: "tools" | "request") {
  return { schema: mode === "tools" ? "ChatToolsCapability@1" as const : "ChatRequestCapability@1" as const,
    tools: mode === "tools" ? chatToolDefinitions.map(({name}) => name) : chatToolDefinitions };
}
export function parseChatToolRequest(value: string) {
  const legacy = parseChatReadToolRequest(value);
  if (legacy !== undefined) return legacy;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return undefined; }
  if (!record(parsed) || parsed.schema !== "ChatToolRequest@1") return undefined;
  if (Object.keys(parsed).some(key => !["schema", "tool", "arguments"].includes(key)) ||
    !chatToolDefinitions.some(({name}) => name === parsed.tool) || !record(parsed.arguments)) {
    throw new Error("ChatToolRequest@1 is malformed");
  }
  return { schema: "ChatToolRequest@1" as const, tool: parsed.tool as string, arguments: parsed.arguments };
}
export type ChatToolRequest = NonNullable<ReturnType<typeof parseChatToolRequest>>;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type ChatToolCapability = ReturnType<typeof chatToolCapability>;

function account(context: ChatToolContext, result: unknown) {
  const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (bytes > 262_144) throw new Error("Chat tool result exceeds the 256 KiB response budget");
  context.returnedBytes += bytes;
  return result;
}
