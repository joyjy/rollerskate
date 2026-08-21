import { createHash } from "node:crypto";

import type { AgentClient } from "./client-profile.js";

export interface ProviderPolicyObservation {
  readonly client: AgentClient;
  readonly controls: Readonly<Record<string, string | boolean>>;
  readonly hook: {
    readonly state: "enforced" | "ignored" | "fail-open" | "missing";
    readonly helperDigest?: string;
  };
}

export interface ProviderPolicyReceipt {
  readonly schemaVersion: "ProviderPolicyReceipt@1";
  readonly client: AgentClient;
  readonly activityAccess: "owner-wide-read" | "same-client-history-read";
  readonly controls: Readonly<Record<string, string | boolean>>;
  readonly hookHelperDigest: string;
  readonly fingerprint: string;
}

const OWNER_WIDE_CONTROLS:
Readonly<Record<AgentClient, Readonly<Record<string, string | boolean>>>> = {
  codex: {
    sandbox: "read-only",
    approvalPolicy: "never",
    ignoreUserConfig: true
  },
  "claude-code": {
    permissionMode: "plan",
    tools: "Read,Glob,Grep"
  },
  "kimi-code": {
    prompt: true,
    outputFormat: "stream-json",
    agentFile: "bundled-read-only",
    auto: true,
    yolo: false
  },
  pi: {
    mode: "json",
    tools: "read,grep,find,ls"
  }
};

const SAME_CLIENT_HISTORY_CONTROLS = {
  ...OWNER_WIDE_CONTROLS,
  codex: {
    sandbox: "read-only",
    approvalPolicy: "never",
    historyPolicyEnvironment: "excluded-from-shell"
  }
} satisfies Readonly<
  Record<AgentClient, Readonly<Record<string, string | boolean>>>
>;

export function admitOwnerWideActivityPolicy(
  observation: ProviderPolicyObservation
): ProviderPolicyReceipt {
  return admitProviderPolicy(observation, "owner-wide-read", OWNER_WIDE_CONTROLS);
}

export function admitSameClientHistoryPolicy(
  observation: ProviderPolicyObservation
): ProviderPolicyReceipt {
  return admitProviderPolicy(
    observation,
    "same-client-history-read",
    SAME_CLIENT_HISTORY_CONTROLS
  );
}

function admitProviderPolicy(
  observation: ProviderPolicyObservation,
  activityAccess: ProviderPolicyReceipt["activityAccess"],
  requiredControls: Readonly<
    Record<AgentClient, Readonly<Record<string, string | boolean>>>
  >
): ProviderPolicyReceipt {
  const required = requiredControls[observation.client];
  for (const [name, value] of Object.entries(required)) {
    if (observation.controls[name] !== value) {
      throw new Error(`${observation.client} ${activityAccess} policy requires ${name}`);
    }
  }
  if (observation.hook.state !== "enforced") {
    throw new Error(
      `${observation.client} ${activityAccess} policy hook is ${observation.hook.state}`
    );
  }
  const helperDigest = observation.hook.helperDigest;
  if (helperDigest === undefined || !/^[a-f0-9]{64}$/.test(helperDigest)) {
    throw new Error(`${observation.client} ${activityAccess} policy helper is unverifiable`);
  }
  const controls = Object.fromEntries(Object.entries(required).sort(([a], [b]) =>
    a.localeCompare(b)));
  const fingerprint = createHash("sha256").update(JSON.stringify({
    schemaVersion: "ProviderPolicyReceipt@1",
    client: observation.client,
    activityAccess,
    controls,
    hookHelperDigest: helperDigest
  })).digest("hex");
  return {
    schemaVersion: "ProviderPolicyReceipt@1",
    client: observation.client,
    activityAccess,
    controls,
    hookHelperDigest: helperDigest,
    fingerprint
  };
}

export function verifyProviderPolicyReceipt(
  receipt: ProviderPolicyReceipt,
  expectedAccess: ProviderPolicyReceipt["activityAccess"] = "owner-wide-read"
): void {
  const observation = {
    client: receipt.client,
    controls: receipt.controls,
    hook: { state: "enforced", helperDigest: receipt.hookHelperDigest }
  } satisfies ProviderPolicyObservation;
  const verified = expectedAccess === "owner-wide-read"
    ? admitOwnerWideActivityPolicy(observation)
    : admitSameClientHistoryPolicy(observation);
  if (verified.fingerprint !== receipt.fingerprint ||
    receipt.schemaVersion !== "ProviderPolicyReceipt@1" ||
    receipt.activityAccess !== expectedAccess) {
    throw new Error("Provider policy receipt fingerprint is invalid");
  }
}
