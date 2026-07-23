export interface ClockOptions {
  readonly now?: () => Date;
}

export function now(options: ClockOptions): string {
  return (options.now ?? (() => new Date()))().toISOString();
}

export function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}
