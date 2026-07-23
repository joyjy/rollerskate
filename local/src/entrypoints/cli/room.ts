import type {
  AgentRoomBindingSummary,
  RoomEventProjection,
  RoomSummary
} from "../../protocol.js";
import {
  addAgentToRoom,
  allowAdmissionSubject,
  configureRoomPolicy,
  createRoom,
  inviteHuman,
  joinRoom,
  listAgentRoomBindings,
  listRooms,
  removeAgentFromRoom,
  roomHistory,
  sendAgentRoomMessage,
  sendRoomMessage,
  updateAgentRoomWakeMode,
  type RoomPolicyUpdate
} from "../../application/room-control.js";

interface CommandOutput {
  readonly write: (text: string) => void;
}

export async function runAdminCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: CommandOutput,
  runtimeDirectory?: string
): Promise<number> {
  const [command, ...rest] = arguments_;
  if (command !== "allow" || rest.length !== 1) {
    throw new Error("admin allow requires exactly one OIDC subject");
  }
  await allowAdmissionSubject(repoRoot, rest[0]!, dependency(runtimeDirectory));
  output.write(`OIDC subject admitted: ${rest[0]}\n`);
  return 0;
}

export async function runRoomCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: CommandOutput,
  runtimeDirectory?: string
): Promise<number> {
  const [command, ...rest] = arguments_;
  const dependencies = dependency(runtimeDirectory);
  if (command === "create") {
    const isPublic = rest.at(-1) === "--public";
    const name = (isPublic ? rest.slice(0, -1) : rest).join(" ").trim();
    if (name === "") throw new Error("room create requires a name");
    output.write(formatRoom("Room created.", await createRoom(
      repoRoot,
      name,
      isPublic ? "public" : "private",
      dependencies
    )));
    return 0;
  }
  if (command === "list") {
    rejectArguments(rest);
    const rooms = await listRooms(repoRoot, dependencies);
    output.write(rooms.length === 0
      ? "No Rooms are visible to this Human.\n"
      : `${rooms.map((room) => formatRoom("Room", room).trimEnd()).join("\n\n")}\n`);
    return 0;
  }
  if (command === "join") {
    requireCount(rest, 1, "room join requires exactly one Room id");
    output.write(formatRoom("Room joined.", await joinRoom(repoRoot, rest[0]!, dependencies)));
    return 0;
  }
  if (command === "invite-human") {
    requireCount(rest, 2, "room invite-human requires <room-id> <human-id>");
    output.write(formatRoom("Human invited.", await inviteHuman(
      repoRoot,
      rest[0]!,
      rest[1]!,
      dependencies
    )));
    return 0;
  }
  if (command === "add-agent") {
    requireCount(rest, 2, "room add-agent requires <room-id> <agent-name>");
    output.write(formatBinding("Agent added to Room.", await addAgentToRoom(
      repoRoot,
      rest[0]!,
      rest[1]!,
      dependencies
    )));
    return 0;
  }
  if (command === "set-wake") {
    requireCount(rest, 3, "room set-wake requires <room-id> <agent-name> <mode>");
    const wakeMode = rest[2];
    if (wakeMode !== "disabled" && wakeMode !== "mention_only" && wakeMode !== "proactive") {
      throw new Error("wake mode must be disabled, mention_only or proactive");
    }
    output.write(formatBinding("Agent wake mode updated.", await updateAgentRoomWakeMode(
      repoRoot,
      rest[0]!,
      rest[1]!,
      wakeMode,
      dependencies
    )));
    return 0;
  }
  if (command === "remove-agent") {
    requireCount(rest, 2, "room remove-agent requires <room-id> <agent-name>");
    await removeAgentFromRoom(repoRoot, rest[0]!, rest[1]!, dependencies);
    output.write(`Agent ${rest[1]} removed from Room ${rest[0]}.\n`);
    return 0;
  }
  if (command === "bindings") {
    requireCount(rest, 1, "room bindings requires exactly one Agent name");
    const bindings = await listAgentRoomBindings(repoRoot, rest[0]!, dependencies);
    output.write(bindings.length === 0
      ? `Agent ${rest[0]} has no active Room bindings.\n`
      : `${bindings.map((binding) => formatBinding("Binding", binding).trimEnd())
        .join("\n\n")}\n`);
    return 0;
  }
  if (command === "policy") {
    if (rest.length < 4 || rest.length % 2 !== 0) {
      throw new Error("room policy requires <room-id> <agent-name> and one or more policy flags");
    }
    const policy = configureRoomPolicy(
      repoRoot,
      rest[0]!,
      rest[1]!,
      parsePolicy(rest.slice(2)),
      dependencies
    );
    output.write(`Room policy updated.\n${JSON.stringify(policy, null, 2)}\n`);
    return 0;
  }
  if (command === "send") {
    if (rest.length < 2) throw new Error("room send requires <room-id> <message...>");
    const receipt = await sendRoomMessage(repoRoot, rest[0]!, rest.slice(1).join(" "), dependencies);
    output.write(receiptText("Room message sent.", receipt));
    return 0;
  }
  if (command === "agent-send") {
    if (rest.length < 3) {
      throw new Error("room agent-send requires <room-id> <agent-name> <message...>");
    }
    const receipt = await sendAgentRoomMessage(
      repoRoot,
      rest[0]!,
      rest[1]!,
      rest.slice(2).join(" "),
      dependencies
    );
    output.write(receiptText("Agent Room message sent.", receipt));
    return 0;
  }
  if (command === "history") {
    if (rest.length !== 2 && !(rest.length === 4 && rest[2] === "--limit")) {
      throw new Error("room history requires <room-id> <agent-name> [--limit <1-100>]");
    }
    const events = await roomHistory(
      repoRoot,
      rest[0]!,
      rest[1]!,
      rest.length === 4 ? Number(rest[3]) : 50,
      dependencies
    );
    output.write(events.length === 0
      ? "Room history is empty.\n"
      : `${events.map(formatHistoryEvent).join("\n")}\n`);
    return 0;
  }
  throw new Error(
    "room requires create, list, join, invite-human, add-agent, set-wake, " +
    "remove-agent, bindings, policy, send, agent-send or history"
  );
}

function parsePolicy(arguments_: readonly string[]): RoomPolicyUpdate {
  let ownerMessageWake: "never" | "mention_only" | "normal" | undefined;
  const values = new Map<keyof Omit<RoomPolicyUpdate, "ownerMessageWake">, number>();
  const numeric = new Map<string, keyof Omit<RoomPolicyUpdate, "ownerMessageWake">>([
    ["--interval-ms", "intervalMilliseconds"],
    ["--max-wakes", "maxWakesPerHour"],
    ["--max-replies", "maxRepliesPerHour"],
    ["--input-tokens", "maxInputTokensPerTurn"],
    ["--output-tokens", "maxOutputTokensPerTurn"],
    ["--daily-tokens", "maxDailyTokens"]
  ]);
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index]!;
    const value = arguments_[index + 1]!;
    if (flag === "--owner-wake") {
      if (value !== "never" && value !== "mention_only" && value !== "normal") {
        throw new Error("--owner-wake must be never, mention_only or normal");
      }
      ownerMessageWake = value;
      continue;
    }
    const field = numeric.get(flag);
    if (field === undefined) throw new Error(`unknown Room policy flag: ${flag}`);
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) {
      throw new Error(`${flag} must be a non-negative integer`);
    }
    values.set(field, number);
  }
  return {
    ...(ownerMessageWake === undefined ? {} : { ownerMessageWake }),
    ...(values.has("intervalMilliseconds")
      ? { intervalMilliseconds: values.get("intervalMilliseconds")! } : {}),
    ...(values.has("maxWakesPerHour")
      ? { maxWakesPerHour: values.get("maxWakesPerHour")! } : {}),
    ...(values.has("maxRepliesPerHour")
      ? { maxRepliesPerHour: values.get("maxRepliesPerHour")! } : {}),
    ...(values.has("maxInputTokensPerTurn")
      ? { maxInputTokensPerTurn: values.get("maxInputTokensPerTurn")! } : {}),
    ...(values.has("maxOutputTokensPerTurn")
      ? { maxOutputTokensPerTurn: values.get("maxOutputTokensPerTurn")! } : {}),
    ...(values.has("maxDailyTokens")
      ? { maxDailyTokens: values.get("maxDailyTokens")! } : {})
  };
}

function formatRoom(prefix: string, room: RoomSummary): string {
  return [
    prefix,
    `Room: ${room.name} (${room.id})`,
    `Matrix: ${room.matrixRoomId}`,
    `Visibility: ${room.visibility}`,
    `Head: ${room.head}`,
    ...(room.membership === undefined ? [] : [
      `Membership: ${room.membership.status} (${room.membership.role})`,
      `Can invite: ${room.membership.canInvite ? "yes" : "no"}`
    ])
  ].join("\n") + "\n";
}

function formatBinding(prefix: string, binding: AgentRoomBindingSummary): string {
  return [
    prefix,
    `Binding: ${binding.id}`,
    `Room: ${binding.roomId}`,
    `Agent: ${binding.agentId}`,
    `Wake: ${binding.wakeMode}`,
    `Status: ${binding.status}`
  ].join("\n") + "\n";
}

function formatHistoryEvent(projection: RoomEventProjection): string {
  const payload = projection.event.payload;
  const body = typeof payload === "object" && payload !== null && !Array.isArray(payload) &&
    typeof payload.body === "string" ? payload.body : JSON.stringify(payload);
  return `${projection.position} ${projection.event.source.kind}:` +
    `${projection.event.source.id} ${body}`;
}

function receiptText(
  prefix: string,
  receipt: { readonly eventId: string; readonly transactionId: string }
): string {
  return [prefix, `Event: ${receipt.eventId}`, `Transaction: ${receipt.transactionId}`]
    .join("\n") + "\n";
}

function dependency(runtimeDirectory: string | undefined): { readonly runtimeDirectory?: string } {
  return runtimeDirectory === undefined ? {} : { runtimeDirectory };
}

function requireCount(arguments_: readonly string[], count: number, message: string): void {
  if (arguments_.length !== count) throw new Error(message);
}

function rejectArguments(arguments_: readonly string[]): void {
  if (arguments_.length > 0) throw new Error(`unexpected arguments: ${arguments_.join(" ")}`);
}
