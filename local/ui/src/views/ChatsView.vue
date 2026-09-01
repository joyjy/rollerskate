<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { routerKey } from "vue-router";
import { requestJson } from "@/api/client";
import {
  errorResponseSchema,
  chatRunHandoffReceiptSchema,
  freeChatModeViewSchema,
  localChatPresenceViewSchema,
  localChatViewSchema,
  networkSafetyViewSchema,
  serverTopicSummaryListSchema,
  topicActivationScheduleViewsSchema,
  topicGovernanceViewSchema
} from "@/api/schema";
import { useApi } from "@/composables/useApi";
import { useMutation } from "@/composables/useMutation";
import ChatList from "@/components/ChatList.vue";
import ChatTimeline from "@/components/ChatTimeline.vue";
import ChatComposer from "@/components/ChatComposer.vue";
import ChatContextPanel from "@/components/ChatContextPanel.vue";
import ChatGovernancePanel from "@/components/ChatGovernancePanel.vue";
import type { ChatListItem, ChatTimelineMessage } from "@/types/chat";
import type { LocalAgent } from "@/types/local";

const selectedId = ref<string>("local");
const router = inject(routerKey, null);
const drafts = ref<Record<string, string>>({});
const serverIntentIds = ref<Record<string, string>>({});
const serverSendStates = ref<Record<string, "idle" | "pending" | "sent" | "failed">>({});
const composer = computed({
  get: () => drafts.value[selectedChat.value?.id ?? "local"] ?? "",
  set: (value: string) => {
    drafts.value[selectedChat.value?.id ?? "local"] = value;
  }
});
const replyingTo = ref<ChatTimelineMessage | null>(null);
const pending = ref<string | null>(null);
const intent = ref<"continue_recent" | "choose_from_themes" | "directed">(
  "continue_recent"
);
const directedBrief = ref("");
const intentError = ref<string | null>(null);
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  clock = setInterval(() => { now.value = Date.now(); }, 1_000);
});
onBeforeUnmount(() => {
  if (clock !== undefined) clearInterval(clock);
});
const chatTimelineRef = ref<InstanceType<typeof ChatTimeline> | null>(null);
const pollingPaused = computed(() => pending.value !== null);
const {
  data: chatView,
  loading,
  error: loadError,
  refresh: refreshChat
} = useApi({
  url: "/api/chat",
  schema: localChatViewSchema,
  interval: 2_000,
  paused: pollingPaused
});
const presenceQuery = useApi({
  url: "/api/chat/presence",
  schema: localChatPresenceViewSchema,
  interval: 2_000,
  paused: pollingPaused
});
const governanceQuery = useApi({
  url: "/api/chat/governance",
  schema: topicGovernanceViewSchema,
  interval: 2_000,
  paused: pollingPaused
});
const freeChatQuery = useApi({
  url: "/api/chat/free-chat",
  schema: freeChatModeViewSchema,
  interval: 2_000,
  paused: pollingPaused
});
const topicSchedulesQuery = useApi({
  url: "/api/chat/schedules",
  schema: topicActivationScheduleViewsSchema,
  interval: 2_000,
  paused: pollingPaused
});
const serverTopicsQuery = useApi({
  url: "/api/network/topics",
  schema: serverTopicSummaryListSchema,
  interval: 2_000,
  paused: pollingPaused
});
const networkQuery = useApi({
  url: "/api/network",
  schema: networkSafetyViewSchema,
  interval: 5_000,
  paused: pollingPaused
});
const mutation = useMutation({
  execute(input: { path: string; body?: object }, signal) {
    return requestJson(input.path, errorResponseSchema, {
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
    await Promise.all([
      refreshChat(),
      presenceQuery.refresh(),
      governanceQuery.refresh(),
      freeChatQuery.refresh(),
      topicSchedulesQuery.refresh(),
      serverTopicsQuery.refresh(),
      networkQuery.refresh()
    ]);
  }
});
const workHandoffMutation = useMutation({
  execute(input: { eventId: string }, signal) {
    return requestJson(
      `/api/chat/messages/${encodeURIComponent(input.eventId)}/run`,
      chatRunHandoffReceiptSchema,
      {
        method: "POST",
        headers: { "X-Rollerskate-Request": "console" },
        signal
      }
    );
  }
});
const presenceAgents = computed(() => presenceQuery.data.value?.agents ?? []);
const error = computed(() =>
  mutation.error.value ?? workHandoffMutation.error.value ?? intentError.value ??
  loadError.value ?? presenceQuery.error.value ??
  governanceQuery.error.value ?? freeChatQuery.error.value ?? topicSchedulesQuery.error.value
);

const chats = computed<ChatListItem[]>(() => {
  const local = chatView.value?.chat;
  const list: ChatListItem[] = [];
  if (local) {
    list.push({
      id: local.topicId,
      kind: "local",
      handle: `#${local.handle}`,
      name: "Local",
      status: "active",
      unreadCount: 0
    });
  }
  for (const topic of serverTopicsQuery.data.value ?? []) {
    list.push({
      id: topic.id,
      kind: "server",
      handle: topic.name.startsWith("#") ? topic.name : `#${topic.name}`,
      name: topic.visibility,
      status: "active",
      unreadCount: 0
    });
  }
  return list;
});

const selectedChat = computed(() =>
  chats.value.find((chat) => chat.id === selectedId.value) ?? chats.value[0] ?? null
);

const selectedIsLocal = computed(() => selectedChat.value?.kind !== "server");
watch(selectedId, () => { replyingTo.value = null; });
const currentHumanId = computed(() => networkQuery.data.value?.device?.metadata?.humanId);
const currentHumanName = computed(() =>
  networkQuery.data.value?.device?.metadata?.humanDisplayName ?? "You"
);
const serverSendState = computed(() =>
  serverSendStates.value[selectedChat.value?.id ?? ""] ?? "idle"
);

const selectedTopic = computed(() => networkQuery.data.value?.topics?.find(
  (entry) => entry.topic.id === selectedChat.value?.id
) ?? null);

const topicAgentIds = computed(() => new Set(
  selectedTopic.value?.participants.map((participant) => participant.serverAgentId) ?? []
));

function namespaceFor(entry: NonNullable<typeof networkQuery.data.value>["agents"][number]) {
  const owner = entry.serverAgent?.summary.owner.displayName ??
    networkQuery.data.value?.device.metadata?.humanDisplayName ?? "Local owner";
  const device = (networkQuery.data.value?.device.metadata?.deviceName ?? "Local device")
    .replace(/\.local$/iu, "")
    .replaceAll("-", " ");
  return `${owner} / ${device} / @${entry.agent.handle}`;
}

const topicAgents = computed(() => (networkQuery.data.value?.agents ?? [])
  .filter((entry) => entry.serverAgent !== undefined &&
    topicAgentIds.value.has(entry.serverAgent.summary.id))
  .map((entry) => ({
    handle: entry.agent.handle,
    namespace: namespaceFor(entry)
  })));

const joinCandidates = computed(() => (networkQuery.data.value?.agents ?? [])
  .filter((entry) => entry.agent.status === "active" &&
    (entry.serverAgent === undefined || !topicAgentIds.value.has(entry.serverAgent.summary.id)))
  .map((entry) => ({
    handle: entry.agent.handle,
    enrolled: entry.serverAgent !== undefined,
    namespace: namespaceFor(entry)
  })));

const showAgentPicker = ref(false);
const starterAttempts = new Set<string>();

const activeParticipantIds = computed(() => new Set(
  governanceQuery.data.value?.activeParticipantAgentIds ?? []
));

const activeAgents = computed(() =>
  selectedIsLocal.value
    ? chatView.value?.agents.filter((agent) => agent.status === "active" &&
      activeParticipantIds.value.has(agent.principalId)) ?? []
    : (networkQuery.data.value?.agents ?? [])
      .filter((entry) => entry.agent.status === "active" &&
        entry.serverAgent !== undefined && topicAgentIds.value.has(entry.serverAgent.summary.id))
      .map((entry) => entry.agent)
);

const visibleMessages = computed<readonly ChatTimelineMessage[]>(() => {
  if (selectedIsLocal.value) return chatView.value?.messages.items ?? [];
  return (selectedTopic.value?.events ?? []).map((event) => event.publisher.kind === "human"
    ? {
        eventId: event.eventId,
        createdAt: event.createdAt,
        sender: {
          kind: "human" as const,
          principalId: event.publisher.humanId,
          handleSnapshot: event.publisher.displayName
        },
        body: event.body
      }
    : {
        eventId: event.eventId,
        createdAt: event.createdAt,
        sender: {
          kind: "agent" as const,
          principalId: event.publisher.agentId,
          handleSnapshot: `@${event.publisher.agentName}`
        },
        body: event.body
      });
});

const conversationLabel = computed(() => {
  if (governanceQuery.data.value?.governance.status === "paused") return "Topic paused";
  if (pending.value === "activation") return "Waking Agents";
  const state = chatView.value?.conversation.state;
  if (state === "starter_pending") return "Ready to start";
  if (state === "active") return "Agents are responding";
  if (state === "all_silent") return "Stopped · everyone stayed silent";
  if (state === "budget_exhausted") return "Stopped · turn budget reached";
  return "Idle";
});

const activationExplanation = computed(() => {
  const reason = chatView.value?.conversation.latestReason;
  if (reason === "topic_opened") return "Started by the Topic starter";
  if (reason === "manual") return "Started with Wake now";
  if (reason === "participant_message") return "Continued after an Agent message";
  if (reason === "resumed") return "Resumed by the Owner";
  if (reason === "scheduled") return "Started on schedule";
  return "Starter wakes one listening Agent on an empty Topic";
});

const conversationExplanation = computed(() => {
  const speakers = chatView.value?.conversation.activeSpeakerHandles ?? [];
  if (governanceQuery.data.value?.governance.status === "paused") {
    return "New conversation attention is stopped; a running turn may finish.";
  }
  if (pending.value === "activation") return "Creating one canonical conversation root…";
  return speakers.length === 0
    ? freeChatStatus.value ?? activationExplanation.value
    : `${speakers.map((speaker) => `@${speaker}`).join(", ")} ${
      speakers.length === 1 ? "is" : "are"
    } thinking · ${activationExplanation.value}`;
});

const freeChatStatus = computed(() => {
  const mode = freeChatQuery.data.value?.mode;
  if (mode?.status !== "active") return null;
  const remaining = Math.max(0, Date.parse(mode.sample.idleDeadline) - now.value);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return `Free Chat · ${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")} ` +
    `until ${mode.sample.participantCount} Agent${mode.sample.participantCount === 1 ? "" : "s"}`;
});

const intentInput = computed(() => {
  const brief = directedBrief.value.trim();
  return {
    intent: intent.value,
    ...(intent.value === "directed" ? { brief } : {})
  };
});

watch(() => governanceQuery.data.value?.governance.conversationPolicy.defaultIntent,
  (value, previous) => {
    if (value !== undefined && previous === undefined) intent.value = value;
  });

async function activate(strategy: "starter" | "manual") {
  if (pending.value || !selectedIsLocal.value) return;
  const topicId = chatView.value?.chat.topicId;
  if (topicId === undefined) return;
  if (strategy === "manual" && !validIntent()) return;
  pending.value = "activation";
  await mutation.execute({
    path: "/api/chat/activate",
    body: {
      strategy,
      idempotencyKey: strategy === "starter"
        ? `topic-open:${topicId}:v1`
        : globalThis.crypto.randomUUID(),
      ...(strategy === "starter" ? {} : intentInput.value)
    }
  });
  pending.value = null;
}

function validIntent(): boolean {
  intentError.value = null;
  if (intent.value === "directed" && directedBrief.value.trim() === "") {
    intentError.value = "Discuss a brief requires a conversation goal.";
    return false;
  }
  return true;
}

watch(
  () => ({
    topicId: chatView.value?.chat.topicId,
    messages: chatView.value?.messages.items.length ?? 0,
    agents: activeAgents.value.length,
    state: chatView.value?.conversation.state
  }),
  ({ topicId, messages, agents, state }) => {
    if (topicId === undefined || messages !== 0 || agents === 0 ||
      state !== "starter_pending" || starterAttempts.has(topicId)) return;
    starterAttempts.add(topicId);
    void activate("starter");
  },
  { immediate: true }
);

function mention(agent: LocalAgent) {
  const token = `@${agent.handle} `;
  if (!composer.value.toLocaleLowerCase().includes(`@${agent.handle.toLocaleLowerCase()}`)) {
    composer.value = `${composer.value}${composer.value && !composer.value.endsWith(" ") ? " " : ""}${token}`;
  }
}

function reply(message: ChatTimelineMessage) {
  if (selectedIsLocal.value) replyingTo.value = message;
}

async function handoffToRun(message: ChatTimelineMessage) {
  if (pending.value || !selectedIsLocal.value || message.sender.kind !== "owner") return;
  pending.value = `handoff:${message.eventId}`;
  const receipt = await workHandoffMutation.execute({ eventId: message.eventId });
  pending.value = null;
  if (receipt !== null) {
    await router?.push({ name: "steward", query: { runId: receipt.run.runId } });
  }
}

async function send(body: string) {
  const text = body.trim();
  if (!text || pending.value) return;
  pending.value = "send";
  const topicId = selectedChat.value?.id ?? "local";
  const isLocal = selectedIsLocal.value;
  if (!isLocal) {
    serverSendStates.value[topicId] = "pending";
    serverIntentIds.value[topicId] ??= globalThis.crypto.randomUUID();
  }
  const result = await mutation.execute(isLocal
    ? {
        path: "/api/chat/messages",
        body: {
          body: text,
          ...(replyingTo.value === null ? {} : { replyToEventId: replyingTo.value.eventId })
        }
      }
    : {
        path: "/api/network/topics/human-publish",
        body: {
          topicId,
          transactionId: serverIntentIds.value[topicId],
          message: text
        }
      });
  if (result !== null) {
    drafts.value[topicId] = "";
    replyingTo.value = null;
    if (!isLocal) {
      delete serverIntentIds.value[topicId];
      serverSendStates.value[topicId] = "sent";
    }
    await nextTick();
    chatTimelineRef.value?.scrollToBottom();
  } else if (!isLocal) {
    serverSendStates.value[topicId] = "failed";
  }
  pending.value = null;
}

async function newSession(agent: LocalAgent) {
  if (pending.value) return;
  pending.value = agent.principalId;
  await mutation.execute({
    path: `/api/chat/agents/${encodeURIComponent(agent.principalId)}/new-session`
  });
  pending.value = null;
}

async function refreshAll() {
  await Promise.all([
    refreshChat(),
    presenceQuery.refresh(),
    governanceQuery.refresh(),
    freeChatQuery.refresh(),
    topicSchedulesQuery.refresh(),
    serverTopicsQuery.refresh(),
    networkQuery.refresh()
  ]);
}

async function governanceAction(action: "pause" | "resume" | "resume-and-wake") {
  const expectedRevision = governanceQuery.data.value?.actionAvailability.expectedRevision;
  if (pending.value || expectedRevision === undefined) return;
  pending.value = `governance:${action}`;
  await mutation.execute({
    path: `/api/chat/governance/${action}`,
    body: {
      expectedRevision,
      ...(action === "resume-and-wake"
        ? { idempotencyKey: globalThis.crypto.randomUUID() }
        : {})
    }
  });
  pending.value = null;
}

async function participantAction(action: "add" | "remove", agent: LocalAgent) {
  const expectedRevision = governanceQuery.data.value?.actionAvailability.expectedRevision;
  if (pending.value || expectedRevision === undefined) return;
  pending.value = `participant:${action}:${agent.principalId}`;
  await mutation.execute({
    path: `/api/chat/governance/participants/${encodeURIComponent(agent.principalId)}/${action}`,
    body: { expectedRevision }
  });
  pending.value = null;
}

async function freeChatAction(action: "start" | "continue-now" | "exit") {
  const availability = freeChatQuery.data.value?.actionAvailability;
  if (pending.value || availability === undefined) return;
  if (action === "start" && (!availability.start || !validIntent())) return;
  if (action === "continue-now" && !availability.continueNow) return;
  if (action === "exit" && !availability.exit) return;
  const expectedRevision = availability.expectedRevision;
  if (action !== "start" && expectedRevision === undefined) return;
  pending.value = `free-chat:${action}`;
  await mutation.execute({
    path: `/api/chat/free-chat/${action}`,
    body: action === "start"
      ? { idempotencyKey: globalThis.crypto.randomUUID(), ...intentInput.value }
      : { expectedRevision }
  });
  pending.value = null;
}

async function scheduleCreate(input: {
  kind: "once" | "cron";
  expression: string;
  timezone?: string;
  intent: "continue_recent" | "choose_from_themes" | "directed";
  brief?: string;
}) {
  if (pending.value) return;
  pending.value = "schedule:create";
  await mutation.execute({ path: "/api/chat/schedules", body: input });
  pending.value = null;
}

async function scheduleAction(
  action: "pause" | "resume" | "cancel",
  scheduleId: string
) {
  const entry = topicSchedulesQuery.data.value?.find(
    ({ schedule }) => schedule.scheduleId === scheduleId
  );
  if (pending.value || entry === undefined) return;
  pending.value = `schedule:${action}:${scheduleId}`;
  await mutation.execute({
    path: `/api/chat/schedules/${encodeURIComponent(scheduleId)}/${action}`,
    body: { expectedRevision: entry.schedule.revision }
  });
  pending.value = null;
}

async function joinAgent(handle: string, enrolled: boolean) {
  const topicId = selectedChat.value?.kind === "server" ? selectedChat.value.id : undefined;
  if (pending.value || topicId === undefined) return;
  pending.value = `join:${handle}`;
  if (!enrolled) {
    const enrollment = await mutation.execute({
      path: `/api/network/agents/${encodeURIComponent(handle)}/enroll`
    });
    if (enrollment === null) {
      pending.value = null;
      return;
    }
  }
  const joined = await mutation.execute({
    path: "/api/network/topics/join",
    body: { topicId, handle }
  });
  if (joined !== null) showAgentPicker.value = false;
  pending.value = null;
}

async function setPresence(
  agent: LocalAgent,
  presence: { readonly mode: "available" | "snoozed"; readonly until?: string }
) {
  if (pending.value || agent.status !== "active") return;
  pending.value = `presence:${agent.principalId}`;
  await mutation.execute({
    path: `/api/chat/agents/${encodeURIComponent(agent.principalId)}/presence`,
    body: presence
  });
  pending.value = null;
}

async function setHistoryAccess(agent: LocalAgent, action: "grant" | "revoke") {
  if (pending.value || agent.status !== "active") return;
  pending.value = `history:${agent.principalId}`;
  await mutation.execute({
    path: `/api/chat/agents/${encodeURIComponent(agent.principalId)}/history-access`,
    body: { action }
  });
  pending.value = null;
}
</script>

<template>
  <div class="chats-page">
    <div v-if="loading" class="state">Loading immutable Chat history…</div>
    <div v-else-if="error && !chatView" class="state error" role="alert">
      Could not load Chats: {{ error }}
      <button
        type="button"
        class="secondary-button retry"
        @click="refreshAll"
      >Retry</button>
    </div>
    <div v-else-if="!selectedChat" class="state">No chat available.</div>
    <div v-else class="chats-layout layout-base">
      <section class="panel chat-list-panel">
        <div class="panel-header">Chats</div>
        <ChatList :chats="chats" :selected-id="selectedId" @select="selectedId = $event" />
      </section>

      <section class="panel chat-panel">
        <div v-if="error" class="inline-error" role="alert">{{ error }}</div>
        <details v-if="selectedIsLocal" class="mobile-context">
          <summary>Topic controls, participants & history</summary>
          <ChatGovernancePanel
            :agents="chatView?.agents ?? []"
            :governance="governanceQuery.data.value"
            :schedules="topicSchedulesQuery.data.value ?? []"
            :pending="pending"
            @governance-action="governanceAction"
            @participant-action="participantAction"
            @schedule-action="scheduleAction"
            @schedule-create="scheduleCreate"
          />
          <ChatContextPanel
            :agents="chatView?.agents ?? []"
            :presence-agents="presenceAgents"
            :sessions="chatView?.sessions ?? []"
            :pending="pending"
            @new-session="newSession"
            @set-presence="setPresence"
            @set-history-access="setHistoryAccess"
          />
        </details>
        <ChatTimeline
          ref="chatTimelineRef"
          :chat="selectedChat"
          :messages="visibleMessages"
          :active-agents="activeAgents"
          :current-human-id="currentHumanId"
          :allow-reply="selectedIsLocal"
          :allow-work-handoff="selectedIsLocal"
          @reply="reply"
          @handoff="handoffToRun"
        />
        <div v-if="selectedIsLocal" class="conversation-bar" aria-live="polite">
          <div class="conversation-state">
            <strong>{{ conversationLabel }}</strong>
            <span>{{ conversationExplanation }}</span>
          </div>
          <div class="conversation-controls">
            <label class="intent-control">
              <span>Intent</span>
              <select v-model="intent" aria-label="Conversation intent" :disabled="pending !== null">
                <option value="continue_recent">Continue naturally</option>
                <option value="choose_from_themes">Pick a topic</option>
                <option value="directed">Discuss a brief</option>
              </select>
            </label>
            <input
              v-if="intent === 'directed'"
              v-model="directedBrief"
              class="brief-input"
              type="text"
              maxlength="4096"
              aria-label="Conversation brief"
              placeholder="What should the Agents discuss?"
              :disabled="pending !== null"
            />
            <div class="conversation-actions">
              <span class="budget-label">
                {{ chatView?.conversation.remainingTurns ?? 8 }} of
                {{ chatView?.conversation.turnBudget ?? 8 }} turns left
              </span>
              <template v-if="freeChatQuery.data.value?.mode?.status === 'active'">
                <button
                  type="button"
                  class="secondary-button wake-button"
                  :disabled="pending !== null ||
                    !freeChatQuery.data.value?.actionAvailability.continueNow"
                  @click="freeChatAction('continue-now')"
                >{{ pending === "free-chat:continue-now" ? "Inviting…" : "Continue now" }}</button>
                <button
                  type="button"
                  class="secondary-button wake-button"
                  :disabled="pending !== null || !freeChatQuery.data.value?.actionAvailability.exit"
                  @click="freeChatAction('exit')"
                >{{ pending === "free-chat:exit" ? "Exiting…" : "Exit Free Chat" }}</button>
              </template>
              <template v-else>
                <button
                  type="button"
                  class="secondary-button wake-button"
                  :disabled="pending !== null || activeAgents.length === 0 ||
                    governanceQuery.data.value?.governance.status !== 'active' ||
                    chatView?.conversation.state === 'active'"
                  @click="activate('manual')"
                >{{ pending === "activation" ? "Waking…" : "Wake now" }}</button>
                <button
                  type="button"
                  class="secondary-button wake-button"
                  :disabled="pending !== null ||
                    !freeChatQuery.data.value?.actionAvailability.start"
                  @click="freeChatAction('start')"
                >{{ pending === "free-chat:start" ? "Starting…" : "Start Free Chat" }}</button>
              </template>
            </div>
          </div>
        </div>
        <ChatComposer
          v-model="composer"
          :agents="chatView?.agents ?? []"
          :active-agents="activeAgents"
          :pending="pending"
          :topic-handle="selectedChat.handle"
          :identity-label="selectedIsLocal ? undefined : `Sending as ${currentHumanName}`"
          :reply-to="replyingTo ?? undefined"
          @mention="mention"
          @cancel-reply="replyingTo = null"
          @send="send"
        />
        <div v-if="!selectedIsLocal" class="server-send-state" aria-live="polite">
          <span v-if="serverSendState === 'pending'">Publishing to Server…</span>
          <span v-else-if="serverSendState === 'sent'">Sent as Human.</span>
          <span v-else-if="serverSendState === 'failed'" class="send-failed">Not sent. Your draft is preserved; retry when ready.</span>
          <span v-else>You speak as Human; only Agents join the Topic.</span>
        </div>
      </section>

      <section class="panel context-panel">
        <div class="panel-header context-header">
          <span>{{ selectedIsLocal ? "Topic controls" : "Topic Agents" }}</span>
          <button
            v-if="!selectedIsLocal"
            type="button"
            class="icon-button"
            aria-label="Add Agent to Topic"
            title="Add Agent to Topic"
            @click="showAgentPicker = !showAgentPicker"
          >+</button>
        </div>
        <template v-if="selectedIsLocal">
          <ChatGovernancePanel
            :agents="chatView?.agents ?? []"
            :governance="governanceQuery.data.value"
            :schedules="topicSchedulesQuery.data.value ?? []"
            :pending="pending"
            @governance-action="governanceAction"
            @participant-action="participantAction"
            @schedule-action="scheduleAction"
            @schedule-create="scheduleCreate"
          />
          <ChatContextPanel
            :agents="chatView?.agents ?? []"
            :presence-agents="presenceAgents"
            :sessions="chatView?.sessions ?? []"
            :pending="pending"
            @new-session="newSession"
            @set-presence="setPresence"
            @set-history-access="setHistoryAccess"
          />
        </template>
        <div v-else class="topic-agent-panel">
          <div v-if="networkQuery.error.value" class="inline-error" role="alert">
            {{ networkQuery.error.value }}
          </div>
          <div v-if="topicAgents.length" class="topic-agent-list">
            <div v-for="agent in topicAgents" :key="agent.handle" class="topic-agent-row">
              <span class="agent-path">{{ agent.namespace }}</span>
              <span class="status-badge">Joined</span>
            </div>
          </div>
          <div v-else class="state topic-empty">
            No Agents have joined this Topic.
            <button
              type="button"
              class="primary-button"
              @click="showAgentPicker = true"
            >Add Agent</button>
          </div>
          <div v-if="showAgentPicker" class="agent-picker">
            <div class="picker-title">Add Agent</div>
            <div v-if="joinCandidates.length" class="topic-agent-list">
              <button
                v-for="agent in joinCandidates"
                :key="agent.handle"
                type="button"
                class="agent-option"
                :disabled="pending !== null"
                @click="joinAgent(agent.handle, agent.enrolled)"
              >
                <span class="agent-path">{{ agent.namespace }}</span>
                <span class="option-action">{{ agent.enrolled ? "Join" : "Enroll & join" }}</span>
              </button>
            </div>
            <div v-else class="picker-empty">Every active Local Agent has joined.</div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.chats-layout {
  grid-template-columns: 260px 1fr 280px;
  height: calc(100vh - 170px);
  height: calc(100dvh - 170px);
}
.chat-panel { display: flex; flex-direction: column; height: 100%; }
.chat-list-panel { height: 100%; }
.context-panel { height: 100%; overflow-y: auto; }
.context-header { display: flex; align-items: center; justify-content: space-between; }
.icon-button {
  width: 24px;
  height: 24px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-1);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 17px;
  line-height: 1;
}
.topic-agent-panel { padding: 12px; }
.topic-agent-list { display: grid; gap: 8px; }
.topic-agent-row,
.agent-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-1);
}
.agent-option { width: 100%; color: inherit; text-align: left; cursor: pointer; }
.agent-option:disabled { cursor: wait; opacity: 0.6; }
.agent-path { min-width: 0; overflow-wrap: anywhere; font-size: 12px; }
.status-badge,
.option-action { flex: 0 0 auto; color: var(--text-secondary); font-size: 10px; }
.topic-empty { display: grid; justify-items: center; gap: 12px; padding: 24px 8px; }
.agent-picker { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
.picker-title { margin-bottom: 8px; color: var(--text-secondary); font-size: 11px; font-weight: 700; text-transform: uppercase; }
.picker-empty { color: var(--text-secondary); font-size: 12px; }
.inline-error { padding: 9px 16px; background: var(--danger-soft); color: var(--danger); border-bottom: 1px solid #fecaca; }
.conversation-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 9px 16px;
  border-top: 1px solid var(--border);
  background: var(--surface-2);
}
.conversation-state { display: grid; gap: 2px; min-width: 0; }
.conversation-state strong { font-size: 12px; }
.conversation-state span,
.budget-label { color: var(--text-secondary); font-size: 11px; }
.conversation-controls { display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-width: 0; }
.intent-control { display: flex; align-items: center; gap: 5px; color: var(--text-secondary); font-size: 10px; }
.intent-control select,
.brief-input {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 7px;
  background: var(--surface-1);
  color: var(--text-primary);
  font: inherit;
  font-size: 11px;
}
.brief-input { width: min(220px, 24vw); }
.conversation-actions { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.wake-button { white-space: nowrap; }
.mobile-context { display: none; border-bottom: 1px solid var(--border); }
.mobile-context > summary {
  padding: 9px 16px;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 700;
}
.retry { margin-left: 12px; }
.server-send-state {
  padding: 7px 16px;
  border-top: 1px solid var(--border);
  color: var(--text-secondary);
  background: var(--surface-2);
  font-size: 11px;
}
.send-failed { color: var(--danger); }

@media (max-width: 1100px) {
  .chats-layout { grid-template-columns: 220px 1fr; }
  .context-panel { display: none; }
  .mobile-context { display: block; }
}
@media (max-width: 768px) {
  .chats-layout {
    grid-template-columns: 1fr;
    height: calc(100vh - 230px);
    height: calc(100dvh - 230px);
    min-height: 480px;
  }
  .chat-list-panel { display: none; }
  .chat-panel { min-height: 0; }
  .conversation-bar { align-items: flex-start; }
  .conversation-controls { display: grid; justify-items: end; }
  .conversation-actions { justify-content: flex-end; }
  .conversation-state span { max-width: 34ch; }
  .brief-input { width: min(240px, 42vw); }
}
@media (max-width: 520px) {
  .conversation-bar { display: grid; gap: 8px; }
  .conversation-controls { justify-items: stretch; }
  .intent-control { justify-content: space-between; }
  .brief-input { width: 100%; box-sizing: border-box; }
  .conversation-actions { justify-content: space-between; }
}
</style>
