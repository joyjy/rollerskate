export type SubscriptionPluginKind = "subscription.probe";

export interface EnvironmentValue {
  readonly environment: string;
}

export interface HttpPollProbe {
  readonly kind: "http";
  readonly url: string;
  readonly method?: "GET" | "HEAD";
  readonly headers?: Readonly<Record<string, string | EnvironmentValue>>;
}

export interface CommandPollProbe {
  readonly kind: "command";
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | EnvironmentValue>>;
}

export type PollProbe = HttpPollProbe | CommandPollProbe;

export interface HttpProbeResult {
  readonly kind: "http";
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface CommandProbeResult {
  readonly kind: "command";
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type PollProbeResult = HttpProbeResult | CommandProbeResult;

export interface PollObservation {
  readonly version: string;
  readonly facts: Readonly<Record<string, unknown>>;
  readonly terminal: "success" | "failure" | "cancelled" | null;
  readonly summary?: string;
}

export interface PollPluginContext {
  readonly subscriptionId: string;
  readonly attempt: number;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly previousObservation?: PollObservation;
}

/**
 * A user plugin fills one sandboxed Subscription strategy slot. It cannot register a
 * Capability, Event type, Route, Handler, loop, store or host API.
 */
export interface SubscriptionProbePlugin<Config = unknown> {
  readonly kind: SubscriptionPluginKind;
  readonly id: string;
  readonly schemaVersion: 1;
  plan(config: Config, context: PollPluginContext): PollProbe | Promise<PollProbe>;
  evaluate(
    config: Config,
    result: PollProbeResult,
    context: PollPluginContext
  ): PollObservation | Promise<PollObservation>;
}
