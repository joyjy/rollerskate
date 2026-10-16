import type { ScheduleRevision } from "../../capabilities/scheduled-task/model.js";
import type { ScheduleAdmission, ScheduleAdmissionGate } from "../../capabilities/scheduled-task/runtime.js";
import type { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import { inspectCodexDesktopTarget } from "../../integrations/codex-desktop/ipc.js";
import type { InteractivePowerState } from "../../integrations/power/readiness.js";
import { isStewardOrchestrated } from "../../modules/steward/caller-contract.js";
import { CODEX_DESKTOP_REMINDER_ACTION, parseCodexDesktopReminderInput, reminderAdmission } from "../proactive/desktop-reminder-action.js";

/** Read-only, bounded probes. Durable waiting belongs to ScheduledRun, not this cache. */
export function createScheduleAdmissionGate(options: {
  readonly runs: Pick<AgentRunStore, "projection">;
  readonly agentClient: (agentId: string) => string | undefined;
  readonly socketPath?: string;
  readonly power: () => Promise<InteractivePowerState>;
  readonly network?: () => Promise<boolean>;
  readonly desktop?: (threadId: string) => Promise<unknown>;
  readonly clock?: () => number;
  readonly fetch?: typeof fetch;
}): ScheduleAdmissionGate {
  const clock = options.clock ?? Date.now;
  const cached = new Map<string, { until: number; value: unknown }>();
  async function probe<T>(key: string, read: () => Promise<T>): Promise<T> {
    const entry = cached.get(key);
    if (entry !== undefined && entry.until > clock()) return entry.value as T;
    const value = await read();
    if (cached.size >= 128) cached.delete(cached.keys().next().value!);
    cached.set(key, { until: clock() + 5_000, value });
    return value;
  }
  return async (revision: ScheduleRevision, at: string): Promise<ScheduleAdmission> => {
    const expired = reminderAdmission(revision, at);
    if (expired !== undefined) return expired;
    let threadId: string | undefined;
    let network = false;
    if (revision.schemaVersion === "ScheduleRevision@3" && revision.target.kind === "application_action") {
      if (revision.target.actionRef !== CODEX_DESKTOP_REMINDER_ACTION) return { status: "ready" };
      threadId = parseCodexDesktopReminderInput(revision.target.input).threadId;
    } else if (revision.schemaVersion === "ScheduleRevision@1") {
      network = options.agentClient(revision.agentId) === "codex";
    } else {
      const binding = revision.schemaVersion === "ScheduleRevision@2" ? revision.sourceBinding :
        revision.target.kind === "steward_run" ? revision.target.sourceBinding : undefined;
      if (binding === undefined) return { status: "ready" };
      const run = options.runs.projection(binding.runId);
      network = run !== undefined && options.agentClient(run.stewardAgentId) === "codex";
      const destination = run?.orchestratorBinding !== undefined && isStewardOrchestrated(run.orchestratorBinding)
        ? run.orchestratorBinding.resultDestination : undefined;
      if (destination?.delivery.kind === "codex-desktop") threadId = destination.delivery.address.threadId;
    }
    const power = await probe(`power:${at}`, options.power);
    if (power !== "awake") return { status: "defer", reason: power === "sleeping" ? "waiting-awake" : "waiting-power-probe" };
    if (network && !await probe("network", options.network ?? (() => codexTransportReachable(options.fetch ?? fetch)))) {
      return { status: "defer", reason: "waiting-network" };
    }
    if (threadId !== undefined) {
      const target = threadId;
      const available = await probe(`desktop:${target}`, async () => {
        try {
          await (options.desktop?.(target) ?? inspectCodexDesktopTarget(target, {
            timeoutMilliseconds: 2_000,
            ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath })
          }));
          return true;
        } catch { return false; }
      });
      if (!available) return { status: "defer", reason: "waiting-desktop" };
    }
    return { status: "ready" };
  };
}

async function codexTransportReachable(fetchImplementation: typeof fetch): Promise<boolean> {
  try {
    // Any HTTP response proves DNS/TLS transport only, not provider/model health.
    const response = await fetchImplementation("https://chatgpt.com", {
      method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(2_000)
    });
    await response.body?.cancel();
    return true;
  } catch { return false; }
}
