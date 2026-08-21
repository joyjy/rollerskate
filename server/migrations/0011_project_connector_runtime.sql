CREATE TABLE IF NOT EXISTS integration_bindings (
  binding_id VARCHAR(64) PRIMARY KEY,
  owner_human_id VARCHAR(64) NOT NULL,
  connector_id VARCHAR(255) NOT NULL,
  connector_version VARCHAR(255) NOT NULL,
  placement VARCHAR(16) NOT NULL,
  endpoint_ref VARCHAR(2048) NOT NULL,
  profile_ids JSON NOT NULL,
  external_scope_ref VARCHAR(1024) NOT NULL,
  credential_ref VARCHAR(1024) NOT NULL,
  cursor_value VARCHAR(1024) NULL,
  status VARCHAR(16) NOT NULL,
  revision BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT integration_bindings_owner_fk
    FOREIGN KEY (owner_human_id) REFERENCES humans (id),
  CONSTRAINT integration_bindings_placement_known
    CHECK (placement IN ('server', 'runtime')),
  CONSTRAINT integration_bindings_status_known
    CHECK (status IN ('active', 'suspended', 'revoked')),
  CONSTRAINT integration_bindings_revision_positive CHECK (revision > 0)
);

CREATE INDEX integration_bindings_owner_status_updated
  ON integration_bindings (owner_human_id, status, updated_at);

CREATE TABLE IF NOT EXISTS project_bindings (
  binding_id VARCHAR(64) PRIMARY KEY,
  owner_human_id VARCHAR(64) NOT NULL,
  workflow_ref VARCHAR(255) NOT NULL,
  integration_binding_id VARCHAR(64) NOT NULL,
  topic_id VARCHAR(64) NULL,
  participant_agent_ids JSON NOT NULL,
  policy_json JSON NOT NULL,
  policy_revision BIGINT NOT NULL,
  status VARCHAR(16) NOT NULL,
  revision BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT project_bindings_owner_fk
    FOREIGN KEY (owner_human_id) REFERENCES humans (id),
  CONSTRAINT project_bindings_integration_fk
    FOREIGN KEY (integration_binding_id) REFERENCES integration_bindings (binding_id),
  CONSTRAINT project_bindings_topic_fk
    FOREIGN KEY (topic_id) REFERENCES topics (id),
  CONSTRAINT project_bindings_workflow_known CHECK (workflow_ref = 'forum@1'),
  CONSTRAINT project_bindings_status_known
    CHECK (status IN ('active', 'suspended', 'revoked')),
  CONSTRAINT project_bindings_policy_revision_positive CHECK (policy_revision > 0),
  CONSTRAINT project_bindings_revision_positive CHECK (revision > 0)
);

CREATE INDEX project_bindings_owner_status_updated
  ON project_bindings (owner_human_id, status, updated_at);

CREATE TABLE IF NOT EXISTS external_effects (
  effect_id VARCHAR(64) PRIMARY KEY,
  project_binding_id VARCHAR(64) NOT NULL,
  integration_binding_id VARCHAR(64) NOT NULL,
  run_id VARCHAR(255) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_digest VARCHAR(71) NOT NULL,
  request_json JSON NOT NULL,
  status VARCHAR(16) NOT NULL,
  receipt_json JSON NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT external_effects_project_fk
    FOREIGN KEY (project_binding_id) REFERENCES project_bindings (binding_id),
  CONSTRAINT external_effects_integration_fk
    FOREIGN KEY (integration_binding_id) REFERENCES integration_bindings (binding_id),
  CONSTRAINT external_effects_idempotency_unique
    UNIQUE (integration_binding_id, idempotency_key),
  CONSTRAINT external_effects_status_known
    CHECK (status IN ('pending', 'applied', 'conflict', 'rejected', 'failed', 'unknown'))
);

CREATE INDEX external_effects_project_run
  ON external_effects (project_binding_id, run_id, created_at);
