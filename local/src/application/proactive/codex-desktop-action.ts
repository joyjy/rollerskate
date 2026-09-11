import { runtimeId } from "../../core/runtime/model.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import type { CodexPushSourceResolver } from "../../integrations/codex-desktop/push.js";
import { deterministicActionReceiptId } from "../../modules/proactive/target.js";
import { contractRecord, contractText, exactContractKeys, stableContractJson } from "../../modules/steward/contract-codec.js";
import type { DeterministicApplicationActionRegistry, DeterministicApplicationActionRegistration } from "./action-registry.js";

export const CODEX_DESKTOP_PUSH_ACTION = "action:codex-desktop.push@1";

export function parseCodexDesktopActionInput(value: unknown) {
  const input = contractRecord(value, "Desktop push input");
  exactContractKeys(input, ["threadId", "title"], "Desktop push input");
  const threadId = contractText(input.threadId, "threadId", 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(threadId)) {
    throw new Error("Codex Desktop target requires an exact lowercase task UUID");
  }
  return { threadId, title: contractText(input.title, "title", 120) };
}

/** Source transaction owns admission and the outbox; only Delivery performs IPC. */
export const codexDesktopPushAction: DeterministicApplicationActionRegistration = {
  ref: CODEX_DESKTOP_PUSH_ACTION,
  inputSchema: "CodexDesktopPushInput@1",
  parseInput: parseCodexDesktopActionInput,
  executeInTransaction({ database, source, occurrenceKey, observation, actionInput, at }) {
    if (source.kind !== "subscription" && source.kind !== "continuous_subscription") {
      throw new Error("Desktop push action requires a Subscription source");
    }
    const { threadId, title } = parseCodexDesktopActionInput(actionInput);
    const body = JSON.stringify({ title, observation });
    const destinationId = runtimeId("dst");
    const runtime = new RuntimeStore(database, { migrate: false });
    const delivery = runtime.enqueueHostDeliveryInTransaction({
      originId: deterministicActionReceiptId({ source, occurrenceKey }),
      destinationId, kind: "codex-desktop", address: { threadId },
      payload: { body }, maxAttempts: 1, at
    });
    return { status: "succeeded", summary: "Desktop Delivery enqueued; acceptance is recorded on Delivery",
      output: { deliveryId: delivery.deliveryId, destinationId, threadId, body } };
  }
};

export function codexDesktopActionSource(actions: DeterministicApplicationActionRegistry): CodexPushSourceResolver {
  return ({ delivery, destination }) => {
    const receipt = actions.receiptById(delivery.origin.id);
    if (receipt === undefined) return undefined;
    const output = contractRecord(receipt.output, "Desktop action receipt output");
    if (receipt.actionRef !== CODEX_DESKTOP_PUSH_ACTION || receipt.status !== "succeeded" ||
      !["subscription", "continuous_subscription"].includes(receipt.source.kind) ||
      receipt.receiptId !== deterministicActionReceiptId({ source: receipt.source, occurrenceKey: receipt.occurrenceKey }) ||
      output.deliveryId !== delivery.deliveryId || output.destinationId !== destination.destinationId ||
      delivery.destinationId !== destination.destinationId || destination.kind !== "codex-desktop" ||
      stableContractJson(destination.address) !== stableContractJson({ threadId: output.threadId }) ||
      stableContractJson(delivery.payload) !== stableContractJson({ body: output.body })) {
      throw new Error("Codex Desktop Delivery differs from the canonical Subscription action receipt");
    }
    return { body: contractText(output.body, "Desktop action body", 65_536), source: {
      kind: "rs-subscription-observation", subscriptionId: receipt.source.id,
      subscriptionKind: receipt.source.kind, definitionRevision: receipt.source.definitionRevision,
      occurrenceKey: receipt.occurrenceKey, actionReceiptId: receipt.receiptId
    } };
  };
}
