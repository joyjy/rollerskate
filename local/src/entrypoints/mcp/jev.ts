import { isAbsolute } from "node:path";
import { callJevTool, jevTool } from "../../application/judgment/jev.js";
import { runStdioMcpToolServer } from "./stdio-server.js";
const keyFile = process.argv[2];
if (process.argv.length !== 3 || !keyFile || !isAbsolute(keyFile)) throw new Error("Jev requires an absolute private credential file");
void runStdioMcpToolServer({ name: "rollerskate-jev", version: "0.6.1", tools: [jevTool],
  call: (name, args, signal) => callJevTool(keyFile, name, args, signal)
}).catch(() => { process.stderr.write("Jev tool server failed\n"); process.exitCode = 1; });
