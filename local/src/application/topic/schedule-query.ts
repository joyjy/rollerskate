import { openRuntimeDatabaseReadOnly } from "../../infrastructure/sqlite/database.js";
import { assertCurrentLocalSchema } from "../../infrastructure/sqlite/schema/index.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { TopicActivationScheduleStore } from
  "../../infrastructure/sqlite/topic-activation-schedule-store.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";

export function localTopicActivationSchedules(
  repoRoot: string,
  runtimeDirectory?: string
) {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const database = openRuntimeDatabaseReadOnly(paths.database);
  try {
    assertCurrentLocalSchema(database);
    const store = new TopicActivationScheduleStore(database, { migrate: false });
    const foundation = new LocalFoundationStore(database, { migrate: false });
    const topic = foundation.foundation()?.topicId;
    return topic === undefined ? [] : store.list(topic).map((schedule) => ({
      schedule,
      receipts: store.receipts(schedule.scheduleId)
    }));
  } finally {
    database.close();
  }
}

export function localTopicActivationSchedule(
  repoRoot: string,
  scheduleId: string,
  runtimeDirectory?: string
) {
  const database = openRuntimeDatabaseReadOnly(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    assertCurrentLocalSchema(database);
    const store = new TopicActivationScheduleStore(database, { migrate: false });
    const schedule = store.require(scheduleId);
    return { schedule, receipts: store.receipts(scheduleId) };
  } finally {
    database.close();
  }
}
