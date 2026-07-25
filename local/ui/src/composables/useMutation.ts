import { ref } from "vue";

import { boundedError } from "@/api/client";

export interface UseMutationOptions<T, P> {
  readonly execute: (payload: P, signal: AbortSignal) => Promise<T>;
  readonly refresh?: () => Promise<void>;
}

export function useMutation<T, P>(options: UseMutationOptions<T, P>) {
  const pending = ref(false);
  const error = ref<string | null>(null);
  let controller: AbortController | null = null;

  async function execute(payload: P): Promise<T | null> {
    if (pending.value) return null;
    pending.value = true;
    error.value = null;
    controller = new AbortController();
    try {
      const result = await options.execute(payload, controller.signal);
      await options.refresh?.();
      return result;
    } catch (reason) {
      if (!controller.signal.aborted) error.value = boundedError(reason);
      return null;
    } finally {
      pending.value = false;
    }
  }

  return { pending, error, execute };
}
