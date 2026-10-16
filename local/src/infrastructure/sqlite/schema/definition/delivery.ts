export const deliverySchemaSql = `
    CREATE TABLE IF NOT EXISTS deliveries (
      delivery_id TEXT PRIMARY KEY,
      result_event_id TEXT REFERENCES events(event_id),
      origin_kind TEXT NOT NULL CHECK(origin_kind IN ('event', 'host')),
      origin_id TEXT NOT NULL,
      destination_id TEXT NOT NULL,
      destination_kind TEXT NOT NULL CHECK(destination_kind IN (
        'matrix', 'macos-notification', 'server-topic', 'vikunja-task', 'codex-desktop'
      )),
      destination_address_json TEXT NOT NULL CHECK(json_valid(destination_address_json)),
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      status TEXT NOT NULL CHECK(status IN (
        'pending', 'delivering', 'retry_wait', 'delivered', 'failed'
      )),
      attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
      max_attempts INTEGER NOT NULL CHECK(max_attempts >= 1),
      next_attempt_at TEXT NOT NULL,
      receipt TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(
        (origin_kind = 'event' AND result_event_id = origin_id) OR
        (origin_kind = 'host' AND result_event_id IS NULL)
      ),
      UNIQUE(origin_kind, origin_id, destination_id)
    );
    CREATE INDEX IF NOT EXISTS deliveries_due
      ON deliveries(status, next_attempt_at);
    CREATE TABLE IF NOT EXISTS chat_presence (
      agent_id TEXT NOT NULL,
      scope_kind TEXT NOT NULL CHECK(scope_kind IN ('topic', 'global')),
      scope_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('available', 'snoozed')),
      until_at TEXT,
      wake_keywords_json TEXT NOT NULL CHECK(json_valid(wake_keywords_json)),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      updated_by_dispatch_event_id TEXT REFERENCES events(event_id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(agent_id, scope_kind, scope_id),
      CHECK(
        (scope_kind = 'global' AND scope_id = '*')
        OR (scope_kind = 'topic' AND scope_id <> '*')
      ),
      CHECK(
        (mode = 'available' AND until_at IS NULL)
        OR (mode = 'snoozed' AND until_at IS NOT NULL)
      )
    );
`;
