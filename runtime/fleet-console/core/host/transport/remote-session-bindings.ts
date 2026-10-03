import type * as http from "node:http";
import type { Duplex } from "node:stream";

/**
 * 원격 세션 하나로 열린 연결들. 원격 리스너는 라우팅 전에 세션을 한 번 판정하는데, 그 판정 자리에서
 * 응답과 업그레이드 소켓을 그 세션에 묶어 두면 세션이 끝나는 순간 그 연결 모두를 한 곳에서 닫을 수 있다.
 *
 * 채널마다 세션을 기억하게 하면 하나만 빠져도 끝난 세션이 계속 듣는다. 그래서 묶는 일은 기능·플러그인이
 * 아니라 transport가 하고, 새 SSE·WebSocket도 따로 손대지 않아도 닫힌다. 루프백 요청은 세션 판정을
 * 거치지 않으므로 여기 묶이지 않는다.
 */
export interface RemoteSessionBindings {
  /** 그 세션으로 입장한 응답. 응답이 닫히면 저절로 풀린다. */
  bindResponse(handle: string, res: http.ServerResponse): void;
  /** 그 세션으로 입장한 업그레이드 소켓. 소켓이 닫히면 저절로 풀린다. */
  bindSocket(handle: string, socket: Duplex): void;
  /**
   * 세션이 끝났다 — 아직 열린 응답과 소켓을 파기한다. 끝난 세션이 받을 응답은 없으므로 진행 중인
   * 일반 요청도 함께 끊는다(fail-closed).
   *
   * `end()`가 아니라 `destroy()`다. 소켓이 파기되어야 요청·응답의 `close`가 어떤 경우에도 나고,
   * 채널들은 이미 그 이벤트로 구독을 푼다. 이미 끝내는 중인 응답(`writableEnded`)은 건드리지 않는다 —
   * 회수 안내 프레임을 쓰고 우아하게 닫은 스트림의 마지막 바이트를 잘라 먹지 않기 위해서다.
   */
  closeSession(handle: string): void;
}

export interface RemoteSessionBindingsDeps {
  /**
   * 그 handle의 세션이 아직 살아 있는가. 묶는 순간에도 다시 본다 — 판정과 묶기 사이에 세션이 끝났다면
   * 그 handle의 표는 이미 지워져 다시는 닫히지 않으므로, 끝난 handle에 묶으려는 연결은 그 자리에서 파기한다.
   * 판정과 묶기가 같은 동기 블록이라는 호출부 성질에 기대지 않기 위해서다.
   */
  readonly isLive: (handle: string) => boolean;
  readonly onFailure: (kind: string, error: unknown) => void;
}

export function createRemoteSessionBindings(deps: RemoteSessionBindingsDeps): RemoteSessionBindings {
  const { isLive, onFailure } = deps;
  const responses = new Map<string, Set<http.ServerResponse>>();
  const sockets = new Map<string, Set<Duplex>>();

  function add<T>(table: Map<string, Set<T>>, handle: string, value: T): void {
    let set = table.get(handle);
    if (!set) {
      set = new Set();
      table.set(handle, set);
    }
    set.add(value);
  }

  function remove<T>(table: Map<string, Set<T>>, handle: string, value: T): void {
    const set = table.get(handle);
    if (!set) return;
    set.delete(value);
    if (set.size === 0) table.delete(handle);
  }

  return {
    bindResponse(handle, res) {
      if (res.destroyed) return;
      if (!isLive(handle)) {
        try { res.destroy(); } catch (error) { onFailure("session_response_destroy_failed", error); }
        return;
      }
      add(responses, handle, res);
      res.once("close", () => remove(responses, handle, res));
    },
    bindSocket(handle, socket) {
      if (socket.destroyed) return;
      if (!isLive(handle)) {
        try { socket.destroy(); } catch (error) { onFailure("session_socket_destroy_failed", error); }
        return;
      }
      add(sockets, handle, socket);
      socket.once("close", () => remove(sockets, handle, socket));
    },
    closeSession(handle) {
      const openResponses = responses.get(handle);
      const openSockets = sockets.get(handle);
      responses.delete(handle);
      sockets.delete(handle);
      for (const res of openResponses ?? []) {
        if (res.writableEnded || res.destroyed) continue;
        try { res.destroy(); } catch (error) { onFailure("session_response_destroy_failed", error); }
      }
      for (const socket of openSockets ?? []) {
        if (socket.destroyed) continue;
        try { socket.destroy(); } catch (error) { onFailure("session_socket_destroy_failed", error); }
      }
    },
  };
}
