<script setup lang="ts">
import { computed, ref, watch } from "vue";
import * as v from "valibot";
import { boundedError, requestJson } from "@/api/client";
import { runInterventionSchema } from "@/api/schema/shared";
import { useApi } from "@/composables/useApi";

const props = defineProps<{runId: string; intervention: v.InferOutput<typeof runInterventionSchema>; disabled?: boolean}>();
const emit = defineEmits<{request: [requestId: string]; changed: []}>();
const schema = v.object({proposal: v.nullable(v.object({revision: v.string(), runVersion: v.number(),
  action: v.string(), reason: v.string(), effect: v.string(), checkedAcceptance: v.array(v.string()), workspace: v.nullable(v.string())})),
  request: v.optional(v.nullable(v.object({state:v.picklist(["queued","running","succeeded","failed"]), error:v.optional(v.string())})))});
const query = useApi({url: computed(() => `/api/runs/${encodeURIComponent(props.runId)}/recovery`), schema, interval: 5000});
const proposal = computed(() => query.data.value?.proposal?.runVersion === props.intervention.runVersion ? query.data.value.proposal : null);
const recoveryRequest = computed(() => query.data.value?.request ?? null);
const recoveryPreparing = computed(() => recoveryRequest.value?.state === "queued" || recoveryRequest.value?.state === "running");
const confirmation = ref<"confirm-recovery" | "retry-orchestrator" | "cancel" | null>(null);
const busy = ref(false);
const error = ref("");
const result = ref("");
const ids = new Map<string,string>();
watch([() => props.intervention.runVersion, () => proposal.value?.revision], () => { confirmation.value = null; });
async function submit() {
  const action = confirmation.value;
  if (!action || busy.value || props.disabled) return;
  if (action === "confirm-recovery" && (!proposal.value || query.stale.value || query.error.value)) return;
  const body = action === "confirm-recovery" ? {revision: proposal.value!.revision} : {expectedVersion: props.intervention.runVersion};
  const key = JSON.stringify([action, body]);
  const requestId = ids.get(key) ?? crypto.randomUUID(); ids.set(key, requestId);
  busy.value = true; error.value = "";
  try {
    await requestJson(`/api/runs/${encodeURIComponent(props.runId)}/${action}`, v.looseObject({status:v.string()}), {
      method:"POST", headers:{"X-Rollerskate-Request":"console","Content-Type":"application/json"}, body:JSON.stringify({...body,requestId})
    });
    confirmation.value = null; result.value = "操作已受理，正在更新原 Run。"; emit("changed"); await query.refresh();
  } catch (reason) { error.value = boundedError(reason); }
  finally { busy.value = false; }
}
function requestRecovery() {
  if (busy.value || props.disabled || recoveryPreparing.value) return;
  emit("request", crypto.randomUUID());
}
</script>

<template>
  <section class="recovery" aria-label="Run recovery">
    <strong>需要恢复</strong>
    <p>编排结果未通过校验，任务正在等待恢复。</p>
    <details><summary>诊断详情</summary><p class="reason">{{ intervention.reason }}</p></details>
    <template v-if="proposal">
      <strong>恢复方案</strong>
      <p>{{ proposal.reason }}</p>
      <span class="label">确认后将执行</span>
      <p class="effect">{{ proposal.effect }}</p>
      <ul v-if="proposal.checkedAcceptance.length"><li v-for="check in proposal.checkedAcceptance" :key="check">{{ check }}</li></ul>
      <p class="dim">保留原任务、工作区和授权{{ proposal.workspace ? ` · ${proposal.workspace}` : '' }}</p>
    </template>
    <p v-else-if="recoveryPreparing">正在由负责 agent 准备修正方案；不会续跑，方案会显示在这里供你确认。</p>
    <p v-else>由负责 agent 准备修正方案，准备不会续跑；方案会显示在这里供你确认。</p>
    <div class="actions">
      <button v-if="proposal" :disabled="busy || disabled || query.stale.value || !!query.error.value" @click="confirmation = 'confirm-recovery'">{{ proposal.action === 'next_step' ? '审阅并继续' : '审阅处理方案' }}</button>
      <button :disabled="busy || disabled || recoveryPreparing" @click="requestRecovery">{{ recoveryPreparing ? '正在准备方案…' : proposal ? '请 agent 调整方案' : '请 agent 准备方案' }}</button>
      <button v-if="intervention.allowedActions.includes('retry_orchestrator')" :disabled="busy || disabled" @click="confirmation = 'retry-orchestrator'">重试只读编排</button>
      <button v-if="intervention.allowedActions.includes('cancel')" :disabled="busy || disabled" @click="confirmation = 'cancel'">取消 Run</button>
    </div>
    <div v-if="confirmation" class="confirm" role="group" aria-label="Confirm recovery action">
      <p v-if="confirmation === 'confirm-recovery'">确认按上方方案处理原任务？系统会重新核对方案和 Run 版本。</p>
      <p v-else-if="confirmation === 'cancel'">确认取消原任务？既有外部效果保留，不会自动重建任务。</p>
      <p v-else>确认重试初始只读编排？不会重放 Worker 或写入操作。</p>
      <div class="actions"><button :disabled="busy || disabled" @click="submit">{{ busy ? '提交中…' : '确认' }}</button><button :disabled="busy" @click="confirmation = null">返回</button></div>
    </div>
    <p v-if="error || query.error.value || recoveryRequest?.error" role="alert">{{ error || query.error.value || recoveryRequest?.error }}</p>
    <p v-if="result" role="status">{{ result }}</p>
  </section>
</template>

<style scoped>
.recovery { display: grid; gap: 10px; border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-top: 10px; min-width: 0; }
p { margin: 0; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; white-space: pre-wrap; }
.reason,.dim { color: var(--text-secondary); font-size: 12px; }
.label { font-size: 12px; color: var(--text-secondary); }
button { border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px; background: var(--bg-panel, white); color: var(--primary); font: inherit; font-size: 12px; cursor: pointer; }
button:disabled { opacity: .55; cursor: default; }
button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.confirm { display: grid; gap: 10px; }
[role="alert"] { color: var(--danger, #b42318); }
</style>
