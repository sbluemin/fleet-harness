import type http from "node:http";
export type ApiCatalogMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "*";

export type ApiCatalogGate = "loopback" | "origin-write" | "origin-strict" | "lock-token" | "anthropic-credential" | "one-use-ticket";

export type ApiCatalogTransport = "http" | "sse" | "websocket" | "proxy";


export interface ApiCatalogEntry {
  readonly method: ApiCatalogMethod;
  readonly path: string;
  readonly summary: string;
  readonly category: string;
  readonly gate: ApiCatalogGate;
  readonly transport: ApiCatalogTransport;
}
