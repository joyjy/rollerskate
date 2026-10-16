<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type {
  TopicActivationScheduleViewOutput,
  TopicGovernanceViewOutput
} from "@/api/schema";
import type { LocalAgent, LocalChatPresenceAgent, LocalChatSession } from "@/types/local";
import ChatContextPanel from "./ChatContextPanel.vue";

const props = defineProps<{
  agents: readonly LocalAgent[];
  presenceAgents?: readonly LocalChatPresenceAgent[];
  sessions?: readonly LocalChatSession[];
  governance: TopicGovernanceViewOutput | null;
  schedules: readonly TopicActivationScheduleViewOutput[];
  pending: string | null;
}>();

const emit = defineEmits<{
  (e: "newSession", agent: LocalAgent): void;
  (e: "setPresence", agent: LocalAgent, presence: { readonly mode: "available" | "snoozed"; readonly until?: string }): void;
  (e: "setHistoryAccess", agent: LocalAgent, action: "grant" | "revoke"): void;
  (e: "setWebSearchAccess", agent: LocalAgent, action: "grant" | "revoke"): void;
  (e: "governanceAction", action: "pause" | "resume"): void;
  (e: "participantAction", action: "add" | "remove", agent: LocalAgent): void;
  (e: "scheduleAction", action: "pause" | "resume" | "cancel", scheduleId: string): void;
  (e: "scheduleCreate", input: {
    kind: "once" | "cron";
    expression: string;
    timezone?: string;
    intent: "continue_recent" | "choose_from_themes" | "directed";
    brief?: string;
  }): void;
}>();

const showScheduleForm = ref(false);
const scheduleKind = ref<"once" | "cron">("once");
const onceAt = ref(toLocalDateTimeInput(new Date(Date.now() + 60 * 60 * 1_000).toISOString()));
const cronExpression = ref("0 9 * * 1-5");
const timezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
const scheduleIntent = ref<"continue_recent" | "choose_from_themes" | "directed">(
  "continue_recent"
);
const scheduleBrief = ref("");
const formError = ref<string | null>(null);
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  timer = setInterval(() => { now.value = Date.now(); }, 1_000);
});
onBeforeUnmount(() => {
  if (timer !== undefined) clearInterval(timer);
});

const participantMap = computed(() => new Map(
  props.governance?.governance.participants.map((entry) => [entry.agentId, entry]) ?? []
));

const sortedAgents = computed(() => [...props.agents].sort((left, right) =>
  left.handle.localeCompare(right.handle)));

function participantLabel(agent: LocalAgent): string {
  const participant = participantMap.value.get(agent.principalId);
  if (participant?.status !== "active") return "Not participating";
  return agent.status === "active" ? "Participating" : "Participant · suspended";
}

function canAdd(agent: LocalAgent): boolean {
  return props.governance?.actionAvailability.participantAddAgentIds
    .includes(agent.principalId) ?? false;
}

function canRemove(agent: LocalAgent): boolean {
  return props.governance?.actionAvailability.participantRemoveAgentIds
    .includes(agent.principalId) ?? false;
}

function submitSchedule() {
  formError.value = null;
  let expression: string;
  if (scheduleKind.value === "once") {
    const instant = new Date(onceAt.value);
    if (!Number.isFinite(instant.getTime()) || instant.getTime() <= Date.now()) {
      formError.value = "Choose a future time.";
      return;
    }
    expression = instant.toISOString();
  } else {
    expression = cronExpression.value.trim();
    if (expression === "" || timezone.value.trim() === "") {
      formError.value = "Cron and timezone are required.";
      return;
    }
  }
  const brief = scheduleBrief.value.trim();
  if (scheduleIntent.value === "directed" && brief === "") {
    formError.value = "Directed intent needs a brief.";
    return;
  }
  emit("scheduleCreate", {
    kind: scheduleKind.value,
    expression,
    ...(scheduleKind.value === "cron" ? { timezone: timezone.value.trim() } : {}),
    intent: scheduleIntent.value,
    ...(scheduleIntent.value === "directed" ? { brief } : {})
  });
}

function scheduleSummary(entry: TopicActivationScheduleViewOutput): string {
  const schedule = entry.schedule;
  if (schedule.nextRunAt === undefined) return "No future occurrence";
  return `${countdown(schedule.nextRunAt)} · ${formatDateTime(schedule.nextRunAt)}`;
}

function latestReceipt(entry: TopicActivationScheduleViewOutput): string {
  const receipt = entry.receipts.at(-1);
  if (receipt === undefined) return "No receipt yet";
  return receipt.reason === undefined
    ? receipt.action.replaceAll("_", " ")
    : `${receipt.action.replaceAll("_", " ")} · ${receipt.reason}`;
}

function countdown(value: string): string {
  const remaining = Math.max(0, Date.parse(value) - now.value);
  const totalMinutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, "0")}m`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function toLocalDateTimeInput(value: string): string {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
</script>

<template>
  <div class="governance-panel">
    <section class="control-section">
      <div class="section-heading">
        <span>Topic</span>
        <span
          class="status-pill"
          :class="governance?.governance.status === 'active' ? 'ok' : 'degraded'"
        >{{ governance?.governance.status ?? "Unavailable" }}</span>
      </div>
      <p class="section-note">
        Pause stops new conversation attention, not the Runtime or an already running turn.
      </p>
      <div class="button-row">
        <button
          v-if="governance?.actionAvailability.pause"
          type="button"
          class="secondary-button danger"
          :disabled="pending !== null"
          @click="emit('governanceAction', 'pause')"
        >{{ pending === "governance:pause" ? "Pausing…" : "Pause Topic" }}</button>
        <template v-else-if="governance?.actionAvailability.resume">
          <button
            type="button"
            class="secondary-button"
            :disabled="pending !== null"
            @click="emit('governanceAction', 'resume')"
          >{{ pending === "governance:resume" ? "Resuming…" : "Resume" }}</button>
        </template>
      </div>
      <small v-if="governance?.recentReceipts.at(-1)" class="receipt-line">
        Last control · {{ governance.recentReceipts.at(-1)?.action.replaceAll("_", " ") }}
      </small>
    </section>

    <section class="control-section">
      <div class="section-heading">
        <span>Participants</span>
        <span>{{ governance?.activeParticipantAgentIds.length ?? 0 }}</span>
      </div>
      <div class="participant-list">
        <article v-for="agent in sortedAgents" :key="agent.principalId" class="participant-entry">
          <div class="participant-row">
          <span>
            <strong>@{{ agent.handle }}</strong>
            <small>{{ participantLabel(agent) }}</small>
          </span>
          <button
            v-if="canRemove(agent)"
            type="button"
            class="text-button danger-text"
            :disabled="pending !== null"
            @click="emit('participantAction', 'remove', agent)"
          >{{ pending === `participant:remove:${agent.principalId}` ? "Removing…" : "Remove" }}</button>
          <button
            v-else-if="canAdd(agent)"
            type="button"
            class="text-button"
            :disabled="pending !== null"
            @click="emit('participantAction', 'add', agent)"
          >{{ pending === `participant:add:${agent.principalId}` ? "Adding…" : "Add" }}</button>
          </div>
          <details v-if="participantMap.get(agent.principalId)?.status === 'active'" class="participant-tools">
            <summary :aria-label="`Tools and session for @${agent.handle}`">Tools & session</summary>
            <ChatContextPanel
              compact
              :agents="[agent]"
              :presence-agents="presenceAgents ?? []"
              :sessions="sessions ?? []"
              :pending="pending"
              @new-session="emit('newSession', $event)"
              @set-presence="(agent, presence) => emit('setPresence', agent, presence)"
              @set-history-access="(agent, action) => emit('setHistoryAccess', agent, action)"
              @set-web-search-access="(agent, action) => emit('setWebSearchAccess', agent, action)"
            />
          </details>
        </article>
      </div>
      <p class="section-note">RS history is built in: search all currently joined Topics. Removing a participant revokes access to this Topic. Client history and web search follow each Agent’s settings.</p>
    </section>

    <section class="control-section">
      <div class="section-heading">
        <span>Scheduled activation</span>
        <button
          type="button"
          class="text-button"
          :disabled="pending !== null"
          @click="showScheduleForm = !showScheduleForm"
        >{{ showScheduleForm ? "Close" : "Add" }}</button>
      </div>
      <div v-if="schedules.length" class="schedule-list">
        <article v-for="entry in schedules" :key="entry.schedule.scheduleId" class="schedule-row">
          <div class="schedule-title">
            <strong>{{ entry.schedule.kind === "once" ? "Once" : "Recurring" }}</strong>
            <span class="status-pill" :class="entry.schedule.status === 'active' ? 'ok' : ''">
              {{ entry.schedule.status }}
            </span>
          </div>
          <span>{{ scheduleSummary(entry) }}</span>
          <small>{{ latestReceipt(entry) }}</small>
          <div v-if="entry.schedule.status === 'active' || entry.schedule.status === 'paused'" class="button-row compact">
            <button
              v-if="entry.schedule.status === 'active'"
              type="button"
              class="secondary-button"
              :disabled="pending !== null"
              @click="emit('scheduleAction', 'pause', entry.schedule.scheduleId)"
            >Pause</button>
            <button
              v-else
              type="button"
              class="secondary-button"
              :disabled="pending !== null"
              @click="emit('scheduleAction', 'resume', entry.schedule.scheduleId)"
            >Resume</button>
            <button
              type="button"
              class="secondary-button danger"
              :disabled="pending !== null"
              @click="emit('scheduleAction', 'cancel', entry.schedule.scheduleId)"
            >Cancel</button>
          </div>
        </article>
      </div>
      <p v-else class="section-note">No scheduled conversation.</p>

      <form v-if="showScheduleForm" class="schedule-form" @submit.prevent="submitSchedule">
        <label>
          Timing
          <select v-model="scheduleKind" :disabled="pending !== null">
            <option value="once">Once</option>
            <option value="cron">Recurring cron</option>
          </select>
        </label>
        <label v-if="scheduleKind === 'once'">
          Start at
          <input v-model="onceAt" type="datetime-local" :disabled="pending !== null" />
        </label>
        <template v-else>
          <label>
            Cron
            <input v-model="cronExpression" type="text" :disabled="pending !== null" />
          </label>
          <label>
            Timezone
            <input v-model="timezone" type="text" :disabled="pending !== null" />
          </label>
        </template>
        <label>
          Conversation intent
          <select v-model="scheduleIntent" :disabled="pending !== null">
            <option value="continue_recent">Continue naturally</option>
            <option value="choose_from_themes">Pick a topic</option>
            <option value="directed">Discuss a brief</option>
          </select>
        </label>
        <label v-if="scheduleIntent === 'directed'">
          Brief
          <textarea v-model="scheduleBrief" rows="2" maxlength="4096" :disabled="pending !== null" />
        </label>
        <span v-if="formError" class="form-error">{{ formError }}</span>
        <button type="submit" class="primary-button" :disabled="pending !== null">
          {{ pending === "schedule:create" ? "Creating…" : "Create schedule" }}
        </button>
      </form>
    </section>
  </div>
</template>

<style scoped>
.governance-panel { border-bottom: 1px solid var(--border); }
.control-section { display: grid; gap: 8px; padding: 13px 16px; border-bottom: 1px solid var(--border); }
.control-section:last-child { border-bottom: 0; }
.section-heading,
.schedule-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.section-heading { color: var(--text); font-size: 12px; font-weight: 700; }
.section-note,
.receipt-line { margin: 0; color: var(--text-dim); font-size: 10px; line-height: 1.4; }
.button-row { display: flex; flex-wrap: wrap; gap: 6px; }
.button-row.compact .secondary-button { padding: 4px 7px; font-size: 10px; }
.participant-list,
.schedule-list { display: grid; gap: 6px; }
.participant-entry { border-bottom: 1px solid var(--border); padding: 7px 0; }
.participant-entry:last-child { border-bottom: 0; }
.participant-tools { margin-top: 6px; }
.participant-tools > summary { cursor: pointer; color: var(--text-dim); font-size: 11px; padding: 3px 0; }
.participant-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.participant-row > span { display: grid; gap: 1px; min-width: 0; }
.participant-row small,
.schedule-row > span,
.schedule-row > small { color: var(--text-dim); font-size: 10px; overflow-wrap: anywhere; }
.text-button { border: 0; padding: 2px; background: transparent; color: var(--primary); font: inherit; font-size: 11px; cursor: pointer; }
.text-button:disabled { cursor: wait; opacity: .55; }
.danger-text { color: var(--danger); }
.schedule-row { display: grid; gap: 5px; padding: 9px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-1); }
.schedule-title strong { color: var(--text); font-size: 11px; }
.schedule-form { display: grid; gap: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
.schedule-form label { display: grid; gap: 4px; color: var(--text-secondary); font-size: 10px; }
.schedule-form input,
.schedule-form select,
.schedule-form textarea {
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 7px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 11px;
}
.form-error { color: var(--danger); font-size: 10px; }
.status-pill { text-transform: capitalize; }
</style>
