import type { OperationWorkspace } from "../agent/types.js";
import { useT } from "../i18n/index.js";

/**
 * Operation의 "지금 어디" 줄 — 실험 기능(Operation 위치 표시)이 켜진 동안 서버가 세션 DTO에 실어
 * 보내는 투영을 사이드바 칩과 ⌘K 팔레트가 같은 문법으로 그린다. 브랜치는 늘, 폴더는 Theater 루트를
 * 벗어났을 때만. 글자색 위계만 쓰고 상태·brass·정체성 채널은 건드리지 않는다. 폴더는 마지막 마디만
 * 보이고 전체는 툴팁이 든다. 장식(aria-hidden)이므로 접근성 이름은 {@link describeWorkspace}로 싣는다.
 */
export function OperationWorkspaceContext({ workspace, className }: { readonly workspace: OperationWorkspace; readonly className?: string }) {
  const t = useT();
  const folder = workspace.folder;
  const folderLabel = folder === null ? null : folder.includes("/") ? `…/${folder.slice(folder.lastIndexOf("/") + 1)}` : folder;
  const classes = ["operation-context", folder !== null ? "operation-context--deviates" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <span className={classes} aria-hidden="true">
      {workspace.branch ? (
        <span className="operation-context-branch" title={t("sidebar.chip.branchTitle", { branch: workspace.branch })}>{workspace.branch}</span>
      ) : null}
      {workspace.branch && folderLabel ? <span className="operation-context-sep">·</span> : null}
      {folderLabel ? (
        <span
          className={`operation-context-folder${workspace.outside ? " is-outside" : ""}`}
          title={workspace.outside ? t("sidebar.chip.outsideTitle", { folder: folderLabel }) : t("sidebar.chip.folderTitle", { folder: folder ?? "" })}
        >
          {folderLabel}
        </span>
      ) : null}
    </span>
  );
}

/** 브랜치·폴더 편차가 하나라도 있어야 줄을 낸다 — 없으면 오늘의 한 줄 행과 같다. */
export function visibleWorkspace(workspace: OperationWorkspace | null | undefined): OperationWorkspace | null {
  return workspace && (workspace.branch || workspace.folder) ? workspace : null;
}

/**
 * 사이드바 칩이 그리는 몫 — 브랜치만. 폴더는 칩에서 내려가고 hover 상세 카드가 진다.
 * 목록을 훑는 자리에 잘린 경로를 두 겹으로 쌓지 않기 위한 분리이며, 접근성 이름은
 * {@link describeWorkspace}가 계속 폴더까지 싣는다. ⌘K 팔레트는 폭이 넓고 목록 스캔이
 * 아니므로 원래의 브랜치·폴더 문법을 그대로 쓴다.
 */
export function chipWorkspace(workspace: OperationWorkspace | null): OperationWorkspace | null {
  return workspace && workspace.branch ? { branch: workspace.branch, folder: null, outside: false } : null;
}

/**
 * 상세 카드의 "위치" 한 줄 — 지금 어디인지만 말한다. 글리프도, Theater 루트·밖 같은 해설도 붙이지
 * 않는다. 그 판단은 카드를 여는 사람이 이미 하고 있고, 여기서 필요한 것은 사실뿐이다.
 */
export function locationLine(workspace: OperationWorkspace | null): string | null {
  if (!workspace) return null;
  return [workspace.branch, workspace.folder].filter(Boolean).join(" · ") || null;
}

export function describeWorkspace(t: ReturnType<typeof useT>, workspace: OperationWorkspace): string {
  return (workspace.branch ? t("sidebar.chip.onBranch", { branch: workspace.branch }) : "")
    + (workspace.folder ? (workspace.outside ? t("sidebar.chip.outsideFolder", { folder: workspace.folder }) : t("sidebar.chip.inFolder", { folder: workspace.folder })) : "");
}
