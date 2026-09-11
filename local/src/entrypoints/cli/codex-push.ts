import { sendCodexDesktopMessage, MAX_PUSH_BYTES } from "../../application/codex-desktop/control.js";
import type { AppOutput } from "./shared.js";

export async function runCodexPushCommand(argv: readonly string[], output: AppOutput, input: AsyncIterable<Buffer | string> = process.stdin): Promise<number> {
  let threadId: string | undefined;
  let socketPath: string | undefined;
  let timeoutMilliseconds = 20_000;
  let offset = 0;
  while (offset < argv.length - 1) {
    const flag = argv[offset++];
    const value = argv[offset++];
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === "--thread") threadId = value;
    else if (flag === "--socket") socketPath = value;
    else if (flag === "--timeout") timeoutMilliseconds = Number(value) * 1000;
    else throw new Error(`unexpected argument: ${flag}`);
  }
  if (threadId === undefined || argv[offset] !== "send" || offset !== argv.length - 1) {
    throw new Error("codex-push requires --thread <full UUID> [--socket <path>] [--timeout <seconds>] send; body is read from stdin");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_PUSH_BYTES) throw new Error("Codex Desktop message exceeds 65536 bytes; not_sent");
    chunks.push(bytes);
  }
  const receipt = await sendCodexDesktopMessage(threadId, Buffer.concat(chunks).toString("utf8"), {
    timeoutMilliseconds, ...(socketPath === undefined ? {} : { socketPath })
  });
  output.write(`${JSON.stringify(receipt)}\n`);
  return { accepted: 0, not_sent: 1, rejected: 2, unknown: 3 }[receipt.status];
}
