type Transport =
  | {
      readonly kind: "http";
      readonly apiOrigin: string;
      readonly project: string;
      readonly pipelineId: number;
      readonly tokenEnvironment?: string;
    }
  | {
      readonly kind: "command";
      readonly executable: string;
      readonly project: string;
      readonly pipelineId: number;
      readonly cwd?: string;
      readonly environment?: readonly string[];
    };

interface Config {
  readonly transport: Transport;
}

interface ProbeResult {
  readonly kind: "http" | "command";
  readonly status?: number;
  readonly body?: string;
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

export default {
  kind: "subscription.probe",
  id: "gitlabee-pipeline",
  schemaVersion: 1,

  plan(config: Config) {
    const transport = config.transport;
    const endpoint = `projects/${encodeURIComponent(transport.project)}/pipelines/${transport.pipelineId}`;
    if (transport.kind === "http") {
      return {
        kind: "http",
        url: `${transport.apiOrigin}/api/v4/${endpoint}`,
        method: "GET",
        ...(transport.tokenEnvironment === undefined
          ? {}
          : { headers: { "PRIVATE-TOKEN": { environment: transport.tokenEnvironment } } })
      };
    }
    return {
      kind: "command",
      executable: transport.executable,
      args: ["api", endpoint],
      ...(transport.cwd === undefined ? {} : { cwd: transport.cwd }),
      environment: Object.fromEntries((transport.environment ?? []).map((name) => [
        name,
        { environment: name }
      ]))
    };
  },

  evaluate(_config: Config, result: ProbeResult) {
    if (result.kind === "http" && result.status !== 200) {
      throw new Error(`pipeline HTTP probe returned ${result.status}`);
    }
    if (result.kind === "command" && result.exitCode !== 0) {
      throw new Error(`pipeline command probe failed: ${result.stderr ?? "unknown error"}`);
    }
    const payload = JSON.parse(result.kind === "http" ? result.body ?? "" : result.stdout ?? "") as PipelinePayload;
    if (!Number.isInteger(payload.id) || typeof payload.status !== "string") {
      throw new Error("pipeline response is malformed");
    }
    return {
      version: [payload.id, payload.sha ?? "unknown", payload.status, payload.updated_at ?? "unknown"].join(":"),
      facts: {
        pipelineId: payload.id,
        status: payload.status,
        ref: payload.ref ?? null,
        sha: payload.sha ?? null,
        url: payload.web_url ?? null,
        updatedAt: payload.updated_at ?? null
      },
      terminal: terminal.get(payload.status) ?? null,
      summary: `Pipeline ${payload.id} is ${payload.status}`
    };
  }
};
