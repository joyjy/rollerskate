import { parseBoundedJsonObject } from "../../modules/agent/result-envelope.js";

export interface SubscriptionAgentResult {
  readonly schemaVersion: "SubscriptionAgentResult@1";
  readonly status: "succeeded" | "blocked" | "failed";
  readonly summary: string;
  readonly artifactRefs: readonly string[];
}

export function subscriptionAgentPrompt(prompt: string): string {
  return [
    prompt,
    "Return exactly one SubscriptionAgentResult@1 JSON object:",
    JSON.stringify({
      schemaVersion: "SubscriptionAgentResult@1",
      status: "succeeded | blocked | failed",
      summary: "bounded human-readable outcome",
      artifactRefs: ["optional durable artifact or MR references"]
    }),
    "Own the requested outcome, not merely the first attempted command. Inspect available tool help and contracts when a deterministic request error occurs. You may make a bounded number of information-gaining corrections only when readback proves the failed attempt did not mutate external state; repeating the same request is not a correction.",
    "Read back every mutation. Stop when authority, approval, credentials, a required tool, or an external prerequisite is missing; the target or revision is ambiguous; any side effect has an ambiguous outcome; recovery would expand the granted scope; or bounded recovery is exhausted. Use blocked for a missing prerequisite or authority and failed for an exhausted or verified-incomplete in-scope outcome. Use succeeded only when every requested side effect is complete and verified."
  ].join("\n");
}

export function parseSubscriptionAgentResult(output: string): SubscriptionAgentResult {
  const value = parseBoundedJsonObject(
    output,
    "SubscriptionAgentResult@1 output must be one JSON object"
  );
  if (value.schemaVersion !== "SubscriptionAgentResult@1") {
    throw new Error("SubscriptionAgentResult@1 schemaVersion is required");
  }
  exactKeys(value, ["schemaVersion", "status", "summary", "artifactRefs"]);
  if (value.status !== "succeeded" && value.status !== "blocked" && value.status !== "failed") {
    throw new Error("SubscriptionAgentResult@1 status is unsupported");
  }
  if (typeof value.summary !== "string" || value.summary.trim() === "" ||
    Buffer.byteLength(value.summary, "utf8") > 4_096) {
    throw new Error("SubscriptionAgentResult@1 summary must contain 1-4096 bytes");
  }
  if (!Array.isArray(value.artifactRefs) || value.artifactRefs.length > 32 ||
    value.artifactRefs.some((item) => typeof item !== "string" || item.trim() === "" ||
      Buffer.byteLength(item, "utf8") > 2_048)) {
    throw new Error("SubscriptionAgentResult@1 artifactRefs are malformed");
  }
  return {
    schemaVersion: "SubscriptionAgentResult@1",
    status: value.status,
    summary: value.summary,
    artifactRefs: value.artifactRefs as string[]
  };
}

function exactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`SubscriptionAgentResult@1 has unknown field: ${unknown}`);
  const missing = allowed.find((key) => !(key in value));
  if (missing !== undefined) throw new Error(`SubscriptionAgentResult@1 is missing field: ${missing}`);
}
