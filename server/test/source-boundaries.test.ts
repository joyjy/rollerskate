import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = resolve(
  serverRoot,
  "src/adapter/persistence/mysql/repository"
);

test("MySQL repository support remains a thin domain barrel", () => {
  const support = readFileSync(resolve(repositoryRoot, "support.ts"), "utf8");
  assert.doesNotMatch(support, /\binterface\b|\bfunction\b|\bSELECT\b/);
  for (const owner of [
    "transaction.ts",
    "human-support.ts",
    "trust-support.ts",
    "device-support.ts",
    "agent-support.ts",
    "room-support.ts"
  ]) {
    const moduleSpecifier = `./${owner.replace(/\.ts$/u, ".js")}`;
    assert.ok(support.includes(moduleSpecifier));
  }
});
