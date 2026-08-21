import { z } from "zod";

export const identifierSchema = z.string().trim().min(1).max(255);
export const timestampSchema = z.iso.datetime({ offset: true });

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export const principalReferenceSchema = z.object({
  kind: z.enum(["human", "device", "agent", "server"]),
  id: identifierSchema
}).strict();

export const eventEnvelopeSchema = z.object({
  protocolVersion: z.literal(1),
  eventId: identifierSchema,
  type: identifierSchema,
  occurredAt: timestampSchema,
  traceId: identifierSchema.optional(),
  source: principalReferenceSchema,
  subject: principalReferenceSchema.optional(),
  payload: jsonValueSchema,
  adapter: z.object({
    transport: identifierSchema,
    metadata: z.record(z.string(), jsonValueSchema)
  }).strict().optional()
}).strict();

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
