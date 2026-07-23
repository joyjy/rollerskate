#!/usr/bin/env node

import { TrustService } from "../modules/trust/service.js";
import { AgentService } from "../modules/agent/service.js";
import { AgentRoomService } from "../application/room/agent-service.js";
import { DeviceService } from "../modules/device/service.js";
import { DeviceLoginService } from "../application/device/login-service.js";
import { RoomEventBroker } from "../modules/event/broker.js";
import { EventService } from "../modules/event/service.js";
import { RoomService } from "../application/room/service.js";
import { HttpMatrixApplicationServiceGateway } from "../adapter/matrix/application-service.js";
import { connectMysqlPool } from "../adapter/persistence/mysql/connection.js";
import { MysqlRepository } from "../adapter/persistence/mysql/repository.js";
import { OidcClient } from "../adapter/oidc/client.js";
import { credentialService } from "../adapter/security/credentials.js";
import { loadServerRuntimeConfig } from "./config.js";
import { createBffServer } from "./http-server.js";

export async function startServer(): Promise<void> {
  const config = loadServerRuntimeConfig();
  const pool = connectMysqlPool(config.databaseUrl);
  try {
    await pool.query("SELECT 1");
  } catch (error) {
    await pool.end();
    throw error;
  }
  const repository = new MysqlRepository(pool);
  const trust = new TrustService(repository, {
    issuer: config.oidc.issuer,
    publicUrl: config.publicUrl
  });
  const devices = new DeviceService(repository, {
    publicUrl: config.publicUrl,
    credentials: credentialService
  });
  const agents = new AgentService(repository, { credentials: credentialService });
  const oidc = new OidcClient(config.oidc);
  const deviceLogin = new DeviceLoginService(repository, trust, oidc);
  const matrix = new HttpMatrixApplicationServiceGateway(config.matrix);
  const rooms = new RoomService(repository, matrix);
  const agentRooms = new AgentRoomService(repository, matrix);
  const events = new EventService(repository, new RoomEventBroker());
  const server = createBffServer({
    trust,
    devices,
    deviceLogin,
    agents,
    oidc,
    rooms,
    agentRooms,
    events,
    matrixHsToken: config.matrix.hsToken
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await pool.end();
    throw error;
  }

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;
  process.stdout.write(`Rollerskate Server listening on http://${config.host}:${port}\n`);

  const close = (): void => {
    server.close(async (error) => {
      await pool.end();
      if (error !== undefined) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startServer();
}
