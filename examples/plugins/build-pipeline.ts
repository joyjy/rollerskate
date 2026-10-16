interface GitLabPipelineInput {
  readonly schemaVersion: "GitLabPipelineInput@1";
  readonly transport: {
    readonly kind: "command";
    readonly executable: string;
    readonly project: string;
    readonly pipelineId: number;
    readonly cwd?: string;
  };
  readonly expectedSha: string;
}

interface ProbeResult {
  readonly kind: "command";
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface PipelinePayload {
  readonly id: number;
  readonly status: string;
  readonly ref?: string;
  readonly sha?: string;
  readonly web_url?: string;
  readonly updated_at?: string;
}

const terminal = new Map<string, "success" | "failure" | "cancelled">([
  ["success", "success"],
  ["failed", "failure"],
  ["canceled", "cancelled"],
  ["cancelled", "cancelled"],
  ["skipped", "cancelled"]
]);

/** Owner-registered source for `scripts/rs run pipeline`; it has no host permissions. */
export default {
  kind: "subscription.probe",
  id: "build-pipeline",
  schemaVersion: 1,

  plan(input: GitLabPipelineInput) {
    validateInput(input);
    return {
      kind: "command",
      executable: input.transport.executable,
      args: ["api", `projects/${encodeURIComponent(input.transport.project)}/pipelines/${input.transport.pipelineId}`],
      ...(input.transport.cwd === undefined ? {} : { cwd: input.transport.cwd })
    };
  },

  evaluate(input: GitLabPipelineInput, result: ProbeResult) {
    validateInput(input);
    if (result.kind !== "command" || result.exitCode !== 0) {
      throw new Error(`pipeline command probe failed: ${result.stderr ?? "unknown error"}`);
    }
    const payload = JSON.parse(result.stdout ?? "") as PipelinePayload;
    if (!Number.isInteger(payload.id) || typeof payload.status !== "string") {
      throw new Error("pipeline response is malformed");
    }
    if (payload.id !== input.transport.pipelineId) {
      throw new Error(`pipeline response ID ${payload.id} does not match requested pipeline ${input.transport.pipelineId}`);
    }
    const shaMatches = payload.sha === input.expectedSha;
    return {
      version: [payload.id, payload.sha ?? "unknown", payload.status, payload.updated_at ?? "unknown"].join(":"),
      facts: {
        pipelineId: payload.id,
        status: payload.status,
        ref: payload.ref ?? null,
        sha: payload.sha ?? null,
        expectedSha: input.expectedSha,
        shaMatches,
        url: payload.web_url ?? null,
        updatedAt: payload.updated_at ?? null
      },
      terminal: shaMatches ? terminal.get(payload.status) ?? null : "failure",
      summary: shaMatches
        ? `Pipeline ${payload.id} is ${payload.status}`
        : `Pipeline ${payload.id} SHA does not match the expected revision`
    };
  }
};

function validateInput(input: GitLabPipelineInput): void {
  if (input.schemaVersion !== "GitLabPipelineInput@1" || input.transport?.kind !== "command" ||
    typeof input.transport.executable !== "string" || input.transport.executable === "" ||
    typeof input.transport.project !== "string" || input.transport.project === "" ||
    !Number.isSafeInteger(input.transport.pipelineId) || input.transport.pipelineId < 1 ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(input.expectedSha)) {
    throw new Error("GitLabPipelineInput@1 requires a command transport, positive pipeline ID, and exact lowercase expected SHA");
  }
}
