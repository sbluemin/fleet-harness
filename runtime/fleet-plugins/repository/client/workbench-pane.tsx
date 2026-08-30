import { useRef } from "react";

import { CaptionActionButton } from "@fleet-console/sdk/components/caption-actions";
import type { PaneContext, PaneDescriptor } from "@fleet-console/sdk/pane";

import { getT } from "./i18n/index.js";
import { StashSavePopover } from "./stash-popover.js";
import { useRepositoryWorkbench, type RepositoryVerb, type RepositoryVerbState } from "./workbench-bridge.js";

/**
 * 작업면 — 표면의 detail 열.
 *
 * 소스 트리와 한 본문 안에 있던 시절, 저장소 이름·브랜치와 원격 동사는 두 열 위에 걸친
 * 툴바 한 줄이었다. 열이 갈라지면서 그 줄은 걸칠 자리를 잃었다 — 그리고 그 자리에 이미
 * 있던 것이 캡션이다. 이름은 캡션 제목이 되고, 동사 넷은 캡션 동작이 된다.
 */

export const REPOSITORY_WORKBENCH_PANE_ID = "repository-workbench";

export const repositoryWorkbenchPane: PaneDescriptor = {
  id: REPOSITORY_WORKBENCH_PANE_ID,
  role: "detail",
  mounts: ["rail"],
  title: (ctx) => workbenchTitle(ctx),
  render: () => <RepositoryWorkbenchPane />,
  captionActions: (ctx) => <RepositoryWorkbenchCaptionActions {...ctx} />,
  defaultWidth: 520,
  minWidth: 320,
  // 커밋 초안과 스테이징 선택은 열을 닫아도 살아 있어야 한다 — 지금까지 `hidden` 동시
  // 마운트가 지키던 것을 계약이 대신 받는다.
  keepAlive: true,
};

function workbenchTitle(ctx: PaneContext): string {
  const t = getT(ctx.language ?? "en");
  return ctx.params.repository || t("repository.panel.title");
}

function RepositoryWorkbenchPane() {
  const workbench = useRepositoryWorkbench();
  // 소스 트리 열이 아직 자기 상태를 싣기 전 한 프레임. 빈 상자를 그리면 그 프레임에
  // 작업면이 접혔다 펴진다.
  if (!workbench) return null;
  return <div className="repository-workbench-pane">{workbench.body}</div>;
}

/**
 * 캡션 동작 — 동기화와 원격 동사 셋.
 *
 * 각 버튼의 말풍선이 곧 그 시도의 결과다. 예전에는 버튼 안에 결과 문면을 담은 배지가 따로
 * 떠 있었는데, 캡션은 라벨 없는 마크만 서는 줄이고 그 줄의 모든 버튼이 이미 같은 말풍선을
 * 쓴다 — 결과를 라벨에 실으면 표면이 하나로 준다.
 */
function RepositoryWorkbenchCaptionActions(ctx: PaneContext) {
  const t = getT(ctx.language);
  const workbench = useRepositoryWorkbench();
  const stashHostRef = useRef<HTMLSpanElement | null>(null);
  if (!workbench) return null;
  const verbs = workbench.verbs;

  return (
    <>
      <CaptionActionButton
        label={verbLabel(verbs, "sync", verbs.syncHint ?? t("repository.sync.title"))}
        actionId="repository-sync"
        disabled={verbs.syncing}
        busy={verbs.syncing}
        onClick={verbs.onSync}
      >
        <SyncGlyph settled={verbs.syncSettled} failed={verbs.syncFailed} />
      </CaptionActionButton>
      <CaptionActionButton
        label={verbLabel(verbs, "pull", t("repository.verb.pullTitle"))}
        actionId="repository-pull"
        disabled={verbs.disabled}
        busy={verbs.busy === "pull"}
        onClick={verbs.onPull}
      >
        <ArrowGlyph direction="down" count={verbs.behind} failed={failedVerb(verbs, "pull")} />
      </CaptionActionButton>
      <CaptionActionButton
        label={verbLabel(verbs, "push", t("repository.verb.pushTitle"))}
        actionId="repository-push"
        disabled={verbs.disabled}
        busy={verbs.busy === "push"}
        onClick={verbs.onPush}
      >
        <ArrowGlyph direction="up" count={verbs.ahead} failed={failedVerb(verbs, "push")} />
      </CaptionActionButton>
      <span className="repository-stash-anchor" ref={stashHostRef}>
        <CaptionActionButton
          label={verbLabel(verbs, "stash", t("repository.verb.stashTitle"))}
          actionId="repository-stash"
          pressed={verbs.stashPromptOpen}
          disabled={verbs.disabled}
          busy={verbs.busy === "stash"}
          onClick={verbs.onStash}
        >
          <StashGlyph failed={failedVerb(verbs, "stash")} />
        </CaptionActionButton>
        {verbs.stashPromptOpen && (
          <StashSavePopover t={t} hostRef={stashHostRef} onSave={verbs.onStashSave} onClose={verbs.onStashPromptClose} />
        )}
      </span>
    </>
  );
}

/**
 * 마지막 시도가 실패로 끝났는가.
 *
 * 캡션 말풍선에는 성공과 실패를 가르는 채널이 없다 — 문장은 같은 자리에 같은 모양으로 뜬다.
 * 그래서 실패는 마크 위의 coral 점이 진다. 신호 채널을 잃지 않기 위한 자리이며, 예전
 * `.repository-sync-dot`이 하던 일과 같은 뜻이다.
 */
function failedVerb(verbs: RepositoryVerbState, verb: RepositoryVerb): boolean {
  return verbs.outcome?.verb === verb && verbs.outcome.kind === "error";
}

/** 마지막 시도의 결과가 있으면 그것이 이 버튼의 이름이다 — 없으면 무엇을 하는 버튼인지 말한다. */
function verbLabel(verbs: RepositoryVerbState, verb: RepositoryVerb | "sync", fallback: string): string {
  if (verb !== "sync" && verbs.outcome?.verb === verb) return verbs.outcome.text;
  return fallback;
}

function SyncGlyph({ settled, failed }: { readonly settled: boolean; readonly failed: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {settled ? (
        <path d="M3.6 8.4 6.4 11.2 12.4 5.2" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <>
          <path d="M12.5 6.5A4.6 4.6 0 1 0 12.9 10" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M12.6 3.4v3.2H9.4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {failed ? <circle cx="13" cy="13" r="1.7" className="repository-caption-fail-dot" /> : null}
    </svg>
  );
}

/**
 * 앞섬·뒤처짐은 세로 화살표 하나와 숫자로 말한다. 0이면 숫자를 그리지 않는다 —
 * 없는 것을 0으로 쓰면 눈이 매번 읽고 매번 버린다.
 */
function ArrowGlyph({ direction, count, failed }: { readonly direction: "up" | "down"; readonly count: number; readonly failed: boolean }) {
  return (
    <span className="repository-caption-verb">
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        {direction === "down"
          ? <path d="M8 3.4v8.2M5 8.6 8 11.6l3-3" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
          : <path d="M8 12.6V4.4M5 7.4 8 4.4l3 3" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />}
        {failed ? <circle cx="13" cy="13" r="1.7" className="repository-caption-fail-dot" /> : null}
      </svg>
      {count > 0 ? <i className="repository-caption-count">{count}</i> : null}
    </span>
  );
}

function StashGlyph({ failed }: { readonly failed: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="3.2" y="4.2" width="9.6" height="2.6" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.35" />
      <rect x="3.2" y="8.6" width="9.6" height="2.6" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.35" />
      {failed ? <circle cx="13" cy="13" r="1.7" className="repository-caption-fail-dot" /> : null}
    </svg>
  );
}
