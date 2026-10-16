import { readFileSync } from "node:fs";
import { resumeSubscriptionWithReadback } from "../../application/subscription/control.js";
import { readSubscriptionResumeOutcome, type SubscriptionResumeReceipt } from "../../application/subscription/resume-query.js";
import { controlNotifications, inspectNotificationControl } from "../../application/subscription/notification-control.js";
import { desktopSubscriptionDeliveries, desktopSubscriptionReceipt } from "../../application/subscription/desktop-control.js";
import { recoverFileSubscription, fileSubscriptionRecoveries } from "../../application/subscription/file-recovery.js";
import { registerFileSubscription, readFileSubscriptionRegistration } from "../../application/subscription/file-control.js";
import {
  controlSubscriptionView,
  inspectSubscriptionView,
  listSubscriptionViews
} from "../../application/subscription/control.js";
import { subscriptionHistory } from
  "../../application/subscription/query.js";
import {
  inspectRunMonitor,
  listRunMonitors,
  runMonitorDeliveries
} from "../../application/subscription/run-monitor-query.js";

interface Output {
  readonly write: (text: string) => void;
}

const HELP = [
  "Usage:",
  "  scripts/rs subscription run-monitors",
  "  scripts/rs subscription resume-readback <receipt.json>",
  "  scripts/rs subscription notifications inspect|mute|resume|close run|codex-thread <id> [--reason <text>]",
  "  scripts/rs subscription list",
  "  scripts/rs subscription receipt <action-receipt-id>",
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
  if(command === 'notifications') {
    const [action,scope,id,...options] = rest;
    if(!['inspect','mute','resume','close'].includes(action??'') || !['run','codex-thread'].includes(scope??'') || !id ||
      (action==='inspect' ? options.length!==0 : options.length!==2 || options[0]!=='--reason'))
      throw new Error('notifications requires inspect|mute|resume|close run|codex-thread <exact-id>; writes require --reason <text>');
    const targetScope=scope as 'run'|'codex-thread';
    const result=action==='inspect'?inspectNotificationControl(repoRoot,targetScope,id,runtimeDirectory):
      controlNotifications(repoRoot,targetScope,id,action as 'mute'|'resume'|'close',options[1]!,runtimeDirectory);
    output.write(`${JSON.stringify(result,null,2)}\n`);return 0;
  }
  if(command === 'resume-readback') {
    if(rest.length!==1) throw new Error('resume-readback requires one saved resume receipt JSON');
    const input=JSON.parse(readFileSync(rest[0]!,'utf8')) as {receipt?:SubscriptionResumeReceipt} & SubscriptionResumeReceipt;
    output.write(`${JSON.stringify(readSubscriptionResumeOutcome(repoRoot,input.receipt??input,runtimeDirectory),null,2)}\n`);return 0;
  }
  if(command === 'resume') {
    if(rest.length!==1) throw new Error('subscription resume requires exactly one id');
    output.write(`${JSON.stringify(resumeSubscriptionWithReadback(repoRoot,rest[0]!,runtimeDirectory),null,2)}\n`);return 0;
  }
  if (command === "register-desktop") {
    throw new Error("subscription registration is internal; use run preflight/start --source <plugin-ref> --input <business-input.json>");
  }
  if (command === "receipt") {
    if (rest.length !== 1) throw new Error("subscription receipt requires one exact action receipt id");
    output.write(`${JSON.stringify(desktopSubscriptionReceipt(repoRoot, rest[0]!, runtimeDirectory), null, 2)}\n`);
    return 0;
  }
  if (command === "run-monitors") {
    if (rest.length !== 0) throw new Error("subscription run-monitors accepts no arguments");
    output.write(`${JSON.stringify(listRunMonitors(repoRoot, runtimeDirectory), null, 2)}\n`);
    return 0;
  }
  if (command === "deliveries") {
    if (rest.length !== 1) throw new Error("subscription deliveries requires one subscription id");
    const result = rest[0]!.startsWith("sub_run_")
      ? runMonitorDeliveries(repoRoot, rest[0]!, runtimeDirectory)
      : desktopSubscriptionDeliveries(repoRoot, rest[0]!, runtimeDirectory);
    output.write(`${JSON.stringify(result, null, 2)}\n`);
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
    if (rest[0]!.startsWith("sub_run_")) {
      output.write(`${JSON.stringify(inspectRunMonitor(repoRoot, rest[0]!, runtimeDirectory), null, 2)}\n`);
      return 0;
    }
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
  if (command === "pause" || command === "cancel") {
    if (rest.length !== 1) throw new Error(`subscription ${command} requires exactly one id`);
    output.write(`${JSON.stringify(
      controlSubscriptionView(repoRoot, rest[0]!, command, runtimeDirectory),
      null,
      2
    )}\n`);
    return 0;
  }
  throw new Error("subscription requires run-monitors, receipt, deliveries, register-file, recover-file, recoveries, list, history, inspect, pause, resume or cancel; create observations with run preflight/start");
}
