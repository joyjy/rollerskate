export const chatProjectionSchemaSql = `
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
          WHERE event_id = chat_messages.event_id
        ),
        projected_at = NEW.updated_at
      WHERE EXISTS (
        SELECT 1
        FROM json_each(chat_messages.attention_json, '$.receipts') AS receipt
        WHERE json_extract(receipt.value, '$.dispatchEventId') = NEW.event_id
      );
    END;
`;
