import { describe, expect, it, vi } from "vitest";
import * as v from "valibot";

import { boundedError, requestJson } from "@/api/client";

describe("requestJson", () => {
  it("validates nested Console API responses before returning them", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      runtime: { status: 42 }
    })));

    await expect(requestJson("/api/test", v.object({
      runtime: v.object({ status: v.string() })
    }))).rejects.toThrow("Invalid Console API response at runtime.status");
  });

  it("uses bounded API errors instead of rendering an unbounded payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { error: "not allowed" },
      { status: 403 }
    )));

    await expect(requestJson("/api/test", v.object({ ok: v.boolean() })))
      .rejects.toMatchObject({ message: "not allowed", status: 403 });
    expect(boundedError("x".repeat(900))).toHaveLength(500);
  });
});
