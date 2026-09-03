<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from "vue";
import { routerKey } from "vue-router";
import { boundedError, requestJson } from "@/api/client";
import {
  errorResponseSchema,
  chatRunHandoffReceiptSchema,
  chatRunProposalDecisionReceiptSchema,
  chatRunProposalPreflightSchema,
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
import type {
  ChatRunProposal,
  ChatRunWorkspaceSelection,
  LocalAgent
} from "@/types/local";

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
const proposalOperations = ref<Record<string, "preflight" | "start" | "decline">>({});
const proposalErrors = ref<Record<string, string>>({});
const proposalOverlays = ref<Record<string, {
  readonly sourceRevision: string;
  readonly proposal: ChatRunProposal;
}>>({});
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
  mutation.error.value ?? workHandoffMutation.error.value ??
  loadError.value ?? presenceQuery.error.value ??
  governanceQuery.error.value ?? topicSchedulesQuery.error.value
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
  if (selectedIsLocal.value) {
    return (chatView.value?.messages.items ?? []).map((message) => {
      const source = message.runProposals;
      if (source === undefined) return message;
      return {
        ...message,
        runProposals: source.map((proposal) => {
          const overlay = proposalOverlays.value[proposal.proposalId];
          return overlay?.sourceRevision === proposal.revision
            ? overlay.proposal
            : proposal;
        })
      };
    });
  }
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

async function preflightProposal(
  proposal: ChatRunProposal,
  selection: ChatRunWorkspaceSelection
) {
  if (!selectedIsLocal.value || proposalOperations.value[proposal.proposalId] !== undefined) {
    return;
  }
  proposalOperations.value[proposal.proposalId] = "preflight";
  delete proposalErrors.value[proposal.proposalId];
  const sourceRevision = proposalOverlays.value[proposal.proposalId]?.sourceRevision ??
    proposal.revision;
  try {
    const receipt = await requestJson(
      proposalActionPath(proposal, "preflight"),
      chatRunProposalPreflightSchema,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Rollerskate-Request": "console"
        },
        body: JSON.stringify({ revision: sourceRevision, ...workspaceBody(selection) })
      }
    );
    proposalOverlays.value[proposal.proposalId] = {
      sourceRevision: receipt.sourceRevision,
      proposal: receipt.proposal
    };
  } catch (reason) {
    if (selection !== undefined) delete proposalOverlays.value[proposal.proposalId];
    proposalErrors.value[proposal.proposalId] = boundedError(reason);
  } finally {
    delete proposalOperations.value[proposal.proposalId];
  }
}

async function confirmProposal(
  proposal: ChatRunProposal,
  selection?: ChatRunWorkspaceSelection
) {
  if (!selectedIsLocal.value || !proposal.ready || proposal.linkedRun !== undefined ||
    proposalOperations.value[proposal.proposalId] !== undefined) return;
  proposalOperations.value[proposal.proposalId] = "start";
  delete proposalErrors.value[proposal.proposalId];
  try {
    await requestJson(
      proposalActionPath(proposal, "confirm"),
      chatRunHandoffReceiptSchema,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Rollerskate-Request": "console"
        },
        body: JSON.stringify({
          revision: proposal.revision,
          ...(selection === undefined ? {} : workspaceBody(selection))
        })
      }
    );
    delete proposalOverlays.value[proposal.proposalId];
    await Promise.all([refreshChat(), presenceQuery.refresh()]);
  } catch (reason) {
    delete proposalOverlays.value[proposal.proposalId];
    proposalErrors.value[proposal.proposalId] = boundedError(reason);
  } finally {
    delete proposalOperations.value[proposal.proposalId];
  }
}

async function declineProposal(proposal: ChatRunProposal) {
  if (!selectedIsLocal.value || proposal.linkedRun !== undefined ||
    proposal.decision !== undefined ||
    proposalOperations.value[proposal.proposalId] !== undefined) return;
  proposalOperations.value[proposal.proposalId] = "decline";
  delete proposalErrors.value[proposal.proposalId];
  const revision = proposalOverlays.value[proposal.proposalId]?.sourceRevision ??
    proposal.revision;
  try {
    await requestJson(
      proposalActionPath(proposal, "decline"),
      chatRunProposalDecisionReceiptSchema,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Rollerskate-Request": "console"
        },
        body: JSON.stringify({ revision })
      }
    );
    delete proposalOverlays.value[proposal.proposalId];
    await refreshChat();
  } catch (reason) {
    proposalErrors.value[proposal.proposalId] = boundedError(reason);
  } finally {
    delete proposalOperations.value[proposal.proposalId];
  }
}

function proposalActionPath(
  proposal: ChatRunProposal,
  action: "preflight" | "confirm" | "decline"
) {
  const messageId = encodeURIComponent(proposal.sourceMessageEventId);
  const dispatchId = encodeURIComponent(proposal.dispatchEventId);
  return `/api/chat/proposals/${messageId}/${dispatchId}/${action}`;
}

function workspaceBody(selection: ChatRunWorkspaceSelection) {
  return selection.kind === "path"
    ? { workspaceKind: selection.kind, workspacePath: selection.path }
    : { workspaceKind: selection.kind };
}

async function openRun(runId: string) {
  await router?.push({ name: "steward", query: { runId } });
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
    topicSchedulesQuery.refresh(),
    serverTopicsQuery.refresh(),
    networkQuery.refresh()
  ]);
}

async function governanceAction(action: "pause" | "resume") {
  const expectedRevision = governanceQuery.data.value?.actionAvailability.expectedRevision;
  if (pending.value || expectedRevision === undefined) return;
  pending.value = `governance:${action}`;
  await mutation.execute({
    path: `/api/chat/governance/${action}`,
    body: { expectedRevision }
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
          :pending="pending"
          :proposal-operations="proposalOperations"
          :proposal-errors="proposalErrors"
          @reply="reply"
          @handoff="handoffToRun"
          @preflight-proposal="preflightProposal"
          @confirm-proposal="confirmProposal"
          @decline-proposal="declineProposal"
          @open-run="openRun"
        />
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
}
</style>
