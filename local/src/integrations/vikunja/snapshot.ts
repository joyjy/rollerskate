import { createHash } from "node:crypto";

import {
  connectorReadResultSchema,
  observationSchema,
  type ConnectorReadResult,
  type ExternalRef,
  type JsonValue,
  type Observation
} from "@rollerskate/protocol";

export interface VikunjaSnapshot {
  readonly ref: ExternalRef;
  readonly profileId: "playground@1";
  readonly schemaRef: "project.read@1" | "work-item.read@1";
  readonly payload: JsonValue;
  readonly digest: string;
}

export function projectSnapshot(
  value: unknown,
  integrationBindingId: string
): VikunjaSnapshot {
  const project = record(value, "Vikunja project");
  const id = positiveInteger(project.id, "Vikunja project id");
  const payload = {
    kind: "project",
    title: boundedString(project.title, "Vikunja project title", 250),
    description: optionalBoundedString(project.description, 16_384),
    archived: boolean(project.is_archived, false),
    createdAt: optionalTimestamp(project.created),
    updatedAt: optionalTimestamp(project.updated)
  } satisfies JsonValue;
  return snapshot(integrationBindingId, "project", id, "project.read@1", payload);
}

export function taskSnapshot(
  value: unknown,
  integrationBindingId: string
): VikunjaSnapshot {
  const task = record(value, "Vikunja task");
  const id = positiveInteger(task.id, "Vikunja task id");
  const projectId = positiveInteger(task.project_id, "Vikunja task project id");
  const payload = {
    kind: "work-item",
    title: boundedString(task.title, "Vikunja task title", 4_096),
    description: optionalBoundedString(task.description, 16_384),
    status: boolean(task.done, false) ? "done" : "open",
    projectRef: jsonRef(integrationBindingId, "project", projectId),
    assigneeRefs: referenceArray(task.assignees, integrationBindingId, "principal", 64),
    bucketRefs: referenceArray(task.buckets, integrationBindingId, "bucket", 32),
    labelRefs: referenceArray(task.labels, integrationBindingId, "label", 64),
    relationRefs: relationReferences(task.related_tasks, integrationBindingId),
    comments: comments(task.comments, integrationBindingId),
    createdAt: optionalTimestamp(task.created),
    updatedAt: optionalTimestamp(task.updated)
  } satisfies JsonValue;
  return snapshot(integrationBindingId, "work-item", id, "work-item.read@1", payload);
}

export function observationFromTask(
  snapshotValue: VikunjaSnapshot,
  occurredAt: string,
  cursor: string
): Observation {
  if (snapshotValue.schemaRef !== "work-item.read@1") {
    throw new Error("Only WorkItem snapshots can become playground observations");
  }
  return observationSchema.parse({
    schemaVersion: "Observation@1",
    observationId: `obs_vk_${digest(`${snapshotValue.ref.integrationBindingId}:` +
      `${snapshotValue.ref.externalId}:${snapshotValue.digest}`).slice(7, 47)}`,
    sourceRef: snapshotValue.ref,
    sourceRevision: snapshotValue.ref.revision,
    profileId: snapshotValue.profileId,
    schemaRef: "playground.work-item.snapshot@1",
    boundedPayload: snapshotValue.payload,
    payloadDigest: snapshotValue.digest,
    occurredAt,
    cursor
  });
}

export function readResult(
  snapshotValue: VikunjaSnapshot,
  readAt: string
): ConnectorReadResult {
  return connectorReadResultSchema.parse({
    schemaVersion: "ConnectorReadResult@1",
    ref: snapshotValue.ref,
    profileId: snapshotValue.profileId,
    schemaRef: snapshotValue.schemaRef,
    boundedPayload: snapshotValue.payload,
    payloadDigest: snapshotValue.digest,
    readAt
  });
}

export function externalRef(
  integrationBindingId: string,
  kind: string,
  externalId: string | number,
  revision?: string
): ExternalRef {
  return {
    schemaVersion: "ExternalRef@1",
    integrationBindingId,
    kind,
    externalId: String(externalId),
    ...(revision === undefined ? {} : { revision })
  };
}

export function numericExternalId(ref: ExternalRef, kind: string): number {
  if (ref.kind !== kind || !/^[1-9][0-9]*$/u.test(ref.externalId)) {
    throw new Error(`Vikunja ${kind} reference is invalid`);
  }
  const id = Number(ref.externalId);
  if (!Number.isSafeInteger(id)) throw new Error(`Vikunja ${kind} reference is too large`);
  return id;
}

export function payloadDigest(value: unknown): string {
  return digest(canonicalJson(value));
}

function snapshot(
  integrationBindingId: string,
  kind: "project" | "work-item",
  externalId: number,
  schemaRef: VikunjaSnapshot["schemaRef"],
  payload: JsonValue
): VikunjaSnapshot {
  const hash = payloadDigest(payload);
  return {
    ref: externalRef(integrationBindingId, kind, externalId, `vk1:${hash}`),
    profileId: "playground@1",
    schemaRef,
    payload,
    digest: hash
  };
}

function relationReferences(
  value: unknown,
  integrationBindingId: string
): JsonValue[] {
  if (value === undefined || value === null) return [];
  const relations = record(value, "Vikunja related tasks");
  const result: JsonValue[] = [];
  for (const relationKind of Object.keys(relations).sort()) {
    const tasks = relations[relationKind];
    if (!Array.isArray(tasks)) throw new Error("Vikunja related task group is invalid");
    for (const task of tasks.slice(0, 128 - result.length)) {
      const item = record(task, "Vikunja related task");
      result.push({
        relationKind: relationKind.slice(0, 64),
        ref: jsonRef(
          integrationBindingId,
          "work-item",
          positiveInteger(item.id, "Vikunja related task id")
        )
      });
    }
    if (result.length >= 128) break;
  }
  return result;
}

function referenceArray(
  value: unknown,
  integrationBindingId: string,
  kind: string,
  limit: number
): JsonValue[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`Vikunja ${kind} collection is invalid`);
  return value.slice(0, limit).map((item) => {
    const provider = record(item, `Vikunja ${kind}`);
    return jsonRef(
      integrationBindingId,
      kind,
      positiveInteger(provider.id, `Vikunja ${kind} id`)
    );
  });
}

function comments(value: unknown, integrationBindingId: string): JsonValue[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Vikunja comment collection is invalid");
  return value.slice(0, 20).map((item) => {
    const comment = record(item, "Vikunja comment");
    const author = comment.author === undefined || comment.author === null
      ? undefined
      : record(comment.author, "Vikunja comment author");
    return {
      ref: jsonRef(
        integrationBindingId,
        "comment",
        positiveInteger(comment.id, "Vikunja comment id")
      ),
      body: boundedString(comment.comment, "Vikunja comment body", 4_096),
      ...(author === undefined ? {} : {
        authorRef: jsonRef(
          integrationBindingId,
          "principal",
          positiveInteger(author.id, "Vikunja comment author id")
        )
      }),
      createdAt: optionalTimestamp(comment.created),
      updatedAt: optionalTimestamp(comment.updated)
    };
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function jsonRef(
  integrationBindingId: string,
  kind: string,
  externalId: string | number,
  revision?: string
): JsonValue {
  return {
    schemaVersion: "ExternalRef@1",
    integrationBindingId,
    kind,
    externalId: String(externalId),
    ...(revision === undefined ? {} : { revision })
  };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is invalid`);
  return value.slice(0, maximum);
}

function optionalBoundedString(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function optionalTimestamp(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
