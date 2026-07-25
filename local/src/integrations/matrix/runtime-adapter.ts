import type { RoomEventPage, RoomHead } from "@rollerskate/protocol";

import type { RuntimeDestinationAdapter } from "../../core/runtime/handlers.js";
import type { RuntimeDestination } from "../../core/runtime/model.js";

export interface MatrixIngressPolicy {
  readonly wakeMode: "disabled" | "mention_only" | "proactive";
  readonly ownerMessageWake: "never" | "mention_only" | "normal";
}

export interface MatrixBinding {
  readonly bindingId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly agentMxid?: string;
  readonly roomId: string;
  readonly ownerHumanId: string;
  readonly policy: MatrixIngressPolicy;
}

export interface MatrixHistory {
  head(roomId: string): Promise<RoomHead>;
  events(input: {
    readonly roomId: string;
    readonly after?: string;
    readonly through: string;
    readonly limit: number;
  }): Promise<RoomEventPage>;
}

export interface MatrixPublisher {
  send(input: {
    readonly agentId: string;
    readonly roomId: string;
    readonly transactionId: string;
    readonly body: string;
    readonly causalChainId: string;
    readonly causalHop: number;
  }): Promise<{ readonly eventId: string }>;
}

export interface MatrixIngressCycleResult {
  readonly bindingId: string;
  readonly destinationId: string;
  readonly roomId: string;
  readonly readThrough: string;
  readonly scanned: number;
  readonly acceptedEventIds: readonly string[];
  readonly ignoredExternalIds: readonly string[];
}

/**
 * The v42 Matrix ingress cursor/session table belonged to the legacy Server
 * binding model. v0.4 will reintroduce it with Server Agent authentication and
 * Topic/TransportBinding lifecycle instead of creating a fourteenth Local table.
 */
export class MatrixIngress {
  public constructor(options: {
    readonly databasePath: string;
    readonly history: MatrixHistory;
    readonly pageSize?: number;
  }) {
    void options;
    throw deferredMatrixIngress();
  }

  public register(binding: MatrixBinding, at = new Date().toISOString()): RuntimeDestination {
    void binding;
    void at;
    throw deferredMatrixIngress();
  }

  public bindingIds(): string[] {
    throw deferredMatrixIngress();
  }

  public async runCycle(
    bindingId: string,
    now = new Date().toISOString()
  ): Promise<MatrixIngressCycleResult> {
    void bindingId;
    void now;
    throw deferredMatrixIngress();
  }

  public close(): void {}
}

/**
 * Outbound delivery remains usable for a Destination snapshot admitted by a
 * supported source. It does not own binding or Session persistence.
 */
export class MatrixDeliveryAdapter implements RuntimeDestinationAdapter {
  public readonly kind = "matrix" as const;
  readonly #publisher: MatrixPublisher;

  public constructor(options: {
    readonly databasePath: string;
    readonly publisher: MatrixPublisher;
  }) {
    void options.databasePath;
    this.#publisher = options.publisher;
  }

  public async deliver(input: Parameters<RuntimeDestinationAdapter["deliver"]>[0]):
  Promise<{ readonly receipt: string }> {
    const address = input.destination.address;
    const roomId = address.roomId;
    const agentId = address.agentId;
    const bindingId = address.bindingId;
    if (roomId === undefined || agentId === undefined || bindingId === undefined) {
      throw new Error(`Matrix destination address is incomplete: ${input.destination.destinationId}`);
    }
    const body = input.resultEvent.outcome === "succeeded"
      ? input.resultEvent.output
      : input.resultEvent.error;
    if (body === undefined || body.trim() === "") {
      throw new Error(`Result Event has no Matrix delivery body: ${input.resultEvent.eventId}`);
    }
    const receipt = await this.#publisher.send({
      agentId,
      roomId,
      transactionId: input.delivery.deliveryId,
      body,
      causalChainId: input.requestEvent.causality.rootEventId,
      causalHop: input.resultEvent.causality.hop
    });
    return { receipt: receipt.eventId };
  }

  public close(): void {}
}

function deferredMatrixIngress(): Error {
  return new Error("Matrix ingress binding persistence is deferred to v0.4");
}
