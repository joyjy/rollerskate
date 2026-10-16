<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { boundedError, requestJson } from "@/api/client";
import { workspaceCandidatesSchema, workspaceForkSchema, type WorkspaceCandidate } from "@/api/schema/workspace";
const props=defineProps<{path:string;initialQuery?:string;sourceRevision:string;eventId:string;dispatchId:string;disabled:boolean}>();
const emit=defineEmits<{select:[path:string];forked:[path:string];busy:[value:boolean]}>();
const query=ref(props.path || props.initialQuery || "");
const candidates=ref<WorkspaceCandidate[]>([]);
const searched=ref(false);
const truncated=ref(false);
const operation=ref<"find"|"fork">();
const error=ref("");
const purpose=ref("");
const result=ref<{root:string;branch:string;baseSha:string}|null>(null);
const selected=computed(()=>candidates.value.find(item=>item.root===props.path));
const locked=computed(()=>props.disabled || operation.value!==undefined);
const forkInput=ref<{path:string;token:string;purpose:string;requestId:string}|null>(null);
const storageKey=`rs-workspace-fork:${props.eventId}:${props.dispatchId}`;
try {
  const saved=sessionStorage.getItem(storageKey);
  if(saved) {
    const input=JSON.parse(saved);
    if(typeof input.path==="string" && typeof input.token==="string" && typeof input.purpose==="string" && typeof input.requestId==="string") forkInput.value=input;
  }
} catch { /* The server receipt still owns idempotency if browser storage is unavailable. */ }
async function find(path?:string) {
  if(locked.value) return;
  operation.value="find";emit("busy",true);error.value="";
  try {
    const receipt=await requestJson("/api/chat/workspaces/find",workspaceCandidatesSchema,{method:"POST",
      headers:{"Content-Type":"application/json","X-Rollerskate-Request":"console"},body:JSON.stringify(path?{path}:query.value.trim().startsWith('/')?{path:query.value.trim()}:{query:query.value.trim()})});
    candidates.value=receipt.items;searched.value=true;truncated.value=receipt.truncated;
    if(receipt.items.length===1) emit("select",receipt.items[0]!.root);
  } catch(reason) {error.value=boundedError(reason);}
  finally {operation.value=undefined;emit("busy",false);}
}
function editQuery(value:string) {
  query.value=value;candidates.value=[];searched.value=false;
  emit('select',value.trim().startsWith('/')?value.trim():'');
}
onMounted(()=>{if(query.value.trim()) void find();});
async function fork(retry=false) {
  if(locked.value) return;
  const candidate=selected.value;
  if(!retry) {
    if(!candidate || candidate.forkBlocker || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(purpose.value)) return;
    forkInput.value={path:candidate.root,token:candidate.token,purpose:purpose.value,requestId:forkInput.value?.requestId ?? crypto.randomUUID()};
  }
  const input=forkInput.value;
  if(!input) return;
  operation.value="fork";emit("busy",true);error.value="";
  try {
    sessionStorage.setItem(storageKey,JSON.stringify(input));
    const receipt=await requestJson(`/api/chat/proposals/${encodeURIComponent(props.eventId)}/${encodeURIComponent(props.dispatchId)}/fork`,workspaceForkSchema,
      {method:"POST",headers:{"Content-Type":"application/json","X-Rollerskate-Request":"console"},body:JSON.stringify({...input,revision:props.sourceRevision})});
    result.value=receipt;
    emit("select",receipt.root);
    // Release before asking the existing parent preflight flow to continue.
    operation.value=undefined;emit("busy",false);emit("forked",receipt.root);
  } catch(reason) {error.value=boundedError(reason);}
  finally {operation.value=undefined;emit("busy",false);}
}
</script>
<template>
  <div class="workspace-picker">
    <div class="search-row">
      <label>Workspace
        <input :value="query" aria-label="Workspace project name" placeholder="Project name or absolute Git path" :disabled="locked" maxlength="4096" @input="editQuery(($event.target as HTMLInputElement).value)" @keyup.enter="find()" />
      </label>
      <button type="button" :disabled="locked || !query.trim()" @click="find()">{{ operation==='find'?'Finding…':'Find workspaces' }}</button>
    </div>
    <label v-if="candidates.length">Workspace candidates
      <select :value="path" :disabled="locked" aria-label="Workspace candidates" @change="emit('select',($event.target as HTMLSelectElement).value)">
        <option value="" disabled>Select a workspace</option>
        <option v-for="item in candidates" :key="item.root" :value="item.root">{{ item.root }} · {{ item.branch ?? 'detached' }}</option>
      </select>
    </label>
    <span v-if="searched && !candidates.length" role="status">No matching Git workspaces. Enter an absolute Git path or try another project name.</span>
    <span v-if="truncated">Results are limited. Refine the project name.</span>
    <slot />
    <details v-if="selected" class="fork-preview">
      <summary>Fork a separate workspace</summary>
      <span>Default branch: <strong>{{ selected.defaultBranch ?? 'Unknown' }}</strong></span>
      <code v-if="selected.baseSha">{{ selected.baseSha }}</code>
      <span v-if="selected.forkBlocker" role="status">Fork unavailable: {{ selected.forkBlocker }}. Use workspace does not require a default branch.</span>
      <template v-else>
        <label>Fork purpose
          <input v-model="purpose" aria-label="Fork purpose" placeholder="feature-name" maxlength="48" :disabled="locked" />
        </label>
        <span v-if="purpose">Creates a sibling worktree ending in -wt-{{ purpose }} on branch rs/{{ purpose }}. Source edits stay in place.</span>
        <button type="button" :disabled="locked || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(purpose)" @click="fork()">{{ operation==='fork'?'Forking…':'Fork Workspace' }}</button>
      </template>
    </details>
    <div v-if="result" class="fork-result" role="status">
      <strong>Workspace created</strong><span>{{ result.root }}</span><code>{{ result.branch }} · {{ result.baseSha }}</code>
      <button type="button" :disabled="locked" @click="emit('select',result.root)">Use created workspace</button>
    </div>
    <div v-if="error" role="alert">{{ error }}</div>
    <div v-if="forkInput && !result" class="fork-result">
      <span>Reserved Fork: {{ forkInput.path }} · {{ forkInput.purpose }}</span>
      <button type="button" :disabled="locked" @click="fork(true)">Recover Fork result</button>
    </div>
  </div>
</template>
<style scoped>
.workspace-picker,.fork-preview,.fork-result,label {display:grid;gap:8px;min-width:0;}
.workspace-picker {font-size:12px;overflow-wrap:anywhere;}
.search-row {display:flex;align-items:end;gap:8px;}
.search-row label {flex:1;}
.search-row button {flex-shrink:0;}
.fork-preview {border-top:1px solid var(--border);padding-top:8px;}
.fork-preview summary {cursor:pointer;}
.fork-preview[open] > * + * {margin-top:8px;}
@media(max-width:480px){.search-row{align-items:stretch;flex-direction:column;}}
.actions {display:flex;flex-wrap:wrap;gap:8px;}
input,select {width:100%;min-width:0;box-sizing:border-box;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:inherit;font:inherit;}
button {padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer;}
button:disabled {opacity:.5;cursor:default;}
code {overflow-wrap:anywhere;white-space:normal;}
[role=alert] {color:var(--danger);}
</style>
