import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const REQUIRED_THEME_TOKENS = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "selectedBg",
  "userMessageBg",
  "userMessageText",
  "customMessageBg",
  "customMessageText",
  "customMessageLabel",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode",
] as const;

describe("fleet branding theme json", () => {
  it("fleet-dark와 fleet-light JSON이 51 토큰을 전수 정의하고 은은한 userMessageBg를 적용한다", async () => {
    const registerModule = await import("../../src/branding/register.js");

    const handlers = new Map<string, Function>();
    const pi = {
      on: (event: string, handler: Function) => {
        handlers.set(event, handler);
      },
    };

    registerModule.registerFleetBrandingLifecycle(pi as any);

    const result = handlers.get("resources_discover")?.({ cwd: process.cwd(), reason: "startup" });
    const themePaths = result?.themePaths as string[];

    expect(themePaths).toHaveLength(2);

    const expectedUserMessageBg: Record<string, string> = {
      "fleet-dark": "#1c2030",
      "fleet-light": "#eef2f8",
    };

    for (const themePath of themePaths) {
      const parsed = JSON.parse(readFileSync(themePath, "utf-8")) as {
        name: string;
        colors: Record<string, string | number>;
      };

      expect(parsed.name === "fleet-dark" || parsed.name === "fleet-light").toBe(true);
      expect(Object.keys(parsed.colors)).toHaveLength(51);
      expect(Object.keys(parsed.colors).sort()).toEqual([...REQUIRED_THEME_TOKENS].sort());
      expect(parsed.colors.userMessageBg).toBe(expectedUserMessageBg[parsed.name]);
    }
  });
});
