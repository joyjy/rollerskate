import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, type Ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as v from "valibot";

import { useApi } from "@/composables/useApi";
import { useMutation } from "@/composables/useMutation";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useApi", () => {
  it("keeps the latest refresh when an older response finishes last", async () => {
    const pending: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      pending.push(resolve);
    })));
    let query!: TestQuery;
    const schema = v.object({ value: v.string() });
    const wrapper = mount(defineComponent({
      setup() {
        query = useApi({ url: "/api/test", schema });
        return () => h("div");
      }
    }));

    await nextTick();
    const latest = query!.refresh();
    pending[1]!(Response.json({ value: "latest" }));
    await latest;
    pending[0]!(Response.json({ value: "stale" }));
    await flushPromises();

    expect(query!.data.value).toEqual({ value: "latest" });
    wrapper.unmount();
  });

  it("preserves prior data and marks it stale after a background schema error", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ value: "valid" }))
      .mockResolvedValueOnce(Response.json({ value: 7 }));
    vi.stubGlobal("fetch", fetchMock);
    let query!: TestQuery;
    const schema = v.object({ value: v.string() });
    const wrapper = mount(defineComponent({
      setup() {
        query = useApi({ url: "/api/test", schema });
        return () => h("div");
      }
    }));

    await flushPromises();
    await query!.refresh();

    expect(query!.data.value).toEqual({ value: "valid" });
    expect(query!.stale.value).toBe(true);
    expect(query!.error.value).toContain("Invalid Console API response");
    wrapper.unmount();
  });

  it("pauses polling while hidden and refreshes immediately when visible", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const fetchMock = vi.fn(async () => Response.json({ value: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const schema = v.object({ value: v.string() });
    const wrapper = mount(defineComponent({
      setup() {
        useApi({ url: "/api/test", schema, interval: 1_000 });
        return () => h("div");
      }
    }));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    visibility = "hidden";
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
});

describe("useMutation", () => {
  it("exposes pending state and refreshes only after a successful mutation", async () => {
    const gate = deferred<string>();
    const refresh = vi.fn(async () => undefined);
    const mutation = useMutation({
      execute: async () => gate.promise,
      refresh
    });

    const result = mutation.execute(undefined);
    expect(mutation.pending.value).toBe(true);
    gate.resolve("done");
    await expect(result).resolves.toBe("done");
    expect(refresh).toHaveBeenCalledOnce();
    expect(mutation.pending.value).toBe(false);
  });

  it("returns a local bounded error without refreshing on failure", async () => {
    const refresh = vi.fn(async () => undefined);
    const mutation = useMutation({
      execute: async () => {
        throw new Error("mutation failed");
      },
      refresh
    });

    await expect(mutation.execute(undefined)).resolves.toBeNull();
    expect(mutation.error.value).toBe("mutation failed");
    expect(refresh).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

interface TestQuery {
  readonly data: Ref<{ value: string } | null>;
  readonly error: Ref<string | null>;
  readonly stale: Ref<boolean>;
  readonly refresh: () => Promise<void>;
}
