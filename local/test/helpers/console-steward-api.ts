import { once } from "node:events";
import { createServer } from "node:http";
import { serveStewardApi } from "../../src/entrypoints/console/steward-api.js";

/** A native HTTP boundary against an isolated Runtime, without a UI or daemon. */
export async function withConsoleStewardApi(
  repoRoot: string,
  runtimeDirectory: string,
  exercise: (post: (path: string, body: unknown, marker?: string) => Promise<{
    status: number; body: Record<string, unknown>;
  }>) => Promise<void>
): Promise<void> {
  const server = createServer((request, response) => {
    void serveStewardApi(repoRoot, runtimeDirectory, request, request.headers["x-rollerskate-request"],
      new URL(request.url!, "http://127.0.0.1"), response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected loopback HTTP address");
  try {
    await exercise(async (path, body, marker = "console") => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: "POST", headers: {"content-type": "application/json", "x-rollerskate-request": marker},
        body: JSON.stringify(body)
      });
      return {status: response.status, body: await response.json() as Record<string, unknown>};
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
