<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { formatDateTime } from "@/utils/format";
import type { AgentConsoleItem, LocalAgentClient, LocalFoundation } from "@/types/local";

const emit = defineEmits<{ (e: "agentAdded"): void }>();

const agents = ref<AgentConsoleItem[]>([]);
const foundation = ref<LocalFoundation | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);
const actionError = ref<string | null>(null);
const selectedId = ref<string>("");
const pendingAction = ref<"add" | "rename" | "suspend" | "resume" | null>(null);

const addDialogOpen = ref(false);
const newHandle = ref("");
const newClient = ref<LocalAgentClient>("codex");

const editing = ref(false);
const editHandle = ref("");
const suspendConfirm = ref(false);

const activeCount = computed(() => agents.value.filter((a) => a.status === "active").length);
const suspendedCount = computed(() => agents.value.filter((a) => a.status === "suspended").length);

const sortedAgents = computed(() => {
  return [...agents.value].sort((a, b) => {
    if (a.status === b.status) return a.handle.localeCompare(b.handle);
    return a.status === "active" ? -1 : 1;
  });
});

const selected = computed(() =>
  agents.value.find((a) => a.principalId === selectedId.value) ??
  sortedAgents.value[0] ??
  null
);


function sessionSummary(agent: AgentConsoleItem): string {
  if (!agent.currentSession) return "No session yet · 首次调用时创建";
  const s = agent.currentSession;
  return `Generation ${s.generation} · ${s.state} · ${formatDateTime(s.updatedAt)}`;
}

function availabilityState(agent: AgentConsoleItem): "ready" | "unavailable" | "unknown" {
  return agent.availability?.state ?? "unknown";
}

function availabilityReason(agent: AgentConsoleItem): string | undefined {
  return agent.availability?.reason;
}

function resetActionState() {
  actionError.value = null;
  suspendConfirm.value = false;
}

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    const [agentsResponse, localResponse] = await Promise.all([
      fetch("/api/agents", { headers: { Accept: "application/json" } }),
      fetch("/api/local", { headers: { Accept: "application/json" } })
    ]);
    if (!agentsResponse.ok) throw new Error(`Agents HTTP ${agentsResponse.status}`);
    if (!localResponse.ok) throw new Error(`Local HTTP ${localResponse.status}`);
    agents.value = (await agentsResponse.json()) as AgentConsoleItem[];
    const localBody = (await localResponse.json()) as { foundation: LocalFoundation };
    foundation.value = localBody.foundation;
    if (selected.value === null && sortedAgents.value.length > 0) {
      selectedId.value = sortedAgents.value[0]!.principalId;
    }
  } catch (reason) {
    loadError.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    loading.value = false;
  }
}

function selectAgent(id: string) {
  selectedId.value = id;
  resetActionState();
  editing.value = false;
}

function openAddDialog() {
  newHandle.value = "";
  newClient.value = "codex";
  addDialogOpen.value = true;
  resetActionState();
}

function closeAddDialog() {
  addDialogOpen.value = false;
}

async function addAgent() {
  const handle = newHandle.value.trim();
  if (!handle || pendingAction.value) return;
  pendingAction.value = "add";
  actionError.value = null;
  try {
    const response = await fetch("/api/agents", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Rollerskate-Request": "console"
      },
      body: JSON.stringify({ handle, client: newClient.value })
    });
    const result = (await response.json()) as { error?: string; principalId?: string };
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    closeAddDialog();
    await load();
    if (result.principalId) {
      selectedId.value = result.principalId;
    }
    emit("agentAdded");
  } catch (reason) {
    actionError.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    pendingAction.value = null;
  }
}

function beginRename() {
  if (!selected.value) return;
  editing.value = true;
  editHandle.value = selected.value.handle;
  resetActionState();
}

function cancelRename() {
  editing.value = false;
}

async function renameAgent() {
  if (!selected.value || pendingAction.value) return;
  const handle = editHandle.value.trim();
  if (!handle) return;
  pendingAction.value = "rename";
  actionError.value = null;
  try {
    const response = await fetch(`/api/agents/${encodeURIComponent(selected.value.principalId)}/rename`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Rollerskate-Request": "console"
      },
      body: JSON.stringify({ handle })
    });
    const result = (await response.json()) as { error?: string };
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    editing.value = false;
    await load();
  } catch (reason) {
    actionError.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    pendingAction.value = null;
  }
}

function askSuspend() {
  suspendConfirm.value = true;
  resetActionState();
}

function cancelSuspend() {
  suspendConfirm.value = false;
}

async function doSuspend() {
  if (!selected.value || pendingAction.value) return;
  pendingAction.value = "suspend";
  actionError.value = null;
  try {
    const response = await fetch(`/api/agents/${encodeURIComponent(selected.value.principalId)}/suspend`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "X-Rollerskate-Request": "console"
      }
    });
    const result = (await response.json()) as { error?: string };
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    suspendConfirm.value = false;
    await load();
  } catch (reason) {
    actionError.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    pendingAction.value = null;
  }
}

async function resumeAgent() {
  if (!selected.value || pendingAction.value) return;
  pendingAction.value = "resume";
  actionError.value = null;
  try {
    const response = await fetch(`/api/agents/${encodeURIComponent(selected.value.principalId)}/resume`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "X-Rollerskate-Request": "console"
      }
    });
    const result = (await response.json()) as { error?: string };
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    await load();
  } catch (reason) {
    actionError.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    pendingAction.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div class="agents-page layout-base narrow">
    <div class="page-header">
      <div class="page-title">
        <div class="eyebrow">LOCAL RUNTIME</div>
        <h1>Agents</h1>
        <p>Manage local execution identities and availability.</p>
        <div class="facts">
          <span><strong>{{ activeCount }}</strong> active</span>
          <span><strong>{{ suspendedCount }}</strong> suspended</span>
          <span>Device <strong>{{ foundation?.deviceName ?? "—" }}</strong></span>
          <span>Workspace <span class="mono secret">{{ foundation?.workspacePath ?? "—" }}</span></span>
        </div>
      </div>
      <button class="primary-button" :disabled="loading" @click="openAddDialog">Add Agent</button>
    </div>

    <div v-if="loading" class="state">Loading durable Agent facts…</div>
    <div v-else-if="loadError" class="state error" role="alert">
      Could not load Agents: {{ loadError }}
      <button class="secondary-button retry" @click="load">Retry</button>
    </div>
    <div v-else-if="agents.length === 0" class="panel empty-panel">
      <div class="panel-header">Local Agents</div>
      <div class="panel-body empty">
        <strong>No Local Agents yet.</strong>
        <span>This is a fresh Local Runtime. Add your first Agent to start.</span>
        <button class="primary-button" @click="openAddDialog">Add first Agent</button>
      </div>
    </div>
    <div v-else class="agents-layout layout-base layout-two-pane-compact">
      <aside class="panel roster">
        <div class="panel-header">Agent roster · {{ agents.length }}</div>
        <button
          v-for="agent in sortedAgents"
          :key="agent.principalId"
          type="button"
          class="roster-row"
          :class="{ active: selected?.principalId === agent.principalId }"
          @click="selectAgent(agent.principalId)"
        >
          <div class="avatar">{{ agent.handle.slice(0, 1).toUpperCase() }}</div>
          <div class="row-main">
            <div class="handle">{{ agent.handle }}</div>
            <div class="row-meta">
              <span class="badge" :class="agent.status">{{ agent.status }}</span>
              <span class="badge" :class="availabilityState(agent)">{{ availabilityState(agent) }}</span>
              <span class="client">{{ agent.client }}</span>
            </div>
            <div class="row-session">{{ sessionSummary(agent) }}</div>
          </div>
        </button>
      </aside>

      <section v-if="!selected" class="panel inspector">
        <div class="panel-header">Agent inspector</div>
        <div class="panel-body state">Select an Agent to inspect its identity, session and lifecycle controls.</div>
      </section>
      <section v-else class="panel inspector">
        <div class="panel-header">{{ selected.handle }}</div>
        <div class="panel-body">
          <div v-if="actionError" class="inline-error" role="alert">{{ actionError }}</div>

          <div class="inspector-section">
            <div class="section-title">Identity</div>
            <dl class="kv">
              <dt>@handle</dt>
              <dd>
                <template v-if="editing">
                  <input v-model="editHandle" maxlength="32" class="rename-input" :disabled="pendingAction === 'rename'" />
                </template>
                <template v-else>
                  <span class="handle">{{ selected.handle }}</span>
                </template>
              </dd>
              <dt>Stable ID</dt><dd class="mono">{{ selected.principalId }}</dd>
              <dt>Created</dt><dd>{{ formatDateTime(selected.createdAt) }}</dd>
              <dt>Updated</dt><dd>{{ formatDateTime(selected.updatedAt) }}</dd>
            </dl>
          </div>

          <div class="inspector-section">
            <div class="section-title">Execution</div>
            <dl class="kv">
              <dt>Client</dt><dd>{{ selected.client }}</dd>
              <dt>Availability</dt>
              <dd>
                <span class="badge" :class="availabilityState(selected)">{{ availabilityState(selected) }}</span>
                <span v-if="availabilityReason(selected)" class="note">{{ availabilityReason(selected) }}</span>
              </dd>
              <dt>Lifecycle</dt><dd><span class="badge" :class="selected.status">{{ selected.status }}</span></dd>
              <dt>Workspace</dt><dd class="mono secret">{{ foundation?.workspacePath ?? "—" }}</dd>
            </dl>
          </div>

          <div class="inspector-section">
            <div class="section-title">Current session</div>
            <template v-if="selected.currentSession">
              <dl class="kv">
                <dt>Session ID</dt><dd class="mono secret">{{ selected.currentSession.sessionId }}</dd>
                <dt>Generation</dt><dd>{{ selected.currentSession.generation }}</dd>
                <dt>State</dt><dd>{{ selected.currentSession.state }}</dd>
                <dt>Updated</dt><dd>{{ formatDateTime(selected.currentSession.updatedAt) }}</dd>
              </dl>
            </template>
            <p v-else class="note">没有 Session。首次调用时由 Runtime 自动创建，不伪造空 ID。</p>
          </div>

          <div class="inspector-section">
            <div class="section-title">Lifecycle controls</div>
            <template v-if="editing">
              <div class="control-group">
                <button class="secondary-button" :disabled="pendingAction === 'rename'" @click="cancelRename">Cancel</button>
                <button class="primary-button" :disabled="!editHandle.trim() || pendingAction === 'rename'" @click="renameAgent">
                  {{ pendingAction === 'rename' ? 'Saving…' : 'Save rename' }}
                </button>
              </div>
              <p class="note">Stable Principal ID、历史 Event 与 Session 引用不会变化。</p>
            </template>
            <template v-else-if="suspendConfirm">
              <p class="note">新的调用不会再进入该 Agent；历史、current Session 和审计引用会保留。</p>
              <div class="control-group">
                <button class="secondary-button" :disabled="pendingAction === 'suspend'" @click="cancelSuspend">Cancel</button>
                <button class="primary-button" style="background:var(--warning);border-color:var(--warning);" :disabled="pendingAction === 'suspend'" @click="doSuspend">
                  {{ pendingAction === 'suspend' ? 'Suspending…' : 'Confirm Suspend' }}
                </button>
              </div>
            </template>
            <template v-else>
              <div class="control-group">
                <button class="secondary-button" :disabled="pendingAction === 'suspend' || pendingAction === 'resume'" @click="beginRename">Rename</button>
                <button
                  v-if="selected.status === 'active'"
                  class="secondary-button danger"
                  :disabled="pendingAction === 'suspend' || pendingAction === 'resume'"
                  @click="askSuspend"
                >
                  Suspend
                </button>
                <button
                  v-else
                  class="primary-button"
                  :disabled="pendingAction === 'suspend' || pendingAction === 'resume'"
                  @click="resumeAgent"
                >
                  {{ pendingAction === 'resume' ? 'Resuming…' : 'Resume' }}
                </button>
              </div>
            </template>
          </div>
        </div>
      </section>
    </div>

    <div v-if="addDialogOpen" class="modal-overlay" @click.self="closeAddDialog">
      <div class="modal">
        <div class="modal-header"><h3>Add Agent</h3></div>
        <div class="modal-body">
          <div v-if="actionError" class="inline-error" role="alert">{{ actionError }}</div>
          <div class="field">
            <label for="new-handle">Handle</label>
            <input id="new-handle" v-model="newHandle" type="text" maxlength="32" placeholder="researcher" autocomplete="off" :disabled="pendingAction === 'add'" />
            <div class="preview">将显示为 <strong>@{{ newHandle.trim() || 'researcher' }}</strong>，大小写不敏感且唯一。</div>
          </div>
          <div class="field">
            <label for="new-client">Client</label>
            <select id="new-client" v-model="newClient" :disabled="pendingAction === 'add'">
              <option value="codex">Codex</option>
            </select>
            <div class="preview">决定该 Agent 使用哪个执行 adapter。</div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="secondary-button" :disabled="pendingAction === 'add'" @click="closeAddDialog">Cancel</button>
          <button class="primary-button" :disabled="!newHandle.trim() || pendingAction === 'add'" @click="addAgent">
            {{ pendingAction === 'add' ? 'Adding…' : 'Add Agent' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; flex-wrap: wrap; }
.page-title h1 { margin: 4px 0 6px; font-size: 26px; line-height: 1.2; }
.page-title p { margin: 0; color: var(--text-secondary); max-width: 620px; }
.eyebrow { color: var(--primary); font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.facts { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: var(--text-secondary); margin-top: 10px; }
.facts span strong { color: var(--text); font-weight: 600; }
.secondary-button.retry { margin-left: 12px; }

.badge.active { background: var(--success-soft); color: var(--success); }
.badge.suspended { background: var(--muted-soft); color: var(--muted); }
.badge.ready { background: var(--success-soft); color: var(--success); }
.badge.unavailable { background: var(--danger-soft); color: var(--danger); }
.badge.unknown { background: var(--warning-soft); color: var(--warning); }

.empty-panel .empty { display: flex; flex-direction: column; gap: 12px; align-items: center; padding: 48px 18px; }
.note { font-size: 12px; color: var(--text-secondary); }

.agents-layout { grid-template-columns: minmax(300px, 0.9fr) minmax(420px, 1.1fr); }
.roster { max-height: calc(100vh - 220px); overflow-y: auto; }
.roster-row {
  display: flex; align-items: center; gap: 12px;
  width: 100%; padding: 13px 16px; border: 0; border-bottom: 1px solid var(--border);
  background: var(--surface); color: var(--text); text-align: left; cursor: pointer;
}
.roster-row:hover { background: var(--surface-2); }
.roster-row:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
.roster-row.active { background: var(--primary-soft); box-shadow: inset 3px 0 var(--primary); }
.roster-row:last-child { border-bottom: 0; }
.avatar { width: 36px; height: 36px; border-radius: 9px; display: grid; place-items: center; background: var(--primary-soft); color: var(--primary); font-weight: 800; flex-shrink: 0; }
.row-main { flex: 1; min-width: 0; }
.handle { font-weight: 750; }
.handle::before { content: "@"; color: var(--text-dim); font-weight: 500; margin-right: 1px; }
.row-meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 4px; }
.client { color: var(--text-secondary); font-size: 12px; }
.row-session { font-size: 12px; color: var(--text-secondary); margin-top: 3px; }

.inspector { min-height: 420px; }
.inspector .panel-body { padding: 20px; }
.inspector-section { margin-bottom: 22px; }
.inspector-section:last-child { margin-bottom: 0; }
.section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-secondary); margin: 0 0 10px; }
.kv { display: grid; grid-template-columns: 130px 1fr; gap: 6px 14px; font-size: 13px; }
.kv dt { color: var(--text-secondary); font-weight: 500; }
.kv dd { margin: 0; word-break: break-word; }
.rename-input { width: 100%; max-width: 280px; border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font: inherit; }
.control-group { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px; }

.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 16px; }
.modal { background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow-lg); width: 100%; max-width: 420px; overflow: hidden; }
.modal-header { padding: 16px; border-bottom: 1px solid var(--border); }
.modal-header h3 { margin: 0; font-size: 16px; }
.modal-body { padding: 16px; }
.modal-footer { padding: 12px 16px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 10px; }
.field { margin-bottom: 14px; }
.field label { display: block; font-size: 12px; font-weight: 700; color: var(--text-secondary); margin-bottom: 6px; }
.field input, .field select { width: 100%; border: 1px solid var(--border); border-radius: 7px; padding: 9px 10px; font: inherit; background: var(--surface); color: var(--text); }
.field .preview { font-size: 12px; color: var(--text-secondary); margin-top: 4px; }

.mono { font-family: var(--mono); font-size: 12px; word-break: break-all; }
.secret { color: var(--text-secondary); font-style: italic; }

@media (max-width: 1100px) {
  .agents-layout { grid-template-columns: minmax(0, 1fr); }
  .agents-layout > * { min-width: 0; }
  .roster { max-height: 360px; }
}
@media (max-width: 600px) {
  .page-header { flex-direction: column; }
  .facts { gap: 10px; }
  .kv { grid-template-columns: 100px 1fr; }
}
</style>
