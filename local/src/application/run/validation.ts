import { parseWorkRunIntent, workDigest } from "../../modules/run/intent.js";

/** Syntax and topology only: no runtime, identity resolution or authority checks. */
export function validateRunInput(value: unknown) {
  const intent = parseWorkRunIntent(value);
  return {
    status: "valid" as const,
    scope: "format" as const,
    intent,
    intentDigest: workDigest(intent),
    execution: {status: "requires_preflight" as const}
  };
}
