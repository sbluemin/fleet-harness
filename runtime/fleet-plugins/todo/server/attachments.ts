/**
 * 메모 첨부 이미지 — 형식은 바이트의 머리로 판정한다(요청의 Content-Type 은 믿지 않는다). SVG 는 받지 않는다:
 * 같은 origin 에서 스크립트를 실을 수 있는 형식은 이미지로 되돌려주지 않는다.
 */

export const ATTACHMENT_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as const;
export type AttachmentType = keyof typeof ATTACHMENT_TYPES;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;
export const MAX_ATTACHMENT_NAME = 120;

export interface ImageInfo {
  readonly type: AttachmentType;
  readonly width?: number;
  readonly height?: number;
}

const ascii = (buffer: Buffer, start: number, length: number) => buffer.toString("latin1", start, start + length);

/** 머리 바이트로 형식과 (읽을 수 있으면) 크기를 판정한다. 받는 형식이 아니면 null. */
export function imageInfo(buffer: Buffer): ImageInfo | null {
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) {
    return { type: "image/png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && (ascii(buffer, 0, 6) === "GIF87a" || ascii(buffer, 0, 6) === "GIF89a")) {
    return { type: "image/gif", width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 16 && ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 4) === "WEBP") {
    const chunk = ascii(buffer, 12, 4);
    if (chunk === "VP8X" && buffer.length >= 30) return { type: "image/webp", width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    if (chunk === "VP8 " && buffer.length >= 30) return { type: "image/webp", width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L" && buffer.length >= 25) { const bits = buffer.readUInt32LE(21); return { type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
    return { type: "image/webp" };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    // SOF 표식까지 세그먼트를 건너뛴다 — 크기는 첫 프레임 머리에 있다.
    let at = 2;
    while (at + 9 < buffer.length) {
      if (buffer[at] !== 0xff) { at += 1; continue; }
      const marker = buffer[at + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      const length = buffer.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { type: "image/jpeg", height: buffer.readUInt16BE(at + 5), width: buffer.readUInt16BE(at + 7) };
      at += 2 + length;
    }
    return { type: "image/jpeg" };
  }
  return null;
}

/** 파일 이름 — 경로 구분자·제어 문자를 지우고 줄인다. 디스크 이름으로는 쓰지 않는다(디스크는 id). */
export function attachmentName(raw: string | null, type: AttachmentType): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = (raw ?? "").replace(/[\u0000-\u001f\u007f/\\]/g, "").trim();
  const name = cleaned || `image.${ATTACHMENT_TYPES[type]}`;
  return name.length > MAX_ATTACHMENT_NAME ? `${name.slice(0, MAX_ATTACHMENT_NAME - 1)}…` : name;
}
