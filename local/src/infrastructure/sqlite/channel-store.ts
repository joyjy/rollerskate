import type { DatabaseSync } from "node:sqlite";

import {
  channelRefAllowed,
  channelRefKey,
  interactiveChannelBindingAvailableAt,
  parseChannelFollow,
  parseChannelSendReceipt,
  parseInteractiveChannelBinding,
  type ChannelFollow,
  type ChannelSendReceipt,
  type InteractiveChannelBinding
} from "../../modules/channel/model.js";
import { openInitializedRuntimeDatabase } from "./database.js";
import { migrateLocalDatabase } from "./schema/index.js";
import { withImmediateTransaction } from "./transaction.js";

interface StateRow { state_json: string }
interface ReceiptRow { receipt_json: string }

export class InteractiveChannelBindingRevisionConflict extends Error {
  public readonly current: InteractiveChannelBinding;

  public constructor(expectedRevision: number, current: InteractiveChannelBinding) {
    super(
      `Interactive Channel binding revision conflict: expected ${expectedRevision}, ` +
      `current ${current.revision}`
    );
    this.name = "InteractiveChannelBindingRevisionConflict";
    this.current = current;
  }
}

export class ChannelSendRevisionConflict extends Error {
  public readonly current: ChannelSendReceipt;

  public constructor(expectedRevision: number, current: ChannelSendReceipt) {
    super(`Channel send revision conflict: expected ${expectedRevision}, current ${current.revision}`);
    this.name = "ChannelSendRevisionConflict";
    this.current = current;
  }
}

export class ChannelSendIdempotencyConflict extends Error {
  public readonly current: ChannelSendReceipt;

  public constructor(current: ChannelSendReceipt) {
    super(`Channel send idempotency key has different input: ${current.idempotencyKey}`);
    this.name = "ChannelSendIdempotencyConflict";
    this.current = current;
  }
}

export class ChannelFollowRevisionConflict extends Error {
  public readonly current: ChannelFollow;

  public constructor(expectedRevision: number, current: ChannelFollow) {
    super(`Channel follow revision conflict: expected ${expectedRevision}, current ${current.revision}`);
    this.name = "ChannelFollowRevisionConflict";
    this.current = current;
  }
}

export class ChannelStore {
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

  public createBinding(bindingInput: InteractiveChannelBinding): InteractiveChannelBinding {
    const binding = parseInteractiveChannelBinding(bindingInput);
    if (binding.status !== "active" || binding.revision !== 1) {
      throw new Error("Interactive Channel binding must start active at revision 1");
    }
    this.#database.prepare(`
      INSERT INTO interactive_channel_bindings (
        binding_id, agent_id, status, revision, state_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      binding.bindingId,
      binding.agentId,
      binding.status,
      binding.revision,
      JSON.stringify(binding),
      binding.createdAt,
      binding.updatedAt
    );
    return binding;
  }

  public getBinding(bindingId: string): InteractiveChannelBinding | undefined {
    const row = this.#database.prepare(`
      SELECT state_json FROM interactive_channel_bindings WHERE binding_id = ?
    `).get(bindingId) as StateRow | undefined;
    return row === undefined ? undefined : parseBindingJson(row.state_json);
  }

  public requireBinding(bindingId: string): InteractiveChannelBinding {
    const binding = this.getBinding(bindingId);
    if (binding === undefined) throw new Error(`Interactive Channel binding not found: ${bindingId}`);
    return binding;
  }

  public bindingsForAgent(agentId: string): readonly InteractiveChannelBinding[] {
    return (this.#database.prepare(`
      SELECT state_json FROM interactive_channel_bindings
      WHERE agent_id = ? ORDER BY updated_at DESC, binding_id DESC
    `).all(agentId) as unknown as StateRow[]).map(({ state_json }) => parseBindingJson(state_json));
  }

  public bindings(limit = 100): readonly InteractiveChannelBinding[] {
    boundedLimit(limit);
    return (this.#database.prepare(`
      SELECT state_json FROM interactive_channel_bindings
      ORDER BY updated_at DESC, binding_id DESC LIMIT ?
    `).all(limit) as unknown as StateRow[]).map(({ state_json }) =>
      parseBindingJson(state_json));
  }

  public activeBindingsExpiredAt(at: string): readonly InteractiveChannelBinding[] {
    return (this.#database.prepare(`
      SELECT state_json FROM interactive_channel_bindings
      WHERE status = 'active'
        AND julianday(json_extract(state_json, '$.expiresAt')) <= julianday(?)
      ORDER BY updated_at ASC, binding_id ASC
    `).all(at) as unknown as StateRow[]).map(({ state_json }) => parseBindingJson(state_json));
  }

  public commitBinding(input: {
    readonly bindingId: string;
    readonly expectedRevision: number;
    readonly next: InteractiveChannelBinding;
  }): InteractiveChannelBinding {
    return withImmediateTransaction(this.#database, () => {
      const current = this.requireBinding(input.bindingId);
      if (current.revision !== input.expectedRevision) {
        throw new InteractiveChannelBindingRevisionConflict(input.expectedRevision, current);
      }
      const next = parseInteractiveChannelBinding(input.next);
      if (next.bindingId !== current.bindingId || next.agentId !== current.agentId ||
        next.revision !== current.revision + 1 || next.createdAt !== current.createdAt) {
        throw new Error("Interactive Channel binding transition changed identity or revision");
      }
      const result = this.#database.prepare(`
        UPDATE interactive_channel_bindings
        SET status = ?, revision = ?, state_json = ?, updated_at = ?
        WHERE binding_id = ? AND revision = ?
      `).run(
        next.status,
        next.revision,
        JSON.stringify(next),
        next.updatedAt,
        next.bindingId,
        current.revision
      );
      if (result.changes !== 1) {
        throw new InteractiveChannelBindingRevisionConflict(
          input.expectedRevision, this.requireBinding(input.bindingId)
        );
      }
      return next;
    });
  }

  public reserveSend(input: {
    readonly receipt: ChannelSendReceipt;
    readonly follow: ChannelFollow;
  }): {
    readonly created: boolean;
    readonly receipt: ChannelSendReceipt;
    readonly follow: ChannelFollow;
  } {
    const receipt = parseChannelSendReceipt(input.receipt);
    const follow = parseChannelFollow(input.follow);
    if (receipt.status !== "pending" || receipt.revision !== 1) {
      throw new Error("Channel send reservation must start pending at revision 1");
    }
    if (follow.status !== "waiting" || follow.revision !== 1 ||
      follow.followToken !== receipt.followToken || follow.sendId !== receipt.sendId ||
      follow.bindingId !== receipt.bindingId || follow.bindingRevision !== receipt.bindingRevision ||
      channelRefKey(follow.channelRef) !== channelRefKey(receipt.channelRef)) {
      throw new Error("Channel send and follow reservation identities must agree");
    }
    return withImmediateTransaction(this.#database, () => {
      const existing = this.sendForIdempotency(receipt.bindingId, receipt.idempotencyKey);
      if (existing !== undefined) {
        if (!sameSendRequest(existing, receipt)) {
          throw new ChannelSendIdempotencyConflict(existing);
        }
        return {
          created: false,
          receipt: existing,
          follow: this.requireFollow(existing.followToken)
        };
      }
      const binding = this.requireBinding(receipt.bindingId);
      if (binding.revision !== receipt.bindingRevision ||
        binding.agentId !== receipt.senderAgentId ||
        !interactiveChannelBindingAvailableAt(binding, receipt.createdAt) ||
        !channelRefAllowed(binding, receipt.channelRef)) {
        throw new Error("Interactive Channel binding authority changed before send admission");
      }
      if (follow.callback !== undefined &&
        follow.callback.sessionId !== binding.callbackSessionId) {
        throw new Error("Channel follow callback must use the exact bound Session");
      }
      this.#database.prepare(`
        INSERT INTO channel_send_receipts (
          send_id, binding_id, idempotency_key, channel_kind, channel_id,
          receipt_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        receipt.sendId,
        receipt.bindingId,
        receipt.idempotencyKey,
        receipt.channelRef.kind,
        receipt.channelRef.channelId,
        JSON.stringify(receipt),
        receipt.createdAt
      );
      this.#insertFollow(follow);
      return { created: true, receipt, follow };
    });
  }

  public getSend(sendId: string): ChannelSendReceipt | undefined {
    const row = this.#database.prepare(`
      SELECT receipt_json FROM channel_send_receipts WHERE send_id = ?
    `).get(sendId) as ReceiptRow | undefined;
    return row === undefined ? undefined : parseSendJson(row.receipt_json);
  }

  public requireSend(sendId: string): ChannelSendReceipt {
    const receipt = this.getSend(sendId);
    if (receipt === undefined) throw new Error(`Channel send not found: ${sendId}`);
    return receipt;
  }

  public sendForIdempotency(
    bindingId: string,
    idempotencyKey: string
  ): ChannelSendReceipt | undefined {
    const row = this.#database.prepare(`
      SELECT receipt_json FROM channel_send_receipts
      WHERE binding_id = ? AND idempotency_key = ?
    `).get(bindingId, idempotencyKey) as ReceiptRow | undefined;
    return row === undefined ? undefined : parseSendJson(row.receipt_json);
  }

  public pendingSends(limit = 100): readonly ChannelSendReceipt[] {
    boundedLimit(limit);
    return (this.#database.prepare(`
      SELECT receipt_json FROM channel_send_receipts
      WHERE json_extract(receipt_json, '$.status') = 'pending'
      ORDER BY created_at ASC, send_id ASC LIMIT ?
    `).all(limit) as unknown as ReceiptRow[]).map(({ receipt_json }) => parseSendJson(receipt_json));
  }

  public commitSend(input: {
    readonly sendId: string;
    readonly expectedRevision: number;
    readonly next: ChannelSendReceipt;
  }): ChannelSendReceipt {
    return withImmediateTransaction(this.#database, () => {
      const current = this.requireSend(input.sendId);
      if (current.revision !== input.expectedRevision) {
        throw new ChannelSendRevisionConflict(input.expectedRevision, current);
      }
      const next = parseChannelSendReceipt(input.next);
      if (!sameSendRequest(current, next) || next.sendId !== current.sendId ||
        next.followToken !== current.followToken || next.transactionId !== current.transactionId ||
        next.createdAt !== current.createdAt || next.revision !== current.revision + 1) {
        throw new Error("Channel send transition changed request identity or revision");
      }
      if (current.status !== "pending") {
        throw new Error(`Terminal Channel send cannot become ${next.status}`);
      }
      const result = this.#database.prepare(`
        UPDATE channel_send_receipts SET receipt_json = ?
        WHERE send_id = ? AND json_extract(receipt_json, '$.revision') = ?
      `).run(JSON.stringify(next), next.sendId, current.revision);
      if (result.changes !== 1) {
        throw new ChannelSendRevisionConflict(input.expectedRevision, this.requireSend(input.sendId));
      }
      return next;
    });
  }

  public getFollow(followToken: string): ChannelFollow | undefined {
    const row = this.#database.prepare(`
      SELECT state_json FROM channel_follows WHERE follow_token = ?
    `).get(followToken) as StateRow | undefined;
    return row === undefined ? undefined : parseFollowJson(row.state_json);
  }

  public requireFollow(followToken: string): ChannelFollow {
    const follow = this.getFollow(followToken);
    if (follow === undefined) throw new Error(`Channel follow not found: ${followToken}`);
    return follow;
  }

  public followsForBinding(bindingId: string, limit = 100): readonly ChannelFollow[] {
    boundedLimit(limit);
    return (this.#database.prepare(`
      SELECT state_json FROM channel_follows
      WHERE binding_id = ? ORDER BY updated_at DESC, follow_token DESC LIMIT ?
    `).all(bindingId, limit) as unknown as StateRow[]).map(({ state_json }) =>
      parseFollowJson(state_json));
  }

  public activeFollows(limit = 100): readonly ChannelFollow[] {
    boundedLimit(limit);
    return (this.#database.prepare(`
      SELECT state_json FROM channel_follows
      WHERE status IN ('waiting', 'active')
      ORDER BY updated_at ASC, follow_token ASC LIMIT ?
    `).all(limit) as unknown as StateRow[]).map(({ state_json }) => parseFollowJson(state_json));
  }

  public callbackCandidates(limit = 100): readonly ChannelFollow[] {
    boundedLimit(limit);
    return (this.#database.prepare(`
      SELECT state_json FROM channel_follows
      WHERE status IN ('quiet', 'terminal', 'failed')
        AND json_extract(state_json, '$.callback.status') IN ('armed', 'pending')
      ORDER BY updated_at ASC, follow_token ASC LIMIT ?
    `).all(limit) as unknown as StateRow[]).map(({ state_json }) => parseFollowJson(state_json));
  }

  public activeFollowsExpiredAt(at: string, limit = 100): readonly ChannelFollow[] {
    boundedLimit(limit);
    return (this.#database.prepare(`
      SELECT state_json FROM channel_follows
      WHERE status IN ('waiting', 'active')
        AND julianday(json_extract(state_json, '$.deadlineAt')) <= julianday(?)
      ORDER BY updated_at ASC, follow_token ASC LIMIT ?
    `).all(at, limit) as unknown as StateRow[]).map(({ state_json }) => parseFollowJson(state_json));
  }

  public commitFollow(input: {
    readonly followToken: string;
    readonly expectedRevision: number;
    readonly next: ChannelFollow;
  }): ChannelFollow {
    return withImmediateTransaction(this.#database, () => {
      const current = this.requireFollow(input.followToken);
      if (current.revision !== input.expectedRevision) {
        throw new ChannelFollowRevisionConflict(input.expectedRevision, current);
      }
      const next = parseChannelFollow(input.next);
      if (next.followToken !== current.followToken || next.sendId !== current.sendId ||
        next.bindingId !== current.bindingId || next.bindingRevision !== current.bindingRevision ||
        channelRefKey(next.channelRef) !== channelRefKey(current.channelRef) ||
        next.condition !== current.condition || next.deadlineAt !== current.deadlineAt ||
        next.createdAt !== current.createdAt || next.revision !== current.revision + 1) {
        throw new Error("Channel follow transition changed identity, policy, or revision");
      }
      const result = this.#database.prepare(`
        UPDATE channel_follows SET status = ?, state_json = ?, updated_at = ?
        WHERE follow_token = ? AND json_extract(state_json, '$.revision') = ?
      `).run(next.status, JSON.stringify(next), next.updatedAt, next.followToken, current.revision);
      if (result.changes !== 1) {
        throw new ChannelFollowRevisionConflict(
          input.expectedRevision, this.requireFollow(input.followToken)
        );
      }
      return next;
    });
  }

  #insertFollow(follow: ChannelFollow): void {
    this.#database.prepare(`
      INSERT INTO channel_follows (
        follow_token, send_id, binding_id, status, state_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      follow.followToken,
      follow.sendId,
      follow.bindingId,
      follow.status,
      JSON.stringify(follow),
      follow.createdAt,
      follow.updatedAt
    );
  }
}

function sameSendRequest(left: ChannelSendReceipt, right: ChannelSendReceipt): boolean {
  return left.bindingId === right.bindingId &&
    left.bindingRevision === right.bindingRevision &&
    left.senderAgentId === right.senderAgentId &&
    left.idempotencyKey === right.idempotencyKey &&
    left.requestFingerprint === right.requestFingerprint &&
    left.body === right.body &&
    channelRefKey(left.channelRef) === channelRefKey(right.channelRef);
}

function boundedLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Channel query limit must be between 1 and 1000");
  }
}

function parseBindingJson(value: string): InteractiveChannelBinding {
  return parseInteractiveChannelBinding(parseJson(value, "binding"));
}

function parseSendJson(value: string): ChannelSendReceipt {
  return parseChannelSendReceipt(parseJson(value, "send receipt"));
}

function parseFollowJson(value: string): ChannelFollow {
  return parseChannelFollow(parseJson(value, "follow"));
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Persisted Channel ${field} JSON is invalid`);
  }
}
