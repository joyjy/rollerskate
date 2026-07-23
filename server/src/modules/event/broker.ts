import type { RoomStreamEvent } from "@rollerskate/protocol";

export type RoomStreamListener = (event: RoomStreamEvent) => void;

export class RoomEventBroker {
  readonly #listeners = new Map<string, Set<RoomStreamListener>>();

  public subscribe(
    agentId: string,
    roomId: string,
    listener: RoomStreamListener
  ): () => void {
    const key = subscriptionKey(agentId, roomId);
    const listeners = this.#listeners.get(key) ?? new Set<RoomStreamListener>();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.#listeners.delete(key);
      }
    };
  }

  public publish(agentId: string, roomId: string, event: RoomStreamEvent): void {
    for (const listener of this.#listeners.get(subscriptionKey(agentId, roomId)) ?? []) {
      listener(event);
    }
  }
}

function subscriptionKey(agentId: string, roomId: string): string {
  return `${agentId}\u0000${roomId}`;
}
