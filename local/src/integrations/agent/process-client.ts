import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export interface AgentProcessClientConfig {
  readonly adapterId: string;
  readonly executable: string;
  readonly args?: string[] | ((request: unknown) => string[]);
  readonly environment?: Readonly<Record<string, string>> |
    ((request: unknown) => Readonly<Record<string, string>>);
  readonly workingDirectory?: string;
  readonly timeoutMilliseconds: number;
  readonly meaningfulOutputTimeoutMilliseconds?: number;
  readonly maxOutputBytes?: number;
  readonly protocol?: AgentProcessProtocol;
}

export interface AgentProcessProtocol {
  readonly encodeRequest: (request: unknown) => string;
  readonly decodeResponse?: (output: string, request: unknown) => unknown;
  readonly createResponseDecoder?: (
    request: unknown,
    maxOutputBytes: number
  ) => AgentProcessResponseDecoder;
}

export interface AgentProcessResponseDecoder {
  readonly push: (chunk: Buffer) => boolean;
  readonly finish: () => unknown;
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
      config.timeoutMilliseconds > 900_000
    ) {
      throw new Error("timeoutMilliseconds must be between 1 and 900000");
    }
    if (
      config.maxOutputBytes !== undefined &&
      (!Number.isInteger(config.maxOutputBytes) ||
        config.maxOutputBytes < 1 ||
        config.maxOutputBytes > 1_048_576)
    ) {
      throw new Error("maxOutputBytes must be between 1 and 1048576");
    }
    if (config.protocol !== undefined &&
      config.protocol.decodeResponse === undefined &&
      config.protocol.createResponseDecoder === undefined) {
      throw new Error("agent process protocol requires a response decoder");
    }
    if (config.meaningfulOutputTimeoutMilliseconds !== undefined &&
      (!Number.isInteger(config.meaningfulOutputTimeoutMilliseconds) ||
        config.meaningfulOutputTimeoutMilliseconds < 1 ||
        config.meaningfulOutputTimeoutMilliseconds > config.timeoutMilliseconds)) {
      throw new Error(
        "meaningfulOutputTimeoutMilliseconds must be between 1 and timeoutMilliseconds"
      );
    }
    if (config.meaningfulOutputTimeoutMilliseconds !== undefined &&
      config.protocol?.createResponseDecoder === undefined) {
      throw new Error(
        "meaningfulOutputTimeoutMilliseconds requires a streaming response decoder"
      );
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
    let responseDecoder: AgentProcessResponseDecoder | undefined;
    try {
      responseDecoder = this.#config.protocol?.createResponseDecoder?.(
        request,
        maxOutputBytes
      );
    } catch (error) {
      return Promise.reject(new Error(
        `agent response decoder initialization failed: ${errorMessage(error)}`
      ));
    }
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
          env: {
            ...(typeof this.#config.environment === "function"
              ? this.#config.environment(request)
              : this.#config.environment ?? {})
          },
          stdio: ["pipe", "pipe", "pipe"]
        }
      );
      const stdout: Buffer[] = [];
      const stdoutDiagnostics: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stdoutDiagnosticBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const finish = (error?: Error, response?: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (meaningfulOutputTimeout !== undefined) {
          clearTimeout(meaningfulOutputTimeout);
        }
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

      let meaningfulOutputTimeout: NodeJS.Timeout | undefined;
      const resetMeaningfulOutputTimeout = () => {
        const milliseconds = this.#config.meaningfulOutputTimeoutMilliseconds;
        if (milliseconds === undefined) return;
        if (meaningfulOutputTimeout !== undefined) clearTimeout(meaningfulOutputTimeout);
        meaningfulOutputTimeout = setTimeout(() => {
          child.kill("SIGKILL");
          finish(new Error(
            `agent invocation stalled without meaningful output: ${this.#config.adapterId}`
          ));
        }, milliseconds);
      };
      resetMeaningfulOutputTimeout();

      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        if (stdoutDiagnosticBytes < 16_384) {
          const retained = chunk.subarray(0, 16_384 - stdoutDiagnosticBytes);
          stdoutDiagnostics.push(Buffer.from(retained));
          stdoutDiagnosticBytes += retained.length;
        }
        if (responseDecoder !== undefined) {
          try {
            if (responseDecoder.push(chunk)) resetMeaningfulOutputTimeout();
          } catch (error) {
            child.kill("SIGKILL");
            finish(new Error(`agent response decoding failed: ${errorMessage(error)}`));
          }
          return;
        }
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) {
          child.kill("SIGKILL");
          finish(new Error(`agent output exceeded ${maxOutputBytes} bytes`));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (settled) return;
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
          const stderrText = Buffer.concat(stderr).toString("utf8").trim();
          const stdoutText = Buffer.concat(
            responseDecoder === undefined ? stdout : stdoutDiagnostics
          )
            .subarray(0, 16_384)
            .toString("utf8")
            .trim();
          const detail = [
            ...(stderrText === "" ? [] : [`stderr: ${stderrText}`]),
            ...(stdoutText === "" ? [] : [`stdout: ${stdoutText}`])
          ].join("\n");
          finish(new Error(
            `agent exited with code=${String(code)} signal=${String(signal)}: ` +
            (detail === "" ? "no process diagnostics" : detail)
          ));
          return;
        }
        try {
          finish(
            undefined,
            responseDecoder !== undefined
              ? responseDecoder.finish()
              : decodeBufferedResponse(
                  this.#config.protocol,
                  Buffer.concat(stdout).toString("utf8"),
                  request
                )
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

function decodeBufferedResponse(
  protocol: AgentProcessProtocol | undefined,
  output: string,
  request: unknown
): unknown {
  if (protocol === undefined) return JSON.parse(output) as unknown;
  if (protocol.decodeResponse === undefined) {
    throw new Error("agent process protocol has no buffered response decoder");
  }
  return protocol.decodeResponse(output, request);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
