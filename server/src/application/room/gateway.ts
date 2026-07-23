import type { RoomVisibility } from "@rollerskate/protocol";

export interface MatrixApplicationServiceGateway {
  readonly serverName: string;
  mxidFor(principalKind: "human" | "agent", principalId: string): string;
  ensurePrincipal(mxid: string, displayName: string): Promise<void>;
  createRoom(input: {
    readonly creatorMxid: string;
    readonly name: string;
    readonly visibility: RoomVisibility;
  }): Promise<string>;
  invite(roomId: string, actorMxid: string, inviteeMxid: string): Promise<void>;
  join(roomId: string, mxid: string): Promise<void>;
  leave(roomId: string, mxid: string): Promise<void>;
  sendMessage(input: {
    readonly roomId: string;
    readonly senderMxid: string;
    readonly transactionId: string;
    readonly body: string;
    readonly causalChainId?: string;
    readonly causalHop?: number;
  }): Promise<string>;
}
