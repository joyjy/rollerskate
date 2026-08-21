import { listAgents } from "../agent/control.js";
import { inspectServerAgent } from "../agent/server-control.js";
import { inspectActivityAccess } from "../activity/control.js";
import { inspectLocalDevice } from "../device/query.js";
import { inspectAgentPublicProfile } from "../topic/control.js";
import { passiveTopicInboxView } from "../topic/query.js";

export async function networkSafetyView(
  repoRoot: string,
  options: {
    readonly runtimeDirectory?: string;
    readonly fetch?: typeof fetch;
    readonly configuredServerUrl?: string;
  } = {}
) {
  const localOptions = options.runtimeDirectory === undefined
    ? {}
    : { runtimeDirectory: options.runtimeDirectory };
  const agents = listAgents(repoRoot, localOptions);
  return {
    ...(options.configuredServerUrl === undefined
      ? {}
      : { configuredServerUrl: options.configuredServerUrl }),
    device: inspectLocalDevice(repoRoot, options.runtimeDirectory),
    agents: await Promise.all(agents.map(async (agent) => {
      let profile: unknown;
      let profileError: string | undefined;
      let serverAgent: unknown;
      let serverAgentError: string | undefined;
      try {
        serverAgent = await inspectServerAgent(repoRoot, agent.handle, options);
      } catch (error) {
        serverAgentError = error instanceof Error ? error.message : String(error);
      }
      if (serverAgent !== undefined) {
        try {
          profile = await inspectAgentPublicProfile(repoRoot, agent.handle, options);
        } catch (error) {
          profileError = error instanceof Error ? error.message : String(error);
        }
      }
      return {
        agent,
        activityAccess: inspectActivityAccess(repoRoot, agent.handle, localOptions) ?? null,
        ...(serverAgent === undefined ? {} : { serverAgent }),
        ...(serverAgentError === undefined ? {} : { serverAgentError }),
        ...(profile === undefined ? {} : { profile }),
        ...(profileError === undefined ? {} : { profileError })
      };
    })),
    topics: passiveTopicInboxView(repoRoot, options.runtimeDirectory)
  };
}
