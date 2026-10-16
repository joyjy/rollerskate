import { RuntimeStore } from "../../core/runtime/store.js";
import { LocalChatStore } from "../../infrastructure/sqlite/chat-store.js";
import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { answerRunHumanInTransaction, runHumanQuestion } from "../steward/human-input.js";
import { chatRunOriginSql } from "./work-origin.js";

/** Console adapter for an Owner answer. Chat owns the origin lookup and
 * message admission; Steward owns the versioned continuation and CAS. */
export function answerStewardRunFromConsole(
  repoRoot: string, runId: string, questionId: string, expectedVersion: number,
  answer: string, runtimeDirectory?: string, at = new Date().toISOString()
) {
  const database = openRuntimeDatabase(runtimePaths(repoRoot, runtimeDirectory).database);
  const runtime = new RuntimeStore(database);
  const runs = new AgentRunStore(database);
  const chat = new LocalChatStore(database);
  const foundation = new LocalFoundationStore(database, { migrate: false });
  try {
    return runtime.withImmediateTransaction(() => {
      const run = runs.requireProjection(runId);
      if (run.version !== expectedVersion) throw new Error("Run version changed; read the Run again before answering");
      const question = runHumanQuestion(run, runs, runtime, questionId, at);
      if (question?.status !== "pending" || question.runVersion !== expectedVersion) {
        throw new Error("Run question is no longer pending at this version");
      }
      const origin = database.prepare(`SELECT json_extract(dispatch.payload_json, '$.topicId') topic_id,
          json_extract(dispatch.payload_json, '$.sourceMessageEventId') source_message_id,
          dispatch.agent_id agent_id, agent.handle agent_handle
        FROM events dispatch JOIN agent_runs run ON ${chatRunOriginSql("dispatch")}
        JOIN agents agent ON agent.principal_id = dispatch.agent_id
        WHERE run.run_id = ? ORDER BY dispatch.created_at DESC LIMIT 1`).get(runId) as
        { topic_id: string; source_message_id: string; agent_id: string; agent_handle: string } | undefined;
      if (origin === undefined) throw new Error("Run has no Chat Owner origin for an answer");
      const local = foundation.foundation();
      if (local === undefined) throw new Error("Local foundation is not initialized");
      const message = chat.postOwnerMessageInTransaction({
        topicId: origin.topic_id,
        ownerPrincipalId: local.owner.principalId,
        body: answer,
        targets: [{ principalId: origin.agent_id, handle: origin.agent_handle }],
        replyToEventId: origin.source_message_id,
        at
      });
      return answerRunHumanInTransaction({
        runtime, runs, run, questionId, expectedVersion,
        sourceMessageEventId: message.message.eventId, at
      });
    });
  } finally { foundation.close(); chat.close(); runs.close(); runtime.close(); database.close(); }
}
