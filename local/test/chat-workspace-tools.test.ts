import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { addLocalAgent } from "../src/application/agent/control.js";
import { postLocalChatMessage } from "../src/application/chat/control.js";
import { callChatTool, createChatToolContext, chatToolCapability, parseChatToolRequest } from "../src/application/chat/tool-policy.js";
import { inspectGitWorkspace, workspaceGit } from "../src/application/workspace/discovery.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { chatPromptResourceId } from "../src/core/chat/model.js";

test("Chat Fork requires exact Owner command and active dispatch; shared manifests expose both tools",()=>{
  const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),"../../..");
  const runtimeDirectory=realpathSync(mkdtempSync(join(tmpdir(),"rs-chat-workspace-")));
  const root=join(runtimeDirectory,"source");mkdirSync(root);
  workspaceGit(root,["init","-b","trunk"]);
  workspaceGit(root,["config","rollerskate.defaultBranch","trunk"]);
  workspaceGit(root,["-c","user.name=Test","-c","user.email=test@example.invalid","commit","--allow-empty","-m","base"]);
  const agent=addLocalAgent(repoRoot,"alice","codex",{runtimeDirectory});
  const runtime=new RuntimeStore(join(runtimeDirectory,"runtime.db"));
  const at=()=>new Date().toISOString();
  function dispatch(body:string){
    const message=postLocalChatMessage(repoRoot,body,{runtimeDirectory}).message;
    const execution=runtime.claimDueExecutions(100,at()).find(item=>item.eventId===message.eventId)!;
    const event=runtime.admitChatAttention(execution.executionId,[{plan:{agentId:agent.principalId,handle:agent.handle,outcome:"dispatch",reason:"direct-mention",
      presenceSnapshot:{global:{scope:"global",mode:"available",wakeKeywords:[]},topic:{scope:"topic",mode:"available",wakeKeywords:[]}}},prompt:"fixture",promptResourceId:chatPromptResourceId}],at())[0]!;
    runtime.claimDueExecutions(100,at());
    return createChatToolContext({repoRoot,runtimeDirectory,dispatchEventId:event.eventId});
  }
  try {
    const input={path:root,token:inspectGitWorkspace(root).token,purpose:"tool",requestId:"same"};
    const denied=dispatch(`@alice Do not Fork Workspace ${root}`);
    assert.equal((callChatTool(denied,"fork_workspace",input) as {status:string}).status,"needs_authorization");
    const found=callChatTool(denied,"find_workspaces",{path:root}) as {items:Array<{root:string}>};
    assert.equal(found.items[0]!.root,root);
    const allowed=dispatch(`@alice Fork Workspace ${root}`);
    const result=callChatTool(allowed,"fork_workspace",input) as {root:string};
    assert.equal(result.root,`${root}-wt-tool`);
    assert.deepEqual(callChatTool(allowed,"fork_workspace",input),result);
    assert.throws(()=>callChatTool(createChatToolContext({repoRoot,runtimeDirectory}),"fork_workspace",input),/running Host dispatch/);
    assert.ok(chatToolCapability("tools").tools.some(tool=>tool==="find_workspaces"));
    assert.ok(chatToolCapability("tools").tools.some(tool=>tool==="fork_workspace"));
    assert.equal(parseChatToolRequest(JSON.stringify({schema:"ChatToolRequest@1",tool:"find_workspaces",arguments:{query:"source"}}))?.tool,"find_workspaces");
  } finally {runtime.close();rmSync(runtimeDirectory,{recursive:true,force:true});}
});
