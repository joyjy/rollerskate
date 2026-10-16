import type { HostCommandExecutor } from "../host-command.js";

const IOREG_EXECUTABLE = "/usr/sbin/ioreg";
const IOREG_ARGUMENTS = ["-r", "-d", "1", "-c", "IOPMrootDomain"];
const IOREG_TIMEOUT_MILLISECONDS = 2_000;
const IOREG_MAX_OUTPUT_BYTES = 64 * 1024;

const CPU_CAPABILITY = 0x1;
const GRAPHICS_OR_AUDIO_CAPABILITY = 0x6;

export type InteractivePowerState = "awake" | "sleeping" | "unknown";

export function parseInteractivePowerState(output: string): InteractivePowerState {
  const lines = output.split(/\r?\n/u).filter(line => /^\s*"System Capabilities"/u.test(line));
  if (lines.length !== 1) return "unknown";

  const match = /^\s*"System Capabilities"\s*=\s*(0[xX][0-9a-fA-F]+|[0-9]+)\s*$/u.exec(lines[0]!);
  if (match === null) return "unknown";

  const capabilities = Number(match[1]);
  if (!Number.isSafeInteger(capabilities) || capabilities < 0 || capabilities > 0xffff_ffff) {
    return "unknown";
  }
  if ((capabilities & GRAPHICS_OR_AUDIO_CAPABILITY) !== 0) return "awake";
  if ((capabilities & CPU_CAPABILITY) !== 0) return "sleeping"; // DarkWake.
  return "sleeping";
}

export async function readInteractivePowerState(executor: HostCommandExecutor): Promise<InteractivePowerState> {
  if (process.platform !== "darwin") return "awake";
  try {
    const result = await executor.executeHostCommand({
      executable: IOREG_EXECUTABLE, arguments: IOREG_ARGUMENTS, environment: {},
      timeoutMilliseconds: IOREG_TIMEOUT_MILLISECONDS, maxOutputBytes: IOREG_MAX_OUTPUT_BYTES
    });
    return parseInteractivePowerState(result.stdout);
  } catch { return "unknown"; }
}
