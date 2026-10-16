export interface ChatRotationTurn {
  readonly agentId: string;
  readonly revision: number;
  readonly sequence: number;
}

/** Chat owns this bounded queue; canonical messages and Execution own content/results. */
export interface ChatRotationState {
  readonly schema: "ChatRotationState@1";
  readonly agentIds: readonly string[];
  readonly revision: number;
  readonly currentQueue: readonly string[];
  readonly nextOrder: readonly string[];
  readonly nextPending: readonly string[];
  readonly active: ChatRotationTurn | null;
  readonly turnsStarted: number;
  readonly turnBudget: number;
  readonly failedAgents: readonly string[];
  readonly evaluated: readonly { readonly agentId: string; readonly revision: number }[];
}

export function parseChatRotationState(value: unknown): ChatRotationState {
  if (!record(value) || value.schema !== "ChatRotationState@1") {
    throw new Error("Chat rotation state schema is invalid");
  }
  const agentIds = parseIds(value.agentIds, "agentIds");
  const currentQueue = parseIds(value.currentQueue, "currentQueue");
  const nextOrder = parseIds(value.nextOrder, "nextOrder");
  const nextPending = parseIds(value.nextPending, "nextPending");
  const failedAgents = parseIds(value.failedAgents, "failedAgents");
  const revision = integer(value.revision, "revision", 0, Number.MAX_SAFE_INTEGER);
  const turnBudget = integer(value.turnBudget, "turnBudget", 1, 64);
  const turnsStarted = integer(value.turnsStarted, "turnsStarted", 0, turnBudget);
  if (nextOrder.length !== agentIds.length ||
    [...currentQueue, ...nextOrder, ...nextPending, ...failedAgents].some((id) => !agentIds.includes(id)) ||
    currentQueue.some((id) => nextPending.includes(id))) {
    throw new Error("Chat rotation queue references are invalid");
  }
  let active: ChatRotationTurn | null = null;
  if (value.active !== null) {
    if (!record(value.active)) throw new Error("Chat rotation active turn is invalid");
    active = {
      agentId: parseId(value.active.agentId),
      revision: integer(value.active.revision, "active.revision", 1, revision),
      sequence: integer(value.active.sequence, "active.sequence", 1, turnsStarted)
    };
    if (active.sequence !== turnsStarted || currentQueue.includes(active.agentId)) {
      throw new Error("Chat rotation active turn references are invalid");
    }
  }
  if (!Array.isArray(value.evaluated) || value.evaluated.length > 64) {
    throw new Error("Chat rotation evaluated list is invalid");
  }
  const evaluated = value.evaluated.map((entry: unknown) => {
    if (!record(entry)) throw new Error("Chat rotation evaluated entry is invalid");
    return {
      agentId: parseId(entry.agentId),
      revision: integer(entry.revision, "evaluated.revision", 1, revision)
    };
  });
  if (new Set(evaluated.map(({agentId}) => agentId)).size !== evaluated.length ||
    evaluated.some(({agentId}) => !agentIds.includes(agentId))) {
    throw new Error("Chat rotation evaluated Agent references are invalid");
  }
  return { schema: "ChatRotationState@1", agentIds, revision, currentQueue, nextOrder,
    nextPending, active, turnsStarted, turnBudget, failedAgents, evaluated };
}

export function createChatRotationState(
  agentIds: readonly string[],
  options: { readonly turnBudget: number }
): ChatRotationState {
  requireOrder(agentIds);
  if (!Number.isInteger(options.turnBudget) || options.turnBudget < 1 || options.turnBudget > 64) {
    throw new Error("Chat rotation turnBudget must be between 1 and 64");
  }
  return {
    schema: "ChatRotationState@1", agentIds: [...agentIds], revision: 0,
    currentQueue: [], nextOrder: [...agentIds], nextPending: [], active: null,
    turnsStarted: 0, turnBudget: options.turnBudget, failedAgents: [], evaluated: []
  };
}

/** Owner supplies the newly sampled eligible order. Agent speech never samples again. */
export function offerChatRotationMessage(
  state: ChatRotationState,
  message: { readonly ownerOrder: readonly string[]; readonly senderAgentId?: never }
    | { readonly senderAgentId: string; readonly ownerOrder?: never }
): ChatRotationState {
  const owner = message.ownerOrder !== undefined;
  const order = message.ownerOrder ?? state.nextOrder;
  requireOrder(order);
  if (!owner && message.senderAgentId.trim() === "") throw new Error("Agent sender is required");
  const agentIds = owner ? [...order] : state.agentIds;
  const eligible = new Set(agentIds);
  const revision = state.revision + 1;
  const currentQueue = state.currentQueue.filter((id) => eligible.has(id));
  const nextPending = new Set(state.nextPending.filter((id) => eligible.has(id)));
  // A new Owner message reopens a finished discussion, but bursts cannot refill its budget.
  if (owner && state.active === null && chatRotationStatus(state) !== "ready") {
    return {
      ...state, agentIds, revision, currentQueue: [...order], nextOrder: [...order],
      nextPending: [], turnsStarted: 0, failedAgents: [], evaluated: []
    };
  }
  for (const id of agentIds) {
    if (id !== message.senderAgentId && !currentQueue.includes(id)) nextPending.add(id);
  }
  return {
    ...state, agentIds, revision, currentQueue, nextOrder: [...order],
    nextPending: [...nextPending], failedAgents: state.failedAgents.filter((id) => eligible.has(id)),
    evaluated: state.evaluated.filter(({agentId}) => eligible.has(agentId))
  };
}

export function startChatRotationTurn(
  state: ChatRotationState
): { readonly state: ChatRotationState; readonly turn: ChatRotationTurn } | undefined {
  if (state.active !== null || state.turnsStarted >= state.turnBudget) return undefined;
  const queue = state.currentQueue.length > 0
    ? state.currentQueue
    : state.nextOrder.filter((id) => state.nextPending.includes(id));
  const agentId = queue[0];
  if (agentId === undefined) return undefined;
  const turn = { agentId, revision: state.revision, sequence: state.turnsStarted + 1 };
  return {
    turn,
    state: {
      ...state, active: turn, turnsStarted: turn.sequence, currentQueue: queue.slice(1),
      nextPending: state.currentQueue.length > 0 ? state.nextPending : []
    }
  };
}

/** Speech is offered separately from the canonical reply, before or after completion. */
export function completeChatRotationTurn(
  state: ChatRotationState,
  turn: ChatRotationTurn,
  outcome: "completed" | "failed"
): ChatRotationState {
  if (state.active?.agentId !== turn.agentId || state.active.revision !== turn.revision ||
    state.active.sequence !== turn.sequence) throw new Error("Chat rotation active turn changed");
  const failedAgents = state.failedAgents.filter((id) => id !== turn.agentId);
  if (outcome === "failed" && state.agentIds.includes(turn.agentId)) failedAgents.push(turn.agentId);
  return {
    ...state, active: null, failedAgents,
    evaluated: outcome === "failed" || !state.agentIds.includes(turn.agentId) ? state.evaluated : [
      ...state.evaluated.filter(({ agentId }) => agentId !== turn.agentId),
      { agentId: turn.agentId, revision: turn.revision }
    ]
  };
}

export function chatRotationStatus(
  state: ChatRotationState
): "idle" | "running" | "ready" | "quiescent" | "blocked" | "budget_exhausted" {
  if (state.active !== null) return "running";
  if (state.currentQueue.length > 0 || state.nextPending.length > 0) {
    return state.turnsStarted >= state.turnBudget ? "budget_exhausted" : "ready";
  }
  if (state.failedAgents.length > 0) return "blocked";
  return state.revision === 0 ? "idle" : "quiescent";
}

function requireOrder(order: readonly string[]): void {
  if (order.length > 64 || order.some((id) => id.trim() === "") || new Set(order).size !== order.length) {
    throw new Error("Chat rotation order must contain up to 64 distinct Agent IDs");
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 256) {
    throw new Error("Chat rotation Agent ID is invalid");
  }
  return value;
}

function parseIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error(`Chat rotation ${field} is invalid`);
  const ids = value.map(parseId);
  requireOrder(ids);
  return ids;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Chat rotation ${field} is invalid`);
  }
  return value;
}
