import type { ServerRepository } from "../../application/repository.js";
import type { RoomRepository } from "../../application/room/repository.js";
import type { AgentRepository } from "../../modules/agent/repository.js";
import type { DeviceRepository } from "../../modules/device/repository.js";
import type { EventRepository } from "../../modules/event/repository.js";
import type { TrustRepository } from "../../modules/trust/repository.js";

export interface ServerRepositoryPorts {
  readonly agent: AgentRepository;
  readonly device: DeviceRepository;
  readonly room: RoomEventRepository;
  readonly trust: TrustRepository;
}

type RoomEventRepository = RoomRepository &
  Omit<EventRepository, "getAgentRoomBinding"> & {
    isMatrixTransactionComplete(transactionId: string): Promise<boolean>;
  };

export class DelegatingServerRepository implements ServerRepository {
  readonly #agent: AgentRepository;
  readonly #device: DeviceRepository;
  readonly #room: RoomEventRepository;
  readonly #trust: TrustRepository;

  public constructor(ports: ServerRepositoryPorts) {
    this.#agent = ports.agent;
    this.#device = ports.device;
    this.#room = ports.room;
    this.#trust = ports.trust;
  }

  public putAuthorizationTransaction(
    ...args: Parameters<TrustRepository["putAuthorizationTransaction"]>
  ): ReturnType<TrustRepository["putAuthorizationTransaction"]> {
    return this.#trust.putAuthorizationTransaction(...args);
  }

  public takeAuthorizationTransaction(
    ...args: Parameters<TrustRepository["takeAuthorizationTransaction"]>
  ): ReturnType<TrustRepository["takeAuthorizationTransaction"]> {
    return this.#trust.takeAuthorizationTransaction(...args);
  }

  public admitHuman(
    ...args: Parameters<TrustRepository["admitHuman"]>
  ): ReturnType<TrustRepository["admitHuman"]> {
    return this.#trust.admitHuman(...args);
  }

  public allowSubject(
    ...args: Parameters<TrustRepository["allowSubject"]>
  ): ReturnType<TrustRepository["allowSubject"]> {
    return this.#trust.allowSubject(...args);
  }

  public getHuman(
    ...args: Parameters<TrustRepository["getHuman"]>
  ): ReturnType<TrustRepository["getHuman"]> {
    return this.#trust.getHuman(...args);
  }

  public putSession(
    ...args: Parameters<TrustRepository["putSession"]>
  ): ReturnType<TrustRepository["putSession"]> {
    return this.#trust.putSession(...args);
  }

  public getSession(
    ...args: Parameters<TrustRepository["getSession"]>
  ): ReturnType<TrustRepository["getSession"]> {
    return this.#trust.getSession(...args);
  }

  public putPairing(
    ...args: Parameters<DeviceRepository["putPairing"]>
  ): ReturnType<DeviceRepository["putPairing"]> {
    return this.#device.putPairing(...args);
  }

  public getPairing(
    ...args: Parameters<DeviceRepository["getPairing"]>
  ): ReturnType<DeviceRepository["getPairing"]> {
    return this.#device.getPairing(...args);
  }

  public claimPairingAuthorizationPoll(
    ...args: Parameters<DeviceRepository["claimPairingAuthorizationPoll"]>
  ): ReturnType<DeviceRepository["claimPairingAuthorizationPoll"]> {
    return this.#device.claimPairingAuthorizationPoll(...args);
  }

  public updatePairingPollInterval(
    ...args: Parameters<DeviceRepository["updatePairingPollInterval"]>
  ): ReturnType<DeviceRepository["updatePairingPollInterval"]> {
    return this.#device.updatePairingPollInterval(...args);
  }

  public finishPairingAuthorization(
    ...args: Parameters<DeviceRepository["finishPairingAuthorization"]>
  ): ReturnType<DeviceRepository["finishPairingAuthorization"]> {
    return this.#device.finishPairingAuthorization(...args);
  }

  public approvePairing(
    ...args: Parameters<DeviceRepository["approvePairing"]>
  ): ReturnType<DeviceRepository["approvePairing"]> {
    return this.#device.approvePairing(...args);
  }

  public redeemPairing(
    ...args: Parameters<DeviceRepository["redeemPairing"]>
  ): ReturnType<DeviceRepository["redeemPairing"]> {
    return this.#device.redeemPairing(...args);
  }

  public getDeviceAuthentication(
    ...args: Parameters<DeviceRepository["getDeviceAuthentication"]>
  ): ReturnType<DeviceRepository["getDeviceAuthentication"]> {
    return this.#device.getDeviceAuthentication(...args);
  }

  public revokeDeviceCredential(
    ...args: Parameters<DeviceRepository["revokeDeviceCredential"]>
  ): ReturnType<DeviceRepository["revokeDeviceCredential"]> {
    return this.#device.revokeDeviceCredential(...args);
  }

  public createOrResumeAgent(
    ...args: Parameters<AgentRepository["createOrResumeAgent"]>
  ): ReturnType<AgentRepository["createOrResumeAgent"]> {
    return this.#agent.createOrResumeAgent(...args);
  }

  public redeemEnrollment(
    ...args: Parameters<AgentRepository["redeemEnrollment"]>
  ): ReturnType<AgentRepository["redeemEnrollment"]> {
    return this.#agent.redeemEnrollment(...args);
  }

  public listAgentsForDevice(
    ...args: Parameters<AgentRepository["listAgentsForDevice"]>
  ): ReturnType<AgentRepository["listAgentsForDevice"]> {
    return this.#agent.listAgentsForDevice(...args);
  }

  public getAgentForDeviceByName(
    ...args: Parameters<AgentRepository["getAgentForDeviceByName"]>
  ): ReturnType<AgentRepository["getAgentForDeviceByName"]> {
    return this.#agent.getAgentForDeviceByName(...args);
  }

  public getAgentAuthentication(
    ...args: Parameters<AgentRepository["getAgentAuthentication"]>
  ): ReturnType<AgentRepository["getAgentAuthentication"]> {
    return this.#agent.getAgentAuthentication(...args);
  }

  public getAgentAggregateById(
    ...args: Parameters<AgentRepository["getAgentAggregateById"]>
  ): ReturnType<AgentRepository["getAgentAggregateById"]> {
    return this.#agent.getAgentAggregateById(...args);
  }

  public rotateAgentCredential(
    ...args: Parameters<AgentRepository["rotateAgentCredential"]>
  ): ReturnType<AgentRepository["rotateAgentCredential"]> {
    return this.#agent.rotateAgentCredential(...args);
  }

  public revokeAgentCredentials(
    ...args: Parameters<AgentRepository["revokeAgentCredentials"]>
  ): ReturnType<AgentRepository["revokeAgentCredentials"]> {
    return this.#agent.revokeAgentCredentials(...args);
  }

  public getAgentRoomBinding(
    ...args: Parameters<AgentRepository["getAgentRoomBinding"]>
  ): ReturnType<AgentRepository["getAgentRoomBinding"]> {
    return this.#agent.getAgentRoomBinding(...args);
  }

  public putAgentRoomBinding(
    ...args: Parameters<AgentRepository["putAgentRoomBinding"]>
  ): ReturnType<AgentRepository["putAgentRoomBinding"]> {
    return this.#agent.putAgentRoomBinding(...args);
  }

  public updateAgentRoomBinding(
    ...args: Parameters<AgentRepository["updateAgentRoomBinding"]>
  ): ReturnType<AgentRepository["updateAgentRoomBinding"]> {
    return this.#agent.updateAgentRoomBinding(...args);
  }

  public listAgentRoomBindings(
    ...args: Parameters<AgentRepository["listAgentRoomBindings"]>
  ): ReturnType<AgentRepository["listAgentRoomBindings"]> {
    return this.#agent.listAgentRoomBindings(...args);
  }

  public createRoom(
    ...args: Parameters<RoomRepository["createRoom"]>
  ): ReturnType<RoomRepository["createRoom"]> {
    return this.#room.createRoom(...args);
  }

  public getRoom(
    ...args: Parameters<RoomRepository["getRoom"]>
  ): ReturnType<RoomRepository["getRoom"]> {
    return this.#room.getRoom(...args);
  }

  public getRoomByMatrixId(
    ...args: Parameters<RoomRepository["getRoomByMatrixId"]>
  ): ReturnType<RoomRepository["getRoomByMatrixId"]> {
    return this.#room.getRoomByMatrixId(...args);
  }

  public listRoomsForHuman(
    ...args: Parameters<RoomRepository["listRoomsForHuman"]>
  ): ReturnType<RoomRepository["listRoomsForHuman"]> {
    return this.#room.listRoomsForHuman(...args);
  }

  public getRoomMembership(
    ...args: Parameters<RoomRepository["getRoomMembership"]>
  ): ReturnType<RoomRepository["getRoomMembership"]> {
    return this.#room.getRoomMembership(...args);
  }

  public putRoomMembership(
    ...args: Parameters<RoomRepository["putRoomMembership"]>
  ): ReturnType<RoomRepository["putRoomMembership"]> {
    return this.#room.putRoomMembership(...args);
  }

  public appendRoomEvent(
    ...args: Parameters<EventRepository["appendRoomEvent"]>
  ): ReturnType<EventRepository["appendRoomEvent"]> {
    return this.#room.appendRoomEvent(...args);
  }

  public listRoomEvents(
    ...args: Parameters<EventRepository["listRoomEvents"]>
  ): ReturnType<EventRepository["listRoomEvents"]> {
    return this.#room.listRoomEvents(...args);
  }

  public getMatrixPrincipalByMxid(
    ...args: Parameters<RoomRepository["getMatrixPrincipalByMxid"]>
  ): ReturnType<RoomRepository["getMatrixPrincipalByMxid"]> {
    return this.#room.getMatrixPrincipalByMxid(...args);
  }

  public getMatrixPrincipal(
    ...args: Parameters<RoomRepository["getMatrixPrincipal"]>
  ): ReturnType<RoomRepository["getMatrixPrincipal"]> {
    return this.#room.getMatrixPrincipal(...args);
  }

  public putMatrixPrincipal(
    ...args: Parameters<RoomRepository["putMatrixPrincipal"]>
  ): ReturnType<RoomRepository["putMatrixPrincipal"]> {
    return this.#room.putMatrixPrincipal(...args);
  }

  public completeMatrixTransaction(
    ...args: Parameters<EventRepository["completeMatrixTransaction"]>
  ): ReturnType<EventRepository["completeMatrixTransaction"]> {
    return this.#room.completeMatrixTransaction(...args);
  }

  public isMatrixTransactionComplete(transactionId: string): Promise<boolean> {
    return this.#room.isMatrixTransactionComplete(transactionId);
  }
}
