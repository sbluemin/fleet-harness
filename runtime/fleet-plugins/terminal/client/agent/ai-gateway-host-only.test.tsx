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

const MODEL: AiGatewayCatalogModel = {
  id: "cursor--grok-4.5",
  name: "Grok-4.5",
  contextWindow: 256000,
  oneMillion: false,
  maxMode: false,
  fast: false,
  capabilityClass: "flagship",
  description: null,
  effort: { levels: ["low", "medium", "high"] },
};

function renderRow(options: {
  readonly hostOnly: boolean;
  readonly saving?: boolean;
  readonly onToggleHostOnly?: () => void;
}): HTMLElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(AiGatewayModelRow, {
      model: MODEL,
      hostOnly: options.hostOnly,
      isDefault: false,
      saving: options.saving ?? false,
      onRemove: () => {},
      onSetDefault: () => {},
      onSetEfforts: () => {},
      onToggleHostOnly: options.onToggleHostOnly ?? (() => {}),
    }));
  });
  const control = container.querySelector(".ai-gateway-host-only");
  if (!(control instanceof HTMLElement)) throw new Error("host-only control did not render");
  return control;
}

describe("ai gateway host-only control", () => {
  it("carries a one-line summary that hover and keyboard focus reveal", () => {
    // 라벨 두 단어로는 "와이어에는 남고 로스터에서만 빠진다"를 읽을 수 없다 — 이 한 줄이
    // 그 컨트롤의 유일한 설명이다.
    const control = renderRow({ hostOnly: false });
    const tip = control.nextElementSibling;
    expect(tip?.className).toBe("ai-gateway-host-only-tip");
    expect(tip?.textContent).toBe(TERMINAL_MESSAGES.en["terminal.settings.aiGatewayHostOnlyTip"]);
    expect(tip?.getAttribute("role")).toBe("tooltip");
  });

  it("draws that summary in the page rather than delegating to the browser's own tooltip", () => {
    // 네이티브 title은 브라우저가 그려서 지연이 길고 토큰을 안 따르며 스크린샷에도 안 잡힌다 —
    // 실제로 이 패널에서 사용자가 못 보고 지나갔다. 그 속성으로 되돌아가면 이 단언이 막는다.
    const control = renderRow({ hostOnly: false });
    expect(control.getAttribute("title")).toBeNull();
  });

  it("keeps the tip an immediate sibling, which is what the hover rule selects on", () => {
    // CSS가 `.ai-gateway-host-only:hover + .ai-gateway-host-only-tip`로 여는 구조라,
    // 사이에 무엇이든 끼면 말풍선은 조용히 영영 안 뜬다.
    const control = renderRow({ hostOnly: false });
    expect(control.nextElementSibling?.classList.contains("ai-gateway-host-only-tip")).toBe(true);
    expect(control.parentElement?.className).toBe("ai-gateway-model-row");
  });

  it("keeps every host-only string one line in both locales and never leaves one untranslated", () => {
    const keys = [
      "terminal.settings.aiGatewayHostOnly",
      "terminal.settings.aiGatewayHostOnlyAria",
      "terminal.settings.aiGatewayHostOnlyTip",
      "terminal.settings.aiGatewayHostOnlyNote",
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

  it("names both the picker it keeps the model in and the surfaces it withholds it from", () => {
    // 문장이 한쪽만 말하면 사용자는 모델을 잃는 줄 알고 켜지 않는다.
    for (const line of [
      TERMINAL_MESSAGES.en["terminal.settings.aiGatewayHostOnlyTip"],
      TERMINAL_MESSAGES.ko["terminal.settings.aiGatewayHostOnlyTip"],
    ]) {
      expect(line).toContain("/model");
      expect(line).toContain("gateway_models");
    }
  });

  it("reports its state through aria-pressed rather than colour alone", () => {
    expect(renderRow({ hostOnly: false }).getAttribute("aria-pressed")).toBe("false");
    expect(renderRow({ hostOnly: true }).getAttribute("aria-pressed")).toBe("true");
    expect(renderRow({ hostOnly: true }).className).toContain("is-on");
    expect(renderRow({ hostOnly: false }).className).not.toContain("is-on");
  });

  it("toggles away from the state it is currently in", () => {
    const onToggleHostOnly = vi.fn();
    const control = renderRow({ hostOnly: false, onToggleHostOnly });
    act(() => control.click());
    expect(onToggleHostOnly).toHaveBeenCalledTimes(1);
  });

  it("stops accepting clicks while a save is in flight", () => {
    expect((renderRow({ hostOnly: false, saving: true }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("stops claiming delegation identities for a model that registers none", () => {
    // 호스트 전용 모델의 정체성 수는 0이므로, 켜진 단계를 세어 보여 주면 그 문장은 거짓이 된다.
    renderRow({ hostOnly: true });
    expect(container?.querySelector(".ai-gateway-effort")?.getAttribute("title"))
      .toBe(TERMINAL_MESSAGES.en["terminal.settings.aiGatewayHostOnlyNote"]);
  });

  it("still counts identities for a delegable model", () => {
    renderRow({ hostOnly: false });
    expect(container?.querySelector(".ai-gateway-effort")?.getAttribute("title")).toContain("3");
  });
});
