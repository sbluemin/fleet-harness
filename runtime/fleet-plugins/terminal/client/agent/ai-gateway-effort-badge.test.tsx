// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/index.js", () => ({
  TerminalSurface: () => createElement("div", { className: "terminal-surface-stub" }),
}));

import { TERMINAL_MESSAGES } from "../i18n/index.js";
import { AiGatewayModelRow } from "./index.js";
import type { AiGatewayCatalogModel } from "./settings.js";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function model(levels: readonly string[]): AiGatewayCatalogModel {
  return {
    id: "cursor--grok-4.5",
    name: "Grok-4.5",
    contextWindow: 256000,
    oneMillion: false,
    maxMode: false,
    fast: false,
    capabilityClass: "flagship",
    description: null,
    effort: levels.length > 0 ? { levels: [...levels] } : null,
  };
}

interface Rendered {
  readonly host: HTMLDivElement;
  readonly picked: string[][];
}

function renderRow(options: {
  readonly levels?: readonly string[];
  readonly exposedEfforts?: readonly string[];
  readonly saving?: boolean;
} = {}): Rendered {
  const picked: string[][] = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(AiGatewayModelRow, {
      model: model(options.levels ?? ["low", "medium", "high"]),
      ...(options.exposedEfforts ? { exposedEfforts: options.exposedEfforts } : {}),
      isDefault: false,
      saving: options.saving ?? false,
      onRemove: () => {},
      onSetDefault: () => {},
      onSetEfforts: (efforts) => picked.push([...efforts]),
    }));
  });
  return { host: container, picked };
}

function levelButtons(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll(".ai-gateway-effort-level")].filter(
    (node): node is HTMLButtonElement => node instanceof HTMLButtonElement,
  );
}

describe("ai gateway effort badge", () => {
  it("shows the whole ladder in the badge itself, with no disclosure left to open", () => {
    const { host } = renderRow();
    expect(levelButtons(host).map((button) => button.textContent)).toEqual(["low", "medium", "high"]);
    expect(host.querySelector(".ai-gateway-levels-toggle")).toBeNull();
    expect(host.querySelector("[aria-expanded]")).toBeNull();
  });

  it("keeps the badge inside the attribute chips so the row stays one line of properties", () => {
    const { host } = renderRow();
    const badge = host.querySelector(".ai-gateway-effort");
    expect(badge?.parentElement?.className).toBe("ai-gateway-chips");
    expect(badge?.getAttribute("role")).toBe("group");
    expect(badge?.firstElementChild?.textContent).toBe("effort");
    // 범위 요약 칩은 배지가 사다리를 직접 보여주므로 남지 않는다.
    expect(host.textContent).not.toContain("effort low–high");
  });

  it("marks exposed levels pressed and narrowed ones unpressed, without hiding either", () => {
    const { host } = renderRow({ exposedEfforts: ["low", "high"] });
    expect(levelButtons(host).map((button) => button.getAttribute("aria-pressed")))
      .toEqual(["true", "false", "true"]);
  });

  it("adds a level on click and drops an exposed one, reporting the whole next ladder", () => {
    const { host, picked } = renderRow({ exposedEfforts: ["low", "high"] });
    act(() => levelButtons(host)[1]?.click());
    act(() => levelButtons(host)[0]?.click());
    expect(picked).toEqual([["low", "high", "medium"], ["high"]]);
  });

  it("locks the last exposed level on rather than letting a model reach zero identities", () => {
    const { host, picked } = renderRow({ exposedEfforts: ["medium"] });
    const [low, medium, high] = levelButtons(host);
    expect(medium?.disabled).toBe(true);
    expect(low?.disabled).toBe(false);
    expect(high?.disabled).toBe(false);
    act(() => medium?.click());
    expect(picked).toEqual([]);
  });

  it("suspends every level while a save is in flight", () => {
    const { host } = renderRow({ saving: true });
    expect(levelButtons(host).every((button) => button.disabled)).toBe(true);
  });

  it("says on hover what a level costs, counting only the exposed ones", () => {
    const { host } = renderRow({ exposedEfforts: ["low", "high"] });
    const badge = host.querySelector(".ai-gateway-effort");
    expect(badge?.getAttribute("title")).toBe(
      TERMINAL_MESSAGES.en["terminal.settings.aiGatewayIdentityCount"].replace("{count}", "2"),
    );
    expect(badge?.getAttribute("aria-label")).toBe(
      TERMINAL_MESSAGES.en["terminal.settings.aiGatewayLevelsAria"].replace("{name}", "Grok-4.5"),
    );
  });

  it("renders no effort badge for a model whose catalog entry has no ladder", () => {
    const { host } = renderRow({ levels: [] });
    expect(host.querySelector(".ai-gateway-effort")).toBeNull();
    expect(host.querySelector(".ai-gateway-chips")).not.toBeNull();
  });

  it("keeps both locales translated for the surfaces the badge still carries", () => {
    for (const key of ["terminal.settings.aiGatewayLevelsAria", "terminal.settings.aiGatewayIdentityCount"] as const) {
      expect(TERMINAL_MESSAGES.en[key]).not.toBe("");
      expect(TERMINAL_MESSAGES.ko[key]).not.toBe("");
      expect(TERMINAL_MESSAGES.en[key]).not.toBe(TERMINAL_MESSAGES.ko[key]);
    }
  });
});
