import type { FolderListResult } from "../server/types.js";
import type { PluginFilesClient } from "./tree.js";

/**
 * 폴더 목록 창구. 상태가 없으므로 Theater마다 하나씩 만들어 쓴다.
 *
 * 트리 페인과 문서 로더가 함께 부르므로 어느 컴포넌트에도 속하지 않는다 — 문서 창은 이미지의
 * 기준 mtime을 얻으려 부모 폴더를 한 번 나열하고, 트리는 목록 그 자체를 그린다.
 */
export function makeFilesClient(theaterId: string | null): PluginFilesClient {
  return {
    listFolder: async (relativePath?) => {
      if (!theaterId) throw new Error("no_theater");
      const res = await fetch("/plugins/file-explorer/files/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theaterId, relativePath: relativePath ?? "" }),
      });
      if (!res.ok) {
        const payload = await res.json() as { error?: string };
        throw new Error(payload.error ?? "list_failed");
      }
      return res.json() as Promise<FolderListResult>;
    },
  };
}
