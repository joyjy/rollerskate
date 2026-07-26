import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const localRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = resolve(localRoot, "src");

test("Local source layers preserve the core and Capability dependency boundary", () => {
  assertLayerImports("core", new Set([
    "core",
    "infrastructure"
  ]));
  assertLayerImports("capabilities", new Set([
    "capabilities",
    "core",
    "infrastructure",
    "modules"
  ]));
  assertLayerImports("application", new Set([
    "application",
    "capabilities",
    "core",
    "infrastructure",
    "integrations",
    "modules",
    "protocol.js"
  ]));
  assertLayerImports("modules", new Set([
    "modules"
  ]));
  assertLayerImports("integrations", new Set([
    "core",
    "integrations",
    "protocol.js"
  ]));
  assertLayerImports("entrypoints", new Set([
    "application",
    "bootstrap",
    "entrypoints",
    "protocol.js"
  ]));
  assertLayerImports("infrastructure", new Set([
    "capabilities",
    "core",
    "infrastructure",
    "integrations",
    "modules",
    "protocol.js"
  ]));
});

test("Core and Agent adapters do not own application result schemas", () => {
  for (const file of sourceFiles(resolve(sourceRoot, "core"))) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /AgentTurnResult@1/,
      `${relative(sourceRoot, file)} cannot own the Agent Run result schema`
    );
  }
  for (const file of sourceFiles(resolve(sourceRoot, "integrations/agent"))) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /AgentTurnResult@1|ReviewerResult@1|ImplementerResult@1/,
      `${relative(sourceRoot, file)} cannot own an application result schema`
    );
  }
});

test("Local core owns the only long-running loop", () => {
  const loopFiles = sourceFiles(sourceRoot)
    .filter((file) => readFileSync(file, "utf8").includes("while (!signal.aborted)"))
    .map((file) => relative(sourceRoot, file))
    .sort();
  assert.deepEqual(loopFiles, ["core/loop.ts"]);
  const importers = sourceFiles(sourceRoot)
    .filter((file) => /\bimport\s*\{[^}]*\brunLoop\b[^}]*\}\s*from\s*["'][^"']*core\/loop\.js["']/s
      .test(readFileSync(file, "utf8")))
    .map((file) => relative(sourceRoot, file));
  assert.deepEqual(importers, ["bootstrap/runtime.ts"]);
});

function assertLayerImports(layer: string, allowedRoots: ReadonlySet<string>): void {
  for (const file of sourceFiles(resolve(sourceRoot, layer))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      if (!target.startsWith(sourceRoot)) continue;
      const targetRoot = relative(sourceRoot, target).split("/")[0]!;
      assert.ok(
        allowedRoots.has(targetRoot),
        `${relative(sourceRoot, file)} cannot import ${targetRoot} through ${specifier}`
      );
    }
  }
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : path.endsWith(".ts") ? [path] : [];
  }).sort();
}
