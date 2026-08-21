import type { DatabaseSync } from "node:sqlite";

import {
  defaultTopicGovernance,
  materializationReceipt,
  parseTopicGovernance,
  parseTopicGovernanceControlReceipt,
  revisionReceipt,
  type TopicGovernance,
  type TopicGovernanceControlReceipt,
  type TopicGovernanceMaterialization,
  type TopicGovernanceRevisionInput
} from "../../modules/topic/governance.js";
import { openInitializedRuntimeDatabase } from "./database.js";
import { migrateLocalDatabase } from "./schema/index.js";
import { withImmediateTransaction } from "./transaction.js";

interface GovernanceRow {
  topic_id: string;
  status: string;
  participants_json: string;
  strategy_policy_json: string;
  conversation_policy_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface ReceiptRow {
  receipt_json: string;
}

export class TopicGovernanceRevisionConflict extends Error {
  public readonly current: TopicGovernance;

  public constructor(expectedRevision: number, current: TopicGovernance) {
    super(
      `Topic governance revision conflict: expected ${expectedRevision}, ` +
      `current ${current.revision}`
    );
    this.name = "TopicGovernanceRevisionConflict";
    this.current = current;
  }
}

export class TopicGovernanceStore {
  readonly #database: DatabaseSync;
  readonly #ownsDatabase: boolean;

  public constructor(database: string | DatabaseSync) {
    this.#database = typeof database === "string"
      ? openInitializedRuntimeDatabase(database, migrateLocalDatabase)
      : database;
    this.#ownsDatabase = typeof database === "string";
    if (!this.#ownsDatabase) migrateLocalDatabase(this.#database);
  }

  public close(): void {
    if (this.#ownsDatabase) this.#database.close();
  }

  public materializeDefault(
    topicId: string,
    activeAgentIds: readonly string[],
    at = new Date().toISOString()
  ): TopicGovernanceMaterialization {
    return withImmediateTransaction(this.#database, () => {
      const existing = this.get(topicId);
      if (existing !== undefined) {
        return {
          governance: existing,
          receipt: this.requireReceipt(topicId, 1),
          created: false
        };
      }
      const governance = defaultTopicGovernance(topicId, activeAgentIds, at);
      const receipt = materializationReceipt(governance);
      this.#database.prepare(`
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
      this.#insertReceipt(receipt);
      return { governance, receipt, created: true };
    });
  }

  public get(topicId: string): TopicGovernance | undefined {
    const row = this.#database.prepare(`
      SELECT topic_id, status, participants_json, strategy_policy_json,
             conversation_policy_json, revision, created_at, updated_at
      FROM topic_governance
      WHERE topic_id = ?
    `).get(topicId) as GovernanceRow | undefined;
    return row === undefined ? undefined : governanceFromRow(row);
  }

  public require(topicId: string): TopicGovernance {
    const governance = this.get(topicId);
    if (governance === undefined) {
      throw new Error(`Topic governance is not materialized: ${topicId}`);
    }
    return governance;
  }

  public receipts(topicId: string, limit = 100): readonly TopicGovernanceControlReceipt[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("Topic governance receipt limit must be between 1 and 1000");
    }
    return (this.#database.prepare(`
      SELECT receipt_json
      FROM topic_governance_control_receipts
      WHERE topic_id = ?
      ORDER BY resulting_revision DESC
      LIMIT ?
    `).all(topicId, limit) as unknown as ReceiptRow[])
      .map(({ receipt_json }) => parseReceiptJson(receipt_json));
  }

  public commitRevision(
    topicId: string,
    input: TopicGovernanceRevisionInput,
    at = new Date().toISOString()
  ): {
    readonly governance: TopicGovernance;
    readonly receipt: TopicGovernanceControlReceipt;
  } {
    return withImmediateTransaction(this.#database, () => {
      const current = this.require(topicId);
      if (current.revision !== input.expectedRevision) {
        throw new TopicGovernanceRevisionConflict(input.expectedRevision, current);
      }
      const next = parseTopicGovernance({
        topicId,
        ...input.next,
        revision: current.revision + 1,
        createdAt: current.createdAt,
        updatedAt: at
      });
      const receipt = revisionReceipt({
        topicId,
        action: input.action,
        actor: input.actor,
        previousRevision: current.revision,
        changedFields: input.changedFields,
        createdAt: at
      });
      const result = this.#database.prepare(`
        UPDATE topic_governance
        SET status = ?, participants_json = ?, strategy_policy_json = ?,
            conversation_policy_json = ?, revision = ?, updated_at = ?
        WHERE topic_id = ? AND revision = ?
      `).run(
        next.status,
        JSON.stringify(next.participants),
        JSON.stringify(next.strategyPolicy),
        JSON.stringify(next.conversationPolicy),
        next.revision,
        next.updatedAt,
        topicId,
        input.expectedRevision
      );
      if (result.changes !== 1) {
        throw new TopicGovernanceRevisionConflict(input.expectedRevision, this.require(topicId));
      }
      this.#insertReceipt(receipt);
      return { governance: next, receipt };
    });
  }

  public requireReceipt(
    topicId: string,
    resultingRevision: number
  ): TopicGovernanceControlReceipt {
    const row = this.#database.prepare(`
      SELECT receipt_json
      FROM topic_governance_control_receipts
      WHERE topic_id = ? AND resulting_revision = ?
    `).get(topicId, resultingRevision) as ReceiptRow | undefined;
    if (row === undefined) {
      throw new Error(
        `Topic governance receipt not found: ${topicId}@${resultingRevision}`
      );
    }
    return parseReceiptJson(row.receipt_json);
  }

  #insertReceipt(receipt: TopicGovernanceControlReceipt): void {
    const validated = parseTopicGovernanceControlReceipt(receipt);
    this.#database.prepare(`
      INSERT INTO topic_governance_control_receipts (
        receipt_id, topic_id, action, previous_revision, resulting_revision,
        receipt_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      validated.receiptId,
      validated.topicId,
      validated.action,
      validated.previousRevision,
      validated.resultingRevision,
      JSON.stringify(validated),
      validated.createdAt
    );
  }
}

function governanceFromRow(row: GovernanceRow): TopicGovernance {
  return parseTopicGovernance({
    topicId: row.topic_id,
    status: row.status,
    participants: parseJson(row.participants_json, "participants"),
    strategyPolicy: parseJson(row.strategy_policy_json, "strategyPolicy"),
    conversationPolicy: parseJson(row.conversation_policy_json, "conversationPolicy"),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function parseReceiptJson(value: string): TopicGovernanceControlReceipt {
  return parseTopicGovernanceControlReceipt(parseJson(value, "receipt"));
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Persisted Topic governance ${field} JSON is invalid`);
  }
}
