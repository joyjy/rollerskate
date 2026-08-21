import type { Pool } from "mysql2/promise";

import { DelegatingServerRepository } from "../repository.js";
import { MysqlAgentRepository } from "./repository/agent.js";
import { MysqlDeviceRepository } from "./repository/device.js";
import { MysqlRoomEventRepository } from "./repository/room-event.js";
import { MysqlTrustRepository } from "./repository/trust.js";

export class MysqlRepository extends DelegatingServerRepository {
  public constructor(pool: Pool) {
    super({
      agent: new MysqlAgentRepository(pool),
      device: new MysqlDeviceRepository(pool),
      room: new MysqlRoomEventRepository(pool),
      trust: new MysqlTrustRepository(pool)
    });
  }
}
