import { parseAgentInvocationReceipt } from "./codec.js";
import { RuntimeStoreQuery } from "./query.js";
import type { RuntimeAudit } from "./types.js";

export class RuntimeAuditQuery {
  readonly #query: RuntimeStoreQuery;

  public constructor(query: RuntimeStoreQuery) {
    this.#query = query;
  }

  public audit(eventId: string): RuntimeAudit | undefined {
    const event = this.#query.event(eventId);
    if (event === undefined) return undefined;
    const execution = this.#query.executionForEvent(eventId);
    const resultEvent = event.type === "agent.result"
      ? event
      : this.#query.resultEventForParent(event.eventId);
    const sessionId = resultEvent?.sessionId ?? event.sessionId;
    const session = sessionId === undefined ? undefined : this.#query.session(sessionId);
    const resultExecution = resultEvent === undefined || resultEvent.eventId === event.eventId
      ? undefined
      : this.#query.executionForEvent(resultEvent.eventId);
    const deliveries = resultEvent === undefined
      ? []
      : this.#query.deliveriesForResultEvent(resultEvent.eventId).map((delivery) => {
          const destination = this.#query.destination(delivery.destinationId);
          if (destination === undefined) {
            throw new Error(`Destination not found: ${delivery.destinationId}`);
          }
          return { delivery, destination };
        });
    const chat = event.type === "chat.message" || event.type === "chat.activation"
      ? { attentionReceipts: this.#query.chatAttentionReceipts(event.eventId) }
      : event.type === "chat.dispatch"
        ? {
            promptResourceId: event.promptResourceId,
            attentionReceipts: this.#query.chatAttentionReceipts(event.sourceAttentionEventId)
              .filter((receipt) => receipt.dispatchEventId === event.eventId),
            ...(this.#query.chatDecisionReceipt(event.eventId) === undefined
              ? {}
              : { decisionReceipt: this.#query.chatDecisionReceipt(event.eventId)! })
          }
        : undefined;
    const receiptJson = execution === undefined
      ? null
      : this.#query.executionReceiptJson(execution.executionId);
    const invocation = parseAgentInvocationReceipt(receiptJson) ??
      (event.type === "chat.dispatch"
        ? parseAgentInvocationReceipt(receiptJson, true)
        : undefined);
    return {
      event,
      ...(execution === undefined ? {} : { execution }),
      ...(resultEvent === undefined ? {} : { resultEvent }),
      ...(resultExecution === undefined ? {} : { resultExecution }),
      ...(session === undefined ? {} : { session }),
      ...(invocation === undefined ? {} : { invocation }),
      deliveries,
      ...(chat === undefined ? {} : { chat })
    };
  }

  public audits(limit = 100): RuntimeAudit[] {
    return this.#query.events(limit).map((event) => this.audit(event.eventId)!);
  }

  public auditsForRoot(rootEventId: string): RuntimeAudit[] {
    return this.#query.eventsForRoot(rootEventId)
      .map((event) => this.audit(event.eventId)!);
  }
}
