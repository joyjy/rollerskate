import * as v from "valibot";

export const errorResponseSchema = v.looseObject({
  error: v.optional(v.string())
});
