const MAX_INPUT_BYTES = 1_048_576;
const MAX_WRAPPER_BYTES = 4_096;

export function parseBoundedJsonObject(
  input: string,
  invalidMessage: string
): Readonly<Record<string, unknown>> {
  if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) {
    throw new Error(invalidMessage);
  }
  const direct = jsonObject(input);
  if (direct !== undefined) return direct;

  const fenced = /^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/iu.exec(input);
  const unwrapped = fenced === null ? undefined : jsonObject(fenced[1]!);
  if (unwrapped !== undefined) return unwrapped;

  const candidates = jsonObjectCandidates(input);
  if (candidates.length !== 1) throw new Error(invalidMessage);
  const candidate = candidates[0]!;
  const wrapper = input.slice(0, candidate.start) + input.slice(candidate.end);
  if (Buffer.byteLength(wrapper, "utf8") > MAX_WRAPPER_BYTES) {
    throw new Error(invalidMessage);
  }
  return candidate.value;
}

function jsonObject(input: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const value = JSON.parse(input) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function jsonObjectCandidates(input: string): Array<{
  readonly start: number;
  readonly end: number;
  readonly value: Readonly<Record<string, unknown>>;
}> {
  const candidates: Array<{
    readonly start: number;
    readonly end: number;
    readonly value: Readonly<Record<string, unknown>>;
  }> = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (start < 0) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        const value = jsonObject(input.slice(start, index + 1));
        if (value !== undefined) {
          candidates.push({ start, end: index + 1, value });
        }
        start = -1;
      }
    }
  }
  return candidates;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
