<script setup lang="ts">
import { computed, ref } from "vue";
import type {
  ChatPresence,
  LocalAgent,
  LocalChatPresenceAgent,
  LocalChatSession
} from "@/types/local";

const props = defineProps<{
  agents: readonly LocalAgent[];
  presenceAgents: readonly LocalChatPresenceAgent[];
  sessions: readonly LocalChatSession[];
  pending: string | null;
}>();

const emit = defineEmits<{
  (e: "newSession", agent: LocalAgent): void;
  (
    e: "setPresence",
    agent: LocalAgent,
    presence: { readonly mode: "available" | "snoozed"; readonly until?: string }
  ): void;
  (e: "setHistoryAccess", agent: LocalAgent, action: "grant" | "revoke"): void;
}>();

const editingPresenceId = ref<string | null>(null);
const snoozeUntil = ref("");
const editorError = ref<string | null>(null);

const sessionMap = computed(() => {
  const map = new Map<string, LocalChatSession>();
  for (const session of props.sessions) {
    map.set(session.principalId, session);
  }
  return map;
});

const presenceMap = computed(() => {
  const map = new Map<string, LocalChatPresenceAgent>();
  for (const presence of props.presenceAgents) {
    map.set(presence.principalId, presence);
  }
  return map;
});

const agentsWithSession = computed(() =>
  [...props.agents]
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === "active" ? -1 : 1;
      return left.handle.localeCompare(right.handle);
    })
    .map((agent) => ({
      agent,
      session: sessionMap.value.get(agent.principalId)
    }))
);

function clientLabel(agent: LocalAgent): string {
  switch (agent.client) {
    case "codex": return "Codex";
    case "claude-code": return "Claude Code";
    case "kimi-code": return "Kimi";
    case "pi": return "Pi";
    default: return agent.client;
  }
}

function activeSnooze(presence: ChatPresence | undefined): ChatPresence | undefined {
  if (presence?.mode !== "snoozed" || presence.until === undefined) return undefined;
  return Date.parse(presence.until) > Date.now() ? presence : undefined;
}

function presenceState(agent: LocalAgent): {
  readonly label: string;
  readonly kind: "listening" | "snoozed" | "global" | "suspended";
  readonly editable: boolean;
} {
  if (agent.status === "suspended") {
    return { label: "Suspended", kind: "suspended", editable: false };
  }
  const presence = presenceMap.value.get(agent.principalId);
  const globalSnooze = activeSnooze(presence?.global);
  if (globalSnooze !== undefined) {
    return { label: "Snoozed globally", kind: "global", editable: false };
  }
  const topicSnooze = activeSnooze(presence?.topic);
  if (topicSnooze !== undefined) {
    return {
      label: `Snoozed · until ${formatUntil(topicSnooze.until!)}`,
      kind: "snoozed",
      editable: true
    };
  }
  return { label: "Listening", kind: "listening", editable: true };
}

function lastTurnLabel(agent: LocalAgent): string {
  const turn = presenceMap.value.get(agent.principalId)?.lastTurn;
  if (turn === undefined) return "No turn yet";
  if (turn.state === "thinking") return "Thinking now";
  if (turn.state === "replied") return "Last turn · contributed";
  if (turn.state === "silent") {
    return `Last turn · stayed silent${turn.reason === undefined ? "" : ` · ${turn.reason}`}`;
  }
  return "Last turn · execution failed";
}

function historyDetail(agent: LocalAgent): string {
  const history = presenceMap.value.get(agent.principalId)?.clientHistory;
  if (history?.status !== "active") return "Off";
  const coverage = history.coverage === "available"
    ? history.truncated
      ? "Available · bounded result"
      : "Available"
    : history.coverage === "unavailable"
      ? "Source unavailable"
      : history.coverage === "unsupported"
        ? "Source unsupported"
        : history.coverage === "error"
          ? "Last request failed"
          : "Allowed · checked on first use";
  const result = history.lastResultCount === undefined
    ? ""
    : ` · ${history.lastResultCount} result${history.lastResultCount === 1 ? "" : "s"}`;
  return `${clientLabel(agent)} only · ${coverage}${result}`;
}

function openPresenceEditor(agent: LocalAgent) {
  if (!presenceState(agent).editable || props.pending !== null) return;
  editingPresenceId.value = editingPresenceId.value === agent.principalId
    ? null
    : agent.principalId;
  editorError.value = null;
  const existing = activeSnooze(presenceMap.value.get(agent.principalId)?.topic);
  snoozeUntil.value = toLocalDateTimeInput(
    existing?.until ?? new Date(Date.now() + 60 * 60 * 1_000).toISOString()
  );
}

function setListening(agent: LocalAgent) {
  emit("setPresence", agent, { mode: "available" });
  editingPresenceId.value = null;
  editorError.value = null;
}

function setSnoozed(agent: LocalAgent) {
  const until = new Date(snoozeUntil.value);
  if (!Number.isFinite(until.getTime()) || until.getTime() <= Date.now()) {
    editorError.value = "Choose a future time.";
    return;
  }
  emit("setPresence", agent, { mode: "snoozed", until: until.toISOString() });
  editingPresenceId.value = null;
  editorError.value = null;
}

function formatUntil(value: string): string {
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
  <div class="context-body">
    <div v-if="agents.length === 0" class="state">No Local Agents.</div>
    <article
      v-for="{ agent, session } in agentsWithSession"
      v-else
      :key="agent.principalId"
      class="session-row"
      :class="{ suspended: agent.status === 'suspended' }"
    >
      <div class="agent-line">
        <span class="identity">
          <strong>@{{ agent.handle }}</strong>
          <span class="client-label">{{ clientLabel(agent) }}</span>
        </span>
        <button
          v-if="presenceState(agent).editable"
          type="button"
          class="presence-control"
          :class="presenceState(agent).kind"
          :disabled="pending !== null"
          @click="openPresenceEditor(agent)"
        >
          {{ pending === `presence:${agent.principalId}` ? "Saving…" : presenceState(agent).label }}
        </button>
        <span
          v-else
          class="presence-control static"
          :class="presenceState(agent).kind"
        >{{ presenceState(agent).label }}</span>
      </div>
      <div v-if="editingPresenceId === agent.principalId" class="presence-editor">
        <button
          type="button"
          class="secondary-button"
          :disabled="pending !== null"
          @click="setListening(agent)"
        >Listening</button>
        <input
          v-model="snoozeUntil"
          type="datetime-local"
          aria-label="Snooze until"
          :disabled="pending !== null"
        />
        <button
          type="button"
          class="secondary-button"
          :disabled="pending !== null"
          @click="setSnoozed(agent)"
        >Snooze</button>
        <span v-if="editorError" class="editor-error">{{ editorError }}</span>
      </div>
      <div class="turn-state">{{ lastTurnLabel(agent) }}</div>
      <div class="history-row">
        <span>
          Client history
          <small>{{ historyDetail(agent) }}</small>
        </span>
        <button
          type="button"
          class="secondary-button"
          :class="{ danger: presenceMap.get(agent.principalId)?.clientHistory?.status === 'active' }"
          :disabled="agent.status !== 'active' || pending !== null"
          @click="emit(
            'setHistoryAccess',
            agent,
            presenceMap.get(agent.principalId)?.clientHistory?.status === 'active'
              ? 'revoke'
              : 'grant'
          )"
        >
          {{ pending === `history:${agent.principalId}`
            ? "Saving…"
            : presenceMap.get(agent.principalId)?.clientHistory?.status === "active"
              ? "Revoke"
              : "Allow" }}
        </button>
      </div>
      <details class="session-details">
        <summary>Session continuity</summary>
        <div>
          <span>{{ session?.currentSessionId ? "Existing session" : "New on next turn" }}</span>
          <span>Generation {{ session?.generation ?? 1 }}</span>
          <button
            class="secondary-button"
            type="button"
            :disabled="agent.status !== 'active' || pending !== null"
            @click="emit('newSession', agent)"
          >
            {{ pending === agent.principalId ? "Starting…" : "Start fresh" }}
          </button>
        </div>
      </details>
    </article>
  </div>
</template>

<style scoped>
.context-body { overflow-y: auto; }
.session-row {
  padding: 13px 16px;
  display: grid;
  gap: 6px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-secondary);
}
.session-row:last-child { border-bottom: 0; }
.session-row.suspended { opacity: .58; }
.agent-line { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--text); }
.identity { display: inline-flex; align-items: baseline; gap: 7px; min-width: 0; }
.client-label { color: var(--text-dim); font-size: 10px; white-space: nowrap; }
.presence-control {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 11px;
  white-space: nowrap;
}
button.presence-control { cursor: pointer; }
button.presence-control:hover:not(:disabled) { color: var(--primary); }
.presence-control.listening { color: var(--success); }
.presence-control.snoozed,
.presence-control.global { color: var(--warning); }
.presence-control.suspended { color: var(--muted); }
.presence-editor {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 6px;
  align-items: center;
}
.presence-editor input {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 6px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 11px;
}
.editor-error { grid-column: 1 / -1; color: var(--danger); }
.turn-state { color: var(--text-dim); font-size: 10px; }
.history-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 4px;
  padding-top: 9px;
  border-top: 1px solid var(--border);
  color: var(--text);
}
.history-row span { display: grid; gap: 2px; }
.history-row small { color: var(--text-dim); font-size: 10px; }
.session-details summary { cursor: pointer; color: var(--text-dim); font-size: 11px; }
.session-details > div {
  display: grid;
  gap: 6px;
  margin-top: 8px;
  padding-left: 10px;
  border-left: 2px solid var(--border);
}
</style>
