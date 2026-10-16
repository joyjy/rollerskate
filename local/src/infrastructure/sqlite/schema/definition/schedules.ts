export const schedulesSchemaSql = `
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
`;
