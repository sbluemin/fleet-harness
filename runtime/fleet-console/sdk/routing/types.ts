import type http from "node:http";
import type { Duplex } from "node:stream";

export interface RouteHandlerContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
}

export interface UpgradeHandlerContext {
  readonly req: http.IncomingMessage;
  readonly socket: Duplex;
  readonly head: Buffer;
  readonly pathname: string;
}

export type RouteHandler = (ctx: RouteHandlerContext) => boolean | Promise<boolean>;
export type UpgradeHandler = (ctx: UpgradeHandlerContext) => boolean;
