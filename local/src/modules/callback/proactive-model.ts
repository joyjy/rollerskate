export const proactiveCallbackKinds = [
  "agent.invoke",
  "command.exec",
  "destination.deliver"
] as const;

export type ProactiveCallbackKind = (typeof proactiveCallbackKinds)[number];
export type ProactiveCallbackOwnerKind =
  | "schedule"
  | "subscription"
  | "continuous_subscription";
export type ProactiveCallbackStatus =
  | "pending"
  | "started"
  | "succeeded"
  | "blocked"
  | "failed"
  | "unknown";

export interface ProactiveCallbackOwner {
  readonly kind: ProactiveCallbackOwnerKind;
  readonly id: string;
  readonly revision: number;
}

export interface ProactiveCallbackDefinition {
  readonly callbackId: string;
  readonly kind: ProactiveCallbackKind;
  readonly definition: Readonly<Record<string, unknown>>;
  readonly grant: Readonly<Record<string, unknown>>;
}

export interface ProactiveCallbackOccurrence extends ProactiveCallbackDefinition {
  readonly occurrenceId: string;
  readonly owner: ProactiveCallbackOwner;
  readonly triggerOccurrenceKey: string;
  readonly ordinal: number;
  readonly status: ProactiveCallbackStatus;
  readonly eventId?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly receipt?: unknown;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProactiveCallbackOccurrenceRow {
  readonly occurrence_id: string;
  readonly owner_kind: string;
  readonly owner_id: string;
  readonly owner_revision: number;
  readonly trigger_occurrence_key: string;
  readonly callback_id: string;
  readonly ordinal: number;
  readonly kind: string;
  readonly definition_schema: string;
  readonly definition_json: string;
  readonly grant_json: string;
  readonly status: string;
  readonly event_id: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly receipt_json: string | null;
  readonly last_error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const DEFINITION_KEYS: Readonly<Record<ProactiveCallbackKind, readonly string[]>> = {
  "agent.invoke": [
    "schemaVersion", "callbackId", "kind", "agentId", "workspace", "prompt", "sessionId"
  ],
  "command.exec": [
    "schemaVersion", "callbackId", "kind", "runtime", "executable", "argv", "cwd",
    "environment", "timeoutMilliseconds", "maxOutputBytes"
  ],
  "destination.deliver": [
    "schemaVersion", "callbackId", "kind", "destinationId", "destinationKind",
    "address", "payload"
  ]
};

const REQUIRED_DEFINITION_KEYS: Readonly<Record<ProactiveCallbackKind, readonly string[]>> = {
  "agent.invoke": [
    "schemaVersion", "callbackId", "kind", "agentId", "workspace", "prompt"
  ],
  "command.exec": [
    "schemaVersion", "callbackId", "kind", "runtime", "executable", "argv", "cwd",
    "timeoutMilliseconds", "maxOutputBytes"
  ],
  "destination.deliver": [
    "schemaVersion", "callbackId", "kind", "destinationId", "destinationKind",
    "address", "payload"
  ]
};

const GRANT_KEYS: Readonly<Record<ProactiveCallbackKind, readonly string[]>> = {
  "agent.invoke": [
    "schemaVersion", "kind", "agentId", "workspace", "workspaceAccess", "networkAccess"
  ],
  "command.exec": [
    "schemaVersion", "kind", "runtime", "executable", "argv", "cwd", "environment",
    "filesystemRoots", "networkAccess", "timeoutMilliseconds", "maxOutputBytes",
    "secretReferences"
  ],
  "destination.deliver": [
    "schemaVersion", "kind", "destinationId", "destinationKind", "address"
  ]
};

export function validateProactiveCallback(
  value: ProactiveCallbackDefinition
): ProactiveCallbackDefinition {
  return validateProactiveCallbackValue(value, false);
}

export function mapPersistedProactiveCallbackDefinition(
  value: ProactiveCallbackDefinition
): ProactiveCallbackDefinition {
  return validateProactiveCallbackValue(value, true);
}

function validateProactiveCallbackValue(
  value: ProactiveCallbackDefinition,
  allowLegacyNodeRuntime: boolean
): ProactiveCallbackDefinition {
  const definition = record(value.definition, "callback definition");
  const grant = record(value.grant, "callback grant");
  const kind = callbackKind(definition.kind);
  if (value.kind !== kind) throw new Error("callback kind does not match definition");
  exactKeys(definition, DEFINITION_KEYS[kind], REQUIRED_DEFINITION_KEYS[kind], "definition");
  exactKeys(grant, GRANT_KEYS[kind], GRANT_KEYS[kind], "grant");
  if (definition.schemaVersion !== "ProactiveCallbackDefinition@1") {
    throw new Error("callback definition schemaVersion must be ProactiveCallbackDefinition@1");
  }
  if (grant.schemaVersion !== "ProactiveCallbackGrant@1") {
    throw new Error("callback grant schemaVersion must be ProactiveCallbackGrant@1");
  }
  if (grant.kind !== kind) throw new Error("callback grant kind does not match definition");
  const callbackId = boundedText(definition.callbackId, "callbackId", 256);
  if (value.callbackId !== callbackId) throw new Error("callbackId does not match definition");

  if (kind === "agent.invoke") validateAgent(definition, grant);
  else if (kind === "command.exec") {
    validateCommand(definition, grant, allowLegacyNodeRuntime);
  }
  else validateDestination(definition, grant);

  boundedJson(definition, "callback definition");
  boundedJson(grant, "callback grant");
  return { callbackId, kind, definition, grant };
}

export function mapProactiveCallbackOccurrence(
  row: ProactiveCallbackOccurrenceRow
): ProactiveCallbackOccurrence {
  if (row.definition_schema !== "ProactiveCallbackDefinition@1") {
    throw new Error(`Unsupported proactive callback schema: ${row.definition_schema}`);
  }
  const callback = mapPersistedProactiveCallbackDefinition({
    callbackId: row.callback_id,
    kind: callbackKind(row.kind),
    definition: parseJson(row.definition_json, "callback definition"),
    grant: parseJson(row.grant_json, "callback grant")
  });
  const status = callbackStatus(row.status);
  const ownerKind = ownerKindValue(row.owner_kind);
  return {
    ...callback,
    occurrenceId: row.occurrence_id,
    owner: {
      kind: ownerKind,
      id: text(row.owner_id, "callback owner id"),
      revision: positiveInteger(row.owner_revision, "callback owner revision")
    },
    triggerOccurrenceKey: text(row.trigger_occurrence_key, "trigger occurrence key"),
    ordinal: nonNegativeInteger(row.ordinal, "callback ordinal"),
    status,
    ...(row.event_id === null ? {} : { eventId: row.event_id }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.receipt_json === null
      ? {}
      : { receipt: parseJsonValue(row.receipt_json, "callback receipt") }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function boundedProactiveCallbackJson(value: unknown, field: string): string {
  return boundedJson(value, field);
}

function validateAgent(
  definition: Readonly<Record<string, unknown>>,
  grant: Readonly<Record<string, unknown>>
): void {
  const agentId = text(definition.agentId, "callback agentId");
  const workspace = text(definition.workspace, "callback workspace");
  text(definition.prompt, "callback prompt");
  optionalText(definition.sessionId, "callback sessionId");
  if (grant.agentId !== agentId || grant.workspace !== workspace) {
    throw new Error("agent callback target exceeds grant");
  }
  if (grant.workspaceAccess !== "read" && grant.workspaceAccess !== "write") {
    throw new Error("callback grant workspaceAccess must be read or write");
  }
  if (typeof grant.networkAccess !== "boolean") {
    throw new Error("callback grant networkAccess must be boolean");
  }
}

function validateCommand(
  definition: Readonly<Record<string, unknown>>,
  grant: Readonly<Record<string, unknown>>,
  allowLegacyNodeRuntime: boolean
): void {
  const executable = text(definition.executable, "callback executable");
  const cwd = text(definition.cwd, "callback cwd");
  const runtime = definition.runtime;
  if ((runtime !== "host" && !(allowLegacyNodeRuntime && runtime === "node")) ||
    grant.runtime !== runtime) {
    throw new Error("command callback runtime must be host");
  }
  const argv = strings(definition.argv, "callback argv");
  const environment = stringRecord(definition.environment ?? {}, "callback environment");
  const timeout = positiveInteger(definition.timeoutMilliseconds, "callback timeoutMilliseconds");
  const maxOutput = positiveInteger(definition.maxOutputBytes, "callback maxOutputBytes");
  if (grant.executable !== executable || grant.cwd !== cwd) {
    throw new Error("command callback target exceeds grant");
  }
  if (canonicalJson(grant.argv) !== canonicalJson(argv) ||
    canonicalJson(grant.environment) !== canonicalJson(environment) ||
    grant.timeoutMilliseconds !== timeout || grant.maxOutputBytes !== maxOutput) {
    throw new Error("command callback execution exceeds exact grant");
  }
  const roots = strings(grant.filesystemRoots, "callback grant filesystemRoots");
  if (roots.length === 0) throw new Error("callback grant filesystemRoots must not be empty");
  if (grant.networkAccess !== true) {
    throw new Error("host command callbacks must truthfully grant networkAccess");
  }
  strings(grant.secretReferences, "callback grant secretReferences");
}

function validateDestination(
  definition: Readonly<Record<string, unknown>>,
  grant: Readonly<Record<string, unknown>>
): void {
  const destinationId = destinationIdValue(definition.destinationId);
  const destinationKind = text(definition.destinationKind, "callback destinationKind");
  if (destinationKind !== "matrix" && destinationKind !== "macos-notification") {
    throw new Error(`Unsupported callback destination kind: ${destinationKind}`);
  }
  const address = stringRecord(definition.address, "callback destination address");
  jsonObject(definition.payload, "callback destination payload");
  if (grant.destinationId !== destinationId || grant.destinationKind !== destinationKind ||
    canonicalJson(grant.address) !== canonicalJson(address)) {
    throw new Error("destination callback target exceeds grant");
  }
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  required: readonly string[],
  field: string
): void {
  const actual = Object.keys(value);
  const extra = actual.find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new Error(`${field} has unsupported field: ${extra}`);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw new Error(`${field} is missing field: ${missing}`);
}

function boundedJson(value: unknown, field: string): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${field} must be JSON-serializable`);
  }
  if (encoded === undefined) throw new Error(`${field} must be JSON-serializable`);
  if (Buffer.byteLength(encoded, "utf8") > 65_536) {
    throw new Error(`${field} exceeds 65536 bytes`);
  }
  return encoded;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseJson(value: string, field: string): Readonly<Record<string, unknown>> {
  return record(parseJsonValue(value, field), field);
}

function parseJsonValue(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${field} is not valid JSON`);
  }
}

function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function jsonObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  const result = record(value, field);
  boundedJson(result, field);
  return result;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function boundedText(value: unknown, field: string, maximum: number): string {
  const result = text(value, field);
  if (result.length > maximum) throw new Error(`${field} must be at most ${maximum} characters`);
  return result;
}

function optionalText(value: unknown, field: string): void {
  if (value !== undefined) text(value, field);
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

function stringRecord(value: unknown, field: string): Readonly<Record<string, string>> {
  const result = record(value, field);
  if (Object.values(result).some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be a string record`);
  }
  return result as Readonly<Record<string, string>>;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function callbackKind(value: unknown): ProactiveCallbackKind {
  if (!proactiveCallbackKinds.includes(value as ProactiveCallbackKind)) {
    throw new Error(`Unsupported proactive callback kind: ${String(value)}`);
  }
  return value as ProactiveCallbackKind;
}

function callbackStatus(value: string): ProactiveCallbackStatus {
  if (!["pending", "started", "succeeded", "blocked", "failed", "unknown"].includes(value)) {
    throw new Error(`Unsupported proactive callback status: ${value}`);
  }
  return value as ProactiveCallbackStatus;
}

function ownerKindValue(value: string): ProactiveCallbackOwnerKind {
  if (value !== "schedule" && value !== "subscription" &&
    value !== "continuous_subscription") {
    throw new Error(`Unsupported proactive callback owner kind: ${value}`);
  }
  return value;
}

function destinationIdValue(value: unknown): string {
  const result = text(value, "callback destinationId");
  if (!/^dst_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    .test(result)) {
    throw new Error("callback destinationId must be a dst_ UUIDv7");
  }
  return result;
}
