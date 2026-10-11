/** Gateway 본문 32 MiB 중 이미지 이력은 base64 16 MiB 이하, 나머지는 텍스트·도구·wire 여유다. */
export const MAX_COMMODORE_MESSAGE_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_COMMODORE_TURN_IMAGE_BYTES = MAX_COMMODORE_MESSAGE_IMAGE_BYTES;
export const MAX_COMMODORE_SESSION_IMAGE_BYTES = 12 * 1024 * 1024;
/** 파일마다 base64 padding이 붙는다 — raw 합계뿐 아니라 실제 인코딩 길이도 제한한다. */
export const MAX_COMMODORE_SESSION_IMAGE_BASE64_BYTES = 16 * 1024 * 1024;
/** 모인 메시지는 순서대로 나눈다 — 한 턴 본문이 무한히 자라지 않는다. */
export const MAX_COMMODORE_TURN_MESSAGE_CHARS = 128 * 1024;
