import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export interface WorkspaceRevision {
  readonly schemaVersion: "workspace-revision-v1";
  readonly revision: string;
  readonly repoIdentity: string;
  readonly head: string;
  readonly clean: boolean;
  readonly trackedDiffHash?: string;
  readonly untrackedManifest?: readonly {
    readonly path: string;
    readonly contentHash: string;
  }[];
}

export interface WorkspaceRevisionOptions {
  readonly trackedExcludes?: readonly string[];
  readonly ignoreUntracked?: (path: string) => boolean;
}

export function fileRevision(pathInput: string): string {
  if (!isAbsolute(pathInput)) throw new Error("file path must be absolute");
  const path = realpathSync(pathInput);
  const metadata = lstatSync(path);
  if (!metadata.isFile()) throw new Error(`review subject is not a file: ${path}`);
  if (metadata.size > MAX_SUBJECT_BYTES) {
    throw new Error(`review subject exceeds ${MAX_SUBJECT_BYTES} bytes`);
  }
  return `file1_${sha256(readFileSync(path))}`;
}

const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SUBJECT_BYTES = 16 * 1024 * 1024;

export function workspaceRevision(
  workspaceInput: string,
  options: WorkspaceRevisionOptions = {}
): WorkspaceRevision {
  if (!isAbsolute(workspaceInput)) throw new Error("workspace must be an absolute path");
  const workspace = realpathSync(workspaceInput);
  const root = realpathSync(git(workspace, ["rev-parse", "--show-toplevel"]).trim());
  const relativeWorkspace = relative(root, workspace);
  if (relativeWorkspace.startsWith(`..${sep}`) || relativeWorkspace === "..") {
    throw new Error("workspace is outside its Git repository");
  }
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const tracked = Buffer.concat([
    gitBuffer(root, [
      "diff", "--binary", "--no-ext-diff", "--",
      ".",
      ...(options.trackedExcludes ?? []).map((path) => `:(exclude)${path}`)
    ]),
    gitBuffer(root, [
      "diff", "--cached", "--binary", "--no-ext-diff", "--",
      ".",
      ...(options.trackedExcludes ?? []).map((path) => `:(exclude)${path}`)
    ])
  ]);
  const untrackedPaths = gitBuffer(
    root,
    ["ls-files", "--others", "--exclude-standard", "-z"]
  ).toString("utf8").split("\0").filter(Boolean)
    .filter((path) => options.ignoreUntracked?.(path) !== true)
    .sort();
  if (tracked.length === 0 && untrackedPaths.length === 0) {
    return finalize({
      schemaVersion: "workspace-revision-v1",
      revision: "",
      repoIdentity: root,
      head,
      clean: true
    });
  }
  const untrackedManifest = untrackedPaths.map((path) => {
    const absolute = resolve(root, path);
    const lexical = relative(root, absolute);
    if (lexical.startsWith(`..${sep}`) || lexical === ".." || lstatSync(absolute).isSymbolicLink()) {
      throw new Error(`untracked path is outside workspace authority: ${path}`);
    }
    const content = readFileSync(absolute);
    if (content.length > MAX_UNTRACKED_FILE_BYTES) {
      throw new Error(`untracked file exceeds ${MAX_UNTRACKED_FILE_BYTES} bytes: ${path}`);
    }
    return {
      path,
      contentHash: sha256(content)
    };
  });
  return finalize({
    schemaVersion: "workspace-revision-v1",
    revision: "",
    repoIdentity: root,
    head,
    clean: false,
    trackedDiffHash: sha256(tracked),
    untrackedManifest
  });
}

function finalize(revision: WorkspaceRevision): WorkspaceRevision {
  return {
    ...revision,
    revision: `wrk1_${sha256(Buffer.from(JSON.stringify({
      ...revision,
      revision: ""
    })))}`
  };
}

function git(cwd: string, arguments_: readonly string[]): string {
  return gitBuffer(cwd, arguments_).toString("utf8");
}

function gitBuffer(cwd: string, arguments_: readonly string[]): Buffer {
  const result = spawnSync("git", arguments_, {
    cwd,
    shell: false,
    encoding: "buffer",
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${arguments_.join(" ")} failed: ${result.stderr.toString("utf8").trim()}`
    );
  }
  return result.stdout;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
