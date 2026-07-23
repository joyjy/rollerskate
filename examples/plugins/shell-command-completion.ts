interface Config {
  readonly commandId: string;
  readonly probeExecutable: string;
  readonly cwd?: string;
}

interface ProbeResult {
  readonly kind: "command";
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Receipt {
  readonly schemaVersion: 1;
  readonly commandId: string;
  readonly state: "running" | "completed";
  readonly outcome?: "success" | "failure" | "cancelled";
  readonly exitCode?: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export default {
  kind: "subscription.probe",
  id: "shell-command-completion",
  schemaVersion: 1,

  plan(config: Config) {
    return {
      kind: "command",
      executable: config.probeExecutable,
      args: [config.commandId],
      ...(config.cwd === undefined ? {} : { cwd: config.cwd })
    };
  },

  evaluate(config: Config, result: ProbeResult) {
    if (result.exitCode !== 0) {
      throw new Error(`command receipt probe failed: ${result.stderr || `exit ${result.exitCode}`}`);
    }
    const receipt = JSON.parse(result.stdout) as Receipt;
    if (receipt.schemaVersion !== 1 || receipt.commandId !== config.commandId ||
      (receipt.state !== "running" && receipt.state !== "completed")) {
      throw new Error("command receipt is malformed");
    }
    const terminal = receipt.state === "completed"
      ? receipt.outcome ?? (receipt.exitCode === 0 ? "success" : "failure")
      : null;
    return {
      version: receipt.state === "completed"
        ? `${receipt.commandId}:${receipt.completedAt ?? "completed"}:${terminal}`
        : `${receipt.commandId}:running`,
      facts: {
        commandId: receipt.commandId,
        state: receipt.state,
        exitCode: receipt.exitCode ?? null,
        startedAt: receipt.startedAt ?? null,
        completedAt: receipt.completedAt ?? null
      },
      terminal,
      summary: receipt.state === "completed"
        ? `Shell command ${receipt.commandId} completed with ${terminal}`
        : `Shell command ${receipt.commandId} is still running`
    };
  }
};
