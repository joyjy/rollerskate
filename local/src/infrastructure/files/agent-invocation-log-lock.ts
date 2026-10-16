import { closeSync, constants, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Short registration/maintenance lock. Never steal a lock whose owner may be alive.
 * A failed mutation may retain its lock as recovery evidence. */
export function withInvocationLogLock<T>(runtimeDirectory: string, action: () => T,
  options: {readonly preserveOnError?: () => boolean} = {}): T {
  const path = join(runtimeDirectory, "runs", ".maintenance.lock");
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let completed = false;
  try {
    const result = action();
    completed = true;
    return result;
  } finally {
    closeSync(fd);
    if (completed || options.preserveOnError?.() !== true) unlinkSync(path);
  }
}
