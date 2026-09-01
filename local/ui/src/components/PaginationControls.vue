<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  page: number;
  pageSize: number;
  total: number;
}>();

const emit = defineEmits<{
  (event: "page", value: number): void;
}>();

const pageCount = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));
const pageSlots = computed<Array<number | null>>(() => {
  if (props.total === 0) return [null, null, null];
  if (pageCount.value <= 3) {
    return [...Array.from({ length: pageCount.value }, (_, index) => index + 1),
      ...Array.from({ length: 3 - pageCount.value }, () => null)];
  }
  if (props.page <= 2) return [1, 2, pageCount.value];
  if (props.page >= pageCount.value - 1) return [1, pageCount.value - 1, pageCount.value];
  return [1, props.page, pageCount.value];
});
</script>

<template>
  <nav class="pagination" aria-label="Pagination">
    <span class="pagination-info">{{ total === 0 ? "0 results" : `Page ${page}/${pageCount}` }}</span>
    <span class="pagination-spacer" />
    <button
      type="button"
      class="page-button direction-button"
      :disabled="page === 1 || total === 0"
      aria-label="Previous page"
      @click="emit('page', page - 1)"
    >Prev</button>
    <template v-for="(slot, index) in pageSlots" :key="`${index}-${slot ?? 'empty'}`">
      <button
        v-if="slot !== null"
        type="button"
        class="page-button page-number"
        :class="{ active: slot === page }"
        :aria-current="slot === page ? 'page' : undefined"
        :aria-label="`Page ${slot}`"
        @click="emit('page', slot)"
      >{{ slot }}</button>
      <span v-else class="page-placeholder" aria-hidden="true" />
    </template>
    <button
      type="button"
      class="page-button direction-button"
      :disabled="page === pageCount || total === 0"
      aria-label="Next page"
      @click="emit('page', page + 1)"
    >Next</button>
  </nav>
</template>

<style scoped>
.pagination {
  flex: 0 0 44px;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  border-top: 1px solid var(--border);
  background: var(--surface);
}
.pagination-info { flex: 0 0 58px; overflow: hidden; color: var(--text-secondary); font-size: 11px; white-space: nowrap; }
.pagination-spacer { flex: 1 1 auto; min-width: 0; }
.page-button {
  flex: 0 0 auto;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: inherit;
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
}
.direction-button { width: 40px; padding: 0; }
.page-number,
.page-placeholder { width: 28px; }
.page-placeholder { flex: 0 0 28px; height: 28px; }
.page-button:hover:not(:disabled),
.page-button.active { border-color: var(--primary); color: var(--primary); }
.page-button.active { background: var(--primary); color: white; }
.page-button:disabled { cursor: not-allowed; opacity: .45; }
@media (max-width: 420px) { .pagination-info { display: none; } }
</style>
