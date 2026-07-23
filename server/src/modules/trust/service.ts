import { randomUUID } from "node:crypto";

import type {
  AuthorizationTransactionRecord,
  BffSessionRecord,
  HumanRecord,
  OidcIdentity
} from "./model.js";
import { ServerError } from "../shared/error.js";
import {
  hashesEqual,
  parseOpaqueCredential,
  randomToken,
  sha256
} from "../shared/opaque-credential.js";
import { addMilliseconds, now, type ClockOptions } from "../shared/time.js";
import type { TrustRepository } from "./repository.js";

const AUTHORIZATION_TTL_MILLISECONDS = 10 * 60 * 1_000;
const SESSION_TTL_MILLISECONDS = 12 * 60 * 60 * 1_000;

export interface TrustServiceOptions extends ClockOptions {
  readonly issuer: string;
  readonly publicUrl: string;
}

export interface AuthorizationStart {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly returnTo: string;
}

export interface AuthorizationCompletion {
  readonly human: HumanRecord;
  readonly sessionToken: string;
  readonly returnTo: string;
}

export class TrustService {
  readonly #repository: TrustRepository;
  readonly #options: TrustServiceOptions;

  public constructor(repository: TrustRepository, options: TrustServiceOptions) {
    this.#repository = repository;
    this.#options = {
      ...options,
      issuer: normalizeIssuer(options.issuer),
      publicUrl: new URL(options.publicUrl).origin
    };
  }

  public async beginAuthorization(returnTo: string): Promise<AuthorizationStart> {
    const safeReturnTo = validateReturnTo(returnTo);
    const timestamp = now(this.#options);
    const record: AuthorizationTransactionRecord = {
      state: randomToken(),
      nonce: randomToken(),
      codeVerifier: randomToken(),
      returnTo: safeReturnTo,
      expiresAt: addMilliseconds(timestamp, AUTHORIZATION_TTL_MILLISECONDS),
      createdAt: timestamp
    };
    await this.#repository.putAuthorizationTransaction(record);
    return {
      state: record.state,
      nonce: record.nonce,
      codeVerifier: record.codeVerifier,
      returnTo: record.returnTo
    };
  }

  public async takeAuthorization(state: string): Promise<AuthorizationTransactionRecord> {
    const transaction = await this.#repository.takeAuthorizationTransaction(
      state,
      now(this.#options)
    );
    if (transaction === undefined) {
      throw new ServerError(
        "invalid_authorization_state",
        400,
        "authorization state is missing, expired or already consumed"
      );
    }
    return transaction;
  }

  public async completeAuthorization(
    transaction: AuthorizationTransactionRecord,
    identity: OidcIdentity
  ): Promise<AuthorizationCompletion> {
    const timestamp = now(this.#options);
    const human = await this.admitIdentity(identity, timestamp);
    const sessionId = randomUUID();
    const sessionSecret = randomToken();
    const session: BffSessionRecord = {
      id: sessionId,
      humanId: human.id,
      tokenHash: sha256(sessionSecret),
      expiresAt: addMilliseconds(timestamp, SESSION_TTL_MILLISECONDS),
      createdAt: timestamp
    };
    await this.#repository.putSession(session);
    return {
      human,
      sessionToken: `${sessionId}.${sessionSecret}`,
      returnTo: transaction.returnTo
    };
  }

  public async admitIdentity(
    identity: OidcIdentity,
    timestamp = now(this.#options)
  ): Promise<HumanRecord> {
    if (normalizeIssuer(identity.issuer) !== this.#options.issuer) {
      throw new ServerError("issuer_mismatch", 401, "OIDC issuer does not match");
    }
    const human = await this.#repository.admitHuman(identity, timestamp);
    if (human === undefined) {
      throw new ServerError(
        "admission_denied",
        403,
        "OIDC identity is not admitted to this deployment"
      );
    }
    if (human.status !== "active") {
      throw new ServerError(
        "admission_denied",
        403,
        "OIDC identity is not active in this deployment"
      );
    }
    return human;
  }

  public async authenticateSession(token: string | undefined): Promise<HumanRecord> {
    const parsed = parseOpaqueCredential(token);
    if (parsed === undefined) {
      throw new ServerError("unauthorized", 401, "BFF session is required");
    }
    const session = await this.#repository.getSession(parsed.id, now(this.#options));
    if (session === undefined || !hashesEqual(session.tokenHash, sha256(parsed.secret))) {
      throw new ServerError("unauthorized", 401, "BFF session is invalid");
    }
    const human = await this.#repository.getHuman(session.humanId);
    if (human === undefined || human.status !== "active") {
      throw new ServerError("unauthorized", 401, "Human is not active");
    }
    return human;
  }

  public async allowSubject(admin: HumanRecord, subject: string): Promise<void> {
    if (!admin.isAdmin) {
      throw new ServerError("forbidden", 403, "admin is required");
    }
    if (subject.trim() === "") {
      throw new ServerError("invalid_subject", 400, "subject is required");
    }
    await this.#repository.allowSubject(
      this.#options.issuer,
      subject.trim(),
      admin.id,
      now(this.#options)
    );
  }

  public get issuer(): string {
    return this.#options.issuer;
  }

  public get publicUrl(): string {
    return this.#options.publicUrl;
  }
}

function validateReturnTo(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    throw new ServerError("invalid_return_to", 400, "returnTo must be a local path");
  }
  return value;
}

function normalizeIssuer(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.href.replace(/\/$/, "");
}
