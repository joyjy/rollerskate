export const runtimeSchemaSql = `
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
`;
