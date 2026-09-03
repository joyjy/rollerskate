import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

interface GitDiffCommand {
  readonly output: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly stderrBytes: number;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly signal?: string;
  readonly stderr?: string;
}

interface GitDiffResult {
  readonly tool: "read_git_diff";
  readonly workspace: string;
  readonly paths: string[];
  readonly status: GitDiffCommand;
  readonly diff: GitDiffCommand;
}

interface GitExtensionModule {
  readonly GIT_WORKSPACE_ENV: string;
  readonly MAX_GIT_PATHS: number;
  readonly MAX_GIT_PATH_BYTES: number;
  readonly resolveWorkspace: (raw: string) => string;
  readonly validateGitPaths: (
    paths: unknown,
    workspace: string
  ) => { readonly ok: true; readonly paths: string[] } |
    { readonly ok: false; readonly error: string };
  readonly gitEnvironment: () => Record<string, string | undefined>;
  readonly gitBaseArgs: () => string[];
  readonly gitStatusArgs: (paths?: string[]) => string[];
  readonly gitDiffArgs: (paths?: string[]) => string[];
  readonly readGitDiff: (
    params: unknown,
    workspace: string,
    options?: { readonly maxOutputBytes?: number; readonly timeoutMilliseconds?: number }
  ) => Promise<GitDiffResult>;
  readonly default: (pi: { readonly registerTool: (definition: unknown) => void }) => void;
}

const gitExtension = await import(
  new URL("../resources/agents/pi-readonly-git.mjs", import.meta.url).href
) as GitExtensionModule;

test("pi readonly git validates optional path inputs fail-closed", () => {
  const workspace = mkdtempSync(join(tmpdir(), "rollerskate-git-path-"));
  try {
    assert.deepEqual(gitExtension.validateGitPaths(undefined, workspace),
      { ok: true, paths: [] });
    assert.deepEqual(gitExtension.validateGitPaths([], workspace),
      { ok: true, paths: [] });
    assert.deepEqual(gitExtension.validateGitPaths(["a.txt", "src/b.md"], workspace),
      { ok: true, paths: ["a.txt", "src/b.md"] });

    const absoluteSamples = process.platform === "win32"
      ? ["C:\\Windows\\system32", "C:/Windows"]
      : ["/etc/passwd", "/tmp/outside.txt"];
    for (const bad of [
      ...absoluteSamples,
      "../secret.txt",
      "a/../../secret.txt",
      "..",
      "--force",
      "-p",
      "a\0b"
    ]) {
      const result = gitExtension.validateGitPaths([bad], workspace);
      assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
    }

    const tooMany = Array.from(
      { length: gitExtension.MAX_GIT_PATHS + 1 },
      (_value, index) => `file-${index}.txt`
    );
    assert.equal(gitExtension.validateGitPaths(tooMany, workspace).ok, false);

    const tooLong = "a".repeat(gitExtension.MAX_GIT_PATH_BYTES + 1);
    assert.equal(gitExtension.validateGitPaths([tooLong], workspace).ok, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("pi readonly git resolves the workspace strictly", () => {
  const workspace = mkdtempSync(join(tmpdir(), "rollerskate-git-resolve-"));
  try {
    assert.equal(gitExtension.resolveWorkspace(workspace), realpathSync(workspace));
    assert.throws(() => gitExtension.resolveWorkspace(""), /workspace is missing/);
    assert.throws(() => gitExtension.resolveWorkspace("relative/path"),
      /must be absolute/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("pi readonly git ignores ambient Git repository and helper redirection", () => {
  const names = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_CONFIG_COUNT",
    "GIT_EXEC_PATH",
    "GIT_EXTERNAL_DIFF"
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = "/tmp/untrusted";
    const environment = gitExtension.gitEnvironment();
    for (const name of names) assert.equal(environment[name], undefined);
    assert.equal(environment.GIT_PAGER, "cat");
    assert.equal(environment.GIT_OPTIONAL_LOCKS, "0");
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("pi readonly git returns exact diff and status evidence against HEAD", async () => {
  const workspace = initGitRepo();
  try {
    commit(workspace, "a.txt", "line one\n");
    commit(workspace, "b.txt", "hello\n");

    writeFileSync(join(workspace, "a.txt"), "line one modified\n");
    writeFileSync(join(workspace, "c.txt"), "new staged file\n");
    execFileSync("git", ["add", "c.txt"], { cwd: workspace, encoding: "utf8" });
    writeFileSync(join(workspace, "d.txt"), "untracked\n");

    const result = await gitExtension.readGitDiff({}, workspace);
    const expectedDiff = git(workspace, gitExtension.gitDiffArgs());
    const expectedStatus = git(workspace, gitExtension.gitStatusArgs());

    assert.equal(result.tool, "read_git_diff");
    assert.deepEqual(result.paths, []);
    assert.equal(result.diff.output, expectedDiff);
    assert.equal(result.status.output, expectedStatus);
    assert.equal(result.diff.truncated, false);
    assert.equal(result.status.truncated, false);
    assert.equal(result.diff.exitCode, 0);
    assert.equal(result.status.exitCode, 0);
    assert.match(result.diff.output, /line one modified/);
    assert.match(result.status.output, / M a\.txt/);
    assert.match(result.status.output, /A {2}c\.txt/);
    assert.match(result.status.output, /\?\? d\.txt/);

    const limited = await gitExtension.readGitDiff({ paths: ["a.txt"] }, workspace);
    assert.equal(limited.diff.output, git(workspace, gitExtension.gitDiffArgs(["a.txt"])));
    assert.equal(limited.status.output,
      git(workspace, gitExtension.gitStatusArgs(["a.txt"])));
    assert.match(limited.diff.output, /line one modified/);
    assert.doesNotMatch(limited.diff.output, /new staged file/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("pi readonly git rejects escaping paths before spawning git", async () => {
  const workspace = initGitRepo();
  try {
    await assert.rejects(
      gitExtension.readGitDiff({ paths: ["../secret.txt"] }, workspace),
      /traverse upward/
    );
    await assert.rejects(
      gitExtension.readGitDiff({ paths: ["--force"] }, workspace),
      /look like options/
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("pi readonly git bounds output and reports deterministic truncation", async () => {
  const workspace = initGitRepo();
  try {
    const lines = Array.from({ length: 500 }, (_value, index) => `line ${index}`);
    commit(workspace, "big.txt", `${lines.join("\n")}\n`);
    writeFileSync(join(workspace, "big.txt"),
      `${lines.map((line) => `${line} changed`).join("\n")}\n`);

    const result = await gitExtension.readGitDiff({}, workspace, {
      maxOutputBytes: 256
    });
    assert.equal(result.diff.truncated, true);
    assert.ok(result.diff.bytes > 256);
    assert.ok(Buffer.byteLength(result.diff.output, "utf8") <= 256);
    assert.equal(result.status.truncated, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("pi readonly git bounds stderr and reports its truncation metadata", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "rollerskate-git-stderr-"));
  try {
    const result = await gitExtension.readGitDiff({}, workspace, {
      maxOutputBytes: 64
    });
    assert.notEqual(result.diff.exitCode, 0);
    assert.ok(result.diff.stderrBytes > 16);
    assert.equal(result.diff.stderrTruncated, true);
    assert.ok(Buffer.byteLength(result.diff.stderr ?? "", "utf8") <= 16);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("pi readonly git registers one dedicated read-only tool", () => {
  const workspace = mkdtempSync(join(tmpdir(), "rollerskate-git-tool-"));
  const previous = process.env[gitExtension.GIT_WORKSPACE_ENV];
  process.env[gitExtension.GIT_WORKSPACE_ENV] = workspace;
  try {
    const registered: Array<{
      readonly name: string;
      readonly label: string;
      readonly parameters: { readonly type: string;
        readonly additionalProperties: boolean };
      readonly execute: (toolCallId: string, params: unknown) => Promise<unknown>;
    }> = [];
    gitExtension.default({
      registerTool: (definition) => {
        registered.push(definition as (typeof registered)[number]);
      }
    });
    assert.equal(registered.length, 1);
    const tool = registered[0]!;
    assert.equal(tool.name, "read_git_diff");
    assert.equal(tool.parameters.type, "object");
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(typeof tool.execute, "function");
  } finally {
    if (previous === undefined) {
      delete process.env[gitExtension.GIT_WORKSPACE_ENV];
    } else {
      process.env[gitExtension.GIT_WORKSPACE_ENV] = previous;
    }
    rmSync(workspace, { recursive: true, force: true });
  }
});

function initGitRepo(): string {
  const workspace = mkdtempSync(join(tmpdir(), "rollerskate-git-repo-"));
  execFileSync("git", ["init"], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  execFileSync("git", ["config", "user.email", "test@example.com"],
    { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["config", "user.name", "Test User"],
    { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return workspace;
}

function commit(workspace: string, file: string, content: string): void {
  writeFileSync(join(workspace, file), content);
  execFileSync("git", ["add", file], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  execFileSync("git", ["commit", "-m", `add ${file}`], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
}

function git(workspace: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    env: gitExtension.gitEnvironment(),
    maxBuffer: 16 * 1024 * 1024
  });
}
