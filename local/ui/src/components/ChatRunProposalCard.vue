<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { formatDateTime } from "@/utils/format";
import type {
  ChatRunProposal,
  ChatRunWorkspaceSelection
} from "@/types/local";

const props = defineProps<{
  proposal: ChatRunProposal;
  operation?: "preflight" | "start" | "decline";
  error?: string;
}>();

const emit = defineEmits<{
  preflight: [proposal: ChatRunProposal, selection: ChatRunWorkspaceSelection];
  start: [proposal: ChatRunProposal, selection?: ChatRunWorkspaceSelection];
  decline: [proposal: ChatRunProposal];
  openRun: [runId: string];
}>();

const selectedKind = ref<ChatRunWorkspaceSelection["kind"]>(
  props.proposal.selectedWorkspace?.kind ?? "project"
);
const customPath = ref(
  props.proposal.selectedWorkspace?.kind === "path"
    ? props.proposal.selectedWorkspace.root
    : ""
);

watch(() => props.proposal.selectedWorkspace, (selected) => {
  if (selected === undefined) return;
  selectedKind.value = selected.kind;
  if (selected.kind === "path") customPath.value = selected.root;
});

const effectLabel = computed(() => {
  const effect = props.proposal.finalForm.desiredEffect;
  if (effect === "change") return "Will modify files";
  if (effect === "read") return "Read files";
  if (effect === "none") return "No workspace access";
  return "Effect needs clarification";
});

const runStateLabel = computed(() => {
  const linked = props.proposal.linkedRun;
  if (linked === undefined) {
    if (props.proposal.decision?.status === "declined") return "Declined";
    if (props.proposal.ready) return "Ready for Owner";
    if (props.proposal.blocker?.code === "workspace_required" ||
      props.proposal.blocker?.code === "workspace_invalid") return "Needs workspace";
    if (props.proposal.blocker?.code === "clarification_required") return "Needs clarification";
    return "Blocked";
  }
  if (linked.state === "needs_human") return "Run needs human · blocked";
  if (linked.state === "terminal") return `Run ${linked.status.replaceAll("_", " ")}`;
  return `Run started · ${linked.status.replaceAll("_", " ")}`;
});

const workspaceSelection = computed<ChatRunWorkspaceSelection | undefined>(() => {
  if (props.proposal.workspaceChoices === undefined) return undefined;
  return selectedKind.value === "path"
    ? { kind: "path", path: customPath.value.trim() }
    : { kind: selectedKind.value };
});

const selectedChoice = computed(() => props.proposal.workspaceChoices?.find(
  ({ kind }) => kind === selectedKind.value
));

const workspaceAdmitted = computed(() => {
  const selected = props.proposal.selectedWorkspace;
  if (!props.proposal.ready || selected === undefined || selected.kind !== selectedKind.value) {
    return false;
  }
  return selected.kind !== "path" || customPath.value.trim() === selected.root;
});

const canPreflight = computed(() => {
  const selection = workspaceSelection.value;
  return selection !== undefined &&
    (selection.kind !== "path" || selection.path !== "") &&
    props.operation === undefined;
});

function preflight() {
  const selection = workspaceSelection.value;
  if (selection !== undefined && canPreflight.value) {
    emit("preflight", props.proposal, selection);
  }
}
</script>

<template>
  <section
    class="run-proposal"
    :class="{
      blocked: !proposal.ready,
      linked: proposal.linkedRun !== undefined,
      declined: proposal.decision?.status === 'declined',
      terminal: proposal.linkedRun?.state === 'terminal'
    }"
    :aria-label="`Run proposal from @${proposal.chatLead.handle}`"
  >
    <header class="proposal-header">
      <div>
        <div class="proposal-eyebrow">Run proposal</div>
        <strong>{{ runStateLabel }}</strong>
      </div>
      <span class="effect-chip">{{ effectLabel }}</span>
    </header>

    <div
      v-if="proposal.blocker && !proposal.linkedRun && !proposal.decision"
      class="proposal-blocker"
      role="status"
    >
      <strong>{{ proposal.blocker.code === "workspace_required" ? "Workspace required" : "Blocked" }}</strong>
      <span>{{ proposal.blocker.message }}</span>
      <span v-if="proposal.blocker.action === 'reply'" class="blocker-hint">Reply in Chat with the missing decision.</span>
      <details v-if="proposal.blocker.detail">
        <summary>Technical details</summary>
        <code>{{ proposal.blocker.detail }}</code>
      </details>
    </div>

    <div v-if="error" class="proposal-error" role="alert">{{ error }}</div>

    <div
      v-if="proposal.workspaceChoices && !proposal.linkedRun && !proposal.decision"
      class="workspace-control"
    >
      <label>
        <span class="section-label">Workspace authority</span>
        <select v-model="selectedKind" :disabled="operation !== undefined">
          <option
            v-for="choice in proposal.workspaceChoices"
            :key="choice.kind"
            :value="choice.kind"
          >{{ choice.label }}</option>
        </select>
      </label>
      <label v-if="selectedKind === 'path'">
        <span class="section-label">Absolute Git workspace path</span>
        <input
          v-model="customPath"
          type="text"
          autocomplete="off"
          placeholder="/absolute/path/to/repository"
          :disabled="operation !== undefined"
          @keyup.enter="preflight"
        />
      </label>
      <div v-else-if="selectedChoice?.root" class="workspace-candidate">
        {{ selectedChoice.root }}
      </div>
      <div v-if="workspaceAdmitted && proposal.authority?.workspace" class="workspace-admitted">
        <span>Verified {{ proposal.authority.workspace.access }} authority</span>
        <strong>{{ proposal.authority.workspace.root }}</strong>
        <code>{{ proposal.authority.workspace.revision }}</code>
        <span>Network access off</span>
      </div>
      <button
        v-if="!workspaceAdmitted"
        type="button"
        class="secondary-action"
        :disabled="!canPreflight"
        @click="preflight"
      >{{ operation === "preflight" ? "Checking…" : "Use workspace" }}</button>
    </div>

    <div class="proposal-section goal-section">
      <span class="section-label">Goal</span>
      <p>{{ proposal.finalForm.goal ?? "Goal needs clarification" }}</p>
    </div>

    <div class="proposal-columns">
      <div class="proposal-section">
        <span class="section-label">In scope</span>
        <ul v-if="proposal.finalForm.scope.include.length">
          <li v-for="item in proposal.finalForm.scope.include" :key="item">{{ item }}</li>
        </ul>
        <span v-else class="empty-value">Needs clarification</span>
      </div>
      <div v-if="proposal.finalForm.scope.exclude.length" class="proposal-section">
        <span class="section-label">Out of scope</span>
        <ul>
          <li v-for="item in proposal.finalForm.scope.exclude" :key="item">{{ item }}</li>
        </ul>
      </div>
    </div>

    <div class="proposal-section">
      <span class="section-label">Acceptance</span>
      <ul v-if="proposal.finalForm.acceptance.length">
        <li v-for="item in proposal.finalForm.acceptance" :key="item">{{ item }}</li>
      </ul>
      <span v-else class="empty-value">Needs clarification</span>
    </div>

    <dl class="roles">
      <div>
        <dt>Chat Lead</dt>
        <dd>@{{ proposal.chatLead.handle }}</dd>
      </div>
      <div>
        <dt>Run Orchestrator</dt>
        <dd>{{ proposal.runOrchestrator ? `@${proposal.runOrchestrator.handle}` : "Unavailable" }}</dd>
      </div>
      <div>
        <dt>Participants</dt>
        <dd>{{ proposal.participants.map(({ handle }) => `@${handle}`).join(", ") || "None" }}</dd>
      </div>
    </dl>

    <div v-if="proposal.linkedRun" class="linked-run" aria-live="polite">
      <div>
        <span class="section-label">Run</span>
        <strong>{{ proposal.linkedRun.runId }}</strong>
        <p v-if="proposal.linkedRun.terminalSummary">{{ proposal.linkedRun.terminalSummary }}</p>
      </div>
      <button
        type="button"
        class="secondary-action"
        @click="emit('openRun', proposal.linkedRun.runId)"
      >Open Run</button>
    </div>
    <div v-else-if="proposal.decision" class="proposal-decision" aria-live="polite">
      <span>Declined by Owner</span>
      <time :datetime="proposal.decision.decidedAt">
        {{ formatDateTime(proposal.decision.decidedAt) }}
      </time>
    </div>
    <div v-else class="proposal-action-row">
      <span>
        {{ proposal.ready && (proposal.workspaceChoices === undefined || workspaceAdmitted)
          ? "Only this revision authorizes the exact effect above."
          : "This proposal has not been authorized." }}
      </span>
      <div class="proposal-actions">
        <button
          v-if="proposal.ready && (proposal.workspaceChoices === undefined || workspaceAdmitted)"
          type="button"
          class="start-action"
          :disabled="operation !== undefined"
          @click="emit('start', proposal, workspaceSelection)"
        >{{ operation === "start" ? "Starting…" : "Start Run" }}</button>
        <button
          type="button"
          class="decline-action"
          :disabled="operation !== undefined"
          @click="emit('decline', proposal)"
        >{{ operation === "decline" ? "Declining…" : "Decline proposal" }}</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.run-proposal {
  margin-top: 12px;
  padding: 13px;
  border: 1px solid color-mix(in srgb, var(--primary) 38%, var(--border));
  border-left: 3px solid var(--primary);
  border-radius: 8px;
  background: color-mix(in srgb, var(--primary-soft) 28%, var(--surface));
  display: grid;
  gap: 12px;
}
.run-proposal.blocked { border-left-color: var(--warning); }
.run-proposal.linked { border-left-color: var(--success); }
.run-proposal.declined { border-left-color: var(--text-dim); background: var(--surface-2); }
.run-proposal.terminal { background: var(--surface-2); }
.proposal-header, .proposal-action-row, .linked-run {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.proposal-eyebrow, .section-label, dt {
  color: var(--text-dim);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .07em;
  text-transform: uppercase;
}
.effect-chip {
  padding: 3px 7px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 700;
}
.proposal-section { display: grid; gap: 4px; min-width: 0; }
.proposal-section p, .linked-run p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.goal-section p { font-weight: 650; }
.proposal-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
ul { margin: 0; padding-left: 18px; color: var(--text-secondary); }
li + li { margin-top: 3px; }
.empty-value { color: var(--text-dim); }
.roles { margin: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.roles div { min-width: 0; }
dt { margin-bottom: 3px; }
dd { margin: 0; overflow-wrap: anywhere; }
.proposal-blocker {
  display: grid;
  gap: 2px;
  padding: 9px 10px;
  border-radius: 6px;
  background: var(--warning-soft);
  color: var(--text-secondary);
}
.proposal-blocker strong { color: var(--warning); }
.blocker-hint { color: var(--text-dim); font-size: 11px; }
.proposal-blocker details { margin-top: 3px; }
.proposal-blocker code { display: block; margin-top: 5px; overflow-wrap: anywhere; white-space: pre-wrap; }
.proposal-error {
  padding: 9px 10px;
  border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border));
  border-radius: 6px;
  background: var(--danger-soft);
  color: var(--danger);
}
.workspace-control { display: grid; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); }
.workspace-control label { display: grid; gap: 5px; }
.workspace-control select, .workspace-control input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 8px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
}
.workspace-candidate, .workspace-admitted { color: var(--text-dim); font-size: 11px; overflow-wrap: anywhere; }
.workspace-admitted { display: grid; gap: 3px; padding: 8px; border-radius: 6px; background: var(--success-soft); }
.workspace-admitted strong, .workspace-admitted code { color: var(--text-secondary); overflow-wrap: anywhere; }
.workspace-control > .secondary-action { justify-self: end; }
.proposal-action-row, .linked-run {
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.proposal-action-row > span { color: var(--text-dim); font-size: 11px; }
.proposal-actions { display: flex; align-items: center; gap: 8px; }
.proposal-decision {
  display: flex; justify-content: space-between; gap: 12px; padding-top: 10px;
  border-top: 1px solid var(--border); color: var(--text-dim); font-size: 11px;
}
.linked-run > div { min-width: 0; display: grid; gap: 2px; }
.linked-run strong { overflow-wrap: anywhere; }
.start-action, .secondary-action, .decline-action {
  flex-shrink: 0;
  border-radius: 6px;
  padding: 7px 10px;
  font: inherit;
  font-weight: 750;
  cursor: pointer;
}
.start-action { border: 1px solid var(--primary); background: var(--primary); color: white; }
.secondary-action { border: 1px solid var(--border); background: var(--surface); color: var(--primary); }
.decline-action { border: 1px solid var(--border); background: transparent; color: var(--text-secondary); }
.start-action:disabled, .secondary-action:disabled, .decline-action:disabled { cursor: wait; opacity: .65; }
@media (max-width: 720px) {
  .proposal-columns, .roles { grid-template-columns: 1fr; }
  .proposal-header, .proposal-action-row, .linked-run { align-items: flex-start; flex-direction: column; }
  .proposal-actions { width: 100%; flex-direction: column; align-items: stretch; }
  .start-action, .secondary-action, .decline-action { width: 100%; }
  .workspace-control > .secondary-action { justify-self: stretch; }
}
</style>
