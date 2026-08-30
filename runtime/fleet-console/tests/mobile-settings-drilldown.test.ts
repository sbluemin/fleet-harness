import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const MOBILE_CSS = read("../core/client/src/styles/mobile.css");
const COMPONENTS_CSS = read("../core/client/src/styles/components.css");
const APP = read("../core/client/src/app.tsx");
const VIEW_MODE = read("../core/client/src/view-mode-store.ts");
const PAGE = read("../core/client/src/mobile/mobile-settings-page.tsx");

/**
 * The phone had no Settings screen of its own: the desktop page rendered inside the mobile frame,
 * where its section list took 59% of the first viewport and wrapped into a ragged pile. These pin
 * the parts of the fix that would fail silently — a layout regression shows up as a screenshot
 * nobody takes, not as a thrown error.
 */
describe("mobile settings", () => {
  it("routes /settings to the mobile page only while the mobile layout is on", () => {
    // 데스크톱은 페이지 대신 어댑터를 받는다 — 주소는 살아 있고, 표면은 레일이 진다.
    expect(APP).toContain('<Route path="/settings" element={mobileLayout ? <MobileSettingsPage /> : <SettingsRouteAdapter />} />');
  });

  it("keeps the section in the address so the platform back gesture returns to the list", () => {
    expect(PAGE).toContain('navigate({ pathname: "/settings", search: `?section=${encodeURIComponent(id)}` }');
    // A direct load has no list entry above it, and popping there would leave the Console.
    expect(PAGE).toContain("mobileSettingsEntry");
    expect(PAGE).toContain('navigate({ pathname: "/settings", search: "" }, { replace: true })');
  });

  /**
   * The desktop page still renders below the mobile shell's own boundary — a viewer who forces the
   * desktop view on a narrow window. When the two boundaries disagreed, the band between them
   * squeezed the help text into a 65px-wide ribbon 324px tall.
   */
  it("stacks the desktop settings rows at the same width the mobile shell begins", () => {
    const shellBoundary = /\(max-width:\s*(\d+)px\)/.exec(VIEW_MODE.slice(VIEW_MODE.indexOf("narrowViewportQuery")));
    expect(shellBoundary).not.toBeNull();
    expect(COMPONENTS_CSS).toContain(`@media (max-width: ${shellBoundary![1]}px)`);
    const stack = COMPONENTS_CSS.slice(COMPONENTS_CSS.indexOf(`@media (max-width: ${shellBoundary![1]}px)`));
    expect(stack).toContain(".global-settings-row");
    expect(stack).toContain("flex-direction: column");
  });

  /**
   * The detail screen carries the desktop section body. That body's card is a shell meant to divide
   * one wide column into parts; on a phone it wraps a screen that already holds one part, and its
   * padding stacked with the inner cards until the text ran in a 268px gutter.
   */
  it("drops the desktop card shell inside the mobile detail", () => {
    const detail = MOBILE_CSS.slice(MOBILE_CSS.indexOf(".mobile-settings-detail {"));
    expect(detail).toContain(".mobile-settings-detail .global-settings-card");
    expect(detail).toMatch(/\.mobile-settings-detail \.global-settings-card \{[^}]*padding: 0;/);
    expect(detail).toMatch(/\.mobile-settings-detail \.global-settings-card \{[^}]*border: 0;/);
  });

  it("floors every pointer target in the detail at the touch minimum", () => {
    expect(MOBILE_CSS).toMatch(/\.mobile-settings-detail button,[\s\S]{0,200}min-height: 44px;/);
    // Rows in the list are the other half of the same contract.
    expect(MOBILE_CSS).toMatch(/\.mobile-settings-row \{[\s\S]{0,400}min-height: 56px;/);
  });

  /**
   * Back is how a detail is left, so it owes the same 44px. Growing the box was not the way: the
   * header grows with it, widening the step from the 48px list header and overrunning the 44px
   * height the landscape rail query compacts the header to. The drawn size stays with the other
   * header icons and only the hit area reaches 44.
   */
  it("gives Back a 44px hit area without growing the header", () => {
    const back = MOBILE_CSS.slice(MOBILE_CSS.indexOf(".mobile-settings-back {"));
    expect(back).toMatch(/\.mobile-settings-back \{[^}]*min-width: 40px;/);
    expect(back).toMatch(/\.mobile-settings-back::after \{[^}]*inset: -2px;/);
    expect(back).toMatch(/\.mobile-settings-back::after \{[^}]*position: absolute;/);
  });

  /**
   * The add-host dialog is portaled to the body, so no ancestor of the detail reaches it. Reached
   * from Remote access on a phone it kept a 28px close button until the floor was written against
   * width instead.
   */
  it("floors the portaled add-host dialog by view mode, not by width", () => {
    // Width misses the app (UA) and the explicit preference, which keep the mobile shell up on a
    // wide screen; at 1024px all four dialog controls fell back to the desktop sizes.
    expect(APP).toContain('document.documentElement.dataset.viewMode = mobileLayout ? "mobile" : "desktop"');
    expect(MOBILE_CSS).toContain('[data-view-mode="mobile"] .add-host-close');
    expect(MOBILE_CSS).toMatch(/\[data-view-mode="mobile"\] \.add-host-submit \{\s*\n\s*min-height: 44px;/);
  });

  /** A control with no text is only as wide as its box, so a height floor alone leaves it narrow. */
  it("floors the width of icon-only controls", () => {
    expect(MOBILE_CSS).toMatch(/\.mobile-settings-detail \.fc-font-browser__stepper \{\s*\n\s*min-width: 44px;/);
  });

  /** Selection groups laid out for a wide column wrap into uneven steps at phone width. */
  it("stands the theme choices in one column", () => {
    expect(MOBILE_CSS).toContain(".mobile-settings-detail .theme-dark-tray");
    const tray = MOBILE_CSS.slice(MOBILE_CSS.indexOf(".mobile-settings-detail .theme-picker"));
    expect(tray).toContain("flex-flow: column");
    expect(tray).toContain("align-items: stretch");
  });
});
