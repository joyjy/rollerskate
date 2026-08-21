export interface UiServerOptions {
  readonly repoRoot: string;
  readonly runtimeDirectory?: string;
  readonly serverUrl?: string;
  readonly port: number;
  readonly signal: AbortSignal;
  readonly output?: { readonly write: (text: string) => void };
  readonly fetch?: typeof fetch;
}

export interface UiServerHandle {
  readonly url: string;
  readonly close: () => Promise<void>;
}
