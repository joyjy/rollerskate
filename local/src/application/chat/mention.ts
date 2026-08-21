import type { LocalAgent } from "../../modules/foundation/model.js";

export function mentionedChatAgents(
  body: string,
  agents: readonly LocalAgent[]
): readonly LocalAgent[] {
  return agents.filter((agent) => new RegExp(
    `(^|[^\\p{L}\\p{N}_-])@${escapeRegExp(agent.handle)}` +
      "(?=$|[^\\p{L}\\p{N}_-])",
    "iu"
  ).test(body));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
