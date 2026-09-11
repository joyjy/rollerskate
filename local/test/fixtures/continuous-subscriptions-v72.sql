-- Exact Continuous Subscription DDL from schema v72, retained for upgrade verification.
    CREATE TABLE IF NOT EXISTS continuous_subscriptions (
      subscription_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      owner_agent_id TEXT REFERENCES agents(principal_id),
      current_revision INTEGER NOT NULL CHECK(current_revision >= 1),
      definition_schema TEXT NOT NULL DEFAULT 'ContinuousSubscriptionDefinition@1' CHECK(
        definition_schema IN (
          'ContinuousSubscriptionDefinition@1', 'ContinuousSubscriptionDefinition@2',
          'ContinuousSubscriptionDefinition@3'
        )
      ),
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
        (pending_occurrence_key IS NULL AND pending_observation_json IS NULL)
        OR (pending_occurrence_key IS NOT NULL AND pending_observation_json IS NOT NULL)
      ),
      CHECK(
        (definition_schema = 'ContinuousSubscriptionDefinition@1'
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
