import { isAbsolute } from "node:path";

export interface StdioMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}

export function stdioMcpConfig(servers: readonly StdioMcpServer[]): string {
  return JSON.stringify({
    mcpServers: Object.fromEntries(servers.map((server) => {
      validateStdioMcpServer(server);
      return [server.name, { command: server.command, args: server.args }];
    }))
  });
}

export function validateStdioMcpServer(server: StdioMcpServer): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(server.name)) {
    throw new Error("MCP server name is invalid");
  }
  if (!isAbsolute(server.command)) {
    throw new Error("MCP server command must be absolute");
  }
  if (server.args.some((argument) => argument.includes("\0"))) {
    throw new Error("MCP server argument is invalid");
  }
}
