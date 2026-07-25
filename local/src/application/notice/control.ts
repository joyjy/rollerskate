import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { NoticeStore } from "../../infrastructure/sqlite/notice-store.js";
import {
  noticeDetailView,
  type NoticeDetailView
} from "./query.js";

export function markNoticeRead(
  repoRoot: string,
  noticeId: string,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): NoticeDetailView {
  const store = openStore(repoRoot, runtimeDirectory);
  try {
    return noticeDetailView(store.markRead(noticeId, at));
  } finally {
    store.close();
  }
}

export function acknowledgeNotice(
  repoRoot: string,
  noticeId: string,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): NoticeDetailView {
  const store = openStore(repoRoot, runtimeDirectory);
  try {
    return noticeDetailView(store.acknowledge(noticeId, at));
  } finally {
    store.close();
  }
}

export function rebuildNoticeIndex(
  repoRoot: string,
  runtimeDirectory?: string
): {
  readonly projected: number;
  readonly preservedStates: number;
} {
  const store = openStore(repoRoot, runtimeDirectory);
  try {
    return store.rebuildIndex();
  } finally {
    store.close();
  }
}

function openStore(
  repoRoot: string,
  runtimeDirectory?: string
): NoticeStore {
  return new NoticeStore(runtimePaths(repoRoot, runtimeDirectory).database);
}
