import type { DatabaseSync } from "node:sqlite";
import { withImmediateTransaction } from "./transaction.js";

import { openInitializedRuntimeDatabase } from "./database.js";
import { migrateLocalDatabase } from "./schema/index.js";

export type NoticeDeliveryStatus =
  | "pending"
  | "delivering"
  | "retry_wait"
  | "delivered"
  | "failed";

export interface NoticeProjection {
  readonly noticeId: string;
  readonly sourceKind: "delivery";
  readonly sourceId: string;
  readonly title: string;
  readonly summary: string;
  readonly outcome: "succeeded" | "failed";
  readonly deliveryStatus: NoticeDeliveryStatus;
  readonly deliveryError: string | null;
  readonly eventId: string;
  readonly destinationId: string;
  readonly subscriptionId: string | null;
  readonly occurredAt: string;
  readonly deliveredAt: string | null;
  readonly projectionUpdatedAt: string;
  readonly readAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly stateUpdatedAt: string | null;
}

interface NoticeRow {
  notice_id: string;
  source_kind: "delivery";
  source_id: string;
  title: string;
  summary: string;
  outcome: "succeeded" | "failed";
  delivery_status: NoticeDeliveryStatus;
  delivery_error: string | null;
  event_id: string;
  destination_id: string;
  subscription_id: string | null;
  occurred_at: string;
  delivered_at: string | null;
  projection_updated_at: string;
  read_at: string | null;
  acknowledged_at: string | null;
  state_updated_at: string | null;
}

const NOTICE_SELECT = `
  SELECT * FROM notices
`;

const PROJECT_BASE = `
  INSERT INTO notices (
    notice_id, source_kind, source_id, title, summary, outcome,
    delivery_status, delivery_error, event_id, destination_id,
    subscription_id, occurred_at, delivered_at, projection_updated_at
  )
  SELECT
    'ntc1_' || deliveries.delivery_id,
    'delivery',
    deliveries.delivery_id,
    substr(COALESCE(
      NULLIF(trim(json_extract(deliveries.destination_address_json, '$.title')), ''),
      'Agent result'
    ), 1, 160),
    substr(COALESCE(events.output, events.error, ''), 1, 4096),
    events.outcome,
    deliveries.status,
    CASE
      WHEN deliveries.last_error IS NULL THEN NULL
      ELSE substr(deliveries.last_error, 1, 512)
    END,
    events.event_id,
    deliveries.destination_id,
    CASE
      WHEN json_type(deliveries.destination_address_json, '$.subscriptionId') = 'text'
      THEN substr(
        json_extract(deliveries.destination_address_json, '$.subscriptionId'),
        1,
        256
      )
      ELSE NULL
    END,
    events.created_at,
    CASE WHEN deliveries.status = 'delivered' THEN deliveries.updated_at ELSE NULL END,
    deliveries.updated_at
  FROM deliveries
  JOIN events
    ON events.event_id = deliveries.result_event_id
  WHERE deliveries.destination_kind = 'macos-notification'
    AND events.type = 'agent.result'
`;

const PROJECT_UPSERT = `
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
    projection_updated_at = excluded.projection_updated_at
`;

const PROJECT_ALL = `${PROJECT_BASE}${PROJECT_UPSERT}`;

export class NoticeStore {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string) {
    let needsBackfill = false;
    this.#database = openInitializedRuntimeDatabase(databasePath, (database) => {
      needsBackfill = database.prepare(`
        SELECT 1 AS present
        FROM sqlite_master
        WHERE type = 'table' AND name = 'notices'
      `).get() === undefined;
      migrateLocalDatabase(database);
    });
    if (needsBackfill) this.#projectAll();
  }

  public close(): void {
    this.#database.close();
  }

  public list(limit = 100): readonly NoticeProjection[] {
    return (this.#database.prepare(`
      ${NOTICE_SELECT}
      ORDER BY occurred_at DESC, notice_id DESC
      LIMIT ?
    `).all(bounded(limit, 1, 1_000, "notice limit")) as unknown as NoticeRow[])
      .map(mapNotice);
  }

  public get(noticeId: string): NoticeProjection | undefined {
    const row = this.#database.prepare(`
      ${NOTICE_SELECT}
      WHERE notice_id = ?
    `).get(requireNoticeId(noticeId)) as NoticeRow | undefined;
    return row === undefined ? undefined : mapNotice(row);
  }

  public require(noticeId: string): NoticeProjection {
    const notice = this.get(noticeId);
    if (notice === undefined) throw new Error(`Notice not found: ${noticeId}`);
    return notice;
  }

  public counts(): {
    readonly total: number;
    readonly unread: number;
    readonly unacknowledged: number;
  } {
    const row = this.#database.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread,
        SUM(CASE WHEN acknowledged_at IS NULL THEN 1 ELSE 0 END)
          AS unacknowledged
      FROM notices
    `).get() as {
      total: number;
      unread: number | null;
      unacknowledged: number | null;
    };
    return {
      total: Number(row.total),
      unread: Number(row.unread ?? 0),
      unacknowledged: Number(row.unacknowledged ?? 0)
    };
  }

  public markRead(
    noticeId: string,
    at = new Date().toISOString()
  ): NoticeProjection {
    const id = this.require(noticeId).noticeId;
    const timestamp = iso(at);
    this.#database.prepare(`
      UPDATE notices
      SET read_at = COALESCE(read_at, ?),
        state_updated_at = CASE
          WHEN read_at IS NULL THEN ?
          ELSE state_updated_at
        END
      WHERE notice_id = ?
    `).run(timestamp, timestamp, id);
    return this.require(id);
  }

  public acknowledge(
    noticeId: string,
    at = new Date().toISOString()
  ): NoticeProjection {
    const id = this.require(noticeId).noticeId;
    const timestamp = iso(at);
    this.#database.prepare(`
      UPDATE notices
      SET read_at = COALESCE(read_at, ?),
        acknowledged_at = COALESCE(acknowledged_at, ?),
        state_updated_at = CASE
          WHEN read_at IS NULL OR acknowledged_at IS NULL THEN ?
          ELSE state_updated_at
        END
      WHERE notice_id = ?
    `).run(timestamp, timestamp, timestamp, id);
    return this.require(id);
  }

  public rebuildIndex(): {
    readonly projected: number;
    readonly preservedStates: number;
  } {
    return withImmediateTransaction(this.#database, () => {
      this.#projectAll();
      const projected = Number((this.#database.prepare(`
        SELECT COUNT(*) AS count FROM notices
      `).get() as { count: number }).count);
      const preservedStates = Number((this.#database.prepare(`
        SELECT COUNT(*) AS count FROM notices
        WHERE read_at IS NOT NULL OR acknowledged_at IS NOT NULL
      `).get() as { count: number }).count);
      return { projected, preservedStates };
    });
  }

  #projectAll(): void {
    this.#database.prepare(PROJECT_ALL).run();
  }

}

function mapNotice(row: NoticeRow): NoticeProjection {
  return {
    noticeId: row.notice_id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    title: row.title,
    summary: row.summary,
    outcome: row.outcome,
    deliveryStatus: row.delivery_status,
    deliveryError: row.delivery_error,
    eventId: row.event_id,
    destinationId: row.destination_id,
    subscriptionId: row.subscription_id,
    occurredAt: row.occurred_at,
    deliveredAt: row.delivered_at,
    projectionUpdatedAt: row.projection_updated_at,
    readAt: row.read_at,
    acknowledgedAt: row.acknowledged_at,
    stateUpdatedAt: row.state_updated_at
  };
}

function requireNoticeId(value: string): string {
  if (!/^ntc1_del_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    .test(value)) {
    throw new Error(`noticeId must be a deterministic Delivery Notice ID: ${value}`);
  }
  return value;
}

function iso(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`invalid ISO timestamp: ${value}`);
  return new Date(value).toISOString();
}

function bounded(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
