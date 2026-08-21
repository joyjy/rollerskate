<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { requestJson } from "@/api/client";
import {
  agentSummariesSchema,
  agentMutationResponseSchema,
  localSnapshotSchema
} from "@/api/schema";
import { useApi } from "@/composables/useApi";
import { useMutation } from "@/composables/useMutation";
import AgentRoster from "@/components/AgentRoster.vue";
import AddAgentModal from "@/components/AddAgentModal.vue";
import AgentInspector from "@/components/AgentInspector.vue";
import type { SupportedLocalAgentClient } from "@/types/local";

const emit = defineEmits<{ (e: "agentAdded"): void }>();

const selectedId = ref<string>("");
const pendingAction = ref<
  "add" | "configure" | "rename" | "suspend" | "resume" | null
>(null);
const pollingPaused = computed(() => pendingAction.value !== null);
const agentsQuery = useApi({
  url: "/api/agents",
  schema: agentSummariesSchema,
  interval: 5_000,
  paused: pollingPaused
});
const localQuery = useApi({
  url: "/api/local",
  schema: localSnapshotSchema,
  interval: 5_000,
  paused: pollingPaused
});
const agents = computed(() => agentsQuery.data.value ?? []);
const foundation = computed(() => localQuery.data.value?.foundation ?? null);
const loading = computed(() => agentsQuery.loading.value || localQuery.loading.value);
const loadError = computed(() => agentsQuery.error.value ?? localQuery.error.value);
const mutation = useMutation({
  execute(input: { path: string; body?: object }, signal) {
    return requestJson(input.path, agentMutationResponseSchema, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Rollerskate-Request": "console"
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal
    });
  },
  async refresh() {
    await Promise.all([agentsQuery.refresh(), localQuery.refresh()]);
  }
});
const actionError = mutation.error;

const addDialogOpen = ref(false);
const addTrigger = ref<HTMLButtonElement | null>(null);
const newHandle = ref("");
const newClient = ref<SupportedLocalAgentClient>("codex");
const newLaunchArgs = ref("");

const editing = ref(false);
const editHandle = ref("");
const configuring = ref(false);
const editLaunchArgs = ref("");
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


function resetActionState() {
  actionError.value = null;
  suspendConfirm.value = false;
}

async function refreshAll() {
  await Promise.all([agentsQuery.refresh(), localQuery.refresh()]);
}

function selectAgent(id: string) {
  selectedId.value = id;
  resetActionState();
  editing.value = false;
  configuring.value = false;
}

async function openAddDialog() {
  newHandle.value = "";
  newClient.value = "codex";
  newLaunchArgs.value = "";
  addDialogOpen.value = true;
  resetActionState();
}

function closeAddDialog() {
  addDialogOpen.value = false;
  void nextTick(() => addTrigger.value?.focus());
}

async function addAgent() {
  const handle = newHandle.value.trim();
  if (!handle || pendingAction.value) return;
  pendingAction.value = "add";
  const result = await mutation.execute({
    path: "/api/agents",
    body: {
      handle,
      client: newClient.value,
      launchArgs: launchArgsFromText(newLaunchArgs.value)
    }
  });
  if (result !== null) {
    closeAddDialog();
    if (result.principalId) {
      selectedId.value = result.principalId;
    }
    emit("agentAdded");
  }
  pendingAction.value = null;
}

function beginRename() {
  if (!selected.value) return;
  editing.value = true;
  editHandle.value = selected.value.handle;
  resetActionState();
}

function cancelRename() {
  editing.value = false;
  resetActionState();
}

function beginConfigure() {
  if (!selected.value) return;
  configuring.value = true;
  editLaunchArgs.value = selected.value.executionConfig.launchArgs.join("\n");
  resetActionState();
}

function cancelConfigure() {
  configuring.value = false;
  resetActionState();
}

async function configureAgent() {
  if (!selected.value || pendingAction.value) return;
  pendingAction.value = "configure";
  const result = await mutation.execute({
    path: `/api/agents/${encodeURIComponent(selected.value.principalId)}/configure`,
    body: { launchArgs: launchArgsFromText(editLaunchArgs.value) }
  });
  if (result !== null) configuring.value = false;
  pendingAction.value = null;
}

function launchArgsFromText(value: string): string[] {
  return value.split(/\r?\n/).filter((argument) => argument.length > 0);
}

async function renameAgent() {
  if (!selected.value || pendingAction.value) return;
  const handle = editHandle.value.trim();
  if (!handle) return;
  pendingAction.value = "rename";
  const result = await mutation.execute({
    path: `/api/agents/${encodeURIComponent(selected.value.principalId)}/rename`,
    body: { handle }
  });
  if (result !== null) {
    editing.value = false;
  }
  pendingAction.value = null;
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
  const result = await mutation.execute({
    path: `/api/agents/${encodeURIComponent(selected.value.principalId)}/suspend`
  });
  if (result !== null) {
    suspendConfirm.value = false;
  }
  pendingAction.value = null;
}

async function resumeAgent() {
  if (!selected.value || pendingAction.value) return;
  pendingAction.value = "resume";
  await mutation.execute({
    path: `/api/agents/${encodeURIComponent(selected.value.principalId)}/resume`
  });
  pendingAction.value = null;
}
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
      <button ref="addTrigger" type="button" class="primary-button" :disabled="loading" @click="openAddDialog">Add Agent</button>
    </div>

    <div v-if="loading" class="state">Loading durable Agent facts…</div>
    <div v-else-if="loadError" class="state error" role="alert">
      Could not load Agents: {{ loadError }}
      <button type="button" class="secondary-button retry" @click="refreshAll">Retry</button>
    </div>
    <div v-else-if="agents.length === 0" class="panel empty-panel">
      <div class="panel-header">Local Agents</div>
      <div class="panel-body empty">
        <strong>No Local Agents yet.</strong>
        <span>This is a fresh Local Runtime. Add your first Agent to start.</span>
        <button type="button" class="primary-button" @click="openAddDialog">Add first Agent</button>
      </div>
    </div>
    <div v-else class="agents-layout layout-base layout-two-pane-compact">
      <AgentRoster
        :agents="sortedAgents"
        :selected-id="selected?.principalId ?? null"
        @select="selectAgent"
      />

      <AgentInspector
        v-model:edit-handle="editHandle"
        v-model:edit-launch-args="editLaunchArgs"
        :agent="selected"
        :foundation="foundation"
        :error="actionError"
        :pending="pendingAction"
        :editing="editing"
        :configuring="configuring"
        :suspend-confirm="suspendConfirm"
        @begin-rename="beginRename"
        @cancel-rename="cancelRename"
        @rename="renameAgent"
        @begin-configure="beginConfigure"
        @cancel-configure="cancelConfigure"
        @configure="configureAgent"
        @ask-suspend="askSuspend"
        @cancel-suspend="cancelSuspend"
        @suspend="doSuspend"
        @resume="resumeAgent"
      />
    </div>

    <AddAgentModal
      v-if="addDialogOpen"
      v-model:handle="newHandle"
      v-model:client="newClient"
      v-model:launch-args-text="newLaunchArgs"
      :pending="pendingAction === 'add'"
      :error="actionError"
      @close="closeAddDialog"
      @add="addAgent"
    />
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

.empty-panel .empty { display: flex; flex-direction: column; gap: 12px; align-items: center; padding: 48px 18px; }
.agents-layout { grid-template-columns: minmax(300px, 0.9fr) minmax(420px, 1.1fr); }

.mono { font-family: var(--mono); font-size: 12px; word-break: break-all; }
.secret { color: var(--text-secondary); font-style: italic; }

@media (max-width: 1100px) {
  .agents-layout { grid-template-columns: minmax(0, 1fr); }
  .agents-layout > * { min-width: 0; }
}
@media (max-width: 600px) {
  .page-header { flex-direction: column; }
  .facts { gap: 10px; }
}
</style>
