import { FreeChatModeStore } from "../../infrastructure/sqlite/free-chat-mode-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import type {
  FreeChatMode,
  FreeChatModeReceipt
} from "../../modules/topic/free-chat.js";
import { materializeLocalTopicGovernance } from "./governance-control.js";

export interface FreeChatModeView {
  readonly mode?: FreeChatMode;
  readonly recentReceipts: readonly FreeChatModeReceipt[];
  readonly actionAvailability: {
    readonly start: boolean;
    readonly continueNow: boolean;
    readonly exit: boolean;
    readonly expectedRevision?: number;
  };
}

export function inspectLocalFreeChat(
  repoRoot: string,
  runtimeDirectory?: string
): FreeChatModeView {
  const governance = materializeLocalTopicGovernance(
    repoRoot, runtimeDirectory
  ).governance;
  const store = new FreeChatModeStore(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    const mode = store.latest(governance.topicId);
    return {
      ...(mode === undefined ? {} : { mode }),
      recentReceipts: mode === undefined ? [] : store.receipts(mode.modeId),
      actionAvailability: {
        start: mode?.status !== "active" && governance.status === "active",
        continueNow: mode?.status === "active" && governance.status === "active",
        exit: mode?.status === "active",
        ...(mode === undefined ? {} : { expectedRevision: mode.revision })
      }
    };
  } finally {
    store.close();
  }
}
