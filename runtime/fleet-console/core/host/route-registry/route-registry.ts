import type http from "node:http";

export interface RouteHandlerContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
}

export type RouteHandler = (ctx: RouteHandlerContext) => boolean | Promise<boolean>;

export interface RouteRegistration {
  readonly prefix: string;
  readonly handler: RouteHandler;
}

export class RouteRegistry {
  readonly #routes: RouteRegistration[] = [];

  register(prefix: string, handler: RouteHandler): void {
    this.#routes.push({ prefix: normalizePrefix(prefix), handler });
  }

  async handle(ctx: RouteHandlerContext): Promise<boolean> {
    for (const route of this.#routes) {
      if (!matchesPrefix(ctx.pathname, route.prefix)) continue;
      if (await route.handler(ctx)) return true;
    }
    return false;
  }

  list(): readonly RouteRegistration[] {
    return [...this.#routes];
  }
}

function normalizePrefix(prefix: string): string {
  return prefix.length > 1 && prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}
