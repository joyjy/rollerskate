<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";

import { boundedError, requestJson } from "@/api/client";
import {
  noticeCenterViewSchema,
  noticeDetailViewSchema,
  type NoticeDetailViewOutput,
  type NoticeSummaryViewOutput
} from "@/api/schema";
import { useApi } from "@/composables/useApi";

const route = useRoute();
const router = useRouter();
const centerQuery = useApi({
  url: "/api/notices?limit=100",
  schema: noticeCenterViewSchema,
  interval: 5_000
});
const detail = ref<NoticeDetailViewOutput | null>(null);
const detailLoading = ref(false);
const detailError = ref<string | null>(null);
const mutationPending = ref<"mark-read" | "ack" | null>(null);
const open = ref(false);
let detailRequest = 0;

const countLabel = computed(() => {
  const count = centerQuery.data.value?.counts.unread ?? 0;
  return count > 99 ? "99+" : String(count);
});

watch(
  () => route.query.noticeId,
  (value) => {
    if (typeof value !== "string" || value === "") return;
    open.value = true;
    void loadDetail(value);
  },
  { immediate: true }
);

async function selectNotice(notice: NoticeSummaryViewOutput): Promise<void> {
  open.value = true;
  await router.replace({
    query: { ...route.query, noticeId: notice.noticeId }
  });
  if (detail.value?.summary.noticeId !== notice.noticeId) {
    await loadDetail(notice.noticeId);
  }
}

async function loadDetail(noticeId: string): Promise<void> {
  const request = ++detailRequest;
  detailLoading.value = true;
  detailError.value = null;
  try {
    const result = await requestJson(
      `/api/notices/${encodeURIComponent(noticeId)}`,
      noticeDetailViewSchema
    );
    if (request === detailRequest) detail.value = result;
  } catch (reason) {
    if (request === detailRequest) {
      detail.value = null;
      detailError.value = boundedError(reason);
    }
  } finally {
    if (request === detailRequest) detailLoading.value = false;
  }
}

async function mutate(action: "mark-read" | "ack"): Promise<void> {
  const noticeId = detail.value?.summary.noticeId;
  if (noticeId === undefined || mutationPending.value !== null) return;
  mutationPending.value = action;
  detailError.value = null;
  try {
    detail.value = await requestJson(
      `/api/notices/${encodeURIComponent(noticeId)}/${action}`,
      noticeDetailViewSchema,
      {
        method: "POST",
        headers: { "X-Rollerskate-Request": "console" }
      }
    );
    await centerQuery.refresh();
  } catch (reason) {
    detailError.value = boundedError(reason);
  } finally {
    mutationPending.value = null;
  }
}

async function close(): Promise<void> {
  dismiss();
  const query = { ...route.query };
  delete query.noticeId;
  await router.replace({ query });
}

function dismiss(): void {
  open.value = false;
  detail.value = null;
  detailError.value = null;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && open.value) void close();
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="notice-center">
    <button
      type="button"
      class="notice-trigger"
      :class="{ unread: (centerQuery.data.value?.counts.unread ?? 0) > 0 }"
      aria-label="Open Notice Center"
      :aria-expanded="open"
      @click="open = true"
    >
      <span aria-hidden="true">●</span>
      Notices
      <span
        v-if="(centerQuery.data.value?.counts.unread ?? 0) > 0"
        class="notice-count"
      >{{ countLabel }}</span>
    </button>

    <Teleport to="body">
      <div v-if="open" class="notice-overlay" @click.self="close">
        <aside class="notice-drawer" aria-label="Notice Center">
          <div class="notice-drawer-header">
            <div>
              <strong>Notice Center</strong>
              <span v-if="centerQuery.data.value">
                {{ centerQuery.data.value.counts.unread }} unread ·
                {{ centerQuery.data.value.counts.unacknowledged }} unacknowledged
              </span>
            </div>
            <button type="button" class="notice-close" aria-label="Close Notice Center" @click="close">×</button>
          </div>

          <div v-if="centerQuery.error.value" class="notice-error" role="alert">
            {{ centerQuery.error.value }}
          </div>
          <div v-if="detailError" class="notice-error" role="alert">{{ detailError }}</div>

          <div class="notice-content" :class="{ inspecting: detail !== null || detailLoading }">
            <section class="notice-list" aria-label="Notices">
              <div v-if="centerQuery.loading.value" class="notice-state">Loading notices…</div>
              <div
                v-else-if="(centerQuery.data.value?.notices.length ?? 0) === 0"
                class="notice-state"
              >No notices yet.</div>
              <button
                v-for="notice in centerQuery.data.value?.notices ?? []"
                :key="notice.noticeId"
                type="button"
                class="notice-row"
                :class="{
                  unread: notice.readAt === null,
                  failed: notice.deliveryStatus === 'failed',
                  active: detail?.summary.noticeId === notice.noticeId
                }"
                @click="selectNotice(notice)"
              >
                <span class="notice-row-top">
                  <strong>{{ notice.title }}</strong>
                  <time>{{ new Date(notice.occurredAt).toLocaleString() }}</time>
                </span>
                <span class="notice-summary">{{ notice.summary || notice.statusReason }}</span>
                <span class="notice-row-meta">
                  {{ notice.deliveryStatus.replace("_", " ") }}
                  <span v-if="notice.acknowledgedAt">acknowledged</span>
                </span>
              </button>
            </section>

            <section v-if="detailLoading" class="notice-detail notice-state">
              Loading notice…
            </section>
            <section v-else-if="detail" class="notice-detail" aria-label="Notice detail">
              <button type="button" class="notice-back" @click="detail = null">← All notices</button>
              <div class="notice-detail-heading">
                <span
                  class="notice-outcome"
                  :class="detail.summary.deliveryStatus === 'failed' ? 'failed' : 'ok'"
                >{{ detail.summary.deliveryStatus.replace("_", " ") }}</span>
                <h2>{{ detail.summary.title }}</h2>
                <p>{{ detail.summary.statusReason }}</p>
              </div>
              <pre v-if="detail.summary.summary" class="notice-output">{{ detail.summary.summary }}</pre>
              <dl class="notice-kv">
                <dt>Notice</dt><dd>{{ detail.summary.noticeId }}</dd>
                <dt>Occurred</dt><dd>{{ new Date(detail.summary.occurredAt).toLocaleString() }}</dd>
                <dt>Read</dt><dd>{{ detail.summary.readAt ?? "Unread" }}</dd>
                <dt>Acknowledged</dt><dd>{{ detail.summary.acknowledgedAt ?? "No" }}</dd>
              </dl>
              <div class="notice-actions">
                <button
                  v-if="detail.summary.availableActions.markRead"
                  type="button"
                  class="secondary-button"
                  :disabled="mutationPending !== null"
                  @click="mutate('mark-read')"
                >Mark read</button>
                <button
                  v-if="detail.summary.availableActions.acknowledge"
                  type="button"
                  class="primary-button"
                  :disabled="mutationPending !== null"
                  @click="mutate('ack')"
                >Acknowledge</button>
                <RouterLink
                  class="notice-link"
                  :to="detail.summary.sourceAction.consoleRoute"
                  @click="dismiss"
                >{{ detail.summary.sourceAction.label }}</RouterLink>
                <RouterLink
                  v-if="detail.summary.failure"
                  class="notice-link danger"
                  :to="detail.summary.failure.consoleRoute"
                  @click="dismiss"
                >Open Runtime Failure</RouterLink>
              </div>
            </section>
          </div>
        </aside>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.notice-center { margin-left: auto; flex: 0 0 auto; }
.notice-trigger { display: inline-flex; align-items: center; gap: 7px; min-height: 38px; padding: 0 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text-secondary); font: inherit; font-weight: 700; cursor: pointer; }
.notice-trigger > span:first-child { color: var(--text-dim); font-size: 8px; }
.notice-trigger.unread { color: var(--text); border-color: #f5c36b; background: var(--warning-soft); }
.notice-trigger.unread > span:first-child { color: var(--warning); }
.notice-count { min-width: 20px; padding: 1px 6px; border-radius: 999px; background: var(--warning); color: #fff; font-size: 11px; text-align: center; }
.notice-overlay { position: fixed; inset: var(--console-header-bottom, 0px) 0 0; z-index: 40; display: flex; justify-content: flex-end; background: rgba(31, 35, 41, .3); }
.notice-drawer { width: min(760px, 92vw); height: 100%; display: flex; flex-direction: column; background: var(--surface); box-shadow: var(--shadow-lg); }
.notice-drawer-header { min-height: 68px; padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); }
.notice-drawer-header div { display: grid; gap: 2px; }
.notice-drawer-header strong { font-size: 16px; }
.notice-drawer-header span { color: var(--text-secondary); font-size: 12px; }
.notice-close { border: 0; background: transparent; color: var(--text-secondary); font-size: 26px; cursor: pointer; }
.notice-error { padding: 9px 14px; color: var(--danger); background: var(--danger-soft); border-bottom: 1px solid #fecaca; font-size: 12px; }
.notice-content { min-height: 0; flex: 1; display: grid; grid-template-columns: minmax(260px, 2fr) minmax(320px, 3fr); overflow: hidden; }
.notice-list { min-width: 0; overflow-y: auto; border-right: 1px solid var(--border); }
.notice-row { width: 100%; display: grid; gap: 6px; padding: 13px 14px; border: 0; border-bottom: 1px solid var(--border); background: var(--surface); color: var(--text); text-align: left; cursor: pointer; }
.notice-row:hover, .notice-row.active { background: var(--surface-2); }
.notice-row.unread { box-shadow: inset 3px 0 0 var(--warning); }
.notice-row.failed { box-shadow: inset 3px 0 0 var(--danger); }
.notice-row-top { min-width: 0; display: flex; justify-content: space-between; gap: 10px; }
.notice-row-top strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.notice-row-top time { flex: 0 0 auto; color: var(--text-dim); font-size: 10px; }
.notice-summary { overflow: hidden; color: var(--text-secondary); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.notice-row-meta { display: flex; gap: 8px; color: var(--text-dim); font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
.notice-detail { min-width: 0; overflow-y: auto; padding: 18px; }
.notice-state { padding: 28px 18px; color: var(--text-secondary); text-align: center; }
.notice-back { display: none; margin-bottom: 14px; padding: 0; border: 0; background: transparent; color: var(--primary); cursor: pointer; }
.notice-detail-heading { display: grid; gap: 8px; }
.notice-detail-heading h2 { margin: 0; font-size: 20px; line-height: 1.25; }
.notice-detail-heading p { margin: 0; color: var(--text-secondary); }
.notice-outcome { justify-self: start; padding: 2px 7px; border-radius: 999px; background: var(--success-soft); color: var(--success); font-size: 10px; font-weight: 700; text-transform: uppercase; }
.notice-outcome.failed { background: var(--danger-soft); color: var(--danger); }
.notice-output { margin: 18px 0; padding: 12px; max-height: 240px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); font: 12px/1.5 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.notice-kv { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 7px 12px; font-size: 12px; }
.notice-kv dt { color: var(--text-secondary); }
.notice-kv dd { margin: 0; overflow-wrap: anywhere; }
.notice-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; margin-top: 20px; }
.notice-link { color: var(--primary); font-size: 12px; font-weight: 700; text-decoration: none; }
.notice-link.danger { color: var(--danger); }
@media (max-width: 680px) {
  .notice-drawer { width: 100vw; }
  .notice-content { display: block; overflow-y: auto; }
  .notice-list { border-right: 0; }
  .notice-content.inspecting .notice-list { display: none; }
  .notice-detail { min-height: 100%; }
  .notice-back { display: inline-block; }
}
</style>
