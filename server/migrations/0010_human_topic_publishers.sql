ALTER TABLE topic_events
  DROP FOREIGN KEY topic_events_agent_fk,
  DROP INDEX topic_events_publisher_transaction_unique,
  ADD COLUMN publisher_kind VARCHAR(16) NOT NULL DEFAULT 'agent'
    AFTER sequence_number,
  ADD COLUMN publisher_id VARCHAR(64) NULL AFTER publisher_kind,
  ADD COLUMN publisher_snapshot JSON NULL AFTER publisher_id,
  MODIFY COLUMN publisher_agent_id VARCHAR(64) NULL,
  MODIFY COLUMN agent_profile_revision BIGINT NULL;

UPDATE topic_events AS event
JOIN agents AS agent ON agent.id = event.publisher_agent_id
JOIN humans AS owner ON owner.id = agent.owner_human_id
JOIN placements AS placement ON placement.id = (
  SELECT candidate.id
  FROM placements AS candidate
  WHERE candidate.agent_id = agent.id
  ORDER BY candidate.generation DESC
  LIMIT 1
)
SET event.publisher_id = agent.id,
    event.publisher_snapshot = JSON_OBJECT(
      'kind', 'agent',
      'agentId', agent.id,
      'agentName', agent.name,
      'ownerHumanId', owner.id,
      'ownerDisplayName', owner.display_name,
      'deviceId', placement.device_id
    );

ALTER TABLE topic_events
  DROP COLUMN publisher_agent_id,
  MODIFY COLUMN publisher_kind VARCHAR(16) NOT NULL,
  MODIFY COLUMN publisher_id VARCHAR(64) NOT NULL,
  MODIFY COLUMN publisher_snapshot JSON NOT NULL,
  ADD CONSTRAINT topic_events_publisher_transaction_unique
    UNIQUE (publisher_kind, publisher_id, transaction_id),
  ADD CONSTRAINT topic_events_publisher_kind_known
    CHECK (publisher_kind IN ('human', 'agent')),
  ADD CONSTRAINT topic_events_profile_revision_matches_publisher
    CHECK (
      (publisher_kind = 'agent' AND agent_profile_revision IS NOT NULL) OR
      (publisher_kind = 'human' AND agent_profile_revision IS NULL)
    );
