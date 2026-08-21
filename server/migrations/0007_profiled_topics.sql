CREATE TABLE IF NOT EXISTS agent_public_profiles (
  agent_id VARCHAR(64) PRIMARY KEY,
  display_name VARCHAR(128) NOT NULL,
  role_text VARCHAR(512) NOT NULL,
  disclosure TEXT NOT NULL,
  expression_rules JSON NOT NULL,
  revision BIGINT NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT agent_public_profiles_agent_fk
    FOREIGN KEY (agent_id) REFERENCES agents (id),
  CONSTRAINT agent_public_profiles_revision_positive CHECK (revision > 0)
);

CREATE TABLE IF NOT EXISTS topics (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  visibility VARCHAR(32) NOT NULL,
  owner_human_id VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT topics_owner_fk FOREIGN KEY (owner_human_id) REFERENCES humans (id),
  CONSTRAINT topics_visibility_known CHECK (visibility IN ('public', 'private'))
);

CREATE TABLE IF NOT EXISTS topic_profiles (
  topic_id VARCHAR(64) PRIMARY KEY,
  purpose TEXT NOT NULL,
  participation_rules JSON NOT NULL,
  expression_rules JSON NOT NULL,
  revision BIGINT NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT topic_profiles_topic_fk
    FOREIGN KEY (topic_id) REFERENCES topics (id) ON DELETE CASCADE,
  CONSTRAINT topic_profiles_revision_positive CHECK (revision > 0)
);

CREATE TABLE IF NOT EXISTS topic_human_roles (
  topic_id VARCHAR(64) NOT NULL,
  human_id VARCHAR(64) NOT NULL,
  role_name VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (topic_id, human_id),
  CONSTRAINT topic_human_roles_topic_fk
    FOREIGN KEY (topic_id) REFERENCES topics (id) ON DELETE CASCADE,
  CONSTRAINT topic_human_roles_human_fk FOREIGN KEY (human_id) REFERENCES humans (id),
  CONSTRAINT topic_human_roles_role_known CHECK (role_name IN ('owner', 'admin')),
  CONSTRAINT topic_human_roles_status_known CHECK (status IN ('active', 'revoked'))
);

CREATE TABLE IF NOT EXISTS topic_agent_memberships (
  topic_id VARCHAR(64) NOT NULL,
  agent_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  joined_by_human_id VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (topic_id, agent_id),
  CONSTRAINT topic_agent_memberships_topic_fk
    FOREIGN KEY (topic_id) REFERENCES topics (id) ON DELETE CASCADE,
  CONSTRAINT topic_agent_memberships_agent_fk FOREIGN KEY (agent_id) REFERENCES agents (id),
  CONSTRAINT topic_agent_memberships_joiner_fk
    FOREIGN KEY (joined_by_human_id) REFERENCES humans (id),
  CONSTRAINT topic_agent_memberships_status_known CHECK (status IN ('active', 'left'))
);
