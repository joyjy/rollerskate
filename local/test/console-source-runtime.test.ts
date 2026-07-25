import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startUiServer } from "../src/entrypoints/console/launcher.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("Local Console serves Vite source runtime instead of static dist", async () => {
  const controller = new AbortController();
  const server = await startUiServer({
    repoRoot,
    port: 0,
    signal: controller.signal
  });
  try {
    const response = await fetch(server.url);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /\/console\/@vite\/client/);
    assert.match(html, /\/console\/src\/main\.ts/);

    const source = await fetch(new URL("src/main.ts", server.url));
    assert.equal(source.status, 200);
    assert.match(await source.text(), /createApp/);
  } finally {
    controller.abort();
    await server.close();
  }
});
