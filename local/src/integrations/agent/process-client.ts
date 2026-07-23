import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export interface AgentProcessClientConfig {
  readonly adapterId: string;
  readonly executable: string;
  readonly args?: string[] | ((request: unknown) => string[]);
  readonly environment?: Readonly<Record<string, string>>;
  readonly workingDirectory?: string;
  readonly timeoutMilliseconds: number;
  readonly maxOutputBytes?: number;
  readonly protocol?: AgentProcessProtocol;
}

export interface AgentProcessProtocol {
  readonly encodeRequest: (request: unknown) => string;
  readonly decodeResponse: (output: string) => unknown;
}

export interface AgentInvocationReceipt {
  readonly adapterId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly response: unknown;
}

export class AgentProcessClient {
  readonly #config: AgentProcessClientConfig;

  public constructor(config: AgentProcessClientConfig) {
    if (config.adapterId.trim() === "") {
      throw new Error("adapterId must be a non-empty string");
    }
    if (!isAbsolute(config.executable)) {
      throw new Error("agent executable must be an absolute path");
    }
    if (config.workingDirectory !== undefined && !isAbsolute(config.workingDirectory)) {
      throw new Error("agent workingDirectory must be an absolute path");
    }
    if (
      !Number.isInteger(config.timeoutMilliseconds) ||
      config.timeoutMilliseconds < 1 ||
      config.timeoutMilliseconds > 300_000
    ) {
      throw new Error("timeoutMilliseconds must be between 1 and 300000");
    }
    if (
      config.maxOutputBytes !== undefined &&
      (!Number.isInteger(config.maxOutputBytes) ||
        config.maxOutputBytes < 1 ||
        config.maxOutputBytes > 1_048_576)
    ) {
      throw new Error("maxOutputBytes must be between 1 and 1048576");
    }
    this.#config = config;
  }

  public invoke(request: unknown): Promise<AgentInvocationReceipt> {
    let requestJson: string;
    try {
      requestJson = this.#config.protocol === undefined
        ? JSON.stringify(request)
        : this.#config.protocol.encodeRequest(request);
      if (requestJson === undefined) {
        throw new Error("value is undefined");
      }
    } catch (error) {
      return Promise.reject(new Error(
        (this.#config.protocol === undefined
          ? `agent request is not JSON-serializable: `
          : `agent request encoding failed: `) +
        (error instanceof Error ? error.message : String(error))
      ));
    }
    const startedAt = new Date().toISOString();
    const maxOutputBytes = this.#config.maxOutputBytes ?? 65_536;
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.#config.executable,
        typeof this.#config.args === "function"
          ? this.#config.args(request)
          : this.#config.args ?? [],
        {
          shell: false,
          ...(this.#config.workingDirectory === undefined
            ? {}
            : { cwd: this.#config.workingDirectory }),
          env: { ...(this.#config.environment ?? {}) },
          stdio: ["pipe", "pipe", "pipe"]
        }
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const finish = (error?: Error, response?: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve({
          adapterId: this.#config.adapterId,
          startedAt,
          completedAt: new Date().toISOString(),
          response
        });
      };

      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error(`agent invocation timed out: ${this.#config.adapterId}`));
      }, this.#config.timeoutMilliseconds);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) {
          child.kill("SIGKILL");
          finish(new Error(`agent output exceeded ${maxOutputBytes} bytes`));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= 16_384) {
          stderr.push(chunk);
        }
      });
      child.stdin.once("error", (error) => finish(error));
      child.once("error", (error) => finish(error));
      child.once("close", (code, signal) => {
        if (settled) {
          return;
        }
        if (code !== 0) {
          finish(new Error(
            `agent exited with code=${String(code)} signal=${String(signal)}: ` +
            Buffer.concat(stderr).toString("utf8").trim()
          ));
          return;
        }
        try {
          const output = Buffer.concat(stdout).toString("utf8");
          finish(
            undefined,
            this.#config.protocol === undefined
              ? JSON.parse(output) as unknown
              : this.#config.protocol.decodeResponse(output)
          );
        } catch (error) {
          finish(new Error(
            (this.#config.protocol === undefined
              ? `agent returned invalid JSON: `
              : `agent response decoding failed: `) +
            (error instanceof Error ? error.message : String(error))
          ));
        }
      });
      child.stdin.end(requestJson);
    });
  }
}
