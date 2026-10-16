import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { workspaceForkStore } from "../../infrastructure/files/workspace-fork-store.js";
import { inspectGitWorkspace, workspaceGit } from "./discovery.js";

export interface ForkWorkspaceInput {
  readonly path: string;
  readonly token: string;
  readonly purpose: string;
  readonly requestId: string;
}
export interface WorkspaceForkResult {
  readonly schema: "WorkspaceFork@1";
  readonly requestId: string;
  readonly authority: string;
  readonly sourceRoot: string;
  readonly defaultBranch: string;
  readonly baseSha: string;
  readonly root: string;
  readonly branch: string;
}

/** The caller supplies verified Owner/proposal authority, never model-authored identity. */
export function forkWorkspace(repoRoot: string, input: ForkWorkspaceInput, authority: string, runtimeDirectory?: string): WorkspaceForkResult {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/u.test(input.purpose) ||
    !/^[A-Za-z0-9_-]{1,100}$/u.test(input.requestId) || !/^[a-f0-9]{64}$/u.test(input.token)) {
    throw new Error("Fork requires a purpose slug, stable requestId and inspected workspace token");
  }
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const store = workspaceForkStore(paths.runtimeDirectory, authority, input.requestId);
  const normalized = {path:input.path,token:input.token,purpose:input.purpose,requestId:input.requestId};
  const prior = store.read("request");
  if (prior !== undefined) {
    if (!record(prior) || prior.schema !== "WorkspaceForkRequest@1" ||
      JSON.stringify(prior.input) !== JSON.stringify(normalized) || prior.authority !== authority) {
      throw new Error("Fork requestId already belongs to different inputs");
    }
    const planned = parseForkResult(prior.result, authority, input.requestId);
    const result = store.read("result");
    if (result !== undefined) return parseForkResult(result,authority,input.requestId);
    // A crash after Git success may lose only the receipt. Reconcile exact metadata; never replay Git.
    if (!matchesFork(planned)) throw new Error(`Fork outcome is unknown; inspect ${planned.root}, branch ${planned.branch}, base ${planned.baseSha}. Retry the same request only.`);
    try { store.write("result",planned); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return parseForkResult(store.read("result"),authority,input.requestId);
  }
  const source = inspectGitWorkspace(input.path);
  if (source.root !== input.path || source.token !== input.token) throw new Error("Workspace changed; inspect it again before Fork");
  if (source.forkBlocker || !source.defaultBranch || !source.baseSha) throw new Error(source.forkBlocker ?? "Default branch is unknown");
  const branch = `rs/${input.purpose}`;
  const root = join(dirname(source.root), `${basename(source.root)}-wt-${input.purpose}`);
  if (existsSync(root)) throw new Error(`Fork target already exists: ${root}`);
  const branches = workspaceGit(source.root, ["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`]);
  if (branches) throw new Error(`Fork branch already exists: ${branch}`);
  if (!store.reserve()) throw new Error("Fork request is in progress or unknown; retry the same request to read its result");
  const result: WorkspaceForkResult = {schema: "WorkspaceFork@1", requestId: input.requestId, authority,
    sourceRoot: source.root, defaultBranch: source.defaultBranch, baseSha: source.baseSha, root, branch};
  // Persist source, default/base and destination before the external Git effect.
  store.write("request", {schema:"WorkspaceForkRequest@1",input:normalized,authority,result});
  workspaceGit(source.root, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", branch, "--", root, source.baseSha]);
  if (!matchesFork(result)) throw new Error("Fork identity verification failed");
  try { store.write("result", result); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return parseForkResult(store.read("result"),authority,input.requestId);
}
function record(value: unknown): value is Record<string,unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseForkResult(value: unknown, authority: string, requestId: string): WorkspaceForkResult {
  if (!record(value) || value.schema !== "WorkspaceFork@1" || value.authority !== authority || value.requestId !== requestId ||
    !["sourceRoot","defaultBranch","baseSha","root","branch"].every(key=>typeof value[key]==="string" && (value[key] as string).length>0) ||
    !/^[a-f0-9]{40,64}$/.test(String(value.baseSha))) throw new Error("Invalid workspace Fork receipt");
  return value as unknown as WorkspaceForkResult;
}
function matchesFork(result: WorkspaceForkResult): boolean {
  try {
    return workspaceGit(result.root,["rev-parse","--path-format=absolute","--git-common-dir"]) === workspaceGit(result.sourceRoot,["rev-parse","--path-format=absolute","--git-common-dir"]) &&
      workspaceGit(result.root,["rev-parse","HEAD"]) === result.baseSha &&
      workspaceGit(result.root,["symbolic-ref","--short","HEAD"]) === result.branch;
  } catch { return false; }
}
