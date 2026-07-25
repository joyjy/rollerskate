<script setup lang="ts">
import { formatDateTime } from "@/utils/format";
import type { AgentConsoleItem, LocalFoundation } from "@/types/local";

defineProps<{
  agent: AgentConsoleItem | null;
  foundation: LocalFoundation | null;
  error: string | null;
  pending: "add" | "configure" | "rename" | "suspend" | "resume" | null;
  editing: boolean;
  editHandle: string;
  configuring: boolean;
  editLaunchArgs: string;
  suspendConfirm: boolean;
}>();
const emit = defineEmits<{
  "update:editHandle": [value: string];
  "update:editLaunchArgs": [value: string];
  beginConfigure: [];
  cancelConfigure: [];
  configure: [];
  beginRename: [];
  cancelRename: [];
  rename: [];
  askSuspend: [];
  cancelSuspend: [];
  suspend: [];
  resume: [];
}>();
</script>

<template>
  <section class="panel inspector">
    <div class="panel-header">{{ agent?.handle ?? "Agent inspector" }}</div>
    <div v-if="!agent" class="panel-body state">Select an Agent to inspect its identity, session and lifecycle controls.</div>
    <div v-else class="panel-body">
      <div v-if="error" class="inline-error" role="alert">{{ error }}</div>
      <div class="inspector-section">
        <div class="section-title">Identity</div>
        <dl class="kv">
          <dt>@handle</dt>
          <dd>
            <input
              v-if="editing"
              :value="editHandle"
              maxlength="32"
              class="rename-input"
              :disabled="pending === 'rename'"
              @input="emit('update:editHandle', ($event.target as HTMLInputElement).value)"
            />
            <span v-else class="handle">{{ agent.handle }}</span>
          </dd>
          <dt>Stable ID</dt><dd class="mono">{{ agent.principalId }}</dd>
          <dt>Created</dt><dd>{{ formatDateTime(agent.createdAt) }}</dd>
          <dt>Updated</dt><dd>{{ formatDateTime(agent.updatedAt) }}</dd>
        </dl>
      </div>
      <div class="inspector-section">
        <div class="section-title">Execution</div>
        <dl class="kv">
          <dt>Client</dt><dd>{{ agent.client }}</dd>
          <dt>Launch args</dt>
          <dd v-if="agent.executionConfig.launchArgs.length" class="launch-args">
            <code v-for="(argument, index) in agent.executionConfig.launchArgs" :key="index">{{ argument }}</code>
          </dd>
          <dd v-else class="note">None</dd>
          <dt>Availability</dt>
          <dd>
            <span class="badge" :class="agent.availability.state">{{ agent.availability.state }}</span>
            <span v-if="agent.availability.reason" class="note">{{ agent.availability.reason }}</span>
          </dd>
          <dt>Lifecycle</dt><dd><span class="badge" :class="agent.status">{{ agent.status }}</span></dd>
          <dt>Workspace</dt><dd class="mono secret">{{ foundation?.workspacePath ?? "—" }}</dd>
        </dl>
      </div>
      <div class="inspector-section">
        <div class="section-title">Launch configuration</div>
        <template v-if="configuring">
          <textarea
            :value="editLaunchArgs"
            rows="5"
            class="launch-args-input"
            :disabled="pending === 'configure'"
            aria-label="Launch arguments, one per line"
            @input="emit('update:editLaunchArgs', ($event.target as HTMLTextAreaElement).value)"
          />
          <p class="note">每行一个 argv 参数。保存后下一次调用会使用新的 adapter 配置。</p>
          <div class="control-group">
            <button type="button" class="secondary-button" :disabled="pending === 'configure'" @click="emit('cancelConfigure')">Cancel</button>
            <button type="button" class="primary-button" :disabled="pending === 'configure'" @click="emit('configure')">{{ pending === "configure" ? "Saving…" : "Save arguments" }}</button>
          </div>
        </template>
        <template v-else>
          <button type="button" class="secondary-button" :disabled="pending !== null" @click="emit('beginConfigure')">Configure arguments</button>
        </template>
      </div>
      <div class="inspector-section">
        <div class="section-title">Current session</div>
        <dl v-if="agent.currentSession" class="kv">
          <dt>Session ID</dt><dd class="mono secret">{{ agent.currentSession.sessionId }}</dd>
          <dt>Generation</dt><dd>{{ agent.currentSession.generation }}</dd>
          <dt>State</dt><dd>{{ agent.currentSession.state }}</dd>
          <dt>Updated</dt><dd>{{ formatDateTime(agent.currentSession.updatedAt) }}</dd>
        </dl>
        <p v-else class="note">没有 Session。首次调用时由 Runtime 自动创建，不伪造空 ID。</p>
      </div>
      <div class="inspector-section">
        <div class="section-title">Lifecycle controls</div>
        <template v-if="editing">
          <div class="control-group">
            <button type="button" class="secondary-button" :disabled="pending === 'rename'" @click="emit('cancelRename')">Cancel</button>
            <button type="button" class="primary-button" :disabled="!editHandle.trim() || pending === 'rename'" @click="emit('rename')">{{ pending === "rename" ? "Saving…" : "Save rename" }}</button>
          </div>
          <p class="note">Stable Principal ID、历史 Event 与 Session 引用不会变化。</p>
        </template>
        <template v-else-if="suspendConfirm">
          <p class="note">新的调用不会再进入该 Agent；历史、current Session 和审计引用会保留。</p>
          <div class="control-group">
            <button type="button" class="secondary-button" :disabled="pending === 'suspend'" @click="emit('cancelSuspend')">Cancel</button>
            <button type="button" class="primary-button warning" :disabled="pending === 'suspend'" @click="emit('suspend')">{{ pending === "suspend" ? "Suspending…" : "Confirm Suspend" }}</button>
          </div>
        </template>
        <div v-else class="control-group">
          <button type="button" class="secondary-button" :disabled="pending === 'suspend' || pending === 'resume'" @click="emit('beginRename')">Rename</button>
          <button v-if="agent.status === 'active'" type="button" class="secondary-button danger" :disabled="pending === 'suspend' || pending === 'resume'" @click="emit('askSuspend')">Suspend</button>
          <button v-else type="button" class="primary-button" :disabled="pending === 'suspend' || pending === 'resume'" @click="emit('resume')">{{ pending === "resume" ? "Resuming…" : "Resume" }}</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.inspector { min-height: 420px; }
.panel-body { padding: 20px; }
.inspector-section { margin-bottom: 22px; }
.inspector-section:last-child { margin-bottom: 0; }
.section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--text-secondary); margin: 0 0 10px; }
.kv { display: grid; grid-template-columns: 130px 1fr; gap: 6px 14px; font-size: 13px; }
.kv dt { color: var(--text-secondary); font-weight: 500; }
.kv dd { margin: 0; word-break: break-word; }
.rename-input { width: 100%; max-width: 280px; border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font: inherit; }
.launch-args { display: flex; flex-direction: column; gap: 4px; }
.launch-args code { font-family: var(--mono); font-size: 12px; }
.launch-args-input { width: 100%; border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font-family: var(--mono); font-size: 12px; resize: vertical; }
.control-group { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
.note { font-size: 12px; color: var(--text-secondary); }
.handle { font-weight: 700; }
.handle::before { content: "@"; color: var(--text-dim); font-weight: 500; margin-right: 1px; }
.mono { font-family: var(--mono); font-size: 12px; word-break: break-all; }
.secret { color: var(--text-secondary); font-style: italic; }
.badge.active, .badge.ready { background: var(--success-soft); color: var(--success); }
.badge.suspended { background: var(--muted-soft); color: var(--muted); }
.badge.unavailable { background: var(--danger-soft); color: var(--danger); }
.badge.unknown { background: var(--warning-soft); color: var(--warning); }
.primary-button.warning { background: var(--warning); border-color: var(--warning); }
@media (max-width: 600px) { .kv { grid-template-columns: 100px 1fr; } }
</style>
