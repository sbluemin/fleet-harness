import { useEffect, useRef, useState } from "react";
import { CONSOLE_SECTION_CAPABILITY, CONSOLE_SECTION_EVENT, CONSOLE_SECTION_FOCUS_EVENT, consoleSectionSignalUrl, type ConsoleSectionGeometry } from "@fleet-console/protocol/desktop/console-section";
import { isDesktopShell, useDesktopHomeOrigin } from "../../../core/client/src/integration/desktop-shell.js";
import { useT } from "../../../core/client/src/i18n/index.js";
import { ConsoleSection } from "./console-section.js";
import "./console-section.css";

/** 현재 문서는 자리만 알린다. 집 Console의 저장 목록은 이 문서를 거치지 않는다. */
export function ConsoleSectionSlot({ compact }: { readonly compact: boolean }) {
  const t = useT();
  const shell = useDesktopHomeOrigin();
  const capable = isDesktopShell() && shell.capabilities.includes(CONSOLE_SECTION_CAPABILITY);
  const rootRef = useRef<HTMLDivElement>(null);
  const beforeRef = useRef<HTMLButtonElement>(null);
  const afterRef = useRef<HTMLButtonElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!capable) return;
    const update = (event: Event) => {
      const value: unknown = (event as CustomEvent).detail;
      if (value === null) { setHeight(null); return; }
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100_000) setHeight(value);
    };
    const focus = (event: Event) => {
      const direction = (event as CustomEvent).detail;
      const entries = Array.from(document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex="0"]'))
        .filter((el) => !el.closest('[inert], [hidden]') && !el.matches(':disabled') && el.getClientRects().length > 0);
      const anchor = direction === "before" ? beforeRef.current : afterRef.current;
      const index = entries.findIndex((el) => el === anchor);
      const step = direction === "before" ? -1 : 1;
      entries[(index + step + entries.length) % entries.length]?.focus();
    };
    window.addEventListener(CONSOLE_SECTION_EVENT, update);
    window.addEventListener(CONSOLE_SECTION_FOCUS_EVENT, focus);
    return () => {
      window.removeEventListener(CONSOLE_SECTION_EVENT, update);
      window.removeEventListener(CONSOLE_SECTION_FOCUS_EVENT, focus);
    };
  }, [capable]);
  useEffect(() => {
    if (!capable) return;
    const root = rootRef.current;
    if (!root) return;
    let frame = 0;
    let last = "";
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = root.getBoundingClientRect();
        const geometry: ConsoleSectionGeometry = {
          x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width,
          available: Math.max(0, window.innerHeight - rect.y - 100), compact, visible: !document.documentElement.hasAttribute("data-modal-open"),
          theme: document.documentElement.dataset.theme ?? "dark",
        };
        const key = JSON.stringify(geometry);
        if (key === last) return;
        last = key;
        location.assign(consoleSectionSignalUrl(location.origin, { geometry }));
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    // 배치·테마·모달 변경은 슬롯 크기를 바꾸지 않을 수도 있다.
    const mutations = new MutationObserver(measure);
    mutations.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-modal-open"] });
    if (root.parentElement) mutations.observe(root.parentElement, { attributes: true, attributeFilter: ["class", "style"] });
    window.addEventListener("resize", measure);
    root.parentElement?.addEventListener("transitionend", measure);
    measure();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); mutations.disconnect();
      window.removeEventListener("resize", measure);
      root.parentElement?.removeEventListener("transitionend", measure);
      // 사이드바가 사라지면 다른 화면 위에 네이티브 뷰가 남아서는 안 된다.
      location.assign(consoleSectionSignalUrl(location.origin, { hidden: true }));
    };
  }, [capable, compact]);
  const focusSection = (edge: "first" | "last") => location.assign(consoleSectionSignalUrl(location.origin, { focus: edge }));
  const native = capable && height !== null;
  return <div ref={rootRef} className="side-bar-shared" data-native-section={native || undefined}>
    {native ? <div className="console-section-spacer" style={{ height }}>
      <button ref={beforeRef} className="console-section-focus-entry" onFocus={() => focusSection("first")} aria-label={t("chrome.consoles.enter")} />
      <button ref={afterRef} className="console-section-focus-entry" onFocus={() => focusSection("last")} aria-label={t("chrome.consoles.enter")} />
    </div> : <ConsoleSection compact={compact} />}
  </div>;
}
