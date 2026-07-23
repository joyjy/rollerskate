<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  title: string;
}>();

const displayTitle = computed(() => props.title.charAt(0).toUpperCase() + props.title.slice(1));

const cards: Record<string, { title: string; body: string }[]> = {
  runtime: [
    { title: "Health", body: "Local Runtime loop、Subscription 与 Matrix adapter 可用性。" },
    { title: "Logs", body: "按 Subscription / Agent / Room 过滤的本地日志。" }
  ],
  agents: [
    { title: "Agent Registry", body: "查看已注册 Agent、client 类型与 workspace。" },
    { title: "Enrollment", body: "管理 Agent enrollment、credential 状态与 revoke。" }
  ],
  rooms: [
    { title: "Room List", body: "查看本地 Agent 加入的 Room 与 wake mode。" },
    { title: "Bindings", body: "管理 Agent-Room binding 与 policy。" }
  ]
};

const items = computed(() => cards[props.title] ?? []);
</script>

<template>
  <div class="placeholder-view">
    <h2>{{ displayTitle }}</h2>
    <p>v0.3.0 仅实现 Subscription 控制面。{{ displayTitle }} 将在后续版本开放。</p>
    <div class="cards">
      <div v-for="item in items" :key="item.title" class="placeholder-card">
        <h4>{{ item.title }}</h4>
        <p>{{ item.body }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.placeholder-view {
  max-width: 720px;
  margin: 40px auto;
  text-align: center;
  padding: 48px 24px;
  color: var(--text-secondary);
}

.placeholder-view h2 {
  color: var(--text);
  margin-bottom: 12px;
}

.placeholder-view p {
  margin-bottom: 24px;
}

.cards {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px;
}

.placeholder-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 24px;
  text-align: left;
  width: 260px;
}

.placeholder-card h4 {
  margin: 0 0 8px;
  color: var(--text);
}

.placeholder-card p {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
}
</style>
