import type {
  AgentInputEvent,
  ChatDispatchEvent
} from "../../core/event/model.js";

export function runtimeAgentEventPrompt(
  event: AgentInputEvent | ChatDispatchEvent
): string {
  const invocationContext = event.type === "agent.request"
    ? event.runContext
    : event.type === "subscription.fire"
      ? event.invocation
      : undefined;
  return [
    "You are handling one fixed-schema Rollerskate Local Runtime Event.",
    event.type === "chat.dispatch"
      ? "Follow the referenced Chat prompt resource and return only its requested JSON object."
      : "Follow the Event prompt and return exactly the result format it requests.",
    "Your entire final response must be the raw requested result: no Markdown fence, prefix, or suffix.",
    `Event type: ${event.type}`,
    `Causal root: ${event.causality.rootEventId}`,
    `Causal hop: ${event.causality.hop}`,
    ...(invocationContext === undefined
      ? []
      : ["Invocation context:", JSON.stringify(invocationContext)]),
    ...(event.type === "subscription.fire" && event.observation !== undefined
      ? ["Terminal observation:", JSON.stringify(event.observation)]
      : []),
    "Prompt:",
    event.prompt
  ].join("\n");
}
