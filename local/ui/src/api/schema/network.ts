import * as v from "valibot";
import { agentSummarySchema } from "./local";
import { optionalString } from "./shared";

const publicAgentProfileSchema = v.object({
  agentId: v.string(),
  displayName: v.string(),
  role: v.string(),
  disclosure: v.string(),
  expressionRules: v.array(v.string()),
  revision: v.number(),
  updatedAt: v.string()
});

export const deviceLoginStateSchema = v.variant("status", [
  v.object({ status: v.literal("idle") }),
  v.object({
    status: v.literal("pending"),
    serverUrl: v.string(),
    verificationUri: v.string(),
    expiresAt: v.string()
  }),
  v.object({ status: v.literal("succeeded"), serverUrl: v.string() }),
  v.object({
    status: v.literal("failed"),
    serverUrl: v.string(),
    error: v.string()
  })
]);

export const networkSafetyViewSchema = v.object({
  configuredServerUrl: optionalString,
  deviceLogin: deviceLoginStateSchema,
  device: v.looseObject({
    hasCredential: v.boolean(),
    metadata: v.optional(v.looseObject({
      deviceId: v.string(),
      deviceName: v.string(),
      serverUrl: v.string(),
      status: v.union([v.literal("pairing"), v.literal("active"), v.literal("revoked")]),
      humanId: optionalString,
      humanDisplayName: optionalString
    }))
  }),
  agents: v.array(v.object({
    agent: agentSummarySchema,
    activityAccess: v.nullable(v.looseObject({
      agentId: v.string(),
      scope: v.literal("owner-wide-read"),
      status: v.union([v.literal("active"), v.literal("revoked")]),
      grantedAt: v.string(),
      updatedAt: v.string(),
      revokedAt: optionalString
    })),
    serverAgent: v.optional(v.looseObject({
      credentialId: v.string(),
      deviceId: v.string(),
      placementId: v.string(),
      summary: v.looseObject({
        id: v.string(),
        name: v.string(),
        status: v.string(),
        credentialStatus: v.string(),
        owner: v.looseObject({
          id: v.string(),
          displayName: v.string()
        }),
        placement: v.looseObject({
          id: v.string(),
          deviceId: v.string(),
          state: v.string()
        })
      })
    })),
    serverAgentError: v.optional(v.string()),
    profile: v.optional(publicAgentProfileSchema),
    profileError: v.optional(v.string())
  })),
  topics: v.array(v.looseObject({
    topic: v.looseObject({
      id: v.string(),
      name: v.string(),
      visibility: v.union([v.literal("public"), v.literal("private")]),
      profile: v.looseObject({
        purpose: v.string(),
        revision: v.number(),
        participationRules: v.array(v.string()),
        expressionRules: v.array(v.string())
      })
    }),
    cursor: v.number(),
    syncedAt: v.string(),
    participants: v.array(v.looseObject({
      localAgentId: v.string(),
      serverAgentId: v.string(),
      profile: publicAgentProfileSchema
    })),
    events: v.array(v.looseObject({
      eventId: v.string(),
      publisher: v.variant("kind", [
        v.looseObject({
          kind: v.literal("agent"),
          agentId: v.string(),
          agentName: v.string(),
          ownerHumanId: v.string(),
          ownerDisplayName: v.string(),
          deviceId: v.string()
        }),
        v.looseObject({
          kind: v.literal("human"),
          humanId: v.string(),
          displayName: v.string(),
          deviceId: v.string()
        })
      ]),
      body: v.string(),
      createdAt: v.string()
    }))
  }))
});

export const serverTopicSummarySchema = v.object({
  id: v.string(),
  name: v.string(),
  visibility: v.union([v.literal("public"), v.literal("private")]),
  ownerHumanId: v.string(),
  profile: v.object({
    topicId: v.string(),
    purpose: v.string(),
    participationRules: v.array(v.string()),
    expressionRules: v.array(v.string()),
    revision: v.number(),
    updatedAt: v.string()
  }),
  createdAt: v.string()
});

export const serverTopicSummaryListSchema = v.array(serverTopicSummarySchema);

export type NetworkSafetyViewOutput = v.InferOutput<typeof networkSafetyViewSchema>;
