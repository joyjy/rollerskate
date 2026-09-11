import { chmodSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { TestContext } from "node:test";

/** A discovery-only Desktop fixture: any attempted user input is rejected and recorded. */
export function desktopTargetFixture(t: TestContext, root: string, threadId: string) {
  const path = join(root, "ipc.sock");
  const requests: string[] = [];
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
        const request = JSON.parse(buffer.subarray(4, size + 4).toString());
        buffer = buffer.subarray(size + 4);
        requests.push(request.method);
        const known = request.method === "initialize" || request.method === "thread-owner-discovery" && request.params.conversationId === threadId;
        const reply = Buffer.from(JSON.stringify({ type:"response", requestId:request.requestId, method:request.method,
          resultType:known ? "success" : "error", handledByClientId:"fixture-owner",
          ...(known ? {result:request.method === "initialize" ? {clientId:"fixture-client"} : {supportsUntrustedAppInput:true}} : {error:"no-client-found"}) }));
        const prefix = Buffer.alloc(4); prefix.writeUInt32LE(reply.length); socket.write(Buffer.concat([prefix,reply]));
      }
    });
  });
  const ready = new Promise<void>((resolve, reject) => {server.once("error",reject);server.listen(path,()=>{chmodSync(path,0o600);resolve();});});
  t.after(async()=>{for(const socket of sockets) socket.destroy(); await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return {path,ready,requests};
}
