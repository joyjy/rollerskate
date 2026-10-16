import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, readdirSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findWorkspaces, inspectGitWorkspace, workspaceGit } from "../src/application/workspace/discovery.js";
import { forkWorkspace } from "../src/application/workspace/control.js";

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "rs-workspace-test-")));
  const root = join(directory, "sample"); mkdirSync(root);
  workspaceGit(root, ["init", "-b", "trunk"]);
  workspaceGit(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base"]);
  const runtime = join(directory, "runtime"); mkdirSync(runtime);
  writeFileSync(join(runtime, "workspace-discovery.json"), JSON.stringify({schemaVersion:1,roots:[directory],registered:[]}));
  return {directory,root,runtime};
}

test("discovery reports ambiguity and never assumes the current or initial branch is default", () => {
  const f = fixture();
  try {
    assert.equal(inspectGitWorkspace(f.root).defaultBranch, null);
    assert.match(inspectGitWorkspace(f.root).forkBlocker!, /unknown/u);
    workspaceGit(f.root, ["config", "rollerskate.defaultBranch", "trunk"]);
    const result = findWorkspaces(f.root, {query:"sample"}, f.runtime);
    assert.equal(result.items.length,1);
    assert.equal(result.items[0]!.defaultBranch,"trunk");
    assert.throws(() => inspectGitWorkspace(f.directory));
  } finally { rmSync(f.directory,{recursive:true,force:true}); }
});

test("Fork uses default commit, preserves dirty source and returns the same receipt across retries", () => {
  const f = fixture();
  try {
    workspaceGit(f.root, ["config", "rollerskate.defaultBranch", "trunk"]);
    const base = workspaceGit(f.root,["rev-parse","HEAD"]);
    workspaceGit(f.root,["checkout","-b","working"]);
    workspaceGit(f.root,["-c","user.name=Test","-c","user.email=test@example.invalid","commit","--allow-empty","-m","working"]);
    writeFileSync(join(f.root,"dirty.txt"),"keep me");
    const input = {path:f.root,token:inspectGitWorkspace(f.root).token,purpose:"feature",requestId:"same-request"};
    const first = forkWorkspace(f.root,input,"proposal:fixture",f.runtime);
    assert.equal(first.baseSha,base);
    assert.equal(workspaceGit(first.root,["rev-parse","HEAD"]),base);
    assert.equal(readFileSync(join(f.root,"dirty.txt"),"utf8"),"keep me");
    assert.deepEqual(forkWorkspace(f.root,input,"proposal:fixture",f.runtime),first);
    const receiptDirectory=join(f.runtime,"workspace-forks",readdirSync(join(f.runtime,"workspace-forks"))[0]!);
    unlinkSync(join(receiptDirectory,"result.json")); // Simulate interruption after Git success.
    assert.deepEqual(forkWorkspace(f.root,input,"proposal:fixture",f.runtime),first);

    assert.throws(()=>forkWorkspace(f.root,{...input,purpose:"different"},"proposal:fixture",f.runtime),/different inputs/u);
    assert.throws(()=>forkWorkspace(f.root,{...input,requestId:"another"},"proposal:fixture",f.runtime),/already exists/u);
  } finally { rmSync(f.directory,{recursive:true,force:true}); }
});

test("stale default commit and absent default prevent a Fork before the Git effect", () => {
  const f=fixture();
  try {
    let input={path:f.root,token:inspectGitWorkspace(f.root).token,purpose:"feature",requestId:"one"};
    assert.throws(()=>forkWorkspace(f.root,input,"proposal:x",f.runtime),/unknown/u);
    workspaceGit(f.root,["config","rollerskate.defaultBranch","trunk"]);
    input={...input,token:inspectGitWorkspace(f.root).token};
    workspaceGit(f.root,["-c","user.name=Test","-c","user.email=test@example.invalid","commit","--allow-empty","-m","changed"]);
    assert.throws(()=>forkWorkspace(f.root,input,"proposal:x",f.runtime),/changed/u);
  } finally { rmSync(f.directory,{recursive:true,force:true}); }
});

test("a locally established remote HEAD is evidence even when working on another branch", () => {
  const f=fixture();
  try {
    workspaceGit(f.root,["update-ref","refs/remotes/upstream/trunk","HEAD"]);
    workspaceGit(f.root,["symbolic-ref","refs/remotes/upstream/HEAD","refs/remotes/upstream/trunk"]);
    assert.equal(inspectGitWorkspace(f.root).defaultBranch,"trunk");
    workspaceGit(f.root,["update-ref","refs/remotes/other/trunk","HEAD"]);
    workspaceGit(f.root,["symbolic-ref","refs/remotes/other/HEAD","refs/remotes/other/trunk"]);
    assert.match(inspectGitWorkspace(f.root).forkBlocker!,/Multiple/u);
  } finally { rmSync(f.directory,{recursive:true,force:true}); }
});
