import type {
  RuntimeDelivery,
  RuntimeDestination,
  RuntimeExecution,
  RuntimeHandlerKind,
  RuntimeSession
} from "../../../core/runtime/model.js";

export interface ExecutionRow {
  execution_id: string;
  event_id: string;
  handler: RuntimeHandlerKind;
  status: RuntimeExecution["status"];
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  receipt_json: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface SessionRow {
  session_id: string;
  agent_id: string;
  run_id: string | null;
  cycle_id: string | null;
  adapter_id: string;
  provider_session_id: string;
  workspace: string;
  created_at: string;
  updated_at: string;
}

export interface DestinationRow {
  destination_id: string;
  kind: RuntimeDestination["kind"];
  address_json: string;
  created_at: string;
  updated_at: string;
}

export interface DeliveryRow {
  delivery_id: string;
  result_event_id: string | null;
  origin_kind: RuntimeDelivery["origin"]["kind"];
  origin_id: string;
  destination_id: string;
  destination_kind: RuntimeDestination["kind"];
  destination_address_json: string;
  payload_json: string;
  status: RuntimeDelivery["status"];
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string;
  receipt: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export function mapExecution(row: ExecutionRow): RuntimeExecution {
  return {
    executionId: row.execution_id,
    eventId: row.event_id,
    handler: row.handler,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    createdAt: row.created_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    updatedAt: row.updated_at
  };
}

export function mapSession(row: SessionRow): RuntimeSession {
  return {
    sessionId: row.session_id,
    agentId: row.agent_id,
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    ...(row.cycle_id === null ? {} : { cycleId: row.cycle_id }),
    adapterId: row.adapter_id,
    providerSessionId: row.provider_session_id,
    workspace: row.workspace,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapDestination(row: DestinationRow): RuntimeDestination {
  return {
    destinationId: row.destination_id,
    kind: row.kind,
    address: JSON.parse(row.address_json) as Readonly<Record<string, string>>,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapDelivery(row: DeliveryRow): RuntimeDelivery {
  return {
    deliveryId: row.delivery_id,
    origin: { kind: row.origin_kind, id: row.origin_id },
    ...(row.result_event_id === null ? {} : { resultEventId: row.result_event_id }),
    destinationId: row.destination_id,
    payload: JSON.parse(row.payload_json) as Readonly<Record<string, unknown>>,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    ...(row.receipt === null ? {} : { receipt: row.receipt }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
