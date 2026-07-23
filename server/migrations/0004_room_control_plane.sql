ALTER TABLE rooms
  ADD COLUMN name VARCHAR(255) NULL AFTER id,
  ADD COLUMN matrix_room_id VARCHAR(255) NULL AFTER name,
  ADD COLUMN created_by_human_id VARCHAR(64) NULL AFTER visibility,
  ADD COLUMN head_sequence BIGINT NOT NULL DEFAULT 0 AFTER room_head;

UPDATE rooms SET name = id WHERE name IS NULL;
UPDATE rooms SET matrix_room_id = id WHERE matrix_room_id IS NULL;

ALTER TABLE rooms
  MODIFY COLUMN name VARCHAR(255) NOT NULL,
  MODIFY COLUMN matrix_room_id VARCHAR(255) NOT NULL,
  ADD CONSTRAINT rooms_matrix_room_unique UNIQUE (matrix_room_id),
  ADD CONSTRAINT rooms_creator_fk
    FOREIGN KEY (created_by_human_id) REFERENCES humans (id);

ALTER TABLE agent_room_bindings
  ADD COLUMN created_by_human_id VARCHAR(64) NULL AFTER wake_mode,
  ADD COLUMN updated_at TIMESTAMP NULL AFTER created_at,
  ADD CONSTRAINT bindings_creator_fk
    FOREIGN KEY (created_by_human_id) REFERENCES humans (id);

ALTER TABLE room_event_projections
  ADD COLUMN room_sequence BIGINT NULL AFTER room_position,
  ADD COLUMN matrix_event_id VARCHAR(255) NULL AFTER event_id,
  ADD COLUMN event_json LONGTEXT NULL AFTER adapter_metadata,
  ADD CONSTRAINT room_events_sequence_unique UNIQUE (room_id, room_sequence),
  ADD CONSTRAINT room_events_matrix_event_unique UNIQUE (matrix_event_id);

CREATE TABLE IF NOT EXISTS room_human_memberships (
  room_id VARCHAR(255) NOT NULL,
  human_id VARCHAR(64) NOT NULL,
  role VARCHAR(32) NOT NULL,
  can_invite BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(32) NOT NULL,
  invited_by_human_id VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL,
  left_at TIMESTAMP NULL,
  PRIMARY KEY (room_id, human_id),
  CONSTRAINT room_memberships_room_fk FOREIGN KEY (room_id) REFERENCES rooms (id),
  CONSTRAINT room_memberships_human_fk FOREIGN KEY (human_id) REFERENCES humans (id),
  CONSTRAINT room_memberships_inviter_fk
    FOREIGN KEY (invited_by_human_id) REFERENCES humans (id)
);

CREATE TABLE IF NOT EXISTS matrix_principals (
  principal_kind VARCHAR(32) NOT NULL,
  principal_id VARCHAR(64) NOT NULL,
  mxid VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL,
  PRIMARY KEY (principal_kind, principal_id),
  CONSTRAINT matrix_principals_mxid_unique UNIQUE (mxid)
);

CREATE TABLE IF NOT EXISTS matrix_transactions (
  transaction_id VARCHAR(255) PRIMARY KEY,
  completed_at TIMESTAMP NOT NULL
);
