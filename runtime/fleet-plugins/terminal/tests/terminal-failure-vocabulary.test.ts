import { afterEach, describe, expect, it, vi } from "vitest";

import { getT } from "../client/i18n/index.js";
import { createTerminalConnection, TerminalTicketError, type TerminalConnectionStatus } from "../client/shared/terminal-connection.js";
import { describeTerminalFailure } from "../client/shared/terminal-failure.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * 실패 화법 계약: 티켓 거절은 상태 코드가 아니라 서버가 실어 보낸 이유로 화면에 도달하고,
 * 화면은 그 이유를 무슨 일 · 왜 · 지금 할 일로 옮긴다. 이 파일이 그 경로를 끝에서 끝까지 고정한다.
 */
describe("terminal failure vocabulary", () => {
  function rejectingConnection(body: unknown, status: number, onStatus: (s: TerminalConnectionStatus, code?: string) => void) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })));
    return createTerminalConnection({
      operationId: "session-a",
      terminal: { onData: () => ({ dispose: () => {} }), write: () => {}, drain: (cb) => cb() },
      ticketPath: "/ticket",
      wsPath: "/ws",
      location: { host: "console.test", protocol: "http:" },
      onStatus,
      webSocketFactory: () => { throw new Error("must not reach the socket"); },
    });
  }

  it("carries the server's reason instead of collapsing it to a status code", async () => {
    const seen: Array<{ status: TerminalConnectionStatus; code?: string }> = [];
    const connection = rejectingConnection({ error: "theater_id_required" }, 400, (status, code) => {
      seen.push({ status, code });
    });
    connection.start();

    // 첫 실패는 화면을 바꾸지 않는다 — 이어지는 재연결이 흔히 삼킨다.
    await vi.waitFor(() => expect(seen.some((entry) => entry.status === "failed")).toBe(true), { timeout: 4_000 });
    connection.dispose();

    const failed = seen.find((entry) => entry.status === "failed");
    expect(failed?.code).toBe("theater_id_required");
    // 예전 동작: `Terminal ticket request failed: 400` 이 그대로 화면 문자열이 되었다.
    expect(seen.every((entry) => !/Terminal ticket request failed/.test(entry.code ?? ""))).toBe(true);
  });

  it("keeps the first failure quiet and reports only from the second", async () => {
    const seen: Array<{ status: TerminalConnectionStatus; code?: string }> = [];
    const connection = rejectingConnection({ error: "theater_not_found" }, 404, (status, code) => {
      seen.push({ status, code });
    });
    connection.start();
    await vi.waitFor(() => expect(seen.some((entry) => entry.status === "failed")).toBe(true), { timeout: 4_000 });
    connection.dispose();

    const firstFailedIndex = seen.findIndex((entry) => entry.status === "failed");
    // failed 앞에는 최소한 최초의 connecting 이 있어야 한다 — 첫 거절만으로 실패를 선언하지 않는다.
    expect(firstFailedIndex).toBeGreaterThan(0);
    expect(seen[0]?.status).toBe("connecting");
  });

  it("falls back to the status code only when the body carries no reason", async () => {
    const seen: Array<{ status: TerminalConnectionStatus; code?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>gateway</html>", { status: 502 })));
    const connection = createTerminalConnection({
      operationId: "session-a",
      terminal: { onData: () => ({ dispose: () => {} }), write: () => {}, drain: (cb) => cb() },
      ticketPath: "/ticket",
      wsPath: "/ws",
      location: { host: "console.test", protocol: "http:" },
      onStatus: (status, code) => { seen.push({ status, code }); },
      webSocketFactory: () => { throw new Error("must not reach the socket"); },
    });
    connection.start();
    await vi.waitFor(() => expect(seen.some((entry) => entry.status === "failed")).toBe(true), { timeout: 4_000 });
    connection.dispose();

    expect(seen.find((entry) => entry.status === "failed")?.code).toBe("http_502");
  });

  it("names the ticket error with its code so callers do not parse prose", () => {
    const error = new TerminalTicketError("operation_dormant", 409);
    expect(error.code).toBe("operation_dormant");
    expect(error.status).toBe(409);
  });

  describe("code to sentence", () => {
    const t = getT("en");

    it("turns every known rejection into what happened plus what to do", () => {
      const codes = [
        "theater_id_required",
        "theater_not_found",
        "operation_id_required",
        "operation_not_found",
        "terminal_session_not_found",
        "operation_dormant",
        "invalid_shell_operation",
        "invalid_global_shell_operation",
        "operation_chat_mode",
        "unauthorized",
      ];
      for (const code of codes) {
        const notice = describeTerminalFailure(code, t);
        expect(notice.title, code).toBeTruthy();
        expect(notice.cause, code).toBeTruthy();
        // 기계 코드는 문장 자리를 차지하지 않고 진단으로만 남는다.
        expect(notice.title, code).not.toContain(code);
        expect(notice.cause, code).not.toContain(code);
        expect(notice.diagnostic, code).toBe(code);
      }
    });

    it("tells a missing Theater apart from a missing Operation", () => {
      const theater = describeTerminalFailure("theater_id_required", t);
      const operation = describeTerminalFailure("operation_id_required", t);
      expect(theater.cause).toContain("Theater");
      expect(theater.title).not.toBe(operation.title);
    });

    it("still says something usable for a code it has never seen", () => {
      const notice = describeTerminalFailure("some_future_code", t);
      expect(notice.title).toBeTruthy();
      expect(notice.cause).toBeTruthy();
      expect(notice.diagnostic).toBe("some_future_code");
    });

    it("keeps both locales in step", () => {
      const ko = describeTerminalFailure("theater_id_required", getT("ko"));
      expect(ko.title).toBeTruthy();
      expect(ko.cause).toContain("Theater");
      expect(ko.title).not.toBe(describeTerminalFailure("theater_id_required", t).title);
    });
  });
});
