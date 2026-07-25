import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DeviceCredentialStore } from "../src/infrastructure/files/device-credential-store.js";

test("device credential store rejects loose permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-device-secret-"));
  try {
    const path = join(directory, "credential.json");
    const store = new DeviceCredentialStore(path);
    store.save({
      serverUrl: "https://server.example.com",
      deviceId: "device-id",
      credentialId: "credential-id",
      credential: "credential-id.private-secret-value"
    });
    chmodSync(path, 0o644);
    assert.throws(() => store.load(), /must not be accessible/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("device credential store rejects symlink targets", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-device-symlink-"));
  try {
    const target = join(directory, "target.json");
    const targetStore = new DeviceCredentialStore(target);
    targetStore.save({
      serverUrl: "https://server.example.com",
      deviceId: "device-id",
      credentialId: "credential-id",
      credential: "credential-id.private-secret-value"
    });
    const link = join(directory, "credential.json");
    symlinkSync(target, link);
    const store = new DeviceCredentialStore(link);
    assert.throws(() => store.load(), /must not be a symlink/);
    assert.throws(() => store.save({
      serverUrl: "https://server.example.com",
      deviceId: "device-id",
      credentialId: "credential-id",
      credential: "credential-id.another-secret-value"
    }), /must not be a symlink/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
