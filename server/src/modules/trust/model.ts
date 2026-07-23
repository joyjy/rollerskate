import type { HumanSummary } from "@rollerskate/protocol";

export interface OidcIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly displayName: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface AuthorizationTransactionRecord {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly returnTo: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly consumedAt?: string;
}

export interface HumanRecord extends HumanSummary {
  readonly issuer: string;
  readonly subject: string;
  readonly status: "active" | "revoked";
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

export interface BffSessionRecord {
  readonly id: string;
  readonly humanId: string;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly revokedAt?: string;
}
