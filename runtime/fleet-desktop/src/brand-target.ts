import { DESKTOP_BRAND_MARK_ATTRIBUTE, DESKTOP_BRAND_READY_ATTRIBUTE, DESKTOP_BRAND_WORDMARK_ATTRIBUTE, readDesktopBrandTarget, type DesktopBrandTarget } from "@fleet-console/protocol/desktop/brand";
import type { EntryPageWebContents } from "./entry-page.js";

/** 공개 DOM 닻만 읽는다. 구버전·닻 없는 화면·멈춘 렌더러는 상한 뒤 기존 전환으로 넘긴다. */
export async function measureBrandTarget(contents: EntryPageWebContents, waitMs = 2_000): Promise<DesktopBrandTarget | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const script = `new Promise((resolve) => {
    const until = performance.now() + ${waitMs};
    let previous = "";
    const rect = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0 || getComputedStyle(element).visibility === "hidden") return null;
      return { left: box.left, top: box.top, width: box.width, height: box.height };
    };
    const measure = () => {
      if (document.documentElement.hasAttribute(${JSON.stringify(DESKTOP_BRAND_READY_ATTRIBUTE)}) && document.fonts.status === "loaded") {
        const mark = rect(document.querySelector(${JSON.stringify(`[${DESKTOP_BRAND_MARK_ATTRIBUTE}]`)}));
        const word = document.querySelector(${JSON.stringify(`[${DESKTOP_BRAND_WORDMARK_ATTRIBUTE}]`)});
        const box = rect(word);
        const target = mark ? { mark, wordmark: box ? { ...box, fontSize: parseFloat(getComputedStyle(word).fontSize) } : null } : null;
        const key = JSON.stringify(target);
        if (target && key === previous) return resolve(target);
        previous = key;
      }
      if (performance.now() >= until) return resolve(null);
      setTimeout(measure, 34);
    };
    measure();
  })`;
  try {
    const value = await Promise.race([
      contents.executeJavaScript(script),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs + 100); }),
    ]);
    return readDesktopBrandTarget(value) ?? undefined;
  } catch { return undefined; }
  finally { if (timer) clearTimeout(timer); }
}
