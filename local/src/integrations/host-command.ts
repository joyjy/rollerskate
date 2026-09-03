export interface HostCommandRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly stdin?: string;
}

export interface HostCommandResult {
  readonly exitCode: 0;
  readonly stdout: string;
  readonly stderr: string;
}

export class HostCommandExecutionError extends Error {
  public readonly outcome: "failed" | "unknown";
  public readonly exitCode?: number;
  public readonly stdout: string;
  public readonly stderr: string;

  public constructor(input: {
    readonly message: string;
    readonly outcome: "failed" | "unknown";
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
  }) {
    super(input.message);
    this.name = "HostCommandExecutionError";
    this.outcome = input.outcome;
    if (input.exitCode !== undefined) this.exitCode = input.exitCode;
    this.stdout = input.stdout ?? "";
    this.stderr = input.stderr ?? "";
  }
}

export interface HostCommandExecutor {
  executeHostCommand(request: HostCommandRequest): Promise<HostCommandResult>;
}
