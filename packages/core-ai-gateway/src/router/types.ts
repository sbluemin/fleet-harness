import type http from "node:http";

export type GatewayHttpHandlerContext = {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
};

export type GatewayHttpHandler = (
  ctx: GatewayHttpHandlerContext,
) => boolean | Promise<boolean>;
