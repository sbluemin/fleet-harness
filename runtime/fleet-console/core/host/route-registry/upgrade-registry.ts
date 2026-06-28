import type http from "node:http";
import type { Duplex } from "node:stream";

export interface UpgradeHandlerContext {
  readonly req: http.IncomingMessage;
  readonly socket: Duplex;
  readonly head: Buffer;
  readonly pathname: string;
}

export type UpgradeHandler = (ctx: UpgradeHandlerContext) => boolean;

export interface UpgradeRegistration {
  readonly prefix: string;
  readonly handler: UpgradeHandler;
}

export class UpgradeRegistry {
  readonly #handlers: UpgradeRegistration[] = [];

  register(prefix: string, handler: UpgradeHandler): void {
    this.#handlers.push({ prefix: normalizePrefix(prefix), handler });
  }

  handle(ctx: UpgradeHandlerContext): boolean {
    for (const handler of this.#handlers) {
      if (!matchesPrefix(ctx.pathname, handler.prefix)) continue;
      if (handler.handler(ctx)) return true;
    }
    return false;
  }

  list(): readonly UpgradeRegistration[] {
    return [...this.#handlers];
  }
}

function normalizePrefix(prefix: string): string {
  return prefix.length > 1 && prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}
