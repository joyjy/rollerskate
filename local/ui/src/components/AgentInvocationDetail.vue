<script setup lang="ts">
import { computed } from "vue";

import type {
  AgentInvocationDiagnosticsOutput,
  AgentStepResultOutput,
  AgentTurnResultOutput
} from "@/api/schema";
import { formatDateTime } from "@/utils/format";

const props = defineProps<{
  agent: { principalId: string; handle: string; client: string; status: string } | null | undefined;
  status: string;
  createdAt: string;
  completedAt?: string | null;
  prompt?: string;
  effectivePrompt?: string | null;
  result?: AgentTurnResultOutput | AgentStepResultOutput | null;
  rawOutput?: string | null;
  error?: string | null;
  invocation?: AgentInvocationDiagnosticsOutput | null;
  requestEventId?: string;
  resultEventId?: string | null;
  expanded?: boolean;
  expandRawOutput?: boolean;
}>();

const displayPrompt = computed(() =>
  props.effectivePrompt && props.effectivePrompt.length > 0
    ? props.effectivePrompt
    : props.prompt
);
const hasProductPrompt = computed(() =>
  Boolean(props.prompt) &&
  props.prompt !== props.effectivePrompt
);
const hasRawOutput = computed(() =>
  Boolean(props.rawOutput) && props.rawOutput!.length > 0
);
const hasError = computed(() => Boolean(props.error));

const statusClass = computed(() => {
  if (props.status === "succeeded") return "success";
  if (props.status === "failed") return "failed";
  if (props.status === "running") return "running";
  if (props.status === "queued") return "queued";
  return "";
});

const timing = computed(() => {
  const started = props.invocation?.startedAt;
  const completed = props.completedAt ?? props.invocation?.completedAt;
  const duration = props.invocation?.durationMilliseconds;
  const parts: string[] = [];
  if (started) parts.push(`started ${formatDateTime(started)}`);
  if (completed) parts.push(`completed ${formatDateTime(completed)}`);
  if (duration !== undefined && Number.isFinite(duration)) {
    parts.push(`${duration}ms`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
});

function statLabel(value: number | undefined | null): string | number {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return "Unavailable";
  }
  return value;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(6)}`;
}

const tokens = computed(() => {
  const usage = props.invocation?.tokenUsage;
  return {
    input: statLabel(usage?.inputTokens),
    output: statLabel(usage?.outputTokens),
    cacheRead: statLabel(usage?.cacheReadTokens),
    cacheCreation: statLabel(usage?.cacheCreationTokens),
    total: statLabel(usage?.totalTokens),
    cost: usage?.costUsd === undefined || usage.costUsd === null
      ? "Unavailable"
      : formatUsd(usage.costUsd)
  };
});

const toolUsage = computed(() => props.invocation?.toolUsage);
const turnCount = computed(() => statLabel(props.invocation?.turnCount));
const toolCallsSummary = computed(() => {
  const usage = toolUsage.value;
  if (usage === undefined) return "Unavailable";
  const total = usage.reduce((count, tool) => count + tool.count, 0);
  return `${total} tool call${total === 1 ? "" : "s"}`;
});
</script>

<template>
  <details class="step-disclosure" :open="expanded">
    <summary>
      <div class="step-summary">
        <div class="invocation-agent">
          <span class="agent-handle">@{{ agent?.handle ?? "unknown" }}</span>
          <span class="agent-client">{{ agent?.client ?? "—" }}</span>
        </div>
        <div class="summary-meta">
          <span class="status-badge" :class="statusClass">{{ status }}</span>
          <span v-if="timing" class="timing-detail">{{ timing }}</span>
          <span class="tool-summary">tools · {{ toolCallsSummary }}</span>
        </div>
      </div>
    </summary>
    <div class="agent-invocation-detail">
      <div class="invocation-timing">
        <span>created {{ formatDateTime(createdAt) }}</span>
      </div>

      <div v-if="requestEventId || resultEventId" class="invocation-ids">
        <span v-if="requestEventId" class="id-pill">
          <span class="id-label">request</span>
          <span class="mono">{{ requestEventId }}</span>
        </span>
        <span v-if="resultEventId" class="id-pill">
          <span class="id-label">result</span>
          <span class="mono">{{ resultEventId }}</span>
        </span>
      </div>

      <div class="section-title">Prompt sent to Agent</div>
      <div class="prompt-block">
        <pre v-if="displayPrompt" class="prompt-body">{{ displayPrompt }}</pre>
        <div v-else class="empty-inline">No prompt recorded.</div>
        <details v-if="hasProductPrompt" class="product-prompt">
          <summary>Product prompt</summary>
          <pre class="prompt-body secondary">{{ prompt }}</pre>
        </details>
      </div>

      <template v-if="result">
        <div class="section-title">{{ result.schemaVersion }}</div>
        <div
          v-if="result.schemaVersion === 'AgentStepResult@1'"
          class="result-card"
          :class="result.outcome"
        >
          <div class="result-action">
            <span class="action-badge">worker step</span>
            <span class="outcome-badge" :class="result.outcome">{{ result.outcome }}</span>
          </div>
          <div class="result-summary">{{ result.summary }}</div>
          <div v-if="result.acceptanceEvidence?.length" class="artifact-list">
            <span class="label">Evidence</span>
            <span v-for="item in result.acceptanceEvidence" :key="item" class="artifact-pill">{{ item }}</span>
          </div>
          <div v-if="result.unresolvedQuestions?.length" class="artifact-list">
            <span class="label">Unresolved</span>
            <span v-for="item in result.unresolvedQuestions" :key="item" class="artifact-pill">{{ item }}</span>
          </div>
          <div v-if="result.artifactRefs.length > 0" class="artifact-list">
            <span class="label">Artifacts</span>
            <span v-for="ref in result.artifactRefs" :key="ref" class="artifact-pill mono">{{ ref }}</span>
          </div>
        </div>
        <div v-else class="result-card" :class="result.action === 'complete' ? result.outcome : 'delegate'">
          <div class="result-action">
            <span class="action-badge">{{ result.action }}</span>
            <span v-if="result.action === 'complete'" class="outcome-badge" :class="result.outcome">
              {{ result.outcome }}
            </span>
            <span v-else class="outcome-badge delegate">
              {{ result.mandate.kind }}
            </span>
          </div>
          <div v-if="result.action === 'delegate'" class="result-target">
            <span class="label">Target</span>
            <span class="mono">{{ result.targetAgentId }}</span>
          </div>
          <div v-if="result.action === 'delegate' && result.mandate.kind === 'workflow'" class="result-target">
            <span class="label">Workflow</span>
            <span class="mono">{{ result.mandate.workflowRef }}</span>
          </div>
          <div class="result-summary">{{ result.summary }}</div>
          <div v-if="result.artifactRefs.length > 0" class="artifact-list">
            <span class="label">Artifacts</span>
            <span v-for="ref in result.artifactRefs" :key="ref" class="artifact-pill mono">{{ ref }}</span>
          </div>
        </div>
      </template>

      <details v-if="hasRawOutput" class="raw-response" :open="expandRawOutput">
        <summary>Raw Agent response</summary>
        <pre class="raw-body">{{ rawOutput }}</pre>
      </details>

      <div v-if="hasError" class="error-block">
        <strong>Error</strong>
        <pre class="error-body">{{ error }}</pre>
      </div>

      <div class="section-title">Invocation statistics</div>
      <div class="stats-grid">
        <div class="stat-cell">
          <span class="stat-label">Input tokens</span>
          <span class="stat-value">{{ tokens.input }}</span>
        </div>
        <div class="stat-cell">
          <span class="stat-label">Output tokens</span>
          <span class="stat-value">{{ tokens.output }}</span>
        </div>
        <div class="stat-cell">
          <span class="stat-label">Cache read</span>
          <span class="stat-value">{{ tokens.cacheRead }}</span>
        </div>
        <div class="stat-cell">
          <span class="stat-label">Cache creation</span>
          <span class="stat-value">{{ tokens.cacheCreation }}</span>
        </div>
        <div class="stat-cell">
          <span class="stat-label">Total tokens</span>
          <span class="stat-value">{{ tokens.total }}</span>
        </div>
        <div class="stat-cell">
          <span class="stat-label">Cost</span>
          <span class="stat-value">{{ tokens.cost }}</span>
        </div>
        <div class="stat-cell">
          <span class="stat-label">Turns</span>
          <span class="stat-value">{{ turnCount }}</span>
        </div>
      </div>

      <div class="tool-section">
        <div class="section-title">Tool calls</div>
        <div v-if="toolUsage === undefined" class="empty-inline">{{ toolCallsSummary }}</div>
        <div v-else-if="toolUsage.length === 0" class="empty-inline">{{ toolCallsSummary }}</div>
        <ul v-else class="tool-list">
          <li v-for="tool in toolUsage" :key="tool.name">
            <span class="mono tool-name">{{ tool.name }}</span>
            <span class="tool-count">{{ tool.count }}</span>
          </li>
        </ul>
      </div>
    </div>
  </details>
</template>

<style scoped>
.step-disclosure { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); overflow: hidden; }
.step-disclosure summary { list-style: none; cursor: pointer; }
.step-disclosure summary::-webkit-details-marker { display: none; }
.step-disclosure summary:hover { background: var(--surface-2); }
.step-summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; flex-wrap: wrap; min-width: 0; }
.agent-invocation-detail { display: flex; flex-direction: column; gap: 10px; padding: 0 12px 12px; }
.invocation-agent { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex-wrap: wrap; }
.agent-handle { font-weight: 700; font-size: 14px; }
.agent-client { color: var(--text-secondary); font-size: 12px; }
.summary-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.status-badge { padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; background: var(--muted-soft); color: var(--muted); }
.status-badge.success { background: var(--success-soft); color: var(--success); }
.status-badge.failed { background: var(--danger-soft); color: var(--danger); }
.status-badge.running { background: var(--primary-soft); color: var(--primary); }
.status-badge.queued { background: var(--muted-soft); color: var(--muted); }
.invocation-timing { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--text-secondary); }
.timing-detail { color: var(--text-dim); font-size: 12px; }
.tool-summary { color: var(--text-secondary); font-size: 11px; }
.invocation-ids { display: flex; gap: 8px; flex-wrap: wrap; }
.id-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 6px; background: var(--surface-2); border: 1px solid var(--border); font-size: 11px; }
.id-label { font-weight: 700; text-transform: uppercase; color: var(--text-dim); font-size: 9px; letter-spacing: .04em; }
.section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--text-secondary); margin-top: 4px; }
.prompt-block { display: flex; flex-direction: column; gap: 8px; }
.prompt-body { margin: 0; padding: 10px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border); white-space: pre-wrap; word-break: break-word; font-family: var(--mono); font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
.product-prompt summary { font-size: 12px; color: var(--primary); font-weight: 600; cursor: pointer; }
.product-prompt .secondary { background: var(--surface); }
.result-card { padding: 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); }
.result-card.succeeded { border-color: var(--success); background: var(--success-soft); }
.result-card.failed { border-color: var(--danger); background: var(--danger-soft); }
.result-card.needs_human { border-color: var(--warning); background: var(--warning-soft); }
.result-card.delegate { border-color: var(--primary); background: var(--primary-soft); }
.result-action { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.action-badge, .outcome-badge { display: inline-flex; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
.action-badge { background: var(--surface); border: 1px solid var(--border); }
.outcome-badge.success { background: var(--success); color: #fff; }
.outcome-badge.failed { background: var(--danger); color: #fff; }
.outcome-badge.needs_human { background: var(--warning); color: #000; }
.outcome-badge.delegate { background: var(--primary); color: #fff; }
.result-target { display: flex; align-items: center; gap: 8px; font-size: 12px; margin-bottom: 6px; flex-wrap: wrap; }
.result-summary { font-size: 13px; color: var(--text); margin: 8px 0; }
.artifact-list { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.artifact-pill { display: inline-block; padding: 2px 7px; border-radius: 4px; background: var(--surface); border: 1px solid var(--border); font-size: 11px; }
.raw-response { border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
.raw-response summary { padding: 10px 12px; font-size: 12px; font-weight: 700; color: var(--text-secondary); cursor: pointer; }
.raw-body { margin: 0; padding: 10px 12px; white-space: pre-wrap; word-break: break-word; font-family: var(--mono); font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
.error-block { padding: 10px 12px; border-radius: 8px; background: var(--danger-soft); border: 1px solid var(--danger); color: var(--danger); font-size: 13px; }
.error-body { margin: 6px 0 0; white-space: pre-wrap; word-break: break-word; font-family: var(--mono); font-size: 12px; }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
.stat-cell { display: flex; flex-direction: column; gap: 3px; padding: 10px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border); min-width: 0; }
.stat-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--text-dim); }
.stat-value { font-size: 14px; font-weight: 700; color: var(--text); overflow-wrap: anywhere; }
.tool-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.tool-list li { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; border-radius: 6px; background: var(--surface-2); border: 1px solid var(--border); }
.tool-name { font-size: 12px; }
.tool-count { font-size: 12px; font-weight: 700; }
.empty-inline { color: var(--text-dim); font-size: 13px; }
.label { color: var(--text-dim); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.mono { font-family: var(--mono); word-break: break-all; }
@media (max-width: 640px) {
  .step-summary { align-items: flex-start; flex-direction: column; }
  .summary-meta { width: 100%; justify-content: space-between; }
  .invocation-timing { flex-direction: column; gap: 4px; }
  .stats-grid { grid-template-columns: 1fr; }
  .result-target { flex-direction: column; align-items: flex-start; gap: 2px; }
}
</style>
