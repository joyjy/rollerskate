import { randomUUID } from "node:crypto";

import type {
  AuthorizationTransactionRecord,
  BffSessionRecord,
  HumanRecord,
  OidcIdentity
} from "../../../../application/model.js";
import type { TrustRepository } from "../../../../modules/trust/repository.js";
import { identityKey, MemoryRepositoryState } from "./state.js";

export class MemoryTrustRepository implements TrustRepository {
  readonly #state: MemoryRepositoryState;

  public constructor(state: MemoryRepositoryState) {
    this.#state = state;
  }

  public async putAuthorizationTransaction(
    record: AuthorizationTransactionRecord
  ): Promise<void> {
    this.#state.authorizationTransactions.set(record.state, record);
  }

  public async takeAuthorizationTransaction(
    state: string,
    now: string
  ): Promise<AuthorizationTransactionRecord | undefined> {
    const record = this.#state.authorizationTransactions.get(state);
    if (
      record === undefined ||
      record.consumedAt !== undefined ||
      Date.parse(record.expiresAt) <= Date.parse(now)
    ) {
      return undefined;
    }
    this.#state.authorizationTransactions.set(state, { ...record, consumedAt: now });
    return record;
  }

  public async admitHuman(
    identity: OidcIdentity,
    now: string
  ): Promise<HumanRecord | undefined> {
    const key = identityKey(identity.issuer, identity.subject);
    const existingId = this.#state.humanIdentity.get(key);
    const existing = existingId === undefined ? undefined : this.#state.humans.get(existingId);
    const isBootstrapAdmin = this.#state.humans.size === 0;
    if (
      !isBootstrapAdmin &&
      existing?.isAdmin !== true &&
      !this.#state.allowlist.has(key)
    ) {
      return undefined;
    }
    const human: HumanRecord = {
      id: existing?.id ?? randomUUID(),
      issuer: identity.issuer,
      subject: identity.subject,
      displayName: identity.displayName,
      status: existing?.status ?? "active",
      isAdmin: existing?.isAdmin === true || isBootstrapAdmin,
      metadata: identity.metadata,
      createdAt: existing?.createdAt ?? now
    };
    this.#state.humans.set(human.id, human);
    this.#state.humanIdentity.set(key, human.id);
    return human;
  }

  public async allowSubject(
    issuer: string,
    subject: string,
    _createdByHumanId: string,
    _now: string
  ): Promise<void> {
    this.#state.allowlist.add(identityKey(issuer, subject));
  }

  public async getHuman(id: string): Promise<HumanRecord | undefined> {
    return this.#state.humans.get(id);
  }

  public async putSession(record: BffSessionRecord): Promise<void> {
    this.#state.sessions.set(record.id, record);
  }

  public async getSession(
    id: string,
    now: string
  ): Promise<BffSessionRecord | undefined> {
    const record = this.#state.sessions.get(id);
    return record !== undefined &&
      record.revokedAt === undefined &&
      Date.parse(record.expiresAt) > Date.parse(now)
      ? record
      : undefined;
  }
}
