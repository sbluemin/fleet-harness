import type http from "node:http";
export interface McpTransport {
  mount(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): { url(): Promise<string>; dispose(): void };
}
