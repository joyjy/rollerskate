import type { DatabaseSync } from "node:sqlite";

import {
  defaultTopicGovernance,
  materializationReceipt
} from "../../../modules/topic/governance.js";
import { withImmediateTransaction } from "../transaction.js";
import { createSchema } from "./definition.js";
import {
  preV61ProductTables,
  writeSchemaVersion
} from "./introspection.js";

export const V53_TABLES = [
  "agent_sessions",
  "agent_runs",
  "agents",
  "chat_messages",
  "chat_presence",
  "continuous_subscriptions",
  "deliveries",
  "events",
  "executions",
  "local_foundation",
  "notices",
  "proactive_callback_definitions",
  "proactive_callback_occurrences",
  "scheduled_runs",
  "schedules",
  "schema_meta",
  "subscriptions"
] as const;

export function assertV53SchemaShape(database: DatabaseSync): void {
  const actual = preV61ProductTables(database);
  if (actual.length !== V53_TABLES.length ||
    V53_TABLES.some((table) => !actual.includes(table))) {
    throw new Error("Local database schema 53 is incomplete");
  }
}

export function migrateV53Schema(database: DatabaseSync, targetVersion: number): void {
  withImmediateTransaction(database, () => {
    createSchema(database);
    materializeExistingFoundationGovernanceInTransaction(database);
    writeSchemaVersion(database, targetVersion);
    const violations = database.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `Local database migration left ${violations.length} foreign key violations`
      );
    }
  });
}

export function materializeExistingFoundationGovernanceInTransaction(
  database: DatabaseSync
): void {
  const foundation = database.prepare(`
    SELECT topic_id
    FROM local_foundation
    WHERE singleton = 1
  `).get() as { topic_id: string } | undefined;
  if (foundation === undefined) return;
  const existing = database.prepare(`
    SELECT 1 AS present
    FROM topic_governance
    WHERE topic_id = ?
  `).get(foundation.topic_id);
  if (existing !== undefined) return;
  const agents = database.prepare(`
    SELECT principal_id
    FROM agents
    WHERE status = 'active'
    ORDER BY handle_key ASC
  `).all() as unknown as { principal_id: string }[];
  const at = new Date().toISOString();
  const governance = defaultTopicGovernance(
    foundation.topic_id,
    agents.map(({ principal_id }) => principal_id),
    at
  );
  const receipt = materializationReceipt(governance);
  database.prepare(`
    INSERT INTO topic_governance (
      topic_id, status, participants_json, strategy_policy_json,
      conversation_policy_json, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    governance.topicId,
    governance.status,
    JSON.stringify(governance.participants),
    JSON.stringify(governance.strategyPolicy),
    JSON.stringify(governance.conversationPolicy),
    governance.revision,
    governance.createdAt,
    governance.updatedAt
  );
  database.prepare(`
    INSERT INTO topic_governance_control_receipts (
      receipt_id, topic_id, action, previous_revision, resulting_revision,
      receipt_json, created_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?)
  `).run(
    receipt.receiptId,
    receipt.topicId,
    receipt.action,
    receipt.resultingRevision,
    JSON.stringify(receipt),
    receipt.createdAt
  );
}
