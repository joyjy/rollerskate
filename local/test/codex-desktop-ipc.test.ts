import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pushToCodexDesktop } from "../src/integrations/codex-desktop/ipc.js";
import { codexPushRunner } from "../src/integrations/codex-desktop/push.js";
import { runCodexPushCommand } from "../src/entrypoints/cli/codex-push.js";

const THREAD = "01a08ecd-5752-72e1-bc4f-f10554b86125";
interface Request {
  type: string;
  requestId: string;
  method: string;
  version: number;
  targetClientId?: string;
  params: Record<string, unknown>;
}

for (const scenario of ["active", "idle", "disconnect", "idle-disconnect", "other-thread", "timeout", "wrong-owner", "oversized", "cli-idle"] as const) {
  test(`bundled Desktop IPC: ${scenario}, without an external executable`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rs-desktop-ipc-"));
    const socketPath = join(root, "ipc.sock");
    const requests: Request[] = [];
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      let buffer: Buffer = Buffer.alloc(0);
      socket.on("data", data => {
        buffer = Buffer.concat([buffer, data]);
        while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
          const size = buffer.readUInt32LE(0);
          const request = JSON.parse(buffer.subarray(4, size + 4).toString()) as Request;
          buffer = buffer.subarray(size + 4);
          requests.push(request);
          const method = request.method;
          if ((scenario === "disconnect" && method === "thread-follower-steer-turn") ||
              (scenario === "idle-disconnect" && method === "thread-follower-start-turn")) { socket.destroy(); return; }
          if (scenario === "timeout" && method === "thread-follower-steer-turn") return;
          if (scenario === "oversized") {
            const frame = Buffer.alloc(4); frame.writeUInt32LE(2 * 1024 * 1024 + 1); socket.write(frame); return;
          }
          let reply: Record<string, unknown> = { type: "response", requestId: request.requestId,
            method, handledByClientId: "owner", resultType: "success", result:
              method === "initialize" ? { clientId: "external" } :
              method === "thread-owner-discovery" ? { supportsUntrustedAppInput: true } :
              method === "thread-follower-start-turn" ? { result: { turn: { id: "new-turn" } } } :
              { result: { turnId: "active-turn" } } };
          if (method === "thread-follower-steer-turn" && ["idle", "idle-disconnect", "cli-idle", "other-thread"].includes(scenario)) {
            reply = { type: "response", requestId: request.requestId, resultType: "error",
              error: `Cannot steer conversation ${scenario === "other-thread" ? "another" : THREAD} because its active turn already ended` };
          }
          if (scenario === "wrong-owner" && method === "thread-follower-steer-turn") reply.handledByClientId = "another-owner";
          const body = Buffer.from(JSON.stringify(reply));
          const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
          const frame = Buffer.concat([header, body]);
          socket.write(frame.subarray(0, 2));
          socket.write(frame.subarray(2, 9));
          socket.write(frame.subarray(9));
        }
      });
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
      chmodSync(socketPath, 0o600);
      let receipt;
      if (scenario === "cli-idle") {
        let output = "";
        const code = await runCodexPushCommand(["--thread", THREAD, "--socket", socketPath, "send"],
          { write: text => { output += text; } }, (async function* () { yield Buffer.from("RS_NATIVE"); })());
        assert.equal(code, 0);
        receipt = JSON.parse(output);
      } else {
        receipt = JSON.parse(await codexPushRunner({ socketPath, timeoutMilliseconds: 300 })(THREAD, "RS_NATIVE"));
      }
      const expected = ["active", "idle", "cli-idle"].includes(scenario) ? "accepted" : scenario === "oversized" ? "not_sent" : "unknown";
      assert.equal(receipt.status, expected);
      const mutations = requests.filter(r => r.method.startsWith("thread-follower-"));
      const starts = mutations.filter(r => r.method === "thread-follower-start-turn");
      assert.equal(starts.length, ["idle", "idle-disconnect", "cli-idle"].includes(scenario) ? 1 : 0);
      for (const request of mutations) {
        assert.equal(request.targetClientId, "owner");
        assert.equal(request.params.conversationId, THREAD);
      }
      if (starts[0]) {
        assert.equal(starts[0].version, 2);
        assert.deepEqual(starts[0].params.turnStart, { request: { threadId: THREAD,
          input: [{ type: "text", text: "RS_NATIVE", text_elements: [] }] }, context: { inheritThreadSettings: true } });
      }
      if (receipt.status === "accepted") assert.equal(receipt.turnId, scenario === "active" ? "active-turn" : "new-turn");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("Desktop missing socket, invalid target and oversized message fail before dispatch", async () => {
  assert.equal((await pushToCodexDesktop(THREAD, "hello", { socketPath: "/no-such-rs-ipc/socket" })).status, "not_sent");
  assert.equal((await pushToCodexDesktop("latest", "hello")).status, "not_sent");
  assert.equal((await pushToCodexDesktop(THREAD, "x".repeat(65_537))).status, "not_sent");
});
