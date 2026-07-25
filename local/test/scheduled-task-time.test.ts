import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalCronExpression,
  canonicalOnceExpression,
  firstOccurrence,
  latestCronOccurrence,
  nextCronOccurrence,
  requireIanaTimezone
} from "../src/capabilities/scheduled-task/time.js";

test("one-shot requires an explicit RFC 3339 offset and canonicalizes UTC", () => {
  assert.equal(
    canonicalOnceExpression("2026-07-24T12:30:00+08:00"),
    "2026-07-24T04:30:00.000Z"
  );
  assert.throws(
    () => canonicalOnceExpression("2026-07-24T12:30:00"),
    /explicit offset/
  );
  assert.throws(
    () => canonicalOnceExpression("2026-02-30T12:30:00Z"),
    /valid instant/
  );
  assert.deepEqual(firstOccurrence({
    kind: "once",
    expression: "2026-07-24T12:30:00+08:00",
    after: "2026-07-24T04:00:00.000Z"
  }), {
    scheduledFor: "2026-07-24T04:30:00.000Z",
    occurrenceKey: "2026-07-24T04:30:00.000Z",
    missingLocalTime: false
  });
});

test("cron-v1 accepts the fixed numeric grammar and traditional DOM/DOW OR", () => {
  assert.equal(canonicalCronExpression("*/15 9-17 * * 1,3,5"), "*/15 9-17 * * 1,3,5");
  assert.throws(() => canonicalCronExpression("@daily"), /five fields/);
  assert.throws(() => canonicalCronExpression("0 9 L * *"), /unsupported syntax/);
  assert.deepEqual(
    nextCronOccurrence("0 9 25 * 1", "Asia/Shanghai", "2026-07-26T00:00:00.000Z"),
    {
      scheduledFor: "2026-07-27T01:00:00.000Z",
      occurrenceKey: "cron-v1:Asia/Shanghai:2026-07-27T09:00",
      missingLocalTime: false
    }
  );
});

test("cron-v1 uses an IANA timezone", () => {
  assert.equal(requireIanaTimezone("America/New_York"), "America/New_York");
  assert.equal(requireIanaTimezone("UTC"), "UTC");
  assert.throws(() => requireIanaTimezone("EST"), /IANA timezone name/);
  assert.throws(() => requireIanaTimezone("Mars/Olympus"), /not a valid IANA timezone/);
});

test("DST repeated local minute chooses the earlier offset and dedupes the later instant", () => {
  assert.deepEqual(
    nextCronOccurrence("30 1 * * *", "America/New_York", "2026-10-31T12:00:00.000Z"),
    {
      scheduledFor: "2026-11-01T05:30:00.000Z",
      occurrenceKey: "cron-v1:America/New_York:2026-11-01T01:30",
      missingLocalTime: false
    }
  );
  assert.deepEqual(
    nextCronOccurrence("30 1 * * *", "America/New_York", "2026-11-01T05:30:00.000Z"),
    {
      scheduledFor: "2026-11-02T06:30:00.000Z",
      occurrenceKey: "cron-v1:America/New_York:2026-11-02T01:30",
      missingLocalTime: false
    }
  );
});

test("DST missing local minute resolves to the transition boundary and remains explicit", () => {
  assert.deepEqual(
    nextCronOccurrence("30 2 * * *", "America/New_York", "2026-03-07T12:00:00.000Z"),
    {
      scheduledFor: "2026-03-08T07:00:00.000Z",
      occurrenceKey: "cron-v1:America/New_York:2026-03-08T02:30",
      missingLocalTime: true
    }
  );
});

test("latest cron occurrence is bounded and preserves canonical DST decisions", () => {
  assert.deepEqual(
    latestCronOccurrence("30 1 * * *", "America/New_York", "2026-11-01T06:15:00.000Z"),
    {
      scheduledFor: "2026-11-01T05:30:00.000Z",
      occurrenceKey: "cron-v1:America/New_York:2026-11-01T01:30",
      missingLocalTime: false
    }
  );
  assert.deepEqual(
    latestCronOccurrence("30 2 * * *", "America/New_York", "2026-03-08T07:05:00.000Z"),
    {
      scheduledFor: "2026-03-08T07:00:00.000Z",
      occurrenceKey: "cron-v1:America/New_York:2026-03-08T02:30",
      missingLocalTime: true
    }
  );
});
