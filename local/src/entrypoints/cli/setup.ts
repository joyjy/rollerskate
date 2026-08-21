import { realpathSync } from "node:fs";
import { createInterface, type Interface } from "node:readline/promises";

import type { SetupInput } from "../../application/runtime/control.js";
import { findExecutable } from "./shared.js";

export async function collectSetupInput(
  repoRoot: string,
  environment: NodeJS.ProcessEnv
): Promise<SetupInput> {
  let prompts: Interface | undefined;
  const ask = async (
    environmentName: string,
    label: string,
    defaultValue?: string
  ): Promise<string> => {
    const configured = environment[environmentName]?.trim();
    if (configured !== undefined && configured !== "") {
      return configured;
    }
    if (!process.stdin.isTTY) {
      throw new Error(`${environmentName} is required for non-interactive setup`);
    }
    prompts ??= createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultValue === undefined ? ": " : ` [${defaultValue}]: `;
    const answer = (await prompts.question(`${label}${suffix}`)).trim();
    if (answer !== "") {
      return answer;
    }
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`${label} is required`);
  };

  try {
    const projectRoot = await ask(
      "ROLLERSKATE_PROJECT_ROOT",
      "Local source directory",
      realpathSync(repoRoot)
    );
    const defaultCodex = findExecutable("codex", environment.PATH);
    const codexExecutable = await ask(
      "ROLLERSKATE_CODEX_EXECUTABLE",
      "Codex executable",
      defaultCodex
    );
    const homeserver = await ask(
      "ROLLERSKATE_MATRIX_HOMESERVER",
      "Matrix homeserver"
    );
    const roomId = await ask("ROLLERSKATE_MATRIX_ROOM_ID", "Matrix room ID");
    const ownerUserId = await ask(
      "ROLLERSKATE_MATRIX_OWNER_USER",
      "Your Matrix user ID"
    );
    const agentUserId = await ask(
      "ROLLERSKATE_MATRIX_AGENT_USER",
      "Agent Matrix user ID"
    );
    prompts?.close();
    prompts = undefined;
    const configuredToken = environment.ROLLERSKATE_MATRIX_ACCESS_TOKEN?.trim();
    const matrixAccessToken = configuredToken === undefined || configuredToken === ""
      ? await promptSecret("Agent access token (hidden): ")
      : configuredToken;
    return {
      homeserver,
      roomId,
      ownerUserId,
      agentUserId,
      matrixAccessToken,
      projectRoot,
      codexExecutable
    };
  } finally {
    prompts?.close();
  }
}

async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY || process.stdin.setRawMode === undefined) {
    throw new Error(
      "ROLLERSKATE_MATRIX_ACCESS_TOKEN is required for non-interactive setup"
    );
  }
  process.stdout.write(label);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolvePromise, rejectPromise) => {
    let value = "";
    const finish = (error?: Error): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(wasRaw);
      process.stdout.write("\n");
      if (error !== undefined) {
        rejectPromise(error);
      } else if (value.trim() === "") {
        rejectPromise(new Error("Agent access token is required"));
      } else {
        resolvePromise(value);
      }
    };
    const onData = (chunk: Buffer): void => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          finish(new Error("setup cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("");
        } else {
          value += character;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}
