ALTER TABLE agents
  DROP INDEX agents_name_unique,
  ADD CONSTRAINT agents_owner_name_unique UNIQUE (owner_human_id, name);
