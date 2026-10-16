export const foundationSchemaSql = `
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_sessions (
      session_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      run_id TEXT REFERENCES agent_runs(run_id),
      cycle_id TEXT,
      adapter_id TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      workspace TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(adapter_id, provider_session_id)
    );
    CREATE INDEX IF NOT EXISTS agent_sessions_run_agent
      ON agent_sessions(run_id, agent_id)
      WHERE run_id IS NOT NULL AND cycle_id IS NULL;
    CREATE INDEX IF NOT EXISTS agent_sessions_run_cycle_agent
      ON agent_sessions(run_id, cycle_id, agent_id)
      WHERE cycle_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS local_foundation (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      device_id TEXT NOT NULL UNIQUE,
      device_name TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      topic_id TEXT NOT NULL UNIQUE,
      topic_handle TEXT NOT NULL UNIQUE CHECK(topic_handle = 'local'),
      owner_principal_id TEXT NOT NULL UNIQUE,
      owner_handle TEXT NOT NULL,
      owner_status TEXT NOT NULL CHECK(owner_status IN ('active', 'suspended')),
      owner_created_at TEXT NOT NULL,
      owner_updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agents (
      principal_id TEXT PRIMARY KEY,
      handle TEXT NOT NULL,
      handle_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('active', 'suspended')),
      agent_client TEXT NOT NULL
        CHECK(agent_client IN ('codex', 'claude-code', 'kimi-code', 'pi')),
      execution_config TEXT NOT NULL CHECK(json_valid(execution_config)),
      current_session_id TEXT REFERENCES agent_sessions(session_id),
      session_generation INTEGER NOT NULL DEFAULT 1 CHECK(session_generation >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS topic_governance (
      topic_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('active', 'paused')),
      participants_json TEXT NOT NULL CHECK(
        json_valid(participants_json) AND length(participants_json) <= 131072
      ),
      strategy_policy_json TEXT NOT NULL CHECK(
        json_valid(strategy_policy_json) AND length(strategy_policy_json) <= 16384
      ),
      conversation_policy_json TEXT NOT NULL CHECK(
        json_valid(conversation_policy_json) AND length(conversation_policy_json) <= 131072
      ),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS topic_governance_control_receipts (
      receipt_id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topic_governance(topic_id),
      action TEXT NOT NULL CHECK(action IN (
        'materialize_default', 'pause', 'resume', 'participant_add',
        'participant_remove', 'strategy_policy_update',
        'conversation_policy_update'
      )),
      previous_revision INTEGER CHECK(previous_revision >= 1),
      resulting_revision INTEGER NOT NULL CHECK(resulting_revision >= 1),
      receipt_json TEXT NOT NULL CHECK(
        json_valid(receipt_json) AND length(receipt_json) <= 16384
      ),
      created_at TEXT NOT NULL,
      UNIQUE(topic_id, resulting_revision),
      CHECK(
        (
          previous_revision IS NULL
          AND resulting_revision = 1
          AND action = 'materialize_default'
        )
        OR (
          previous_revision IS NOT NULL
          AND resulting_revision = previous_revision + 1
          AND action != 'materialize_default'
        )
      )
    );
    CREATE INDEX IF NOT EXISTS topic_governance_receipts_topic_revision
      ON topic_governance_control_receipts(topic_id, resulting_revision DESC);
    CREATE TABLE IF NOT EXISTS free_chat_modes (
      mode_id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topic_governance(topic_id),
      status TEXT NOT NULL CHECK(status IN ('active', 'exited', 'stopped', 'expired')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      state_json TEXT NOT NULL CHECK(
        json_valid(state_json) AND length(state_json) <= 131072
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS free_chat_modes_active_topic
      ON free_chat_modes(topic_id) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS free_chat_modes_topic_updated
      ON free_chat_modes(topic_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS free_chat_mode_receipts (
      receipt_id TEXT PRIMARY KEY,
      mode_id TEXT NOT NULL REFERENCES free_chat_modes(mode_id),
      topic_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence >= 1),
      action TEXT NOT NULL CHECK(action IN (
        'started', 'contribution_observed', 'roster_changed', 'activation_admitted',
        'cycle_silent', 'continued_now', 'exited', 'stopped'
      )),
      receipt_json TEXT NOT NULL CHECK(
        json_valid(receipt_json) AND length(receipt_json) <= 16384
      ),
      created_at TEXT NOT NULL,
      UNIQUE(mode_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS free_chat_mode_receipts_mode_sequence
      ON free_chat_mode_receipts(mode_id, sequence DESC);
    CREATE TABLE IF NOT EXISTS topic_activation_schedules (
      schedule_id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topic_governance(topic_id),
      status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'cancelled', 'completed')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      next_run_at TEXT,
      next_occurrence_key TEXT,
      state_json TEXT NOT NULL CHECK(json_valid(state_json) AND length(state_json) <= 131072),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK((status = 'active' AND next_run_at IS NOT NULL AND next_occurrence_key IS NOT NULL)
        OR status != 'active')
    );
    CREATE INDEX IF NOT EXISTS topic_activation_schedules_due
      ON topic_activation_schedules(status, next_run_at);
    CREATE INDEX IF NOT EXISTS topic_activation_schedules_topic
      ON topic_activation_schedules(topic_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS topic_activation_schedule_receipts (
      receipt_id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL REFERENCES topic_activation_schedules(schedule_id),
      topic_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence >= 1),
      action TEXT NOT NULL CHECK(action IN (
        'created', 'paused', 'resumed', 'cancelled', 'occurrence_admitted',
        'occurrence_skipped', 'occurrence_failed'
      )),
      occurrence_key TEXT,
      receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(receipt_json) <= 32768),
      created_at TEXT NOT NULL,
      UNIQUE(schedule_id, sequence),
      UNIQUE(schedule_id, occurrence_key)
    );
    CREATE TABLE IF NOT EXISTS interactive_channel_bindings (
      binding_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(principal_id),
      status TEXT NOT NULL CHECK(status IN ('active', 'revoked', 'expired')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      state_json TEXT NOT NULL CHECK(json_valid(state_json) AND length(state_json) <= 131072),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS interactive_channel_bindings_agent
      ON interactive_channel_bindings(agent_id, status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS channel_send_receipts (
      send_id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL REFERENCES interactive_channel_bindings(binding_id),
      idempotency_key TEXT NOT NULL,
      channel_kind TEXT NOT NULL CHECK(channel_kind IN ('local-chat', 'server-topic')),
      channel_id TEXT NOT NULL,
      receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(receipt_json) <= 131072),
      created_at TEXT NOT NULL,
      UNIQUE(binding_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS channel_follows (
      follow_token TEXT PRIMARY KEY,
      send_id TEXT NOT NULL UNIQUE REFERENCES channel_send_receipts(send_id),
      binding_id TEXT NOT NULL REFERENCES interactive_channel_bindings(binding_id),
      status TEXT NOT NULL CHECK(status IN (
        'waiting', 'active', 'quiet', 'terminal', 'failed', 'expired', 'stopped'
      )),
      state_json TEXT NOT NULL CHECK(json_valid(state_json) AND length(state_json) <= 131072),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS channel_follows_status_updated
      ON channel_follows(status, updated_at);
`;
