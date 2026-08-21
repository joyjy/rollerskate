import type { RuntimeDestinationAdapter } from "../../core/runtime/handlers.js";
import type { TopicEvent, TopicEventPublishRequest } from "../../protocol.js";

export interface ServerTopicPublisher {
  publishTopic(topicId: string, request: TopicEventPublishRequest): Promise<TopicEvent>;
}

export class ServerTopicDeliveryAdapter implements RuntimeDestinationAdapter {
  public readonly kind = "server-topic" as const;
  readonly #clients: ReadonlyMap<string, ServerTopicPublisher>;

  public constructor(clients: ReadonlyMap<string, ServerTopicPublisher>) {
    this.#clients = clients;
  }

  public async deliver(
    input: Parameters<RuntimeDestinationAdapter["deliver"]>[0]
  ): Promise<{ readonly receipt: string }> {
    const topicId = input.destination.address.topicId;
    const agentId = input.destination.address.agentId;
    if (topicId === undefined || agentId === undefined) {
      throw new Error(
        `Server Topic destination address is incomplete: ${input.destination.destinationId}`
      );
    }
    const client = this.#clients.get(agentId);
    if (client === undefined) throw new Error(`Server Topic publisher is unavailable: ${agentId}`);
    const body = input.delivery.payload.body;
    if (typeof body !== "string" || body.trim() === "") {
      throw new Error(`Server Topic Delivery has no body: ${input.delivery.deliveryId}`);
    }
    const event = await client.publishTopic(topicId, {
      transactionId: input.delivery.origin.id,
      body
    });
    return { receipt: event.eventId };
  }
}
