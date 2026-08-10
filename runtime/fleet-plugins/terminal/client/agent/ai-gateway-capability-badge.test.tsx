// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/index.js", () => ({
  TerminalSurface: () => createElement("div", { className: "terminal-surface-stub" }),
}));

import { TERMINAL_MESSAGES } from "../i18n/index.js";
import { AiGatewayModelRow } from "./index.js";
import type { AiGatewayCapabilityClass, AiGatewayCatalogModel } from "./settings.js";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function model(capabilityClass: AiGatewayCapabilityClass | null): AiGatewayCatalogModel {
  return {
    id: "cursor--grok-4.5",
    name: "Grok-4.5",
    contextWindow: 256000,
    oneMillion: false,
    maxMode: false,
    fast: false,
    capabilityClass,
    description: null,
    effort: { levels: ["low", "medium", "high"] },
  };
}

function renderRow(capabilityClass: AiGatewayCapabilityClass | null): HTMLElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(AiGatewayModelRow, {
      model: model(capabilityClass),
      hostOnly: false,
      saving: false,
      onRemove: () => {},
      onSetEfforts: () => {},
      onToggleHostOnly: () => {},
    }));
  });
  const badge = container.querySelector(".ai-gateway-class-badge");
  if (!(badge instanceof HTMLElement)) throw new Error("capability badge did not render");
  return badge;
}

describe("ai gateway capability badge", () => {
  it("labels each class with the catalog's own literal so the roster and the host share one vocabulary", () => {
    expect(renderRow("flagship").textContent).toBe("flagship");
    expect(renderRow("standard").textContent).toBe("standard");
    expect(renderRow("light").textContent).toBe("light");
  });

  it("separates the three grades by class modifier, keeping standard on the base rule", () => {
    expect(renderRow("flagship").className).toContain("is-flagship");
    expect(renderRow("standard").className).toContain("is-standard");
    expect(renderRow("light").className).toContain("is-light");
  });

  it("states the absent class rather than hiding the badge for a routing alias", () => {
    const badge = renderRow(null);
    expect(badge.textContent).toBe("unclassed");
    expect(badge.className).toContain("is-unclassed");
    expect(badge.title).toBe(TERMINAL_MESSAGES.en["terminal.settings.aiGatewayClassUnclassedTooltip"]);
  });

  it("hovers one line per grade explaining the meaning and how the host reads it", () => {
    expect(renderRow("flagship").title).toBe(TERMINAL_MESSAGES.en["terminal.settings.aiGatewayClassFlagshipTooltip"]);
    expect(renderRow("standard").title).toBe(TERMINAL_MESSAGES.en["terminal.settings.aiGatewayClassStandardTooltip"]);
    expect(renderRow("light").title).toBe(TERMINAL_MESSAGES.en["terminal.settings.aiGatewayClassLightTooltip"]);
  });

  it("sits beside the model name rather than among the attribute chips", () => {
    const badge = renderRow("flagship");
    const head = badge.parentElement;
    expect(head?.className).toBe("ai-gateway-model-head");
    expect(badge.previousElementSibling?.className).toBe("ai-gateway-model-name");
    expect(badge.closest(".ai-gateway-chips")).toBeNull();
  });

  it("keeps both locales on one line and never leaves a grade untranslated", () => {
    const keys = [
      "terminal.settings.aiGatewayClassFlagshipTooltip",
      "terminal.settings.aiGatewayClassStandardTooltip",
      "terminal.settings.aiGatewayClassLightTooltip",
      "terminal.settings.aiGatewayClassUnclassedTooltip",
    ] as const;
    for (const key of keys) {
      const en = TERMINAL_MESSAGES.en[key];
      const ko = TERMINAL_MESSAGES.ko[key];
      expect(en).not.toBe("");
      expect(ko).not.toBe("");
      expect(en).not.toBe(ko);
      expect(en).not.toContain("\n");
      expect(ko).not.toContain("\n");
    }
  });
});
