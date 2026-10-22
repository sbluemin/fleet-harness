import http from "node:http";
import { randomUUID } from "node:crypto";
import type { McpHttpTransport, McpCatalogReader } from "@fleet-console/agent-runtime/mcp";

export function createMcpHttpTransport(origin?: () => string | null) {
  const handlers = new Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>();
  const catalogs = new Map<string, McpCatalogReader>();
  let server: http.Server | undefined;
  let starting: Promise<string> | undefined;
  let closed = false;
  const prefix = "/mcp/";
  const handle = (req: http.IncomingMessage, res: http.ServerResponse): boolean => {
    if (!req.url?.startsWith(prefix)) return false;
    const handler = handlers.get(req.url);
    if (!handler || req.headers.origin) { res.writeHead(404); res.end(); return true; }
    handler(req, res);
    return true;
  };
  const getOrigin = async () => {
    if (closed) throw new Error("MCP transport is closed");
    if (origin) {
      const value = origin();
      if (!value) throw new Error("Console listener is not ready");
      return value;
    }
    starting ??= new Promise<string>((resolve, reject) => {
      server = http.createServer((req, res) => { if (!handle(req, res)) { res.writeHead(404); res.end(); } });
      server.timeout = 30 * 60 * 1000;
      server.keepAliveTimeout = 30 * 60 * 1000;
      server.headersTimeout = 30 * 60 * 1000 + 1000;
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server!.address();
        if (!address || typeof address === "string") return reject(new Error("MCP listener bind failed"));
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
    return starting;
  };
  const transport: McpHttpTransport = {
    mount(handler, catalog) {
      if (closed) throw new Error("MCP transport is closed");
      const path = `${prefix}${randomUUID()}`;
      handlers.set(path, handler);
      if (catalog) catalogs.set(path, catalog);
      return { url: async () => `${await getOrigin()}${path}`, dispose: () => { handlers.delete(path); catalogs.delete(path); } };
    },
  };
  const readCatalog = async (url: string, request: Parameters<McpCatalogReader>[0]): Promise<unknown> => {
    const endpoint = new URL(url);
    const currentOrigin = await getOrigin();
    const read = catalogs.get(endpoint.pathname);
    if (endpoint.origin !== new URL(currentOrigin).origin || endpoint.search || endpoint.hash || !read) throw new Error("mcp_catalog_scope_unavailable");
    return read(request);
  };
  const ownsCatalog = (url: string): boolean => {
    if (closed || !origin?.()) return false;
    const endpoint = new URL(url);
    return endpoint.origin === new URL(origin()!).origin && !endpoint.search && !endpoint.hash && catalogs.has(endpoint.pathname);
  };
  return { transport, handle, readCatalog, catalog: { owns: ownsCatalog, read: readCatalog }, async dispose() {
    closed = true;
    handlers.clear(); catalogs.clear();
    if (starting) await starting.catch(() => {});
    if (server) await new Promise<void>((resolve) => { server!.close(() => resolve()); server!.closeAllConnections(); });
  } };
}
