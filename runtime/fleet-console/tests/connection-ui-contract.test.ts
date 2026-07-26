import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { getT } from "../core/client/src/i18n/index.js";

const CLIENT_ROOT = resolve(import.meta.dirname, "../core/client/src");
const source = (path: string) => readFileSync(resolve(CLIENT_ROOT, path), "utf8");

describe("console connection-loss UI contract", () => {
  it("keeps the approved English and Korean connection copy literal", () => {
    const en = getT("en");
    const ko = getT("ko");

    expect(en("chrome.link.offline")).toBe("Connection lost");
    expect(en("chrome.link.reconnecting")).toBe("Reconnecting…");
    expect(en("chrome.link.bannerDetail", { time: "10:00" })).toBe("Values on screen are from 10:00.");
    expect(en("chrome.link.reconnect")).toBe("Reconnect");
    expect(en("chrome.link.staleHeadline")).toBe("Updates stopped here");
    expect(en("chrome.link.staleDetail", { time: "10:00" })).toBe("Last updated 10:00");

    expect(ko("chrome.link.offline")).toBe("연결 끊김");
    expect(ko("chrome.link.reconnecting")).toBe("다시 연결하는 중…");
    expect(ko("chrome.link.bannerDetail", { time: "10:00" })).toBe("화면의 값은 10:00 기준입니다.");
    expect(ko("chrome.link.reconnect")).toBe("다시 연결");
    expect(ko("chrome.link.staleHeadline")).toBe("이 값은 갱신이 멈췄습니다");
    expect(ko("chrome.link.staleDetail", { time: "10:00" })).toBe("마지막 갱신 10:00");
  });

  it("renders distinct command-band, global banner, and rail stale surfaces", () => {
    const commandBand = source("components/command-band.tsx");
    const app = source("app.tsx");
    const rail = source("rail/right-rail.tsx");

    expect(commandBand).toContain('className="command-band-link-chip" data-link-state={state.connection}');
    expect(commandBand).toContain('state.connection !== "live"');
    expect(app).toContain('className="console-link-banner" role="status" aria-live="polite"');
    expect(app).toContain('state.connection !== "live" && state.connectionLostAt !== null');
    expect(app).toContain("<ReconnectButton />");
    expect(rail).toContain('className="right-rail-stale-veil"');
    expect(rail).toContain('connection !== "live" && connectionLostAt !== null');
    expect(rail).toContain("<ReconnectButton buttonRef={reconnectButtonRef} />");
    expect(rail).toContain('className="right-rail-panel-content" inert={staleVisible || undefined}');
    expect(rail).toContain("reconnectButtonRef.current?.focus()");
    expect(rail).toContain("returnFocus?.isConnected");
    expect(rail).toContain("if (returnFocus === null) return;");
    expect(rail).toContain("if (!focusStillOwned) return;");
    expect(rail).toContain("panelBodyRef.current?.focus()");

    // 재연결 버튼은 상태 기계와 별개로 눌렸다는 사실을 보증한다 — 서버가 죽어 있으면
    // EventSource가 즉시 실패해 connecting이 250ms 안에 사라지기 때문이다(실측).
    const button = source("components/reconnect-button.tsx");
    expect(button).toContain("disabled={pending}");
    expect(button).toContain('t(pending ? "chrome.link.reconnecting" : "chrome.link.reconnect")');
  });

  it("uses signal tokens and the required stale-veil motion grammar", () => {
    const layout = source("styles/layout.css");
    const rail = source("styles/rail.css");

    expect(layout).toMatch(/\.command-band-link-chip\[data-link-state="offline"\][^{]*\{[^}]*var\(--coral-glow\)[^}]*var\(--coral\)/s);
    expect(layout).toMatch(/\.command-band-link-chip\[data-link-state="connecting"\][^{]*\{[^}]*var\(--warn-glow\)[^}]*var\(--warn\)/s);
    expect(layout).toMatch(/\.console-link-banner \{[^}]*var\(--coral\)[^}]*var\(--coral-glow\)/s);
    // 덮개는 offline일 때만 마운트되므로 상태 전환이 없다 — 진입 페이드는 transition이 아니라
    // animation이 져야 실제로 발화한다.
    expect(rail).toMatch(/\.right-rail-stale-veil \{[^}]*animation: right-rail-stale-veil-in var\(--duration-base\) var\(--ease-glide\)/s);
    expect(rail).toMatch(/@keyframes right-rail-stale-veil-in \{[\s\S]*opacity: 0[\s\S]*opacity: 1/);
    expect(layout).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.right-rail-stale-veil[\s\S]*animation: none !important/);
  });
});
