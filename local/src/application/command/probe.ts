import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { workDigest } from "../../modules/run/intent.js";
import type { RegisteredSubscriptionPlugin } from "../subscription/plugin-registry.js";

/** Bundled receipt reader authority is derived here, never supplied by an external intent. */
export function commandProbe(repoRoot: string, commandId: string, runtimeDirectory?: string) {
  const path = fileURLToPath(new URL("../../../resources/command/completion-plugin.mjs", import.meta.url));
  const probePath = fileURLToPath(new URL("../../entrypoints/command/read-receipt.js", import.meta.url));
  if (!statSync(path).isFile() || !statSync(probePath).isFile()) throw new Error("Build the command completion probe first");
  const workspaceRoot = realpathSync(runtimePaths(repoRoot, runtimeDirectory).runtimeDirectory);
  const nodeExecutable = realpathSync(process.execPath);
  const digest = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  const plugin: RegisteredSubscriptionPlugin = {
    ref: "plugin:rs-command-completion@1", path, id: "rs-command-completion", artifactRevision: digest,
    artifactDigest: digest, authorityDigest: workDigest({ digest, probePath, nodeExecutable, workspaceRoot }),
    workspaceRoot, triggerKinds: ["until"], allowedExecutables: [nodeExecutable], allowedHttpOrigins: []
  };
  return { plugin, config: { commandId, probePath, nodeExecutable, workspaceRoot, receiptRoot: join(workspaceRoot, "commands") } };
}
