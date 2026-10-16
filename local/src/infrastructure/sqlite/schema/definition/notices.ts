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

export const noticesSchemaSql = `
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
`;
