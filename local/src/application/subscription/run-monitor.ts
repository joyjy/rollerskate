import { NotificationControlStore } from "../../capabilities/subscription/notification-control-store.js";
import {join} from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RunMonitorStore, type RunSubscription } from "../../capabilities/subscription/run-monitor-store.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import { redact } from "../../integrations/activity/provider-source.js";
import type { CodexPushSourceResolver } from "../../integrations/codex-desktop/push.js";
import { isTerminal, type AgentRunProjection } from "../../modules/steward/state-machine.js";
import { stableContractJson } from "../../modules/steward/contract-codec.js";
import { terminalRunResultDelivery } from "../steward/result-destination.js";
import { inspectStewardWork } from "../steward/work-query.js";
import { runMonitorTarget } from "./run-monitor-target.js";
import { admitRunMonitorChatNotice, runMonitorChatNoticeStates } from "../chat/run-monitor-return.js";

const digest = (value: unknown): string => createHash("sha256").update(stableContractJson(value)).digest("hex");
const clean = (value: string): string => redact(value).slice(0, 4096);

/** Run state remains authoritative. This observer owns only notification progress. */
export class RunSubscriptionRuntime {
  readonly #subscriptions: RunMonitorStore;
  readonly #runs: AgentRunStore;
  readonly #runtime: RuntimeStore;
  #chatEventIds: string[] = [];
  constructor(readonly options: {database: DatabaseSync; repoRoot: string; runtimeDirectory: string;
    runtimeIdentity: string; startedAt: string}) {
    this.#subscriptions = new RunMonitorStore(options.database);
    this.#runs = new AgentRunStore(options.database, {migrate: false});
    this.#runtime = new RuntimeStore(options.database, {migrate: false});
  }

  /** Only resumable, explicitly routed historical work is enrolled; no terminal replay. */
  recover(at = new Date().toISOString()): void {
    this.#runtime.withImmediateTransaction(() => {
      const rows = this.options.database.prepare(`SELECT run_id FROM agent_runs
        WHERE status NOT IN ('succeeded','failed','cancelled','needs_human')
        AND (json_extract(orchestrator_binding_json,'$.resultDestination') IS NOT NULL OR substr(owner_request_id,1,13) = 'chat-execute:')
        AND NOT EXISTS (SELECT 1 FROM run_subscriptions sub WHERE sub.run_id = agent_runs.run_id)
        ORDER BY created_at LIMIT 100`).all() as {run_id: string}[];
      for (const row of rows) {
        const run = this.#runs.requireProjection(row.run_id);
        const subscription = this.#subscriptions.createInTransaction(run.runId, at);
        if (!runMonitorTarget(this.options.database,run)) this.#subscriptions.setStatusInTransaction(subscription.subscriptionId,
          "blocked", "origin_session_unbound: no immutable return target", at);
      }
    });
  }

  runCycle(at = new Date().toISOString(), mode: "all" | "chat-return" = "all") {
    this.#chatEventIds = [];
    const notifications: string[] = []; const blocked: string[] = [];
    if (mode === "all") this.recover(at);
    for (const candidate of this.#subscriptions.listDue(100)) {
      try {
        this.#runtime.withImmediateTransaction(() => {
          const subscription = this.#subscriptions.get(candidate.subscriptionId)!;
          const run = this.#runs.requireProjection(subscription.runId);
          const target = runMonitorTarget(this.options.database, run);
          if (mode === "chat-return" && target?.kind !== "chat") return;
          const threadId = target?.kind === 'destination' && target.destination.delivery.kind === 'codex-desktop'
            ? target.destination.delivery.address.threadId : undefined;
          const control = new NotificationControlStore(this.options.database).forRun(run.runId,threadId);
          if(control) {
            // Muted observations do not advance: resume reports the latest state once.
            if(control.mode === 'closed') this.#subscriptions.setStatusInTransaction(subscription.subscriptionId,'completed',
              `notification_closed:${control.scope}:${control.targetId}:r${control.revision}`,at);
            else this.#subscriptions.setStatusInTransaction(subscription.subscriptionId,'blocked',
              `notification_muted:${control.scope}:${control.targetId}:r${control.revision}`,at);
            return;
          }

          if (!target) {
            const error = "origin_session_unbound: no immutable return target; inspect the Run";
            this.#subscriptions.setStatusInTransaction(subscription.subscriptionId, "blocked", error, at);
            if (subscription.status !== "blocked" || subscription.latestError !== error) blocked.push(subscription.subscriptionId);
            return;
          }
          const snapshot = this.snapshot(run, at);
          if (mode === "chat-return" && snapshot.status === "accepted") return;
          // Runtime identity is diagnostic only. Re-observing an unchanged state after restart
          // must not enqueue a distinct interruption message or replay business work.
          if (subscription.observedKey !== snapshot.key && !(target.kind === "chat" && snapshot.status === "accepted")) {
            if (!this.enqueue(subscription, run, target, snapshot.key, snapshot.status, snapshot.reason, at, snapshot.terminal)) return;
            notifications.push(subscription.subscriptionId);
          }
          this.#subscriptions.checkpointInTransaction(subscription.subscriptionId, snapshot.key, mode === "all" ? this.options.runtimeIdentity : subscription.runtimeIdentity, at);
          const failures = this.deliveryFailures(subscription, run);
          if (failures.length) {
            const error = failures.join("; ").slice(0,4096);
            this.#subscriptions.setStatusInTransaction(subscription.subscriptionId, "blocked", error, at);
            if (subscription.status !== "blocked" || subscription.latestError !== error) blocked.push(subscription.subscriptionId);
          } else {
            const pending = this.pendingNotifications(subscription, run);
            this.#subscriptions.setStatusInTransaction(subscription.subscriptionId,
              isTerminal(run.status) && !pending ? "completed" : "active", null, at);
          }
        });
      } catch (error) {
        const message = clean(`monitor_error: ${error instanceof Error ? error.message : String(error)}`);
        this.#runtime.withImmediateTransaction(() => this.#subscriptions.setStatusInTransaction(candidate.subscriptionId,
          "blocked", message, at));
        if (candidate.status !== "blocked" || candidate.latestError !== message) blocked.push(candidate.subscriptionId);
      }
    }
    return {notifications, blocked, eventIds:this.#chatEventIds};
  }

  private snapshot(run: AgentRunProjection, at: string) {
    // Existing query owns human questions and rejected orchestrator decisions.
    const work = inspectStewardWork(this.options.repoRoot, run.runId, this.options.runtimeDirectory, this.options.database);
    const failure = this.options.database.prepare(`SELECT execution.execution_id, execution.last_error, execution.status, execution.attempt_count
      FROM executions execution JOIN events event ON event.event_id = execution.event_id
      WHERE (event.event_id = ? OR event.root_event_id = ?) AND execution.status IN ('failed','retry_wait')
      ORDER BY execution.updated_at DESC, execution.execution_id DESC LIMIT 1`).get(run.rootEventId,run.rootEventId) as
      {execution_id:string; last_error:string|null;status:string;attempt_count:number} | undefined;
    if (isTerminal(run.status)) return {key: `terminal:${run.activeCycleId ?? "run"}`, status: run.status,
      reason: clean(run.terminalSummary ?? "Run reached its recorded terminal state; inspect acceptance evidence."), terminal: true};
    if (run.status === "awaiting_source") {
      const cycle = this.options.database.prepare(`SELECT cycle_id,status,terminal_summary FROM agent_run_cycles
        WHERE run_id = ? ORDER BY updated_at DESC,cycle_id DESC LIMIT 1`).get(run.runId) as
        {cycle_id:string;status:string;terminal_summary:string|null}|undefined;
      if (cycle && ["succeeded","failed","needs_human"].includes(cycle.status)) return {
        key:`terminal:${cycle.cycle_id}`, status:cycle.status, reason:clean(cycle.terminal_summary ?? "Run cycle ended; waiting for the next source."),terminal:true};
    }
    const active = run.activeExecutionId === undefined ? undefined : this.#runtime.execution(run.activeExecutionId);
    const stalled = active?.status === "running" && Date.parse(at) - Date.parse(active.updatedAt) >= 300_000;
    const deadline = run.deadlineAt !== undefined && Date.parse(at) >= Date.parse(run.deadlineAt);
    const status = deadline ? "deadline_exhausted" : stalled ? "execution_stalled" : work.state === "needs_human" ? "needs_attention"
      : run.status === "awaiting_orchestrator" ? "awaiting_orchestrator" : run.status === "awaiting_source" ? "awaiting_source" : "accepted";
    const reason = clean(deadline ? "Run deadline elapsed; execution success is not confirmed."
      : stalled ? "No Execution progress for at least five minutes; outcome is unconfirmed, inspect before retrying." : work.attentionReason ?? (run.status === "awaiting_orchestrator" && failure?.last_error ? failure.last_error
        : status === "accepted" ? "Run and its persistent Subscription are registered; execution success is not yet established." : `Run is ${run.status}.`));
    // A settled failure is independently reportable even while Run continuation is pending.
    const pending = this.options.database.prepare(`SELECT count(*) AS count FROM executions execution
      JOIN events event ON event.event_id = execution.event_id WHERE (event.event_id = ? OR event.root_event_id = ?)
      AND execution.status IN ('queued','running','retry_wait')`).get(run.rootEventId,run.rootEventId) as {count:number};
    const currentFailure = failure && (active?.status === "failed" || active?.status === "retry_wait" ||
      run.status === "awaiting_orchestrator" || pending.count === 0);
    return {key:`state:${digest({status, reason, stalled:stalled ? `${active.executionId}:${active.updatedAt}` : undefined, failure:currentFailure ? `${failure.execution_id}:${failure.attempt_count}` : undefined})}`,
      status:currentFailure ? (failure.status === "retry_wait" ? "retry_wait" : "execution_failed") : status, reason:currentFailure ? clean(failure.last_error ?? reason) : reason,terminal:false};
  }

  private enqueue(subscription: RunSubscription, run: AgentRunProjection, target: NonNullable<ReturnType<typeof runMonitorTarget>>,
    key: string, status: string, reason: string, at: string, terminal = false): boolean {
    const origin = `run-subscription:${subscription.subscriptionId}:${key}`;
    const quote = (value: string): string => "'" + value.replace(/'/gu,"'\\''") + "'";
    const read = [join(this.options.repoRoot,"scripts/rs"),"--runtime",this.options.runtimeDirectory,"run","inspect",run.runId].map(quote).join(" ");
    const body = [`RS Run ${run.runId}: ${status}`, reason,
      `Subscription: ${subscription.subscriptionId}`, `Read: ${read}`,
      "Read the recorded state and acceptance evidence before continuing; this notice grants no new authority.",
      "Report this status in a visible reply to the original Owner; do not silently treat it as task success."].join("\n");
    if (target.kind === "chat") {
      const existed = this.options.database.prepare("SELECT event_id FROM events WHERE source_kind='handler' AND source_external_id=?")
        .get(`chat-activation:${origin}`);
      const accepted = admitRunMonitorChatNotice(this.options.database, this.#runtime,
        {dispatchEventId:target.dispatchEventId, key:origin, brief:body}, at);
      if (accepted && !existed) {
        const event = this.options.database.prepare("SELECT event_id FROM events WHERE source_kind='handler' AND source_external_id=?")
          .get(`chat-activation:${origin}`) as {event_id:string};
        this.#chatEventIds.push(event.event_id);
      }
      if (!accepted) this.#subscriptions.setStatusInTransaction(subscription.subscriptionId, "blocked",
        "chat_return_pending: original Session is busy or unavailable; monitoring retained", at);
      return accepted;
    }
    // Reuse terminal outbox identities to avoid duplicate messages from existing Run completion paths.
    if (terminal && ["succeeded","failed","needs_human","cancelled"].includes(status)) {
      const cycleId = key.slice("terminal:".length);
      const summary = cycleId === "run" ? run.terminalSummary : this.#runs.cycle(cycleId)?.terminalSummary;
      const delivery = terminalRunResultDelivery(target.destination, {runId:run.runId,
        ...(cycleId === "run" ? {} : {cycleId}), status: status as "succeeded"|"failed"|"needs_human"|"cancelled", summary:summary ?? reason});
      this.#runtime.enqueueHostDeliveryInTransaction({originId:`steward-run:${run.runId}:${cycleId}:terminal`,
        destinationId:target.destination.destinationId,...delivery,at});
    } else {
      const delivery = terminalRunResultDelivery(target.destination, {runId:run.runId,status:"needs_human",summary:body});
      this.#runtime.enqueueHostDeliveryInTransaction({originId:origin,destinationId:target.destination.destinationId,
        kind:delivery.kind,address:delivery.address,payload:delivery.kind === "codex-desktop"
          ? {schemaVersion:"RunSubscriptionNotice@1",subscriptionId:subscription.subscriptionId,
            runId:run.runId,runVersion:run.version,status,body}
          : delivery.kind === "vikunja-task" ? {schemaVersion:"VikunjaTaskComment@1",runId:run.runId,body}
          : {body:`RS Run ${run.runId}: ${status}. Inspect the Run for bounded details.`},at});
    }
    return true;
  }

  private deliveryFailures(subscription: RunSubscription, run: AgentRunProjection): string[] {
    const target = runMonitorTarget(this.options.database,run);
    const chatFailures = target?.kind === "chat" ? runMonitorChatNoticeStates(this.options.database,this.#runtime,
      target.dispatchEventId,subscription.subscriptionId).filter(state => state.status === "failed" || state.status === "blocked")
      .map(state => `chat_notification_failed:${state.reason ?? state.status}`) : [];
    return [...chatFailures,...(this.options.database.prepare(`SELECT delivery_id,last_error FROM deliveries WHERE
      (substr(origin_id,1,length(?)) = ? OR substr(origin_id,1,length(?)) = ?) AND status = 'failed'`).all(
      `run-subscription:${subscription.subscriptionId}:`,`run-subscription:${subscription.subscriptionId}:`,
      `steward-run:${run.runId}:`,`steward-run:${run.runId}:`) as {delivery_id:string;last_error:string|null}[])
      .map(row => clean(`notification_failed:${row.delivery_id}: ${row.last_error ?? "unknown"}; no blind resend`))];
  }
  private pendingNotifications(subscription: RunSubscription, run: AgentRunProjection): boolean {
    const target = runMonitorTarget(this.options.database,run);
    const chatPending = target?.kind === "chat" && runMonitorChatNoticeStates(this.options.database,this.#runtime,
      target.dispatchEventId,subscription.subscriptionId).some(state => state.status !== "turn_completed" && state.status !== "failed" && state.status !== "blocked");
    const row = this.options.database.prepare(`SELECT count(*) AS count FROM deliveries WHERE
      (substr(origin_id,1,length(?)) = ? OR substr(origin_id,1,length(?)) = ?) AND status NOT IN ('delivered','failed')`).get(
      `run-subscription:${subscription.subscriptionId}:`,`run-subscription:${subscription.subscriptionId}:`,
      `steward-run:${run.runId}:`,`steward-run:${run.runId}:`) as {count:number};
    return chatPending || row.count > 0;
  }
}

/** Stored host outbox content is accepted only for the Run's immutable return binding. */
export function runSubscriptionPushSource(database: DatabaseSync): CodexPushSourceResolver {
  return ({delivery,destination}) => {
    if (delivery.origin.kind !== "host" || !delivery.origin.id.startsWith("run-subscription:")) return undefined;
    const payload = delivery.payload;
    if (payload.schemaVersion !== "RunSubscriptionNotice@1" || typeof payload.runId !== "string" || typeof payload.subscriptionId !== "string" ||
      typeof payload.body !== "string" || Buffer.byteLength(payload.body) > 16_384) throw new Error("Invalid Run Subscription notice");
    const subscription = new RunMonitorStore(database).get(payload.subscriptionId);
    const run = new AgentRunStore(database,{migrate:false}).requireProjection(payload.runId);
    const target = runMonitorTarget(database,run);
    if (!subscription || subscription.runId !== run.runId || target?.kind !== "destination" ||
      target.destination.delivery.kind !== "codex-desktop" || destination.kind !== "codex-desktop" ||
      destination.destinationId !== target.destination.destinationId || delivery.destinationId !== destination.destinationId ||
      stableContractJson(destination.address) !== stableContractJson(target.destination.delivery.address) ||
      !delivery.origin.id.startsWith(`run-subscription:${subscription.subscriptionId}:`)) throw new Error("Run Subscription destination/source mismatch");
    return {body:payload.body,source:{kind:"rs-run-subscription",runId:run.runId,subscriptionId:subscription.subscriptionId,status:payload.status}};
  };
}
