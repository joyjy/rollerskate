import {
  localChatPresenceView,
  postLocalChatMessage,
  resumeAndWakeLocalChat,
  rotateLocalAgentSession,
  setLocalChatPresence
} from "../../application/chat/control.js";
import {
  addLocalTopicParticipant,
  pauseLocalTopic,
  removeLocalTopicParticipant,
  resumeLocalTopic
} from "../../application/topic/governance-control.js";
import { inspectLocalTopicGovernance } from
  "../../application/topic/governance-query.js";
import {
  continueLocalFreeChatNow,
  exitLocalFreeChat,
  startLocalFreeChat
} from "../../application/topic/free-chat-control.js";
import { inspectLocalFreeChat } from
  "../../application/topic/free-chat-query.js";
import {
  cancelLocalTopicActivationSchedule,
  createLocalTopicActivationSchedule,
  pauseLocalTopicActivationSchedule,
  resumeLocalTopicActivationSchedule
} from "../../application/topic/schedule-control.js";
import {
  localTopicActivationSchedule,
  localTopicActivationSchedules
} from "../../application/topic/schedule-query.js";
import {
  localChatTimeline,
  type ChatTimelineOptions
} from "../../application/chat/query.js";
import { requireLocalAgent } from "./agent.js";
import type { AppOutput } from "./shared.js";
import {
  parseBoundedInteger,
  rejectArguments,
  runtimeDependency
} from "./shared.js";

export function runChatCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: AppOutput,
  runtimeDirectory?: string
): number {
  const [command, ...rest] = arguments_;
  const options = runtimeDependency(runtimeDirectory);
  if (command === "schedule") {
    const [action, ...scheduleArguments] = rest;
    if (action === "status") {
      if (scheduleArguments.length > 1) {
        throw new Error("chat schedule status accepts at most one schedule id");
      }
      output.write(`${JSON.stringify(
        scheduleArguments[0] === undefined
          ? localTopicActivationSchedules(repoRoot, runtimeDirectory)
          : localTopicActivationSchedule(repoRoot, scheduleArguments[0], runtimeDirectory),
        null, 2
      )}\n`);
      return 0;
    }
    if (action === "create") {
      output.write(`${JSON.stringify(
        createLocalTopicActivationSchedule(
          repoRoot, parseTopicScheduleCreate(scheduleArguments), options
        ), null, 2
      )}\n`);
      return 0;
    }
    if (action === "pause" || action === "resume" || action === "cancel") {
      const scheduleId = scheduleArguments[0];
      if (scheduleId === undefined) {
        throw new Error(`chat schedule ${action} requires a schedule id`);
      }
      const revision = parseExpectedRevision(
        scheduleArguments.slice(1), `chat schedule ${action}`
      );
      const result = action === "pause"
        ? pauseLocalTopicActivationSchedule(repoRoot, scheduleId, revision, options)
        : action === "resume"
          ? resumeLocalTopicActivationSchedule(repoRoot, scheduleId, revision, options)
          : cancelLocalTopicActivationSchedule(repoRoot, scheduleId, revision, options);
      output.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    throw new Error("chat schedule requires status, create, pause, resume or cancel");
  }
  if (command === "free") {
    const [action, ...freeArguments] = rest;
    if (action === "status") {
      rejectArguments(freeArguments);
      output.write(`${JSON.stringify(
        inspectLocalFreeChat(repoRoot, runtimeDirectory), null, 2
      )}\n`);
      return 0;
    }
    if (action === "start") {
      const input = parseFreeChatStart(freeArguments);
      output.write(`${JSON.stringify(
        startLocalFreeChat(repoRoot, input, options), null, 2
      )}\n`);
      return 0;
    }
    if (action === "continue-now" || action === "exit") {
      const expectedRevision = parseExpectedRevision(
        freeArguments, `chat free ${action}`
      );
      const result = action === "continue-now"
        ? continueLocalFreeChatNow(repoRoot, expectedRevision, options)
        : exitLocalFreeChat(repoRoot, expectedRevision, options);
      output.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    throw new Error("chat free requires status, start, continue-now or exit");
  }
  if (command === "governance") {
    rejectArguments(rest);
    output.write(`${JSON.stringify(
      inspectLocalTopicGovernance(repoRoot, runtimeDirectory), null, 2
    )}\n`);
    return 0;
  }
  if (command === "pause" || command === "resume") {
    const expectedRevision = parseExpectedRevision(rest, `chat ${command}`);
    const result = command === "pause"
      ? pauseLocalTopic(repoRoot, expectedRevision, options)
      : resumeLocalTopic(repoRoot, expectedRevision, options);
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "resume-and-wake") {
    const change = parseResumeAndWake(rest);
    output.write(`${JSON.stringify(resumeAndWakeLocalChat(
      repoRoot,
      change.expectedRevision,
      change.idempotencyKey,
      options
    ), null, 2)}\n`);
    return 0;
  }
  if (command === "participant") {
    const action = rest[0];
    const handle = rest[1];
    if ((action !== "add" && action !== "remove") || handle === undefined) {
      throw new Error("chat participant requires add|remove <handle> --revision <revision>");
    }
    const expectedRevision = parseExpectedRevision(rest.slice(2), `chat participant ${action}`);
    const agent = requireLocalAgent(repoRoot, handle, options);
    const result = action === "add"
      ? addLocalTopicParticipant(repoRoot, agent.principalId, expectedRevision, options)
      : removeLocalTopicParticipant(repoRoot, agent.principalId, expectedRevision, options);
    output.write(`${JSON.stringify({ ...result, agent }, null, 2)}\n`);
    return 0;
  }
  if (command === "post") {
    const body = rest.join(" ").trim();
    if (body === "") throw new Error("chat post requires a non-empty message");
    const receipt = postLocalChatMessage(repoRoot, body, options);
    output.write(`${JSON.stringify({
      eventId: receipt.message.eventId,
      topicId: receipt.message.topicId,
      ...(receipt.message.targets === undefined ? {} : { targets: receipt.message.targets }),
      status: "queued"
    })}\n`);
    return 0;
  }
  if (command === "history") {
    output.write(`${JSON.stringify(
      localChatTimeline(repoRoot, options, parseChatHistoryOptions(rest)),
      null,
      2
    )}\n`);
    return 0;
  }
  if (command === "status") {
    rejectArguments(rest);
    output.write(`${JSON.stringify(localChatPresenceView(repoRoot, options), null, 2)}\n`);
    return 0;
  }
  if (command === "presence") {
    if (rest[0] !== "set") {
      throw new Error("chat presence requires set");
    }
    const change = parseChatPresenceSet(rest.slice(1));
    const agent = requireLocalAgent(repoRoot, change.handle, options);
    const presence = setLocalChatPresence(
      repoRoot,
      agent.principalId,
      change.presence,
      options
    );
    output.write(`${JSON.stringify({
      agentId: agent.principalId,
      handle: agent.handle,
      presence
    }, null, 2)}\n`);
    return 0;
  }
  if (command === "session") {
    if (rest[0] !== "new" || rest.length !== 2) {
      throw new Error("chat session new requires exactly one Agent handle");
    }
    const agent = requireLocalAgent(repoRoot, rest[1]!, options);
    const generation = rotateLocalAgentSession(
      repoRoot,
      agent.principalId,
      options
    );
    output.write(`${JSON.stringify({
      agentId: agent.principalId,
      handle: agent.handle,
      generation,
      currentSessionId: null
    })}\n`);
    return 0;
  }
  throw new Error(
    "chat requires schedule, governance, pause, resume, resume-and-wake, participant, " +
    "post, history, status, presence set or session new"
  );
}

function parseTopicScheduleCreate(arguments_: readonly string[]) {
  let kind: "once" | "cron" | undefined;
  let expression: string | undefined;
  let timezone: string | undefined;
  let misfirePolicy: "skip" | "run_once" | undefined;
  let misfireGraceMilliseconds: number | undefined;
  let candidatePolicy: "deterministic_one" | "sampled_sequential" | "all_available" | undefined;
  let intent: "continue_recent" | "choose_from_themes" | "directed" | undefined;
  let brief: string | undefined;
  let turnBudget: number | undefined;
  for (let offset = 0; offset < arguments_.length; offset += 2) {
    const option = arguments_[offset];
    const value = arguments_[offset + 1];
    if (value === undefined) throw new Error(`${option} requires a value`);
    if ((option === "--once" || option === "--cron") && kind === undefined) {
      kind = option === "--once" ? "once" : "cron";
      expression = value;
    } else if (option === "--timezone" && timezone === undefined) {
      timezone = value;
    } else if (option === "--misfire" && misfirePolicy === undefined &&
      (value === "skip" || value === "run_once")) {
      misfirePolicy = value;
    } else if (option === "--misfire-grace-ms" && misfireGraceMilliseconds === undefined) {
      misfireGraceMilliseconds = parseBoundedInteger(
        value, "chat schedule misfire grace", 0, 604_800_000
      );
    } else if (option === "--candidates" && candidatePolicy === undefined &&
      (value === "deterministic_one" || value === "sampled_sequential" ||
        value === "all_available")) {
      candidatePolicy = value;
    } else if (option === "--intent" && intent === undefined &&
      (value === "continue_recent" || value === "choose_from_themes" ||
        value === "directed")) {
      intent = value;
    } else if (option === "--brief" && brief === undefined) {
      brief = value;
    } else if (option === "--turn-budget" && turnBudget === undefined) {
      turnBudget = parseBoundedInteger(value, "chat schedule turn budget", 1, 64);
    } else {
      throw new Error(`unexpected chat schedule create option: ${option}`);
    }
  }
  if (kind === undefined || expression === undefined) {
    throw new Error("chat schedule create requires exactly one of --once or --cron");
  }
  if (kind === "cron" && timezone === undefined) {
    throw new Error("chat schedule create --cron requires --timezone");
  }
  if (kind === "once" && timezone !== undefined) {
    throw new Error("chat schedule create --once does not accept --timezone");
  }
  if (intent === "directed" && brief === undefined) {
    throw new Error("directed schedule intent requires --brief");
  }
  if (intent !== "directed" && brief !== undefined) {
    throw new Error("--brief requires --intent directed");
  }
  return {
    kind,
    expression,
    ...(timezone === undefined ? {} : { timezone }),
    ...(misfirePolicy === undefined ? {} : { misfirePolicy }),
    ...(misfireGraceMilliseconds === undefined ? {} : { misfireGraceMilliseconds }),
    ...(candidatePolicy === undefined ? {} : { candidatePolicy }),
    ...(intent === undefined ? {} : {
      intentPolicy: intent === "directed"
        ? { kind: "fixed_directed" as const, brief: brief! }
        : { kind: intent }
    }),
    ...(turnBudget === undefined ? {} : { turnBudget })
  };
}

function parseFreeChatStart(arguments_: readonly string[]) {
  let idempotencyKey: string | undefined;
  let intent: "continue_recent" | "choose_from_themes" | "directed" | undefined;
  let brief: string | undefined;
  for (let offset = 0; offset < arguments_.length; offset += 2) {
    const option = arguments_[offset];
    const value = arguments_[offset + 1];
    if (value === undefined) throw new Error(`${option} requires a value`);
    if (option === "--idempotency-key" && idempotencyKey === undefined) {
      idempotencyKey = value;
    } else if (option === "--intent" && intent === undefined &&
      (value === "continue_recent" || value === "choose_from_themes" ||
        value === "directed")) {
      intent = value;
    } else if (option === "--brief" && brief === undefined) {
      brief = value;
    } else {
      throw new Error(`unexpected chat free start option: ${option}`);
    }
  }
  if (idempotencyKey === undefined) {
    throw new Error("chat free start requires --idempotency-key");
  }
  if (intent === "directed" && brief === undefined) {
    throw new Error("directed Free Chat intent requires --brief");
  }
  if (intent !== "directed" && brief !== undefined) {
    throw new Error("--brief requires --intent directed");
  }
  return {
    idempotencyKey,
    ...(intent === undefined ? {} : {
      intentPolicy: intent === "directed"
        ? { kind: "fixed_directed" as const, brief: brief! }
        : { kind: intent }
    })
  };
}

function parseExpectedRevision(arguments_: readonly string[], command: string): number {
  if (arguments_.length !== 2 || arguments_[0] !== "--revision") {
    throw new Error(`${command} requires --revision <positive-integer>`);
  }
  return parseBoundedInteger(arguments_[1]!, `${command} revision`, 1, 1_000_000);
}

function parseResumeAndWake(arguments_: readonly string[]): {
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
} {
  let expectedRevision: number | undefined;
  let idempotencyKey: string | undefined;
  for (let offset = 0; offset < arguments_.length; offset += 2) {
    const option = arguments_[offset];
    const value = arguments_[offset + 1];
    if (value === undefined) throw new Error(`${option} requires a value`);
    if (option === "--revision" && expectedRevision === undefined) {
      expectedRevision = parseBoundedInteger(
        value, "chat resume-and-wake revision", 1, 1_000_000
      );
    } else if (option === "--idempotency-key" && idempotencyKey === undefined &&
      value.trim() !== "") {
      idempotencyKey = value;
    } else {
      throw new Error(`unexpected chat resume-and-wake option: ${option}`);
    }
  }
  if (expectedRevision === undefined || idempotencyKey === undefined) {
    throw new Error(
      "chat resume-and-wake requires --revision and --idempotency-key"
    );
  }
  return { expectedRevision, idempotencyKey };
}

function parseChatHistoryOptions(arguments_: readonly string[]): ChatTimelineOptions {
  let beforeEventId: string | undefined;
  let limit: number | undefined;
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) {
      throw new Error("chat history options require a value");
    }
    if (option === "--before") {
      if (beforeEventId !== undefined || value.trim() === "") {
        throw new Error("chat history --before requires one non-empty Event id");
      }
      beforeEventId = value;
      continue;
    }
    if (option === "--limit") {
      if (limit !== undefined) throw new Error("chat history --limit may appear once");
      limit = parseBoundedInteger(value, "chat history limit", 1, 200);
      continue;
    }
    throw new Error(`unknown chat history option: ${option}`);
  }
  return {
    ...(beforeEventId === undefined ? {} : { beforeEventId }),
    ...(limit === undefined ? {} : { limit })
  };
}

function parseChatPresenceSet(arguments_: readonly string[]) {
  const handle = arguments_[0];
  if (handle === undefined || handle.trim() === "") {
    throw new Error("chat presence set requires an Agent handle");
  }
  let scope: "topic" | "global" | undefined;
  let mode: "available" | "snoozed" | undefined;
  let until: string | undefined;
  const wakeKeywords: string[] = [];
  for (let offset = 1; offset < arguments_.length; offset += 2) {
    const option = arguments_[offset];
    const value = arguments_[offset + 1];
    if (value === undefined) throw new Error(`${option} requires a value`);
    if (option === "--scope") {
      if (value !== "topic" && value !== "global") {
        throw new Error("chat presence scope must be topic or global");
      }
      scope = value;
    } else if (option === "--mode") {
      if (value !== "available" && value !== "snoozed") {
        throw new Error("chat presence mode must be available or snoozed");
      }
      mode = value;
    } else if (option === "--until") {
      until = value;
    } else if (option === "--wake-keyword") {
      wakeKeywords.push(value);
    } else {
      throw new Error(`unexpected chat presence option: ${option}`);
    }
  }
  if (scope === undefined || mode === undefined) {
    throw new Error("chat presence set requires --scope and --mode");
  }
  if (mode === "available") {
    if (until !== undefined || wakeKeywords.length !== 0) {
      throw new Error("available presence does not accept --until or --wake-keyword");
    }
    return { handle, presence: { scope, mode, wakeKeywords: [] } };
  }
  if (until === undefined) {
    throw new Error("snoozed presence requires --until");
  }
  return { handle, presence: { scope, mode, until, wakeKeywords } };
}
