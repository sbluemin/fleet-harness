import { describe, expect, it } from "vitest";

import { terminalEn, terminalKo } from "../client/i18n/index.js";

const NEW_MESSAGE_KEYS = [
  "terminal.settings.idleAgent",
  "terminal.settings.idleAgentHelp",
  "terminal.settings.idleAgentOff",
  "terminal.settings.idleAgent30m",
  "terminal.settings.idleAgent1h",
  "terminal.settings.idleAgent2h",
  "terminal.settings.idleAgent4h",
  "terminal.settings.idleAgentMinutes_one",
  "terminal.settings.idleAgentMinutes_other",
  "terminal.notifications.agentInputWaitingBody",
  "terminal.notifications.agentTurnEndedBody",
  "terminal.notifications.resumeFailedMessage",
  "terminal.settings.aiGatewayDiagnostics",
  "terminal.settings.aiGatewayDiagnosticsHelp",
  "terminal.settings.aiGatewayDiagnosticsFoot",
  "terminal.settings.aiGatewayWireLog",
  "terminal.settings.aiGatewayWireLogHelp",
  "terminal.settings.terminalDrawingAria",
  "terminal.settings.terminalDrawingFoot",
  "terminal.settings.inactiveFlush",
  "terminal.settings.inactiveFlushHelp",
  "terminal.settings.inactiveFlushAria",
  "terminal.settings.inactiveFlushSaving",
  "terminal.settings.inactiveFlushBalanced",
  "terminal.settings.inactiveFlushInstant",
] as const satisfies readonly (keyof typeof terminalEn)[];

const PLACEHOLDER_KEYS = [
  "terminal.settings.idleAgentMinutes_one",
  "terminal.settings.idleAgentMinutes_other",
] as const satisfies readonly (keyof typeof terminalEn)[];

function placeholders(message: string): string[] {
  return [...message.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? "").sort();
}

describe("Terminal client i18n catalog", () => {
  it("defines distinct non-empty English and Korean settings and notification messages", () => {
    for (const key of NEW_MESSAGE_KEYS) {
      expect(terminalEn[key]).not.toBe("");
      expect(terminalKo[key]).not.toBe("");
      expect(terminalEn[key]).not.toBe(terminalKo[key]);
    }
  });

  it("keeps placeholder sets aligned across locales", () => {
    for (const key of PLACEHOLDER_KEYS) {
      expect(placeholders(terminalEn[key])).toEqual(placeholders(terminalKo[key]));
    }
  });
});
