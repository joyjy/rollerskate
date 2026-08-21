import {
  bindInteractiveChannel,
  revokeInteractiveChannel,
  sendInteractiveChannelMessage,
  stopInteractiveChannelFollow
} from "../../application/channel/control.js";
import {
  inspectInteractiveChannelBinding,
  inspectInteractiveChannelFollow,
  followInteractiveChannel
} from "../../application/channel/query.js";
import type { ChannelRef } from "../../application/channel/control.js";
import { requireLocalAgent } from "./agent.js";
import type { AppOutput, LocalAppDependencies } from "./shared.js";
import { parseBoundedInteger, runtimeDependency } from "./shared.js";

export async function runChannelCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: AppOutput,
  runtimeDirectory: string | undefined,
  dependencies: LocalAppDependencies
): Promise<number> {
  const [command, ...rest] = arguments_;
  const options = {
    ...runtimeDependency(runtimeDirectory),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now })
  };
  if (command === "bind") {
    const handle = rest[0];
    if (handle === undefined) throw new Error("channel bind requires an Agent handle");
    const parsed = parseBinding(rest.slice(1));
    const agent = requireLocalAgent(repoRoot, handle, options);
    output.write(`${JSON.stringify(bindInteractiveChannel(repoRoot, {
      agentId: agent.principalId,
      allowedChannelRefs: parsed.refs,
      expiresAt: parsed.expiresAt,
      ...(parsed.callbackSessionId === undefined
        ? {} : { callbackSessionId: parsed.callbackSessionId })
    }, options), null, 2)}\n`);
    return 0;
  }
  if (command === "send") {
    const bindingId = rest[0];
    const ref = rest[1];
    const idempotencyKey = rest[2];
    const body = rest.slice(3).join(" ").trim();
    if (bindingId === undefined || ref === undefined || idempotencyKey === undefined || body === "") {
      throw new Error(
        "channel send requires <binding-id> <kind:channel-id> <idempotency-key> <message...>"
      );
    }
    output.write(`${JSON.stringify(await sendInteractiveChannelMessage(repoRoot, {
      bindingId,
      channelRef: parseChannelRef(ref),
      idempotencyKey,
      body
    }, options), null, 2)}\n`);
    return 0;
  }
  if (command === "status") {
    if (rest.length !== 1) throw new Error("channel status requires one binding id");
    output.write(`${JSON.stringify(
      inspectInteractiveChannelBinding(repoRoot, rest[0]!, runtimeDirectory), null, 2
    )}\n`);
    return 0;
  }
  if (command === "follow") {
    const followOptions = parseFollow(rest);
    const result = followOptions.waitMilliseconds === undefined
      ? inspectInteractiveChannelFollow(repoRoot, rest[0]!, runtimeDirectory)
      : await followInteractiveChannel(repoRoot, rest[0]!, followOptions.waitMilliseconds, {
          ...options,
          ...(followOptions.afterCursor === undefined
            ? {} : { afterCursor: followOptions.afterCursor })
        });
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (command === "revoke" || command === "stop") {
    if (rest.length !== 3 || rest[1] !== "--revision") {
      throw new Error(`channel ${command} requires <id> --revision <revision>`);
    }
    const revision = parseBoundedInteger(
      rest[2]!, `channel ${command} revision`, 1, 1_000_000
    );
    const result = command === "revoke"
      ? revokeInteractiveChannel(repoRoot, rest[0]!, revision, options)
      : stopInteractiveChannelFollow(repoRoot, rest[0]!, revision, options);
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  throw new Error("channel requires bind, send, status, follow, revoke or stop");
}

function parseFollow(arguments_: readonly string[]) {
  if (arguments_.length < 1) {
    throw new Error("channel follow requires <follow-token> [--wait <milliseconds>] [--after <cursor>]");
  }
  let waitMilliseconds: number | undefined;
  let afterCursor: string | undefined;
  for (let offset = 1; offset < arguments_.length; offset += 2) {
    const option = arguments_[offset];
    const value = arguments_[offset + 1];
    if (value === undefined) throw new Error(`${option} requires a value`);
    if (option === "--wait" && waitMilliseconds === undefined) {
      waitMilliseconds = parseBoundedInteger(value, "channel follow wait", 0, 30_000);
    } else if (option === "--after" && afterCursor === undefined && value.trim() !== "") {
      afterCursor = value;
    } else {
      throw new Error(`unexpected channel follow option: ${option}`);
    }
  }
  if (afterCursor !== undefined && waitMilliseconds === undefined) waitMilliseconds = 0;
  return { waitMilliseconds, afterCursor };
}

function parseBinding(arguments_: readonly string[]) {
  const refs: ChannelRef[] = [];
  let expiresAt: string | undefined;
  let callbackSessionId: string | undefined;
  for (let offset = 0; offset < arguments_.length; offset += 2) {
    const option = arguments_[offset];
    const value = arguments_[offset + 1];
    if (value === undefined) throw new Error(`${option} requires a value`);
    if (option === "--allow") refs.push(parseChannelRef(value));
    else if (option === "--expires" && expiresAt === undefined) expiresAt = value;
    else if (option === "--callback-session" && callbackSessionId === undefined) {
      callbackSessionId = value;
    } else throw new Error(`unexpected channel bind option: ${option}`);
  }
  if (refs.length === 0 || expiresAt === undefined) {
    throw new Error("channel bind requires --allow and --expires");
  }
  return { refs, expiresAt, callbackSessionId };
}

function parseChannelRef(value: string): ChannelRef {
  const separator = value.indexOf(":");
  const kind = value.slice(0, separator);
  const channelId = value.slice(separator + 1);
  if ((kind !== "local-chat" && kind !== "server-topic") || channelId === "") {
    throw new Error("Channel ref must be local-chat:<id> or server-topic:<id>");
  }
  return { kind, channelId };
}
