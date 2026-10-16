export const subscriptionsSchemaSql = `
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
      observation_state_json TEXT CHECK(observation_state_json IS NULL OR (json_valid(observation_state_json) AND length(observation_state_json) <= 16384)),
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
`;
