import { vikunjaRunResultDelivery } from
  "../../integrations/vikunja/task-destination.js";
import type { RunResultDestination } from
  "../../modules/steward/caller-contract.js";

export function terminalRunResultDelivery(
  destination: RunResultDestination,
  input: {
    readonly runId: string;
    readonly cycleId?: string;
    readonly status: "succeeded" | "failed" | "needs_human";
    readonly summary: string;
  }
): {
  readonly kind: "vikunja-task" | "server-topic";
  readonly address: Readonly<Record<string, string>>;
  readonly payload: Readonly<Record<string, unknown>>;
} {
  const heading = `Rollerskate Run ${input.runId}${input.cycleId === undefined
    ? ""
    : ` cycle ${input.cycleId}`}: ${input.status}`;
  const detailedBody = [
    heading,
    "",
    input.summary
  ].join("\n");
  if (destination.delivery.kind === "vikunja-task") {
    const delivery = vikunjaRunResultDelivery(destination);
    return {
      kind: delivery.kind,
      address: delivery.address,
      payload: {
        schemaVersion: "VikunjaTaskComment@1",
        runId: input.runId,
        body: detailedBody
      }
    };
  }
  if (destination.delivery.kind === "server-topic") {
    const address = destination.delivery.address;
    if (Object.keys(address).length !== 2 ||
      text(address.topicId) === undefined || text(address.agentId) === undefined) {
      throw new Error("Steward server-topic destination address is invalid");
    }
    return {
      kind: "server-topic",
      address: { topicId: address.topicId!, agentId: address.agentId! },
      payload: {
        body: [heading, "", "Inspect the Run Workspace for bounded details and trace."].join(
          "\n"
        )
      }
    };
  }
  throw new Error(
    `Steward terminal result destination is unsupported: ${destination.delivery.kind}`
  );
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
