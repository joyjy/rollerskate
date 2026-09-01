export const MAX_CONTRACT_TEXT = 16_384;
export const MAX_CONTRACT_LIST = 100;
export const MAX_CONTRACT_JSON_BYTES = 32_768;

export function contractRecord(
  value: unknown,
  field: string
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export function exactContractKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  field: string,
  optional: readonly string[] = []
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`${field} has unknown field: ${unknown}`);
  const missing = allowed.find((key) => !optional.includes(key) && !(key in value));
  if (missing !== undefined) throw new Error(`${field} is missing field: ${missing}`);
}

export function contractText(
  value: unknown,
  field: string,
  maximum = MAX_CONTRACT_TEXT
): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new Error(`${field} must be a non-empty string up to ${maximum} characters`);
  }
  return value;
}

export function contractInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

export function contractStringList(
  value: unknown,
  field: string,
  options: { readonly minimum?: number; readonly maximum?: number } = {}
): readonly string[] {
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? MAX_CONTRACT_LIST;
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${field} must contain ${minimum}-${maximum} strings`);
  }
  return value.map((item, index) => contractText(item, `${field}[${index}]`, 2_048));
}

export function boundedContractValue(value: unknown, field: string): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_CONTRACT_JSON_BYTES) {
    throw new Error(`${field} must be bounded JSON up to ${MAX_CONTRACT_JSON_BYTES} bytes`);
  }
  return value;
}

export function contractIso(value: unknown, field: string): string {
  const timestamp = contractText(value, field, 64);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${field} must be RFC3339`);
  return new Date(timestamp).toISOString();
}

export function stableContractJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableContractJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableContractJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
