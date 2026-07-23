CREATE TABLE IF NOT EXISTS humans (
  id VARCHAR(64) PRIMARY KEY,
  oauth_issuer VARCHAR(255) NOT NULL,
  oauth_subject VARCHAR(255) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  identity_metadata TEXT NULL,
  created_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP NULL,
  CONSTRAINT humans_oauth_identity_unique UNIQUE (oauth_issuer, oauth_subject)
);

CREATE TABLE IF NOT EXISTS devices (
  id VARCHAR(64) PRIMARY KEY,
  human_id VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP NULL,
  CONSTRAINT devices_human_fk FOREIGN KEY (human_id) REFERENCES humans (id)
);

CREATE TABLE IF NOT EXISTS agents (
  id VARCHAR(64) PRIMARY KEY,
  owner_human_id VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at TIMESTAMP NOT NULL,
  suspended_at TIMESTAMP NULL,
  CONSTRAINT agents_name_unique UNIQUE (name),
  CONSTRAINT agents_owner_fk FOREIGN KEY (owner_human_id) REFERENCES humans (id)
);

CREATE TABLE IF NOT EXISTS placements (
  id VARCHAR(64) PRIMARY KEY,
  agent_id VARCHAR(64) NOT NULL,
  device_id VARCHAR(64) NOT NULL,
  state VARCHAR(32) NOT NULL,
  generation INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL,
  activated_at TIMESTAMP NULL,
  superseded_at TIMESTAMP NULL,
  CONSTRAINT placements_agent_generation_unique UNIQUE (agent_id, generation),
  CONSTRAINT placements_agent_fk FOREIGN KEY (agent_id) REFERENCES agents (id),
  CONSTRAINT placements_device_fk FOREIGN KEY (device_id) REFERENCES devices (id)
);

CREATE TABLE IF NOT EXISTS rooms (
  id VARCHAR(255) PRIMARY KEY,
  visibility VARCHAR(32) NOT NULL,
  room_head VARCHAR(512) NULL,
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_room_bindings (
  id VARCHAR(64) PRIMARY KEY,
  agent_id VARCHAR(64) NOT NULL,
  room_id VARCHAR(255) NOT NULL,
  wake_mode VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at TIMESTAMP NOT NULL,
  deactivated_at TIMESTAMP NULL,
  CONSTRAINT bindings_agent_room_unique UNIQUE (agent_id, room_id),
  CONSTRAINT bindings_agent_fk FOREIGN KEY (agent_id) REFERENCES agents (id),
  CONSTRAINT bindings_room_fk FOREIGN KEY (room_id) REFERENCES rooms (id)
);

CREATE TABLE IF NOT EXISTS room_event_projections (
  event_id VARCHAR(255) PRIMARY KEY,
  room_id VARCHAR(255) NOT NULL,
  room_position VARCHAR(512) NOT NULL,
  event_type VARCHAR(255) NOT NULL,
  occurred_at TIMESTAMP NOT NULL,
  source_kind VARCHAR(32) NOT NULL,
  source_id VARCHAR(255) NOT NULL,
  payload TEXT NOT NULL,
  adapter_metadata TEXT NULL,
  retained_until TIMESTAMP NULL,
  CONSTRAINT room_events_position_unique UNIQUE (room_id, room_position),
  CONSTRAINT room_events_room_fk FOREIGN KEY (room_id) REFERENCES rooms (id)
);

CREATE TABLE IF NOT EXISTS pairing_transactions (
  id VARCHAR(64) PRIMARY KEY,
  device_id VARCHAR(64) NOT NULL,
  verifier_hash VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  approved_human_id VARCHAR(64) NULL,
  redeemed_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL,
  CONSTRAINT pairing_human_fk FOREIGN KEY (approved_human_id) REFERENCES humans (id)
);

CREATE TABLE IF NOT EXISTS enrollment_grants (
  id VARCHAR(64) PRIMARY KEY,
  agent_id VARCHAR(64) NOT NULL,
  device_id VARCHAR(64) NOT NULL,
  placement_id VARCHAR(64) NOT NULL,
  verifier_hash VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  redeemed_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL,
  CONSTRAINT enrollment_agent_fk FOREIGN KEY (agent_id) REFERENCES agents (id),
  CONSTRAINT enrollment_device_fk FOREIGN KEY (device_id) REFERENCES devices (id),
  CONSTRAINT enrollment_placement_fk FOREIGN KEY (placement_id) REFERENCES placements (id)
);

CREATE TABLE IF NOT EXISTS credential_metadata (
  id VARCHAR(64) PRIMARY KEY,
  principal_kind VARCHAR(32) NOT NULL,
  principal_id VARCHAR(64) NOT NULL,
  placement_id VARCHAR(64) NULL,
  secret_hash VARCHAR(255) NOT NULL,
  hash_algorithm VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at TIMESTAMP NOT NULL,
  expires_at TIMESTAMP NULL,
  rotated_from_credential_id VARCHAR(64) NULL,
  revoked_at TIMESTAMP NULL,
  CONSTRAINT credentials_rotation_fk FOREIGN KEY (rotated_from_credential_id) REFERENCES credential_metadata (id),
  CONSTRAINT credentials_placement_fk FOREIGN KEY (placement_id) REFERENCES placements (id)
);

CREATE TABLE IF NOT EXISTS attention_results (
  id VARCHAR(64) PRIMARY KEY,
  agent_id VARCHAR(64) NOT NULL,
  room_id VARCHAR(255) NOT NULL,
  binding_id VARCHAR(64) NOT NULL,
  through_position VARCHAR(512) NOT NULL,
  decision VARCHAR(32) NOT NULL,
  causal_chain_id VARCHAR(64) NOT NULL,
  causal_hop INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL,
  CONSTRAINT attention_agent_fk FOREIGN KEY (agent_id) REFERENCES agents (id),
  CONSTRAINT attention_room_fk FOREIGN KEY (room_id) REFERENCES rooms (id),
  CONSTRAINT attention_binding_fk FOREIGN KEY (binding_id) REFERENCES agent_room_bindings (id)
);
