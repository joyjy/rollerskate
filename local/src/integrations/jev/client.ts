import { readFileSync } from "node:fs";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAX_BYTES = 131_072;
export class JevError extends Error {
  constructor(readonly code: string) { super(`Jev ${code}`); }
}

export function readJevKey(path: string): string {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { throw new JevError("credential_unavailable"); }
  for (const line of text.split(/\r?\n/u)) {
    const match = /^(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/u.exec(line.trim());
    if (match?.[1]) {
      const key = match[1].replace(/^(['"])(.*)\1$/u, "$2");
      if (key && !/[\r\n]/u.test(key)) return key;
    }
  }
  throw new JevError("credential_unavailable");
}

export async function evaluateJev(request: unknown, options: {
  readonly key: () => string;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
  readonly signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  if (!record(request) || !('state' in request) || !record(request.questions) ||
    Object.keys(request).some(key => !["state", "questions", "model"].includes(key)) ||
    Object.keys(request.questions).length === 0 || Object.keys(request.questions).length > 32 ||
    (request.model !== undefined && (typeof request.model !== "string" || !request.model.trim()))) {
    throw new JevError("invalid_request");
  }
  for (const question of Object.values(request.questions)) {
    if (!record(question) || !["choice", "noul", "score"].includes(String(question.type)) ||
      !("instructions" in question)) throw new JevError("invalid_question");
  }
  const body = JSON.stringify({ ...request, model: request.model ?? "jev-latest" });
  if (Buffer.byteLength(body) > MAX_BYTES) throw new JevError("request_too_large");
  const deadline = AbortSignal.timeout(options.timeoutMilliseconds ?? 20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const key = options.key();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted) throw new JevError("cancelled_or_timeout");
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(ENDPOINT, {
        method: "POST", redirect: "error", signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body
      });
    } catch { throw new JevError(signal.aborted ? "cancelled_or_timeout" : "network_error"); }
    if ((response.status === 429 || response.status === 529) && attempt < 2) {
      await response.body?.cancel();
      await new Promise<void>((resolve, reject) => {
        const done = () => { signal.removeEventListener("abort", aborted); resolve(); };
        const timer = setTimeout(done, 500 * 2 ** attempt);
        const aborted = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); reject(new JevError("cancelled_or_timeout")); };
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      });
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new JevError(`http_${response.status}`); }
    const reader = response.body?.getReader();
    if (!reader) throw new JevError("invalid_response");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new JevError("response_too_large"); }
        chunks.push(chunk.value);
      }
    } catch (error) { if (error instanceof JevError) throw error; throw new JevError(signal.aborted ? "cancelled_or_timeout" : "response_interrupted"); }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new JevError("invalid_response"); }
    if (!record(value) || !record(value.answers) || typeof value.model !== "string" ||
      Object.keys(request.questions).some(id => !record(value.answers) || !record(value.answers[id]) ||
        (value.answers[id] as Record<string, unknown>).type !== (request.questions as Record<string, Record<string, unknown>>)[id]?.type)) {
      throw new JevError("invalid_response");
    }
    for (const [id, answer] of Object.entries(value.answers)) {
      const question = (request.questions as Record<string, unknown>)[id];
      if (!record(question) || !record(answer)) throw new JevError("invalid_response");
      const probability = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
      if (answer.type === "noul") {
        if (!probability(answer.noul)) throw new JevError("invalid_response");
      } else {
        if (!record(answer.probabilities) || !Object.values(answer.probabilities).every(probability) ||
          !probability(answer.confidence)) throw new JevError("invalid_response");
        if (answer.type === "choice" && (typeof answer.choice !== "string" ||
          !record(question.criteria) || !(answer.choice in question.criteria))) throw new JevError("invalid_response");
        if (answer.type === "score" && (typeof answer.score !== "number" || !Number.isFinite(answer.score) ||
          !record(answer.legend))) throw new JevError("invalid_response");
      }
    }
    return value;
  }
  throw new JevError("retry_exhausted");
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
