import type {
  AuthorizationTransactionRecord,
  BffSessionRecord,
  HumanRecord,
  OidcIdentity
} from "./model.js";

export interface TrustRepository {
  putAuthorizationTransaction(record: AuthorizationTransactionRecord): Promise<void>;
  takeAuthorizationTransaction(
    state: string,
    now: string
  ): Promise<AuthorizationTransactionRecord | undefined>;
  admitHuman(identity: OidcIdentity, now: string): Promise<HumanRecord | undefined>;
  allowSubject(
    issuer: string,
    subject: string,
    createdByHumanId: string,
    now: string
  ): Promise<void>;
  getHuman(id: string): Promise<HumanRecord | undefined>;
  putSession(record: BffSessionRecord): Promise<void>;
  getSession(id: string, now: string): Promise<BffSessionRecord | undefined>;
}
