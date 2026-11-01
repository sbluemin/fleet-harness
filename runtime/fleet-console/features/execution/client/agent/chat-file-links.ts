import type { RenderMarkdownOptions } from "@fleet-console/markdown/core";
import { parseFileRef, isAbsolute } from "@fleet-console/markdown/file-ref";
import type { MarkdownLinkActivation } from "@fleet-console/markdown/link-activation";
import type { ClientNavigateCapability } from "../../../workspace/shared/navigation.js";

export function createChatFileLinkPorts(theaterId: string, navigate: ClientNavigateCapability, onFailure: (reason: "unsupported" | "failed" | null) => void, objectiveId?: string): {
  readonly resolveLink: NonNullable<RenderMarkdownOptions["resolveLink"]>;
  readonly onActivate: MarkdownLinkActivation;
} {
  return {
    resolveLink: (href) => {
      if (href.startsWith("#") || href.startsWith("?") || href.startsWith("//")) return null;
      let decoded: string;
      try { decoded = decodeURIComponent(href); } catch { return null; }
      const ref = parseFileRef(decoded);
      if (!ref) return null;
      return { kind: "file", data: {
        path: ref.path,
        pathKind: isAbsolute(ref) ? "absolute" : "theater-relative",
        ...(ref.line === undefined ? {} : { line: String(ref.line) }),
        ...(ref.column === undefined ? {} : { column: String(ref.column) }),
      } };
    },
    onActivate: (kind, data, event) => {
      if (kind !== "file" || !data.path) return;
      // 포인터가 링크에 포커스를 주지 않는 브라우저에서도 미리보기의 복귀점을 남긴다.
      const target = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
      target?.closest<HTMLElement>("a[data-md-link-kind]")?.focus({ preventScroll: true });
      onFailure(null);
      void navigate.openFile({
        theaterId, ...(objectiveId ? { objectiveId } : {}),
        path: data.path,
        pathKind: data.pathKind === "absolute" ? "absolute" : "theater-relative",
        ...(data.line === undefined ? {} : { line: Number(data.line) }),
        ...(data.column === undefined ? {} : { column: Number(data.column) }),
        source: "agent-chat",
      }).then((result) => {
        // Files 처리기는 서버 거절을 이미 알린다. 처리기 부재와 예외만 채팅의 기존 오류 행으로 보낸다.
        if (!result.ok && result.reason === "no_handler") onFailure("unsupported");
      }).catch(() => onFailure("failed"));
    },
  };
}
