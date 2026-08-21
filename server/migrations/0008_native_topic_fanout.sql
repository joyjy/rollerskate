ALTER TABLE topics
  ADD COLUMN head_sequence BIGINT NOT NULL DEFAULT 0 AFTER owner_human_id;

CREATE TABLE IF NOT EXISTS topic_runtime_subscriptions (
  topic_id VARCHAR(64) NOT NULL,
  runtime_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  cursor_sequence BIGINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (topic_id, runtime_id),
  CONSTRAINT topic_runtime_subscriptions_topic_fk
    FOREIGN KEY (topic_id) REFERENCES topics (id) ON DELETE CASCADE,
  CONSTRAINT topic_runtime_subscriptions_runtime_fk
    FOREIGN KEY (runtime_id) REFERENCES devices (id),
  CONSTRAINT topic_runtime_subscriptions_status_known
    CHECK (status IN ('active', 'inactive'))
);

CREATE TABLE IF NOT EXISTS topic_events (
  event_id VARCHAR(64) PRIMARY KEY,
  topic_id VARCHAR(64) NOT NULL,
  sequence_number BIGINT NOT NULL,
  publisher_agent_id VARCHAR(64) NOT NULL,
  transaction_id VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  agent_profile_revision BIGINT NOT NULL,
  topic_profile_revision BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT topic_events_topic_sequence_unique UNIQUE (topic_id, sequence_number),
  CONSTRAINT topic_events_publisher_transaction_unique
    UNIQUE (publisher_agent_id, transaction_id),
  CONSTRAINT topic_events_topic_fk FOREIGN KEY (topic_id) REFERENCES topics (id),
  CONSTRAINT topic_events_agent_fk FOREIGN KEY (publisher_agent_id) REFERENCES agents (id)
);
