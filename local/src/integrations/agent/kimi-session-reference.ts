export type KimiSessionAccess = "read" | "write";

export const kimiSessionReferenceVersion = "rollerskate-kimi-session-v1";

export function kimiProviderSessionId(
  reference: string | undefined,
  access?: KimiSessionAccess
): string | undefined {
  if (reference === undefined) return undefined;
  const match = /^rollerskate-kimi-session-v1:(read|write):(.+)$/.exec(reference);
  if (match === null || (access !== undefined && match[1] !== access)) return undefined;
  return match[2];
}

export function kimiSessionReference(
  access: KimiSessionAccess,
  providerSessionId: string
): string {
  return `${kimiSessionReferenceVersion}:${access}:${providerSessionId}`;
}
