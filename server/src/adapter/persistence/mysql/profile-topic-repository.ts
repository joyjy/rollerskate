import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { topicEventSchema, topicPublisherIdentitySchema } from "@rollerskate/protocol";

import type {
  AgentPublicProfileRecord,
  TopicAgentMembershipRecord,
  TopicEventAppendRecord,
  TopicEventRecord,
  TopicHumanRoleRecord,
  TopicProfileRecord,
  TopicRuntimeSubscriptionRecord,
  TopicRecord
} from "../../../modules/profile-topic/model.js";
import type {
  CreateTopicInput,
  ProfileTopicRepository
} from "../../../modules/profile-topic/repository.js";

interface AgentProfileRow extends RowDataPacket {
  agent_id: string;
  display_name: string;
  role_text: string;
  disclosure: string;
  expression_rules: unknown;
  revision: number;
  updated_at: Date;
}

interface TopicRow extends RowDataPacket {
  id: string;
  name: string;
  visibility: "public" | "private";
  owner_human_id: string;
  created_at: Date;
}

interface TopicProfileRow extends RowDataPacket {
  topic_id: string;
  purpose: string;
  participation_rules: unknown;
  expression_rules: unknown;
  revision: number;
  updated_at: Date;
}

interface HumanRoleRow extends RowDataPacket {
  topic_id: string;
  human_id: string;
  role_name: "owner" | "admin";
  status: "active" | "revoked";
  created_at: Date;
  updated_at: Date;
}

interface AgentMembershipRow extends RowDataPacket {
  topic_id: string;
  agent_id: string;
  status: "active" | "left";
  joined_by_human_id: string;
  created_at: Date;
  updated_at: Date;
}

interface RuntimeSubscriptionRow extends RowDataPacket {
  topic_id: string;
  runtime_id: string;
  status: "active" | "inactive";
  cursor_sequence: number;
  created_at: Date;
  updated_at: Date;
}

interface TopicEventRow extends RowDataPacket {
  event_id: string;
  topic_id: string;
  sequence_number: number;
  publisher_kind: "human" | "agent";
  publisher_id: string;
  publisher_snapshot: unknown;
  transaction_id: string;
  body: string;
  agent_profile_revision: number | null;
  topic_profile_revision: number;
  created_at: Date;
}

interface RuntimeViewRow extends RuntimeSubscriptionRow {
  agent_id: string | null;
}

export class MysqlProfileTopicRepository implements ProfileTopicRepository {
  readonly #pool: Pool;

  public constructor(pool: Pool) {
    this.#pool = pool;
  }

  public async getAgentPublicProfile(
    agentId: string
  ): Promise<AgentPublicProfileRecord | undefined> {
    const [rows] = await this.#pool.execute<AgentProfileRow[]>(`
      SELECT * FROM agent_public_profiles WHERE agent_id = ?
    `, [agentId]);
    return rows[0] === undefined ? undefined : agentProfile(rows[0]);
  }

  public async putAgentPublicProfile(
    profile: AgentPublicProfileRecord,
    expectedRevision: number
  ): Promise<AgentPublicProfileRecord | undefined> {
    if (expectedRevision === 0) {
      const [result] = await this.#pool.execute<ResultSetHeader>(`
        INSERT IGNORE INTO agent_public_profiles (
          agent_id, display_name, role_text, disclosure, expression_rules,
          revision, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?)
      `, [
        profile.agentId, profile.displayName, profile.role, profile.disclosure,
        JSON.stringify(profile.expressionRules), sqlDate(profile.updatedAt)
      ]);
      if (result.affectedRows !== 1) return undefined;
    } else {
      const [result] = await this.#pool.execute<ResultSetHeader>(`
        UPDATE agent_public_profiles SET display_name = ?, role_text = ?,
          disclosure = ?, expression_rules = ?, revision = revision + 1, updated_at = ?
        WHERE agent_id = ? AND revision = ?
      `, [
        profile.displayName, profile.role, profile.disclosure,
        JSON.stringify(profile.expressionRules), sqlDate(profile.updatedAt),
        profile.agentId, expectedRevision
      ]);
      if (result.affectedRows !== 1) return undefined;
    }
    return this.getAgentPublicProfile(profile.agentId);
  }

  public async createTopic(input: CreateTopicInput): Promise<void> {
    const connection = await this.#pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(`
        INSERT INTO topics (id, name, visibility, owner_human_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `, [
        input.topic.id, input.topic.name, input.topic.visibility,
        input.topic.ownerHumanId, sqlDate(input.topic.createdAt)
      ]);
      await connection.execute(`
        INSERT INTO topic_profiles (
          topic_id, purpose, participation_rules, expression_rules, revision, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?)
      `, [
        input.profile.topicId, input.profile.purpose,
        JSON.stringify(input.profile.participationRules),
        JSON.stringify(input.profile.expressionRules), sqlDate(input.profile.updatedAt)
      ]);
      await connection.execute(`
        INSERT INTO topic_human_roles (
          topic_id, human_id, role_name, status, created_at, updated_at
        ) VALUES (?, ?, 'owner', 'active', ?, ?)
      `, [
        input.owner.topicId, input.owner.humanId,
        sqlDate(input.owner.createdAt), sqlDate(input.owner.updatedAt)
      ]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  public async listTopicsForHuman(humanId: string): Promise<readonly TopicRecord[]> {
    const [rows] = await this.#pool.execute<TopicRow[]>(`
      SELECT topic.*
      FROM topics AS topic
      JOIN topic_human_roles AS role ON role.topic_id = topic.id
      WHERE role.human_id = ? AND role.status = 'active'
      ORDER BY topic.created_at DESC, topic.id
    `, [humanId]);
    return rows.map(topicRecord);
  }

  public async getTopic(topicId: string): Promise<TopicRecord | undefined> {
    const [rows] = await this.#pool.execute<TopicRow[]>("SELECT * FROM topics WHERE id = ?", [topicId]);
    const row = rows[0];
    return row === undefined ? undefined : topicRecord(row);
  }

  public async getTopicProfile(topicId: string): Promise<TopicProfileRecord | undefined> {
    const [rows] = await this.#pool.execute<TopicProfileRow[]>(`
      SELECT * FROM topic_profiles WHERE topic_id = ?
    `, [topicId]);
    return rows[0] === undefined ? undefined : topicProfile(rows[0]);
  }

  public async putTopicProfile(
    profile: TopicProfileRecord,
    expectedRevision: number
  ): Promise<TopicProfileRecord | undefined> {
    const [result] = await this.#pool.execute<ResultSetHeader>(`
      UPDATE topic_profiles SET purpose = ?, participation_rules = ?,
        expression_rules = ?, revision = revision + 1, updated_at = ?
      WHERE topic_id = ? AND revision = ?
    `, [
      profile.purpose, JSON.stringify(profile.participationRules),
      JSON.stringify(profile.expressionRules), sqlDate(profile.updatedAt),
      profile.topicId, expectedRevision
    ]);
    return result.affectedRows === 1 ? this.getTopicProfile(profile.topicId) : undefined;
  }

  public async getTopicHumanRole(
    topicId: string,
    humanId: string
  ): Promise<TopicHumanRoleRecord | undefined> {
    const [rows] = await this.#pool.execute<HumanRoleRow[]>(`
      SELECT * FROM topic_human_roles WHERE topic_id = ? AND human_id = ?
    `, [topicId, humanId]);
    const row = rows[0];
    return row === undefined ? undefined : {
      topicId: row.topic_id,
      humanId: row.human_id,
      role: row.role_name,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString()
    };
  }

  public async getTopicAgentMembership(
    topicId: string,
    agentId: string
  ): Promise<TopicAgentMembershipRecord | undefined> {
    const [rows] = await this.#pool.execute<AgentMembershipRow[]>(`
      SELECT * FROM topic_agent_memberships WHERE topic_id = ? AND agent_id = ?
    `, [topicId, agentId]);
    return rows[0] === undefined ? undefined : agentMembership(rows[0]);
  }

  public async joinTopic(
    membership: TopicAgentMembershipRecord,
    subscription: TopicRuntimeSubscriptionRecord
  ): Promise<{
    readonly membership: TopicAgentMembershipRecord;
    readonly subscription: TopicRuntimeSubscriptionRecord;
  }> {
    const connection = await this.#pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(`
        INSERT INTO topic_agent_memberships (
          topic_id, agent_id, status, joined_by_human_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE status = 'active', updated_at = VALUES(updated_at)
      `, [
        membership.topicId, membership.agentId, membership.status,
        membership.joinedByHumanId, sqlDate(membership.createdAt), sqlDate(membership.updatedAt)
      ]);
      await connection.execute(`
        INSERT INTO topic_runtime_subscriptions (
          topic_id, runtime_id, status, cursor_sequence, created_at, updated_at
        ) VALUES (?, ?, 'active', 0, ?, ?)
        ON DUPLICATE KEY UPDATE status = 'active', updated_at = VALUES(updated_at)
      `, [
        subscription.topicId, subscription.runtimeId,
        sqlDate(subscription.createdAt), sqlDate(subscription.updatedAt)
      ]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return {
      membership: (await this.getTopicAgentMembership(membership.topicId, membership.agentId))!,
      subscription: (await this.getTopicRuntimeSubscription(
        subscription.topicId,
        subscription.runtimeId
      ))!
    };
  }

  public async getTopicRuntimeSubscription(
    topicId: string,
    runtimeId: string
  ): Promise<TopicRuntimeSubscriptionRecord | undefined> {
    const [rows] = await this.#pool.execute<RuntimeSubscriptionRow[]>(`
      SELECT * FROM topic_runtime_subscriptions WHERE topic_id = ? AND runtime_id = ?
    `, [topicId, runtimeId]);
    const row = rows[0];
    return row === undefined ? undefined : runtimeSubscription(row);
  }

  public async listTopicRuntimeViews(runtimeId: string) {
    const [rows] = await this.#pool.execute<RuntimeViewRow[]>(`
      SELECT subscription.*, membership.agent_id
      FROM topic_runtime_subscriptions AS subscription
      LEFT JOIN topic_agent_memberships AS membership
        ON membership.topic_id = subscription.topic_id AND membership.status = 'active'
      LEFT JOIN placements AS placement
        ON placement.agent_id = membership.agent_id
       AND placement.device_id = subscription.runtime_id
       AND placement.state = 'active'
      WHERE subscription.runtime_id = ? AND subscription.status = 'active'
        AND (membership.agent_id IS NULL OR placement.id IS NOT NULL)
      ORDER BY subscription.topic_id, membership.agent_id
    `, [runtimeId]);
    const views = new Map<string, {
      subscription: TopicRuntimeSubscriptionRecord;
      agentIds: string[];
    }>();
    for (const row of rows) {
      const view = views.get(row.topic_id) ?? {
        subscription: runtimeSubscription(row),
        agentIds: []
      };
      if (row.agent_id !== null) view.agentIds.push(row.agent_id);
      views.set(row.topic_id, view);
    }
    return [...views.values()];
  }

  public async advanceTopicRuntimeCursor(
    topicId: string,
    runtimeId: string,
    cursor: number,
    updatedAt: string
  ): Promise<TopicRuntimeSubscriptionRecord | undefined> {
    const [result] = await this.#pool.execute<ResultSetHeader>(`
      UPDATE topic_runtime_subscriptions AS subscription
      JOIN topics AS topic ON topic.id = subscription.topic_id
      SET subscription.updated_at = IF(subscription.cursor_sequence < ?, ?, subscription.updated_at),
          subscription.cursor_sequence = GREATEST(subscription.cursor_sequence, ?)
      WHERE subscription.topic_id = ? AND subscription.runtime_id = ?
        AND subscription.status = 'active' AND ? <= topic.head_sequence
    `, [cursor, sqlDate(updatedAt), cursor, topicId, runtimeId, cursor]);
    if (result.affectedRows === 0) {
      const current = await this.getTopicRuntimeSubscription(topicId, runtimeId);
      if (current?.status === "active" && cursor <= current.cursor) return current;
      return undefined;
    }
    return this.getTopicRuntimeSubscription(topicId, runtimeId);
  }

  public async appendTopicEvent(
    event: TopicEventAppendRecord
  ): Promise<TopicEventRecord> {
    const connection = await this.#pool.getConnection();
    try {
      await connection.beginTransaction();
      const [existingRows] = await connection.execute<TopicEventRow[]>(`
        SELECT * FROM topic_events
        WHERE publisher_kind = ? AND publisher_id = ? AND transaction_id = ?
        FOR UPDATE
      `, [event.publisher.kind, publisherId(event), event.transactionId]);
      if (existingRows[0] !== undefined) {
        await connection.commit();
        return topicEvent(existingRows[0]);
      }
      const [topics] = await connection.execute<RowDataPacket[]>(`
        SELECT head_sequence FROM topics WHERE id = ? FOR UPDATE
      `, [event.topicId]);
      const head = Number((topics[0] as { head_sequence?: unknown } | undefined)?.head_sequence);
      if (!Number.isInteger(head) || head < 0) throw new Error(`Topic not found: ${event.topicId}`);
      const sequence = head + 1;
      await connection.execute(`
        INSERT INTO topic_events (
          event_id, topic_id, sequence_number, publisher_kind, publisher_id,
          publisher_snapshot, transaction_id, body, agent_profile_revision,
          topic_profile_revision, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        event.eventId, event.topicId, sequence, event.publisher.kind,
        publisherId(event), JSON.stringify(event.publisher), event.transactionId,
        event.body, event.publisher.kind === "agent" ? event.agentProfileRevision : null,
        event.topicProfileRevision, sqlDate(event.createdAt)
      ]);
      await connection.execute("UPDATE topics SET head_sequence = ? WHERE id = ?", [
        sequence,
        event.topicId
      ]);
      await connection.commit();
      return { ...event, sequence };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  public async listTopicEvents(
    topicId: string,
    runtimeId: string,
    after: number,
    limit: number
  ): Promise<{ readonly events: readonly TopicEventRecord[]; readonly head: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Topic Event page limit is invalid");
    }
    const [topics] = await this.#pool.execute<RowDataPacket[]>(`
      SELECT head_sequence FROM topics WHERE id = ?
    `, [topicId]);
    const head = Number((topics[0] as { head_sequence?: unknown } | undefined)?.head_sequence ?? 0);
    const [rows] = await this.#pool.execute<TopicEventRow[]>(`
      SELECT event.* FROM topic_events AS event
      JOIN topic_runtime_subscriptions AS subscription
        ON subscription.topic_id = event.topic_id
       AND subscription.runtime_id = ? AND subscription.status = 'active'
      WHERE event.topic_id = ? AND event.sequence_number > ?
      ORDER BY event.sequence_number LIMIT ${limit}
    `, [runtimeId, topicId, after]);
    return { events: rows.map(topicEvent), head };
  }
}

function agentProfile(row: AgentProfileRow): AgentPublicProfileRecord {
  return {
    agentId: row.agent_id,
    displayName: row.display_name,
    role: row.role_text,
    disclosure: row.disclosure,
    expressionRules: stringArray(row.expression_rules),
    revision: Number(row.revision),
    updatedAt: row.updated_at.toISOString()
  };
}

function topicProfile(row: TopicProfileRow): TopicProfileRecord {
  return {
    topicId: row.topic_id,
    purpose: row.purpose,
    participationRules: stringArray(row.participation_rules),
    expressionRules: stringArray(row.expression_rules),
    revision: Number(row.revision),
    updatedAt: row.updated_at.toISOString()
  };
}

function topicRecord(row: TopicRow): TopicRecord {
  return {
    id: row.id,
    name: row.name,
    visibility: row.visibility,
    ownerHumanId: row.owner_human_id,
    createdAt: row.created_at.toISOString()
  };
}

function agentMembership(row: AgentMembershipRow): TopicAgentMembershipRecord {
  return {
    topicId: row.topic_id,
    agentId: row.agent_id,
    status: row.status,
    joinedByHumanId: row.joined_by_human_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function runtimeSubscription(row: RuntimeSubscriptionRow): TopicRuntimeSubscriptionRecord {
  return {
    topicId: row.topic_id,
    runtimeId: row.runtime_id,
    status: row.status,
    cursor: Number(row.cursor_sequence),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function topicEvent(row: TopicEventRow): TopicEventRecord {
  const publisherValue = typeof row.publisher_snapshot === "string"
    ? JSON.parse(row.publisher_snapshot) as unknown
    : row.publisher_snapshot;
  const publisher = topicPublisherIdentitySchema.parse(publisherValue);
  return topicEventSchema.parse({
    eventId: row.event_id,
    topicId: row.topic_id,
    sequence: Number(row.sequence_number),
    publisher,
    transactionId: row.transaction_id,
    body: row.body,
    ...(publisher.kind === "agent"
      ? { agentProfileRevision: Number(row.agent_profile_revision) }
      : {}),
    topicProfileRevision: Number(row.topic_profile_revision),
    createdAt: row.created_at.toISOString()
  });
}

function publisherId(event: TopicEventAppendRecord): string {
  return event.publisher.kind === "agent"
    ? event.publisher.agentId
    : event.publisher.humanId;
}

function stringArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Profile rule snapshot is invalid");
  }
  return parsed;
}

function sqlDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("invalid profile timestamp");
  return date;
}
