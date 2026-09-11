import { temporaryDirectory } from "./support/temp-directory.js";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  PollPluginRunner,
  PollProbeExecutor
} from "../src/capabilities/subscription/plugin-runner.js";

test("TypeScript poll plugin plans a probe and evaluates a terminal result in the host", async () => {
  const directory = temporaryDirectory("rollerskate-plugin-runner-");
  const plugin = join(directory, "pipeline.ts");
  writeFileSync(plugin, `
interface Config { readonly url: string }
export default {
  kind: "subscription.probe",
  id: "fixture-pipeline",
  schemaVersion: 1,
  plan(config: Config) {
    return { kind: "http", url: config.url, method: "GET" };
  },
  evaluate(_config: Config, result: { readonly body: string }) {
    const payload = JSON.parse(result.body) as { id: number; status: string };
    return {
      version: String(payload.id) + ":" + payload.status,
      facts: payload,
      terminal: payload.status === "success" ? "success" : null
    };
  }
};
`, "utf8");
  const runner = new PollPluginRunner();
  const context = {
    subscriptionId: "sub-1",
    attempt: 1,
    startedAt: "2026-07-22T10:00:00.000Z",
    deadlineAt: "2026-07-22T10:01:00.000Z"
  };
  assert.deepEqual(await runner.plan(plugin, "fixture-pipeline", { url: "https://example.test/pipelines/42" }, context), {
    kind: "http",
    url: "https://example.test/pipelines/42",
    method: "GET"
  });
  assert.deepEqual(await runner.evaluate(plugin, "fixture-pipeline", {}, context, {
    kind: "http",
    status: 200,
    headers: {},
    body: '{"id":42,"status":"success"}'
  }), {
    version: "42:success",
    facts: { id: 42, status: "success" },
    terminal: "success"
  });
});

test("poll plugin cannot supply the Runtime-owned terminal identity", async () => {
  const directory = temporaryDirectory("rollerskate-plugin-terminal-key-");
  const plugin = join(directory, "deprecated-terminal-key.mjs");
  writeFileSync(plugin, `export default {
    kind: "subscription.probe",
    id: "deprecated-terminal-key",
    schemaVersion: 1,
    plan() { return { kind: "http", url: "https://example.test/status" }; },
    evaluate() {
      return {
        version: "v1",
        terminalKey: "plugin-owned",
        facts: {},
        terminal: "success"
      };
    }
  };`, "utf8");
  const runner = new PollPluginRunner();

  await assert.rejects(
    runner.evaluate(plugin, "deprecated-terminal-key", {}, {
      subscriptionId: "sub-1",
      attempt: 1,
      startedAt: "2026-07-22T10:00:00.000Z"
    }, {
      kind: "http",
      status: 200,
      headers: {},
      body: "{}"
    }),
    /Runtime owns terminal identity/
  );
});

test("user plugin must fill the subscription.probe slot and cannot present a Capability", async () => {
  const directory = temporaryDirectory("rollerskate-plugin-kind-");
  const plugin = join(directory, "capability.ts");
  writeFileSync(plugin, `
export default {
  kind: "capability",
  id: "third-party-capability",
  schemaVersion: 1,
  plan() {
    return { kind: "http", url: "https://example.test" };
  },
  evaluate() {
    return { version: "1", facts: {}, terminal: null };
  }
};
`, "utf8");
  await assert.rejects(
    new PollPluginRunner().plan(plugin, "third-party-capability", {}, {
      subscriptionId: "sub-1",
      attempt: 1,
      startedAt: "2026-07-22T10:00:00.000Z",
      deadlineAt: "2026-07-22T10:01:00.000Z"
    }),
    /default export is malformed/
  );
});

test("probe executor enforces HTTP origins and exact command executable", async () => {
  const directory = realpathSync(temporaryDirectory("rollerskate-probe-executor-"));
  const executable = realpathSync(process.execPath);
  const policy = {
    workspaceRoot: directory,
    allowedHttpOrigins: ["https://example.test"],
    allowedExecutables: [executable],
    allowedEnvironment: [],
    timeoutMilliseconds: 1_000,
    maxOutputBytes: 4_096
  };
  const executor = new PollProbeExecutor({
    fetch: async () => new Response('{"status":"running"}', { status: 200 })
  });
  assert.equal((await executor.execute({
    kind: "http",
    url: "https://example.test/pipeline"
  }, policy)).kind, "http");
  await assert.rejects(executor.execute({
    kind: "http",
    url: "https://not-allowed.test/pipeline"
  }, policy), /origin is not allowed/);
  assert.deepEqual(await executor.execute({
    kind: "command",
    executable,
    args: ["-e", "process.stdout.write('ok')"]
  }, policy), {
    kind: "command",
    exitCode: 0,
    stdout: "ok",
    stderr: ""
  });
});

test("GitLabee reference plugin keeps pipeline planning and status mapping outside core", async () => {
  const plugin = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../examples/plugins/gitlabee-pipeline.ts"
  );
  const runner = new PollPluginRunner();
  const context = {
    subscriptionId: "pipeline-42",
    attempt: 1,
    startedAt: "2026-07-22T10:00:00.000Z",
    deadlineAt: "2026-07-22T11:00:00.000Z"
  };
  const config = {
    transport: {
      kind: "command",
      executable: realpathSync(process.execPath),
      project: "group/project",
      pipelineId: 42,
      cwd: dirname(plugin),
      environment: ["HOME"]
    }
  };
  assert.deepEqual(await runner.plan(plugin, "gitlabee-pipeline", config, context), {
    kind: "command",
    executable: realpathSync(process.execPath),
    args: ["api", "projects/group%2Fproject/pipelines/42"],
    cwd: dirname(plugin),
    environment: { HOME: { environment: "HOME" } }
  });
  const observation = await runner.evaluate(plugin, "gitlabee-pipeline", config, context, {
    kind: "command",
    exitCode: 0,
    stdout: JSON.stringify({
      id: 42,
      status: "success",
      ref: "main",
      sha: "abc123",
      web_url: "https://gitlabee.example/group/project/-/pipelines/42",
      updated_at: "2026-07-22T10:05:00Z"
    }),
    stderr: ""
  });
  assert.equal(observation.terminal, "success");
  assert.equal("terminalKey" in observation, false);
  assert.equal(observation.version, "42:abc123:success:2026-07-22T10:05:00Z");
  assert.deepEqual(observation.facts, {
    pipelineId: 42,
    status: "success",
    ref: "main",
    sha: "abc123",
    url: "https://gitlabee.example/group/project/-/pipelines/42",
    updatedAt: "2026-07-22T10:05:00Z"
  });
});

test("shell command completion plugin observes a fixed workspace receipt without rerunning the command", async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const plugin = resolve(repoRoot, "examples/plugins/shell-command-completion.ts");
  const executable = realpathSync(resolve(repoRoot, "examples/probes/read-command-receipt"));
  const workspace = realpathSync(temporaryDirectory("rollerskate-command-receipt-"));
  const config = {
    commandId: "acceptance-1",
    probeExecutable: executable,
    cwd: workspace
  };
  const context = {
    subscriptionId: "shell-command-1",
    attempt: 1,
    startedAt: "2026-07-23T10:00:00.000Z",
    deadlineAt: "2026-07-23T10:10:00.000Z"
  };
  const runner = new PollPluginRunner();
  const probe = await runner.plan(plugin, "shell-command-completion", config, context);
  assert.deepEqual(probe, {
    kind: "command",
    executable,
    args: ["acceptance-1"],
    cwd: workspace
  });
  const executor = new PollProbeExecutor();
  const policy = {
    workspaceRoot: workspace,
    allowedHttpOrigins: [],
    allowedExecutables: [executable],
    allowedEnvironment: [],
    timeoutMilliseconds: 1_000,
    maxOutputBytes: 4_096
  };
  const running = await executor.execute(probe, policy);
  assert.equal((await runner.evaluate(
    plugin,
    "shell-command-completion",
    config,
    context,
    running
  )).terminal, null);

  const receiptDirectory = join(workspace, ".rollerskate-command-receipts");
  mkdirSync(receiptDirectory, { mode: 0o700 });
  writeFileSync(join(receiptDirectory, "acceptance-1.json"), JSON.stringify({
    schemaVersion: 1,
    commandId: "acceptance-1",
    state: "completed",
    exitCode: 0,
    startedAt: "2026-07-23T10:00:00.000Z",
    completedAt: "2026-07-23T10:00:01.000Z"
  }), { mode: 0o600 });
  const completed = await executor.execute(probe, policy);
  const observation = await runner.evaluate(
    plugin,
    "shell-command-completion",
    config,
    { ...context, attempt: 2 },
    completed
  );
  assert.equal(observation.terminal, "success");
  assert.equal("terminalKey" in observation, false);
  assert.deepEqual(observation.facts, {
    commandId: "acceptance-1",
    state: "completed",
    exitCode: 0,
    startedAt: "2026-07-23T10:00:00.000Z",
    completedAt: "2026-07-23T10:00:01.000Z"
  });
});
