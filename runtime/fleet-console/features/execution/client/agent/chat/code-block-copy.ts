import { React } from "@fleet-console/sdk/plugin/browser";
import type { getT } from "../i18n/index.js";

const CODE_COPY_COPIED_MS = 1_200;
const CODE_COPY_FAILED_MS = 3_000;

/**
 * 코드 블록 복사 버튼 위임 — 마크다운이 심은 `[data-action="copy-code"]`를 각 대화 표면의 바깥 한 곳에서 받는다.
 * 각 표면에서 위임하므로 일반 대화와 그룹 대화가 같은 복사 피드백을 쓴다.
 *
 * 성공 글자는 writeText가 이행된 뒤에만 나온다. 클립보드가 없거나 동기로 던지거나 거절되면 모두 실패이고,
 * 실패는 성공 글자 없이 「복사 실패」로 알린다. 원래 글자는 클릭 때의 textContent가 아니라 키에서 얻는다 —
 * 표시 중에 다시 누르면 표시 글자가 원래 글자로 굳기 때문이다.
 */
export function useCodeBlockCopy(t: ReturnType<typeof getT>) {
  const [announcement, setAnnouncement] = React.useState("");
  const buttons = React.useRef(new Map<HTMLElement, { timer: number | null; seq: number }>());
  React.useEffect(() => {
    const held = buttons.current;
    return () => {
      for (const entry of held.values()) if (entry.timer !== null) window.clearTimeout(entry.timer);
      held.clear();
    };
  }, []);
  const onClick = React.useCallback((event: React.MouseEvent<HTMLElement>) => {
    const button = (event.target as Element | null)?.closest<HTMLElement>('[data-action="copy-code"]') ?? null;
    if (!button) return;
    // 빈 문자열은 복사할 코드다. 속성 자체가 없을 때만 대상이 아니다.
    const code = button.closest("pre")?.getAttribute("data-code");
    if (code === null || code === undefined) return;
    const entry = buttons.current.get(button) ?? { timer: null, seq: 0 };
    buttons.current.set(button, entry);
    entry.seq += 1;
    const seq = entry.seq;
    if (entry.timer !== null) window.clearTimeout(entry.timer);
    entry.timer = null;
    const settle = (state: "copied" | "failed") => {
      // 스트리밍 재렌더가 버튼을 갈아끼웠거나 그 사이 다시 눌렸다면 이 결과는 낡았다.
      if (entry.seq !== seq || !button.isConnected) return;
      const message = t(state === "copied" ? "terminal.markdown.copied" : "terminal.markdown.copyFailed");
      button.textContent = message;
      button.dataset.copyState = state;
      setAnnouncement("");
      requestAnimationFrame(() => setAnnouncement(message));
      entry.timer = window.setTimeout(() => {
        entry.timer = null;
        if (entry.seq !== seq || !button.isConnected) return;
        button.textContent = t("terminal.markdown.copy");
        delete button.dataset.copyState;
        setAnnouncement("");
      }, state === "copied" ? CODE_COPY_COPIED_MS : CODE_COPY_FAILED_MS);
    };
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard || typeof clipboard.writeText !== "function") {
      settle("failed");
      return;
    }
    let write: Promise<void>;
    try { write = clipboard.writeText(code); } catch { settle("failed"); return; }
    void write.then(() => settle("copied"), () => settle("failed"));
  }, [t]);
  return { onClick, announcement };
}
