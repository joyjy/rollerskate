<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { formatDateTime } from "@/utils/format";
import ChatReadProgress from "./ChatReadProgress.vue";
import ChatRunProposalCard from "./ChatRunProposalCard.vue";
import type { ChatListItem, ChatTimelineMessage } from "@/types/chat";
import type {
  ChatRunProposal,
  ChatRunWorkspaceSelection,
  LocalAgent
} from "@/types/local";

const props = defineProps<{
  chat: ChatListItem | null;
  messages: readonly ChatTimelineMessage[];
  activeAgents: readonly LocalAgent[];
  currentHumanId?: string;
  allowReply?: boolean;
  pending?: string | null;
  proposalOperations?: Readonly<Record<string, "preflight" | "start" | "decline">>;
  proposalSourceRevisions?: Readonly<Record<string,string>>;
  proposalErrors?: Readonly<Record<string, string>>;
  pendingMessage?: { readonly eventId: string; readonly body: string; readonly createdAt: string };
}>();

const emit = defineEmits<{
  reply: [message: ChatTimelineMessage];
  preflightProposal: [proposal: ChatRunProposal, selection: ChatRunWorkspaceSelection, resolution?: ChatRunProposal["resolution"]];
  confirmProposal: [proposal: ChatRunProposal, selection?: ChatRunWorkspaceSelection];
  declineProposal: [proposal: ChatRunProposal];
  openRun: [runId: string];
  requestRecovery: [runId: string, requestId: string];
  recoveryChanged: [];
  clarifyProposal: [message: ChatTimelineMessage, proposal: ChatRunProposal, workspacePath?: string];
}>();

type TimelineItem =
  | { kind: "message"; message: ChatTimelineMessage }
  | { kind: "system"; message: ChatTimelineMessage }
  | { kind: "pending"; message: NonNullable<typeof props.pendingMessage> };

const timelineItems = computed<TimelineItem[]>(() => {
  const items: TimelineItem[] = props.messages.map((message) => ({
    kind: message.sender.kind === "system" ? "system" : "message",
    message
  }));
  if (props.pendingMessage !== undefined) {
    items.push({kind: "pending", message: props.pendingMessage});
  }
  return items;
});

const timelineContentKey = computed(() => props.messages.map((message) => [
  message.eventId,
  message.body,
  message.works?.map((work) => [
    work.runId,
    work.state,
    work.status,
    work.updatedAt,
    work.attentionReason,
    work.terminalSummary
  ].join("\u0000")).join("\u0001"),
  message.runProposals?.map((proposal) => [
    proposal.proposalId,
    proposal.revision,
    proposal.linkedRun?.state,
    proposal.linkedRun?.status,
    proposal.linkedRun?.updatedAt,
    proposal.linkedRun?.terminalSummary,
    proposal.linkedRun?.attentionReason
  ].join("\u0000")).join("\u0001")
].join("\u0002")).join("\u0003"));

const timeline = ref<HTMLElement | null>(null);
const timelineContent = ref<HTMLElement | null>(null);
const followingLatest = ref(true);
const hasNewerContent = ref(false);
let contentObserver: ResizeObserver | null = null;
let observedContentHeight: number | undefined;

function scrollToBottom() {
  const el = timeline.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  followingLatest.value = true;
  hasNewerContent.value = false;
}

function isNearBottom() {
  const el = timeline.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function onScroll() {
  followingLatest.value = isNearBottom();
  if (followingLatest.value) hasNewerContent.value = false;
}

function noteContentChange() {
  if (followingLatest.value) {
    scrollToBottom();
  } else {
    hasNewerContent.value = true;
  }
}

function senderLabel(message: ChatTimelineMessage) {
  if (message.sender.kind === "owner") return "You";
  if (message.sender.kind === "human" &&
    message.sender.principalId === props.currentHumanId) {
    return `${message.sender.handleSnapshot} · You`;
  }
  return message.sender.handleSnapshot;
}

function referencedMessage(message: ChatTimelineMessage) {
  return message.replyToEventId === undefined
    ? undefined
    : props.messages.find((candidate) => candidate.eventId === message.replyToEventId);
}

function replyRuns(message: ChatTimelineMessage) {
  const runs = new Map<string, { runId: string; status: string }>();
  for (const reply of props.messages) {
    if (reply.sender.kind !== "owner" || reply.replyToEventId !== message.eventId) continue;
    for (const work of reply.works ?? []) runs.set(work.runId, work);
    for (const proposal of reply.runProposals ?? []) {
      if (proposal.linkedRun) runs.set(proposal.linkedRun.runId, proposal.linkedRun);
    }
  }
  return [...runs.values()];
}

const activeTaskAnchors = computed(() => {
  const anchors: Array<{ id: string; eventId: string; label: string }> = [];
  for (const message of props.messages) {
    for (const proposal of message.runProposals ?? []) {
      if (proposal.linkedRun === undefined || proposal.linkedRun.state === "terminal") continue;
      anchors.push({
        id: proposal.proposalId,
        eventId: message.eventId,
        label: proposal.finalForm.goal ?? proposal.linkedRun.runId
      });
    }
    for (const work of message.works ?? []) {
      if (work.state === "terminal") continue;
      anchors.push({id: work.runId, eventId: message.eventId, label: work.label ?? work.runId});
    }
  }
  return anchors;
});

function scrollToMessage(eventId: string) {
  const target = Array.from(
    timeline.value?.querySelectorAll<HTMLElement>("[data-event-id]") ?? []
  )
    .find((element) => element.dataset.eventId === eventId);
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
  target?.focus({ preventScroll: true });
}

function preflightProposal(
  proposal: ChatRunProposal,
  selection: ChatRunWorkspaceSelection,
  resolution?: ChatRunProposal["resolution"]
) {
  emit("preflightProposal", proposal, selection, resolution);
}

function confirmProposal(
  proposal: ChatRunProposal,
  selection?: ChatRunWorkspaceSelection
) {
  emit("confirmProposal", proposal, selection);
}

function declineProposal(proposal: ChatRunProposal) {
  emit("declineProposal", proposal);
}

function workKind(work: NonNullable<ChatTimelineMessage["works"]>[number]) {
  return work.kind ?? "agent";
}

function returnStateLabel(work: NonNullable<ChatTimelineMessage["works"]>[number]) {
  const status = work.returnState?.status;
  if (status === undefined) return undefined;
  if (status === "waiting_origin") return "Waiting for origin";
  if (status === "waiting_agent") return "Waiting for Agent";
  if (status === "agent_pending") return "Agent pending";
  if (status === "turn_completed") return "Agent turn completed · verify task evidence";
  if (status === "blocked") {
    return "Blocked";
  }
  return status.replaceAll("_", " ");
}

function returnReason(reason: string) {
  const labels: Record<string, string> = {
    participant_unavailable: "The responsible Agent is unavailable or no longer participating.",
    session_changed: "The responsible Agent has moved to a new session.",
    session_busy: "Waiting for the responsible Agent to finish its current turn.",
    origin_missing: "The original conversation is unavailable.",
    origin_session_missing: "The original Agent session is unavailable.",
    origin_session_pending: "Waiting for the original Agent session to be recorded.",
    responsible_turn_failed: "The responsible Agent could not complete its return turn.",
    activation_failed: "The return could not be admitted.",
    activation_not_dispatched: "The return was admitted but no Agent turn could start."
  };
  return labels[reason] ?? reason;
}

watch(() => [
  timelineContentKey.value,
  props.pendingMessage?.eventId,
  props.pendingMessage?.body,
  props.pendingMessage?.createdAt
] as const, async () => {
  const followedBeforeUpdate = followingLatest.value;
  await nextTick();
  if (followedBeforeUpdate) scrollToBottom();
  else hasNewerContent.value = true;
});

onMounted(() => {
  scrollToBottom();
  if (typeof ResizeObserver !== "undefined" && timelineContent.value !== null) {
    contentObserver = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (height === undefined) return;
      if (observedContentHeight !== undefined && height > observedContentHeight) noteContentChange();
      observedContentHeight = height;
    });
    contentObserver.observe(timelineContent.value);
  }
});

onBeforeUnmount(() => contentObserver?.disconnect());

defineExpose({ scrollToBottom, scrollToMessage });
</script>

<template>
  <div class="chat-header">
    <div class="chat-title">
      <div class="eyebrow">{{ chat?.kind === "server" ? "Server Topic" : "Local Topic" }}</div>
      <h1>{{ chat?.handle ?? "—" }}</h1>
    </div>
    <div class="chat-header-meta">
      <span>{{ activeAgents.length }} active Agent{{ activeAgents.length === 1 ? "" : "s" }}</span>
      <span class="status-dot">{{ chat?.kind === "server" ? "server" : "local only" }}</span>
    </div>
  </div>

  <div v-if="activeTaskAnchors.length" class="active-task-jump" aria-label="In-progress tasks">
    <span>In progress</span>
    <button v-for="task in activeTaskAnchors" :key="task.id" type="button" @click="scrollToMessage(task.eventId)">
      {{ task.label }}
    </button>
  </div>

  <div v-if="messages.length === 0 && pendingMessage === undefined" class="state">
    <strong>{{ chat?.kind === "server" ? "No messages yet." : "Local is ready." }}</strong>
    <div v-if="chat?.kind === 'server'">This Topic is visible to you even before an Agent joins.</div>
    <div v-else>Mention an Agent, or send freely to the Agents who are listening.</div>
  </div>
  <div v-else ref="timeline" class="timeline" aria-live="polite" @scroll="onScroll">
    <div ref="timelineContent" class="timeline-content">
    <template v-for="item in timelineItems" :key="item.message.eventId">
      <article
        v-if="item.kind === 'message'"
        class="message"
        :class="item.message.sender.kind"
        :data-event-id="item.message.eventId"
        tabindex="-1"
      >
        <div class="avatar">{{ item.message.sender.handleSnapshot.slice(0, 1).toUpperCase() }}</div>
        <div class="message-content">
          <div class="message-head">
            <strong>{{ senderLabel(item.message) }}</strong>
            <div class="message-meta">
              <span>{{ formatDateTime(item.message.createdAt) }}</span>
              <ChatReadProgress v-if="item.message.sender.kind === 'owner'" :progress="item.message.readProgress" />
              <button
                v-if="allowReply"
                type="button"
                class="reply-action"
                @click="emit('reply', item.message)"
              >Reply</button>
            </div>
          </div>
          <button
            v-if="item.message.replyToEventId"
            type="button"
            class="reply-reference"
            :disabled="referencedMessage(item.message) === undefined"
            @click="scrollToMessage(item.message.replyToEventId)"
          >
            <strong>{{ referencedMessage(item.message)?.sender.handleSnapshot ?? "Referenced message" }}</strong>
            <span>{{ referencedMessage(item.message)?.body ?? "Message not in loaded history" }}</span>
          </button>
          <p>{{ item.message.body }}</p>
          <div v-if="item.message.targets" class="target-chip">
            to {{ item.message.targets.map((target) => `@${target.handleSnapshot}`).join(", ") }}
          </div>
          <section v-for="work in item.message.works ?? []" :key="work.runId" class="chat-work" aria-live="polite">
            <div class="chat-work-head">
              <strong>
                {{ work.humanQuestion?.status === "pending"
                  ? "Waiting for your answer"
                  : work.humanQuestion?.status === "expired"
                    ? "Question expired"
                    : work.capabilityRequest?.status === "pending"
                      ? "Capability request pending"
                      : work.capabilityRequest?.status === "expired"
                        ? "Capability request expired"
                        : work.state === "needs_human"
                          ? "Run needs human"
                          : `Run ${work.status.replaceAll('_', ' ')}` }}
              </strong>
              <span class="work-kind">{{ workKind(work) }}</span>
            </div>
            <div v-if="work.returnState" class="work-return-state" role="status">
              Return: {{ returnStateLabel(work) }}
            </div>
            <p>{{ work.label }}</p>
            <p v-if="work.attentionReason && work.attentionReason !== work.humanQuestion?.question &&
              work.attentionReason !== work.capabilityRequest?.reason">{{ work.attentionReason }}</p>
            <p v-if="work.capabilityRequest?.status === 'pending' || work.capabilityRequest?.status === 'expired'" class="work-attention">
              {{ work.capabilityRequest.reason }}
            </p>
            <p v-if="work.humanQuestion?.status === 'pending' || work.humanQuestion?.status === 'expired'" class="work-attention">
              {{ work.humanQuestion.question }}
            </p>
            <p v-if="work.returnState?.reason" class="work-return-reason">{{ returnReason(work.returnState.reason) }}</p>
            <p v-if="work.terminalSummary">{{ work.terminalSummary }}</p>
            <ul aria-label="Run outputs"><li v-for="output in work.outputs ?? []" :key="output.outputId">{{ output.title }}</li></ul>
            <button type="button" class="open-run-action" @click="emit('openRun', work.detail?.runId ?? work.runId)">
              Open Run details
            </button>
          </section>
          <ChatRunProposalCard
            v-for="proposal in item.message.runProposals ?? []"
            :key="proposal.proposalId"
            :proposal="proposal"
            :source-revision="proposalSourceRevisions?.[proposal.proposalId]"
            :operation="proposalOperations?.[proposal.proposalId]"
            :error="proposalErrors?.[proposal.proposalId]"
            :reply-runs="replyRuns(item.message)"
            :recovery-pending="pending === 'recovery'"
            @preflight="preflightProposal"
            @start="confirmProposal"
            @decline="declineProposal"
            @request-recovery="(runId, requestId) => emit('requestRecovery', runId, requestId)"
            @recovery-changed="emit('recoveryChanged')"
            @open-run="emit('openRun', $event)"
            @clarify="(proposal, path) => emit('clarifyProposal', item.message, proposal, path)"
          />
        </div>
      </article>

      <article v-else-if="item.kind === 'pending'" class="message owner pending-message" aria-live="polite">
        <div class="avatar">Y</div>
        <div class="message-content">
          <div class="message-head"><strong>You</strong><div class="message-meta"><span>Sending…</span></div></div>
          <p>{{ item.message.body }}</p>
        </div>
      </article>

      <div v-else-if="item.kind === 'system'" class="system-message">
        <div class="system-card">
          <span>{{ item.message.body }}</span>
        </div>
      </div>
    </template>
    </div>
    <button v-if="hasNewerContent" type="button" class="new-content-button" @click="scrollToBottom">
      New messages or task updates · Show latest
    </button>
  </div>
</template>

<style scoped>
.chat-work { margin-top: 12px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; overflow-wrap: anywhere; }
.chat-work-head { display: flex; align-items: center; gap: 8px; }
.work-kind { padding: 2px 6px; border-radius: 999px; background: var(--muted-soft); color: var(--text-secondary); font-size: 10px; font-weight: 700; text-transform: uppercase; }
.work-return-state { margin-top: 5px; color: var(--text-secondary); font-size: 11px; text-transform: capitalize; }
.work-attention { color: var(--warning); }
.work-return-reason { color: var(--text-secondary); }
.open-run-action { border: 1px solid var(--border); border-radius: 6px; padding: 5px 9px; background: var(--surface); color: var(--primary); cursor: pointer; }
.chat-work p { margin: 6px 0; }
.chat-header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-shrink: 0;
}
.chat-title h1 { margin: 0; font-size: 20px; line-height: 1.2; }
.eyebrow { color: var(--primary); font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.chat-header-meta { display: flex; gap: 12px; color: var(--text-secondary); font-size: 12px; }
.status-dot::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 5px; border-radius: 50%; background: var(--success); }
.active-task-jump { display: flex; align-items: center; gap: 7px; overflow-x: auto; padding: 7px 16px; border-bottom: 1px solid var(--border); background: var(--surface-2); color: var(--text-secondary); font-size: 11px; flex-shrink: 0; }
.active-task-jump > span { flex: 0 0 auto; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.active-task-jump button { max-width: 220px; overflow: hidden; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--primary); cursor: pointer; font: inherit; padding: 3px 8px; text-overflow: ellipsis; white-space: nowrap; }
.timeline { position: relative; flex: 1; overflow-y: auto; padding: 16px 20px; }
.timeline-content { min-width: 0; }
.new-content-button { position: sticky; bottom: 8px; display: block; margin: 8px auto 0; border: 1px solid var(--primary); border-radius: 999px; background: var(--surface); color: var(--primary); cursor: pointer; font: inherit; font-size: 12px; padding: 6px 10px; box-shadow: 0 2px 10px rgb(0 0 0 / 12%); }
.pending-message { opacity: .72; }
.message {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr);
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.message:focus { outline: 2px solid var(--primary-soft); outline-offset: -2px; }
.reply-action {
  border: 0; background: transparent; color: var(--primary); cursor: pointer; opacity: 0; padding: 0;
}
.message:hover .reply-action, .message:focus-within .reply-action { opacity: 1; }
.reply-reference {
  display: grid; gap: 2px; width: 100%; margin: 6px 0; padding: 7px 9px;
  border: 0; border-left: 3px solid var(--primary); border-radius: 4px;
  background: var(--surface-2); color: var(--text-secondary); text-align: left; cursor: pointer;
}
.reply-reference span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reply-reference:disabled { cursor: default; }
.avatar {
  width: 34px; height: 34px; display: grid; place-items: center;
  border-radius: 8px; background: var(--muted-soft); color: var(--text-secondary); font-weight: 800;
}
.message.agent .avatar { background: var(--success-soft); color: var(--success); }
.message.human .avatar { background: var(--primary-soft); color: var(--primary); }
.message-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.message-head span { color: var(--text-dim); font-size: 11px; }
.message-meta { display: flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; flex-wrap: wrap; }
.message p { margin: 3px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.target-chip {
  display: inline-block;
  margin-top: 7px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 11px;
  font-weight: 700;
}
.system-message {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}
@media (max-width: 640px) {
  .timeline { padding: 12px; }
  .message-head { align-items: flex-start; flex-wrap: wrap; }
  .message-meta { min-width: 0; max-width: 100%; flex-shrink: 1; flex-wrap: wrap; justify-content: flex-start; }
  .message-meta > span:first-child { white-space: nowrap; }
  .reply-action { opacity: 1; }
}
</style>
