import { DelegatingServerRepository } from "../repository.js";

import { MemoryAgentRepository } from "./repository/agent.js";
import { MemoryDeviceRepository } from "./repository/device.js";
import { MemoryRoomEventRepository } from "./repository/room-event.js";
import { MemoryRepositoryState } from "./repository/state.js";
import { MemoryTrustRepository } from "./repository/trust.js";

export class MemoryRepository extends DelegatingServerRepository {
  public constructor() {
    const state = new MemoryRepositoryState();
    super({
      agent: new MemoryAgentRepository(state),
      device: new MemoryDeviceRepository(state),
      room: new MemoryRoomEventRepository(state),
      trust: new MemoryTrustRepository(state)
    });
  }
}
