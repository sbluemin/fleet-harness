/** 뷰어 메타 바의 파일 크기 표기 — 1024 기수, KB/MB는 소수 한 자리. */
export function formatByteSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return "";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const kb = sizeBytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** 뷰어 메타 바의 줄 수 — 마지막 개행 뒤의 빈 꼬리는 줄로 세지 않는다. */
export function countLines(content: string): number {
  if (content === "") return 0;
  const lines = content.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}
