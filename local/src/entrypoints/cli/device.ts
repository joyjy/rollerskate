import {
  loginDevice,
  logoutDevice,
  statusDevice,
  type LocalDeviceStatus
} from "../../application/device/server-control.js";
import type { AppOutput, LocalAppDependencies } from "./shared.js";
import { rejectArguments, runtimeDependency } from "./shared.js";

export async function runDeviceCommand(
  repoRoot: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  output: AppOutput,
  runtimeDirectory: string | undefined,
  appDependencies: LocalAppDependencies
): Promise<number> {
  const [command, ...rest] = arguments_;
  const dependencies = {
    ...runtimeDependency(runtimeDirectory),
    ...(appDependencies.fetch === undefined ? {} : { fetch: appDependencies.fetch }),
    ...(appDependencies.now === undefined ? {} : { now: appDependencies.now }),
    ...(appDependencies.sleep === undefined ? {} : { sleep: appDependencies.sleep })
  };
  if (command === "login") {
    rejectArguments(rest);
    const serverUrl = environment.ROLLERSKATE_SERVER_URL?.trim();
    const result = await loginDevice(repoRoot, {
      ...(serverUrl === undefined || serverUrl === "" ? {} : { serverUrl })
    }, { write: (text) => output.write(text), ...dependencies });
    output.write(formatDeviceStatus("Device paired.", result));
    return 0;
  }
  if (command === "status") {
    rejectArguments(rest);
    output.write(formatDeviceStatus(
      "Device is active.",
      await statusDevice(repoRoot, dependencies)
    ));
    return 0;
  }
  if (command === "logout") {
    rejectArguments(rest);
    await logoutDevice(repoRoot, dependencies);
    output.write("Device credential revoked and removed from this Local Runtime.\n");
    return 0;
  }
  throw new Error("device requires login, status or logout");
}

function formatDeviceStatus(prefix: string, result: LocalDeviceStatus): string {
  return [
    prefix,
    `Device: ${result.summary.name} (${result.summary.id})`,
    `Human: ${result.summary.human.displayName} (${result.summary.human.id})`,
    `Admin: ${result.summary.human.isAdmin ? "yes" : "no"}`,
    `Server: ${result.metadata.serverUrl}`
  ].join("\n") + "\n";
}
