import type { TrustRepository } from "../modules/trust/repository.js";
import type {
  AgentRepository,
  CreateAgentInput,
  CreateAgentOutcome,
  RedeemEnrollmentInput,
  RedeemEnrollmentOutcome
} from "../modules/agent/repository.js";
import type {
  DeviceRepository,
  PairingRedeemOutcome
} from "../modules/device/repository.js";
import type { EventRepository } from "../modules/event/repository.js";
import type { RoomRepository } from "./room/repository.js";

export type ServerRepository = TrustRepository & DeviceRepository & AgentRepository &
  EventRepository & RoomRepository;

export type {
  CreateAgentInput,
  CreateAgentOutcome,
  PairingRedeemOutcome,
  RedeemEnrollmentInput,
  RedeemEnrollmentOutcome
};
