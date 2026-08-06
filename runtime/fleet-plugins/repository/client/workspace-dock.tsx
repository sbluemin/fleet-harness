import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { RepositoryMessageKey } from "./i18n/index.js";
import { installPointerDragLifecycle } from "./rail-layout.js";
import { clampWorkspaceDockFilesWidth, readWorkspaceDockFilesWidth, saveWorkspaceDockFilesWidth } from "./workspace-layout.js";

interface WorkspaceDockProps {
  readonly t: Translate<RepositoryMessageKey>;
  readonly className?: string;
  /** 흐름 밖 자식(스크린 리더 상태 등) — 그리드 트랙을 차지하지 않는다. */
  readonly overlay?: ReactNode;
  readonly files: ReactNode;
  readonly main: ReactNode;
}

/**
 * 커밋 검사기와 비교 검사기가 공유하는 파일 목록 ⇔ diff 독.
 *
 * 폭은 인라인 grid-template-columns가 아니라 `--ws-dock-files-width`로만 주입한다. 인라인
 * 트랙 정의는 좁은 독을 세로 스택으로 돌리는 컨테이너 쿼리를 이겨 main 열을 0으로 붕괴시킨다.
 */
export function WorkspaceDock({ t, className, overlay, files, main }: WorkspaceDockProps) {
  const [filesWidth, setFilesWidth] = useState(readWorkspaceDockFilesWidth);
  const dockRef = useRef<HTMLDivElement>(null);
  const filesWidthRef = useRef(filesWidth);
  const dragDisposeRef = useRef<(() => void) | null>(null);

  // 드래그 도중 언마운트(Esc로 검사기 닫기 등)에서도 이미 적용된 폭을 저장한다 — dispose는
  // onFinish를 부르지 않으므로, 여기서 저장하지 않으면 화면에 반영된 폭이 조용히 되돌아간다.
  useEffect(() => () => {
    if (!dragDisposeRef.current) return;
    dragDisposeRef.current();
    saveWorkspaceDockFilesWidth(filesWidthRef.current);
  }, []);

  const startDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const dock = dockRef.current;
    if (!dock) return;
    const start = filesWidthRef.current;
    const startX = event.clientX;
    const width = dock.getBoundingClientRect().width;
    dragDisposeRef.current?.();
    dragDisposeRef.current = installPointerDragLifecycle({
      documentTarget: document,
      windowTarget: window,
      onMove: (moveEvent) => {
        const next = clampWorkspaceDockFilesWidth(start, (moveEvent as PointerEvent).clientX - startX, width);
        if (next === null) return;
        filesWidthRef.current = next;
        setFilesWidth(next);
      },
      onFinish: () => {
        saveWorkspaceDockFilesWidth(filesWidthRef.current);
        dragDisposeRef.current = null;
      },
    });
  }, []);

  return <div ref={dockRef} className={`repository-ws-dock${className ? ` ${className}` : ""}`} style={{ "--ws-dock-files-width": `${filesWidth}px` } as CSSProperties}>
    {overlay}
    {files}
    <div className="history-divider repository-ws-dock-divider" role="separator" aria-orientation="vertical" aria-label={t("repository.history.resizeFileList")} onPointerDown={startDrag} />
    {main}
  </div>;
}
