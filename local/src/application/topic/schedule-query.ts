import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { TopicActivationScheduleStore } from
  "../../infrastructure/sqlite/topic-activation-schedule-store.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";

export function localTopicActivationSchedules(
  repoRoot: string,
  runtimeDirectory?: string
) {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const store = new TopicActivationScheduleStore(paths.database);
  const foundation = new LocalFoundationStore(paths.database);
  try {
    const topic = foundation.foundation()?.topicId;
    return topic === undefined ? [] : store.list(topic).map((schedule) => ({
      schedule,
      receipts: store.receipts(schedule.scheduleId)
    }));
  } finally {
    foundation.close();
    store.close();
  }
}

export function localTopicActivationSchedule(
  repoRoot: string,
  scheduleId: string,
  runtimeDirectory?: string
) {
  const store = new TopicActivationScheduleStore(
    runtimePaths(repoRoot, runtimeDirectory).database
  );
  try {
    const schedule = store.require(scheduleId);
    return { schedule, receipts: store.receipts(scheduleId) };
  } finally {
    store.close();
  }
}
