import type { DatabaseSync } from "node:sqlite";

import {
  freeChatReceipt,
  parseFreeChatMode,
  parseFreeChatModeReceipt,
  type FreeChatMode,
  type FreeChatModeReceipt,
  type FreeChatModeReceiptAction
} from "../../modules/topic/free-chat.js";
import { openInitializedRuntimeDatabase } from "./database.js";
import { migrateLocalDatabase } from "./schema/index.js";
import { withImmediateTransaction } from "./transaction.js";

interface ModeRow {
  state_json: string;
}

interface ReceiptRow {
  receipt_json: string;
}

export class FreeChatModeRevisionConflict extends Error {
  public readonly current: FreeChatMode;

  public constructor(expectedRevision: number, current: FreeChatMode) {
    super(
      `Free Chat mode revision conflict: expected ${expectedRevision}, ` +
      `current ${current.revision}`
    );
    this.name = "FreeChatModeRevisionConflict";
    this.current = current;
  }
}

export class FreeChatActiveModeConflict extends Error {
  public readonly current: FreeChatMode;

  public constructor(current: FreeChatMode) {
    super(`Free Chat mode is already active: ${current.modeId}`);
    this.name = "FreeChatActiveModeConflict";
    this.current = current;
  }
}

export class FreeChatModeStore {
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

  public create(
    modeInput: FreeChatMode,
    at = new Date().toISOString()
  ): { readonly mode: FreeChatMode; readonly receipt: FreeChatModeReceipt } {
    const mode = parseFreeChatMode(modeInput);
    if (mode.revision !== 1 || mode.status !== "active") {
      throw new Error("Free Chat mode must start active at revision 1");
    }
    return withImmediateTransaction(this.#database, () => {
      const active = this.active(mode.topicId);
      if (active !== undefined) throw new FreeChatActiveModeConflict(active);
      const receipt = freeChatReceipt({
        mode,
        action: "started",
        previousRevision: null,
        sequence: 1,
        details: {
          idleDeadline: mode.sample.idleDeadline,
          participantCount: mode.sample.participantCount
        },
        createdAt: at
      });
      this.#database.prepare(`
        INSERT INTO free_chat_modes (
          mode_id, topic_id, status, revision, state_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        mode.modeId,
        mode.topicId,
        mode.status,
        mode.revision,
        JSON.stringify(mode),
        mode.startedAt,
        mode.updatedAt
      );
      this.#insertReceipt(receipt);
      return { mode, receipt };
    });
  }

  public get(modeId: string): FreeChatMode | undefined {
    const row = this.#database.prepare(`
      SELECT state_json FROM free_chat_modes WHERE mode_id = ?
    `).get(modeId) as ModeRow | undefined;
    return row === undefined ? undefined : parseModeJson(row.state_json);
  }

  public active(topicId: string): FreeChatMode | undefined {
    const row = this.#database.prepare(`
      SELECT state_json FROM free_chat_modes
      WHERE topic_id = ? AND status = 'active'
      LIMIT 1
    `).get(topicId) as ModeRow | undefined;
    return row === undefined ? undefined : parseModeJson(row.state_json);
  }

  public latest(topicId: string): FreeChatMode | undefined {
    const row = this.#database.prepare(`
      SELECT state_json FROM free_chat_modes
      WHERE topic_id = ?
      ORDER BY updated_at DESC, mode_id DESC
      LIMIT 1
    `).get(topicId) as ModeRow | undefined;
    return row === undefined ? undefined : parseModeJson(row.state_json);
  }

  public activeModes(): readonly FreeChatMode[] {
    return (this.#database.prepare(`
      SELECT state_json FROM free_chat_modes
      WHERE status = 'active'
      ORDER BY updated_at ASC, mode_id ASC
    `).all() as unknown as ModeRow[]).map(({ state_json }) => parseModeJson(state_json));
  }

  public receipts(modeId: string, limit = 100): readonly FreeChatModeReceipt[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Free Chat receipt limit must be between 1 and 1000");
    }
    return (this.#database.prepare(`
      SELECT receipt_json FROM free_chat_mode_receipts
      WHERE mode_id = ?
      ORDER BY sequence DESC
      LIMIT ?
    `).all(modeId, limit) as unknown as ReceiptRow[])
      .map(({ receipt_json }) => parseReceiptJson(receipt_json));
  }

  public commit(input: {
    readonly modeId: string;
    readonly expectedRevision: number;
    readonly next: FreeChatMode;
    readonly action: Exclude<FreeChatModeReceiptAction, "started">;
    readonly details?: Readonly<Record<string, string | number | boolean>>;
    readonly at?: string;
  }): { readonly mode: FreeChatMode; readonly receipt: FreeChatModeReceipt } {
    return withImmediateTransaction(this.#database, () => this.commitInTransaction(input));
  }

  public commitInTransaction(input: {
    readonly modeId: string;
    readonly expectedRevision: number;
    readonly next: FreeChatMode;
    readonly action: Exclude<FreeChatModeReceiptAction, "started">;
    readonly details?: Readonly<Record<string, string | number | boolean>>;
    readonly at?: string;
  }): { readonly mode: FreeChatMode; readonly receipt: FreeChatModeReceipt } {
      const current = this.get(input.modeId);
      if (current === undefined) throw new Error(`Free Chat mode not found: ${input.modeId}`);
      if (current.revision !== input.expectedRevision) {
        throw new FreeChatModeRevisionConflict(input.expectedRevision, current);
      }
      const mode = parseFreeChatMode(input.next);
      if (mode.modeId !== current.modeId || mode.topicId !== current.topicId ||
        mode.revision !== current.revision + 1) {
        throw new Error("Free Chat mode transition identity or revision changed");
      }
      const sequence = (this.#database.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM free_chat_mode_receipts WHERE mode_id = ?
      `).get(mode.modeId) as { sequence: number }).sequence;
      const receipt = freeChatReceipt({
        mode,
        action: input.action,
        previousRevision: current.revision,
        sequence,
        ...(input.details === undefined ? {} : { details: input.details }),
        createdAt: input.at ?? mode.updatedAt
      });
      const result = this.#database.prepare(`
        UPDATE free_chat_modes
        SET status = ?, revision = ?, state_json = ?, updated_at = ?
        WHERE mode_id = ? AND revision = ?
      `).run(
        mode.status,
        mode.revision,
        JSON.stringify(mode),
        mode.updatedAt,
        mode.modeId,
        current.revision
      );
      if (result.changes !== 1) {
        throw new FreeChatModeRevisionConflict(
          input.expectedRevision, this.get(input.modeId)!
        );
      }
      this.#insertReceipt(receipt);
      return { mode, receipt };
  }

  #insertReceipt(receiptInput: FreeChatModeReceipt): void {
    const receipt = parseFreeChatModeReceipt(receiptInput);
    this.#database.prepare(`
      INSERT INTO free_chat_mode_receipts (
        receipt_id, mode_id, topic_id, sequence, action, receipt_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.receiptId,
      receipt.modeId,
      receipt.topicId,
      receipt.sequence,
      receipt.action,
      JSON.stringify(receipt),
      receipt.createdAt
    );
  }
}

function parseModeJson(value: string): FreeChatMode {
  return parseFreeChatMode(parseJson(value, "mode"));
}

function parseReceiptJson(value: string): FreeChatModeReceipt {
  return parseFreeChatModeReceipt(parseJson(value, "receipt"));
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Persisted Free Chat ${field} JSON is invalid`);
  }
}
