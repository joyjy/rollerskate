import { spawn } from "node:child_process";

import type { RuntimeDestinationAdapter } from "../../core/runtime/handlers.js";

export interface MacOsNotification {
  readonly title: string;
  readonly subtitle: string;
  readonly body: string;
}

export type MacOsNotificationRunner = (
  notification: MacOsNotification
) => Promise<void>;

export class MacOsNotificationAdapter implements RuntimeDestinationAdapter {
  public readonly kind = "macos-notification" as const;
  readonly #notify: MacOsNotificationRunner;

  public constructor(notify: MacOsNotificationRunner = displayMacOsNotification) {
    this.#notify = notify;
  }

  public async deliver(
    input: Parameters<RuntimeDestinationAdapter["deliver"]>[0]
  ): Promise<{ readonly receipt: string }> {
    const title = input.destination.address.title;
    const subscriptionId = input.destination.address.subscriptionId;
    if (title === undefined || subscriptionId === undefined) {
      throw new Error(
        `macOS notification destination address is incomplete: ` +
        input.destination.destinationId
      );
    }
    const succeeded = input.resultEvent.outcome === "succeeded";
    await this.#notify({
      title,
      subtitle: "Rollerskate",
      body: succeeded
        ? "Result saved to the original task. Reopen it; restart the client if the open view has not refreshed."
        : `Callback failed and the failure was saved. Inspect Subscription ${subscriptionId}.`
    });
    return { receipt: `macos-notification:${input.delivery.deliveryId}` };
  }
}

export async function displayMacOsNotification(
  notification: MacOsNotification
): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("macOS notifications are unavailable on this platform");
  }
  const script = [
    "on run argv",
    "display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv)",
    "end run"
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", [
      "-e", script[0]!,
      "-e", script[1]!,
      "-e", script[2]!,
      "--",
      notification.title,
      notification.subtitle,
      notification.body
    ], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let error = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      error = `${error}${chunk}`.slice(-4_096);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(
        `osascript notification failed with exit ${code ?? "unknown"}: ${error.trim()}`
      ));
    });
  });
}
