export default {
  kind: "subscription.probe", id: "rs-command-completion", schemaVersion: 1,
  plan(config) {
    return { kind: "command", executable: config.nodeExecutable,
      args: [config.probePath, config.commandId, config.receiptRoot], cwd: config.workspaceRoot ?? config.receiptRoot };
  },
  evaluate(config, result) {
    if (result.exitCode !== 0) throw new Error(`Command receipt unavailable: ${result.stderr}`);
    const receipt = JSON.parse(result.stdout);
    if (receipt.commandId !== config.commandId || receipt.schemaVersion !== "ShellCommandReceipt@1") {
      throw new Error("Command receipt identity mismatch");
    }
    const terminal = receipt.state === "completed" ? receipt.outcome : null;
    return { version: `${receipt.commandId}:${receipt.state}:${receipt.completedAt ?? "running"}`,
      facts: receipt, terminal,
      summary: terminal === null ? `Command ${receipt.commandId} is running`
        : `Command ${receipt.commandId}: ${terminal}; exit=${receipt.exitCode}; log=${receipt.logPath}` };
  }
};
