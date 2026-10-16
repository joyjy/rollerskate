import type { DatabaseSync } from "node:sqlite";
import { redact } from "../../integrations/activity/provider-source.js";
import { inspectStewardRunView, type StewardRunDetailView } from "./query.js";

// A bounded projection for Chat cards and tools. Lifecycle and intervention stay
// owned by the Steward detail query; output references never copy artifact bodies.
export function stewardWorkView(view: StewardRunDetailView) {
  const { summary, intervention } = view;
  const terminal = ["succeeded", "failed", "cancelled", "needs_human"].includes(summary.status);
  const outputs = view.outputFolders.flatMap((folder) => folder.outputs);
  return {
    kind: "agent" as const,
    detail: { tool: "get_run" as const, runId: summary.runId },
    runId: summary.runId,
    version: summary.version,
    label: redact(summary.mandate.label).slice(0, 512),
    humanQuestion: view.humanQuestion === null ? null : {...view.humanQuestion,question:redact(view.humanQuestion.question)},
    capabilityRequest: view.capabilityRequest,
    state: (view.capabilityRequest?.status === "pending" || view.capabilityRequest?.status === "expired") || view.humanQuestion?.status === "pending" || view.humanQuestion?.status === "expired" || intervention !== null || summary.status === "needs_human"
      ? "needs_human" as const
      : terminal ? "terminal" as const : "started" as const,
    status: summary.status,
    terminal,
    ...(summary.terminalSummary === null ? {} : {
      terminalSummary: redact(summary.terminalSummary).slice(0, 4_096)
    }),
    ...((view.capabilityRequest?.status === "pending" || view.capabilityRequest?.status === "expired") ? {attentionReason: redact(view.capabilityRequest.reason)} : view.humanQuestion?.status === "pending" || view.humanQuestion?.status === "expired" ? {
      attentionReason: redact(view.humanQuestion.question)
    } : intervention === null ? {} : {
      attentionReason: redact(intervention.reason).slice(0, 4_096)
    }),
    intervention: intervention === null ? null : {
      ...intervention, reason: redact(intervention.reason).slice(0, 4_096)
    },
    outputs: outputs.slice(-20).map((output) => ({
      outputId: output.outputId,
      stepId: output.stepId,
      title: redact(output.title).slice(0, 256),
      kind: output.kind,
      contentType: output.contentType
    })),
    outputsTruncated: outputs.length > 20,
    updatedAt: summary.updatedAt
  };
}

export type StewardWorkView = ReturnType<typeof stewardWorkView>;

export function inspectStewardWork(
  repoRoot: string, runId: string, runtimeDirectory?: string, database?: DatabaseSync
): StewardWorkView {
  return stewardWorkView(inspectStewardRunView(repoRoot, runId, runtimeDirectory, {
    inspectCurrentWorkspaceRevision: false,
    ...(database === undefined ? {} : { database })
  }));
}
