import type { RenderMarkdownOptions } from "@fleet-console/markdown/core";
import { parseFileRef, isAbsolute } from "@fleet-console/markdown/file-ref";
import type { MarkdownLinkActivation } from "@fleet-console/markdown/link-activation";
import type { ClientNavigateCapability } from "@fleet-console/sdk/navigation";

export function createChatFileLinkPorts(theaterId: string, navigate: ClientNavigateCapability, onFailure: (reason: "unsupported" | "failed" | null) => void): {
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
    onActivate: (kind, data) => {
      if (kind !== "file" || !data.path) return;
      onFailure(null);
      void navigate.openFile({
        theaterId,
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
