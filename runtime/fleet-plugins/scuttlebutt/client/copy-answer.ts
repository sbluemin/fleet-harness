import { React } from "@fleet-console/sdk/plugin/browser";

/**
 * 답 복사 버튼의 상태. 말풍선과 카드가 같은 손잡이를 쓴다 — 두 표면의 복사가 서로 다른 시간·실패
 * 규칙을 갖기 시작하면 "여기서는 되고 저기서는 안 되는" 버튼이 된다.
 */
export function useCopyAnswer(): { readonly copied: boolean; readonly copy: (text: string) => Promise<void> } {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = React.useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // 클립보드가 막힌 컨텍스트(권한·비보안 origin)에서는 조용히 둔다 — 텍스트는 화면에 있다.
    }
  }, []);
  return { copied, copy };
}

/** 코드 블록 복사 버튼의 글자 셋 — 복원·성공·실패. 호출부가 버튼과 같은 locale의 t로 채운다. */
export interface CopyCodeLabels {
  readonly copy: string;
  readonly copied: string;
  readonly failed: string;
}

const copyCodeStates = new WeakMap<HTMLElement, { timer: number | null; seq: number }>();

/**
 * 마크다운 렌더러가 코드 블록마다 심는 Copy 버튼. 렌더러는 버튼만 그리고 동작은 표면이 위임으로
 * 받는다(Skills·Analyst와 같은 계약). 말풍선과 카드가 같은 손잡이를 쓴다.
 *
 * 성공 글자는 writeText가 이행된 뒤에만 낸다. 클립보드가 없거나 던지거나 거절되면 모두 실패이고,
 * 복원 글자는 클릭 때의 textContent가 아니라 호출부가 넘긴 라벨이다 — 표시 중에 다시 누르면
 * 표시 글자가 원래 글자로 굳기 때문이다.
 */
export function copyCodeBlock(event: React.MouseEvent<HTMLElement>, labels: CopyCodeLabels): void {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action="copy-code"]');
  if (!button) return;
  const code = button.closest("pre")?.getAttribute("data-code");
  // 빈 문자열은 복사할 코드다. 속성 자체가 없을 때만 대상이 아니다.
  if (code === null || code === undefined) return;
  const entry = copyCodeStates.get(button) ?? { timer: null, seq: 0 };
  copyCodeStates.set(button, entry);
  entry.seq += 1;
  const seq = entry.seq;
  if (entry.timer !== null) window.clearTimeout(entry.timer);
  entry.timer = null;
  const settle = (state: "copied" | "failed") => {
    // 다시 눌렸거나 재렌더로 버튼이 빠졌다면 이 결과는 낡았다.
    if (entry.seq !== seq || !button.isConnected) return;
    button.textContent = state === "copied" ? labels.copied : labels.failed;
    entry.timer = window.setTimeout(() => {
      entry.timer = null;
      if (entry.seq !== seq || !button.isConnected) return;
      button.textContent = labels.copy;
    }, state === "copied" ? 1_200 : 3_000);
  };
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (!clipboard || typeof clipboard.writeText !== "function") { settle("failed"); return; }
  let write: Promise<void>;
  try { write = clipboard.writeText(code); } catch { settle("failed"); return; }
  void write.then(() => settle("copied"), () => settle("failed"));
}
