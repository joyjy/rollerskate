import { randomUUID } from "node:crypto";

import type {
  AgentCreateRequest,
  AgentCreateResponse,
  AgentCredentialIssuance,
  AgentCredentialRevocation,
  AgentSummary
} from "@rollerskate/protocol";

import { ServerError } from "../shared/error.js";
import type { CredentialService } from "../shared/credentials.js";
import type {
  AgentAggregate,
  AgentAuthenticationRecord,
  AgentCredentialRecord,
  AgentRecord,
  EnrollmentGrantRecord,
  PlacementRecord
} from "./model.js";
import type { DeviceAuthenticationRecord } from "../device/model.js";
import { toAgentSummary } from "./model.js";
import {
  parseOpaqueCredential,
  sha256Base64Url
} from "../shared/opaque-credential.js";
import { addMilliseconds, now, type ClockOptions } from "../shared/time.js";
import type { AgentRepository } from "./repository.js";

const ENROLLMENT_TTL_MILLISECONDS = 10 * 60 * 1_000;

export interface AgentServiceOptions extends ClockOptions {
  readonly credentials: CredentialService;
}

export class AgentService {
  readonly #repository: AgentRepository;
  readonly #options: AgentServiceOptions;

  public constructor(repository: AgentRepository, options: AgentServiceOptions) {
    this.#repository = repository;
    this.#options = options;
  }

  public async createAgent(
    authentication: DeviceAuthenticationRecord,
    request: AgentCreateRequest
  ): Promise<AgentCreateResponse> {
    const timestamp = now(this.#options);
    const agent: AgentRecord = {
      id: randomUUID(),
      name: request.name,
      ownerHumanId: authentication.human.id,
      operatorHumanId: authentication.human.id,
      status: "provisioning",
      createdAt: timestamp
    };
    const placement: PlacementRecord = {
      id: randomUUID(),
      agentId: agent.id,
      deviceId: authentication.device.id,
      state: "pending",
      generation: 1,
      createdAt: timestamp
    };
    const enrollmentId = randomUUID();
    const enrollment: EnrollmentGrantRecord = {
      id: enrollmentId,
      agentId: agent.id,
      deviceId: authentication.device.id,
      placementId: placement.id,
      credentialId: enrollmentId,
      verifierChallenge: request.verifierChallenge,
      status: "issued",
      expiresAt: addMilliseconds(timestamp, ENROLLMENT_TTL_MILLISECONDS),
      createdAt: timestamp
    };
    const outcome = await this.#repository.createOrResumeAgent({
      device: authentication,
      agent,
      placement,
      enrollment,
      now: timestamp
    });
    if (!outcome.ok) {
      const status = outcome.reason === "verifier_mismatch" ? 409
        : 403;
      throw new ServerError(
        `agent_${outcome.reason}`,
        status,
        `Agent creation failed: ${outcome.reason}`
      );
    }
    return {
      agent: toAgentSummary(outcome.value.aggregate),
      enrollment: {
        id: outcome.value.enrollment.id,
        agentId: outcome.value.enrollment.agentId,
        deviceId: outcome.value.enrollment.deviceId,
        placementId: outcome.value.enrollment.placementId,
        status: outcome.value.enrollment.status,
        expiresAt: outcome.value.enrollment.expiresAt
      }
    };
  }

  public async redeemAgentEnrollment(
    authentication: DeviceAuthenticationRecord,
    grantId: string,
    verifier: string
  ): Promise<AgentCredentialIssuance> {
    const timestamp = now(this.#options);
    const credential: AgentCredentialRecord = {
      id: grantId,
      agentId: "pending",
      placementId: "pending",
      secretHash: await this.#options.credentials.hashSecret(verifier),
      status: "active",
      createdAt: timestamp
    };
    const outcome = await this.#repository.redeemEnrollment({
      grantId,
      deviceId: authentication.device.id,
      verifierChallenge: sha256Base64Url(verifier),
      credential,
      now: timestamp
    });
    if (!outcome.ok) {
      const status = outcome.reason === "not_found" ? 404
        : outcome.reason === "expired" ? 410
        : outcome.reason === "device_mismatch" ? 403
        : 409;
      throw new ServerError(
        `enrollment_${outcome.reason}`,
        status,
        `Agent enrollment failed: ${outcome.reason}`
      );
    }
    return {
      credentialId: outcome.value.credential.id,
      credential: `${outcome.value.credential.id}.${verifier}`,
      agent: toAgentSummary(outcome.value.aggregate)
    };
  }

  public async listAgents(
    authentication: DeviceAuthenticationRecord
  ): Promise<readonly AgentSummary[]> {
    return (await this.#repository.listAgentsForDevice(authentication.device.id))
      .map(toAgentSummary);
  }

  public async rotateCredential(
    authentication: DeviceAuthenticationRecord,
    agentId: string
  ): Promise<AgentCredentialIssuance> {
    const aggregate = await this.#ownedAgent(authentication, agentId);
    if (aggregate.agent.status !== "active" || aggregate.placement.state !== "active") {
      throw new ServerError("agent_inactive", 409, "Agent placement is not active");
    }
    const timestamp = now(this.#options);
    const id = randomUUID();
    const secret = this.#options.credentials.generateSecret();
    const credential = await this.#repository.rotateAgentCredential(
      agentId,
      aggregate.placement.id,
      {
        id,
        agentId,
        placementId: aggregate.placement.id,
        secretHash: await this.#options.credentials.hashSecret(secret),
        status: "active",
        createdAt: timestamp
      },
      timestamp
    );
    if (credential === undefined) {
      throw new ServerError("agent_inactive", 409, "Agent placement is not active");
    }
    return {
      credentialId: credential.id,
      credential: `${credential.id}.${secret}`,
      agent: toAgentSummary((await this.#repository.getAgentAggregateById(agentId))!)
    };
  }

  public async revokeCredentials(
    authentication: DeviceAuthenticationRecord,
    agentId: string
  ): Promise<AgentCredentialRevocation> {
    await this.#ownedAgent(authentication, agentId);
    const timestamp = now(this.#options);
    return {
      agentId,
      revokedCount: await this.#repository.revokeAgentCredentials(agentId, timestamp),
      revokedAt: timestamp
    };
  }

  public async getAgentByName(
    authentication: DeviceAuthenticationRecord,
    name: string
  ): Promise<AgentSummary> {
    const aggregate = await this.#repository.getAgentForDeviceByName(
      authentication.device.id,
      name
    );
    if (aggregate === undefined) {
      throw new ServerError("agent_not_found", 404, "Agent was not found");
    }
    return toAgentSummary(aggregate);
  }

  public async authenticateAgent(
    token: string | undefined,
    expectedAgentId?: string
  ): Promise<AgentAuthenticationRecord> {
    const parsed = parseOpaqueCredential(token);
    if (parsed === undefined) {
      throw new ServerError("unauthorized", 401, "Agent credential is required");
    }
    const authentication = await this.#repository.getAgentAuthentication(
      parsed.id,
      now(this.#options)
    );
    if (
      authentication === undefined ||
      !await this.#options.credentials.verifySecret(
        parsed.secret,
        authentication.credential.secretHash
      )
    ) {
      throw new ServerError("unauthorized", 401, "Agent credential is invalid");
    }
    if (expectedAgentId !== undefined && authentication.agent.id !== expectedAgentId) {
      throw new ServerError(
        "agent_credential_mismatch",
        403,
        "Agent credential does not match the requested Agent"
      );
    }
    return authentication;
  }

  public agentSummary(authentication: AgentAuthenticationRecord): AgentSummary {
    return toAgentSummary(authentication);
  }

  async #ownedAgent(
    authentication: DeviceAuthenticationRecord,
    agentId: string
  ): Promise<AgentAggregate> {
    const aggregate = await this.#repository.getAgentAggregateById(agentId);
    if (aggregate === undefined) throw new ServerError("agent_not_found", 404,
      "Agent was not found");
    if (aggregate.owner.id !== authentication.human.id) {
      throw new ServerError("forbidden", 403, "Only the Agent owner can manage credentials");
    }
    return aggregate;
  }
}
