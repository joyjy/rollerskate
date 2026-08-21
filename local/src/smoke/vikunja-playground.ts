import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "@rollerskate/protocol";

import type { RuntimeDelivery, RuntimeDestination } from "../core/runtime/model.js";
import { VikunjaConnector } from "../integrations/vikunja/connector.js";
import { VikunjaTaskDestinationAdapter } from
  "../integrations/vikunja/task-destination.js";

const endpoint = process.env.ROLLERSKATE_VIKUNJA_URL ?? "http://127.0.0.1:3456";
if (process.env.ROLLERSKATE_VIKUNJA_SMOKE_ALLOW_WRITE !== "true") {
  throw new Error("Set ROLLERSKATE_VIKUNJA_SMOKE_ALLOW_WRITE=true for the isolated write smoke");
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const username = `rollerskate_smoke_${suffix}`;
const email = `${username}@example.invalid`;
const password = `Rs-${randomUUID()}-A1!`;
const integrationBindingId = `vikunja-smoke-${suffix}`;
const stateDirectory = mkdtempSync(join(tmpdir(), "rollerskate-vikunja-real-smoke-"));

let token = "";
try {
  await publicRequest("/register", "POST", { username, email, password });
  const login = record(await publicRequest("/login", "POST", { username, password }), "login");
  token = requiredString(login.token, "login token");
  const createdProject = record(await authorizedRequest("/projects", "PUT", {
    title: `Rollerskate ordinary-tool smoke ${suffix}`,
    description: "Isolated read and idempotent comment smoke artifact"
  }), "created project");
  const projectId = positiveInteger(createdProject.id, "created project id");
  const createdTask = record(await authorizedRequest(`/projects/${projectId}/tasks`, "PUT", {
    title: "Orchestrator result destination",
    description: "Created by isolated Vikunja smoke setup"
  }), "created task");
  const taskId = positiveInteger(createdTask.id, "created task id");

  const connector = new VikunjaConnector({
    endpoint,
    token: () => token,
    integrationBindingId,
    projectExternalId: String(projectId),
    ledgerPath: join(stateDirectory, "connector-ledger.json")
  });
  const observations = await connector.observe({
    schemaVersion: "ConnectorObserveRequest@1",
    integrationBindingId,
    limit: 25
  });
  if (observations.observations.length !== 1) {
    throw new Error(`Expected one task observation, got ${observations.observations.length}`);
  }
  const read = await connector.read({
    schemaVersion: "ConnectorReadRequest@1",
    ref: {
      schemaVersion: "ExternalRef@1",
      integrationBindingId,
      kind: "work-item",
      externalId: String(taskId)
    },
    profileId: "playground@1",
    schemaRef: "work-item.read@1",
    maxBytes: 65_536
  });

  const adapter = new VikunjaTaskDestinationAdapter({ endpoint, token: () => token });
  const delivery = smokeDelivery();
  const destination = smokeDestination(taskId);
  const first = await adapter.deliver({ delivery, destination });
  const replay = await adapter.deliver({ delivery, destination });
  if (first.receipt !== replay.receipt) {
    throw new Error("Vikunja Task Delivery replay returned another receipt");
  }
  const comments = await authorizedRequest(`/tasks/${taskId}/comments?order_by=desc`, "GET");
  const matchingComments = Array.isArray(comments)
    ? comments.filter((item) => {
        const comment = record(item, "comment").comment;
        return comment !== undefined && String(comment).includes(delivery.deliveryId);
      })
    : [];
  if (matchingComments.length !== 1) {
    throw new Error("Vikunja Task Delivery marker was not written exactly once");
  }

  process.stdout.write(`${JSON.stringify({
    smoke: "vikunja-ordinary-tool@1",
    outcome: "passed",
    endpoint,
    isolatedUsername: username,
    projectId,
    taskId,
    observedRevision: read.ref.revision,
    deliveryReceipt: first.receipt,
    replayStable: true,
    retainedProviderArtifacts: true
  }, null, 2)}\n`);
} finally {
  token = "";
  rmSync(stateDirectory, { recursive: true, force: true });
}

function smokeDestination(taskId: number): RuntimeDestination {
  return {
    destinationId: "dst_019fa649-637b-7bf2-ad2b-a9b7be044fcd",
    kind: "vikunja-task",
    address: { taskUrl: `${endpoint.replace(/\/$/u, "")}/tasks/${taskId}` },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function smokeDelivery(): RuntimeDelivery {
  const timestamp = new Date().toISOString();
  return {
    deliveryId: "del_019fa649-637b-7bf2-ad2b-a9b7be044fce",
    origin: { kind: "host", id: `vikunja-smoke:${suffix}` },
    destinationId: "dst_019fa649-637b-7bf2-ad2b-a9b7be044fcd",
    payload: {
      schemaVersion: "VikunjaTaskComment@1",
      runId: `run-smoke-${suffix}`,
      body: "Rollerskate Orchestrator result writeback verified."
    },
    status: "delivering",
    attemptCount: 1,
    maxAttempts: 5,
    nextAttemptAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function publicRequest(path: string, method: string, body: JsonValue): Promise<unknown> {
  return providerRequest(path, method, body, false);
}

async function authorizedRequest(
  path: string,
  method: string,
  body?: JsonValue
): Promise<unknown> {
  return providerRequest(path, method, body, true);
}

async function providerRequest(
  path: string,
  method: string,
  body: JsonValue | undefined,
  authorized: boolean
): Promise<unknown> {
  const response = await fetch(new URL(`/api/v1${path}`, endpoint), {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(authorized ? { authorization: `Bearer ${token}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  const value = text === "" ? {} : JSON.parse(text) as unknown;
  if (!response.ok) {
    const provider = typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const code = typeof provider.code === "number" ? provider.code : "unknown";
    throw new Error(`Vikunja smoke setup failed: HTTP ${response.status}, code ${code}`);
  }
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Vikunja ${name} response is invalid`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`Vikunja ${name} is invalid`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Vikunja ${name} is invalid`);
  }
  return value;
}
