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

/**
 * 마크다운 렌더러가 코드 블록마다 심는 Copy 버튼. 렌더러는 버튼만 그리고 동작은 표면이 위임으로
 * 받는다(Skills·Analyst와 같은 계약). 말풍선과 카드가 같은 손잡이를 쓴다.
 */
export function copyCodeBlock(event: React.MouseEvent<HTMLElement>, copiedLabel: string): void {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action="copy-code"]');
  if (!button) return;
  const code = button.closest("pre")?.getAttribute("data-code");
  if (!code) return;
  void navigator.clipboard?.writeText(code);
  const original = button.textContent;
  button.textContent = copiedLabel;
  window.setTimeout(() => { button.textContent = original; }, 1_200);
}
