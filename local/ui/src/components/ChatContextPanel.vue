<script setup lang="ts">
import { computed } from "vue";
import type { LocalAgent, LocalChatSession } from "@/types/local";

const props = defineProps<{
  agents: readonly LocalAgent[];
  sessions: readonly LocalChatSession[];
  pending: string | null;
}>();

const emit = defineEmits<{
  (e: "newSession", agent: LocalAgent): void;
}>();

const sessionMap = computed(() => {
  const map = new Map<string, LocalChatSession>();
  for (const session of props.sessions) {
    map.set(session.principalId, session);
  }
  return map;
});

const agentsWithSession = computed(() =>
  props.agents.map((agent) => ({
    agent,
    session: sessionMap.value.get(agent.principalId)
  }))
);
</script>

<template>
  <div class="context-body">
    <div v-if="agents.length === 0" class="state">No Local Agents.</div>
    <article
      v-for="{ agent, session } in agentsWithSession"
      v-else
      :key="agent.principalId"
      class="session-row"
    >
      <div>
        <strong>@{{ agent.handle }}</strong>
        <span class="agent-status" :class="agent.status">{{ agent.status }}</span>
      </div>
      <span class="mono session-id">
        {{ session?.currentSessionId ?? "new on next dispatch" }}
      </span>
      <span>Generation {{ session?.generation ?? 1 }}</span>
      <button
        class="secondary-button"
        type="button"
        :disabled="agent.status !== 'active' || pending !== null"
        @click="emit('newSession', agent)"
      >
        {{ pending === agent.principalId ? "Starting…" : "New session" }}
      </button>
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
.session-row > div { display: flex; justify-content: space-between; gap: 8px; color: var(--text); }
.agent-status { font-size: 10px; text-transform: uppercase; font-weight: 700; }
.agent-status.active { color: var(--success); }
.agent-status.suspended { color: var(--muted); }
.session-id { font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
