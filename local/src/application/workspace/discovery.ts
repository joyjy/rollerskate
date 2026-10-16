import { createHash } from "node:crypto";
import { existsSync, opendirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { runtimePaths } from "../../infrastructure/runtime/config.js";

export interface WorkspaceCandidate {
  readonly ref: string;
  readonly root: string;
  readonly branch: string | null;
  readonly defaultBranch: string | null;
  readonly defaultRef: string | null;
  readonly baseSha: string | null;
  readonly defaultSource: string | null;
  readonly forkBlocker: string | null;
  readonly token: string;
}

export function workspaceGit(root: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 262_144,
    stdio: ["ignore", "pipe", "pipe"], env: {...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0"}
  }).trim();
}
function optionalGit(root: string, args: readonly string[]): string | null {
  try { return workspaceGit(root, args) || null; } catch { return null; }
}

/** Reads Git metadata only. Never fetches, guesses a branch name or inspects file contents. */
export function inspectGitWorkspace(path: string): WorkspaceCandidate {
  if (!isAbsolute(path) || path.length > 4096) throw new Error("Workspace must be an absolute Git root");
  const root = realpathSync(path);
  if (!statSync(root).isDirectory() || realpathSync(workspaceGit(root, ["rev-parse", "--show-toplevel"])) !== root) {
    throw new Error("Workspace must be an exact Git root");
  }
  const branch = optionalGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const configured = optionalGit(root, ["config", "--get", "rollerskate.defaultBranch"]);
  let defaultRef: string | null = null;
  let defaultBranch: string | null = null;
  let defaultSource: string | null = null;
  let forkBlocker: string | null = null;
  if (configured !== null) {
    try { workspaceGit(root, ["check-ref-format", `refs/heads/${configured}`]); }
    catch { throw new Error("Configured default branch is invalid"); }
    defaultRef = `refs/heads/${configured}`;
    defaultBranch = configured;
    defaultSource = "git config rollerskate.defaultBranch";
  } else {
    const heads = (optionalGit(root, ["for-each-ref", "--format=%(refname) %(symref)", "refs/remotes/"]) ?? "")
      .split("\n").map(line => line.split(" ")).filter(([ref, target]) => ref?.endsWith("/HEAD") && target);
    if (heads.length === 1) {
      defaultRef = heads[0]![1]!;
      defaultBranch = defaultRef.replace(/^refs\/remotes\/[^/]+\//u, "");
      defaultSource = heads[0]![0]!;
    } else forkBlocker = heads.length > 1
      ? "Multiple remote HEADs; configure rollerskate.defaultBranch explicitly"
      : "Default branch is unknown; configure rollerskate.defaultBranch or establish a remote HEAD";
  }
  const baseSha = defaultRef === null ? null : optionalGit(root, ["rev-parse", "--verify", `${defaultRef}^{commit}`]);
  if (baseSha === null && forkBlocker === null) forkBlocker = "Default branch has no locally available commit";
  const value = {ref: pathToFileURL(root).href, root, branch, defaultBranch, defaultRef, baseSha, defaultSource, forkBlocker};
  return {...value, token: createHash("sha256").update(JSON.stringify(value)).digest("hex")};
}

export function findWorkspaces(repoRoot: string, input: {query?: string; path?: string}, runtimeDirectory?: string) {
  if (input.path !== undefined) return {schema: "WorkspaceCandidates@1" as const, items: [inspectGitWorkspace(input.path)], truncated: false};
  const query = input.query?.trim().toLowerCase() ?? "";
  if (!query || query.length > 120) throw new Error("Workspace query must contain 1–120 characters");
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const configPath = join(paths.runtimeDirectory, "workspace-discovery.json");
  let roots = [join(homedir(), "Projects")];
  let registered = [repoRoot, paths.workspace];
  if (existsSync(configPath)) {
    if (statSync(configPath).size > 16_384) throw new Error("Workspace discovery configuration is too large");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (config.schemaVersion !== 1 || ![config.roots, config.registered].every(value =>
      Array.isArray(value) && value.length <= 32 && value.every(path => typeof path === "string" && isAbsolute(path)))) {
      throw new Error("Invalid workspace-discovery.json");
    }
    roots = config.roots; registered = [...registered, ...config.registered];
  }
  const candidates = new Set(registered.filter(path => basename(path).toLowerCase().includes(query)));
  let truncated = false;
  for (const configuredRoot of roots) {
    if (!existsSync(configuredRoot)) continue;
    const root = realpathSync(configuredRoot);
    if (root === "/" || root === homedir()) throw new Error("Workspace discovery root must be a controlled project directory");
    const directory = opendirSync(root);
    try {
      let entry; let count = 0;
      while ((entry = directory.readSync()) !== null) {
        if (++count > 500) { truncated = true; break; }
        if (!entry.isDirectory() || !entry.name.toLowerCase().includes(query)) continue;
        const path = realpathSync(join(root, entry.name));
        if (!relative(root, path).startsWith("..")) candidates.add(path);
      }
    } finally { directory.closeSync(); }
  }
  const items: WorkspaceCandidate[] = [];
  let inspected = 0;
  for (const path of [...candidates].sort()) {
    if (items.length === 20 || inspected++ === 40) { truncated = true; break; }
    try { const item = inspectGitWorkspace(path); if (!items.some(existing => existing.root === item.root)) items.push(item); } catch { /* Non-Git directories are not candidates. */ }
  }
  return {schema: "WorkspaceCandidates@1" as const, items, truncated};
}
