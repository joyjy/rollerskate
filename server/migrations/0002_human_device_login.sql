ALTER TABLE pairing_transactions
  ADD COLUMN device_name VARCHAR(255) NOT NULL AFTER device_id;

CREATE TABLE IF NOT EXISTS admission_allowlist (
  issuer VARCHAR(255) NOT NULL,
  oauth_subject VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_by_human_id VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP NULL,
  PRIMARY KEY (issuer, oauth_subject),
  CONSTRAINT allowlist_creator_fk FOREIGN KEY (created_by_human_id) REFERENCES humans (id)
);

CREATE TABLE IF NOT EXISTS oidc_authorization_transactions (
  state VARCHAR(128) PRIMARY KEY,
  nonce VARCHAR(128) NOT NULL,
  code_verifier VARCHAR(128) NOT NULL,
  return_to VARCHAR(512) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS bff_sessions (
  id VARCHAR(64) PRIMARY KEY,
  human_id VARCHAR(64) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL,
  CONSTRAINT bff_sessions_human_fk FOREIGN KEY (human_id) REFERENCES humans (id)
);
