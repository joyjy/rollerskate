import * as v from "valibot";

export const nullableString = v.nullable(v.string());
export const optionalString = v.optional(v.string());
export const stringRecord = v.record(v.string(), v.string());
