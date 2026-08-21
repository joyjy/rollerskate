import type { DatabaseSync } from "node:sqlite";

import {
  parseTopicActivationSchedule,
  parseTopicActivationScheduleReceipt,
  topicActivationScheduleReceipt,
  type TopicActivationSchedule,
  type TopicActivationScheduleReceipt,
  type TopicActivationScheduleReceiptAction
} from "../../modules/topic/schedule.js";
import { openInitializedRuntimeDatabase } from "./database.js";
import { migrateLocalDatabase } from "./schema/index.js";
import { withImmediateTransaction } from "./transaction.js";

interface ScheduleRow { state_json: string }
interface ReceiptRow { receipt_json: string }

export class TopicActivationScheduleRevisionConflict extends Error {
  public readonly current: TopicActivationSchedule;
  public constructor(expected: number, current: TopicActivationSchedule) {
    super(`Topic activation schedule revision conflict: expected ${expected}, current ${current.revision}`);
    this.name = "TopicActivationScheduleRevisionConflict";
    this.current = current;
  }
}

export class TopicActivationScheduleStore {
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

  public create(scheduleInput: TopicActivationSchedule): {
    readonly schedule: TopicActivationSchedule;
    readonly receipt: TopicActivationScheduleReceipt;
  } {
    const schedule = parseTopicActivationSchedule(scheduleInput);
    return withImmediateTransaction(this.#database, () => {
      this.#database.prepare(`
        INSERT INTO topic_activation_schedules (
          schedule_id, topic_id, status, revision, next_run_at,
          next_occurrence_key, state_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        schedule.scheduleId, schedule.topicId, schedule.status, schedule.revision,
        schedule.nextRunAt ?? null, schedule.nextOccurrenceKey ?? null,
        JSON.stringify(schedule), schedule.createdAt, schedule.updatedAt
      );
      const receipt = this.#receipt(schedule, "created", schedule.createdAt);
      this.#insertReceipt(receipt);
      return { schedule, receipt };
    });
  }

  public get(scheduleId: string): TopicActivationSchedule | undefined {
    const row = this.#database.prepare(`
      SELECT state_json FROM topic_activation_schedules WHERE schedule_id = ?
    `).get(scheduleId) as ScheduleRow | undefined;
    return row === undefined ? undefined : parseScheduleJson(row.state_json);
  }

  public require(scheduleId: string): TopicActivationSchedule {
    const schedule = this.get(scheduleId);
    if (schedule === undefined) throw new Error(`Topic activation schedule not found: ${scheduleId}`);
    return schedule;
  }

  public list(topicId: string): readonly TopicActivationSchedule[] {
    return (this.#database.prepare(`
      SELECT state_json FROM topic_activation_schedules
      WHERE topic_id = ? ORDER BY updated_at DESC, schedule_id DESC
    `).all(topicId) as unknown as ScheduleRow[]).map(({ state_json }) =>
      parseScheduleJson(state_json));
  }

  public due(at: string): readonly TopicActivationSchedule[] {
    return (this.#database.prepare(`
      SELECT state_json FROM topic_activation_schedules
      WHERE status = 'active' AND julianday(next_run_at) <= julianday(?)
      ORDER BY next_run_at ASC, schedule_id ASC
    `).all(at) as unknown as ScheduleRow[]).map(({ state_json }) =>
      parseScheduleJson(state_json));
  }

  public receipts(scheduleId: string, limit = 100): readonly TopicActivationScheduleReceipt[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Topic activation schedule receipt limit must be between 1 and 1000");
    }
    return (this.#database.prepare(`
      SELECT receipt_json FROM topic_activation_schedule_receipts
      WHERE schedule_id = ? ORDER BY sequence DESC LIMIT ?
    `).all(scheduleId, limit) as unknown as ReceiptRow[]).map(({ receipt_json }) =>
      parseReceiptJson(receipt_json));
  }

  public receiptForOccurrence(
    scheduleId: string,
    occurrenceKey: string
  ): TopicActivationScheduleReceipt | undefined {
    const row = this.#database.prepare(`
      SELECT receipt_json FROM topic_activation_schedule_receipts
      WHERE schedule_id = ? AND occurrence_key = ?
    `).get(scheduleId, occurrenceKey) as ReceiptRow | undefined;
    return row === undefined ? undefined : parseReceiptJson(row.receipt_json);
  }

  public commitControl(input: {
    readonly current: TopicActivationSchedule;
    readonly expectedRevision: number;
    readonly action: "pause" | "resume" | "cancel";
    readonly next: TopicActivationSchedule;
    readonly at: string;
    readonly skippedOccurrence?: {
      readonly occurrenceKey: string;
      readonly scheduledFor: string;
      readonly reason: string;
    };
  }) {
    return withImmediateTransaction(this.#database, () => {
      const requested = parseTopicActivationSchedule(input.current);
      const current = this.require(requested.scheduleId);
      if (current.revision !== input.expectedRevision || current.revision !== requested.revision) {
        throw new TopicActivationScheduleRevisionConflict(input.expectedRevision, current);
      }
      const next = parseTopicActivationSchedule(input.next);
      this.#update(current.revision, next);
      if (input.skippedOccurrence !== undefined) {
        this.#insertReceipt(this.#receipt(next, "occurrence_skipped", input.at, {
          occurrenceKey: input.skippedOccurrence.occurrenceKey,
          scheduledFor: input.skippedOccurrence.scheduledFor,
          reason: input.skippedOccurrence.reason
        }));
      }
      const receipt = this.#receipt(
        next,
        input.action === "pause" ? "paused" : input.action === "resume" ? "resumed" : "cancelled",
        input.at
      );
      this.#insertReceipt(receipt);
      return { changed: true, schedule: next, receipt };
    });
  }

  public commitOccurrenceInTransaction(input: {
    readonly current: TopicActivationSchedule;
    readonly next: TopicActivationSchedule;
    readonly action: Extract<
      TopicActivationScheduleReceiptAction,
      "occurrence_admitted" | "occurrence_skipped" | "occurrence_failed"
    >;
    readonly occurrenceKey: string;
    readonly scheduledFor: string;
    readonly activationEventId?: string;
    readonly reason?: string;
    readonly at: string;
  }): { readonly schedule: TopicActivationSchedule; readonly receipt: TopicActivationScheduleReceipt } {
    const duplicate = this.receiptForOccurrence(input.current.scheduleId, input.occurrenceKey);
    if (duplicate !== undefined) return { schedule: this.require(input.current.scheduleId), receipt: duplicate };
    const current = this.require(input.current.scheduleId);
    if (current.revision !== input.current.revision ||
      current.nextOccurrenceKey !== input.occurrenceKey) {
      throw new TopicActivationScheduleRevisionConflict(input.current.revision, current);
    }
    const next = parseTopicActivationSchedule(input.next);
    this.#update(current.revision, next);
    const receipt = this.#receipt(next, input.action, input.at, {
      occurrenceKey: input.occurrenceKey,
      scheduledFor: input.scheduledFor,
      ...(input.activationEventId === undefined ? {} : { activationEventId: input.activationEventId }),
      ...(input.reason === undefined ? {} : { reason: input.reason })
    });
    this.#insertReceipt(receipt);
    return { schedule: next, receipt };
  }

  #update(expectedRevision: number, schedule: TopicActivationSchedule): void {
    const changed = this.#database.prepare(`
      UPDATE topic_activation_schedules
      SET status = ?, revision = ?, next_run_at = ?, next_occurrence_key = ?,
        state_json = ?, updated_at = ?
      WHERE schedule_id = ? AND revision = ?
    `).run(
      schedule.status, schedule.revision, schedule.nextRunAt ?? null,
      schedule.nextOccurrenceKey ?? null, JSON.stringify(schedule), schedule.updatedAt,
      schedule.scheduleId, expectedRevision
    );
    if (changed.changes !== 1) {
      throw new TopicActivationScheduleRevisionConflict(
        expectedRevision, this.require(schedule.scheduleId)
      );
    }
  }

  #receipt(
    schedule: TopicActivationSchedule,
    action: TopicActivationScheduleReceiptAction,
    at: string,
    extra: Partial<Pick<
      TopicActivationScheduleReceipt,
      "occurrenceKey" | "scheduledFor" | "activationEventId" | "reason"
    >> = {}
  ): TopicActivationScheduleReceipt {
    const sequence = (this.#database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
      FROM topic_activation_schedule_receipts WHERE schedule_id = ?
    `).get(schedule.scheduleId) as { sequence: number }).sequence;
    return topicActivationScheduleReceipt({
      scheduleId: schedule.scheduleId,
      topicId: schedule.topicId,
      sequence,
      action,
      resultingRevision: schedule.revision,
      ...extra,
      createdAt: at
    });
  }

  #insertReceipt(receipt: TopicActivationScheduleReceipt): void {
    this.#database.prepare(`
      INSERT INTO topic_activation_schedule_receipts (
        receipt_id, schedule_id, topic_id, sequence, action, occurrence_key,
        receipt_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.receiptId, receipt.scheduleId, receipt.topicId, receipt.sequence,
      receipt.action, receipt.occurrenceKey ?? null, JSON.stringify(receipt), receipt.createdAt
    );
  }
}

function parseScheduleJson(value: string): TopicActivationSchedule {
  return parseTopicActivationSchedule(JSON.parse(value) as unknown);
}
function parseReceiptJson(value: string): TopicActivationScheduleReceipt {
  return parseTopicActivationScheduleReceipt(JSON.parse(value) as unknown);
}
