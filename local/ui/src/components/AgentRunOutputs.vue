<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";

import type { AgentRunDetailViewOutput } from "@/api/schema";

type OutputFolder = AgentRunDetailViewOutput["outputFolders"][number];
type RunOutput = OutputFolder["outputs"][number];

const props = defineProps<{
  runId: string;
  folders: AgentRunDetailViewOutput["outputFolders"];
  cycleId?: string;
  outputId?: string;
}>();

const populatedFolders = computed(() => props.folders.filter((folder) => folder.outputs.length > 0));
const selectedFolder = computed<OutputFolder | undefined>(() =>
  populatedFolders.value.find((folder) => folder.cycleId === (props.cycleId || null)) ??
  populatedFolders.value.at(-1)
);
const selectedOutput = computed<RunOutput | undefined>(() => {
  const outputs = selectedFolder.value?.outputs ?? [];
  return [...outputs].reverse().find((output) => output.outputId === props.outputId) ??
    [...outputs].reverse().find((output) => output.kind === "output") ??
    outputs[0];
});
const structuredEntries = computed(() => {
  const value = selectedOutput.value?.value;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value as Record<string, unknown>)
    : [];
});
const rawValue = computed(() => {
  const value = selectedOutput.value?.value;
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
});

function query(folder: OutputFolder, output: RunOutput) {
  return {
    runId: props.runId,
    ...(folder.cycleId ? { cycleId: folder.cycleId } : {}),
    outputId: output.outputId
  };
}

function displayValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}
</script>

<template>
  <section class="outputs-section">
    <div class="section-title">Outputs <span class="output-count">{{ populatedFolders.reduce((count, folder) => count + folder.outputs.length, 0) }}</span></div>
    <div v-if="populatedFolders.length === 0" class="empty-inline">No output recorded.</div>
    <div v-else class="output-browser">
      <nav class="output-tree" aria-label="Run outputs">
        <div v-for="folder in populatedFolders" :key="folder.cycleId ?? 'run'" class="output-folder">
          <div class="folder-title">
            <strong>{{ folder.cycleId ? "Cycle" : "Run" }}</strong>
            <span class="mono">{{ folder.cycleId ?? runId }}</span>
            <span v-if="folder.sourceRevision" class="revision mono">{{ folder.sourceRevision }}</span>
          </div>
          <RouterLink
            v-for="output in folder.outputs"
            :key="`${output.stepId}:${output.outputId}`"
            class="output-link"
            :class="{ active: selectedFolder === folder && selectedOutput === output }"
            :to="{ name: 'steward', query: query(folder, output) }"
          >
            <span>{{ output.title }}</span>
            <span class="output-kind">{{ output.kind }}</span>
          </RouterLink>
        </div>
      </nav>

      <article v-if="selectedOutput" class="output-preview">
        <header>
          <div>
            <strong>{{ selectedOutput.title }}</strong>
            <span v-if="selectedOutput.schemaVersion" class="schema-badge">{{ selectedOutput.schemaVersion }}</span>
          </div>
          <span class="mono">{{ selectedOutput.outputId }}</span>
        </header>

        <dl v-if="selectedOutput.contentType === 'application/json' && structuredEntries.length" class="structured-preview">
          <template v-for="([key, value]) in structuredEntries" :key="key">
            <dt>{{ key }}</dt>
            <dd :class="{ nested: value !== null && typeof value === 'object' }">{{ displayValue(value) }}</dd>
          </template>
        </dl>
        <pre v-else class="text-preview">{{ rawValue }}</pre>

        <details class="raw-preview">
          <summary>Raw output</summary>
          <pre>{{ rawValue }}</pre>
        </details>
      </article>
    </div>
  </section>
</template>

<style scoped>
.outputs-section { margin-top: 16px; }
.section-title { margin-bottom: 10px; color: var(--text-secondary); font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
.output-count { margin-left: 6px; padding: 1px 6px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface-2); font-size: 10px; }
.output-browser { display: grid; grid-template-columns: minmax(210px, .7fr) minmax(0, 1.6fr); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.output-tree { padding: 8px; border-right: 1px solid var(--border); background: var(--surface-2); }
.output-folder + .output-folder { margin-top: 10px; }
.folder-title { display: grid; gap: 2px; margin-bottom: 5px; padding: 3px 5px; font-size: 10px; color: var(--text-secondary); }
.folder-title .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.revision { color: var(--text-dim); }
.output-link { display: flex; justify-content: space-between; gap: 8px; padding: 7px 8px; border-radius: 6px; color: inherit; font-size: 12px; text-decoration: none; }
.output-link:hover, .output-link.active { background: var(--primary-soft); color: var(--primary); }
.output-kind { color: var(--text-dim); font-size: 10px; }
.output-preview { min-width: 0; padding: 14px; }
.output-preview header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
.output-preview header > div { display: flex; align-items: center; gap: 7px; }
.schema-badge { padding: 2px 6px; border-radius: 999px; background: var(--primary-soft); color: var(--primary); font-size: 10px; }
.structured-preview { display: grid; grid-template-columns: minmax(120px, .45fr) minmax(0, 1.55fr); margin: 12px 0 0; }
.structured-preview dt, .structured-preview dd { margin: 0; padding: 8px; border-bottom: 1px solid var(--border); }
.structured-preview dt { color: var(--text-secondary); font-size: 11px; font-weight: 700; }
.structured-preview dd { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
.structured-preview dd.nested { font-family: var(--mono); font-size: 11px; }
.text-preview, .raw-preview pre { margin: 12px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--mono); font-size: 12px; }
.raw-preview { margin-top: 12px; color: var(--text-secondary); font-size: 11px; }
.empty-inline { color: var(--text-dim); font-size: 13px; }
.mono { font-family: var(--mono); word-break: break-all; }
@media (max-width: 760px) {
  .output-browser { grid-template-columns: 1fr; }
  .output-tree { border-right: 0; border-bottom: 1px solid var(--border); }
  .structured-preview { grid-template-columns: 1fr; }
  .structured-preview dt { border-bottom: 0; padding-bottom: 2px; }
  .structured-preview dd { padding-top: 2px; }
}
</style>
