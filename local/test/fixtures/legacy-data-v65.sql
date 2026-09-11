-- Frozen schema 65: 060e7121ca493d2ead461d5137cdd8fa392b20e5, local/src/infrastructure/sqlite/schema/definition.ts
-- Public distribution client allowlist applied to historical table definitions; never derive this fixture from the current schema.
CREATE TABLE schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
CREATE TABLE local_foundation (
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
CREATE TABLE agents (
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
CREATE TABLE agent_runs (
      run_id TEXT PRIMARY KEY,
      root_event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
      owner_request_id TEXT NOT NULL UNIQUE,
      owner_principal_id TEXT NOT NULL,
      steward_agent_id TEXT NOT NULL REFERENCES agents(principal_id),
      series_key TEXT UNIQUE,
      active_cycle_id TEXT,
      mandate_snapshot_json TEXT NOT NULL CHECK(
        json_valid(mandate_snapshot_json)
        AND length(mandate_snapshot_json) <= 65536
      ),
      workspace_grant_json TEXT CHECK(
        workspace_grant_json IS NULL OR (
          json_valid(workspace_grant_json)
          AND length(workspace_grant_json) <= 16384
        )
      ),
      orchestration_mode TEXT NOT NULL DEFAULT 'autonomous'
        CHECK(orchestration_mode IN ('autonomous', 'caller')),
      orchestrator_binding_json TEXT CHECK(
        orchestrator_binding_json IS NULL OR (
          json_valid(orchestrator_binding_json)
          AND length(orchestrator_binding_json) <= 16384
        )
      ),
      status TEXT NOT NULL CHECK(status IN (
        'active', 'waiting', 'awaiting_orchestrator',
        'awaiting_source', 'succeeded', 'failed', 'needs_human', 'cancelled'
      )),
      active_step_id TEXT,
      active_execution_id TEXT REFERENCES executions(execution_id),
      step_count INTEGER NOT NULL CHECK(step_count >= 0),
      max_steps INTEGER NOT NULL CHECK(max_steps BETWEEN 1 AND 1000),
      max_depth INTEGER NOT NULL CHECK(max_depth BETWEEN 0 AND 100),
      deadline_at TEXT,
      checkpoint_json TEXT CHECK(
        checkpoint_json IS NULL OR (
          json_valid(checkpoint_json)
          AND length(checkpoint_json) <= 65536
        )
      ),
      terminal_summary TEXT,
      cancelled_at TEXT,
      archived_at TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(
        (orchestration_mode = 'autonomous' AND orchestrator_binding_json IS NULL)
        OR
        (orchestration_mode = 'caller' AND orchestrator_binding_json IS NOT NULL)
      ),
      CHECK(
        (series_key IS NULL AND active_cycle_id IS NULL)
        OR series_key IS NOT NULL
      ),
      CHECK(
        (
          status IN ('active', 'waiting')
          AND active_step_id IS NOT NULL
          AND active_execution_id IS NOT NULL
          AND checkpoint_json IS NULL
          AND terminal_summary IS NULL
          AND cancelled_at IS NULL
        )
        OR
        (
          status = 'awaiting_source'
          AND series_key IS NOT NULL
          AND active_cycle_id IS NULL
          AND active_step_id IS NULL
          AND active_execution_id IS NULL
          AND checkpoint_json IS NULL
          AND terminal_summary IS NULL
          AND cancelled_at IS NULL
        )
        OR
        (
          status = 'awaiting_orchestrator'
          AND orchestration_mode = 'caller'
          AND active_step_id IS NOT NULL
          AND active_execution_id IS NULL
          AND (checkpoint_json IS NOT NULL OR step_count = 0)
          AND terminal_summary IS NULL
          AND cancelled_at IS NULL
        )
        OR
        (
          status IN ('succeeded', 'failed', 'needs_human')
          AND active_step_id IS NULL
          AND active_execution_id IS NULL
          AND checkpoint_json IS NULL
          AND terminal_summary IS NOT NULL
          AND cancelled_at IS NULL
        )
        OR
        (
          status = 'cancelled'
          AND active_step_id IS NULL
          AND active_execution_id IS NULL
          AND checkpoint_json IS NULL
          AND terminal_summary IS NOT NULL
          AND cancelled_at IS NOT NULL
        )
      )
    );
CREATE TABLE agent_run_cycles (
      cycle_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
      request_id TEXT NOT NULL UNIQUE,
      source_revision TEXT NOT NULL,
      mandate_snapshot_json TEXT NOT NULL CHECK(
        json_valid(mandate_snapshot_json)
        AND length(mandate_snapshot_json) <= 65536
      ),
      workspace_grant_json TEXT CHECK(
        workspace_grant_json IS NULL OR (
          json_valid(workspace_grant_json)
          AND length(workspace_grant_json) <= 16384
        )
      ),
      status TEXT NOT NULL CHECK(status IN (
        'active', 'succeeded', 'failed', 'needs_human', 'superseded', 'cancelled'
      )),
      step_count INTEGER NOT NULL CHECK(step_count >= 0),
      terminal_summary TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(run_id, source_revision),
      CHECK(
        (status = 'active' AND terminal_summary IS NULL AND completed_at IS NULL)
        OR
        (status != 'active' AND terminal_summary IS NOT NULL AND completed_at IS NOT NULL)
      )
    );
CREATE TABLE agent_sessions (
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
CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN (
        'agent.request', 'subscription.fire', 'agent.result',
        'chat.activation', 'chat.message', 'chat.dispatch'
      )),
      source_kind TEXT NOT NULL CHECK(source_kind IN (
        'cli', 'subscription', 'schedule', 'matrix', 'server', 'handler'
      )),
      source_external_id TEXT,
      agent_id TEXT,
      prompt TEXT,
      outcome TEXT CHECK(outcome IN ('succeeded', 'failed')),
      output TEXT,
      error TEXT,
      payload_json TEXT,
      session_id TEXT REFERENCES agent_sessions(session_id),
      destination_ids_json TEXT NOT NULL CHECK(json_valid(destination_ids_json)),
      destination_snapshots_json TEXT NOT NULL CHECK(
        json_valid(destination_snapshots_json)
        AND length(destination_snapshots_json) <= 65536
      ),
      root_event_id TEXT NOT NULL,
      parent_event_id TEXT,
      causal_hop INTEGER NOT NULL CHECK(causal_hop >= 0),
      created_at TEXT NOT NULL,
      CHECK(
        (type = 'agent.request' AND agent_id IS NOT NULL
          AND prompt IS NOT NULL AND outcome IS NULL AND output IS NULL
          AND error IS NULL AND (payload_json IS NULL OR json_valid(payload_json)))
        OR
        (type = 'subscription.fire' AND agent_id IS NOT NULL
          AND prompt IS NOT NULL AND outcome IS NULL AND output IS NULL
          AND error IS NULL AND (payload_json IS NULL OR json_valid(payload_json)))
        OR
        (type = 'agent.result' AND agent_id IS NOT NULL AND prompt IS NULL
          AND outcome IS NOT NULL
          AND (payload_json IS NULL OR json_valid(payload_json))
          AND ((outcome = 'succeeded' AND output IS NOT NULL AND error IS NULL)
            OR (outcome = 'failed' AND output IS NULL AND error IS NOT NULL)))
        OR
        (type = 'chat.message' AND prompt IS NULL AND outcome IS NULL
          AND output IS NULL AND error IS NULL AND payload_json IS NOT NULL
          AND json_valid(payload_json))
        OR
        (type = 'chat.activation' AND agent_id IS NULL AND prompt IS NULL
          AND outcome IS NULL AND output IS NULL AND error IS NULL
          AND payload_json IS NOT NULL AND json_valid(payload_json))
        OR
        (type = 'chat.dispatch' AND agent_id IS NOT NULL AND prompt IS NOT NULL
          AND outcome IS NULL AND output IS NULL AND error IS NULL
          AND payload_json IS NOT NULL AND json_valid(payload_json))
      ),
      UNIQUE(source_kind, source_external_id)
    );
CREATE TABLE schedules (
      schedule_id TEXT PRIMARY KEY,
      owner_principal_id TEXT NOT NULL REFERENCES agents(principal_id),
      status TEXT NOT NULL CHECK(status IN (
        'active', 'paused', 'completed', 'cancelled'
      )),
      current_revision INTEGER NOT NULL CHECK(current_revision >= 1),
      next_run_at TEXT,
      next_occurrence_key TEXT,
      next_occurrence_missing INTEGER NOT NULL DEFAULT 0
        CHECK(next_occurrence_missing IN (0, 1)),
      agent_id TEXT NOT NULL REFERENCES agents(principal_id),
      kind TEXT NOT NULL CHECK(kind IN ('once', 'cron')),
      expression TEXT NOT NULL,
      expression_version TEXT NOT NULL CHECK(
        expression_version IN ('once-rfc3339-v1', 'cron-v1')
      ),
      timezone TEXT,
      misfire_policy TEXT NOT NULL CHECK(misfire_policy IN ('skip', 'run_once')),
      overlap_policy TEXT NOT NULL CHECK(overlap_policy IN ('skip', 'queue')),
      misfire_grace_ms INTEGER NOT NULL CHECK(
        misfire_grace_ms BETWEEN 0 AND 604800000
      ),
      session_policy TEXT NOT NULL CHECK(session_policy IN ('new_each_run', 'fixed')),
      fixed_session_id TEXT REFERENCES agent_sessions(session_id),
      prompt TEXT NOT NULL,
      workspace TEXT NOT NULL,
      external_ref_binding_json TEXT CHECK(
        external_ref_binding_json IS NULL OR (
          json_valid(external_ref_binding_json) AND length(external_ref_binding_json) <= 16384
        )
      ),
      revision_created_at TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(
        (next_run_at IS NULL AND next_occurrence_key IS NULL)
        OR (next_run_at IS NOT NULL AND next_occurrence_key IS NOT NULL)
      ),
      CHECK(
        (kind = 'once' AND expression_version = 'once-rfc3339-v1' AND timezone IS NULL)
        OR (kind = 'cron' AND expression_version = 'cron-v1' AND timezone IS NOT NULL)
      ),
      CHECK(
        (session_policy = 'new_each_run' AND fixed_session_id IS NULL)
        OR (session_policy = 'fixed' AND fixed_session_id IS NOT NULL)
      )
    );
CREATE TABLE scheduled_runs (
      run_id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      schedule_revision INTEGER NOT NULL,
      definition_snapshot_json TEXT NOT NULL CHECK(
        json_valid(definition_snapshot_json)
        AND length(definition_snapshot_json) <= 131072
      ),
      coalesced_through TEXT,
      admitted_at TEXT,
      status TEXT NOT NULL CHECK(status IN (
        'queued', 'running', 'succeeded', 'failed', 'skipped', 'unknown'
      )),
      event_id TEXT UNIQUE REFERENCES events(event_id),
      execution_id TEXT UNIQUE REFERENCES executions(execution_id),
      session_id TEXT REFERENCES agent_sessions(session_id),
      decision_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(schedule_id, occurrence_key)
    );
CREATE TABLE subscriptions (
      subscription_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      owner_agent_id TEXT NOT NULL REFERENCES agents(principal_id),
      plugin_path TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      plugin_schema_version INTEGER NOT NULL CHECK(plugin_schema_version = 1),
      plugin_config_json TEXT NOT NULL CHECK(json_valid(plugin_config_json)),
      policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
      interval_ms INTEGER NOT NULL,
      max_wait_ms INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      definition_schema TEXT NOT NULL CHECK(
        definition_schema = 'SubscriptionDefinition@3'
      ),
      definition_revision TEXT NOT NULL,
      definition_digest TEXT NOT NULL,
      callback_phase_status TEXT NOT NULL CHECK(callback_phase_status IN (
        'pending', 'running', 'completed', 'completed_with_errors',
        'completed_with_unknown', 'blocked'
      )),
      terminal_key TEXT,
      terminal_observation_json TEXT CHECK(
        terminal_observation_json IS NULL OR json_valid(terminal_observation_json)
      ),
      status TEXT NOT NULL CHECK(status IN (
        'active', 'paused', 'completed', 'blocked', 'cancelled', 'expired'
      )),
      started_at TEXT NOT NULL,
      deadline_at TEXT NOT NULL,
      next_poll_at TEXT NOT NULL,
      latest_error TEXT,
      external_ref_binding_json TEXT CHECK(
        external_ref_binding_json IS NULL OR (
          json_valid(external_ref_binding_json) AND length(external_ref_binding_json) <= 16384
        )
      ),
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
CREATE TABLE continuous_subscriptions (
      subscription_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      owner_agent_id TEXT NOT NULL REFERENCES agents(principal_id),
      current_revision INTEGER NOT NULL CHECK(current_revision >= 1),
      plugin_path TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      plugin_config_json TEXT NOT NULL CHECK(
        json_valid(plugin_config_json) AND length(plugin_config_json) <= 65536
      ),
      policy_json TEXT NOT NULL CHECK(
        json_valid(policy_json) AND length(policy_json) <= 65536
      ),
      interval_ms INTEGER NOT NULL CHECK(interval_ms >= 100),
      poll_count INTEGER NOT NULL DEFAULT 0 CHECK(poll_count >= 0),
      status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'blocked', 'cancelled')),
      next_poll_at TEXT NOT NULL,
      checkpoint_occurrence_key TEXT,
      checkpoint_observation_json TEXT CHECK(
        checkpoint_observation_json IS NULL OR (
          json_valid(checkpoint_observation_json) AND
          length(checkpoint_observation_json) <= 65536
        )
      ),
      pending_occurrence_key TEXT,
      pending_observation_json TEXT CHECK(
        pending_observation_json IS NULL OR (
          json_valid(pending_observation_json) AND
          length(pending_observation_json) <= 65536
        )
      ),
      latest_error TEXT,
      external_ref_binding_json TEXT CHECK(
        external_ref_binding_json IS NULL OR (
          json_valid(external_ref_binding_json) AND length(external_ref_binding_json) <= 16384
        )
      ),
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(
        (pending_occurrence_key IS NULL AND pending_observation_json IS NULL)
        OR (pending_occurrence_key IS NOT NULL AND pending_observation_json IS NOT NULL)
      )
    );
CREATE TABLE executions (
      execution_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
      handler TEXT NOT NULL CHECK(handler IN (
        'agent', 'result', 'chat'
      )),
      status TEXT NOT NULL CHECK(status IN (
        'queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled'
      )),
      attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
      max_attempts INTEGER NOT NULL CHECK(max_attempts >= 1),
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      receipt_json TEXT CHECK(receipt_json IS NULL OR (
        json_valid(receipt_json) AND length(receipt_json) <= 65536
      )),
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );
