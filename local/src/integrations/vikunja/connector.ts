import {
  connectorDescriptionSchema,
  connectorObservationPageSchema,
  connectorObserveRequestSchema,
  connectorReadRequestSchema,
  type ConnectorDescription,
  type ConnectorObservationPage,
  type ConnectorObserveRequest,
  type ConnectorReadRequest,
  type ConnectorReadResult,
  type ExternalRef
} from "@rollerskate/protocol";

import { VikunjaConnectorLedger } from "./ledger.js";
import {
  VikunjaProviderClient,
  type VikunjaFetch
} from "./provider-client.js";
import {
  externalRef,
  numericExternalId,
  observationFromTask,
  projectSnapshot,
  readResult,
  taskSnapshot,
  type VikunjaSnapshot
} from "./snapshot.js";

const PROFILE_ID = "playground@1";

interface ObservationCursor {
  readonly version: 1;
  readonly projectId: number;
  readonly page: number;
  readonly cycle: number;
}

export interface VikunjaConnectorOptions {
  readonly endpoint: string;
  readonly token: () => string;
  readonly integrationBindingId: string;
  readonly projectExternalId: string;
  readonly ledgerPath: string;
  readonly fetch?: VikunjaFetch;
  readonly now?: () => Date;
}

export class VikunjaConnector {
  readonly #integrationBindingId: string;
  readonly #projectId: number;
  readonly #client: VikunjaProviderClient;
  readonly #ledger: VikunjaConnectorLedger;
  readonly #now: () => Date;

  public constructor(options: VikunjaConnectorOptions) {
    requireIdentifier(options.integrationBindingId, "Integration binding id");
    this.#integrationBindingId = options.integrationBindingId;
    this.#projectId = numericExternalId(externalRef(
      options.integrationBindingId,
      "project",
      options.projectExternalId
    ), "project");
    this.#client = new VikunjaProviderClient({
      endpoint: options.endpoint,
      token: options.token,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch })
    });
    this.#ledger = new VikunjaConnectorLedger(options.ledgerPath);
    this.#now = options.now ?? (() => new Date());
  }

  public describe(): ConnectorDescription {
    return connectorDescriptionSchema.parse({
      schemaVersion: "ConnectorDescription@1",
      connectorId: "vikunja",
      connectorVersion: "1",
      profiles: [{
        profileId: PROFILE_ID,
        readSchemaRefs: ["project.read@1", "work-item.read@1"]
      }]
    });
  }

  public async observe(input: ConnectorObserveRequest): Promise<ConnectorObservationPage> {
    const request = connectorObserveRequestSchema.parse(input);
    this.#requireIntegration(request.integrationBindingId);
    const cursor = request.cursor ?? encodeCursor({
      version: 1,
      projectId: this.#projectId,
      page: 1,
      cycle: 0
    });
    const pending = this.#ledger.pendingObservation(cursor);
    if (pending !== undefined) {
      return connectorObservationPageSchema.parse({
        schemaVersion: "ConnectorObservationPage@1",
        observations: pending.observations,
        nextCursor: pending.nextCursor,
        complete: pending.complete
      });
    }

    const state = decodeCursor(cursor, this.#projectId);
    const perPage = Math.min(request.limit, 50);
    const query = new URLSearchParams({
      page: String(state.page),
      per_page: String(perPage),
      sort_by: "id",
      order_by: "asc",
      filter: `project = ${this.#projectId} && done in true, false`
    });
    query.append("expand", "comments");
    query.append("expand", "buckets");
    const response = await this.#client.get(`/tasks?${query.toString()}`);
    if (!Array.isArray(response.value)) throw new Error("Vikunja task page is invalid");
    const totalPages = positiveHeader(response.headers, "x-pagination-total-pages");
    const complete = totalPages === undefined
      ? response.value.length < perPage
      : state.page >= totalPages;
    const nextCursor = encodeCursor(complete
      ? { ...state, page: 1, cycle: state.cycle + 1 }
      : { ...state, page: state.page + 1 });
    const revisions: Record<string, string> = {};
    const observations = response.value.flatMap((item) => {
      const providerTask = record(item, "Vikunja observed task");
      if (providerTask.project_id !== this.#projectId) {
        throw new Error("Vikunja observation returned a WorkItem outside scope");
      }
      const snapshot = taskSnapshot(item, this.#integrationBindingId);
      const revision = snapshot.ref.revision;
      if (revision === undefined) throw new Error("Vikunja task revision is missing");
      revisions[snapshot.ref.externalId] = revision;
      return this.#ledger.observedRevision(snapshot.ref.externalId) === revision
        ? []
        : [observationFromTask(snapshot, this.#timestamp(), cursor)];
    });
    this.#ledger.savePendingObservation({
      inputCursor: cursor,
      nextCursor,
      complete,
      observations,
      revisionUpdates: revisions
    });
    return connectorObservationPageSchema.parse({
      schemaVersion: "ConnectorObservationPage@1",
      observations,
      nextCursor,
      complete
    });
  }

  public async read(input: ConnectorReadRequest): Promise<ConnectorReadResult> {
    const request = connectorReadRequestSchema.parse(input);
    this.#requireIntegration(request.ref.integrationBindingId);
    if (request.profileId !== PROFILE_ID) throw new Error("Vikunja profile is unsupported");
    const snapshot = await this.#readRef(request.ref);
    if (request.schemaRef !== snapshot.schemaRef) {
      throw new Error("Vikunja read schema does not match the external reference");
    }
    const result = readResult(snapshot, this.#timestamp());
    if (Buffer.byteLength(JSON.stringify(result.boundedPayload), "utf8") > request.maxBytes) {
      throw new Error("Vikunja read result exceeds the requested byte limit");
    }
    return result;
  }

  async #readRef(ref: ExternalRef): Promise<VikunjaSnapshot> {
    this.#requireIntegration(ref.integrationBindingId);
    if (ref.kind === "project") {
      const projectId = numericExternalId(ref, "project");
      if (projectId !== this.#projectId) throw new Error("Vikunja project is outside scope");
      const response = await this.#client.get(`/projects/${projectId}`);
      return projectSnapshot(response.value, this.#integrationBindingId);
    }
    return this.#readTask(numericExternalId(ref, "work-item"));
  }

  async #readTask(taskId: number): Promise<VikunjaSnapshot> {
    const response = await this.#client.get(`/tasks/${taskId}?expand=comments&expand=buckets`);
    const snapshot = taskSnapshot(response.value, this.#integrationBindingId);
    const payload = record(snapshot.payload, "Vikunja WorkItem snapshot");
    const projectRef = record(payload.projectRef, "Vikunja WorkItem Project ref");
    if (projectRef.externalId !== String(this.#projectId)) {
      throw new Error("Vikunja WorkItem is outside the Integration scope");
    }
    return snapshot;
  }

  #requireIntegration(value: string): void {
    if (value !== this.#integrationBindingId) {
      throw new Error("Vikunja request targets another Integration binding");
    }
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

function encodeCursor(cursor: ObservationCursor): string {
  return `vkc1.${Buffer.from(JSON.stringify(cursor)).toString("base64url")}`;
}

function decodeCursor(value: string, projectId: number): ObservationCursor {
  if (!value.startsWith("vkc1.")) throw new Error("Vikunja observation cursor is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value.slice(5), "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("Vikunja observation cursor is invalid");
  }
  const cursor = record(parsed, "Vikunja observation cursor");
  if (cursor.version !== 1 || cursor.projectId !== projectId ||
    !Number.isInteger(cursor.page) || Number(cursor.page) < 1 ||
    !Number.isInteger(cursor.cycle) || Number(cursor.cycle) < 0) {
    throw new Error("Vikunja observation cursor is invalid");
  }
  return {
    version: 1,
    projectId,
    page: Number(cursor.page),
    cycle: Number(cursor.cycle)
  };
}

function positiveHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value as Record<string, unknown>;
}

function requireIdentifier(value: string, name: string): void {
  if (value.trim() === "" || value.length > 255 || value.includes("\0")) {
    throw new Error(`${name} is invalid`);
  }
}
