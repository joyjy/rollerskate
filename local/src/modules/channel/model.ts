import { moduleId, requireModuleId } from "../shared/id.js";

export type ChannelRef =
  | { readonly kind: "local-chat"; readonly channelId: string }
  | { readonly kind: "server-topic"; readonly channelId: string };

export type InteractiveChannelBindingStatus = "active" | "revoked" | "expired";

export interface InteractiveChannelBinding {
  readonly schema: "InteractiveChannelBinding@1";
  readonly bindingId: string;
  readonly agentId: string;
  readonly allowedChannelRefs: readonly ChannelRef[];
  readonly callbackSessionId?: string;
  readonly status: InteractiveChannelBindingStatus;
  readonly expiresAt: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateInteractiveChannelBinding {
  readonly agentId: string;
  readonly allowedChannelRefs: readonly ChannelRef[];
  readonly callbackSessionId?: string;
  readonly expiresAt: string;
}

export type ChannelSendStatus = "pending" | "accepted" | "failed";

export interface ChannelSendReceipt {
  readonly schema: "ChannelSendReceipt@1";
  readonly sendId: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly senderAgentId: string;
  readonly channelRef: ChannelRef;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly body: string;
  readonly transactionId: string;
  readonly status: ChannelSendStatus;
  readonly observedCursor?: string;
  readonly followToken: string;
  readonly messageEventId?: string;
  readonly remoteMessageId?: string;
  readonly conversationRootId?: string;
  readonly failure?: string;
  readonly acceptedAt?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ChannelFollowCondition = "first_reply" | "quiet" | "terminal" | "failed";
export type ChannelFollowStatus =
  | "waiting"
  | "active"
  | "quiet"
  | "terminal"
  | "failed"
  | "expired"
  | "stopped";
export type ChannelCallbackStatus =
  | "armed"
  | "pending"
  | "admitted"
  | "failed"
  | "expired"
  | "revoked";

export interface ChannelCallbackState {
  readonly sessionId: string;
  readonly status: ChannelCallbackStatus;
  readonly callbackEventId?: string;
  readonly failure?: string;
  readonly updatedAt: string;
}

export interface ChannelFollow {
  readonly schema: "ChannelFollow@1";
  readonly followToken: string;
  readonly sendId: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly channelRef: ChannelRef;
  readonly afterCursor?: string;
  readonly currentCursor?: string;
  readonly condition: ChannelFollowCondition;
  readonly quietWindowMilliseconds: number;
  readonly deadlineAt: string;
  readonly lastObservedAt: string;
  readonly status: ChannelFollowStatus;
  readonly callback?: ChannelCallbackState;
  readonly failure?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelFollow {
  readonly followToken?: string;
  readonly sendId: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly channelRef: ChannelRef;
  readonly afterCursor?: string;
  readonly condition: ChannelFollowCondition;
  readonly quietWindowMilliseconds: number;
  readonly deadlineAt: string;
  readonly callbackSessionId?: string;
}

export function newInteractiveChannelBindingId(): string {
  return moduleId("chn");
}

export function newChannelSendId(): string {
  return moduleId("snd");
}

export function newChannelFollowToken(): string {
  return moduleId("fol");
}

export function requireInteractiveChannelBindingId(value: string): string {
  return requireModuleId(value, "chn", "bindingId");
}

export function requireChannelSendId(value: string): string {
  return requireModuleId(value, "snd", "sendId");
}

export function requireChannelFollowToken(value: string): string {
  return requireModuleId(value, "fol", "followToken");
}

export function parseChannelRef(value: unknown, field = "channelRef"): ChannelRef {
  const record = object(value, field);
  return {
    kind: oneOf(record.kind, ["local-chat", "server-topic"] as const, `${field}.kind`),
    channelId: text(record.channelId, `${field}.channelId`, 512)
  };
}

export function channelRefKey(refInput: ChannelRef): string {
  const ref = parseChannelRef(refInput);
  return `${ref.kind}:${ref.channelId}`;
}

export function channelRefAllowed(
  binding: InteractiveChannelBinding,
  refInput: ChannelRef
): boolean {
  const key = channelRefKey(refInput);
  return binding.allowedChannelRefs.some((candidate) => channelRefKey(candidate) === key);
}

export function interactiveChannelBindingAvailableAt(
  binding: InteractiveChannelBinding,
  atInput: string
): boolean {
  const at = iso(atInput, "at");
  return binding.status === "active" && Date.parse(binding.expiresAt) > Date.parse(at);
}

export function createInteractiveChannelBinding(
  input: CreateInteractiveChannelBinding,
  atInput: string
): InteractiveChannelBinding {
  const at = iso(atInput, "at");
  const binding = parseInteractiveChannelBinding({
    schema: "InteractiveChannelBinding@1",
    bindingId: newInteractiveChannelBindingId(),
    agentId: input.agentId,
    allowedChannelRefs: input.allowedChannelRefs,
    ...(input.callbackSessionId === undefined
      ? {}
      : { callbackSessionId: input.callbackSessionId }),
    status: "active",
    expiresAt: input.expiresAt,
    revision: 1,
    createdAt: at,
    updatedAt: at
  });
  if (Date.parse(binding.expiresAt) <= Date.parse(at)) {
    throw new Error("Interactive Channel binding expiresAt must be after creation");
  }
  return binding;
}

export function transitionInteractiveChannelBinding(
  currentInput: InteractiveChannelBinding,
  status: Exclude<InteractiveChannelBindingStatus, "active">,
  atInput: string
): InteractiveChannelBinding {
  const current = parseInteractiveChannelBinding(currentInput);
  const at = iso(atInput, "at");
  if (current.status !== "active") {
    if (current.status === status) return current;
    throw new Error(`Interactive Channel binding cannot become ${status} from ${current.status}`);
  }
  return parseInteractiveChannelBinding({
    ...current,
    status,
    revision: current.revision + 1,
    updatedAt: at
  });
}

export function parseInteractiveChannelBinding(value: unknown): InteractiveChannelBinding {
  const record = object(value, "InteractiveChannelBinding");
  if (record.schema !== "InteractiveChannelBinding@1") {
    throw new Error("Interactive Channel binding schema is unsupported");
  }
  const refs = array(record.allowedChannelRefs, "allowedChannelRefs")
    .map((entry, index) => parseChannelRef(entry, `allowedChannelRefs[${index}]`));
  if (refs.length < 1 || refs.length > 64) {
    throw new Error("allowedChannelRefs must contain 1-64 Channels");
  }
  if (new Set(refs.map(channelRefKey)).size !== refs.length) {
    throw new Error("allowedChannelRefs must not contain duplicates");
  }
  const callbackSessionId = record.callbackSessionId === undefined
    ? undefined
    : requireModuleId(text(record.callbackSessionId, "callbackSessionId", 64), "ses", "callbackSessionId");
  return {
    schema: "InteractiveChannelBinding@1",
    bindingId: requireInteractiveChannelBindingId(text(record.bindingId, "bindingId", 64)),
    agentId: requireModuleId(text(record.agentId, "agentId", 64), "prn", "agentId"),
    allowedChannelRefs: refs,
    ...(callbackSessionId === undefined ? {} : { callbackSessionId }),
    status: oneOf(record.status, ["active", "revoked", "expired"] as const, "status"),
    expiresAt: iso(record.expiresAt, "expiresAt"),
    revision: integer(record.revision, "revision", 1, 1_000_000),
    createdAt: iso(record.createdAt, "createdAt"),
    updatedAt: iso(record.updatedAt, "updatedAt")
  };
}

export function createPendingChannelSend(input: {
  readonly binding: InteractiveChannelBinding;
  readonly channelRef: ChannelRef;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly body: string;
  readonly observedCursor?: string;
  readonly at: string;
}): ChannelSendReceipt {
  const binding = parseInteractiveChannelBinding(input.binding);
  const channelRef = parseChannelRef(input.channelRef);
  if (!channelRefAllowed(binding, channelRef)) {
    throw new Error(`Channel is not allowed by binding: ${channelRefKey(channelRef)}`);
  }
  const sendId = newChannelSendId();
  const at = iso(input.at, "at");
  if (!interactiveChannelBindingAvailableAt(binding, at)) {
    throw new Error("Interactive Channel binding is not active at send admission");
  }
  return parseChannelSendReceipt({
    schema: "ChannelSendReceipt@1",
    sendId,
    bindingId: binding.bindingId,
    bindingRevision: binding.revision,
    senderAgentId: binding.agentId,
    channelRef,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: input.requestFingerprint,
    body: input.body,
    transactionId: `channel-send:${sendId}`,
    status: "pending",
    ...(input.observedCursor === undefined ? {} : { observedCursor: input.observedCursor }),
    followToken: newChannelFollowToken(),
    revision: 1,
    createdAt: at,
    updatedAt: at
  });
}

export function acceptChannelSend(currentInput: ChannelSendReceipt, input: {
  readonly observedCursor: string;
  readonly messageEventId?: string;
  readonly remoteMessageId?: string;
  readonly conversationRootId?: string;
  readonly at: string;
}): ChannelSendReceipt {
  const current = parseChannelSendReceipt(currentInput);
  if (current.status === "accepted") return current;
  if (current.status !== "pending") throw new Error("Only a pending Channel send can be accepted");
  return parseChannelSendReceipt({
    ...current,
    status: "accepted",
    observedCursor: input.observedCursor,
    ...(input.messageEventId === undefined ? {} : { messageEventId: input.messageEventId }),
    ...(input.remoteMessageId === undefined ? {} : { remoteMessageId: input.remoteMessageId }),
    ...(input.conversationRootId === undefined
      ? {}
      : { conversationRootId: input.conversationRootId }),
    acceptedAt: input.at,
    revision: current.revision + 1,
    updatedAt: input.at
  });
}

export function failChannelSend(
  currentInput: ChannelSendReceipt,
  failure: string,
  at: string
): ChannelSendReceipt {
  const current = parseChannelSendReceipt(currentInput);
  if (current.status === "failed") return current;
  if (current.status !== "pending") throw new Error("Only a pending Channel send can fail");
  return parseChannelSendReceipt({
    ...current,
    status: "failed",
    failure,
    revision: current.revision + 1,
    updatedAt: at
  });
}

export function parseChannelSendReceipt(value: unknown): ChannelSendReceipt {
  const record = object(value, "ChannelSendReceipt");
  if (record.schema !== "ChannelSendReceipt@1") {
    throw new Error("Channel send receipt schema is unsupported");
  }
  const status = oneOf(record.status, ["pending", "accepted", "failed"] as const, "status");
  const channelRef = parseChannelRef(record.channelRef);
  const messageEventId = optionalText(record.messageEventId, "messageEventId", 256);
  const remoteMessageId = optionalText(record.remoteMessageId, "remoteMessageId", 512);
  const observedCursor = optionalText(record.observedCursor, "observedCursor", 2_048);
  const acceptedAt = optionalIso(record.acceptedAt, "acceptedAt");
  const failure = optionalText(record.failure, "failure", 4_096);
  if (status === "accepted" && (observedCursor === undefined || acceptedAt === undefined)) {
    throw new Error("Accepted Channel send requires observedCursor and acceptedAt");
  }
  if (status === "accepted" && channelRef.kind === "local-chat" && messageEventId === undefined) {
    throw new Error("Accepted Local Chat send requires messageEventId");
  }
  if (status === "accepted" && channelRef.kind === "server-topic" && remoteMessageId === undefined) {
    throw new Error("Accepted Server Topic send requires remoteMessageId");
  }
  if (status === "failed" && failure === undefined) {
    throw new Error("Failed Channel send requires failure");
  }
  if (status === "pending" && (acceptedAt !== undefined || failure !== undefined)) {
    throw new Error("Pending Channel send cannot have acceptedAt or failure");
  }
  return {
    schema: "ChannelSendReceipt@1",
    sendId: requireChannelSendId(text(record.sendId, "sendId", 64)),
    bindingId: requireInteractiveChannelBindingId(text(record.bindingId, "bindingId", 64)),
    bindingRevision: integer(record.bindingRevision, "bindingRevision", 1, 1_000_000),
    senderAgentId: requireModuleId(text(record.senderAgentId, "senderAgentId", 64), "prn", "senderAgentId"),
    channelRef,
    idempotencyKey: text(record.idempotencyKey, "idempotencyKey", 512),
    requestFingerprint: text(record.requestFingerprint, "requestFingerprint", 256),
    body: text(record.body, "body", 16_384),
    transactionId: text(record.transactionId, "transactionId", 256),
    status,
    ...(observedCursor === undefined ? {} : { observedCursor }),
    followToken: requireChannelFollowToken(text(record.followToken, "followToken", 64)),
    ...(messageEventId === undefined ? {} : { messageEventId }),
    ...(remoteMessageId === undefined ? {} : { remoteMessageId }),
    ...(optionalText(record.conversationRootId, "conversationRootId", 256) === undefined
      ? {}
      : { conversationRootId: optionalText(record.conversationRootId, "conversationRootId", 256)! }),
    ...(failure === undefined ? {} : { failure }),
    ...(acceptedAt === undefined ? {} : { acceptedAt }),
    revision: integer(record.revision, "revision", 1, 1_000_000),
    createdAt: iso(record.createdAt, "createdAt"),
    updatedAt: iso(record.updatedAt, "updatedAt")
  };
}

export function createChannelFollow(input: CreateChannelFollow, atInput: string): ChannelFollow {
  const at = iso(atInput, "at");
  const follow = parseChannelFollow({
    schema: "ChannelFollow@1",
    followToken: input.followToken ?? newChannelFollowToken(),
    sendId: input.sendId,
    bindingId: input.bindingId,
    bindingRevision: input.bindingRevision,
    channelRef: input.channelRef,
    ...(input.afterCursor === undefined ? {} : { afterCursor: input.afterCursor }),
    ...(input.afterCursor === undefined ? {} : { currentCursor: input.afterCursor }),
    condition: input.condition,
    quietWindowMilliseconds: input.quietWindowMilliseconds,
    deadlineAt: input.deadlineAt,
    lastObservedAt: at,
    status: "waiting",
    ...(input.callbackSessionId === undefined ? {} : {
      callback: {
        sessionId: input.callbackSessionId,
        status: "armed",
        updatedAt: at
      }
    }),
    revision: 1,
    createdAt: at,
    updatedAt: at
  });
  if (Date.parse(follow.deadlineAt) <= Date.parse(at)) {
    throw new Error("Channel follow deadlineAt must be after creation");
  }
  return follow;
}

export function transitionChannelFollow(currentInput: ChannelFollow, input: {
  readonly status: ChannelFollowStatus;
  readonly currentCursor?: string;
  readonly failure?: string;
  readonly callback?: ChannelCallbackState;
  readonly at: string;
}): ChannelFollow {
  const current = parseChannelFollow(currentInput);
  if (terminalFollowStatus(current.status)) {
    if (current.status === input.status) return current;
    throw new Error(`Terminal Channel follow cannot become ${input.status}`);
  }
  return parseChannelFollow({
    ...current,
    status: input.status,
    ...(input.currentCursor === undefined ? {} : { currentCursor: input.currentCursor }),
    ...(input.currentCursor === undefined ? {} : { lastObservedAt: input.at }),
    ...(input.failure === undefined ? {} : { failure: input.failure }),
    ...(input.callback === undefined ? {} : { callback: input.callback }),
    revision: current.revision + 1,
    updatedAt: input.at
  });
}

export function parseChannelFollow(value: unknown): ChannelFollow {
  const record = object(value, "ChannelFollow");
  if (record.schema !== "ChannelFollow@1") throw new Error("Channel follow schema is unsupported");
  const channelRef = parseChannelRef(record.channelRef);
  const condition = oneOf(
    record.condition, ["first_reply", "quiet", "terminal", "failed"] as const, "condition"
  );
  if (channelRef.kind === "server-topic" && (condition === "first_reply" || condition === "terminal")) {
    throw new Error("Server Topic follow cannot claim first_reply or terminal without correlation");
  }
  const status = oneOf(record.status, [
    "waiting", "active", "quiet", "terminal", "failed", "expired", "stopped"
  ] as const, "status");
  const callback = record.callback === undefined ? undefined : parseCallback(record.callback);
  const failure = optionalText(record.failure, "failure", 4_096);
  if (status === "failed" && failure === undefined) {
    throw new Error("Failed Channel follow requires failure");
  }
  return {
    schema: "ChannelFollow@1",
    followToken: requireChannelFollowToken(text(record.followToken, "followToken", 64)),
    sendId: requireChannelSendId(text(record.sendId, "sendId", 64)),
    bindingId: requireInteractiveChannelBindingId(text(record.bindingId, "bindingId", 64)),
    bindingRevision: integer(record.bindingRevision, "bindingRevision", 1, 1_000_000),
    channelRef,
    ...(optionalText(record.afterCursor, "afterCursor", 2_048) === undefined
      ? {}
      : { afterCursor: optionalText(record.afterCursor, "afterCursor", 2_048)! }),
    ...(optionalText(record.currentCursor, "currentCursor", 2_048) === undefined
      ? {}
      : { currentCursor: optionalText(record.currentCursor, "currentCursor", 2_048)! }),
    condition,
    quietWindowMilliseconds: integer(
      record.quietWindowMilliseconds, "quietWindowMilliseconds", 0, 86_400_000
    ),
    deadlineAt: iso(record.deadlineAt, "deadlineAt"),
    lastObservedAt: optionalIso(record.lastObservedAt, "lastObservedAt") ??
      iso(record.updatedAt, "updatedAt"),
    status,
    ...(callback === undefined ? {} : { callback }),
    ...(failure === undefined ? {} : { failure }),
    revision: integer(record.revision, "revision", 1, 1_000_000),
    createdAt: iso(record.createdAt, "createdAt"),
    updatedAt: iso(record.updatedAt, "updatedAt")
  };
}

export function touchChannelFollow(
  currentInput: ChannelFollow,
  atInput: string
): ChannelFollow {
  const current = parseChannelFollow(currentInput);
  if (terminalFollowStatus(current.status)) return current;
  return parseChannelFollow({
    ...current,
    revision: current.revision + 1,
    updatedAt: iso(atInput, "at")
  });
}

export function terminalFollowStatus(status: ChannelFollowStatus): boolean {
  return ["quiet", "terminal", "failed", "expired", "stopped"].includes(status);
}

export function transitionChannelCallback(
  currentInput: ChannelFollow,
  callbackInput: ChannelCallbackState,
  atInput: string
): ChannelFollow {
  const current = parseChannelFollow(currentInput);
  if (current.callback === undefined) throw new Error("Channel follow has no callback");
  if (!terminalFollowStatus(current.status)) {
    throw new Error("Channel callback cannot advance before the follow is terminal");
  }
  const callback = parseCallback(callbackInput);
  if (callback.sessionId !== current.callback.sessionId) {
    throw new Error("Channel callback transition changed Session identity");
  }
  return parseChannelFollow({
    ...current,
    callback,
    revision: current.revision + 1,
    updatedAt: iso(atInput, "at")
  });
}

function parseCallback(value: unknown): ChannelCallbackState {
  const record = object(value, "callback");
  const status = oneOf(record.status, [
    "armed", "pending", "admitted", "failed", "expired", "revoked"
  ] as const, "callback.status");
  const callbackEventId = optionalText(record.callbackEventId, "callback.callbackEventId", 256);
  const failure = optionalText(record.failure, "callback.failure", 4_096);
  if (status === "admitted" && callbackEventId === undefined) {
    throw new Error("Admitted callback requires callbackEventId");
  }
  if (status === "failed" && failure === undefined) {
    throw new Error("Failed callback requires failure");
  }
  return {
    sessionId: requireModuleId(text(record.sessionId, "callback.sessionId", 64), "ses", "callback.sessionId"),
    status,
    ...(callbackEventId === undefined ? {} : { callbackEventId }),
    ...(failure === undefined ? {} : { failure }),
    updatedAt: iso(record.updatedAt, "callback.updatedAt")
  };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be text`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`${field} must contain 1-${maximum} characters`);
  }
  return normalized;
}

function optionalText(value: unknown, field: string, maximum: number): string | undefined {
  return value === undefined ? undefined : text(value, field, maximum);
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function iso(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be an RFC3339 timestamp`);
  }
  return value;
}

function optionalIso(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : iso(value, field);
}

function oneOf<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  field: string
): Values[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${field} must be one of ${allowed.join(", ")}`);
  }
  return value as Values[number];
}
