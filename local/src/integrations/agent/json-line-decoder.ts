import { StringDecoder } from "node:string_decoder";

import type { AgentProcessResponseDecoder } from "./process-client.js";

export class JsonLineResponseDecoder implements AgentProcessResponseDecoder {
  readonly #decoder = new StringDecoder("utf8");
  readonly #maxLineBytes: number;
  readonly #onMessage: (message: unknown) => boolean;
  readonly #onDiscardedLine: (() => void) | undefined;
  readonly #complete: () => unknown;
  #line = "";
  #lineBytes = 0;
  #discarding = false;
  #finished = false;

  public constructor(options: {
    readonly maxLineBytes: number;
    readonly onMessage: (message: unknown) => boolean;
    readonly onDiscardedLine?: () => void;
    readonly complete: () => unknown;
  }) {
    this.#maxLineBytes = options.maxLineBytes;
    this.#onMessage = options.onMessage;
    this.#onDiscardedLine = options.onDiscardedLine;
    this.#complete = options.complete;
  }

  public push(chunk: Buffer): boolean {
    if (this.#finished) throw new Error("JSON line decoder is already finished");
    return this.#consume(this.#decoder.write(chunk), false);
  }

  public finish(): unknown {
    if (this.#finished) throw new Error("JSON line decoder is already finished");
    this.#finished = true;
    this.#consume(this.#decoder.end(), true);
    return this.#complete();
  }

  #consume(text: string, terminal: boolean): boolean {
    let meaningful = false;
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== "\n") continue;
      meaningful = this.#append(text.slice(start, index), true) || meaningful;
      start = index + 1;
    }
    meaningful = this.#append(text.slice(start), terminal) || meaningful;
    return meaningful;
  }

  #append(fragment: string, completeLine: boolean): boolean {
    if (!this.#discarding && fragment !== "") {
      const bytes = Buffer.byteLength(fragment, "utf8");
      if (this.#lineBytes + bytes > this.#maxLineBytes) {
        this.#line = "";
        this.#lineBytes = 0;
        this.#discarding = true;
      } else {
        this.#line += fragment;
        this.#lineBytes += bytes;
      }
    }
    if (!completeLine) return false;
    if (this.#discarding) {
      this.#onDiscardedLine?.();
      this.#resetLine();
      return false;
    }
    const line = this.#line.trim();
    this.#resetLine();
    return line === "" ? false : this.#onMessage(JSON.parse(line) as unknown);
  }

  #resetLine(): void {
    this.#line = "";
    this.#lineBytes = 0;
    this.#discarding = false;
  }
}
