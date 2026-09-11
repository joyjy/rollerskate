import type { DatabaseSync } from "node:sqlite";

export function createSchema(database: DatabaseSync): void {
  database.exec(`
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
    CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_run_agent
      ON agent_sessions(run_id, agent_id)
      WHERE run_id IS NOT NULL AND cycle_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_run_cycle_agent
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
    CREATE TABLE IF NOT EXISTS events (
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
    CREATE INDEX IF NOT EXISTS events_causal
      ON events(root_event_id, causal_hop, created_at);
    CREATE INDEX IF NOT EXISTS events_chat_topic_cursor
      ON events(
        json_extract(payload_json, '$.topicId'),
        created_at DESC,
        event_id DESC
      )
      WHERE type = 'chat.message';
    CREATE TABLE IF NOT EXISTS executions (
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
    CREATE INDEX IF NOT EXISTS executions_due
      ON executions(status, next_attempt_at);
    CREATE TABLE IF NOT EXISTS agent_runs (
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
      source_binding_json TEXT CHECK(
        source_binding_json IS NULL OR (
          json_valid(source_binding_json)
          AND length(source_binding_json) <= 16384
          AND series_key IS NOT NULL
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
    CREATE INDEX IF NOT EXISTS agent_runs_status_updated
      ON agent_runs(status, updated_at DESC, run_id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_active_write_workspace
      ON agent_runs(json_extract(workspace_grant_json, '$.root'))
      WHERE status IN ('active', 'waiting', 'awaiting_orchestrator')
        AND json_extract(workspace_grant_json, '$.access') = 'write';
    CREATE TABLE IF NOT EXISTS agent_run_cycles (
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
      source_envelope_json TEXT CHECK(
        source_envelope_json IS NULL OR (
          json_valid(source_envelope_json)
          AND length(source_envelope_json) <= 65536
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
    CREATE INDEX IF NOT EXISTS agent_run_cycles_run_created
      ON agent_run_cycles(run_id, created_at DESC, cycle_id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS agent_run_cycles_run_occurrence
      ON agent_run_cycles(
        run_id,
        json_extract(source_envelope_json, '$.occurrenceKey')
      )
      WHERE source_envelope_json IS NOT NULL;
    CREATE TABLE IF NOT EXISTS agent_run_decisions (
      run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
      request_id TEXT NOT NULL,
      expected_run_version INTEGER NOT NULL CHECK(expected_run_version >= 1),
      resulting_run_version INTEGER NOT NULL CHECK(resulting_run_version >= 2),
      decision_json TEXT NOT NULL CHECK(
        json_valid(decision_json) AND length(decision_json) <= 65536
      ),
      receipt_json TEXT NOT NULL CHECK(
        json_valid(receipt_json) AND length(receipt_json) <= 65536
      ),
      accepted_at TEXT NOT NULL,
      PRIMARY KEY(run_id, request_id),
      UNIQUE(run_id, resulting_run_version)
    );
    CREATE INDEX IF NOT EXISTS agent_run_decisions_run_version
      ON agent_run_decisions(run_id, resulting_run_version DESC);
    CREATE TABLE IF NOT EXISTS legacy_trigger_migration_receipts (
      source_kind TEXT NOT NULL CHECK(source_kind IN (
        'schedule', 'subscription', 'continuous_subscription'
      )),
      source_id TEXT NOT NULL,
      definition_revision TEXT NOT NULL,
      proposal_digest TEXT NOT NULL CHECK(
        proposal_digest GLOB 'sha256:[0-9a-f]*' AND length(proposal_digest) = 71
      ),
      migration_request_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(run_id),
      admission_digest TEXT NOT NULL CHECK(
        admission_digest GLOB 'sha256:[0-9a-f]*' AND length(admission_digest) = 71
      ),
      old_definition_status TEXT NOT NULL CHECK(
        old_definition_status IN ('active', 'paused')
      ),
      applied_at TEXT NOT NULL,
      PRIMARY KEY(source_kind, source_id, definition_revision)
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      event_id TEXT PRIMARY KEY REFERENCES events(event_id),
      topic_id TEXT NOT NULL,
      sender_kind TEXT NOT NULL CHECK(sender_kind IN ('owner', 'agent', 'system')),
      sender_principal_id TEXT,
      sender_handle_snapshot TEXT NOT NULL,
      body TEXT NOT NULL,
      target_principal_id TEXT,
      target_handle_snapshot TEXT,
      created_at TEXT NOT NULL,
      attention_json TEXT CHECK(
        attention_json IS NULL OR (
          json_valid(attention_json) AND length(attention_json) <= 65536
        )
      ),
      read_progress_json TEXT CHECK(
        read_progress_json IS NULL OR (
          json_valid(read_progress_json) AND length(read_progress_json) <= 65536
        )
      ),
      projected_at TEXT NOT NULL,
      CHECK(
        (target_principal_id IS NULL AND target_handle_snapshot IS NULL)
        OR (target_principal_id IS NOT NULL AND target_handle_snapshot IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS chat_messages_topic_cursor
      ON chat_messages(topic_id, created_at DESC, event_id DESC);
    CREATE TRIGGER IF NOT EXISTS chat_message_project_event_insert
    AFTER INSERT ON events
    WHEN NEW.type = 'chat.message'
    BEGIN
      INSERT INTO chat_messages (
        event_id, topic_id, sender_kind, sender_principal_id,
        sender_handle_snapshot, body, target_principal_id,
        target_handle_snapshot, created_at, projected_at
      ) VALUES (
        NEW.event_id,
        json_extract(NEW.payload_json, '$.topicId'),
        json_extract(NEW.payload_json, '$.sender.kind'),
        json_extract(NEW.payload_json, '$.sender.principalId'),
        json_extract(NEW.payload_json, '$.sender.handleSnapshot'),
        json_extract(NEW.payload_json, '$.body'),
        json_extract(NEW.payload_json, '$.target.principalId'),
        json_extract(NEW.payload_json, '$.target.handleSnapshot'),
        NEW.created_at,
        NEW.created_at
      )
      ON CONFLICT(event_id) DO NOTHING;
    END;
    CREATE VIEW IF NOT EXISTS chat_message_read_progress_v1 AS
    SELECT
      state.event_id,
      json_object(
        'schema', 'ChatReadProgress@1',
        'total', COUNT(*),
        'read', COALESCE(SUM(CASE WHEN state.read_state = 'read' THEN 1 ELSE 0 END), 0),
        'agents', json_group_array(json_object(
          'agentId', state.agent_id,
          'handleSnapshot', state.handle_snapshot,
          'state', state.read_state,
          'reason', state.reason,
          'failureReason', state.failure_reason
        ))
      ) AS progress_json
    FROM (
      SELECT
        message.event_id,
        CAST(receipt.key AS INTEGER) AS receipt_index,
        json_extract(receipt.value, '$.agentId') AS agent_id,
        COALESCE(
          json_extract(receipt.value, '$.handleSnapshot'),
          agent.handle,
          json_extract(receipt.value, '$.agentId')
        ) AS handle_snapshot,
        json_extract(receipt.value, '$.reason') AS reason,
        CASE
          WHEN dispatch_execution.status IN ('failed', 'cancelled')
          THEN dispatch_execution.last_error
          ELSE NULL
        END AS failure_reason,
        CASE
          WHEN json_extract(receipt.value, '$.outcome') = 'skipped' THEN 'unread'
          WHEN dispatch_execution.status = 'succeeded' THEN 'read'
          WHEN dispatch_execution.status = 'failed' THEN 'failed'
          WHEN dispatch_execution.status = 'cancelled' THEN 'unread'
          ELSE 'reading'
        END AS read_state
      FROM chat_messages AS message
      JOIN json_each(message.attention_json, '$.receipts') AS receipt
      LEFT JOIN agents AS agent
        ON agent.principal_id = json_extract(receipt.value, '$.agentId')
      LEFT JOIN executions AS dispatch_execution
        ON dispatch_execution.event_id =
          json_extract(receipt.value, '$.dispatchEventId')
      WHERE json_extract(receipt.value, '$.reason') != 'agent-suspended'
      ORDER BY message.event_id, CAST(receipt.key AS INTEGER)
    ) AS state
    GROUP BY state.event_id;
    CREATE TRIGGER IF NOT EXISTS chat_message_project_read_progress_attention
    AFTER UPDATE OF receipt_json ON executions
    WHEN EXISTS (
      SELECT 1 FROM events
      WHERE event_id = NEW.event_id AND type = 'chat.message'
    )
    BEGIN
      UPDATE chat_messages
      SET attention_json = CASE
          WHEN json_extract(NEW.receipt_json, '$.schema') =
            'ChatAttentionReceiptList@1'
          THEN NEW.receipt_json
          ELSE attention_json
        END
      WHERE event_id = NEW.event_id;
      UPDATE chat_messages
      SET read_progress_json = (
          SELECT progress_json
          FROM chat_message_read_progress_v1
          WHERE event_id = NEW.event_id
        ),
        projected_at = NEW.updated_at
      WHERE event_id = NEW.event_id;
    END;
    CREATE TRIGGER IF NOT EXISTS chat_message_project_read_progress_dispatch
    AFTER UPDATE OF status, receipt_json ON executions
    WHEN EXISTS (
      SELECT 1 FROM events
      WHERE event_id = NEW.event_id AND type = 'chat.dispatch'
    )
    BEGIN
      UPDATE chat_messages
      SET read_progress_json = (
          SELECT progress_json
          FROM chat_message_read_progress_v1
          WHERE event_id = json_extract(
            (SELECT payload_json FROM events WHERE event_id = NEW.event_id),
            '$.sourceMessageEventId'
          )
        ),
        projected_at = NEW.updated_at
      WHERE event_id = json_extract(
        (SELECT payload_json FROM events WHERE event_id = NEW.event_id),
        '$.sourceMessageEventId'
      );
    END;
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
    CREATE TABLE IF NOT EXISTS subscriptions (
      subscription_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      owner_agent_id TEXT REFERENCES agents(principal_id),
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
        definition_schema IN (
          'SubscriptionDefinition@3', 'SubscriptionDefinition@4',
          'SubscriptionDefinition@5'
        )
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
      source_binding_json TEXT CHECK(
        source_binding_json IS NULL OR (
          json_valid(source_binding_json) AND length(source_binding_json) <= 16384
        )
      ),
      target_json TEXT CHECK(
        target_json IS NULL OR (
          json_valid(target_json) AND length(target_json) <= 65536
        )
      ),
      agent_run_id TEXT REFERENCES agent_runs(run_id),
      cycle_id TEXT UNIQUE REFERENCES agent_run_cycles(cycle_id),
      admission_receipt_json TEXT CHECK(
        admission_receipt_json IS NULL OR (
          json_valid(admission_receipt_json) AND length(admission_receipt_json) <= 16384
        )
      ),
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(
        (definition_schema = 'SubscriptionDefinition@3'
          AND owner_agent_id IS NOT NULL AND source_binding_json IS NULL
          AND target_json IS NULL
          AND agent_run_id IS NULL AND cycle_id IS NULL
          AND admission_receipt_json IS NULL)
        OR (definition_schema = 'SubscriptionDefinition@4'
          AND owner_agent_id IS NULL AND source_binding_json IS NOT NULL
          AND target_json IS NULL
          AND agent_run_id IS NOT NULL
          AND json_extract(source_binding_json, '$.schemaVersion') = 'RunSourceBinding@1'
          AND json_extract(source_binding_json, '$.runId') = agent_run_id
          AND json_extract(source_binding_json, '$.source.kind') = 'subscription'
          AND json_extract(source_binding_json, '$.source.id') = subscription_id
          AND json_extract(source_binding_json, '$.source.definitionRevision') =
            'SubscriptionDefinition@4:' || definition_revision)
        OR (definition_schema = 'SubscriptionDefinition@5'
          AND owner_agent_id IS NULL AND source_binding_json IS NULL
          AND target_json IS NOT NULL
          AND json_extract(target_json, '$.schemaVersion') = 'ProactiveTarget@1'
          AND json_extract(target_json, '$.kind') IN ('steward_run', 'application_action')
          AND (
            (json_extract(target_json, '$.kind') = 'steward_run'
              AND agent_run_id IS NOT NULL
              AND json_extract(target_json, '$.sourceBinding.schemaVersion') =
                'RunSourceBinding@1'
              AND json_extract(target_json, '$.sourceBinding.runId') = agent_run_id
              AND json_extract(target_json, '$.sourceBinding.source.kind') = 'subscription'
              AND json_extract(target_json, '$.sourceBinding.source.id') = subscription_id
              AND json_extract(target_json, '$.sourceBinding.source.definitionRevision') =
                'SubscriptionDefinition@5:' || definition_revision)
            OR (json_extract(target_json, '$.kind') = 'application_action'
              AND agent_run_id IS NULL AND cycle_id IS NULL
              AND admission_receipt_json IS NULL
              AND json_type(target_json, '$.actionRef') = 'text'
              AND json_extract(target_json, '$.registrationDigest') GLOB
                'sha256:[0-9a-f]*'
              AND length(json_extract(target_json, '$.registrationDigest')) = 71
              AND json_type(target_json, '$.input') IS NOT NULL)
          ))
      ),
      CHECK(
        (cycle_id IS NULL AND admission_receipt_json IS NULL)
        OR (cycle_id IS NOT NULL AND admission_receipt_json IS NOT NULL
          AND json_extract(admission_receipt_json, '$.schemaVersion') =
            'SubscriptionOccurrenceAdmissionReceipt@1'
          AND json_extract(admission_receipt_json, '$.subscriptionId') = subscription_id
          AND json_extract(admission_receipt_json, '$.occurrenceKey') = terminal_key
          AND json_extract(admission_receipt_json, '$.agentRunId') = agent_run_id
          AND json_extract(admission_receipt_json, '$.cycleId') = cycle_id)
      )
    );
    CREATE INDEX IF NOT EXISTS subscriptions_due
      ON subscriptions(status, next_poll_at);
    CREATE TABLE IF NOT EXISTS continuous_subscriptions (
      subscription_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      owner_agent_id TEXT REFERENCES agents(principal_id),
      current_revision INTEGER NOT NULL CHECK(current_revision >= 1),
      definition_schema TEXT NOT NULL DEFAULT 'ContinuousSubscriptionDefinition@1' CHECK(
        definition_schema IN (
          'ContinuousSubscriptionDefinition@1', 'ContinuousSubscriptionDefinition@2',
          'ContinuousSubscriptionDefinition@3', 'ContinuousSubscriptionDefinition@4'
        )
      ),
      plugin_path TEXT,
      plugin_id TEXT,
      plugin_config_json TEXT CHECK(
        json_valid(plugin_config_json) AND length(plugin_config_json) <= 65536
      ),
      policy_json TEXT CHECK(
        json_valid(policy_json) AND length(policy_json) <= 65536
      ),
      interval_ms INTEGER CHECK(interval_ms >= 100),
      file_source_json TEXT CHECK(file_source_json IS NULL OR (json_valid(file_source_json) AND length(file_source_json) <= 16384)),
      file_listener_json TEXT CHECK(file_listener_json IS NULL OR (json_valid(file_listener_json) AND length(file_listener_json) <= 8192)),
      poll_count INTEGER NOT NULL DEFAULT 0 CHECK(poll_count >= 0),
      status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'blocked', 'cancelled')),
      next_poll_at TEXT,
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
      source_binding_json TEXT CHECK(
        source_binding_json IS NULL OR (
          json_valid(source_binding_json) AND length(source_binding_json) <= 16384
        )
      ),
      target_json TEXT CHECK(
        target_json IS NULL OR (
          json_valid(target_json) AND length(target_json) <= 65536
        )
      ),
      agent_run_id TEXT REFERENCES agent_runs(run_id),
      pending_cycle_id TEXT UNIQUE REFERENCES agent_run_cycles(cycle_id),
      pending_admission_receipt_json TEXT CHECK(
        pending_admission_receipt_json IS NULL OR (
          json_valid(pending_admission_receipt_json)
          AND length(pending_admission_receipt_json) <= 16384
        )
      ),
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(
        (definition_schema = 'ContinuousSubscriptionDefinition@4' AND file_source_json IS NOT NULL)
        OR (definition_schema != 'ContinuousSubscriptionDefinition@4' AND file_source_json IS NULL
          AND plugin_path IS NOT NULL AND plugin_id IS NOT NULL AND plugin_config_json IS NOT NULL
          AND policy_json IS NOT NULL AND interval_ms IS NOT NULL AND next_poll_at IS NOT NULL)
      ),
      CHECK(
        definition_schema != 'ContinuousSubscriptionDefinition@4' OR (
          (json_extract(target_json, '$.kind') = 'steward_run'
            AND agent_run_id IS NOT NULL
            AND json_extract(target_json, '$.sourceBinding.runId') = agent_run_id
            AND json_extract(target_json, '$.sourceBinding.source.kind') = 'continuous_subscription'
            AND json_extract(target_json, '$.sourceBinding.source.id') = subscription_id
            AND json_extract(target_json, '$.sourceBinding.source.definitionRevision') =
              'ContinuousSubscriptionDefinition@4:' || current_revision)
          OR (json_extract(target_json, '$.kind') IN ('application_action', 'external_workflow')
            AND agent_run_id IS NULL AND pending_cycle_id IS NULL AND pending_admission_receipt_json IS NULL)
        )
      ),
      CHECK(
        (pending_occurrence_key IS NULL AND pending_observation_json IS NULL)
        OR (pending_occurrence_key IS NOT NULL AND pending_observation_json IS NOT NULL)
      ),
      CHECK(
        (definition_schema = 'ContinuousSubscriptionDefinition@4'
          AND file_source_json IS NOT NULL AND json_extract(file_source_json, '$.kind') = 'file'
          AND plugin_path IS NULL AND plugin_id IS NULL AND plugin_config_json IS NULL
          AND policy_json IS NULL AND interval_ms IS NULL AND next_poll_at IS NULL
          AND owner_agent_id IS NULL AND source_binding_json IS NULL
          AND target_json IS NOT NULL AND json_extract(target_json, '$.schemaVersion') = 'ProactiveTarget@1'
          AND json_extract(target_json, '$.kind') IN ('steward_run', 'application_action', 'external_workflow'))
        OR (definition_schema = 'ContinuousSubscriptionDefinition@1'
          AND owner_agent_id IS NOT NULL AND source_binding_json IS NULL
          AND target_json IS NULL
          AND agent_run_id IS NULL AND pending_cycle_id IS NULL
          AND pending_admission_receipt_json IS NULL)
        OR (definition_schema = 'ContinuousSubscriptionDefinition@2'
          AND owner_agent_id IS NULL AND source_binding_json IS NOT NULL
          AND target_json IS NULL
          AND agent_run_id IS NOT NULL
          AND json_extract(source_binding_json, '$.schemaVersion') = 'RunSourceBinding@1'
          AND json_extract(source_binding_json, '$.runId') = agent_run_id
          AND json_extract(source_binding_json, '$.source.kind') =
            'continuous_subscription'
          AND json_extract(source_binding_json, '$.source.id') = subscription_id
          AND json_extract(source_binding_json, '$.source.definitionRevision') =
            'ContinuousSubscriptionDefinition@2:' || current_revision)
        OR (definition_schema = 'ContinuousSubscriptionDefinition@3'
          AND owner_agent_id IS NULL AND source_binding_json IS NULL
          AND target_json IS NOT NULL
          AND json_extract(target_json, '$.schemaVersion') = 'ProactiveTarget@1'
          AND json_extract(target_json, '$.kind') IN ('steward_run', 'application_action')
          AND (
            (json_extract(target_json, '$.kind') = 'steward_run'
              AND agent_run_id IS NOT NULL
              AND json_extract(target_json, '$.sourceBinding.schemaVersion') =
                'RunSourceBinding@1'
              AND json_extract(target_json, '$.sourceBinding.runId') = agent_run_id
              AND json_extract(target_json, '$.sourceBinding.source.kind') =
                'continuous_subscription'
              AND json_extract(target_json, '$.sourceBinding.source.id') = subscription_id
              AND json_extract(target_json, '$.sourceBinding.source.definitionRevision') =
                'ContinuousSubscriptionDefinition@3:' || current_revision)
            OR (json_extract(target_json, '$.kind') = 'application_action'
              AND agent_run_id IS NULL AND pending_cycle_id IS NULL
              AND pending_admission_receipt_json IS NULL
              AND json_type(target_json, '$.actionRef') = 'text'
              AND json_extract(target_json, '$.registrationDigest') GLOB
                'sha256:[0-9a-f]*'
              AND length(json_extract(target_json, '$.registrationDigest')) = 71
              AND json_type(target_json, '$.input') IS NOT NULL)
          ))
      ),
      CHECK(
        (pending_cycle_id IS NULL AND pending_admission_receipt_json IS NULL)
        OR (pending_occurrence_key IS NOT NULL AND pending_cycle_id IS NOT NULL
          AND pending_admission_receipt_json IS NOT NULL
          AND json_extract(pending_admission_receipt_json, '$.schemaVersion') =
            'SubscriptionOccurrenceAdmissionReceipt@1'
          AND json_extract(pending_admission_receipt_json, '$.subscriptionId') = subscription_id
          AND json_extract(pending_admission_receipt_json, '$.occurrenceKey') =
            pending_occurrence_key
          AND json_extract(pending_admission_receipt_json, '$.agentRunId') = agent_run_id
          AND json_extract(pending_admission_receipt_json, '$.cycleId') = pending_cycle_id)
      )
    );
    CREATE INDEX IF NOT EXISTS continuous_subscriptions_due
      ON continuous_subscriptions(status, next_poll_at);
    CREATE TABLE IF NOT EXISTS proactive_callback_definitions (
      definition_id TEXT PRIMARY KEY,
      callback_id TEXT NOT NULL,
      owner_kind TEXT NOT NULL CHECK(owner_kind IN (
        'schedule', 'subscription', 'continuous_subscription'
      )),
      owner_id TEXT NOT NULL,
      owner_revision INTEGER NOT NULL CHECK(owner_revision >= 1),
      ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
      kind TEXT NOT NULL CHECK(kind IN (
        'agent.invoke', 'command.exec', 'destination.deliver'
      )),
      definition_schema TEXT NOT NULL CHECK(
        definition_schema = 'ProactiveCallbackDefinition@1'
      ),
      definition_json TEXT NOT NULL CHECK(
        json_valid(definition_json) AND length(definition_json) <= 65536
      ),
      grant_json TEXT NOT NULL CHECK(
        json_valid(grant_json) AND length(grant_json) <= 65536
      ),
      created_at TEXT NOT NULL,
      UNIQUE(owner_kind, owner_id, owner_revision, ordinal),
      UNIQUE(owner_kind, owner_id, owner_revision, callback_id)
    );
    CREATE INDEX IF NOT EXISTS proactive_callback_definitions_owner
      ON proactive_callback_definitions(owner_kind, owner_id, owner_revision, ordinal);
    CREATE TABLE IF NOT EXISTS proactive_callback_occurrences (
      occurrence_id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL CHECK(owner_kind IN (
        'schedule', 'subscription', 'continuous_subscription'
      )),
      owner_id TEXT NOT NULL,
      owner_revision INTEGER NOT NULL CHECK(owner_revision >= 1),
      trigger_occurrence_key TEXT NOT NULL,
      definition_id TEXT NOT NULL REFERENCES proactive_callback_definitions(definition_id),
      callback_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
      kind TEXT NOT NULL CHECK(kind IN (
        'agent.invoke', 'command.exec', 'destination.deliver'
      )),
      definition_schema TEXT NOT NULL CHECK(
        definition_schema = 'ProactiveCallbackDefinition@1'
      ),
      definition_json TEXT NOT NULL CHECK(
        json_valid(definition_json) AND length(definition_json) <= 65536
      ),
      grant_json TEXT NOT NULL CHECK(
        json_valid(grant_json) AND length(grant_json) <= 65536
      ),
      status TEXT NOT NULL CHECK(status IN (
        'pending', 'started', 'succeeded', 'blocked', 'failed', 'unknown'
      )),
      event_id TEXT UNIQUE REFERENCES events(event_id),
      started_at TEXT,
      completed_at TEXT,
      receipt_json TEXT CHECK(
        receipt_json IS NULL OR (
          json_valid(receipt_json) AND length(receipt_json) <= 65536
        )
      ),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_kind, owner_id, trigger_occurrence_key, ordinal),
      UNIQUE(owner_kind, owner_id, trigger_occurrence_key, callback_id)
    );
    CREATE INDEX IF NOT EXISTS proactive_callback_occurrences_status
      ON proactive_callback_occurrences(status, owner_kind, owner_id, created_at, ordinal);
    CREATE TABLE IF NOT EXISTS deterministic_action_receipts (
      receipt_id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL CHECK(source_kind IN (
        'schedule', 'subscription', 'continuous_subscription'
      )),
      source_id TEXT NOT NULL,
      definition_revision TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      target_digest TEXT NOT NULL CHECK(
        target_digest GLOB 'sha256:[0-9a-f]*' AND length(target_digest) = 71
      ),
      action_ref TEXT NOT NULL CHECK(
        action_ref GLOB 'action:*@[1-9]*' AND length(action_ref) <= 256
      ),
      status TEXT NOT NULL CHECK(status IN ('succeeded', 'skipped', 'failed')),
      receipt_json TEXT NOT NULL CHECK(
        json_valid(receipt_json) AND length(receipt_json) <= 65536
        AND json_extract(receipt_json, '$.schemaVersion') =
          'DeterministicApplicationActionReceipt@1'
        AND json_extract(receipt_json, '$.receiptId') = receipt_id
        AND json_extract(receipt_json, '$.source.kind') = source_kind
        AND json_extract(receipt_json, '$.source.id') = source_id
        AND json_extract(receipt_json, '$.source.definitionRevision') =
          definition_revision
        AND json_extract(receipt_json, '$.occurrenceKey') = occurrence_key
        AND json_extract(receipt_json, '$.targetDigest') = target_digest
        AND json_extract(receipt_json, '$.actionRef') = action_ref
        AND json_extract(receipt_json, '$.status') = status
      ),
      created_at TEXT NOT NULL,
      UNIQUE(source_kind, source_id, occurrence_key)
    );
    CREATE TABLE IF NOT EXISTS external_workflow_executions (
      execution_id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL CHECK(source_kind IN (
        'schedule', 'subscription', 'continuous_subscription'
      )),
      source_id TEXT NOT NULL,
      definition_revision TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      target_digest TEXT NOT NULL CHECK(
        target_digest GLOB 'sha256:[0-9a-f]*' AND length(target_digest) = 71
      ),
      workflow_ref TEXT NOT NULL CHECK(
        workflow_ref GLOB 'workflow:*@[1-9]*' AND length(workflow_ref) <= 256
      ),
      registration_digest TEXT NOT NULL CHECK(
        registration_digest GLOB 'sha256:[0-9a-f]*'
        AND length(registration_digest) = 71
      ),
      target_json TEXT NOT NULL CHECK(
        json_valid(target_json) AND length(target_json) <= 65536
        AND json_extract(target_json, '$.schemaVersion') = 'ProactiveTarget@1'
        AND json_extract(target_json, '$.kind') = 'external_workflow'
        AND json_extract(target_json, '$.workflow.schemaVersion') =
          'ExternalWorkflowTarget@1'
        AND json_extract(target_json, '$.workflow.workflowRef') = workflow_ref
        AND json_extract(target_json, '$.workflow.registrationDigest') =
          registration_digest
        AND json_extract(target_json, '$.workflow.executionPolicy.schemaVersion') =
          'ExternalWorkflowExecutionPolicy@1'
        AND json_type(target_json, '$.workflow.executionPolicy.maxAttempts') = 'integer'
        AND json_extract(target_json, '$.workflow.executionPolicy.maxAttempts') BETWEEN 1 AND 5
        AND json_type(
          target_json, '$.workflow.executionPolicy.retryBackoffMilliseconds'
        ) = 'integer'
        AND json_extract(
          target_json, '$.workflow.executionPolicy.retryBackoffMilliseconds'
        ) BETWEEN 1000 AND 3600000
      ),
      observation_json TEXT NOT NULL CHECK(
        json_valid(observation_json) AND length(observation_json) <= 65536
      ),
      status TEXT NOT NULL CHECK(status IN (
        'queued', 'claimed', 'running', 'retry_wait', 'succeeded', 'failed', 'unknown'
      )),
      attempt_count INTEGER NOT NULL CHECK(
        attempt_count >= 0 AND attempt_count <= max_attempts
      ),
      max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 1000000),
      next_attempt_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      effect_started_at TEXT,
      receipt_json TEXT CHECK(receipt_json IS NULL OR (
        json_valid(receipt_json) AND length(receipt_json) <= 131072
        AND json_extract(receipt_json, '$.schemaVersion') =
          'ExternalWorkflowExecutionReceipt@1'
        AND json_extract(receipt_json, '$.executionId') = execution_id
        AND json_extract(receipt_json, '$.source.kind') = source_kind
        AND json_extract(receipt_json, '$.source.id') = source_id
        AND json_extract(receipt_json, '$.source.definitionRevision') =
          definition_revision
        AND json_extract(receipt_json, '$.occurrenceKey') = occurrence_key
        AND json_extract(receipt_json, '$.targetDigest') = target_digest
        AND json_extract(receipt_json, '$.workflowRef') = workflow_ref
        AND json_extract(receipt_json, '$.registrationDigest') = registration_digest
        AND json_extract(receipt_json, '$.resolution') = 'runtime'
      )),
      resolution_receipt_json TEXT CHECK(resolution_receipt_json IS NULL OR (
        json_valid(resolution_receipt_json) AND length(resolution_receipt_json) <= 131072
        AND json_extract(resolution_receipt_json, '$.schemaVersion') =
          'ExternalWorkflowExecutionReceipt@1'
        AND json_extract(resolution_receipt_json, '$.executionId') = execution_id
        AND json_extract(resolution_receipt_json, '$.source.kind') = source_kind
        AND json_extract(resolution_receipt_json, '$.source.id') = source_id
        AND json_extract(resolution_receipt_json, '$.source.definitionRevision') =
          definition_revision
        AND json_extract(resolution_receipt_json, '$.occurrenceKey') = occurrence_key
        AND json_extract(resolution_receipt_json, '$.targetDigest') = target_digest
        AND json_extract(resolution_receipt_json, '$.workflowRef') = workflow_ref
        AND json_extract(resolution_receipt_json, '$.registrationDigest') =
          registration_digest
        AND json_extract(resolution_receipt_json, '$.resolution') = 'manual'
      )),
      last_error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(source_kind, source_id, occurrence_key),
      CHECK(
        (status IN ('claimed', 'running')
          AND lease_owner IS NOT NULL AND lease_token IS NOT NULL
          AND lease_expires_at IS NOT NULL)
        OR (status NOT IN ('claimed', 'running')
          AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
      ),
      CHECK(
        (status IN ('queued', 'claimed', 'retry_wait') AND effect_started_at IS NULL)
        OR (status IN ('running', 'succeeded', 'unknown')
          AND effect_started_at IS NOT NULL)
        OR status = 'failed'
      ),
      CHECK(
        (status IN ('succeeded', 'failed', 'unknown') AND completed_at IS NOT NULL)
        OR (status NOT IN ('succeeded', 'failed', 'unknown') AND completed_at IS NULL)
      ),
      CHECK(
        (status NOT IN ('succeeded', 'failed', 'unknown')
          AND receipt_json IS NULL AND resolution_receipt_json IS NULL)
        OR (status = 'unknown' AND receipt_json IS NOT NULL
          AND json_extract(receipt_json, '$.status') = 'unknown'
          AND json_type(receipt_json, '$.error') = 'text'
          AND resolution_receipt_json IS NULL)
        OR (status IN ('succeeded', 'failed') AND receipt_json IS NOT NULL AND (
          (json_extract(receipt_json, '$.status') = status
            AND ((status = 'succeeded' AND json_type(receipt_json, '$.error') IS NULL)
              OR (status = 'failed' AND json_type(receipt_json, '$.error') = 'text'))
            AND resolution_receipt_json IS NULL)
          OR (json_extract(receipt_json, '$.status') = 'unknown'
            AND json_type(receipt_json, '$.error') = 'text'
            AND resolution_receipt_json IS NOT NULL
            AND json_extract(resolution_receipt_json, '$.status') = status
            AND ((status = 'succeeded'
                AND json_type(resolution_receipt_json, '$.error') IS NULL)
              OR (status = 'failed'
                AND json_type(resolution_receipt_json, '$.error') = 'text')))
        ))
      ),
      CHECK(effect_started_at IS NULL OR status != 'claimed')
    );
    CREATE INDEX IF NOT EXISTS external_workflow_executions_due
      ON external_workflow_executions(status, next_attempt_at);
    CREATE TABLE IF NOT EXISTS external_workflow_recovery_receipts (
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      execution_id TEXT NOT NULL REFERENCES external_workflow_executions(execution_id),
      request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(request_json) <= 16384),
      receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(receipt_json) <= 393216),
      created_at TEXT NOT NULL,
      PRIMARY KEY(source_kind, source_id, request_id)
    );
    CREATE TABLE IF NOT EXISTS proactive_source_migration_receipts (
      receipt_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      source_kind TEXT NOT NULL CHECK(source_kind = 'schedule'),
      source_id TEXT NOT NULL,
      from_definition_revision TEXT NOT NULL,
      to_definition_revision TEXT NOT NULL,
      target_digest TEXT NOT NULL CHECK(
        target_digest GLOB 'sha256:[0-9a-f]*' AND length(target_digest) = 71
      ),
      workflow_ref TEXT NOT NULL CHECK(
        workflow_ref GLOB 'workflow:*@[1-9]*' AND length(workflow_ref) <= 256
      ),
      receipt_json TEXT NOT NULL CHECK(
        json_valid(receipt_json) AND length(receipt_json) <= 32768
        AND json_extract(receipt_json, '$.schemaVersion') =
          'ProactiveSourceMigrationReceipt@1'
        AND json_extract(receipt_json, '$.receiptId') = receipt_id
        AND json_extract(receipt_json, '$.requestId') = request_id
        AND json_extract(receipt_json, '$.sourceKind') = source_kind
        AND json_extract(receipt_json, '$.sourceId') = source_id
        AND json_extract(receipt_json, '$.fromDefinitionRevision') =
          from_definition_revision
        AND json_extract(receipt_json, '$.toDefinitionRevision') =
          to_definition_revision
        AND json_extract(receipt_json, '$.targetDigest') = target_digest
        AND json_extract(receipt_json, '$.workflowRef') = workflow_ref
      ),
      created_at TEXT NOT NULL,
      UNIQUE(source_kind, source_id, from_definition_revision)
    );
    CREATE TABLE IF NOT EXISTS schedules (
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
      definition_schema TEXT NOT NULL DEFAULT 'ScheduleRevision@1' CHECK(
        definition_schema IN (
          'ScheduleRevision@1', 'ScheduleRevision@2', 'ScheduleRevision@3'
        )
      ),
      agent_id TEXT REFERENCES agents(principal_id),
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
      session_policy TEXT CHECK(session_policy IN ('new_each_run', 'fixed')),
      fixed_session_id TEXT REFERENCES agent_sessions(session_id),
      prompt TEXT,
      workspace TEXT,
      source_binding_json TEXT CHECK(
        source_binding_json IS NULL OR (
          json_valid(source_binding_json) AND length(source_binding_json) <= 16384
        )
      ),
      target_json TEXT CHECK(
        target_json IS NULL OR (
          json_valid(target_json) AND length(target_json) <= 65536
        )
      ),
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
        (definition_schema = 'ScheduleRevision@1'
          AND agent_id IS NOT NULL AND session_policy IS NOT NULL
          AND prompt IS NOT NULL AND workspace IS NOT NULL
          AND source_binding_json IS NULL AND target_json IS NULL
          AND (
            (session_policy = 'new_each_run' AND fixed_session_id IS NULL)
            OR (session_policy = 'fixed' AND fixed_session_id IS NOT NULL)
          ))
        OR (definition_schema = 'ScheduleRevision@2'
          AND agent_id IS NULL AND session_policy IS NULL
          AND fixed_session_id IS NULL AND prompt IS NULL AND workspace IS NULL
          AND source_binding_json IS NOT NULL AND target_json IS NULL
          AND json_extract(source_binding_json, '$.schemaVersion') = 'RunSourceBinding@1'
          AND json_extract(source_binding_json, '$.source.kind') = 'schedule'
          AND json_extract(source_binding_json, '$.source.id') = schedule_id
          AND json_extract(source_binding_json, '$.source.definitionRevision') =
            'ScheduleRevision@2:' || current_revision)
        OR (definition_schema = 'ScheduleRevision@3'
          AND agent_id IS NULL AND session_policy IS NULL
          AND fixed_session_id IS NULL AND prompt IS NULL AND workspace IS NULL
          AND source_binding_json IS NULL AND target_json IS NOT NULL
          AND json_extract(target_json, '$.schemaVersion') = 'ProactiveTarget@1'
          AND json_extract(target_json, '$.kind') IN (
            'steward_run', 'application_action', 'external_workflow'
          )
          AND (
            (json_extract(target_json, '$.kind') = 'application_action'
              AND json_type(target_json, '$.actionRef') = 'text'
              AND json_extract(target_json, '$.registrationDigest') GLOB
                'sha256:[0-9a-f]*'
              AND length(json_extract(target_json, '$.registrationDigest')) = 71
              AND json_type(target_json, '$.input') IS NOT NULL)
            OR (json_extract(target_json, '$.kind') = 'external_workflow'
              AND json_extract(target_json, '$.workflow.schemaVersion') =
                'ExternalWorkflowTarget@1'
              AND json_type(target_json, '$.workflow.workflowRef') = 'text'
              AND json_extract(target_json, '$.workflow.registrationDigest') GLOB
                'sha256:[0-9a-f]*'
              AND length(json_extract(
                target_json, '$.workflow.registrationDigest'
              )) = 71
              AND json_type(target_json, '$.workflow.input') IS NOT NULL
              AND json_extract(
                target_json, '$.workflow.executionPolicy.schemaVersion'
              ) = 'ExternalWorkflowExecutionPolicy@1'
              AND json_extract(
                target_json, '$.workflow.executionPolicy.maxAttempts'
              ) BETWEEN 1 AND 5
              AND json_type(
                target_json, '$.workflow.executionPolicy.retryBackoffMilliseconds'
              ) = 'integer'
              AND json_extract(
                target_json, '$.workflow.executionPolicy.retryBackoffMilliseconds'
              ) BETWEEN 1000 AND 3600000)
            OR (
              json_extract(target_json, '$.kind') = 'steward_run'
              AND
              json_extract(target_json, '$.sourceBinding.schemaVersion') =
                'RunSourceBinding@1'
              AND
              json_extract(target_json, '$.sourceBinding.source.kind') = 'schedule'
              AND json_extract(target_json, '$.sourceBinding.source.id') = schedule_id
              AND json_extract(target_json, '$.sourceBinding.source.definitionRevision') =
                'ScheduleRevision@3:' || current_revision
            )
          ))
      )
    );
    CREATE INDEX IF NOT EXISTS schedules_due
      ON schedules(status, next_run_at);
    CREATE UNIQUE INDEX IF NOT EXISTS schedules_bound_run
      ON schedules(json_extract(source_binding_json, '$.runId'))
      WHERE source_binding_json IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS schedules_target_run
      ON schedules(json_extract(target_json, '$.sourceBinding.runId'))
      WHERE json_extract(target_json, '$.kind') = 'steward_run';
    CREATE TABLE IF NOT EXISTS scheduled_runs (
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
      agent_run_id TEXT REFERENCES agent_runs(run_id),
      cycle_id TEXT UNIQUE REFERENCES agent_run_cycles(cycle_id),
      admission_receipt_json TEXT CHECK(
        admission_receipt_json IS NULL OR (
          json_valid(admission_receipt_json) AND length(admission_receipt_json) <= 16384
        )
      ),
      decision_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(schedule_id, occurrence_key),
      CHECK(
        (cycle_id IS NULL AND admission_receipt_json IS NULL)
        OR (agent_run_id IS NOT NULL AND cycle_id IS NOT NULL
          AND admission_receipt_json IS NOT NULL
          AND json_extract(admission_receipt_json, '$.schemaVersion') =
            'ScheduleOccurrenceAdmissionReceipt@1'
          AND json_extract(admission_receipt_json, '$.scheduleId') = schedule_id
          AND json_extract(admission_receipt_json, '$.occurrenceId') = run_id
          AND json_extract(admission_receipt_json, '$.agentRunId') = agent_run_id
          AND json_extract(admission_receipt_json, '$.cycleId') = cycle_id)
      ),
      CHECK(
        agent_run_id IS NULL OR (
          event_id IS NULL AND execution_id IS NULL AND session_id IS NULL
        )
      ),
      CHECK(
        (json_extract(definition_snapshot_json, '$.schema') =
          'ScheduleDefinitionSnapshot@1' AND agent_run_id IS NULL)
        OR (json_extract(definition_snapshot_json, '$.schema') =
          'ScheduleDefinitionSnapshot@2' AND agent_run_id IS NOT NULL)
        OR (json_extract(definition_snapshot_json, '$.schema') =
          'ScheduleDefinitionSnapshot@3' AND (
            (json_extract(definition_snapshot_json, '$.target.kind') = 'steward_run'
              AND agent_run_id IS NOT NULL)
            OR (json_extract(definition_snapshot_json, '$.target.kind') IN (
              'application_action', 'external_workflow'
            ) AND agent_run_id IS NULL)
          ))
      )
    );
    CREATE INDEX IF NOT EXISTS scheduled_runs_schedule
      ON scheduled_runs(schedule_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS scheduled_runs_status
      ON scheduled_runs(schedule_id, status, created_at);
    CREATE TABLE IF NOT EXISTS notices (
      notice_id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL CHECK(source_kind = 'delivery'),
      source_id TEXT NOT NULL,
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
      summary TEXT NOT NULL CHECK(length(summary) <= 4096),
      outcome TEXT NOT NULL CHECK(outcome IN ('succeeded', 'failed')),
      delivery_status TEXT NOT NULL CHECK(delivery_status IN (
        'pending', 'delivering', 'retry_wait', 'delivered', 'failed'
      )),
      delivery_error TEXT CHECK(
        delivery_error IS NULL OR length(delivery_error) <= 512
      ),
      event_id TEXT NOT NULL,
      destination_id TEXT NOT NULL,
      subscription_id TEXT,
      occurred_at TEXT NOT NULL,
      delivered_at TEXT,
      projection_updated_at TEXT NOT NULL,
      read_at TEXT,
      acknowledged_at TEXT,
      state_updated_at TEXT,
      UNIQUE(source_kind, source_id),
      CHECK(acknowledged_at IS NULL OR read_at IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS notices_timeline
      ON notices(occurred_at DESC, notice_id DESC);
    CREATE TRIGGER IF NOT EXISTS notice_project_delivery_insert
    AFTER INSERT ON deliveries
    BEGIN
      ${noticeProjectionSql("NEW.delivery_id")}
    END;
    CREATE TRIGGER IF NOT EXISTS notice_project_delivery_update
    AFTER UPDATE ON deliveries
    BEGIN
      ${noticeProjectionSql("NEW.delivery_id")}
    END;
  `);
  const runColumns = database.prepare("PRAGMA table_info(agent_runs)").all() as
    unknown as Array<{ name: string }>;
  if (runColumns.some(({ name }) => name === "archived_at")) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS agent_runs_archive_updated
        ON agent_runs(archived_at, updated_at DESC, run_id DESC)
    `);
  }
  for (const [table, idColumn, index] of [
    ["schedules", "schedule_id", "schedules_archive_updated"],
    ["subscriptions", "subscription_id", "subscriptions_archive_updated"],
    [
      "continuous_subscriptions",
      "subscription_id",
      "continuous_subscriptions_archive_updated"
    ]
  ] as const) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as
      unknown as Array<{ name: string }>;
    if (columns.some(({ name }) => name === "archived_at")) {
      database.exec(`
        CREATE INDEX IF NOT EXISTS ${index}
          ON ${table}(archived_at, updated_at DESC, ${idColumn} DESC)
      `);
    }
  }
}
function noticeProjectionSql(deliveryIdExpression: string): string {
  return `
    INSERT INTO notices (
      notice_id, source_kind, source_id, title, summary, outcome,
      delivery_status, delivery_error, event_id, destination_id,
      subscription_id, occurred_at, delivered_at, projection_updated_at
    )
    SELECT
      'ntc1_' || delivery.delivery_id,
      'delivery',
      delivery.delivery_id,
      substr(COALESCE(
        NULLIF(trim(json_extract(delivery.destination_address_json, '$.title')), ''),
        'Agent result'
      ), 1, 160),
      substr(COALESCE(event.output, event.error, ''), 1, 4096),
      event.outcome,
      delivery.status,
      CASE
        WHEN delivery.last_error IS NULL THEN NULL
        ELSE substr(delivery.last_error, 1, 512)
      END,
      event.event_id,
      delivery.destination_id,
      CASE
        WHEN json_type(delivery.destination_address_json, '$.subscriptionId') = 'text'
        THEN substr(
          json_extract(delivery.destination_address_json, '$.subscriptionId'),
          1,
          256
        )
        ELSE NULL
      END,
      event.created_at,
      CASE WHEN delivery.status = 'delivered' THEN delivery.updated_at ELSE NULL END,
      delivery.updated_at
    FROM deliveries AS delivery
    JOIN events AS event ON event.event_id = delivery.result_event_id
    WHERE delivery.delivery_id = ${deliveryIdExpression}
      AND delivery.destination_kind = 'macos-notification'
      AND event.type = 'agent.result'
    ON CONFLICT(source_kind, source_id) DO UPDATE SET
      title = excluded.title,
      summary = excluded.summary,
      outcome = excluded.outcome,
      delivery_status = excluded.delivery_status,
      delivery_error = excluded.delivery_error,
      event_id = excluded.event_id,
      destination_id = excluded.destination_id,
      subscription_id = excluded.subscription_id,
      occurred_at = excluded.occurred_at,
      delivered_at = excluded.delivered_at,
      projection_updated_at = excluded.projection_updated_at;
  `;
}
