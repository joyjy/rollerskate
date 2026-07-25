import type { ScheduleKind } from "./model.js";

const MINUTE_MS = 60_000;
const SEARCH_YEARS = 5;
const OFFSET_WINDOW_MS = 36 * 60 * 60 * 1_000;

interface LocalMinute {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

interface CronField {
  readonly values: ReadonlySet<number>;
  readonly wildcard: boolean;
}

interface ParsedCron {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

export interface ScheduledOccurrence {
  readonly scheduledFor: string;
  readonly occurrenceKey: string;
  readonly missingLocalTime: boolean;
}

export function canonicalOnceExpression(expression: string): string {
  const value = expression.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/
    .exec(value);
  if (match === null) {
    throw new Error("once expression must be an RFC 3339 instant with Z or an explicit offset");
  }
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    match.slice(1).map(Number);
  const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  if (month! < 1 || month! > 12 || day! < 1 || day! > daysInMonth ||
    hour! > 23 || minute! > 59 || second! > 59 ||
    (offsetHour !== undefined && (offsetHour > 23 || offsetMinute! > 59))) {
    throw new Error("once expression is not a valid instant");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("once expression is not a valid instant");
  return new Date(milliseconds).toISOString();
}

export function requireIanaTimezone(timezone: string): string {
  const value = timezone.trim();
  if (value === "" || value.toUpperCase() === "UTC") {
    if (value.toUpperCase() === "UTC") return "UTC";
    throw new Error("cron timezone must be a non-empty IANA timezone");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
  } catch {
    throw new Error(`cron timezone is not a valid IANA timezone: ${value}`);
  }
  if (!value.includes("/")) {
    throw new Error(`cron timezone must be an IANA timezone name: ${value}`);
  }
  return value;
}

export function canonicalCronExpression(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron expression must contain exactly five fields");
  parseCron(fields);
  return fields.join(" ");
}

export function firstOccurrence(input: {
  readonly kind: ScheduleKind;
  readonly expression: string;
  readonly timezone?: string;
  readonly after: string;
}): ScheduledOccurrence | undefined {
  const after = iso(input.after, "after");
  if (input.kind === "once") {
    if (input.timezone !== undefined) throw new Error("once schedule must not define timezone");
    const scheduledFor = canonicalOnceExpression(input.expression);
    return Date.parse(scheduledFor) > Date.parse(after)
      ? {
          scheduledFor,
          occurrenceKey: scheduledFor,
          missingLocalTime: false
        }
      : undefined;
  }
  if (input.timezone === undefined) throw new Error("cron schedule requires timezone");
  return nextCronOccurrence(input.expression, input.timezone, after);
}

export function nextCronOccurrence(
  expression: string,
  timezone: string,
  after: string
): ScheduledOccurrence {
  const canonical = canonicalCronExpression(expression);
  const zone = requireIanaTimezone(timezone);
  const afterInstant = Date.parse(iso(after, "after"));
  const cron = parseCron(canonical.split(" "));
  const localAfter = localMinute(afterInstant, zone);
  let wall = Date.UTC(
    localAfter.year,
    localAfter.month - 1,
    localAfter.day,
    localAfter.hour,
    localAfter.minute
  ) + MINUTE_MS;
  const wallLimit = wall + SEARCH_YEARS * 366 * 24 * 60 * MINUTE_MS;

  for (; wall <= wallLimit; wall += MINUTE_MS) {
    const candidate = utcMinute(wall);
    if (!matchesCron(cron, candidate)) continue;
    const resolved = resolveLocalMinute(candidate, zone);
    if (resolved === undefined || resolved.instant <= afterInstant) continue;
    const localKey = formatLocalMinute(candidate);
    return {
      scheduledFor: new Date(resolved.instant).toISOString(),
      occurrenceKey: `cron-v1:${zone}:${localKey}`,
      missingLocalTime: resolved.missing
    };
  }
  throw new Error(`cron expression has no occurrence within ${SEARCH_YEARS} years`);
}

export function latestCronOccurrence(
  expression: string,
  timezone: string,
  at: string
): ScheduledOccurrence {
  const canonical = canonicalCronExpression(expression);
  const zone = requireIanaTimezone(timezone);
  const atInstant = Date.parse(iso(at, "at"));
  const cron = parseCron(canonical.split(" "));
  const localStart = localMinute(atInstant + 4 * 60 * MINUTE_MS, zone);
  let wall = Date.UTC(
    localStart.year,
    localStart.month - 1,
    localStart.day,
    localStart.hour,
    localStart.minute
  );
  const wallLimit = wall - SEARCH_YEARS * 366 * 24 * 60 * MINUTE_MS;

  for (; wall >= wallLimit; wall -= MINUTE_MS) {
    const candidate = utcMinute(wall);
    if (!matchesCron(cron, candidate)) continue;
    const resolved = resolveLocalMinute(candidate, zone);
    if (resolved === undefined || resolved.instant > atInstant) continue;
    return {
      scheduledFor: new Date(resolved.instant).toISOString(),
      occurrenceKey: `cron-v1:${zone}:${formatLocalMinute(candidate)}`,
      missingLocalTime: resolved.missing
    };
  }
  throw new Error(`cron expression has no occurrence within ${SEARCH_YEARS} years`);
}

function parseCron(fields: readonly string[]): ParsedCron {
  return {
    minute: parseField(fields[0]!, 0, 59, "minute"),
    hour: parseField(fields[1]!, 0, 23, "hour"),
    dayOfMonth: parseField(fields[2]!, 1, 31, "day-of-month"),
    month: parseField(fields[3]!, 1, 12, "month"),
    dayOfWeek: parseField(fields[4]!, 0, 6, "day-of-week")
  };
}

function parseField(
  source: string,
  minimum: number,
  maximum: number,
  name: string
): CronField {
  if (!/^[0-9*,/-]+$/.test(source)) {
    throw new Error(`cron ${name} contains unsupported syntax`);
  }
  const values = new Set<number>();
  for (const item of source.split(",")) {
    if (item === "") throw new Error(`cron ${name} contains an empty list item`);
    const [rangeSource, stepSource, ...extra] = item.split("/");
    if (extra.length > 0 || rangeSource === undefined) {
      throw new Error(`cron ${name} has an invalid step`);
    }
    const step = stepSource === undefined
      ? 1
      : integer(stepSource, 1, maximum - minimum + 1, `cron ${name} step`);
    let start: number;
    let end: number;
    if (rangeSource === "*") {
      start = minimum;
      end = maximum;
    } else if (rangeSource.includes("-")) {
      const parts = rangeSource.split("-");
      if (parts.length !== 2) throw new Error(`cron ${name} has an invalid range`);
      start = integer(parts[0]!, minimum, maximum, `cron ${name}`);
      end = integer(parts[1]!, minimum, maximum, `cron ${name}`);
      if (start > end) throw new Error(`cron ${name} range must be ascending`);
    } else {
      start = integer(rangeSource, minimum, maximum, `cron ${name}`);
      end = stepSource === undefined ? start : maximum;
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return { values, wildcard: source === "*" || source.startsWith("*/") };
}

function integer(source: string, minimum: number, maximum: number, field: string): number {
  if (!/^\d+$/.test(source)) throw new Error(`${field} must be an integer`);
  const value = Number(source);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function matchesCron(cron: ParsedCron, value: LocalMinute): boolean {
  if (!cron.minute.values.has(value.minute) ||
    !cron.hour.values.has(value.hour) ||
    !cron.month.values.has(value.month)) {
    return false;
  }
  const dayOfMonth = cron.dayOfMonth.values.has(value.day);
  const dayOfWeek = cron.dayOfWeek.values.has(
    new Date(Date.UTC(value.year, value.month - 1, value.day)).getUTCDay()
  );
  if (cron.dayOfMonth.wildcard && cron.dayOfWeek.wildcard) return true;
  if (cron.dayOfMonth.wildcard) return dayOfWeek;
  if (cron.dayOfWeek.wildcard) return dayOfMonth;
  return dayOfMonth || dayOfWeek;
}

function resolveLocalMinute(
  candidate: LocalMinute,
  timezone: string
): { readonly instant: number; readonly missing: boolean } | undefined {
  const naive = Date.UTC(
    candidate.year,
    candidate.month - 1,
    candidate.day,
    candidate.hour,
    candidate.minute
  );
  const offsets = new Set<number>();
  for (const sample of [naive - OFFSET_WINDOW_MS, naive, naive + OFFSET_WINDOW_MS]) {
    offsets.add(offsetMilliseconds(sample, timezone));
  }
  const exact = [...offsets]
    .map((offset) => naive - offset)
    .filter((instant) => sameMinute(localMinute(instant, timezone), candidate))
    .sort((left, right) => left - right);
  if (exact.length > 0) return { instant: exact[0]!, missing: false };

  const estimates = [...offsets].map((offset) => naive - offset);
  const start = Math.min(...estimates) - 3 * 60 * MINUTE_MS;
  const end = Math.max(...estimates) + 3 * 60 * MINUTE_MS;
  for (let instant = start; instant <= end; instant += MINUTE_MS) {
    const actual = localMinute(instant, timezone);
    if (sameDate(actual, candidate) && compareMinute(actual, candidate) >= 0) {
      return { instant, missing: true };
    }
  }
  return undefined;
}

function offsetMilliseconds(instant: number, timezone: string): number {
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
    year: "numeric"
  }).formatToParts(instant).find((part) => part.type === "timeZoneName")?.value;
  if (value === undefined || value === "GMT") return 0;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(value);
  if (match === null) throw new Error(`cannot resolve timezone offset for ${timezone}`);
  const sign = match[1] === "+" ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3])) * MINUTE_MS;
}

function localMinute(instant: number, timezone: string): LocalMinute {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(instant);
  const number = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (value === undefined) throw new Error(`cannot resolve local ${type} in ${timezone}`);
    return Number(value);
  };
  return {
    year: number("year"),
    month: number("month"),
    day: number("day"),
    hour: number("hour"),
    minute: number("minute")
  };
}

function utcMinute(instant: number): LocalMinute {
  const date = new Date(instant);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes()
  };
}

function formatLocalMinute(value: LocalMinute): string {
  return `${four(value.year)}-${two(value.month)}-${two(value.day)}T` +
    `${two(value.hour)}:${two(value.minute)}`;
}

function compareMinute(left: LocalMinute, right: LocalMinute): number {
  return localNumber(left) - localNumber(right);
}

function localNumber(value: LocalMinute): number {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute);
}

function sameMinute(left: LocalMinute, right: LocalMinute): boolean {
  return localNumber(left) === localNumber(right);
}

function sameDate(left: LocalMinute, right: LocalMinute): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

function iso(value: string, field: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${field} must be a valid instant`);
  return new Date(milliseconds).toISOString();
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

function four(value: number): string {
  return String(value).padStart(4, "0");
}
