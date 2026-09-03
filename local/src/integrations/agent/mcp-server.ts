import { isAbsolute } from "node:path";

export interface StdioMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly tools: readonly string[];
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
  if (server.tools.length === 0 || new Set(server.tools).size !== server.tools.length ||
    server.tools.some((tool) => !/^[A-Za-z0-9_-]{1,64}$/.test(tool))) {
    throw new Error("MCP server tool manifest is invalid");
  }
}

export function stdioMcpAllowedTools(servers: readonly StdioMcpServer[]): string[] {
  const tools = servers.flatMap((server) => {
    validateStdioMcpServer(server);
    return server.tools.map((tool) => `mcp__${server.name}__${tool}`);
  });
  if (new Set(tools).size !== tools.length) {
    throw new Error("MCP server tool manifest contains duplicate qualified names");
  }
  return tools;
}
