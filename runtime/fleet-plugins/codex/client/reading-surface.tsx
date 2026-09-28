import type { ExpandedSurfaceContext, ExpandedSurfaceDescriptor } from "@fleet-console/sdk/expanded-surface";
import { useEffect, useLayoutEffect, useRef } from "react";

import { CodexReadingSheet } from "./codex-reading-sheet.js";
import { readExpandedCodexRequest, releaseCodexExpansion, restoreExpandedCodexReader } from "./reader-store.js";
import { lastResolvedCodexWorkspace, publishResolvedWorkspace, rememberCodexScope, resolveCodexWorkspace } from "./workspace-store.js";
import { getT } from "./i18n/index.js";
import { getCodexReaderDocumentState } from "./codex-host.js";

/**
 * Codex의 확대 표면. 다른 플러그인 기여와 똑같이 레지스트리를 거쳐 선다.
 *
 * 표면 계약을 통해 서는 이유는 자리 때문이다: 예전처럼 캔버스에 직접 portal하면 다른
 * 표면과 같은 칸을 두고 겹쳐, 나중에 그려진 쪽이 앞의 것을 통째로 덮는다.
 */
export const codexReadingSurface: ExpandedSurfaceDescriptor = {
  id: "codex",
  title: (ctx) => {
    const t = getT(ctx.language ?? "en");
    return getCodexReaderDocumentState().title || t("chrome.codexReading.eyebrow");
  },
  // 72ch 측정폭(748px)에 좌우 패딩과 목차 열이 붙는다. 그보다 좁아지면 문서가 아니라
  // 칼럼이 되므로, 분할선이 여기서 멈춘다.
  minPaneWidth: 520,
  render: (ctx) => <RestoredCodexReadingSheet ctx={ctx} />,
  // 호스트가 페인을 닫으면(닫기 버튼·Esc) 확대를 내려놓아 축소 리더로 돌아간다.
  // 읽던 문서는 그대로 두므로, 돌아간 자리에 같은 문서가 서 있다.
  onClose: () => releaseCodexExpansion(),
};

function RestoredCodexReadingSheet({ ctx }: { readonly ctx: ExpandedSurfaceContext }) {
  const restored = useRef<string | null>(null);
  const context = useRef(ctx);
  context.current = ctx;
  useLayoutEffect(() => {
    if (!ctx.theaterId) return;
    if (restored.current) {
      if (restored.current !== ctx.theaterId) ctx.close();
      return;
    }
    restored.current = ctx.theaterId;
    // 명시적인 문서 주소는 세션 스냅샷보다 우선한다. 주소 동기화가 요청과 Theater를 적용한다.
    if (new URLSearchParams(window.location.search).has("codex")) return;
    const request = readExpandedCodexRequest(ctx.params);
    if (!request || (ctx.params.theaterId && ctx.params.theaterId !== ctx.theaterId)) {
      ctx.close();
      return;
    }
    rememberCodexScope(ctx.theaterId);
    restoreExpandedCodexReader(request);
  }, [ctx]);

  useEffect(() => {
    const theaterId = ctx.theaterId;
    if (!theaterId) return;
    // 레일이 다른 도구를 보여도 확대 본문은 스스로 workspace를 확보한다. 이미 해석된
    // 사실은 재사용하고, 떠난 Theater의 늦은 답은 현재 시트에 적용하지 않는다.
    const known = lastResolvedCodexWorkspace();
    if (known?.contextKey === theaterId) {
      if (!known.hasWiki) context.current.close();
      return;
    }
    let stopped = false;
    void resolveCodexWorkspace(theaterId).then((result) => {
      if (stopped || context.current.theaterId !== theaterId) return;
      publishResolvedWorkspace({ contextKey: theaterId, ...result });
      if (!result.hasWiki) context.current.close();
    }).catch(() => {
      if (!stopped && context.current.theaterId === theaterId) context.current.close();
    });
    return () => { stopped = true; };
  }, [ctx.theaterId]);

  return <CodexReadingSheet />;
}

