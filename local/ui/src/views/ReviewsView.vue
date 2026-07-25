<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { requestJson } from "@/api/client";
import {
  reviewDetailViewSchema,
  reviewSummaryViewsSchema
} from "@/api/schema";
import { useApi } from "@/composables/useApi";
import { useMutation } from "@/composables/useMutation";
import { formatDateTime } from "@/utils/format";

const route = useRoute();
const router = useRouter();
const queryReviewId = Array.isArray(route.query.reviewId)
  ? route.query.reviewId[0] ?? ""
  : route.query.reviewId ?? "";
const selectedId = ref(queryReviewId);
const mutationPaused = ref(false);

const reviewsQuery = useApi({
  url: "/api/reviews",
  schema: reviewSummaryViewsSchema,
  interval: 5_000,
  paused: mutationPaused
});
const detailUrl = computed(() =>
  `/api/reviews/${encodeURIComponent(selectedId.value || "__unselected__")}`);
const detailQuery = useApi({
  url: detailUrl,
  schema: reviewDetailViewSchema,
  interval: 5_000,
  paused: mutationPaused,
  immediate: false
});

const reviews = computed(() => reviewsQuery.data.value ?? []);
const detail = detailQuery.data;
const loading = computed(() =>
  reviewsQuery.loading.value || (selectedId.value !== "" && detailQuery.loading.value));
const error = computed(() =>
  recoverMutation.error.value ?? detailQuery.error.value ?? reviewsQuery.error.value);

watch(reviews, (next) => {
  if (selectedId.value === "" && next.length > 0) {
    selectedId.value = next[0]!.rootEventId;
  }
}, { immediate: true });

watch(selectedId, (next) => {
  if (next === "") return;
  detailQuery.data.value = null;
  void router.replace({ name: "reviews", query: { reviewId: next } });
  void detailQuery.refresh();
}, { immediate: true });

const recoverMutation = useMutation({
  execute(rootEventId: string, signal: AbortSignal) {
    return requestJson(
      `/api/reviews/${encodeURIComponent(rootEventId)}/recover`,
      reviewDetailViewSchema,
      {
        method: "POST",
        headers: { "X-Rollerskate-Request": "console" },
        signal
      }
    );
  },
  async refresh() {
    await Promise.all([reviewsQuery.refresh(), detailQuery.refresh()]);
  }
});

async function recover() {
  if (selectedId.value === "") return;
  mutationPaused.value = true;
  await recoverMutation.execute(selectedId.value);
  mutationPaused.value = false;
}
</script>

<template>
  <div class="operations-view">
    <aside class="panel operations-list" aria-label="Reviews">
      <div class="panel-header">
        <span>Reviews</span>
        <span class="dim">{{ reviews.length }}</span>
      </div>
      <div v-if="reviewsQuery.loading.value" class="state">Loading Reviews…</div>
      <div v-else-if="reviews.length === 0" class="state">No Review has been created.</div>
      <div v-else class="operation-rows">
        <button
          v-for="review in reviews"
          :key="review.rootEventId"
          type="button"
          class="operation-row"
          :class="{ active: review.rootEventId === selectedId }"
          :aria-selected="review.rootEventId === selectedId"
          @click="selectedId = review.rootEventId"
        >
          <span class="row-top">
            <strong>{{ review.subject.name }}</strong>
            <span class="status-pill" :class="review.terminalDecision === 'blocked' ? 'degraded' : review.terminalDecision === 'passed' ? 'ok' : ''">
              {{ review.terminalDecision ?? review.phase }}
            </span>
          </span>
          <span class="mono compact-ref">{{ review.rootEventId }}</span>
          <span class="row-meta">
            {{ review.findings.open }} open · rework {{ review.rework.count }}/{{ review.rework.limit }}
          </span>
        </button>
      </div>
    </aside>

    <main class="panel operations-detail">
      <div v-if="loading && !detail" class="state">Loading Review detail…</div>
      <div v-else-if="error && !detail" class="state error" role="alert">{{ error }}</div>
      <template v-else-if="detail">
        <div class="detail-heading">
          <div>
            <div class="eyebrow">ACCEPTANCE REVIEW</div>
            <h1>{{ detail.summary.subject.name }}</h1>
            <div class="mono compact-ref">{{ detail.summary.rootEventId }}</div>
          </div>
          <button
            v-if="detail.summary.availableActions.recover"
            type="button"
            class="control-button recovery"
            :disabled="recoverMutation.pending.value"
            @click="recover"
          >Recover</button>
        </div>

        <div v-if="error" class="state error" role="alert">{{ error }}</div>
        <section class="status-surface" :class="detail.summary.terminalDecision ?? detail.summary.phase">
          <div class="status-line">
            <span class="status-word">{{ detail.summary.terminalDecision ?? detail.summary.phase }}</span>
            <span>cycle {{ detail.summary.cycleIndex }}</span>
            <span>rework {{ detail.summary.rework.count }}/{{ detail.summary.rework.limit }}</span>
            <span>{{ detail.summary.findings.open }} open finding(s)</span>
          </div>
          <p>{{ detail.summary.statusReason }}</p>
          <RouterLink
            v-if="detail.summary.failure"
            class="failure-link mono"
            :to="detail.summary.failure.consoleRoute"
          >{{ detail.summary.failure.failureRef }} → Runtime Failure</RouterLink>
        </section>

        <section class="detail-grid">
          <div>
            <span class="detail-label">Reviewer</span>
            <strong>@{{ detail.summary.reviewer.handle }}</strong>
            <span class="dim">{{ detail.summary.reviewer.client }}</span>
          </div>
          <div>
            <span class="detail-label">Implementer</span>
            <strong>@{{ detail.summary.implementer.handle }}</strong>
            <span class="dim">{{ detail.summary.implementer.client }}</span>
          </div>
          <div>
            <span class="detail-label">Subject revision</span>
            <span class="mono compact-ref">{{ detail.summary.subject.revision }}</span>
          </div>
          <div>
            <span class="detail-label">Implementation</span>
            <span class="mono compact-ref">{{ detail.summary.revisions.implementation }}</span>
          </div>
        </section>

        <section class="detail-section">
          <div class="section-heading">Findings</div>
          <div v-if="detail.artifactError" class="state error">{{ detail.artifactError }}</div>
          <div v-else-if="!detail.artifact || detail.artifact.findings.length === 0" class="empty-inline">
            No findings recorded.
          </div>
          <div v-else class="finding-list">
            <article
              v-for="finding in detail.artifact.findings"
              :key="finding.findingId"
              class="finding"
              :class="finding.status"
            >
              <div class="finding-head">
                <span class="status-pill" :class="finding.status === 'resolved' ? 'ok' : 'degraded'">{{ finding.status }}</span>
                <strong>{{ finding.severity }}</strong>
                <span class="mono compact-ref">{{ finding.findingId }}</span>
              </div>
              <p>{{ finding.summary }}</p>
              <div class="mono compact-ref">{{ finding.anchor.ref }}:{{ finding.anchor.line }}</div>
              <div v-for="reply in finding.implementerReplies" :key="reply.at" class="finding-evidence">
                <strong>Implementer:</strong> {{ reply.summary }}
              </div>
              <div v-for="resolution in finding.resolutionEvidence" :key="resolution.at" class="finding-evidence">
                <strong>Resolution:</strong> {{ resolution.summary }}
              </div>
            </article>
          </div>
        </section>

        <details class="diagnostics-disclosure">
          <summary>Trace · {{ detail.audit.length }} Event(s)</summary>
          <div class="trace-list">
            <div v-for="entry in detail.audit" :key="entry.event.eventId" class="trace-row">
              <span class="mono">{{ entry.event.eventId }}</span>
              <strong>{{ entry.event.type }}</strong>
              <span>{{ entry.execution?.status ?? "no execution" }}</span>
              <span class="dim">{{ formatDateTime(entry.event.createdAt) }}</span>
            </div>
          </div>
        </details>
      </template>
      <div v-else class="state">Select a Review.</div>
    </main>
  </div>
</template>

<style scoped>
.operations-view { display: grid; grid-template-columns: minmax(260px, 0.8fr) minmax(0, 2fr); gap: 12px; min-width: 0; }
.operations-list, .operations-detail { min-width: 0; }
.operation-rows { display: flex; flex-direction: column; gap: 6px; padding: 8px; }
.operation-row { display: flex; flex-direction: column; gap: 5px; width: 100%; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: inherit; text-align: left; cursor: pointer; }
.operation-row:hover, .operation-row.active { border-color: var(--primary); }
.operation-row.active { outline: 2px solid var(--primary-soft); }
.row-top, .status-line, .finding-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.row-top { justify-content: space-between; }
.row-meta, .detail-label { color: var(--text-secondary); font-size: 12px; }
.operations-detail { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.detail-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.detail-heading h1 { margin: 2px 0 4px; font-size: 20px; }
.status-surface { border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; background: var(--surface); }
.status-surface.passed { border-color: var(--success); background: var(--success-soft); }
.status-surface.blocked { border-color: var(--danger); background: var(--danger-soft); }
.status-surface p { margin: 8px 0 0; color: var(--text-secondary); }
.failure-link { display: inline-flex; margin-top: 10px; color: var(--danger); }
.status-word { font-weight: 700; text-transform: uppercase; }
.detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.detail-grid > div { display: flex; min-width: 0; flex-direction: column; gap: 3px; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius); }
.detail-section { display: flex; flex-direction: column; gap: 8px; }
.section-heading { font-weight: 700; }
.finding-list, .trace-list { display: flex; flex-direction: column; gap: 8px; }
.finding { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px; }
.finding.open { border-color: var(--warning); }
.finding p { margin: 8px 0; }
.finding-evidence { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); color: var(--text-secondary); }
.trace-list { padding: 10px 0; }
.trace-row { display: grid; grid-template-columns: minmax(180px, 1fr) 150px 110px 160px; gap: 8px; padding: 8px; border-bottom: 1px solid var(--border); }
.compact-ref { overflow-wrap: anywhere; }
@media (max-width: 900px) {
  .operations-view { grid-template-columns: minmax(0, 1fr); }
  .detail-grid { grid-template-columns: minmax(0, 1fr); }
  .trace-row { grid-template-columns: minmax(0, 1fr); }
}
</style>
