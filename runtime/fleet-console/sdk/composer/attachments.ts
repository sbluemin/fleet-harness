/**
 * 컴포저 첨부 정책 — 붙여넣기·드롭·파일 픽커가 공유하는 브라우저측 사전 판정.
 *
 * 상한은 터미널 플러그인 서버(launch-attachments.ts)의 사본이다. 브라우저 코드는 플러그인
 * 서버 모듈을 끌어올 수 없고, 여기서 미리 거르지 않으면 확실히 400으로 거절될 업로드가
 * 왕복한다 — 최종 판정자는 언제나 서버의 매직 바이트 검사다.
 *
 * 이 파일이 블록 패키지에 사는 이유는 조립이 둘이기 때문이다: Quick Launch와 채팅 컴포저가
 * 같은 정책으로 같은 입구를 열어야, 한쪽에서 되는 붙여넣기가 다른 쪽에서 조용히 사라지지 않는다.
 */

export const COMPOSER_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const COMPOSER_MAX_ATTACHMENTS = 4;

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
