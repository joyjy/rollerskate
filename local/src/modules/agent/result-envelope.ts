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
  if (candidates.length !== 1) {
    if (candidates.length === 0) {
      const source = fenced?.[1] ?? input;
      assertJsonSyntax(source, invalidMessage, Math.max(0, source.indexOf("{")));
    }
    throw new Error(invalidMessage);
  }
  const candidate = candidates[0]!;
  const wrapper = input.slice(0, candidate.start) + input.slice(candidate.end);
  if (Buffer.byteLength(wrapper, "utf8") > MAX_WRAPPER_BYTES) {
    throw new Error(invalidMessage);
  }
  return candidate.value;
}

// Keep source text out of error messages: V8 may quote input in SyntaxError.message.
function assertJsonSyntax(input: string, invalidMessage: string, start: number): void {
  try {
    JSON.parse(input.slice(start));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const match = /\bposition (\d+)/u.exec(error.message);
    const position = match === null
      ? (/end of JSON/u.test(error.message) ? input.length : undefined)
      : start + Number(match[1]);
    if (position === undefined) throw new SyntaxError(`${invalidMessage}: invalid JSON syntax`);
    const before = input.slice(0, position);
    const line = before.split("\n").length;
    const column = position - before.lastIndexOf("\n");
    throw new SyntaxError(`${invalidMessage}: JSON syntax error at character ${position} (line ${line}, column ${column})`);
  }
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
