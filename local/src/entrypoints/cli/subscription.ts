import { desktopSubscriptionDeliveries } from "../../application/subscription/desktop-control.js";
import { recoverFileSubscription, fileSubscriptionRecoveries } from "../../application/subscription/file-recovery.js";
import { registerFileSubscription, readFileSubscriptionRegistration } from "../../application/subscription/file-control.js";
import {
  controlSubscriptionView,
  inspectSubscriptionView,
  listSubscriptionViews
} from "../../application/subscription/control.js";
import { subscriptionHistory } from
  "../../application/subscription/query.js";

interface Output {
  readonly write: (text: string) => void;
}

const HELP = [
  "Usage:",
  "  scripts/rs subscription list",
  "  scripts/rs subscription deliveries <subscription-id>",
  "  scripts/rs subscription register-file <definition.json>",
  "  scripts/rs subscription recover-file <request.json>",
  "  scripts/rs subscription recoveries <subscription-id>",
  "  scripts/rs subscription history <subscription-id> --json",
  "  scripts/rs subscription inspect|pause|resume|cancel <subscription-id>"
].join("\n");

export function runSubscriptionCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: Output,
  runtimeDirectory?: string
): number {
  const [command, ...rest] = arguments_;
  if (command === "--help") {
    if (rest.length > 0) throw new Error("subscription help accepts no additional arguments");
    output.write(`${HELP}\n`);
    return 0;
  }
  if (command === "register-desktop") {
    throw new Error("subscription registration is internal; use run preflight/start --source <plugin-ref> --input <business-input.json>");
  }
  if (command === "deliveries") {
    if (rest.length !== 1) throw new Error("subscription deliveries requires one subscription id");
    output.write(`${JSON.stringify(desktopSubscriptionDeliveries(repoRoot, rest[0]!, runtimeDirectory), null, 2)}\n`);
    return 0;
  }
  if (command === "register-file") {
    if (rest.length !== 1) throw new Error("subscription register-file requires one definition JSON path");
    output.write(`${JSON.stringify(registerFileSubscription(repoRoot, readFileSubscriptionRegistration(rest[0]!), runtimeDirectory), null, 2)}\n`);
    return 0;
  }
  if (command === "recover-file") {
    if (rest.length !== 1) throw new Error("subscription recover-file requires one recovery JSON path");
    output.write(`${JSON.stringify(recoverFileSubscription(repoRoot, readFileSubscriptionRegistration(rest[0]!), runtimeDirectory), null, 2)}\n`);
    return 0;
  }
  if (command === "recoveries") {
    if (rest.length !== 1) throw new Error("subscription recoveries requires one subscription id");
    output.write(`${JSON.stringify(fileSubscriptionRecoveries(repoRoot, rest[0]!, runtimeDirectory), null, 2)}\n`);
    return 0;
  }
  if (command === "add") {
    throw new Error(
      "legacy_trigger_write_closed: start RunIntent@1; Steward await_source owns Subscription registration"
    );
  }
  if (command === "list") {
    if (rest.length !== 0) throw new Error("subscription list accepts no arguments");
    output.write(`${JSON.stringify(listSubscriptionViews(repoRoot, runtimeDirectory), null, 2)}\n`);
    return 0;
  }
  if (command === "inspect") {
    if (rest.length !== 1) throw new Error("subscription inspect requires exactly one id");
    output.write(`${JSON.stringify(
      inspectSubscriptionView(repoRoot, rest[0]!, runtimeDirectory),
      null,
      2
    )}\n`);
    return 0;
  }
  if (command === "history") {
    if (rest.length !== 2 || rest[1] !== "--json") {
      throw new Error("subscription history requires <subscription-id> --json");
    }
    output.write(`${JSON.stringify(
      subscriptionHistory(repoRoot, rest[0]!, runtimeDirectory),
      null,
      2
    )}\n`);
    return 0;
  }
  if (command === "pause" || command === "resume" || command === "cancel") {
    if (rest.length !== 1) throw new Error(`subscription ${command} requires exactly one id`);
    output.write(`${JSON.stringify(
      controlSubscriptionView(repoRoot, rest[0]!, command, runtimeDirectory),
      null,
      2
    )}\n`);
    return 0;
  }
  throw new Error("subscription requires deliveries, register-file, recover-file, recoveries, list, history, inspect, pause, resume or cancel; create observations with run preflight/start");
}
