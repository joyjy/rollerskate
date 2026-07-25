import {
  onBeforeUnmount,
  onMounted,
  ref,
  toValue,
  type Ref,
  type MaybeRefOrGetter
} from "vue";
import type * as v from "valibot";

import { boundedError, requestJson } from "@/api/client";

export interface UseApiOptions<
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>
> {
  readonly url: MaybeRefOrGetter<string>;
  readonly schema: TSchema;
  readonly interval?: number;
  readonly freshnessWindow?: number;
  readonly paused?: Ref<boolean>;
  readonly immediate?: boolean;
}
export function useApi<
  const TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>
>(options: UseApiOptions<TSchema>) {
  type Output = v.InferOutput<TSchema>;
  const data = ref<Output | null>(null);
  const loading = ref(options.immediate !== false);
  const refreshing = ref(false);
  const error = ref<string | null>(null);
  const stale = ref(false);
  let requestId = 0;
  let controller: AbortController | null = null;
  let pollTimer: number | undefined;
  let staleTimer: number | undefined;
  let disposed = false;

  async function refresh(): Promise<void> {
    if (disposed) return;
    const currentRequestId = ++requestId;
    controller?.abort();
    controller = new AbortController();
    if (data.value === null) loading.value = true;
    else refreshing.value = true;
    try {
      const result = await requestJson(toValue(options.url), options.schema, {
        signal: controller.signal
      });
      if (disposed || currentRequestId !== requestId) return;
      data.value = result;
      error.value = null;
      stale.value = false;
      scheduleStale();
    } catch (reason) {
      if (controller.signal.aborted || disposed || currentRequestId !== requestId) return;
      error.value = boundedError(reason);
      if (data.value !== null) stale.value = true;
    } finally {
      if (!disposed && currentRequestId === requestId) {
        loading.value = false;
        refreshing.value = false;
      }
    }
  }

  function scheduleStale() {
    window.clearTimeout(staleTimer);
    const windowMs = options.freshnessWindow ?? Math.max((options.interval ?? 0) * 2, 10_000);
    staleTimer = window.setTimeout(() => {
      stale.value = true;
    }, windowMs);
  }

  function shouldPoll(): boolean {
    return document.visibilityState === "visible" && options.paused?.value !== true;
  }

  function poll() {
    if (shouldPoll()) void refresh();
  }

  function onVisibilityChange() {
    if (document.visibilityState === "visible" && options.paused?.value !== true) {
      void refresh();
    }
  }

  onMounted(() => {
    if (options.immediate !== false) void refresh();
    if ((options.interval ?? 0) > 0) {
      pollTimer = window.setInterval(poll, options.interval);
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
  });

  onBeforeUnmount(() => {
    disposed = true;
    controller?.abort();
    window.clearInterval(pollTimer);
    window.clearTimeout(staleTimer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  });

  return { data, loading, refreshing, error, stale, refresh };
}
