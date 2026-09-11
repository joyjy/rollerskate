/** Shared diagnostics carry locations, never resolved environment values or credentials. */
export interface Diagnostic {
  readonly code: string;
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
  readonly fix: string;
}

export class ValidationError extends Error {
  constructor(readonly diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map(issue => `${issue.field}: ${issue.actual}. ${issue.fix}`).join("; "));
  }
}

export function diagnostic(code: string, field: string, expected: string, actual: string, fix: string): Diagnostic {
  return { code, field, expected, actual, fix };
}

export function check<T>(issues: Diagnostic[], field: string, code: string, expected: string, fix: string, read: () => T): T | undefined {
  try { return read(); }
  catch (error) {
    if (error instanceof ValidationError) issues.push(...error.diagnostics);
    else issues.push(diagnostic(code, field, expected, error instanceof Error ? error.message : String(error), fix));
    return undefined;
  }
}
