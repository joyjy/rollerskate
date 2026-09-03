import type { DatabaseSync } from "node:sqlite";

import { createSchema } from "./definition.js";
import { tableExists, writeSchemaVersion } from "./introspection.js";

interface ActiveFreeChatModeRow {
  readonly mode_id: string;
  readonly topic_id: string;
  readonly revision: number;
  readonly state_json: string;
}

export function assertV69SchemaShape(database: DatabaseSync): void {
  if (!["free_chat_modes", "free_chat_mode_receipts", "events", "executions"].every(
    (table) => tableExists(database, table)
  )) {
    throw new Error("Local database schema 69 is incomplete");
  }
}

export function migrateV69Schema(database: DatabaseSync, targetVersion: number): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    createSchema(database);
    retireSyntheticChatActivationStateInTransaction(database);
    writeSchemaVersion(database, targetVersion);
    const violations = database.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `Local database migration left ${violations.length} foreign key violations`
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function retireSyntheticChatActivationState(database: DatabaseSync): void {
  if (database.isTransaction) {
    retireSyntheticChatActivationStateInTransaction(database);
    return;
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    retireSyntheticChatActivationStateInTransaction(database);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function retireSyntheticChatActivationStateInTransaction(database: DatabaseSync): void {
  const retiredAt = new Date().toISOString();
  const activeModes = database.prepare(`
    SELECT mode_id, topic_id, revision, state_json
    FROM free_chat_modes
    WHERE status = 'active'
    ORDER BY mode_id
  `).all() as unknown as ActiveFreeChatModeRow[];
  for (const row of activeModes) retireFreeChatMode(database, row, retiredAt);
  database.prepare(`
    UPDATE executions
    SET status = 'cancelled', completed_at = ?, updated_at = ?,
      last_error = 'synthetic_chat_activation_retired',
      receipt_json = json_object(
        'schema', 'RuntimeExecutionSkipReceipt@1',
        'reason', 'synthetic_chat_activation_retired',
        'createdAt', ?
      )
    WHERE status IN ('queued', 'retry_wait', 'running')
      AND event_id IN (
        SELECT descendant.event_id
        FROM events AS descendant
        JOIN events AS root ON root.event_id = descendant.root_event_id
        WHERE root.type = 'chat.activation'
          AND (
            json_extract(root.payload_json, '$.strategyId') IN ('manual', 'starter')
            OR root.source_external_id LIKE 'chat-activation:free-chat:%'
          )
      )
  `).run(retiredAt, retiredAt, retiredAt);
}

function retireFreeChatMode(
  database: DatabaseSync,
  row: ActiveFreeChatModeRow,
  retiredAt: string
): void {
  const state = parseObject(row.state_json, row.mode_id);
  const nextRevision = row.revision + 1;
  const sequence = Number((database.prepare(`
    SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
    FROM free_chat_mode_receipts
    WHERE mode_id = ?
  `).get(row.mode_id) as { sequence: number | bigint }).sequence);
  const cycleIndex = Number.isInteger(state.cycleIndex) && Number(state.cycleIndex) > 0
    ? Number(state.cycleIndex)
    : 1;
  const nextState = {
    ...state,
    status: "stopped",
    stopReason: "feature_retired",
    stoppedAt: retiredAt,
    updatedAt: retiredAt,
    revision: nextRevision
  };
  const receipt = {
    schema: "FreeChatModeReceipt@1",
    receiptId: `free-chat:${row.mode_id}:${sequence}`,
    modeId: row.mode_id,
    topicId: row.topic_id,
    sequence,
    action: "stopped",
    previousRevision: row.revision,
    resultingRevision: nextRevision,
    cycleIndex,
    details: { reason: "feature_retired" },
    createdAt: retiredAt
  };
  database.prepare(`
    INSERT INTO free_chat_mode_receipts (
      receipt_id, mode_id, topic_id, sequence, action, receipt_json, created_at
    ) VALUES (?, ?, ?, ?, 'stopped', ?, ?)
  `).run(
    receipt.receiptId,
    row.mode_id,
    row.topic_id,
    sequence,
    JSON.stringify(receipt),
    retiredAt
  );
  const changed = database.prepare(`
    UPDATE free_chat_modes
    SET status = 'stopped', revision = ?, state_json = ?, updated_at = ?
    WHERE mode_id = ? AND status = 'active' AND revision = ?
  `).run(nextRevision, JSON.stringify(nextState), retiredAt, row.mode_id, row.revision);
  if (changed.changes !== 1) {
    throw new Error(`Free Chat retirement CAS failed: ${row.mode_id}`);
  }
}

function parseObject(value: string, modeId: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Free Chat mode state is invalid: ${modeId}`);
  }
  return parsed as Record<string, unknown>;
}
