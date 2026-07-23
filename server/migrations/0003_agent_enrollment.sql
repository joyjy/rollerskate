ALTER TABLE agents
  ADD COLUMN operator_human_id VARCHAR(64) NULL AFTER owner_human_id;

UPDATE agents
SET operator_human_id = owner_human_id
WHERE operator_human_id IS NULL;

ALTER TABLE agents
  MODIFY COLUMN operator_human_id VARCHAR(64) NOT NULL,
  ADD CONSTRAINT agents_operator_fk
    FOREIGN KEY (operator_human_id) REFERENCES humans (id);

ALTER TABLE enrollment_grants
  ADD COLUMN credential_id VARCHAR(64) NULL AFTER placement_id;
