/**
 * 컴포저 첨부 정책 — 붙여넣기·드롭·파일 픽커가 공유하는 브라우저측 사전 판정.
 *
 * 상한은 터미널 플러그인 서버(launch-attachments.ts)의 사본이다. 브라우저 코드는 플러그인
 * 서버 모듈을 끌어올 수 없고, 여기서 미리 거르지 않으면 확실히 400으로 거절될 업로드가
 * 왕복한다 — 최종 판정자는 언제나 서버의 매직 바이트 검사다.
 *
 * 이 파일이 블록 패키지에 사는 이유는 조립이 둘이기 때문이다: 새 세션과 채팅 컴포저가
 * 같은 정책으로 같은 입구를 열어야, 한쪽에서 되는 붙여넣기가 다른 쪽에서 조용히 사라지지 않는다.
 */

export const COMPOSER_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const COMPOSER_MAX_ATTACHMENTS = 15;

/** 호스트 API 주입만 받는 무상태 helper — 플러그인이 실행 feature를 import하지 않는다. */
export async function uploadComposerAttachment(file: Blob, request: (path: string, init: RequestInit) => Promise<Response>): Promise<{ readonly id: string }> {
  const response = await request("/agent/attachments", { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
  const payload = await response.json().catch(() => null) as { id?: unknown; error?: unknown } | null;
  if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "attachment_upload_failed");
  if (typeof payload?.id !== "string" || !payload.id) throw new Error("attachment_upload_failed");
  return { id: payload.id };
}
export async function discardComposerAttachment(id: string, request: (path: string, init: RequestInit) => Promise<Response>): Promise<void> {
  const response = await request(`/agent/attachments/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new Error("attachment_discard_failed");
}

/**
 * 붙여넣기·드롭에서 첨부 후보로 받아들일 파일인지. 브라우저가 아는 라벨로만 거른다 —
 * 이미지가 아닌 파일(텍스트 붙여넣기 등)을 조용히 지나가게 하는 것이 목적이지, 위조를
 * 막는 자리가 아니다.
 */
export function isComposerAttachmentCandidate(file: { readonly type: string }): boolean {
  return file.type.startsWith("image/");
}

/**
 * 붙여넣은 커서 자리에 서는 표시. 서버는 받은 첨부 순서 k로 같은 글자(`[Image #k]`)를 붙인다 —
 * 사령관 session·supervisor와 `launch-attachments.ts`가 이 글자의 사본을 가진다(브라우저↔호스트 import 경계).
 */
export function composerImageMarkers(items: readonly { readonly marker: number }[]): string {
  return items.map((item) => `[Image #${item.marker}]`).join(" ");
}

/**
 * 보낼 본문의 `[Image #n]`을 보낼 첨부(`ids()`와 같은 순서)의 위치(1부터)로 다시 매긴다. 칩이 없는 표시(지운 칩·실패한 업로드)는 지운다.
 * 표시가 없는 칩은 그대로 나간다 — 위치를 모르는 첨부다.
 */
export function resolveComposerImageMarkers(text: string, items: readonly { readonly id: string | null; readonly marker: number }[]): string {
  const sent = items.filter((item) => item.id !== null);
  return text.replace(/\[Image #(\d+)\]/g, (_match, n: string) => {
    const at = sent.findIndex((item) => item.marker === Number(n));
    return at < 0 ? "" : `[Image #${at + 1}]`;
  });
}
