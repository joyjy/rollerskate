import { assertProviderSessionIdentity } from "../../core/runtime/agent-invocation.js";
import { redact } from "../../integrations/activity/provider-source.js";
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
  callChatTool,
  parseChatToolRequest,
  type ChatToolContext,
  type ChatToolRequest
} from "./tool-policy.js";

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
    readonly chatTools?: (event: ChatDispatchEvent) => ChatToolContext;
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
    readonly chatTools?: (event: ChatDispatchEvent) => ChatToolContext;
  }
): Promise<AgentAdapterInvocation> {
  let receipt = initialReceipt;
  assertProviderSessionIdentity(input.providerSessionId, receipt.providerSessionId);
  if (receipt.outcome.kind !== "message") return receipt;
  let chatRequest = parseChatHistoryRequest(receipt.outcome.body);
  let clientRequest = parseClientHistoryRequestForAdapter(adapter, receipt.outcome.body);
  let toolRequest = options.chatTools === undefined
    ? undefined
    : parseChatToolRequestForAdapter(adapter, receipt.outcome.body);
  if (chatRequest === undefined && clientRequest === undefined && toolRequest === undefined) {
    return receipt;
  }
  const chatTools = options.chatTools?.(input.event);
  let expectedCursor: string | undefined;
  let initializedChatCursor = false;
  let recalledMessages = 0;
  let recalledBytes = 0;
  let requests = 0;
  while (chatRequest !== undefined || clientRequest !== undefined || toolRequest !== undefined) {
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
      // History and tool results share one response budget. Reserve envelope space
      // before a tool can mutate, rather than discover overflow after admission.
      chatTools!.returnedBytes = Math.max(chatTools!.returnedBytes, recalledBytes + 4_096);
      let result: unknown;
      try {
        result = callChatTool(chatTools!,toolRequest!.tool,toolRequest!.arguments);
      } catch (error) {
        result = {status:"tool_error",error:redact(error instanceof Error ? error.message : String(error)).slice(0,500),
          guidance:"Check the source state before deciding again. Do not replay the whole instruction or assume a failed response undid an effect."};
      }
      response = [
        `Rollerskate tool result for ${toolRequest!.tool}:`,
        JSON.stringify(result)
      ].join("\n");
    }
    recalledBytes += Buffer.byteLength(response, "utf8");
    if (recalledMessages > 10_000 || recalledBytes > 1_048_576) {
      throw new Error("Chat history access exceeds the bounded context budget");
    }
    const expectedSessionId = receipt.providerSessionId;
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
    assertProviderSessionIdentity(expectedSessionId,receipt.providerSessionId);
    chatRequest = receipt.outcome.kind === "message"
      ? parseChatHistoryRequest(receipt.outcome.body)
      : undefined;
    clientRequest = receipt.outcome.kind === "message"
      ? parseClientHistoryRequestForAdapter(adapter, receipt.outcome.body)
      : undefined;
    toolRequest = options.chatTools !== undefined && receipt.outcome.kind === "message"
      ? parseChatToolRequestForAdapter(adapter, receipt.outcome.body)
      : undefined;
  }
  return receipt;
}

function parseChatToolRequestForAdapter(
  adapter: RuntimeAgentAdapter,
  body: string
): ChatToolRequest | undefined {
  return adapter.providerPolicy?.client === "kimi-code"
    ? parseChatToolRequest(body)
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
