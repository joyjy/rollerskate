<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";

import { boundedError, requestJson } from "@/api/client";
import { localSnapshotSchema } from "@/api/schema";

const router = useRouter();
const loading = ref(true);
const error = ref<string | null>(null);

async function selectInitialView() {
  loading.value = true;
  error.value = null;
  try {
    const local = await requestJson("/api/local", localSnapshotSchema);
    await router.replace(local.agents.some((agent) => agent.status === "active")
      ? { name: "chats" }
      : { name: "agents" });
  } catch (reason) {
    error.value = boundedError(reason);
  } finally {
    loading.value = false;
  }
}

onMounted(selectInitialView);
</script>

<template>
  <div v-if="loading" class="app-loading">Starting Local Console…</div>
  <div v-else-if="error" class="state error" role="alert">
    Could not select the initial Console view: {{ error }}
    <button type="button" class="secondary-button retry" @click="selectInitialView">Retry</button>
  </div>
</template>
