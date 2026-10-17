import type { FolderListResult } from "../server/types.js";
import type { ListFolderOptions, PluginFilesClient } from "./tree.js";

/**
 * 첫 목록의 제한 시간. 브라우저는 출처당 HTTP/1.1 연결을 6개까지만 열고, 장기 스트림(SSE·스트리밍 fetch)이 그 자리를
 * 다 쥐면 일반 요청은 서버에 닿지도 못한 채 대기열에 묶인다(F3). 그 상태에서 끝없이 스켈레톤을 그리지 않고 다시 시도할
 * 수 있는 오류로 바꾼다.
 */
export const LIST_TIMEOUT_MS = 10_000;

/**
 * 폴더 목록 창구. 상태가 없으므로 Theater마다 하나씩 만들어 쓴다.
 *
 * 트리 페인과 문서 로더가 함께 부르므로 어느 컴포넌트에도 속하지 않는다 — 문서 창은 이미지의
 * 기준 mtime을 얻으려 부모 폴더를 한 번 나열하고, 트리는 목록 그 자체를 그린다.
 */
export function makeFilesClient(theaterId: string | null): PluginFilesClient {
  return {
    listFolder: async (relativePath?, options: ListFolderOptions = {}) => {
      if (!theaterId) throw new Error("no_theater");
      const { signal, timeoutMs } = options;
      const controller = new AbortController();
      let timedOut = false;
      const forward = () => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener("abort", forward, { once: true });
      const timer = timeoutMs === undefined ? null : setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        const res = await fetch("/plugins/file-explorer/files/list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ theaterId, relativePath: relativePath ?? "" }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const payload = await res.json() as { error?: string };
          throw new Error(payload.error ?? "list_failed");
        }
        return await res.json() as FolderListResult;
      } catch (error) {
        // 대기열에 묶였다가 시간이 다 됐다 — 취소(언마운트)와 갈라 다시 시도할 수 있는 코드로 알린다.
        if (timedOut) throw new Error("list_timeout");
        throw error;
      } finally {
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener("abort", forward);
      }
    },
  };
}
