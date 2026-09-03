import {
  parseChatHistoryRequest,
  parseClientHistoryRequest,
  type ChatPromptHistory,
  type ClientHistoryRequest,
  type ClientHistoryResult
} from "../../core/chat/model.js";
import type { ChatDispatchEvent } from "../../core/event/model.js";
import type {
  AgentAdapterInput,
  AgentAdapterInvocation
} from "../../core/runtime/agent-invocation.js";
import type { RuntimeAgentAdapter } from "../../core/runtime/handlers.js";
import {
  admitSameClientHistoryPolicy,
  type ProviderPolicyReceipt
} from "../../modules/agent/activity-policy.js";
import { isAgentClient } from "../../modules/agent/client-profile.js";
import {
  callChatReadTool,
  parseChatReadToolRequest,
  type ChatReadToolContext,
  type ChatReadToolRequest
} from "./read-tool-policy.js";

export interface ChatHistoryPageInput {
  readonly topicId: string;
  readonly beforeEventId?: string;
  readonly limit: number;
}

export function withChatHistoryContinuation(
  adapter: RuntimeAgentAdapter,
  options: {
    readonly chatHistory: (input: ChatHistoryPageInput) => ChatPromptHistory;
    readonly clientHistory: (
      agentId: string,
      request: ClientHistoryRequest,
      policyReceipt: ProviderPolicyReceipt | undefined,
      currentProviderSessionId: string | undefined
    ) => ClientHistoryResult;
    readonly chatReadTools?: () => ChatReadToolContext;
  }
): RuntimeAgentAdapter {
  return {
    adapterId: adapter.adapterId,
    workspace: adapter.workspace,
    ...(adapter.providerPolicy === undefined
      ? {}
      : { providerPolicy: adapter.providerPolicy }),
    async invoke(input) {
      const initial = await adapter.invoke(input);
      if (input.event.type !== "chat.dispatch") return initial;
      return continueHistoryRequests(adapter, {
        event: input.event,
        ...(input.providerSessionId === undefined
          ? {}
          : { providerSessionId: input.providerSessionId })
      }, initial, options);
    }
  };
}

async function continueHistoryRequests(
  adapter: RuntimeAgentAdapter,
  input: AgentAdapterInput & { readonly event: ChatDispatchEvent },
  initialReceipt: AgentAdapterInvocation,
  options: {
    readonly chatHistory: (input: ChatHistoryPageInput) => ChatPromptHistory;
    readonly clientHistory: (
      agentId: string,
      request: ClientHistoryRequest,
      policyReceipt: ProviderPolicyReceipt | undefined,
      currentProviderSessionId: string | undefined
    ) => ClientHistoryResult;
    readonly chatReadTools?: () => ChatReadToolContext;
  }
): Promise<AgentAdapterInvocation> {
  let receipt = initialReceipt;
  if (receipt.outcome.kind !== "message") return receipt;
  let chatRequest = parseChatHistoryRequest(receipt.outcome.body);
  let clientRequest = parseClientHistoryRequestForAdapter(adapter, receipt.outcome.body);
  let readToolRequest = options.chatReadTools === undefined
    ? undefined
    : parseChatReadToolRequestForAdapter(adapter, receipt.outcome.body);
  if (chatRequest === undefined && clientRequest === undefined && readToolRequest === undefined) {
    return receipt;
  }
  const readTools = options.chatReadTools?.();
  let expectedCursor: string | undefined;
  let initializedChatCursor = false;
  let recalledMessages = 0;
  let recalledBytes = 0;
  let requests = 0;
  while (chatRequest !== undefined || clientRequest !== undefined || readToolRequest !== undefined) {
    if (requests >= 20) throw new Error("Chat history access exceeds twenty requests");
    requests += 1;
    let response: string;
    if (chatRequest !== undefined) {
      if (!initializedChatCursor) {
        const initialHistory = options.chatHistory({
          topicId: input.event.topicId,
          ...(input.event.sourceMessageEventId === undefined
            ? {}
            : { beforeEventId: input.event.sourceMessageEventId }),
          limit: 10_000
        });
        expectedCursor = initialHistory.hasEarlier
          ? initialHistory.beforeEventId
          : undefined;
        initializedChatCursor = true;
      }
      if (expectedCursor === undefined || chatRequest.beforeEventId !== expectedCursor) {
        throw new Error("Chat history recall cursor does not match the previous page");
      }
      const page = options.chatHistory({
        topicId: input.event.topicId,
        beforeEventId: chatRequest.beforeEventId,
        limit: chatRequest.limit
      });
      if (page.items.length === 0) {
        throw new Error("Chat history recall returned an empty page");
      }
      recalledMessages += page.items.length;
      if (page.hasEarlier &&
        (page.beforeEventId === undefined ||
          page.beforeEventId === chatRequest.beforeEventId)) {
        throw new Error("Chat history recall cursor did not advance");
      }
      expectedCursor = page.hasEarlier ? page.beforeEventId : undefined;
      response = [
        "The Runtime accepted your ChatHistoryRequest@1.",
        "Here is the bounded earlier history page:",
        JSON.stringify(page, null, 2)
      ].join("\n");
    } else if (clientRequest !== undefined) {
      const result = options.clientHistory(
        input.event.agentId,
        clientRequest!,
        sameClientHistoryPolicyForAdapter(adapter),
        receipt.providerSessionId
      );
      recalledMessages += result.items.length;
      response = [
        "The Runtime accepted your ClientHistoryRequest@1.",
        "Here is the bounded, redacted same-client history result:",
        JSON.stringify(result, null, 2)
      ].join("\n");
    } else {
      const result = callChatReadTool(
        readTools!,
        readToolRequest!.tool,
        readToolRequest!.arguments
      );
      response = [
        `The Runtime accepted your ${readToolRequest!.tool} Chat read request.`,
        "Here is the bounded, redacted, read-only Rollerskate evidence:",
        JSON.stringify(result, null, 2)
      ].join("\n");
    }
    recalledBytes += Buffer.byteLength(response, "utf8");
    if (recalledMessages > 10_000 || recalledBytes > 1_048_576) {
      throw new Error("Chat history access exceeds the bounded context budget");
    }
    receipt = await adapter.invoke({
      event: {
        ...input.event,
        prompt: [
          response,
          "Return the original Chat decision schema now, or make another allowed history",
          "request only when the returned result shows that it is necessary.",
          "For proactive_contribution, an empty or unhelpful history result is not itself",
          "a reason to stay silent; follow the original intent using the bounded Topic history."
        ].join("\n")
      },
      providerSessionId: receipt.providerSessionId
    });
    chatRequest = receipt.outcome.kind === "message"
      ? parseChatHistoryRequest(receipt.outcome.body)
      : undefined;
    clientRequest = receipt.outcome.kind === "message"
      ? parseClientHistoryRequestForAdapter(adapter, receipt.outcome.body)
      : undefined;
    readToolRequest = options.chatReadTools !== undefined && receipt.outcome.kind === "message"
      ? parseChatReadToolRequestForAdapter(adapter, receipt.outcome.body)
      : undefined;
  }
  return receipt;
}

function parseChatReadToolRequestForAdapter(
  adapter: RuntimeAgentAdapter,
  body: string
): ChatReadToolRequest | undefined {
  return adapter.providerPolicy?.client === "kimi-code"
    ? parseChatReadToolRequest(body)
    : undefined;
}

function parseClientHistoryRequestForAdapter(
  adapter: RuntimeAgentAdapter,
  body: string
): ClientHistoryRequest | undefined {
  return adapter.providerPolicy?.client === "codex"
    ? undefined
    : parseClientHistoryRequest(body);
}

export function sameClientHistoryPolicyForAdapter(
  adapter: RuntimeAgentAdapter
): ProviderPolicyReceipt | undefined {
  const observation = adapter.providerPolicy;
  if (observation === undefined) return undefined;
  if (!isAgentClient(observation.client)) {
    throw new Error("Provider policy observation has an unsupported client");
  }
  return admitSameClientHistoryPolicy({
    ...observation,
    client: observation.client
  });
}
