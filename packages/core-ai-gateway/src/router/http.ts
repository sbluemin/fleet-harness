import { findCauseCode } from "../transport/upstream-sse.js";

/**
 * 라우터가 클라이언트에게 응답을 쓰는 원시 수단.
 *
 * 어느 downstream 하네스가 붙었는지, 어느 upstream이 답했는지 모른다 — 상태 코드와
 * 바이트를 내보내는 HTTP 역학만 갖는다. 무엇을 쓸지는 라우터와 하네스 프로필이 정한다.
 */
export interface GatewayProxyResponse {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: Uint8Array): boolean;
  end(body?: string): unknown;
  once(event: "drain", listener: () => void): unknown;
  readonly headersSent: boolean;
}

export async function drain(res: { once(event: "drain", listener: () => void): unknown }): Promise<void> {
  await new Promise<void>((resolve) => res.once("drain", resolve));
}

export function writeAnthropicError(
  res: {
    writeHead(status: number, headers: Record<string, string>): unknown;
    end(body: string): unknown;
  },
  status: number,
  type: string,
  message: string,
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

/**
 * 헤더 전송 후의 유일한 통지 수단. 메시지에 따옴표/개행이 있어도 안전하도록 JSON.stringify로만 만든다.
 *
 * 선행 `\n\n`은 생략할 수 없다. passthrough 경로는 상류 네트워크 청크를 그대로 흘리므로
 * 마지막 청크가 프레임 중간에서 끊길 수 있고, 그 뒤에 곧바로 이어 붙이면 잘린 data 줄에
 * 융합되어 클라이언트 JSON 파싱이 깨진다. 이미 경계에 있을 때 덧붙는 빈 줄은 무해하다.
 */
export function writeSseErrorFrame(
  res: { write(chunk: string): boolean },
  type: string,
  message: string,
): void {
  try {
    const data = JSON.stringify({ type: "error", error: { type, message } });
    res.write(`\n\nevent: error\ndata: ${data}\n\n`);
  } catch {
    // 프레임 작성 자체가 실패해도 응답 종료는 막지 않는다.
  }
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // fetch 거절은 message가 "fetch failed"뿐이라 원인 code(cause chain)를 함께 남긴다(issue #531).
  const code = findCauseCode(error);
  return code !== undefined && !message.includes(code) ? `${message} (${code})` : message;
}
