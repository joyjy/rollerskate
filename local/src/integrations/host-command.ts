export interface HostCommandRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly timeoutMilliseconds: number;
  readonly maxOutputBytes: number;
}

export interface HostCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface HostCommandExecutor {
  executeHostCommand(request: HostCommandRequest): Promise<HostCommandResult>;
}
