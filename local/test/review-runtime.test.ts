import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  createReviewArtifact,
  readReviewArtifact,
  reviewArtifactRef,
  writeReviewArtifact
} from "../src/capabilities/review/artifact-schema.js";
import { ReviewRuntime } from "../src/capabilities/review/runtime.js";
import { ReviewStore } from "../src/capabilities/review/store.js";
import {
  fileRevision,
  workspaceRevision
} from "../src/capabilities/review/workspace-revision.js";
import { newEventId, type AgentRequestEvent } from "../src/core/event/model.js";
import { RuntimeCycle } from "../src/core/runtime/cycle.js";
import {
  AgentHandler,
  DeliveryHandler,
  ResultHandler,
  type RuntimeAgentAdapter,
  type RuntimeEventHandler
} from "../src/core/runtime/handlers.js";
import type { RuntimeHandlerKind } from "../src/core/runtime/model.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { createReview } from "../src/application/review/control.js";
import { startRuntime } from "../src/bootstrap/runtime.js";

test("Review chain runs findings, bounded implementation and passed re-review", async () => {
  const fixture = setup(false);
  try {
    const result = await fixture.cycle.run("2026-07-24T01:00:00.000Z");
    assert.deepEqual(result.failures, []);
    const projection = fixture.reviews.requireProjection(fixture.rootEventId);
    assert.equal(projection.phase, "terminal");
    assert.equal(projection.terminalDecision, "passed");
    assert.equal(projection.reworkCount, 1);
    assert.equal(projection.cycleIndex, 1);
    const artifact = readReviewArtifact(fixture.artifactRef)!;
    assert.equal(artifact.findings.length, 1);
    assert.equal(artifact.findings[0]!.status, "resolved");
    assert.equal(artifact.findings[0]!.implementerReplies.length, 1);
    assert.match(readFileSync(fixture.implementationFile, "utf8"), /fixed/);
    const events = fixture.reviews.eventIds(fixture.rootEventId)
      .map((eventId) => fixture.runtime.event(eventId)!.type);
    assert.deepEqual(events, [
      "review.requested",
      "agent.request",
      "agent.result",
      "review.decision",
      "agent.request",
      "agent.result",
      "review.requested",
      "agent.request",
      "agent.result",
      "review.decision"
    ]);
    assert.equal(fixture.reviewer.providerSessions.length, 2);
    assert.equal(fixture.reviewer.providerSessions[0], undefined);
    assert.match(fixture.reviewer.providerSessions[1] ?? "", /^reviewer-session$/);
    assert.deepEqual(fixture.implementer.providerSessions, [undefined]);
    assert.deepEqual(
      new Set(fixture.selectedWorkspaces),
      new Set([fixture.reviewer.workspace])
    );
  } finally {
    fixture.close();
  }
});

test("Reviewer and Implementer may use the same adapter implementation but never share Session", async () => {
  const fixture = setup(true);
  try {
    await fixture.cycle.run("2026-07-24T01:00:00.000Z");
    const sessions = fixture.runtime.sessions();
    assert.equal(sessions.length, 2);
    assert.notEqual(sessions[0]!.sessionId, sessions[1]!.sessionId);
    assert.deepEqual(
      new Set(sessions.map((session) => session.agentId)),
      new Set(["reviewer", "implementer"])
    );
  } finally {
    fixture.close();
  }
});

test("unsupported structured result authority blocks before Agent invocation", async () => {
  const fixture = setup(false, false);
  try {
    const result = await fixture.cycle.run("2026-07-24T01:00:00.000Z");
    assert.deepEqual(result.failures, []);
    assert.equal(fixture.reviewer.calls, 0);
    assert.equal(
      fixture.reviews.requireProjection(fixture.rootEventId).phase,
      "terminal"
    );
    assert.match(
      fixture.reviews.requireProjection(fixture.rootEventId).terminalReason ?? "",
      /does not support ReviewerResult@1/
    );
  } finally {
    fixture.close();
  }
});

test("Reviewer findings cannot anchor outside workspace authority", async () => {
  const fixture = setup(false);
  try {
    fixture.reviewer.anchorRef = "/etc/hosts";
    const result = await fixture.cycle.run("2026-07-24T01:00:00.000Z");
    assert.deepEqual(result.failures, []);
    const projection = fixture.reviews.requireProjection(fixture.rootEventId);
    assert.equal(projection.phase, "terminal");
    assert.equal(projection.terminalDecision, "blocked");
    assert.match(projection.terminalReason ?? "", /outside workspace authority/);
    assert.equal(readReviewArtifact(fixture.artifactRef)!.findings.length, 0);
    assert.equal(fixture.implementer.calls, 0);
  } finally {
    fixture.close();
  }
});

test("real foreground loop completes a CLI-created Codex to Claude Code Review", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-review-real-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-review-real-runtime-"));
  const paths = runtimePaths(repo, runtimeDirectory);
  initializeRuntimeSchema(paths.database);
  bootstrapLocalFoundation(paths, "2026-07-24T00:00:00.000Z");
  git(paths.workspace, ["init"]);
  git(paths.workspace, ["config", "user.name", "Rollerskate Test"]);
  git(paths.workspace, ["config", "user.email", "test@example.invalid"]);
  const subject = join(paths.workspace, "plan.md");
  const implementation = join(paths.workspace, "implementation.txt");
  writeFileSync(subject, "# Acceptance\n\nImplementation must contain fixed.\n");
  writeFileSync(implementation, "pending\n");
  git(paths.workspace, ["add", "plan.md", "implementation.txt"]);
  git(paths.workspace, ["commit", "-m", "initial"]);
  const foundation = new LocalFoundationStore(paths.database);
  foundation.addAgent("reviewer", "codex", "2026-07-24T00:00:00.000Z");
  foundation.addAgent("implementer", "claude-code", "2026-07-24T00:00:00.000Z");
  foundation.close();
  const created = createReview(repo, {
    subjectRef: subject,
    reviewer: "reviewer",
    implementer: "implementer",
    reworkLimit: 1,
    requestId: "real-two-agent-smoke"
  }, runtimeDirectory, "2026-07-24T00:00:01.000Z");
  const executableRoot = mkdtempSync(join(tmpdir(), "rollerskate-review-real-agents-"));
  const codexLog = join(executableRoot, "codex.jsonl");
  const claudeLog = join(executableRoot, "claude.jsonl");
  const codex = join(executableRoot, "codex-fixture");
  const claude = join(executableRoot, "claude-fixture");
  writeFileSync(codex, codexFixture(codexLog));
  writeFileSync(claude, claudeCodeFixture(claudeLog));
  chmodSync(codex, 0o700);
  chmodSync(claude, 0o700);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    await startRuntime({
      repoRoot: repo,
      runtimeDirectory,
      codexExecutable: codex,
      claudeCodeExecutable: claude,
      environment: {},
      pollMilliseconds: 50,
      codexTimeoutMilliseconds: 2_000,
      output: {
        write(text) {
          if (!text.includes('"type":"runtime.cycle"')) return;
          const reviews = new ReviewStore(paths.database);
          try {
            if (reviews.requireProjection(created.rootEventId).phase === "terminal") {
              controller.abort();
            }
          } finally {
            reviews.close();
          }
        }
      }
    }, controller.signal);
    const reviews = new ReviewStore(paths.database);
    try {
      assert.equal(
        reviews.requireProjection(created.rootEventId).terminalDecision,
        "passed"
      );
    } finally {
      reviews.close();
    }
    assert.equal(readFileSync(implementation, "utf8"), "fixed\n");
    const codexInvocations = readFileSync(codexLog, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { args: string[] });
    const claudeInvocation = JSON.parse(readFileSync(claudeLog, "utf8")) as {
      args: string[];
    };
    assert.equal(codexInvocations.length, 2);
    assert.ok(codexInvocations.every((entry) => entry.args.includes("read-only")));
    assert.ok(claudeInvocation.args.includes("acceptEdits"));
  } finally {
    clearTimeout(timeout);
  }
});

interface Fixture {
  readonly runtime: RuntimeStore;
  readonly reviews: ReviewStore;
  readonly cycle: RuntimeCycle;
  readonly rootEventId: string;
  readonly artifactRef: string;
  readonly implementationFile: string;
  readonly reviewer: TestReviewAdapter;
  readonly implementer: TestReviewAdapter;
  readonly selectedWorkspaces: readonly (string | undefined)[];
  readonly close: () => void;
}

function setup(sameAdapter: boolean, supported = true): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rollerskate-review-runtime-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "Rollerskate Test"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  const subject = join(root, "plan.md");
  const implementationFile = join(root, "implementation.txt");
  writeFileSync(subject, "# Acceptance\n\nImplementation must contain fixed.\n");
  writeFileSync(implementationFile, "pending\n");
  git(root, ["add", "plan.md", "implementation.txt"]);
  git(root, ["commit", "-m", "initial"]);
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rollerskate-review-database-"));
  const database = join(runtimeRoot, "runtime.sqlite");
  const runtime = new RuntimeStore(database);
  const reviews = new ReviewStore(database);
  const rootEventId = newEventId();
  const artifactRef = reviewArtifactRef(subject);
  const artifact = createReviewArtifact({
    subjectRef: subject,
    subjectRevision: fileRevision(subject),
    rootReviewId: rootEventId
  });
  writeReviewArtifact(artifactRef, artifact);
  const implementationRevision = workspaceRevision(root).revision;
  reviews.create({
    eventId: rootEventId,
    requestId: "review-test",
    subject: {
      kind: "acceptance",
      ref: subject,
      revision: fileRevision(subject)
    },
    artifactRef,
    artifactRevision: artifact.artifactRevision,
    evidence: [{
      kind: "workspace",
      ref: realpathSync(root),
      revision: implementationRevision
    }],
    implementationRevision,
    reviewerAgentId: "reviewer",
    implementerAgentId: "implementer",
    reworkLimit: 1,
    createdAt: "2026-07-24T00:00:00.000Z"
  });
  const reviewer = new TestReviewAdapter({
    adapterId: sameAdapter ? "shared-test-adapter" : "reviewer-test-adapter",
    role: "reviewer",
    workspace: root,
    implementationFile,
    supported
  });
  const implementer = new TestReviewAdapter({
    adapterId: sameAdapter ? "shared-test-adapter" : "implementer-test-adapter",
    role: "implementer",
    workspace: root,
    implementationFile,
    supported
  });
  const adapters = new Map<string, RuntimeAgentAdapter>([
    ["reviewer", reviewer],
    ["implementer", implementer]
  ]);
  const reviewRuntime = new ReviewRuntime({
    store: reviews,
    runtime,
    adapterForAgent: (agentId) => adapters.get(agentId)
  });
  const selectedWorkspaces: Array<string | undefined> = [];
  const cycle = new RuntimeCycle({
    store: runtime,
    handlers: new Map<RuntimeHandlerKind, RuntimeEventHandler>([
      ["agent", new AgentHandler({
        store: runtime,
        adapterForAgent(agentId, workspace) {
          selectedWorkspaces.push(workspace);
          return adapters.get(agentId);
        }
      })],
      ["result", new ResultHandler(runtime, reviewRuntime)],
      ["review", reviewRuntime]
    ]),
    deliveryHandler: new DeliveryHandler({ store: runtime, adapters: new Map() })
  });
  return {
    runtime,
    reviews,
    cycle,
    rootEventId,
    artifactRef,
    implementationFile,
    reviewer,
    implementer,
    selectedWorkspaces,
    close() {
      reviews.close();
      runtime.close();
    }
  };
}

class TestReviewAdapter implements RuntimeAgentAdapter {
  public readonly adapterId: string;
  public readonly workspace: string;
  public readonly reviewCapabilities;
  public readonly providerSessions: Array<string | undefined> = [];
  public anchorRef: string;
  public calls = 0;
  readonly #implementationFile: string;
  readonly #role: "reviewer" | "implementer";

  public constructor(options: {
    readonly adapterId: string;
    readonly role: "reviewer" | "implementer";
    readonly workspace: string;
    readonly implementationFile: string;
    readonly supported: boolean;
  }) {
    this.adapterId = options.adapterId;
    this.workspace = realpathSync(options.workspace);
    this.anchorRef = options.implementationFile;
    this.#role = options.role;
    this.#implementationFile = options.implementationFile;
    this.reviewCapabilities = options.supported
      ? {
          resultSchemas: ["ReviewerResult@1", "ImplementerResult@1"] as const,
          workspaceAccess: ["read", "write"] as const
        }
      : {
          resultSchemas: [] as const,
          workspaceAccess: [] as const
        };
  }

  public async invoke(input: {
    readonly event: AgentRequestEvent;
    readonly providerSessionId?: string;
  }): Promise<{
    readonly providerSessionId: string;
    readonly outcome: { readonly kind: "message"; readonly body: string };
  }> {
    this.calls += 1;
    this.providerSessions.push(input.providerSessionId);
    const invocation = input.event.reviewInvocation!;
    if (this.#role === "reviewer") {
      const artifact = readReviewArtifact(invocation.artifactRef)!;
      const first = invocation.cycleIndex === 0;
      return {
        providerSessionId: "reviewer-session",
        outcome: {
          kind: "message",
          body: JSON.stringify({
            schemaVersion: "ReviewerResult@1",
            decision: first ? "findings" : "passed",
            boundedSummary: first ? "Implementation is pending." : "Acceptance passes.",
            revisionsRead: {
              subject: invocation.subject.revision,
              artifact: invocation.artifactRevision,
              evidence: invocation.evidence
            },
            artifactMutation: {
              addFindings: first
                ? [{
                    anchor: { ref: this.anchorRef, line: 1 },
                    severity: "high",
                    summary: "Implementation must contain fixed."
                  }]
                : [],
              resolveFindingIds: first
                ? []
                : artifact.findings
                    .filter((finding) => finding.status === "open")
                    .map((finding) => finding.findingId)
            }
          })
        }
      };
    }
    writeFileSync(this.#implementationFile, "fixed\n");
    const artifact = readReviewArtifact(invocation.artifactRef)!;
    return {
      providerSessionId: "implementer-session",
      outcome: {
        kind: "message",
        body: JSON.stringify({
          schemaVersion: "ImplementerResult@1",
          boundedSummary: "Implemented the open finding.",
          findingReplies: artifact.findings
            .filter((finding) => finding.status === "open")
            .map((finding) => ({
              findingId: finding.findingId,
              summary: "Updated implementation.txt.",
              evidenceRefs: [this.#implementationFile]
            })),
          implementationRevision: workspaceRevision(this.workspace).revision
        })
      }
    };
  }
}

function git(cwd: string, arguments_: readonly string[]): void {
  const result = spawnSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) throw new Error(result.stderr);
}

function codexFixture(log: string): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input }) + "\\n");
  const workspace = args[args.indexOf("-C") + 1];
  const artifactPath = fs.readdirSync(workspace)
    .filter((name) => name.endsWith(".review.yaml"))
    .map((name) => path.join(workspace, name))[0];
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const subjectRevision = input.match(/Subject revision: (.+)/)[1];
  const artifactRevision = input.match(/Artifact revision: (.+)/)[1];
  const implementationRevision = input.match(/Implementation revision: (.+)/)[1];
  const first = artifact.findings.length === 0;
  const result = {
    schemaVersion: "ReviewerResult@1",
    decision: first ? "findings" : "passed",
    boundedSummary: first ? "Implementation is pending." : "Acceptance passes.",
    revisionsRead: {
      subject: subjectRevision,
      artifact: artifactRevision,
      evidence: [{
        kind: "workspace",
        ref: workspace,
        revision: implementationRevision
      }]
    },
    artifactMutation: {
      addFindings: first ? [{
        anchor: { ref: path.join(workspace, "implementation.txt"), line: 1 },
        severity: "high",
        summary: "Implementation must contain fixed."
      }] : [],
      resolveFindingIds: first ? [] : artifact.findings
        .filter((finding) => finding.status === "open")
        .map((finding) => finding.findingId)
    }
  };
  process.stdout.write([
    JSON.stringify({ type: "thread.started", thread_id: "reviewer-provider-session" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(result) }
    })
  ].join("\\n") + "\\n");
});
`;
}

function claudeCodeFixture(log: string): string {
  return `#!${process.execPath}
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const child = require("node:child_process");
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({
    args: process.argv.slice(2),
    input
  }));
  const workspace = process.cwd();
  fs.writeFileSync(path.join(workspace, "implementation.txt"), "fixed\\n");
  child.spawnSync("git", ["add", "implementation.txt"], { cwd: workspace });
  child.spawnSync("git", ["commit", "-m", "implement finding"], { cwd: workspace });
  const head = child.spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    encoding: "utf8"
  }).stdout.trim();
  const base = {
    schemaVersion: "workspace-revision-v1",
    revision: "",
    repoIdentity: fs.realpathSync(workspace),
    head,
    clean: true
  };
  const implementationRevision = "wrk1_" +
    crypto.createHash("sha256").update(JSON.stringify(base)).digest("hex");
  const artifactPath = fs.readdirSync(workspace)
    .filter((name) => name.endsWith(".review.yaml"))
    .map((name) => path.join(workspace, name))[0];
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const result = {
    schemaVersion: "ImplementerResult@1",
    boundedSummary: "Implemented the open finding.",
    findingReplies: artifact.findings
      .filter((finding) => finding.status === "open")
      .map((finding) => ({
        findingId: finding.findingId,
        summary: "Updated implementation.txt.",
        evidenceRefs: [path.join(workspace, "implementation.txt")]
      })),
    implementationRevision
  };
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify(result),
    session_id: "implementer-provider-session"
  }));
});
`;
}
