export const workflowsSchemaSql = `
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
`;
