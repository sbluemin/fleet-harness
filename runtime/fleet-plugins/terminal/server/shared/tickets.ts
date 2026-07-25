import crypto from "node:crypto";

import type { TerminalTicket, TerminalTicketContext } from "./terminal-types.js";

export interface TerminalTicketRegistryDeps {
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly randomTicket?: () => string;
}

export interface TerminalTicketRegistry {
  readonly ttlMs: number;
  issue(context: TerminalTicketContext): TerminalTicket;
  consume(ticket: string | null): TerminalTicketContext | null;
  /** Drop every outstanding (unconsumed) ticket for the given session identity. */
  invalidateForSession(sessionId: string): void;
  prune(): void;
}

interface StoredTicket {
  readonly expiresAt: number;
  readonly context: TerminalTicketContext;
}

const DEFAULT_TICKET_TTL_MS = 10_000;

export function createPluginTerminalTicketRegistry(deps: TerminalTicketRegistryDeps = {}): TerminalTicketRegistry {
  const ttlMs = deps.ttlMs ?? DEFAULT_TICKET_TTL_MS;
  const now = deps.now ?? Date.now;
  const randomTicket = deps.randomTicket ?? (() => crypto.randomBytes(32).toString("base64url"));
  const tickets = new Map<string, StoredTicket>();

  function issue(context: TerminalTicketContext): TerminalTicket {
    prune();
    const ticket = randomTicket();
    tickets.set(ticket, { context, expiresAt: now() + ttlMs });
    return { ticket, ttlMs };
  }

  function consume(ticket: string | null): TerminalTicketContext | null {
    prune();
    if (!ticket) return null;
    const stored = tickets.get(ticket);
    if (!stored || stored.expiresAt <= now()) {
      tickets.delete(ticket);
      return null;
    }
    tickets.delete(ticket);
    return stored.context;
  }

  function invalidateForSession(sessionId: string): void {
    for (const [ticket, stored] of tickets) {
      if (stored.context.sessionId === sessionId) tickets.delete(ticket);
    }
  }

  function prune(): void {
    const current = now();
    for (const [ticket, stored] of tickets) {
      if (stored.expiresAt <= current) tickets.delete(ticket);
    }
  }

  return { ttlMs, issue, consume, invalidateForSession, prune };
}
