CREATE TABLE IF NOT EXISTS agent_work_requests (
  work_request_id VARCHAR(64) PRIMARY KEY,
  requester_kind VARCHAR(16) NOT NULL,
  requester_id VARCHAR(64) NOT NULL,
  request_id VARCHAR(256) NOT NULL,
  target_agent_id VARCHAR(64) NOT NULL,
  target_route_id VARCHAR(64) NULL,
  status VARCHAR(32) NOT NULL,
  revision BIGINT NOT NULL,
  request_digest VARCHAR(71) NOT NULL,
  value_json JSON NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT agent_work_requests_target_fk
    FOREIGN KEY (target_agent_id) REFERENCES agents (id),
  CONSTRAINT agent_work_requests_idempotency_unique
    UNIQUE (requester_kind, requester_id, request_id),
  CONSTRAINT agent_work_requests_requester_kind_known
    CHECK (requester_kind IN ('human', 'agent')),
  CONSTRAINT agent_work_requests_status_known
    CHECK (status IN (
      'received', 'awaiting-owner', 'accepted', 'rejected', 'withdrawn',
      'expired', 'target-unavailable', 'completed'
    )),
  CONSTRAINT agent_work_requests_revision_positive CHECK (revision > 0)
);

CREATE INDEX agent_work_requests_requester_pending
  ON agent_work_requests (requester_kind, requester_id, status, expires_at, created_at);

CREATE INDEX agent_work_requests_target_route
  ON agent_work_requests (target_agent_id, target_route_id, status, created_at);
