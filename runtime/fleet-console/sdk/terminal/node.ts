import type { FleetPluginServerContext, FleetPluginTerminalContext } from "../plugin/types.js";
import type { TerminalTicket } from "./types.js";

export function issueTicket(ctx: FleetPluginServerContext, context: FleetPluginTerminalContext): TerminalTicket {
  return ctx.host.terminal.issueTicket(context);
}
