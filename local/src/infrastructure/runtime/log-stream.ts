import { basename, dirname } from "node:path";

import { createStream, type RotatingFileStream } from "rotating-file-stream";

const DEFAULT_MAX_LOG_BYTES = "5M";
const DEFAULT_ROTATED_FILES = 5;

export function createRuntimeLogStream(
  logPath: string,
  options: {
    readonly size?: `${number}${"B" | "K" | "M" | "G"}`;
    readonly rotate?: number;
  } = {}
): RotatingFileStream {
  return createStream(basename(logPath), {
    path: dirname(logPath),
    size: options.size ?? DEFAULT_MAX_LOG_BYTES,
    rotate: options.rotate ?? DEFAULT_ROTATED_FILES,
    mode: 0o600
  });
}
