<script setup lang="ts">
defineProps<{
  title: string;
  total: number;
  search: string;
  archived: boolean;
  busy?: boolean;
}>();

const emit = defineEmits<{
  (event: "update:search", value: string): void;
  (event: "toggle-archive"): void;
}>();
</script>

<template>
  <div class="panel-header list-controls">
    <span>{{ title }}</span>
    <span class="list-count">{{ total }}</span>
    <button
      type="button"
      class="archive-filter"
      :class="{ active: archived }"
      :aria-pressed="archived"
      :disabled="busy"
      @click="emit('toggle-archive')"
    >Archived</button>
    <input
      :value="search"
      class="search-input"
      type="search"
      :aria-label="`Search ${title}`"
      :placeholder="`Search ${title.toLowerCase()}…`"
      @input="emit('update:search', ($event.target as HTMLInputElement).value)"
    />
  </div>
</template>

<style scoped>
.list-controls {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-height: 61px;
}
.list-count {
  min-width: 0;
  overflow: hidden;
  color: var(--text-dim);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.archive-filter {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: normal;
  text-transform: none;
}
.archive-filter:hover,
.archive-filter.active { border-color: var(--primary); color: var(--primary); }
.archive-filter.active { background: var(--primary-soft); }
.archive-filter:disabled { cursor: wait; opacity: .55; }
.search-input {
  grid-column: 1 / -1;
  min-width: 0;
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: inherit;
  font: inherit;
  letter-spacing: normal;
  text-transform: none;
}
.search-input:focus { outline: 2px solid var(--primary-soft); border-color: var(--primary); }
</style>
