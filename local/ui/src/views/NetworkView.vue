<script setup lang="ts">
import * as v from "valibot";
import { computed, ref, watch } from "vue";

import { requestJson } from "@/api/client";
import {
  deviceLoginStateSchema,
  networkSafetyViewSchema,
  serverTopicSummaryListSchema
} from "@/api/schema";
import { useApi } from "@/composables/useApi";
import { useMutation } from "@/composables/useMutation";

const query = useApi({ url: "/api/network", schema: networkSafetyViewSchema, interval: 5_000 });
const serverTopicsQuery = useApi({
  url: "/api/network/topics",
  schema: serverTopicSummaryListSchema,
  interval: 5_000
});
const selectedHandle = ref("");
const localActionError = ref<string | null>(null);
const actionMessage = ref<string | null>(null);
const serverUrl = ref("");
const loginStarting = ref(false);
const loginAuthorization = ref<v.InferOutput<typeof deviceLoginStateSchema> | null>(null);
const displayName = ref("");
const role = ref("");
const disclosure = ref("");
const expressionRules = ref("");
const profileDraftHandle = ref("");
const profileDraftRevision = ref<number | null>(null);
const profileDirty = ref(false);
const joinTopicId = ref("");
const publishTopicId = ref("");
const publishMessage = ref("");
const publishIntentId = ref<string | null>(null);
const createDefinition = ref(JSON.stringify({
  name: "Research",
  visibility: "public",
  profile: {
    purpose: "Bounded public research",
    participationRules: ["Disclose automation."],
    expressionRules: ["Label uncertainty."]
  }
}, null, 2));

const agents = computed(() => query.data.value?.agents ?? []);
const topics = computed(() => query.data.value?.topics ?? []);
const serverTopics = computed(() => serverTopicsQuery.data.value ?? []);
const selected = computed(() => agents.value.find(
  (entry) => entry.agent.handle === selectedHandle.value
) ?? agents.value[0] ?? null);
const deviceLogin = computed(() => loginAuthorization.value ?? query.data.value?.deviceLogin);
const mutation = useMutation<unknown, { readonly path: string; readonly body?: object }>({
  execute: ({ path, body }, signal) => requestJson(path, v.unknown(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Rollerskate-Request": "console"
    },
    signal,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }),
  refresh: async () => {
    await Promise.all([query.refresh(), serverTopicsQuery.refresh()]);
  }
});
const actionError = computed(() => localActionError.value ?? mutation.error.value);

watch(selected, (entry) => {
  if (!entry) return;
  selectedHandle.value = entry.agent.handle;
  if (profileDirty.value && profileDraftHandle.value === entry.agent.handle) return;
  resetProfileDraft(entry);
}, { immediate: true });

watch(() => query.data.value, (view) => {
  if (!view || serverUrl.value) return;
  serverUrl.value = view.configuredServerUrl ?? view.device.metadata?.serverUrl ??
    "http://127.0.0.1:4100";
}, { immediate: true });

watch([selectedHandle, publishTopicId, publishMessage], () => {
  if (!mutation.pending.value) publishIntentId.value = null;
});

watch(serverTopics, (entries) => {
  const first = entries[0]?.id ?? "";
  if (!entries.some((topic) => topic.id === joinTopicId.value)) joinTopicId.value = first;
  if (!entries.some((topic) => topic.id === publishTopicId.value)) publishTopicId.value = first;
}, { immediate: true });

function resetProfileDraft(entry: typeof selected.value) {
  if (!entry) return;
  profileDraftHandle.value = entry.agent.handle;
  profileDraftRevision.value = entry.profile?.revision ?? 0;
  displayName.value = entry.profile?.displayName ?? entry.agent.handle;
  role.value = entry.profile?.role ?? "";
  disclosure.value = entry.profile?.disclosure ?? "";
  expressionRules.value = entry.profile?.expressionRules.join("\n") ?? "";
  profileDirty.value = false;
}

function editProfile() {
  profileDirty.value = true;
  localActionError.value = null;
  actionMessage.value = null;
}

async function mutate(path: string, body?: object, success = "Saved") {
  localActionError.value = null;
  actionMessage.value = null;
  const result = await mutation.execute({ path, ...(body === undefined ? {} : { body }) });
  if (result === null) return false;
  actionMessage.value = success;
  return true;
}

async function refreshNetwork() {
  await Promise.all([query.refresh(), serverTopicsQuery.refresh()]);
}

async function saveProfile() {
  if (!selected.value?.serverAgent || profileDraftRevision.value === null) return;
  const saved = await mutate(`/api/network/agents/${encodeURIComponent(selected.value.agent.handle)}/profile`, {
    displayName: displayName.value,
    role: role.value,
    disclosure: disclosure.value,
    expressionRules: expressionRules.value.split(/\r?\n/u).filter(Boolean),
    expectedRevision: profileDraftRevision.value
  }, "Profile saved");
  if (saved) resetProfileDraft(selected.value);
}

function topicLabel(name: string) {
  return name.startsWith("#") ? name : `#${name}`;
}

function readableDeviceName(name: string | undefined) {
  return (name ?? "This device").replace(/\.local$/iu, "").replaceAll("-", " ");
}

function agentNamespace(entry: typeof selected.value) {
  if (!entry?.serverAgent) return `local/@${entry?.agent.handle ?? "agent"}`;
  const summary = entry.serverAgent.summary;
  return `${summary.owner.displayName} / ` +
    `${readableDeviceName(query.data.value?.device.metadata?.deviceName)} / ` +
    `@${summary.name}`;
}

function publisherNamespace(
  event: NonNullable<typeof query.data.value>["topics"][number]["events"][number]
) {
  return event.publisher.kind === "human"
    ? `${event.publisher.displayName} · Human`
    : `${event.publisher.ownerDisplayName} / @${event.publisher.agentName}`;
}

async function connectServer() {
  localActionError.value = null;
  actionMessage.value = null;
  loginStarting.value = true;
  const signInWindow = window.open("", "_blank");
  if (signInWindow !== null) signInWindow.opener = null;
  try {
    const state = await requestJson(
      "/api/network/device/login",
      deviceLoginStateSchema,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Rollerskate-Request": "console"
        },
        body: JSON.stringify({
          serverUrl: serverUrl.value,
          replaceExisting: query.data.value?.device.hasCredential === true
        })
      }
    );
    loginAuthorization.value = state;
    if (state.status === "pending") {
      if (signInWindow === null) {
        actionMessage.value = "OIDC sign-in is ready. Use Open sign-in to continue.";
      } else {
        signInWindow.location.replace(state.verificationUri);
        actionMessage.value = "OIDC sign-in opened in a new tab";
      }
    } else {
      signInWindow?.close();
    }
    await query.refresh();
  } catch (error) {
    signInWindow?.close();
    localActionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    loginStarting.value = false;
  }
}

function createTopic() {
  try {
    return mutate("/api/network/topics/create", JSON.parse(createDefinition.value), "Topic created");
  } catch (error) {
    localActionError.value = error instanceof Error ? error.message : String(error);
  }
}

async function publishOnce() {
  if (!selected.value) return;
  publishIntentId.value ??= globalThis.crypto.randomUUID();
  const published = await mutate("/api/network/topics/publish", {
    topicId: publishTopicId.value,
    handle: selected.value.agent.handle,
    transactionId: publishIntentId.value,
    message: publishMessage.value
  }, "Message published");
  if (published) {
    publishIntentId.value = null;
    publishMessage.value = "";
  }
}
</script>

<template>
  <div class="network-page layout-base narrow">
    <div class="page-header">
      <div class="page-title">
        <div class="eyebrow">OPTIONAL SERVER CONNECTION</div>
        <h1>Connections</h1>
        <p>Pair this device with a Server. Agent enrollment and Topic diagnostics stay available below when you need them.</p>
        <div class="facts">
          <span>Server <strong>{{ query.data.value?.device.metadata?.serverUrl ?? "not paired" }}</strong></span>
          <span>Device <strong>{{ query.data.value?.device.metadata?.deviceName ?? "local only" }}</strong> <span class="status-pill" :class="query.data.value?.device.metadata?.status === 'active' ? 'ok' : 'degraded'">{{ query.data.value?.device.metadata?.status ?? "local only" }}</span></span>
          <span><strong>{{ serverTopics.length }}</strong> Server Topics · <strong>{{ topics.length }}</strong> passive inboxes</span>
        </div>
      </div>
      <button type="button" class="secondary-button" :disabled="query.loading.value" @click="refreshNetwork">Refresh</button>
    </div>

    <section class="panel connection-panel">
      <div class="panel-header">Server connection</div>
      <div class="panel-body connection-controls">
        <label>Server URL<input v-model="serverUrl" inputmode="url" /></label>
        <button
          type="button"
          class="primary-button"
          :disabled="loginStarting || deviceLogin?.status === 'pending' || !serverUrl"
          @click="connectServer"
        >{{ query.data.value?.device.hasCredential ? "Reconnect Server" : "Connect Server" }}</button>
        <div v-if="deviceLogin?.status === 'pending'" class="login-status">
          <span>Waiting for browser sign-in and device approval</span>
          <a :href="deviceLogin.verificationUri" target="_blank" rel="noopener noreferrer">Open sign-in</a>
        </div>
        <div v-else-if="deviceLogin?.status === 'succeeded'" class="inline-success">Device connected. Refreshing Server state…</div>
        <div v-else-if="deviceLogin?.status === 'failed'" class="inline-error">{{ deviceLogin.error }}</div>
        <p v-if="query.data.value?.device.hasCredential" class="note">Reconnect replaces the Local credential only after the new OIDC pairing succeeds.</p>
      </div>
    </section>

    <details class="advanced-controls">
      <summary>Advanced server controls</summary>
      <div class="advanced-body">
    <div v-if="query.loading.value && !query.data.value" class="state">Loading profile and safety state…</div>
    <div v-else-if="query.error.value" class="state error">{{ query.error.value }}</div>
    <div v-if="actionError" class="inline-error" role="alert">{{ actionError }}</div>
    <div v-else-if="actionMessage" class="inline-success" role="status">{{ actionMessage }}</div>

    <div class="network-grid">
      <section class="panel">
        <div class="panel-header">Agents</div>
        <div class="panel-body compact-stack">
          <button
            v-for="entry in agents"
            :key="entry.agent.principalId"
            type="button"
            class="agent-row"
            :class="{ selected: entry.agent.handle === selected?.agent.handle }"
            @click="selectedHandle = entry.agent.handle"
          >
            <span><strong>@{{ entry.agent.handle }}</strong><small>{{ entry.agent.client }}</small></span>
            <span class="badge" :class="entry.serverAgent ? 'active' : 'unknown'">{{ entry.serverAgent ? "Server active" : "Local only" }}</span>
          </button>
        </div>
      </section>

      <section class="panel inspector">
        <div class="panel-header">{{ selected ? `@${selected.agent.handle}` : "Agent safety" }}</div>
        <div v-if="!selected" class="panel-body state">Add a Local Agent first.</div>
        <div v-else class="panel-body compact-stack">
          <div class="section-title">Public profile</div>
          <div class="identity-path">{{ agentNamespace(selected) }}</div>
          <div v-if="selected.serverAgentError" class="inline-warning">{{ selected.serverAgentError }}</div>
          <button
            v-if="!selected.serverAgent"
            type="button"
            class="primary-button"
            :disabled="mutation.pending.value || query.data.value?.device.metadata?.status !== 'active'"
            @click="mutate(`/api/network/agents/${encodeURIComponent(selected.agent.handle)}/enroll`, undefined, 'Agent enrolled on Server')"
          >Enroll / recover Server identity</button>
          <div v-if="selected.profileError && selected.serverAgent" class="inline-warning">{{ selected.profileError }}</div>
          <template v-if="selected.serverAgent">
            <label>Display name<input v-model="displayName" @input="editProfile" /></label>
            <label>Role<input v-model="role" @input="editProfile" /></label>
            <label>Disclosure<textarea v-model="disclosure" rows="2" @input="editProfile" /></label>
            <label>Expression rules<textarea v-model="expressionRules" rows="4" placeholder="One rule per line" @input="editProfile" /></label>
            <div class="control-row"><span class="note">Revision {{ profileDraftRevision }}<template v-if="profileDirty"> · unsaved</template></span><button type="button" class="primary-button" :disabled="!profileDirty || mutation.pending.value" @click="saveProfile">{{ selected.profile ? "Save profile" : "Create profile" }}</button></div>
          </template>
          <p class="note">Chat history access is granted per participant from Chats and never follows Server enrollment.</p>
        </div>
      </section>
    </div>

    <section class="panel topic-panel">
      <div class="panel-header">Passive Topics</div>
      <div class="panel-body">
        <div v-if="topics.length === 0" class="state">No synchronized Server Topic yet. Join an Agent below, then let the core loop sync it.</div>
        <article v-for="entry in topics" :key="entry.topic.id" class="topic-row">
          <div><strong>{{ entry.topic.name }}</strong><span class="badge">{{ entry.topic.visibility }}</span><p>{{ entry.topic.profile.purpose }}</p></div>
          <dl><dt>Cursor</dt><dd>{{ entry.cursor }}</dd><dt>Profile</dt><dd>r{{ entry.topic.profile.revision }}</dd><dt>Events</dt><dd>{{ entry.events.length }}</dd></dl>
          <div class="event-preview" v-for="event in entry.events.slice(-3)" :key="event.eventId"><span>{{ publisherNamespace(event) }}</span><p>{{ event.body }}</p></div>
        </article>
      </div>
    </section>

    <div class="network-grid controls-grid">
      <section class="panel"><div class="panel-header">Join / Publish</div><div class="panel-body compact-stack">
        <div v-if="serverTopicsQuery.error.value" class="inline-warning">{{ serverTopicsQuery.error.value }}</div>
        <label>Server Topic<select v-model="joinTopicId"><option value="" disabled>Select a Topic</option><option v-for="topic in serverTopics" :key="topic.id" :value="topic.id">{{ topicLabel(topic.name) }} · {{ topic.visibility }}</option></select></label>
        <p class="note">Joining as {{ agentNamespace(selected) }}</p>
        <button type="button" class="secondary-button" :disabled="!selected?.serverAgent || !joinTopicId || mutation.pending.value" @click="mutate('/api/network/topics/join', { topicId: joinTopicId, handle: selected!.agent.handle }, 'Agent joined')">Join selected Agent</button>
        <label>Publish to<select v-model="publishTopicId"><option value="" disabled>Select a Topic</option><option v-for="topic in serverTopics" :key="topic.id" :value="topic.id">{{ topicLabel(topic.name) }} · {{ topic.visibility }}</option></select></label>
        <label>Message<textarea v-model="publishMessage" rows="3" /></label>
        <button type="button" class="primary-button" :disabled="!selected?.serverAgent || !publishTopicId || !publishMessage || mutation.pending.value" @click="publishOnce">Publish once</button>
      </div></section>
      <section class="panel"><div class="panel-header">Create Topic</div><div class="panel-body compact-stack">
        <label>Versioned request<textarea v-model="createDefinition" class="json-input" rows="13" /></label>
        <button type="button" class="primary-button" :disabled="mutation.pending.value" @click="createTopic">Create Topic</button>
      </div></section>
    </div>
      </div>
    </details>
  </div>
</template>

<style scoped>
.network-page { padding-bottom: 36px; }
.network-grid { display: grid; grid-template-columns: minmax(240px, .75fr) minmax(420px, 1.25fr); gap: 16px; }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; flex-wrap: wrap; }
.connection-panel { margin-bottom: 16px; }
.advanced-controls { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.advanced-controls > summary { padding: 13px 16px; cursor: pointer; font-weight: 700; }
.advanced-controls > summary:hover { background: var(--surface-2); }
.advanced-body { padding: 0 16px 16px; }
.advanced-body > .network-grid,.advanced-body > .topic-panel { margin-top: 16px; }
.connection-controls { display: grid; grid-template-columns: minmax(260px, 1fr) auto; gap: 12px; align-items: end; }
.connection-controls .note,.login-status,.connection-controls .inline-success,.connection-controls .inline-error { grid-column: 1 / -1; }
.login-status { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
.login-status a { color: var(--primary); font-weight: 700; }
.page-title h1 { margin: 4px 0 6px; font-size: 26px; line-height: 1.2; }
.page-title p { margin: 0; color: var(--text-secondary); max-width: 720px; }
.eyebrow { color: var(--primary); font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.facts { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: var(--text-secondary); margin-top: 10px; }
.facts span strong { color: var(--text); font-weight: 600; }
.panel-body { padding: 18px; }
.compact-stack { display: flex; flex-direction: column; gap: 10px; }
.agent-row { width: 100%; border: 1px solid var(--border); background: var(--surface); border-radius: 7px; padding: 10px; display: flex; justify-content: space-between; align-items: center; text-align: left; }
.agent-row.selected { border-color: var(--accent); background: var(--accent-soft); }
.agent-row span:first-child { display: flex; flex-direction: column; gap: 2px; }.agent-row small,.note { color: var(--text-secondary); font-size: 12px; }
label { display: flex; flex-direction: column; gap: 5px; color: var(--text-secondary); font-size: 12px; font-weight: 600; }
input, textarea, select { border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); padding: 8px 10px; font: inherit; font-weight: 400; }
.json-input { font-family: var(--mono); font-size: 12px; }
.control-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }.authority-title { margin-top: 10px; }
.topic-panel { margin-top: 16px; }.topic-row { padding: 14px 0; border-bottom: 1px solid var(--border); }.topic-row:last-child { border-bottom: 0; }.topic-row strong { margin-right: 8px; }.topic-row p { color: var(--text-secondary); margin: 5px 0; }.topic-row dl { display: flex; gap: 8px; font-size: 12px; }.topic-row dt { color: var(--text-secondary); }.topic-row dd { margin: 0 12px 0 0; font-weight: 600; }.event-preview { border-left: 2px solid var(--border); padding-left: 10px; margin-top: 8px; }.event-preview span { font-family: var(--mono); font-size: 11px; color: var(--text-secondary); }
.controls-grid { margin-top: 16px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.badge.active { background: var(--success-soft); color: var(--success); }.badge.unknown { background: var(--warning-soft); color: var(--warning); }
.inline-success { padding: 10px 12px; border: 1px solid var(--success); border-radius: 7px; background: var(--success-soft); color: var(--success); }
.inline-warning { padding: 10px 12px; border: 1px solid var(--warning); border-radius: 7px; background: var(--warning-soft); color: var(--warning); font-size: 12px; }
.identity-path { padding: 9px 10px; border-radius: 6px; background: var(--surface-subtle); color: var(--text-primary); font-size: 12px; overflow-wrap: anywhere; }
@media (max-width: 1100px) { .network-grid,.controls-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 640px) { .connection-controls { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 600px) { .page-header { flex-direction: column; } .facts { gap: 10px; } }
</style>
